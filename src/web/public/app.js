// Team Memory Dashboard v2 - JavaScript

const API_BASE = '/api';

// Auth: Bearer token from localStorage (set via ?token= query param or manual input)
const AUTH_TOKEN = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('auth-token') || '';
if (AUTH_TOKEN) {
  localStorage.setItem('auth-token', AUTH_TOKEN);
  // Remove token from URL to prevent leaking via browser history / Referer
  const url = new URL(window.location);
  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url);
  }
}

function authHeaders() {
  return AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {};
}

async function authFetch(url, options = {}) {
  const headers = { ...authHeaders(), ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    // In readonly mode, don't redirect — show toast and return
    if (isReadOnly) {
      showToast('Требуется авторизация для этого действия', 'error');
      return res;
    }
    localStorage.removeItem('auth-token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  return res;
}

// State
let currentCategory = 'all';
let currentSearch = '';
let currentStatus = '';
let currentDomain = '';
let currentProjectId = localStorage.getItem('selected-project') || '';
let entries = [];
let projects = [];
let ws = null;
let isGraphView = false;
let isAgentsView = false;
let isMasterUser = false;
let isReadOnly = false;

// Sessions state
let sessionsData = [];
let currentSessionOffset = 0;
const SESSIONS_LIMIT = 20;
let currentSessionId = null;
let sessionMessages = [];
let sessionMessageFrom = 0;
const SESSION_MESSAGES_PAGE = 50;
let sessionSearchDebounce = null;

// Notes state
let notesData = [];
let currentNoteOffset = 0;
const NOTES_LIMIT = 20;

// Theme configuration — Nothing is the canonical default. Others remain selectable but rendered under a "LEGACY" divider.
const THEMES = [
  {
    id: 'nothing',
    name: 'Nothing',
    desc: 'OLED-чёрная типографическая, сигнальный оранжевый',
    colors: { bg: '#000000', sidebar: '#000000', sidebarBorder: '1px solid #222', accent: '#D77554', line1: '#222', line2: '#D77554', line3: '#1A1A1A', line4: '#1A1A1A' }
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    desc: 'Жёсткий геометричный стиль, толстые рамки',
    legacy: true,
    colors: { bg: '#F8F6F1', sidebar: '#fff', sidebarBorder: '3px solid #111', accent: '#D42B2B', line1: '#D8D4CC', line2: '#D42B2B', line3: '#EDEAE4', line4: '#EDEAE4' }
  },
  {
    id: 'gazette',
    name: 'Gazette',
    desc: 'Газетный editorial-стиль, тёплые тона',
    legacy: true,
    colors: { bg: '#F6F1E9', sidebar: '#FAF7F1', sidebarBorder: '2px solid #2A241C', accent: '#8B2020', line1: '#D4C9B8', line2: '#8B2020', line3: '#E2D9CA', line4: '#E2D9CA' }
  },
  {
    id: 'sport',
    name: 'Sport',
    desc: 'Тёмный спортивный с неоновым акцентом',
    legacy: true,
    colors: { bg: '#0A0A0A', sidebar: '#161616', sidebarBorder: '1px solid #3A3A3A', accent: '#CCFF00', line1: '#3A3A3A', line2: '#CCFF00', line3: '#1C1C1C', line4: '#1C1C1C' }
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    desc: 'Aurora-градиенты, тёплые и холодные тона',
    legacy: true,
    colors: { bg: '#07070B', sidebar: '#0D0D14', sidebarBorder: '1px solid rgba(255,255,255,0.05)', accent: '#FF8C42', line1: '#2A2A34', line2: 'linear-gradient(90deg, #FF8C42, #FF3B6C)', line3: '#15151E', line4: '#15151E' }
  }
];

// Domain display info
const domainInfo = {
  backend:        { name: 'Backend',        icon: 'server' },
  frontend:       { name: 'Frontend',       icon: 'monitor' },
  infrastructure: { name: 'Infrastructure', icon: 'network' },
  devops:         { name: 'DevOps',         icon: 'container' },
  database:       { name: 'Database',       icon: 'database' },
  testing:        { name: 'Testing',        icon: 'test-tubes' }
};

// DOM Elements
const entriesContainer = document.getElementById('entries-container');
const searchInput = document.getElementById('search-input');
const statusSelect = document.getElementById('status-select');
const statusSelectTrigger = statusSelect.querySelector('.custom-select-trigger');
const statusSelectValue = statusSelect.querySelector('.custom-select-value');
const statusOptionsContainer = document.getElementById('status-options');
const pageTitle = document.getElementById('page-title');
const modal = document.getElementById('entry-modal');
const entryForm = document.getElementById('entry-form');
const toastContainer = document.getElementById('toast-container');
const projectSelect = document.getElementById('project-select');
const projectSelectTrigger = projectSelect.querySelector('.custom-select-trigger');
const projectSelectValue = projectSelect.querySelector('.custom-select-value');
const projectOptionsContainer = document.getElementById('project-options');
const domainFiltersContainer = document.getElementById('domain-filters');
const projectsModal = document.getElementById('projects-modal');
let projectDomains = []; // ProjectDomain[] from API

// Category config
// v5: 'knowledge' is the canonical category for WHY-facts. Legacy categories
// are kept here so that entries already in the DB still render with proper
// title/icon, even though the nav buttons for them are display:none.
// When V5+ Azure DevOps integration revives tasks/issues/progress as shadow
// views over Azure work items, unhide the nav buttons and these configs are
// already correct.
const categoryConfig = {
  all: { title: 'Все записи', icon: 'layout-grid' },
  pinned: { title: 'Закреплённые', icon: 'pin' },
  knowledge: { title: 'Знания', icon: 'book-open' },
  profile: { title: 'Профиль', icon: 'map' },
  architecture: { title: 'Архитектура', icon: 'building-2' },
  tasks: { title: 'Задачи', icon: 'clipboard-list' },
  decisions: { title: 'Решения', icon: 'check-circle-2' },
  issues: { title: 'Проблемы', icon: 'bug' },
  progress: { title: 'Прогресс', icon: 'trending-up' },
  conventions: { title: 'Конвенции', icon: 'book-open' }
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Check if auth is required and redirect to login if needed
  try {
    const checkRes = await fetch('/api/auth/check');
    const { authEnabled, allowReadonly } = await checkRes.json();
    if (authEnabled && !AUTH_TOKEN) {
      if (allowReadonly) {
        // Enter readonly viewer mode without token
        isReadOnly = true;
      } else {
        window.location.href = '/login';
        return;
      }
    }
    if (authEnabled && AUTH_TOKEN) {
      const verifyRes = await authFetch('/api/auth/verify');
      const authInfo = await verifyRes.json();
      if (authInfo.readOnly) {
        isReadOnly = true;
      }
      if (authInfo.agentName) {
        const badge = document.createElement('span');
        badge.className = 'agent-badge';
        badge.textContent = authInfo.agentName;
        badge.setAttribute('data-tooltip', `${authInfo.agentName} · ${authInfo.role || 'agent'}`);
        const footer = document.querySelector('.sidebar-footer');
        footer.insertBefore(badge, footer.firstChild);
      }
      // Show admin-only UI for master token holder
      if (authInfo.isMaster) {
        isMasterUser = true;
        const agentsBtn = document.getElementById('btn-agents-view');
        if (agentsBtn) agentsBtn.style.display = '';
        const backupBtn = document.getElementById('btn-backup');
        if (backupBtn) backupBtn.style.display = '';
      }
    }
    // Apply readonly mode: hide write UI, show viewer badge and login button
    if (isReadOnly) {
      applyReadonlyMode();
    }
    // Always show auth button (login or logout)
    if (authEnabled) {
      renderAuthButton();
    }
  } catch (e) {
    // If check fails, proceed without auth
  }

  lucide.createIcons();
  initTooltips();
  initSidebarToggle();
  initNavigation();
  initSearch();
  initModal();
  initFormSelects();
  initThemeSwitcher();
  initProjectsModal();
  initDomainModal();
  initDomainContextMenu();
  initEntryActions();
  await loadProjects();
  await loadProjectDomains();
  renderDomainFilters();
  populateEntryDomainSelect();
  initWebSocket();
  loadEntries();
  loadStats();
  updateSessionNotesCounts();
});

// === Readonly Mode & Auth Button ===

function applyReadonlyMode() {
  // Mark body so CSS + other scripts (chat.js) can scope their behaviour.
  document.body.classList.add('readonly-mode');
  // Hide write-action buttons
  const hideSelectors = [
    '#btn-add',                     // "Добавить" button
    '#btn-backup',                  // Backup button
    '#session-delete-detail-btn',   // Session delete in detail view
  ];
  hideSelectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.style.display = 'none';
  });

  // Add readonly badge to sidebar footer
  const badge = document.createElement('span');
  badge.className = 'agent-badge readonly-badge';
  badge.textContent = 'Viewer';
  badge.setAttribute('data-tooltip', 'Режим просмотра — авторизуйтесь для редактирования');
  const footer = document.querySelector('.sidebar-footer');
  footer.insertBefore(badge, footer.firstChild);
}

function renderAuthButton() {
  const headerRight = document.querySelector('.header-right');
  if (!headerRight) return;

  const btn = document.createElement('button');
  btn.className = 'btn btn-icon btn-auth';

  if (AUTH_TOKEN && !isReadOnly) {
    // Logout button
    btn.title = 'Выйти';
    btn.innerHTML = '<i data-lucide="log-out"></i>';
    btn.addEventListener('click', () => {
      localStorage.removeItem('auth-token');
      window.location.reload();
    });
  } else {
    // Login button
    btn.title = 'Войти';
    btn.innerHTML = '<i data-lucide="log-in"></i>';
    btn.addEventListener('click', () => {
      window.location.href = '/login';
    });
  }

  headerRight.appendChild(btn);
  lucide.createIcons();
}

// === Tooltips ===

function convertTitlesToTooltips(root = document) {
  root.querySelectorAll('[title]').forEach(el => {
    const text = el.getAttribute('title');
    if (text) {
      el.setAttribute('data-tooltip', text);
      el.removeAttribute('title');
    }
  });
}

function initTooltips() {
  convertTitlesToTooltips();
  // Watch for dynamically added elements with title attributes
  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) convertTitlesToTooltips(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// === Projects ===

async function loadProjects() {
  try {
    const response = await authFetch(`${API_BASE}/projects`);
    const result = await response.json();

    if (result.success) {
      projects = result.projects;
      renderProjectSelect();
      renderDomainFilters();
    }
  } catch (error) {
    console.error('Failed to load projects:', error);
  }
}

function renderProjectSelect() {
  const current = currentProjectId;
  projectOptionsContainer.innerHTML = '';

  for (const p of projects) {
    const opt = document.createElement('div');
    opt.className = 'custom-select-option' + (p.id === current ? ' selected' : '');
    opt.dataset.value = p.id;
    opt.innerHTML = `
      <span class="custom-select-option-name">${escapeHtml(p.name)}</span>
      ${p.description ? `<span class="custom-select-option-desc">${escapeHtml(p.description)}</span>` : ''}
    `;
    opt.addEventListener('click', () => {
      selectProjectOption(p.id);
    });
    projectOptionsContainer.appendChild(opt);
  }

  // Restore selection or select default
  if (current && projects.some(p => p.id === current)) {
    updateProjectSelectDisplay(current);
  } else if (projects.length > 0) {
    const defaultProject = projects.find(p => p.name === 'default') || projects[0];
    updateProjectSelectDisplay(defaultProject.id);
    currentProjectId = defaultProject.id;
  }
}

function updateProjectSelectDisplay(projectId) {
  const project = projects.find(p => p.id === projectId);
  if (project) {
    projectSelectValue.textContent = project.name;
  }
  // Update selected state
  projectOptionsContainer.querySelectorAll('.custom-select-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === projectId);
  });
}

function selectProjectOption(projectId) {
  projectSelect.classList.remove('open');
  updateProjectSelectDisplay(projectId);
  switchProject(projectId);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Clipboard helper with fallback for non-secure contexts (HTTP without SSL).
// navigator.clipboard is undefined when page is served over plain HTTP.
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (err) { reject(err); }
  });
}

function renderDomainFilters() {
  domainFiltersContainer.innerHTML = '';

  // "+" add domain button (hidden in readonly mode)
  if (!isReadOnly) {
    const addBtn = document.createElement('button');
    addBtn.className = 'domain-pill domain-pill--add';
    addBtn.dataset.domain = '__add__';
    addBtn.innerHTML = '<i data-lucide="plus"></i>';
    addBtn.title = 'Добавить домен';
    addBtn.addEventListener('click', () => openDomainModal());
    domainFiltersContainer.appendChild(addBtn);
  }

  // "All domains" pill
  const allBtn = document.createElement('button');
  allBtn.className = 'domain-pill' + (currentDomain === '' ? ' active' : '');
  allBtn.dataset.domain = '';
  allBtn.textContent = 'Все домены';
  allBtn.addEventListener('click', () => selectDomain(''));
  domainFiltersContainer.appendChild(allBtn);

  // Domain pills from projectDomains
  for (const d of projectDomains) {
    const btn = document.createElement('button');
    btn.className = 'domain-pill' + (currentDomain === d.slug ? ' active' : '');
    btn.dataset.domain = d.slug;
    btn.innerHTML = `<i data-lucide="${d.icon || 'tag'}"></i> ${escapeHtml(d.name)}`;
    btn.addEventListener('click', () => selectDomain(d.slug));
    if (!isReadOnly) btn.addEventListener('contextmenu', (e) => showDomainContextMenu(e, d));
    domainFiltersContainer.appendChild(btn);
  }

  lucide.createIcons();
}

function selectDomain(domain) {
  currentDomain = domain;
  domainFiltersContainer.querySelectorAll('.domain-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.domain === domain);
  });
  loadEntries();
}

async function switchProject(projectId) {
  // Step 1: tear down the WebSocket *before* swapping currentProjectId so any
  // in-flight onmessage handlers don't apply old-project updates to the new
  // project's entries array (race that produced stale data on quick switches).
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch (_e) {}
    ws = null;
  }
  // Also drop any pending WS-reload (memory:* events from the old project
  // that have queued up inside the 150ms debounce window). Otherwise the
  // first new-project loadEntries() can be immediately overwritten by a
  // stale reload triggered by the late-arriving old event.
  if (_wsReloadTimer) {
    clearTimeout(_wsReloadTimer);
    _wsReloadTimer = null;
  }
  _wsReloadFlags = { entries: false, stats: false };

  // Step 2: swap the working set.
  currentProjectId = projectId;
  localStorage.setItem('selected-project', projectId);
  currentDomain = '';

  // Step 3: await all data fetches so the UI reaches a consistent state
  // before the new WebSocket starts pushing updates.
  await loadProjectDomains();
  renderDomainFilters();
  populateEntryDomainSelect();
  await Promise.all([
    loadEntries(),
    loadStats(),
    updateSessionNotesCounts(),
    // Reload whichever alt-view tab is currently active so it doesn't show
    // stale data from the previous project (scope-note M3 et al).
    currentCategory === 'profile' ? loadProfile() : Promise.resolve(),
    currentCategory === 'events' ? loadEvents() : Promise.resolve(),
    currentCategory === 'notes' ? loadNotes() : Promise.resolve(),
    currentCategory === 'sessions' ? loadSessions() : Promise.resolve(),
  ]);

  // Step 4: now safe to bring the WebSocket back up.
  initWebSocket();
}

function populateEntryDomainSelect() {
  const optionsContainer = document.getElementById('domain-options');

  optionsContainer.innerHTML = '<div class="custom-select-option selected" data-value=""><span class="custom-select-option-name">Без домена</span></div>';
  for (const d of projectDomains) {
    const optEl = document.createElement('div');
    optEl.className = 'custom-select-option';
    optEl.dataset.value = d.slug;
    optEl.innerHTML = `<span class="custom-select-option-name">${escapeHtml(d.name)}</span>`;
    optionsContainer.appendChild(optEl);
  }

  // Re-bind click handlers for new options
  initFormSelect('domain-select', 'entry-domain');
  setFormSelectValue('domain-select', 'entry-domain', '');
}

// === Project Domains Management ===

async function loadProjectDomains() {
  try {
    const response = await authFetch(`${API_BASE}/projects/${currentProjectId}/domains`);
    const result = await response.json();
    if (result.success) {
      projectDomains = result.domains;
    }
  } catch (e) {
    console.error('Failed to load project domains:', e);
  }
}

function initDomainModal() {
  document.getElementById('domain-modal-close').addEventListener('click', closeDomainModal);
  document.getElementById('domain-btn-cancel').addEventListener('click', closeDomainModal);
  document.getElementById('domain-btn-save').addEventListener('click', saveDomain);
  document.getElementById('domain-modal').addEventListener('click', (e) => {
    if (e.target.id === 'domain-modal') closeDomainModal();
  });

  // Auto-generate slug from name
  document.getElementById('domain-name').addEventListener('input', (e) => {
    const editSlug = document.getElementById('domain-edit-slug').value;
    if (editSlug) return; // Don't auto-generate when editing
    const slug = transliterate(e.target.value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    document.getElementById('domain-slug').value = slug;
  });
}

function transliterate(text) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
    'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
    'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
    'ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    ' ':'-'
  };
  return text.split('').map(c => {
    const lower = c.toLowerCase();
    return map[lower] !== undefined ? map[lower] : lower;
  }).join('');
}

let _domainModalA11yDetach = null;

function openDomainModal(domain = null) {
  const modal = document.getElementById('domain-modal');
  const title = document.getElementById('domain-modal-title');
  const nameInput = document.getElementById('domain-name');
  const slugInput = document.getElementById('domain-slug');
  const descInput = document.getElementById('domain-description');
  const editSlugInput = document.getElementById('domain-edit-slug');

  if (domain) {
    title.textContent = 'Редактировать домен';
    nameInput.value = domain.name;
    slugInput.value = domain.slug;
    slugInput.disabled = true; // Slug immutable on edit
    descInput.value = domain.description || '';
    editSlugInput.value = domain.slug;
  } else {
    title.textContent = 'Добавить домен';
    nameInput.value = '';
    slugInput.value = '';
    slugInput.disabled = false;
    descInput.value = '';
    editSlugInput.value = '';
  }

  modal.classList.add('active');
  _domainModalA11yDetach = window.attachModalA11y(modal, {
    onClose: closeDomainModal,
    initialFocusSelector: '#domain-name',
  });
}

function closeDomainModal() {
  if (_domainModalA11yDetach) { _domainModalA11yDetach(); _domainModalA11yDetach = null; }
  document.getElementById('domain-modal').classList.remove('active');
}

async function saveDomain() {
  const nameInput = document.getElementById('domain-name');
  const slugInput = document.getElementById('domain-slug');
  const descInput = document.getElementById('domain-description');
  const editSlug = document.getElementById('domain-edit-slug').value;

  const name = nameInput.value.trim();
  const slug = slugInput.value.trim();
  const description = descInput.value.trim();

  if (!name) { showToast('Введите название домена', 'error'); return; }
  if (!slug) { showToast('Введите slug домена', 'error'); return; }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    showToast('Slug: только латиница, цифры и дефисы', 'error');
    return;
  }
  if (slug.length > 64) {
    showToast('Slug: максимум 64 символа', 'error');
    return;
  }

  try {
    let response;
    if (editSlug) {
      // Update
      response = await authFetch(`${API_BASE}/projects/${currentProjectId}/domains/${encodeURIComponent(editSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });
    } else {
      // Create
      response = await authFetch(`${API_BASE}/projects/${currentProjectId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, name, description })
      });
    }

    const result = await response.json();
    if (!result.success) {
      showToast(result.error || 'Ошибка', 'error');
      return;
    }

    showToast(editSlug ? 'Домен обновлён' : 'Домен добавлен', 'success');
    closeDomainModal();
    await loadProjectDomains();
    renderDomainFilters();
    populateEntryDomainSelect();
  } catch (e) {
    showToast('Ошибка сохранения домена', 'error');
  }
}

// === Domain Context Menu ===

let activeContextMenuDomain = null;

function initDomainContextMenu() {
  const menu = document.getElementById('domain-context-menu');

  menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
    hideContextMenu();
    if (activeContextMenuDomain) openDomainModal(activeContextMenuDomain);
  });

  menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    hideContextMenu();
    if (!activeContextMenuDomain) return;
    await deleteDomain(activeContextMenuDomain);
  });

  // Hide on click outside
  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.domain-pill') || e.target.closest('.domain-pill--add') || e.target.closest('[data-domain=""]')) {
      hideContextMenu();
    }
  });
}

function showDomainContextMenu(e, domain) {
  e.preventDefault();
  activeContextMenuDomain = domain;
  const menu = document.getElementById('domain-context-menu');
  menu.classList.add('active');
  lucide.createIcons({ nodes: menu.querySelectorAll('[data-lucide]') });

  // Position with viewport boundary check
  let x = e.clientX;
  let y = e.clientY;
  const menuRect = menu.getBoundingClientRect();
  if (x + menuRect.width > window.innerWidth) {
    x = window.innerWidth - menuRect.width - 4;
  }
  if (y + menuRect.height > window.innerHeight) {
    y = window.innerHeight - menuRect.height - 4;
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function hideContextMenu() {
  document.getElementById('domain-context-menu').classList.remove('active');
  activeContextMenuDomain = null;
}

async function deleteDomain(domain) {
  try {
    // Check how many entries use this domain
    const countResp = await authFetch(`${API_BASE}/projects/${currentProjectId}/domains/${encodeURIComponent(domain.slug)}/count`);
    const countResult = await countResp.json();
    const count = countResult.count || 0;

    let msg = `Удалить домен "${domain.name}"?`;
    if (count > 0) {
      msg += `\n\nУ ${count} записей установлен этот домен. Домен у них будет сброшен.`;
    }

    if (!await showConfirmModal({ title: 'Удалить домен', message: msg, confirmText: 'Удалить', danger: true })) return;

    const response = await authFetch(`${API_BASE}/projects/${currentProjectId}/domains/${encodeURIComponent(domain.slug)}`, {
      method: 'DELETE'
    });
    const result = await response.json();
    if (!result.success) {
      showToast(result.error || 'Ошибка удаления', 'error');
      return;
    }

    showToast('Домен удалён', 'success');

    // If we were filtering by this domain, reset to all
    if (currentDomain === domain.slug) {
      currentDomain = '';
    }

    await loadProjectDomains();
    renderDomainFilters();
    populateEntryDomainSelect();
    loadEntries();
  } catch (e) {
    showToast('Ошибка удаления домена', 'error');
  }
}

// ===== Custom nav tooltips =====
// One reusable tooltip element kept on document.body. Triggered by hover on
// any .nav-item with data-tooltip-title / data-tooltip-body / data-tooltip-example.
// Positioned to the right of the hovered button at vertical center, with a
// small viewport-edge clamp. Hidden when no anchor.
let _navTooltipEl = null;
let _navTooltipShowTimer = null;
let _navTooltipHideTimer = null;
const NAV_TOOLTIP_SHOW_DELAY_MS = 250;
const NAV_TOOLTIP_GAP_PX = 12;

function ensureNavTooltipEl() {
  if (_navTooltipEl) return _navTooltipEl;
  const el = document.createElement('div');
  el.className = 'nav-tooltip';
  el.innerHTML = `
    <span class="nav-tooltip-title"></span>
    <span class="nav-tooltip-body"></span>
    <span class="nav-tooltip-example"></span>
  `;
  document.body.appendChild(el);
  _navTooltipEl = el;
  return el;
}

function positionNavTooltip(anchor) {
  const el = ensureNavTooltipEl();
  const rect = anchor.getBoundingClientRect();
  // Place to the right of the sidebar item, vertically centered.
  let left = rect.right + NAV_TOOLTIP_GAP_PX;
  let top = rect.top + rect.height / 2;
  // Clamp to viewport — if not enough room on the right, fall back to left side.
  const maxRight = window.innerWidth - 8;
  const tooltipW = el.offsetWidth || 280;
  if (left + tooltipW > maxRight) {
    left = Math.max(8, rect.left - NAV_TOOLTIP_GAP_PX - tooltipW);
  }
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function showNavTooltipFor(anchor) {
  const title = anchor.dataset.tooltipTitle;
  const body = anchor.dataset.tooltipBody;
  if (!title && !body) return;
  const el = ensureNavTooltipEl();
  el.querySelector('.nav-tooltip-title').textContent = title || '';
  el.querySelector('.nav-tooltip-body').textContent = body || '';
  const exampleEl = el.querySelector('.nav-tooltip-example');
  if (anchor.dataset.tooltipExample) {
    exampleEl.textContent = anchor.dataset.tooltipExample;
    exampleEl.style.display = '';
  } else {
    exampleEl.style.display = 'none';
  }
  // Make sure offsetWidth is correct before positioning.
  el.classList.add('is-visible');
  positionNavTooltip(anchor);
  // Re-position once after font/icon-load layout settles.
  requestAnimationFrame(() => positionNavTooltip(anchor));
}

function hideNavTooltip() {
  if (_navTooltipEl) _navTooltipEl.classList.remove('is-visible');
}

function bindNavTooltips() {
  document.querySelectorAll('.nav-item[data-tooltip-title]').forEach(item => {
    item.addEventListener('mouseenter', () => {
      clearTimeout(_navTooltipHideTimer);
      clearTimeout(_navTooltipShowTimer);
      _navTooltipShowTimer = setTimeout(() => showNavTooltipFor(item), NAV_TOOLTIP_SHOW_DELAY_MS);
    });
    item.addEventListener('mouseleave', () => {
      clearTimeout(_navTooltipShowTimer);
      _navTooltipHideTimer = setTimeout(hideNavTooltip, 60);
    });
    item.addEventListener('focus', () => showNavTooltipFor(item));
    item.addEventListener('blur', hideNavTooltip);
  });
  // Hide on click (so the tooltip doesn't linger after the user navigates).
  document.addEventListener('click', () => {
    clearTimeout(_navTooltipShowTimer);
    hideNavTooltip();
  });
}

// Navigation
function initNavigation() {
  bindNavTooltips();
  document.querySelectorAll('.nav-item[data-category]').forEach(item => {
    item.addEventListener('click', () => {
      if (isGraphView) toggleGraphView(false);
      if (isAgentsView) toggleAgentsView(false);

      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      currentCategory = item.dataset.category;

      // Hide all content containers
      document.getElementById('entries-container').style.display = '';
      document.getElementById('sessions-container').style.display = 'none';
      document.getElementById('session-detail-container').style.display = 'none';
      document.getElementById('notes-container').style.display = 'none';
      document.getElementById('domain-filters').style.display = '';

      const existingLoadMore = document.getElementById('load-more-btn');
      if (existingLoadMore) existingLoadMore.remove();
      const sessLoadMore = document.getElementById('sessions-load-more-btn');
      if (sessLoadMore) sessLoadMore.remove();
      const notesLoadMore = document.getElementById('notes-load-more-btn');
      if (notesLoadMore) notesLoadMore.remove();

      // Reset all alternative-view containers before showing the active one.
      const altContainers = ['sessions-container', 'notes-container', 'events-container', 'profile-container'];
      altContainers.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      if (currentCategory === 'sessions') {
        document.getElementById('entries-container').style.display = 'none';
        document.getElementById('sessions-container').style.display = '';
        document.getElementById('domain-filters').style.display = 'none';
        statusSelect.style.display = 'none';
        pageTitle.textContent = 'Сессии';
        updateHeaderStatsForSessions();
        loadSessions();
      } else if (currentCategory === 'notes') {
        document.getElementById('entries-container').style.display = 'none';
        document.getElementById('notes-container').style.display = '';
        document.getElementById('domain-filters').style.display = 'none';
        statusSelect.style.display = 'none';
        pageTitle.textContent = 'Заметки';
        updateHeaderStatsForNotes();
        loadNotes();
      } else if (currentCategory === 'events') {
        // v5: project_events live in a separate table; show timeline view.
        document.getElementById('entries-container').style.display = 'none';
        document.getElementById('events-container').style.display = '';
        document.getElementById('domain-filters').style.display = 'none';
        statusSelect.style.display = 'none';
        pageTitle.textContent = 'События';
        loadEvents();
      } else if (currentCategory === 'profile') {
        // v5: profile is a single curated entry per project — show single
        // markdown card view instead of the grid used for other categories.
        document.getElementById('entries-container').style.display = 'none';
        document.getElementById('profile-container').style.display = '';
        document.getElementById('domain-filters').style.display = 'none';
        statusSelect.style.display = 'none';
        pageTitle.textContent = 'Профиль проекта';
        loadProfile();
      } else {
        // entries-container path covers: all, pinned, profile, knowledge, and
        // any legacy categories (if their nav buttons are unhidden later).
        document.getElementById('entries-container').style.display = '';
        statusSelect.style.display = '';
        pageTitle.textContent = categoryConfig[currentCategory]?.title || 'Все записи';
        loadStats();
        loadEntries();
      }
    });
  });

  document.getElementById('btn-add').addEventListener('click', () => {
    if (currentCategory === 'notes') {
      openNoteModal();
    } else {
      openModal();
    }
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    params.append('format', 'markdown');
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      params.append('category', currentCategory);
    }
    try {
      const res = await authFetch(`${API_BASE}/export?${params}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'team-memory-export.md';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Экспорт загружен', 'success');
    } catch (e) {
      showToast('Ошибка экспорта', 'error');
    }
  });

  // Backup button (admin only)
  document.getElementById('btn-backup').addEventListener('click', async () => {
    const btn = document.getElementById('btn-backup');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i> Бэкап...';
    lucide.createIcons();
    try {
      const res = await authFetch(`${API_BASE}/backup`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(`Бэкап создан: ${data.file} (${data.sizeMB} MB)`, 'success');
      } else {
        showToast(data.error || 'Ошибка бэкапа', 'error');
      }
    } catch (e) {
      showToast('Ошибка сети', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="database-backup"></i> Бэкап';
      lucide.createIcons();
    }
  });

  // Graph view toggle
  document.getElementById('btn-graph-view').addEventListener('click', () => {
    toggleGraphView(true);
  });

  // Agents view toggle (admin only)
  const agentsBtn = document.getElementById('btn-agents-view');
  if (agentsBtn) {
    agentsBtn.addEventListener('click', () => toggleAgentsView(true));
  }
  initAgentsPanel();

  // Custom project dropdown toggle
  projectSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    projectSelect.classList.toggle('open');
    statusSelect.classList.remove('open');
  });

  // Custom status dropdown toggle
  statusSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    statusSelect.classList.toggle('open');
    projectSelect.classList.remove('open');
  });

  // Status option click handlers
  statusOptionsContainer.querySelectorAll('.custom-select-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const value = opt.dataset.value;
      currentStatus = value;
      statusSelectValue.textContent = opt.querySelector('.custom-select-option-name').textContent;
      statusOptionsContainer.querySelectorAll('.custom-select-option').forEach(o =>
        o.classList.toggle('selected', o === opt)
      );
      statusSelect.classList.remove('open');
      loadEntries();
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!projectSelect.contains(e.target)) {
      projectSelect.classList.remove('open');
    }
    if (!statusSelect.contains(e.target)) {
      statusSelect.classList.remove('open');
    }
  });
}

// Sidebar collapse toggle
function initSidebarToggle() {
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const stored = localStorage.getItem('sidebar-collapsed');
  if (stored === 'true') sidebar.classList.add('collapsed');

  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed'));
  });
}

// Search & Filter
function initSearch() {
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = e.target.value;
      if (currentCategory === 'sessions') {
        loadSessions();
      } else if (currentCategory === 'notes') {
        loadNotes();
      } else {
        loadEntries();
      }
    }, 300);
  });

}

// === Form Custom Selects ===

function initFormSelect(selectId, hiddenInputId) {
  const wrapper = document.getElementById(selectId);
  if (!wrapper || wrapper._formSelectInit) return;
  wrapper._formSelectInit = true;
  const trigger = wrapper.querySelector('.custom-select-trigger');
  const valueEl = wrapper.querySelector('.custom-select-value');
  const hidden = document.getElementById(hiddenInputId);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.custom-select.open').forEach(s => {
      if (s !== wrapper) s.classList.remove('open');
    });
    wrapper.classList.toggle('open');
  });

  // Event delegation — works for dynamically added options
  wrapper.addEventListener('click', (e) => {
    const opt = e.target.closest('.custom-select-option');
    if (!opt) return;
    e.stopPropagation();
    wrapper.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    valueEl.textContent = opt.querySelector('.custom-select-option-name').textContent;
    hidden.value = opt.dataset.value;
    wrapper.classList.remove('open');
  });
}

function setFormSelectValue(selectId, hiddenInputId, value) {
  const wrapper = document.getElementById(selectId);
  const hidden = document.getElementById(hiddenInputId);
  if (!wrapper || !hidden) return;
  hidden.value = value;
  const options = wrapper.querySelectorAll('.custom-select-option');
  options.forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === value);
    if (opt.dataset.value === value) {
      wrapper.querySelector('.custom-select-value').textContent =
        opt.querySelector('.custom-select-option-name').textContent;
    }
  });
}

function initFormSelects() {
  initFormSelect('category-select', 'entry-category');
  initFormSelect('domain-select', 'entry-domain');
  initFormSelect('priority-select', 'entry-priority');
  initFormSelect('entry-status-select', 'entry-status');

  // Close all selects on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
  });
}

// === Entry & Project Action Delegation (CSP-safe, no inline handlers) ===

function initEntryActions() {
  // Entry card actions (delegated on entries container)
  entriesContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'togglePin') togglePin(id);
      else if (action === 'editEntry') editEntry(id);
      else if (action === 'showHistory') showHistory(id);
      else if (action === 'archiveEntry') archiveEntry(id);
      else if (action === 'deleteEntry') deleteEntry(id);
      return;
    }
    const card = e.target.closest('.entry-card');
    if (card) openReadModal(card.dataset.id);
  });

  // Project delete action (delegated on projects modal)
  const projectsList = document.getElementById('projects-list');
  if (projectsList) {
    projectsList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.action === 'deleteProject') deleteProject(btn.dataset.id);
      if (btn.dataset.action === 'renameProject') renameProject(btn.dataset.id, btn.dataset.name);
      if (btn.dataset.action === 'copyProjectId') copyProjectId(btn);
    });
  }
}

// === Read Modal ===

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  // headings: ### > ## > #
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  // bold **text** and __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // italic *text* and _text_
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // inline code `text`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // line breaks
  html = html.replace(/\n/g, '<br>');
  // clean up <br> after block elements
  html = html.replace(/(<\/h[234]>)<br>/g, '$1');
  html = html.replace(/(<\/ul>)<br>/g, '$1');
  html = html.replace(/(<\/li>)<br>/g, '$1');
  // Final defense-in-depth pass through DOMPurify. escapeHtml() above already
  // blocks any literal <script>/event handlers from the raw input, but a
  // future regex bug could re-introduce them; whitelist the tags we
  // actually use so anything unexpected gets stripped instead of executed.
  if (typeof window.DOMPurify !== 'undefined') {
    html = window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['strong', 'em', 'u', 'code', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'br', 'p', 'a'],
      ALLOWED_ATTR: ['href'],
    });
  }
  return html;
}

function openReadModal(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;

  document.getElementById('read-modal-title').textContent = entry.title;

  const catInfo = categoryConfig[entry.category];
  const readDomainPd = entry.domain ? projectDomains.find(pd => pd.slug === entry.domain) : null;
  const domainStr = entry.domain ? ` · ${readDomainPd ? readDomainPd.name : entry.domain}` : '';
  document.getElementById('read-modal-meta').innerHTML =
    `<span class="read-meta-cat">${catInfo?.label || entry.category}${domainStr}</span>
     <span class="read-meta-info">${escapeHtml(entry.author)} · ${formatDate(entry.updatedAt)}</span>`;

  document.getElementById('read-modal-body').innerHTML = renderMarkdown(entry.content);

  const tagsEl = document.getElementById('read-modal-tags');
  tagsEl.innerHTML = entry.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const readModal = document.getElementById('read-modal');
  readModal.classList.add('active');
  readModal.dataset.entryId = id;

  let detach = null;
  const close = () => {
    if (detach) { detach(); detach = null; }
    readModal.classList.remove('active');
  };

  document.getElementById('read-modal-close').onclick = close;
  const readEditBtn = document.getElementById('read-modal-edit');
  if (isReadOnly) {
    readEditBtn.style.display = 'none';
  } else {
    readEditBtn.style.display = '';
    readEditBtn.onclick = () => {
      close();
      editEntry(id);
    };
  }
  readModal.onclick = (e) => { if (e.target === readModal) close(); };
  detach = window.attachModalA11y(readModal, {
    onClose: close,
    initialFocusSelector: '#read-modal-close',
  });
  lucide.createIcons();
}

// === Entry Modal ===

function initModal() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  entryForm.addEventListener('submit', handleFormSubmit);
}

let _entryModalA11yDetach = null;

function openModal(entry = null) {
  populateEntryDomainSelect();
  const modalTitle = document.getElementById('modal-title');

  if (entry) {
    modalTitle.textContent = 'Редактировать запись';
    document.getElementById('entry-id').value = entry.id;
    setFormSelectValue('category-select', 'entry-category', entry.category);
    setFormSelectValue('domain-select', 'entry-domain', entry.domain || '');
    document.getElementById('entry-title').value = entry.title;
    document.getElementById('entry-content').value = entry.content;
    setFormSelectValue('priority-select', 'entry-priority', entry.priority);
    setFormSelectValue('entry-status-select', 'entry-status', entry.status);
    document.getElementById('entry-tags').value = entry.tags.join(', ');
    document.getElementById('entry-author').value = entry.author;
  } else {
    modalTitle.textContent = 'Добавить запись';
    entryForm.reset();
    document.getElementById('entry-id').value = '';
    // v5: default new entries to 'knowledge' (architecture/decisions/conventions
    // are now legacy-hidden and collapsed into knowledge by migration 022).
    setFormSelectValue('category-select', 'entry-category', 'knowledge');
    setFormSelectValue('priority-select', 'entry-priority', 'medium');
    setFormSelectValue('entry-status-select', 'entry-status', 'active');
    setFormSelectValue('domain-select', 'entry-domain', '');
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      setFormSelectValue('category-select', 'entry-category', currentCategory);
    }
    if (currentDomain) {
      setFormSelectValue('domain-select', 'entry-domain', currentDomain);
    }
  }

  modal.classList.add('active');
  _entryModalA11yDetach = window.attachModalA11y(modal, {
    onClose: closeModal,
    initialFocusSelector: '#entry-title',
  });
}

function closeModal() {
  if (_entryModalA11yDetach) { _entryModalA11yDetach(); _entryModalA11yDetach = null; }
  modal.classList.remove('active');
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('entry-id').value;
  const data = {
    category: document.getElementById('entry-category').value,
    domain: document.getElementById('entry-domain').value || null,
    title: document.getElementById('entry-title').value,
    content: document.getElementById('entry-content').value,
    priority: document.getElementById('entry-priority').value,
    status: document.getElementById('entry-status').value,
    tags: document.getElementById('entry-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    author: document.getElementById('entry-author').value || 'web-ui'
  };

  if (!id) {
    data.project_id = currentProjectId;
  }

  try {
    let response;
    if (id) {
      response = await authFetch(`${API_BASE}/memory/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } else {
      response = await authFetch(`${API_BASE}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    }

    const result = await response.json();

    if (result.success) {
      showToast(id ? 'Запись обновлена' : 'Запись добавлена', 'success');
      closeModal();
      loadEntries();
      loadStats();
    } else {
      showToast(result.error || 'Ошибка сохранения', 'error');
    }
  } catch (error) {
    showToast('Ошибка сети', 'error');
    console.error(error);
  }
}

// === Projects Modal ===

function initProjectsModal() {
  document.getElementById('btn-manage-projects').addEventListener('click', openProjectsModal);
  document.getElementById('projects-modal-close').addEventListener('click', closeProjectsModal);
  projectsModal.addEventListener('click', (e) => {
    if (e.target === projectsModal) closeProjectsModal();
  });
  document.getElementById('btn-create-project').addEventListener('click', createProject);
}

let _projectsModalA11yDetach = null;

function openProjectsModal() {
  projectsModal.classList.add('active');
  renderProjectsList();
  lucide.createIcons();
  _projectsModalA11yDetach = window.attachModalA11y(projectsModal, {
    onClose: closeProjectsModal,
    initialFocusSelector: '#projects-modal-close',
  });
}

function closeProjectsModal() {
  if (_projectsModalA11yDetach) { _projectsModalA11yDetach(); _projectsModalA11yDetach = null; }
  projectsModal.classList.remove('active');
}

function renderProjectsList() {
  const container = document.getElementById('projects-list');

  if (projects.length === 0) {
    container.innerHTML = '<div class="empty-state-text">Нет проектов</div>';
    return;
  }

  container.innerHTML = projects.map(p => `
    <div class="project-item" data-id="${p.id}">
      <div class="project-item-info">
        <div class="project-item-name">
          <i data-lucide="folder"></i>
          <strong>${escapeHtml(p.name)}</strong>
          ${p.name === 'default' ? '<span class="badge">по умолчанию</span>' : ''}
        </div>
        <div class="project-item-desc">${p.description ? escapeHtml(p.description) : '<em>Нет описания</em>'}</div>
        <div class="project-item-domains">
          ${p.domains.map(d => {
            const pd = projectDomains.find(pd => pd.slug === d);
            const label = pd ? pd.name : (domainInfo[d] ? domainInfo[d].name : d);
            return `<span class="domain-tag">${escapeHtml(label)}</span>`;
          }).join('')}
        </div>
      </div>
      <div class="project-item-actions">
        <button class="btn-copy-id" data-action="copyProjectId" data-id="${escapeHtml(p.id)}" data-tooltip="Скопировать Project ID">
          <i data-lucide="copy"></i> <span>ID</span>
        </button>
        ${p.name !== 'default' && isMasterUser ? `
          <button class="btn-icon" data-action="renameProject" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Переименовать">
            <i data-lucide="pencil"></i>
          </button>
          <button class="btn-icon" data-action="deleteProject" data-id="${escapeHtml(p.id)}" title="Удалить проект">
            <i data-lucide="trash-2"></i>
          </button>
        ` : ''}
      </div>
    </div>
  `).join('');

  lucide.createIcons();
}

function copyProjectId(btn) {
  const id = btn.dataset.id;
  const textarea = document.createElement('textarea');
  textarea.value = id;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);

  const icon = btn.querySelector('[data-lucide]');
  const span = btn.querySelector('span');

  if (!ok) {
    span.textContent = 'Ошибка';
    btn.classList.add('copy-failed');
    setTimeout(() => {
      span.textContent = 'ID';
      btn.classList.remove('copy-failed');
    }, 2000);
    return;
  }

  span.textContent = 'Скопировано';
  icon.setAttribute('data-lucide', 'check');
  btn.classList.add('copied');
  lucide.createIcons({ nodes: [icon] });
  setTimeout(() => {
    span.textContent = 'ID';
    icon.setAttribute('data-lucide', 'copy');
    btn.classList.remove('copied');
    lucide.createIcons({ nodes: [icon] });
  }, 1500);
}

async function createProject() {
  const nameInput = document.getElementById('new-project-name');
  const descInput = document.getElementById('new-project-description');
  const name = nameInput.value.trim();
  const description = descInput.value.trim();

  if (!name) {
    showToast('Введите название проекта', 'error');
    return;
  }

  try {
    const response = await authFetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });

    const result = await response.json();

    if (result.success) {
      showToast('Проект создан', 'success');
      nameInput.value = '';
      descInput.value = '';
      await loadProjects();
      renderProjectsList();
    } else {
      showToast(result.error || 'Ошибка создания', 'error');
    }
  } catch (error) {
    showToast('Ошибка сети', 'error');
    console.error(error);
  }
}

window.deleteProject = async function(id) {
  const project = projects.find(p => p.id === id);
  if (!project) return;

  if (!await showConfirmModal({
    title: 'Удалить проект',
    message: `Удалить проект "${project.name}" и все его записи?`,
    confirmText: 'Удалить',
    danger: true,
  })) return;

  try {
    const response = await authFetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
    const result = await response.json();

    if (result.success) {
      showToast('Проект удалён', 'success');

      // Switch to default if deleted current
      if (currentProjectId === id) {
        const defaultProject = projects.find(p => p.name === 'default');
        if (defaultProject) switchProject(defaultProject.id);
      }

      await loadProjects();
      renderProjectsList();
    } else {
      showToast(result.error || 'Ошибка удаления', 'error');
    }
  } catch (error) {
    showToast('Ошибка сети', 'error');
    console.error(error);
  }
};

async function renameProject(id, currentName) {
  const newName = await showPromptModal({
    title: 'Переименовать проект',
    label: 'Новое название',
    defaultValue: currentName,
    submitText: 'Сохранить',
  });
  if (!newName || newName.trim() === '' || newName.trim() === currentName) return;

  try {
    const response = await authFetch(`${API_BASE}/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const result = await response.json();

    if (result.success) {
      showToast(`Проект переименован: ${newName.trim()}`, 'success');
      await loadProjects();
      renderProjectsList();
    } else {
      showToast(result.error || 'Ошибка переименования', 'error');
    }
  } catch (error) {
    showToast('Ошибка сети', 'error');
    console.error(error);
  }
}

// === Load Data ===

async function loadEntries() {
  entriesContainer.innerHTML = `
    <div class="loading">
      <i data-lucide="loader-2" class="spin"></i>
      <span>Загрузка...</span>
    </div>
  `;
  lucide.createIcons();

  try {
    const params = new URLSearchParams();

    if (currentProjectId) params.append('project_id', currentProjectId);
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      params.append('category', currentCategory);
    }
    if (currentCategory === 'pinned') {
      params.append('pinned', 'true');
    }
    if (currentDomain) params.append('domain', currentDomain);
    if (currentSearch) params.append('search', currentSearch);
    if (currentStatus) params.append('status', currentStatus);

    const response = await authFetch(`${API_BASE}/memory?${params}`);
    const result = await response.json();

    if (result.success) {
      entries = result.entries;
      renderEntries();
      renderLoadMoreButton(result);
    }
  } catch (error) {
    entriesContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="alert-triangle"></i>
        <div class="empty-state-text">Ошибка загрузки данных</div>
      </div>
    `;
    lucide.createIcons();
    console.error(error);
  }
}

function renderLoadMoreButton(result) {
  const existing = document.getElementById('load-more-btn');
  if (existing) existing.remove();
  if (result.hasMore) {
    const btn = document.createElement('button');
    btn.id = 'load-more-btn';
    btn.className = 'btn btn-secondary load-more';
    btn.innerHTML = '<i data-lucide="chevrons-down"></i> Загрузить ещё';
    btn.addEventListener('click', () => loadMoreEntries(result.offset + result.limit));
    entriesContainer.after(btn);
    lucide.createIcons();
  }
}

async function loadMoreEntries(offset) {
  try {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    if (currentCategory !== 'all' && currentCategory !== 'pinned') params.append('category', currentCategory);
    if (currentCategory === 'pinned') params.append('pinned', 'true');
    if (currentDomain) params.append('domain', currentDomain);
    if (currentSearch) params.append('search', currentSearch);
    if (currentStatus) params.append('status', currentStatus);
    params.append('offset', String(offset));

    const response = await authFetch(`${API_BASE}/memory?${params}`);
    const result = await response.json();

    if (result.success) {
      entries = entries.concat(result.entries);
      renderEntries();
      renderLoadMoreButton(result);
    }
  } catch (e) {
    showToast('Ошибка загрузки', 'error');
  }
}

async function loadStats() {
  try {
    const params = currentProjectId ? `?project_id=${currentProjectId}` : '';
    const response = await authFetch(`${API_BASE}/stats${params}`);
    const result = await response.json();

    if (result.success) {
      const stats = result.stats;

      document.getElementById('count-all').textContent = stats.totalEntries;
      // v5 active categories
      const knowledgeEl = document.getElementById('count-knowledge');
      if (knowledgeEl) knowledgeEl.textContent = stats.byCategory.knowledge || 0;
      const profileEl = document.getElementById('count-profile');
      if (profileEl) profileEl.textContent = stats.byCategory.profile || 0;
      // Legacy counts — kept for the hidden nav items and possible V5+ Azure
      // revive (see index.html comment block).
      document.getElementById('count-architecture').textContent = stats.byCategory.architecture || 0;
      document.getElementById('count-tasks').textContent = stats.byCategory.tasks || 0;
      document.getElementById('count-decisions').textContent = stats.byCategory.decisions || 0;
      document.getElementById('count-issues').textContent = stats.byCategory.issues || 0;
      document.getElementById('count-progress').textContent = stats.byCategory.progress || 0;
      document.getElementById('count-conventions').textContent = stats.byCategory.conventions || 0;
      // Events live in a separate table — fetched independently.
      updateEventsCount();

      document.getElementById('stat-total').textContent = stats.totalEntries;
      document.getElementById('stat-24h').textContent = stats.recentActivity?.last24h || 0;

      // Pinned count from stats (server-side, accurate)
      document.getElementById('count-pinned').textContent = stats.pinnedCount || 0;

      // Embedding stats
      if (result.embedding) {
        renderEmbeddingIndicator(result.embedding);
      }
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// === Render ===

function renderEntries() {
  if (entries.length === 0) {
    entriesContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="file-text"></i>
        <div class="empty-state-text">Нет записей${currentSearch ? ' по запросу "' + escapeHtml(currentSearch) + '"' : ''}</div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  entriesContainer.innerHTML = entries.map(entry => {
    const dPd = entry.domain ? projectDomains.find(pd => pd.slug === entry.domain) : null;
    const dInfo = entry.domain ? (dPd || domainInfo[entry.domain]) : null;
    const domainLabel = dPd ? dPd.name : (domainInfo[entry.domain] ? domainInfo[entry.domain].name : entry.domain);
    const domainBadge = entry.domain
      ? `<span class="entry-domain-badge">${escapeHtml(domainLabel)}</span>`
      : '';

    return `
    <div class="entry-card ${escapeHtml(entry.status)}${entry.pinned ? ' pinned' : ''}" data-id="${escapeHtml(entry.id)}">
      <div class="entry-badges">
        ${domainBadge}
        <span class="entry-category">
          <i data-lucide="${categoryConfig[entry.category]?.icon || 'file'}"></i>
          ${escapeHtml(entry.category)}
        </span>
      </div>
      <div class="entry-title">
        ${entry.pinned ? '<i data-lucide="pin" class="pin-indicator"></i>' : ''}
        <span class="priority-dot priority-${escapeHtml(entry.priority)}"></span>
        <span class="entry-title-text">${escapeHtml(entry.title)}</span>
      </div>
      <div class="entry-content">${escapeHtml(entry.content)}</div>
      <div class="entry-tags-row">
        ${entry.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
      </div>
      <div class="entry-footer">
        <div class="entry-meta">
          <span class="entry-meta-time"><i data-lucide="calendar"></i> ${formatDate(entry.updatedAt)}</span>
          <span class="entry-meta-author"><i data-lucide="user"></i> ${escapeHtml(entry.author)}</span>
        </div>
        <div class="entry-actions">
          ${isReadOnly ? `
          <button data-action="showHistory" data-id="${entry.id}" title="История">
            <i data-lucide="history"></i>
          </button>
          ` : `
          <button data-action="togglePin" data-id="${entry.id}" title="${entry.pinned ? 'Открепить' : 'Закрепить'}" class="${entry.pinned ? 'active' : ''}">
            <i data-lucide="pin"></i>
          </button>
          <button data-action="editEntry" data-id="${entry.id}" title="Редактировать">
            <i data-lucide="pencil"></i>
          </button>
          <button data-action="showHistory" data-id="${entry.id}" title="История">
            <i data-lucide="history"></i>
          </button>
          ${entry.status !== 'archived' ? `<button data-action="archiveEntry" data-id="${entry.id}" title="Архивировать">
            <i data-lucide="archive"></i>
          </button>` : ''}
          <button data-action="deleteEntry" data-id="${entry.id}" title="Удалить">
            <i data-lucide="trash-2"></i>
          </button>
          `}
        </div>
      </div>
    </div>
  `}).join('');

  lucide.createIcons();
}

// === Entry Actions ===

window.editEntry = function(id) {
  const entry = entries.find(e => e.id === id);
  if (entry) openModal(entry);
};

window.archiveEntry = async function(id) {
  if (!await showConfirmModal({ title: 'Архивировать запись', message: 'Архивировать эту запись?', confirmText: 'Архивировать' })) return;

  try {
    const response = await authFetch(`${API_BASE}/memory/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();

    if (result.success) {
      showToast('Запись архивирована', 'success');
      loadEntries();
      loadStats();
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Ошибка архивации', 'error');
  }
};

window.deleteEntry = async function(id) {
  if (!await showConfirmModal({ title: 'Удалить запись', message: 'Удалить эту запись навсегда?', confirmText: 'Удалить', danger: true })) return;

  try {
    const response = await authFetch(`${API_BASE}/memory/${id}?archive=false`, {
      method: 'DELETE'
    });

    const result = await response.json();

    if (result.success) {
      showToast('Запись удалена', 'success');
      loadEntries();
      loadStats();
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Ошибка удаления', 'error');
  }
};

window.togglePin = async function(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;

  const newPinned = !entry.pinned;

  try {
    const response = await authFetch(`${API_BASE}/memory/${id}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: newPinned })
    });

    const result = await response.json();

    if (result.success) {
      showToast(newPinned ? 'Запись закреплена' : 'Запись откреплена', 'success');
      loadEntries();
      loadStats();
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Ошибка при изменении закрепления', 'error');
  }
};

window.showHistory = async function(id) {
  try {
    const response = await authFetch(`${API_BASE}/memory/${id}/history`);
    const result = await response.json();

    if (!result.success) {
      showToast(result.error || 'Ошибка загрузки истории', 'error');
      return;
    }

    if (result.versions.length === 0) {
      showToast('Запись ещё не обновлялась — история пуста', 'info');
      return;
    }

    const text = result.versions.map(v =>
      `v${v.version} [${new Date(v.createdAt).toLocaleString()}]\n  ${v.title} (${v.status})`
    ).join('\n\n');

    await showAlertModal({ title: 'История версий', message: text });
  } catch (error) {
    showToast('Ошибка загрузки истории', 'error');
    console.error(error);
  }
};

// === WebSocket ===

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  if (AUTH_TOKEN) params.set('token', AUTH_TOKEN);
  params.set('client_type', 'ui');
  if (currentProjectId) params.set('project_id', currentProjectId);
  const wsUrl = `${protocol}//${window.location.host}/ws?${params.toString()}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      showToast('Подключено к серверу', 'info');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWSMessage(data);
      } catch (e) {
        console.error('Invalid WS message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setTimeout(initWebSocket, 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to connect WebSocket:', error);
  }
}

function isEventForCurrentProject(payload) {
  if (!currentProjectId) return true; // no project selected — show all
  if (!payload.projectId) return true; // event has no project — global event
  return payload.projectId === currentProjectId;
}

// WebSocket reload debounce — when the server broadcasts a burst of
// memory:* events (bulk import, mass-archive, etc.) we'd otherwise call
// loadEntries() once per event. With ~100 entries flying in, the UI
// re-renders 100 times within a few hundred ms and the tab visibly freezes.
// Coalesce into a single reload per ~150ms window.
let _wsReloadTimer = null;
let _wsReloadFlags = { entries: false, stats: false };
function scheduleWsReload(flags) {
  if (flags.entries) _wsReloadFlags.entries = true;
  if (flags.stats) _wsReloadFlags.stats = true;
  if (_wsReloadTimer) return;
  _wsReloadTimer = setTimeout(() => {
    _wsReloadTimer = null;
    const f = _wsReloadFlags;
    _wsReloadFlags = { entries: false, stats: false };
    if (f.entries && currentCategory !== 'sessions' && currentCategory !== 'notes') {
      loadEntries();
    }
    if (f.stats) loadStats();
  }, 150);
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'memory:created':
    case 'memory:updated':
    case 'memory:deleted':
      if (isEventForCurrentProject(data.payload)) {
        scheduleWsReload({ entries: true, stats: true });
        if (data.type === 'memory:created') {
          // Toasts are not debounced — one per event is fine and we'd lose
          // the "N new entries" signal if we coalesced them. If we ever
          // observe toast spam under load, switch this to a count + show
          // "N новых записей" after the debounce.
          showToast('Новая запись добавлена', 'info');
        }
      }
      break;

    case 'agent:connected':
      if (isEventForCurrentProject(data.payload) && !data.payload.renamed) {
        scheduleWsReload({ stats: true });
      }
      break;

    case 'agent:disconnected':
      if (isEventForCurrentProject(data.payload)) {
        scheduleWsReload({ stats: true });
      }
      break;
  }
}

// === Helpers ===

function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  if (diff < 60000) return 'только что';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
  if (diff < 86400000) return `сегодня, ${time}`;
  if (diff < 172800000) return `вчера, ${time}`;

  return `${date.toLocaleDateString('ru-RU')}, ${time}`;
}

/** Format cumulative chat-API cost for an agent. Returns a $ string with
 * a per-token tooltip. Uses ¢ for amounts under $0.01 to stay readable. */
function formatAgentCost(costUsd, promptTokens, completionTokens) {
  const cost = Number(costUsd ?? 0);
  const pt = Number(promptTokens ?? 0);
  const ct = Number(completionTokens ?? 0);
  let label;
  if (cost === 0) label = '—';
  else if (cost < 0.01) label = `${(cost * 100).toFixed(2)}¢`;
  else if (cost < 1) label = `$${cost.toFixed(4)}`;
  else label = `$${cost.toFixed(2)}`;
  const tooltip = cost === 0 ? 'Расходов пока не было' : `${pt.toLocaleString('ru-RU')} in / ${ct.toLocaleString('ru-RU')} out токенов`;
  return `<span title="${tooltip}">${label}</span>`;
}

// === Graph View Toggle ===

function toggleGraphView(show) {
  isGraphView = show;
  if (show && isAgentsView) toggleAgentsView(false);

  const entriesEl = document.getElementById('entries-container');
  const domainEl = document.getElementById('domain-filters');
  const graphEl = document.getElementById('graph-view');
  const headerRight = document.querySelector('.header-right');

  if (show) {
    entriesEl.style.display = 'none';
    domainEl.style.display = 'none';
    graphEl.style.display = 'flex';
    headerRight.style.visibility = 'hidden';
    const loadMore = document.getElementById('load-more-btn');
    if (loadMore) loadMore.style.display = 'none';
    const sessLoadMore = document.getElementById('sessions-load-more-btn');
    if (sessLoadMore) sessLoadMore.style.display = 'none';
    const notesLoadMore = document.getElementById('notes-load-more-btn');
    if (notesLoadMore) notesLoadMore.style.display = 'none';

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById('btn-graph-view').classList.add('active');
    pageTitle.textContent = 'Граф знаний';

    // Hide sessions/notes containers
    document.getElementById('sessions-container').style.display = 'none';
    document.getElementById('session-detail-container').style.display = 'none';
    document.getElementById('notes-container').style.display = 'none';

    // Scroll to top so graph is visible
    document.querySelector('.main').scrollTo(0, 0);

    // Load all entries for graph (no filters, higher limit)
    loadGraphEntries();
  } else {
    entriesEl.style.display = '';
    domainEl.style.display = '';
    graphEl.style.display = 'none';
    headerRight.style.visibility = '';
    const loadMore = document.getElementById('load-more-btn');
    if (loadMore) loadMore.style.display = '';
    if (typeof destroyGraph === 'function') destroyGraph();
  }
}

async function loadGraphEntries() {
  try {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    params.append('limit', '500');

    const response = await authFetch(`${API_BASE}/memory?${params}`);
    const result = await response.json();

    if (result.success && typeof renderGraph === 'function') {
      renderGraph(result.entries);
    }
  } catch (error) {
    console.error('Failed to load graph entries:', error);
  }
}

// === Embedding Indicator ===

function renderEmbeddingIndicator(emb) {
  const dot = document.getElementById('embedding-dot');
  const countEl = document.getElementById('embedding-count');
  const indicator = document.getElementById('embedding-indicator');
  if (!dot || !countEl || !indicator) return;

  if (!emb.provider) {
    dot.className = 'embedding-dot inactive';
    countEl.textContent = '—';
    indicator.setAttribute('data-tooltip', 'Векторный поиск отключён');
  } else if (emb.isReady && emb.entriesEmbedded >= emb.entriesTotal) {
    dot.className = 'embedding-dot active';
    countEl.textContent = `${emb.entriesEmbedded}/${emb.entriesTotal}`;
    indicator.setAttribute('data-tooltip', `${emb.model} · ${emb.dimensions}d · Все записи проиндексированы`);
  } else if (emb.isReady) {
    dot.className = 'embedding-dot partial';
    countEl.textContent = `${emb.entriesEmbedded}/${emb.entriesTotal}`;
    const pct = emb.entriesTotal > 0 ? Math.round(emb.entriesEmbedded / emb.entriesTotal * 100) : 0;
    indicator.setAttribute('data-tooltip', `${emb.model} · ${emb.dimensions}d · ${pct}% проиндексировано`);
  } else {
    dot.className = 'embedding-dot inactive';
    countEl.textContent = '—';
    indicator.setAttribute('data-tooltip', 'Модель не инициализирована');
  }
}

function showToast(message, type = 'info') {
  const iconMap = {
    success: 'check-circle',
    error: 'x-circle',
    info: 'info'
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i data-lucide="${iconMap[type]}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  toastContainer.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// === Agents Panel ===

function toggleAgentsView(show) {
  isAgentsView = show;
  if (show && isGraphView) toggleGraphView(false);

  const entriesEl = document.getElementById('entries-container');
  const domainEl = document.getElementById('domain-filters');
  const agentsEl = document.getElementById('agents-panel');
  const headerRight = document.querySelector('.header-right');

  if (show) {
    entriesEl.style.display = 'none';
    domainEl.style.display = 'none';
    agentsEl.style.display = '';
    headerRight.style.visibility = 'hidden';
    const loadMore = document.getElementById('load-more-btn');
    if (loadMore) loadMore.style.display = 'none';

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById('btn-agents-view').classList.add('active');
    pageTitle.textContent = 'Агенты';

    loadAgents();
  } else {
    agentsEl.style.display = 'none';
    entriesEl.style.display = '';
    domainEl.style.display = '';
    headerRight.style.visibility = '';
    const loadMore = document.getElementById('load-more-btn');
    if (loadMore) loadMore.style.display = '';
  }
}

function initAgentsPanel() {
  const createBtn = document.getElementById('btn-create-agent');
  const cancelBtn = document.getElementById('btn-cancel-agent');
  const confirmBtn = document.getElementById('btn-confirm-agent');
  const closeRevealBtn = document.getElementById('btn-close-reveal');
  const copyBtn = document.getElementById('btn-copy-token');

  if (createBtn) createBtn.addEventListener('click', () => {
    document.getElementById('agents-create-modal').style.display = 'flex';
    document.getElementById('new-agent-name').value = '';
    // Reset role dropdown to developer
    const roleSelect = document.getElementById('role-select');
    if (roleSelect) {
      roleSelect.querySelector('.custom-select-value').innerHTML = '<i data-lucide="code-2"></i> Разработчик';
      roleSelect.querySelector('.custom-select-value').dataset.role = 'developer';
      roleSelect.querySelectorAll('.custom-select-option').forEach(o => o.classList.toggle('selected', o.dataset.value === 'developer'));
    }
    lucide.createIcons();
    document.getElementById('new-agent-name').focus();
  });

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    document.getElementById('agents-create-modal').style.display = 'none';
  });

  if (confirmBtn) confirmBtn.addEventListener('click', createAgent);

  if (closeRevealBtn) closeRevealBtn.addEventListener('click', () => {
    document.getElementById('agents-token-reveal').style.display = 'none';
  });

  if (copyBtn) copyBtn.addEventListener('click', () => {
    const token = document.getElementById('revealed-token').textContent;
    copyToClipboard(token).then(() => showToast('Токен скопирован', 'success'))
      .catch(() => showToast('Не удалось скопировать токен', 'error'));
  });

  // Custom role dropdown
  const roleSelect = document.getElementById('role-select');
  if (roleSelect) {
    const trigger = roleSelect.querySelector('.custom-select-trigger');
    const options = roleSelect.querySelectorAll('.custom-select-option');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      roleSelect.classList.toggle('open');
    });
    options.forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        options.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        const val = roleSelect.querySelector('.custom-select-value');
        val.innerHTML = opt.querySelector('.custom-select-option-name').innerHTML;
        val.dataset.role = opt.dataset.value;
        roleSelect.classList.remove('open');
        lucide.createIcons();
      });
    });
    document.addEventListener('click', () => roleSelect.classList.remove('open'));
  }

  // Event delegation for agents table (CSP-compatible, no inline handlers)
  const tbody = document.getElementById('agents-tbody');
  if (tbody) tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      const token = btn.dataset.token;

      if (action === 'copy' && token) {
        copyToClipboard(token).then(() => showToast('Токен скопирован', 'success'))
          .catch(() => showToast('Не удалось скопировать токен', 'error'));
        return;
      }
      if (action === 'revoke') { await revokeAgent(id, name); return; }
      if (action === 'activate') { await activateAgent(id, name); return; }
      if (action === 'delete') { await deleteAgent(id, name); return; }
    }

    // Row click — toggle token row
    const row = e.target.closest('[data-toggle]');
    if (row) {
      const tokenRow = document.getElementById(row.dataset.toggle);
      if (tokenRow) {
        const isVisible = tokenRow.style.display !== 'none';
        tokenRow.style.display = isVisible ? 'none' : '';
        if (!isVisible) lucide.createIcons();
      }
    }
  });
}

async function loadAgents() {
  const tbody = document.getElementById('agents-tbody');
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens`);
    const data = await res.json();

    if (!data.success || !data.tokens?.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:32px">Нет агентов. Создайте первый токен.</td></tr>';
      return;
    }

    tbody.innerHTML = data.tokens.map(t => {
      const statusDot = t.isActive ? '<span class="agent-status-dot active"></span>Активен' : '<span class="agent-status-dot inactive"></span>Отключён';
      const roleIcons = { developer: 'code-2', qa: 'bug', lead: 'crown', devops: 'container' };
      const roleNames = { developer: 'Разработчик', qa: 'Тестировщик', lead: 'Руководитель', devops: 'DevOps' };
      const roleIcon = roleIcons[t.role] || 'user';
      const roleLabel = roleNames[t.role] || escapeHtml(t.role);
      const roleBadge = `<span class="agent-role-badge ${escapeHtml(t.role)}"><i data-lucide="${roleIcon}"></i> ${roleLabel}</span>`;
      const created = t.createdAt ? new Date(t.createdAt).toLocaleDateString('ru-RU') : '—';
      const lastUsed = t.lastUsedAt ? formatDate(t.lastUsedAt) : 'никогда';
      const cost = formatAgentCost(t.totalCostUsd, t.totalPromptTokens, t.totalCompletionTokens);

      const actions = [];
      if (t.isActive) {
        actions.push(`<button class="btn-revoke" data-action="revoke" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.agentName)}">Отключить</button>`);
      } else {
        actions.push(`<button class="btn-activate" data-action="activate" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.agentName)}">Включить</button>`);
      }
      actions.push(`<button class="btn-delete" data-action="delete" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.agentName)}">Удалить</button>`);

      const rowId = `agent-row-${escapeHtml(t.id)}`;
      return `<tr class="agent-row" data-toggle="${rowId}">
        <td>${statusDot}</td>
        <td><strong>${escapeHtml(t.agentName)}</strong></td>
        <td>${roleBadge}</td>
        <td>${created}</td>
        <td>${lastUsed}</td>
        <td class="agent-cost">${cost}</td>
        <td class="agents-actions">${actions.join(' ')}</td>
      </tr>
      <tr class="agent-token-row" id="${rowId}" style="display:none">
        <td colspan="7">
          <div class="agent-token-inline">
            <code>${escapeHtml(t.token)}</code>
            <button class="btn-copy-inline" data-action="copy" data-token="${escapeHtml(t.token)}" title="Копировать">
              <i data-lucide="copy"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
    lucide.createIcons();
  } catch (e) {
    console.error('Failed to load agents:', e);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--red)">Ошибка загрузки агентов</td></tr>';
  }
}

async function createAgent() {
  const name = document.getElementById('new-agent-name').value.trim();
  const role = document.querySelector('#role-select .custom-select-value')?.dataset.role || 'developer';

  if (!name) {
    showToast('Введите имя агента', 'error');
    return;
  }

  try {
    const res = await authFetch(`${API_BASE}/agent-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: name, role })
    });
    const data = await res.json();

    if (!data.success) {
      showToast(data.error || 'Ошибка создания', 'error');
      return;
    }

    document.getElementById('agents-create-modal').style.display = 'none';
    document.getElementById('revealed-token').textContent = data.token;
    document.getElementById('agents-token-reveal').style.display = 'flex';
    lucide.createIcons();

    loadAgents();
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

async function revokeAgent(id, name) {
  if (!await showConfirmModal({
    title: 'Отключить токен',
    message: `Отключить токен для "${name}"?`,
    confirmText: 'Отключить',
    danger: true,
  })) return;
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens/${id}/revoke`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Токен ${name} отключён`, 'success');
      loadAgents();
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

async function activateAgent(id, name) {
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens/${id}/activate`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Токен ${name} активирован`, 'success');
      loadAgents();
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

async function deleteAgent(id, name) {
  if (!await showConfirmModal({
    title: 'Удалить токен',
    message: `Удалить токен "${name}" навсегда? Это действие нельзя отменить.`,
    confirmText: 'Удалить навсегда',
    danger: true,
  })) return;
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Токен ${name} удалён`, 'success');
      loadAgents();
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

// ============================================
// Theme Switching
// ============================================

function getCurrentTheme() {
  return document.documentElement.dataset.theme || 'nothing';
}

function applyTheme(themeId) {
  document.documentElement.dataset.theme = themeId;
  localStorage.setItem('tm-theme', themeId);
  // Notify graph (if loaded) to re-read theme colors
  if (typeof window.refreshGraphTheme === 'function') {
    window.refreshGraphTheme();
  }
}

function renderThemePreview(colors) {
  return `<div class="theme-preview">
    <div class="theme-preview-inner" style="background:${colors.bg}">
      <div class="theme-preview-sidebar" style="background:${colors.sidebar};border-right:${colors.sidebarBorder}"></div>
      <div class="theme-preview-main">
        <div class="theme-preview-line" style="width:80%;background:${colors.line1}"></div>
        <div class="theme-preview-line" style="width:60%;background:${colors.line2}"></div>
        <div class="theme-preview-line" style="width:80%;background:${colors.line3}"></div>
        <div class="theme-preview-line" style="width:40%;background:${colors.line4}"></div>
      </div>
    </div>
  </div>`;
}

function openThemeModal() {
  const current = getCurrentTheme();
  const list = document.getElementById('theme-list');

  const renderRow = (t) => `
    <div class="theme-row ${t.id === current ? 'active' : ''} ${t.legacy ? 'legacy' : ''}" data-theme-id="${t.id}">
      ${renderThemePreview(t.colors)}
      <div class="theme-info">
        <div class="theme-name">
          ${t.name}
          ${t.legacy ? '<span class="theme-legacy-badge">LEGACY</span>' : ''}
        </div>
        <div class="theme-desc">${t.desc}</div>
      </div>
      <div class="theme-check">\u2713</div>
    </div>
  `;

  const primary = THEMES.filter(t => !t.legacy);
  const legacy = THEMES.filter(t => t.legacy);

  list.innerHTML = primary.map(renderRow).join('')
    + (legacy.length ? '<div class="theme-section-divider">LEGACY THEMES</div>' : '')
    + legacy.map(renderRow).join('');

  let selectedId = null;
  list.querySelectorAll('.theme-row').forEach(row => {
    row.addEventListener('click', () => {
      list.querySelectorAll('.theme-row').forEach(r => {
        r.classList.remove('selected');
        r.classList.remove('active');
      });
      row.classList.add('selected');
      selectedId = row.dataset.themeId;
    });
  });

  const themeModal = document.getElementById('theme-modal');
  themeModal.classList.add('active');

  const applyBtn = document.getElementById('theme-apply');
  const cancelBtn = document.getElementById('theme-cancel');
  const closeBtn = document.getElementById('theme-modal-close');

  const handleApply = () => {
    if (selectedId) {
      applyTheme(selectedId);
    }
    closeThemeModal();
  };

  const handleClose = () => closeThemeModal();

  applyBtn.onclick = handleApply;
  cancelBtn.onclick = handleClose;
  closeBtn.onclick = handleClose;

  themeModal.onclick = (e) => {
    if (e.target === themeModal) handleClose();
  };

  _themeModalA11yDetach = window.attachModalA11y(themeModal, {
    onClose: handleClose,
    initialFocusSelector: '#theme-modal-close',
  });
}

let _themeModalA11yDetach = null;
function closeThemeModal() {
  if (_themeModalA11yDetach) { _themeModalA11yDetach(); _themeModalA11yDetach = null; }
  document.getElementById('theme-modal').classList.remove('active');
}

function initThemeSwitcher() {
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.addEventListener('click', openThemeModal);
  }
  // ESC handling for theme/note/note-read modals now lives inside
  // attachModalA11y(), which scopes per-modal and respects modal stacking.
}

// ===== Sessions UI =====

async function loadSessions(append = false) {
  const container = document.getElementById('sessions-container');

  // Readonly: show demo placeholder instead of private data
  if (isReadOnly) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="message-square"></i>
        <div class="empty-state-text">Здесь могут находиться ваши сессии с AI</div>
        <div class="empty-state-hint" style="color:var(--text-muted);font-size:13px;margin-top:8px">
          Войдите в систему, чтобы импортировать и просматривать историю диалогов
        </div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  if (!append) {
    currentSessionOffset = 0;
    container.innerHTML = `
      <div class="loading">
        <i data-lucide="loader-2" class="spin"></i>
        <span>Загрузка...</span>
      </div>
    `;
    lucide.createIcons();
  }

  try {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    if (currentSearch) params.append('search', currentSearch);
    params.append('limit', String(SESSIONS_LIMIT));
    params.append('offset', String(currentSessionOffset));

    const response = await authFetch(`${API_BASE}/sessions?${params}`);
    const result = await response.json();

    if (result.success) {
      if (append) {
        sessionsData = sessionsData.concat(result.sessions);
      } else {
        sessionsData = result.sessions;
      }
      renderSessions();
      renderSessionsLoadMore(result);
    }
  } catch (error) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="alert-triangle"></i>
        <div class="empty-state-text">Ошибка загрузки сессий</div>
      </div>
    `;
    lucide.createIcons();
    console.error(error);
  }
}

function renderSessions() {
  const container = document.getElementById('sessions-container');

  if (sessionsData.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="message-square"></i>
        <div class="empty-state-text">Нет сессий${currentSearch ? ' по запросу "' + escapeHtml(currentSearch) + '"' : ''}</div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const statusLabels = {
    complete: 'Indexed', processing: 'Processing', summarizing: 'Summarizing',
    queued_embed: 'Processing', queued: 'Queued', failed: 'Failed'
  };

  container.innerHTML = sessionsData.map(session => {
    const title = session.name || ('Сессия от ' + formatDate(session.importedAt));
    const statusLabel = statusLabels[session.embeddingStatus] || session.embeddingStatus;

    return `
    <div class="session-card" data-session-id="${escapeHtml(session.id)}">
      <div class="session-card-header">
        <div class="session-title">${escapeHtml(title)}</div>
        ${isReadOnly ? '' : `<button class="btn-icon session-delete-btn" data-action="deleteSession" data-id="${escapeHtml(session.id)}" title="Удалить сессию">
          <i data-lucide="trash-2"></i>
        </button>`}
      </div>
      ${session.summary ? `<div class="session-summary">${escapeHtml(session.summary)}</div>` : ''}
      <div class="session-meta">
        <span><i data-lucide="calendar"></i> ${formatDate(session.importedAt)}</span>
        <span><i data-lucide="message-square"></i> ${session.messageCount} сообщений</span>
        <span class="embedding-badge ${escapeHtml(session.embeddingStatus)}">${escapeHtml(statusLabel)}</span>
      </div>
      ${session.tags && session.tags.length > 0 ? `
        <div class="session-tags">
          ${session.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `}).join('');

  lucide.createIcons();
}

function renderSessionsLoadMore(result) {
  const existing = document.getElementById('sessions-load-more-btn');
  if (existing) existing.remove();

  if (result.hasMore) {
    const btn = document.createElement('button');
    btn.id = 'sessions-load-more-btn';
    btn.className = 'btn btn-secondary load-more';
    btn.innerHTML = '<i data-lucide="chevrons-down"></i> Загрузить ещё';
    btn.addEventListener('click', () => {
      currentSessionOffset += SESSIONS_LIMIT;
      loadSessions(true);
    });
    document.getElementById('sessions-container').after(btn);
    lucide.createIcons();
  }
}

// Event delegation for session cards
document.getElementById('sessions-container').addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('[data-action="deleteSession"]');
  if (deleteBtn) {
    e.stopPropagation();
    deleteSession(deleteBtn.dataset.id);
    return;
  }
  const card = e.target.closest('.session-card');
  if (card) {
    openSessionDetail(card.dataset.sessionId);
  }
});

async function openSessionDetail(sessionId) {
  currentSessionId = sessionId;
  sessionMessageFrom = 0;
  sessionMessages = [];

  document.getElementById('sessions-container').style.display = 'none';
  const existingLoadMore = document.getElementById('sessions-load-more-btn');
  if (existingLoadMore) existingLoadMore.style.display = 'none';
  document.getElementById('session-detail-container').style.display = '';

  const messagesEl = document.getElementById('session-messages');
  messagesEl.innerHTML = `
    <div class="loading">
      <i data-lucide="loader-2" class="spin"></i>
      <span>Загрузка сообщений...</span>
    </div>
  `;
  lucide.createIcons();

  try {
    const params = new URLSearchParams({ from: '0', to: String(SESSION_MESSAGES_PAGE - 1) });
    const response = await authFetch(`${API_BASE}/sessions/${sessionId}?${params}`);
    const result = await response.json();

    if (!result.success) {
      messagesEl.innerHTML = `<div class="empty-state"><i data-lucide="alert-triangle"></i><div class="empty-state-text">Ошибка загрузки</div></div>`;
      lucide.createIcons();
      return;
    }

    const session = result.session;
    sessionMessages = result.messages;
    sessionMessageFrom = result.messages.length;

    // Fill header
    document.getElementById('session-detail-title').textContent = session.name || ('Сессия от ' + formatDate(session.importedAt));
    document.getElementById('session-detail-summary').textContent = session.summary || '';
    document.getElementById('session-detail-meta').innerHTML = `
      <span><i data-lucide="calendar"></i> ${formatDate(session.importedAt)}</span>
      <span><i data-lucide="message-square"></i> ${session.messageCount} сообщений</span>
      <span class="embedding-badge ${escapeHtml(session.embeddingStatus)}">${session.embeddingStatus}</span>
    `;
    document.getElementById('session-detail-tags').innerHTML =
      (session.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');

    renderSessionMessages(result.total_messages);
    lucide.createIcons();
  } catch (error) {
    messagesEl.innerHTML = `<div class="empty-state"><i data-lucide="alert-triangle"></i><div class="empty-state-text">Ошибка загрузки</div></div>`;
    lucide.createIcons();
    console.error(error);
  }
}

function renderSessionMessages(totalMessages) {
  const container = document.getElementById('session-messages');

  if (sessionMessages.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="message-square"></i>
        <div class="empty-state-text">Нет сообщений</div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  let html = '';

  html += sessionMessages.map(msg => `
    <div class="message message-${escapeHtml(msg.role)}" data-message-id="${escapeHtml(msg.id)}">
      <div class="message-role">${escapeHtml(msg.role)}</div>
      <div class="message-content">${escapeHtml(msg.content)}</div>
      ${msg.timestamp ? `<div class="message-timestamp">${formatDate(msg.timestamp)}</div>` : ''}
    </div>
  `).join('');

  // Load more button at bottom if there are more messages
  if (sessionMessageFrom < totalMessages) {
    html += `<button class="btn btn-secondary session-load-more" id="session-messages-load-more">
      <i data-lucide="chevrons-down"></i> Загрузить ещё (${sessionMessageFrom} из ${totalMessages})
    </button>`;
  }

  container.innerHTML = html;
  lucide.createIcons();

  // Bind load more
  const loadMoreBtn = document.getElementById('session-messages-load-more');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', loadMoreSessionMessages);
  }
}

async function loadMoreSessionMessages() {
  if (!currentSessionId) return;
  const to = sessionMessageFrom + SESSION_MESSAGES_PAGE - 1;
  try {
    const params = new URLSearchParams({ from: String(sessionMessageFrom), to: String(to) });
    const response = await authFetch(`${API_BASE}/sessions/${currentSessionId}?${params}`);
    const result = await response.json();
    if (result.success && result.messages.length > 0) {
      sessionMessages = sessionMessages.concat(result.messages);
      sessionMessageFrom += result.messages.length;
      renderSessionMessages(result.total_messages);
    }
  } catch (e) {
    showToast('Ошибка загрузки сообщений', 'error');
  }
}

// Back button
document.getElementById('session-back-btn').addEventListener('click', () => {
  document.getElementById('session-detail-container').style.display = 'none';
  document.getElementById('sessions-container').style.display = '';
  const existingLoadMore = document.getElementById('sessions-load-more-btn');
  if (existingLoadMore) existingLoadMore.style.display = '';
  currentSessionId = null;
  document.getElementById('session-message-search').value = '';
});

// Delete session
async function deleteSession(id) {
  if (!await showConfirmModal({
    title: 'Удалить сессию',
    message: 'Удалить сессию навсегда?',
    confirmText: 'Удалить',
    danger: true,
  })) return;

  try {
    const response = await authFetch(`${API_BASE}/sessions/${id}`, {
      method: 'DELETE'
    });

    const result = await response.json();

    if (result.success) {
      showToast('Сессия удалена', 'success');
      // If in detail view, go back to list
      if (currentSessionId === id) {
        document.getElementById('session-detail-container').style.display = 'none';
        document.getElementById('sessions-container').style.display = '';
        currentSessionId = null;
        document.getElementById('session-message-search').value = '';
      }
      currentSessionOffset = 0;
      loadSessions();
    } else {
      showToast(result.error || 'Ошибка удаления', 'error');
    }
  } catch (error) {
    showToast('Ошибка удаления сессии', 'error');
  }
}

// Delete button in detail view
document.getElementById('session-delete-detail-btn').addEventListener('click', () => {
  if (currentSessionId) deleteSession(currentSessionId);
});

// Message search within session
document.getElementById('session-message-search').addEventListener('input', (e) => {
  clearTimeout(sessionSearchDebounce);
  const query = e.target.value.trim();
  sessionSearchDebounce = setTimeout(async () => {
    if (!currentSessionId) return;
    if (!query) {
      // Reset to full messages
      openSessionDetail(currentSessionId);
      return;
    }
    try {
      const params = new URLSearchParams({ q: query, limit: '50' });
      const response = await authFetch(`${API_BASE}/sessions/${currentSessionId}/search?${params}`);
      const result = await response.json();
      if (result.success) {
        const container = document.getElementById('session-messages');
        container.innerHTML = result.messages.length === 0
          ? `<div class="empty-state"><i data-lucide="search"></i><div class="empty-state-text">Ничего не найдено</div></div>`
          : result.messages.map(msg => `
              <div class="message message-${escapeHtml(msg.role)} message-highlight" data-message-id="${escapeHtml(msg.id)}">
                <div class="message-role">${escapeHtml(msg.role)}</div>
                <div class="message-content">${escapeHtml(msg.content)}</div>
                ${msg.timestamp ? `<div class="message-timestamp">${formatDate(msg.timestamp)}</div>` : ''}
              </div>
            `).join('');
        lucide.createIcons();
      }
    } catch (e) {
      showToast('Ошибка поиска', 'error');
    }
  }, 300);
});

// ===== Notes UI =====

async function loadNotes(append = false) {
  const container = document.getElementById('notes-container');

  // Readonly: show demo placeholder instead of private data
  if (isReadOnly) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="sticky-note"></i>
        <div class="empty-state-text">Здесь могут находиться ваши личные заметки</div>
        <div class="empty-state-hint" style="color:var(--text-muted);font-size:13px;margin-top:8px">
          Войдите в систему, чтобы создавать и просматривать заметки
        </div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  if (!append) {
    currentNoteOffset = 0;
    container.innerHTML = `
      <div class="loading">
        <i data-lucide="loader-2" class="spin"></i>
        <span>Загрузка...</span>
      </div>
    `;
    lucide.createIcons();
  }

  try {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    if (currentSearch) params.append('search', currentSearch);
    params.append('limit', String(NOTES_LIMIT));
    params.append('offset', String(currentNoteOffset));

    const response = await authFetch(`${API_BASE}/notes?${params}`);
    const result = await response.json();

    if (result.success) {
      if (append) {
        notesData = notesData.concat(result.notes);
      } else {
        notesData = result.notes;
      }
      renderNotes();
      renderNotesLoadMore(result);
    }
  } catch (error) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="alert-triangle"></i>
        <div class="empty-state-text">Ошибка загрузки заметок</div>
      </div>
    `;
    lucide.createIcons();
    console.error(error);
  }
}

function renderNotes() {
  const container = document.getElementById('notes-container');

  if (notesData.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="sticky-note"></i>
        <div class="empty-state-text">Нет заметок${currentSearch ? ' по запросу "' + escapeHtml(currentSearch) + '"' : ''}</div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = notesData.map(note => `
    <div class="note-card" data-note-id="${escapeHtml(note.id)}">
      <div class="note-title">${escapeHtml(note.title)}</div>
      <div class="note-content-preview">${escapeHtml(note.content)}</div>
      <div class="note-meta">
        <span><i data-lucide="calendar"></i> ${formatDate(note.createdAt)}</span>
        ${note.updatedAt !== note.createdAt ? `<span><i data-lucide="edit"></i> ${formatDate(note.updatedAt)}</span>` : ''}
      </div>
      <div class="note-footer">
        <div class="note-tags">
          ${(note.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
        ${isReadOnly ? '' : `<div class="note-actions">
          ${note.sharedToEntryId
            ? `<button data-action="viewSharedEntry" data-entry-id="${escapeHtml(note.sharedToEntryId)}" title="Уже расшарена — открыть запись">
                 <i data-lucide="link"></i>
               </button>`
            : `<button data-action="shareNote" data-note-id="${escapeHtml(note.id)}" title="Расшарить как запись командной памяти">
                 <i data-lucide="share-2"></i>
               </button>`}
          <button data-action="editNote" data-note-id="${escapeHtml(note.id)}" title="Редактировать">
            <i data-lucide="pencil"></i>
          </button>
          <button data-action="deleteNote" data-note-id="${escapeHtml(note.id)}" title="Удалить">
            <i data-lucide="trash-2"></i>
          </button>
        </div>`}
      </div>
    </div>
  `).join('');

  lucide.createIcons();
}

function renderNotesLoadMore(result) {
  const existing = document.getElementById('notes-load-more-btn');
  if (existing) existing.remove();

  if (result.hasMore) {
    const btn = document.createElement('button');
    btn.id = 'notes-load-more-btn';
    btn.className = 'btn btn-secondary load-more';
    btn.innerHTML = '<i data-lucide="chevrons-down"></i> Загрузить ещё';
    btn.addEventListener('click', () => {
      currentNoteOffset += NOTES_LIMIT;
      loadNotes(true);
    });
    document.getElementById('notes-container').after(btn);
    lucide.createIcons();
  }
}

// Event delegation for notes
document.getElementById('notes-container').addEventListener('click', (e) => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const noteId = actionBtn.dataset.noteId;
    const action = actionBtn.dataset.action;
    if (action === 'editNote') openNoteModal(noteId);
    else if (action === 'deleteNote') deleteNote(noteId);
    else if (action === 'shareNote') openShareNoteModal(noteId);
    else if (action === 'viewSharedEntry') {
      const entryId = actionBtn.dataset.entryId;
      if (entryId) location.hash = '#memory/' + encodeURIComponent(entryId);
    }
    return;
  }
  const card = e.target.closest('.note-card');
  if (card) {
    openNoteReadModal(card.dataset.noteId);
  }
});

/* ========== v4.5 Share Note → team-memory entry ========== */

async function openShareNoteModal(noteId) {
  const note = notesData.find(n => n.id === noteId);
  if (!note) return;
  if (note.sharedToEntryId) {
    await showAlertModal({
      title: 'Заметка уже расшарена',
      message: 'Открой связанную запись через иконку ссылки.',
    });
    return;
  }

  // Build the modal lazily — keeps the index.html footprint small.
  let modal = document.getElementById('share-note-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'share-note-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 560px;">
        <div class="modal-header">
          <h2>Расшарить заметку как запись</h2>
          <button class="modal-close" data-action="closeShareModal" aria-label="Закрыть">×</button>
        </div>
        <div class="modal-body">
          <p style="margin-top: 0; color: var(--text-secondary);">
            Заметка станет видимой записью командной памяти. Запись будет
            закреплена (pinned) и не подвергнется автоматическому удалению.
          </p>
          <div class="form-group">
            <label for="share-note-title">Заголовок</label>
            <input id="share-note-title" type="text" maxlength="500" />
          </div>
          <div class="form-group">
            <label>Категория</label>
            <!--
              v5: NotesManager.share accepts these legacy values and translates
              them into category='knowledge' + the kind tag (architecture /
              decision / convention). Kept here as the UX surface because the
              author still picks WHAT kind of fact they're sharing — the
              translation is internal.
            -->
            <input type="hidden" id="share-note-category" value="decisions">
            <div class="custom-select" id="share-note-category-select">
              <button class="custom-select-trigger" type="button">
                <span class="custom-select-value">decisions — почему мы выбрали X</span>
                <i data-lucide="chevron-down" class="custom-select-arrow"></i>
              </button>
              <div class="custom-select-options">
                <div class="custom-select-option selected" data-value="decisions"><span class="custom-select-option-name">decisions — почему мы выбрали X</span></div>
                <div class="custom-select-option" data-value="architecture"><span class="custom-select-option-name">architecture — структура / контракты</span></div>
                <div class="custom-select-option" data-value="conventions"><span class="custom-select-option-name">conventions — правила и стандарты</span></div>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label for="share-note-content">Содержимое</label>
            <textarea id="share-note-content" rows="6"></textarea>
          </div>
          <div class="form-group">
            <label>При найденном дубликате</label>
            <input type="hidden" id="share-note-on-match" value="prompt">
            <div class="custom-select" id="share-note-on-match-select">
              <button class="custom-select-trigger" type="button">
                <span class="custom-select-value">Спросить (показать совпадение)</span>
                <i data-lucide="chevron-down" class="custom-select-arrow"></i>
              </button>
              <div class="custom-select-options">
                <div class="custom-select-option selected" data-value="prompt"><span class="custom-select-option-name">Спросить (показать совпадение)</span></div>
                <div class="custom-select-option" data-value="confirm_existing"><span class="custom-select-option-name">Подтвердить существующую</span></div>
                <div class="custom-select-option" data-value="merge"><span class="custom-select-option-name">Объединить</span></div>
                <div class="custom-select-option" data-value="create_new"><span class="custom-select-option-name">Создать новую (игнорировать)</span></div>
              </div>
            </div>
          </div>
          <div id="share-note-status" style="margin-top: 12px;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" data-action="closeShareModal">Отмена</button>
          <button class="btn-primary" id="share-note-submit">Расшарить</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Wire up the themed custom-selects (replaces the native <select>s that
    // ignored project theme and were jarring next to the rest of the modal).
    initFormSelect('share-note-category-select', 'share-note-category');
    initFormSelect('share-note-on-match-select', 'share-note-on-match');
    if (window.lucide) window.lucide.createIcons();

    modal.addEventListener('click', e => {
      if (e.target === modal) closeShareNoteModal();
      if (e.target.dataset?.action === 'closeShareModal') closeShareNoteModal();
    });
    modal.querySelector('#share-note-submit').addEventListener('click', submitShareNote);
  }

  modal.dataset.noteId = note.id;
  modal.querySelector('#share-note-title').value = note.title;
  modal.querySelector('#share-note-content').value = note.content;
  setFormSelectValue('share-note-category-select', 'share-note-category', 'decisions');
  setFormSelectValue('share-note-on-match-select', 'share-note-on-match', 'prompt');
  modal.querySelector('#share-note-status').innerHTML = '';
  modal.querySelector('#share-note-submit').disabled = false;
  modal.style.display = 'flex';
  _shareModalA11yDetach = window.attachModalA11y(modal, {
    onClose: closeShareNoteModal,
    initialFocusSelector: '#share-note-title',
  });
}

let _shareModalA11yDetach = null;

function closeShareNoteModal() {
  if (_shareModalA11yDetach) { _shareModalA11yDetach(); _shareModalA11yDetach = null; }
  const modal = document.getElementById('share-note-modal');
  if (modal) modal.style.display = 'none';
}

async function submitShareNote() {
  const modal = document.getElementById('share-note-modal');
  const noteId = modal.dataset.noteId;
  const submit = modal.querySelector('#share-note-submit');
  const status = modal.querySelector('#share-note-status');
  const title = modal.querySelector('#share-note-title').value.trim();
  const content = modal.querySelector('#share-note-content').value.trim();
  const category = modal.querySelector('#share-note-category').value;
  const onMatch = modal.querySelector('#share-note-on-match').value;

  if (!title || !content) {
    status.textContent = '❌ Заполни заголовок и содержимое.';
    status.style.color = 'var(--error, #c0392b)';
    return;
  }

  submit.disabled = true;
  status.textContent = '⏳ Отправляем…';
  status.style.color = 'var(--text-secondary)';

  try {
    const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        category,
        on_match: onMatch,
        override: { title, content },
      }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.success) {
      status.textContent = '❌ ' + (data.error ?? `HTTP ${response.status}`);
      status.style.color = 'var(--error, #c0392b)';
      submit.disabled = false;
      return;
    }

    if (data.action === 'match_found_pending_user_decision' && data.existingEntry) {
      const score = (data.matchScore ?? 0).toFixed(2);
      const proceed = await showConfirmModal({
        title: 'Найдена похожая запись',
        message:
          `cosine ${score}\n\n` +
          `${data.existingEntry.title}\n\n` +
          `Подтвердить связь с существующей записью?`,
        confirmText: 'Подтвердить связь',
      });
      if (proceed) {
        setFormSelectValue('share-note-on-match-select', 'share-note-on-match', 'confirm_existing');
        await submitShareNote();
        return;
      }
      submit.disabled = false;
      status.textContent = 'ℹ️ Отменено. Можешь выбрать "Создать новую" если совпадение ложное.';
      status.style.color = 'var(--text-secondary)';
      return;
    }

    status.innerHTML =
      `✅ ${data.action} — entry <code>${data.entryId ?? ''}</code>`;
    status.style.color = 'var(--success, #2ecc71)';

    // Refresh notes list so the share-icon flips to a link-icon.
    if (typeof loadNotes === 'function') await loadNotes();

    setTimeout(closeShareNoteModal, 1200);
  } catch (err) {
    status.textContent = '❌ Сеть: ' + (err?.message ?? String(err));
    status.style.color = 'var(--error, #c0392b)';
    submit.disabled = false;
  }
}

function openNoteReadModal(noteId) {
  const note = notesData.find(n => n.id === noteId);
  if (!note) return;

  document.getElementById('note-read-title').textContent = note.title;
  document.getElementById('note-read-meta').innerHTML = `
    <span>Создано: ${formatDate(note.createdAt)}</span>
    ${note.updatedAt !== note.createdAt ? ` · <span>Обновлено: ${formatDate(note.updatedAt)}</span>` : ''}
  `;
  document.getElementById('note-read-body').textContent = note.content;
  document.getElementById('note-read-body').style.whiteSpace = 'pre-wrap';
  document.getElementById('note-read-tags').innerHTML =
    (note.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const modal = document.getElementById('note-read-modal');
  modal.classList.add('active');
  modal.dataset.noteId = noteId;

  let detach = null;
  const close = () => {
    if (detach) { detach(); detach = null; }
    modal.classList.remove('active');
  };

  document.getElementById('note-read-close').onclick = close;
  const noteEditBtn = document.getElementById('note-read-edit');
  if (isReadOnly) {
    noteEditBtn.style.display = 'none';
  } else {
    noteEditBtn.style.display = '';
    noteEditBtn.onclick = () => {
      close();
      openNoteModal(noteId);
    };
  }
  modal.onclick = (e) => { if (e.target === modal) close(); };
  detach = window.attachModalA11y(modal, {
    onClose: close,
    initialFocusSelector: '#note-read-close',
  });
  lucide.createIcons();
}

let _noteModalA11yDetach = null;

function openNoteModal(noteId = null) {
  const modal = document.getElementById('note-modal');
  const title = document.getElementById('note-modal-title');
  const form = document.getElementById('note-form');

  if (noteId) {
    const note = notesData.find(n => n.id === noteId);
    if (!note) return;
    title.textContent = 'Редактировать заметку';
    document.getElementById('note-id').value = note.id;
    document.getElementById('note-title-input').value = note.title;
    document.getElementById('note-content-input').value = note.content;
    document.getElementById('note-tags-input').value = (note.tags || []).join(', ');
    const sessionSelect = document.getElementById('note-session-select');
    if (note.sessionId) sessionSelect.value = note.sessionId;
  } else {
    title.textContent = 'Создать заметку';
    form.reset();
    document.getElementById('note-id').value = '';
  }

  populateNoteSessionSelect();
  modal.classList.add('active');
  _noteModalA11yDetach = window.attachModalA11y(modal, {
    onClose: closeNoteModal,
    initialFocusSelector: '#note-title-input',
  });
}

async function populateNoteSessionSelect() {
  const select = document.getElementById('note-session-select');
  const currentVal = select.value;
  try {
    const params = new URLSearchParams({ limit: '100' });
    if (currentProjectId) params.append('project_id', currentProjectId);
    const response = await authFetch(`${API_BASE}/sessions?${params}`);
    const result = await response.json();
    if (result.success) {
      select.innerHTML = '<option value="">Без привязки</option>' +
        result.sessions.map(s => {
          const name = s.name || ('Сессия от ' + formatDate(s.importedAt));
          return `<option value="${escapeHtml(s.id)}">${escapeHtml(name)}</option>`;
        }).join('');
      if (currentVal) select.value = currentVal;
    }
  } catch (e) {
    // Keep default option
  }
}

function closeNoteModal() {
  if (_noteModalA11yDetach) { _noteModalA11yDetach(); _noteModalA11yDetach = null; }
  document.getElementById('note-modal').classList.remove('active');
}

document.getElementById('note-modal-close').addEventListener('click', closeNoteModal);
document.getElementById('note-btn-cancel').addEventListener('click', closeNoteModal);
document.getElementById('note-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('note-modal')) closeNoteModal();
});

document.getElementById('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const noteId = document.getElementById('note-id').value;
  const title = document.getElementById('note-title-input').value.trim();
  const content = document.getElementById('note-content-input').value.trim();
  const tags = document.getElementById('note-tags-input').value;
  const sessionId = document.getElementById('note-session-select').value || null;

  if (!title || !content) {
    showToast('Заголовок и содержание обязательны', 'error');
    return;
  }

  try {
    if (noteId) {
      const updateBody = { title, content, tags };
      if (sessionId !== null) updateBody.session_id = sessionId;
      const response = await authFetch(`${API_BASE}/notes/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      });
      const result = await response.json();
      if (result.success) {
        showToast('Заметка обновлена', 'success');
        closeNoteModal();
        // Optimistic replace in notesData; reconcile via loadNotes after.
        if (result.note && Array.isArray(notesData)) {
          const idx = notesData.findIndex(n => n.id === result.note.id);
          if (idx !== -1) notesData[idx] = result.note;
          renderNotes();
        }
        await loadNotes();
      } else {
        showToast(result.error || 'Ошибка обновления', 'error');
      }
    } else {
      const body = { title, content, tags };
      if (sessionId) body.session_id = sessionId;
      if (currentProjectId) body.project_id = currentProjectId;

      const response = await authFetch(`${API_BASE}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (result.success) {
        showToast('Заметка создана', 'success');
        closeNoteModal();
        // Optimistic insert — note returned by API already has id/timestamps;
        // user sees it instantly without waiting for the GET round-trip.
        // The await below reconciles in case server-side rules changed the
        // order or other fields.
        if (result.note && Array.isArray(notesData)) {
          notesData.unshift(result.note);
          renderNotes();
          if (typeof updateSessionNotesCounts === 'function') updateSessionNotesCounts();
        }
        await loadNotes();
      } else {
        showToast(result.error || 'Ошибка создания', 'error');
      }
    }
  } catch (err) {
    showToast('Ошибка сохранения заметки', 'error');
    console.error(err);
  }
});

async function deleteNote(noteId) {
  if (!await showConfirmModal({
    title: 'Удалить заметку',
    message: 'Удалить заметку?',
    confirmText: 'Удалить',
    danger: true,
  })) return;
  try {
    const response = await authFetch(`${API_BASE}/notes/${noteId}`, { method: 'DELETE' });
    const result = await response.json();
    if (result.success) {
      showToast('Заметка удалена', 'success');
      notesData = notesData.filter(n => n.id !== noteId);
      renderNotes();
      if (typeof updateSessionNotesCounts === 'function') updateSessionNotesCounts();
    } else {
      showToast(result.error || 'Ошибка удаления', 'error');
    }
  } catch (err) {
    showToast('Ошибка удаления', 'error');
  }
}

// ===== Sidebar Badge Counts =====

async function updateHeaderStatsForSessions() {
  try {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    const res = await authFetch(`${API_BASE}/sessions/count?${params}`);
    const result = await res.json();
    if (result.success) {
      document.getElementById('stat-total').textContent = result.count;

      // Update vectorized indicator for sessions
      if (result.embeddingCounts) {
        const ec = result.embeddingCounts;
        const total = Object.values(ec).reduce((a, b) => a + b, 0);
        const complete = ec.complete || 0;
        const dot = document.getElementById('embedding-dot');
        const countEl = document.getElementById('embedding-count');
        const indicator = document.getElementById('embedding-indicator');
        if (dot && countEl && indicator) {
          countEl.textContent = `${complete}/${total}`;
          if (complete >= total && total > 0) {
            dot.className = 'embedding-dot active';
            indicator.setAttribute('data-tooltip', 'Все сессии проиндексированы');
          } else if (complete > 0) {
            dot.className = 'embedding-dot partial';
            const pct = total > 0 ? Math.round(complete / total * 100) : 0;
            indicator.setAttribute('data-tooltip', `${pct}% сессий проиндексировано`);
          }
        }
      }
    }

    // 24h count
    const params24h = new URLSearchParams();
    if (currentProjectId) params24h.append('project_id', currentProjectId);
    params24h.append('date_from', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const res24h = await authFetch(`${API_BASE}/sessions/count?${params24h}`);
    const result24h = await res24h.json();
    if (result24h.success) {
      document.getElementById('stat-24h').textContent = result24h.count;
    }
  } catch (e) { /* ignore */ }
}

async function updateHeaderStatsForNotes() {
  try {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    const res = await authFetch(`${API_BASE}/notes/count?${params}`);
    const result = await res.json();
    if (result.success) {
      document.getElementById('stat-total').textContent = result.count;
      document.getElementById('stat-24h').textContent = result.count; // all notes are "recent" for now
    }
  } catch (e) { /* ignore */ }
}

async function updateSessionNotesCounts() {
  if (isReadOnly) return; // Private data — skip API calls in viewer mode
  try {
    const sessParams = new URLSearchParams();
    if (currentProjectId) sessParams.append('project_id', currentProjectId);
    const sessRes = await authFetch(`${API_BASE}/sessions/count?${sessParams}`);
    const sessResult = await sessRes.json();
    if (sessResult.success) {
      document.getElementById('count-sessions').textContent = sessResult.count;
    }

    const notesParams = new URLSearchParams();
    if (currentProjectId) notesParams.append('project_id', currentProjectId);
    const notesRes = await authFetch(`${API_BASE}/notes/count?${notesParams}`);
    const notesResult = await notesRes.json();
    if (notesResult.success) {
      document.getElementById('count-notes').textContent = notesResult.count;
    }
  } catch (e) {
    // Silently fail
  }
}

// ===== Events UI (v5) =====
// Project events live in their own `project_events` table (separate from
// `entries`), so they need their own fetch + render path. Read-only here —
// creating new events goes through MCP `event_add` or REST POST.

const EVENT_TYPE_LABELS = {
  merge: { icon: 'git-merge', title: 'Merge' },
  release: { icon: 'rocket', title: 'Release' },
  deploy: { icon: 'package', title: 'Deploy' },
  incident: { icon: 'alert-triangle', title: 'Incident' },
  milestone: { icon: 'flag', title: 'Milestone' },
};

// ===== Profile (v5 — one curated active entry per project) =====

async function loadProfile() {
  const container = document.getElementById('profile-container');
  if (!container) return;
  if (!currentProjectId) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="map"></i>
        <h3>Выбери проект</h3>
        <p>Профиль привязан к конкретному проекту. Выбери его в селекторе слева.</p>
      </div>`;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  container.innerHTML = `<div class="loading"><i data-lucide="loader-2" class="spin"></i><span>Загрузка...</span></div>`;
  if (window.lucide) window.lucide.createIcons();

  try {
    const response = await authFetch(`${API_BASE}/projects/${currentProjectId}/profile`);
    if (response.status === 404) {
      renderEmptyProfile(container);
      return;
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      container.innerHTML = `<div class="empty-state"><i data-lucide="alert-triangle"></i><h3>Ошибка</h3><p>${escapeHtml(err.error || `HTTP ${response.status}`)}</p></div>`;
      if (window.lucide) window.lucide.createIcons();
      return;
    }
    const data = await response.json();
    renderProfileCard(container, data.profile);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><i data-lucide="wifi-off"></i><h3>Ошибка сети</h3><p>${escapeHtml(err.message || 'Не удалось загрузить профиль')}</p></div>`;
    if (window.lucide) window.lucide.createIcons();
  }
}

function renderEmptyProfile(container) {
  if (isReadOnly) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="map"></i>
        <h3>Профиль не задан</h3>
        <p>Администратор ещё не создал профиль этого проекта.</p>
      </div>`;
  } else {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="map"></i>
        <h3>Профиль не задан</h3>
        <p>Эталонная карточка проекта для онбординга агентов: миссия, стек, repo-map, конвенции, guard-rails.</p>
        <button class="btn btn-primary" id="profile-create-btn">Создать профиль</button>
      </div>`;
    if (window.lucide) window.lucide.createIcons();
    document.getElementById('profile-create-btn')?.addEventListener('click', () => openProfileEdit(null));
  }
  if (window.lucide) window.lucide.createIcons();
}

function renderProfileCard(container, profile) {
  const updated = profile.updatedAt ? new Date(profile.updatedAt).toLocaleString() : '';
  const tagsHtml = (profile.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(' ');
  const renderedBody = (typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined')
    ? window.DOMPurify.sanitize(window.marked.parse(profile.content || ''))
    : `<pre>${escapeHtml(profile.content || '')}</pre>`;

  container.innerHTML = `
    <article class="profile-card">
      <header class="profile-card-header">
        <div class="profile-card-title">
          <i data-lucide="map"></i>
          <h2>${escapeHtml(profile.title || 'Project Profile')}</h2>
        </div>
        <div class="profile-card-actions">
          ${!isReadOnly ? `<button class="btn btn-secondary" id="profile-edit-btn"><i data-lucide="edit"></i> Редактировать</button>` : ''}
        </div>
      </header>
      <div class="profile-card-meta">
        <span class="profile-card-updated">Обновлено: ${escapeHtml(updated)}</span>
        ${tagsHtml ? `<span class="profile-card-tags">${tagsHtml}</span>` : ''}
      </div>
      <div class="profile-card-body markdown-body">${renderedBody}</div>
    </article>`;
  if (window.lucide) window.lucide.createIcons();
  document.getElementById('profile-edit-btn')?.addEventListener('click', () => openProfileEdit(profile));
}

function openProfileEdit(currentProfile) {
  const container = document.getElementById('profile-container');
  const content = currentProfile?.content ?? '';
  const tags = (currentProfile?.tags ?? []).join(', ');
  container.innerHTML = `
    <article class="profile-card profile-card--editing">
      <header class="profile-card-header">
        <div class="profile-card-title">
          <i data-lucide="edit"></i>
          <h2>${currentProfile ? 'Редактирование профиля' : 'Создание профиля'}</h2>
        </div>
      </header>
      <form id="profile-edit-form">
        <div class="form-group">
          <label for="profile-content-input">Содержимое (markdown, до 64 KB)</label>
          <textarea id="profile-content-input" rows="18" required>${escapeHtml(content)}</textarea>
        </div>
        <div class="form-group">
          <label for="profile-tags-input">Теги (через запятую)</label>
          <input type="text" id="profile-tags-input" value="${escapeHtml(tags)}" placeholder="mission, stack, repo-map">
        </div>
        <div id="profile-edit-status" class="form-status"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="profile-cancel-btn">Отмена</button>
          <button type="submit" class="btn btn-primary" id="profile-save-btn">Сохранить</button>
        </div>
      </form>
    </article>`;
  if (window.lucide) window.lucide.createIcons();

  document.getElementById('profile-cancel-btn').addEventListener('click', () => loadProfile());

  document.getElementById('profile-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newContent = document.getElementById('profile-content-input').value;
    const tagsRaw = document.getElementById('profile-tags-input').value;
    const newTags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const status = document.getElementById('profile-edit-status');
    const saveBtn = document.getElementById('profile-save-btn');
    saveBtn.disabled = true;
    status.textContent = '';

    try {
      const response = await authFetch(`${API_BASE}/projects/${currentProjectId}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent, tags: newTags }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        status.textContent = '⚠️ Профиль изменён параллельно — обновите страницу и повторите.';
        status.style.color = 'var(--error, #c0392b)';
        saveBtn.disabled = false;
        return;
      }
      if (!response.ok || !data.success) {
        status.textContent = '❌ ' + (data.error || `HTTP ${response.status}`);
        status.style.color = 'var(--error, #c0392b)';
        saveBtn.disabled = false;
        return;
      }
      showToast('Профиль сохранён', 'success');
      await loadProfile();
    } catch (err) {
      status.textContent = '❌ Ошибка сети: ' + escapeHtml(err.message || '');
      status.style.color = 'var(--error, #c0392b)';
      saveBtn.disabled = false;
    }
  });
}

async function loadEvents() {
  const container = document.getElementById('events-container');
  if (!currentProjectId) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="activity"></i>
        <div class="empty-state-text">Выберите проект для просмотра событий</div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = `
    <div class="loading">
      <i data-lucide="loader-2" class="spin"></i>
      <span>Загрузка событий...</span>
    </div>
  `;
  lucide.createIcons();

  try {
    const params = new URLSearchParams();
    params.append('limit', '50');
    const response = await authFetch(`${API_BASE}/projects/${currentProjectId}/events?${params}`);
    const result = await response.json();

    if (!result.success) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-text">${result.error || 'Не удалось загрузить события'}</div></div>`;
      return;
    }

    if (!result.events || result.events.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i data-lucide="activity"></i>
          <div class="empty-state-text">Событий пока нет</div>
          <div class="empty-state-hint" style="color:var(--text-muted);font-size:13px;margin-top:8px">
            События (merge / release / deploy / incident / milestone) добавляются автоматически из сессий
            или вручную через <code>event_add</code> MCP / REST.
          </div>
        </div>
      `;
      lucide.createIcons();
      return;
    }

    container.innerHTML = renderEventsTimeline(result.events);
    lucide.createIcons();
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-text">Ошибка загрузки событий</div></div>`;
    console.error('loadEvents failed', e);
  }
}

function renderEventsTimeline(events) {
  const items = events.map(ev => {
    const meta = EVENT_TYPE_LABELS[ev.eventType] || { icon: 'circle', title: ev.eventType };
    const date = ev.occurredAt ? new Date(ev.occurredAt).toLocaleString() : '';
    const refsHtml = renderEventRefs(ev.refs);
    const actor = ev.actor ? `<span class="event-actor">— ${escapeHtml(ev.actor)}</span>` : '';
    const autoTag = ev.autoGenerated
      ? '<span class="event-auto-tag" title="Извлечено из сессии автоматически">auto</span>'
      : '';
    const desc = ev.description
      ? `<div class="event-description">${escapeHtml(ev.description)}</div>`
      : '';
    return `
      <div class="event-card event-card--${escapeHtml(ev.eventType)}">
        <div class="event-icon"><i data-lucide="${meta.icon}"></i></div>
        <div class="event-body">
          <div class="event-header">
            <span class="event-type">${escapeHtml(meta.title)}</span>
            <span class="event-date">${escapeHtml(date)}</span>
            ${autoTag}
          </div>
          <div class="event-title">${escapeHtml(ev.title)} ${actor}</div>
          ${desc}
          ${refsHtml}
        </div>
      </div>
    `;
  }).join('');
  return `<div class="events-timeline">${items}</div>`;
}

function renderEventRefs(refs) {
  if (!refs || typeof refs !== 'object' || Object.keys(refs).length === 0) return '';
  const parts = Object.entries(refs).map(([k, v]) => {
    const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `<span class="event-ref"><strong>${escapeHtml(k)}</strong>: ${escapeHtml(value)}</span>`;
  });
  return `<div class="event-refs">${parts.join(' · ')}</div>`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function updateEventsCount() {
  if (!currentProjectId) {
    const el = document.getElementById('count-events');
    if (el) el.textContent = '0';
    return;
  }
  try {
    // No dedicated /events/count endpoint — fetch last 200 and use the length.
    // For projects with > 200 events the badge shows "200+" instead.
    const res = await authFetch(`${API_BASE}/projects/${currentProjectId}/events?limit=200`);
    const result = await res.json();
    if (result.success) {
      const n = result.count ?? (result.events?.length || 0);
      const el = document.getElementById('count-events');
      if (el) el.textContent = n >= 200 ? '200+' : String(n);
    }
  } catch (e) {
    // Silently fail
  }
}
