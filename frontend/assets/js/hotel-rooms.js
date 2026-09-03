'use strict';
/* ===========================================================================
   hotel-rooms.js — the Room Selection screen.
   ===========================================================================
   Step 4 of the hotel journey. Reads the property's real room types and lets
   the traveller choose ONE ROOM AT A TIME, independently, for each room they
   searched for.

   WHY EACH ROOM IS CHOSEN SEPARATELY, AND WHAT THAT COST.
   The booking model used to be "``rooms_count`` of one ``room_id``" — two
   rooms meant two of the SAME type, and there was literally one room_id
   column to put an answer in. A party wanting a Deluxe and a Premium could
   not be represented at all. Migration 0058 adds
   ``customer_hotel_booking_rooms``, one row per room booked, and
   ``StayInput.room_ids`` carries the selections in order. This screen is the
   thing that produces that list, which is why Room 1 and Room 2 here are
   genuinely independent rather than one choice drawn twice.

   THE TOTAL IS THE SERVER'S. As soon as every room has been chosen this asks
   ``POST /hotel-bookings/quote`` with the real ``room_ids`` and shows what
   comes back. Nothing here adds up a final price: the per-room lines shown
   while the selection is still incomplete are the individual real nightly
   rates, clearly labelled as a running subtotal, and the word "Total" does
   not appear until the server has said one.

   WHAT THE ROOM DATA DOES NOT HAVE.
       room photographs   `customer_hotel_rooms` has no image column, and the
                          property's exterior photo is not a picture of the
                          room. Room cards carry no image rather than a
                          misleading one.
       "N rooms left"     `total_inventory` is a flat stock count, not
                          availability for these dates. It is used ONLY to cap
                          how many of a type can be chosen — a real limit —
                          and never rendered as date-specific scarcity.
   =========================================================================== */

const HotelRooms = (function () {

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rupees = n => (typeof money === 'function' ? money(n)
    : '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'));
  const icon = (name, cls) => (typeof HotelResults !== 'undefined' && HotelResults.icon)
    ? HotelResults.icon(name, cls) : '';

  /* The rate the pricing service charges, borrowed rather than restated so
     the two cannot disagree. */
  const TAX_RATE = (typeof HotelResults !== 'undefined' && HotelResults.TAX_RATE) || 0.12;

  let detail = null;       // HotelDetail, with .rooms
  let shell = null;        // travel-explore's shared search state
  let picks = [];          // one entry per searched room: a room object or null
  let active = 0;          // which room is being configured
  let quote = null;        // the server's answer, once every room is chosen
  let quoteBusy = false;
  let quoteError = null;
  let bound = false;
  let onBack = null;
  let onGuests = null;

  /* ---------------------------------------------------------------------
     Stay maths — same rules as Results and Details.
     --------------------------------------------------------------------- */
  function nights() {
    const a = shell && shell.checkIn ? new Date(shell.checkIn) : null;
    const b = shell && shell.checkOut ? new Date(shell.checkOut) : null;
    if (!a || !b || isNaN(a) || isNaN(b)) return 1;
    return Math.max(1, Math.round((b - a) / 86400000));
  }
  function roomCount() { return Math.max(1, Number(shell && shell.rooms) || 1); }
  function guestCount() { return Math.max(1, Number(shell && shell.guests) || 2); }

  /** The per-room party the search panel collected, when it is still in hand.
   *  This is the only place child AGES exist on the client. */
  function roomsList() {
    const list = shell && Array.isArray(shell.roomsList) ? shell.roomsList : null;
    return list && list.length ? list : null;
  }
  function adultsTotal() {
    const list = roomsList();
    if (list) return list.reduce((n, r) => n + (Number(r.adults) || 0), 0) || 1;
    return guestCount();
  }
  function childAges() {
    const list = roomsList();
    if (!list) return [];
    return list.flatMap(r => Array.from({ length: Number(r.children) || 0 },
      (_, i) => Number((r.childAges || [])[i] ?? 8)));
  }

  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function isInclusion(meal) { return !/^\s*room only\s*$/i.test(String(meal || '')); }

  const allChosen = () => picks.length === roomCount() && picks.every(Boolean);

  /** How many of a room type are already taken by OTHER room slots. Used to
   *  disable a type once its real stock is exhausted. */
  function usedElsewhere(roomId, exceptIndex) {
    return picks.reduce((n, p, i) =>
      (i !== exceptIndex && p && p.id === roomId ? n + 1 : n), 0);
  }
  function isAvailable(room, forIndex) {
    const stock = Number(room.left);
    if (!Number.isFinite(stock)) return true;
    return usedElsewhere(room.id, forIndex) < stock;
  }

  /** The running room subtotal from what has been chosen so far — real rates,
   *  never presented as the final price. */
  function chosenSubtotal() {
    return picks.reduce((n, p) => n + (p ? Number(p.price) * nights() : 0), 0);
  }

  /* ---------------------------------------------------------------------
     Server quote
     --------------------------------------------------------------------- */
  function stayPayload() {
    const list = roomsList();
    return {
      hotel_id: Number(detail.id),
      room_id: Number(picks[0].id),
      room_ids: picks.map(p => Number(p.id)),
      check_in: shell.checkIn,
      check_out: shell.checkOut,
      rooms_count: roomCount(),
      adults: adultsTotal(),
      children: list ? list.reduce((n, r) => n + (Number(r.children) || 0), 0) : 0,
      /* The ages the search panel collected actually travel now. `StayInput`
         has always accepted them and `customer_hotel_bookings.child_ages` has
         always had a column for them; the client simply never sent any. */
      child_ages: childAges(),
    };
  }

  async function refreshQuote() {
    if (!allChosen()) { quote = null; quoteError = null; paintSummary(); paintActionbar(); return; }
    if (typeof BookingApi === 'undefined' || !BookingApi.isLive('hotel')) return;

    quoteBusy = true; quoteError = null;
    paintSummary(); paintActionbar();
    /* Which selection this answer belongs to — a slower earlier request must
       not overwrite the price for a selection the traveller has since
       changed. */
    const token = picks.map(p => p.id).join(',');
    lastToken = token;
    try {
      const q = await BookingApi.quoteHotel(stayPayload(), [], null);
      if (lastToken !== token) return;
      quote = q;
    } catch (err) {
      if (lastToken !== token) return;
      quote = null;
      quoteError = (BookingApi.errorText && BookingApi.errorText(err))
        || "We couldn't price these rooms just now.";
    } finally {
      if (lastToken === token) { quoteBusy = false; paintSummary(); paintActionbar(); }
    }
  }
  let lastToken = '';

  /* ---------------------------------------------------------------------
     Render — room tabs
     --------------------------------------------------------------------- */
  function roomTabsHtml() {
    if (roomCount() < 2) return '';
    const list = roomsList();
    return `
      <div class="hr-roomtabs" role="tablist" aria-label="Rooms in this booking">
        ${picks.map((p, i) => {
          const party = list && list[i]
            ? `${list[i].adults} adult${list[i].adults > 1 ? 's' : ''}`
              + (list[i].children ? `, ${list[i].children} child${list[i].children > 1 ? 'ren' : ''}` : '')
            : '';
          return `
          <button type="button" role="tab" class="hr-roomtab ${i === active ? 'is-on' : ''}"
                  id="hrRoomTab-${i}" aria-controls="hrRoomPanel"
                  aria-selected="${i === active}" tabindex="${i === active ? '0' : '-1'}"
                  data-room-slot="${i}">
            <span class="hr-roomtab-title">Room ${i + 1}</span>
            ${party ? `<span class="hr-roomtab-party">${esc(party)}</span>` : ''}
            <span class="hr-roomtab-state ${p ? 'is-set' : ''}">
              ${p ? `${icon('check')} ${esc(p.name)}` : 'Not selected'}
            </span>
          </button>`;
        }).join('')}
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Render — one room card
     --------------------------------------------------------------------- */
  function roomCardHtml(r) {
    const n = nights();
    const chosen = picks[active] && picks[active].id === r.id;
    const available = isAvailable(r, active);
    const stayTotal = Math.round(Number(r.price) * n);
    /* The same 12% the pricing service charges — the Results cards already
       preview it this way, and a card that said "calculated at checkout"
       while the card on the previous screen showed a figure read as two
       different rules. The server still has the last word on the total. */
    const roomTax = Math.round(stayTotal * TAX_RATE);
    const perks = r.perks || [];

    return `
      <article class="hr-roomcard ${chosen ? 'is-selected' : ''} ${available ? '' : 'is-unavailable'}"
               data-room="${esc(r.id)}" aria-disabled="${available ? 'false' : 'true'}">
        <div class="hr-roomcard-main">
          <div class="hr-roomcard-head">
            <h3 class="hr-roomcard-name">${esc(r.name)}</h3>
            ${chosen ? `<span class="hr-chip-selected">${icon('check')} Selected for Room ${active + 1}</span>` : ''}
          </div>
          ${r.description ? `<p class="hr-roomcard-desc">${esc(r.description)}</p>` : ''}
          <div class="hr-roomcard-meta">
            ${r.beds ? `<span>${icon('bed')} ${esc(r.beds)}</span>` : ''}
            ${r.maxGuests ? `<span>${icon('person')} Up to ${esc(r.maxGuests)} guests</span>` : ''}
            ${r.size ? `<span>${esc(r.size)}</span>` : ''}
          </div>
          ${perks.length ? `<div class="hr-roomcard-perks">${
            perks.map(p => `<i>${esc(p)}</i>`).join('')}</div>` : ''}
          <div class="hr-notes">
            ${r.mealPlan ? (isInclusion(r.mealPlan)
              ? `<span class="hr-note-ok">${icon('check')} ${esc(r.mealPlan)}</span>`
              : `<span class="hr-note-plain">${esc(r.mealPlan)}</span>`) : ''}
            ${r.cancellationPolicy
              ? `<span class="hr-note-plain">${esc(r.cancellationPolicy)}</span>` : ''}
          </div>
        </div>

        <div class="hr-roomcard-side">
          <span class="hr-roomcard-rate">${esc(rupees(r.price))}</span>
          <span class="hr-roomcard-per">per night</span>
          <span class="hr-roomcard-tax">+ ${esc(rupees(roomTax))} taxes &amp; fees</span>
          <span class="hr-roomcard-stay">${esc(rupees(stayTotal))} for ${n} night${n > 1 ? 's' : ''}</span>
          ${available
            ? `<button type="button" class="hr-btn ${chosen ? 'hr-btn-ghost' : 'hr-btn-primary'}"
                       data-pick="${esc(r.id)}">
                 ${chosen ? 'Selected' : 'Select Room'}
               </button>`
            : `<button type="button" class="hr-btn hr-btn-primary" disabled>Unavailable</button>
               <span class="hr-roomcard-why">All ${esc(r.left)} of this room type are already in your booking.</span>`}
        </div>
      </article>`;
  }

  function roomsPanelHtml() {
    const rooms = (detail.rooms || []).map(r => ({
      id: String(r.id), name: r.name, description: r.description,
      beds: r.bed_type, size: r.size_label, maxGuests: r.max_guests,
      price: Number(r.price), mealPlan: r.meal_plan,
      cancellationPolicy: r.cancellation_policy, perks: r.perks || [], left: r.left,
    }));

    if (!rooms.length) {
      return `
        <div class="hr-empty">
          <b>No rooms are currently available for these dates</b>
          <p>Try different dates, or choose another property.</p>
          <button type="button" class="hr-btn hr-btn-primary" data-rooms-back>Back to Hotel Results</button>
        </div>`;
    }
    return `<div class="hr-roomcards" id="hrRoomPanel" role="tabpanel"
                 ${roomCount() > 1 ? `aria-labelledby="hrRoomTab-${active}"` : ''}>
      ${rooms.map(roomCardHtml).join('')}
    </div>`;
  }

  /* ---------------------------------------------------------------------
     Render — booking summary
     --------------------------------------------------------------------- */
  function summaryHtml() {
    const n = nights();
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
    const slug = (detail.image && known[detail.image]) ? detail.image
      : (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');

    const roomLines = picks.map((p, i) => `
      <div class="hr-sum-line">
        <span>Room ${i + 1}${p ? ` · ${esc(p.name)}` : ''}</span>
        <b>${p ? esc(rupees(Number(p.price) * n)) : '<i class="hr-sum-pending">Not selected</i>'}</b>
      </div>`).join('');

    let priceBlock;
    if (quoteBusy) {
      priceBlock = `<div class="hr-sum-line"><span>Pricing your stay…</span><b>—</b></div>`;
    } else if (quoteError) {
      priceBlock = `<p class="hr-sum-error">${esc(quoteError)}</p>`;
    } else if (quote) {
      priceBlock = `
        ${(quote.lines || []).map(l => `
          <div class="hr-sum-line"><span>${esc(l.label)}</span><b>${esc(rupees(l.amount))}</b></div>`).join('')}
        <div class="hr-sum-total">
          <span class="hr-sum-total-label">Total Amount</span>
          <span class="hr-sum-total-value">${esc(rupees(quote.total_amount))}</span>
        </div>
        <span class="hr-sum-note">Inclusive of all taxes. Confirmed by our booking system.</span>`;
    } else {
      /* Deliberately NOT called a total: rooms are still unchosen, so this is
         only what has been picked so far. */
      priceBlock = `
        <div class="hr-sum-line"><span>Selected so far</span><b>${esc(rupees(chosenSubtotal()))}</b></div>
        <span class="hr-sum-note">
          Choose every room to see your total, including taxes and fees.
        </span>`;
    }

    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <img class="hr-sum-thumb" src="${esc(dir + slug + '-480.webp')}" alt="" loading="lazy">
            <div>
              <p class="hr-sum-hotel-name">${esc(detail.name)}</p>
              ${detail.stars ? `<span class="hr-stars" role="img"
                aria-label="${esc(detail.stars)} star hotel">${'★'.repeat(detail.stars)}</span>` : ''}
              <p class="hr-sum-hotel-loc">${esc(detail.location)}</p>
            </div>
          </div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-line"><span>Check-in</span><b>${esc(fmtDay(shell.checkIn))}</b></div>
          <div class="hr-sum-line"><span>Check-out</span><b>${esc(fmtDay(shell.checkOut))}</b></div>
          <div class="hr-sum-meta">${roomCount()} Room${roomCount() > 1 ? 's' : ''} · ${guestCount()} Guest${guestCount() > 1 ? 's' : ''}</div>
          <div class="hr-sum-meta">${n} Night${n > 1 ? 's' : ''}</div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Room selection</div>
          ${roomLines}
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Price Details</div>
          ${priceBlock}
        </div>
        <div class="hr-trust">
          <div class="hr-trust-row">${icon('shield')}
            <div><b>Secure booking</b><span>Your data is protected</span></div></div>
          <div class="hr-trust-row">${icon('headset')}
            <div><b>24/7 customer support</b><span>We're here to help you anytime</span></div></div>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Render — sticky action bar
     --------------------------------------------------------------------- */
  function actionbarHtml() {
    const missing = picks.map((p, i) => (p ? null : i + 1)).filter(Boolean);
    const ready = allChosen() && !!quote && !quoteBusy;
    const n = nights();

    let note;
    if (missing.length === 1) note = `Choose a room for Room ${missing[0]}`;
    else if (missing.length > 1) note = `Choose a room for Room ${missing.slice(0, -1).join(', Room ')} and Room ${missing[missing.length - 1]}`;
    else if (quoteBusy) note = 'Pricing your stay…';
    else if (quoteError) note = 'We could not price these rooms';
    else note = 'You can add guest details next';

    return `
      <div class="hr-actionbar-inner">
        <div class="hr-ab-item hr-ab-hide-sm">${icon('shield')}
          <div><b>Secure booking</b><span>Your data is protected</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item">${icon('calendar')}
          <div><b>${esc(fmtDay(shell.checkIn))} → ${esc(fmtDay(shell.checkOut))}</b>
          <span>${n} night${n > 1 ? 's' : ''}</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item hr-ab-hide-sm">${icon('bed')}
          <div><b>${picks.filter(Boolean).length} of ${roomCount()} chosen</b>
          <span>${guestCount()} Guest${guestCount() > 1 ? 's' : ''}</span></div></div>
        <div class="hr-ab-total">
          <b>${quote ? esc(rupees(quote.total_amount)) : '—'}</b>
          <span>${quote ? 'Inclusive of all taxes' : 'Total pending'}</span>
        </div>
        <div class="hr-ab-cta">
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg" id="hrToGuests"
                  ${ready ? '' : 'disabled'}>
            Continue to Guest Details
          </button>
          <span>${esc(note)}</span>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Paint
     --------------------------------------------------------------------- */
  function paintChrome() {
    const HR = typeof HotelResults !== 'undefined' ? HotelResults : null;
    const sb = $('hrmSearchbar');
    if (sb && HR && HR.searchbarHtml) sb.innerHTML = HR.searchbarHtml();
    const st = $('hrmStepper');
    if (st && HR && HR.stepperHtml) st.innerHTML = HR.stepperHtml(3);
  }

  function paintMain() {
    const main = $('hrmMain');
    if (!main) return;
    main.innerHTML = `
      <button type="button" class="hr-backlink" data-rooms-back>
        ${icon('chevron', 'hr-back-ico')} Back to Hotel Details
      </button>
      <div class="hr-hd-head">
        <div class="hr-name-row">
          <h1 class="hr-hd-name">Select your room</h1>
        </div>
        <p class="hr-loc">${icon('pin')} ${esc(detail.name)} · ${esc(detail.location)}</p>
        <p class="hr-panel-note">
          ${roomCount() > 1
            ? `Choose a room for each of your ${roomCount()} rooms. They can be different types.`
            : 'Choose from the rooms available for your stay.'}
        </p>
      </div>
      ${roomTabsHtml()}
      ${roomsPanelHtml()}`;
  }

  function paintSummary() {
    const el = $('hrmSummary');
    if (el && detail) el.innerHTML = summaryHtml();
  }
  function paintActionbar() {
    const el = $('hrActionbar');
    if (el && detail) { el.innerHTML = actionbarHtml(); el.hidden = false; }
  }

  function paint() { paintChrome(); paintMain(); paintSummary(); paintActionbar(); }

  /* ---------------------------------------------------------------------
     Events
     --------------------------------------------------------------------- */
  function bind() {
    if (bound) return;
    const root = $('hrmRoot');
    if (!root) return;
    bound = true;

    root.addEventListener('click', e => {
      if (e.target.closest('[data-rooms-back]')) { if (onBack) onBack(); return; }

      const slot = e.target.closest('[data-room-slot]');
      if (slot) { active = Number(slot.getAttribute('data-room-slot')); paintMain(); return; }

      const pick = e.target.closest('[data-pick]');
      if (pick) {
        const id = pick.getAttribute('data-pick');
        const room = (detail.rooms || []).find(r => String(r.id) === id);
        if (!room) return;
        const shaped = {
          id: String(room.id), name: room.name, price: Number(room.price),
          mealPlan: room.meal_plan, beds: room.bed_type, size: room.size_label,
          maxGuests: room.max_guests, perks: room.perks || [],
          cancellationPolicy: room.cancellation_policy,
        };
        if (!isAvailable(shaped, active)) return;

        /* ONE SLOT ONLY. This is the whole point of the screen: choosing for
           Room 2 must never touch Room 1. */
        picks[active] = shaped;

        /* Move to the next room still needing one, so a two-room booking
           flows without hunting for the next tab. */
        const next = picks.findIndex((p, i) => !p && i > active);
        if (next !== -1) active = next;

        paintMain(); paintSummary(); paintActionbar();
        refreshQuote();
        return;
      }
    });

    /* Arrow keys across the room tabs. */
    root.addEventListener('keydown', e => {
      const tab = e.target.closest('[data-room-slot]');
      if (!tab || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...root.querySelectorAll('[data-room-slot]')];
      const i = tabs.indexOf(tab);
      const nextEl = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length]
                   : e.key === 'ArrowLeft'  ? tabs[(i - 1 + tabs.length) % tabs.length]
                   : e.key === 'Home'       ? tabs[0] : tabs[tabs.length - 1];
      e.preventDefault();
      active = Number(nextEl.getAttribute('data-room-slot'));
      paintMain();
      const again = root.querySelector(`[data-room-slot="${active}"]`);
      if (again) again.focus();
    });

    const bar = $('hrActionbar');
    if (bar) bar.addEventListener('click', e => {
      if (!e.target.closest('#hrToGuests')) return;
      if (!allChosen() || !quote) return;
      if (onGuests) onGuests(picks.slice(), quote, stayPayload());
    });
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  function skeleton() {
    paintChrome();
    const main = $('hrmMain');
    if (main) main.innerHTML = Array.from({ length: 3 },
      () => '<div class="hr-skeleton hr-skeleton-room"></div>').join('');
    const sum = $('hrmSummary');
    if (sum) sum.innerHTML = '<div class="hr-skeleton hr-skeleton-sum"></div>';
  }

  function error(message) {
    const main = $('hrmMain');
    if (main) main.innerHTML = `
      <div class="hr-error">
        <b>We couldn't load rooms for this property</b>
        <p>${esc(message || 'Something went wrong at our end. Please try again in a moment.')}</p>
        <button type="button" class="hr-btn hr-btn-primary" data-rooms-back>Back to Hotel Details</button>
      </div>`;
    const sum = $('hrmSummary');
    if (sum) sum.innerHTML = '';
  }

  /** Show Room Selection for one property.
   *  `keep` carries selections already made, so returning from a later step
   *  does not throw away the traveller's choices. */
  async function show(hotelRow, sharedState, handlers, keep) {
    listenForSearchChange();
    shell = sharedState || {};
    onBack = handlers && handlers.back;
    onGuests = handlers && handlers.guests;

    const root = $('hrmRoot');
    if (root) root.hidden = false;
    bind();

    /* Resize the slot list to the number of rooms searched, preserving any
       selection already made for a slot that still exists. */
    const want = roomCount();
    const prior = Array.isArray(keep) ? keep : picks;
    picks = Array.from({ length: want }, (_, i) => prior[i] || null);
    if (active >= want) active = 0;

    if (!detail || String(detail.id) !== String(hotelRow.id)) {
      detail = null;
      skeleton();
      try {
        if (typeof BookingApi === 'undefined' || !BookingApi.isLive('hotel')) {
          throw new Error('The hotel catalogue is unavailable.');
        }
        detail = await BookingApi.getHotelDetail(hotelRow.id);
      } catch (err) {
        const msg = (typeof BookingApi !== 'undefined' && BookingApi.errorText)
          ? BookingApi.errorText(err) : '';
        error(msg);
        return;
      }
    }

    paint();
    if (allChosen()) refreshQuote();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function hide() {
    const root = $('hrmRoot');
    if (root) root.hidden = true;
  }

  /** The current selections, so the router can carry them forward. */
  function selections() { return picks.slice(); }


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
      const el = document.getElementById('hrmRoot');
      if (!el || el.hidden) return;
      refreshQuote();
      paintMain();
      paintSummary();
      paintActionbar();
    });
  }

  return { show, hide, selections };
})();
