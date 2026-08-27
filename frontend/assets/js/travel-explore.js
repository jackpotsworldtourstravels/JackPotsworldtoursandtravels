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

  /* The departure-time buckets moved to flight-filters.js, which now owns five
     of them (the "night" the four here had no room for) and uses the same list
     for arrival. windowOf() went with them. */

  const state = {
    /* The free-text box and the paging cursor. Every FACET the sidebar offers
       lives in flight-filters.js instead — one place that owns what a filter is,
       rather than a named Set here per filter that ever gets added. */
    q: '', sort: 'best', shown: PAGE_SIZE,
    /* Hotels page out of the flights page's way: two results grids on two
       pages, each with its own sort and its own paging cursor. */
    hotelSort: 'recommended', hotelShown: PAGE_SIZE,
    /* Which card is expanded, so a shared link reopens the same one. */
    openHotel: null,
    /* Step 1 of the booking journey. These are carried into the flow so the
       traveller forms already know how many people to ask about — nobody
       should have to say "2 adults" twice. */
    trip: 'oneway', from: 'HYD', to: '', depart: '', ret: '',
    /* A multi-city itinerary, [{from, to, date}, ...]. Empty for the other two
       trip types, so nothing has to ask which one is in play before reading it. */
    legs: [],
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
  let allHotels = [];
  let allPackages = [];
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
  /** The free-text box in the toolbar, which is NOT one of the sidebar filters:
   *  it searches across every field at once rather than narrowing one facet, so
   *  it stays here and the panel stays generic. Everything else the sidebar
   *  decides — see flight-filters.js. */
  function matchesQuery(f) {
    /* THE SEARCHED ROUTE, both ends. Origin matters as much as destination: the
       sample schedule is one base airport so it changes nothing today, but the
       criteria say HYD -> DEL and a list that ignored the HYD would start lying
       the moment a second base lands.

       This is the SEARCH's destination, which is not the sidebar's "Arrival
       airport" filter — that one narrows within these results and is the
       traveller's, this one is the query. */
    if (state.from && f.origin.code !== state.from) return false;
    if (state.to && f.destination.code !== state.to) return false;
    if (!state.q) return true;
    const hay = [f.flightNumber, f.flightNumberRaw, f.airline,
                 f.destination.city, f.destination.code,
                 f.origin.city, f.origin.code].join(' ').toLowerCase();
    return hay.includes(state.q.toLowerCase());
  }

  /** Everything the query allows, before the sidebar has its say. This is the
   *  set the filter panel derives its options and counts from — deriving them
   *  from the whole schedule would offer airlines that the searched route does
   *  not fly. */
  const searchable = () => flights.filter(matchesQuery);

  function matches(f) {
    return matchesQuery(f)
      && (typeof FlightFilters === 'undefined' || FlightFilters.test(f));
  }

  function sorted(list) {
    return (typeof FlightFilters !== 'undefined')
      ? FlightFilters.sortRows(list, state.sort)
      : list.slice();
  }

  /** The day these results are FOR.
   *
   *  The sample set is one supplied day of departures (travel-data.js,
   *  SAMPLE_DATE) and it is already in the past. Filtering it against a chosen
   *  departure date would empty the page for every real search, so the searched
   *  day is what the cards and the heading show instead — which is what a live
   *  endpoint would return anyway, and the "Sample schedule" badge beside the
   *  heading is what says the tariffs are not quotes. */
  function shownDate(f) {
    return state.depart || (f && f.date) || '';
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
          <div class="tx-carrier-no">${esc(f.flightNumber)} · ${esc(fmtDate(shownDate(f)))}</div>
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
    const cell = (label, value, wide) =>
      `<div class="tx-detail${wide ? ' tx-detail-wide' : ''}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    /* Same constant booking-data.js's seat map uses (see its own comment —
       every aircraft in this sample dataset is one type), read here once
       rather than left absent just because the seat map is a step away. */
    const aircraft = 'Airbus A320neo';
    const cabin = (typeof BookingData !== 'undefined'
      && BookingData.CABIN_CLASSES.find(c => c.id === state.cabin)) || {};
    const fareRule = f.refundable
      ? 'Cancellation and date changes are allowed for a fee, up to 4 hours before departure.'
      : 'Non-refundable: cancellation forfeits the fare. A date change is allowed for a fee.';
    return `<div class="tx-details">
      ${cell('Flight', f.flightNumber)}
      ${cell('Airline', f.airline)}
      ${cell('Aircraft', aircraft)}
      ${cell('Route', `${f.origin.code} → ${f.destination.code}`)}
      ${cell('Date', fmtDate(shownDate(f)))}
      ${cell('Departs', `${f.departure} · ${f.origin.city}`)}
      ${cell('Arrives', f.arrival ? `${f.arrival} · ${f.destination.city}` : 'To be announced')}
      ${cell('Duration', f.durationLabel || 'Not published')}
      ${cell('Stops', f.nonStop ? 'Non-stop' : String(f.stops))}
      ${cell('Cabin', cabin.label || 'Economy')}
      ${cell('Baggage', `Cabin ${f.baggage.cabin} · Check-in ${f.baggage.checkIn}`)}
      ${cell('Status', f.status)}
      ${cell('Fare rules', `${f.fareType} — ${fareRule}`, true)}
    </div>`;
  }

  /* facet() lived here and counted one field into {key,label,count} rows. The
     filter panel needs its counts computed against the OTHER active filters
     rather than the whole set, so that job moved into flight-filters.js with
     the definitions it belongs to. */

  /** Hand the panel the current searchable set and repaint the sort menu.
   *
   *  Both are derived from the SAME rows, which is what keeps a sort mode from
   *  being offered for data the filters have already decided does not exist —
   *  "Lowest layover" over a list of non-stops, for instance. */
  function renderFilters() {
    if (typeof FlightFilters === 'undefined') return;
    FlightFilters.setRows(searchable());
    renderSortOptions();
  }

  function renderSortOptions() {
    const sel = $('txSort');
    if (!sel || typeof FlightFilters === 'undefined') return;
    const opts = FlightFilters.availableSorts();
    if (!opts.some(o => o.id === state.sort)) state.sort = FlightFilters.DEFAULT_SORT;
    sel.innerHTML = opts.map(o =>
      `<option value="${esc(o.id)}"${o.id === state.sort ? ' selected' : ''}>${esc(o.label)}</option>`
    ).join('');
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
      : `<div class="tx-empty">
           <b>No flights match those filters</b>
           Every result was ruled out by the filters currently on. Clear them to
           see the full list again, or change the route and dates above.
           <div class="tx-empty-acts">
             <button type="button" class="tx-btn tx-btn-primary" data-tx-clear>Clear filters</button>
             <button type="button" class="tx-btn tx-btn-ghost" data-tx-modify>Modify search</button>
           </div>
         </div>`;

    /* Written on every render, so a filter, a sort and a "show more" all leave
       a URL that reproduces exactly what is on screen. */
    writeUrl();

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
  /** Hotels matching the destination the traveller searched for.
   *
   *  Matched against `location` ("Banjara Hills, Hyderabad") as a substring,
   *  which is as much as the sample data supports — there is no city field to
   *  match exactly and inventing one here would be guessing. Phase 4's
   *  destination search is where this becomes a real lookup over cities,
   *  areas and landmarks.
   *
   *  An unmatched destination returns nothing rather than everything: showing
   *  Hyderabad hotels to somebody who asked for Goa is worse than saying we
   *  have none, because they would have to notice for themselves. */
  function hotelsMatching(rows, dest) {
    if (!dest) return rows;
    const needle = dest.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(h => String(h.location || '').toLowerCase().includes(needle)
                         || String(h.name || '').toLowerCase().includes(needle));
  }

  /** Destination and nightly rate together — the two things the panel filters
   *  on. Kept beside hotelsMatching so "what a hotel search means" is one
   *  place rather than spread between here and the panel. */
  function hotelsFiltered(rows) {
    let out = hotelsMatching(rows, state.dest);
    if (state.priceRange && state.priceRange !== 'any' && typeof HotelSearch !== 'undefined') {
      out = out.filter(h => HotelSearch.inPriceBand(h.pricePerNight, state.priceRange));
    }
    return out;
  }

  /* ---------------------------------------------------------------------
     The sticky search summary

     WHY A SEPARATE BAR AND NOT THE PANEL PINNED. The search panel is a full
     form — destination, two calendars, a rooms-and-guests popover, a submit —
     and pinning it would hold about 180px of the viewport open on every scroll,
     on the page whose whole job is a long list. So the panel stays where it is
     and this appears once it has scrolled away: the criteria as one line, plus
     the way back to the form that owns them. Edit scrolls to the panel rather
     than duplicating its controls, which is what stops there being two places
     to type a destination and two answers to what was searched.
     --------------------------------------------------------------------- */
  function hotelSummaryBits() {
    const nights = (typeof SearchWidgets !== 'undefined')
      ? SearchWidgets.nightsBetween(state.checkIn, state.checkOut) : 0;
    const bits = [];
    if (state.dest) bits.push(state.dest);
    if (state.checkIn && state.checkOut) {
      bits.push(`${fmtDate(state.checkIn)} – ${fmtDate(state.checkOut)}`);
      if (nights) bits.push(`${nights} ${nights === 1 ? 'night' : 'nights'}`);
    }
    const rooms = Number(state.rooms) || 1;
    const guests = Number(state.guests) || 1;
    bits.push(`${rooms} ${rooms === 1 ? 'room' : 'rooms'}`);
    bits.push(`${guests} ${guests === 1 ? 'guest' : 'guests'}`);
    return bits;
  }

  function renderHotelSummary() {
    const bar = $('txSummaryBar');
    if (!bar) return;
    bar.innerHTML = `
      <div class="tx-summary-in">
        <p class="tx-summary-text">${hotelSummaryBits().map(b => `<span>${esc(b)}</span>`).join('')}</p>
        <button type="button" class="tx-btn tx-btn-primary tx-summary-edit" data-tx-edit-search>
          Edit search
        </button>
      </div>`;
  }

  /** Show the bar only once the panel it summarises is off screen. An
   *  IntersectionObserver rather than a scroll handler: no work per frame, and
   *  it is correct on a page whose height changes as filters run. */
  function watchHotelSummary() {
    const panel = $('txSearchPanel');
    const bar = $('txSummaryBar');
    if (!panel || !bar || typeof IntersectionObserver === 'undefined') return;
    new IntersectionObserver(([entry]) => {
      bar.classList.toggle('is-shown', !entry.isIntersecting);
      /* Hidden from assistive tech as well as from view — a duplicate summary
         in the tab order is noise while the real form is still on screen. */
      bar.setAttribute('aria-hidden', String(entry.isIntersecting));
    }, { rootMargin: '-80px 0px 0px 0px', threshold: 0 }).observe(panel);
  }

  /** Feed the panel the searchable set and repaint the sort menu. Both come
   *  from the SAME rows, so a sort whose field nothing carries is never
   *  offered — the same arrangement the flights page uses. */
  function renderHotelFilters() {
    if (typeof HotelFilters === 'undefined') return;
    HotelFilters.setRows(hotelsFiltered(allHotels));
    renderHotelSortOptions();
  }

  function renderHotelSortOptions() {
    const sel = $('txSort');
    if (!sel || typeof HotelFilters === 'undefined') return;
    const opts = HotelFilters.availableSorts();
    if (!opts.some(o => o.id === state.hotelSort)) state.hotelSort = HotelFilters.DEFAULT_SORT;
    sel.innerHTML = opts.map(o =>
      `<option value="${esc(o.id)}"${o.id === state.hotelSort ? ' selected' : ''}>${esc(o.label)}</option>`
    ).join('');
  }

  /** The heart on a card. Rendered only where the module is loaded, so a page
   *  that does not carry wishlist.js simply has no button rather than a
   *  broken one. */
  function wishlistButton(h) {
    return (typeof Wishlist !== 'undefined') ? Wishlist.button('hotel', h.id, h.name) : '';
  }

  /** A discount, only if the API sends something to discount FROM. No field
   *  does today, so the badge never renders — and will, unchanged, the moment
   *  an original price appears on the row. */
  function hotelDiscount(h) {
    const was = Number(h.originalPrice != null ? h.originalPrice : h.strikePrice);
    const now = Number(h.pricePerNight);
    if (!Number.isFinite(was) || !Number.isFinite(now) || was <= now) return null;
    return { pct: Math.round((was - now) / was * 100), was };
  }

  /* THE CARD'S HIERARCHY, in the order the eye should take it: the
     photograph, then the name, then how good it is (stars + score), then where
     it is, then what it costs. Amenities are capped at four because a card is
     a summary — the rest are one click away in the expanded panel, and a chip
     list that wraps to four rows buries the price under it. */
  const CARD_AMENITIES = 4;

  function hotelCard(h) {
    /* Distance is optional on the API row, so the badge is too — an empty
       "km from airport" is worse than no badge. */
    const badge = h.distanceKm != null
      ? `<span class="tx-badge">${esc(h.distanceKm)} km from airport</span>` : '';

    /* Guest rating as a scored block rather than a sentence: it is the number
       people compare properties on, so it gets its own weight. The review
       COUNT beside it is what makes a score trustworthy, so it renders the
       moment the API sends one — and stays absent until then, because "4.6"
       from three guests and from three thousand are not the same claim. */
    const rating = h.guestRating != null ? `
      <span class="tx-score" title="Guest rating">
        <b>${esc(h.guestRating.toFixed(1))}</b>
        <span>${esc(scoreWord(h.guestRating))}${h.reviewCount != null
          ? ` · ${esc(Number(h.reviewCount).toLocaleString('en-IN'))} reviews` : ''}</span>
      </span>` : '';

    const disc = hotelDiscount(h);
    const price = h.pricePerNight != null ? `
      <div class="tx-price">
        ${disc ? `<s class="tx-was">${esc(money(disc.was))}</s>` : ''}
        <b>${esc(money(h.pricePerNight))}</b>
        <span>per night</span>
        <i>+ taxes &amp; fees</i>
      </div>`
      : `<div class="tx-price"><b>Rate on request</b></div>`;

    /* Classified by the same reader the filter uses, so the badge and the
       filter can never disagree about what the policy says. */
    const cancelKey = typeof HotelFilters !== 'undefined' ? HotelFilters.cancellationOf(h) : null;
    const cancelBadge = cancelKey && cancelKey !== 'non-refundable'
      ? `<span class="tx-chip is-good">${esc(HotelFilters.cancellationLabel(cancelKey))}</span>` : '';
    /* Breakfast is the one amenity people filter a whole search on, so it gets
       a badge of its own rather than sitting anonymously in the chip list. */
    const meals = (h.amenities || []).find(a => /breakfast/i.test(a));
    const mealBadge = meals ? `<span class="tx-chip is-good">${esc(meals)}</span>` : '';

    const shown = (h.amenities || []).filter(a => a !== meals).slice(0, CARD_AMENITIES);
    const restCount = Math.max(0, (h.amenities || []).length - shown.length - (meals ? 1 : 0));

    return `<article class="tx-card" data-hotel-card="${esc(h.id)}">
      <div class="tx-media">
        ${hotelImage(h)}
        ${badge}
        ${disc ? `<span class="tx-deal">${disc.pct}% off</span>` : ''}
        ${wishlistButton(h)}
      </div>
      <div class="tx-body">
        <h3 class="tx-title">${esc(h.name)}</h3>
        <div class="tx-rate-row">${starRow(h.stars)}${rating}</div>
        <p class="tx-sub">${esc(h.location)}</p>
        <div class="tx-chips">
          ${cancelBadge}${mealBadge}
          ${shown.map(a => `<span class="tx-chip">${esc(a)}</span>`).join('')}
          ${restCount ? `<span class="tx-chip is-more">+${restCount} more</span>` : ''}
        </div>
        <div class="tx-foot">
          ${price}
          <div class="tx-card-actions">
            <button type="button" class="tx-btn tx-btn-ghost"
                    data-tx-hotel-details="${esc(h.id)}" aria-expanded="false">View Details</button>
            <button type="button" class="tx-btn tx-btn-primary"
                    data-tx-buy="hotel" data-tx-id="${esc(h.id)}">Book Now</button>
          </div>
        </div>
      </div>
    </article>`;
  }

  /** The word next to the score. Same thresholds the Guest rating filter bands
   *  use, read from that one list so the card and the filter cannot disagree. */
  function scoreWord(r) {
    if (typeof HotelFilters === 'undefined' || !HotelFilters.RATING_BANDS) return '';
    const band = HotelFilters.RATING_BANDS.find(b => r >= b.min);
    return band ? band.label : '';
  }

  function renderHotels(all) {
    const el = $('txHotelGrid');
    if (!el) return;
    allHotels = all;
    const dest = state.dest || '';

    const head = $('txHotelsHead');
    if (head) head.textContent = dest ? `Stays in ${dest}` : 'Hotels near the airport';

    /* Two stages, and the difference matters for the copy below. `searched` is
       what the destination and price band left; `found` is what the sidebar
       then allowed. An empty `searched` means the search found nothing; an
       empty `found` means the filters did, and those need different buttons. */
    const searched = hotelsFiltered(all);
    const found = (typeof HotelFilters !== 'undefined')
      ? HotelFilters.apply(searched)
      : searched;
    const page = found.slice(0, state.hotelShown);

    const line = $('txCount');
    if (line) {
      line.innerHTML = found.length
        ? `Showing <b>${page.length}</b> of <b>${found.length}</b> ${found.length === 1 ? 'stay' : 'stays'}`
        : '';
    }

    /* Only the rendered page is handed to the booking layer, matching what a
       Select Room click can actually reach. */
    catalogue.hotel = page;

    if (!page.length) {
      el.innerHTML = searched.length ? emptyByFilters() : emptyBySearch(dest);
      wireHotelEmptyState(all);
      return;
    }

    el.innerHTML = page.map(hotelCard).join('');
    armIcons(el);
    /* The cards were just replaced, so the hearts are freshly rendered from
       whatever Wishlist knew at build time; repaint in case the saved set
       arrived after the first render. */
    if (typeof Wishlist !== 'undefined') Wishlist.refresh();
    restoreOpenHotel();

    const more = $('txHotelMore');
    if (more) {
      const rest = found.length - page.length;
      more.style.display = rest > 0 ? '' : 'none';
      more.textContent = rest > 0 ? `Show ${Math.min(rest, PAGE_SIZE)} more` : '';
    }
    writeUrl();
  }

  /** The filters emptied it — the search itself found properties. */
  function emptyByFilters() {
    return `<div class="tx-empty">
      <b>No stays match those filters</b>
      Every property the search found was ruled out by the filters currently on.
      Clear them to see the full list again.
      <div class="tx-empty-acts">
        <button type="button" class="tx-btn tx-btn-primary" data-tx-hotel-clear>Clear filters</button>
      </div>
    </div>`;
  }

  /** The search itself found nothing, so clearing filters would not help. */
  function emptyBySearch(dest) {
    const because = dest ? `in ${esc(dest)}` : 'in that price range';
    return `<div class="tx-empty">
      <b>No stays ${because}</b>
      Try another destination or a wider price range, or browse everything we do have.
      <div class="tx-empty-acts">
        <button type="button" class="tx-btn tx-btn-primary" id="txShowAllHotels">Show all hotels</button>
      </div>
    </div>`;
  }

  function wireHotelEmptyState(all) {
    const clear = $('txHotelGrid').querySelector('[data-tx-hotel-clear]');
    if (clear) clear.addEventListener('click', () => {
      if (typeof HotelFilters !== 'undefined') HotelFilters.clear();
      state.hotelShown = PAGE_SIZE;
      renderHotelFilters();
      renderHotels(all);
    });
    const showAll = $('txShowAllHotels');
    if (showAll) showAll.addEventListener('click', () => {
      state.dest = '';
      state.priceRange = 'any';
      state.seededFromUrl = false;
      if (typeof HotelFilters !== 'undefined') HotelFilters.clear();
      state.hotelShown = PAGE_SIZE;
      if (typeof HotelSearch !== 'undefined') HotelSearch.mount();
      renderHotelFilters();
      renderHotels(all);
    });
  }

  /* ---------------------------------------------------------------------
     Hotel Details — an inline expansion, the same pattern flightCard's
     "View Details" already uses (detailsHtml/data-tx-details), rather than a
     second page: images, description, amenities, policies and every room
     option (price, meal plan, cancellation policy) with its own Select Room.
     --------------------------------------------------------------------- */
  const hotelDetailCache = new Map();

  async function hotelDetail(id) {
    if (hotelDetailCache.has(id)) return hotelDetailCache.get(id);
    const p = (typeof BookingApi !== 'undefined')
      ? BookingApi.getHotelDetail(id)
      : Promise.reject(new Error('offline'));
    hotelDetailCache.set(id, p);
    try { return await p; } catch (err) { hotelDetailCache.delete(id); throw err; }
  }

  /* The panel's markup moved to hotel-details.js, which renders each section
     only when the payload can fill it — gallery, rooms, about, amenities,
     policies, charges, nearby and map — rather than the fixed four this used
     to print whether or not there was anything in them. */
  function hotelDetailsHtml(h, detail) {
    if (typeof HotelDetails === 'undefined') return '';
    const body = HotelDetails.html(h, detail);
    return body ? `<div class="tx-hotel-details">${body}</div>` : '';
  }

  /** Expand one card. Its own function because the click handler and the
   *  restore-from-URL path both need it, and because a details fetch can fail
   *  on its own — separately from the catalogue that is already on screen. */
  function openHotelDetails(card, btn, h) {
    btn.textContent = 'Loading…';
    btn.setAttribute('aria-busy', 'true');
    hotelDetail(h.id).then(detail => {
      const html = hotelDetailsHtml(h, detail);
      btn.removeAttribute('aria-busy');
      if (!html) {
        /* Nothing the payload could fill. Saying so beats opening an empty
           drawer and leaving the traveller to wonder what they missed. */
        btn.textContent = 'No further details';
        btn.disabled = true;
        return;
      }
      btn.textContent = 'Hide Details';
      btn.setAttribute('aria-expanded', 'true');
      card.querySelector('.tx-body').insertAdjacentHTML('beforeend', html);
      if (typeof HotelDetails !== 'undefined') HotelDetails.mount(card);
      armIcons(card);
      state.openHotel = h.id;
      writeUrl();
    }).catch(err => {
      btn.removeAttribute('aria-busy');
      btn.textContent = 'View Details';
      /* The list is fine; only this panel failed. A toast says so without
         replacing results the traveller can still use. */
      if (typeof showToast === 'function') {
        showToast('We could not load those details just now. Please try again.', 'error');
      }
      console.error('[explore] hotel details failed', h.id, err);
    });
  }

  /** Re-open whatever the URL says was open, once the grid exists. */
  function restoreOpenHotel() {
    if (!state.openHotel) return;
    const card = document.querySelector(`[data-hotel-card="${CSS.escape(state.openHotel)}"]`);
    if (!card) return;
    const btn = card.querySelector('[data-tx-hotel-details]');
    const h = (catalogue.hotel || []).find(x => x.id === state.openHotel);
    if (btn && h && !card.querySelector('.tx-hotel-details')) openHotelDetails(card, btn, h);
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

  function renderPackages(all) {
    const el = $('txPackageGrid');
    if (!el) return;
    allPackages = all;
    const live = typeof PackageSearch !== 'undefined';
    const rows = live ? all.filter(p => PackageSearch.matches(p)) : all;

    const head = $('txPkgHead');
    if (head) {
      head.textContent = state.pkgDest ? `Tour packages — ${state.pkgDest}` : 'Curated tour packages';
    }

    if (!rows.length) {
      catalogue.package = [];
      /* Name the filter that emptied it. With one shared departure calendar
         a month with no Saturdays in it is the usual culprit, and "no
         results" would leave that a mystery. */
      const bits = [];
      if (state.pkgDest) bits.push(`to ${esc(state.pkgDest)}`);
      if (state.pkgMonth && state.pkgMonth !== 'any' && live) {
        bits.push(`departing in ${esc(PackageSearch.monthLabel(state.pkgMonth))}`);
      }
      if (state.pkgBudget && state.pkgBudget !== 'any') bits.push('in that budget');
      if (state.pkgDuration && state.pkgDuration !== 'any') bits.push('of that length');
      el.innerHTML = `<div class="tx-empty">
        <b>No packages ${bits.length ? bits.join(', ') : 'match that'}</b>
        Try a different month, a wider budget or another destination.
        <button type="button" class="tx-btn tx-btn-primary" id="txShowAllPkgs">Show all packages</button>
      </div>`;
      const btn = $('txShowAllPkgs');
      if (btn) btn.addEventListener('click', () => {
        state.pkgDest = '';
        state.pkgMonth = 'any';
        state.pkgBudget = 'any';
        state.pkgDuration = 'any';
        if (live) PackageSearch.mount();
        renderPackages(all);
      });
      return;
    }

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
     Search
     ---------------------------------------------------------------------
     The criteria filter the SAME client-side result set the facets do. When
     the live endpoint lands, this becomes a call carrying these values — the
     rendering below does not change either way. */

  /** Turn the current `state` into rendered results.
   *
   *  Shared by the Search button and by a search arriving in the URL, so the
   *  two cannot drift — landing-page criteria produce exactly the result set
   *  the button would have produced from the same values. */
  function applySearch() {
    state.shown = PAGE_SIZE;
    renderFilters();
    renderFlights();
  }

  /** The Packages panel.
   *
   *  The landing page speaks a different dialect: its Month is a bare name
   *  ("July") and its Tour Package Type is a category, not a destination.
   *  Both are translated here into what the panel uses — a real departure
   *  month key, and a destination only when it names a package we sell.
   *  Anything that does not translate is dropped rather than guessed at. */
  async function mountPackageSearch(rows) {
    if (typeof PackageSearch === 'undefined') return;

    if (state.pkgType && !state.pkgDest) {
      const hit = rows.find(p => p.name.toLowerCase() === String(state.pkgType).toLowerCase());
      if (hit) state.pkgDest = hit.name;
    }

    await PackageSearch.init(state, rows, req => {
      state.pkgDest = req.destination || '';
      state.pkgMonth = req.departureMonth || 'any';
      state.pkgBudget = req.budget;
      state.pkgDuration = req.duration;
      state.pkgTravellers = req.travellers;
      renderPackages(allPackages.length ? allPackages : rows);
      $('txResults')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    /* A month NAME from the hero becomes the first real departure month that
       matches it; if nothing departs then, the filter is left off rather than
       silently emptying the page. */
    if (state.pkgMonth && !/^\d{4}-\d{2}$/.test(state.pkgMonth) && state.pkgMonth !== 'any') {
      const wanted = String(state.pkgMonth).toLowerCase();
      const match = PackageSearch.availableMonths()
        .find(k => PackageSearch.monthLabel(k).toLowerCase().startsWith(wanted));
      state.pkgMonth = match || 'any';
      PackageSearch.mount();
    }
  }

  /** The Hotels panel, same arrangement as Flights: it owns the criteria and
   *  hands back a request; this file re-filters and re-renders. Absent module
   *  means no panel and the plain list, rather than a broken page. */
  function mountHotelSearch(rows) {
    if (typeof HotelSearch === 'undefined') return;
    HotelSearch.init(state, rows, req => {
      state.dest = req.destination;
      state.checkIn = req.checkIn;
      state.checkOut = req.checkOut;
      state.rooms = req.rooms;
      state.guests = req.adults + req.children;
      state.priceRange = req.priceRange;
      /* A NEW SEARCH CLEARS THE FILTERS. They were chosen against a different
         destination — a neighbourhood in Hyderabad means nothing in Goa, and a
         price band from one city would hide every result in another. This is
         the one case that resets them; sorting and paging leave them alone. */
      if (typeof HotelFilters !== 'undefined') HotelFilters.clear();
      state.hotelShown = PAGE_SIZE;
      const rowsNow = allHotels.length ? allHotels : rows;
      renderHotelFilters();
      renderHotels(rowsNow);
      renderHotelSummary();
      $('txResults')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ---------------------------------------------------------------------
     The search panel IS the hero card.

     This page used to carry a second set of criteria controls below the fold,
     in a module of their own. It does not any more: the card in the hero is the
     landing page's card, mounted here with the criteria that produced the list
     underneath it, so there is one place to type a trip and one place it can
     be read back from.

     A search here does NOT reload the page. The criteria are written into
     `state`, the URL is rewritten so the result is linkable and survives a
     refresh, and the list re-renders under a skeleton — which is what makes
     Search on this page feel like a filter rather than a navigation.
     --------------------------------------------------------------------- */

  /** Hotels, cruises and packages still live on their own pages, so their tabs
   *  navigate. Flights is handled in place. */
  const OTHER_SERVICES = { hotels: 'hotels.html', packages: 'packages.html' };

  function leaveFor(kind, params) {
    /* A GROUP DEALS ENQUIRY IS NOT A NAVIGATION, and this is the choke point
       every non-flights submission passes through.

       BookingCard holds ONE search handler and the last page to mount wins it.
       On index.html that is app.js, which makes this same check; this page
       registers its own, so without the check here the Hotels panel's Group
       Deals form — which this page renders in full — would fall through to the
       URLSearchParams below and put the enquirer's name, email and phone in a
       query string. Two handlers, one rule, and GroupEnquiry owns both halves
       of it so they cannot drift. */
    if (typeof GroupEnquiry !== 'undefined' && GroupEnquiry.isGroup(kind, params)) {
      GroupEnquiry.handle(params);
      return;
    }
    const page = OTHER_SERVICES[kind];
    if (!page) {
      if (typeof showToast === 'function') {
        showToast("Cruise search isn't available yet — browse our featured sailings below.", true);
      }
      return;
    }
    /* Nested values are skipped rather than stringified — see the same filter
       in app.js's goToSearch. An array here becomes "[object Object]". */
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) =>
        v !== '' && v !== null && v !== undefined && typeof v !== 'object'));
    window.location.href = `${page}?${qs.toString()}`;
  }

  /** Push the criteria into the address bar without reloading, so a result set
   *  can be shared, bookmarked and reached again with Back. */
  function writeUrl() {
    const multi = state.trip === 'multi' && state.legs.length >= 2;
    const p = {
      trip: state.trip, from: state.from, to: state.to,
      depart: state.depart, ret: state.trip === 'round' ? state.ret : '',
      legs: multi && typeof BookingCard !== 'undefined'
        ? BookingCard.encodeLegs(state.legs) : '',
      adults: state.pax.adults, children: state.pax.children, infants: state.pax.infants,
      cabin: state.cabin,
      q: state.q,
    };
    /* THE FILTERS GO IN THE URL TOO, which is the whole of "persist across a
       refresh, a sort change, opening a flight, and Back". They are namespaced
       f_* by the module, so nothing here has to know what they are or how many
       there now are — that is the point of asking it rather than listing them. */
    if (typeof FlightFilters !== 'undefined') FlightFilters.writeParams(p);

    /* The hotels page carries its own criteria and its own h_* filters. Both
       pages call one writeUrl so "what is in the address bar" is one answer. */
    if (document.body.dataset.spService === 'hotels') {
      Object.assign(p, {
        trip: undefined, from: undefined, to: undefined, ret: undefined,
        legs: undefined, cabin: undefined,
        dest: state.dest, checkIn: state.checkIn, checkOut: state.checkOut,
        rooms: state.rooms, guests: state.guests,
        price: state.priceRange && state.priceRange !== 'any' ? state.priceRange : undefined,
        open: state.openHotel || undefined,
      });
      if (typeof HotelFilters !== 'undefined') HotelFilters.writeParams(p);
    }

    const qs = new URLSearchParams(
      Object.entries(p).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== 0));
    history.replaceState(null, '', `${location.pathname}?${qs.toString()}`);
  }

  /** Bring the results under the hero into view. Honours reduced motion, which
   *  is the same condition the rest of the site stops animating under. */
  function revealResults() {
    const target = $('txResults');
    if (!target) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* Deferred a frame: called straight after render the list is still being
       laid out and the scroll lands short of it. */
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    });
  }

  function mountSearch() {
    if (typeof BookingCard === 'undefined') return;

    /* The card renders during parse with its own defaults; this is where the
       criteria that produced the list below are written into it, so the two
       cannot show different searches. */
    BookingCard.seedFlights({
      trip: state.trip, from: state.from, to: state.to,
      depart: state.depart, ret: state.ret, cabin: state.cabin,
      legs: state.legs.length ? state.legs : undefined,
      adults: state.pax.adults, children: state.pax.children, infants: state.pax.infants,
    });

    BookingCard.setSearchHandler((kind, params) => {
      if (kind !== 'flights') { leaveFor(kind, params); return; }
      state.trip = params.trip;
      /* The card hands over the ENCODED itinerary, because that is what a URL
         can carry; the array is this file's business. */
      state.legs = params.legs && typeof BookingCard !== 'undefined'
        ? BookingCard.decodeLegs(params.legs) : [];
      /* from/to/depart are the FIRST leg for a multi-city search — the card
         fills them in for exactly this reason, so the filters and the renderers
         below need no idea that an itinerary is in play. */
      state.from = params.from;
      state.to = params.to;
      state.depart = params.depart;
      state.ret = params.ret || '';
      state.cabin = params.cabin === 'premium-economy' ? 'premium' : params.cabin;
      state.pax = {
        adults: params.adults, children: params.children, infants: params.infants,
      };
      /* A NEW SEARCH CLEARS THE FILTERS. They were chosen against a different
         route — an airline that flies HYD→DEL may not fly the next pair at all,
         and a price band from a short hop would hide every result on a long
         one. This is the one case that resets them; sorting, paging and opening
         a flight all deliberately leave them alone. */
      if (typeof FlightFilters !== 'undefined') FlightFilters.clear();
      state.q = '';
      const box = $('txSearch');
      if (box) box.value = '';
      writeUrl();
      runFlightSearch({ scroll: true });
    });
  }


  function bind() {
    const search = $('txSearch');
    if (search) {
      let t = null;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          state.q = search.value.trim();
          state.shown = PAGE_SIZE;
          /* The query changes which rows the panel is describing, so its
             options and counts have to be re-derived, not just the list. */
          renderFilters();
          renderFlights();
        }, 160);
      });
    }

    /* The sidebar. Mounted once; setRows() feeds it and this fires on every
       change it makes. Sorting is NOT reset here — the spec is explicit that
       changing one must not clear the other, and they are separate state. */
    if (typeof FlightFilters !== 'undefined') {
      FlightFilters.mount($('txFilters'), () => {
        state.shown = PAGE_SIZE;
        renderFilters();
        renderFlights();
      });
    }

    /* The hotels sidebar. Same engine, its own definitions and its own h_*
       parameters, so the two pages cannot read each other's URL state. */
    const hotelsPage = document.body.dataset.spService === 'hotels';
    if (hotelsPage && typeof HotelFilters !== 'undefined') {
      HotelFilters.mount($('txFilters'), () => {
        state.hotelShown = PAGE_SIZE;
        renderHotelFilters();
        renderHotels(allHotels);
      });
    }

    const sort = $('txSort');
    if (sort) sort.addEventListener('change', () => {
      /* Sorting NEVER resets the filters — separate state, and the spec is
         explicit about it on both pages. */
      if (hotelsPage) {
        state.hotelSort = sort.value;
        if (typeof HotelFilters !== 'undefined') HotelFilters.sort = sort.value;
        renderHotels(allHotels);
        return;
      }
      state.sort = sort.value;
      if (typeof FlightFilters !== 'undefined') FlightFilters.sort = sort.value;
      renderFlights();
    });

    const hotelMore = $('txHotelMore');
    if (hotelMore) hotelMore.addEventListener('click', () => {
      state.hotelShown += PAGE_SIZE;
      renderHotels(allHotels);
    });

    const more = $('txMore');
    if (more) more.addEventListener('click', () => { state.shown += PAGE_SIZE; renderFlights(); });

    const toggle = $('txFilterToggle');
    if (toggle) toggle.addEventListener('click', () => $('txFilters').classList.toggle('tx-open'));

    /* Delegated: the filter panel and the result list are both re-rendered, so
       per-element listeners would be lost on every repaint. */
    document.addEventListener('click', e => {
      /* Both buttons on the empty state, and the sidebar's own "clear all"
         routes here too — one way to reset, wherever it is asked for. */
      if (e.target.closest('[data-tx-clear]')) {
        state.q = '';
        state.shown = PAGE_SIZE;
        if (search) search.value = '';
        if (typeof FlightFilters !== 'undefined') FlightFilters.clear();
        renderFilters(); renderFlights();
        return;
      }
      /* "Edit search" on the sticky bar and "Modify search" on the empty and
         error states are one action: return to the form that owns the criteria.
         The hotels page keeps its form in #txSearchPanel, the flights page in
         the hero card. */
      if (e.target.closest('[data-tx-modify], [data-tx-edit-search]')) {
        const dock = $('txSearchPanel') || $('heroSearchDock');
        if (dock) {
          const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
          dock.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
          const first = dock.querySelector('input, button');
          if (first) setTimeout(() => first.focus(), smooth ? 420 : 0);
        }
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

      const hdet = e.target.closest('[data-tx-hotel-details]');
      if (hdet) {
        const card = hdet.closest('.tx-card');
        const open = card.querySelector('.tx-hotel-details');
        if (open) {
          open.remove();
          hdet.textContent = 'View Details';
          hdet.setAttribute('aria-expanded', 'false');
          state.openHotel = null;
          writeUrl();
          return;
        }
        const h = (catalogue.hotel || []).find(x => x.id === hdet.dataset.txHotelDetails);
        if (!h) return;
        openHotelDetails(card, hdet, h);
        return;
      }
      /* --- Book Now: hand the chosen item to the booking engine ------------
         These used to be placeholder toasts. The engine owns everything from
         here — travellers, seats, extras, payment, confirmation — and this
         file's only job is to say WHICH item was chosen. */
      const book = e.target.closest('[data-tx-book]');
      if (book) {
        const f = flights.find(x => x.id === book.dataset.txBook);
        /* The row is handed on with the SEARCHED day, not the sample set's own.
           The card beside this button says "Thu, 10 Sept" (see shownDate); a
           booking sheet that then said "8 Aug 2026" is the same flight quoting
           two different dates, and the traveller has no way to tell which one
           they are buying. */
        if (f) {
          BookingFlows.open('flight', Object.assign({}, f, { date: shownDate(f) }),
                            { pax: state.pax, cabin: state.cabin });
        }
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
  /* ---------------------------------------------------------------------
     Criteria arriving from the landing page.

     The hero search cannot answer a query itself, so it collects the criteria
     and sends them here in the URL. Seeding `state` before the panel mounts is
     what makes the results page open ALREADY showing what was asked for —
     nobody types their route twice.

     Unknown or malformed values are ignored rather than trusted: this is a URL
     anyone can edit, and `state` drives what gets booked.
     --------------------------------------------------------------------- */
  function seedFromUrl() {
    const q = new URLSearchParams(location.search);
    if (![...q.keys()].length) return false;

    const str = (key, max) => {
      const v = (q.get(key) || '').trim();
      return v && v.length <= (max || 60) ? v : '';
    };
    const int = (key, lo, hi, dflt) => {
      const n = parseInt(q.get(key), 10);
      return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
    };
    /* Dates are compared as strings elsewhere, so anything that is not a plain
       ISO day is dropped rather than half-parsed. */
    const day = key => (/^\d{4}-\d{2}-\d{2}$/.test(q.get(key) || '') ? q.get(key) : '');

    let seeded = false;
    const mark = () => { seeded = true; };

    const trip = str('trip');
    if (trip === 'oneway' || trip === 'round' || trip === 'multi') { state.trip = trip; mark(); }
    const from = str('from', 40); if (from) { state.from = from.toUpperCase(); mark(); }
    const to = str('to', 40);     if (to)   { state.to = to.toUpperCase(); mark(); }
    const dep = day('depart');    if (dep)  { state.depart = dep; mark(); }
    const ret = day('ret');       if (ret)  { state.ret = ret; state.trip = 'round'; mark(); }

    /* The itinerary, decoded by the card that wrote it — one codec, not two
       that have to agree about a separator. */
    const rawLegs = q.get('legs');
    if (rawLegs && typeof BookingCard !== 'undefined') {
      const legs = BookingCard.decodeLegs(rawLegs).filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l.date));
      if (legs.length >= 2) {
        state.legs = legs;
        state.trip = 'multi';
        /* The first leg is what the results below can actually answer, so it
           doubles as the plain from/to/depart the renderers already read. */
        state.from = legs[0].from;
        state.to = legs[0].to;
        state.depart = legs[0].date;
        mark();
      }
    }

    if (q.has('adults') || q.has('children') || q.has('infants')) {
      /* Clamped by the SAME rules the picker enforces, not by a second set of
         bounds written here. A URL is editable by anyone and `state.pax` is
         what gets booked, so "9 adults and 9 children" has to be reduced to a
         party that can actually fly rather than trusted because it parsed. */
      const wanted = {
        adults: int('adults', 1, 99, state.pax.adults),
        children: int('children', 0, 99, state.pax.children),
        infants: int('infants', 0, 99, state.pax.infants),
      };
      state.pax = (typeof PaxSelector !== 'undefined')
        ? PaxSelector.clamp(wanted)
        : wanted;
      mark();
    }
    const cabin = str('cabin', 20);
    if (['economy', 'premium-economy', 'premium', 'business', 'first'].includes(cabin)) {
      /* The hero labels it "Premium Economy"; the booking data calls it
         'premium'. Normalise here rather than teaching both sides both names. */
      state.cabin = cabin === 'premium-economy' ? 'premium' : cabin;
      mark();
    }

    /* The sidebar reads its own f_* parameters. Not marked as "seeded": a URL
       carrying only filters is not a search, and marking it would scroll a
       first-time visitor past the hero to a list they did not ask for. */
    if (typeof FlightFilters !== 'undefined') {
      FlightFilters.readParams(name => q.get(name));
      state.sort = FlightFilters.sort;
    }
    if (typeof HotelFilters !== 'undefined') {
      HotelFilters.readParams(name => q.get(name));
      state.hotelSort = HotelFilters.sort;
    }
    const freeText = str('q', 80);
    if (freeText) {
      state.q = freeText;
      const box = $('txSearch');
      if (box) box.value = freeText;
    }

    /* Which card was expanded. Not "seeded": reopening a panel is not a
       search, and marking it would scroll a visitor past the hero. */
    const open = str('open', 40);   if (open) state.openHotel = open;

    const dest = str('dest', 80);   if (dest) { state.dest = dest; mark(); }
    const ci = day('checkIn');      if (ci)   { state.checkIn = ci; mark(); }
    const co = day('checkOut');     if (co)   { state.checkOut = co; mark(); }
    if (q.has('guests')) { state.guests = int('guests', 1, 32, state.guests); mark(); }
    if (q.has('rooms'))  { state.rooms = int('rooms', 1, 4, state.rooms); mark(); }

    const type = str('type', 60);   if (type)  { state.pkgType = type; mark(); }
    const month = str('month', 20); if (month) { state.pkgMonth = month; mark(); }

    return seeded;
  }

  /* =====================================================================
     Loading state
     =====================================================================
     A skeleton is a PROMISE ABOUT SHAPE. The flights one is built from the
     real card's own classes — .tx-flight, .tx-carrier, .tx-leg, .tx-act — so
     the placeholder occupies the same grid, the same three columns and very
     nearly the same height as the card that replaces it. That is what stops
     the list jumping when the data lands; a generic stack of grey bars looks
     tidier in isolation and moves everything when it is swapped out.
     ===================================================================== */

  /** One placeholder flight: logo, airline, both times, duration, fare, button
   *  — every element the real card carries, in its place. */
  function flightSkeletonCard() {
    return `<article class="tx-flight tx-sk-flight" aria-hidden="true">
      <div class="tx-carrier">
        <div class="tx-sk-logo"></div>
        <div class="tx-sk-col">
          <div class="tx-sk-line w80"></div>
          <div class="tx-sk-line w50"></div>
        </div>
      </div>
      <div class="tx-leg">
        <div class="tx-sk-col">
          <div class="tx-sk-line tx-sk-time"></div>
          <div class="tx-sk-line w70"></div>
        </div>
        <div class="tx-path tx-sk-col">
          <div class="tx-sk-line tx-sk-dur"></div>
          <div class="tx-sk-rule"></div>
          <div class="tx-sk-line tx-sk-stops"></div>
        </div>
        <div class="tx-leg-end tx-sk-col">
          <div class="tx-sk-line tx-sk-time"></div>
          <div class="tx-sk-line w70"></div>
        </div>
      </div>
      <div class="tx-act tx-sk-col">
        <div class="tx-sk-line tx-sk-fare"></div>
        <div class="tx-sk-btn"></div>
      </div>
    </article>`;
  }

  /** Card-shaped placeholders in the flight list.
   *
   *  role="status" on the wrapper, not aria-hidden on it: a screen reader is
   *  told a search is running, while the decorative bars inside it are not
   *  announced one by one. */
  function showFlightSkeleton(rows) {
    const host = $('txFlightList');
    if (!host) return;
    const count = rows || 5;
    host.innerHTML = `<div class="tx-sk-list" role="status" aria-live="polite">
      <span class="sr-only">Searching for flights…</span>
      ${Array.from({ length: count }, flightSkeletonCard).join('')}
    </div>`;
    /* The count line and the Show-more button belong to the previous result
       set; leaving them up over a skeleton says the old numbers still hold. */
    const line = $('txCount');
    if (line) line.innerHTML = '';
    const more = $('txMore');
    if (more) more.style.display = 'none';
  }

  /** One placeholder hotel: image, name, rating, location, amenities, price and
   *  both buttons — every element renderHotels puts on the real card, in its
   *  place.
   *
   *  Built on .tx-card/.tx-media/.tx-body themselves, exactly as the flight one
   *  is built on .tx-flight, so the placeholder inherits the real card's grid
   *  cell, aspect-ratio, padding, border and radius. Only the CONTENTS are grey
   *  bars; the box is the box. The previous three-line stack was a third of the
   *  height of what replaced it, so a full grid of them collapsed upward the
   *  moment the data landed. */
  function hotelSkeletonCard() {
    return `<article class="tx-card tx-sk-hotel" aria-hidden="true">
      <div class="tx-media tx-sk-media"></div>
      <div class="tx-body">
        <div class="tx-sk-line tx-sk-h-title"></div>
        <div class="tx-sk-line tx-sk-h-stars"></div>
        <div class="tx-sk-line tx-sk-h-sub"></div>
        <!-- FOUR chips, not three: the real cards carry four amenities, which
             wrap to two rows at this column width. Three sat on one row and
             made the placeholder a row shorter than the card. -->
        <div class="tx-chips">
          <span class="tx-sk-chip"></span>
          <span class="tx-sk-chip w-sm"></span>
          <span class="tx-sk-chip w-lg"></span>
          <span class="tx-sk-chip"></span>
        </div>
        <!-- The cancellation note. Two lines, because that is what "Free
             cancellation up to 48 hours before check-in" wraps to here. -->
        <div class="tx-sk-h-cancel">
          <div class="tx-sk-line tx-sk-h-note"></div>
          <div class="tx-sk-line tx-sk-h-note w60"></div>
        </div>
        <div class="tx-foot">
          <div class="tx-sk-col">
            <div class="tx-sk-line tx-sk-h-cap"></div>
            <div class="tx-sk-line tx-sk-h-price"></div>
            <div class="tx-sk-line tx-sk-h-tax"></div>
          </div>
          <div class="tx-sk-h-actions">
            <div class="tx-sk-btn tx-sk-h-btn"></div>
            <div class="tx-sk-btn tx-sk-h-btn"></div>
          </div>
        </div>
      </div>
    </article>`;
  }

  /** Placeholder cards in whichever grid this page has.
   *
   *  Flights and hotels get card-shaped sets built from their own markup.
   *  Cruises and packages are still simple stacks: their cards are image tiles
   *  with a caption, so a grey rectangle is already very nearly the shape. */
  function showSkeleton(rows) {
    /* The sidebar too, not just the list — see FilterEngine.showSkeleton. */
    const panel = (document.body.dataset.spService === 'hotels')
      ? (typeof HotelFilters !== 'undefined' ? HotelFilters : null)
      : (typeof FlightFilters !== 'undefined' ? FlightFilters : null);
    if (panel && $('txFilters')) panel.showSkeleton();

    if ($('txFlightList')) { showFlightSkeleton(rows); return; }

    const hotelGrid = $('txHotelGrid');
    if (hotelGrid) {
      /* Into the grid itself, not a wrapper: .tx-grid is what lays the cards
         out in columns, and a <div> in between would put every placeholder in
         one column and then reflow the lot when the real cards replace them. */
      hotelGrid.innerHTML = `<span class="sr-only" role="status">Searching for hotels…</span>`
        + Array.from({ length: rows || 6 }, hotelSkeletonCard).join('');
      return;
    }

    const host = $('txCruiseGrid') || $('txPackageGrid');
    if (!host) return;
    host.innerHTML = `<div class="tx-skeleton">${
      Array.from({ length: rows || 4 }, () => `
        <div class="tx-sk-card">
          <div class="tx-sk-line w40"></div>
          <div class="tx-sk-line w70"></div>
          <div class="tx-sk-line w55"></div>
        </div>`).join('')
    }</div>`;
  }

  /* The shortest time a skeleton stays up.
     Not padding for its own sake: the sample set resolves in the same frame the
     search starts, so without a floor the skeleton appears and vanishes inside
     one repaint — which reads as a flicker in the list, not as loading. Once a
     real endpoint is behind TravelData.flights() this stops mattering, because
     the response will already take longer than this. */
  const SKELETON_FLOOR_MS = 320;

  const wait = ms => new Promise(r => setTimeout(r, ms));

  /** Run the current `state` as a search: skeleton, fetch, render.
   *
   *  Every path that searches goes through here — the card's Search button and
   *  criteria arriving in the URL — so the first paint and the tenth search
   *  cannot produce different-looking results from the same values. */
  async function runFlightSearch(opts) {
    const started = Date.now();
    showFlightSkeleton();
    /* Scrolled to the SKELETON, not to the results: the placeholder is already
       the right shape and height, so the page settles once instead of moving
       again when the real cards land. */
    if (opts && opts.scroll) revealResults();
    try {
      flights = await TravelData.flights();
      const left = SKELETON_FLOOR_MS - (Date.now() - started);
      if (left > 0) await wait(left);
      writeFlightHeading();
      applySearch();
    } catch (err) {
      const host = $('txFlightList');
      if (host) {
        host.innerHTML = `<div class="tx-empty"><b>We could not load these flights</b>
          Check your connection and try the search again.</div>`;
      }
    }
  }

  /** The results heading, written from the criteria rather than typed into the
   *  markup — the two disagreed the moment a city was hardcoded. */
  function writeFlightHeading() {
    const head = $('txFlightsHead');
    const sub = $('txFlightsSub');
    const city = code => {
      const a = typeof TravelData !== 'undefined' && TravelData.airports[code];
      return a ? a.city : code;
    };
    const multi = state.trip === 'multi' && state.legs.length >= 2;

    if (head) {
      if (multi) {
        /* The whole itinerary, not just the leg being shown — the traveller
           planned four cities and should see four cities named back. */
        const stops = [city(state.legs[0].from)].concat(state.legs.map(l => city(l.to)));
        head.textContent = stops.join(' → ');
      } else {
        head.textContent = state.to
          ? `${city(state.from)} to ${city(state.to)}`
          : `Departures from ${city(state.from)}`;
      }
    }

    if (sub) {
      const when = state.depart || (flights[0] && flights[0].date);
      const party = typeof PaxSelector !== 'undefined'
        ? PaxSelector.summary(state.pax) : '';
      const bits = [];
      if (multi) {
        /* SAYS WHICH LEG THIS IS. The list below can only answer one leg at a
           time, and a page headed with a four-city itinerary that silently
           showed one hop would be reporting more than it found. */
        bits.push(`Flight 1 of ${state.legs.length}: `
          + `${city(state.legs[0].from)} to ${city(state.legs[0].to)}`);
      }
      if (when) bits.push(fmtDate(when));
      if (state.trip === 'round' && state.ret) bits.push(`returning ${fmtDate(state.ret)}`);
      if (party) bits.push(party);
      sub.textContent = bits.length
        ? bits.join(' · ')
        : 'Non-stop services across India, the Gulf and South-East Asia.';
    }
  }

  async function init() {
    const service = document.body.dataset.spService;
    if (ready || !service) return;
    ready = true;
    /* Before bind() and before the panel mounts, so the controls render
       already holding the criteria rather than being corrected afterwards. */
    const seeded = seedFromUrl();
    state.seededFromUrl = seeded;
    bind();
    /* Card-shaped placeholders while the catalogue loads. The sample data is
       instant, so this is usually a single frame — but it is the same await a
       real endpoint will sit behind, and an empty grid reads as "nothing
       here" rather than "not yet". */
    showSkeleton();
    await loadCatalogue(service);
  }

  /** Fetch and render one product's catalogue. Separate from init() so the
   *  error state's "Try again" can run it again without re-seeding the URL or
   *  binding a second set of listeners to every control on the page. */
  async function loadCatalogue(service) {
    try {
      if (service === 'flights') {
        mountSearch();
        /* ONE path, whether the criteria arrived in the URL from the landing
           page or are this page's own defaults: skeleton, fetch, render. A
           second "just render the schedule" branch is how the first paint and
           a later search ended up looking different. */
        await runFlightSearch();
        /* HOW THE SEAM IS HIDDEN.

           The hero above is pixel-identical to the landing page's — same nav,
           same video, same heading, same card in the same place — so arriving
           here looks like nothing happened, and the results would be a screen
           below the fold. Scrolling to them once they exist is what turns that
           into "the content beneath the hero changed": the page the traveller
           left is on screen for a moment, then moves up to reveal what they
           asked for. Only when they actually searched — a bare visit to this
           page should land on the hero like any other. */
        if (state.seededFromUrl) revealResults();
      } else if (service === 'hotels') {
        const rows = await TravelData.hotels();
        allHotels = rows;
        /* Started, not awaited: the saved set is a decoration on cards that
           should render at once, and a slow wishlist must not hold the grid. */
        if (typeof Wishlist !== 'undefined') {
          Wishlist.init().then(() => Wishlist.refresh());
        }
        mountHotelSearch(rows);
        /* Panel before grid: it derives the options and reconciles anything the
           URL asked for against what actually came back, so the first paint of
           the list is already the filtered one. */
        renderHotelFilters();
        renderHotels(rows);
        renderHotelSummary();
        watchHotelSummary();
        if (state.seededFromUrl) revealResults();
      } else if (service === 'cruises') {
        renderCruises(await TravelData.cruises());
      } else if (service === 'packages') {
        const rows = await TravelData.packages();
        await mountPackageSearch(rows);
        renderPackages(rows);
      }
    } catch (err) {
      showLoadError(err, service);
    }
  }

  /* ---------------------------------------------------------------------
     When the catalogue does not arrive

     WHY THIS IS FOUR MESSAGES AND NOT ONE. "Something went wrong" tells the
     traveller nothing they can act on. Whether the connection dropped, the
     request took too long, or the server answered with an error decides
     whether retrying is worth their time — and only the first is something
     they can fix themselves. TravelData tags the error with `kind`; this
     turns each into words plus the one or two buttons that actually help.
     --------------------------------------------------------------------- */
  const LOAD_ERRORS = {
    network: {
      icon: 'M1 1l22 22M16.7 16.7A10.9 10.9 0 0 0 12 20M5 12.5a10.9 10.9 0 0 1 4-2.4M2 8.8a16 16 0 0 1 5-3.3M20 5.5a16 16 0 0 1 2 3.3',
      title: 'No connection',
      body: 'Your device appears to be offline, so we could not reach our servers. Check the connection and try again.',
    },
    timeout: {
      icon: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
      title: 'This is taking longer than it should',
      body: 'The request timed out before anything came back. It is usually a passing thing — trying again often works.',
    },
    http: {
      icon: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
      title: 'We could not load these results',
      body: 'Our servers answered with an error. Nothing is wrong with your search — please try again in a moment.',
    },
  };

  function errorStateHtml(kind, opts) {
    const e = LOAD_ERRORS[kind] || LOAD_ERRORS.http;
    const modify = (opts && opts.modify) ? `
      <button type="button" class="tx-btn tx-btn-ghost" data-tx-modify>Modify search</button>` : '';
    return `<div class="tx-state" role="alert">
      <svg class="tx-state-art" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="${e.icon}"/>
      </svg>
      <b>${esc(e.title)}</b>
      <p>${esc(e.body)}</p>
      <div class="tx-empty-acts">
        <button type="button" class="tx-btn tx-btn-primary" data-tx-retry>Try again</button>
        ${modify}
      </div>
    </div>`;
  }

  function showLoadError(err, service) {
    const host = $('txFlightList') || $('txHotelGrid') || $('txCruiseGrid') || $('txPackageGrid');
    /* Offline is worth trusting over the thrown kind: a browser that knows it
       has no network says so more reliably than a failed fetch can. */
    const kind = (navigator.onLine === false) ? 'network' : ((err && err.kind) || 'http');
    if (host) {
      host.innerHTML = errorStateHtml(kind, { modify: service === 'flights' || service === 'hotels' });
      const retry = host.querySelector('[data-tx-retry]');
      if (retry) retry.addEventListener('click', () => {
        /* `ready` is what stops init() running twice; reload the catalogue
           directly instead, so a retry does not re-bind every listener. */
        showSkeleton();
        loadCatalogue(service);
      });
    }
    /* Still logged: a 500 is our problem to find, whatever the page says. */
    console.error('[explore] load failed', service, err);
  }

  return { init, state };
})();

document.addEventListener('DOMContentLoaded', TravelExplore.init);
/* The scripts are at the end of <body>, so DOMContentLoaded may already have
   fired by the time this runs. */
if (document.readyState !== 'loading') TravelExplore.init();
