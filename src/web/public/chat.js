// RAG chat v4.0 — SSE streaming + session history + project selector

(function () {
  const state = {
    projects: [],
    currentProjectId: null,
    sessions: [],
    currentSessionId: null,
    messagesBySession: {},
    sending: false,
    pendingDeleteId: null,
  };

  const $ = (sel) => document.querySelector(sel);

  function renderMarkdown(text) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      // Graceful fallback to plain text if CDN didn't load
      const div = document.createElement('div');
      div.style.whiteSpace = 'pre-wrap';
      div.textContent = text;
      return div.outerHTML;
    }
    const html = marked.parse(text, { gfm: true, breaks: true });
    return DOMPurify.sanitize(html);
  }

  function highlightCodeIn(el) {
    if (typeof hljs === 'undefined') return;
    el.querySelectorAll('pre code').forEach(block => {
      try { hljs.highlightElement(block); } catch { /* ignore */ }
    });
  }

  function authHeaders() {
    const token = localStorage.getItem('auth-token') || '';
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  /** True when the viewer has no token — write endpoints are blocked by
   * server auth middleware. Chat.js short-circuits all POST/DELETE and shows
   * the readonly banner instead of firing doomed API calls. */
  function isReadonly() {
    return document.body.classList.contains('readonly-mode');
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

  /** Polls the session's title a couple of times after the first exchange
   * to pick up the server-side auto-generated title without a full refresh. */
  function scheduleTitleRefresh(sessionId) {
    if (!sessionId) return;
    const session = state.sessions.find(s => s.id === sessionId);
    const originalTitle = session?.title ?? '';
    const check = async () => {
      try {
        const res = await api(`/api/chat/sessions/${sessionId}`);
        if (!res) return;
        const s = state.sessions.find(x => x.id === sessionId);
        if (s && res.title && res.title !== originalTitle) {
          s.title = res.title;
          renderSessionList();
          return true;
        }
      } catch { /* ignore */ }
      return false;
    };
    setTimeout(async () => {
      const ok = await check();
      if (!ok) setTimeout(check, 2500);
    }, 1500);
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
        <span class="chat-session-title">${escapeHtml(s.title)}</span>
        <button class="chat-session-rename" data-id="${escapeHtml(s.id)}" aria-label="Переименовать чат">✎</button>
        <button class="chat-session-delete" data-id="${escapeHtml(s.id)}" aria-label="Удалить чат">×</button>
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

  function openDeleteChatModal(sessionId, ev) {
    if (ev) ev.stopPropagation();
    const session = state.sessions.find(s => s.id === sessionId);
    state.pendingDeleteId = sessionId;
    const titleEl = $('#chat-delete-title-text');
    if (titleEl) titleEl.textContent = session?.title ?? 'Новый чат';
    const modal = document.getElementById('chat-delete-modal');
    if (modal) modal.classList.add('active');
  }

  function closeDeleteChatModal() {
    state.pendingDeleteId = null;
    const modal = document.getElementById('chat-delete-modal');
    if (modal) modal.classList.remove('active');
  }

  async function confirmDeleteChat() {
    const sessionId = state.pendingDeleteId;
    if (!sessionId) return;
    closeDeleteChatModal();
    try {
      await api(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' });
      state.sessions = state.sessions.filter(s => s.id !== sessionId);
      if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        const msgs = $('#chat-messages');
        if (msgs) msgs.innerHTML = '';
      }
      renderSessionList();
    } catch (err) {
      showToast('error', `Не удалось удалить чат: ${err.message}`);
    }
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
    // Scroll to bottom after layout: rAF waits for paint so scrollHeight
    // reflects the final (markdown-rendered) content size.
    requestAnimationFrame(() => {
      const scrollEl = document.querySelector('.chat-messages-scroll');
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  }

  function bubble(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const inner = document.createElement('div');
    inner.className = 'msg-text';
    if (role === 'assistant') {
      inner.innerHTML = renderMarkdown(text);
      highlightCodeIn(inner);
    } else {
      inner.textContent = text;
    }
    wrap.appendChild(inner);
    return wrap;
  }

  function assistantBubble(text, traceNode) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    if (traceNode) el.appendChild(traceNode);
    const txt = document.createElement('div');
    txt.className = 'msg-text';
    txt.innerHTML = renderMarkdown(text);
    highlightCodeIn(txt);
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
    const scrollEl = document.querySelector('.chat-messages-scroll');
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;

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
            textEl.innerHTML = renderMarkdown(finalText);
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
            highlightCodeIn(textEl);
          } else if (ev.type === 'error') {
            showToast('error', ev.message || ev.code);
            toolSummary.textContent = `⚠ Ошибка: ${ev.code}`;
          }
          const scrollEl = document.querySelector('.chat-messages-scroll');
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        }
      }

      if (finalText) messages.push({ role: 'assistant', content: finalText });
      await loadSessions();
      // Auto-title is generated server-side fire-and-forget after the stream
      // ends (Gemini call ~0.5–1 s). Poll twice to pick up the new name
      // without forcing the user to refresh.
      scheduleTitleRefresh(state.currentSessionId);
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
    // Keep <main class="main"> and <header class="header"> visible so the
    // app header (page title + stats) stays at the top like on other tabs.
    // Only hide the per-tab content containers and filter rails.
    const hideIds = [
      'entries-container',
      'graph-view',
      'agents-panel',
      'sessions-container',
      'session-detail-container',
      'notes-container',
      'load-more-btn',
      'sessions-load-more-btn',
      'notes-load-more-btn',
    ];
    hideIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    const domainEl = document.getElementById('domain-filters');
    if (domainEl) domainEl.style.display = 'none';
    // .header-right visibility is scoped via body.chat-active in CSS so that
    // leaving the chat tab restores search / export / theme / login without
    // each nav-item handler having to reset inline styles.

    if (panel) panel.style.display = 'flex';

    // body class lets CSS hide anything that should be invisible on chat tab
    // (vectorized indicator, pagination, etc.) — more resilient than per-element
    // inline display:none which later code paths can overwrite.
    document.body.classList.add('chat-active');

    const pageTitle = document.getElementById('page-title');
    if (pageTitle) pageTitle.innerHTML =
      '<span class="intellectika-brand">Intellectika</span> ' +
      '<span class="intellectika-ai">AI</span> ' +
      '<span class="intellectika-chat">Chat</span>';

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    const chatBtn = document.getElementById('btn-ai-chat');
    if (chatBtn) chatBtn.classList.add('active');

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
        // Skip API calls in readonly — the banner is shown instead.
        if (!isReadonly()) loadProjects();
        try { localStorage.setItem('active-tab', 'chat'); } catch {}
      });
    }

    // Readonly banner login button — mirrors the header login flow in app.js
    document.getElementById('chat-readonly-login-btn')?.addEventListener('click', () => {
      window.location.href = '/login';
    });

    // Sidebar collapse toggle (persisted in localStorage)
    const panel = document.getElementById('chat-panel');
    const sidebarToggle = document.getElementById('chat-sidebar-toggle');
    const applySidebarState = (collapsed) => {
      if (!panel) return;
      panel.classList.toggle('sidebar-collapsed', collapsed);
      try { localStorage.setItem('chat-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
    };
    let savedCollapsed = false;
    try { savedCollapsed = localStorage.getItem('chat-sidebar-collapsed') === '1'; } catch {}
    applySidebarState(savedCollapsed);

    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', () => {
        const nowCollapsed = !panel.classList.contains('sidebar-collapsed');
        applySidebarState(nowCollapsed);
      });
    }

    // Chat-delete modal wiring
    const delModal = document.getElementById('chat-delete-modal');
    document.getElementById('chat-delete-modal-close')?.addEventListener('click', closeDeleteChatModal);
    document.getElementById('chat-delete-cancel')?.addEventListener('click', closeDeleteChatModal);
    document.getElementById('chat-delete-confirm')?.addEventListener('click', confirmDeleteChat);
    // Close on backdrop click
    delModal?.addEventListener('click', (e) => {
      if (e.target === delModal) closeDeleteChatModal();
    });
    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && delModal?.classList.contains('active')) closeDeleteChatModal();
    });

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
      if (delBtn) return openDeleteChatModal(delBtn.dataset.id, e);
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
    const input = $('#chat-input');
    if (input) {
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 240) + 'px';
      });
      input.addEventListener('keydown', (e) => {
        // Enter sends, Shift+Enter inserts newline
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isReadonly()) return;  // banner is shown; form is hidden via CSS but guard anyway
      const inp = $('#chat-input');
      const text = inp.value.trim();
      if (!text) return;
      // Auto-create a new chat if the user just typed without opening one.
      if (!state.currentSessionId) {
        if (!state.currentProjectId) {
          showToast('error', 'Сначала выбери проект сверху в левой панели');
          return;
        }
        try {
          await createNewChat();
        } catch (err) {
          showToast('error', `Не удалось создать чат: ${err.message}`);
          return;
        }
      }
      inp.value = '';
      inp.style.height = 'auto';
      sendMessage(text);
    });

    // When another nav item (not #btn-ai-chat) is clicked, restore main and hide chat panel.
    document.querySelectorAll('.nav-item').forEach(navItem => {
      if (navItem.id === 'btn-ai-chat') return;
      navItem.addEventListener('click', () => {
        const panelEl = document.getElementById('chat-panel');
        if (panelEl) panelEl.style.display = 'none';
        document.body.classList.remove('chat-active');
        // app.js's own nav handlers restore the content containers and
        // header-right visibility for each target tab.
        try { localStorage.removeItem('active-tab'); } catch {}
      });
    });

    // Restore: if user was on the chat tab before refresh, reopen it.
    let wasOnChat = false;
    try { wasOnChat = localStorage.getItem('active-tab') === 'chat'; } catch {}
    if (wasOnChat) {
      showChatPanel();
      if (!isReadonly()) loadProjects();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
