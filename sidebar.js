/**
 * sidebar.js — Componente de categorías inyectado en el sidebar de YouTube.
 * Prefijo CSS: ycsm-  (YouTube Category Subscription Manager)
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let sidebarRoot = null;
  let dragState = null;

  /* ═══════════════════════════════════════════════════════════════
     UTILIDADES
  ═══════════════════════════════════════════════════════════════ */

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value ?? '')));
    return div.innerHTML;
  }

  function sanitizeColor(color) {
    // Solo permitir colores hexadecimales válidos
    return /^#[0-9A-Fa-f]{3,8}$/.test(color) ? color : '#4285F4';
  }

  /* ═══════════════════════════════════════════════════════════════
     SCRAPING DEL DOM DE YOUTUBE
  ═══════════════════════════════════════════════════════════════ */

  function getChannelsFromDOM() {
    const channels = [];
    const seen = new Set();

    const entries = document.querySelectorAll('ytd-guide-entry-renderer');
    entries.forEach((entry) => {
      const link = entry.querySelector('a');
      if (!link) return;

      const href = link.getAttribute('href') || '';
      if (
        !href.startsWith('/channel/') &&
        !href.startsWith('/@') &&
        !href.startsWith('/c/')
      )
        return;

      // ID canónico: UCxxxxx para /channel/, o el handle para /@...
      const channelId = href.startsWith('/channel/')
        ? href.replace('/channel/', '').split('?')[0]
        : href.split('?')[0];

      if (!channelId || seen.has(channelId)) return;
      seen.add(channelId);

      const nameEl = entry.querySelector(
        'yt-formatted-string, #endpoint yt-formatted-string, #label'
      );
      const name =
        nameEl?.textContent?.trim() ||
        link.getAttribute('title') ||
        channelId;

      const imgEl = entry.querySelector('img#img, yt-img-shadow img, img');
      const avatar = imgEl?.src || '';

      channels.push({ id: channelId, name, avatar, href });
    });

    return channels;
  }

  /* ═══════════════════════════════════════════════════════════════
     ELEMENTOS DEL SIDEBAR
  ═══════════════════════════════════════════════════════════════ */

  function createCategoryElement(category, channels, assignments, allCategories) {
    const catEl = document.createElement('div');
    catEl.className = 'ycsm-category';
    catEl.dataset.categoryId = category.id;

    const color = sanitizeColor(category.color || '#4285F4');

    // Canales asignados a esta categoría
    const assigned = channels.filter((ch) =>
      (assignments[ch.id] || []).includes(category.id)
    );

    /* ── Header ── */
    const header = document.createElement('div');
    header.className = 'ycsm-category-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', category.collapsed ? 'false' : 'true');
    header.innerHTML = `
      <span class="ycsm-drag-handle" title="Reordenar" aria-hidden="true">⠿</span>
      <span class="ycsm-cat-dot" style="background-color:${color}" aria-hidden="true"></span>
      <span class="ycsm-cat-name">${escapeHtml((category.emoji || '') + ' ' + category.name)}</span>
      <span class="ycsm-cat-count" aria-label="${assigned.length} canales">${assigned.length}</span>
      <div class="ycsm-cat-actions" role="group" aria-label="Acciones de categoría">
        <button class="ycsm-btn-icon ycsm-btn-rename" title="Renombrar" aria-label="Renombrar categoría">✏️</button>
        <button class="ycsm-btn-icon ycsm-btn-delete" title="Eliminar" aria-label="Eliminar categoría">🗑️</button>
      </div>
      <span class="ycsm-cat-chevron" aria-hidden="true">${category.collapsed ? '▶' : '▼'}</span>
    `;

    /* ── Content ── */
    const content = document.createElement('div');
    content.className =
      'ycsm-cat-content' + (category.collapsed ? ' ycsm-collapsed' : '');

    if (assigned.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ycsm-empty-cat';
      empty.innerHTML = `Sin canales. <button class="ycsm-link-btn ycsm-open-panel">Organizar</button>`;
      empty
        .querySelector('.ycsm-open-panel')
        .addEventListener('click', () => YCSM.panel.open());
      content.appendChild(empty);
    } else {
      assigned.forEach((ch) => {
        const chEl = createChannelItem(ch, assignments[ch.id] || [], allCategories);
        content.appendChild(chEl);
      });
    }

    catEl.appendChild(header);
    catEl.appendChild(content);

    /* ── Eventos de header ── */
    header.addEventListener('click', (e) => {
      if (
        e.target.closest('.ycsm-cat-actions') ||
        e.target.closest('.ycsm-drag-handle')
      )
        return;
      toggleCollapse(category.id, catEl, content, header);
    });

    header
      .querySelector('.ycsm-cat-name')
      .addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startInlineRename(category.id, header.querySelector('.ycsm-cat-name'), category.name);
      });

    header
      .querySelector('.ycsm-btn-rename')
      .addEventListener('click', (e) => {
        e.stopPropagation();
        startInlineRename(category.id, header.querySelector('.ycsm-cat-name'), category.name);
      });

    header
      .querySelector('.ycsm-btn-delete')
      .addEventListener('click', (e) => {
        e.stopPropagation();
        promptDelete(category.id, category.name);
      });

    /* ── Drag & Drop ── */
    setupDragHandlers(catEl, category.id, header.querySelector('.ycsm-drag-handle'));

    return catEl;
  }

  function createChannelItem(channel, categoryIds, allCategories) {
    const el = document.createElement('a');
    el.className = 'ycsm-channel-item';
    el.href = channel.href;

    // Tooltip con categorías múltiples
    const catNames = categoryIds
      .map((id) => allCategories[id]?.name)
      .filter(Boolean);
    if (catNames.length > 1) {
      el.title = `${channel.name}\nCategorías: ${catNames.join(', ')}`;
    } else {
      el.title = channel.name;
    }

    const avatarHtml = channel.avatar
      ? `<img class="ycsm-avatar" src="${escapeHtml(channel.avatar)}" alt="" loading="lazy">`
      : `<div class="ycsm-avatar ycsm-avatar-placeholder">${escapeHtml(channel.name.charAt(0).toUpperCase())}</div>`;

    el.innerHTML = `
      ${avatarHtml}
      <span class="ycsm-channel-name">${escapeHtml(channel.name)}</span>
      ${categoryIds.length > 1 ? '<span class="ycsm-multicat" aria-label="En varias categorías">◈</span>' : ''}
    `;

    // Botón contextual al hacer hover
    el.addEventListener('mouseenter', () => {
      if (el.querySelector('.ycsm-ctx-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'ycsm-btn-icon ycsm-ctx-btn';
      btn.title = 'Gestionar categorías';
      btn.setAttribute('aria-label', 'Gestionar categorías del canal');
      btn.textContent = '🏷️';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(channel, btn, categoryIds);
      });
      el.appendChild(btn);
    });

    el.addEventListener('mouseleave', (e) => {
      if (!e.relatedTarget?.closest('.ycsm-channel-item')) {
        el.querySelector('.ycsm-ctx-btn')?.remove();
      }
    });

    return el;
  }

  /* ═══════════════════════════════════════════════════════════════
     ACCIONES INTERACTIVAS
  ═══════════════════════════════════════════════════════════════ */

  async function toggleCollapse(categoryId, catEl, contentEl, headerEl) {
    const categories = await YCSM.storage.getCategories();
    const cat = categories[categoryId];
    if (!cat) return;

    const collapsed = !cat.collapsed;
    await YCSM.storage.updateCategory(categoryId, { collapsed });

    contentEl.classList.toggle('ycsm-collapsed', collapsed);
    headerEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const chevron = catEl.querySelector('.ycsm-cat-chevron');
    if (chevron) chevron.textContent = collapsed ? '▶' : '▼';
  }

  function startInlineRename(categoryId, nameEl, currentName) {
    const input = document.createElement('input');
    input.className = 'ycsm-rename-input';
    input.value = currentName;
    input.maxLength = 50;
    input.setAttribute('aria-label', 'Nuevo nombre de categoría');

    const originalText = nameEl.textContent;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    let saved = false;

    async function commit() {
      if (saved) return;
      saved = true;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        await YCSM.storage.updateCategory(categoryId, { name: newName });
        nameEl.textContent = newName;
      } else {
        nameEl.textContent = originalText;
      }
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        saved = true;
        nameEl.textContent = originalText;
      }
    });
  }

  async function promptDelete(categoryId, categoryName) {
    if (
      confirm(
        `¿Eliminar la categoría "${categoryName}"?\nLos canales no se perderán, solo se desasignarán.`
      )
    ) {
      await YCSM.storage.deleteCategory(categoryId);
      await renderSidebar();
    }
  }

  async function showContextMenu(channel, anchor, currentCategoryIds) {
    // Cierra cualquier menú abierto
    document.querySelectorAll('.ycsm-ctx-menu').forEach((m) => m.remove());

    const categories = await YCSM.storage.getCategories();
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    if (sorted.length === 0) return;

    const menu = document.createElement('div');
    menu.className = 'ycsm-ctx-menu';
    menu.setAttribute('role', 'menu');

    sorted.forEach((cat) => {
      const color = sanitizeColor(cat.color);
      const isAssigned = currentCategoryIds.includes(cat.id);
      const item = document.createElement('label');
      item.className = 'ycsm-ctx-menu-item';
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', isAssigned ? 'true' : 'false');
      item.innerHTML = `
        <input type="checkbox" ${isAssigned ? 'checked' : ''} aria-hidden="true">
        <span class="ycsm-cat-dot" style="background:${color}"></span>
        <span>${escapeHtml(cat.name)}</span>
      `;

      const checkbox = item.querySelector('input');
      checkbox.addEventListener('change', async () => {
        await YCSM.storage.toggleChannelCategory(channel.id, cat.id);
        await renderSidebar();
        // Actualiza el aria-checked
        item.setAttribute('aria-checked', checkbox.checked ? 'true' : 'false');
      });

      menu.appendChild(item);
    });

    // Posicionamiento
    const rect = anchor.getBoundingClientRect();
    menu.style.cssText = `
      position:fixed;
      top:${rect.bottom + 4}px;
      left:${rect.left}px;
      z-index:99999;
    `;

    document.body.appendChild(menu);

    // Cierra al hacer clic fuera
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
  }

  /* ═══════════════════════════════════════════════════════════════
     DRAG & DROP (reordenar categorías)
  ═══════════════════════════════════════════════════════════════ */

  function setupDragHandlers(catEl, categoryId, handle) {
    // Solo empieza el drag desde el handle
    handle.addEventListener('mousedown', () => {
      catEl.setAttribute('draggable', 'true');
    });

    catEl.addEventListener('dragstart', (e) => {
      dragState = { categoryId };
      catEl.classList.add('ycsm-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', categoryId);
    });

    catEl.addEventListener('dragend', () => {
      catEl.setAttribute('draggable', 'false');
      catEl.classList.remove('ycsm-dragging');
      document
        .querySelectorAll('.ycsm-drag-over')
        .forEach((el) => el.classList.remove('ycsm-drag-over'));
      dragState = null;
    });

    catEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragState && dragState.categoryId !== categoryId) {
        catEl.classList.add('ycsm-drag-over');
        e.dataTransfer.dropEffect = 'move';
      }
    });

    catEl.addEventListener('dragleave', (e) => {
      if (!catEl.contains(e.relatedTarget)) {
        catEl.classList.remove('ycsm-drag-over');
      }
    });

    catEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      catEl.classList.remove('ycsm-drag-over');
      if (!dragState || dragState.categoryId === categoryId) return;

      const list = sidebarRoot?.querySelector('.ycsm-categories-list');
      if (!list) return;

      const categoryEls = [...list.querySelectorAll(':scope > .ycsm-category')];
      const ids = categoryEls.map((el) => el.dataset.categoryId);

      const fromIdx = ids.indexOf(dragState.categoryId);
      const toIdx = ids.indexOf(categoryId);
      if (fromIdx === -1 || toIdx === -1) return;

      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, dragState.categoryId);

      await YCSM.storage.reorderCategories(ids);
      await renderSidebar();
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDER PRINCIPAL
  ═══════════════════════════════════════════════════════════════ */

  // Debounce: evita re-renders en ráfaga cuando el panel actualiza varias
  // asignaciones seguidas. 120ms es imperceptible para el usuario.
  let _renderTimer = null;
  function scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(renderSidebar, 120);
  }

  async function renderSidebar() {
    if (!sidebarRoot) return;

    const [{ categories, channelAssignments }, { channels: cachedChannels }] = await Promise.all([
      YCSM.storage.getAll(),
      YCSM.storage.getCachedChannels(),
    ]);

    // Construir mapa de canales: primero los cacheados (panel), luego enriquecer
    // con los del DOM si YouTube ya los tiene renderizados (avatar fresco, etc.)
    const channelMap = {};
    for (const ch of (cachedChannels || [])) {
      channelMap[ch.id] = ch;
    }
    for (const ch of getChannelsFromDOM()) {
      // El DOM tiene el avatar más reciente; actualizar o añadir
      channelMap[ch.id] = { ...channelMap[ch.id], ...ch };
    }

    // Si no hay canales en caché ni en DOM, generar entradas mínimas a partir
    // de las asignaciones guardadas para que las categorías no aparezcan vacías.
    if (Object.keys(channelMap).length === 0) {
      const allAssigned = new Set(Object.keys(channelAssignments));
      allAssigned.forEach((id) => {
        channelMap[id] = { id, name: id, avatar: '', href: `https://www.youtube.com/channel/${id}` };
      });
    }

    const channels = Object.values(channelMap);
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    const list = sidebarRoot.querySelector('.ycsm-categories-list');
    if (!list) return;
    list.innerHTML = '';

    if (sorted.length === 0) {
      list.innerHTML =
        '<div class="ycsm-empty-cat" style="padding:10px 14px">Sin categorías. Crea la primera.</div>';
      return;
    }

    sorted.forEach((cat) => {
      const el = createCategoryElement(cat, channels, channelAssignments, categories);
      list.appendChild(el);
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     CONSTRUCCIÓN DEL SIDEBAR
  ═══════════════════════════════════════════════════════════════ */

  function buildSidebarRoot() {
    const root = document.createElement('div');
    root.id = 'ycsm-sidebar';
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', 'Mis categorías de YouTube');
    root.innerHTML = `
      <div class="ycsm-sidebar-header">
        <span class="ycsm-sidebar-title">Mis Categorías</span>
        <div class="ycsm-sidebar-header-actions">
          <button class="ycsm-btn-icon" id="ycsm-btn-organize" title="Organizar suscripciones" aria-label="Organizar suscripciones">⚙️</button>
          <button class="ycsm-btn-icon" id="ycsm-btn-add" title="Nueva categoría" aria-label="Nueva categoría">＋</button>
        </div>
      </div>
      <div class="ycsm-categories-list" role="list"></div>
      <div class="ycsm-add-form" id="ycsm-add-form" hidden>
        <input
          class="ycsm-input"
          id="ycsm-new-name"
          type="text"
          placeholder="Nombre de la categoría…"
          maxlength="50"
          aria-label="Nombre de la nueva categoría"
        >
        <div class="ycsm-add-form-row">
          <input type="color" id="ycsm-new-color" value="#4285F4" title="Color" aria-label="Color de la categoría">
          <button class="ycsm-btn-primary" id="ycsm-btn-save">Crear</button>
          <button class="ycsm-btn-icon" id="ycsm-btn-cancel">✕</button>
        </div>
      </div>
    `;
    return root;
  }

  function attachSidebarEvents(root) {
    const addForm = root.querySelector('#ycsm-add-form');
    const nameInput = root.querySelector('#ycsm-new-name');
    const colorInput = root.querySelector('#ycsm-new-color');

    root.querySelector('#ycsm-btn-add').addEventListener('click', () => {
      addForm.hidden = !addForm.hidden;
      if (!addForm.hidden) nameInput.focus();
    });

    root.querySelector('#ycsm-btn-cancel').addEventListener('click', () => {
      addForm.hidden = true;
      nameInput.value = '';
    });

    const createCategory = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      await YCSM.storage.addCategory(name, colorInput.value);
      nameInput.value = '';
      addForm.hidden = true;
      await renderSidebar();
    };

    root.querySelector('#ycsm-btn-save').addEventListener('click', createCategory);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createCategory();
      if (e.key === 'Escape') {
        addForm.hidden = true;
        nameInput.value = '';
      }
    });

    root.querySelector('#ycsm-btn-organize').addEventListener('click', () => {
      YCSM.panel.open();
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     INYECCIÓN EN YOUTUBE
  ═══════════════════════════════════════════════════════════════ */

  async function injectIntoYouTube() {
    // Evitar doble inyección
    if (document.getElementById('ycsm-sidebar')) return true;

    const guideContent = document.querySelector(
      '#guide-content, ytd-guide-renderer #sections'
    );
    if (!guideContent) return false;

    const root = buildSidebarRoot();
    sidebarRoot = root;

    // Insertar antes de la sección de suscripciones si existe; si no, al inicio
    const sections = guideContent.querySelectorAll('ytd-guide-section-renderer');
    let insertBefore = null;

    for (const section of sections) {
      const title =
        section.querySelector('#guide-section-title')?.textContent?.toLowerCase() ||
        section.querySelector('[title]')?.getAttribute('title')?.toLowerCase() ||
        '';
      if (title.includes('subscri') || title.includes('suscri')) {
        insertBefore = section;
        break;
      }
    }

    if (insertBefore) {
      guideContent.insertBefore(root, insertBefore);
    } else {
      guideContent.prepend(root);
    }

    attachSidebarEvents(root);
    await renderSidebar();
    return true;
  }

  /* ── Export ── */
  window.YCSM.sidebar = {
    injectIntoYouTube,
    renderSidebar,
    scheduleRender,
    getChannelsFromDOM,
  };
})();
