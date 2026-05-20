/**
 * content.js — Controlador principal del content script.
 * Gestiona inyección, MutationObserver y navegación SPA de YouTube.
 */
(function () {
  let isInjected = false;
  let injectTimeout = null;
  let injectMaxWait = null;   // garantiza inyección aunque el debounce siga rebotando
  let observer = null;

  /* ═══════════════════════════════════════════════════════════════
     INYECCIÓN CON REINTENTOS
  ═══════════════════════════════════════════════════════════════ */

  async function tryInject() {
    // Si el sidebar ya existe en el DOM, no hacer nada
    if (document.getElementById('ycsm-sidebar')) {
      isInjected = true;
      return;
    }

    const success = await YCSM.sidebar.injectIntoYouTube();
    if (success) {
      isInjected = true;
    }
  }

  function scheduleInject(delayMs = 300) {
    clearTimeout(injectTimeout);
    injectTimeout = setTimeout(fireInject, delayMs);
    if (!injectMaxWait) {
      injectMaxWait = setTimeout(fireInject, Math.max(delayMs, 1500));
    }
  }

  function fireInject() {
    clearTimeout(injectTimeout);
    clearTimeout(injectMaxWait);
    injectTimeout = null;
    injectMaxWait = null;
    tryInject();
  }

  function isSubscriptionsPage() {
    return location.pathname === '/feed/subscriptions';
  }

  function isChannelPage() {
    return /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
  }

  function shouldShowCategoryButton() {
    return location.pathname.startsWith('/watch') || isChannelPage();
  }

  /* ═══════════════════════════════════════════════════════════════
     MUTATION OBSERVER — supervisa el sidebar de YouTube
  ═══════════════════════════════════════════════════════════════ */

  function setupObserver() {
    if (observer) observer.disconnect();

    const target = document.querySelector('ytd-app') || document.body;

    observer = new MutationObserver(() => {
      // Si nuestro sidebar fue eliminado por un re-render de YouTube, reinyectar
      if (isInjected && !document.getElementById('ycsm-sidebar')) {
        isInjected = false;
        scheduleInject(400);
        return;
      }
      // Si aún no hemos inyectado y el guide-content ya está disponible
      if (!isInjected) {
        scheduleInject(300);
      }
      if (shouldShowCategoryButton() && !document.getElementById('ycsm-label-btn')) {
        YCSM.videoLabel?.scheduleInject(500);
      }
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     MENSAJES DESDE POPUP / BACKGROUND
  ═══════════════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {
      case 'openPanel':
        YCSM.panel.open();
        sendResponse({ success: true });
        break;

      case 'refreshSidebar':
        YCSM.sidebar.scheduleRender();
        sendResponse({ success: true });
        break;

      case 'getChannels':
        sendResponse({ channels: YCSM.panel.scrapeChannelsFromDOM() });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
        break;
    }
    // Devolver true no es necesario aquí porque las respuestas son síncronas
  });

  /* ═══════════════════════════════════════════════════════════════
     REACTIVIDAD AL STORAGE
  ═══════════════════════════════════════════════════════════════ */

  YCSM.storage.onChange((changes) => {
    if (document.getElementById('ycsm-sidebar')) {
      YCSM.sidebar.scheduleRender();
    }
    if (changes.categories && location.pathname === '/feed/subscriptions') {
      YCSM.subscriptionsFilter?.refreshNav();
    }
    // Sincronizar el botón de categorías con cualquier cambio de storage
    if (document.getElementById('ycsm-label-btn')) {
      YCSM.videoLabel?.scheduleButtonStateUpdate();
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     NAVEGACIÓN SPA DE YOUTUBE
  ═══════════════════════════════════════════════════════════════ */

  // YouTube emite este evento tras cada navegación interna
  document.addEventListener('yt-navigate-finish', () => {
    // Resetear el maxWait para que empiece fresco en la nueva página
    clearTimeout(injectMaxWait);
    injectMaxWait = null;
    isInjected = false;
    scheduleInject(600);
    // Navbar de suscripciones: el módulo gestiona su propio observer
    // y reacciona en cuanto aparece el grid, así que basta con dispararlo.
    if (isSubscriptionsPage()) {
      YCSM.subscriptionsFilter?.injectSubscriptionsNav();
    } else {
      YCSM.subscriptionsFilter?.cleanup();
    }
    // Botón de categorías en página de vídeo o canal
    YCSM.videoLabel?.cleanup();
    if (shouldShowCategoryButton()) {
      YCSM.videoLabel?.scheduleInject(900);
    }
  });

  // Algunos cambios de ruta también emiten este evento
  document.addEventListener('yt-page-data-updated', () => {
    if (!isInjected) scheduleInject(500);
    if (isSubscriptionsPage()) {
      YCSM.subscriptionsFilter?.injectSubscriptionsNav();
    }
    // Reintentar inyección del botón de categorías si la página cargó más contenido
    if (shouldShowCategoryButton()) {
      YCSM.videoLabel?.scheduleInject(600);
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     INICIALIZACIÓN
  ═══════════════════════════════════════════════════════════════ */

  async function init() {
    setupObserver();

    // Primer intento inmediato; si falla, los reintentos vienen del observer
    await tryInject();

    // Navbar de suscripciones en carga directa.
    // reconcile() es idempotente y monta su propio observer; no necesita delays.
    if (isSubscriptionsPage()) YCSM.subscriptionsFilter?.injectSubscriptionsNav();

    // Botón de categorías en carga directa de página de vídeo o canal
    if (shouldShowCategoryButton()) {
      YCSM.videoLabel?.scheduleInject(1200);
    }

    // Si tras 3 s todavía no inyectamos, reintentar (para cargas lentas)
    if (!isInjected) {
      setTimeout(async () => {
        if (!isInjected) await tryInject();
      }, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
