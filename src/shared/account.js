/**
 * account.js — Detección de cuenta YouTube activa
 * Expone window.YCSM.account con métodos para acceder al channel ID del usuario logueado
 * y notificaciones de cambio de cuenta.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let _currentAccountId = null;
  const _switchCallbacks = [];

  function getChannelIdFromYtcfg() {
    const ytcfg = window.ytcfg?.data_;
    if (!ytcfg) return null;
    // Probar múltiples ubicaciones donde YouTube almacena el channel ID
    return (
      ytcfg.CHANNEL_ID ||
      ytcfg.DELEGATED_SESSION_ID?.split('|')?.[0] ||
      null
    );
  }

  function getChannelIdFromDOM() {
    // Extraer channel ID del avatar en el header
    const avatarLink = document.querySelector('#avatar-link, ytd-topbar-logo-button-renderer a[href*="/@"], a[href*="/channel/UC"]');
    if (avatarLink?.href) {
      const match = avatarLink.href.match(/(?:\/@|\/channel\/)([a-zA-Z0-9_-]+)/);
      if (match) return match[1];
    }
    // Buscar en los scripts de ytInitialData
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        if (script.textContent.includes('CHANNEL_ID')) {
          const match = script.textContent.match(/"CHANNEL_ID":"([^"]+)"/);
          if (match) return match[1];
        }
      }
    } catch (_) {}
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
      _currentAccountId = data['__active_account_id__'] || null;
    } catch (_) {}
    return _currentAccountId;
  }

  function onSwitch(callback) {
    _switchCallbacks.push(callback);
  }

  window.YCSM.account = { detect, getAccountId, loadAccountId, onSwitch };
})();
