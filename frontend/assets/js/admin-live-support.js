'use strict';
/* ===========================================================================
   admin-live-support.js — the agent console (CR-9, slice 4)
   ===========================================================================
   Three panes: the queue, the thread, and who the customer is. An agent works
   left to right and never leaves the section, because a support conversation is
   answered in seconds and a page navigation between each one is the difference
   between a queue that gets cleared and one that does not.

   IT HOLDS ONE SOCKET FOR THE WHOLE SECTION, not one per thread. `join_chat`
   and `leave_chat` move the subscription as the agent moves between
   conversations — see AgentConnection in chat_gateway.py, which unsubscribes on
   leave so a long shift does not accumulate forty live subscriptions.

   XSS: the same rule as the customer widget. Message bodies go through
   textContent, never innerHTML. Here it matters MORE, not less: the text was
   written by a member of the public and is rendered inside the admin dashboard,
   where the reader holds a session that can move money.
   =========================================================================== */

const AdminLiveSupport = (function () {

  const API = '/api/admin/chat';

  const state = {
    conversations: [],
    counts: {},
    filter: 'waiting',
    mine: false,
    search: '',
    current: null,
    messages: [],
    ws: null,
    wsAttempt: 0,
    booted: false,
  };

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

  async function api(path, options) {
    const opts = options || {};
    const response = await fetch(API + path, Object.assign({}, opts, {
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        typeof authHeaders === 'function' ? authHeaders() : {},
        opts.headers || {},
      ),
    }));
    if (response.status === 204) return null;
    let payload = null;
    try { payload = await response.json(); } catch (e) { /* no body */ }
    if (!response.ok) {
      const error = new Error((payload && payload.detail) || ('HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  /* -------------------------------------------------------------------------
     Queue
     ------------------------------------------------------------------------- */
  async function loadQueue() {
    const params = new URLSearchParams();
    if (state.filter && state.filter !== 'all') params.set('status', state.filter);
    if (state.mine) params.set('mine', 'true');
    if (state.search) params.set('q', state.search);
    try {
      const data = await api('/conversations?' + params.toString());
      state.conversations = data.conversations;
      state.counts = data.counts;
      renderQueue();
      renderCounts();
    } catch (error) {
      const list = document.getElementById('alsQueueList');
      if (list) list.innerHTML = '<div class="als-empty">Could not load the queue.</div>';
    }
  }

  function renderCounts() {
    ['waiting', 'active', 'resolved', 'closed'].forEach(status => {
      const el = document.querySelector(`[data-als-count="${status}"]`);
      if (el) el.textContent = state.counts[status] ?? 0;
    });
    const badge = document.getElementById('alsNavBadge');
    if (badge) {
      const waiting = state.counts.waiting || 0;
      badge.textContent = waiting;
      badge.hidden = waiting === 0;
    }
  }

  function renderQueue() {
    const list = document.getElementById('alsQueueList');
    if (!list) return;
    if (!state.conversations.length) {
      list.innerHTML = '<div class="als-empty">Nothing here. When a customer writes, '
        + 'their conversation appears in Waiting.</div>';
      return;
    }
    list.innerHTML = state.conversations.map(c => `
      <button type="button" class="als-row${state.current && state.current.conversation_id === c.conversation_id ? ' is-open' : ''}"
              data-als-open="${c.conversation_id}">
        <div class="als-row-top">
          <span class="als-name">${esc(c.customer_name || 'Customer #' + c.customer_id)}</span>
          ${c.unread_count ? `<span class="als-unread">${c.unread_count}</span>` : ''}
        </div>
        <div class="als-preview">${esc(c.last_message || 'No messages yet')}</div>
        <div class="als-row-meta">
          <span class="als-chip als-${esc(c.status)}">${esc(c.status)}</span>
          ${c.assigned_admin_name ? `<span class="als-agent">${esc(c.assigned_admin_name)}</span>` : ''}
          <span class="als-when">${c.last_message_at ? fmtWhen(c.last_message_at) : ''}</span>
        </div>
      </button>`).join('');
  }

  function fmtWhen(iso) {
    const when = new Date(iso);
    if (isNaN(when)) return '';
    const mins = Math.floor((Date.now() - when.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm';
    if (mins < 1440) return Math.floor(mins / 60) + 'h';
    return when.toLocaleDateString();
  }

  /* -------------------------------------------------------------------------
     Thread
     ------------------------------------------------------------------------- */
  async function openConversation(conversationId) {
    if (state.current && state.ws) socketSend('leave_chat', {
      conversation_id: state.current.conversation_id,
    });
    try {
      const data = await api('/conversations/' + conversationId);
      state.current = data.conversation;
      state.messages = data.messages;
      renderThread();
      renderContext();
      renderQueue();
      socketSend('join_chat', { conversation_id: conversationId });
      markRead();
    } catch (error) {
      const thread = document.getElementById('alsThread');
      if (thread) thread.innerHTML = '<div class="als-empty">Could not open that conversation.</div>';
    }
  }

  function renderThread() {
    const thread = document.getElementById('alsThread');
    const composer = document.getElementById('alsComposer');
    if (!thread) return;
    if (!state.current) {
      thread.innerHTML = '<div class="als-empty">Pick a conversation on the left.</div>';
      if (composer) composer.hidden = true;
      return;
    }
    if (composer) composer.hidden = false;

    thread.textContent = '';
    const fragment = document.createDocumentFragment();
    state.messages.forEach(m => fragment.appendChild(messageEl(m)));
    thread.appendChild(fragment);
    thread.scrollTop = thread.scrollHeight;
    paintActions();
  }

  function messageEl(message) {
    if (message.message_type === 'system') {
      const row = document.createElement('div');
      row.className = 'als-system';
      row.textContent = message.body || '';
      return row;
    }
    const mine = message.sender_type === 'admin';
    const row = document.createElement('div');
    row.className = 'als-msg ' + (mine ? 'als-msg-out' : 'als-msg-in');
    if (message.is_internal) row.classList.add('als-msg-note');
    if (message.deleted_at) row.classList.add('als-msg-deleted');

    const bubble = document.createElement('div');
    bubble.className = 'als-bubble';
    /* textContent. The body was typed by a member of the public and is being
       rendered in a dashboard whose session can move money. */
    bubble.textContent = message.deleted_at
      ? 'This message was deleted'
      : (message.body || '');
    row.appendChild(bubble);

    const meta = document.createElement('div');
    meta.className = 'als-meta';
    if (message.is_internal) {
      const tag = document.createElement('span');
      tag.className = 'als-note-tag';
      tag.textContent = 'Internal note — not sent to the customer';
      meta.appendChild(tag);
    }
    const who = document.createElement('span');
    who.textContent = message.sender_name || (mine ? 'You' : 'Customer');
    meta.appendChild(who);
    const time = document.createElement('span');
    time.textContent = new Date(message.created_at).toLocaleString();
    meta.appendChild(time);
    row.appendChild(meta);
    return row;
  }

  function renderContext() {
    const box = document.getElementById('alsContext');
    if (!box) return;
    const c = state.current;
    if (!c) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <h3>${esc(c.customer_name || 'Customer')}</h3>
      <dl class="als-dl">
        <dt>Email</dt><dd>${esc(c.customer_email || '—')}</dd>
        <dt>Mobile</dt><dd>${esc(c.customer_mobile || '—')}</dd>
        <dt>Conversation</dt><dd>#${c.conversation_id}</dd>
        <dt>Status</dt><dd>${esc(c.status)}</dd>
        <dt>Assigned</dt><dd>${esc(c.assigned_admin_name || 'Nobody')}</dd>
      </dl>
      <!-- Booking history lands here when CR-10 exposes it; the pane exists now
           so the layout does not shift when it does. -->
      <div class="als-soon">Booking history — coming with CR-10</div>`;
  }

  function paintActions() {
    const c = state.current;
    const bar = document.getElementById('alsActions');
    if (!bar || !c) return;
    const claimable = !c.assigned_admin_id;
    bar.querySelector('[data-als-claim]').hidden = !claimable;
    bar.querySelector('[data-als-resolve]').hidden = c.status !== 'active';
    bar.querySelector('[data-als-close]').hidden = c.status === 'closed';
    bar.querySelector('[data-als-reopen]').hidden = c.status !== 'resolved';
  }

  /* -------------------------------------------------------------------------
     Actions
     ------------------------------------------------------------------------- */
  async function act(path, body) {
    if (!state.current) return;
    try {
      const updated = await api('/conversations/' + state.current.conversation_id + path, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      state.current = updated;
      renderContext();
      paintActions();
      loadQueue();
    } catch (error) {
      /* 409 is the claim race: another agent got there first. Saying so is the
         useful answer — reloading the queue would just make it vanish. */
      alert(error.status === 409 ? error.message : ('Action failed: ' + error.message));
      loadQueue();
    }
  }

  async function send(isInternal) {
    const input = document.getElementById('alsInput');
    if (!input || !state.current) return;
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try {
      await api('/conversations/' + state.current.conversation_id + '/messages', {
        method: 'POST',
        body: JSON.stringify({ body: body, is_internal: !!isInternal }),
      });
      /* The message comes back over the socket like any other, so nothing is
         appended here — one path renders every message, including our own. */
    } catch (error) {
      input.value = body;
      alert('Could not send: ' + error.message);
    }
  }

  async function markRead() {
    if (!state.current || !state.messages.length) return;
    const newest = [...state.messages].reverse().find(m => m.sender_type === 'customer');
    if (!newest) return;
    try {
      await api(`/conversations/${state.current.conversation_id}/read?up_to_message_id=${newest.message_id}`,
                { method: 'POST' });
      loadQueue();
    } catch (error) { /* a stale badge is not worth an alert */ }
  }

  /* -------------------------------------------------------------------------
     Socket
     ------------------------------------------------------------------------- */
  async function connect() {
    if (state.ws) return;
    let ticket;
    try {
      ticket = (await api('/ws-ticket', { method: 'POST' })).ticket;
    } catch (error) { scheduleReconnect(); return; }

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${scheme}//${location.host}${API}/ws?ticket=${encodeURIComponent(ticket)}`);
    } catch (error) { scheduleReconnect(); return; }
    state.ws = ws;

    ws.onopen = () => {
      state.wsAttempt = 0;
      setStatus('Live');
      if (state.current) socketSend('join_chat', {
        conversation_id: state.current.conversation_id,
      });
    };
    ws.onmessage = event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch (e) { return; }
      handleFrame(frame.event, frame.data || {});
    };
    ws.onclose = () => {
      state.ws = null;
      setStatus('Reconnecting…');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    state.wsAttempt = Math.min(state.wsAttempt + 1, 6);
    const base = Math.min(1000 * Math.pow(2, state.wsAttempt - 1), 30000);
    setTimeout(connect, base * (0.7 + Math.random() * 0.6));
  }

  function socketSend(event, data) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    state.ws.send(JSON.stringify({ event: event, data: data }));
    return true;
  }

  function handleFrame(event, data) {
    if (event === 'receive_message') {
      if (state.current && data.conversation_id === state.current.conversation_id) {
        const i = state.messages.findIndex(m => m.message_id === data.message_id);
        if (i === -1) state.messages.push(data); else state.messages[i] = data;
        renderThread();
        if (data.sender_type === 'customer') markRead();
      }
      loadQueue();
      return;
    }
    if (event === 'typing' && data.actor === 'customer') {
      if (state.current && data.conversation_id === state.current.conversation_id) {
        setStatus(data.is_typing ? 'Customer is typing…' : 'Live');
      }
    }
  }

  function setStatus(text) {
    const el = document.getElementById('alsStatus');
    if (el) el.textContent = text;
  }

  /* -------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------- */
  function init() {
    if (state.booted) { loadQueue(); return; }
    state.booted = true;

    document.querySelectorAll('[data-als-filter]').forEach(tab => {
      tab.addEventListener('click', () => {
        state.filter = tab.dataset.alsFilter;
        document.querySelectorAll('[data-als-filter]').forEach(
          t => t.classList.toggle('active', t === tab));
        loadQueue();
      });
    });

    const search = document.getElementById('alsSearch');
    if (search) {
      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.search = search.value.trim(); loadQueue(); }, 300);
      });
    }

    const mine = document.getElementById('alsMine');
    if (mine) mine.addEventListener('change', () => { state.mine = mine.checked; loadQueue(); });

    document.getElementById('alsQueueList')?.addEventListener('click', e => {
      const row = e.target.closest('[data-als-open]');
      if (row) openConversation(Number(row.dataset.alsOpen));
    });

    document.getElementById('alsSendBtn')?.addEventListener('click', () => send(false));
    document.getElementById('alsNoteBtn')?.addEventListener('click', () => send(true));
    document.getElementById('alsInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(false); }
    });

    const bar = document.getElementById('alsActions');
    bar?.querySelector('[data-als-claim]')?.addEventListener('click', () => act('/claim'));
    bar?.querySelector('[data-als-resolve]')?.addEventListener('click', () => act('/status', { status: 'resolved' }));
    bar?.querySelector('[data-als-close]')?.addEventListener('click', () => act('/status', { status: 'closed' }));
    bar?.querySelector('[data-als-reopen]')?.addEventListener('click', () => act('/status', { status: 'active' }));

    loadQueue();
    connect();
  }

  return { init, loadQueue };
})();
