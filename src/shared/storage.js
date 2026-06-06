/**
 * storage.js — Capa de abstracción sobre chrome.storage
 * Compatible con content scripts y páginas de extensión (popup, panel).
 * Migrado a chrome.storage.local (v1.1.0+) con soporte para export/import manual.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  const SCHEMA_VERSION = 2;
  const SCHEMA_KEY = '__schema_version__';
  const MIGRATION_FLAG_KEY = '__migrated_from_sync_v2__';

  const DEFAULT_SETTINGS = {
    showUncategorized: true,
    collapseByDefault: false,
    subscriptionsLayout: 'list',
  };

  function generateId() {
    return 'cat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function scopedKey(key) {
    const accountId = YCSM.account?.getAccountId();
    if (!accountId) return key;
    return `account:${accountId}:${key}`;
  }

  /* ─── Helpers internos ─────────────────────────────────────────── */

  /**
   * Comprueba si el contexto de la extensión sigue activo.
   * En MV3 el service worker puede morir; el content script queda vivo
   * pero chrome.storage lanza "Extension context invalidated".
   */
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  /**
   * Helpers que usan la API Promise de chrome.storage (MV3).
   * Con callbacks, chrome.storage TAMBIÉN devuelve una Promise interna que
   * puede rechazarse con "Extension context invalidated" sin ser capturada.
   * Usando solo Promises y encadenando .catch() evitamos ese rechazo no manejado.
   */
  function storageGet(keys) {
    if (!isContextValid()) return Promise.resolve({});
    return chrome.storage.local.get(keys).catch((e) => {
      console.warn('[YCSM] storage.local.get error:', e.message);
      return {};
    });
  }

  function storageSet(items) {
    if (!isContextValid()) return Promise.resolve(false);
    return chrome.storage.local.set(items).then(() => true).catch((e) => {
      console.warn('[YCSM] storage.local.set error:', e.message);
      return false;
    });
  }

  function localGet(keys) {
    return storageGet(keys);
  }

  function localSet(items) {
    return storageSet(items);
  }

  /* ─── Caché en memoria ─────────────────────────────────────────── */
  // Evita round-trips a chrome.storage en cada render del sidebar.
  // Se invalida cada vez que se escribe en sync storage.
  let _memCache = null;

  function invalidateCache() {
    _memCache = null;
  }

  /* ─── Lectura ──────────────────────────────────────────────────── */

  async function getAll() {
    if (_memCache) return _memCache;
    const sk = (k) => scopedKey(k);
    const keys = [sk('categories'), sk('channelAssignments'), sk('settings')];
    const data = await storageGet(keys);
    _memCache = {
      categories: data[sk('categories')] || {},
      channelAssignments: data[sk('channelAssignments')] || {},
      settings: { ...DEFAULT_SETTINGS, ...(data[sk('settings')] || {}) },
    };
    return _memCache;
  }

  async function getCategories() {
    const all = await getAll();
    return all.categories;
  }

  async function getChannelAssignments() {
    const all = await getAll();
    return all.channelAssignments;
  }

  async function getSettings() {
    const all = await getAll();
    return all.settings;
  }

  /* ─── Escritura ─────────────────────────────────────────────────── */

  // Debouncer para push (2s)
  const _debouncedPush = YCSM.utils?.debounce?.(async () => {
    const session = await (YCSM.auth?.getSession?.());
    if (session && YCSM.sync?.push) {
      try {
        await YCSM.sync.push();
      } catch (e) {
        console.warn('[YCSM] debounced push failed:', e.message);
      }
    }
  }, 2000) || function () {};

  function saveCategories(categories) {
    if (_memCache) _memCache.categories = categories;
    const toSet = {
      [scopedKey('categories')]: categories,
      [scopedKey('__local_updated_at__')]: Date.now(),
    };
    _debouncedPush();
    return storageSet(toSet);
  }

  function saveChannelAssignments(channelAssignments) {
    if (_memCache) _memCache.channelAssignments = channelAssignments;
    const toSet = {
      [scopedKey('channelAssignments')]: channelAssignments,
      [scopedKey('__local_updated_at__')]: Date.now(),
    };
    _debouncedPush();
    return storageSet(toSet);
  }

  function saveSettings(settings) {
    if (_memCache) _memCache.settings = settings;
    const toSet = {
      [scopedKey('settings')]: settings,
      [scopedKey('__local_updated_at__')]: Date.now(),
    };
    _debouncedPush();
    return storageSet(toSet);
  }

  /* ─── Canales en caché (storage local — 5 MB) ──────────────────── */

  function cacheChannels(channels) {
    return localSet({
      [scopedKey('cachedChannels')]: channels,
      [scopedKey('channelsCachedAt')]: Date.now(),
    });
  }

  async function getCachedChannels() {
    const data = await localGet([scopedKey('cachedChannels'), scopedKey('channelsCachedAt')]);
    return {
      channels: data[scopedKey('cachedChannels')] || [],
      cachedAt: data[scopedKey('channelsCachedAt')] || 0,
    };
  }

  /* ─── CRUD Categorías ──────────────────────────────────────────── */

  async function addCategory(name) {
    const categories = await getCategories();
    const id = generateId();
    const order = Object.keys(categories).length;
    const { HUE_PALETTE } = window.YCSM.utils;
    const hue = HUE_PALETTE[order % HUE_PALETTE.length];
    categories[id] = { id, name, order, hue, collapsed: false };
    await saveCategories(categories);
    return categories[id];
  }

  async function updateCategory(id, updates) {
    const categories = await getCategories();
    if (!categories[id]) return null;
    categories[id] = { ...categories[id], ...updates };
    await saveCategories(categories);
    return categories[id];
  }

  async function deleteCategory(id) {
    const [categories, channelAssignments] = await Promise.all([
      getCategories(),
      getChannelAssignments(),
    ]);

    delete categories[id];

    // Reasignar orden
    Object.values(categories)
      .sort((a, b) => a.order - b.order)
      .forEach((cat, i) => (cat.order = i));

    // Eliminar de todas las asignaciones
    for (const channelId of Object.keys(channelAssignments)) {
      channelAssignments[channelId] = channelAssignments[channelId].filter(
        (catId) => catId !== id
      );
      if (channelAssignments[channelId].length === 0) {
        delete channelAssignments[channelId];
      }
    }

    await Promise.all([saveCategories(categories), saveChannelAssignments(channelAssignments)]);
  }

  async function reorderCategories(orderedIds) {
    const categories = await getCategories();
    const ids = [
      ...orderedIds.filter((id) => categories[id]),
      ...Object.values(categories)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((cat) => cat.id)
        .filter((id) => !orderedIds.includes(id)),
    ];

    ids.forEach((id, index) => {
      if (categories[id]) categories[id].order = index;
    });
    await saveCategories(categories);
  }

  /* ─── Asignaciones canal ↔ categoría ──────────────────────────── */

  async function assignChannel(channelId, categoryId) {
    const channelAssignments = await getChannelAssignments();
    if (!channelAssignments[channelId]) channelAssignments[channelId] = [];
    if (!channelAssignments[channelId].includes(categoryId)) {
      channelAssignments[channelId].push(categoryId);
    }
    await saveChannelAssignments(channelAssignments);
  }

  async function unassignChannel(channelId, categoryId) {
    const channelAssignments = await getChannelAssignments();
    if (!channelAssignments[channelId]) return;
    channelAssignments[channelId] = channelAssignments[channelId].filter(
      (id) => id !== categoryId
    );
    if (channelAssignments[channelId].length === 0) {
      delete channelAssignments[channelId];
    }
    await saveChannelAssignments(channelAssignments);
  }

  async function toggleChannelCategory(channelId, categoryId) {
    const channelAssignments = await getChannelAssignments();
    const current = channelAssignments[channelId] || [];
    if (current.includes(categoryId)) {
      await unassignChannel(channelId, categoryId);
      return false;
    } else {
      await assignChannel(channelId, categoryId);
      return true;
    }
  }

  /* ─── Reactividad ───────────────────────────────────────────────── */

  function onChange(callback) {
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        const accountId = YCSM.account?.getAccountId();
        if (accountId) {
          const prefix = `account:${accountId}:`;
          const relevant = Object.keys(changes).some((k) => k.startsWith(prefix));
          if (!relevant) return;
        }
        invalidateCache();
        const cleanChanges = {};
        for (const [k, v] of Object.entries(changes)) {
          const cleanKey = k.replace(/^account:[^:]+:/, '');
          cleanChanges[cleanKey] = v;
        }
        try {
          callback(cleanChanges);
        } catch (e) {
          console.warn('[YCSM] onChange callback error:', e.message);
        }
      });
    } catch (e) {
      console.warn('[YCSM] onChange registration error:', e.message);
    }
  }

  /* ─── Export / Import ──────────────────────────────────────────── */

  async function exportAll() {
    const keys = ['categories', 'channelAssignments', 'settings', 'cachedChannels', 'channelsCachedAt'];
    const scopedKeys = keys.map((k) => scopedKey(k));
    const raw = await storageGet(scopedKeys);
    const data = {};
    for (const k of keys) {
      const sk = scopedKey(k);
      if (raw[sk] !== undefined) data[k] = raw[sk];
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: chrome.runtime.getManifest().version,
      accountId: YCSM.account?.getAccountId() || null,
      data,
    };
  }

  async function importAll(payload, { mode = 'replace' } = {}) {
    if (!payload || typeof payload !== 'object' || !payload.data) {
      throw new Error('Invalid import payload: missing "data".');
    }
    if (payload.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `Import schemaVersion ${payload.schemaVersion} > current ${SCHEMA_VERSION}. ` +
        `Update the extension before importing.`
      );
    }

    if (mode === 'replace') {
      const keys = ['categories', 'channelAssignments', 'settings', 'cachedChannels', 'channelsCachedAt'];
      await chrome.storage.local.remove(keys.map((k) => scopedKey(k)));
    }

    const scoped = {};
    for (const [k, v] of Object.entries(payload.data)) {
      scoped[scopedKey(k)] = v;
    }
    await storageSet(scoped);
    invalidateCache();

    if (chrome.runtime.lastError) {
      throw new Error(`Import failed: ${chrome.runtime.lastError.message}`);
    }

    return { restoredKeys: Object.keys(payload.data).length };
  }

  /* ─── Migración desde chrome.storage.sync (one-shot) ──────────────── */

  async function migrateFromSyncIfNeeded() {
    const flag = await storageGet(MIGRATION_FLAG_KEY);
    if (flag[MIGRATION_FLAG_KEY] === true) {
      return { migrated: false, reason: 'already_migrated' };
    }

    const syncData = await chrome.storage.sync.get(null);
    const syncKeys = Object.keys(syncData);

    if (syncKeys.length === 0) {
      await storageSet({ [MIGRATION_FLAG_KEY]: true, [SCHEMA_KEY]: SCHEMA_VERSION });
      return { migrated: false, reason: 'no_sync_data' };
    }

    // Copiar sync → local
    await storageSet(syncData);
    if (chrome.runtime.lastError) {
      throw new Error(`Migration write to local failed: ${chrome.runtime.lastError.message}`);
    }

    // Verificar que se escribió todo
    const localAfter = await storageGet(syncKeys);
    for (const k of syncKeys) {
      if (JSON.stringify(localAfter[k]) !== JSON.stringify(syncData[k])) {
        throw new Error(`Migration verification failed for key ${k}.`);
      }
    }

    // Marcar flag antes de tocar sync
    await storageSet({ [MIGRATION_FLAG_KEY]: true, [SCHEMA_KEY]: SCHEMA_VERSION });

    // Comentado por seguridad; habilitar tras 2 releases estables
    // await chrome.storage.sync.clear();

    return { migrated: true, keysMigrated: syncKeys.length };
  }

  /* ─── Migración a almacenamiento por cuenta (one-shot) ──────────────── */

  const ACCOUNT_SCOPE_FLAG = '__migrated_account_scope__';

  async function migrateToAccountScope() {
    const flag = await storageGet(ACCOUNT_SCOPE_FLAG);
    if (flag[ACCOUNT_SCOPE_FLAG]) return;

    const accountId = YCSM.account?.getAccountId();
    if (!accountId) return;

    const oldKeys = ['categories', 'channelAssignments', 'settings', 'cachedChannels', 'channelsCachedAt'];
    const oldData = await storageGet(oldKeys);

    const hasData = oldKeys.some((k) => oldData[k] !== undefined);
    if (!hasData) {
      await storageSet({ [ACCOUNT_SCOPE_FLAG]: true });
      return;
    }

    const scoped = {};
    for (const k of oldKeys) {
      if (oldData[k] !== undefined) {
        scoped[`account:${accountId}:${k}`] = oldData[k];
      }
    }
    await storageSet(scoped);

    await chrome.storage.local.remove(oldKeys);
    await storageSet({ [ACCOUNT_SCOPE_FLAG]: true });
    invalidateCache();
  }

  /* ─── Export ────────────────────────────────────────────────────── */

  window.YCSM.storage = {
    getAll,
    getCategories,
    getChannelAssignments,
    getSettings,
    saveCategories,
    saveChannelAssignments,
    saveSettings,
    cacheChannels,
    getCachedChannels,
    addCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    assignChannel,
    unassignChannel,
    toggleChannelCategory,
    onChange,
    invalidateCache,
    exportAll,
    importAll,
    migrateFromSyncIfNeeded,
    migrateToAccountScope,
  };

  // Ejecutar migración automáticamente si es necesario (one-shot en contexto valid)
  if (isContextValid()) {
    migrateFromSyncIfNeeded().catch((e) => {
      console.error('[Sidefold] Automatic migration failed:', e);
    });
  }

  // Registrar listener de cambio de cuenta
  if (YCSM.account) {
    YCSM.account.onSwitch(() => invalidateCache());
  }
})();
