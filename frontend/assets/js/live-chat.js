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
    /* Whether this page wants the floating bubble at all. Only `autoMount()`
       — which fires on a page carrying `data-live-chat` — turns it on. A page
       that merely docks the panel into Support Center builds the same widget
       on demand and must NOT get a launcher out of it. */
    showLauncher: false,
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
    clip: '<path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.19 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.59-2.6l8.49-8.48"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    phoneOff: '<path d="M10.7 13.3a16 16 0 0 0 4 3l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 5 15.5"/><path d="M2 2l20 20"/><path d="M8.6 3.7A2 2 0 0 0 7.1 2h-3a2 2 0 0 0-2 2.2 19.6 19.6 0 0 0 1 4.3"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 19v3"/>',
    speaker: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
    micOff: '<path d="M2 2l20 20"/><path d="M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M15 10.5V5a3 3 0 0 0-5.9-.7"/><path d="M19 10v1a7 7 0 0 1-10.8 5.9"/><path d="M5 10v1a7 7 0 0 0 2 4.9"/><path d="M12 19v3"/>',
  };

  /* A small, deliberately boring set. A full emoji keyboard is a library plus a
     font-loading problem; these are the ones people actually send to a travel
     desk, and each renders from the system font on Windows, Android and iOS
     with no webfont. Written as escapes rather than literal glyphs so the file
     stays ASCII and cannot be mangled by an editor guessing its encoding. */
  const EMOJI = [
    '\u{1F600}', '\u{1F604}', '\u{1F642}', '\u{1F609}', '\u{1F60A}', '\u{1F607}',
    '\u{1F614}', '\u{1F622}', '\u{1F62D}', '\u{1F633}', '\u{1F644}', '\u{1F914}',
    '\u{1F44D}', '\u{1F44E}', '\u{1F64F}', '\u{1F44C}', '\u{1F44F}', '\u{1F4AF}',
    '\u{2764}\u{FE0F}', '\u{1F525}', '\u{2705}', '\u{274C}', '\u{2757}', '\u{2753}',
    '\u{2708}\u{FE0F}', '\u{1F3E8}', '\u{1F3D6}\u{FE0F}', '\u{1F5FA}\u{FE0F}',
    '\u{1F4C5}', '\u{1F4B3}', '\u{1F4CE}', '\u{1F44B}',
  ];
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
    const files = (!message.deleted_at && message.attachments) || [];
    if (files.length) {
      bubble.classList.add('lc-bubble-file');
      files.forEach(file => bubble.appendChild(attachmentEl(file)));
    }
    if (message.deleted_at || message.body) {
      const text = document.createElement('div');
      text.className = 'lc-text';
      /* textContent, not innerHTML. See the module header. */
      text.textContent = message.deleted_at
        ? 'This message was deleted'
        : (message.body || '');
      bubble.appendChild(text);
    }
    if (message.uploading) {
      const bar = document.createElement('div');
      bar.className = 'lc-progress';
      bar.appendChild(document.createElement('i'));
      bubble.appendChild(bar);
    }
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

  /** One file inside a bubble: a thumbnail for a photo, a row for anything else.
   *
   *  THE IMAGE IS FETCHED WITH THE BEARER TOKEN AND SHOWN FROM A BLOB, not set
   *  as a plain `src`. The download endpoint requires the Authorization header,
   *  which `<img src>` cannot send -- and putting the token in the query string
   *  instead would write it into every proxy log and browser history entry
   *  between here and the server.
   */
  function attachmentEl(file) {
    const isImage = /^image\//.test(file.mime_type || '');
    if (!isImage) {
      const link = document.createElement('a');
      link.className = 'lc-file';
      link.href = '#';
      link.innerHTML = svg(ICONS.doc, 'lc-file-icon');
      const meta = document.createElement('span');
      meta.className = 'lc-file-meta';
      const name = document.createElement('span');
      name.className = 'lc-file-name';
      name.textContent = file.file_name || 'Attachment';
      const size = document.createElement('span');
      size.className = 'lc-file-size';
      size.textContent = readableSize(file.file_size);
      meta.appendChild(name);
      meta.appendChild(size);
      link.appendChild(meta);
      link.addEventListener('click', e => { e.preventDefault(); saveFile(file); });
      return link;
    }

    const wrap = document.createElement('div');
    wrap.className = 'lc-photo';
    const img = document.createElement('img');
    img.alt = file.file_name || 'Photo';
    img.loading = 'lazy';
    wrap.appendChild(img);
    wrap.addEventListener('click', () => saveFile(file));
    fetchBlob(file).then(url => { if (url) img.src = url; }).catch(() => {
      wrap.classList.add('lc-photo-failed');
      img.alt = 'This photo could not be loaded';
    });
    return wrap;
  }

  function readableSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* Object URLs are held for the life of the widget rather than revoked per
     render: a thumbnail still on screen must keep its blob, and the thread
     re-renders on every incoming frame. */
  const blobs = new Map();

  async function fetchBlob(file) {
    if (blobs.has(file.attachment_id)) return blobs.get(file.attachment_id);
    const jwt = token();
    const response = await fetch(API + '/attachments/' + file.attachment_id, {
      headers: jwt ? { Authorization: 'Bearer ' + jwt } : {},
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const url = URL.createObjectURL(await response.blob());
    blobs.set(file.attachment_id, url);
    return url;
  }

  /** Save a file. Goes through a blob because the URL needs an auth header. */
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
      setBanner('That file could not be downloaded. Try again.');
      setTimeout(() => setBanner(null), 4000);
    }
  }

  /* -------------------------------------------------------------------------
     Sending a file
     ------------------------------------------------------------------------- */
  const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
  const MAX_BYTES = 10 * 1024 * 1024;

  /** Upload one file, showing an optimistic bubble throughout.
   *
   *  ALWAYS REST, NEVER THE SOCKET. A WebSocket frame would carry the bytes
   *  base64-encoded down the same connection the conversation is using, which
   *  blocks every other message on that channel for the length of a 10 MB
   *  upload. The server publishes the result either way, so the other side
   *  still hears about it immediately: the transport for the bytes and the
   *  transport for the news do not have to be the same one.
   */
  async function upload(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setBanner('Files must be 10 MB or smaller.');
      setTimeout(() => setBanner(null), 5000);
      return;
    }

    const placeholder = 'local-' + Math.random().toString(36).slice(2);
    const pending = {
      client_msg_id: newClientId(),
      sender_type: 'customer',
      message_type: /^image\//.test(file.type) ? 'image' : 'file',
      body: null,
      created_at: new Date().toISOString(),
      attachments: [{
        attachment_id: placeholder,
        file_name: file.name,
        mime_type: file.type,
        file_size: file.size,
      }],
      pending: true,
      uploading: true,
    };
    /* The local preview is seeded into the blob cache under the placeholder id,
       so the photo appears instantly instead of after a round trip to fetch
       back bytes the browser is already holding. */
    if (pending.message_type === 'image') {
      blobs.set(placeholder, URL.createObjectURL(file));
    }
    state.messages.push(pending);
    renderThread();
    scrollToBottom();

    const form = new FormData();
    form.append('file', file);
    form.append('client_msg_id', pending.client_msg_id);
    try {
      const jwt = token();
      const response = await fetch(API + '/attachments', {
        method: 'POST',
        /* No Content-Type header on purpose: the browser must set the multipart
           boundary itself, and naming the type here strips it. */
        headers: jwt ? { Authorization: 'Bearer ' + jwt } : {},
        body: form,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error((payload && payload.detail) || 'Upload failed');
      mergeMessage(payload.message);
      renderThread();
      scrollToBottom();
    } catch (err) {
      pending.uploading = false;
      pending.pending = false;
      pending.failed = true;
      renderThread();
      setBanner(err.message || 'That file could not be sent.');
      setTimeout(() => setBanner(null), 5000);
    }
  }

  /* -------------------------------------------------------------------------
     The arrival sound
     -------------------------------------------------------------------------
     Synthesised rather than shipped as an mp3: no asset to cache-bust, nothing
     to 404, and no autoplay-blocked <audio> element in the DOM. Two short
     notes, quiet, and only for a message the reader did not send.

     Browsers refuse to start audio before the page has been interacted with,
     so the context is built lazily on the first play and every failure is
     swallowed -- a chat that throws because a sound could not play is worse
     than a silent one.

     Reduced-motion suppresses it too. The setting is nominally about movement,
     but the people who turn it on are asking for a calmer page, and an
     unsolicited noise is not that. */
  let audio = null;

  function chime() {
    try {
      if (window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audio = audio || new Ctx();
      if (audio.state === 'suspended') audio.resume();
      const now = audio.currentTime;
      [[880, 0], [1174.7, 0.11]].forEach(function (note) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = note[0];
        gain.gain.setValueAtTime(0.0001, now + note[1]);
        gain.gain.exponentialRampToValueAtTime(0.07, now + note[1] + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note[1] + 0.16);
        osc.connect(gain).connect(audio.destination);
        osc.start(now + note[1]);
        osc.stop(now + note[1] + 0.2);
      });
    } catch (e) { /* no audio available; not worth a word to the customer */ }
  }

  /** The emoji tray. Built once, then shown and hidden. */
  function toggleEmoji(force) {
    const tray = inPanel('[data-lc-emoji-tray]');
    if (!tray) return;
    const show = force === undefined ? tray.hidden : force;
    if (show && !tray.childElementCount) {
      EMOJI.forEach(glyph => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lc-emoji';
        btn.textContent = glyph;
        /* Inserted at the caret, not appended: someone who clicked back into
           the middle of a sentence meant to put it there. */
        btn.addEventListener('click', () => insertAtCaret(glyph));
        tray.appendChild(btn);
      });
    }
    tray.hidden = !show;
  }

  function insertAtCaret(text) {
    const input = state.input;
    if (!input) return;
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    autoGrow();
  }

  /* =========================================================================
     Voice calling (CR-10)
     =========================================================================
     Signalling rides the chat socket that is already open and already
     authenticated. Media does not: audio goes peer-to-peer over WebRTC, or
     through TURN, and never touches the server.

     WHY THE PANEL IS AN OVERLAY AND NOT A SCREEN
     A call happens *about* a conversation. Replacing the thread with a call
     screen means the customer cannot read the booking reference the agent just
     asked them for. The overlay covers the composer, leaves the messages
     visible, and collapses to a strip once the call connects.
     ========================================================================= */
  const call = {
    id: null,
    status: null,        /* calling | ringing | accepted | connected | ... */
    direction: null,
    agentName: null,
    connectedAt: null,
    timer: null,
    iceServers: null,
    quality: null,
  };

  const CALL_LABELS = {
    calling: 'Calling support\u2026',
    ringing: 'Ringing\u2026',
    accepted: 'Connecting\u2026',
    connected: 'Connected',
    ended: 'Call ended',
    rejected: 'Call declined',
    missed: 'No answer',
    cancelled: 'Call cancelled',
    busy: 'Support is on another call',
    failed: 'Call failed',
  };
  /* NOT ROW STATUSES. The call stays `connected` through a hold and through a
     transfer — that is the point of both — so these are chosen from the last
     frame rather than from `status`. */
  const CALL_LIVE_LABELS = {
    held: 'On Hold',
    transferring: 'Transferring\u2026',
    transferred: 'Transferred',
  };

  /** ICE servers, fetched once per call and never cached across calls.
   *  TURN credentials are short-lived by design; a browser holding a stale one
   *  fails to connect in a way indistinguishable from a network fault. */
  async function iceServers() {
    const config = await api('/ice');
    if (config && config.turn_configured === false) {
      /* Not shown to the customer — they can do nothing about it. Logged so
         that whoever is debugging "some calls never connect" finds the reason
         in the console rather than in a packet capture. */
      console.warn(
        'JackpotsWorld: no TURN server is configured. Calls will fail between '
        + 'peers with no direct network path (common on Indian mobile carriers).'
      );
    }
    return (config && config.iceServers) || [];
  }

  function callHandlers() {
    return {
      onConnected: () => socketSend('call_connected', { call_id: call.id }),
      onReconnecting: () => { setCallNote('Reconnecting\u2026'); },
      /* A DIFFERENT SENTENCE FROM "Connected". Someone who just heard three
         seconds of silence needs to know the call came back rather than being
         left to wonder whether it ever dropped. Cleared after a moment: a
         banner that stays says "something is wrong" long after it is not. */
      onRestored: () => {
        setCallNote('Connection restored');
        setTimeout(() => {
          if (call.status === 'connected' && !call.quality) setCallNote(null);
        }, 2600);
      },
      onOutput: info => {
        setCallNote('Audio: ' + (info && info.label ? info.label : 'switched'));
        setTimeout(() => {
          if (call.status === 'connected' && !call.quality) setCallNote(null);
        }, 2000);
      },
      onQuality: q => {
        call.quality = q.quality;
        setCallNote(q.quality === 'poor' ? 'Poor connection' : null);
      },
      onFailed: info => {
        socketSend('call_failed', { call_id: call.id, reason: (info && info.code) || 'failed' });
        endCallUi('failed');
      },
      onError: info => setCallNote(info && info.message),
      onMute: () => paintCall(),
    };
  }

  /** Press-to-call. Everything that can refuse happens BEFORE anyone is rung. */
  async function startCall() {
    if (call.id) return;
    if (!socketOpen()) {
      setCallNote('You are offline. Reconnect and try again.');
      showCallPanel(true);
      setTimeout(() => { if (!call.id) showCallPanel(false); }, 3500);
      return;
    }
    call.status = 'preparing';
    call.direction = 'customer_to_admin';
    showCallPanel(true);
    paintCall();
    try {
      /* The microphone is requested BEFORE the request goes out. Ringing an
         agent and then discovering the customer has no microphone wastes the
         agent's attention and shows the customer a failure after a delay that
         made it look like a network problem. */
      call.iceServers = await iceServers();
      await JWCall.prepare({
        callId: null, role: 'caller', send: socketSend,
        handlers: callHandlers(), iceServers: call.iceServers,
      });
    } catch (err) {
      call.status = null;
      /* A DENIAL IS RECOVERABLE, so it gets a button rather than a sentence
         that leaves the customer nowhere. Note that nothing here pre-empts the
         browser prompt: getMicrophone() calls getUserMedia() directly and this
         runs only on its rejection. What looks like "blocked before asking" is
         the browser remembering an earlier denial and refusing without showing
         the prompt again — which is exactly the case Try Again cannot fix on
         its own, hence the sentence pointing at browser settings. */
      if (err.code === 'permission_denied') {
        setCallError(
          'Microphone access is required for voice calls. '
          + 'Please allow microphone permission in your browser settings.',
          'Try Again', () => { setCallNote(null); startCall(); },
        );
      } else {
        setCallNote(err.message || 'Your microphone could not be started.');
      }
      paintCall();
      return;
    }
    socketSend('call_request', {});
  }

  /** Answering a call the agent placed. */
  async function acceptCall() {
    if (!call.id) return;
    try {
      call.iceServers = call.iceServers || await iceServers();
      await JWCall.prepare({
        callId: call.id, role: 'callee', send: socketSend,
        handlers: callHandlers(), iceServers: call.iceServers,
      });
    } catch (err) {
      socketSend('call_reject', { call_id: call.id });
      setCallNote(err.message);
      endCallUi('failed');
      return;
    }
    socketSend('call_accept', { call_id: call.id });
  }

  function rejectCall() {
    if (call.id) socketSend('call_reject', { call_id: call.id });
    endCallUi('rejected');
  }

  /** Hang up. `call_cancel` before an answer, `call_end` after — the server
   *  records them as different outcomes, and the customer's log shows the
   *  difference between a call they abandoned and one they had. */
  function hangUp() {
    if (!call.id) { endCallUi(null); return; }
    const connected = call.status === 'connected' || call.status === 'accepted';
    socketSend(connected ? 'call_end' : 'call_cancel', { call_id: call.id });
    endCallUi('ended');
  }

  function endCallUi(finalStatus) {
    JWCall.reset();
    stopCallTimer();
    call.id = null;
    call.live = null;
    call.connectedAt = null;
    call.quality = null;
    call.status = finalStatus;
    paintCall();
    /* The outcome stays on screen briefly. A panel that vanishes the instant a
       call is declined leaves the customer unsure whether it was declined or
       whether the button never worked. */
    setTimeout(() => {
      if (!call.id) { showCallPanel(false); call.status = null; loadCallLog(); }
    }, finalStatus ? 2600 : 0);
  }

  /* -- frames ------------------------------------------------------------- */
  async function handleCallFrame(event, data) {
    if (event === 'incoming_call') {
      /* An agent is calling this customer. */
      call.id = data.call_id;
      call.status = 'ringing';
      call.direction = 'admin_to_customer';
      JWCall.startRinging();
      call.notification = JWCall.notifyIncoming(
        'JackpotsWorld Support', (data.admin_name || 'Support') + ' is calling you');
      call.agentName = data.admin_name;
      showCallPanel(true);
      paintCall();
      chime();
      return true;
    }
    if (event === 'call_hold') {
      call.live = data.on_hold ? 'held' : null;
      if (data.held_by !== 'customer') {
        setCallNote(data.on_hold
          ? 'Your call has been placed on hold. Please stay on the line \u2014 '
            + 'you will hear music until support returns.'
          : 'Support has resumed the call.');
        if (!data.on_hold) setTimeout(() => {
          if (call.status === 'connected') setCallNote(null);
        }, 2600);
      }
      paintCall();
      return;
    }
    if (event === 'call_transfer_failed') {
      /* The handover did not happen and the customer never needs to know why —
         only that the person they were already speaking to is still there. */
      call.live = null;
      setCallNote('Still connected to support.');
      setTimeout(() => {
        if (call.status === 'connected') setCallNote(null);
      }, 2600);
      paintCall();
      return;
    }
    if (event === 'call_renegotiate') {
      /* THE CALL IS BEING HANDED TO ANOTHER AGENT. The customer is NOT asked
         to answer again — they already consented to this call, and a second
         prompt mid-conversation reads as the call having dropped. The peer
         connection is rebuilt in place and the new agent's offer arrives on
         the ordinary path. */
      call.live = 'transferring';
      setCallNote('Connecting you to another support specialist\u2026');
      call.adminName = data.admin_name || call.adminName;
      JWCall.releasePeer();
      JWCall.prepare({
        callId: data.call_id, role: 'callee', send: socketSend,
        handlers: callHandlers(), iceServers: call.iceServers,
      }).catch(() => setCallNote('That transfer could not be completed.'));
      paintCall();
      return;
    }
    if (event === 'call_status') {
      /* "No answer" and "nobody was there to answer" are different facts, and
         the second one is not the customer's fault to sit through. */
      if (data.status === 'missed' && data.failure_reason === 'no_agent_online') {
        setCallNote('No agent is available right now. Send a message instead \u2014 '
                    + 'we reply to every one.');
      }
      call.id = data.status && !isTerminal(data.status) ? data.call_id : null;
      /* THE CALLER LEARNS ITS OWN CALL ID HERE, and nowhere else. `startCall`
         takes the microphone and builds the peer connection before the call
         exists, so it has no id to hand over; this is the first frame that
         carries one. Until JWCall is told, everything it sends — the offer and
         every ICE candidate after it — goes out with `call_id: null`, the relay
         refuses each one as "no such call", and the call connects nowhere while
         both sides still look like a call in progress. */
      if (call.id) JWCall.setCallId(call.id);
      call.status = data.status;
      call.agentName = data.admin_name || call.agentName;
      if (data.status === 'connected' && !call.connectedAt) {
        call.connectedAt = data.connected_at ? new Date(data.connected_at) : new Date();
        startCallTimer();
        /* NAMED, NOT JUST "Connected". Somebody who has been listening to a
           ring for twenty seconds wants to know a person arrived, and the
           status line above them already says the connection is up. */
        setCallNote((call.agentName ? call.agentName : 'A support agent')
                    + ' has joined the call.');
        setTimeout(() => {
          if (call.status === 'connected' && !call.quality && !call.live) {
            setCallNote(null);
          }
        }, 3000);
      }
      if (isTerminal(data.status)) { endCallUi(data.status); return true; }
      showCallPanel(true);
      paintCall();
      return true;
    }
    if (event === 'call_accepted') {
      call.status = 'accepted';
      call.agentName = data.admin_name || call.agentName;
      paintCall();
      /* THE OFFER IS CREATED HERE, not when the call was placed. The callee
         must have a peer connection listening before the offer arrives, or the
         first frame of the negotiation is dropped and the call fails silently
         with both sides showing "connected". */
      if (call.direction === 'customer_to_admin') {
        try { await JWCall.createOffer(); }
        catch (e) {
          /* NEVER SILENT. An offer that fails to build is the difference
             between "no audio" and a reason, and the reason is in `e`. */
          console.error('[JWCall] createOffer failed', e);
          socketSend('call_failed', { call_id: call.id, reason: 'offer_failed' });
        }
      }
      return true;
    }
    if (event === 'call_busy') {
      setCallNote('Support is on another call. Please try again shortly.');
      endCallUi('busy');
      return true;
    }
    if (event === 'call_cancelled') { endCallUi(data.status || 'ended'); return true; }
    if (event === 'offer')  { await JWCall.handleOffer(data.payload); return true; }
    if (event === 'answer') { await JWCall.handleAnswer(data.payload); return true; }
    if (event === 'ice_candidate') { await JWCall.handleCandidate(data.payload); return true; }
    return false;
  }

  /* EVERY EVENT handleCallFrame() ANSWERS HAS TO BE LISTED HERE, or the
     handler for it is dead code: handleFrame() only routes what this list
     names. `call_renegotiate` was missing, which meant a transferred call left
     the customer holding a peer connection that had already been released —
     connected on screen, silent in both ears. */
  const CALL_FRAMES = [
    'incoming_call', 'call_status', 'call_accepted', 'call_busy',
    'call_cancelled', 'offer', 'answer', 'ice_candidate',
    'call_hold', 'call_renegotiate', 'call_transfer_failed',
  ];

  function isTerminal(status) {
    return ['ended', 'rejected', 'missed', 'cancelled', 'busy', 'failed'].indexOf(status) !== -1;
  }

  /* -- the timer ---------------------------------------------------------- */
  /** Find something inside the PANEL, wherever the panel currently lives.
   *
   *  THE BUG THIS EXISTS TO KILL. `mountInto()` moves the panel out of the
   *  floating root and into Support Center — so `state.root.querySelector()`
   *  finds these elements while the widget floats and returns null once it is
   *  docked. Seven call sites did exactly that, which meant the call panel, the
   *  timer, call notes, the call log and the emoji tray were all silently
   *  unreachable in Support Center: the one place voice calling is supposed to
   *  live. Nothing threw; everything just quietly did nothing.
   *
   *  `state.panel` is the element that actually owns them and travels with
   *  them. The launcher and the unread badge stay on `state.root`, because
   *  those really are the floating widget's own.
   */
  function inPanel(selector) {
    return state.panel ? state.panel.querySelector(selector) : null;
  }

  function startCallTimer() {
    stopCallTimer();
    call.timer = setInterval(() => {
      const el = inPanel('[data-lc-call-timer]');
      if (el && call.connectedAt) {
        el.textContent = JWCall.formatDuration((Date.now() - call.connectedAt) / 1000);
      }
    }, 500);
  }

  function stopCallTimer() {
    if (call.timer) { clearInterval(call.timer); call.timer = null; }
  }

  /* -- the panel ---------------------------------------------------------- */
  function showCallPanel(show) {
    const panel = inPanel('[data-lc-call]');
    if (panel) panel.hidden = !show;
  }

  function setCallNote(text) {
    const el = inPanel('[data-lc-call-note]');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  /** A call note with something to press.
   *
   *  Built as elements rather than innerHTML: the only variable part is text
   *  the server or the browser produced, and this panel already renders
   *  customer-supplied message bodies a few pixels away.
   */
  function setCallError(text, actionLabel, onAction) {
    const el = inPanel('[data-lc-call-note]');
    if (!el) return;
    el.textContent = '';
    el.hidden = false;
    const line = document.createElement('div');
    line.textContent = text;
    el.appendChild(line);
    if (actionLabel) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lc-call-retry';
      btn.textContent = actionLabel;
      btn.addEventListener('click', onAction);
      el.appendChild(btn);
    }
  }

  function paintCall() {
    const root = state.root;
    if (!root) return;
    const title = root.querySelector('[data-lc-call-title]');
    const sub = root.querySelector('[data-lc-call-status]');
    const timer = root.querySelector('[data-lc-call-timer]');
    const muteBtn = root.querySelector('[data-lc-call-mute]');
    const answerRow = root.querySelector('[data-lc-call-answer]');
    const liveRow = root.querySelector('[data-lc-call-live]');

    const incoming = call.direction === 'admin_to_customer'
      && (call.status === 'ringing' || call.status === 'calling');

    if (title) {
      title.textContent = incoming
        ? (call.agentName || 'JackpotsWorld Support')
        : (call.agentName || 'JackpotsWorld Support');
    }
    if (sub) {
      sub.textContent = call.status === 'preparing'
        ? 'Checking your microphone\u2026'
        : ((call.live && CALL_LIVE_LABELS[call.live])
           || CALL_LABELS[call.status] || '');
    }
    if (timer) {
      timer.hidden = call.status !== 'connected';
      if (call.status !== 'connected') timer.textContent = '00:00';
    }
    if (muteBtn) {
      const muted = JWCall.isMuted();
      muteBtn.classList.toggle('is-on', muted);
      muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      muteBtn.title = muted ? 'Unmute' : 'Mute';
      muteBtn.innerHTML = svg(muted ? ICONS.micOff : ICONS.mic)
        + '<span>' + (muted ? 'Unmute' : 'Mute') + '</span>';
    }
    if (answerRow) answerRow.hidden = !incoming;
    if (liveRow) liveRow.hidden = incoming;

    /* CHECKED DURING THE CALL, NOT AT MOUNT. `enumerateDevices` only returns
       usable output entries once microphone permission has been granted, so
       asking earlier would hide the button on a device that does have a second
       output. Async, so the button appears a beat after the call connects —
       which is fine, because it is useless before then anyway. */
    const speakerBtn = root.querySelector('[data-lc-call-speaker]');
    if (speakerBtn) {
      if (call.status !== 'connected') {
        speakerBtn.hidden = true;
      } else {
        JWCall.speakerAvailable().then(ok => { speakerBtn.hidden = !ok; });
      }
    }
    root.querySelector('[data-lc-panel]')
      && root.querySelector('[data-lc-panel]').classList.toggle(
        'lc-in-call', call.status === 'connected');
  }

  /* -- recent calls ------------------------------------------------------- */
  async function loadCallLog() {
    const list = inPanel('[data-lc-calls]');
    if (!list) return;
    try {
      const body = await api('/calls?limit=8');
      const rows = (body && body.calls) || [];
      list.textContent = '';
      if (!rows.length) { list.hidden = true; return; }
      rows.forEach(c => list.appendChild(callLogRow(c)));
      list.hidden = false;
    } catch (e) {
      list.hidden = true;   /* a log that will not load is not worth an error */
    }
  }

  const CALL_LOG_LABELS = {
    ended: 'Completed', missed: 'Missed', rejected: 'Declined',
    cancelled: 'Cancelled', busy: 'Busy', failed: 'Failed',
  };

  function callLogRow(c) {
    const row = document.createElement('div');
    row.className = 'lc-call-row lc-call-' + c.status;
    row.innerHTML = svg(
      ['missed', 'rejected', 'failed', 'busy'].indexOf(c.status) !== -1
        ? ICONS.phoneOff : ICONS.phone, 'lc-call-row-icon');
    const meta = document.createElement('div');
    meta.className = 'lc-call-row-meta';
    const top = document.createElement('span');
    top.className = 'lc-call-row-top';
    top.textContent = 'Voice call \u00b7 ' + (CALL_LOG_LABELS[c.status] || c.status);
    const when = document.createElement('span');
    when.className = 'lc-call-row-when';
    const d = new Date(c.created_at);
    when.textContent = d.toLocaleDateString([], { day: 'numeric', month: 'short' })
      + ' \u00b7 ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      + (c.duration_seconds != null
        ? ' \u00b7 ' + JWCall.formatDuration(c.duration_seconds) : '');
    meta.appendChild(top);
    meta.appendChild(when);
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

  /* VOICE CALLING IS A SUPPORT CENTER FEATURE, NOT A WIDGET ONE.
     The floating bubble is for a quick question from a product page; a call is
     a deliberate act that belongs in the account area, next to the booking it
     is about. Same panel either way — `mountInto()` relocates the one element
     rather than building a second — so this is one condition on one button,
     which is also why the two can never drift apart.

     Called from paintHeader() so it re-evaluates on every dock and undock
     without either of those needing to remember. */
  function paintCallAffordance() {
    const btn = inPanel('[data-lc-call-start]');
    if (!btn) return;
    btn.hidden = !state.docked;
  }

  function paintHeader() {
    paintCallAffordance();
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
    /* Call frames first, and awaited nowhere: handleFrame is called from the
       socket's onmessage, which cannot await. The call handler returns a
       promise that resolves on its own; nothing after it depends on the
       result. */
    if (CALL_FRAMES.indexOf(event) !== -1) {
      Promise.resolve(handleCallFrame(event, data)).catch(err => {
        console.error('JackpotsWorld: call frame failed', event, err);
        socketSend('call_failed', { call_id: call.id, reason: 'client_error' });
        endCallUi('failed');
      });
      return;
    }
    if (event === 'receive_message') {
      mergeMessage(data);
      renderThread();
      /* Only follow the conversation down if the reader is already at the
         bottom. Yanking someone back while they are reading history is the
         rudest thing a chat widget can do. */
      if (atBottom()) scrollToBottom();
      if (state.open && data.sender_type === 'admin') markRead();
      if (data.sender_type === 'admin' && !data.is_internal) chime();
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
    if (event === 'conversation_assigned') {
      /* Auto-assignment happened server-side on this customer's first message.
         Repainting the header from the frame means the widget can say who is
         with them without asking for the conversation again. */
      if (state.conversation) {
        state.conversation.assigned_admin_name = data.assigned_admin_name;
        state.conversation.status = data.status;
        paintHeader();
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
      /* hidden until paintCallAffordance() says otherwise — the widget
         mounts floating, and a button that appears and then vanishes is worse
         than one that was never there. */
      + '<button type="button" class="lc-head-call" hidden data-lc-call-start'
      + ' aria-label="Start a voice call" title="Call support">'
      + svg(ICONS.phone) + '</button>'
      + '<button type="button" class="lc-head-close" data-lc-close aria-label="Close chat">'
      + svg(ICONS.close) + '</button>'
      + '</div>'
      /* The call overlay. Hidden until there is a call; covers the composer
         and leaves the thread readable behind it. */
      + '<div class="lc-call" data-lc-call hidden role="dialog"'
      + ' aria-label="Voice call">'
      + '<div class="lc-call-avatar" aria-hidden="true">JW</div>'
      + '<div class="lc-call-title" data-lc-call-title>JackpotsWorld Support</div>'
      + '<div class="lc-call-status" data-lc-call-status></div>'
      + '<div class="lc-call-timer" data-lc-call-timer hidden>00:00</div>'
      + '<div class="lc-call-note" data-lc-call-note hidden></div>'
      + '<div class="lc-call-actions" data-lc-call-answer hidden>'
      + '<button type="button" class="lc-call-btn lc-call-reject" data-lc-call-decline>'
      + svg(ICONS.phoneOff) + '<span>Decline</span></button>'
      + '<button type="button" class="lc-call-btn lc-call-accept" data-lc-call-answer-btn>'
      + svg(ICONS.phone) + '<span>Accept</span></button>'
      + '</div>'
      + '<div class="lc-call-actions" data-lc-call-live>'
      + '<button type="button" class="lc-call-btn lc-call-mute" data-lc-call-mute'
      + ' aria-pressed="false">' + svg(ICONS.mic) + '<span>Mute</span></button>'
      /* Hidden until a call is running and the device actually has somewhere
         else to send audio — see JWCall.speakerAvailable(). A button that does
         nothing is worse than no button. */
      + '<button type="button" class="lc-call-btn lc-call-speaker" data-lc-call-speaker'
      + ' hidden>' + svg(ICONS.speaker) + '<span>Speaker</span></button>'
      + '<button type="button" class="lc-call-btn lc-call-end" data-lc-call-hangup>'
      + svg(ICONS.phoneOff) + '<span>End</span></button>'
      + '</div>'
      + '</div>'
      + '<div class="lc-calls" data-lc-calls hidden></div>'
      + '<div class="lc-thread" data-lc-thread role="log" aria-live="polite" aria-label="Conversation"></div>'
      + '<div class="lc-emoji-tray" data-lc-emoji-tray hidden></div>'
      + '<form class="lc-composer" data-lc-form>'
      + '<label class="lc-sr" for="lcInput">Message</label>'
      + '<input type="file" class="lc-sr" data-lc-file'
      + ' accept="' + ACCEPT + '">'
      + '<button type="button" class="lc-tool" data-lc-attach'
      + ' aria-label="Attach a photo or document" title="Attach a photo or PDF">'
      + svg(ICONS.clip) + '</button>'
      + '<button type="button" class="lc-tool" data-lc-emoji'
      + ' aria-label="Insert an emoji" title="Emoji">'
      + svg(ICONS.smile) + '</button>'
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

    const callBtn = root.querySelector('[data-lc-call-start]');
    if (callBtn) callBtn.addEventListener('click', () => startCall());
    const hangupBtn = root.querySelector('[data-lc-call-hangup]');
    if (hangupBtn) hangupBtn.addEventListener('click', () => hangUp());
    const muteToggle = root.querySelector('[data-lc-call-mute]');
    if (muteToggle) muteToggle.addEventListener('click', () => { JWCall.toggleMute(); });
    const speakerToggle = root.querySelector('[data-lc-call-speaker]');
    if (speakerToggle) speakerToggle.addEventListener('click', () => { JWCall.cycleOutput(); });
    const answerBtn = root.querySelector('[data-lc-call-answer-btn]');
    if (answerBtn) answerBtn.addEventListener('click', () => acceptCall());
    const declineBtn = root.querySelector('[data-lc-call-decline]');
    if (declineBtn) declineBtn.addEventListener('click', () => rejectCall());

    const form = root.querySelector('[data-lc-form]');
    form.addEventListener('submit', e => { e.preventDefault(); send(); });

    const picker = root.querySelector('[data-lc-file]');
    const attach = root.querySelector('[data-lc-attach]');
    if (attach && picker) {
      attach.addEventListener('click', () => picker.click());
      picker.addEventListener('change', () => {
        const file = picker.files && picker.files[0];
        /* Cleared before the await so choosing the same file twice in a row
           still fires a change event the second time. */
        picker.value = '';
        upload(file);
      });
    }

    const emoji = root.querySelector('[data-lc-emoji]');
    if (emoji) {
      emoji.addEventListener('click', e => { e.stopPropagation(); toggleEmoji(); });
      root.addEventListener('click', e => {
        if (!e.target.closest('[data-lc-emoji-tray]')
            && !e.target.closest('[data-lc-emoji]')) toggleEmoji(false);
      });
    }

    /* Drag a photo onto the panel. `dragover` must be prevented or the browser
       navigates to the file instead of letting the page have it. */
    const panel = root.querySelector('[data-lc-panel]');
    if (panel) {
      panel.addEventListener('dragover', e => {
        e.preventDefault();
        panel.classList.add('lc-dropping');
      });
      panel.addEventListener('dragleave', () => panel.classList.remove('lc-dropping'));
      panel.addEventListener('drop', e => {
        e.preventDefault();
        panel.classList.remove('lc-dropping');
        const dropped = e.dataTransfer && e.dataTransfer.files;
        if (dropped && dropped.length) upload(dropped[0]);
      });
    }

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

    /* A call in progress must not survive the tab closing: the other party
       would sit listening to a connection nobody is on. */
    window.addEventListener('beforeunload', () => {
      if (call.id) {
        try { socketSend('call_end', { call_id: call.id }); } catch (e) {}
        JWCall.reset();
      }
    });
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
  /** Show or hide the floating bubble, per this page's wishes.
   *
   *  Called from mount() and from undock(). The second is the one that
   *  matters: undock() clears `lc-open`, which is what un-hides the launcher —
   *  so without this, a page that never wanted a bubble would sprout one the
   *  moment somebody closed Support Center.
   */
  function paintLauncher() {
    const launcher = state.root && state.root.querySelector('[data-lc-launcher]');
    if (launcher) launcher.hidden = !state.showLauncher;
  }

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
    paintLauncher();
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
    paintCallAffordance();
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
    paintCallAffordance();
    state.panel.hidden = true;
    state.root.classList.remove('lc-open');
    paintLauncher();
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
    /* The call log is loaded alongside the thread, not lazily on a tab: the
       brief puts "Recent Calls" inside Support Center, and a customer checking
       whether they missed a callback should not have to find a control first. */
    loadCallLog();
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
    /* `data-live-chat` on the body is a page saying it wants the floating
       bubble. Support Center does not go through here — it calls mountInto()
       directly — so a page can host the conversation without advertising a
       launcher in the corner. */
    if (!document.querySelector('[data-live-chat]')) return;
    state.showLauncher = true;
    mount();
  }

  document.addEventListener('DOMContentLoaded', autoMount);
  if (document.readyState !== 'loading') autoMount();

  return { mount, mountInto, undock, open, hide, isSignedIn: signedIn };
})();
