// RAG chat v4.0 — SSE streaming + session history + project selector

(function () {
  const state = {
    projects: [],
    currentProjectId: null,
    sessions: [],
    currentSessionId: null,
    messagesBySession: {},
    sending: false,
  };

  const $ = (sel) => document.querySelector(sel);

  function authHeaders() {
    const token = localStorage.getItem('auth-token') || '';
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(opts.headers || {}),
      },
      credentials: 'include',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function loadProjects() {
    let projects = [];
    try {
      const res = await api('/api/projects');
      projects = Array.isArray(res) ? res : res?.projects ?? [];
    } catch (err) {
      showToast('error', `Не удалось загрузить проекты: ${err.message}`);
    }
    state.projects = projects;
    renderProjectOptions();
  }

  function renderProjectOptions() {
    const opts = $('#chat-project-options');
    if (!opts) return;
    const items = [{ id: '', name: '— Выбери проект —' }, ...state.projects];
    opts.innerHTML = items.map(p => `
      <div class="custom-select-option${p.id === (state.currentProjectId || '') ? ' selected' : ''}" data-value="${escapeHtml(p.id)}">
        <span class="custom-select-option-name">${escapeHtml(p.name || p.id)}</span>
      </div>
    `).join('');
  }

  function setProjectValue(id, displayName) {
    state.currentProjectId = id || null;
    const valueEl = $('#chat-project-select .custom-select-value');
    if (valueEl) valueEl.textContent = displayName || '— Выбери проект —';
    const newBtn = $('#chat-new-btn');
    if (newBtn) newBtn.disabled = !state.currentProjectId;
    renderProjectOptions();
    state.currentSessionId = null;
    const msgs = $('#chat-messages');
    if (msgs) msgs.innerHTML = '';
    loadSessions();
  }

  async function loadSessions() {
    if (!state.currentProjectId) {
      state.sessions = [];
      renderSessionList();
      return;
    }
    const qs = new URLSearchParams({ project_id: state.currentProjectId, limit: '50' });
    const list = await api(`/api/chat/sessions?${qs}`);
    state.sessions = list || [];
    renderSessionList();
  }

  function renderSessionList() {
    const ul = $('#chat-session-list');
    if (!ul) return;
    if (!state.sessions.length) {
      ul.innerHTML = '<li class="chat-session-empty" style="padding:8px 12px;color:var(--text-dim,#888);font-size:13px;">Нет чатов</li>';
      return;
    }
    ul.innerHTML = state.sessions.map(s => `
      <li class="chat-session-item ${s.id === state.currentSessionId ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
        <span class="chat-session-title" title="Двойной клик — переименовать">${escapeHtml(s.title)}</span>
        <button class="chat-session-rename" data-id="${escapeHtml(s.id)}" title="Переименовать">✎</button>
        <button class="chat-session-delete" data-id="${escapeHtml(s.id)}" title="Удалить">×</button>
      </li>
    `).join('');
  }

  async function renameChatInline(sessionId, titleEl) {
    const current = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-session-title-edit';
    input.value = current;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = async (save) => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (!save || !next || next === current) {
        renderSessionList();
        return;
      }
      try {
        await api(`/api/chat/sessions/${sessionId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: next }),
        });
        const session = state.sessions.find(s => s.id === sessionId);
        if (session) session.title = next;
      } catch (err) {
        showToast('error', `Не удалось переименовать: ${err.message}`);
      }
      renderSessionList();
    };
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
  }

  async function createNewChat() {
    if (!state.currentProjectId) return;
    const session = await api('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ project_id: state.currentProjectId }),
    });
    state.sessions.unshift(session);
    await openChat(session.id);
  }

  async function openChat(sessionId) {
    state.currentSessionId = sessionId;
    renderSessionList();
    const res = await api(`/api/chat/sessions/${sessionId}`);
    state.messagesBySession[sessionId] = (res && res.messages) || [];
    renderChatMessages();
  }

  async function deleteChat(sessionId, ev) {
    ev.stopPropagation();
    if (!confirm('Удалить чат?')) return;
    await api(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' });
    state.sessions = state.sessions.filter(s => s.id !== sessionId);
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = null;
      const msgs = $('#chat-messages');
      if (msgs) msgs.innerHTML = '';
    }
    renderSessionList();
  }

  function renderChatMessages() {
    const container = $('#chat-messages');
    if (!container) return;
    container.innerHTML = '';
    const messages = state.messagesBySession[state.currentSessionId] || [];

    // Build lookup of tool_call_id → tool message
    const toolResults = {};
    for (const m of messages) {
      if (m.role === 'tool') {
        const cid = m.tool_call_id || m.toolCallId;
        if (cid) toolResults[cid] = { name: m.tool_name || m.toolName, result: m.content };
      }
    }

    for (const m of messages) {
      if (m.role === 'system' || m.role === 'tool') continue;
      if (m.role === 'user') {
        container.appendChild(bubble('user', m.content));
      } else if (m.role === 'assistant') {
        const toolCalls = m.tool_calls || m.toolCalls || [];
        const traceNode = toolCalls.length ? toolTraceNode(toolCalls, toolResults, true) : null;
        container.appendChild(assistantBubble(m.content, traceNode));
      }
    }
    container.scrollTop = container.scrollHeight;
  }

  function bubble(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    return el;
  }

  function assistantBubble(text, traceNode) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    if (traceNode) el.appendChild(traceNode);
    const txt = document.createElement('div');
    txt.className = 'msg-text';
    txt.textContent = text;
    el.appendChild(txt);
    return el;
  }

  function toolTraceNode(toolCalls, resultsMap, collapsed) {
    const details = document.createElement('details');
    details.className = 'tool-trace';
    if (!collapsed) details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = `🔧 Использовано ${toolCalls.length} инстр.`;
    details.appendChild(summary);
    const ol = document.createElement('ol');
    for (const tc of toolCalls) {
      const li = document.createElement('li');
      const res = resultsMap[tc.id];
      const ok = res ? (res.result && res.result.startsWith('{"error"') ? '✗' : '✓') : '…';
      const nameEl = document.createElement('code');
      nameEl.textContent = tc.name;
      li.innerHTML = `<span class="tool-status">${ok}</span>`;
      li.appendChild(nameEl);
      const pre = document.createElement('pre');
      pre.textContent = `args: ${JSON.stringify(tc.args, null, 2)}\n` +
        (res ? `result: ${String(res.result).slice(0, 500)}` : 'выполняется...');
      li.appendChild(pre);
      ol.appendChild(li);
    }
    details.appendChild(ol);
    return details;
  }

  async function sendMessage(text) {
    if (state.sending || !state.currentSessionId) return;
    state.sending = true;

    const messages = state.messagesBySession[state.currentSessionId] = state.messagesBySession[state.currentSessionId] || [];
    messages.push({ role: 'user', content: text });
    const userNode = bubble('user', text);
    const msgContainer = $('#chat-messages');
    msgContainer.appendChild(userNode);

    const assistantEl = document.createElement('div');
    assistantEl.className = 'msg assistant';
    const toolDetails = document.createElement('details');
    toolDetails.className = 'tool-trace';
    toolDetails.open = true;
    toolDetails.style.display = 'none';
    const toolSummary = document.createElement('summary');
    toolSummary.textContent = '🔧 Использую инструменты…';
    toolDetails.appendChild(toolSummary);
    const toolOl = document.createElement('ol');
    toolDetails.appendChild(toolOl);
    assistantEl.appendChild(toolDetails);
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    assistantEl.appendChild(textEl);
    msgContainer.appendChild(assistantEl);
    msgContainer.scrollTop = msgContainer.scrollHeight;

    const toolStartItems = {};

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        credentials: 'include',
        body: JSON.stringify({ session_id: state.currentSessionId, message: text }),
      });
      if (!res.ok) {
        showToast('error', `Ошибка ${res.status}: ${await res.text()}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (raw.startsWith(':')) continue;
          const ev = parseSse(raw);
          if (!ev) continue;
          if (ev.type === 'text') {
            finalText += ev.delta;
            textEl.textContent = finalText;
          } else if (ev.type === 'tool_start') {
            toolDetails.style.display = 'block';
            const li = document.createElement('li');
            const nameCode = document.createElement('code');
            nameCode.textContent = ev.name;
            li.innerHTML = `<span class="tool-status">…</span>`;
            li.appendChild(nameCode);
            const pre = document.createElement('pre');
            pre.textContent = `args: ${JSON.stringify(ev.args, null, 2)}`;
            li.appendChild(pre);
            toolOl.appendChild(li);
            toolStartItems[ev.id] = li;
          } else if (ev.type === 'tool_end') {
            const li = toolStartItems[ev.id];
            if (li) {
              const status = li.querySelector('.tool-status');
              if (status) status.textContent = ev.ok ? '✓' : '✗';
              const pre = li.querySelector('pre');
              if (pre) pre.textContent += `\nresult: ${ev.summary || ev.error || 'ok'}`;
            }
          } else if (ev.type === 'done') {
            toolDetails.open = false;
            if (toolOl.children.length) {
              toolSummary.textContent = `🔧 Использовано ${toolOl.children.length} инстр.`;
            }
          } else if (ev.type === 'error') {
            showToast('error', ev.message || ev.code);
            toolSummary.textContent = `⚠ Ошибка: ${ev.code}`;
          }
          msgContainer.scrollTop = msgContainer.scrollHeight;
        }
      }

      if (finalText) messages.push({ role: 'assistant', content: finalText });
      await loadSessions();
    } catch (err) {
      showToast('error', err.message);
    } finally {
      state.sending = false;
    }
  }

  function parseSse(raw) {
    const lines = raw.split('\n');
    let type = null, data = null;
    for (const l of lines) {
      if (l.startsWith('event: ')) type = l.slice(7).trim();
      else if (l.startsWith('data: ')) data = l.slice(6);
    }
    if (!type || data === null) return null;
    try { return { type, ...JSON.parse(data) }; } catch { return null; }
  }

  function showToast(level, message) {
    const el = document.createElement('div');
    el.className = `chat-toast ${level}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showChatPanel() {
    const panel = document.getElementById('chat-panel');
    const entriesEl = document.getElementById('entries-container');
    const domainEl = document.getElementById('domain-filters');
    const graphEl = document.getElementById('graph-view');
    const agentsEl = document.getElementById('agents-panel');
    const headerRight = document.querySelector('.header-right');
    const pageTitle = document.getElementById('page-title');

    if (panel) panel.style.display = 'flex';
    if (entriesEl) entriesEl.style.display = 'none';
    if (domainEl) domainEl.style.display = 'none';
    if (graphEl) graphEl.style.display = 'none';
    if (agentsEl) agentsEl.style.display = 'none';
    if (headerRight) headerRight.style.visibility = 'hidden';
    if (pageTitle) pageTitle.textContent = 'Intellectika AI';

    const containers = ['sessions-container', 'session-detail-container', 'notes-container'];
    containers.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // Hide load-more buttons from entries/sessions/notes views
    const loadMoreIds = ['load-more-btn', 'sessions-load-more-btn', 'notes-load-more-btn'];
    loadMoreIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    const chatBtn = document.getElementById('btn-ai-chat');
    if (chatBtn) chatBtn.classList.add('active');

    // Render lucide icons inside chat panel (chevron on select trigger, etc.)
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
      lucide.createIcons({ nodes: panel?.querySelectorAll('[data-lucide]') });
    }
  }

  function init() {
    const projSel = $('#chat-project-select');
    const newBtn = $('#chat-new-btn');
    const sessionList = $('#chat-session-list');
    const form = $('#chat-form');
    if (!projSel || !newBtn || !sessionList || !form) return;  // markup not present

    // Wire nav button
    const openBtn = document.getElementById('btn-ai-chat');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        showChatPanel();
        loadProjects();
      });
    }

    // Custom-select: toggle open on trigger click
    const trigger = projSel.querySelector('.custom-select-trigger');
    const optionsEl = $('#chat-project-options');
    if (trigger) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        projSel.classList.toggle('open');
      });
    }
    // Option click handler (delegated — options are re-rendered)
    if (optionsEl) {
      optionsEl.addEventListener('click', (e) => {
        const opt = e.target.closest('.custom-select-option');
        if (!opt) return;
        const id = opt.dataset.value;
        const name = opt.querySelector('.custom-select-option-name')?.textContent || '';
        projSel.classList.remove('open');
        setProjectValue(id, name);
      });
    }
    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!projSel.contains(e.target)) projSel.classList.remove('open');
    });

    newBtn.addEventListener('click', createNewChat);
    sessionList.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.chat-session-delete');
      if (delBtn) return deleteChat(delBtn.dataset.id, e);
      const renameBtn = e.target.closest('.chat-session-rename');
      if (renameBtn) {
        e.stopPropagation();
        const item = renameBtn.closest('.chat-session-item');
        const titleEl = item?.querySelector('.chat-session-title');
        if (titleEl) renameChatInline(renameBtn.dataset.id, titleEl);
        return;
      }
      const item = e.target.closest('.chat-session-item');
      if (item) openChat(item.dataset.id);
    });
    sessionList.addEventListener('dblclick', (e) => {
      const titleEl = e.target.closest('.chat-session-title');
      if (!titleEl) return;
      const item = titleEl.closest('.chat-session-item');
      if (item) {
        e.preventDefault();
        e.stopPropagation();
        renameChatInline(item.dataset.id, titleEl);
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text || !state.currentSessionId) return;
      input.value = '';
      sendMessage(text);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
