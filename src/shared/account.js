/**
 * account.js — Detección de cuenta YouTube activa
 * Expone window.YCSM.account con métodos para acceder al channel ID del usuario logueado
 * y notificaciones de cambio de cuenta.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let _currentAccountId = null;
  const _switchCallbacks = [];

  function detect() {
    const ytcfg = window.ytcfg?.data_;
    const loggedIn = ytcfg?.LOGGED_IN !== false;
    const newId = loggedIn ? (ytcfg?.CHANNEL_ID || null) : null;

    if (newId === null) {
      return { accountId: _currentAccountId, changed: false, ready: false };
    }

    const changed = _currentAccountId !== null && _currentAccountId !== newId;
    const prevId = _currentAccountId;
    _currentAccountId = newId;

    // Persistir en storage para que el iframe del panel pueda leerlo
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ '__active_account_id__': newId });
    }

    if (changed) {
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
