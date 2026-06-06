/**
 * sync.js — Sincronización offline-first con Supabase
 * Expone window.YCSM.sync con métodos pull/push/sync.
 * Last-write-wins por updated_at.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  /**
   * Comprueba si el contexto de la extensión sigue activo.
   */
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  /**
   * Helper debounce (reutilizar el de utils si existe, sino definir aquí).
   */
  function debounce(fn, delayMs) {
    let timeoutId = null;
    return function (...args) {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        fn(...args);
        timeoutId = null;
      }, delayMs);
    };
  }

  /**
   * Obtiene el accountId activo tanto en content scripts (memoria) como en popup/iframe (storage).
   */
  async function resolveAccountId() {
    return YCSM.account?.getAccountId() || await YCSM.account?.loadAccountId() || null;
  }

  /**
   * Descarga (pull) datos de Supabase si el remoto es más nuevo.
   */
  async function pull() {
    const session = await YCSM.auth?.getSession();
    const accountId = await resolveAccountId();

    if (!session || !accountId) {
      return { success: false, reason: 'no_session_or_account' };
    }

    try {
      const response = await fetch(
        `${YCSM.config.SUPABASE_URL}/rest/v1/user_data?` +
        `user_id=eq.${encodeURIComponent(session.user.id)}&` +
        `account_id=eq.${encodeURIComponent(accountId)}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${session.accessToken}`,
            'apikey': YCSM.config.SUPABASE_ANON_KEY,
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        console.warn('[YCSM] pull failed:', response.status, response.statusText);
        return { success: false, reason: 'http_error', status: response.status };
      }

      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return { success: true, reason: 'no_remote_data' };
      }

      const remote = rows[0];
      const localUpdatedAt = await getLocalUpdatedAt(accountId);

      // Last-write-wins: si remoto es más nuevo, descargar
      const remoteTime = new Date(remote.updated_at).getTime();
      if (remoteTime <= localUpdatedAt) {
        return { success: true, reason: 'local_is_newer' };
      }

      // Descargar categorías, asignaciones y settings
      const updates = {};
      if (remote.categories) {
        updates.categories = remote.categories;
      }
      if (remote.channel_assignments) {
        updates.channel_assignments = remote.channel_assignments;
      }
      if (remote.settings) {
        updates.settings = remote.settings;
      }

      // Guardar vía storage (que actualiza __local_updated_at__)
      if (Object.keys(updates).length > 0) {
        if (updates.categories) {
          await YCSM.storage.saveCategories(updates.categories);
        }
        if (updates.channel_assignments) {
          await YCSM.storage.saveChannelAssignments(updates.channel_assignments);
        }
        if (updates.settings) {
          await YCSM.storage.saveSettings(updates.settings);
        }
        // Marcar __local_updated_at__ al timestamp remoto para no volver a tirar
        await setLocalUpdatedAt(accountId, remoteTime);
      }

      return { success: true, reason: 'pulled', timestamp: remoteTime };
    } catch (e) {
      console.warn('[YCSM] pull error:', e.message);
      return { success: false, reason: 'error', error: e.message };
    }
  }

  /**
   * Sube (push) datos locales a Supabase.
   */
  async function push() {
    const session = await YCSM.auth?.getSession();
    const accountId = await resolveAccountId();

    if (!session || !accountId) {
      return { success: false, reason: 'no_session_or_account' };
    }

    try {
      const all = await YCSM.storage.getAll();

      const payload = {
        user_id: session.user.id,
        account_id: accountId,
        categories: all.categories || {},
        channel_assignments: all.channelAssignments || {},
        settings: all.settings || {},
        updated_at: new Date().toISOString(),
      };

      const response = await fetch(`${YCSM.config.SUPABASE_URL}/rest/v1/user_data`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.accessToken}`,
          'apikey': YCSM.config.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.warn('[YCSM] push failed:', response.status, response.statusText);
        return { success: false, reason: 'http_error', status: response.status };
      }

      // Actualizar __local_updated_at__ con el timestamp que acabamos de enviar
      await setLocalUpdatedAt(accountId, new Date(payload.updated_at).getTime());

      return { success: true, reason: 'pushed' };
    } catch (e) {
      console.warn('[YCSM] push error:', e.message);
      return { success: false, reason: 'error', error: e.message };
    }
  }

  /**
   * Sincronización completa: pull → last-write-wins → push.
   */
  async function sync() {
    const session = await YCSM.auth?.getSession();
    const accountId = await resolveAccountId();

    if (!session || !accountId) {
      return { success: false, reason: 'no_session_or_account' };
    }

    try {
      // Hacer pull
      const pullResult = await pull();
      if (!pullResult.success) {
        console.warn('[YCSM] sync: pull failed, aborting');
        return pullResult;
      }

      // Hacer push (si hay datos locales más nuevos)
      const pushResult = await push();
      return { success: true, reason: 'synced', pull: pullResult, push: pushResult };
    } catch (e) {
      console.warn('[YCSM] sync error:', e.message);
      return { success: false, reason: 'error', error: e.message };
    }
  }

  /**
   * Obtiene el timestamp de la última actualización local (scoped por cuenta).
   */
  async function getLocalUpdatedAt(accountId) {
    if (!isContextValid()) return 0;
    try {
      const key = `account:${accountId}:__local_updated_at__`;
      const data = await chrome.storage.local.get(key);
      return data[key] || 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Establece el timestamp de la última actualización local.
   */
  async function setLocalUpdatedAt(accountId, timestamp) {
    if (!isContextValid()) return false;
    try {
      const key = `account:${accountId}:__local_updated_at__`;
      await chrome.storage.local.set({ [key]: timestamp });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Registrar sincronización automática al cambiar de cuenta
  if (YCSM.account) {
    YCSM.account.onSwitch(() => {
      // Sincronizar con la nueva cuenta
      sync().catch((e) => {
        console.warn('[YCSM] sync on account switch failed:', e.message);
      });
    });
  }

  window.YCSM.sync = {
    pull,
    push,
    sync,
  };
})();
