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

  /* -------------------------------------------------------------------------
     Attachments
     -------------------------------------------------------------------------
     Everything here mirrors the customer widget, for a reason that is not
     symmetry for its own sake: the two sides render the same rows out of the
     same table, and a file that displays as a photo to the customer and as a
     grey box to the agent makes them describe different screens to each other
     while trying to solve a problem. */
  const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
  const MAX_BYTES = 10 * 1024 * 1024;
  const blobs = new Map();

  function readableSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* Fetched with the admin's own auth header and shown from a blob. The same
     reason as the customer side: <img src> cannot send Authorization, and a
     token in the query string ends up in proxy logs. */
  async function fetchBlob(file) {
    if (blobs.has(file.attachment_id)) return blobs.get(file.attachment_id);
    const response = await fetch(API + '/attachments/' + file.attachment_id, {
      headers: typeof authHeaders === 'function' ? authHeaders() : {},
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const url = URL.createObjectURL(await response.blob());
    blobs.set(file.attachment_id, url);
    return url;
  }

  async function saveFile(file) {
    try {
      const url = await fetchBlob(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.file_name || 'attachment';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      alert('That file could not be downloaded.');
    }
  }

  function attachmentEl(file) {
    const isImage = /^image\//.test(file.mime_type || '');
    if (isImage) {
      const wrap = document.createElement('div');
      wrap.className = 'als-photo';
      const img = document.createElement('img');
      img.alt = file.file_name || 'Photo';
      img.loading = 'lazy';
      wrap.appendChild(img);
      wrap.addEventListener('click', () => saveFile(file));
      fetchBlob(file).then(url => { img.src = url; }).catch(() => {
        wrap.classList.add('als-photo-failed');
        img.alt = 'This photo could not be loaded';
      });
      return wrap;
    }
    const link = document.createElement('a');
    link.className = 'als-file';
    link.href = '#';
    const name = document.createElement('span');
    name.className = 'als-file-name';
    name.textContent = file.file_name || 'Attachment';
    const size = document.createElement('span');
    size.className = 'als-file-size';
    size.textContent = readableSize(file.file_size);
    link.appendChild(name);
    link.appendChild(size);
    link.addEventListener('click', e => { e.preventDefault(); saveFile(file); });
    return link;
  }

  /** Send a file to the customer, or attach one to an internal note.
   *
   *  `isInternal` rides on the same multipart form as the file. The two-button
   *  composer applies here too: an agent who meant to file a screenshot
   *  privately and sent it to the customer has done something they cannot take
   *  back, and a checkbox is not enough friction for that.
   */
  async function upload(file, isInternal) {
    if (!file || !state.current) return;
    if (file.size > MAX_BYTES) { alert('Files must be 10 MB or smaller.'); return; }
    const form = new FormData();
    form.append('file', file);
    if (isInternal) form.append('is_internal', 'true');
    setStatus('Uploading ' + file.name + '\u2026');
    try {
      const response = await fetch(
        API + '/conversations/' + state.current.conversation_id + '/attachments',
        {
          method: 'POST',
          /* No Content-Type: the browser sets the multipart boundary. */
          headers: typeof authHeaders === 'function' ? authHeaders() : {},
          body: form,
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error((payload && payload.detail) || 'Upload failed');
      /* Nothing is appended: it arrives over the socket like every other
         message, so one path renders the thread. */
    } catch (error) {
      alert('Could not send that file: ' + error.message);
    } finally {
      paintActions();
    }
  }

  /* A short two-note chime when a customer message lands in a thread the agent
     is not looking at. An agent works with this console open behind a booking
     screen all day; silence is how a waiting customer goes unnoticed. */
  let audio = null;

  function chime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audio = audio || new Ctx();
      if (audio.state === 'suspended') audio.resume();
      const now = audio.currentTime;
      [[784, 0], [1046.5, 0.1]].forEach(function (note) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = note[0];
        gain.gain.setValueAtTime(0.0001, now + note[1]);
        gain.gain.exponentialRampToValueAtTime(0.06, now + note[1] + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note[1] + 0.15);
        osc.connect(gain).connect(audio.destination);
        osc.start(now + note[1]);
        osc.stop(now + note[1] + 0.2);
      });
    } catch (e) { /* no audio; the badge still moves */ }
  }

  /* =========================================================================
     Voice calling (CR-10)
     =========================================================================
     The incoming-call popup is the reason the agent socket subscribes to its
     own channel. An agent is almost never looking at the thread a customer
     rings from — that is what a call is for — so the invitation cannot ride the
     per-conversation channels the rest of this console uses.

     ONE CALL AT A TIME, deliberately. An agent already on a call gets
     `call_busy` from the server rather than a second popup over the first; a
     console that stacked invitations would have an agent answering one
     customer while another listens to them fumbling.
     ========================================================================= */
  const call = {
    id: null,
    status: null,
    conversationId: null,
    customerName: null,
    direction: null,
    connectedAt: null,
    timer: null,
    iceServers: null,
  };

  const CALL_LABELS = {
    calling: 'Calling\u2026', ringing: 'Ringing\u2026', accepted: 'Connecting\u2026',
    connected: 'Connected', ended: 'Call ended', rejected: 'Declined',
    missed: 'No answer', cancelled: 'Cancelled by customer', busy: 'Busy',
    failed: 'Call failed',
  };
  const CALL_LOG_LABELS = {
    ended: 'Completed', missed: 'Missed', rejected: 'Declined',
    cancelled: 'Cancelled', busy: 'Busy', failed: 'Failed',
  };
  const CALL_FRAMES = [
    'incoming_call', 'call_status', 'call_accepted', 'call_busy', 'call_taken',
    'call_cancelled', 'offer', 'answer', 'ice_candidate',
  ];

  async function iceServers() {
    const config = await api('/ice');
    if (config && config.turn_configured === false) {
      console.warn(
        'JackpotsWorld: no TURN server configured. Calls will fail between peers '
        + 'with no direct network path.'
      );
    }
    return (config && config.iceServers) || [];
  }

  function callHandlers() {
    return {
      onConnected: () => socketSend('call_connected', { call_id: call.id }),
      onReconnecting: () => setCallNote('Reconnecting\u2026'),
      onRestored: () => {
        setCallNote('Connection restored');
        setTimeout(() => { if (call.status === 'connected') setCallNote(null); }, 2600);
      },
      onOutput: info => {
        setCallNote('Audio: ' + (info && info.label ? info.label : 'switched'));
        setTimeout(() => { if (call.status === 'connected') setCallNote(null); }, 2000);
      },
      onQuality: q => setCallNote(q.quality === 'poor' ? 'Poor connection' : null),
      onFailed: info => {
        socketSend('call_failed', { call_id: call.id, reason: (info && info.code) || 'failed' });
        endCallUi('failed');
      },
      onError: info => setCallNote(info && info.message),
      onMute: () => paintCall(),
    };
  }

  /** Answer the invitation on screen. */
  async function acceptCall() {
    if (!call.id) return;
    setCallNote('Checking your microphone\u2026');
    try {
      call.iceServers = call.iceServers || await iceServers();
      await JWCall.prepare({
        callId: call.id, role: 'callee', send: socketSend,
        handlers: callHandlers(), iceServers: call.iceServers,
      });
    } catch (err) {
      /* The customer is told immediately rather than left ringing while the
         agent hunts for a headset. */
      socketSend('call_reject', { call_id: call.id });
      setCallNote(err.message);
      endCallUi('failed');
      return;
    }
    setCallNote(null);
    socketSend('call_accept', { call_id: call.id });
  }

  function rejectCall() {
    if (call.id) socketSend('call_reject', { call_id: call.id });
    endCallUi('rejected');
  }

  function hangUp() {
    if (!call.id) { endCallUi(null); return; }
    const live = call.status === 'connected' || call.status === 'accepted';
    socketSend(live ? 'call_end' : 'call_cancel', { call_id: call.id });
    endCallUi('ended');
  }

  /** The agent calling a customer back. */
  async function startCall() {
    if (call.id || !state.current) return;
    call.conversationId = state.current.conversation_id;
    call.direction = 'admin_to_customer';
    call.customerName = state.current.customer_name || 'Customer';
    call.status = 'calling';
    showCallCard(true);
    paintCall();
    try {
      call.iceServers = await iceServers();
      await JWCall.prepare({
        callId: null, role: 'caller', send: socketSend,
        handlers: callHandlers(), iceServers: call.iceServers,
      });
    } catch (err) {
      setCallNote(err.message);
      endCallUi('failed');
      return;
    }
    socketSend('call_request', { conversation_id: call.conversationId });
  }

  function endCallUi(finalStatus) {
    JWCall.reset();
    stopCallTimer();
    call.id = null;
    call.connectedAt = null;
    call.status = finalStatus;
    paintCall();
    setTimeout(() => {
      if (!call.id) {
        showCallCard(false);
        call.status = null; call.direction = null;
        if (state.current) loadCallLog(state.current.conversation_id);
      }
    }, finalStatus ? 2400 : 0);
  }

  async function handleCallFrame(event, data) {
    if (event === 'incoming_call') {
      if (call.id) return true;      /* already on one; the server sends busy */
      call.id = data.call_id;
      call.status = 'ringing';
      call.direction = 'customer_to_admin';
      call.conversationId = data.conversation_id;
      call.customerName = data.customer_name || 'Customer';
      showCallCard(true);
      paintCall();
      /* A RING, NOT A BEEP. chime() was one two-note blip — the same one a chat
         message plays — so an agent looking at another tab heard it once and
         missed the call. This keeps ringing until it is dealt with. */
      JWCall.startRinging();
      call.notification = JWCall.notifyIncoming(
        'Incoming call', (data.customer_name || 'A customer') + ' is calling');
      return true;
    }
    if (event === 'call_taken' || event === 'call_busy') {
      /* Another agent got there first, or we are already on a call. Not an
         error, and not worth an alert — the popup just closes. */
      endCallUi(null);
      return true;
    }
    if (event === 'call_status') {
      if (data.status === 'missed' && data.failure_reason === 'callee_offline') {
        setCallNote('This customer is not online. Reply in the chat instead.');
      }
      if (data.call_id !== call.id && !isTerminal(data.status)) return true;
      call.status = data.status;
      call.customerName = data.customer_name || call.customerName;
      if (data.status === 'connected' && !call.connectedAt) {
        call.connectedAt = data.connected_at ? new Date(data.connected_at) : new Date();
        startCallTimer();
        setCallNote(null);
      }
      if (isTerminal(data.status)) { endCallUi(data.status); return true; }
      paintCall();
      return true;
    }
    if (event === 'call_accepted') {
      call.status = 'accepted';
      paintCall();
      if (call.direction === 'admin_to_customer') {
        try { await JWCall.createOffer(); }
        catch (e) { socketSend('call_failed', { call_id: call.id, reason: 'offer_failed' }); }
      }
      return true;
    }
    if (event === 'call_cancelled') { endCallUi(data.status || 'ended'); return true; }
    if (event === 'offer')  { await JWCall.handleOffer(data.payload); return true; }
    if (event === 'answer') { await JWCall.handleAnswer(data.payload); return true; }
    if (event === 'ice_candidate') { await JWCall.handleCandidate(data.payload); return true; }
    return false;
  }

  function isTerminal(s) {
    return ['ended', 'rejected', 'missed', 'cancelled', 'busy', 'failed'].indexOf(s) !== -1;
  }

  function startCallTimer() {
    stopCallTimer();
    call.timer = setInterval(() => {
      const el = document.getElementById('alsCallTimer');
      if (el && call.connectedAt) {
        el.textContent = JWCall.formatDuration((Date.now() - call.connectedAt) / 1000);
      }
    }, 500);
  }

  function stopCallTimer() {
    if (call.timer) { clearInterval(call.timer); call.timer = null; }
  }

  function showCallCard(show) {
    const card = document.getElementById('alsCall');
    if (card) card.hidden = !show;
  }

  function setCallNote(text) {
    const el = document.getElementById('alsCallNote');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  function paintCall() {
    const who = document.getElementById('alsCallWho');
    const status = document.getElementById('alsCallStatus');
    const timer = document.getElementById('alsCallTimer');
    const answering = document.getElementById('alsCallAnswer');
    const liveRow = document.getElementById('alsCallLive');
    const muteBtn = document.getElementById('alsCallMute');
    const viewBtn = document.getElementById('alsCallView');

    const incoming = call.direction === 'customer_to_admin'
      && (call.status === 'ringing' || call.status === 'calling');

    if (who) who.textContent = call.customerName || 'Customer';
    if (status) status.textContent = CALL_LABELS[call.status] || '';
    if (timer) {
      timer.hidden = call.status !== 'connected';
      if (call.status !== 'connected') timer.textContent = '00:00';
    }
    if (answering) answering.hidden = !incoming;
    if (liveRow) liveRow.hidden = incoming;

    /* Same rule as the customer widget: only knowable mid-call, so only asked
       then. An agent on a headset switching to desk speakers is the whole use. */
    const speakerBtn = document.getElementById('alsCallSpeaker');
    if (speakerBtn) {
      if (call.status !== 'connected') {
        speakerBtn.hidden = true;
      } else {
        JWCall.speakerAvailable().then(ok => { speakerBtn.hidden = !ok; });
      }
    }
    if (viewBtn) {
      /* "View Customer" from the brief. Only useful while the popup is over a
         thread the agent has not opened. */
      viewBtn.hidden = !call.conversationId
        || (state.current && state.current.conversation_id === call.conversationId);
    }
    if (muteBtn) {
      const muted = JWCall.isMuted();
      muteBtn.classList.toggle('is-on', muted);
      muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      muteBtn.textContent = muted ? 'Unmute' : 'Mute';
    }
    const callBtn = document.querySelector('[data-als-call]');
    if (callBtn) callBtn.disabled = Boolean(call.id);
  }

  async function loadCallLog(conversationId) {
    const box = document.getElementById('alsCallLog');
    if (!box) return;
    try {
      const body = await api('/conversations/' + conversationId + '/calls?limit=6');
      const rows = (body && body.calls) || [];
      box.textContent = '';
      if (!rows.length) { box.hidden = true; return; }
      const head = document.createElement('div');
      head.className = 'als-calls-head';
      head.textContent = 'Recent calls';
      box.appendChild(head);
      rows.forEach(c => {
        const row = document.createElement('div');
        row.className = 'als-call-row als-call-' + c.status;
        const label = document.createElement('span');
        label.textContent = CALL_LOG_LABELS[c.status] || c.status;
        const when = document.createElement('span');
        when.className = 'als-call-when';
        const d = new Date(c.created_at);
        when.textContent = d.toLocaleDateString([], { day: 'numeric', month: 'short' })
          + ' \u00b7 ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          + (c.duration_seconds != null
            ? ' \u00b7 ' + JWCall.formatDuration(c.duration_seconds) : '');
        row.appendChild(label);
        row.appendChild(when);
        box.appendChild(row);
      });
      box.hidden = false;
    } catch (e) { box.hidden = true; }
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
    const files = (!message.deleted_at && message.attachments) || [];
    if (files.length) {
      bubble.classList.add('als-bubble-file');
      files.forEach(file => bubble.appendChild(attachmentEl(file)));
    }
    if (message.deleted_at || message.body) {
      const text = document.createElement('div');
      text.className = 'als-text';
      /* textContent. The body was typed by a member of the public and is being
         rendered in a dashboard whose session can move money. */
      text.textContent = message.deleted_at
        ? 'This message was deleted'
        : (message.body || '');
      bubble.appendChild(text);
    }
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
      <div class="als-calls" id="alsCallLog" hidden></div>
      <div class="als-bookings" id="alsBookings">
        <div class="als-ctx-loading">Loading bookings\u2026</div>
      </div>`;
    /* Rendered by THIS function rather than left as static markup in
       index.html: renderContext replaces the whole pane's innerHTML on every
       thread switch, so a container declared in the page is destroyed the
       first time an agent opens a conversation. */
    loadCallLog(c.conversation_id);
    loadContext(c.conversation_id);
  }

  /* -------------------------------------------------------------------------
     Booking context
     -------------------------------------------------------------------------
     THE POINT OF THIS PANE. Without it the first four exchanges of every chat
     are the same: what is your booking reference, which trip, has the payment
     gone through, what is your number. The customer told us all of it when they
     booked, and asking again is slow and faintly insulting to someone who
     booked twenty minutes ago.

     Fetched per conversation rather than bundled into the queue response: the
     queue is a list of fifty rows an agent refreshes constantly, and carrying
     six bookings on each would make it many times larger to serve a panel only
     the open conversation shows. */
  async function loadContext(conversationId) {
    const box = document.getElementById('alsBookings');
    if (!box) return;
    try {
      const ctx = await api(`/conversations/${conversationId}/context`);
      renderBookings(box, ctx);
    } catch (error) {
      /* A failure here must not look like "this customer has no bookings" —
         that is a statement an agent would act on. */
      box.innerHTML = '<div class="als-ctx-error">Bookings could not be loaded.</div>';
    }
  }

  function renderBookings(box, ctx) {
    const list = (ctx && ctx.bookings) || [];
    const c = (ctx && ctx.customer) || {};
    const extra = [];
    if (c.customer_code) extra.push(`<dt>Customer</dt><dd>${esc(c.customer_code)}</dd>`);
    if (c.city) extra.push(`<dt>City</dt><dd>${esc(c.city)}</dd>`);

    if (!list.length) {
      box.innerHTML = (extra.length ? `<dl class="als-dl">${extra.join('')}</dl>` : '')
        + '<div class="als-ctx-empty">No bookings on this account yet.</div>';
      return;
    }

    const unpaid = (ctx.totals && ctx.totals.unpaid_count) || 0;
    box.innerHTML = `
      ${extra.length ? `<dl class="als-dl">${extra.join('')}</dl>` : ''}
      <h4 class="als-ctx-h">Recent bookings
        ${unpaid ? `<span class="als-unpaid-pill">${unpaid} unpaid</span>` : ''}
      </h4>
      <ul class="als-bk-list">
        ${list.map(bookingRow).join('')}
      </ul>`;
  }

  const PRODUCT_LABEL = { flight: 'Flight', hotel: 'Hotel', package: 'Package' };

  function bookingRow(b) {
    /* The reference is the first thing on the row and is selectable, because
       the single most common action an agent takes here is copying it into
       another screen. */
    const money = b.total_amount
      ? `${esc(b.currency || 'INR')} ${Number(b.total_amount).toLocaleString('en-IN')}`
      : '';
    const when = b.travel_date
      ? new Date(b.travel_date).toLocaleDateString('en-IN',
          { day: 'numeric', month: 'short', year: 'numeric' })
      : '';
    /* `paid` is the only one worth colouring green. "pending" and "none" are
       different facts — a payment that failed versus one never attempted — and
       an agent needs to be able to say which. */
    const payClass = b.paid ? 'is-paid' : (b.payment_status === 'none' ? 'is-none' : 'is-pending');
    const payLabel = b.paid ? 'Paid'
      : (b.payment_status === 'none' ? 'No payment' : esc(b.payment_status));
    return `
      <li class="als-bk">
        <div class="als-bk-top">
          <span class="als-bk-ref">${esc(b.booking_ref)}</span>
          <span class="als-bk-kind">${esc(PRODUCT_LABEL[b.product] || b.product)}</span>
        </div>
        <div class="als-bk-title">${esc(b.title)}</div>
        ${b.detail ? `<div class="als-bk-detail">${esc(b.detail)}</div>` : ''}
        <div class="als-bk-meta">
          ${when ? `<span>${esc(when)}</span>` : ''}
          ${money ? `<span>${money}</span>` : ''}
          <span class="als-bk-status">${esc(b.status)}</span>
          <span class="als-pay ${payClass}">${payLabel}</span>
        </div>
        ${b.reference_extra
          ? `<div class="als-bk-pnr">PNR ${esc(b.reference_extra)}</div>` : ''}
      </li>`;
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
    if (CALL_FRAMES.indexOf(event) !== -1) {
      /* onmessage cannot await; the handler settles on its own and nothing
         after this line depends on the result. */
      Promise.resolve(handleCallFrame(event, data)).catch(err => {
        console.error('live support: call frame failed', event, err);
        endCallUi('failed');
      });
      return;
    }
    if (event === 'receive_message') {
      const open = state.current && data.conversation_id === state.current.conversation_id;
      if (open) {
        const i = state.messages.findIndex(m => m.message_id === data.message_id);
        if (i === -1) state.messages.push(data); else state.messages[i] = data;
        renderThread();
        if (data.sender_type === 'customer') markRead();
      }
      /* The sound is for a customer message the agent is NOT already reading —
         either in another thread, or in this one with the tab in the
         background. Chiming for a thread that is open and on screen would
         make the console noisy for the agent who is doing the right thing. */
      if (data.sender_type === 'customer'
          && (!open || document.visibilityState !== 'visible')) chime();
      loadQueue();
      return;
    }
    if (event === 'conversation_assigned') {
      /* A chat was routed automatically. Refresh the badges so it appears in
         the right tab, and repaint the header if it is the open one. */
      if (state.current && data.conversation_id === state.current.conversation_id) {
        state.current.assigned_admin_id = data.assigned_admin_id;
        state.current.assigned_admin_name = data.assigned_admin_name;
        state.current.status = data.status;
        paintActions();
        renderContext();
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

    document.getElementById('alsCallAcceptBtn')?.addEventListener('click', () => acceptCall());
    document.getElementById('alsCallRejectBtn')?.addEventListener('click', () => rejectCall());
    document.getElementById('alsCallEndBtn')?.addEventListener('click', () => hangUp());
    document.getElementById('alsCallMute')?.addEventListener('click', () => JWCall.toggleMute());
    document.getElementById('alsCallSpeaker')?.addEventListener('click', () => JWCall.cycleOutput());
    document.getElementById('alsCallView')?.addEventListener('click', () => {
      if (call.conversationId) openConversation(call.conversationId);
    });
    document.querySelector('[data-als-call]')?.addEventListener('click', () => startCall());

    /* A call must not outlive the tab: the customer would be left listening to
       a connection nobody is on. */
    window.addEventListener('beforeunload', () => {
      if (call.id) {
        try { socketSend('call_end', { call_id: call.id }); } catch (e) {}
        JWCall.reset();
      }
    });

    document.getElementById('alsSendBtn')?.addEventListener('click', () => send(false));
    document.getElementById('alsNoteBtn')?.addEventListener('click', () => send(true));

    const picker = document.getElementById('alsFile');
    document.getElementById('alsAttachBtn')?.addEventListener('click', () => {
      /* The button remembers whether the note toggle was held, so one file
         picker serves both destinations without a second control. */
      picker.dataset.internal = '';
      picker.click();
    });
    document.getElementById('alsAttachNoteBtn')?.addEventListener('click', () => {
      picker.dataset.internal = '1';
      picker.click();
    });
    picker?.addEventListener('change', () => {
      const file = picker.files && picker.files[0];
      const isInternal = picker.dataset.internal === '1';
      picker.value = '';   /* so the same file can be chosen twice running */
      upload(file, isInternal);
    });
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
