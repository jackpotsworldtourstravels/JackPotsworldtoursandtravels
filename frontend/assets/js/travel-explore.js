'use strict';
/* ===========================================================================
   travel-explore.js — renders the Explore band under the V1 hero.
   ===========================================================================
   Reads ONLY the normalised shapes from travel-data.js. It does not know
   whether a row came from the sample set or a live endpoint, which is the
   whole point: when the real Flight API lands, nothing in this file changes.

   Filtering, sorting and paging are client-side because the sample set is one
   day of departures. If the live endpoint grows past a few hundred rows, move
   `state` into the query passed to TravelData.flights() — the render functions
   already take a plain array and will not care.
   =========================================================================== */

const TravelExplore = (function () {

  const PAGE_SIZE = 8;

  /* Buckets for the "Departure Time" filter. Ordered, because the sidebar and
     the matcher both iterate this one list — two hand-kept copies would drift. */
  const TIME_WINDOWS = [
    { id: 'early',     label: 'Before 6 AM',   from: 0,    to: 359  },
    { id: 'morning',   label: '6 AM – 12 PM',  from: 360,  to: 719  },
    { id: 'afternoon', label: '12 PM – 6 PM',  from: 720,  to: 1079 },
    { id: 'evening',   label: 'After 6 PM',    from: 1080, to: 1439 },
  ];

  const state = {
    q: '', airlines: new Set(), windows: new Set(), dests: new Set(),
    nonStop: false, sort: 'dep-asc', shown: PAGE_SIZE,
    /* Step 1 of the booking journey. These are carried into the flow so the
       traveller forms already know how many people to ask about — nobody
       should have to say "2 adults" twice. */
    trip: 'oneway', from: 'HYD', to: '', depart: '', ret: '',
    pax: { adults: 1, children: 0, infants: 0 },
    cabin: 'economy',
    guests: 2, rooms: 1, checkIn: '', checkOut: '',
  };

  /** What the booking engine needs to seed a flow, whichever product it is. */
  function searchParams() {
    return {
      pax: state.pax, cabin: state.cabin,
      guests: state.guests, rooms: state.rooms,
      checkIn: state.checkIn || null, checkOut: state.checkOut || null,
    };
  }

  let flights = [];
  /* The rendered rows, kept so a Book Now click can find the object it belongs
     to. Reading the item back out of the DOM would mean re-parsing formatted
     prices, which is how a booking ends up costing "₹12,500" the string. */
  const catalogue = { hotel: [], cruise: [], package: [] };
  let ready = false;

  /* ---------------------------------------------------------------------
     Small helpers
     --------------------------------------------------------------------- */
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const $ = id => document.getElementById(id);

  function minutesOf(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  }

  /** Indian grouping, no decimals — these are whole-rupee tariffs. */
  function money(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  /** A rating row. Uses the jp-icons star so it matches the rest of the set;
   *  the "★".repeat() it replaces picked up whatever star the OS font had and
   *  turned into a colour emoji on some of them. */
  function starRow(n) {
    return (typeof JPIcon !== 'undefined')
      ? JPIcon.stars(n)
      : `<span aria-label="${n} star">${'★'.repeat(n)}</span>`;
  }

  /** Arm any icons a freshly rendered block just introduced. jp-icons.js mounts
   *  once on DOMContentLoaded; everything rendered after that — every filter
   *  change, every "show more" — brings in icons it has never seen. */
  function armIcons(scope) {
    if (typeof JPIcon !== 'undefined') JPIcon.mount(scope || document);
  }

  function windowOf(mins) {
    const w = TIME_WINDOWS.find(x => mins >= x.from && mins <= x.to);
    return w ? w.id : 'evening';
  }

  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso
      : d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  /* ---------------------------------------------------------------------
     Imagery
     --------------------------------------------------------------------- */

  /** Vendored carrier logo, or the IATA code as a legible fallback tile.
   *  Reuses airline-logos.js rather than shipping a second copy of the map. */
  function airlineLogo(f) {
    const code = f.airlineCode;
    const have = typeof AIRLINE_LOGO_FILES !== 'undefined'
      && code && AIRLINE_LOGO_FILES[code];
    if (have) {
      const dir = (typeof AIRLINE_LOGO_DIR === 'string') ? AIRLINE_LOGO_DIR : 'assets/images/airlines/';
      /* A vendored file that 404s degrades to the carrier's IATA code, which is
         always present in this branch — `have` required it. */
      return `<span class="tx-logo"><img src="${esc(dir + AIRLINE_LOGO_FILES[code])}"
        alt="${esc(f.airline)} logo" width="34" height="34" decoding="async"
        onerror="this.parentNode.innerHTML='<span class=&quot;tx-logo-fb&quot;>${esc(code)}</span>'"></span>`;
    }
    /* No logo AND no code — a carrier the API knows and this app does not. Was
       a '✈' text glyph; now the jp-icons mark, so an unknown airline still
       looks like the rest of the set. */
    const fallback = code
      ? `<span class="tx-logo-fb">${esc(code)}</span>`
      : (typeof JPIcon !== 'undefined' ? JPIcon.html('flights') : '<span class="tx-logo-fb">--</span>');
    return `<span class="tx-logo">${fallback}</span>`;
  }

  /** Real photograph for a hotel slug, with the 480px variant for small cards. */
  function hotelImage(h) {
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' && HOTEL_IMAGE_FILES[h.imageKey];
    const slug = known ? h.imageKey : 'default-hotel';
    return `<img src="${esc(dir + slug + '.webp')}"
      srcset="${esc(dir + slug + '-480.webp')} 480w, ${esc(dir + slug + '.webp')} 1024w"
      sizes="(max-width: 760px) 90vw, 280px"
      alt="${esc(h.name)}" loading="lazy" decoding="async">`;
  }

  /* Cruises and packages have no photo library, so they get a drawn scene
     instead of a grey box. Deterministic from the name, so a given package
     always looks the same rather than reshuffling on every render. */
  function hashOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }
  const SCENE_PALETTES = [
    ['#0EA5E9', '#0369A1'], ['#F59E0B', '#B45309'], ['#10B981', '#065F46'],
    ['#8B5CF6', '#5B21B6'], ['#EF4444', '#991B1B'], ['#06B6D4', '#155E75'],
  ];
  function sceneSvg(kind, seedText) {
    const h = hashOf(seedText);
    const [c1, c2] = SCENE_PALETTES[h % SCENE_PALETTES.length];
    const gid = `g${kind}${h % 100000}`;
    const sun = 40 + (h % 120);

    /* The centrepiece is the jp-icons drawing, not an emoji: the same ship and
       island the nav uses, so a card and its menu entry are visibly the same
       product. Drawn at 72px from a 24 grid (scale 3), with stroke-width pulled
       back to 0.6 so it renders ~1.8px after the transform rather than 4.8. */
    const mark = (typeof JPIcon !== 'undefined')
      ? `<g transform="translate(124 84) scale(3)" fill="none" stroke="#fff"
             stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" opacity=".95">
           ${JPIcon.inner(kind === 'cruise' ? 'cruises' : 'packages')}
         </g>`
      : '';

    /* aria-hidden: the card's heading already names it, so the decoration
       should not be announced a second time. */
    return `<svg viewBox="0 0 320 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient></defs>
      <rect width="320" height="240" fill="url(#${gid})"/>
      <circle cx="${sun}" cy="56" r="26" fill="#fff" opacity=".28"/>
      <path d="M0 176 Q 40 160 80 176 T 160 176 T 240 176 T 320 176 V240 H0 Z" fill="#fff" opacity=".16"/>
      <path d="M0 200 Q 50 184 100 200 T 200 200 T 320 200 V240 H0 Z" fill="#fff" opacity=".2"/>
      ${mark}
    </svg>`;
  }

  /* ---------------------------------------------------------------------
     Flights — filter, sort, render
     --------------------------------------------------------------------- */
  function matches(f) {
    if (state.nonStop && !f.nonStop) return false;
    if (state.airlines.size && !state.airlines.has(f.airline)) return false;
    if (state.dests.size && !state.dests.has(f.destination.code)) return false;
    if (state.windows.size && !state.windows.has(windowOf(minutesOf(f.departure)))) return false;
    if (state.q) {
      const hay = [f.flightNumber, f.flightNumberRaw, f.airline,
                   f.destination.city, f.destination.code,
                   f.origin.city, f.origin.code].join(' ').toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    return true;
  }

  function sorted(list) {
    const out = list.slice();
    if (state.sort === 'dep-asc')  out.sort((a, b) => minutesOf(a.departure) - minutesOf(b.departure));
    if (state.sort === 'dep-desc') out.sort((a, b) => minutesOf(b.departure) - minutesOf(a.departure));
    if (state.sort === 'airline')  out.sort((a, b) => a.airline.localeCompare(b.airline)
                                              || minutesOf(a.departure) - minutesOf(b.departure));
    return out;
  }

  function flightCard(f) {
    const arrival = f.arrival
      ? `<div class="tx-time">${esc(f.arrival)}</div>`
      /* Table 1 of the source has no arrival times. Saying so beats printing a
         guessed one next to a real flight number. */
      : `<div class="tx-time tx-tbd">Arrival TBA</div>`;

    const dur = f.durationLabel
      ? `<div class="tx-dur">${esc(f.durationLabel)}</div>`
      : `<div class="tx-dur">Non-stop</div>`;

    const fare = f.fare == null
      ? `<div class="tx-fare">Fare on request</div>`
      : `<div class="tx-fare"><span>from</span><b>${esc(money(f.total))}</b><i>incl. taxes</i></div>`;

    /* The commercial line every booking site carries: what it costs to change
       your mind, what you may bring, and how much is left. */
    const facts = f.fare == null ? '' : `
      <div class="tx-facts">
        <span class="tx-fact ${f.refundable ? 'is-good' : ''}">${esc(f.fareType)}</span>
        <span class="tx-fact">Cabin ${esc(f.baggage.cabin)}</span>
        <span class="tx-fact">Check-in ${esc(f.baggage.checkIn)}</span>
        <span class="tx-fact ${f.seatsLow ? 'is-warn' : ''}">${esc(f.seatsLeft)} seat${f.seatsLeft === 1 ? '' : 's'} left</span>
      </div>`;

    return `<article class="tx-flight" data-flight="${esc(f.id)}">
      <div class="tx-carrier">
        ${airlineLogo(f)}
        <div>
          <div class="tx-carrier-name">${esc(f.airline)}</div>
          <div class="tx-carrier-no">${esc(f.flightNumber)} · ${esc(fmtDate(f.date))}</div>
        </div>
      </div>

      <div class="tx-leg">
        <div>
          <div class="tx-time">${esc(f.departure)}</div>
          <div class="tx-place">${esc(f.origin.city)} (${esc(f.origin.code)})</div>
        </div>
        <div class="tx-path">
          ${dur}
          <div class="tx-line">${typeof JPIcon !== 'undefined' ? JPIcon.html('flights') : ''}</div>
          <div class="tx-stops">${f.nonStop ? 'Non-stop' : esc(f.stops + ' stop')}</div>
        </div>
        <div class="tx-leg-end">
          ${arrival}
          <div class="tx-place">${esc(f.destination.city)} (${esc(f.destination.code)})</div>
        </div>
        ${facts}
      </div>

      <div class="tx-act">
        ${fare}
        <span class="tx-status">${esc(f.status)}</span>
        <button type="button" class="tx-btn tx-btn-ghost" data-tx-details="${esc(f.id)}">View Details</button>
        <button type="button" class="tx-btn tx-btn-primary" data-tx-book="${esc(f.id)}">Book Now</button>
      </div>
    </article>`;
  }

  function detailsHtml(f) {
    const cell = (label, value) => `<div class="tx-detail"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    return `<div class="tx-details">
      ${cell('Flight', f.flightNumber)}
      ${cell('Airline', f.airline)}
      ${cell('Route', `${f.origin.code} → ${f.destination.code}`)}
      ${cell('Date', fmtDate(f.date))}
      ${cell('Departs', `${f.departure} · ${f.origin.city}`)}
      ${cell('Arrives', f.arrival ? `${f.arrival} · ${f.destination.city}` : 'To be announced')}
      ${cell('Duration', f.durationLabel || 'Not published')}
      ${cell('Stops', f.nonStop ? 'Non-stop' : String(f.stops))}
      ${cell('Status', f.status)}
    </div>`;
  }

  function facet(list, keyFn, labelFn) {
    const counts = new Map();
    list.forEach(f => {
      const k = keyFn(f);
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([k, n]) => ({ key: k, label: labelFn(k), count: n }));
  }

  function renderFilters() {
    const box = $('txFilters');
    if (!box) return;
    const airlines = facet(flights, f => f.airline, k => k);
    const dests = facet(flights, f => f.destination.code,
                        k => `${(TravelData.airports[k] || {}).city || k} (${k})`);
    const wins = TIME_WINDOWS.map(w => ({
      key: w.id, label: w.label,
      count: flights.filter(f => windowOf(minutesOf(f.departure)) === w.id).length,
    })).filter(w => w.count);

    const group = (title, name, items, checkedSet) => `
      <div class="tx-fgroup">
        <h4>${esc(title)}</h4>
        ${items.map(i => `<label class="tx-check">
          <input type="checkbox" data-tx-facet="${esc(name)}" value="${esc(i.key)}"
                 ${checkedSet.has(i.key) ? 'checked' : ''}>
          <span>${esc(i.label)}</span><span class="tx-count">${i.count}</span>
        </label>`).join('')}
      </div>`;

    box.innerHTML =
      group('Airline', 'airlines', airlines, state.airlines) +
      group('Departure time', 'windows', wins, state.windows) +
      group('Destination', 'dests', dests, state.dests) +
      `<div class="tx-fgroup">
         <h4>Stops</h4>
         <label class="tx-check">
           <input type="checkbox" data-tx-nonstop ${state.nonStop ? 'checked' : ''}>
           <span>Non-stop only</span>
           <span class="tx-count">${flights.filter(f => f.nonStop).length}</span>
         </label>
       </div>
       <button type="button" class="tx-clear" data-tx-clear>Clear all filters</button>`;
  }

  function renderFlights() {
    const list = $('txFlightList');
    if (!list) return;
    const found = sorted(flights.filter(matches));
    const page = found.slice(0, state.shown);

    const line = $('txCount');
    if (line) {
      line.innerHTML = found.length
        ? `Showing <b>${page.length}</b> of <b>${found.length}</b> departures`
        : '';
    }

    list.innerHTML = page.length
      ? page.map(flightCard).join('')
      : `<div class="tx-empty"><b>No flights match those filters</b>
           Try clearing a filter or searching for a different city.</div>`;

    armIcons(list);

    const more = $('txMore');
    if (more) {
      const rest = found.length - page.length;
      more.style.display = rest > 0 ? '' : 'none';
      more.textContent = rest > 0 ? `Show ${Math.min(rest, PAGE_SIZE)} more` : '';
    }
  }

  /* ---------------------------------------------------------------------
     Hotels / cruises / packages
     --------------------------------------------------------------------- */
  function renderHotels(rows) {
    const el = $('txHotelGrid');
    if (!el) return;
    catalogue.hotel = rows;
    el.innerHTML = rows.map(h => `<article class="tx-card">
      <div class="tx-media">${hotelImage(h)}
        <span class="tx-badge">${esc(h.distanceKm)} km from airport</span>
      </div>
      <div class="tx-body">
        <h3 class="tx-title">${esc(h.name)}</h3>
        <div class="tx-stars">${starRow(h.stars)}</div>
        <p class="tx-sub">${esc(h.location)}</p>
        <div class="tx-chips">${h.amenities.map(a => `<span class="tx-chip">${esc(a)}</span>`).join('')}</div>
        <div class="tx-foot">
          <div class="tx-price"><span>per night</span><b>${esc(money(h.pricePerNight))}</b></div>
          <button type="button" class="tx-btn tx-btn-primary" data-tx-buy="hotel" data-tx-id="${esc(h.id)}">Book Now</button>
        </div>
      </div>
    </article>`).join('');
    armIcons(el);
  }

  function renderCruises(rows) {
    const el = $('txCruiseGrid');
    if (!el) return;
    catalogue.cruise = rows;
    el.innerHTML = rows.map(c => `<article class="tx-card">
      <div class="tx-media">${sceneSvg('cruise', c.name)}
        <span class="tx-badge">${esc(c.nights)} nights</span>
      </div>
      <div class="tx-body">
        <h3 class="tx-title">${esc(c.name)}</h3>
        <p class="tx-sub">${esc(c.route)} · ${esc(c.nights)} nights</p>
        <div class="tx-foot">
          <div class="tx-price"><span>from</span><b>${esc(money(c.priceFrom))}</b><i> per person</i></div>
          <div class="tx-card-actions">
            <button type="button" class="tx-btn tx-btn-ghost" data-tx-detail="cruise" data-tx-id="${esc(c.id)}">View Details</button>
            <button type="button" class="tx-btn tx-btn-primary" data-tx-buy="cruise" data-tx-id="${esc(c.id)}">Book Now</button>
          </div>
        </div>
      </div>
    </article>`).join('');
    armIcons(el);
  }

  function renderPackages(rows) {
    const el = $('txPackageGrid');
    if (!el) return;
    catalogue.package = rows;
    el.innerHTML = rows.map(p => `<article class="tx-card">
      <div class="tx-media">${sceneSvg('package', p.name)}
        <span class="tx-badge">${esc(p.days)} days</span>
      </div>
      <div class="tx-body">
        <h3 class="tx-title">${esc(p.name)}</h3>
        <p class="tx-sub">${esc(p.blurb)}</p>
        <div class="tx-foot">
          <div class="tx-price"><span>from</span><b>${esc(money(p.priceFrom))}</b><i> per person</i></div>
          <button type="button" class="tx-btn tx-btn-primary" data-tx-buy="package" data-tx-id="${esc(p.id)}">Explore Package</button>
        </div>
      </div>
    </article>`).join('');
    armIcons(el);
  }

  /* ---------------------------------------------------------------------
     Events
     --------------------------------------------------------------------- */
  /* ---------------------------------------------------------------------
     Step 1 — the search panel
     ---------------------------------------------------------------------
     It filters the SAME client-side result set the facets do. When the live
     endpoint lands, `submit` becomes a call with these values instead — the
     rendering below it does not change either way. */
  function mountSearch() {
    const panel = $('txSearchPanel');
    if (!panel) return;

    const codes = Object.keys(TravelData.airports);
    const opt = (c, sel) => `<option value="${esc(c)}"${c === sel ? ' selected' : ''}>${
      esc(TravelData.airports[c].city)} (${esc(c)})</option>`;
    const today = new Date().toISOString().slice(0, 10);

    panel.innerHTML = `
      <div class="tx-trip">
        <label class="tx-radio"><input type="radio" name="txTrip" value="oneway" checked> <span>One way</span></label>
        <label class="tx-radio"><input type="radio" name="txTrip" value="round"> <span>Round trip</span></label>
      </div>
      <div class="tx-searchgrid">
        <div class="tx-sf"><label for="txFrom">From</label>
          <select id="txFrom">${codes.map(c => opt(c, 'HYD')).join('')}</select></div>
        <div class="tx-sf"><label for="txTo">To</label>
          <select id="txTo"><option value="">Anywhere</option>${codes.filter(c => c !== 'HYD').map(c => opt(c)).join('')}</select></div>
        <div class="tx-sf"><label for="txDepart">Departure</label>
          <input id="txDepart" type="date" value="${esc(today)}" min="${esc(today)}"></div>
        <div class="tx-sf" id="txReturnWrap" hidden><label for="txReturn">Return</label>
          <input id="txReturn" type="date" min="${esc(today)}"></div>
        <div class="tx-sf"><label for="txAdults">Adults</label>
          <select id="txAdults">${[1,2,3,4,5,6].map(n => `<option${n === 1 ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="tx-sf"><label for="txChildren">Children</label>
          <select id="txChildren">${[0,1,2,3,4].map(n => `<option${n === 0 ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="tx-sf"><label for="txInfants">Infants</label>
          <select id="txInfants">${[0,1,2].map(n => `<option${n === 0 ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="tx-sf"><label for="txCabin">Cabin</label>
          <select id="txCabin">${BookingData.CABIN_CLASSES.map(c =>
            `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></div>
        <button type="button" class="tx-btn tx-btn-primary tx-searchgo" id="txSearchGo">Search flights</button>
      </div>`;

    panel.querySelectorAll('input[name="txTrip"]').forEach(r => r.addEventListener('change', () => {
      state.trip = r.value;
      /* The return field is hidden rather than disabled so a one-way search
         cannot silently carry a stale return date into the booking. */
      $('txReturnWrap').hidden = r.value !== 'round';
      if (r.value !== 'round') $('txReturn').value = '';
    }));

    $('txSearchGo').addEventListener('click', () => {
      state.from = $('txFrom').value;
      state.to = $('txTo').value;
      state.depart = $('txDepart').value;
      state.ret = $('txReturn').value;
      state.cabin = $('txCabin').value;
      state.pax = {
        adults: Number($('txAdults').value) || 1,
        children: Number($('txChildren').value) || 0,
        infants: Number($('txInfants').value) || 0,
      };
      if (state.pax.infants > state.pax.adults) {
        showToast('Each infant must travel with an adult.', true);
        return;
      }
      /* Destination narrows the facet set, which is what "search" means
         against a client-side result list. */
      state.dests = state.to ? new Set([state.to]) : new Set();
      state.shown = PAGE_SIZE;
      renderFilters();
      renderFlights();
      $('txResults')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function bind() {
    const search = $('txSearch');
    if (search) {
      let t = null;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { state.q = search.value.trim(); state.shown = PAGE_SIZE; renderFlights(); }, 160);
      });
    }

    const sort = $('txSort');
    if (sort) sort.addEventListener('change', () => { state.sort = sort.value; renderFlights(); });

    const more = $('txMore');
    if (more) more.addEventListener('click', () => { state.shown += PAGE_SIZE; renderFlights(); });

    const toggle = $('txFilterToggle');
    if (toggle) toggle.addEventListener('click', () => $('txFilters').classList.toggle('tx-open'));

    /* Delegated: the filter panel and the result list are both re-rendered, so
       per-element listeners would be lost on every repaint. */
    document.addEventListener('change', e => {
      const cb = e.target.closest('[data-tx-facet]');
      if (cb) {
        const set = state[cb.dataset.txFacet];
        cb.checked ? set.add(cb.value) : set.delete(cb.value);
        state.shown = PAGE_SIZE;
        renderFlights();
        return;
      }
      if (e.target.closest('[data-tx-nonstop]')) {
        state.nonStop = e.target.checked;
        state.shown = PAGE_SIZE;
        renderFlights();
      }
    });

    document.addEventListener('click', e => {
      if (e.target.closest('[data-tx-clear]')) {
        state.q = ''; state.airlines.clear(); state.windows.clear(); state.dests.clear();
        state.nonStop = false; state.shown = PAGE_SIZE;
        if (search) search.value = '';
        renderFilters(); renderFlights();
        return;
      }
      const det = e.target.closest('[data-tx-details]');
      if (det) {
        const card = det.closest('.tx-flight');
        const open = card.querySelector('.tx-details');
        if (open) { open.remove(); det.textContent = 'View Details'; return; }
        const f = flights.find(x => x.id === det.dataset.txDetails);
        if (f) { card.insertAdjacentHTML('beforeend', detailsHtml(f)); det.textContent = 'Hide Details'; }
        return;
      }
      /* --- Book Now: hand the chosen item to the booking engine ------------
         These used to be placeholder toasts. The engine owns everything from
         here — travellers, seats, extras, payment, confirmation — and this
         file's only job is to say WHICH item was chosen. */
      const book = e.target.closest('[data-tx-book]');
      if (book) {
        const f = flights.find(x => x.id === book.dataset.txBook);
        if (f) BookingFlows.open('flight', f, { pax: state.pax, cabin: state.cabin });
        return;
      }
      const buy = e.target.closest('[data-tx-buy]');
      if (buy) {
        const kind = buy.dataset.txBuy;
        const item = (catalogue[kind] || []).find(x => x.id === buy.dataset.txId);
        if (item) BookingFlows.open(kind, item, searchParams());
        return;
      }
      const detail = e.target.closest('[data-tx-detail]');
      if (detail) {
        const item = (catalogue[detail.dataset.txDetail] || []).find(x => x.id === detail.dataset.txId);
        /* Cruises have no separate detail page yet, so View Details opens the
           booking at its first step — which IS the detail, with a price. */
        if (item) BookingFlows.open(detail.dataset.txDetail, item, searchParams());
      }
    });
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  /* ONE SERVICE PER PAGE. The page declares which it is with
     <body data-sp-service="flights">, and only that source is fetched — a
     hotels page must not call the flight API, and once each service has its own
     backend that would be three pointless round-trips per visit. */
  async function init() {
    const service = document.body.dataset.spService;
    if (ready || !service) return;
    ready = true;
    bind();
    try {
      if (service === 'flights') {
        mountSearch();
        flights = await TravelData.flights();
        /* Written from the data, never typed into the markup — the two
           disagreed the moment a weekday was hardcoded. */
        const sub = $('txFlightsSub');
        if (sub && flights.length) {
          sub.textContent = `Schedule for ${fmtDate(flights[0].date)} — non-stop services `
            + 'across India, the Gulf and South-East Asia.';
        }
        renderFilters();
        renderFlights();
      } else if (service === 'hotels') {
        renderHotels(await TravelData.hotels());
      } else if (service === 'cruises') {
        renderCruises(await TravelData.cruises());
      } else if (service === 'packages') {
        renderPackages(await TravelData.packages());
      }
    } catch (err) {
      const host = $('txFlightList') || $('txHotelGrid') || $('txCruiseGrid') || $('txPackageGrid');
      if (host) {
        host.innerHTML = `<div class="tx-empty"><b>We could not load this just now</b>
          Please refresh the page, or try again in a moment.</div>`;
      }
      console.error('[explore] load failed', service, err);
    }
  }

  return { init, state };
})();

document.addEventListener('DOMContentLoaded', TravelExplore.init);
/* The scripts are at the end of <body>, so DOMContentLoaded may already have
   fired by the time this runs. */
if (document.readyState !== 'loading') TravelExplore.init();
