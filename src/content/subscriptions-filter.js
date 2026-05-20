/**
 * subscriptions-filter.js — Navbar de categorías en /feed/subscriptions
 *
 * Estrategia (robusta, sin polling):
 *  - Un MutationObserver persistente sobre `ytd-page-manager` dispara
 *    `reconcile()` con debounce en cada cambio relevante del DOM.
 *  - `reconcile()` es idempotente y es la única función que decide qué hacer:
 *      • Si no estamos en /feed/subscriptions → cleanup() y fuera.
 *      • Si el grid aún no existe → no-op (el observer volverá a llamar
 *        cuando aparezca; no hacen falta setTimeout retries).
 *      • Si el nav ya está bien colocado → solo aplica el filtro pendiente
 *        si lo hay y se asegura de que el filterObserver esté activo.
 *      • Si falta o está mal colocado → lo reconstruye e inyecta.
 *  - Las llamadas asincrónicas se versionan: si entra una reconciliación
 *    nueva mientras una anterior está en `await`, la anterior se autoinvalida.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let activeFilter = null;      // null = Todos, string = categoryId
  let filterObserver = null;    // observa el grid para vídeos lazy-loaded
  let pageObserver = null;      // observa ytd-page-manager para detectar el grid
  let navEl = null;
  let _hrefToId = {};
  let _injectVersion = 0;
  let _reconcileTimer = null;
  let _reconcileMaxWait = null;   // garantiza que reconcile() se dispara aunque el debounce siga rebotando
  let _filterDebounce = null;

  const { t } = YCSM.i18n;

  /* ─── Utilidades ──────────────────────────────────────────── */

  function isSubscriptionsPage() {
    return location.pathname === '/feed/subscriptions';
  }

  function normalizeHref(href) {
    if (!href) return null;
    return href.split('?')[0];
  }

  function getGrid() {
    return document.querySelector('ytd-rich-grid-renderer');
  }

  function resolveChannelId(href) {
    if (!href) return null;
    const norm = normalizeHref(href);
    if (_hrefToId[norm]) return _hrefToId[norm];
    if (norm.startsWith('/channel/')) return norm.replace('/channel/', '');
    return norm;
  }

  function getVideoChannelId(itemEl) {
    const link = itemEl.querySelector(
      '#avatar-link[href], a[href^="/@"], a[href^="/channel/"], a[href^="/c/"]'
    );
    const href = link?.getAttribute('href');
    if (!href) return null;
    if (!href.startsWith('/@') && !href.startsWith('/channel/') && !href.startsWith('/c/')) return null;
    return resolveChannelId(href);
  }

  async function buildHrefMap() {
    const { channels } = await YCSM.storage.getCachedChannels();
    _hrefToId = {};
    (channels || []).forEach((ch) => {
      if (ch.href) _hrefToId[normalizeHref(ch.href)] = ch.id;
      if (ch.id && ch.id.startsWith('UC')) {
        _hrefToId[`/channel/${ch.id}`] = ch.id;
      }
    });
  }

  /* ─── Filtrado ─────────────────────────────────────────────── */

  async function applyFilter({ animate = false } = {}) {
    const { channelAssignments: assignments } = await YCSM.storage.getAll();

    const grid = getGrid();

    if (animate && grid) {
      grid.style.transition = 'none';
      grid.style.opacity = '0';
    }

    // Pausar el observer mientras aplicamos cambios para evitar bucle infinito
    if (filterObserver) filterObserver.disconnect();

    // ── vídeos normales ──────────────────────────────────────────
    document.querySelectorAll('ytd-rich-item-renderer').forEach((item) => {
      if (!activeFilter) {
        item.style.removeProperty('display');
        return;
      }
      const chId = getVideoChannelId(item);
      if (!chId) {
        item.style.setProperty('display', 'none', 'important');
        return;
      }
      const cats = assignments[chId] || [];
      if (cats.includes(activeFilter)) {
        item.style.removeProperty('display');
      } else {
        item.style.setProperty('display', 'none', 'important');
      }
    });

    // ── secciones ("Más recientes", "Más relevantes") ────────────
    document.querySelectorAll('ytd-rich-section-renderer').forEach((section) => {
      const sectionItems = section.querySelectorAll('ytd-rich-item-renderer');
      if (!sectionItems.length) return;
      const anyVisible = Array.from(sectionItems).some(
        (it) => it.style.getPropertyValue('display') !== 'none'
      );
      if (anyVisible) {
        section.style.removeProperty('display');
      } else {
        section.style.setProperty('display', 'none', 'important');
      }
    });

    // ── bloque de Shorts ─────────────────────────────────────────
    document.querySelectorAll('ytd-rich-shelf-renderer').forEach((shelf) => {
      if (activeFilter) {
        shelf.style.setProperty('display', 'none', 'important');
      } else {
        shelf.style.removeProperty('display');
      }
    });

    if (grid) {
      requestAnimationFrame(() => {
        grid.style.transition = 'opacity 0.2s ease';
        grid.style.opacity = '1';
      });
    }

    setupFilterObserver();
  }

  /* ─── Navbar ───────────────────────────────────────────────── */

  async function buildNav() {
    const { categories } = await YCSM.storage.getAll();
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    if (navEl) navEl.remove();
    navEl = document.createElement('div');
    navEl.id = 'ycsm-subs-nav';
    navEl.className = 'ycsm-subs-nav';

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'ycsm-subs-nav-scroll';

    // Pill "Todos"
    const allPill = makePill(t('all'), null, activeFilter === null);
    allPill.addEventListener('click', () => {
      activeFilter = null;
      refreshPills();
      applyFilter({ animate: true });
    });
    scrollWrap.appendChild(allPill);

    sorted.forEach((cat) => {
      const pill = makePill(cat.name, cat.id, activeFilter === cat.id);
      pill.addEventListener('click', () => {
        activeFilter = cat.id;
        refreshPills();
        applyFilter({ animate: true });
        pill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      });
      scrollWrap.appendChild(pill);
    });

    navEl.appendChild(scrollWrap);

    function updateFades() {
      const sl = scrollWrap.scrollLeft;
      const maxSl = scrollWrap.scrollWidth - scrollWrap.clientWidth;
      navEl.classList.toggle('ycsm-subs-can-scroll-left', sl > 1);
      navEl.classList.toggle('ycsm-subs-can-scroll-right', sl < maxSl - 1);
    }
    scrollWrap.addEventListener('scroll', updateFades, { passive: true });
    requestAnimationFrame(() => requestAnimationFrame(updateFades));

    return navEl;
  }

  function makePill(text, catId, isActive) {
    const btn = document.createElement('button');
    btn.className = 'ycsm-subs-pill' + (isActive ? ' ycsm-subs-pill-active' : '');
    btn.textContent = text;
    if (catId) btn.dataset.catId = catId;
    return btn;
  }

  function refreshPills() {
    if (!navEl) return;
    navEl.querySelectorAll('.ycsm-subs-pill').forEach((pill) => {
      const isActive = activeFilter === null
        ? !pill.dataset.catId
        : pill.dataset.catId === activeFilter;
      pill.classList.toggle('ycsm-subs-pill-active', isActive);
    });
  }

  /* ─── Observer para vídeos cargados lazy ───────────────────── */

  function setupFilterObserver() {
    if (filterObserver) filterObserver.disconnect();
    const contents = document.querySelector(
      'ytd-rich-grid-renderer #contents, #contents.ytd-rich-grid-renderer'
    );
    if (!contents) { filterObserver = null; return; }
    filterObserver = new MutationObserver((mutations) => {
      // Si hay filtro activo, ocultar nuevos items ANTES de que el browser los pinte
      if (activeFilter) {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'YTD-RICH-ITEM-RENDERER') {
              node.style.setProperty('display', 'none', 'important');
            }
            node.querySelectorAll?.('ytd-rich-item-renderer').forEach((el) => {
              el.style.setProperty('display', 'none', 'important');
            });
          }
        }
      }
      clearTimeout(_filterDebounce);
      _filterDebounce = setTimeout(() => applyFilter(), 400);
    });
    filterObserver.observe(contents, { childList: true, subtree: true });
  }

  /* ─── Reconciliación (núcleo) ──────────────────────────────── */

  // Debounce con maxWait: el debounce normal se resetea en cada llamada,
  // pero el maxWait garantiza la ejecución aunque las mutaciones del DOM de
  // YouTube sigan rebotando indefinidamente el timer (livelock).
  function scheduleReconcile(delay = 100) {
    clearTimeout(_reconcileTimer);
    _reconcileTimer = setTimeout(fireReconcile, delay);
    if (!_reconcileMaxWait) {
      _reconcileMaxWait = setTimeout(fireReconcile, Math.max(delay, 600));
    }
  }

  function fireReconcile() {
    clearTimeout(_reconcileTimer);
    clearTimeout(_reconcileMaxWait);
    _reconcileTimer = null;
    _reconcileMaxWait = null;
    reconcile();
  }

  async function reconcile() {
    if (!isSubscriptionsPage()) {
      cleanup();
      return;
    }

    setupPageObserver();

    const grid = getGrid();
    if (!grid) return; // el page observer volverá a llamarnos cuando aparezca

    // ── Caso 1: el nav ya está donde toca ────────────────────────
    if (navEl && navEl.isConnected && navEl.nextElementSibling === grid) {
      const pending = sessionStorage.getItem('ycsm_pending_filter');
      if (pending) {
        sessionStorage.removeItem('ycsm_pending_filter');
        activeFilter = pending;
        refreshPills();
        applyFilter({ animate: false });
      } else if (!filterObserver) {
        // Asegura que el filterObserver siga activo aunque YouTube haya
        // reemplazado #contents bajo nuestros pies.
        setupFilterObserver();
      }
      return;
    }

    // ── Caso 2: hay que (re)inyectar ─────────────────────────────
    const myVersion = ++_injectVersion;

    await buildHrefMap();
    if (_injectVersion !== myVersion || !isSubscriptionsPage()) return;

    const { categories } = await YCSM.storage.getAll();
    if (Object.keys(categories).length === 0) return;

    const freshGrid = getGrid();
    if (!freshGrid) return;

    // Consume el filtro pendiente que dejó el sidebar antes de navegar
    const pending = sessionStorage.getItem('ycsm_pending_filter');
    if (pending) {
      activeFilter = pending;
      sessionStorage.removeItem('ycsm_pending_filter');
    }

    const nav = await buildNav();
    if (_injectVersion !== myVersion || !isSubscriptionsPage() || !freshGrid.isConnected) return;

    freshGrid.parentElement.insertBefore(nav, freshGrid);
    setupFilterObserver();
    applyFilter({ animate: false });
  }

  /* ─── Observer de la página (watchdog) ─────────────────────── */

  function setupPageObserver() {
    if (pageObserver) return;
    const target = document.querySelector('ytd-page-manager')
                 || document.querySelector('ytd-app')
                 || document.body;
    if (!target) return;
    pageObserver = new MutationObserver(() => scheduleReconcile(120));
    pageObserver.observe(target, { childList: true, subtree: true });
  }

  function teardownPageObserver() {
    pageObserver?.disconnect();
    pageObserver = null;
  }

  /* ─── Limpieza ─────────────────────────────────────────────── */

  function cleanup() {
    if (filterObserver) { filterObserver.disconnect(); filterObserver = null; }
    teardownPageObserver();
    clearTimeout(_filterDebounce);
    clearTimeout(_reconcileTimer);
    clearTimeout(_reconcileMaxWait);
    _reconcileTimer = null;
    _reconcileMaxWait = null;
    navEl?.remove();
    navEl = null;
    activeFilter = null;
    _hrefToId = {};
    _injectVersion++; // invalida cualquier reconciliación en vuelo
  }

  function activateFilter(categoryId) {
    activeFilter = categoryId;
    if (navEl) refreshPills();
    applyFilter({ animate: true });
  }

  /* ─── API pública ──────────────────────────────────────────── */
  //
  // `injectSubscriptionsNav` y `refreshNav` mantienen el nombre por compatibilidad,
  // pero ahora ambas delegan en la misma reconciliación idempotente.
  // `refreshNav` además fuerza una reconstrucción del nav (p.ej. tras
  // cambios en categorías), eliminando el nav existente para invalidar Caso 1.

  window.YCSM.subscriptionsFilter = {
    injectSubscriptionsNav: () => scheduleReconcile(0),
    refreshNav: () => {
      navEl?.remove();
      navEl = null;
      scheduleReconcile(0);
    },
    cleanup,
    activateFilter,
  };
})();
