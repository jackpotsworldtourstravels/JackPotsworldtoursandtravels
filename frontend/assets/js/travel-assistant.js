'use strict';
/* ===========================================================================
   travel-assistant.js — the floating menu's Travel Assistant and Voice Assistant
   ===========================================================================
   TWO DOORS, ONE BRAIN. The typed panel and the spoken popup send the same
   sentence to the same endpoint and act on the same answer:

       POST /api/customer/assistant/message   {message, session_id?, kind}
        ->  {session_id, reply, intent, action, suggestions}

   The understanding lives on the SERVER (services/customer_assistant_service.py).
   Nothing in this file decides what a sentence means, which is what keeps the
   two doors from drifting into two assistants: a phrase taught to one is
   understood by the other the same second.

   WHAT THIS FILE OWNS is the conversation on screen and ONE map from an
   action to a screen this site already has (runAction below). It opens the
   existing searches; it never books anything and never quotes a price.

   THE SESSION IS THE BROWSER'S. The first reply hands out an opaque
   `session_id`, kept in sessionStorage so a reload continues the conversation
   and a new tab starts a fresh one. A guest may talk; signing in later CLAIMS
   that conversation for the account (claimPending), which is the merge the
   brief asks for — no history is copied, its owner is simply named.

   XSS: every message is rendered with textContent. Nothing a traveller types,
   and nothing the server echoes back, is ever parsed as HTML.
   =========================================================================== */

const TravelAssistant = (function () {
  const API = '/api/customer/assistant';
  const KEY = 'jpc_assistant_session';

  const state = {
    panel: null, thread: null, form: null, input: null, chips: null,
    voice: null, voiceText: null, voiceReply: null, voiceBtn: null, voiceHint: null,
    sessionId: null,
    sending: false,
    recognition: null,
    listening: false,
    greeted: false,
  };

  /* ------------------------------------------------------------- session */
  function readSession() {
    try { return sessionStorage.getItem(KEY) || null; } catch { return null; }
  }
  function writeSession(id) {
    state.sessionId = id || null;
    try { if (id) sessionStorage.setItem(KEY, id); } catch { /* private mode */ }
  }

  function authHeader() {
    /* auth.js owns the customer token. Sent when there is one so the
       conversation is stored against the account from its first line; absent
       for a guest, which the endpoint serves just the same. */
    try {
      const t = (typeof getCustomerAuth === 'function') ? getCustomerAuth().access : null;
      return t ? { Authorization: 'Bearer ' + t } : {};
    } catch { return {}; }
  }

  /** Hand a conversation started while signed out to the account that just
   *  signed in. Safe to call at any time: without both a session and a token
   *  it does nothing, and the server refuses a session owned by someone else. */
  async function claimPending() {
    const id = state.sessionId || readSession();
    const headers = authHeader();
    if (!id || !headers.Authorization) return;
    try {
      await fetch(API + '/claim', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ session_id: id }),
      });
    } catch { /* the conversation still works; only its ownership is deferred */ }
  }

  async function ask(message, kind) {
    const res = await fetch(API + '/message', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
      body: JSON.stringify({ message, session_id: state.sessionId || readSession(), kind }),
    });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    writeSession(data.session_id);
    return data;
  }

  function friendlyError(err) {
    if (err && err.status === 429) return 'You are sending messages very quickly — give me a moment.';
    return 'I could not reach the assistant just now. Please try again.';
  }

  /* -------------------------------------------------- airports and the card
     The assistant READS the airport reference; it never widens it. Nothing
     below changes the picker's suggestions, and nothing below writes into the
     booking card by hand — the card has its own seeding API and its own way of
     labelling an airport, and a second copy of either here is how the two
     would come to disagree. */

  /** A spoken city, resolved to the airport it means.
   *
   *      resolveAirport('Hyderabad')
   *        -> {airportCode:'HYD', city:'Hyderabad',
   *            airportName:'Rajiv Gandhi International Airport',
   *            country:'India', label:'Hyderabad (HYD)'}
   *      resolveAirport('Colombo')
   *        -> {airportCode:'CMB', city:'Colombo',
   *            airportName:'Bandaranaike International Airport',
   *            country:'Sri Lanka', label:'Colombo (CMB)'}
   *
   *  THE LOOKUP ITSELF IS NOT HERE. It is JPAirports.resolve, in airports.js,
   *  where the airport reference already lives — the brief's own instruction
   *  was to reuse the existing source rather than add a second one, and an
   *  airport table inside the assistant would be exactly that second one.
   *
   *  @returns the record above, or null when no table answers to that name. */
  function resolveAirport(cityName) {
    if (typeof JPAirports === 'undefined' || !JPAirports.resolve) return null;
    return JPAirports.resolve(cityName);
  }

  /** What to say when a city was named and no airport answers to it.
   *
   *  THE REPLY ITSELF CANNOT KNOW. It comes from the server, which has no
   *  airport table on purpose, so it will already have said "searching flights
   *  from Narnia". This is the correction, and it is a sentence rather than a
   *  silently empty box: the traveller has to be told WHICH half of what they
   *  said did not land, or they are left guessing at a form. */
  function airportNote(asked, from, to, duplicate) {
    if (duplicate) return 'That came through as the same airport at both ends — '
      + 'please choose where you are flying to.';
    const noFrom = asked.from && !from;
    const noTo = asked.to && !to;
    if (noFrom && noTo) return 'Please select your departure and destination airports.';
    if (noFrom) return 'I could not find an airport for ' + asked.from
      + ' — please select your departure airport.';
    if (noTo) return 'I could not find an airport for ' + asked.to
      + ' — please select your destination airport.';
    return null;
  }

  /** The landing page's booking card, opened on Flights and filled with the
   *  route — and with nothing else.
   *
   *  IT GOES THROUGH BookingCard.seedFlights, the card's own seeding API, and
   *  writes no field by hand. That API already knows the difference between a
   *  value and an absence: `undefined` leaves a box exactly as the traveller
   *  left it, and '' CLEARS it. Both are used here — a city we could not
   *  resolve clears its box, because the card ships with Hyderabad and Delhi
   *  in it and leaving "Delhi (DEL)" sitting under a reply about somewhere
   *  else is the card contradicting the answer.
   *
   *  THE DATE, THE PARTY AND THE CABIN STAY THE TRAVELLER'S. Only a date they
   *  actually spoke is written in; the rest keep whatever the card held, and
   *  nothing is submitted. A search fired on their behalf would also hit the
   *  sign-in gate before they expected it.
   *
   *  On a page with no Flights panel, activateTab() navigates to flights.html
   *  instead, and the route goes with it in the URL rather than being typed
   *  into boxes that are not on this page.
   *
   *  @returns {{opened: boolean, note: string|null}} */
  function openFlightSearchCard(route) {
    const r = route || {};
    /* THE CODE THE BACKEND ALREADY RESOLVED, when it had one. It reads the
       SAME table this does — assets/js/airports.js — so this is not a second
       opinion; it saves a lookup and, for a city the picker spells its own
       way, it is the exact airport that was meant. A name is still what
       arrives for everywhere else, and everywhere else still resolves here. */
    const from = resolveAirport(r.fromCode || r.from);
    let to = resolveAirport(r.toCode || r.to);

    /* ONE AIRPORT CANNOT BE BOTH ENDS, and only this side can tell. Two
       different words resolve to the same code more often than they look like
       they would — "Bangalore" and "Bengaluru" are both BLR, and a voice
       transcript that hears one city at both ends of a route lands here too.
       The card refuses from === to on submit ("Origin and destination cannot
       be the same"), so filling both boxes with one airport is writing a
       search that cannot run. */
    let duplicate = false;
    if (from && to && from.airportCode === to.airportCode) { to = null; duplicate = true; }

    const params = { trip: r.trip === 'round' ? 'round' : 'oneway' };
    if (r.from) params.from = from ? from.airportCode : '';
    if (r.to) params.to = to ? to.airportCode : '';
    if (r.date) params.depart = r.date;

    const note = airportNote(r, from, to, duplicate);
    if (typeof activateTab !== 'function') return { opened: false, note: note };
    /* False means it navigated: the boxes are not on this page any more, and
       the route has gone with it in the URL. */
    if (!activateTab('flights', params)) return { opened: false, note: null };

    if (typeof BookingCard !== 'undefined' && BookingCard.seedFlights) BookingCard.seedFlights(params);
    document.querySelector('.search-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { opened: true, note: note };
  }


  /* -------------------------------------------------------------- actions
     ONE MAP, AND EVERY DESTINATION IS A SCREEN THAT ALREADY EXISTS. The
     assistant opens the site's own searches under the traveller's own session;
     it has no booking path of its own and adds none.

     EVERY BRANCH RETURNS THE SAME SHAPE — {opened, note}. `note` is a line the
     traveller still needs to read after the screen has changed, which only the
     flight card ever produces; a bare boolean left the one branch that has
     something to say with nowhere to say it. */
  function runAction(action, entities) {
    const a = action || {};
    const p = a.params || {};
    /* The reading, as a fallback for the fields. `params` is what THIS screen
       was told to show and wins; `entities` is what the sentence was
       understood to mean, and is here so a reply that named an intent without
       spelling out the params still fills the card. */
    const e = entities || {};
    const went = ok => ({ opened: !!ok, note: null });
    switch (a.type) {
      case 'search_flights':
        return openFlightSearchCard({
          trip: p.trip || e.trip,
          from: p.from || e.origin,
          to: p.to || e.destination,
          fromCode: p.fromCode,
          toCode: p.toCode,
          date: p.date || e.date,
        });
      case 'search_hotels': {
        const qs = new URLSearchParams();
        if (p.dest) qs.set('dest', p.dest);
        if (p.checkIn) qs.set('checkIn', p.checkIn);
        window.location.href = 'hotels.html' + (qs.toString() ? '?' + qs : '');
        return went(true);
      }
      case 'search_packages': {
        /* `type` is what the packages page reads into its destination filter
           (travel-explore.js seedFromUrl) — the same parameter the hero card
           sends, not a second one invented here. */
        const qs = new URLSearchParams();
        if (p.dest) qs.set('type', p.dest);
        window.location.href = 'packages.html' + (qs.toString() ? '?' + qs : '');
        return went(true);
      }
      case 'hotels_near':
        if (p.destination && p.attraction) {
          window.location.href = 'hotels/' + encodeURIComponent(p.destination)
            + '/' + encodeURIComponent(p.attraction);
          return went(true);
        }
        return went(false);
      case 'open_destination':
        if (p.destination) {
          window.location.href = 'destination/' + encodeURIComponent(p.destination);
          return went(true);
        }
        return went(false);
      case 'open_support':
        /* The REAL support chat — Account Center's Support Center, where
           LiveChat is docked. Signed out it opens the sign-in dialog first and
           returns here afterwards (account-center.js). */
        closePanel();
        closeVoice();
        if (typeof AccountCenter !== 'undefined' && AccountCenter.open) AccountCenter.open('support');
        return went(true);
      case 'open_bookings':
        closePanel();
        closeVoice();
        if (typeof AccountCenter !== 'undefined' && AccountCenter.open) AccountCenter.open('bookings');
        return went(true);
      default:
        return went(false);
    }
  }

  /* ------------------------------------------------- intent -> the screen
     ONE DOOR OUT OF A REPLY, and both the typed panel and the voice popup go
     through it — the same reason the understanding itself is on the server: a
     sentence understood once should be acted on once.

     IT ROUTES ON `action.type`, not on the intent, because the server names
     the SCREEN and not just the subject. "flight" and "the Flights panel of
     the hero card, filled in and left alone" are not the same fact, and the
     screen is the one the assistant is answerable for. `entities` then fills
     that screen's fields.

     The brief's own names — flight_search, hotel_search, tour_package — are
     understood as well, so a reply written in that vocabulary lands on the
     same screens as one written in this module's. */
  const INTENT_ACTION = {
    flight: 'search_flights', flight_search: 'search_flights',
    hotel: 'search_hotels', hotel_search: 'search_hotels',
    package: 'search_packages', tour_package: 'search_packages',
  };

  /** @param response one /message reply: {reply, intent, action, entities}.
   *  @returns {{opened: boolean, note: string|null}} */
  function handleAssistantIntent(response) {
    const data = response || {};
    const action = data.action || {};
    const nothing = { opened: false, note: null };
    if (action.type && action.type !== 'none') return runAction(action, data.entities);
    /* An explicit "none" is an answer, not an omission — "which city are you
       staying in?" has nowhere to send anyone yet — so the intent is only
       consulted when no action arrived at all. */
    if (action.type) return nothing;
    const mapped = INTENT_ACTION[data.intent];
    return mapped ? runAction({ type: mapped, params: {} }, data.entities) : nothing;
  }

  /* ---------------------------------------------------------------- panel */
  function bubble(text, who) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (who === 'user' ? 'user' : 'bot');
    el.textContent = text;                       // never innerHTML
    return el;
  }

  function scrollThread() {
    if (state.thread) state.thread.scrollTop = state.thread.scrollHeight;
  }

  function typingOn() {
    if (!state.thread || document.getElementById('taTyping')) return;
    const el = document.createElement('div');
    el.className = 'chat-msg bot ta-typing';
    el.id = 'taTyping';
    el.setAttribute('aria-label', 'Assistant is typing');
    el.innerHTML = '<span></span><span></span><span></span>';   // three dots, no data
    state.thread.appendChild(el);
    scrollThread();
  }
  function typingOff() { document.getElementById('taTyping')?.remove(); }

  function paintChips(list) {
    if (!state.chips) return;
    state.chips.innerHTML = '';
    (list || []).forEach(text => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-chip';
      b.textContent = text;
      b.addEventListener('click', () => send(text));
      state.chips.appendChild(b);
    });
    state.chips.hidden = !(list && list.length);
  }

  async function send(text, kind) {
    const message = String(text || '').trim();
    if (!message || state.sending) return;
    state.sending = true;
    if (state.input) state.input.value = '';
    if (state.thread) { state.thread.appendChild(bubble(message, 'user')); scrollThread(); }
    paintChips([]);
    typingOn();
    try {
      const data = await ask(message, kind || 'assistant');
      typingOff();
      if (state.thread) { state.thread.appendChild(bubble(data.reply, 'bot')); scrollThread(); }
      paintChips(data.suggestions);
      /* The screen opens a beat later, so the reply is read before the page
         moves under it. */
      if (data.action && data.action.type !== 'none') {
        setTimeout(() => {
          const done = handleAssistantIntent(data);
          /* A note is the part of the answer the server could not know — an
             airport nobody could find. It goes in the thread as its own line,
             because the reply above it has already said something the card
             does not show. */
          if (done.note && state.thread) {
            state.thread.appendChild(bubble(done.note, 'bot'));
            scrollThread();
          }
        }, 700);
      }
    } catch (err) {
      typingOff();
      if (state.thread) { state.thread.appendChild(bubble(friendlyError(err), 'bot')); scrollThread(); }
    } finally {
      state.sending = false;
    }
  }

  function buildPanel() {
    if (state.panel) return state.panel;
    const panel = document.getElementById('chatPanel');
    if (!panel) return null;
    panel.innerHTML = `
      <div class="chatbot-head">
        <div>
          <h4>JackPots World Travel Assistant</h4>
          <p>Flights, hotels, holidays — ask in your own words.</p>
        </div>
        <button type="button" class="ta-close" id="taClose" aria-label="Close assistant">&times;</button>
      </div>
      <div class="chatbot-body" id="chatBody" role="log" aria-live="polite"></div>
      <div class="chat-suggestions" id="chatSuggestions"></div>
      <form class="ta-compose" id="taForm">
        <label class="sr-only" for="taInput">Message the travel assistant</label>
        <input id="taInput" type="text" autocomplete="off" maxlength="500"
               placeholder="e.g. hotels in Goa next week">
        <button type="submit" class="ta-send" id="taSend" aria-label="Send message">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>
        </button>
      </form>`;
    state.panel = panel;
    state.thread = document.getElementById('chatBody');
    state.chips = document.getElementById('chatSuggestions');
    state.form = document.getElementById('taForm');
    state.input = document.getElementById('taInput');
    state.form.addEventListener('submit', e => { e.preventDefault(); send(state.input.value); });
    document.getElementById('taClose').addEventListener('click', closePanel);
    return panel;
  }

  function openPanel() {
    const panel = buildPanel();
    if (!panel) return;
    panel.classList.add('open');
    document.getElementById('fabAiBtn')?.setAttribute('aria-expanded', 'true');
    if (!state.greeted) {
      state.greeted = true;
      state.thread.appendChild(bubble(
        'Hi! I can help with flights, hotels, holiday packages and places to visit. '
        + 'What are you planning?', 'bot'));
      paintChips(['Flights from Hyderabad to Delhi', 'Hotels in Goa', 'Places to visit in Jaipur']);
    }
    setTimeout(() => state.input?.focus(), 120);
  }

  function closePanel() {
    state.panel?.classList.remove('open');
    document.getElementById('fabAiBtn')?.setAttribute('aria-expanded', 'false');
  }

  function togglePanel() {
    if (state.panel && state.panel.classList.contains('open')) closePanel();
    else openPanel();
  }

  /* ---------------------------------------------------------------- voice
     The Web Speech API, which is the browser's own recogniser — no audio ever
     leaves the device through this site, and only the resulting TEXT is sent
     to the endpoint above. Unsupported browsers (Firefox, older Safari) are
     told so and offered the typed panel instead of a dead button. */
  function speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function buildVoice() {
    if (state.voice) return state.voice;
    const wrap = document.createElement('div');
    wrap.className = 'va-overlay';
    wrap.id = 'vaOverlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="va-card" role="dialog" aria-modal="true" aria-labelledby="vaTitle">
        <button type="button" class="ta-close va-close" id="vaClose" aria-label="Close voice assistant">&times;</button>
        <h2 class="va-title" id="vaTitle">Voice Assistant</h2>
        <p class="va-hint" id="vaHint">Press the microphone and say where you want to go.</p>
        <button type="button" class="va-mic" id="vaMic" aria-label="Start listening">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
          </svg>
          <span class="va-ring" aria-hidden="true"></span>
        </button>
        <p class="va-heard" id="vaHeard" aria-live="polite"></p>
        <p class="va-reply" id="vaReply" aria-live="polite"></p>
      </div>`;
    document.body.appendChild(wrap);
    state.voice = wrap;
    state.voiceText = wrap.querySelector('#vaHeard');
    state.voiceReply = wrap.querySelector('#vaReply');
    state.voiceBtn = wrap.querySelector('#vaMic');
    state.voiceHint = wrap.querySelector('#vaHint');
    wrap.querySelector('#vaClose').addEventListener('click', closeVoice);
    wrap.addEventListener('click', e => { if (e.target === wrap) closeVoice(); });
    state.voiceBtn.addEventListener('click', toggleListening);
    return wrap;
  }

  function openVoice() {
    const wrap = buildVoice();
    wrap.hidden = false;
    document.body.style.overflow = 'hidden';
    state.voiceText.textContent = '';
    state.voiceReply.textContent = '';
    if (!speechCtor()) {
      state.voiceHint.textContent =
        'This browser cannot listen — Chrome or Edge can. You can type to the assistant instead.';
      state.voiceBtn.disabled = true;
      return;
    }
    state.voiceHint.textContent = 'Press the microphone and say where you want to go.';
    state.voiceBtn.disabled = false;
    /* Not auto-started: a popup that begins recording on open is a microphone
       switched on without being asked. The traveller presses the button. */
  }

  function closeVoice() {
    stopListening();
    if (state.voice) state.voice.hidden = true;
    document.body.style.overflow = '';
  }

  function setListening(on) {
    state.listening = on;
    state.voiceBtn?.classList.toggle('is-listening', on);
    state.voiceBtn?.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
    if (state.voiceHint) {
      state.voiceHint.textContent = on
        ? 'Listening… say something like "hotels in Goa".'
        : 'Press the microphone and say where you want to go.';
    }
  }

  function stopListening() {
    if (state.recognition && state.listening) {
      try { state.recognition.stop(); } catch { /* already stopped */ }
    }
    setListening(false);
  }

  function toggleListening() {
    if (state.listening) { stopListening(); return; }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = state.recognition || new Ctor();
    state.recognition = rec;
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = e => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) text += e.results[i][0].transcript;
      state.voiceText.textContent = text;
      /* Final result only: an interim guess changes under the traveller and
         must not be acted on. */
      if (e.results[e.results.length - 1].isFinal) handleHeard(text);
    };
    rec.onerror = ev => {
      setListening(false);
      /* The two that need different words: a refused microphone is a
         permission to change, not a failure to retry. */
      state.voiceReply.textContent = (ev && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed'))
        ? 'Microphone permission is blocked. Allow it in your browser settings, or type to the assistant instead.'
        : (ev && ev.error === 'no-speech')
          ? 'I did not hear anything — press the microphone and try again.'
          : 'The microphone is not available just now.';
    };
    rec.onend = () => setListening(false);

    state.voiceText.textContent = '';
    state.voiceReply.textContent = '';
    try { rec.start(); setListening(true); } catch { setListening(false); }
  }

  async function handleHeard(text) {
    const said = String(text || '').trim();
    if (!said) return;
    stopListening();
    state.voiceReply.textContent = 'Thinking…';
    try {
      const data = await ask(said, 'voice');
      state.voiceReply.textContent = data.reply;
      if (data.action && data.action.type !== 'none') {
        /* Long enough to read the answer before the page changes. */
        setTimeout(() => {
          const done = handleAssistantIntent(data);
          /* THE POPUP STAYS OPEN WHEN SOMETHING IS STILL MISSING. Closing onto
             a card with an empty From box leaves the traveller to work out for
             themselves which half of what they said did not land. */
          if (done.note) state.voiceReply.textContent = done.note;
          else closeVoice();
        }, 1200);
      }
    } catch (err) {
      state.voiceReply.textContent = friendlyError(err);
    }
  }

  /* ------------------------------------------------------------------ boot */
  function init() {
    /* A conversation held while signed out becomes the account's as soon as
       there is one — on load, and again whenever the session changes. */
    claimPending();
    window.addEventListener('storage', e => {
      if (e.key === 'jpc_access' && e.newValue) claimPending();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (state.voice && !state.voice.hidden) closeVoice();
      else if (state.panel && state.panel.classList.contains('open')) closePanel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  return {
    openPanel, closePanel, togglePanel,
    openVoice, closeVoice,
    send, claimPending,
    /* The routing seam, exported so it can be driven without speaking into a
       microphone — and so a caller that already has a reply in hand does not
       have to know which of the two doors it came through. */
    handleAssistantIntent, runAction, openFlightSearchCard, resolveAirport,
  };
})();
