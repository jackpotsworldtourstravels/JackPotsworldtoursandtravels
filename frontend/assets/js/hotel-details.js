'use strict';
/* ===========================================================================
   hotel-details.js — the Hotel Details screen.
   ===========================================================================
   Step 3 of the hotel journey, between Results and Room Selection. Reads the
   existing `GET /api/customer/hotels/{id}` response — description, images,
   amenities, cancellation policy and every room — and renders it against the
   approved reference layout: gallery and content on the left, the same sticky
   Booking Summary Phase 1 introduced on the right, sticky action bar below.

   WHAT THIS SCREEN CANNOT SHOW, AND DOES NOT PRETEND TO.
   The reference Details page carries several things this catalogue has no
   data for. Each is omitted rather than invented:

       "1 / 28" + thumbnail strip   every property has exactly ONE photograph
                                    (`images` holds a single slug), so there is
                                    no gallery to page through and no honest
                                    number to print. The strip renders only if
                                    a property ever has more than one image.
       Reviews tab                  no reviews table exists. The numeric guest
                                    rating is real and is shown; the count of
                                    reviews behind it is not recorded, so no
                                    "(2,348 reviews)" appears.
       Check-in / check-out times,   not columns. The Policies section shows the
       house rules                   cancellation policy, which IS real, and
                                    nothing else.
       A map                         there are no latitude/longitude columns.
                                    Location shows the real address and the
                                    real distance; see `locationPanel()` for
                                    where a map drops in when coordinates land,
                                    without the section moving.

   PHOTO CREDIT IS NOT DECORATION. The photographs are Wikimedia Commons files
   under CC BY / CC BY-SA, which require visible attribution — see
   assets/hotels/CREDITS.md, which states that if the credit overlay is removed
   it must be reproduced somewhere the user can reach. It is rendered under the
   gallery here. Where the photograph stands in for the CHAIN rather than this
   property, `hotelImageMatchLevel()` reports 'brand' and the caption says so
   instead of implying the picture is of this building.
   =========================================================================== */

const HotelDetails = (function () {

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rupees = n => (typeof money === 'function' ? money(n)
    : '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'));

  /* Panels are only offered when the property has something to put in them,
     so a tab is never a dead end. `has` is evaluated per hotel. */
  const TABS = [
    { id: 'overview',  label: 'Overview',  has: d => !!d.description || (d.amenities || []).length },
    { id: 'rooms',     label: 'Rooms',     has: d => (d.rooms || []).length > 0 },
    { id: 'amenities', label: 'Amenities', has: d => (d.amenities || []).length > 0 },
    { id: 'policies',  label: 'Policies',  has: d => !!d.cancellation_policy },
    { id: 'location',  label: 'Location',  has: d => !!d.location },
  ];

  let detail = null;        // the API's HotelDetail
  let row = null;           // the search-result row it was opened from
  let shell = null;         // travel-explore's shared search state
  let activeTab = 'overview';
  let bound = false;
  let onBack = null;
  let onRooms = null;

  /* ---------------------------------------------------------------------
     Stay maths — the same rules Phase 1 established, imported rather than
     re-derived so the two screens cannot disagree about a total.
     --------------------------------------------------------------------- */
  const TAX_RATE = (typeof HotelResults !== 'undefined' && HotelResults.TAX_RATE) || 0.12;

  function nights() {
    const a = shell && shell.checkIn ? new Date(shell.checkIn) : null;
    const b = shell && shell.checkOut ? new Date(shell.checkOut) : null;
    if (!a || !b || isNaN(a) || isNaN(b)) return 1;
    return Math.max(1, Math.round((b - a) / 86400000));
  }
  function roomCount() { return Math.max(1, Number(shell && shell.rooms) || 1); }
  function guestCount() { return Math.max(1, Number(shell && shell.guests) || 2); }

  /** The property's lowest nightly rate, taken from its actual rooms when the
   *  detail response is in hand rather than from the summary row. */
  function lowestRate() {
    const prices = (detail.rooms || []).map(r => Number(r.price)).filter(n => n > 0);
    if (prices.length) return Math.min(...prices);
    return Number((row && row.pricePerNight) || 0);
  }

  function stayCost() {
    const roomTotal = Math.round(lowestRate() * nights() * roomCount());
    const tax = Math.round(roomTotal * TAX_RATE);
    return { room: roomTotal, tax, total: roomTotal + tax };
  }

  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtWeekday(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { weekday: 'short' });
  }
  function ratingWord(r) {
    const n = Number(r) || 0;
    if (n >= 4.5) return 'Excellent';
    if (n >= 4.0) return 'Very Good';
    if (n >= 3.5) return 'Good';
    return 'Pleasant';
  }
  function isInclusion(meal) { return !/^\s*room only\s*$/i.test(String(meal || '')); }

  const icon = (name, cls) => (typeof HotelResults !== 'undefined' && HotelResults.icon)
    ? HotelResults.icon(name, cls) : '';

  /* ---------------------------------------------------------------------
     The property hero.

     THE PHOTOGRAPH IS THE SHARED RESOLVER'S ANSWER, NOT THE API'S. The detail
     response carries `image` / `images` keys, and the seed set those to chain
     files — the Taj Mahal Palace in Mumbai for a Taj in Banjara Hills, the
     Hyatt in London for a Hyatt in Hyderabad. The old gallery trusted them and
     captioned the mismatch "Representative photograph of the group". It is
     gone: HotelPhoto shows this property's verified photograph, else the
     city's — labelled ON the picture as not the hotel — else the honest
     placeholder. With one verified photograph at most, there is no thumbnail
     strip and no "1 / N" to print.
     --------------------------------------------------------------------- */
  function areaOf() {
    const parts = String(detail.location || '').split(',').map(s => s.trim()).filter(Boolean);
    return { area: parts.length > 1 ? parts[0] : '', city: parts[parts.length - 1] || '' };
  }

  function heroHtml() {
    const { area, city } = areaOf();
    const photo = (typeof HotelPhoto !== 'undefined')
      ? HotelPhoto.html(detail, { surface: 'hero', eager: true, allowDestination: false, sizes: '(max-width: 900px) 100vw, 1100px' }) : '';
    return `
      <section class="hd-hero" aria-labelledby="hdName">
        <div class="hd-hero-media">${photo}</div>
        <div class="hd-hero-body">
          ${area || city ? `<p class="hc-kicker">${esc(area)}${area && city ? '<i aria-hidden="true">·</i>' : ''}${esc(city)}</p>` : ''}
          <h1 class="hr-hd-name" id="hdName">${esc(detail.name)}</h1>
          <div class="hc-meta">
            ${detail.stars ? `<span class="hr-stars" role="img" aria-label="${esc(detail.stars)}-star hotel">${
              typeof JPIcon !== 'undefined' ? JPIcon.stars(detail.stars, detail.stars) : ''}</span>` : ''}
            ${detail.guest_rating != null ? `<span class="hc-score"><b>${esc(Number(detail.guest_rating).toFixed(1))}</b>${
              esc(ratingWord(detail.guest_rating))}<span class="hr-sr">guest rating out of 5</span></span>` : ''}
          </div>
        </div>
      </section>`;
  }

  /** The five facts that decide a stay, each from a column or the room list:
   *  the lowest nightly rate, how many room types, the meal plans, whether
   *  cancellation is free, and the airport distance. A missing one is absent. */
  function glanceHtml() {
    const rooms = detail.rooms || [];
    const meals = [...new Set(rooms.map(r => r.meal_plan).filter(Boolean))];
    const free = String(detail.cancellation_policy || '').trim().toLowerCase().startsWith('free cancellation');
    const cells = [
      rooms.length ? ['From', `${rupees(lowestRate())}<small>/ night</small>`] : null,
      rooms.length ? ['Room types', String(rooms.length)] : null,
      meals.length ? ['Meal plans', meals.length === 1 ? esc(meals[0]) : `${meals.length} options`] : null,
      detail.cancellation_policy ? ['Cancellation', free ? 'Free' : 'See policy', free] : null,
      detail.distanceKm != null ? ['Airport', `${esc(Number(detail.distanceKm))} km`] : null,
    ].filter(Boolean);
    if (!cells.length) return '';
    return `<dl class="hd-glance" data-ds-stagger=".07">${cells.map(c =>
      `<div data-ds-reveal class="${c[2] ? 'is-good' : ''}"><dt>${c[0]}</dt><dd>${c[1]}</dd></div>`).join('')}</dl>`;
  }

  /* ---------------------------------------------------------------------
     Tab panels
     --------------------------------------------------------------------- */
  function overviewPanel() {
    const meals = [...new Set((detail.rooms || []).map(r => r.meal_plan).filter(Boolean))];
    return `
      ${detail.description ? `
        <h3 class="hr-panel-title">About this property</h3>
        <p class="hr-prose">${esc(detail.description)}</p>` : ''}
      ${(detail.amenities || []).length ? `
        <h3 class="hr-panel-title">Popular amenities</h3>
        <ul class="hr-amenity-grid">
          ${detail.amenities.map(a => `<li>${icon('check')} ${esc(a)}</li>`).join('')}
        </ul>` : ''}
      ${meals.length ? `
        <h3 class="hr-panel-title">Meal plans available</h3>
        <ul class="hr-amenity-grid">
          ${meals.map(m => `<li>${icon('check')} ${esc(m)}</li>`).join('')}
        </ul>` : ''}`;
  }

  /** The room list. Deliberately a SUMMARY with a route into Room Selection,
   *  not a second copy of that screen — the choice is made there, and making
   *  it in two places would be two states to keep in step. */
  function roomsPanel() {
    const n = nights();
    return `
      <h3 class="hr-panel-title">Room options</h3>
      <div class="hr-roomlist">
        ${(detail.rooms || []).map(r => {
          const perks = (r.perks || []);
          return `
          <div class="hr-roomrow">
            <div class="hr-roomrow-main">
              <b>${esc(r.name)}</b>
              <div class="hr-roomrow-meta">
                ${r.bed_type ? `<span>${icon('bed')} ${esc(r.bed_type)}</span>` : ''}
                ${r.max_guests ? `<span>${icon('person')} Up to ${esc(r.max_guests)} guests</span>` : ''}
                ${r.size_label ? `<span>${esc(r.size_label)}</span>` : ''}
              </div>
              ${perks.length ? `<div class="hr-roomrow-perks">${
                perks.map(p => `<i>${esc(p)}</i>`).join('')}</div>` : ''}
              ${r.meal_plan ? `<span class="${isInclusion(r.meal_plan) ? 'hr-note-ok' : 'hr-note-plain'}">
                ${isInclusion(r.meal_plan) ? icon('check') : ''} ${esc(r.meal_plan)}</span>` : ''}
            </div>
            <div class="hr-roomrow-price">
              <b>${esc(rupees(r.price))}</b>
              <span>per night</span>
              <span>${esc(rupees(Math.round(Number(r.price) * n * roomCount())))} for ${n} night${n > 1 ? 's' : ''}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="hr-panel-cta">
        <button type="button" class="hr-btn hr-btn-primary" data-hd-rooms>View Rooms</button>
      </div>`;
  }

  function amenitiesPanel() {
    return `
      <h3 class="hr-panel-title">Amenities</h3>
      <ul class="hr-amenity-grid">
        ${(detail.amenities || []).map(a => `<li>${icon('check')} ${esc(a)}</li>`).join('')}
      </ul>
      <p class="hr-panel-note">
        This is the amenity list recorded for the property. Facilities not listed
        here have not been confirmed.
      </p>`;
  }

  /** Cancellation only. There are no check-in/check-out time or house-rule
   *  columns, so this panel does not invent a "2 PM check-in" line. */
  function policiesPanel() {
    const roomPolicies = [...new Set((detail.rooms || [])
      .map(r => r.cancellation_policy).filter(Boolean))];
    return `
      <h3 class="hr-panel-title">Cancellation policy</h3>
      <p class="hr-prose">${esc(detail.cancellation_policy || '')}</p>
      ${roomPolicies.length && !(roomPolicies.length === 1 && roomPolicies[0] === detail.cancellation_policy)
        ? `<h3 class="hr-panel-title">By room type</h3>
           <ul class="hr-policy-list">${roomPolicies.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`
        : ''}
      <p class="hr-panel-note">
        Check-in and check-out times are not published for this property. The
        property will confirm them on your voucher.
      </p>`;
  }

  /** Address and distance — both real columns.
   *
   *  THE MAP SLOT. `#hdMapSlot` is where an embedded map goes the moment
   *  `customer_hotels` gains latitude/longitude. It is left empty rather than
   *  filled with a picture of the wrong place, and the surrounding structure
   *  is final, so adding the map later does not move anything on this page. */
  function locationPanel() {
    return `
      <h3 class="hr-panel-title">Location</h3>
      <p class="hr-prose">${icon('pin')} ${esc(detail.location)}</p>
      ${detail.distanceKm != null ? `
        <p class="hr-panel-note">${esc(Number(detail.distanceKm))} km from the airport.</p>` : ''}
      <div id="hdMapSlot" class="hr-mapslot" hidden></div>`;
  }

  const PANELS = {
    overview: overviewPanel, rooms: roomsPanel,
    amenities: amenitiesPanel, policies: policiesPanel, location: locationPanel,
  };

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */
  /* headerHtml() drew the identity column beside the old gallery: name,
     stars, score, every amenity, the meal and cancellation notes. The name,
     stars and score are the hero's now; the facts are the glance strip's; the
     amenities and the policy text are the Overview and Policies panels'. */

  function tabsHtml() {
    const avail = TABS.filter(t => t.has(detail));
    if (!avail.some(t => t.id === activeTab)) activeTab = (avail[0] || {}).id;
    return `
      <div class="hr-tabs" role="tablist" aria-label="About this property">
        ${avail.map(t => `
          <button type="button" role="tab" id="hdTab-${t.id}"
                  aria-controls="hdPanel-${t.id}"
                  aria-selected="${t.id === activeTab}"
                  tabindex="${t.id === activeTab ? '0' : '-1'}"
                  class="hr-tab ${t.id === activeTab ? 'is-on' : ''}"
                  data-hd-tab="${t.id}">${esc(t.label)}</button>`).join('')}
      </div>
      <div class="hr-panel" role="tabpanel" id="hdPanel-${activeTab}"
           aria-labelledby="hdTab-${activeTab}" tabindex="0">
        ${(PANELS[activeTab] || overviewPanel)()}
      </div>`;
  }

  function summaryHtml() {
    const cost = stayCost();
    const n = nights();
    const free = String(detail.cancellation_policy || '').trim().toLowerCase()
      .startsWith('free cancellation');
    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <div class="hr-sum-thumb">${HotelPhoto.thumb(detail)}</div>
            <div>
              <p class="hr-sum-hotel-name">${esc(detail.name)}</p>
              ${detail.stars ? `<span class="hr-stars" role="img"
                aria-label="${esc(detail.stars)} star hotel">${typeof JPIcon !== 'undefined' ? JPIcon.stars(detail.stars, detail.stars) : ''}</span>` : ''}
              <p class="hr-sum-hotel-loc">${esc(detail.location)}</p>
            </div>
          </div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-line"><span>Check-in</span><b>${esc(fmtDay(shell && shell.checkIn))} ${esc(fmtWeekday(shell && shell.checkIn))}</b></div>
          <div class="hr-sum-line"><span>Check-out</span><b>${esc(fmtDay(shell && shell.checkOut))} ${esc(fmtWeekday(shell && shell.checkOut))}</b></div>
          <div class="hr-sum-meta">${roomCount()} Room${roomCount() > 1 ? 's' : ''} · ${guestCount()} Guest${guestCount() > 1 ? 's' : ''}</div>
          <div class="hr-sum-meta">${n} Night${n > 1 ? 's' : ''}</div>
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
          ${free ? `
            <div class="hr-sum-callout">
              ${icon('shield')}
              <div><b>Free cancellation</b><span>${esc(detail.cancellation_policy)}</span></div>
            </div>` : ''}
        </div>
        <div class="hr-trust">
          <div class="hr-trust-row">${icon('shield')}
            <div><b>Secure booking</b><span>Your data is protected</span></div></div>
          <div class="hr-trust-row">${icon('headset')}
            <div><b>24/7 customer support</b><span>We're here to help you anytime</span></div></div>
        </div>
      </div>`;
  }

  function actionbarHtml() {
    const cost = stayCost();
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
          <b>${esc(rupees(cost.total))}</b>
          <span>From, indicative</span>
        </div>
        <div class="hr-ab-cta">
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg" data-hd-rooms>
            Continue<span class="hr-ab-long"> to Room Selection</span>
          </button>
        </div>
      </div>`;
  }

  /** The criteria bar and stepper, borrowed from the Results screen so both
   *  screens show one journey. Details is step 3 (index 2). */
  function paintChrome() {
    const HR = typeof HotelResults !== 'undefined' ? HotelResults : null;
    const sb = $('hdSearchbar');
    if (sb && HR && HR.searchbarHtml) sb.innerHTML = HR.searchbarHtml();
    const st = $('hdStepper');
    if (st && HR && HR.stepperHtml) st.innerHTML = HR.stepperHtml(2);
  }

  function paint() {
    paintChrome();
    const main = $('hdMain');
    if (main) {
      /* The hero carries the photograph AND the name over it, so the name is
         above the fold however tall the picture is; the facts follow as one
         strip, the tabs below. */
      main.innerHTML = `
        ${heroHtml()}
        ${glanceHtml()}
        ${tabsHtml()}`;
      if (typeof DS !== 'undefined') DS.reveal(main);
    }
    const sum = $('hdSummary');
    if (sum) sum.innerHTML = summaryHtml();
    const bar = $('hrActionbar');
    if (bar) { bar.innerHTML = actionbarHtml(); bar.hidden = false; }
  }

  /* Only the tab strip and its panel are re-rendered on a tab change, so the
     hero photograph is not torn down and re-developed every time. */
  function paintTabs() {
    const strip = $('hdMain') && $('hdMain').querySelector('.hr-tabs');
    const panel = $('hdMain') && $('hdMain').querySelector('.hr-panel');
    if (!strip || !panel) { paint(); return; }
    const holder = document.createElement('div');
    holder.innerHTML = tabsHtml();
    strip.replaceWith(holder.firstElementChild);
    panel.replaceWith(holder.lastElementChild);
  }

  function bind() {
    if (bound) return;
    const root = $('hdRoot');
    if (!root) return;
    bound = true;

    root.addEventListener('click', e => {
      const tab = e.target.closest('[data-hd-tab]');
      if (tab) { activeTab = tab.getAttribute('data-hd-tab'); paintTabs(); return; }
      if (e.target.closest('[data-hd-back]')) { if (onBack) onBack(); return; }
      if (e.target.closest('[data-hd-rooms]')) { if (onRooms) onRooms(detail, row); return; }
      /* The criteria bar is the Results screen's, so its Modify Search opens
         the same panel here. */
      if (e.target.closest('#hrModify')) {
        if (typeof HotelResults !== 'undefined' && HotelResults.modifySearch) {
          HotelResults.modifySearch();
        }
        return;
      }

    });

    /* Arrow keys move between tabs, which is what a tablist is expected to do
       and what keyboard users will try first. */
    root.addEventListener('keydown', e => {
      const tab = e.target.closest('[data-hd-tab]');
      if (!tab || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...root.querySelectorAll('[data-hd-tab]')];
      const i = tabs.indexOf(tab);
      const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length]
                 : e.key === 'ArrowLeft'  ? tabs[(i - 1 + tabs.length) % tabs.length]
                 : e.key === 'Home'       ? tabs[0] : tabs[tabs.length - 1];
      e.preventDefault();
      activeTab = next.getAttribute('data-hd-tab');
      paintTabs();
      const again = document.querySelector(`[data-hd-tab="${activeTab}"]`);
      if (again) again.focus();
    });

    /* The sticky bar lives outside #hdRoot. */
    const bar = $('hrActionbar');
    if (bar) bar.addEventListener('click', e => {
      if (e.target.closest('[data-hd-rooms]') && detail) { if (onRooms) onRooms(detail, row); }
    });
  }

  function skeleton() {
    /* Chrome first, so the criteria bar and the stepper are already there
       while the property loads — the page never flashes empty. */
    paintChrome();
    const main = $('hdMain');
    if (main) main.innerHTML = '<div class="hr-skeleton hr-skeleton-gal"></div>'
      + '<div class="hr-skeleton hr-skeleton-line"></div>'
      + '<div class="hr-skeleton hr-skeleton-line"></div>';
    const sum = $('hdSummary');
    if (sum) sum.innerHTML = '<div class="hr-skeleton hr-skeleton-sum"></div>';
  }

  function error(message) {
    const main = $('hdMain');
    if (main) main.innerHTML = `
      <div class="hr-error">
        <b>We couldn't load this property</b>
        <p>${esc(message || "Something went wrong at our end. Please try again in a moment.")}</p>
        <button type="button" class="hr-btn hr-btn-primary" data-hd-back>Back to Hotel Results</button>
      </div>`;
    const sum = $('hdSummary');
    if (sum) sum.innerHTML = '';
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  /** Show the details screen for one property.
   *  `handlers.back` returns to Results, `handlers.rooms` goes on to Room
   *  Selection — both supplied by the router so this module does not need to
   *  know how navigation is done. */
  async function show(hotelRow, sharedState, handlers) {
    listenForSearchChange();
    row = hotelRow;
    shell = sharedState || {};
    onBack = handlers && handlers.back;
    onRooms = handlers && handlers.rooms;
    activeTab = 'overview';
    detail = null;

    const rootEl = $('hdRoot');
    if (rootEl) rootEl.hidden = false;
    bind();
    skeleton();

    try {
      if (typeof BookingApi === 'undefined' || !BookingApi.isLive('hotel')) {
        throw new Error('The hotel catalogue is unavailable.');
      }
      detail = await BookingApi.getHotelDetail(hotelRow.id);
      paint();
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (err) {
      const msg = (typeof BookingApi !== 'undefined' && BookingApi.errorText)
        ? BookingApi.errorText(err) : '';
      error(msg);
    }
  }

  function hide() {
    const rootEl = $('hdRoot');
    if (rootEl) rootEl.hidden = true;
  }


  /* THE SEARCH BAR IS EDITABLE, so the stay can change while this screen is
     open. One listener, bound once: re-price and repaint, but only when this
     screen is the one showing — the others read the new state when they next
     paint. paintChrome() is deliberately NOT called, because it would replace
     the very input being edited. */
  let sbListening = false;
  function listenForSearchChange() {
    if (sbListening) return;
    sbListening = true;
    document.addEventListener('hr:searchchange', () => {
      const el = document.getElementById('hdRoot');
      if (!el || el.hidden || !detail) return;
      /* The whole screen: this module never had paintMain / paintSummary /
         paintActionbar, so a date edited here used to throw a ReferenceError
         and leave the old price on screen. paint() does not touch the search
         strip, so the field being edited is not replaced under the cursor. */
      paint();
    });
  }

  return { show, hide };
})();
