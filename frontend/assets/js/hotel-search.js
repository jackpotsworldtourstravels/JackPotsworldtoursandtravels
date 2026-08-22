'use strict';
/* ===========================================================================
   hotel-search.js — the Hotels search panel.
   ===========================================================================
   Same shape as flight-search.js and built from the same SearchWidgets: a
   destination autocomplete, two calendars and a stepper popup. Nothing here
   re-implements a listbox or a month grid.

   WHAT THE DESTINATION LIST IS BUILT FROM. The spec asks for city, hotel,
   area, locality, landmark and tourist attraction. This data has three of
   those: `location` is "Area, City" and `name` is the hotel, so cities, areas
   and hotels are all derivable and all offered. Landmarks and tourist
   attractions are NOT — there is no such field, and inventing "near Charminar"
   would put words in the data's mouth. They arrive with the destination feed,
   and buildIndex() is the one function that changes.

   Nothing here searches. It validates, writes `state`, and calls onSearch().
   =========================================================================== */

const HotelSearch = (function () {

  const W = SearchWidgets;
  const $ = id => document.getElementById(id);
  const esc = W.esc;

  const RECENT_KEY = 'jpc_recent_destinations';
  const RECENT_MAX = 5;
  const MAX_ROOMS = 4;

  /* Shown before anything is typed. Derived from the catalogue at mount time
     rather than hardcoded, so it cannot name a city we do not sell. */
  let TRENDING = [];

  const PRICE_BANDS = [
    { id: 'any',       label: 'Any price',        min: 0,    max: Infinity },
    { id: '0-1500',    label: '₹0 – 1,500',      min: 0,    max: 1500 },
    { id: '1500-3000', label: '₹1,500 – 3,000',  min: 1500, max: 3000 },
    { id: '3000-5000', label: '₹3,000 – 5,000',  min: 3000, max: 5000 },
    { id: '5000-8000', label: '₹5,000 – 8,000',  min: 5000, max: 8000 },
    { id: '8000+',     label: '₹8,000+',         min: 8000, max: Infinity },
  ];

  const CHILD_AGES = Array.from({ length: 18 }, (_, i) => i);   // 0..17
  const DEFAULT_CHILD_AGE = 8;

  let state = null;
  let onSearch = null;
  let hotels = [];
  let searching = false;

  /* ---------------------------------------------------------------------
     Destination index
     --------------------------------------------------------------------- */
  function buildIndex(rows) {
    const cities = new Map();
    const areas = new Map();
    const names = [];

    rows.forEach(h => {
      const parts = String(h.location || '').split(',').map(s => s.trim()).filter(Boolean);
      const city = parts[parts.length - 1];
      const area = parts.length > 1 ? parts[0] : null;
      if (city) cities.set(city, (cities.get(city) || 0) + 1);
      if (area) areas.set(area, city);
      names.push({ key: h.name, label: h.name, sub: `Hotel · ${h.location}`, kind: 'hotel' });
    });

    return [
      ...[...cities].map(([c, n]) => ({ key: c, label: c, sub: `City · ${n} propert${n === 1 ? 'y' : 'ies'}`, kind: 'city' })),
      ...[...areas].map(([a, c]) => ({ key: a, label: a, sub: `Area · ${c}`, kind: 'area' })),
      ...names,
    ];
  }

  function recent() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw) ? raw.slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }

  function remember(dest) {
    if (!dest) return;
    try {
      const next = [dest, ...recent().filter(d => d !== dest)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch { /* private mode */ }
  }

  function destinationSource(query) {
    const index = buildIndex(hotels);
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      const recents = recent().map(d => ({ key: d, label: d, sub: '', group: 'Recent searches' }));
      const trending = TRENDING
        .filter(t => !recents.some(r => r.key === t.key))
        .map(t => ({ ...t, group: 'Trending destinations' }));
      const popular = index
        .filter(i => i.kind === 'city' && !trending.some(t => t.key === i.key)
                                       && !recents.some(r => r.key === i.key))
        .map(i => ({ ...i, group: 'Popular destinations' }));
      return [...recents, ...trending, ...popular];
    }
    return index
      .filter(i => i.label.toLowerCase().includes(q) || String(i.sub).toLowerCase().includes(q))
      /* Cities first: "Hyderabad" almost always means the city, not a hotel
         that happens to have it in its name. */
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 8)
      .map(i => ({ ...i, group: '' }));
  }

  const rank = i => (i.kind === 'city' ? 0 : i.kind === 'area' ? 1 : 2);

  /* ---------------------------------------------------------------------
     Rooms & guests
     --------------------------------------------------------------------- */
  function blankRoom() { return { adults: 2, children: 0, childAges: [] }; }

  function totals() {
    return state.roomsList.reduce((a, r) => ({
      adults: a.adults + r.adults,
      children: a.children + r.children,
    }), { adults: 0, children: 0 });
  }

  function roomsSummary() {
    const t = totals();
    const n = state.roomsList.length;
    const guests = t.adults + t.children;
    return `${n} room${n === 1 ? '' : 's'} · ${guests} guest${guests === 1 ? '' : 's'}`;
  }

  function paintRooms() {
    const pop = $('txRoomsPop');
    if (!pop) return;
    pop.innerHTML = `
      ${state.roomsList.map((room, i) => `
        <section class="tx-room" data-room="${i}">
          <header>
            <b>Room ${i + 1}</b>
            ${state.roomsList.length > 1
              ? `<button type="button" class="tx-room-remove" data-remove-room="${i}">Remove</button>` : ''}
          </header>
          ${W.stepperRow(`adults${i}`, 'Adults', '18 and over', room.adults, 1, 8, `data-room-idx="${i}"`)}
          ${W.stepperRow(`children${i}`, 'Children', '0 to 17 years', room.children, 0, 4, `data-room-idx="${i}"`)}
          ${room.children ? `<div class="tx-pax-ages">
            <b>Child ages</b>
            <div class="tx-pax-agegrid">${Array.from({ length: room.children }, (_, c) => `
              <label><span>Child ${c + 1}</span>
                <select data-room-age="${i}" data-child="${c}">${CHILD_AGES.map(a =>
                  `<option value="${a}"${(room.childAges[c] ?? DEFAULT_CHILD_AGE) === a ? ' selected' : ''}>${
                    a === 0 ? 'Under 1' : a}</option>`).join('')}</select>
              </label>`).join('')}</div>
          </div>` : ''}
        </section>`).join('')}
      <button type="button" class="tx-btn tx-btn-ghost tx-room-add" id="txAddRoom"
        ${state.roomsList.length >= MAX_ROOMS ? 'disabled' : ''}>+ Add room</button>
      ${state.roomsList.length >= MAX_ROOMS
        ? '<p class="tx-pax-note">Four rooms is the most that can be booked at once. For a larger party, use Group booking.</p>'
        : ''}
      <button type="button" class="tx-btn tx-btn-primary tx-pax-done" id="txRoomsDone">Done</button>`;
    const trigger = $('txRoomsBtn');
    if (trigger) trigger.textContent = roomsSummary();
  }

  function mountRooms() {
    const btn = $('txRoomsBtn');
    const pop = $('txRoomsPop');
    if (!btn || !pop) return;

    const close = W.dismissable('txRoomsPop', 'txRoomsBtn');
    btn.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
      if (!pop.hidden) paintRooms();
    });

    pop.addEventListener('click', e => {
      const step = e.target.closest('[data-step-key]');
      if (step) {
        const i = Number(step.dataset.roomIdx);
        const key = step.dataset.stepKey.replace(/\d+$/, '');
        const delta = Number(step.dataset.delta);
        const limits = key === 'adults' ? [1, 8] : [0, 4];
        const room = state.roomsList[i];
        room[key] = Math.min(limits[1], Math.max(limits[0], room[key] + delta));
        if (key === 'children') room.childAges = room.childAges.slice(0, room.children);
        paintRooms();
        return;
      }
      const rm = e.target.closest('[data-remove-room]');
      if (rm) { state.roomsList.splice(Number(rm.dataset.removeRoom), 1); paintRooms(); return; }
      if (e.target.id === 'txAddRoom') {
        if (state.roomsList.length < MAX_ROOMS) state.roomsList.push(blankRoom());
        paintRooms();
        return;
      }
      if (e.target.id === 'txRoomsDone' && close) close();
    });

    pop.addEventListener('change', e => {
      const age = e.target.closest('[data-room-age]');
      if (age) {
        state.roomsList[Number(age.dataset.roomAge)].childAges[Number(age.dataset.child)] = Number(age.value);
      }
    });
  }

  /* ---------------------------------------------------------------------
     Markup
     --------------------------------------------------------------------- */
  function render(panel) {
    const nights = W.nightsBetween(state.checkIn, state.checkOut);
    const mode = state.searchMode || 'rooms';

    panel.innerHTML = `
      <div class="tx-trip">
        <label class="tx-radio"><input type="radio" name="txMode" value="rooms"${
          mode === 'rooms' ? ' checked' : ''}> <span>Up to 4 rooms</span></label>
        <label class="tx-radio"><input type="radio" name="txMode" value="group"${
          mode === 'group' ? ' checked' : ''}> <span>Group booking</span></label>
      </div>

      ${mode === 'group' ? `
        <div class="tx-empty tx-group-note">
          <b>Group booking</b>
          For parties needing more than four rooms we quote by hand — there is no
          instant rate for a block booking. Tell us the dates and size and the
          desk will come back with a quote.
          <a class="tx-btn tx-btn-primary" href="index.html#contact">Request a group quote</a>
        </div>` : `
        <div class="tx-searchgrid tx-hotelgrid">
          ${W.autocompleteField('txDest', 'Destination', {
            placeholder: 'City, area or hotel',
            value: state.dest || '',
            key: state.dest || '',
          })}
          ${W.calendarField('txCheckIn', 'Check-in', state.checkIn, W.today())}
          ${W.calendarField('txCheckOut', 'Check-out', state.checkOut,
            state.checkIn ? W.addDays(state.checkIn, 1) : W.today())}
          <div class="tx-sf tx-nights">
            <label>Nights</label>
            <output class="tx-nights-out" id="txNights">${nights || '—'}</output>
          </div>
          <div class="tx-sf tx-pax">
            <label for="txRoomsBtn">Rooms &amp; guests</label>
            <button type="button" class="tx-pax-trigger" id="txRoomsBtn" aria-haspopup="dialog" aria-expanded="false"></button>
            <div class="tx-pax-pop" id="txRoomsPop" role="dialog" aria-label="Rooms and guests" hidden></div>
            <p class="tx-err" id="txRoomsErr" role="alert"></p>
          </div>
          <div class="tx-sf">
            <label for="txPrice">Price per night</label>
            <select id="txPrice">${PRICE_BANDS.map(b =>
              `<option value="${esc(b.id)}"${b.id === (state.priceRange || 'any') ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}</select>
          </div>
          <button type="button" class="tx-btn tx-btn-primary tx-searchgo" id="txHotelGo">Search hotels</button>
        </div>`}`;
  }

  /* ---------------------------------------------------------------------
     Wiring
     --------------------------------------------------------------------- */
  function bind(panel) {
    panel.querySelectorAll('input[name="txMode"]').forEach(r => {
      r.addEventListener('change', () => { state.searchMode = r.value; mount(); });
    });
    if (state.searchMode === 'group') return;

    W.mountAutocomplete('txDest', {
      source: destinationSource,
      emptyText: 'No destinations match that.',
      onPick: row => { state.dest = row.key; remember(row.key); },
    });

    const nightsOut = () => {
      const n = W.nightsBetween($('txCheckIn').value, $('txCheckOut').value);
      const el = $('txNights');
      if (el) el.textContent = n || '—';
      return n;
    };

    const outCal = W.mountCalendar('txCheckOut', {
      placeholder: 'Select a date',
      onPick: d => { state.checkOut = d; nightsOut(); },
    });

    W.mountCalendar('txCheckIn', {
      placeholder: 'Select a date',
      /* The stay is shaded between the two dates, so the calendar shows the
         nights rather than only the day being picked. */
      rangeEnd: () => $('txCheckOut')?.value || null,
      onPick: d => {
        state.checkIn = d;
        const out = $('txCheckOut');
        if (out) {
          /* A one-night minimum: check-out cannot be the arrival day, so the
             floor is the day after — which also drops a now-impossible date
             rather than leaving it to fail at validation. */
          out.min = W.addDays(d, 1);
          if (out.value && out.value <= d) { out.value = ''; state.checkOut = ''; }
          outCal?.refresh();
        }
        nightsOut();
        setTimeout(() => $('txCheckOutBtn')?.click(), 120);
      },
    });

    mountRooms();
    paintRooms();
    nightsOut();

    $('txPrice')?.addEventListener('change', e => { state.priceRange = e.target.value; });
    $('txHotelGo')?.addEventListener('click', submit);
  }

  /* ---------------------------------------------------------------------
     Validate
     --------------------------------------------------------------------- */
  function readDest() {
    const el = $('txDest');
    if (!el) return '';
    if (el.dataset.key) return el.dataset.key;
    const typed = el.value.trim();
    if (!typed) return '';
    /* A typed name that exactly matches something in the index counts as a
       choice; anything else is reported rather than guessed at. */
    const hit = buildIndex(hotels).find(i => i.label.toLowerCase() === typed.toLowerCase());
    return hit ? hit.key : '';
  }

  function validate() {
    W.clearAllErrors('#txSearchPanel');

    const dest = readDest();
    if (!dest) {
      const typed = ($('txDest')?.value || '').trim();
      return W.setError('txDest', typed
        ? 'We could not find that destination — pick one from the list.'
        : 'Tell us where you are going.');
    }
    const ci = $('txCheckIn').value;
    const co = $('txCheckOut').value;
    if (!ci) return W.setError('txCheckIn', 'Choose a check-in date.');
    if (!co) return W.setError('txCheckOut', 'Choose a check-out date.');
    if (co <= ci) return W.setError('txCheckOut', 'Check-out must be at least one night after check-in.');

    if (state.roomsList.length > MAX_ROOMS) {
      return W.setError('txRooms', 'Four rooms is the most that can be booked at once.');
    }
    for (let i = 0; i < state.roomsList.length; i++) {
      const room = state.roomsList[i];
      if (room.adults < 1) return W.setError('txRooms', `Room ${i + 1} needs at least one adult.`);
      for (let c = 0; c < room.children; c++) {
        if (room.childAges[c] === undefined || room.childAges[c] === null) {
          $('txRoomsBtn')?.click();
          return W.setError('txRooms', `Choose an age for child ${c + 1} in room ${i + 1}.`);
        }
      }
    }

    state.dest = dest;
    state.checkIn = ci;
    state.checkOut = co;
    return true;
  }

  function request() {
    const t = totals();
    return {
      destination: state.dest,
      checkIn: state.checkIn,
      checkOut: state.checkOut,
      nights: W.nightsBetween(state.checkIn, state.checkOut),
      rooms: state.roomsList.length,
      roomsDetail: state.roomsList.map(r => ({
        adults: r.adults,
        children: r.children,
        childAges: Array.from({ length: r.children }, (_, i) => r.childAges[i] ?? DEFAULT_CHILD_AGE),
      })),
      adults: t.adults,
      children: t.children,
      childAges: state.roomsList.flatMap(r =>
        Array.from({ length: r.children }, (_, i) => r.childAges[i] ?? DEFAULT_CHILD_AGE)),
      priceRange: state.priceRange || 'any',
      searchMode: state.searchMode || 'rooms',
    };
  }

  /** The band a nightly rate falls in — used by the results filter. */
  function inPriceBand(pricePerNight, bandId) {
    const band = PRICE_BANDS.find(b => b.id === (bandId || 'any'));
    if (!band || band.id === 'any') return true;
    return pricePerNight >= band.min && pricePerNight < band.max;
  }

  async function submit() {
    if (searching) return;
    if (!validate()) return;
    const btn = $('txHotelGo');
    searching = true;
    if (btn) {
      btn.disabled = true;
      btn.dataset.label = btn.textContent;
      btn.innerHTML = '<span class="tx-spin" aria-hidden="true"></span> Searching…';
    }
    try {
      if (onSearch) await onSearch(request());
    } finally {
      searching = false;
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Search hotels'; }
    }
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  function mount() {
    const panel = $('txSearchPanel');
    if (!panel) return;
    render(panel);
    bind(panel);
  }

  function init(sharedState, rows, handler) {
    state = sharedState;
    hotels = rows || [];
    onSearch = handler;

    /* Trending is the three cities with the most properties — derived, so it
       cannot advertise somewhere with nothing to book. */
    TRENDING = buildIndex(hotels)
      .filter(i => i.kind === 'city')
      .slice(0, 3)
      .map(i => ({ key: i.key, label: i.label, sub: i.sub }));

    if (!Array.isArray(state.roomsList) || !state.roomsList.length) {
      /* Seeded from whatever the landing page sent, so a hero search for
         2 rooms opens with 2 rooms. */
      const rooms = Math.min(MAX_ROOMS, Math.max(1, state.rooms || 1));
      const guests = Math.max(rooms, state.guests || 2);
      const perRoom = Math.max(1, Math.min(8, Math.round(guests / rooms)));
      state.roomsList = Array.from({ length: rooms }, () => ({ ...blankRoom(), adults: perRoom }));
    }
    if (!state.priceRange) state.priceRange = 'any';
    if (!state.searchMode) state.searchMode = 'rooms';
    mount();
  }

  return { init, mount, request, validate, inPriceBand, destinationSource, PRICE_BANDS };
})();
