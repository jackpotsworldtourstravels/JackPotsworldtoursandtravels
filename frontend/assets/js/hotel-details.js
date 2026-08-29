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
     Images
     --------------------------------------------------------------------- */
  /** Every slug this property has a real file for. `images` is the source of
   *  truth; `image` is the primary and is included even if `images` is empty,
   *  so a property with only the one key still gets its photograph. */
  function slugs() {
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
    const all = [];
    const push = s => { if (s && known[s] && !all.includes(s)) all.push(s); };
    push(detail.image);
    (detail.images || []).forEach(push);
    if (!all.length) {
      all.push(typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');
    }
    return all;
  }

  function imgTag(slug, cls, eager) {
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    return `<img class="${cls || ''}" src="${esc(dir + slug + '.webp')}"
      srcset="${esc(dir + slug + '-480.webp')} 480w, ${esc(dir + slug + '.webp')} 1024w"
      sizes="(max-width: 900px) 96vw, 620px"
      alt="${esc(detail.name)}"
      ${eager ? '' : 'loading="lazy"'} decoding="async"
      onerror="this.closest('.hr-gal-frame')?.classList.add('is-broken'); this.remove();">`;
  }

  /** The attribution line. Required by the photographs' licences, and honest
   *  about whether the picture is of this property or of the chain. */
  function creditHtml(slug) {
    const credits = typeof HOTEL_IMAGE_CREDITS !== 'undefined' ? HOTEL_IMAGE_CREDITS : {};
    const c = credits[slug];
    const level = (typeof hotelImageMatchLevel === 'function')
      ? hotelImageMatchLevel(slug, 'property') : 'property';

    const standIn = level === 'brand'
      ? `<span class="hr-gal-standin">Representative photograph of the ${esc(brandWord())} group — not this property.</span>`
      : '';
    if (!c) return standIn;
    return `${standIn}<span class="hr-gal-credit">Photo: ${esc(c.artist)} · ${esc(c.licence)}
      ${c.source ? `<a href="${esc(c.source)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</span>`;
  }

  function brandWord() {
    return String(detail.name || '').split(/\s+/)[0] || 'hotel';
  }

  function galleryHtml() {
    const all = slugs();
    const primary = all[0];
    return `
      <figure class="hr-gallery">
        <div class="hr-gal-frame" data-gal-main>
          ${imgTag(primary, 'hr-gal-img', true)}
          <span class="hr-gal-broken">Photograph unavailable</span>
        </div>
        ${all.length > 1 ? `
          <div class="hr-gal-thumbs" role="group" aria-label="Photographs of ${esc(detail.name)}">
            ${all.map((s, i) => `
              <button type="button" class="hr-gal-thumb ${i === 0 ? 'is-on' : ''}"
                      data-gal-pick="${esc(s)}" aria-pressed="${i === 0}"
                      aria-label="Show photograph ${i + 1} of ${all.length}">
                ${imgTag(s, '')}
              </button>`).join('')}
          </div>
          <span class="hr-gal-count">1 / ${all.length}</span>` : ''}
        <figcaption class="hr-gal-cap">${creditHtml(primary)}</figcaption>
      </figure>`;
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
        <p class="hr-panel-note">${esc(detail.distanceKm)} km from the airport.</p>` : ''}
      <div id="hdMapSlot" class="hr-mapslot" hidden></div>`;
  }

  const PANELS = {
    overview: overviewPanel, rooms: roomsPanel,
    amenities: amenitiesPanel, policies: policiesPanel, location: locationPanel,
  };

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */
  function headerHtml() {
    const meals = [...new Set((detail.rooms || []).map(r => r.meal_plan).filter(Boolean))]
      .filter(isInclusion);
    const free = String(detail.cancellation_policy || '').trim().toLowerCase()
      .startsWith('free cancellation');
    return `
      <div class="hr-hd-head">
        <div class="hr-name-row">
          <h1 class="hr-hd-name">${esc(detail.name)}</h1>
          ${detail.stars ? `<span class="hr-stars" role="img"
            aria-label="${esc(detail.stars)} star hotel">${'★'.repeat(detail.stars)}</span>` : ''}
        </div>
        <p class="hr-loc">${icon('pin')} ${esc(detail.location)}
          ${detail.distanceKm != null
            ? `<span class="hr-dot">·</span> ${esc(detail.distanceKm)} km from airport` : ''}</p>
        ${detail.guest_rating != null ? `
          <div class="hr-rating-row">
            <span class="hr-rating">${esc(Number(detail.guest_rating).toFixed(1))}</span>
            <span class="hr-rating-word">${esc(ratingWord(detail.guest_rating))}</span>
          </div>` : ''}
        ${(detail.amenities || []).length ? `
          <div class="hr-amenities">${detail.amenities.map(a =>
            `<span class="hr-amenity">${icon('check')} ${esc(a)}</span>`).join('')}</div>` : ''}
        <div class="hr-notes">
          ${meals.length ? `<span class="hr-note-ok">${icon('check')} ${esc(meals[0])}</span>` : ''}
          ${free ? `<span class="hr-note-ok">${icon('check')} Free cancellation</span>` : ''}
          ${detail.cancellation_policy
            ? `<span class="hr-note-plain">${esc(detail.cancellation_policy)}</span>` : ''}
        </div>
      </div>`;
  }

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
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    const free = String(detail.cancellation_policy || '').trim().toLowerCase()
      .startsWith('free cancellation');
    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <img class="hr-sum-thumb" src="${esc(dir + slugs()[0] + '-480.webp')}" alt="" loading="lazy">
            <div>
              <p class="hr-sum-hotel-name">${esc(detail.name)}</p>
              ${detail.stars ? `<span class="hr-stars" role="img"
                aria-label="${esc(detail.stars)} star hotel">${'★'.repeat(detail.stars)}</span>` : ''}
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
            Continue to Room Selection
          </button>
          <span>You can choose your room next</span>
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
      /* Gallery and identity sit SIDE BY SIDE, as they do in the reference —
         stacking them put a 571px-tall photograph above the fold and pushed
         the hotel's own name off it. The tabs span the full width below. */
      main.innerHTML = `
        <button type="button" class="hr-backlink" data-hd-back>
          ${icon('chevron', 'hr-back-ico')} Back to Hotel Results
        </button>
        <div class="hr-hd-hero">
          ${galleryHtml()}
          ${headerHtml()}
        </div>
        ${tabsHtml()}`;
    }
    const sum = $('hdSummary');
    if (sum) sum.innerHTML = summaryHtml();
    const bar = $('hrActionbar');
    if (bar) { bar.innerHTML = actionbarHtml(); bar.hidden = false; }
  }

  /* Only the tab strip and its panel are re-rendered on a tab change, so the
     gallery is not torn down and re-decoded every time. */
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

      const pick = e.target.closest('[data-gal-pick]');
      if (pick) {
        const slug = pick.getAttribute('data-gal-pick');
        const frame = root.querySelector('[data-gal-main]');
        const all = slugs();
        if (frame) {
          frame.classList.remove('is-broken');
          frame.innerHTML = imgTag(slug, 'hr-gal-img', true)
            + '<span class="hr-gal-broken">Photograph unavailable</span>';
        }
        root.querySelectorAll('[data-gal-pick]').forEach(b => {
          const on = b === pick;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        const cap = root.querySelector('.hr-gal-cap');
        if (cap) cap.innerHTML = creditHtml(slug);
        const count = root.querySelector('.hr-gal-count');
        if (count) count.textContent = `${all.indexOf(slug) + 1} / ${all.length}`;
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

  return { show, hide };
})();
