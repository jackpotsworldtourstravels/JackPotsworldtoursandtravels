'use strict';
/* Merchant Home — the MakeMyTrip-style booking surface that a merchant lands on
   after sign-in.
   ---------------------------------------------------------------------------
   Backend: nothing new. This is a different front door onto endpoints that
   already shipped in Phase 2 —
     GET /api/catalog/search        (the same call Ticket Enquiry makes)
     GET /api/catalog/{id}/quote    (server-priced, so the fare can't be tampered with)
     GET /api/merchant/dashboard    (wallet + counts for the B2B strip)
     GET /api/requests?search=      (the header's global search)
   "Request" hands off to the existing Request Ticket flow via startRequestTicket()
   in partner-request-ticket.js — the passenger-details step, draft/submit calls and
   approval lifecycle are untouched, so the whole approved Phase 2 workflow still
   runs exactly as it was verified.

   Travel types come from TravelType in models_v2.py: flight, hotel, cruise, package.
   Packages are a real enum member and /api/catalog/search accepts them, but whether
   any package inventory exists depends on the catalog rows — an empty result renders
   the same empty state as any other unmatched search.

   Results are refined client-side (mh-filters.js) and drawn with generated
   imagery (mh-visuals.js); see the header comments in those files for why. */

const MH_TYPES = {
  flight: {
    label: '✈️ Flights', emoji: '✈️', cols: '', noun: 'flight',
    fields: ['origin', 'swap', 'destination', 'date', 'passengers', 'cabin'],
    loading: ['Searching flights…', 'Comparing your negotiated fares…', 'Checking seat availability…'],
  },
  hotel: {
    label: '🏨 Hotels', emoji: '🏨', cols: 'mh-cols-4', noun: 'hotel',
    fields: ['destination', 'date', 'passengers'],
    loading: ['Searching hotels…', 'Finding the best rates…', 'Checking room availability…'],
  },
  cruise: {
    label: '🚢 Cruises', emoji: '🚢', cols: 'mh-cols-5', noun: 'cruise',
    fields: ['origin', 'destination', 'date', 'passengers'],
    loading: ['Searching sailings…', 'Comparing cabin fares…', 'Checking cabin availability…'],
  },
  package: {
    label: '🏝️ Packages', emoji: '🏝️', cols: 'mh-cols-4', noun: 'package',
    fields: ['destination', 'date', 'passengers'],
    loading: ['Searching packages…', 'Pricing itineraries…', 'Checking departures…'],
  },
};

const MH_CABINS = [
  ['', 'Any Cabin'], ['economy', 'Economy'], ['premium_economy', 'Premium Economy'],
  ['business', 'Business'], ['first_class', 'First Class'],
];

/* Filters are applied to what the API returned (mh-filters.js explains why), so
   ask for a wide page — otherwise the rail would describe only the first 20 rows.
   100 is the router's documented ceiling for page_size. */
const MH_PAGE_SIZE = 100;

/* Cards render in batches as the merchant scrolls rather than all at once, so a
   large result set doesn't build hundreds of DOM nodes up front. */
const MH_BATCH = 12;

let mhType = 'flight';
let mhSearched = false;

/* Current result set + view state. `mhAll` is what the API returned; `mhShown`
   is that set after filters and sorting. */
let mhAll = [];
let mhShown = [];
let mhTotal = 0;
let mhRendered = 0;
let mhPassengers = 1;
let mhFilterGroups = [];
let mhFilterState = {};
let mhSort = 'price_asc';
let mhLoadingTimer = null;
let mhSearchSeq = 0;

/* ---------------------------------------------------------------- search card */

function mhFieldHtml(type, field) {
  const p = `mh-${type}`;
  switch (field) {
    case 'origin':
      return `<div class="mh-field"><label for="${p}Origin">From</label>
        <input id="${p}Origin" type="text" placeholder="City or code" autocomplete="off"></div>`;
    case 'swap':
      return `<button type="button" class="mh-swap" data-mh-swap="${type}" aria-label="Swap from and to">⇆</button>`;
    case 'destination':
      return `<div class="mh-field"><label for="${p}Destination">${type === 'flight' || type === 'cruise' ? 'To' : 'Destination'}</label>
        <input id="${p}Destination" type="text" placeholder="City or code" autocomplete="off"></div>`;
    case 'date':
      return `<div class="mh-field"><label for="${p}Date">${type === 'hotel' ? 'Check-in' : 'Travel Date'}</label>
        <input id="${p}Date" type="date"></div>`;
    case 'passengers':
      return `<div class="mh-field"><label for="${p}Passengers">${type === 'hotel' ? 'Guests' : 'Passengers'}</label>
        <select id="${p}Passengers">${[1, 2, 3, 4, 5, 6, 7, 8, 9]
          .map(n => `<option value="${n}">${n}</option>`).join('')}</select></div>`;
    case 'cabin':
      return `<div class="mh-field"><label for="${p}Cabin">Cabin</label>
        <select id="${p}Cabin">${MH_CABINS
          .map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>`;
    default:
      return '';
  }
}

function mhRenderSearchCard() {
  const tabs = Object.entries(MH_TYPES)
    .map(([type, cfg]) => `<button type="button" class="mh-tab${type === mhType ? ' active' : ''}"
      role="tab" aria-selected="${type === mhType}" data-mh-tab="${type}">${cfg.label}</button>`).join('');

  const panels = Object.entries(MH_TYPES).map(([type, cfg]) => `
    <div class="mh-panel${type === mhType ? ' active' : ''}" data-mh-panel="${type}">
      <div class="mh-fields ${cfg.cols}">
        ${cfg.fields.map(f => mhFieldHtml(type, f)).join('')}
        <button type="button" class="mh-btn mh-btn-coral mh-go" data-mh-search="${type}">Search</button>
      </div>
    </div>`).join('');

  document.getElementById('mhSearchCard').innerHTML = `
    <div class="mh-tabs" role="tablist" aria-label="Booking type">${tabs}</div>
    <div class="mh-body">${panels}</div>
    <div class="mh-quick" id="mhQuickRow"></div>`;

  mhEnhanceSearchFields();

  document.querySelectorAll('[data-mh-tab]').forEach(btn => {
    btn.addEventListener('click', () => mhSetType(btn.dataset.mhTab));
  });
  document.querySelectorAll('[data-mh-search]').forEach(btn => {
    btn.addEventListener('click', () => mhRunSearch({ reveal: true }));
  });
  document.querySelectorAll('[data-mh-swap]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.mhSwap;
      const a = document.getElementById(`mh-${t}Origin`);
      const b = document.getElementById(`mh-${t}Destination`);
      if (!a || !b) return;
      /* The resolved IATA token has to travel with the visible text, or swapping
         two picked cities would search the old pair. */
      const v = a.value; const t2 = a.dataset.searchToken;
      a.value = b.value; b.value = v;
      if (b.dataset.searchToken) a.dataset.searchToken = b.dataset.searchToken;
      else delete a.dataset.searchToken;
      if (t2) b.dataset.searchToken = t2; else delete b.dataset.searchToken;
    });
  });
  /* Enter anywhere in the active panel searches, like the public site. */
  document.querySelectorAll('.mh-panel input').forEach(input => {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') mhRunSearch({ reveal: true }); });
  });
}

/* Hero background videos — one clip per booking tab, mirroring the public
   landing page. Clips other than Flights carry data-src and are only given a
   real src the first time their tab is opened, so the page still loads one
   video, not four. */
const MH_HERO_VIDEO_SPEED = 1.35;

function mhHeroVideos() {
  return document.querySelectorAll('.mh-hero-video-layer video');
}

function mhSwitchHeroVideo(type) {
  mhHeroVideos().forEach(v => {
    if (v.dataset.mhVideo === type) {
      v.classList.add('active');
      if (!v.getAttribute('src') && v.dataset.src) {
        v.setAttribute('src', v.dataset.src);
        /* Assigning src aborts the play() below, so the clip would sit on a
           frozen first frame. Play again once it can actually play — guarded on
           still-active so a quick tab switch doesn't restart a hidden clip. */
        v.addEventListener('canplay', () => {
          if (!v.classList.contains('active')) return;
          v.playbackRate = MH_HERO_VIDEO_SPEED;
          const q = v.play();
          if (q && q.catch) q.catch(() => {});
        }, { once: true });
      }
      v.playbackRate = MH_HERO_VIDEO_SPEED;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      v.classList.remove('active');
      v.pause();
    }
  });
}

function mhInitHero() {
  mhHeroVideos().forEach(v => {
    v.playbackRate = MH_HERO_VIDEO_SPEED;
    v.addEventListener('loadedmetadata', () => { v.playbackRate = MH_HERO_VIDEO_SPEED; });
  });
  /* Parallax matches the landing page, and is skipped for reduced-motion. */
  const bg = document.getElementById('mhHeroBg');
  const layer = document.getElementById('mhHeroVideoLayer');
  if (bg && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.addEventListener('scroll', () => {
      const y = Math.min(window.scrollY, 800);
      const t = `translateY(${y * 0.25}px) scale(${1 + y * 0.0002})`;
      bg.style.transform = t;
      if (layer) layer.style.transform = t;
    }, { passive: true });
  }
}

function mhSetType(type) {
  if (!MH_TYPES[type]) return;
  const changed = mhType !== type;
  mhType = type;
  mhSwitchHeroVideo(type);
  document.querySelectorAll('[data-mh-tab]').forEach(b => {
    const on = b.dataset.mhTab === type;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('[data-mh-panel]').forEach(p => {
    p.classList.toggle('active', p.dataset.mhPanel === type);
  });
  document.querySelectorAll('[data-mh-navlink]').forEach(l => {
    l.classList.toggle('active', l.dataset.mhNavlink === type);
  });
  /* Filters belong to the result set they were built from; a different travel
     type has entirely different facets. */
  if (changed) { mhClearFilterState(mhFilterState); mhSort = 'price_asc'; }
  mhRenderDiscover();
  if (mhSearched) mhRunSearch();
}

/* ============================================================ recent searches

   Kept in localStorage, per merchant, so "Delhi → Dubai" survives a reload the
   way it does on the public site. Nothing here is sent anywhere — there is no
   search-history endpoint, and inventing one would be a backend change. */

const MH_RECENT_KEY = 'mh_recent_searches';
const MH_RECENT_MAX = 6;

function mhRecentSearches() {
  try {
    const raw = JSON.parse(localStorage.getItem(MH_RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(r => r && r.type && MH_TYPES[r.type]) : [];
  } catch { return []; }
}

/* Signature deliberately excludes the date and party size: a merchant re-running
   "Delhi → Dubai" for a new date should replace the old entry, not add a
   near-duplicate row. */
function mhRecentKeyOf(entry) {
  return [entry.type, entry.originToken || entry.origin || '', entry.destinationToken || entry.destination || '']
    .join('|').toLowerCase();
}

function mhRememberSearch(entry) {
  if (!entry.origin && !entry.destination) return;   // an unfiltered browse isn't a search
  const list = mhRecentSearches().filter(r => mhRecentKeyOf(r) !== mhRecentKeyOf(entry));
  list.unshift({ ...entry, ts: Date.now() });
  try {
    localStorage.setItem(MH_RECENT_KEY, JSON.stringify(list.slice(0, MH_RECENT_MAX)));
  } catch { /* quota or private mode — recents are a nicety, never block a search */ }
  mhRenderDiscover();
}

function mhRecentLabel(r) {
  const cfg = MH_TYPES[r.type] || MH_TYPES.flight;
  const a = r.origin || r.originToken;
  const b = r.destination || r.destinationToken;
  const route = a && b ? `${a} → ${b}` : (b || a || cfg.noun);
  return `${cfg.emoji} ${route}`;
}

function mhApplyRecent(r) {
  mhSetType(r.type);
  const p = `mh-${r.type}`;
  const set = (id, value, token) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value || '';
    if (token) el.dataset.searchToken = token; else delete el.dataset.searchToken;
  };
  set(`${p}Origin`, r.origin, r.originToken);
  set(`${p}Destination`, r.destination, r.destinationToken);
  const pax = document.getElementById(`${p}Passengers`);
  if (pax && r.passengers) pax.value = String(r.passengers);
  const cabin = document.getElementById(`${p}Cabin`);
  if (cabin) cabin.value = r.cabin || '';
  /* The date is deliberately not restored — a saved date is usually in the past
     by the time the row is clicked, which would silently return nothing. */
  mhRunSearch({ reveal: true });
}

/* ======================================================= popular destinations

   A static shortlist, like the reference data behind the search fields: there is
   no "popular destinations" or trending endpoint, and the catalog has no
   popularity signal to derive one from. Codes are the ones the seeded inventory
   actually sells, so a click returns results rather than an empty state. */
const MH_POPULAR = [
  { flag: '🇦🇪', city: 'Dubai', code: 'DXB', country: 'UAE' },
  { flag: '🇹🇭', city: 'Bangkok', code: 'BKK', country: 'Thailand' },
  { flag: '🇸🇬', city: 'Singapore', code: 'SIN', country: 'Singapore' },
  { flag: '🇬🇧', city: 'London', code: 'LHR', country: 'United Kingdom' },
  { flag: '🇮🇳', city: 'Goa', code: 'GOI', country: 'India' },
  { flag: '🇲🇾', city: 'Kuala Lumpur', code: 'KUL', country: 'Malaysia' },
  { flag: '🇶🇦', city: 'Doha', code: 'DOH', country: 'Qatar' },
  { flag: '🇮🇳', city: 'Chennai', code: 'MAA', country: 'India' },
];

function mhApplyPopular(code) {
  const hit = MH_POPULAR.find(p => p.code === code);
  if (!hit) return;
  const el = document.getElementById(`mh-${mhType}Destination`);
  if (el) {
    /* Flights and cruises filter on the code; hotels and packages match the city
       name, because their inventory has no IATA code in `destination`. */
    const place = (mhType === 'flight' || mhType === 'cruise');
    el.value = place ? `${hit.city} (${hit.code})` : hit.city;
    el.dataset.searchToken = place ? hit.code : hit.city;
  }
  mhRunSearch({ reveal: true });
}

function mhRenderDiscover() {
  const host = document.getElementById('mhDiscover');
  if (!host) return;
  const recent = mhRecentSearches();

  host.innerHTML = `
    ${recent.length ? `
      <div class="mh-disc-row">
        <div class="mh-disc-head">
          <h3>Recent searches</h3>
          <button type="button" class="mh-disc-clear" id="mhRecentClear">Clear</button>
        </div>
        <div class="mh-disc-chips">
          ${recent.map((r, i) => `<button type="button" class="mh-chipbtn" data-mh-recent="${i}">
            ${escapeHtml(mhRecentLabel(r))}
          </button>`).join('')}
        </div>
      </div>` : ''}

    <div class="mh-disc-row">
      <div class="mh-disc-head"><h3>Popular with partners</h3></div>
      <div class="mh-pop-grid">
        ${MH_POPULAR.map(p => `
          <button type="button" class="mh-pop" data-mh-pop="${p.code}"
            aria-label="Search ${escapeHtml(p.city)}, ${escapeHtml(p.country)}">
            ${mhThumb(mhType, p.city, '')}
            <span class="mh-pop-text">
              <span class="mh-pop-city"><span aria-hidden="true">${p.flag}</span> ${escapeHtml(p.city)}</span>
              <span class="mh-pop-sub">${escapeHtml(p.country)} · ${p.code}</span>
            </span>
          </button>`).join('')}
      </div>
    </div>`;

  host.querySelectorAll('[data-mh-recent]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = mhRecentSearches()[Number(btn.dataset.mhRecent)];
      if (r) mhApplyRecent(r);
    });
  });
  host.querySelectorAll('[data-mh-pop]').forEach(btn => {
    btn.addEventListener('click', () => mhApplyPopular(btn.dataset.mhPop));
  });
  document.getElementById('mhRecentClear')?.addEventListener('click', () => {
    try { localStorage.removeItem(MH_RECENT_KEY); } catch { /* ignore */ }
    mhRenderDiscover();
  });
}

/* ================================================================== results */

function mhCabinLabel(v) {
  return v ? String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
}

/* Leaves the results heading just under the sticky travel header (76px) rather
   than flush against it, so the count and the sort control aren't half-covered. */
function mhScrollToResults() {
  const head = document.querySelector('.mh-results-head');
  if (!head) return;
  const y = head.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}

function mhDurText(mins) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/* Seat/room/cabin availability, with an urgency treatment under 6 — the same
   scarcity cue the public site uses, driven by the real available_units. */
function mhSeatsChip(item, noun) {
  if (item.available_units == null) return '';
  const n = Number(item.available_units);
  const low = n <= 5;
  return `<span class="mh-chip${low ? ' mh-chip-low' : ''}">${
    low ? `Only ${n} ${noun}${n === 1 ? '' : 's'} left` : `${n} ${noun}s available`}</span>`;
}

function mhFareBlock(item, passengers) {
  const per = Number(item.total_amount);
  const total = Number.isFinite(per) ? per * passengers : null;
  return `
    <div class="mh-rprice">${money(item.total_amount)}<small>/pax</small></div>
    ${passengers > 1 && total != null
      ? `<div class="mh-rtotal">${money(total)} for ${passengers}</div>`
      : '<div class="mh-rtotal">incl. taxes</div>'}
    <button type="button" class="mh-btn mh-btn-coral mh-btn-sm mh-rcta"
      data-mh-request="${item.id}" data-mh-pax="${passengers}">Request</button>`;
}

/* Only rendered when the inventory actually carries the flag — see mhFlag(). */
function mhRefundChip(item) {
  const f = mhFlag(item, ['refundable', 'is_refundable', 'fare_type']);
  if (f == null) return '';
  return `<span class="mh-chip ${f ? 'mh-chip-ok' : 'mh-chip-warn'}">${f ? 'Refundable' : 'Non-refundable'}</span>`;
}

function mhFlightCard(item, passengers) {
  const d = mhD(item);
  const dur = mhDurationMins(item);
  const stops = mhNum(d.stops);
  return `
    <article class="mh-rcard mh-rcard-flight" data-mh-reveal>
      <div class="mh-rhead">
        ${mhAirlineLogo({ name: d.airline, flightNumber: d.flight_number, travelType: 'flight' })}
        <div class="mh-rcarrier">
          <div class="mh-rname">${escapeHtml(d.airline || item.title || 'Flight')}</div>
          <div class="mh-rmeta">${escapeHtml(d.flight_number || '')}${
            d.cabin_class ? ` · ${escapeHtml(mhCabinLabel(d.cabin_class))}` : ''}</div>
        </div>
      </div>

      <div class="mh-rleg">
        <div class="mh-rend">
          <div class="mh-rtime">${d.departure_time ? escapeHtml(fmtTime(d.departure_time)) : '—'}</div>
          <div class="mh-rcode">${escapeHtml(d.origin || '')}</div>
          <div class="mh-rcity">${escapeHtml(d.origin_city || '')}</div>
        </div>
        <div class="mh-rmid">
          <span class="mh-rdur">${escapeHtml(mhDurText(dur))}</span>
          <span class="mh-rline"><i class="mh-rdot"></i><span class="mh-rplane" aria-hidden="true">✈</span></span>
          <span class="mh-rstops">${stops === 0 ? 'Non-stop' : stops == null ? '' : `${stops} stop${stops > 1 ? 's' : ''}`}</span>
        </div>
        <div class="mh-rend mh-rend-r">
          <div class="mh-rtime">${d.arrival_time ? escapeHtml(fmtTime(d.arrival_time)) : '—'}</div>
          <div class="mh-rcode">${escapeHtml(d.destination || '')}</div>
          <div class="mh-rcity">${escapeHtml(d.destination_city || '')}</div>
        </div>
      </div>

      <div class="mh-rright">${mhFareBlock(item, passengers)}</div>

      <div class="mh-rchips">
        ${item.travel_date ? `<span class="mh-chip mh-chip-plain">${escapeHtml(fmtDate(item.travel_date))}</span>` : ''}
        ${d.baggage_kg ? `<span class="mh-chip mh-chip-plain">🧳 ${escapeHtml(String(d.baggage_kg))} kg</span>` : ''}
        ${d.trip_type ? `<span class="mh-chip mh-chip-plain">${escapeHtml(String(d.trip_type).replace(/_/g, ' '))}</span>` : ''}
        ${mhRefundChip(item)}
        ${mhSeatsChip(item, 'seat')}
      </div>
    </article>`;
}

/* Amenity glyphs. Anything unmapped still renders, just with a neutral dot, so a
   new amenity string from the inventory is never dropped silently. */
const MH_AMENITY_ICON = {
  wifi: '📶', 'free wifi': '📶', internet: '📶',
  breakfast: '🍳', 'free breakfast': '🍳', meals: '🍳',
  pool: '🏊', 'swimming pool': '🏊',
  gym: '🏋', fitness: '🏋',
  spa: '💆', parking: '🅿', restaurant: '🍽', bar: '🍸',
  ac: '❄', 'air conditioning': '❄', laundry: '🧺',
  'airport shuttle': '🚐', shuttle: '🚐', 'pet friendly': '🐾', beach: '🏖',
};

/* The two badges the brief calls out. Both are conditional on the inventory
   actually saying so — mhFlag returns null for "doesn't say", and a null must
   never render as a promise of free cancellation. The seeded catalogue carries
   no cancellation key at all, so that badge correctly stays hidden until real
   inventory supplies one. */
function mhStayBadges(item) {
  const out = [];
  const freeCancel = mhFlag(item, [
    'free_cancellation', 'freeCancellation', 'refundable', 'is_refundable', 'cancellation',
  ]);
  if (freeCancel === true) {
    out.push('<span class="mh-badge mh-badge-ok">✓ Free cancellation</span>');
  }
  const amenities = mhAmenities(item);
  const hasBreakfast = amenities.some(a => a.includes('breakfast')) ||
    /breakfast/i.test(String(mhD(item).meal_plan || ''));
  if (hasBreakfast) {
    out.push('<span class="mh-badge mh-badge-warm">🍳 Breakfast included</span>');
  }
  return out.join('');
}

/* Hotel money, stated the way a hotelier states it.

   The headline is the per-night rate, which is what the brief asks for and what
   every OTA leads with — but it is DERIVED (total_amount / nights), so the exact
   figure the request is raised against is always printed underneath it. When
   nights is missing the derivation is skipped rather than guessed.

   Deliberately NOT multiplied by the guest count, unlike mhFareBlock: a room
   rate is per room, not per person, so "x2 guests" would have overstated the
   stay. The Request button still carries the same data-mh-pax it always did, so
   nothing about what gets submitted changes — this is the display only. */
function mhStayFareBlock(item, passengers, nights) {
  const total = Number(item.total_amount);
  const perNight = Number.isFinite(total) && nights ? total / nights : null;

  return `
    ${perNight != null
      ? `<div class="mh-rprice">${money(perNight)}<small>/night</small></div>
         <div class="mh-rtotal">${money(total)} total · ${nights} night${nights === 1 ? '' : 's'}</div>`
      : `<div class="mh-rprice">${money(item.total_amount)}</div>
         <div class="mh-rtotal">total · incl. taxes</div>`}
    <button type="button" class="mh-btn mh-btn-coral mh-btn-sm mh-rcta"
      data-mh-request="${item.id}" data-mh-pax="${passengers}">Request</button>`;
}

function mhStayCard(item, passengers, index) {
  const d = mhD(item);
  const name = d.hotel_name || item.title || 'Hotel';
  const city = d.destination_city || d.destination || '';
  const stars = mhNum(d.star_rating);
  const amenities = mhAmenities(item).slice(0, 4);
  const nights = mhNum(d.nights);
  const place = [city, d.country].filter(Boolean).join(', ');

  return `
    <article class="mh-rcard mh-rcard-media mh-rcard-hotel" data-mh-reveal>
      ${hotelImageHtml({
        name,
        city,
        /* Full-bleed below 640, a fixed thumbnail column above it — the same
           numbers the stylesheet uses, so the browser picks the 480w file for
           the desktop column and only pays for 960w on a phone. */
        sizes: '(max-width: 640px) 100vw, (max-width: 960px) 176px, 224px',
        /* The first two cards are above the fold on every viewport we support;
           lazy-loading them would only delay the thing the merchant came to see. */
        eager: index < 2,
      })}
      <div class="mh-rbody">
        <div class="mh-rname">${escapeHtml(name)}</div>
        <div class="mh-rmeta">
          ${stars ? `<span class="mh-stars" aria-label="${stars} star rating">${'★'.repeat(stars)}</span>` : ''}
          ${place ? `<span class="mh-rplace">📍 ${escapeHtml(place)}</span>` : ''}
        </div>
        ${d.room_type || amenities.length ? `
        <div class="mh-rchips">
          ${d.room_type ? `<span class="mh-chip mh-chip-sky">${escapeHtml(d.room_type)}</span>` : ''}
          ${amenities.map(a => `<span class="mh-chip mh-chip-plain">${
            MH_AMENITY_ICON[a] ? `${MH_AMENITY_ICON[a]} ` : ''}${escapeHtml(mhCabinLabel(a))}</span>`).join('')}
          ${mhSeatsChip(item, 'room')}
        </div>` : ''}
        ${(() => { const b = mhStayBadges(item); return b ? `<div class="mh-badges">${b}</div>` : ''; })()}
        ${item.travel_date ? `<div class="mh-rdates">Check-in ${escapeHtml(fmtDate(item.travel_date))}${
          item.return_date ? ` · Check-out ${escapeHtml(fmtDate(item.return_date))}` : ''}</div>` : ''}
      </div>
      <div class="mh-rright">${mhStayFareBlock(item, passengers, nights)}</div>
    </article>`;
}

function mhCruiseCard(item, passengers) {
  const d = mhD(item);
  const from = d.origin_city || d.origin || '';
  const to = d.destination_city || d.destination || '';
  const nights = mhNum(d.nights);
  const ports = Array.isArray(d.ports_of_call) ? d.ports_of_call : [];
  return `
    <article class="mh-rcard mh-rcard-media" data-mh-reveal>
      ${mhThumb('cruise', to || from || 'sea', from && to ? `${from} → ${to}` : (to || from))}
      <div class="mh-rbody">
        <div class="mh-rname">${escapeHtml(d.cruise_name || item.title || 'Cruise')}</div>
        <div class="mh-rmeta">${escapeHtml(d.cruise_line || '')}${
          from && to ? ` · ${escapeHtml(from)} → ${escapeHtml(to)}` : ''}</div>
        <div class="mh-rchips">
          ${nights ? `<span class="mh-chip mh-chip-sky">${nights} night${nights === 1 ? '' : 's'}</span>` : ''}
          ${d.cabin_class ? `<span class="mh-chip mh-chip-plain">${escapeHtml(mhCabinLabel(d.cabin_class))} cabin</span>` : ''}
          ${ports.length ? `<span class="mh-chip mh-chip-plain">⚓ ${escapeHtml(ports.join(' · '))}</span>` : ''}
          ${mhSeatsChip(item, 'cabin')}
        </div>
        ${item.travel_date ? `<div class="mh-rdates">Sails ${escapeHtml(fmtDate(item.travel_date))}${
          item.return_date ? ` · Returns ${escapeHtml(fmtDate(item.return_date))}` : ''}</div>` : ''}
      </div>
      <div class="mh-rright">${mhFareBlock(item, passengers)}</div>
    </article>`;
}

function mhPackageCard(item, passengers) {
  const d = mhD(item);
  const dest = d.destination_city || d.destination || '';
  const nights = mhNum(d.nights);
  const cities = Array.isArray(d.cities) ? d.cities : (Array.isArray(d.itinerary) ? d.itinerary : []);
  const inclusions = [
    d.meal_plan || d.meals, d.hotels_included && 'Hotels included',
    d.flights_included && 'Flights included', d.theme && mhCabinLabel(d.theme),
  ].filter(Boolean);
  return `
    <article class="mh-rcard mh-rcard-media" data-mh-reveal>
      ${mhThumb('package', dest || item.title || 'trip', dest)}
      <div class="mh-rbody">
        <div class="mh-rname">${escapeHtml(d.package_name || item.title || 'Package')}</div>
        <div class="mh-rmeta">${escapeHtml([dest, d.country].filter(Boolean).join(', '))}</div>
        <div class="mh-rchips">
          ${nights ? `<span class="mh-chip mh-chip-sky">${nights} night${nights === 1 ? '' : 's'}</span>` : ''}
          ${cities.length ? `<span class="mh-chip mh-chip-plain">📍 ${escapeHtml(cities.join(' · '))}</span>` : ''}
          ${inclusions.map(t => `<span class="mh-chip mh-chip-plain">${escapeHtml(String(t))}</span>`).join('')}
          ${mhSeatsChip(item, 'slot')}
        </div>
        ${item.travel_date ? `<div class="mh-rdates">Departs ${escapeHtml(fmtDate(item.travel_date))}</div>` : ''}
      </div>
      <div class="mh-rright">${mhFareBlock(item, passengers)}</div>
    </article>`;
}

/* `index` is the card's position in the whole result list, not in the batch —
   it only decides which hotel photographs skip lazy-loading, and that has to
   mean "first two on screen", not "first two of every batch of twelve". */
function mhResultCard(item, passengers, index) {
  switch (item.travel_type) {
    case 'hotel': return mhStayCard(item, passengers, index);
    case 'cruise': return mhCruiseCard(item, passengers);
    case 'package': return mhPackageCard(item, passengers);
    default: return mhFlightCard(item, passengers);
  }
}

/* ------------------------------------------------------------ loading state */

function mhSkeletonHtml(n = 4) {
  return Array.from({ length: n }, () => `
    <div class="mh-skel" aria-hidden="true">
      <div class="mh-skel-logo"></div>
      <div class="mh-skel-lines"><span></span><span></span><span></span></div>
      <div class="mh-skel-price"></div>
    </div>`).join('');
}

/* Rotates the per-type messages so a slow search reads as progress rather than
   a stuck spinner. aria-live is on the count element, which is where the final
   result total lands too. */
function mhStartLoadingMessages(cfg) {
  const el = document.getElementById('mhResultsCount');
  clearInterval(mhLoadingTimer);
  let i = 0;
  el.textContent = cfg.loading[0];
  el.classList.add('mh-loading-msg');
  mhLoadingTimer = setInterval(() => {
    i = (i + 1) % cfg.loading.length;
    el.textContent = cfg.loading[i];
  }, 1100);
}

function mhStopLoadingMessages() {
  clearInterval(mhLoadingTimer);
  mhLoadingTimer = null;
  document.getElementById('mhResultsCount')?.classList.remove('mh-loading-msg');
}

/* --------------------------------------------------------------- empty state */

function mhEmptyHtml(cfg, filtered) {
  if (filtered) {
    return `
      <div class="mh-empty">
        <span class="mh-empty-emoji" aria-hidden="true">🔍</span>
        <b>No ${escapeHtml(cfg.noun)}s match your filters</b>
        <span>${mhAll.length} option${mhAll.length === 1 ? '' : 's'} matched this search before filtering.</span>
        <button type="button" class="mh-btn mh-btn-outline mh-btn-sm" id="mhEmptyClearBtn">Clear filters</button>
      </div>`;
  }
  return `
    <div class="mh-empty">
      <span class="mh-empty-emoji" aria-hidden="true">${cfg.emoji}</span>
      <b>No ${escapeHtml(cfg.noun)}s found for this search</b>
      <span>Try a nearby date, widen the route, or pick a destination below.<br>
      Inventory is live — options appear here as soon as they're loaded.</span>
      <div class="mh-empty-alts">
        ${MH_POPULAR.slice(0, 5).map(p => `<button type="button" class="mh-chipbtn" data-mh-alt="${p.code}">
          <span aria-hidden="true">${p.flag}</span> ${escapeHtml(p.city)}</button>`).join('')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------ render results */

function mhAppendBatch() {
  const list = document.getElementById('mhResultsList');
  const slice = mhShown.slice(mhRendered, mhRendered + MH_BATCH);
  if (!slice.length) return;
  const frag = document.createElement('div');
  frag.innerHTML = slice.map((i, n) => mhResultCard(i, mhPassengers, mhRendered + n)).join('');
  const sentinel = list.querySelector('#mhMoreSentinel');
  while (frag.firstElementChild) list.insertBefore(frag.firstElementChild, sentinel);
  mhRendered += slice.length;

  const more = document.getElementById('mhMoreBtn');
  if (more) {
    const left = mhShown.length - mhRendered;
    if (left <= 0) document.getElementById('mhMoreSentinel').hidden = true;
    else more.textContent = `Show ${Math.min(left, MH_BATCH)} more of ${left}`;
  }
  mhReveal(list);
  /* A cached photograph can finish loading before this batch's nodes are even
     in the document, so its `load` event never reaches the listener. Sweep the
     newly inserted cards for images that are already complete, or their
     skeletons would shimmer forever over a picture that is right there. */
  hotelImageSettle(list);
}

let mhMoreObserver = null;

function mhWatchSentinel() {
  const sentinel = document.getElementById('mhMoreSentinel');
  if (!sentinel || !('IntersectionObserver' in window)) return;
  mhMoreObserver?.disconnect();
  mhMoreObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting) && mhRendered < mhShown.length) mhAppendBatch();
  }, { rootMargin: '300px' });
  mhMoreObserver.observe(sentinel);
}

/* Re-applies filters + sort to the fetched set and redraws. No network call —
   this is why the rail feels instant. */
function mhRefreshResults() {
  const cfg = MH_TYPES[mhType];
  const list = document.getElementById('mhResultsList');
  const countEl = document.getElementById('mhResultsCount');

  mhShown = mhSortItems(mhFilterItems(mhAll, mhFilterGroups, mhFilterState), mhSort);
  mhRendered = 0;

  const active = mhActiveFilterCount(mhFilterGroups, mhFilterState);
  const shownWord = `${mhShown.length} ${mhShown.length === 1 ? 'option' : 'options'}`;
  countEl.textContent = active
    ? `${shownWord} of ${mhAll.length} after filters`
    : (mhTotal > mhAll.length
      ? `${shownWord} shown of ${mhTotal} — narrow the search to see the rest`
      : shownWord);

  mhRenderFilterRail(
    document.getElementById('mhFilterRail'), mhFilterGroups, mhFilterState, mhType, mhRefreshResults,
  );
  const toggle = document.getElementById('mhFilterToggle');
  if (toggle) {
    toggle.hidden = !mhFilterGroups.length;
    toggle.querySelector('[data-mh-fbadge]').textContent = active ? String(active) : '';
    toggle.querySelector('[data-mh-fbadge]').hidden = !active;
  }

  if (!mhShown.length) {
    list.innerHTML = mhEmptyHtml(cfg, mhAll.length > 0);
    document.getElementById('mhEmptyClearBtn')?.addEventListener('click', () => {
      mhClearFilterState(mhFilterState);
      mhRefreshResults();
    });
    list.querySelectorAll('[data-mh-alt]').forEach(b => {
      b.addEventListener('click', () => mhApplyPopular(b.dataset.mhAlt));
    });
    return;
  }

  list.innerHTML = `<div id="mhMoreSentinel" class="mh-more-wrap">
    <button type="button" class="mh-btn mh-btn-outline mh-btn-sm" id="mhMoreBtn">Show more</button>
  </div>`;
  mhAppendBatch();
  document.getElementById('mhMoreBtn').addEventListener('click', mhAppendBatch);
  mhWatchSentinel();
}

/* Upgrades the raw inputs the card just rendered into the smart-search and
   calendar components. Flights and cruises pick a PLACE, so they use the static
   airport reference data and search by IATA code. Hotels and packages pick a
   PRODUCT, so they suggest live inventory titles from the same catalog endpoint
   the search button uses — a merchant is never offered a city with no stock. */
function mhEnhanceSearchFields() {
  Object.keys(MH_TYPES).forEach(type => {
    const p = `mh-${type}`;
    const source = (type === 'flight' || type === 'cruise') ? 'airport' : 'catalog';
    ['Origin', 'Destination'].forEach(which => {
      const el = document.getElementById(`${p}${which}`);
      if (el) mhAttachAutocomplete(el, { source, travelType: type, popular: MH_POPULAR });
    });
    const date = document.getElementById(`${p}Date`);
    /* Inventory is future-dated, so the calendar opens on this year forward; no
       min is set, because the native input had none and search must stay able to
       run against any date the API accepts. */
    if (date) mhAttachDatePicker(date, {
      placeholder: type === 'hotel' ? 'Select check-in' : 'Select date',
      yearFrom: new Date().getFullYear(),
      yearTo: new Date().getFullYear() + 3,
    });
  });
}

/* Prefers the precise token a picked suggestion left behind ("HYD") over the
   human label sitting in the input ("Hyderabad (HYD)") — searching the label
   verbatim would match nothing. Free-typed text still goes through as-is. */
function mhVal(id) {
  const el = document.getElementById(id);
  if (!el) return undefined;
  const token = el.dataset?.searchToken?.trim();
  return token || el.value?.trim() || undefined;
}

/* `opts.reveal` scrolls the results into view. It is set for a DELIBERATE search
   (the button, Enter, a recent chip, a popular destination) and deliberately not
   for the search that runs on arrival or on a tab switch — the hero and the
   discover strip put the first result card well below the fold, so without this a
   merchant pressed Search and saw nothing move. Arriving on the page, though,
   should leave them at the top of the hero, not thrown down the page. */
async function mhRunSearch(opts = {}) {
  const cfg = MH_TYPES[mhType];
  const p = `mh-${mhType}`;
  const passengers = Number(document.getElementById(`${p}Passengers`)?.value || 1);
  const resultsWrap = document.getElementById('mhResults');
  const list = document.getElementById('mhResultsList');
  const titleEl = document.getElementById('mhResultsTitle');

  mhSearched = true;
  mhPassengers = passengers;
  resultsWrap.style.display = 'block';
  titleEl.textContent = `${cfg.label.replace(/^\S+\s/, '')}`;
  document.getElementById('mhSortWrap').innerHTML = mhSortSelectHtml(mhType, mhSort);
  document.getElementById('mhSortSelect').addEventListener('change', e => {
    mhSort = e.target.value;
    mhRefreshResults();
  });
  mhStartLoadingMessages(cfg);
  list.innerHTML = mhSkeletonHtml();
  /* Scroll to the skeletons, not to the finished list: the merchant sees the
     search being answered rather than being moved after the fact. */
  if (opts.reveal) mhScrollToResults();

  const params = { travel_type: mhType, passengers, page_size: MH_PAGE_SIZE };
  if (cfg.fields.includes('origin')) params.origin = mhVal(`${p}Origin`);
  if (cfg.fields.includes('destination')) params.destination = mhVal(`${p}Destination`);
  if (cfg.fields.includes('date')) params.travel_date = mhVal(`${p}Date`);
  if (cfg.fields.includes('cabin')) params.cabin_class = mhVal(`${p}Cabin`);

  const mine = ++mhSearchSeq;
  try {
    const { data } = await axios.get(`${API_BASE}/api/catalog/search`, {
      headers: partnerAuthHeaders(), params,
    });
    if (mine !== mhSearchSeq) return;    // a newer search already answered
    mhStopLoadingMessages();
    mhAll = data.items || [];
    mhTotal = data.total ?? mhAll.length;
    /* Facets describe the set that came back, so they are rebuilt per search;
       selections the new set no longer supports are dropped rather than silently
       filtering everything away. */
    mhFilterGroups = mhBuildFilterGroups(mhType, mhAll);
    mhPruneFilterState();
    mhRefreshResults();

    mhRememberSearch({
      type: mhType,
      origin: document.getElementById(`${p}Origin`)?.value?.trim() || '',
      originToken: document.getElementById(`${p}Origin`)?.dataset?.searchToken || '',
      destination: document.getElementById(`${p}Destination`)?.value?.trim() || '',
      destinationToken: document.getElementById(`${p}Destination`)?.dataset?.searchToken || '',
      passengers, cabin: document.getElementById(`${p}Cabin`)?.value || '',
    });
  } catch (err) {
    if (mine !== mhSearchSeq) return;
    mhStopLoadingMessages();
    document.getElementById('mhResultsCount').textContent = '';
    document.getElementById('mhFilterRail').hidden = true;
    list.innerHTML = `
      <div class="mh-empty">
        <span class="mh-empty-emoji" aria-hidden="true">⚠️</span>
        <b>Couldn't load results</b>
        <span>${escapeHtml(err.response?.data?.detail || 'Please try again in a moment.')}</span>
        <button type="button" class="mh-btn mh-btn-outline mh-btn-sm" id="mhRetryBtn">Try again</button>
      </div>`;
    document.getElementById('mhRetryBtn')?.addEventListener('click', () => mhRunSearch());
  }
}

/* Drops selected values the new facets don't offer. Without this, filtering
   Emirates then searching a route Emirates doesn't fly would show zero results
   with no visible cause. */
function mhPruneFilterState() {
  const byId = new Map(mhFilterGroups.map(g => [g.id, g]));
  Object.keys(mhFilterState).forEach(id => {
    const group = byId.get(id);
    if (!group) { delete mhFilterState[id]; return; }
    if (group.kind === 'price') {
      const cap = mhFilterState.price?.max;
      if (cap == null || cap < group.min || cap >= group.max) delete mhFilterState.price;
      return;
    }
    const allowed = new Set(group.values.map(v => String(v.value)));
    const kept = new Set([...mhFilterState[id]].filter(v => allowed.has(v)));
    if (kept.size) mhFilterState[id] = kept; else delete mhFilterState[id];
  });
}

/* Mobile: the rail is a bottom sheet rather than a column. */
function mhInitFilterSheet() {
  const toggle = document.getElementById('mhFilterToggle');
  const rail = document.getElementById('mhFilterRail');
  const backdrop = document.getElementById('mhFilterBackdrop');
  if (!toggle || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';

  const setOpen = (open) => {
    rail.classList.toggle('mh-frail-open', open);
    backdrop?.classList.toggle('open', open);
    document.body.classList.toggle('mh-noscroll', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  const close = () => setOpen(false);

  toggle.addEventListener('click', () => setOpen(!rail.classList.contains('mh-frail-open')));
  backdrop?.addEventListener('click', close);
  /* Delegated: the Done button lives inside the rail's markup, which is rebuilt
     on every result set, so a direct binding would go stale after one search. */
  rail.addEventListener('click', e => { if (e.target.id === 'mhFilterDone') close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && rail.classList.contains('mh-frail-open')) close();
  });
}

/* Hand off to the existing, already-verified Request Ticket flow. The quote is
   fetched server-side first so the passenger step opens against a real priced
   catalog item — identical to what Ticket Enquiry does. */
async function mhRequestItem(itemId, passengers, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Pricing…'; }
  try {
    const { data: quote } = await axios.get(`${API_BASE}/api/catalog/${itemId}/quote`, {
      headers: partnerAuthHeaders(), params: { passengers },
    });
    startRequestTicket(quote, passengers);
    navigateToSection('request-ticket');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    showToast(err.response?.data?.detail || 'Could not price this option.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Request'; }
  }
}

/* One delegated listener on the list, so the batches appended on scroll are
   clickable without re-binding each time. */
function mhInitResultDelegation() {
  const list = document.getElementById('mhResultsList');
  if (!list || list.dataset.wired) return;
  list.dataset.wired = '1';
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-mh-request]');
    if (!btn) return;
    mhRequestItem(Number(btn.dataset.mhRequest), Number(btn.dataset.mhPax), btn);
  });
}

/* ---------------------------------------------------------------- B2B strip */

function mhQuickIcon(kind) {
  const paths = {
    wallet: '<path d="M3 7h18v12H3z"/><path d="M16 13h2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };
  return `<svg viewBox="0 0 24 24">${paths[kind] || paths.check}</svg>`;
}

async function mhLoadQuickRow() {
  const row = document.getElementById('mhQuickRow');
  if (!row) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/merchant/dashboard`, {
      headers: partnerAuthHeaders(),
    });
    const s = data.requests_by_status || {};
    const awaiting = (s.pending_approval || 0) + (s.in_review || 0);
    /* "Due" is requests_by_status.payment_pending — requests the merchant still
       owes money on. NOT pending_payments_count: dashboard_service.py counts that
       from the Payment table where payment_status is PENDING, i.e. payments the
       merchant has ALREADY submitted and an Admin hasn't verified yet. Keying the
       "Pay now" prompt off it made Home say "No payments due" while a request sat
       in Payment Pending — found in the browser against the demo merchant. */
    const due = s.payment_pending || 0;
    const verifying = data.pending_payments_count || 0;
    const items = [
      /* wallet_balance is a Decimal string (M4) — moneyStr(), not money(),
         which mishandles a negative CR-4 balance (see partner-dashboard.js). */
      `<button type="button" class="mh-quick-item" data-mh-goto="dashboard">${
        mhQuickIcon('wallet')}Wallet <b>${moneyStr(data.wallet_balance)}</b></button>`,
      `<button type="button" class="mh-quick-item" data-mh-goto="request-history">${
        mhQuickIcon('clock')}<b>${awaiting}</b> awaiting approval</button>`,
    ];
    if (due) {
      items.push(`<button type="button" class="mh-quick-item mh-warn" data-mh-goto="payments">${
        mhQuickIcon('card')}<b>${due}</b> payment${due === 1 ? '' : 's'} due
        <span class="mh-quick-cta">Pay now</span></button>`);
    } else if (verifying) {
      items.push(`<button type="button" class="mh-quick-item" data-mh-goto="payments">${
        mhQuickIcon('clock')}<b>${verifying}</b> payment${verifying === 1 ? '' : 's'} being verified</button>`);
    } else {
      items.push(`<span class="mh-quick-item mh-quick-static">${mhQuickIcon('check')}No payments due</span>`);
    }
    row.innerHTML = items.join('');
    row.querySelectorAll('[data-mh-goto]').forEach(b => {
      b.addEventListener('click', () => navigateToSection(b.dataset.mhGoto));
    });
  } catch (err) {
    row.innerHTML = '';   /* the strip is a nicety — never block the search card on it */
  }
}

/* ---------------------------------------------------------------- global search

   Matches what GET /api/requests?search= actually looks at: PNR, request number,
   booking reference, ticket number, the item title (which carries the airline,
   hotel or cruise name), destination, and passenger name or passport. Phone and
   email are NOT in that query, so the hint doesn't claim them. */

let mhGlobalTimer = null;

function mhInitGlobalSearch() {
  const input = document.getElementById('mhGlobalSearch');
  const panel = document.getElementById('mhGlobalResults');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';

  input.addEventListener('input', () => {
    clearTimeout(mhGlobalTimer);
    const q = input.value.trim();
    if (q.length < 2) { panel.classList.remove('open'); return; }
    mhGlobalTimer = setTimeout(() => mhRunGlobalSearch(q), 300);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { panel.classList.remove('open'); input.blur(); return; }
    const items = [...panel.querySelectorAll('.mh-gsr-item')];
    if (!items.length) return;
    const at = items.findIndex(el => el.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? (at + 1) % items.length
        : (at - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === next));
      items[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault();
      items[at].click();
    }
  });
  document.addEventListener('click', e => {
    if (!panel.contains(e.target) && e.target !== input) panel.classList.remove('open');
  });
}

async function mhRunGlobalSearch(q) {
  const panel = document.getElementById('mhGlobalResults');
  panel.classList.add('open');
  panel.innerHTML = '<div class="mh-gsr-empty">Searching…</div>';
  try {
    const { data } = await axios.get(`${API_BASE}/api/requests`, {
      headers: partnerAuthHeaders(), params: { search: q, page_size: 8 },
    });
    const hint = `<div class="mh-gsr-hint">Matches PNR, request &amp; booking numbers,
      ticket numbers, passenger names, airlines, hotels and destinations.</div>`;
    if (!data.items.length) {
      panel.innerHTML = `<div class="mh-gsr-empty">Nothing matches “${escapeHtml(q)}”</div>${hint}`;
      return;
    }
    panel.innerHTML = `<div class="mh-gsr-label">Your requests · ${data.total}</div>${data.items.map(r => `
      <button type="button" class="mh-gsr-item" data-mh-open-request="${r.id}">
        <span class="mh-gsr-ico" aria-hidden="true">${MH_TYPES[r.travel_type]?.emoji || '🎫'}</span>
        <span class="mh-gsr-text">
          <span class="mh-gsr-title">${escapeHtml(r.request_number)}${
            r.booking_reference ? ` · ${escapeHtml(r.booking_reference)}` : ''}${
            r.pnr ? ` · PNR ${escapeHtml(r.pnr)}` : ''}</span>
          <span class="mh-gsr-sub">${escapeHtml(r.title || r.status_label || r.status || '')}${
            r.travel_date ? ` · ${fmtDate(r.travel_date)}` : ''}${
            r.total_amount != null ? ` · ${money(r.total_amount)}` : ''}</span>
        </span>
        ${r.status ? `<span class="mh-gsr-badge">${escapeHtml(r.status_label || statusLabel(r.status))}</span>` : ''}
      </button>`).join('')}${hint}`;
    panel.querySelectorAll('[data-mh-open-request]').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.classList.remove('open');
        openBookingDetailModal(btn.dataset.mhOpenRequest);
      });
    });
  } catch (err) {
    panel.innerHTML = '<div class="mh-gsr-empty">Search failed — please try again.</div>';
  }
}

/* ---------------------------------------------------------------- account menu */

function mhInitAccountMenu() {
  const btn = document.getElementById('mhAcctBtn');
  const menu = document.getElementById('mhAcctMenu');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', e => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu.classList.contains('open')) {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }
  });
  menu.querySelectorAll('[data-section]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      navigateToSection(link.dataset.section);
    });
  });
}

function mhInitHeaderNav() {
  document.querySelectorAll('[data-mh-navlink]').forEach(link => {
    link.addEventListener('click', () => {
      navigateToSection('home', () => mhSetType(link.dataset.mhNavlink));
    });
  });
  document.getElementById('mhHomeLink')?.addEventListener('click', e => {
    e.preventDefault();
    navigateToSection('home');
  });
}

/* ---------------------------------------------------------------- entry point */

function initHome() {
  mhInitRipple();
  mhInitLogoFallback();
  hotelImageInit();
  mhInitHero();
  mhRenderSearchCard();
  mhRenderDiscover();
  mhLoadQuickRow();
  mhInitGlobalSearch();
  mhInitAccountMenu();
  mhInitHeaderNav();
  mhInitFilterSheet();
  mhInitResultDelegation();
  /* Land on results straight away so Home is useful before any typing, mirroring
     how the public site shows live fares on arrival. */
  mhRunSearch();
}
