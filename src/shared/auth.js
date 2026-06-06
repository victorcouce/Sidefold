/**
 * auth.js — Autenticación con Google vía Supabase
 * Expone window.YCSM.auth con métodos para login/logout y gestión de sesión.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  const SESSION_KEY = '__supabase_session__';

  /**
   * Decodifica un JWT sin verificar firma (seguro porque ya lo hizo Supabase).
   */
  function decodeJWT(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1]));
      return payload;
    } catch (_) {
      return null;
    }
  }

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
   * Obtiene la sesión almacenada en chrome.storage.local.
   */
  async function getStoredSession() {
    if (!isContextValid()) return null;
    try {
      const data = await chrome.storage.local.get(SESSION_KEY);
      const session = data[SESSION_KEY];
      if (!session) return null;
      // Verificar que no haya expirado
      if (session.expiresAt && session.expiresAt < Date.now()) {
        await chrome.storage.local.remove(SESSION_KEY);
        return null;
      }
      return session;
    } catch (_) {
      return null;
    }
  }

  /**
   * Almacena una sesión en chrome.storage.local.
   */
  async function storeSession(session) {
    if (!isContextValid()) return false;
    try {
      await chrome.storage.local.set({ [SESSION_KEY]: session });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Inicia sesión con Google vía launchWebAuthFlow contra Supabase.
   */
  async function signIn() {
    if (!YCSM.config) throw new Error('config.js not loaded');

    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl =
      `${YCSM.config.SUPABASE_URL}/auth/v1/authorize?` +
      `provider=google&` +
      `redirect_to=${encodeURIComponent(redirectUrl)}&` +
      `response_type=token&` +
      `scope=${encodeURIComponent('openid email profile')}&` +
      `client_id=${encodeURIComponent(YCSM.config.SUPABASE_ANON_KEY)}`;

    let redirectUrlWithCode;
    try {
      redirectUrlWithCode = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
          { url: authUrl, interactive: true },
          (url) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(url);
            }
          }
        );
      });
    } catch (e) {
      throw new Error(`Auth flow failed: ${e.message}`);
    }

    // Extraer tokens del fragment
    const urlObj = new URL(redirectUrlWithCode);
    const fragment = new URLSearchParams(urlObj.hash.slice(1));
    const accessToken = fragment.get('access_token');
    const refreshToken = fragment.get('refresh_token');
    const expiresIn = parseInt(fragment.get('expires_in'), 10) || 3600;

    if (!accessToken) {
      throw new Error('No access_token in response');
    }

    const payload = decodeJWT(accessToken);
    if (!payload) {
      throw new Error('Invalid JWT');
    }

    const session = {
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt: Date.now() + expiresIn * 1000,
      user: {
        id: payload.sub,
        email: payload.email || null,
      },
    };

    await storeSession(session);
    return session;
  }

  /**
   * Refresca la sesión usando el refresh_token.
   */
  async function refreshIfNeeded() {
    const session = await getStoredSession();
    if (!session) return null;

    // Si no está a punto de expirar, devolver
    if (session.expiresAt > Date.now() + 5 * 60 * 1000) {
      return session;
    }

    if (!session.refreshToken) {
      // No hay token de refresh, desloguear
      await signOut();
      return null;
    }

    try {
      const response = await fetch(`${YCSM.config.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': YCSM.config.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          refresh_token: session.refreshToken,
        }),
      });

      if (!response.ok) {
        await signOut();
        return null;
      }

      const data = await response.json();
      const newSession = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || session.refreshToken,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
        user: session.user,
      };

      await storeSession(newSession);
      return newSession;
    } catch (e) {
      console.warn('[YCSM] refresh token failed:', e.message);
      return null;
    }
  }

  /**
   * Obtiene la sesión actual (refrescando si es necesario).
   */
  async function getSession() {
    const session = await getStoredSession();
    if (!session) return null;

    // Si está cerca de expirar, refrescar
    if (session.expiresAt < Date.now() + 5 * 60 * 1000) {
      return await refreshIfNeeded();
    }

    return session;
  }

  /**
   * Obtiene la información del usuario.
   */
  async function getUser() {
    const session = await getSession();
    return session?.user || null;
  }

  /**
   * Cierra sesión.
   */
  async function signOut() {
    if (!isContextValid()) return;
    try {
      await chrome.storage.local.remove(SESSION_KEY);
    } catch (_) {}
  }

  window.YCSM.auth = {
    signIn,
    signOut,
    getSession,
    getUser,
    refreshIfNeeded,
  };
})();
