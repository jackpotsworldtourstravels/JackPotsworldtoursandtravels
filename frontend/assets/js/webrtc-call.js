'use strict';
/* ===========================================================================
   webrtc-call.js — one voice call, from either side (CR-10)
   ===========================================================================
   Loaded by BOTH the customer widget and the agent console. A call is
   symmetric: both sides capture a microphone, both build a peer connection,
   both trickle candidates, both watch the same connection states. Only two
   things differ — who creates the offer, and how a frame is put on the wire —
   and both are parameters.

   Writing this twice would mean two copies of the negotiation, and the copy
   that gets forgotten during the next change is the one that leaves a customer
   listening to silence.

   WHAT THIS FILE DOES NOT DO
   It does not know about conversations, agents, queues or the DOM. It takes a
   `send` function and emits state through `on*` callbacks; the two UIs decide
   what a ringing call looks like. No element is created here except the hidden
   <audio> that remote audio has to play through.

   THE ORDER OF NEGOTIATION, AND WHY IT IS NOT THE OBVIOUS ONE
   The caller does NOT create an offer when it presses call. It waits until the
   server says the other side accepted. An offer created earlier would arrive at
   a browser with no peer connection yet, and be dropped — the call then fails
   with both sides showing "connected" and no audio, which is the single most
   confusing way for this to break.
   =========================================================================== */

const JWCall = (function () {

  /* Candidates that arrive before the remote description is set cannot be
     added yet — addIceCandidate throws. They are queued and replayed the
     moment the description lands. This is not an edge case: with trickle ICE
     the first candidates routinely beat the answer. */
  const state = {
    pc: null,
    localStream: null,
    remoteAudio: null,
    callId: null,
    role: null,          /* 'caller' | 'callee' */
    muted: false,
    pendingCandidates: [],
    remoteDescriptionSet: false,
    send: null,
    handlers: {},
    iceServers: null,
    statsTimer: null,
    lastQuality: null,
    /* True once ICE has dropped to `disconnected` at least once on this call.
       Without it there is no way to tell "we just connected" from "we just
       came back", and the brief asks for both to be said differently. */
    wasDegraded: false,
    outputLabel: null,
    notification: null,
    held: false,
    startedAt: 0,
  };

  /* -------------------------------------------------------------------------
     Diagnostics
     -------------------------------------------------------------------------
     One prefix, so a whole call can be filtered in or out of a console that
     also carries the page's own noise. Timestamped from the start of the call
     rather than the clock, because what matters when reading a failure is how
     long after the offer the thing happened, not what time it was.

     Errors are logged as errors and never swallowed — a `catch` that hides the
     reason a peer connection failed costs an entire round of testing. */
  function log(...args) {
    const t = state.startedAt ? ((Date.now() - state.startedAt) / 1000).toFixed(2) : '0.00';
    console.log(`[JWCall +${t}s]`, ...args);
  }

  function logError(...args) {
    const t = state.startedAt ? ((Date.now() - state.startedAt) / 1000).toFixed(2) : '0.00';
    console.error(`[JWCall +${t}s]`, ...args);
  }

  /** Everything worth knowing about the current call, in one object.
   *
   *  Meant to be typed into a console during or just after a failure:
   *  `await JWCall.diagnostics()`. Async because the candidate pair only comes
   *  from getStats().
   */
  async function diagnostics() {
    const pc = state.pc;
    const out = {
      callId: state.callId,
      role: state.role,
      muted: state.muted,
      held: state.held,
      hasPeerConnection: !!pc,
      iceServers: (state.iceServers || []).map(srv => ({
        urls: srv.urls,
        hasCredential: !!srv.credential,
      })),
      turnConfigured: (state.iceServers || []).some(
        srv => String(srv.urls).indexOf('turn:') !== -1),
    };
    if (pc) {
      out.connectionState = pc.connectionState;
      out.iceConnectionState = pc.iceConnectionState;
      out.iceGatheringState = pc.iceGatheringState;
      out.signalingState = pc.signalingState;
      out.localDescription = pc.localDescription && pc.localDescription.type;
      out.remoteDescription = pc.remoteDescription && pc.remoteDescription.type;
      out.senders = pc.getSenders().map(sender => sender.track && {
        kind: sender.track.kind, enabled: sender.track.enabled,
        muted: sender.track.muted, readyState: sender.track.readyState,
      }).filter(Boolean);
      out.receivers = pc.getReceivers().map(r => r.track && {
        kind: r.track.kind, enabled: r.track.enabled,
        muted: r.track.muted, readyState: r.track.readyState,
      }).filter(Boolean);
      out.selectedCandidatePair = await selectedPair();
    }
    if (state.remoteAudio) {
      out.remoteAudio = {
        hasStream: !!state.remoteAudio.srcObject,
        paused: state.remoteAudio.paused,
        muted: state.remoteAudio.muted,
        volume: state.remoteAudio.volume,
        readyState: state.remoteAudio.readyState,
      };
    }
    return out;
  }

  /** The pair ICE actually chose — host, reflexive, or relayed through TURN.
   *
   *  THE SINGLE MOST USEFUL LINE when a call connects for two laptops on one
   *  wifi and fails between a phone and a desk. `relay` on both ends means
   *  TURN is carrying it; no pair at all means ICE never completed.
   */
  async function selectedPair() {
    if (!state.pc || !state.pc.getStats) return null;
    try {
      const stats = await state.pc.getStats();
      let pair = null;
      const candidates = {};
      stats.forEach(report => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates[report.id] = report;
        }
        if (report.type === 'candidate-pair'
            && (report.selected || report.state === 'succeeded')) {
          if (!pair || report.selected) pair = report;
        }
      });
      if (!pair) return null;
      const local = candidates[pair.localCandidateId];
      const remote = candidates[pair.remoteCandidateId];
      return {
        state: pair.state,
        local: local && { type: local.candidateType, protocol: local.protocol },
        remote: remote && { type: remote.candidateType, protocol: remote.protocol },
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
        currentRoundTripTime: pair.currentRoundTripTime,
      };
    } catch (e) {
      return null;
    }
  }

  function emit(name, detail) {
    const fn = state.handlers['on' + name];
    if (typeof fn === 'function') {
      try { fn(detail); } catch (e) { console.error('JWCall handler', name, e); }
    }
  }

  /* -------------------------------------------------------------------------
     Microphone
     -------------------------------------------------------------------------
     Every failure mode here is one a person can act on, so each gets its own
     sentence rather than a generic "could not start call". The browser's own
     error names are the only reliable way to tell them apart — the messages it
     attaches to them are not translated and not stable. */
  async function getMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('This browser cannot make voice calls. Try Chrome, Edge or Safari.');
      err.code = 'unsupported';
      throw err;
    }
    /* getUserMedia is only available on a secure origin. localhost counts;
       a LAN IP over plain http does not, and the failure there is a confusing
       "undefined is not a function" rather than a permission prompt. */
    if (!window.isSecureContext) {
      const err = new Error('Voice calls need a secure (https) connection.');
      err.code = 'insecure';
      throw err;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (e) {
      const err = new Error('');
      switch (e && e.name) {
        case 'NotAllowedError':
        case 'SecurityError':
          err.message = 'Microphone access was blocked. Allow it in your browser settings and try again.';
          err.code = 'permission_denied';
          break;
        case 'NotFoundError':
        case 'OverconstrainedError':
          err.message = 'No microphone was found. Plug one in and try again.';
          err.code = 'no_microphone';
          break;
        case 'NotReadableError':
          err.message = 'Your microphone is in use by another application.';
          err.code = 'microphone_busy';
          break;
        default:
          err.message = 'Your microphone could not be started.';
          err.code = 'microphone_failed';
      }
      throw err;
    }
  }

  /** Has the user already granted the microphone? Never prompts.
   *
   *  The brief asks for the permission to be requested once. The Permissions
   *  API answers without a prompt where it exists, which is what lets the UI
   *  show "Allow microphone" beforehand instead of a dialog appearing over a
   *  call that has already started ringing. Firefox does not implement the
   *  `microphone` name, so an exception here means "unknown", not "denied".
   */
  async function micPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
      const status = await navigator.permissions.query({ name: 'microphone' });
      return status.state;    /* granted | denied | prompt */
    } catch (e) {
      return 'unknown';
    }
  }

  /* -------------------------------------------------------------------------
     The peer connection
     ------------------------------------------------------------------------- */
  function remoteAudioElement() {
    if (state.remoteAudio) return state.remoteAudio;
    const el = document.createElement('audio');
    el.autoplay = true;
    /* Not `hidden`, and not display:none. Some mobile browsers refuse to play
       audio from an element that is not in the layout at all, so it is placed
       off-screen instead. */
    el.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    state.remoteAudio = el;
    return el;
  }

  function buildPeer(iceServers) {
    const pc = new RTCPeerConnection({
      iceServers: iceServers || [],
      /* `all` rather than `relay`: try a direct path first and fall back to
         TURN. Forcing relay would make every call cost us bandwidth even when
         the two peers could talk to each other. */
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
    });

    pc.onicegatheringstatechange = () => log('iceGatheringState', pc.iceGatheringState);
    pc.onsignalingstatechange = () => log('signalingState', pc.signalingState);
    /* ONE HANDLER, NOT TWO. A second `pc.onconnectionstatechange =` further
       down silently replaced this one, so `connectionState` was never logged
       and the line naming a failed peer connection never printed — which is
       the one line worth having when a call is silent. */
    pc.onconnectionstatechange = () => {
      log('connectionState', pc.connectionState);
      if (pc.connectionState === 'failed') {
        logError('the peer connection FAILED — no media path was established');
        emit('Failed', { code: 'peer_failed' });
      }
    };

    pc.onicecandidate = e => {
      if (!e.candidate) { log('ICE gathering complete'); return; }
      /* candidateType tells you which path was found: host (same network),
         srflx (through NAT via STUN), relay (through TURN). No relay
         candidates on a mobile network usually means TURN is unreachable. */
      log('local ICE candidate', e.candidate.type || '(type unknown)',
          e.candidate.protocol || '', e.candidate.address || '');
      state.send('ice_candidate', {
        call_id: state.callId,
        payload: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate,
      });
    };

    pc.ontrack = e => {
      const track = e.track;
      log('REMOTE TRACK received', {
        kind: track.kind, enabled: track.enabled,
        muted: track.muted, readyState: track.readyState,
        streams: e.streams.length,
      });
      /* `muted: true` here is normal for a moment — it clears when media
         actually starts flowing. Still muted seconds later means the other
         side is sending nothing. */
      track.onunmute = () => log('remote track unmuted — audio is flowing');
      track.onmute = () => log('remote track MUTED — audio stopped arriving');
      track.onended = () => log('remote track ended');

      const el = remoteAudioElement();
      el.srcObject = e.streams[0];
      /* play() can still be refused despite autoplay, on a page the user has
         not interacted with. They pressed Call or Accept, so this should not
         fire — and if it does, silence with no error is the worst outcome, so
         it is reported. */
      const played = el.play();
      if (played && played.catch) {
        played.catch(() => emit('Error', {
          code: 'audio_blocked',
          message: 'Your browser blocked call audio. Tap the page and try again.',
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      log('iceConnectionState', s);
      if (s === 'connected' || s === 'completed') {
        /* TWO DIFFERENT EVENTS FROM ONE ICE STATE. Arriving at `connected` for
           the first time is the call starting; arriving there again after a
           drop is the call recovering, and a customer who just heard three
           seconds of silence needs to be told which of those happened. */
        if (state.wasDegraded) {
          state.wasDegraded = false;
          emit('Restored');
        }
        /* WHICH PATH WON. Logged once per connect, because "it works on two
           laptops and fails from a phone" is answered entirely by whether this
           says host/srflx or relay. */
        selectedPair().then(pair => log('CONNECTED via', pair || '(no pair yet)'));
        emit('Connected');
      } else if (s === 'disconnected') {
        /* NOT a failure yet. `disconnected` is routinely transient — a phone
           switching from wifi to mobile data spends a second or two here and
           recovers on its own. Reporting it as a dropped call would end calls
           that were about to be fine. */
        state.wasDegraded = true;
        emit('Reconnecting');
      } else if (s === 'failed') {
        /* An ICE restart is the one recovery worth attempting: it re-gathers
           candidates over the new network path. Only the caller does it —
           both sides restarting produces two offers and glare. */
        if (state.role === 'caller') {
          restartIce();
        } else {
          emit('Failed', { code: 'ice_failed' });
        }
      }
    };

    return pc;
  }

  async function restartIce() {
    try {
      state.wasDegraded = true;
      emit('Reconnecting');
      const offer = await state.pc.createOffer({ iceRestart: true });
      await state.pc.setLocalDescription(offer);
      state.send('offer', { call_id: state.callId, payload: { sdp: offer.sdp, type: offer.type } });
    } catch (e) {
      emit('Failed', { code: 'ice_restart_failed' });
    }
  }

  /* -------------------------------------------------------------------------
     Connection quality
     -------------------------------------------------------------------------
     getStats gives packet loss and jitter on the inbound audio track. "Poor
     Connection" from real numbers rather than from a guess, and only when it
     changes, so the UI is not rewritten every two seconds. */
  function watchQuality() {
    stopQualityWatch();
    let lastLost = 0, lastReceived = 0;
    state.statsTimer = setInterval(async () => {
      if (!state.pc) return;
      try {
        const report = await state.pc.getStats(null);
        report.forEach(s => {
          if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
          const lost = s.packetsLost || 0;
          const received = s.packetsReceived || 0;
          const dLost = lost - lastLost;
          const dRecv = received - lastReceived;
          lastLost = lost; lastReceived = received;
          if (dRecv + dLost <= 0) return;
          const loss = dLost / (dRecv + dLost);
          const quality = loss > 0.08 ? 'poor' : (loss > 0.03 ? 'fair' : 'good');
          if (quality !== state.lastQuality) {
            state.lastQuality = quality;
            emit('Quality', { quality: quality, loss: loss });
          }
        });
      } catch (e) { /* stats are diagnostics; never break a call for them */ }
    }, 3000);
  }

  function stopQualityWatch() {
    if (state.statsTimer) { clearInterval(state.statsTimer); state.statsTimer = null; }
    state.lastQuality = null;
  }

  /* -------------------------------------------------------------------------
     Public surface
     ------------------------------------------------------------------------- */

  /** Prepare a call: grab the mic and build the peer connection.
   *  Does NOT create an offer — see the header on why that waits.
   */
  async function prepare(opts) {
    /* Answering silences the ring. `prepare` is the first thing both sides do
       when a call is accepted, so this covers the one exit that never reaches
       reset(): the call that actually connects. */
    stopRinging();
    reset();
    state.callId = opts.callId;
    state.role = opts.role;
    state.send = opts.send;
    state.handlers = opts.handlers || {};
    state.iceServers = opts.iceServers || [];
    state.startedAt = Date.now();
    log('preparing', {
      role: opts.role, callId: opts.callId,
      iceServers: (state.iceServers || []).length,
      turn: (state.iceServers || []).some(x => String(x.urls).indexOf('turn:') !== -1),
    });

    state.localStream = await getMicrophone();
    log('microphone granted', state.localStream.getAudioTracks().map(t => ({
      label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState,
    })));

    state.pc = buildPeer(state.iceServers);
    state.localStream.getTracks().forEach(t => {
      state.pc.addTrack(t, state.localStream);
      log('local track added', t.kind, t.id);
    });
    watchQuality();
  }

  /** The caller, once the other side has accepted. */
  async function createOffer() {
    /* NEVER SILENT. An offer sent with no call id is refused by the relay and
       nothing downstream reports it, so the failure has to be named here. */
    if (!state.callId) {
      logError('creating an offer with NO CALL ID — the relay will refuse this '
               + 'offer and every candidate after it. setCallId() was not called.');
    }
    log('creating offer; signalingState was', state.pc.signalingState);
    const offer = await state.pc.createOffer({ offerToReceiveAudio: true });
    await state.pc.setLocalDescription(offer);
    log('local description set (offer); signalingState now', state.pc.signalingState);
    state.send('offer', { call_id: state.callId, payload: { sdp: offer.sdp, type: offer.type } });
  }

  /** An offer arrived — the callee's side, or an ICE restart on the caller's. */
  async function handleOffer(payload) {
    log('offer received; signalingState was', state.pc.signalingState);
    await state.pc.setRemoteDescription(new RTCSessionDescription(payload));
    log('remote description set (offer); signalingState now', state.pc.signalingState);
    await drainCandidates();
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    log('answer sent; signalingState now', state.pc.signalingState);
    state.send('answer', {
      call_id: state.callId, payload: { sdp: answer.sdp, type: answer.type },
    });
  }

  async function handleAnswer(payload) {
    /* An answer for a connection that is not expecting one is a duplicate or a
       late frame from a previous negotiation. Applying it throws and takes the
       call down; ignoring it is correct. */
    if (!state.pc || state.pc.signalingState !== 'have-local-offer') {
      log('answer IGNORED — signalingState is',
          state.pc ? state.pc.signalingState : 'no peer connection',
          '(a duplicate or a late frame from a previous negotiation)');
      return;
    }
    log('answer received; signalingState was', state.pc.signalingState);
    await state.pc.setRemoteDescription(new RTCSessionDescription(payload));
    log('remote description set (answer); signalingState now', state.pc.signalingState);
    await drainCandidates();
  }

  async function handleCandidate(payload) {
    if (!state.pc) return;
    if (!state.remoteDescriptionSet) { state.pendingCandidates.push(payload); return; }
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(payload));
    } catch (e) {
      /* A candidate that cannot be added is one path out of many. Losing one
         is normal; losing the call over it is not. */
    }
  }

  async function drainCandidates() {
    state.remoteDescriptionSet = true;
    const queued = state.pendingCandidates.splice(0);
    for (const c of queued) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* see above */ }
    }
  }

  /** Mute by DISABLING the track, never by stopping it.
   *
   *  A stopped track cannot be restarted without a new getUserMedia call and a
   *  fresh permission check, and on some browsers renegotiation — so unmuting
   *  would prompt the user mid-call. Disabling keeps the track in the sender
   *  and simply sends silence.
   */
  function setMuted(muted) {
    state.muted = !!muted;
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
    }
    emit('Mute', { muted: state.muted });
    return state.muted;
  }

  function toggleMute() { return setMuted(!state.muted); }
  function isMuted() { return state.muted; }
  function isActive() { return Boolean(state.pc); }
  function currentCallId() { return state.callId; }

  /** Tell a prepared call what id the server gave it.
   *
   *  THE CALLER CANNOT KNOW ITS CALL ID WHEN IT PREPARES. The microphone is
   *  taken and the peer connection built BEFORE `call_request` goes out — on
   *  purpose, so a customer with no microphone is told before an agent's phone
   *  rings — and the id only exists once the server has written the row. So
   *  `prepare()` is handed null, and the id arrives a moment later on the first
   *  `call_status` frame.
   *
   *  Until it is handed over, every frame this side sends carries
   *  `call_id: null`: the offer, and every ICE candidate after it. The relay
   *  answers each one with "no such call" and drops it, so the other browser
   *  never receives an offer, never answers, and ICE never leaves `new`. Both
   *  UIs still look like a call — which is exactly the failure this whole file
   *  was written to avoid.
   */
  function setCallId(id) {
    if (!id || id === state.callId) return state.callId;
    log('call id adopted', id);
    state.callId = id;
    return state.callId;
  }

  /** Tear everything down. Safe to call twice, and called on every exit path.
   *
   *  STOPPING THE TRACKS IS NOT OPTIONAL. A MediaStreamTrack left running
   *  keeps the browser's microphone indicator lit after the call has ended,
   *  which reads to a customer as "this website is still listening to me".
   */
  function reset() {
    stopQualityWatch();
    if (state.pc) {
      try {
        state.pc.onicecandidate = null;
        state.pc.ontrack = null;
        state.pc.oniceconnectionstatechange = null;
        state.pc.onconnectionstatechange = null;
        state.pc.close();
      } catch (e) { /* already closed */ }
    }
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    }
    if (state.remoteAudio) {
      try { state.remoteAudio.srcObject = null; } catch (e) {}
    }
    state.pc = null;
    state.localStream = null;
    state.callId = null;
    state.role = null;
    state.muted = false;
    state.pendingCandidates = [];
    state.remoteDescriptionSet = false;
    /* Cleared, or the NEXT call inherits this one's history and announces
       "connection restored" the moment it connects. */
    state.wasDegraded = false;
    state.outputLabel = null;
    state.held = false;
    /* THE RING STOPS HERE, not in each UI's teardown. Both call reset() on
       every terminal path — answered elsewhere, declined, cancelled, timed
       out, tab closing — so putting it here means neither UI can forget one.
       A ringtone that outlives its call is the most annoying bug this feature
       could ship. */
    stopRinging();
    if (state.notification) {
      try { state.notification.close(); } catch (e) {}
      state.notification = null;
    }
  }


  /* -------------------------------------------------------------------------
     Audio output ("Speaker")
     -------------------------------------------------------------------------
     THE BRIEF ASKS FOR A SPEAKER BUTTON. The web platform can only partly give
     one, and where it cannot, this hides the control rather than shipping a
     button that silently does nothing.

     `HTMLMediaElement.setSinkId()` is the only way a page can move audio to a
     different output. It does not exist on iOS Safari at all — there is no web
     API for earpiece-versus-speaker on iPhone, and no amount of code here
     changes that. On desktop it works and is genuinely useful: it moves the
     call from a headset to the laptop's speakers.

     So this is an OUTPUT SWITCH, not a phone speakerphone toggle. It cycles
     through the available audio outputs, which on a laptop with a headset
     plugged in is exactly the "speaker" behaviour someone wants, and on a
     device with one output is correctly absent.

     `enumerateDevices` only returns device LABELS once microphone permission
     has been granted — which, during a call, it has. Called before a call it
     would return unlabelled entries, which is why availability is only ever
     checked while one is running.
  */
  function speakerSupported() {
    return typeof HTMLMediaElement !== 'undefined'
      && typeof HTMLMediaElement.prototype.setSinkId === 'function';
  }

  async function outputDevices() {
    if (!speakerSupported()) return [];
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audiooutput');
    } catch (e) {
      return [];
    }
  }

  /** Is there anywhere else to send the audio? False hides the button. */
  async function speakerAvailable() {
    const outs = await outputDevices();
    return outs.length > 1;
  }

  /** Move to the next available output. Returns its label, or null.
   *
   *  Cycles rather than toggling between two fixed devices: a laptop with a
   *  headset, a monitor and internal speakers has three, and a two-state
   *  toggle would make one of them unreachable.
   */
  async function cycleOutput() {
    const outs = await outputDevices();
    if (outs.length < 2) return null;
    const el = remoteAudioElement();
    const current = el.sinkId || 'default';
    let index = outs.findIndex(d => d.deviceId === current);
    if (index === -1) index = 0;
    const next = outs[(index + 1) % outs.length];
    try {
      await el.setSinkId(next.deviceId);
    } catch (e) {
      /* setSinkId rejects if the device vanished between enumerating and
         setting — a headset unplugged mid-call. The browser has already fallen
         back to the default output, so the call is fine and only the label is
         wrong. */
      emit('Error', {
        code: 'output_failed',
        message: 'That audio device is no longer available.',
      });
      return null;
    }
    state.outputLabel = next.label || 'Speaker';
    emit('Output', { deviceId: next.deviceId, label: state.outputLabel });
    return state.outputLabel;
  }

  function currentOutputLabel() { return state.outputLabel; }


  /* -------------------------------------------------------------------------
     The ringtone
     -------------------------------------------------------------------------
     SHARED BY BOTH UIS, because a ring is a ring. It lives here rather than in
     each UI's own chime() for the reason the rest of this file exists: two
     copies means the one nobody updated is the one that stops ringing.

     A RINGTONE IS NOT A NOTIFICATION SOUND, and that difference is the whole
     point of this code. The previous behaviour played one two-note beep when a
     call arrived — the same beep a chat message plays. An agent who had glanced
     away, or had the console in a background tab, heard it once and missed the
     call. This repeats until somebody accepts, declines, or the caller gives
     up.

     Synthesised rather than an mp3: no asset to cache-bust, nothing to 404, and
     no <audio> element for an autoplay policy to block. Browsers refuse to
     start audio before the page has been interacted with — an agent signed into
     a console has interacted with it — and every failure here is swallowed,
     because a call that throws because it could not make a noise is worse than
     a silent one.

     It deliberately does NOT respect prefers-reduced-motion, unlike the chat
     chime. That setting asks for a calmer page; it does not ask to miss a
     phone call.
  */
  let ringCtx = null;
  let ringTimer = null;

  function ringOnce() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = ringCtx || new Ctx();
    if (ringCtx.state === 'suspended') ringCtx.resume();
    const now = ringCtx.currentTime;
    /* Two bursts of a two-tone pair — the shape of a telephone ring, which is
       recognisable as "answer me" in a way an arbitrary melody is not. */
    [0, 0.4].forEach(function (offset) {
      [440, 480].forEach(function (freq) {
        const osc = ringCtx.createOscillator();
        const gain = ringCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.09, now + offset + 0.03);
        gain.gain.setValueAtTime(0.09, now + offset + 0.28);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.33);
        osc.connect(gain).connect(ringCtx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.35);
      });
    });
  }

  /** Ring until stopRinging(). Safe to call twice. */
  function startRinging() {
    if (ringTimer) return;
    try {
      ringOnce();
      ringTimer = setInterval(() => {
        try { ringOnce(); } catch (e) { stopRinging(); }
      }, 3000);
    } catch (e) {
      /* No audio available. The popup is still on screen; silence is a
         degraded ring, not a broken call. */
      ringTimer = null;
    }
  }

  /** MUST be called on every path out of ringing — answered, declined,
   *  cancelled, timed out, socket dropped. A ringtone that outlives its call is
   *  the most annoying bug this feature could ship. */
  function stopRinging() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  }

  /** A browser notification for a call arriving in a tab nobody is looking at.
   *
   *  `requireInteraction` so it stays until dismissed: a toast that vanishes
   *  after four seconds is no use for something with a 45-second deadline.
   *  `renotify` with a fixed tag so a second call replaces the first rather
   *  than stacking.
   */
  function notifyIncoming(title, body) {
    try {
      if (!window.Notification || Notification.permission !== 'granted') return null;
      state.notification = new Notification(title, {
        body: body || '', tag: 'jw-incoming-call', renotify: true,
        requireInteraction: true,
      });
      return state.notification;
    } catch (e) { return null; }
  }


  /* -------------------------------------------------------------------------
     Hold
     -------------------------------------------------------------------------
     BOTH DIRECTIONS, which is what makes it hold rather than mute. Muting
     stops them hearing you; holding also stops you hearing them, which is the
     entire reason an agent presses it — to talk to a colleague, or to stop a
     customer overhearing the room.

     The peer connection is left up. Tearing it down and rebuilding on resume
     would mean a fresh ICE negotiation every time, which on a mobile network
     takes seconds and sometimes fails — turning a pause into a dropped call.
     Holding is therefore cheap and instant, and the media path survives it. */
  function setHold(on) {
    state.held = !!on;
    if (state.localStream) {
      /* Outbound: the track stays in the sender, so no renegotiation. */
      state.localStream.getAudioTracks().forEach(t => { t.enabled = !on; });
    }
    if (state.remoteAudio) {
      /* Inbound: muted at the element rather than by stopping the track, which
         would need renegotiation to undo. */
      state.remoteAudio.muted = !!on;
    }
    emit('Hold', { on: state.held });
    return state.held;
  }

  function isHeld() { return !!state.held; }

  /** Drop the current session but keep the call, ready for a new offer.
   *
   *  Used by the customer when a call is transferred: the same call continues
   *  with a different agent, so the peer connection is rebuilt while the call
   *  id, the timer and the history stay exactly as they were. `reset()` would
   *  throw all of that away and stop the ringtone-and-teardown machinery too.
   */
  function releasePeer() {
    if (state.pc) {
      try {
        state.pc.onicecandidate = null;
        state.pc.ontrack = null;
        state.pc.oniceconnectionstatechange = null;
        state.pc.onconnectionstatechange = null;
        state.pc.close();
      } catch (e) { /* already closed */ }
    }
    state.pc = null;
    state.pendingCandidates = [];
    state.remoteDescriptionSet = false;
    state.held = false;
    if (state.remoteAudio) {
      state.remoteAudio.muted = false;
      try { state.remoteAudio.srcObject = null; } catch (e) {}
    }
  }

  /** mm:ss from a start timestamp. Used by both UIs' timers. */
  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  return {
    prepare, createOffer, handleOffer, handleAnswer, handleCandidate,
    setMuted, toggleMute, isMuted, isActive, currentCallId, setCallId,
    speakerSupported, speakerAvailable, cycleOutput, currentOutputLabel,
    setHold, isHeld, releasePeer,
    diagnostics, selectedPair,
    startRinging, stopRinging, notifyIncoming,
    reset, getMicrophone, micPermission, formatDuration,
  };
})();

if (typeof window !== 'undefined') window.JWCall = JWCall;
