/**
 * content.js — Controlador principal del content script.
 * Gestiona inyección, MutationObserver y navegación SPA de YouTube.
 */
(function () {
  let isInjected = false;
  let injectTimeout = null;
  let observer = null;
  let subsNavTimeout = null;   // debounce para injectSubscriptionsNav

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
    injectTimeout = setTimeout(tryInject, delayMs);
  }

  // Debounce centralizado para inyectar el nav de suscripciones.
  // Cancela el timer anterior, garantizando que solo se ejecuta una inyección
  // tras el último evento, aunque yt-page-data-updated dispare varias veces.
  function scheduleSubsNavInject(delayMs = 800) {
    clearTimeout(subsNavTimeout);
    subsNavTimeout = setTimeout(() => YCSM.subscriptionsFilter?.injectSubscriptionsNav(), delayMs);
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
    isInjected = false;
    scheduleInject(600);
    // Navbar de suscripciones
    if (location.pathname === '/feed/subscriptions') {
      scheduleSubsNavInject(800);
    } else {
      clearTimeout(subsNavTimeout);
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
    if (location.pathname === '/feed/subscriptions') {
      scheduleSubsNavInject(600);
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

    // Navbar de suscripciones en carga directa (YouTube tarda en renderizar el grid)
    if (location.pathname === '/feed/subscriptions') scheduleSubsNavInject(1500);

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
