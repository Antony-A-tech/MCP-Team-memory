// Team Memory Dashboard - JavaScript

const API_BASE = '/api';
const WS_PORT = 3847;

// State
let currentCategory = 'all';
let currentSearch = '';
let currentStatus = '';
let entries = [];
let ws = null;

// DOM Elements
const entriesContainer = document.getElementById('entries-container');
const searchInput = document.getElementById('search-input');
const statusFilter = document.getElementById('status-filter');
const pageTitle = document.getElementById('page-title');
const modal = document.getElementById('entry-modal');
const entryForm = document.getElementById('entry-form');
const toastContainer = document.getElementById('toast-container');

// Category config
const categoryConfig = {
  all: { title: 'Все записи', icon: 'layout-grid' },
  pinned: { title: 'Закреплённые', icon: 'pin' },
  architecture: { title: 'Архитектура', icon: 'building-2' },
  tasks: { title: 'Задачи', icon: 'clipboard-list' },
  decisions: { title: 'Решения', icon: 'check-circle-2' },
  issues: { title: 'Проблемы', icon: 'bug' },
  progress: { title: 'Прогресс', icon: 'trending-up' }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  initNavigation();
  initSearch();
  initModal();
  initWebSocket();
  loadEntries();
  loadStats();
});

// Navigation
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      currentCategory = item.dataset.category;
      pageTitle.textContent = categoryConfig[currentCategory].title;
      loadEntries();
    });
  });

  document.getElementById('btn-add').addEventListener('click', () => openModal());
  document.getElementById('btn-backup').addEventListener('click', createBackup);
}

// Search & Filter
function initSearch() {
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = e.target.value;
      loadEntries();
    }, 300);
  });

  statusFilter.addEventListener('change', (e) => {
    currentStatus = e.target.value;
    loadEntries();
  });
}

// Modal
function initModal() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  entryForm.addEventListener('submit', handleFormSubmit);
}

function openModal(entry = null) {
  const modalTitle = document.getElementById('modal-title');

  if (entry) {
    modalTitle.textContent = 'Редактировать запись';
    document.getElementById('entry-id').value = entry.id;
    document.getElementById('entry-category').value = entry.category;
    document.getElementById('entry-title').value = entry.title;
    document.getElementById('entry-content').value = entry.content;
    document.getElementById('entry-priority').value = entry.priority;
    document.getElementById('entry-status').value = entry.status;
    document.getElementById('entry-tags').value = entry.tags.join(', ');
    document.getElementById('entry-author').value = entry.author;
  } else {
    modalTitle.textContent = 'Добавить запись';
    entryForm.reset();
    document.getElementById('entry-id').value = '';
    if (currentCategory !== 'all') {
      document.getElementById('entry-category').value = currentCategory;
    }
  }

  modal.classList.add('active');
}

function closeModal() {
  modal.classList.remove('active');
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('entry-id').value;
  const data = {
    category: document.getElementById('entry-category').value,
    title: document.getElementById('entry-title').value,
    content: document.getElementById('entry-content').value,
    priority: document.getElementById('entry-priority').value,
    status: document.getElementById('entry-status').value,
    tags: document.getElementById('entry-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    author: document.getElementById('entry-author').value || 'web-ui'
  };

  try {
    let response;
    if (id) {
      response = await fetch(`${API_BASE}/memory/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } else {
      response = await fetch(`${API_BASE}/memory`, {
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

// Load Data
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
    // Для "pinned" категории получаем все записи и фильтруем на клиенте
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      params.append('category', currentCategory);
    }
    if (currentSearch) params.append('search', currentSearch);
    if (currentStatus) params.append('status', currentStatus);

    const response = await fetch(`${API_BASE}/memory?${params}`);
    const result = await response.json();

    if (result.success) {
      entries = result.entries;

      // Фильтруем по pinned если выбрана категория "Закреплённые"
      if (currentCategory === 'pinned') {
        entries = entries.filter(e => e.pinned === true);
      }

      renderEntries();
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

async function loadStats() {
  try {
    const response = await fetch(`${API_BASE}/stats`);
    const result = await response.json();

    if (result.success) {
      const stats = result.stats;

      // Update counters
      document.getElementById('count-all').textContent = stats.totalEntries;
      document.getElementById('count-architecture').textContent = stats.byCategory.architecture;
      document.getElementById('count-tasks').textContent = stats.byCategory.tasks;
      document.getElementById('count-decisions').textContent = stats.byCategory.decisions;
      document.getElementById('count-issues').textContent = stats.byCategory.issues;
      document.getElementById('count-progress').textContent = stats.byCategory.progress;

      // Update header stats
      document.getElementById('stat-total').textContent = stats.totalEntries;
      document.getElementById('stat-24h').textContent = stats.recentActivity.last24h;

      // Update agents count
      document.getElementById('agents-count').textContent = `${stats.connectedAgents} агентов онлайн`;
    }

    // Загружаем количество закреплённых записей отдельно
    const allResponse = await fetch(`${API_BASE}/memory`);
    const allResult = await allResponse.json();
    if (allResult.success) {
      const pinnedCount = allResult.entries.filter(e => e.pinned === true).length;
      document.getElementById('count-pinned').textContent = pinnedCount;
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// Render
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

  entriesContainer.innerHTML = entries.map(entry => `
    <div class="entry-card ${entry.status}${entry.pinned ? ' pinned' : ''}" data-id="${entry.id}">
      <div class="entry-header">
        <div class="entry-title">
          ${entry.pinned ? '<i data-lucide="pin" class="pin-indicator"></i>' : ''}
          <span class="priority-dot priority-${entry.priority}"></span>
          ${escapeHtml(entry.title)}
        </div>
        <span class="entry-category">
          <i data-lucide="${categoryConfig[entry.category]?.icon || 'file'}"></i>
          ${entry.category}
        </span>
      </div>
      <div class="entry-content">${escapeHtml(entry.content)}</div>
      ${entry.tags.length > 0 ? `
        <div class="entry-tags">
          ${entry.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="entry-footer">
        <div class="entry-meta">
          <span><i data-lucide="user"></i> ${escapeHtml(entry.author)}</span>
          <span><i data-lucide="calendar"></i> ${formatDate(entry.updatedAt)}</span>
        </div>
        <div class="entry-actions">
          <button onclick="togglePin('${entry.id}')" title="${entry.pinned ? 'Открепить' : 'Закрепить'}" class="${entry.pinned ? 'active' : ''}">
            <i data-lucide="pin"></i>
          </button>
          <button onclick="editEntry('${entry.id}')" title="Редактировать">
            <i data-lucide="pencil"></i>
          </button>
          <button onclick="archiveEntry('${entry.id}')" title="Архивировать">
            <i data-lucide="archive"></i>
          </button>
          <button onclick="deleteEntry('${entry.id}')" title="Удалить">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
    </div>
  `).join('');

  lucide.createIcons();
}

// Actions
window.editEntry = function(id) {
  const entry = entries.find(e => e.id === id);
  if (entry) openModal(entry);
};

window.archiveEntry = async function(id) {
  if (!confirm('Архивировать эту запись?')) return;

  try {
    const response = await fetch(`${API_BASE}/memory/${id}`, {
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
  if (!confirm('Удалить эту запись навсегда?')) return;

  try {
    const response = await fetch(`${API_BASE}/memory/${id}?archive=false`, {
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
    const response = await fetch(`${API_BASE}/memory/${id}/pin`, {
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

async function createBackup() {
  try {
    const response = await fetch(`${API_BASE}/backup`, { method: 'POST' });
    const result = await response.json();

    if (result.success) {
      showToast('Бэкап создан', 'success');
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Ошибка создания бэкапа', 'error');
  }
}

// WebSocket
function initWebSocket() {
  const wsUrl = `ws://${window.location.hostname}:${WS_PORT}`;

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
      // Reconnect after 5 seconds
      setTimeout(initWebSocket, 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to connect WebSocket:', error);
  }
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'memory:created':
    case 'memory:updated':
    case 'memory:deleted':
      // Reload data on any change
      loadEntries();
      loadStats();
      if (data.type === 'memory:created') {
        showToast('Новая запись добавлена', 'info');
      }
      break;

    case 'agent:connected':
      if (!data.payload.renamed) {
        loadStats();
      }
      break;

    case 'agent:disconnected':
      loadStats();
      break;
  }
}

// Helpers
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'только что';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} дн назад`;

  return date.toLocaleDateString('ru-RU');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
