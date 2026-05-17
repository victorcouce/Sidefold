/**
 * panel.js — Bulk Assignment Panel
 * Panel flotante para asignar canales a categorías de forma masiva.
 * Compatible como content script inyectado en YouTube.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  /* ── Utilidades ── */
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function normalizeSearch(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  let panelEl = null;
  let allChannels = [];
  let filterText = '';
  let filterCat = null;   // ID de categoría activa para filtrar, o null
  let sortBy = 'activity'; // 'activity' | 'name'
  let selectedIds = new Set(); // IDs de canales seleccionados en modo multi
  let selectionMode = false;  // true = modo multi-selección activo
  const _dateCache = new Map(); // channelId → ISO date string | null
  let _dateObserver = null;
  let _lastSeen = {};             // channelId → ISO string (cuándo visitó el canal por última vez)

  /* ═══════════════════════════════════════════════════════════════
     ESTRATEGIA 1: Fetch de /feed/channels (más fiable que DOM)
  ═══════════════════════════════════════════════════════════════ */

  /**
   * Extrae el primer objeto JSON que contiene 'ytInitialData' de un script.
   * Usa conteo de llaves con manejo correcto de strings para no confundirse
   * con '{' / '}' dentro de valores de cadena.
   */
  function extractYtInitialData(scriptText) {
    const idx = scriptText.indexOf('ytInitialData');
    if (idx === -1) return null;
    const start = scriptText.indexOf('{', idx);
    if (start === -1) return null;

    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < scriptText.length; i++) {
      const c = scriptText[i];
      if (esc)          { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true;  continue; }
      if (c === '"')   { inStr = !inStr; continue; }
      if (inStr)       { continue; }
      if (c === '{')   { depth++; }
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(scriptText.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  /**
   * Recorre el árbol JSON de ytInitialData de forma iterativa buscando
   * todos los objetos channelRenderer (suscripciones del usuario).
   */
  function collectChannelRenderers(root) {
    const channels = [];
    const seen = new Set();
    const stack = [root];

    while (stack.length) {
      const obj = stack.pop();
      if (!obj || typeof obj !== 'object') continue;

      if (Array.isArray(obj)) {
        for (const item of obj) stack.push(item);
        continue;
      }

      if (obj.channelRenderer) {
        const r = obj.channelRenderer;
        const id = r.channelId;
        if (id && !seen.has(id)) {
          seen.add(id);
          const handle = r.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
          const name = r.title?.simpleText || r.title?.runs?.[0]?.text || id;
          const thumbs = r.thumbnail?.thumbnails || [];
          const avatar = thumbs[thumbs.length - 1]?.url || '';
          channels.push({ id, name, avatar, href: handle || `/channel/${id}` });
        }
        // No seguir recursión dentro del channelRenderer
        continue;
      }

      for (const v of Object.values(obj)) stack.push(v);
    }

    return channels;
  }

  /**
   * Obtiene TODAS las suscripciones fetching la página /feed/channels.
   * YouTube embebe ytInitialData con todos los channelRenderers en el HTML.
   * No depende del DOM del sidebar ni de expansiones frágiles.
   */
  async function fetchAllSubscriptions() {
    try {
      const resp = await fetch('https://www.youtube.com/feed/channels', {
        credentials: 'include',
      });
      if (!resp.ok) return [];
      const html = await resp.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      let ytData = null;
      for (const script of doc.querySelectorAll('script')) {
        if (!script.textContent.includes('ytInitialData')) continue;
        ytData = extractYtInitialData(script.textContent);
        if (ytData) break;
      }

      if (!ytData) return [];

      const channels = collectChannelRenderers(ytData);
      // Se preserva el orden de YouTube (actividad reciente) para la opción de ordenación
      return channels;
    } catch (e) {
      console.warn('[YCSM] fetchAllSubscriptions error:', e.message);
      return [];
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     ESTRATEGIA 2 (fallback): Scraping del DOM del sidebar
  ═══════════════════════════════════════════════════════════════ */

  function countCollapsibleEntries() {
    return document.querySelectorAll(
      'ytd-guide-collapsible-section-entry-renderer ytd-guide-entry-renderer'
    ).length;
  }

  async function expandYouTubeSubscriptions() {
    const collapsibles = document.querySelectorAll(
      'ytd-guide-collapsible-section-entry-renderer'
    );
    if (collapsibles.length === 0) return;

    // Snapshot del número de entradas ANTES de expandir
    const countBefore = countCollapsibleEntries();

    let clicked = false;
    for (const section of collapsibles) {
      const trigger = section.querySelector(
        '#expander-item, #expander, [role="button"][aria-expanded="false"]'
      );
      if (!trigger) continue;

      const isCollapsed =
        trigger.getAttribute('aria-expanded') === 'false' ||
        section.hasAttribute('collapsed') ||
        !section.hasAttribute('expanded');

      if (isCollapsed) {
        trigger.click();
        clicked = true;
      }
    }

    if (!clicked) return;

    // Esperar a que el número de entradas supere el snapshot inicial.
    // Luego esperar 300 ms adicionales por si YouTube sigue cargando más.
    // Safety timeout: 3 s.
    await new Promise((resolve) => {
      let stabilizeTimer = null;

      const done = () => {
        mo.disconnect();
        clearTimeout(safetyTimer);
        clearTimeout(stabilizeTimer);
        resolve();
      };

      const safetyTimer = setTimeout(done, 3000);

      const mo = new MutationObserver(() => {
        if (countCollapsibleEntries() > countBefore) {
          // Nuevas entradas detectadas; esperar 300 ms por si llegan más
          clearTimeout(stabilizeTimer);
          stabilizeTimer = setTimeout(done, 300);
        }
      });

      mo.observe(document.body, { childList: true, subtree: true });
    });
  }

  function scrapeChannelsFromDOM() {
    const channels = [];
    const seen = new Set();

    // Recoger todos los enlaces que apunten a canales en cualquier parte del DOM
    const links = document.querySelectorAll(
      'ytd-guide-entry-renderer a, ' +
      'ytd-guide-collapsible-section-entry-renderer a, ' +
      'ytd-subscription-item-renderer a, ' +
      'ytd-channel-renderer a'
    );

    links.forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (
        !href.startsWith('/channel/') &&
        !href.startsWith('/@') &&
        !href.startsWith('/c/')
      )
        return;

      const channelId = href.startsWith('/channel/')
        ? href.replace('/channel/', '').split('?')[0]
        : href.split('?')[0];

      if (!channelId || seen.has(channelId)) return;
      seen.add(channelId);

      // Contexto: elemento padre del enlace
      const entry =
        link.closest('ytd-guide-entry-renderer') ||
        link.closest('ytd-subscription-item-renderer') ||
        link.closest('ytd-channel-renderer') ||
        link.parentElement;

      const nameEl = entry?.querySelector(
        'yt-formatted-string, #channel-title, #display-name, #label, .title'
      );
      const name =
        nameEl?.textContent?.trim() ||
        link.getAttribute('title') ||
        link.getAttribute('aria-label') ||
        channelId;

      const imgEl = entry?.querySelector('img#img, yt-img-shadow img, img');
      const avatar = imgEl?.src || '';

      channels.push({ id: channelId, name: name.trim(), avatar, href });
    });

    return channels.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  }

  /* ═══════════════════════════════════════════════════════════════
     CONSTRUCCIÓN DEL PANEL
  ═══════════════════════════════════════════════════════════════ */

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value ?? '')));
    return div.innerHTML;
  }



  function buildPanel() {
    const overlay = document.createElement('div');
    overlay.id = 'ycsm-panel';
    overlay.className = 'ycsm-panel-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Organizar suscripciones de YouTube');

    overlay.innerHTML = `
      <div class="ycsm-panel-backdrop" aria-hidden="true"></div>
      <div class="ycsm-panel-box">
        <div class="ycsm-panel-head">
          <h2>Organizar Suscripciones</h2>
          <button class="ycsm-btn-select" id="ycsm-btn-select" aria-pressed="false" title="Activar selección múltiple"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg> Seleccionar</button>
          <button class="ycsm-btn-icon ycsm-panel-x" aria-label="Cerrar panel">✕</button>
        </div>
        <div class="ycsm-panel-body">
          <div class="ycsm-panel-toolbar">
            <div class="ycsm-yt-search-container">
              <div class="ycsm-yt-search-box">
                <svg class="ycsm-yt-search-left-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <input
                  class="ycsm-yt-search-input"
                  type="text"
                  placeholder="Buscar canal…"
                  aria-label="Buscar canal por nombre"
                  autocomplete="off"
                >
                <button class="ycsm-yt-search-clear" aria-label="Borrar búsqueda" hidden>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>
                </button>
              </div>
              <button class="ycsm-yt-search-btn" aria-label="Buscar">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
            </div>
            <select class="ycsm-panel-sort" aria-label="Ordenar canales">
              <option value="activity">Recientes</option>
              <option value="name">A → Z</option>
            </select>
          </div>
          <div class="ycsm-panel-legend" aria-label="Categorías disponibles">
          </div>
          <div class="ycsm-panel-channels" role="list" aria-label="Lista de canales suscritos"></div>
        </div>
        <div class="ycsm-panel-bulk" id="ycsm-panel-bulk" hidden>
          <span class="ycsm-bulk-count" id="ycsm-bulk-count">0 seleccionados</span>
          <div class="ycsm-bulk-actions">
            <div class="ycsm-bulk-cat-wrap">
              <button class="ycsm-bulk-cat-btn" id="ycsm-bulk-cat-btn">Asignar categoría</button>
              <div class="ycsm-bulk-cat-menu" id="ycsm-bulk-cat-menu" hidden></div>
            </div>

          </div>
        </div>
        <div class="ycsm-panel-foot">
          <span class="ycsm-panel-count" aria-live="polite"></span>
          <button class="ycsm-panel-close-btn">Cerrar</button>
        </div>
      </div>
    `;

    return overlay;
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDER DEL CONTENIDO
  ═══════════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════════
     MODO MULTI-SELECCIÓN
  ═══════════════════════════════════════════════════════════════ */

  function updateBulkBar() {
    if (!panelEl) return;
    const bar = panelEl.querySelector('#ycsm-panel-bulk');
    const countEl = panelEl.querySelector('#ycsm-bulk-count');
    const n = selectedIds.size;
    bar.hidden = !selectionMode;
    countEl.textContent = `${n} canal${n !== 1 ? 'es' : ''} seleccionado${n !== 1 ? 's' : ''}`;
    panelEl.querySelector('#ycsm-bulk-cat-btn').disabled = n === 0;
  }

  function toggleCardSelection(card, channelId) {
    if (selectedIds.has(channelId)) {
      selectedIds.delete(channelId);
      card.classList.remove('ycsm-card-selected');
    } else {
      selectedIds.add(channelId);
      card.classList.add('ycsm-card-selected');
    }
    updateBulkBar();
  }

  function enterSelectionMode() {
    selectionMode = true;
    selectedIds.clear();
    const btn = panelEl.querySelector('#ycsm-btn-select');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg> Cancelar';
    btn.setAttribute('aria-pressed', 'true');
    panelEl.querySelector('.ycsm-panel-box').classList.add('ycsm-selection-active');
    // Añadir clase a todas las tarjetas para mostrar checkbox
    panelEl.querySelectorAll('.ycsm-panel-card').forEach((c) =>
      c.classList.add('ycsm-card-selectable')
    );
    updateBulkBar();
  }

  function exitSelectionMode() {
    selectionMode = false;
    selectedIds.clear();
    if (!panelEl) return;
    const btn = panelEl.querySelector('#ycsm-btn-select');
    if (btn) {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg> Seleccionar';
      btn.setAttribute('aria-pressed', 'false');
    }
    panelEl.querySelector('.ycsm-panel-box')?.classList.remove('ycsm-selection-active');
    panelEl.querySelectorAll('.ycsm-panel-card').forEach((c) => {
      c.classList.remove('ycsm-card-selectable', 'ycsm-card-selected');
    });
    updateBulkBar();
  }

  async function bulkAssignCategory(categoryId) {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    for (const chId of ids) {
      await YCSM.storage.assignChannel(chId, categoryId);
    }
    if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
    exitSelectionMode();
    await renderPanelContent();
  }

  /* ═══════════════════════════════════════════════════════════════
     FECHAS DEL ÚLTIMO VÍDEO (carga perezosa vía RSS de YouTube)
  ═══════════════════════════════════════════════════════════════ */

  function formatRelativeDate(isoStr) {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return '';
    const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (diffDays === 0) return 'hoy';
    if (diffDays === 1) return 'ayer';
    if (diffDays < 7) return `hace ${diffDays} días`;
    const w = Math.floor(diffDays / 7);
    if (w < 5) return `hace ${w} semana${w > 1 ? 's' : ''}`;
    const m = Math.floor(diffDays / 30);
    if (m < 12) return `hace ${m} mes${m > 1 ? 'es' : ''}`;
    const y = Math.floor(diffDays / 365);
    return `hace ${y} año${y > 1 ? 's' : ''}`;
  }

  function fetchLastVideoDate(channelId) {
    if (_dateCache.has(channelId)) {
      return Promise.resolve(_dateCache.get(channelId));
    }
    return fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { credentials: 'include' }
    )
      .then((r) => (r.ok ? r.text() : null))
      .then((xml) => {
        if (!xml) { _dateCache.set(channelId, null); return null; }
        // La primera <published> del feed Atom es la fecha de creación del canal.
        // Las fechas de vídeos están dentro de <entry>. Se extrae el <published>
        // del primer <entry>, que corresponde al vídeo más reciente.
        const m = xml.match(/<entry>[\s\S]*?<published>([^<]+)<\/published>/);
        const date = m ? m[1] : null;
        _dateCache.set(channelId, date);
        return date;
      })
      .catch(() => { _dateCache.set(channelId, null); return null; });
  }

  /**
   * Carga las fechas del último vídeo de todos los canales con concurrencia
   * limitada (15 peticiones en paralelo) para no saturar el navegador.
   */
  async function fetchAllDates(channels) {
    const CONCURRENCY = 15;
    const queue = channels.filter((ch) => !_dateCache.has(ch.id));
    async function worker() {
      while (queue.length) {
        const ch = queue.shift();
        await fetchLastVideoDate(ch.id);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
  }

  function loadLastSeen() {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) return resolve({});
        chrome.storage.local.get('channelLastSeen', (r) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(r.channelLastSeen || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  function markChannelSeen(channelId) {
    _lastSeen[channelId] = new Date().toISOString();
    try {
      if (chrome.runtime?.id) {
        chrome.storage.local.set({ channelLastSeen: _lastSeen });
      }
    } catch (_) {}
  }

  /**
   * Devuelve true si el canal tiene un vídeo más nuevo que la última vez que el
   * usuario lo visitó. Si nunca lo visitó, usa 7 días atrás como referencia.
   */
  function hasNewVideo(channelId) {
    const lastVideo = _dateCache.get(channelId);
    if (!lastVideo) return false;
    const ref = _lastSeen[channelId] || new Date(Date.now() - 7 * 86400000).toISOString();
    return lastVideo > ref;
  }

  /* ═══════════════════════════════════════════════════════════════
     PANTALLA DE GESTIÓN DE CATEGORÍAS (vista interna del panel)
  ═══════════════════════════════════════════════════════════════ */

  async function openManageLabels(autoCreate = false) {
    if (!panelEl) return;

    const head    = panelEl.querySelector('.ycsm-panel-head');
    const body    = panelEl.querySelector('.ycsm-panel-body');
    const foot    = panelEl.querySelector('.ycsm-panel-foot');
    const bulk    = panelEl.querySelector('.ycsm-panel-bulk');
    const selectBtn = panelEl.querySelector('#ycsm-btn-select');

    const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const TRASH_SVG  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>`;

    // Guardar estado original para restaurarlo al volver
    const originalHead      = head.innerHTML;
    const originalBodyHTML  = body.innerHTML;
    const originalBodyClass = body.className;
    const box = panelEl.querySelector('.ycsm-panel-box');
    const originalWidth = box ? box.style.width : '';

    // Reducir ancho del modal en la vista de gestión
    if (box) box.style.width = '450px';

    function goBack() {
      // Restaurar ancho original del modal
      if (box) box.style.width = originalWidth;
      head.classList.remove('ycsm-panel-head--manage');
      head.innerHTML = originalHead;
      // Re-conectar listeners de la cabecera (se pierden al restaurar innerHTML)
      head.querySelector('.ycsm-panel-x').addEventListener('click', () => panelEl.remove());
      const newSelectBtn = head.querySelector('#ycsm-btn-select');
      if (newSelectBtn) {
        newSelectBtn.hidden = false;
        newSelectBtn.addEventListener('click', () => {
          if (selectionMode) exitSelectionMode();
          else enterSelectionMode();
        });
      }
      if (foot) foot.hidden = false;
      if (bulk) bulk.hidden = true;
      body.innerHTML = originalBodyHTML;
      body.className = originalBodyClass;
      // Re-conectar eventos del toolbar (se pierden al restaurar innerHTML)
      const searchInput = body.querySelector('.ycsm-yt-search-input');
      if (searchInput) {
        const clearBtn = body.querySelector('.ycsm-yt-search-clear');
        const searchBox = body.querySelector('.ycsm-yt-search-box');
        searchInput.addEventListener('input', debounce((e) => { filterText = e.target.value; if (clearBtn) clearBtn.hidden = !e.target.value; renderPanelContent(); }, 150));
        searchInput.addEventListener('focus', () => { if (searchBox) searchBox.classList.add('ycsm-yt-search-focused'); });
        searchInput.addEventListener('blur', () => { if (searchBox) searchBox.classList.remove('ycsm-yt-search-focused'); });
        if (clearBtn) clearBtn.addEventListener('click', () => { searchInput.value = ''; clearBtn.hidden = true; filterText = ''; searchInput.focus(); renderPanelContent(); });
      }
      const sortSelect = body.querySelector('.ycsm-panel-sort');
      if (sortSelect) { sortSelect.value = sortBy; sortSelect.addEventListener('change', (e) => { sortBy = e.target.value; renderPanelContent(); }); }
      renderPanelContent();
    }

    // Cambiar cabecera
    head.classList.add('ycsm-panel-head--manage');
    head.innerHTML = '';
    const backBtn = document.createElement('button');
    backBtn.className = 'ycsm-manage-back-btn';
    backBtn.setAttribute('aria-label', 'Volver');
    backBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg> Volver`;
    backBtn.addEventListener('click', goBack);

    const headTitle = document.createElement('h2');
    headTitle.textContent = 'Gestionar categorías';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ycsm-btn-icon ycsm-panel-x';
    closeBtn.setAttribute('aria-label', 'Cerrar panel');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => panelEl.remove());

    head.appendChild(backBtn);
    head.appendChild(headTitle);
    head.appendChild(closeBtn);

    if (selectBtn) selectBtn.hidden = true;
    if (foot) foot.hidden = true;
    if (bulk) bulk.hidden = true;

    // Limpiar cuerpo y cambiar a vista de gestión
    body.innerHTML = '';
    body.className = 'ycsm-panel-body ycsm-manage-view';

    async function renderManageContent() {
      body.innerHTML = '';

      const { categories, channelAssignments } = await YCSM.storage.getAll();
      const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

      const countByCat = {};
      Object.values(channelAssignments).forEach((cats) => {
        (cats || []).forEach((cid) => { countByCat[cid] = (countByCat[cid] || 0) + 1; });
      });

      if (sorted.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ycsm-manage-empty';
        empty.textContent = 'Todavía no hay categorías.';
        body.appendChild(empty);
      } else {
        const sectionTitle = document.createElement('p');
        sectionTitle.className = 'ycsm-manage-section-title';
        sectionTitle.textContent = 'Categorías existentes';
        body.appendChild(sectionTitle);

        const list = document.createElement('div');
        list.className = 'ycsm-manage-list';

        let manageDragState = null;

        sorted.forEach((cat) => {
          const row = document.createElement('div');
          row.className = 'ycsm-manage-row';
          row.dataset.catId = cat.id;
          row.setAttribute('draggable', 'false');

          const GRIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
          const grip = document.createElement('span');
          grip.className = 'ycsm-manage-grip';
          grip.innerHTML = GRIP_SVG;

          // Activar draggable solo al hacer mousedown en el grip
          grip.addEventListener('mousedown', () => { row.setAttribute('draggable', 'true'); });

          row.addEventListener('dragstart', (e) => {
            manageDragState = cat.id;
            row.classList.add('ycsm-manage-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', cat.id);
          });
          row.addEventListener('dragend', () => {
            row.setAttribute('draggable', 'false');
            row.classList.remove('ycsm-manage-dragging');
            list.querySelectorAll('.ycsm-manage-drag-over').forEach((el) => el.classList.remove('ycsm-manage-drag-over'));
            manageDragState = null;
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (manageDragState && manageDragState !== cat.id) {
              row.classList.add('ycsm-manage-drag-over');
              e.dataTransfer.dropEffect = 'move';
            }
          });
          row.addEventListener('dragleave', (e) => {
            if (!row.contains(e.relatedTarget)) row.classList.remove('ycsm-manage-drag-over');
          });
          row.addEventListener('drop', async (e) => {
            e.preventDefault();
            row.classList.remove('ycsm-manage-drag-over');
            if (!manageDragState || manageDragState === cat.id) return;
            const rows = [...list.querySelectorAll(':scope > .ycsm-manage-row')];
            const ids = rows.map((r) => r.dataset.catId);
            const fromIdx = ids.indexOf(manageDragState);
            const toIdx = ids.indexOf(cat.id);
            if (fromIdx === -1 || toIdx === -1) return;
            ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, manageDragState);
            await YCSM.storage.reorderCategories(ids);
            await renderManageContent();
          });

          const name = document.createElement('span');
          name.className = 'ycsm-manage-name';
          name.textContent = cat.name;

          const count = document.createElement('span');
          count.className = 'ycsm-manage-count';
          const n = countByCat[cat.id] || 0;
          count.textContent = `${n} canal${n !== 1 ? 'es' : ''}`;

          const actions = document.createElement('div');
          actions.className = 'ycsm-manage-actions';

          const editBtn = document.createElement('button');
          editBtn.className = 'ycsm-manage-action-btn';
          editBtn.setAttribute('aria-label', `Editar ${cat.name}`);
          editBtn.innerHTML = PENCIL_SVG;
          editBtn.addEventListener('click', () => openEditLabel(cat));

          const delBtn = document.createElement('button');
          delBtn.className = 'ycsm-manage-action-btn ycsm-manage-del-btn';
          delBtn.setAttribute('aria-label', `Eliminar ${cat.name}`);
          delBtn.innerHTML = TRASH_SVG;
          delBtn.addEventListener('click', async () => {
            if (!confirm(`¿Eliminar la categoría "${cat.name}"?\nLos canales no se perderán, solo se desasignarán.`)) return;
            await YCSM.storage.deleteCategory(cat.id);
            await renderManageContent();
          });

          actions.appendChild(editBtn);
          actions.appendChild(delBtn);
          row.appendChild(grip);
          row.appendChild(name);
          row.appendChild(count);
          row.appendChild(actions);
          list.appendChild(row);
        });

        body.appendChild(list);
      }

      const addBtn = document.createElement('button');
      addBtn.className = 'ycsm-manage-add-btn';
      addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Nueva categoría`;
      addBtn.addEventListener('click', () => openEditLabel(null));
      body.appendChild(addBtn);
    }

    function openEditLabel(cat) {
      const existing = body.querySelector('.ycsm-manage-edit-form');
      if (existing) existing.remove();

      const form = document.createElement('div');
      form.className = 'ycsm-manage-edit-form';

      const formTitle = document.createElement('p');
      formTitle.className = 'ycsm-manage-edit-title';
      formTitle.textContent = cat ? 'Editar categoría' : 'Nueva categoría';

      const nameInput = document.createElement('input');
      nameInput.className = 'ycsm-manage-edit-input';
      nameInput.type = 'text';
      nameInput.placeholder = 'Nombre…';
      nameInput.maxLength = 30;
      nameInput.value = cat ? cat.name : '';

      const btnRow = document.createElement('div');
      btnRow.className = 'ycsm-manage-edit-btns';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'ycsm-manage-edit-save';
      saveBtn.textContent = 'Guardar';
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        if (cat) {
          await YCSM.storage.updateCategory(cat.id, { name });
        } else {
          await YCSM.storage.addCategory(name);
        }
        await renderManageContent();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ycsm-manage-edit-cancel';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.addEventListener('click', () => form.remove());

      const fieldRow = document.createElement('div');
      fieldRow.className = 'ycsm-manage-edit-row';
      fieldRow.appendChild(nameInput);

      btnRow.appendChild(saveBtn);
      btnRow.appendChild(cancelBtn);
      form.appendChild(formTitle);
      form.appendChild(fieldRow);
      form.appendChild(btnRow);
      body.appendChild(form);
      nameInput.focus();
    }

    await renderManageContent();
    if (autoCreate) openEditLabel(null);
  }

  /* ═══════════════════════════════════════════════════════════════
     DROPDOWN INLINE DE GESTIÓN DE CATEGORÍAS
  ═══════════════════════════════════════════════════════════════ */

  function openManageDropdown(wrapEl) {
    // Toggle: si ya está abierto, cerrar
    const existing = wrapEl.querySelector('.ycsm-manage-dropdown');
    if (existing) { existing.remove(); return; }

    const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const TRASH_SVG  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>`;
    const GRIP_SVG   = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;

    const dropdown = document.createElement('div');
    dropdown.className = 'ycsm-manage-dropdown';

    // Cabecera
    const header = document.createElement('div');
    header.className = 'ycsm-manage-dropdown-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'ycsm-manage-dropdown-title';
    titleEl.textContent = 'Gestionar categorías';
    header.appendChild(titleEl);
    dropdown.appendChild(header);

    // Cuerpo scrollable
    const dropBody = document.createElement('div');
    dropBody.className = 'ycsm-manage-dropdown-body';
    dropdown.appendChild(dropBody);

    let closeOnOutside;
    let onKeydown;

    async function closeAndRefresh() {
      dropdown.remove();
      document.removeEventListener('click', closeOnOutside);
      document.removeEventListener('keydown', onKeydown);
      await renderPanelContent();
    }

    closeOnOutside = (e) => {
      if (!dropdown.contains(e.target) && !wrapEl.contains(e.target)) {
        closeAndRefresh();
      }
    };

    onKeydown = (e) => {
      if (e.key === 'Escape') closeAndRefresh();
    };

    async function renderDropdownContent() {
      dropBody.innerHTML = '';

      const { categories, channelAssignments } = await YCSM.storage.getAll();
      const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

      const countByCat = {};
      Object.values(channelAssignments).forEach((cats) => {
        (cats || []).forEach((cid) => { countByCat[cid] = (countByCat[cid] || 0) + 1; });
      });

      if (sorted.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ycsm-manage-empty';
        empty.textContent = 'Todavía no hay categorías.';
        dropBody.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.className = 'ycsm-manage-list';

        let manageDragState = null;

        sorted.forEach((cat) => {
          const row = document.createElement('div');
          row.className = 'ycsm-manage-row';
          row.dataset.catId = cat.id;
          row.setAttribute('draggable', 'false');

          const grip = document.createElement('span');
          grip.className = 'ycsm-manage-grip';
          grip.innerHTML = GRIP_SVG;
          grip.addEventListener('mousedown', () => { row.setAttribute('draggable', 'true'); });

          row.addEventListener('dragstart', (e) => {
            manageDragState = cat.id;
            row.classList.add('ycsm-manage-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', cat.id);
          });
          row.addEventListener('dragend', () => {
            row.setAttribute('draggable', 'false');
            row.classList.remove('ycsm-manage-dragging');
            list.querySelectorAll('.ycsm-manage-drag-over').forEach((el) => el.classList.remove('ycsm-manage-drag-over'));
            manageDragState = null;
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (manageDragState && manageDragState !== cat.id) {
              row.classList.add('ycsm-manage-drag-over');
              e.dataTransfer.dropEffect = 'move';
            }
          });
          row.addEventListener('dragleave', (e) => {
            if (!row.contains(e.relatedTarget)) row.classList.remove('ycsm-manage-drag-over');
          });
          row.addEventListener('drop', async (e) => {
            e.preventDefault();
            row.classList.remove('ycsm-manage-drag-over');
            if (!manageDragState || manageDragState === cat.id) return;
            const rows = [...list.querySelectorAll(':scope > .ycsm-manage-row')];
            const ids = rows.map((r) => r.dataset.catId);
            const fromIdx = ids.indexOf(manageDragState);
            const toIdx = ids.indexOf(cat.id);
            if (fromIdx === -1 || toIdx === -1) return;
            ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, manageDragState);
            await YCSM.storage.reorderCategories(ids);
            await renderDropdownContent();
          });

          const name = document.createElement('span');
          name.className = 'ycsm-manage-name';
          name.textContent = cat.name;

          const count = document.createElement('span');
          count.className = 'ycsm-manage-count';
          const n = countByCat[cat.id] || 0;
          count.textContent = `${n} canal${n !== 1 ? 'es' : ''}`;

          const actions = document.createElement('div');
          actions.className = 'ycsm-manage-actions';

          const editBtn = document.createElement('button');
          editBtn.className = 'ycsm-manage-action-btn';
          editBtn.setAttribute('aria-label', `Editar ${cat.name}`);
          editBtn.innerHTML = PENCIL_SVG;
          editBtn.addEventListener('click', () => openDropdownEditLabel(cat));

          const delBtn = document.createElement('button');
          delBtn.className = 'ycsm-manage-action-btn ycsm-manage-del-btn';
          delBtn.setAttribute('aria-label', `Eliminar ${cat.name}`);
          delBtn.innerHTML = TRASH_SVG;
          delBtn.addEventListener('click', async () => {
            if (!confirm(`¿Eliminar la categoría "${cat.name}"?\nLos canales no se perderán, solo se desasignarán.`)) return;
            await YCSM.storage.deleteCategory(cat.id);
            if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
            await closeAndRefresh();
          });

          actions.appendChild(editBtn);
          actions.appendChild(delBtn);
          row.appendChild(grip);
          row.appendChild(name);
          row.appendChild(count);
          row.appendChild(actions);
          list.appendChild(row);
        });

        dropBody.appendChild(list);
      }

      const addBtn = document.createElement('button');
      addBtn.className = 'ycsm-manage-add-btn';
      addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Nueva categoría`;
      addBtn.addEventListener('click', () => openDropdownEditLabel(null));
      dropBody.appendChild(addBtn);
    }

    function openDropdownEditLabel(cat) {
      const existingForm = dropBody.querySelector('.ycsm-manage-edit-form');
      if (existingForm) existingForm.remove();

      const form = document.createElement('div');
      form.className = 'ycsm-manage-edit-form';

      const formTitle = document.createElement('p');
      formTitle.className = 'ycsm-manage-edit-title';
      formTitle.textContent = cat ? 'Editar categoría' : 'Nueva categoría';

      const nameInput = document.createElement('input');
      nameInput.className = 'ycsm-manage-edit-input';
      nameInput.type = 'text';
      nameInput.placeholder = 'Nombre…';
      nameInput.maxLength = 30;
      nameInput.value = cat ? cat.name : '';

      const btnRow = document.createElement('div');
      btnRow.className = 'ycsm-manage-edit-btns';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'ycsm-manage-edit-save';
      saveBtn.textContent = 'Guardar';
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        if (cat) {
          await YCSM.storage.updateCategory(cat.id, { name });
        } else {
          await YCSM.storage.addCategory(name);
        }
        if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
        await closeAndRefresh();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ycsm-manage-edit-cancel';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.addEventListener('click', () => form.remove());

      nameInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') saveBtn.click();
        if (e.key === 'Escape') form.remove();
      });

      const fieldRow = document.createElement('div');
      fieldRow.className = 'ycsm-manage-edit-row';
      fieldRow.appendChild(nameInput);

      btnRow.appendChild(saveBtn);
      btnRow.appendChild(cancelBtn);
      form.appendChild(formTitle);
      form.appendChild(fieldRow);
      form.appendChild(btnRow);
      dropBody.appendChild(form);
      nameInput.focus();
    }

    wrapEl.appendChild(dropdown);

    setTimeout(() => {
      document.addEventListener('click', closeOnOutside);
      document.addEventListener('keydown', onKeydown);
    }, 0);

    renderDropdownContent();
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDER DEL CONTENIDO
  ═══════════════════════════════════════════════════════════════ */

  async function renderPanelContent() {
    if (!panelEl) return;
    // Si estamos en la vista de gestión de categorías, no renderizar el contenido principal
    if (panelEl.querySelector('.ycsm-manage-view')) return;

    const { categories, channelAssignments } = await YCSM.storage.getAll();
    const sortedCats = Object.values(categories).sort((a, b) => a.order - b.order);

    /* ── Leyenda ── */
    const legend = panelEl.querySelector('.ycsm-panel-legend');
    if (!legend) return;
    legend.innerHTML = '';

    // Botón gestionar categorías (sliders icon)
    const manageWrap = document.createElement('div');
    manageWrap.className = 'ycsm-legend-manage-wrap';

    const manageBtn = document.createElement('button');
    manageBtn.className = 'ycsm-legend-manage-btn';
    manageBtn.setAttribute('aria-label', 'Gestionar categorías');
    manageBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`;
    manageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openManageDropdown(manageWrap);
    });
    manageWrap.appendChild(manageBtn);
    legend.appendChild(manageWrap);

    if (sortedCats.length === 0) {
      const empty = document.createElement('p');
      empty.style.cssText = 'font-size:13px;color:#606060;margin:0;align-self:center';
      empty.textContent = 'Sin categorías. Pulsa el icono para crear.';
      legend.appendChild(empty);
    } else {
      // Pill "Todos"
      const allPill = document.createElement('button');
      allPill.className = 'ycsm-legend-pill ycsm-legend-all' + (filterCat === null ? ' ycsm-legend-pill-active' : '');
      allPill.textContent = 'Todos';
      allPill.addEventListener('click', () => { filterCat = null; renderPanelContent(); });
      legend.appendChild(allPill);

      sortedCats.forEach((cat) => {
        const pill = document.createElement('button');
        pill.className = 'ycsm-legend-pill' + (filterCat === cat.id ? ' ycsm-legend-pill-active' : '');

        pill.style.padding = '0 16px';
        pill.textContent = cat.name;
        pill.addEventListener('click', () => {
          filterCat = filterCat === cat.id ? null : cat.id;
          renderPanelContent();
        });
        legend.appendChild(pill);
      });

      // Botón "Crear categoría" al final de los pills — con dropdown inline
      const createWrap = document.createElement('div');
      createWrap.className = 'ycsm-legend-create-wrap';

      const createPill = document.createElement('button');
      createPill.className = 'ycsm-legend-create-pill';
      createPill.textContent = '+';
      createPill.dataset.tooltip = 'Añadir categoría';

      const addDropdown = document.createElement('div');
      addDropdown.className = 'ycsm-add-cat-dropdown';
      addDropdown.hidden = true;

      const addInput = document.createElement('input');
      addInput.className = 'ycsm-add-cat-input';
      addInput.type = 'text';
      addInput.placeholder = 'Nombre de la categoría…';
      addInput.maxLength = 30;
      addInput.autocomplete = 'off';

      const addBtnRow = document.createElement('div');
      addBtnRow.className = 'ycsm-add-cat-btns';

      const addSaveBtn = document.createElement('button');
      addSaveBtn.className = 'ycsm-add-cat-save';
      addSaveBtn.textContent = 'Añadir';

      const addCancelBtn = document.createElement('button');
      addCancelBtn.className = 'ycsm-add-cat-cancel';
      addCancelBtn.textContent = 'Cancelar';

      const saveNewCategory = async () => {
        const name = addInput.value.trim();
        if (!name) { addInput.focus(); return; }
        await YCSM.storage.addCategory(name);
        addDropdown.hidden = true;
        addInput.value = '';
        if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
        await renderPanelContent();
      };

      addSaveBtn.addEventListener('click', saveNewCategory);
      addCancelBtn.addEventListener('click', () => {
        addDropdown.hidden = true;
        addInput.value = '';
      });
      addInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') await saveNewCategory();
        if (e.key === 'Escape') { addDropdown.hidden = true; addInput.value = ''; }
      });

      let _closeOnOutside = null;
      createPill.addEventListener('click', (e) => {
        e.stopPropagation();
        addDropdown.hidden = !addDropdown.hidden;
        if (!addDropdown.hidden) {
          addInput.focus();
          _closeOnOutside = (ev) => {
            if (!createWrap.contains(ev.target)) {
              addDropdown.hidden = true;
              addInput.value = '';
              document.removeEventListener('click', _closeOnOutside);
            }
          };
          // Diferir para que el propio click que abre no lo cierre
          setTimeout(() => document.addEventListener('click', _closeOnOutside), 0);
        } else if (_closeOnOutside) {
          document.removeEventListener('click', _closeOnOutside);
        }
      });

      addBtnRow.appendChild(addCancelBtn);
      addBtnRow.appendChild(addSaveBtn);
      addDropdown.appendChild(addInput);
      addDropdown.appendChild(addBtnRow);
      createWrap.appendChild(createPill);
      createWrap.appendChild(addDropdown);
      legend.appendChild(createWrap);
    }

    /* ── Ordenación ── */
    let sorted;
    if (sortBy === 'name') {
      sorted = [...allChannels].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    } else {
      // 'activity': ordenar por fecha del último vídeo (más reciente primero)
      // Si faltan fechas en caché, cargarlas todas antes de ordenar
      const needsFetch = allChannels.some((ch) => !_dateCache.has(ch.id));
      if (needsFetch) {
        const list = panelEl.querySelector('.ycsm-panel-channels');
        list.innerHTML = '<div class="ycsm-panel-empty" style="grid-column:1/-1">Cargando fechas para ordenar…</div>';
        await fetchAllDates(allChannels);
        if (!panelEl) return; // panel cerrado mientras cargaba
      }
      sorted = [...allChannels].sort((a, b) => {
        // Las fechas ISO 8601 se comparan lexicográficamente de forma correcta
        const da = _dateCache.get(a.id) || '';
        const db = _dateCache.get(b.id) || '';
        return db < da ? -1 : db > da ? 1 : 0;
      });
    }

    /* ── Filtrado ── */
    const visible = sorted.filter((ch) => {
      const matchText = !filterText || normalizeSearch(ch.name).includes(normalizeSearch(filterText));
      const matchCat  = !filterCat  || (channelAssignments[ch.id] || []).includes(filterCat);
      return matchText && matchCat;
    });

    const countEl = panelEl.querySelector('.ycsm-panel-count');
    const hasFilters = !!filterText || !!filterCat;
    const filterParts = [];
    if (filterText) filterParts.push(`"${filterText}"`);
    if (filterCat) {
      const catName = sortedCats.find(c => c.id === filterCat)?.name;
      if (catName) filterParts.push(catName);
    }
    countEl.textContent = hasFilters
      ? `${visible.length} de ${sorted.length} (${filterParts.join(' + ')})`
      : `${visible.length} canal${visible.length !== 1 ? 'es' : ''}`;

    /* ── Menú de categorías para asignación masiva ── */
    const catMenu = panelEl.querySelector('#ycsm-bulk-cat-menu');
    catMenu.innerHTML = '';
    sortedCats.forEach((cat) => {
      const item = document.createElement('button');
      item.className = 'ycsm-bulk-cat-item';
      item.textContent = cat.name;
      item.addEventListener('click', () => {
        catMenu.hidden = true;
        bulkAssignCategory(cat.id);
      });
      catMenu.appendChild(item);
    });

    /* ── Lista de canales ── */
    const list = panelEl.querySelector('.ycsm-panel-channels');
    list.innerHTML = '';

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ycsm-panel-empty';
      empty.textContent = filterText || filterCat
        ? 'No se encontraron canales con ese filtro.'
        : 'No se detectaron suscripciones. Despliega el menú de suscripciones en YouTube y vuelve a abrir este panel.';
      list.appendChild(empty);
      return;
    }

    visible.forEach((channel) => {
      const assigned = channelAssignments[channel.id] || [];
      const card = document.createElement('div');
      card.className = 'ycsm-panel-card' +
        (selectionMode ? ' ycsm-card-selectable' : '') +
        (selectedIds.has(channel.id) ? ' ycsm-card-selected' : '');
      card.setAttribute('role', 'listitem');
      card.setAttribute('title', `Abrir canal de ${channel.name}`);
      card.style.cursor = 'pointer';
      card.dataset.channelId = channel.id;

      const TIME_ICON_SVG = '<svg class="ycsm-date-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

      const avatarClass = 'ycsm-card-avatar';
      const avatarHtml = channel.avatar
        ? `<img class="${avatarClass}" src="${escapeHtml(channel.avatar)}" alt="" loading="lazy">`
        : `<div class="${avatarClass} ycsm-card-avatar-ph">${escapeHtml(channel.name.charAt(0).toUpperCase())}</div>`;

      const isNew = hasNewVideo(channel.id);
      card.innerHTML = `
        <div class="ycsm-card-thumb-wrap">
          <div class="ycsm-card-check" aria-hidden="true">✓</div>
          ${avatarHtml}
          ${isNew ? '<span class="ycsm-card-new-dot" aria-label="Nuevos vídeos sin ver"></span>' : ''}
        </div>
        <span class="ycsm-card-name" title="${escapeHtml(channel.name)}">${escapeHtml(channel.name)}</span>
        <span class="ycsm-card-date" data-cid="${escapeHtml(channel.id)}" title="Último vídeo publicado">${_dateCache.get(channel.id) ? TIME_ICON_SVG + escapeHtml(formatRelativeDate(_dateCache.get(channel.id))) : ''}</span>
        <div class="ycsm-card-cats" role="group" aria-label="Categorías de ${escapeHtml(channel.name)}"></div>
      `;

      // Click en modo selección → seleccionar tarjeta; fuera → abrir canal
      card.addEventListener('click', (e) => {
        if (e.target.closest('.ycsm-card-check, .ycsm-tag-wrap')) return;
        if (selectionMode) {
          e.preventDefault();
          toggleCardSelection(card, channel.id);
          return;
        }
        const url = channel.href
          ? `https://www.youtube.com${channel.href}`
          : `https://www.youtube.com/channel/${channel.id}`;
        markChannelSeen(channel.id);
        card.querySelector('.ycsm-card-new-dot')?.remove();
        window.open(url, '_blank', 'noopener');
      });

      const catsContainer = card.querySelector('.ycsm-card-cats');

      // Botón 🏷️ con dropdown de búsqueda y listado completo de categorías
      if (sortedCats.length > 0) {
        const tagWrap = document.createElement('div');
        tagWrap.className = 'ycsm-tag-wrap';

        const tagBtn = document.createElement('button');
        tagBtn.className = 'ycsm-tag-btn';
        tagBtn.title = 'Gestionar categorías';
        tagBtn.setAttribute('aria-label', `Gestionar categorías de ${channel.name}`);

        const TAG_SVG = `<svg class="ycsm-tag-btn-icon" width="13" height="13" viewBox="-1 -1 26 26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="overflow:visible"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="0.5" fill="currentColor" stroke="none"/></svg>`;

        const PLUS_SVG = `<svg class="ycsm-tag-btn-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

        function renderTagBtnContent() {
          const currentAssigned = sortedCats.filter((cat) =>
            (channelAssignments[channel.id] || []).includes(cat.id)
          );
          if (currentAssigned.length === 0) {
            tagBtn.classList.add('ycsm-tag-btn-secondary');
            tagBtn.innerHTML = PLUS_SVG + `<span class="ycsm-tag-btn-empty">Categoría</span>`;
          } else if (currentAssigned.length === 1) {
            tagBtn.classList.remove('ycsm-tag-btn-secondary');
            const cat = currentAssigned[0];
            tagBtn.innerHTML = TAG_SVG + `<span class="ycsm-tag-btn-label">${escapeHtml(cat.name)}</span>`;
          } else {
            tagBtn.classList.remove('ycsm-tag-btn-secondary');
            tagBtn.innerHTML = TAG_SVG + `<span class="ycsm-tag-btn-count">${currentAssigned.length} categorías</span>`;
          }
        }

        renderTagBtnContent();

        const dropdown = document.createElement('div');
        dropdown.className = 'ycsm-tag-dropdown';
        dropdown.hidden = true;

        // Estado local de cambios pendientes en este dropdown
        let pendingChanges = new Map(); // catId → true (add) | false (remove)

        // Orden alfabético para el dropdown
        const alphaCats = [...sortedCats].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        );

        // Contar canales por categoría
        const countByCatDropdown = {};
        Object.values(channelAssignments).forEach((cats) => {
          (cats || []).forEach((cid) => { countByCatDropdown[cid] = (countByCatDropdown[cid] || 0) + 1; });
        });

        function getEffectiveAssigned() {
          const base = new Set(channelAssignments[channel.id] || []);
          for (const [catId, add] of pendingChanges) {
            if (add) base.add(catId);
            else base.delete(catId);
          }
          return base;
        }

        function renderDropdownContent(filter = '') {
          dropdown.innerHTML = '';
          const effectiveAssigned = getEffectiveAssigned();

          // ─── Header: Título + búsqueda + crear ───
          const header = document.createElement('div');
          header.className = 'ycsm-dd-header';

          const title = document.createElement('h3');
          title.className = 'ycsm-dd-title';
          title.textContent = 'Añadir a categoría';
          header.appendChild(title);

          const searchInput = document.createElement('input');
          searchInput.className = 'ycsm-tag-search';
          searchInput.type = 'search';
          searchInput.placeholder = 'Buscar categoría…';
          searchInput.autocomplete = 'off';
          searchInput.value = filter;
          header.appendChild(searchInput);

          const createBtn = document.createElement('button');
          createBtn.className = 'ycsm-dd-create-btn';
          createBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Crear categoría`;
          createBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openManageLabels(true);
            closeDropdown();
          });
          header.appendChild(createBtn);

          dropdown.appendChild(header);

          // ─── Listado completo de categorías (filtrado por búsqueda) ───
          const filtered = filter
            ? alphaCats.filter((c) => normalizeSearch(c.name).includes(normalizeSearch(filter)))
            : alphaCats;

          if (filtered.length > 0) {
            const catList = document.createElement('div');
            catList.className = 'ycsm-dd-list';

            filtered.forEach((cat) => {
              const isOn = effectiveAssigned.has(cat.id);
              const n = countByCatDropdown[cat.id] || 0;
              const item = document.createElement('div');
              item.className = 'ycsm-dd-item' + (isOn ? ' ycsm-dd-item-assigned' : '');
              item.innerHTML = `
                <div class="ycsm-dd-item-info">
                  <span class="ycsm-dd-item-name">${escapeHtml(cat.name)}</span>
                  <span class="ycsm-dd-item-count">${n} canal${n !== 1 ? 'es' : ''}</span>
                </div>
                <button class="ycsm-dd-item-check ${isOn ? 'ycsm-dd-item-check-on' : 'ycsm-dd-item-check-off'}" aria-label="${isOn ? 'Quitar de' : 'Añadir a'} ${escapeHtml(cat.name)}">
                  ${isOn
                    ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" fill="currentColor"/><polyline points="9 11 12 14 22 4" stroke="#fff" stroke-width="2.5"/></svg>'
                    : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>'
                  }
                </button>
              `;
              item.querySelector('.ycsm-dd-item-check').addEventListener('click', (e) => {
                e.stopPropagation();
                const originallyOn = (channelAssignments[channel.id] || []).includes(cat.id);
                const newState = !isOn;
                // Si el nuevo estado coincide con el original, eliminar el cambio pendiente
                if (newState === originallyOn) {
                  pendingChanges.delete(cat.id);
                } else {
                  pendingChanges.set(cat.id, newState);
                }
                renderDropdownContent(searchInput.value);
              });
              catList.appendChild(item);
            });

            dropdown.appendChild(catList);
          } else if (filter) {
            const noResults = document.createElement('div');
            noResults.className = 'ycsm-tag-empty';
            noResults.textContent = 'Sin resultados';
            dropdown.appendChild(noResults);
          } else {
            const empty = document.createElement('div');
            empty.className = 'ycsm-tag-empty';
            empty.textContent = 'Sin categorías creadas';
            dropdown.appendChild(empty);
          }

          // ─── Divisor + sección "Pertenece a" (resumen) ───
          const assignedCats = alphaCats.filter((c) => effectiveAssigned.has(c.id));

          const divider = document.createElement('div');
          divider.className = 'ycsm-dd-divider';
          dropdown.appendChild(divider);

          const belongsTitle = document.createElement('h3');
          belongsTitle.className = 'ycsm-dd-title ycsm-dd-title-belongs';
          belongsTitle.textContent = 'Pertenece a';
          dropdown.appendChild(belongsTitle);

          if (assignedCats.length > 0) {
            const belongsSummary = document.createElement('div');
            belongsSummary.className = 'ycsm-dd-belongs-summary';
            belongsSummary.textContent = assignedCats.map((c) => c.name).join(', ');
            dropdown.appendChild(belongsSummary);
          } else {
            const emptyBelongs = document.createElement('div');
            emptyBelongs.className = 'ycsm-tag-empty';
            emptyBelongs.textContent = 'Sin categorías';
            dropdown.appendChild(emptyBelongs);
          }

          // ─── Footer ───
          const footer = document.createElement('div');
          footer.className = 'ycsm-dd-footer';

          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'ycsm-dd-footer-btn ycsm-dd-footer-cancel';
          cancelBtn.textContent = 'Cancelar';
          cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            pendingChanges.clear();
            closeDropdown();
          });
          footer.appendChild(cancelBtn);

          if (pendingChanges.size > 0) {
            const doneBtn = document.createElement('button');
            doneBtn.className = 'ycsm-dd-footer-btn ycsm-dd-footer-done';
            doneBtn.textContent = 'Hecho';
            doneBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              for (const [catId, add] of pendingChanges) {
                const isCurrentlyOn = (channelAssignments[channel.id] || []).includes(catId);
                if (add && !isCurrentlyOn) {
                  await YCSM.storage.toggleChannelCategory(channel.id, catId);
                } else if (!add && isCurrentlyOn) {
                  await YCSM.storage.toggleChannelCategory(channel.id, catId);
                }
              }
              pendingChanges.clear();
              if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
              closeDropdown();
              await renderPanelContent();
            });
            footer.appendChild(doneBtn);
          }

          dropdown.appendChild(footer);

          // Reconectar eventos del search
          const newSearchInput = dropdown.querySelector('.ycsm-tag-search');
          newSearchInput.addEventListener('input', (e) => {
            e.stopPropagation();
            renderDropdownContent(e.target.value);
            // Re-enfocar el input tras re-render
            const si = dropdown.querySelector('.ycsm-tag-search');
            if (si) { si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
          });
          newSearchInput.addEventListener('click', (e) => e.stopPropagation());
          newSearchInput.addEventListener('keydown', (e) => e.stopPropagation());
        }

        function closeDropdown() {
          dropdown.hidden = true;
          if (dropdown.parentNode !== tagWrap) tagWrap.appendChild(dropdown);
        }

        renderDropdownContent();

        tagBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectionMode) return;
          panelEl.querySelectorAll('.ycsm-tag-dropdown:not([hidden])').forEach((d) => {
            if (d !== dropdown) { d.hidden = true; }
          });
          document.querySelectorAll('body > .ycsm-tag-dropdown:not([hidden])').forEach((d) => {
            if (d !== dropdown) { d.hidden = true; }
          });
          const isOpen = !dropdown.hidden;
          dropdown.hidden = isOpen;
          if (!isOpen) {
            // Calcular posición fixed para escapar de cualquier overflow
            const btnRect = tagBtn.getBoundingClientRect();
            const DROPDOWN_W = 260;
            const DROPDOWN_MAX_H = 380;
            const GAP = 6;

            // Alinear a la derecha del botón, sin salirse del viewport
            let left = btnRect.right - DROPDOWN_W;
            if (left < 8) left = 8;

            // Abrir hacia arriba o hacia abajo según espacio disponible
            const spaceBelow = window.innerHeight - btnRect.bottom - GAP;
            const spaceAbove = btnRect.top - GAP;
            let top;
            if (spaceBelow >= DROPDOWN_MAX_H || spaceBelow >= spaceAbove) {
              top = btnRect.bottom + GAP;
            } else {
              top = btnRect.top - GAP - Math.min(DROPDOWN_MAX_H, spaceAbove);
            }

            dropdown.style.position = 'fixed';
            dropdown.style.top = top + 'px';
            dropdown.style.left = left + 'px';
            dropdown.style.bottom = '';
            dropdown.style.right = '';
            dropdown.style.width = DROPDOWN_W + 'px';

            // Mover al body para escapar de todos los stacking contexts
            document.body.appendChild(dropdown);

            pendingChanges.clear();
            renderDropdownContent();
            const si = dropdown.querySelector('.ycsm-tag-search');
            if (si) setTimeout(() => si.focus(), 0);
          } else {
            // Devolver al wrap cuando se cierra
            pendingChanges.clear();
            closeDropdown();
          }
        });

        tagWrap.appendChild(tagBtn);
        tagWrap.appendChild(dropdown);
        catsContainer.appendChild(tagWrap);
      }

      list.appendChild(card);
    });

    // Observar spans de fecha vacíos para carga perezosa (solo los que no tienen fecha ya)
    if (_dateObserver) _dateObserver.disconnect();
    _dateObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const span = entry.target;
          _dateObserver.unobserve(span);
          if (span.textContent) return; // ya tiene fecha del caché
          fetchLastVideoDate(span.dataset.cid).then((iso) => {
            if (iso) {
              span.innerHTML = TIME_ICON_SVG + escapeHtml(formatRelativeDate(iso));
            }
            // Actualizar punto azul ahora que tenemos la fecha
            if (hasNewVideo(span.dataset.cid)) {
              const card = span.closest('.ycsm-panel-card');
              if (card && !card.querySelector('.ycsm-card-new-dot')) {
                const dot = document.createElement('span');
                dot.className = 'ycsm-card-new-dot';
                dot.setAttribute('aria-label', 'Nuevos vídeos sin ver');
                card.querySelector('.ycsm-card-thumb-wrap').appendChild(dot);
              }
            }
          });
        });
      },
      { root: panelEl.querySelector('.ycsm-panel-body'), rootMargin: '160px' }
    );
    list.querySelectorAll('.ycsm-card-date:empty').forEach((span) => _dateObserver.observe(span));
  }

  /* ═══════════════════════════════════════════════════════════════
     MIGRACIÓN DE IDs LEGACY
  ═══════════════════════════════════════════════════════════════ */

  /**
   * El scraper DOM antiguo usaba el href como ID (p.ej. "/@handle", "/c/name").
   * El fetch nuevo usa el channelId real (UCxxxxx).
   * Esta función reescribe las asignaciones guardadas para que usen el ID
   * canónico, de modo que los badges y pills aparezcan correctamente.
   */
  async function migrateAssignmentIds(channels) {
    const assignments = await YCSM.storage.getChannelAssignments();

    // Construir mapa: href-key → channelId canónico
    const hrefToId = {};
    for (const ch of channels) {
      if (!ch.href) continue;
      const hrefKey = ch.href.split('?')[0]; // e.g. "/@handle"
      if (hrefKey !== ch.id) {
        hrefToId[hrefKey] = ch.id;
      }
    }

    let dirty = false;
    for (const [oldKey, canonicalId] of Object.entries(hrefToId)) {
      if (assignments[oldKey] && !assignments[canonicalId]) {
        // Mover asignación al ID canónico
        assignments[canonicalId] = assignments[oldKey];
        delete assignments[oldKey];
        dirty = true;
      } else if (assignments[oldKey] && assignments[canonicalId]) {
        // Fusionar (sin duplicados) y eliminar el viejo
        const merged = [...new Set([...assignments[canonicalId], ...assignments[oldKey]])];
        assignments[canonicalId] = merged;
        delete assignments[oldKey];
        dirty = true;
      }
    }

    if (dirty) {
      await YCSM.storage.saveChannelAssignments(assignments);
      console.log('[YCSM] Asignaciones migradas al ID canónico.');
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     CICLO DE VIDA
  ═══════════════════════════════════════════════════════════════ */

  async function open() {
    // Si ya está abierto, solo traerlo al frente
    if (document.getElementById('ycsm-panel')) return;

    filterText = '';
    filterCat = null;
    _dateCache.clear(); // Limpiar caché de fechas para obtener datos frescos
    panelEl = buildPanel();
    document.body.appendChild(panelEl);

    /* ── Eventos ── */
    panelEl.querySelector('.ycsm-panel-backdrop').addEventListener('click', close);
    panelEl.querySelector('.ycsm-panel-x').addEventListener('click', close);
    panelEl.querySelector('.ycsm-panel-close-btn').addEventListener('click', close);

    const ytSearchInput = panelEl.querySelector('.ycsm-yt-search-input');
    const ytClearBtn = panelEl.querySelector('.ycsm-yt-search-clear');
    const ytSearchBox = panelEl.querySelector('.ycsm-yt-search-box');
    ytSearchInput.addEventListener('input', debounce((e) => {
      filterText = e.target.value;
      ytClearBtn.hidden = !e.target.value;
      renderPanelContent();
    }, 150));
    ytSearchInput.addEventListener('focus', () => { ytSearchBox.classList.add('ycsm-yt-search-focused'); });
    ytSearchInput.addEventListener('blur', () => { ytSearchBox.classList.remove('ycsm-yt-search-focused'); });
    ytClearBtn.addEventListener('click', () => {
      ytSearchInput.value = '';
      ytClearBtn.hidden = true;
      filterText = '';
      ytSearchInput.focus();
      renderPanelContent();
    });
    panelEl.querySelector('.ycsm-yt-search-btn').addEventListener('click', () => {
      ytSearchInput.focus();
    });

    const sortSelect = panelEl.querySelector('.ycsm-panel-sort');
    sortSelect.value = sortBy;
    sortSelect.addEventListener('change', (e) => {
      sortBy = e.target.value;
      renderPanelContent();
    });

    // Botón de modo selección
    panelEl.querySelector('#ycsm-btn-select').addEventListener('click', () => {
      if (selectionMode) exitSelectionMode();
      else enterSelectionMode();
    });

    // Asignación masiva: toggle menú de categorías
    panelEl.querySelector('#ycsm-bulk-cat-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = panelEl.querySelector('#ycsm-bulk-cat-menu');
      menu.hidden = !menu.hidden;
    });
    // Cerrar menú si se hace click fuera
    document.addEventListener('click', () => {
      const menu = panelEl?.querySelector('#ycsm-bulk-cat-menu');
      if (menu) menu.hidden = true;
      // Cerrar dropdowns de categoría (pueden estar en body como fixed)
      document.querySelectorAll('.ycsm-tag-dropdown:not([hidden])').forEach((d) => {
        d.hidden = true;
      });
    }, { capture: true });

    document.addEventListener('keydown', handleEscape);

    // Trampa de foco accesible: primer elemento enfocable
    panelEl.querySelector('button, input')?.focus();

    // Mostrar estado de carga mientras obtenemos canales
    const list = panelEl.querySelector('.ycsm-panel-channels');
    list.innerHTML = '<div class="ycsm-panel-empty" style="grid-column:1/-1">Cargando canales…</div>';

    // Estrategia 1: fetch de /feed/channels → obtiene TODOS los canales sin depender del DOM
    allChannels = await fetchAllSubscriptions();

    // Estrategia 2: DOM scraping del sidebar (fallback)
    if (allChannels.length === 0) {
      await expandYouTubeSubscriptions();
      allChannels = scrapeChannelsFromDOM();
    }

    // Estrategia 3: caché local de sesiones anteriores
    if (allChannels.length === 0) {
      const { channels } = await YCSM.storage.getCachedChannels();
      allChannels = channels || [];
    }

    if (allChannels.length > 0) {
      // Migrar asignaciones antiguas (IDs basados en handle/href) al channelId canónico (UCxxxxx)
      await migrateAssignmentIds(allChannels);
      YCSM.storage.cacheChannels(allChannels);
    }

    _lastSeen = await loadLastSeen();
    await renderPanelContent();

    // Fijar la altura del box tras la primera carga para evitar saltos al cambiar de vista
    const box = panelEl?.querySelector('.ycsm-panel-box');
    if (box) {
      const h = box.getBoundingClientRect().height;
      box.style.height = h + 'px';
    }
  }

  function close() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    filterText = '';
    filterCat = null;
    sortBy = 'activity';
    selectionMode = false;
    selectedIds.clear();
    if (_dateObserver) { _dateObserver.disconnect(); _dateObserver = null; }
    document.removeEventListener('keydown', handleEscape);
  }

  function handleEscape(e) {
    if (e.key === 'Escape') close();
  }

  /* ── Export ── */
  window.YCSM.panel = {
    open,
    close,
    scrapeChannelsFromDOM,
    renderPanelContent,
  };
})();
