'use strict';
/* ===========================================================================
   hotel-results.js — the Hotel Results screen.
   ===========================================================================
   The professional three-column results layout: filters on the left, the
   result cards in the middle, the booking summary on the right, with a search
   summary bar, a horizontal stepper and a sticky action bar.

   WHAT THIS FILE IS ALLOWED TO SAY. Every figure on this screen is either a
   column in `customer_hotels` / `customer_hotel_rooms`, or is derived from one
   by a rule written down here and in the pricing service. Nothing is invented.
   That rules out four things the reference screens show which this data cannot
   support, and they are omitted rather than faked:

       review count ("2,348 reviews")   no column, and no source to fill one
       property type facet              every property here is a hotel
       strikethrough "was" price        no historical rate is recorded
       "Best Seller" badge              no ranking signal exists

   The two derived fields the cards DO show — a meal plan and a
   free-cancellation badge — come from the server (`meal_plans`,
   `free_cancellation` on the search result), computed from the property's own
   rooms and its own policy text. See `CustomerHotel` for both derivations.

   TAX IS 12%. Not a guess: `customer_hotel_pricing_service.quote()` charges
   12% of the room subtotal, and this screen previews the same arithmetic so
   the number here and the number at checkout agree. Because the room is not
   chosen yet, the preview uses the property's lowest nightly rate and says so.

   OWNERSHIP. travel-explore.js still fetches the catalogue and owns the search
   panel; when this module is present on the page it takes over rendering the
   hotel results, and travel-explore steps aside. Cruises, packages and the
   whole of Flights are untouched by anything in this file.
   =========================================================================== */

const HotelResults = (function () {

  /* Same rate the server charges. One constant, one comment, one place to
     change it if the pricing service ever changes. */
  const TAX_RATE = 0.12;

  /* The eight steps of the hotel journey, in order. Horizontal only — this
     product has no vertical timeline anywhere. */
  const STEPS = [
    'Search', 'Hotel Results', 'Hotel Details', 'Room Selection',
    'Guest Details', 'Review', 'Payment', 'Confirmation',
  ];
  const CURRENT_STEP = 1;              // Hotel Results, zero-based.

  /* STAR_FILTERS, RATING_FILTERS, SORTS and the `filters` object were the
     rail's hardcoded contents. They are hotel-filters.js's definition list
     now — which is what lets a facet appear when the API starts sending its
     field, instead of when someone edits four places in this file.

     Filters stay separate from the SEARCH criteria in travel-explore's
     `state`, exactly as before: a filter narrows the list, it does not change
     what was searched for. */

  let rows = [];                       // everything the catalogue returned
  let shell = null;                    // travel-explore's `state`
  let selectedId = null;

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rupees = n => (typeof money === 'function' ? money(n)
    : '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'));

  /* ---------------------------------------------------------------------
     Small inline icons. The site's jp-icons set covers products, not
     amenities, so these are drawn here — as SVG, never emoji.
     --------------------------------------------------------------------- */
  const ICONS = {
    pin: '<path d="M8 1.6a4.6 4.6 0 0 0-4.6 4.6c0 3.4 4.6 8.2 4.6 8.2s4.6-4.8 4.6-8.2A4.6 4.6 0 0 0 8 1.6Zm0 6.3a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Z"/>',
    wifi: '<path d="M8 12.4a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm0-3.2c-1.1 0-2.1.4-2.9 1.1l1 1.1A2.9 2.9 0 0 1 8 10.6c.7 0 1.4.3 1.9.8l1-1.1A4.3 4.3 0 0 0 8 9.2Zm0-3.2c-2 0-3.8.8-5.1 2l1 1.1A5.9 5.9 0 0 1 8 7.4c1.6 0 3 .6 4.1 1.7l1-1.1A7.4 7.4 0 0 0 8 6Z"/>',
    check: '<path d="M6.4 11.3 3.2 8.1l1.1-1.1 2.1 2.1 5.3-5.3 1.1 1.1Z"/>',
    calendar: '<path d="M5 1.5v1.2H3.6c-.7 0-1.3.6-1.3 1.3v9c0 .7.6 1.3 1.3 1.3h8.8c.7 0 1.3-.6 1.3-1.3v-9c0-.7-.6-1.3-1.3-1.3H11V1.5H9.6v1.2H6.4V1.5Zm-1.4 4h8.8v7.5H3.6Z"/>',
    bed: '<path d="M2 4.5v7h1.4V9.8h9.2v1.7H14V7.6c0-1-.8-1.8-1.8-1.8H7.6v3.2H3.4V4.5Zm2.8 1.1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/>',
    person: '<path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 1.4c-2.4 0-5 1.2-5 2.9v1.3h10v-1.3c0-1.7-2.6-2.9-5-2.9Z"/>',
    shield: '<path d="M8 1.4 2.8 3.6v3.6c0 3.3 2.2 6.3 5.2 7.2 3-.9 5.2-3.9 5.2-7.2V3.6Zm-.8 9.6L4.6 8.4l1.1-1.1 1.5 1.5 3.4-3.4 1.1 1.1Z"/>',
    tag: '<path d="m14 8.3-5.7-5.7a1.2 1.2 0 0 0-.9-.4H3.2c-.7 0-1.2.5-1.2 1.2v4.2c0 .3.1.6.4.9L8 14.2c.5.5 1.3.5 1.8 0l4.2-4.2c.5-.5.5-1.2 0-1.7ZM4.9 5.8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>',
    headset: '<path d="M8 1.6a5.6 5.6 0 0 0-5.6 5.6v4a2 2 0 0 0 2 2h1.2V8H3.8v-.8a4.2 4.2 0 0 1 8.4 0V8h-1.8v5.2h1.8a2 2 0 0 0 2-2v-4A5.6 5.6 0 0 0 8 1.6Z"/>',
    chevron: '<path d="m8 10.2-4-4 1-1.1L8 8.1l3-3 1 1.1Z"/>',
  };
  const icon = (name, cls) =>
    `<svg class="${cls || ''}" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  /* ---------------------------------------------------------------------
     Stay maths. Nights come from the searched dates; when none were given
     the flow's own default of one night is used, and the summary says so
     rather than implying a stay length nobody chose.
     --------------------------------------------------------------------- */
  function nights() {
    const a = shell && shell.checkIn ? new Date(shell.checkIn) : null;
    const b = shell && shell.checkOut ? new Date(shell.checkOut) : null;
    if (!a || !b || isNaN(a) || isNaN(b)) return 1;
    return Math.max(1, Math.round((b - a) / 86400000));
  }
  function roomCount() { return Math.max(1, Number(shell && shell.rooms) || 1); }
  function guestCount() { return Math.max(1, Number(shell && shell.guests) || 2); }

  /** What a property costs for THIS stay, at its lowest nightly rate.
   *  `pricePerNight` is that lowest rate — the seed keeps it equal to the
   *  cheapest room, and the API documents it as "lowest nightly rate". */
  function stayCost(h) {
    const base = Number(h.pricePerNight) || 0;
    const room = base * nights() * roomCount();
    const tax = Math.round(room * TAX_RATE);
    return { room: Math.round(room), tax, total: Math.round(room) + tax };
  }

  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtWeekday(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { weekday: 'short' });
  }

  /** "Banjara Hills, Hyderabad" -> "Banjara Hills". The area facet is built
   *  from this, so it can only ever offer areas that exist in the data. */
  function areaOf(h) {
    const parts = String(h.location || '').split(',').map(s => s.trim()).filter(Boolean);
    return parts[0] || '';
  }

  /** The cheapest room's meal plan, when the server sent one. Ordered by room
   *  price, so index 0 is what the headline rate actually includes. */
  function headlineMeal(h) {
    return Array.isArray(h.mealPlans) && h.mealPlans.length ? h.mealPlans[0] : null;
  }

  /** Whether a meal plan adds something to the room rate. Anything that is not
   *  plainly "room only" is treated as an inclusion. */
  function isInclusion(meal) {
    return !/^\s*room only\s*$/i.test(String(meal || ''));
  }

  /* ---------------------------------------------------------------------
     Filtering — HotelFilters owns it.

     THE RAIL USED TO BE SIX HARDCODED FACETS HERE: a price ceiling, four star
     bands, four rating bands, a breakfast checkbox, a free-cancellation
     checkbox and an area list, each with its own line in `passes()`, its own
     block in `filtersHtml()` and its own case in the change handler. Adding a
     seventh meant touching all three.

     They are now a definition list in hotel-filters.js, rendered by the shared
     filter-engine.js that also drives the Flights rail. What changes for this
     screen:

       * a facet appears only when the ROWS can answer it — two or more
         distinct values, or a range with a spread — so the area group's old
         `areas.length > 1` check is the general rule rather than a special
         case, and property type, brand, bed type and the rest are written and
         waiting rather than absent.
       * the price ceiling becomes a real range with a floor as well, so "under
         ₹8,000" and "between ₹4,000 and ₹8,000" are both expressible.
       * meal plan and cancellation stop being two yes/no boxes and become the
         actual values the API sends, now that it sends `meal_plans` and
         `free_cancellation`.
       * filters, sort and paging go in the URL, and Back undoes one step.

     Destination narrowing still stays where it already lived — travel-explore's
     search — so this rail only ever narrows within what that returned.

     `passes()` is gone with the rail: the engine's own predicate replaced it,
     and its counts are computed against the other active filters exactly as
     `countIf(skip, …)` did.
     --------------------------------------------------------------------- */
  const rail = () => (typeof HotelFilters === 'undefined' ? null : HotelFilters);

  /** What the rail has left, in the chosen order.
   *
   *  Both halves belong to HotelFilters now — see the note above `rail()`.
   *  The six hardcoded facets and the four-entry sort table that used to live
   *  here are a definition list in hotel-filters.js, so a facet the API starts
   *  sending appears without an edit to this file. */
  function visible() {
    return rail() ? rail().apply(rows) : rows.slice();
  }

  /* countIf() lived here and answered "how many would this facet leave, counted
     against every OTHER active filter". The engine computes exactly that for
     every option it renders, so the helper went with the rail it served. */

  /* ---------------------------------------------------------------------
     Render — search summary bar
     --------------------------------------------------------------------- */
  /* ---------------------------------------------------------------------
     The search summary — EDITABLE IN PLACE.

     Every screen in the journey renders this same bar, so it is the one place
     the criteria can be changed and the one place that has to be got right.

     IT USED TO BE FIVE READ-ONLY SPANS behind a "Modify Search" button, and
     that was worse than inconvenient: the flow can be entered with no dates at
     all — the landing page's card does not require them — and Room Selection
     then asks the server to price a stay with no nights in it, gets a 422, and
     disables Continue with "We could not price these rooms". The traveller was
     stuck at step 4 with no way forward and no way to supply what was missing
     except going back to the start.

     The fields are real inputs now. Changing one writes it to the shared search
     state, updates the URL and tells the current screen to re-price. Modify
     Search remains and focuses the first field rather than being the only door.
     --------------------------------------------------------------------- */
  const SB_TODAY = () => new Date().toISOString().slice(0, 10);
  const SB_PLUS = n => {
    const d = new Date(); d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /** The destinations the catalogue actually has, so the list cannot offer a
   *  city with nothing in it. */
  function sbPlaces() {
    return [...new Set(rows.map(h => {
      const parts = String(h.location || '').split(',').map(x => x.trim()).filter(Boolean);
      return parts[parts.length - 1];
    }).filter(Boolean))];
  }

  function searchbarHtml() {
    const dest = (shell && shell.dest) || '';
    const ci = (shell && shell.checkIn) || '';
    const co = (shell && shell.checkOut) || '';
    const places = sbPlaces();

    return `
      <div class="hr-searchbar is-editable">
        <label class="hr-sb-field">
          <span class="hr-sb-label">Destination</span>
          <input class="hr-sb-input" type="text" list="hrSbPlaces" data-hr-sb="dest"
                 placeholder="All destinations" autocomplete="off" value="${esc(dest)}">
          <datalist id="hrSbPlaces">${
            places.map(p => `<option value="${esc(p)}"></option>`).join('')
          }</datalist>
        </label>
        <label class="hr-sb-field">
          <span class="hr-sb-label">Check-in</span>
          <input class="hr-sb-input" type="date" data-hr-sb="checkIn"
                 min="${esc(SB_TODAY())}" value="${esc(ci)}">
          <span class="hr-sb-sub">${esc(fmtWeekday(ci))}</span>
        </label>
        <label class="hr-sb-field">
          <span class="hr-sb-label">Check-out</span>
          <input class="hr-sb-input" type="date" data-hr-sb="checkOut"
                 min="${esc(ci || SB_TODAY())}" value="${esc(co)}">
          <span class="hr-sb-sub">${esc(fmtWeekday(co))}</span>
        </label>
        <label class="hr-sb-field is-narrow">
          <span class="hr-sb-label">Rooms</span>
          <input class="hr-sb-input" type="number" data-hr-sb="rooms"
                 min="1" max="8" value="${roomCount()}">
        </label>
        <label class="hr-sb-field is-narrow">
          <span class="hr-sb-label">Guests</span>
          <input class="hr-sb-input" type="number" data-hr-sb="guests"
                 min="1" max="32" value="${guestCount()}">
        </label>
        <div class="hr-sb-action">
          <button type="button" class="hr-btn hr-btn-ghost" id="hrModify">Modify Search</button>
        </div>
      </div>`;
  }

  /** Fill in dates the traveller never gave us.
   *
   *  Tonight and tomorrow, which is what a hotel search means with no dates,
   *  and the same default every booking site applies. Done ONCE on entry to
   *  the flow and written straight into the visible, editable bar — a default
   *  the traveller can see and change is a starting point; one they cannot see
   *  would be us quietly booking dates nobody chose. */
  function ensureStayDates() {
    if (!shell) return false;
    let changed = false;
    if (!shell.checkIn) { shell.checkIn = SB_TODAY(); changed = true; }
    if (!shell.checkOut || shell.checkOut <= shell.checkIn) {
      const base = new Date(shell.checkIn);
      base.setDate(base.getDate() + 1);
      shell.checkOut = base.toISOString().slice(0, 10);
      changed = true;
    }
    return changed;
  }

  /** Apply one edited field and tell the current screen to re-price. */
  function applySearchField(name, raw) {
    if (!shell) return;
    if (name === 'dest') shell.dest = String(raw || '').trim();
    else if (name === 'checkIn') {
      shell.checkIn = raw || '';
      /* Check-out must stay after check-in; push it rather than refuse the
         edit, which reads as the field being stuck. */
      if (shell.checkIn && shell.checkOut && shell.checkOut <= shell.checkIn) {
        const d = new Date(shell.checkIn); d.setDate(d.getDate() + 1);
        shell.checkOut = d.toISOString().slice(0, 10);
      }
    } else if (name === 'checkOut') {
      shell.checkOut = raw || '';
      if (shell.checkIn && shell.checkOut && shell.checkOut <= shell.checkIn) {
        const d = new Date(shell.checkOut); d.setDate(d.getDate() - 1);
        shell.checkIn = d.toISOString().slice(0, 10);
      }
    } else if (name === 'rooms') shell.rooms = Math.max(1, Math.min(8, Number(raw) || 1));
    else if (name === 'guests') shell.guests = Math.max(1, Math.min(32, Number(raw) || 1));

    writeStayUrl();
    /* One event, every screen. A screen that is on the page re-prices; the
       others are hidden and will read the new state when they next paint. */
    document.dispatchEvent(new CustomEvent('hr:searchchange', { detail: { field: name } }));
  }

  /** Keep the criteria in the address bar so a refresh or a share carries the
   *  stay, not just the hotel. */
  function writeStayUrl() {
    const q = new URLSearchParams(location.search);
    const set = (k, v) => { if (v) q.set(k, v); else q.delete(k); };
    set('dest', shell.dest);
    set('checkIn', shell.checkIn);
    set('checkOut', shell.checkOut);
    set('rooms', shell.rooms);
    set('guests', shell.guests);
    const url = `${location.pathname}?${q.toString()}`;
    if (url !== location.pathname + location.search) history.replaceState(null, '', url);
  }

  /** The stepper, at whichever step is current. Exported so Hotel Details
   *  renders the same rail one step further along rather than owning a second
   *  copy of the journey that could disagree about its length. */
  function stepperHtml(current) {
    const at = typeof current === 'number' ? current : CURRENT_STEP;
    return `<nav class="hr-stepper" aria-label="Booking progress">${
      STEPS.map((label, i) => {
        const state = i < at ? 'is-done' : i === at ? 'is-current' : '';
        const mark = i < at ? icon('check') : String(i + 1);
        const aria = i === at ? ' aria-current="step"' : '';
        return `${i ? '<span class="hr-step-line" aria-hidden="true"></span>' : ''}
          <span class="hr-step ${state}"${aria}>
            <span class="hr-step-dot" aria-hidden="true">${mark}</span>
            <span class="hr-step-label">${esc(label)}</span>
          </span>`;
      }).join('')
    }</nav>`;
  }

  /* ---------------------------------------------------------------------
     Render — filters
     --------------------------------------------------------------------- */
  /* opt() drew one checkbox row for the hand-built rail; the engine has its
     own. */


  /* filtersHtml() drew the rail by hand — a head, six groups, and an `opt()`
     helper for each checkbox. filter-engine.js renders it now, from the
     definitions in hotel-filters.js, into the same #hrFilters element. The
     `hr-` look is preserved in hotel.css, which styles the engine's markup to
     match the rest of this screen rather than the Flights sidebar. */


  /* ---------------------------------------------------------------------
     Render — one hotel card
     --------------------------------------------------------------------- */
  /** The save-for-later heart, from wishlist.js.
   *
   *  Rendered only where that module is loaded, so a page without it gets no
   *  button rather than a broken one. The module owns the whole interaction —
   *  the API call, the optimistic fill, putting it back when the server
   *  disagrees, and sending a signed-out visitor to sign in — and it is
   *  generic over item_type because the endpoint is, so this is one call
   *  rather than a wishlist implementation living in a results screen. */
  function saveButton(h) {
    return (typeof Wishlist !== 'undefined') ? Wishlist.button('hotel', h.id, h.name) : '';
  }

  function cardHtml(h) {
    const cost = stayCost(h);
    const meal = headlineMeal(h);
    const n = nights();
    const img = (typeof hotelImageTag === 'function')
      ? hotelImageTag(h)
      : `<img src="${esc(imageSrc(h))}" alt="${esc(h.name)}" loading="lazy">`;

    return `
      <article class="hr-card ${selectedId === String(h.id) ? 'is-selected' : ''}"
               data-hotel="${esc(h.id)}">
        <div class="hr-card-media">
          ${img}
          ${h.distanceKm != null
            ? `<span class="hr-card-badge">${esc(h.distanceKm)} km from airport</span>` : ''}
          ${saveButton(h)}
          ${photoCredit(h)}
        </div>
        <div class="hr-card-body">
          <div class="hr-card-top">
            <div class="hr-card-main">
              <div class="hr-name-row">
                <h3 class="hr-name">${esc(h.name)}</h3>
                ${h.stars ? `<span class="hr-stars" role="img"
                   aria-label="${esc(h.stars)} star hotel">${'★'.repeat(h.stars)}</span>` : ''}
              </div>
              <p class="hr-loc">${icon('pin')} ${esc(h.location)}</p>
              ${h.guestRating != null ? `
                <div class="hr-rating-row">
                  <span class="hr-rating">${esc(Number(h.guestRating).toFixed(1))}</span>
                  <span class="hr-rating-word">${esc(ratingWord(h.guestRating))}</span>
                </div>` : ''}
              ${(h.amenities || []).length ? `
                <div class="hr-amenities">${h.amenities.slice(0, 5).map(a =>
                  `<span class="hr-amenity">${icon('check')} ${esc(a)}</span>`).join('')}
                </div>` : ''}
              <div class="hr-notes">
                ${meal ? (isInclusion(meal)
                  ? `<span class="hr-note-ok">${icon('check')} ${esc(meal)}</span>`
                  /* "Room only" is what the cheapest rate IS, not something it
                     throws in — so it is stated plainly rather than ticked
                     green like an inclusion. */
                  : `<span class="hr-note-plain">${esc(meal)}</span>`) : ''}
                ${h.freeCancellation === true
                  ? `<span class="hr-note-ok">${icon('check')} Free cancellation</span>` : ''}
                ${h.cancellationPolicy
                  ? `<span class="hr-note-plain">${esc(h.cancellationPolicy)}</span>` : ''}
              </div>
            </div>

            <div class="hr-card-price">
              <span class="hr-price-main">${esc(rupees(h.pricePerNight))}</span>
              <span class="hr-price-for">per night</span>
              <span class="hr-price-tax">+ ${esc(rupees(cost.tax))} taxes &amp; fees</span>
              <span class="hr-price-for">${esc(rupees(cost.total))} for ${n} night${n > 1 ? 's' : ''}</span>
              <div class="hr-card-cta">
                <button type="button" class="hr-btn hr-btn-primary" data-view-rooms="${esc(h.id)}">
                  View Rooms
                </button>
              </div>
            </div>
          </div>
        </div>
      </article>`;
  }

  /** The word beside the score. Bands only — never a review count, which this
   *  data does not have. */
  function ratingWord(r) {
    const n = Number(r) || 0;
    if (n >= 4.5) return 'Excellent';
    if (n >= 4.0) return 'Very Good';
    if (n >= 3.5) return 'Good';
    return 'Pleasant';
  }

  /** The photographer credit overlay.
   *
   *  NOT OPTIONAL. Every photograph in assets/hotels/ is a Wikimedia Commons
   *  file under CC BY or CC BY-SA, and those licences require visible
   *  attribution. assets/hotels/CREDITS.md says so explicitly, and says that
   *  if the overlay is ever removed the attribution has to be reproduced
   *  somewhere the user can reach. It was missing from this card — and from
   *  the grid this screen replaced — so it is restored here. */
  function photoCredit(h) {
    const credits = typeof HOTEL_IMAGE_CREDITS !== 'undefined' ? HOTEL_IMAGE_CREDITS : {};
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
    const slug = (h.imageKey && known[h.imageKey]) ? h.imageKey
      : (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');
    const c = credits[slug];
    if (!c) return '';
    return `<span class="hr-card-credit">Photo: ${esc(c.artist)} · ${esc(c.licence)}</span>`;
  }

  /** Falls back to the shared photography map when travel-explore's own
   *  helper is not reachable from here. */
  function imageSrc(h) {
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    const known = typeof HOTEL_IMAGE_FILES === 'object' && HOTEL_IMAGE_FILES
      && h.imageKey && HOTEL_IMAGE_FILES[h.imageKey];
    const slug = known ? h.imageKey
      : (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');
    return `${dir}${slug}.webp`;
  }

  /* ---------------------------------------------------------------------
     Render — booking summary
     --------------------------------------------------------------------- */
  function summaryHtml() {
    const picked = rows.find(h => String(h.id) === String(selectedId));
    const n = nights();

    const stay = `
      <div class="hr-sum-dest">${esc((shell && shell.dest) || 'Your stay')}</div>
      <div class="hr-sum-dates">
        ${esc(fmtDay(shell && shell.checkIn))} ${icon('chevron')} ${esc(fmtDay(shell && shell.checkOut))}
      </div>
      <div class="hr-sum-meta">${roomCount()} Room${roomCount() > 1 ? 's' : ''} · ${guestCount()} Guest${guestCount() > 1 ? 's' : ''}</div>
      <div class="hr-sum-meta">${n} Night${n > 1 ? 's' : ''}</div>`;

    if (!picked) {
      return `
        <div class="hr-summary">
          <div class="hr-sum-head"><h2>Booking Summary</h2></div>
          <div class="hr-sum-body">${stay}</div>
          <div class="hr-sum-placeholder">
            Choose a hotel to see its price breakdown.
          </div>
          ${trustHtml()}
        </div>`;
    }

    const cost = stayCost(picked);
    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <img class="hr-sum-thumb" src="${esc(imageSrc(picked))}" alt="" loading="lazy">
            <div>
              <p class="hr-sum-hotel-name">${esc(picked.name)}</p>
              ${picked.stars ? `<span class="hr-stars" role="img"
                aria-label="${esc(picked.stars)} star hotel">${'★'.repeat(picked.stars)}</span>` : ''}
              <p class="hr-sum-hotel-loc">${esc(picked.location)}</p>
            </div>
          </div>
          <div class="hr-sum-rule"></div>
          ${stay}
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Price Details</div>
          <div class="hr-sum-line">
            <span>Room charges (${n} night${n > 1 ? 's' : ''}${roomCount() > 1 ? ` × ${roomCount()} rooms` : ''})</span>
            <b>${esc(rupees(cost.room))}</b>
          </div>
          <div class="hr-sum-line"><span>Taxes &amp; fees</span><b>${esc(rupees(cost.tax))}</b></div>
          <div class="hr-sum-total">
            <span class="hr-sum-total-label">Total Amount</span>
            <span class="hr-sum-total-value">${esc(rupees(cost.total))}</span>
          </div>
          <span class="hr-sum-note">
            Indicative, at this property's lowest nightly rate. The final price is
            confirmed once you choose a room.
          </span>
          ${picked.freeCancellation === true ? `
            <div class="hr-sum-callout">
              ${icon('shield')}
              <div>
                <b>Free cancellation</b>
                <span>${esc(picked.cancellationPolicy || '')}</span>
              </div>
            </div>` : ''}
        </div>
        ${trustHtml()}
      </div>`;
  }

  /* Claims that are true of this portal regardless of the property: they
     describe how the site works, not the inventory. */
  function trustHtml() {
    return `
      <div class="hr-trust">
        <div class="hr-trust-row">${icon('shield')}
          <div><b>Secure booking</b><span>Your data is protected</span></div></div>
        <div class="hr-trust-row">${icon('headset')}
          <div><b>24/7 customer support</b><span>We're here to help you anytime</span></div></div>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Render — sticky action bar
     --------------------------------------------------------------------- */
  function actionbarHtml() {
    const picked = rows.find(h => String(h.id) === String(selectedId));
    const cost = picked ? stayCost(picked) : null;
    const n = nights();

    return `
      <div class="hr-actionbar-inner">
        <div class="hr-ab-item hr-ab-hide-sm">${icon('shield')}
          <div><b>Secure booking</b><span>Your data is protected</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item">${icon('calendar')}
          <div><b>${esc(fmtDay(shell && shell.checkIn))} → ${esc(fmtDay(shell && shell.checkOut))}</b>
          <span>${n} night${n > 1 ? 's' : ''}</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item hr-ab-hide-sm">${icon('bed')}
          <div><b>${roomCount()} Room${roomCount() > 1 ? 's' : ''}</b>
          <span>${guestCount()} Guest${guestCount() > 1 ? 's' : ''}</span></div></div>

        <div class="hr-ab-total">
          <b>${cost ? esc(rupees(cost.total)) : '—'}</b>
          <span>${cost ? 'Indicative total' : 'Select a hotel'}</span>
        </div>
        <div class="hr-ab-cta">
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg" id="hrContinue"
                  ${picked ? '' : 'disabled'}>
            Continue to Hotel Details
          </button>
          <span>${picked ? 'You can select your room next' : 'Choose a hotel to continue'}</span>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Paint
     --------------------------------------------------------------------- */
  function paintResults() {
    const list = visible();
    const el = $('hrCards');
    const count = $('hrCount');
    if (count) {
      count.textContent = `${list.length} hotel${list.length === 1 ? '' : 's'} found`;
    }
    if (!el) return;

    if (!list.length) {
      el.innerHTML = `
        <div class="hr-empty">
          <b>No hotels match these filters</b>
          <p>Try a wider price range, fewer star categories, or another destination.</p>
          <button type="button" class="hr-btn hr-btn-primary" id="hrResetEmpty">Clear filters</button>
        </div>`;
      const btn = $('hrResetEmpty');
      if (btn) btn.addEventListener('click', clearAll);
      return;
    }
    el.innerHTML = list.map(cardHtml).join('');
    /* The cards were just replaced, so their hearts are freshly built from
       whatever Wishlist knew at the time. Repaint in case the saved set landed
       after this render — it is fetched in parallel, not awaited. */
    if (typeof Wishlist !== 'undefined') Wishlist.refresh();
  }

  /** Hand the panel the current rows. It re-derives which facets the data can
   *  answer, reconciles anything the URL asked for against what actually came
   *  back, and repaints itself — counts included. */
  function paintFilters() {
    if (!rail()) return;
    rail().setRows(rows);
    /* Which sorts are offered depends on the same rows the facets do, so the
       menu is rebuilt here rather than once per search — otherwise a search
       whose properties carry no guest rating would keep offering to sort by
       one until the page reloaded. */
    paintSortOptions();
  }
  function paintSummary() {
    const el = $('hrSummary');
    if (el) el.innerHTML = summaryHtml();
  }
  function paintActionbar() {
    const el = $('hrActionbar');
    if (el) el.innerHTML = actionbarHtml();
  }

  /** Everything that depends on the filter state. Filters repaint too, because
   *  their counts are relative to the other active filters. */
  function repaint() {
    paintFilters();
    paintResults();
    paintSummary();
    paintActionbar();
  }

  function clearAll() {
    if (rail()) rail().clear();
    /* Explicitly, because the engine's clear() repaints the rail but does not
       fire the change callback that normally writes the URL — so without this
       the address bar kept advertising filters that had just been removed, and
       a refresh brought them all back. */
    writeUrl(true);
    repaint();
  }

  /* ---------------------------------------------------------------------
     Events — delegated once, at the root, so every repaint stays live.
     --------------------------------------------------------------------- */
  let bound = false;
  function bind() {
    if (bound) return;
    const root = $('hrRoot');
    if (!root) return;
    bound = true;

    /* The rail. Mounted once; setRows() feeds it and this fires on every
       change it makes. Filters are the engine's, sorting is the select
       above — changing one never resets the other. */
    if (rail()) {
      rail().mount($('hrFilters'), () => {
        writeUrl(true);
        paintResults();
        paintSummary();
        paintActionbar();
      });
    }

    root.addEventListener('click', e => {
      const view = e.target.closest('[data-view-rooms]');
      if (view) { select(view.getAttribute('data-view-rooms'), true); return; }

      const card = e.target.closest('[data-hotel]');
      if (card) { select(card.getAttribute('data-hotel'), false); return; }

      if (e.target.closest('#hrClear')) { clearAll(); return; }
      if (e.target.closest('#hrModify')) { modifySearch(); return; }
    });

    /* Only the sort is this file's now. Every facet in the rail is the
       engine's, which owns its own delegated listeners on #hrFilters. */
    root.addEventListener('change', e => {
      if (e.target.id !== 'hrSort') return;
      if (rail()) rail().sort = e.target.value;
      /* Sorting never touches the filters — a different order of the same
         results. Only the list is repainted. */
      writeUrl(true);
      paintResults();
    });

    /* The bespoke price-slider handlers went with the hand-built rail. The
       engine debounces its own range input, suppresses repaints mid-drag so
       the element being dragged is never replaced under the pointer, and
       commits on release and on `change` for keyboard users.

    /* The sticky bar sits outside #hrRoot, so its CTA is bound separately. */
    const bar = $('hrActionbar');
    if (bar) bar.addEventListener('click', e => {
      if (e.target.closest('#hrContinue')) continueToDetails();
    });
  }


  function select(id, andContinue) {
    selectedId = String(id);
    paintResults();
    paintSummary();
    paintActionbar();
    if (andContinue) continueToDetails();
  }

  /** Results now leads to Hotel Details, not straight into the booking flow —
   *  Details is step 3 of the journey and Room Selection follows it. */
  function continueToDetails() {
    const picked = rows.find(h => String(h.id) === String(selectedId));
    if (picked) goToDetails(picked);
  }

  /** Modify Search reveals the panel that is already on the page — the same
   *  control the landing page uses. It is not redesigned here.
   *
   *  The section around it is un-collapsed, and only the panel is allowed back:
   *  the Explore band's heading and toolbar stay suppressed so the criteria
   *  controls appear on their own rather than under a second page title. */
  function modifySearch() {
    /* THE BAR IS EDITABLE, so the first thing this does is put the cursor in
       it. Only when the full panel exists — the Results screen — does it also
       reveal that; on Details, Rooms, Guests, Review and Payment there is no
       panel to reveal and the bar itself is the whole answer. */
    const field = document.querySelector('[data-hr-sb="dest"]');
    if (field) {
      field.focus();
      field.select && field.select();
      field.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const panel = $('txSearchPanel');
    if (!panel) return;
    const section = document.querySelector('.tx-scope .tx-section');
    if (section) section.classList.remove('hr-collapsed');
    document.querySelectorAll('.tx-scope .tx-head, #txResults, #txHotelGrid')
      .forEach(el => el.classList.add('hr-hidden'));
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const first = panel.querySelector('input, select, button');
    if (first) first.focus();
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  /** True when this page has the results shell — i.e. this module owns the
   *  hotel results and travel-explore should not render its grid. */
  function owns() { return !!document.getElementById('hrRoot'); }

  function skeleton() {
    const el = $('hrCards');
    if (el) el.innerHTML = Array.from({ length: 4 },
      () => '<div class="hr-skeleton"></div>').join('');
  }

  function error() {
    const el = $('hrCards');
    if (el) el.innerHTML = `
      <div class="hr-error">
        <b>We couldn't load hotel availability</b>
        <p>Something went wrong at our end. Please try again in a moment.</p>
        <button type="button" class="hr-btn hr-btn-primary" onclick="location.reload()">Try again</button>
      </div>`;
  }

  /** Called by travel-explore once the catalogue is in hand, and again after
   *  every search. `state` is travel-explore's own — read, never written. */
  /** A stay always has dates by the time a room can be priced.
   *
   *  THE BUG THIS FIXES. Arriving at hotels.html without searching first — a
   *  direct link, the nav bar, a bookmark — left `checkIn`/`checkOut` empty
   *  strings. Everything looked fine until Room Selection, where the quote
   *  POSTs those empties, the server answers 422 ("input is too short"), and
   *  the screen says "We could not price these rooms" with Continue disabled.
   *  The traveller is stranded one step before Payment with no way to tell
   *  that the real problem is two blank dates in the bar above them.
   *
   *  Tomorrow to the day after: the shortest real stay, the default every
   *  hotel site opens on. It is not invented data — it is a starting point,
   *  shown in the search bar and editable there, which is exactly what the
   *  bar's date inputs are for. Anything the traveller actually searched for
   *  is left alone. */
  function ensureStayDates(state) {
    if (!state || (state.checkIn && state.checkOut)) return;
    if (!state.checkIn) state.checkIn = SB_PLUS(1);
    if (!state.checkOut || state.checkOut <= state.checkIn) {
      /* One night after whatever check-in ended up being, so a supplied
         check-in with no check-out is completed rather than overwritten. */
      const after = new Date(state.checkIn);
      after.setDate(after.getDate() + 1);
      state.checkOut = after.toISOString().slice(0, 10);
    }
  }

  function render(allRows, sharedState) {
    rows = Array.isArray(allRows) ? allRows.slice() : [];
    shell = sharedState || {};
    /* Before anything reads the dates — the searchbar, the summary, and the
       quote every downstream screen depends on. */
    ensureStayDates(shell);

    /* The destination narrowing the search panel applied belongs to the
       search, so it is honoured here before the rail's filters run. */
    const dest = String(shell.dest || '').trim().toLowerCase();
    if (dest) {
      rows = rows.filter(h => String(h.location || '').toLowerCase().includes(dest)
                           || String(h.name || '').toLowerCase().includes(dest));
    }

    /* Price bounds and the clamping of a stale ceiling were computed here for
       the hand-built slider. The engine derives both from the rows it is given
       and reconciles any value the URL carried against them. */
    if (selectedId && !rows.some(h => String(h.id) === selectedId)) selectedId = null;

    const shellEl = $('hrRoot');
    if (shellEl) shellEl.hidden = false;
    const bar = $('hrActionbar');
    if (bar) bar.hidden = false;

    /* The criteria bar and the stepper depend on the SEARCH, not on the
       filters, so they are painted once per search rather than in repaint(). */
    const sb = $('hrSearchbar');
    if (sb) sb.innerHTML = searchbarHtml();
    const st = $('hrStepper');
    if (st) st.innerHTML = stepperHtml();
    const heading = $('hrHeading');
    if (heading) heading.textContent = shell.dest ? `Hotels in ${shell.dest}` : 'Hotels';


    /* Started, not awaited: the saved set is a decoration on cards that should
       render at once, and a slow wishlist must not hold the results back.
       Signed out it is a no-op rather than a 401 on every load. */
    if (typeof Wishlist !== 'undefined') {
      Wishlist.init().then(() => Wishlist.refresh());
    }

    /* A stay with no dates cannot be priced, and the flow used to discover
       that four screens later. Filled in here, before anything renders, and
       shown in the editable bar where they can be changed. */
    if (ensureStayDates()) writeStayUrl();
    bindSearchbar();

    /* Before the first paint, so the rail renders already holding whatever the
       URL asked for rather than being corrected a frame later. */
    if (rail()) {
      rail().readParams(name => new URLSearchParams(location.search).get(name));
    }

    bind();
    bindRouter();
    /* route() decides between Results and Details and repaints whichever wins,
       so it replaces the direct repaint() that used to be here. */
    route();

    /* The search panel is a disclosure on this screen — open only when the
       traveller asks for it via Modify Search. */
    const panel = $('txSearchPanel');
    if (panel && !panel.dataset.hrInit) {
      panel.dataset.hrInit = '1';
      panel.hidden = true;
    }

    /* The Explore band's own chrome describes a grid this screen has replaced.
       The whole section is collapsed rather than hidden element by element:
       `hidden` alone did not work, because `.tx-head` sets `display: flex` and
       that beats the user agent's `[hidden] { display: none }` on specificity,
       leaving a 60px ghost heading; with the section's own 56px of padding top
       and bottom that was 230px of empty page between the hero and the search
       bar. Modify Search brings the section back with only the panel in it. */
    const section = document.querySelector('.tx-scope .tx-section');
    if (section) section.classList.add('hr-collapsed');
  }

  /* =====================================================================
     Routing — Results <-> Details, in one page, on real history entries.
     =====================================================================
     The property being viewed lives in the URL (`?hotel=3`) alongside the
     criteria that were already there, which buys three things at once: the
     screen is linkable, a refresh lands back on it, and browser Back returns
     to Results with the search intact rather than leaving the site. Nothing
     is stored in a variable that a reload would lose.
     ===================================================================== */

  /** The current criteria as query parameters — the same names travel-explore's
   *  own `seedFromUrl()` reads, so a reload rebuilds the search from them. */
  function criteriaParams() {
    const q = new URLSearchParams(location.search);
    ['dest', 'checkIn', 'checkOut', 'rooms', 'guests'].forEach(k => {
      const v = shell && shell[k === 'dest' ? 'dest' : k];
      if (v) q.set(k, v); else q.delete(k);
    });
    return q;
  }

  function goToDetails(hotel) {
    const q = criteriaParams();
    q.set('hotel', String(hotel.id));
    history.pushState({ hotel: String(hotel.id) }, '', `${location.pathname}?${q}`);
    route();
  }

  function goToResults() {
    /* Prefer a real Back so the entry this screen pushed is consumed rather
       than stacked — otherwise Back from Results would return to Details. */
    if (history.state && history.state.hotel) { history.back(); return; }
    const q = criteriaParams();
    q.delete('hotel');
    history.replaceState({}, '', `${location.pathname}${q.toString() ? '?' + q : ''}`);
    route();
  }

  function goToGuests(hotel) {
    const q = criteriaParams();
    q.set('hotel', String(hotel.id));
    q.set('step', 'guests');
    history.pushState({ hotel: String(hotel.id), step: 'guests' }, '', `${location.pathname}?${q}`);
    route();
  }

  function goToRooms(hotel) {
    const q = criteriaParams();
    q.set('hotel', String(hotel.id));
    q.set('step', 'rooms');
    history.pushState({ hotel: String(hotel.id), step: 'rooms' }, '', `${location.pathname}?${q}`);
    route();
  }

  /** Show whichever screen the URL names.
   *
   *  Three screens live on this page — Results, Details and Room Selection —
   *  and the URL is the only thing that says which is current. Every one of
   *  them is therefore linkable, survives a refresh, and sits on its own
   *  history entry, which is what makes browser Back walk the journey
   *  backwards instead of leaving the site. */
  function route() {
    const q = new URLSearchParams(location.search);
    const wanted = q.get('hotel');
    const step = q.get('step');
    const hotel = wanted && rows.find(h => String(h.id) === String(wanted));
    const resultsEl = $('hrRoot');

    const hideAll = () => {
      if (typeof HotelDetails !== 'undefined') HotelDetails.hide();
      if (typeof HotelRooms !== 'undefined') HotelRooms.hide();
      if (typeof HotelGuests !== 'undefined') HotelGuests.hide();
      if (typeof HotelReview !== 'undefined') HotelReview.hide();
      if (typeof HotelPayment !== 'undefined') HotelPayment.hide();
      if (typeof HotelConfirm !== 'undefined') HotelConfirm.hide();
    };

    /* The service-page banner — breadcrumb, a second "Hotels" title and a
       duplicate of the service switcher that is already in the header — is
       256px of chrome the approved booking screens do not have. It is
       suppressed on every hotel booking screen (this page only; no other
       service page is touched) and restored nowhere else. */
    document.body.classList.add('hr-booking');

    const ref = q.get('ref');
    if (step === 'confirmation' && ref && typeof HotelConfirm !== 'undefined') {
      if (resultsEl) resultsEl.hidden = true;
      hideAll();
      HotelConfirm.show(ref, {});
      return;
    }

    if (hotel && step === 'payment' && typeof HotelPayment !== 'undefined') {
      /* Payment is only reachable from Review, because it needs the accepted
         quote. Without it the traveller is sent back to Review rather than
         shown a payment screen for a price nobody has agreed. */
      if (!pendingPayment) { goToReview(hotel); return; }
      selectedId = String(hotel.id);
      if (resultsEl) resultsEl.hidden = true;
      if (typeof HotelDetails !== 'undefined') HotelDetails.hide();
      if (typeof HotelRooms !== 'undefined') HotelRooms.hide();
      if (typeof HotelGuests !== 'undefined') HotelGuests.hide();
      if (typeof HotelReview !== 'undefined') HotelReview.hide();
      HotelPayment.show(hotel, shell, {
        back: () => history.back(),
        done: booking => openConfirmation(hotel, booking),
        /* An already-submitted stay routes to its confirmation rather than
           being submitted again. */
        viewBooking: ref => openConfirmation(hotel, { id: ref }),
      }, pendingPayment);
      return;
    }

    if (hotel && step === 'review' && typeof HotelReview !== 'undefined') {
      const picks = (typeof HotelRooms !== 'undefined') ? HotelRooms.selections().filter(Boolean) : [];
      const guestData = (typeof HotelGuests !== 'undefined') ? HotelGuests.payload() : null;
      /* Review needs both the rooms and the party; without either there is
         nothing to review, so the traveller is returned to the step that
         supplies what is missing rather than shown an empty summary. */
      if (picks.length !== roomCount()) { goToRooms(hotel); return; }
      if (!guestData || !guestData.party || !guestData.party.length) { goToGuests(hotel); return; }

      selectedId = String(hotel.id);
      if (resultsEl) resultsEl.hidden = true;
      if (typeof HotelDetails !== 'undefined') HotelDetails.hide();
      if (typeof HotelRooms !== 'undefined') HotelRooms.hide();
      if (typeof HotelGuests !== 'undefined') HotelGuests.hide();
      HotelReview.show(hotel, shell, {
        back: () => history.back(),
        edit: which => { if (which === 'rooms') goToRooms(hotel); else goToGuests(hotel); },
        payment: data => openPayment(hotel, Object.assign({ guestData }, data)),
      }, picks, guestData);
      return;
    }

    if (hotel && step === 'guests' && typeof HotelGuests !== 'undefined') {
      /* Guest Details is only reachable once every room has been chosen —
         the party is built from the room selections, so without them there is
         nothing to ask about. Arriving here directly (a stale link, a
         refresh) sends the traveller to Room Selection rather than showing an
         empty form. */
      const picks = (typeof HotelRooms !== 'undefined') ? HotelRooms.selections().filter(Boolean) : [];
      if (picks.length !== roomCount()) { goToRooms(hotel); return; }

      selectedId = String(hotel.id);
      if (resultsEl) resultsEl.hidden = true;
      if (typeof HotelDetails !== 'undefined') HotelDetails.hide();
      if (typeof HotelRooms !== 'undefined') HotelRooms.hide();
      HotelGuests.show(hotel, shell, {
        back: () => history.back(),
        review: () => goToReview(hotel),
      }, picks, HotelGuests.state());
      return;
    }

    if (hotel && step === 'rooms' && typeof HotelRooms !== 'undefined') {
      selectedId = String(hotel.id);
      if (resultsEl) resultsEl.hidden = true;
      if (typeof HotelDetails !== 'undefined') HotelDetails.hide();
      if (typeof HotelGuests !== 'undefined') HotelGuests.hide();
      HotelRooms.show(hotel, shell, {
        back: () => history.back(),
        guests: () => goToGuests(hotel),
      });
      return;
    }

    if (hotel && typeof HotelDetails !== 'undefined') {
      selectedId = String(hotel.id);
      if (resultsEl) resultsEl.hidden = true;
      if (typeof HotelRooms !== 'undefined') HotelRooms.hide();
      HotelDetails.show(hotel, shell, {
        back: goToResults,
        rooms: () => goToRooms(hotel),
      });
      return;
    }

    hideAll();
    if (resultsEl) resultsEl.hidden = false;
    repaint();
  }

  function goToReview(hotel) {
    const q = criteriaParams();
    q.set('hotel', String(hotel.id));
    q.set('step', 'review');
    history.pushState({ hotel: String(hotel.id), step: 'review' }, '', `${location.pathname}?${q}`);
    route();
  }

  /** What Review accepted, held for the Payment screen. Deliberately NOT in
   *  the URL: a quote is a server answer with a lifetime, not a bookmarkable
   *  criterion, and a refreshed Payment screen must re-derive it from Review
   *  rather than trust a number pasted into an address bar. */
  let pendingPayment = null;

  function openPayment(hotel, data) {
    pendingPayment = {
      picks: data.picks,
      guestData: data.guestData || {},
      addons: data.addons || [],
      couponCode: data.couponCode || null,
      quote: data.quote || null,
    };
    const q = criteriaParams();
    q.set('hotel', String(hotel.id));
    q.set('step', 'payment');
    history.pushState({ hotel: String(hotel.id), step: 'payment' }, '', `${location.pathname}?${q}`);
    route();
  }

  /** The booking exists now. Its reference goes in the URL and the
   *  confirmation screen re-reads it from the server — nothing about the
   *  booking is carried in memory, so a refresh on this screen is correct. */
  function openConfirmation(hotel, booking) {
    const q = criteriaParams();
    q.set('hotel', String(hotel.id));
    q.set('step', 'confirmation');
    q.set('ref', String(booking.id || booking.booking_ref || ''));
    history.pushState({ step: 'confirmation' }, '', `${location.pathname}?${q}`);
    route();
  }


  /* The editable search bar. Delegated on DOCUMENT rather than on #hrRoot,
     because the same bar is rendered into six different screens' own chrome
     containers and each of them repaints it. */
  let sbBound = false;
  function bindSearchbar() {
    if (sbBound) return;
    sbBound = true;
    document.addEventListener('change', e => {
      const f = e.target.closest('[data-hr-sb]');
      if (!f) return;
      applySearchField(f.dataset.hrSb, f.value);
    });
  }

  let routeBound = false;
  function bindRouter() {
    if (routeBound) return;
    routeBound = true;
    window.addEventListener('popstate', () => {
      if (!rows.length) return;
      /* A history entry carries the filters and the sort as well as which
         screen was open, so both are re-read before anything repaints. Cleared
         first: readParams only ASSIGNS what the URL names, so a facet absent
         from this entry would otherwise survive from the last one. */
      if (rail()) {
        rail().clear();
        rail().sort = rail().DEFAULT_SORT;
        rail().readParams(name => new URLSearchParams(location.search).get(name));
        rail().setRows(rows);
        paintSortOptions();
      }
      route();
    });
  }

  /* ---------------------------------------------------------------------
     The sort menu

     Written from the data rather than a fixed list, so a sort is offered only
     when the rows can answer it — "Guest Rating" disappears on a route where
     nothing carries one, and "Highest discount" stays absent until the API
     sends an original price to discount from.
     --------------------------------------------------------------------- */
  function paintSortOptions() {
    const sel = $('hrSort');
    if (!sel || !rail()) return;
    const opts = rail().availableSorts();
    if (!opts.some(o => o.id === rail().sort)) rail().sort = rail().DEFAULT_SORT;
    sel.innerHTML = opts.map(o =>
      `<option value="${esc(o.id)}"${o.id === rail().sort ? ' selected' : ''}>${esc(o.label)}</option>`
    ).join('');
  }

  /* ---------------------------------------------------------------------
     URL state

     The filters and the sort join the criteria already in the address bar, so
     a result set can be shared, survives a refresh, and Back undoes one
     deliberate act rather than the whole search. `h_`-namespaced by the engine,
     so they cannot collide with `hotel`/`step`, which this screen's router owns.
     --------------------------------------------------------------------- */
  function writeUrl(push) {
    if (!rail()) return;
    const q = new URLSearchParams(location.search);
    const params = {};
    rail().writeParams(params);
    /* Drop every h_* the engine did not just set — a facet that has been
       unticked has to leave the URL, not linger. */
    [...q.keys()].forEach(k => { if (k.startsWith('h_')) q.delete(k); });
    Object.entries(params).forEach(([k, v]) => {
      if (v !== '' && v != null) q.set(k, v);
    });
    const url = `${location.pathname}?${q.toString()}`;
    if (url === location.pathname + location.search) return;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  return {
    owns, render, skeleton, error, route, TAX_RATE, icon,
    /* Shared chrome, so Hotel Details renders the same criteria bar and the
       same stepper instead of a near-copy. */
    searchbarHtml, stepperHtml, modifySearch,
    /* So a screen entered directly by URL — Rooms, say, after a refresh — gets
       the same date guarantee the Results screen applies on entry. */
    ensureStayDates, writeStayUrl,
  };
})();
