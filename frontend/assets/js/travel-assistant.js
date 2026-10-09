'use strict';
/* ===========================================================================
   travel-assistant.js — the floating menu's Travel Assistant and Voice Assistant
   ===========================================================================
   TWO DOORS, ONE BRAIN. The typed panel and the spoken popup send the same
   sentence to the same endpoint and act on the same answer:

       POST /api/customer/assistant/message   {message, session_id?, kind, context?}
        ->  {session_id, reply, intent, service_intent, action, entities,
             suggestions, context}

   `context` is the search the conversation is about, handed back so the next
   sentence can change it ("only family packages", "for four people"). Packages,
   places and destinations are drawn INSIDE the conversation (see presentInline,
   and assistant-results.js for what is fetched); flights and hotels still open
   the site's own search.

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
    voiceRich: null,
    sessionId: null,
    sending: false,
    recognition: null,
    listening: false,
    greeted: false,
    /* The search the conversation is about — "Goa tour packages, family" — so a
       follow-up like "for four people" has something to change. Held here and
       in sessionStorage (assistant-results.js), sent back with each message and
       replaced by whatever the reply returns. The server keeps none of it. */
    /* ONE SEARCH PER DOOR. The typed Travel Assistant and the Voice Assistant are
       two interfaces with two screens of results; a spoken "only family
       packages" must not silently edit the search the typed panel is showing,
       or the reverse. The session (the stored history) is shared, the working
       search is not. Keys: 'assistant' (typed) and 'voice'. */
    contexts: { assistant: null, voice: null },
    /* Fetched results, reused for a minute (assistant-results.js DATA_TTL_MS). */
    cache: new Map(),
    /* A transcript spoken twice within a moment (recognisers do this) is one
       request, not two. */
    lastHeard: { text: '', at: 0 },
  };

  const Results = (typeof AssistantResults !== 'undefined') ? AssistantResults : null;

  function storage() { try { return window.sessionStorage; } catch { return null; } }
  function loadContext() {
    ['assistant', 'voice'].forEach(door => {
      state.contexts[door] = Results ? Results.loadContext(storage(), Date.now(), door) : null;
    });
  }
  function setContext(door, ctx) {
    state.contexts[door] = ctx || null;
    if (Results) Results.saveContext(storage(), state.contexts[door], Date.now(), door);
  }

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

  /** A request that has not answered in this long is given up on, so a stalled
   *  connection ends in "try again" and not in a panel that waits for ever. */
  const REQUEST_TIMEOUT_MS = 20000;

  /** @param kind 'assistant' (the typed panel) or 'voice' — which door is asking,
   *  and so which door's search is followed and replaced. */
  async function ask(message, kind) {
    const door = kind === 'voice' ? 'voice' : 'assistant';
    const body = { message, session_id: state.sessionId || readSession(), kind: door };
    /* Only when there is a search to follow. Omitted otherwise, which the
       server reads as "start fresh". */
    if (state.contexts[door]) body.context = state.contexts[door];
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch(API + '/message', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
    } catch (err) {
      if (ctl && ctl.signal.aborted) { const t = new Error('timeout'); t.timeout = true; throw t; }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    writeSession(data.session_id);
    /* The reply owns the context: a new search replaces it, a follow-up
       updates it, and null (support, My Bookings) clears it. */
    setContext(door, data.context);
    return data;
  }

  function friendlyError(err) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 'You seem to be offline — check your connection and try again.';
    }
    if (err && err.timeout) return 'That is taking longer than expected. Please try again.';
    if (err && err.status === 429) return 'You are sending messages very quickly — give me a moment.';
    if (err && err.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
    return 'I could not reach the assistant just now. Please try again.';
  }

  /** Words about the conversation itself, handled without a round trip. */
  function startOver(door) {
    setContext(door === 'voice' ? 'voice' : 'assistant', null);
    return 'Okay — starting fresh. What would you like to look up?';
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
      /* DRAWN IN THE CONVERSATION, NOT NAVIGATED TO — see presentInline. They
         are listed so a caller that hands one to runAction gets "nothing
         opened" rather than being silently treated as unknown. */
      case 'show_packages':
      case 'show_places':
      case 'show_place':
      case 'show_destination':
      case 'show_destinations':
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

  /* ------------------------------------------------------- inline results
     WHY RESULTS ARE DRAWN HERE INSTEAD OF A PAGE BEING OPENED. This assistant
     lives on the landing page only, so navigating to the Tour Packages page
     ends the conversation: the next sentence ("only family packages", "for
     four people") would have nothing to follow. Packages, places and
     destinations are therefore fetched from the site's own endpoints and
     shown beside the reply, each with a link to the full page for when the
     traveller wants it.

     EVERYTHING IS BUILT WITH textContent. A package name or a destination's
     description comes from the catalogue, and none of it is ever parsed as
     HTML. */
  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function anchor(href, text, cls) {
    const a = node('a', cls, text);
    a.href = href;
    return a;
  }

  /** A suggestion is a sentence (its label is what it sends); a CHOICE has a
   *  label of its own — "Charminar · Hyderabad" — and sends a whole sentence,
   *  the traveller's request with the stored place name in it. */
  function asChoice(item) {
    return (item && typeof item === 'object')
      ? { label: String(item.label || item.message || ''), message: String(item.message || item.label || '') }
      : { label: String(item), message: String(item) };
  }

  /** What to offer under a reply: the server's choices when it made any (a
   *  misspelt or ambiguous place), its plain suggestions otherwise. */
  function choicesOf(data) {
    return (data && data.choices && data.choices.length) ? data.choices : ((data && data.suggestions) || []);
  }

  /** A suggestion button. Saying it and tapping it are the same request. */
  function chipButton(item) {
    const c = asChoice(item);
    const b = node('button', 'chat-chip ta-rich-chip', c.label);
    b.type = 'button';
    b.addEventListener('click', () => say(c.message));
    return b;
  }

  function chipRow(labels) {
    const row = node('div', 'ta-rich-chips');
    labels.forEach(l => row.appendChild(chipButton(l)));
    return row;
  }

  function resultDeps() {
    return { fetch: (u, o) => window.fetch(u, o), cache: state.cache, now: Date.now };
  }

  function voiceIsOpen() { return !!(state.voice && !state.voice.hidden); }

  /** One sentence, from whichever door is open. */
  function say(text) {
    if (voiceIsOpen()) handleHeard(text, { confirmed: true });
    else send(text);
  }

  function renderLoading(host, label) {
    host.textContent = '';
    host.setAttribute('aria-busy', 'true');
    const line = node('p', 'ta-rich-status');
    line.setAttribute('role', 'status');
    const dots = node('span', 'ta-typing');
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = '<span></span><span></span><span></span>';   // fixed markup, no data
    line.appendChild(dots);
    line.appendChild(node('span', null, ' ' + label));
    host.appendChild(line);
  }

  /** Artwork for an image key, from the manifests this page already loaded
   *  (destination-images.js on the landing page) — the SAME files the Tour
   *  Packages page's cards use. Null when none shipped; the card then has no
   *  picture, and never a stand-in. */
  function artFor(key) {
    if (!Results || !key) return null;
    /* The manifests are `const`s in classic scripts, so they are global NAMES and
       not window properties — which is why they are read bare, guarded by typeof,
       exactly as package-listing.js reads them. */
    return Results.resolveArt(key, {
      destinations: {
        files: typeof DESTINATION_IMAGE_FILES !== 'undefined' ? DESTINATION_IMAGE_FILES : null,
        dir: typeof DESTINATION_IMAGE_DIR !== 'undefined' ? DESTINATION_IMAGE_DIR : 'assets/destinations/',
      },
      locations: {
        files: typeof LOCATION_IMAGE_FILES !== 'undefined' ? LOCATION_IMAGE_FILES : null,
        dir: typeof LOCATION_IMAGE_DIR !== 'undefined' ? LOCATION_IMAGE_DIR : 'assets/locations/',
      },
    });
  }

  /** A thumbnail, or nothing. `onerror` removes a picture that fails to load. */
  function thumb(key, alt) {
    const art = artFor(key);
    if (!art) return null;
    const img = node('img', 'ta-card-art');
    img.setAttribute('src', art.small);
    img.setAttribute('alt', alt || '');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.addEventListener('error', () => { if (img.remove) img.remove(); });
    return img;
  }

  function renderPackages(host, res, opts) {
    host.textContent = '';
    const withArt = !!(opts && opts.door === 'assistant');
    const p = res.params || {};
    host.appendChild(node('p', 'ta-rich-title', res.empty
      ? 'No matching packages'
      : res.total + (res.total === 1 ? ' package' : ' packages') + ' — ' + res.summary));
    res.notes.forEach(n => host.appendChild(node('p', 'ta-rich-note', n)));
    if (p.travellers) {
      host.appendChild(node('p', 'ta-rich-note',
        'Noted ' + p.travellers + (p.travellers === 1 ? ' traveller' : ' travellers')
        + '. Prices are per person — you confirm the number of travellers when you book.'));
    }
    if (res.empty) {
      host.appendChild(node('p', 'ta-rich-note',
        'We don’t have ' + res.summary + ' on sale right now.'));
      if (res.alternatives.length) {
        host.appendChild(node('p', 'ta-rich-note', 'These destinations do have packages:'));
        host.appendChild(chipRow(res.alternatives.map(n => n + ' tour packages')));
      }
      host.appendChild(anchor('packages.html', 'Browse all tour packages', 'ta-rich-link'));
      return;
    }
    const list = node('ul', 'ta-rich-list');
    res.shown.forEach(pkg => {
      const c = Results.packageCard(pkg);
      const li = node('li');
      const a = anchor(c.href, '', 'ta-card');
      /* The picture belongs to the typed panel's cards. The voice popup's results
         are drawn as they were: that interface is not being redesigned. */
      const art = withArt ? thumb(c.imageKey, '') : null;
      const body = art ? node('div', 'ta-card-body') : a;
      if (art) { a.className += ' has-art'; a.appendChild(art); a.appendChild(body); }
      body.appendChild(node('strong', 'ta-card-title', c.title));
      body.appendChild(node('span', 'ta-card-meta', c.meta));
      if (c.price) {
        const price = node('span', 'ta-card-price');
        price.appendChild(node('b', null, c.price));
        price.appendChild(node('small', null, ' per person'));
        body.appendChild(price);
      }
      if (c.otherDates) body.appendChild(node('span', 'ta-card-meta', 'from ' + c.otherDates + ' on other dates'));
      body.appendChild(node('span', 'ta-card-next', c.departure));
      li.appendChild(a);
      list.appendChild(li);
    });
    host.appendChild(list);
    host.appendChild(anchor(res.href,
      res.total > res.shown.length
        ? 'See all ' + res.total + ' on the Tour Packages page'
        : 'Open the Tour Packages page', 'ta-rich-link'));
  }

  function renderPlaces(host, res, p) {
    host.textContent = '';
    const name = p.name || 'this destination';
    if (res.notFound || res.empty) {
      host.appendChild(node('p', 'ta-rich-title', res.notFound
        ? 'We don’t have ' + name + ' listed'
        : 'No places listed for ' + name + ' yet'));
      if (res.alternatives && res.alternatives.length) {
        host.appendChild(node('p', 'ta-rich-note', 'Try one of these instead:'));
        host.appendChild(chipRow(res.alternatives.map(n => 'Places to visit in ' + n)));
      }
      if (!res.notFound) {
        host.appendChild(chipRow(['Hotels in ' + name, name + ' tour packages']));
      }
      return;
    }
    host.appendChild(node('p', 'ta-rich-title',
      (res.kind === 'locations' ? 'Areas in ' : 'Famous places in ') + name));
    if (res.fellBack) {
      host.appendChild(node('p', 'ta-rich-note', res.kind === 'locations'
        ? name + ' has no famous places listed, so these are its areas.'
        : name + ' has no areas listed, so these are its famous places.'));
    }
    const list = node('ul', 'ta-rich-list');
    res.rows.forEach(row => {
      const links = Results.placeLinks(p.destination, row, res.kind);
      const li = node('li', 'ta-place');
      li.appendChild(node('strong', 'ta-card-title', row.name));
      if (row.description) li.appendChild(node('span', 'ta-card-meta', row.description));
      const sub = [];
      if (row.area_name) sub.push(row.area_name);
      if (row.hotel_count > 0) sub.push(row.hotel_count + (row.hotel_count === 1 ? ' hotel' : ' hotels') + ' nearby');
      if (sub.length) li.appendChild(node('span', 'ta-card-next', sub.join(' · ')));
      const acts = node('span', 'ta-place-actions');
      if (links.detail) acts.appendChild(anchor(links.detail, 'View place', 'ta-rich-link'));
      acts.appendChild(anchor(links.hotels,
        res.kind === 'locations' ? 'Hotels in ' + row.name : 'Hotels near ' + row.name, 'ta-rich-link'));
      li.appendChild(acts);
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  /** ONE named place — a famous place or an area — shown as itself, with the
   *  existing pages that go with it: its own page and "hotels near" for a famous
   *  place, the hotel search by area name for an area. Links only; nothing here
   *  is fetched, so there is nothing to fail. */
  function renderPlace(host, p) {
    host.textContent = '';
    host.appendChild(node('p', 'ta-rich-title', p.name));
    host.appendChild(node('p', 'ta-rich-note', 'in ' + (p.destinationName || p.destination)));
    const links = Results.placeLinks(p.destination, { slug: p.slug, name: p.name },
      p.kind === 'area' ? 'locations' : 'attractions');
    const acts = node('div', 'ta-place-actions');
    if (links.detail) acts.appendChild(anchor(links.detail, 'View ' + p.name, 'ta-rich-link'));
    acts.appendChild(anchor(links.hotels,
      p.kind === 'area' ? 'Hotels in ' + p.name : 'Hotels near ' + p.name, 'ta-rich-link'));
    acts.appendChild(anchor('destination/' + encodeURIComponent(p.destination),
      'Open the ' + (p.destinationName || 'destination') + ' page', 'ta-rich-link'));
    host.appendChild(acts);
  }

  /** The shelf, inside the conversation: one tappable card per destination. */
  function renderDestinationList(host, rows, p) {
    host.textContent = '';
    if (!rows.length) {
      host.appendChild(node('p', 'ta-rich-title', 'No destinations listed'));
      host.appendChild(node('p', 'ta-rich-note', 'There is nothing on the shelf right now. Try tour packages, hotels or flights.'));
      return;
    }
    host.appendChild(node('p', 'ta-rich-title', p.country ? 'Destinations in ' + p.country : 'Our destinations'));
    const list = node('ul', 'ta-rich-list');
    rows.forEach(d => {
      const li = node('li');
      const b = node('button', 'ta-card ta-dest', null);
      b.type = 'button';
      const art = thumb(d.image || d.id, '');
      const body = art ? node('div', 'ta-card-body') : b;
      if (art) { b.className += ' has-art'; b.appendChild(art); b.appendChild(body); }
      body.appendChild(node('strong', 'ta-card-title', d.name));
      if (d.country) body.appendChild(node('span', 'ta-card-meta', d.country));
      b.addEventListener('click', () => say('Tell me about ' + d.name));
      li.appendChild(b);
      list.appendChild(li);
    });
    host.appendChild(list);
    const shelf = node('button', 'ta-rich-link ta-linkbtn', 'See them on the homepage');
    shelf.type = 'button';
    shelf.addEventListener('click', () => { closePanel(false); revealDestinations(); });
    host.appendChild(shelf);
  }

  function renderDestination(host, p, opts) {
    host.textContent = '';
    /* The destination's own artwork (its slug is its image key), in the typed
       panel only. */
    const art = (opts && opts.door === 'assistant') ? thumb(p.destination, '') : null;
    if (art) host.appendChild(art);
    host.appendChild(node('p', 'ta-rich-title', p.name || 'Destination'));
    host.appendChild(anchor('destination/' + encodeURIComponent(p.destination),
      'Open the ' + (p.name || 'destination') + ' page', 'ta-rich-link'));
  }

  function renderFailure(host, data, opts) {
    host.textContent = '';
    host.appendChild(node('p', 'ta-rich-note',
      'I could not load that just now. Check your connection and try again.'));
    const retry = node('button', 'chat-chip ta-rich-chip', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => presentInline(data, host, opts));
    host.appendChild(retry);
  }

  /** The Destinations shelf on the landing page. Elsewhere it is one navigation
   *  away, which is the only time this leaves the page. */
  function revealDestinations() {
    const section = document.getElementById('destinations');
    if (!section) { window.location.href = 'index.html#destinations'; return false; }
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    return true;
  }

  /** Draw an inline action's answer into `host`. Never throws: a failure is
   *  drawn as a message with a retry, because the reply above it is already
   *  on screen and still true. */
  async function presentInline(data, host, opts) {
    const a = data.action || {};
    const p = a.params || {};
    if (!Results || !host) return;
    try {
      if (a.type === 'show_packages') {
        renderLoading(host, 'Looking up tour packages…');
        renderPackages(host, await Results.searchPackages(p, resultDeps()), opts);
      } else if (a.type === 'show_places') {
        renderLoading(host, 'Finding places…');
        renderPlaces(host, await Results.searchPlaces(p.destination, p.list, resultDeps()), p);
      } else if (a.type === 'show_place') {
        renderPlace(host, p);
      } else if (a.type === 'show_destination') {
        renderDestination(host, p, opts);
      } else if (a.type === 'show_destinations') {
        if (opts && opts.door === 'assistant') {
          /* THE TYPED PANEL SHOWS THE DESTINATIONS IN THE CONVERSATION. On a phone
             it covers the page, so scrolling to the shelf behind it would show
             nothing. The list is GET /destinations, with the artwork the shelf
             uses; tapping one asks about it exactly as typing its name would. */
          renderLoading(host, 'Loading destinations…');
          renderDestinationList(host, await Results.listDestinations(p.country, resultDeps()), p);
        } else {
          host.textContent = '';
          revealDestinations();
        }
      }
    } catch (err) {
      renderFailure(host, data, opts);
    } finally {
      host.setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------------------------------------------------------- panel
     THE TYPED TRAVEL ASSISTANT, AND ONLY THAT. It has no microphone and no speech
     code: the Voice Assistant (below) is a separate interface with its own
     popup, and the two share the understanding on the server and the helpers
     above — not a screen, not a search, and not a button. */
  function bubble(text, who) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (who === 'user' ? 'user' : 'bot');
    el.textContent = text;                       // never innerHTML
    return el;
  }

  function isMobile() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
  }
  function calmMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** The newest line in view. Moves the CONVERSATION's own scroll position and
   *  nothing else — scrollIntoView would drag the whole page along with it. */
  function scrollThread() {
    if (state.thread) state.thread.scrollTop = state.thread.scrollHeight;
  }

  /** Bring a new answer into view. A short one is shown at the bottom, with the
   *  question above it; a long one (a list of packages) is shown from its TOP,
   *  because starting at the end of a list is reading it backwards. `from` is
   *  where the answer begins (its reply line) and `to` where it ends (the last
   *  card), which are the same element for a plain reply. */
  function revealLatest(from, to) {
    const t = state.thread;
    const el = from;
    if (!t || !el) return;
    const end = to || from;
    const span = (end.offsetTop + end.offsetHeight) - el.offsetTop;
    const long = span > t.clientHeight - 16;
    const target = long ? Math.max(0, el.offsetTop - 8) : t.scrollHeight;
    if (t.scrollTo) t.scrollTo({ top: target, behavior: calmMotion() ? 'auto' : 'smooth' });
    else t.scrollTop = target;
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

  /** Suggestions under the conversation. EVERY ONE SENDS A REAL MESSAGE — the same
   *  path a typed sentence takes — so a chip can never be a label with nothing
   *  behind it. A list with nothing in it hides the row rather than leaving a gap. */
  function paintChips(list) {
    if (!state.chips) return;
    state.chips.innerHTML = '';
    (list || []).forEach(item => {
      const c = asChoice(item);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-chip';
      b.textContent = c.label;
      b.addEventListener('click', () => send(c.message));
      state.chips.appendChild(b);
    });
    state.chips.hidden = !(list && list.length);
  }

  /** What the input and send button look like while a request is out. The input
   *  stays editable (a traveller may be typing the next question, and a disabled
   *  field drops the keyboard on a phone); only SENDING is held back. */
  function setBusy(on) {
    if (state.form) {
      if (state.form.classList) state.form.classList.toggle('is-busy', !!on);
      state.form.setAttribute('aria-busy', String(!!on));
    }
    if (state.sendBtn) state.sendBtn.disabled = !!on;
  }

  /** A failed turn keeps the conversation: the question stays on screen, the
   *  reason is said, and Try again sends the SAME question without asking it a
   *  second time in the thread. */
  function errorBubble(message, kind, err) {
    const el = node('div', 'chat-msg bot ta-error');
    el.setAttribute('role', 'alert');
    el.appendChild(node('span', null, friendlyError(err)));
    const retry = node('button', 'ta-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (state.sending) return;
      if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
      send(message, kind, { retry: true });
    });
    el.appendChild(retry);
    return el;
  }

  async function send(text, kind, opts) {
    const message = String(text || '').trim();
    /* ONE REQUEST AT A TIME. A second Enter, a double tap or a chip tapped while
       an answer is on its way is ignored — before anything is cleared or drawn —
       so a question is never asked, or shown, twice. */
    if (!message || state.sending) return;
    state.sending = true;
    setBusy(true);
    const retrying = !!(opts && opts.retry);
    if (!retrying) {
      if (state.input) state.input.value = '';
      if (state.thread) { state.thread.appendChild(bubble(message, 'user')); scrollThread(); }
    }
    paintChips([]);
    /* About the conversation, not about travel — no round trip. */
    if (Results && Results.isStartOver(message)) {
      state.sending = false;
      setBusy(false);
      if (state.thread) { state.thread.appendChild(bubble(startOver('assistant'), 'bot')); scrollThread(); }
      return;
    }
    typingOn();
    try {
      const data = await ask(message, kind || 'assistant');
      typingOff();
      let reply = null;
      if (state.thread) { reply = bubble(data.reply, 'bot'); state.thread.appendChild(reply); revealLatest(reply); }
      paintChips(choicesOf(data));
      if (data.action && Results && Results.isInlineAction(data.action.type)) {
        /* Drawn here, under the reply, and the conversation stays where it is. */
        if (state.thread) {
          const host = node('div', 'chat-msg bot ta-rich');
          state.thread.appendChild(host);
          scrollThread();
          await presentInline(data, host, { door: 'assistant' });
          revealLatest(reply || host, host);
        }
      /* The screen opens a beat later, so the reply is read before the page
         moves under it. */
      } else if (data.action && data.action.type !== 'none') {
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
      if (state.thread) { state.thread.appendChild(errorBubble(message, kind || 'assistant', err)); scrollThread(); }
    } finally {
      state.sending = false;
      setBusy(false);
    }
  }

  function buildPanel() {
    if (state.panel) return state.panel;
    const panel = document.getElementById('chatPanel');
    if (!panel) return null;
    panel.setAttribute('aria-labelledby', 'taTitle');
    panel.innerHTML = `
      <div class="chatbot-head">
        <div class="ta-head-text">
          <h4 id="taTitle">JackPots World Travel Assistant</h4>
          <p>Flights, hotels, holidays — ask in your own words.</p>
        </div>
        <button type="button" class="ta-close" id="taClose" aria-label="Close travel assistant">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="chatbot-body" id="chatBody" role="log" aria-live="polite" aria-label="Conversation" tabindex="0"></div>
      <div class="chat-suggestions" id="chatSuggestions" role="group" aria-label="Suggestions"></div>
      <form class="ta-compose" id="taForm">
        <label class="sr-only" for="taInput">Message the travel assistant</label>
        <input id="taInput" type="text" autocomplete="off" maxlength="500" enterkeyhint="send"
               placeholder="Ask about places or trips">
        <button type="submit" class="ta-send" id="taSend" aria-label="Send message">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>
        </button>
      </form>`;
    panel.setAttribute('aria-hidden', 'true');
    state.panel = panel;
    state.thread = document.getElementById('chatBody');
    state.chips = document.getElementById('chatSuggestions');
    state.form = document.getElementById('taForm');
    state.input = document.getElementById('taInput');
    state.sendBtn = document.getElementById('taSend');
    /* Enter submits the form natively, so Enter and the button are one path. */
    state.form.addEventListener('submit', e => { e.preventDefault(); send(state.input.value); });
    document.getElementById('taClose').addEventListener('click', () => closePanel(true));
    /* A phone's keyboard shrinks what is visible; keep the newest line above it. */
    state.input.addEventListener('focus', () => { if (isMobile()) setTimeout(scrollThread, 250); });
    return panel;
  }

  /* --- the phone layout: a full-screen sheet that follows the keyboard ------
     On a phone the panel fills the screen. The visual viewport — what is left
     above the on-screen keyboard — is what the sheet is sized to, so the input
     and the send button are never underneath it; the page behind stops
     scrolling; and the launcher (which sits where the send button is) is hidden
     for as long as the sheet is open. All of it is undone on close and when the
     window grows back to desktop size. */
  let viewportBound = false;
  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv || !state.panel || !isMobile()) return;
    state.panel.style.setProperty('--ta-vh', vv.height + 'px');
    state.panel.style.setProperty('--ta-top', vv.offsetTop + 'px');
    scrollThread();
  }
  function onWindowResize() {
    if (!state.panel || !state.panel.classList.contains('open')) return;
    const mobile = isMobile();
    document.documentElement.classList.toggle('ta-lock', mobile);
    state.panel.setAttribute('aria-modal', String(mobile));
    if (!mobile) {
      state.panel.style.removeProperty('--ta-vh');
      state.panel.style.removeProperty('--ta-top');
    } else syncViewport();
  }
  function bindViewport(on) {
    const vv = window.visualViewport;
    if (on && !viewportBound) {
      if (vv && vv.addEventListener) { vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); }
      window.addEventListener('resize', onWindowResize);
      viewportBound = true;
    } else if (!on && viewportBound) {
      if (vv && vv.removeEventListener) { vv.removeEventListener('resize', syncViewport); vv.removeEventListener('scroll', syncViewport); }
      window.removeEventListener('resize', onWindowResize);
      viewportBound = false;
    }
  }

  /** The four starting points. Each is a real message with a real answer — the
   *  server turns it into the destinations shelf, the packages list, a hotel
   *  question or a flight question — and none is shown again once the
   *  conversation has moved on. */
  const STARTERS = [
    { label: 'Explore destinations', message: 'Show me destinations' },
    { label: 'Tour packages', message: 'Show tour packages' },
    { label: 'Find hotels', message: 'Find hotels' },
    { label: 'Search flights', message: 'Search flights' },
  ];

  function openPanel() {
    const panel = buildPanel();
    if (!panel) return;
    panel.classList.add('open');
    panel.removeAttribute('aria-hidden');
    document.getElementById('fabAiBtn')?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('ta-open');
    const mobile = isMobile();
    document.documentElement.classList.toggle('ta-lock', mobile);
    panel.setAttribute('aria-modal', String(mobile));
    bindViewport(true);
    syncViewport();
    if (!state.greeted) {
      state.greeted = true;
      state.thread.appendChild(bubble(
        'Hi! I can help you explore destinations, tour packages, hotels and flights. '
        + 'What are you planning?', 'bot'));
      paintChips(STARTERS);
    }
    scrollThread();
    /* Not on a phone: focusing the input there raises the keyboard over the
       conversation before the traveller has asked for it. */
    if (!mobile) setTimeout(() => state.input?.focus({ preventScroll: true }), 120);
  }

  /** @param returnFocus true when the TRAVELLER closed it (the X, Escape): focus
   *  goes back to the launcher they opened it from, so a keyboard user is not
   *  dropped at the top of the page. */
  function closePanel(returnFocus) {
    if (!state.panel) return;
    state.panel.classList.remove('open');
    state.panel.setAttribute('aria-hidden', 'true');
    document.getElementById('fabAiBtn')?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('ta-open');
    document.documentElement.classList.remove('ta-lock');
    bindViewport(false);
    if (returnFocus === true) document.getElementById('fabMainBtn')?.focus({ preventScroll: true });
  }

  function togglePanel() {
    if (state.panel && state.panel.classList.contains('open')) closePanel(true);
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
        <div class="va-results ta-rich" id="vaResults" aria-live="polite"></div>
      </div>`;
    document.body.appendChild(wrap);
    state.voice = wrap;
    state.voiceText = wrap.querySelector('#vaHeard');
    state.voiceReply = wrap.querySelector('#vaReply');
    state.voiceBtn = wrap.querySelector('#vaMic');
    state.voiceHint = wrap.querySelector('#vaHint');
    state.voiceRich = wrap.querySelector('#vaResults');
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
    state.voiceRich.textContent = '';
    if (!speechCtor()) {
      state.voiceHint.textContent =
        'This browser cannot listen — Chrome or Edge can. You can type to the assistant instead.';
      state.voiceBtn.disabled = true;
      return;
    }
    state.voiceHint.textContent = IDLE_HINT;
    state.voiceBtn.disabled = false;
    /* Not auto-started: a popup that begins recording on open is a microphone
       switched on without being asked. The traveller presses the button. */
  }

  function closeVoice() {
    stopListening();
    if (state.voice) state.voice.hidden = true;
    document.body.style.overflow = '';
  }

  const IDLE_HINT = 'Press the microphone and say where you want to go.';
  const LISTEN_HINT = 'Listening… try “Goa tour packages” or “places to visit in Hyderabad”.';

  function setListening(on) {
    state.listening = on;
    state.voiceBtn?.classList.toggle('is-listening', on);
    state.voiceBtn?.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
    /* Stopping must not erase WHY it stopped: the recogniser fires `onend`
       after `onerror`, and a blanket "idle" here turned a shown error back
       into a calm popup. Only a listening popup goes back to idle. */
    if (state.voice) {
      if (on) state.voice.dataset.state = 'listening';
      else if (state.voice.dataset.state === 'listening') state.voice.dataset.state = 'idle';
    }
    if (state.voiceHint) state.voiceHint.textContent = on ? LISTEN_HINT : IDLE_HINT;
  }

  /** What the popup is doing — listening, thinking, loading — as words, for
   *  anyone who cannot see the ring pulse. The reply line is a live region. */
  function voiceStatus(kind, text) {
    if (state.voice) state.voice.dataset.state = kind;
    if (state.voiceReply) state.voiceReply.textContent = text || '';
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

    state.gotResult = false;
    rec.onresult = e => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) text += e.results[i][0].transcript;
      state.voiceText.textContent = text;
      /* Final result only: an interim guess changes under the traveller and
         must not be acted on. */
      const last = e.results[e.results.length - 1];
      if (!last.isFinal) return;
      state.gotResult = true;
      if (!text.trim()) { voiceStatus('error', 'I did not catch that — press the microphone and try again.'); return; }
      /* A recogniser reports how sure it is. Below this it is guessing, and
         acting on a guess opens the wrong search — so ask first. Browsers that
         report 0 or nothing are not told off for it. */
      const sure = last[0] && typeof last[0].confidence === 'number' ? last[0].confidence : 1;
      if (sure > 0 && sure < UNSURE_BELOW) confirmHeard(text);
      else handleHeard(text);
    };
    rec.onerror = ev => {
      setListening(false);
      const why = ev && ev.error;
      /* Each reason needs different words: a refused microphone is a
         permission to change, a missing one is hardware, and a dropped
         connection is the recogniser's own (Chrome sends speech to its
         service), not a failure of this site. */
      const words = (why === 'not-allowed' || why === 'service-not-allowed')
        ? 'Microphone permission is blocked. Allow it in your browser settings, or type to the assistant instead.'
        : why === 'no-speech'
          ? 'I did not hear anything — press the microphone and try again.'
          : why === 'audio-capture'
            ? 'I cannot find a microphone on this device. You can type to the assistant instead.'
            : why === 'network'
              ? 'Voice recognition needs an internet connection. Check yours, or type to the assistant instead.'
              : why === 'aborted'
                ? ''
                : 'The microphone is not available just now.';
      if (words) voiceStatus('error', words);
    };
    rec.onend = () => {
      const wasListening = state.listening;
      setListening(false);
      /* Ended with no result and no error: silence, or a cut-off. Said, rather
         than leaving the popup looking like nothing happened. */
      if (wasListening && !state.gotResult && state.voice && state.voice.dataset.state !== 'error') {
        voiceStatus('error', 'I did not catch anything — press the microphone and try again.');
      }
    };

    /* The previous results stay on screen: the next thing said is usually a
       change to them ("only family packages"), and they are replaced when the
       new answer arrives, not when the microphone opens. */
    state.voiceText.textContent = '';
    /* ...but a "Did you say…?" question is about the sentence just replaced. */
    state.voiceRich.querySelectorAll('.ta-confirm').forEach(el => el.remove());
    voiceStatus('listening', '');
    try { rec.start(); setListening(true); } catch { setListening(false); }
  }

  /** Below this recogniser confidence, ask before acting. */
  const UNSURE_BELOW = 0.5;

  /** "Did you say …?" — an uncertain transcript is confirmed, not guessed at. */
  function confirmHeard(text) {
    stopListening();
    voiceStatus('unsure', 'I’m not sure I heard that right. Did you say “' + text.trim() + '”?');
    const host = state.voiceRich;
    host.textContent = '';
    const yes = node('button', 'chat-chip ta-rich-chip', 'Yes, search');
    yes.type = 'button';
    yes.addEventListener('click', () => handleHeard(text, { confirmed: true }));
    const again = node('button', 'chat-chip ta-rich-chip', 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => { host.textContent = ''; toggleListening(); });
    const row = node('div', 'ta-rich-chips ta-confirm');
    row.appendChild(yes);
    row.appendChild(again);
    host.appendChild(row);
  }

  async function handleHeard(text, opts) {
    const said = String(text || '').trim();
    if (!said) { voiceStatus('error', 'I did not catch that — press the microphone and try again.'); return; }
    const now = Date.now();
    /* A recogniser can deliver the same final transcript twice. One sentence is
       one request — and a request already in flight is not repeated either. */
    if (!(opts && opts.confirmed) && said === state.lastHeard.text && (now - state.lastHeard.at) < 2500) return;
    if (state.sending) return;
    state.lastHeard = { text: said, at: now };
    state.sending = true;
    stopListening();
    state.voiceText.textContent = said;
    state.voiceRich.textContent = '';
    if (Results && Results.isStartOver(said)) {
      state.sending = false;
      voiceStatus('idle', startOver('voice'));
      return;
    }
    voiceStatus('thinking', 'Thinking…');
    try {
      const data = await ask(said, 'voice');
      voiceStatus('idle', data.reply);
      const type = data.action && data.action.type;
      if (Results && Results.isInlineAction(type)) {
        voiceStatus('loading', data.reply);
        await presentInline(data, state.voiceRich);
        voiceStatus('idle', data.reply);
        /* The shelf is on the page behind the popup, so the popup gets out of
           its way — after a beat, so the answer is read first. */
        if (type === 'show_destinations') setTimeout(closeVoice, 1200);
      } else if (type && type !== 'none') {
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
      /* Nothing to open: the answer is a question or a choice, so the
         suggestions are offered as buttons — the popup has no chip bar of its
         own, and a reply that ends in "which one?" should not end in silence. */
      if ((!type || type === 'none' || (Results && Results.isInlineAction(type)))
          && choicesOf(data).length && type !== 'show_destinations') {
        state.voiceRich.appendChild(chipRow(choicesOf(data)));
      }
    } catch (err) {
      voiceStatus('error', friendlyError(err));
    } finally {
      state.sending = false;
    }
  }

  /* ------------------------------------------------------------------ boot */
  function init() {
    /* A conversation held while signed out becomes the account's as soon as
       there is one — on load, and again whenever the session changes. */
    claimPending();
    loadContext();
    window.addEventListener('storage', e => {
      if (e.key === 'jpc_access' && e.newValue) claimPending();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (state.voice && !state.voice.hidden) closeVoice();
      else if (state.panel && state.panel.classList.contains('open')) closePanel(true);
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
    presentInline, choicesOf, asChoice,
  };
})();
