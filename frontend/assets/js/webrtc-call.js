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
  };

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

    pc.onicecandidate = e => {
      if (!e.candidate) return;   /* null means gathering finished */
      state.send('ice_candidate', {
        call_id: state.callId,
        payload: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate,
      });
    };

    pc.ontrack = e => {
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
      if (s === 'connected' || s === 'completed') {
        /* TWO DIFFERENT EVENTS FROM ONE ICE STATE. Arriving at `connected` for
           the first time is the call starting; arriving there again after a
           drop is the call recovering, and a customer who just heard three
           seconds of silence needs to be told which of those happened. */
        if (state.wasDegraded) {
          state.wasDegraded = false;
          emit('Restored');
        }
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

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') emit('Failed', { code: 'peer_failed' });
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
    reset();
    state.callId = opts.callId;
    state.role = opts.role;
    state.send = opts.send;
    state.handlers = opts.handlers || {};
    state.iceServers = opts.iceServers || [];
    state.localStream = await getMicrophone();
    state.pc = buildPeer(state.iceServers);
    state.localStream.getTracks().forEach(t => state.pc.addTrack(t, state.localStream));
    watchQuality();
  }

  /** The caller, once the other side has accepted. */
  async function createOffer() {
    const offer = await state.pc.createOffer({ offerToReceiveAudio: true });
    await state.pc.setLocalDescription(offer);
    state.send('offer', { call_id: state.callId, payload: { sdp: offer.sdp, type: offer.type } });
  }

  /** An offer arrived — the callee's side, or an ICE restart on the caller's. */
  async function handleOffer(payload) {
    await state.pc.setRemoteDescription(new RTCSessionDescription(payload));
    await drainCandidates();
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    state.send('answer', {
      call_id: state.callId, payload: { sdp: answer.sdp, type: answer.type },
    });
  }

  async function handleAnswer(payload) {
    /* An answer for a connection that is not expecting one is a duplicate or a
       late frame from a previous negotiation. Applying it throws and takes the
       call down; ignoring it is correct. */
    if (!state.pc || state.pc.signalingState !== 'have-local-offer') return;
    await state.pc.setRemoteDescription(new RTCSessionDescription(payload));
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

  /** mm:ss from a start timestamp. Used by both UIs' timers. */
  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  return {
    prepare, createOffer, handleOffer, handleAnswer, handleCandidate,
    setMuted, toggleMute, isMuted, isActive, currentCallId,
    speakerSupported, speakerAvailable, cycleOutput, currentOutputLabel,
    reset, getMicrophone, micPermission, formatDuration,
  };
})();

if (typeof window !== 'undefined') window.JWCall = JWCall;
