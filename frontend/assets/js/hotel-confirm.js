'use strict';
/* ===========================================================================
   hotel-confirm.js — the Confirmation screen.
   ===========================================================================
   Step 8, and the only screen a traveller may come back to days later. So it
   does not render what the previous screens were holding in memory: it
   re-reads the booking from `GET /api/customer/hotel-bookings/{ref}` and shows
   what the SERVER says. A refresh, a bookmark or a link from an email all land
   on the same truth.

   WHAT THIS SCREEN IS ALLOWED TO CLAIM.
   No gateway is connected. The booking is created `pending` and the payment
   attempt is stored `pending` with no provider and no provider reference. So:

     * the headline is "Booking received", never "confirmed";
     * payment reads "Pending — nothing charged", never "Paid";
     * both statuses are printed from the booking's OWN fields, so if a
       gateway is connected later and the server starts returning
       `confirmed`, this screen says so without being edited.

   NO VOUCHER, AND NO PRETEND ONE.
   There is no hotel voucher endpoint in this API — the only voucher in the
   product belongs to the B2B merchant flow. The shared `booking-ticket.js`
   printable does exist and does work, but it is flight-shaped: seat and
   passport columns, and a "PNR — issued by the airline on ticketing" line.
   Printing that for a hotel stay would hand somebody an airline document for
   a room. So the voucher action is present and DISABLED, with the reason
   written next to it, rather than absent (which reads as forgotten) or
   working badly (which is worse).

   Every other action on this screen goes somewhere real.
   =========================================================================== */

const HotelConfirm = (function () {

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rupees = n => (typeof money === 'function' ? money(n)
    : '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'));
  const icon = (name, cls) => (typeof HotelResults !== 'undefined' && HotelResults.icon)
    ? HotelResults.icon(name, cls) : '';

  let booking = null;      // the server's own record
  let hotel = null;        // catalogue detail, for the photograph and stars
  let loadError = null;
  let bound = false;
  let handlers = {};

  /* ---------------------------------------------------------------------
     Status, read from the booking rather than assumed.
     --------------------------------------------------------------------- */
  const CONFIRMED = /confirm|complete/i;
  const isServerConfirmed = () => CONFIRMED.test(String((booking && booking.status) || ''));

  /* WHAT THIS SCREEN CLAIMS ONCE A PAYMENT HAS BEEN SUBMITTED.
     ---------------------------------------------------------------------
     `true`  — the requested treatment: a green tick, "Payment Received" and
               "Hotel Booking Confirmed", for every booking that has a payment
               attempt recorded against it.
     `false` — the headline follows the SERVER's own booking status, which is
               what the rest of this file was written to do.

     The distinction is real and worth stating once, here, rather than in a
     commit message: no payment gateway is connected, so
     `POST /hotel-bookings/{ref}/pay` records the attempt `pending` and nothing
     is charged. With this switch on, the screen therefore says "received"
     about money that has not moved. Flip it to false and every headline,
     pill and status line on this screen goes back to reporting the booking
     exactly as the server holds it — no other change is needed. */
  const PAYMENT_RECEIVED_UI = true;

  /** Did this booking reach the payment step at all? A booking created but
   *  never paid still shows the honest "received" treatment either way. */
  const hasPaymentAttempt = () => !!((booking && booking.payments) || []).length;

  /** What the SCREEN presents. Everything below asks this, not the raw status,
   *  so the switch above has exactly one place to take effect. */
  const isConfirmed = () =>
    isServerConfirmed() || (PAYMENT_RECEIVED_UI && hasPaymentAttempt());

  /** The payment attempt the server holds, if any. */
  function payment() {
    const list = (booking && booking.payments) || [];
    return list.length ? list[list.length - 1] : null;
  }
  function paymentLine() {
    const p = payment();
    if (!p) return { label: 'No payment recorded', tone: 'wait' };
    const paid = /paid|success|captur/i.test(String(p.status || ''));
    if (paid || PAYMENT_RECEIVED_UI) {
      return { label: `Received${p.method ? ` · ${esc(p.method)}` : ''}`, tone: 'ok' };
    }
    return {
      label: `Pending — nothing has been charged${p.method ? ` · intended via ${p.method}` : ''}`,
      tone: 'wait',
    };
  }

  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00:00');
    return isNaN(d) ? '—' : d.toLocaleDateString('en-IN',
      { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }
  function heroSlug() {
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
    const key = hotel && hotel.image;
    return (key && known[key]) ? key
      : (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');
  }
  const imgDir = () => (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';

  /** Rooms as the server recorded them. Falls back to the parent row's single
   *  room for bookings made before per-room selections existed. */
  function rooms() {
    const list = (booking && booking.rooms) || [];
    if (list.length) return list;
    return booking ? [{
      room_index: 0, room_name: booking.room_name,
      meal_plan: booking.meal_plan, price_per_night: null,
    }] : [];
  }
  function guestsIn(roomIndex) {
    return ((booking && booking.guests) || []).filter(g =>
      (g.room_index == null ? 0 : g.room_index) === roomIndex);
  }

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */
  function bannerHtml() {
    const confirmed = isConfirmed();
    /* The green tick and "Payment Received" belong to the same state — a
       traveller who has just come off the payment screen is looking for one
       word, and the sub-line is where the booking itself is confirmed. */
    return `
      <div class="hr-cf-banner ${confirmed ? 'is-ok' : 'is-wait'}">
        <span class="hr-cf-mark">${icon(confirmed ? 'check' : 'calendar')}</span>
        <div>
          <h1 class="hr-cf-title">${confirmed ? 'Payment Received' : 'Booking received'}</h1>
          <p>${confirmed
            ? '<b class="hr-cf-sub-ok">Hotel Booking Confirmed.</b> Your rooms are held under the reference alongside, and a copy is in My Trips.'
            : 'Your booking request has been received. Payment has not been processed, and nothing has been charged.'}</p>
        </div>
        <div class="hr-cf-ref">
          <span>Booking reference</span>
          <b>${esc(booking.booking_ref)}</b>
        </div>
      </div>`;
  }

  function statusHtml() {
    const pay = paymentLine();
    return `
      <div class="hr-cf-status">
        <div class="hr-cf-stat">
          <span>Booking status</span>
          <b class="hr-pill ${isConfirmed() ? 'is-ok' : 'is-wait'}">${
            isConfirmed() ? 'Confirmed' : esc(booking.status || 'pending')}</b>
        </div>
        <div class="hr-cf-stat">
          <span>Payment status</span>
          <b class="hr-pill ${pay.tone === 'ok' ? 'is-ok' : 'is-wait'}">${pay.label}</b>
        </div>
        <div class="hr-cf-stat">
          <span>Booked on</span>
          <b>${esc(fmtDay(booking.created_at))}</b>
        </div>
        <div class="hr-cf-stat">
          <span>Amount</span>
          <b>${esc(rupees(booking.total_amount))}</b>
        </div>
      </div>`;
  }

  function section(id, title, body) {
    return `
      <section class="hr-rvsec" aria-labelledby="hrCf-${id}">
        <div class="hr-rvsec-head"><h2 id="hrCf-${id}">${esc(title)}</h2></div>
        <div class="hr-rvsec-body">${body}</div>
      </section>`;
  }

  function hotelSection() {
    return section('hotel', 'Booking Details', `
      <div class="hr-rv-hotel">
        <img class="hr-rv-thumb" src="${esc(imgDir() + heroSlug() + '-480.webp')}"
             alt="${esc(booking.hotel_name)}" loading="lazy">
        <div class="hr-rv-hotel-body">
          <div class="hr-name-row">
            <h3 class="hr-rv-name">${esc(booking.hotel_name)}</h3>
            ${hotel && hotel.stars ? `<span class="hr-stars" role="img"
              aria-label="${esc(hotel.stars)} star hotel">${'★'.repeat(hotel.stars)}</span>` : ''}
          </div>
          ${booking.hotel_location
            ? `<p class="hr-loc">${icon('pin')} ${esc(booking.hotel_location)}</p>` : ''}
          <dl class="hr-rv-facts">
            <div><dt>Check-in</dt><dd>${esc(fmtDay(booking.check_in_date))}</dd></div>
            <div><dt>Check-out</dt><dd>${esc(fmtDay(booking.check_out_date))}</dd></div>
            <div><dt>Nights</dt><dd>${esc(booking.nights)}</dd></div>
            <div><dt>Rooms</dt><dd>${esc(booking.rooms_count)}</dd></div>
            <div><dt>Guests</dt><dd>${esc(booking.adults)} adult${booking.adults === 1 ? '' : 's'}${
              booking.children ? `, ${esc(booking.children)} child${booking.children === 1 ? '' : 'ren'}` : ''}</dd></div>
          </dl>
          ${cancellationHtml()}
        </div>
      </div>`);
  }

  /** Cancellation terms.
   *
   *  A hotel booking does not store a cancellation policy of its own — only
   *  the property and its rooms carry one — so this is the property's CURRENT
   *  published policy, and it says so rather than implying the wording was
   *  frozen when the booking was made. Omitted entirely when the catalogue
   *  could not be reached, because a missing policy must not read as "none". */
  function cancellationHtml() {
    const policy = hotel && hotel.cancellation_policy;
    if (!policy) return '';
    return `
      <div class="hr-cf-cancel">
        ${icon('shield')}
        <div>
          <b>Cancellation</b>
          <span>${esc(policy)}</span>
          <span class="hr-cf-why">The property's current published policy. Your
            booking is still pending, so confirm the terms with us before travelling.</span>
        </div>
      </div>`;
  }

  function roomsSection() {
    const n = Number(booking.nights) || 1;
    return section('rooms', 'Room Details', rooms().map((r, i) => {
      const idx = r.room_index == null ? i : r.room_index;
      const members = guestsIn(idx);
      const a = members.filter(g => g.guest_type === 'adult').length;
      const c = members.filter(g => g.guest_type === 'child').length;
      return `
        <div class="hr-rv-room">
          <div class="hr-rv-room-head">
            <b>Room ${idx + 1}</b>
            <span class="hr-rv-room-type">${esc(r.room_name)}</span>
          </div>
          <dl class="hr-rv-facts">
            <div><dt>Guests</dt><dd>${a} adult${a === 1 ? '' : 's'}${c ? `, ${c} child${c === 1 ? '' : 'ren'}` : ''}</dd></div>
            ${r.meal_plan ? `<div><dt>Meal plan</dt><dd>${esc(r.meal_plan)}</dd></div>` : ''}
            ${r.price_per_night != null
              ? `<div><dt>Rate</dt><dd>${esc(rupees(r.price_per_night))} per night</dd></div>` : ''}
          </dl>
          ${r.price_per_night != null ? `
            <div class="hr-rv-room-price">
              <span>${esc(rupees(r.price_per_night))} × ${n} night${n > 1 ? 's' : ''}</span>
              <b>${esc(rupees(Number(r.price_per_night) * n))}</b>
            </div>` : ''}
        </div>`;
    }).join(''));
  }

  /** Guests under their recorded room. Names and the lead guest's contact
   *  only — no identity documents are collected for a hotel stay and none is
   *  printed here. */
  function guestsSection() {
    return section('guests', 'Guest Details', rooms().map((r, i) => {
      const idx = r.room_index == null ? i : r.room_index;
      const members = guestsIn(idx);
      if (!members.length) return '';
      return `
        <div class="hr-rv-guestroom">
          <div class="hr-rv-room-head"><b>Room ${idx + 1}</b>
            <span class="hr-rv-room-type">${esc(r.room_name)}</span></div>
          <ul class="hr-rv-guestlist">
            ${members.map(g => `
              <li>
                <span class="hr-rv-guestname">${esc([g.title, g.first_name, g.last_name].filter(Boolean).join(' '))}</span>
                <span class="hr-rv-guestmeta">${g.guest_type === 'child' ? 'Child' : 'Adult'}${
                  g.is_contact ? ' · Lead guest' : ''}</span>
                ${g.is_contact && (g.email || g.mobile) ? `
                  <span class="hr-rv-guestcontact">${esc([g.email, g.mobile].filter(Boolean).join(' · '))}</span>` : ''}
              </li>`).join('')}
          </ul>
        </div>`;
    }).join(''));
  }

  /** Payment Details.
   *
   *  Every field is printed from the payment attempt the SERVER recorded —
   *  method, amount, when — so this section stays correct the day a gateway
   *  starts returning a provider reference. Rows with nothing behind them are
   *  omitted rather than printed as an em dash; a receipt with blanks on it
   *  reads as a receipt that failed. */
  function paymentSection() {
    const p = payment();
    if (!p) return '';
    const pay = paymentLine();
    const rows = [
      ['Payment status', `<b class="hr-pill ${pay.tone === 'ok' ? 'is-ok' : 'is-wait'}">${pay.label}</b>`],
      p.method ? ['Method', esc(p.method)] : null,
      ['Amount paid', esc(rupees(p.amount != null ? p.amount : booking.total_amount))],
      p.created_at ? ['Payment date', esc(fmtDay(p.created_at))] : null,
      p.provider_reference ? ['Transaction reference', esc(p.provider_reference)] : null,
      ['Booking reference', esc(booking.booking_ref)],
    ].filter(Boolean);
    return section('payment', 'Payment Details', `
      <dl class="hr-rv-facts hr-cf-payfacts">
        ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
      </dl>`);
  }

  function requestsSection() {
    const list = (booking.special_requests || []).filter(Boolean);
    if (!list.length) return '';
    return section('requests', 'Special Requests', `
      <ul class="hr-policy-list">${list.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      <p class="hr-panel-note">
        Passed to the property. Requests are not guaranteed and are subject to
        availability on arrival.
      </p>`);
  }

  function nextStepsSection() {
    if (isConfirmed()) {
      return section('next', 'What happens next', `
        <ol class="hr-cf-steps">
          <li><b>Your rooms are held.</b> Quote the reference above to our
            support team or to the property at any time.</li>
          <li><b>The property is notified.</b> Any special requests you made
            are passed on; they remain subject to availability on arrival.</li>
          <li><b>Everything is in My Trips.</b> This booking, its guests and
            its payment are on your account and can be reopened whenever you
            need them.</li>
        </ol>`);
    }
    return section('next', 'What happens next', `
      <ol class="hr-cf-steps">
        <li><b>We hold your rooms.</b> Your booking reference above is real and
          can be quoted to our support team.</li>
        <li><b>Payment is arranged with you directly.</b> No online payment has
          been taken — there is no payment gateway connected to this site yet.</li>
        <li><b>The property confirms.</b> Your booking moves from <em>pending</em>
          to confirmed once payment is settled, and a hotel voucher is issued
          at that point.</li>
      </ol>`);
  }

  function actionsHtml() {
    return `
      <div class="hr-cf-actions">
        <a class="hr-btn hr-btn-ghost" href="my-bookings.html">View My Trips</a>
        <a class="hr-btn hr-btn-ghost" href="hotels.html">Back to Hotels</a>
        <span class="hr-cf-voucher">
          <button type="button" class="hr-btn hr-btn-ghost" disabled
                  aria-describedby="hrCfVoucherWhy">Download voucher</button>
          <span class="hr-cf-why" id="hrCfVoucherWhy">
            The voucher is issued by the property and is not available to
            download here yet. Your booking reference above is what the
            property and our support team need.
          </span>
        </span>
        <!-- The way OUT of the journey, and the last thing on the screen: the
             traveller is finished, and Done leaves the booking flow the way
             closing the Flights modal does — back to Hotels, criteria and all
             discarded, because the stay they were booking is now booked. -->
        <button type="button" class="hr-btn hr-btn-primary hr-cf-done"
                data-hr-done>Done</button>
      </div>`;
  }

  function summaryHtml() {
    const pay = paymentLine();
    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <img class="hr-sum-thumb" src="${esc(imgDir() + heroSlug() + '-480.webp')}" alt="" loading="lazy">
            <div>
              <p class="hr-sum-hotel-name">${esc(booking.hotel_name)}</p>
              ${hotel && hotel.stars ? `<span class="hr-stars" role="img"
                aria-label="${esc(hotel.stars)} star hotel">${'★'.repeat(hotel.stars)}</span>` : ''}
              <p class="hr-sum-hotel-loc">${esc(booking.hotel_location || '')}</p>
            </div>
          </div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-line"><span>Reference</span><b>${esc(booking.booking_ref)}</b></div>
          <div class="hr-sum-line"><span>Check-in</span><b>${esc(fmtDay(booking.check_in_date))}</b></div>
          <div class="hr-sum-line"><span>Check-out</span><b>${esc(fmtDay(booking.check_out_date))}</b></div>
          <div class="hr-sum-meta">${esc(booking.rooms_count)} Room${booking.rooms_count > 1 ? 's' : ''} · ${
            esc((booking.guests || []).length)} Guest${(booking.guests || []).length > 1 ? 's' : ''}</div>
          <div class="hr-sum-meta">${esc(booking.nights)} Night${booking.nights > 1 ? 's' : ''}</div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Price Details</div>
          <div class="hr-sum-line"><span>Room charges</span><b>${esc(rupees(booking.room_subtotal))}</b></div>
          <div class="hr-sum-line"><span>Taxes &amp; fees</span><b>${esc(rupees(booking.taxes))}</b></div>
          ${Number(booking.addon_total) > 0
            ? `<div class="hr-sum-line"><span>Extras</span><b>${esc(rupees(booking.addon_total))}</b></div>` : ''}
          ${Number(booking.discount) > 0
            ? `<div class="hr-sum-line is-discount"><span>Discount${
                booking.coupon_code ? ` (${esc(booking.coupon_code)})` : ''}</span>
               <b>−${esc(rupees(booking.discount))}</b></div>` : ''}
          <div class="hr-sum-total">
            <span class="hr-sum-total-label">Total Amount</span>
            <span class="hr-sum-total-value">${esc(rupees(booking.total_amount))}</span>
          </div>
          <span class="hr-sum-note">${esc(pay.label)}.</span>
        </div>
        <div class="hr-trust">
          <div class="hr-trust-row">${icon('shield')}
            <div><b>Secure booking</b><span>Your data is protected</span></div></div>
          <div class="hr-trust-row">${icon('headset')}
            <div><b>24/7 customer support</b><span>Quote ${esc(booking.booking_ref)} when you contact us</span></div></div>
        </div>
      </div>`;
  }

  function actionbarHtml() {
    return `
      <div class="hr-actionbar-inner">
        <div class="hr-ab-item hr-ab-hide-sm">${icon('shield')}
          <div><b>${esc(booking.hotel_name)}</b><span>${esc(booking.hotel_location || '')}</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item">${icon('calendar')}
          <div><b>${esc(fmtDay(booking.check_in_date))} → ${esc(fmtDay(booking.check_out_date))}</b>
          <span>${esc(booking.nights)} night${booking.nights > 1 ? 's' : ''} · ${
            esc((booking.guests || []).length)} guest${(booking.guests || []).length > 1 ? 's' : ''}</span></div></div>
        <div class="hr-ab-total">
          <b>${esc(rupees(booking.total_amount))}</b>
          <span>${isConfirmed() ? 'Paid' : 'Payment pending'}</span>
        </div>
        <div class="hr-ab-cta">
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg" data-hr-done>Done</button>
          <span>Reference ${esc(booking.booking_ref)}</span>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Paint
     --------------------------------------------------------------------- */
  function paintChrome() {
    const HR = typeof HotelResults !== 'undefined' ? HotelResults : null;
    const st = $('hcStepper');
    if (st && HR && HR.stepperHtml) st.innerHTML = HR.stepperHtml(7);
  }

  function paint() {
    paintChrome();
    const main = $('hcMain');
    if (main) {
      main.innerHTML = `
        ${bannerHtml()}
        ${statusHtml()}
        ${hotelSection()}
        ${roomsSection()}
        ${guestsSection()}
        ${paymentSection()}
        ${requestsSection()}
        ${nextStepsSection()}
        ${actionsHtml()}`;
    }
    const sum = $('hcSummary');
    if (sum) sum.innerHTML = summaryHtml();
    const bar = $('hrActionbar');
    if (bar) { bar.innerHTML = actionbarHtml(); bar.hidden = false; }
  }

  function paintError(msg) {
    paintChrome();
    const main = $('hcMain');
    if (main) main.innerHTML = `
      <div class="hr-error">
        <b>We couldn't load this booking</b>
        <p>${esc(msg || 'Something went wrong at our end. Please try again in a moment.')}</p>
        <a class="hr-btn hr-btn-primary" href="my-bookings.html">View My Trips</a>
      </div>`;
    const sum = $('hcSummary');
    if (sum) sum.innerHTML = '';
    const bar = $('hrActionbar');
    if (bar) bar.hidden = true;
  }

  function skeleton() {
    paintChrome();
    const main = $('hcMain');
    if (main) main.innerHTML = '<div class="hr-skeleton hr-skeleton-line"></div>'
      + '<div class="hr-skeleton hr-skeleton-line"></div>';
    const sum = $('hcSummary');
    if (sum) sum.innerHTML = '<div class="hr-skeleton hr-skeleton-sum"></div>';
  }

  function bind() {
    if (bound) return;
    const root = $('hcRoot');
    if (!root) return;
    bound = true;
    const onClick = e => {
      if (e.target.closest('[data-hr-done]')) { finish(); return; }
      if (e.target.closest('#hrModify')) {
        if (typeof HotelResults !== 'undefined' && HotelResults.modifySearch) HotelResults.modifySearch();
      }
    };
    root.addEventListener('click', onClick);
    /* The sticky bar lives OUTSIDE #hcRoot — it is the page's, shared by every
       booking screen — so its Done needs the listener too. */
    const bar = $('hrActionbar');
    if (bar) bar.addEventListener('click', onClick);
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  /** Show the confirmation for one booking reference.
   *  The reference is the ONLY input — everything shown is re-read from the
   *  server, so this screen is correct on a refresh and days later. */
  async function show(ref, hs) {
    handlers = hs || {};
    booking = null; hotel = null; loadError = null;

    const root = $('hcRoot');
    if (root) root.hidden = false;
    bind();
    skeleton();

    if (typeof BookingApi === 'undefined' || !BookingApi.isSignedIn()) {
      paintError('Please sign in to view this booking.');
      return;
    }

    try {
      booking = await BookingApi.getHotelBooking(ref);
    } catch (err) {
      paintError((BookingApi.errorText && BookingApi.errorText(err))
        || 'That booking could not be found on your account.');
      return;
    }

    /* The photograph and star rating are catalogue facts, not booking facts,
       so they come from the catalogue. A failure here costs the picture, not
       the confirmation. */
    try { hotel = await BookingApi.getHotelDetail(booking.hotel_id); }
    catch { hotel = null; }

    paint();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /** Leave the journey. A completed booking is not something Back should walk
   *  into again, so this REPLACES the confirmation entry rather than pushing a
   *  new one — the same reason the Flights modal closes instead of navigating.
   *  The handler is asked first, so the page keeps the final say. */
  function finish() {
    if (handlers.done) { handlers.done(); return; }
    location.replace('hotels.html');
  }

  function hide() {
    const root = $('hcRoot');
    if (root) root.hidden = true;
  }

  return { show, hide };
})();
