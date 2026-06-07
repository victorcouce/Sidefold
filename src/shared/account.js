/**
 * account.js — Detección de cuenta YouTube activa
 * Expone window.YCSM.account con métodos para acceder al channel ID del usuario logueado
 * y notificaciones de cambio de cuenta.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let _currentAccountId = null;
  const _switchCallbacks = [];

  /**
   * El ID de cuenta del usuario logueado es SIEMPRE un ID de canal canónico
   * (UCxxxxxxxxxxxxxxxxxxxxxx, 24 chars). Nunca un handle (/@nombre) ni el
   * canal del contenido que se esté viendo. Validamos el formato para no
   * scopear el storage a una cuenta equivocada (p. ej. LaVanguardia).
   */
  function isCanonicalChannelId(id) {
    return typeof id === 'string' && /^UC[0-9A-Za-z_-]{22}$/.test(id);
  }

  function getChannelIdFromYtcfg() {
    const ytcfg = window.ytcfg?.data_;
    if (!ytcfg) return null;
    // ytcfg.CHANNEL_ID es el canal del usuario logueado (estable entre páginas).
    const id = ytcfg.CHANNEL_ID || ytcfg.DELEGATED_SESSION_ID?.split('|')?.[0] || null;
    return isCanonicalChannelId(id) ? id : null;
  }

  function getChannelIdFromDOM() {
    // Fallback SOLO si ytcfg aún no tiene el ID. Restringido al avatar real de
    // la cuenta en el masthead; jamás enlaces de canal del contenido de la
    // página (que apuntarían al canal del vídeo/página, no al del usuario).
    const avatarLink = document.querySelector(
      'ytd-masthead #avatar-btn a[href*="/channel/UC"], ' +
      'ytd-masthead a#avatar-link[href*="/channel/UC"]'
    );
    if (avatarLink?.href) {
      const match = avatarLink.href.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
      if (match && isCanonicalChannelId(match[1])) return match[1];
    }
    return null;
  }

  function detect() {
    const loggedIn = window.ytcfg?.data_?.LOGGED_IN !== false;
    if (!loggedIn) {
      const changed = _currentAccountId !== null && _currentAccountId !== null;
      if (changed) {
        _currentAccountId = null;
        _switchCallbacks.forEach((cb) => {
          try {
            cb(null, _currentAccountId);
          } catch (e) {
            console.warn('[Sidefold] account switch callback error:', e);
          }
        });
      }
      return { accountId: null, changed, ready: false };
    }

    // Intentar detectar el channel ID de múltiples fuentes
    const newId = getChannelIdFromYtcfg() || getChannelIdFromDOM();

    if (newId === null) {
      return { accountId: _currentAccountId, changed: false, ready: false };
    }

    const changed = _currentAccountId !== null && _currentAccountId !== newId;
    const prevId = _currentAccountId;
    _currentAccountId = newId;

    // Persistir en storage para que el iframe del panel pueda leerlo
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ '__active_account_id__': newId }).catch(() => {});
    }

    if (changed) {
      console.log('[Sidefold] Account changed:', { prevId, newId });
      _switchCallbacks.forEach((cb) => {
        try {
          cb(newId, prevId);
        } catch (e) {
          console.warn('[Sidefold] account switch callback error:', e);
        }
      });
    }

    return { accountId: newId, changed, ready: true };
  }

  function getAccountId() {
    return _currentAccountId;
  }

  // Para contextos sin ytcfg (iframe del panel, popup)
  async function loadAccountId() {
    if (_currentAccountId) return _currentAccountId;
    try {
      const data = await chrome.storage.local.get('__active_account_id__');
      const cached = data['__active_account_id__'] || null;
      // Ignorar valores antiguos no canónicos (bug de detección por DOM).
      _currentAccountId = isCanonicalChannelId(cached) ? cached : null;
    } catch (_) {}
    return _currentAccountId;
  }

  function onSwitch(callback) {
    _switchCallbacks.push(callback);
  }

  window.YCSM.account = { detect, getAccountId, loadAccountId, onSwitch };
})();
