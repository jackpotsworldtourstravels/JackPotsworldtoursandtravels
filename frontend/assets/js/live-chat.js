'use strict';
/* ===========================================================================
   live-chat.js — the customer chat widget (CR-9, slice 2)
   ===========================================================================
   ONE COMPONENT, TWO PLACES. A floating launcher on every page, and the same
   panel docked inside Profile -> Support Center. `LiveChat.mount()` builds the
   floating one; `LiveChat.mountInto(el)` docks it. Both render the same DOM
   through the same code path, because the brief asks for the same chat in both
   and two implementations would disagree within a release.

   NO POLLING, AND NO SOCKET YET.
   Slice 2 is deliberately the REST path on its own: it proves the data model
   and the interface before real-time is in play, and a REST send that works is
   what the socket's behaviour gets checked against in slice 3. The brief rules
   out polling, so this does not poll — it refreshes when the panel is opened
   and when the tab regains focus. Until slice 3 lands, an agent's reply appears
   on the next open or focus rather than instantly. That is a known, temporary
   gap, stated here rather than hidden behind a 5-second timer that would have
   to be removed again.

   XSS: EVERY MESSAGE BODY GOES THROUGH textContent, NEVER innerHTML.
   This is the one place in the product where text one person wrote is rendered
   in another person's browser, so it is the one place where an escaping mistake
   is an account takeover rather than a broken layout. The structural markup is
   built with createElement; only the chrome uses template strings, and no
   server value is ever interpolated into one.
   =========================================================================== */

const LiveChat = (function () {

  const API = '/api/customer/chat';
  const PAGE = 30;

  const state = {
    root: null,
    panel: null,
    thread: null,
    input: null,
    sendBtn: null,
    badge: null,
    conversation: null,
    messages: [],
    open: false,
    loading: false,
    loadingOlder: false,
    exhausted: false,
    booted: false,
    docked: null,
  };

  /* -------------------------------------------------------------------------
     Auth
     -------------------------------------------------------------------------
     The customer session lives in the shared `jpc_*` namespace that auth.js
     owns. This reads it through auth.js's own accessor when that file is
     present and falls back to the key directly when it is not, so the widget
     can render on a page that has not loaded the whole auth bundle. */
  function token() {
    try {
      if (typeof getCustomerAuth === 'function') {
        const auth = getCustomerAuth();
        return (auth && auth.access) || null;
      }
      return localStorage.getItem('jpc_access');
    } catch (e) {
      return null;   /* private mode, storage blocked */
    }
  }

  function signedIn() { return Boolean(token()); }

  async function api(path, options) {
    const opts = options || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      opts.headers || {},
    );
    const jwt = token();
    if (jwt) headers.Authorization = 'Bearer ' + jwt;

    const response = await fetch(API + path, Object.assign({}, opts, { headers }));
    if (response.status === 204) return null;
    let payload = null;
    try { payload = await response.json(); } catch (e) { /* empty body */ }
    if (!response.ok) {
      const error = new Error((payload && payload.detail) || ('HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  /* -------------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------------- */
  const ICONS = {
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
    tick: '<path d="M20 6 9 17l-5-5"/>',
    ticks: '<path d="M18 7 9.4 15.6 6 12.2"/><path d="M22 7l-8.6 8.6-.9-.9"/>',
  };
  const svg = (paths, cls) =>
    '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : '') + '>'
    + paths + '</svg>';

  function timeLabel(iso) {
    if (!iso) return '';
    const when = new Date(iso);
    if (isNaN(when)) return '';
    return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** One message row. Structure built as elements; text set with textContent. */
  function messageEl(message) {
    if (message.message_type === 'system') {
      const row = document.createElement('div');
      row.className = 'lc-system';
      row.textContent = message.body || '';
      return row;
    }

    const mine = message.sender_type === 'customer';
    const row = document.createElement('div');
    row.className = 'lc-msg ' + (mine ? 'lc-msg-out' : 'lc-msg-in');
    if (message.deleted_at) row.classList.add('lc-msg-deleted');
    if (message.pending) row.classList.add('lc-msg-pending');
    if (message.failed) row.classList.add('lc-msg-failed');
    if (message.message_id) row.dataset.messageId = String(message.message_id);
    if (message.client_msg_id) row.dataset.clientMsgId = message.client_msg_id;

    const bubble = document.createElement('div');
    bubble.className = 'lc-bubble';
    /* textContent, not innerHTML. See the module header. */
    bubble.textContent = message.deleted_at
      ? 'This message was deleted'
      : (message.body || '');
    row.appendChild(bubble);

    const meta = document.createElement('div');
    meta.className = 'lc-meta';
    if (!mine && message.sender_name) {
      const who = document.createElement('span');
      who.className = 'lc-sender';
      who.textContent = message.sender_name;
      meta.appendChild(who);
    }
    const time = document.createElement('span');
    time.textContent = message.pending ? 'Sending…' : timeLabel(message.created_at);
    meta.appendChild(time);

    if (mine && !message.pending && !message.failed) {
      const receipt = document.createElement('span');
      receipt.className = 'lc-receipt' + (message.read_at ? ' lc-receipt-read' : '');
      receipt.innerHTML = message.read_at ? svg(ICONS.ticks) : svg(ICONS.tick);
      receipt.title = message.read_at ? 'Read' : 'Sent';
      meta.appendChild(receipt);
    }
    if (message.failed) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'lc-retry';
      retry.textContent = 'Not sent — retry';
      retry.addEventListener('click', () => resend(message));
      meta.appendChild(retry);
    }
    row.appendChild(meta);
    return row;
  }

  function renderThread() {
    const thread = state.thread;
    if (!thread) return;
    thread.textContent = '';

    if (state.loading) {
      const skeleton = document.createElement('div');
      skeleton.className = 'lc-skel';
      skeleton.innerHTML = '<div class="lc-skel-row"></div><div class="lc-skel-row"></div>'
        + '<div class="lc-skel-row"></div>';
      thread.appendChild(skeleton);
      return;
    }

    if (state.error) {
      thread.appendChild(stateEl(
        'We could not load your messages',
        state.error,
        'Try again',
        () => open(),
      ));
      return;
    }

    if (!state.messages.length) {
      thread.appendChild(stateEl(
        'Need help?',
        'Our travel experts are here. Send a message and we will reply.',
      ));
      return;
    }

    const fragment = document.createDocumentFragment();
    state.messages.forEach(m => fragment.appendChild(messageEl(m)));
    thread.appendChild(fragment);
  }

  function stateEl(title, body, actionLabel, onAction) {
    const wrap = document.createElement('div');
    wrap.className = 'lc-state';
    const heading = document.createElement('div');
    heading.className = 'lc-state-title';
    heading.textContent = title;
    wrap.appendChild(heading);
    const text = document.createElement('div');
    text.textContent = body;
    wrap.appendChild(text);
    if (actionLabel) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lc-retry';
      button.textContent = actionLabel;
      button.addEventListener('click', onAction);
      wrap.appendChild(button);
    }
    return wrap;
  }

  function paintHeader() {
    const sub = state.panel && state.panel.querySelector('.lc-head-sub');
    if (!sub) return;
    const conversation = state.conversation;
    if (conversation && conversation.assigned_admin_name) {
      sub.textContent = 'You are chatting with ' + conversation.assigned_admin_name;
    } else if (conversation && conversation.status === 'waiting') {
      sub.textContent = 'Connecting you to an agent…';
    } else {
      sub.textContent = 'Our travel experts are available 24/7.';
    }
  }

  function paintBadge() {
    if (!state.badge) return;
    const count = (state.conversation && state.conversation.unread_count) || 0;
    state.badge.textContent = count > 9 ? '9+' : String(count);
    state.badge.hidden = count === 0;
  }

  /** Pin to the newest message. Called after any append. */
  function scrollToBottom() {
    if (!state.thread) return;
    state.thread.scrollTop = state.thread.scrollHeight;
  }

  /* -------------------------------------------------------------------------
     Data
     ------------------------------------------------------------------------- */
  async function load() {
    state.loading = true;
    state.error = null;
    renderThread();
    try {
      const data = await api('/conversation');
      state.conversation = data.conversation;
      state.messages = data.messages;
      state.exhausted = data.messages.length < PAGE;
      state.loading = false;
      renderThread();
      paintHeader();
      paintBadge();
      scrollToBottom();
      markRead();
    } catch (error) {
      state.loading = false;
      state.error = error.status === 401
        ? 'Please sign in again to continue your conversation.'
        : 'Check your connection and try again.';
      renderThread();
    }
  }

  /** Older history, fetched when the reader reaches the top. */
  async function loadOlder() {
    if (state.loadingOlder || state.exhausted || !state.messages.length) return;
    const oldest = state.messages.find(m => m.message_id);
    if (!oldest) return;
    state.loadingOlder = true;
    const thread = state.thread;
    const previousHeight = thread.scrollHeight;
    try {
      const older = await api('/messages?limit=' + PAGE + '&before_id=' + oldest.message_id);
      if (!older.length) {
        state.exhausted = true;
        return;
      }
      state.messages = older.concat(state.messages);
      renderThread();
      /* ANCHOR THE VIEWPORT. Prepending rows moves everything down by their
         height; without restoring the delta the reader is thrown to a random
         point in the history they were part-way through reading. */
      thread.scrollTop = thread.scrollHeight - previousHeight;
    } catch (error) {
      /* Silent: the reader still has everything already loaded, and an error
         banner over a scroll gesture they may not have meant is worse. */
    } finally {
      state.loadingOlder = false;
    }
  }

  async function markRead() {
    const newest = [...state.messages].reverse().find(m => m.message_id && m.sender_type === 'admin');
    if (!newest) return;
    try {
      const result = await api('/read', {
        method: 'POST',
        body: JSON.stringify({ up_to_message_id: newest.message_id }),
      });
      if (state.conversation) state.conversation.unread_count = result.unread_count;
      paintBadge();
    } catch (error) { /* a badge that stays lit is not worth an error state */ }
  }

  function newClientId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c' + Date.now() + Math.random().toString(16).slice(2);
  }

  async function send() {
    const input = state.input;
    if (!input) return;
    const body = input.value.trim();
    if (!body) return;

    /* OPTIMISTIC. The bubble appears now, at reduced opacity, and is reconciled
       when the server answers. Waiting for the round trip before showing
       anything is what makes a chat feel broken on a slow connection. */
    const pending = {
      client_msg_id: newClientId(),
      sender_type: 'customer',
      message_type: 'text',
      body: body,
      created_at: new Date().toISOString(),
      pending: true,
    };
    state.messages.push(pending);
    input.value = '';
    autoGrow();
    renderThread();
    scrollToBottom();

    await deliver(pending);
  }

  async function deliver(pending) {
    /* SOCKET FIRST, REST AS THE SAFETY NET.
       If the socket is open the message goes over it and is reconciled by the
       `message_ack` frame. If no ack arrives within 8 seconds — a half-open
       connection that has not yet reported itself closed, which is the normal
       state of a phone that just lost signal — the same message is retried
       over REST.

       Sending twice is SAFE and that is not an accident: both paths carry the
       same client_msg_id, and the unique index behind it means the second
       attempt returns the first one's row instead of creating a duplicate.
       The idempotency key is what makes this fallback possible at all. */
    if (socketSend('send_message', {
      body: pending.body, client_msg_id: pending.client_msg_id,
    })) {
      clearTimeout(pending.fallbackTimer);
      pending.fallbackTimer = setTimeout(() => {
        if (!pending.message_id) deliverRest(pending);
      }, 8000);
      return;
    }
    return deliverRest(pending);
  }

  async function deliverRest(pending) {
    try {
      const result = await api('/messages', {
        method: 'POST',
        body: JSON.stringify({ body: pending.body, client_msg_id: pending.client_msg_id }),
      });
      const index = state.messages.indexOf(pending);
      if (index !== -1) state.messages[index] = result.message;
      renderThread();
      scrollToBottom();
    } catch (error) {
      pending.pending = false;
      pending.failed = true;
      renderThread();
    }
  }

  function resend(message) {
    message.failed = false;
    message.pending = true;
    renderThread();
    /* The same client_msg_id goes back up. The server stores it once however
       many times this is pressed — that is what the idempotency key is for. */
    deliver(message);
  }


  /* -------------------------------------------------------------------------
     The socket (slice 3)
     -------------------------------------------------------------------------
     REST DOES NOT GO AWAY. The socket is how messages ARRIVE; sending still
     falls back to REST whenever the socket is not open, because a customer
     whose connection just dropped is exactly the customer who most needs their
     message to go. Both paths call the same server code, so a message sent
     either way is the same row with the same idempotency key.

     THE GAP FETCH IS THE PART THAT IS EASY TO FORGET. Reconnecting restores
     the pipe, not the messages that flowed while it was shut. Every successful
     reconnect asks `/messages?after_id=<newest known>` and merges. Without it
     reconnect *looks* like it works, and silently loses the reply that arrived
     during the outage — which is the one message the customer was waiting for.
     ------------------------------------------------------------------------- */
  const socket = {
    ws: null,
    attempt: 0,
    timer: null,
    heartbeat: null,
    typingSent: false,
    typingTimer: null,
    wanted: false,
  };

  function socketUrl(ticket) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return scheme + '//' + location.host + API + '/ws?ticket=' + encodeURIComponent(ticket);
  }

  async function connect() {
    if (!signedIn() || socket.ws) return;
    socket.wanted = true;
    let ticket;
    try {
      const issued = await api('/ws-ticket', { method: 'POST' });
      ticket = issued && issued.ticket;
    } catch (error) {
      scheduleReconnect();
      return;
    }
    if (!ticket) { scheduleReconnect(); return; }

    let ws;
    try {
      ws = new WebSocket(socketUrl(ticket));
    } catch (error) {
      scheduleReconnect();
      return;
    }
    socket.ws = ws;

    ws.onopen = () => {
      socket.attempt = 0;
      setBanner(null);
      /* Anything that arrived while the socket was down. */
      gapFetch();
      socket.heartbeat = setInterval(() => socketSend('ping', {}), 25000);
    };

    ws.onmessage = event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch (e) { return; }
      handleFrame(frame.event, frame.data || {});
    };

    ws.onclose = event => {
      clearInterval(socket.heartbeat);
      socket.ws = null;
      /* 4401 is a spent or expired ticket. Reconnecting gets a fresh one, so
         it is retried like any other drop — but if the SESSION is gone the
         ticket request will 401 and the retry loop backs off on that instead. */
      if (socket.wanted) {
        setBanner('Reconnecting…');
        scheduleReconnect();
      }
    };

    ws.onerror = () => { /* onclose always follows; handled there */ };
  }

  function disconnect() {
    socket.wanted = false;
    clearTimeout(socket.timer);
    clearInterval(socket.heartbeat);
    if (socket.ws) {
      const ws = socket.ws;
      socket.ws = null;
      try { ws.close(1000); } catch (e) { /* already gone */ }
    }
  }

  /** Exponential backoff with jitter, capped at 30s.
   *
   *  Jitter matters more than the curve: without it, every client dropped by
   *  the same restart reconnects on the same schedule and the server is hit by
   *  the whole population at once, repeatedly. */
  function scheduleReconnect() {
    if (!socket.wanted) return;
    clearTimeout(socket.timer);
    socket.attempt = Math.min(socket.attempt + 1, 6);
    const base = Math.min(1000 * Math.pow(2, socket.attempt - 1), 30000);
    const delay = base * (0.7 + Math.random() * 0.6);
    socket.timer = setTimeout(connect, delay);
  }

  function socketOpen() {
    return socket.ws && socket.ws.readyState === WebSocket.OPEN;
  }

  function socketSend(event, data) {
    if (!socketOpen()) return false;
    try {
      socket.ws.send(JSON.stringify({ event: event, data: data }));
      return true;
    } catch (error) {
      return false;
    }
  }

  async function gapFetch() {
    const newest = [...state.messages].reverse().find(m => m.message_id);
    if (!newest) { load(); return; }
    try {
      const missed = await api('/messages?limit=100&after_id=' + newest.message_id);
      if (!missed.length) return;
      missed.forEach(mergeMessage);
      renderThread();
      scrollToBottom();
      if (state.open) markRead();
    } catch (error) { /* the next reconnect tries again */ }
  }

  /** Insert or replace, keyed on message_id then client_msg_id.
   *
   *  Both keys are needed: the socket echo of our own message carries the id we
   *  do not have yet, and the optimistic bubble carries the client id the
   *  server echoes back. Matching on only one of them duplicates every message
   *  the sender sees. */
  function mergeMessage(incoming) {
    const index = state.messages.findIndex(m =>
      (incoming.message_id && m.message_id === incoming.message_id)
      || (incoming.client_msg_id && m.client_msg_id === incoming.client_msg_id));
    if (index === -1) state.messages.push(incoming);
    else state.messages[index] = incoming;
  }

  function handleFrame(event, data) {
    if (event === 'receive_message') {
      mergeMessage(data);
      renderThread();
      /* Only follow the conversation down if the reader is already at the
         bottom. Yanking someone back while they are reading history is the
         rudest thing a chat widget can do. */
      if (atBottom()) scrollToBottom();
      if (state.open && data.sender_type === 'admin') markRead();
      notify(data);
      return;
    }
    if (event === 'typing') {
      if (data.actor !== 'customer') showTyping(data.is_typing);
      return;
    }
    if (event === 'read_receipt' && data.by === 'admin') {
      state.messages.forEach(m => {
        if (m.message_id && m.message_id <= data.up_to_message_id
            && m.sender_type === 'customer' && !m.read_at) {
          m.read_at = new Date().toISOString();
        }
      });
      renderThread();
      return;
    }
    if (event === 'message_ack') {
      const pending = state.messages.find(m => m.client_msg_id === data.client_msg_id);
      if (pending) {
        clearTimeout(pending.fallbackTimer);
        if (!pending.message_id) {
          pending.message_id = data.message_id;
          pending.pending = false;
          renderThread();
        }
      }
      return;
    }
    if (event === 'joined') {
      if (state.conversation) {
        state.conversation.status = data.status;
        state.conversation.assigned_admin_name = data.assigned_admin_name;
        paintHeader();
      }
      return;
    }
    if (event === 'error' && data.code === 'rate_limited') {
      setBanner('You are sending messages too quickly.');
      setTimeout(() => setBanner(null), 4000);
    }
  }

  function atBottom() {
    const t = state.thread;
    if (!t) return true;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 60;
  }

  function showTyping(on) {
    if (!state.thread) return;
    let row = state.thread.querySelector('.lc-typing');
    if (!on) { if (row) row.remove(); return; }
    if (row) return;
    row = document.createElement('div');
    row.className = 'lc-msg lc-msg-in lc-typing';
    row.innerHTML = '<div class="lc-bubble lc-dots"><i></i><i></i><i></i></div>';
    state.thread.appendChild(row);
    if (atBottom()) scrollToBottom();
  }

  function setBanner(text) {
    if (!state.panel) return;
    let banner = state.panel.querySelector('.lc-banner');
    if (!text) { if (banner) banner.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'lc-banner';
      state.panel.insertBefore(banner, state.thread);
    }
    banner.textContent = text;
  }

  /** Browser notification, only when the panel is not the thing being read. */
  function notify(message) {
    if (message.sender_type !== 'admin') return;
    if (state.open && document.visibilityState === 'visible') return;
    if (state.conversation) {
      state.conversation.unread_count = (state.conversation.unread_count || 0) + 1;
      paintBadge();
    }
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification(message.sender_name || 'JackpotsWorld Support', {
          body: (message.body || '').slice(0, 140),
          tag: 'jw-chat',
        });
      }
    } catch (e) { /* notifications unavailable or blocked */ }
  }

  /** Typing, debounced. One frame on the first keystroke, one when it stops. */
  function onTyping() {
    if (!socket.typingSent) {
      socket.typingSent = socketSend('typing_start', {});
    }
    clearTimeout(socket.typingTimer);
    socket.typingTimer = setTimeout(() => {
      socketSend('typing_stop', {});
      socket.typingSent = false;
    }, 2500);
  }

  /* -------------------------------------------------------------------------
     Building the DOM
     ------------------------------------------------------------------------- */
  function panelHtml() {
    return '<div class="lc-head">'
      + '<div class="lc-head-mark" aria-hidden="true">JW</div>'
      + '<div class="lc-head-text">'
      + '<div class="lc-head-title">Support Center</div>'
      + '<div class="lc-head-sub">Our travel experts are available 24/7.</div>'
      + '</div>'
      + '<button type="button" class="lc-head-close" data-lc-close aria-label="Close chat">'
      + svg(ICONS.close) + '</button>'
      + '</div>'
      + '<div class="lc-thread" data-lc-thread role="log" aria-live="polite" aria-label="Conversation"></div>'
      + '<form class="lc-composer" data-lc-form>'
      + '<label class="lc-sr" for="lcInput">Message</label>'
      + '<textarea class="lc-input" id="lcInput" data-lc-input rows="1"'
      + ' placeholder="Type your message…" maxlength="4000"></textarea>'
      + '<button type="submit" class="lc-send" data-lc-send aria-label="Send message">'
      + svg(ICONS.send) + '</button>'
      + '</form>';
  }

  function wire(root, docked) {
    state.root = root;
    state.panel = root.querySelector('[data-lc-panel]');
    state.thread = root.querySelector('[data-lc-thread]');
    state.input = root.querySelector('[data-lc-input]');
    state.sendBtn = root.querySelector('[data-lc-send]');
    state.badge = root.querySelector('[data-lc-badge]');

    const launcher = root.querySelector('[data-lc-launcher]');
    if (launcher) launcher.addEventListener('click', () => open());

    const close = root.querySelector('[data-lc-close]');
    if (close) close.addEventListener('click', () => hide());

    const form = root.querySelector('[data-lc-form]');
    form.addEventListener('submit', e => { e.preventDefault(); send(); });

    state.input.addEventListener('input', () => { autoGrow(); onTyping(); });
    state.input.addEventListener('keydown', e => {
      /* Enter sends, Shift+Enter is a newline — what every messenger does, and
         what a customer pasting a multi-line itinerary needs. */
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    state.thread.addEventListener('scroll', () => {
      if (state.thread.scrollTop < 40) loadOlder();
    });

    if (!docked) {
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && state.open) hide();
      });
    }

    /* Not a poll — a refresh when the reader comes back to the tab. Slice 3
       replaces this with the socket. */
    window.addEventListener('focus', () => { if (state.open) load(); });
  }

  function autoGrow() {
    const input = state.input;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    if (state.sendBtn) state.sendBtn.disabled = !input.value.trim();
  }

  /* -------------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------------- */
  function mount() {
    if (state.booted || !signedIn()) return null;
    const root = document.createElement('div');
    root.className = 'lc-root';
    root.innerHTML =
      '<button type="button" class="lc-launcher" data-lc-launcher aria-label="Chat with support">'
      + svg(ICONS.chat)
      + '<span class="lc-badge" data-lc-badge hidden>0</span>'
      + '</button>'
      + '<section class="lc-panel" data-lc-panel hidden aria-label="Support chat">'
      + panelHtml() + '</section>';
    document.body.appendChild(root);
    wire(root, false);
    state.booted = true;
    return root;
  }

  /** Support Center: THE SAME PANEL, RELOCATED — not a second one.
   *
   *  This used to build a fresh root inside the container, which left two
   *  `.lc-root` elements on the page sharing one `state` object. The second
   *  mount overwrote `state.panel`, `state.thread` and `state.input`, so the
   *  floating launcher — still visible, still bound — opened the DOCKED panel
   *  inside a closed modal and appeared to do nothing.
   *
   *  Moving the one panel is what "one component in two places" actually
   *  means: one DOM tree, one state, one conversation, and no way for the two
   *  to disagree because there is only ever one of them.
   */
  function mountInto(container) {
    if (!container) return null;
    if (!state.booted) mount();
    if (!state.panel) return null;

    container.textContent = '';
    /* The container becomes the root: it needs `lc-root` for the tokens and
       `lc-docked` for the layout, because the panel is no longer inside the
       floating root that carried them. */
    container.classList.add('lc-root', 'lc-docked');
    container.appendChild(state.panel);
    state.docked = container;
    state.panel.hidden = false;
    if (state.root) state.root.classList.add('lc-open');   /* hides the launcher */
    state.open = true;
    autoGrow();
    load();
    connect();
    return container;
  }

  /** Put the panel back on the page. Called when Support Center closes. */
  function undock() {
    if (!state.docked || !state.panel || !state.root) return;
    state.root.appendChild(state.panel);
    state.docked.classList.remove('lc-root', 'lc-docked');
    state.docked = null;
    state.panel.hidden = true;
    state.root.classList.remove('lc-open');
    state.open = false;
  }

  function open() {
    if (!state.panel) return;
    state.panel.hidden = false;
    if (state.root) state.root.classList.add('lc-open');
    state.open = true;
    autoGrow();
    load();
    connect();
    if (state.input) state.input.focus();
  }

  function hide() {
    /* A docked panel has no close affordance of its own — it is closed by
       closing the Account Center, which calls undock(). */
    if (!state.panel || state.docked) return;
    state.panel.hidden = true;
    if (state.root) state.root.classList.remove('lc-open');
    state.open = false;
    /* The socket stays OPEN after the panel closes: that is what makes the
       unread badge light up while the customer is reading another page. It is
       torn down only on sign-out or navigation. */
  }

  function autoMount() {
    if (document.querySelector('[data-live-chat]')) mount();
  }

  document.addEventListener('DOMContentLoaded', autoMount);
  if (document.readyState !== 'loading') autoMount();

  return { mount, mountInto, undock, open, hide, isSignedIn: signedIn };
})();
