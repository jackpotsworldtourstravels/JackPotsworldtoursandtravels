'use strict';
/* ===========================================================================
   hotel-payment.js — the Payment screen.
   ===========================================================================
   Step 7. What this screen can honestly do is narrower than what a payment
   screen usually does, and the whole design follows from that.

   NO GATEWAY IS CONNECTED, AND THE SERVER SAYS SO.
   `GET /api/customer/payment-methods` returns `gateway_configured: false`
   along with the method list. Nothing in this product can take money. So:

     * there is NO QR code. A QR is a payment instrument; drawing one that
       charges nothing would be a picture pretending to be a till.
     * there are NO card number, expiry or CVV fields, and no UPI ID field.
       Collecting a payment identifier nobody will bill is worse than not
       asking — it invites somebody to type a real card number into a form
       that does nothing with it.
     * the button does not say "Pay". It says what actually happens.

   WHAT DOES HAPPEN, AND IT IS ALL REAL.
   Pressing the button creates a genuine booking — `POST /hotel-bookings`,
   which returns a real `JPH######` reference from a Postgres sequence — and
   records a genuine payment ATTEMPT against it. That attempt is stored with
   `status = pending`, no provider and no provider reference, because that is
   the truth. The booking's own status stays `pending` too. Nothing anywhere
   is promoted to "confirmed" or "paid".

   SIGNING IN IS REQUIRED, DELIBERATELY.
   `BookingStore.create()` falls back to a locally-invented reference when
   signed out. For a product where hotel bookings are genuinely server-backed
   that fallback would hand somebody a made-up booking number for a stay no
   server has heard of. So this screen refuses to proceed without a session
   and opens the sign-in dialog instead.
   =========================================================================== */

const HotelPayment = (function () {

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rupees = n => (typeof money === 'function' ? money(n)
    : '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'));
  const icon = (name, cls) => (typeof HotelResults !== 'undefined' && HotelResults.icon)
    ? HotelResults.icon(name, cls) : '';

  let detail = null;
  let shell = null;
  let picks = [];
  let guestData = null;
  let addons = [];
  let couponCode = null;
  let quote = null;
  let methods = [];
  let gatewayConfigured = false;
  let gatewayLive = false;      // a provider would actually collect
  let gatewayMounted = false;   // the JPay panel is up; do not build a second
  let chosen = null;
  let busy = false;          // a submission is in flight
  let submitError = null;
  let bound = false;
  let handlers = {};

  /* ---------------------------------------------------------------------
     ONE SUBMISSION = ONE BOOKING.
     A booking session is identified by a key generated once for a given set
     of choices. It survives a reload in sessionStorage alongside the
     reference it produced, so returning to this screen — by Back, by refresh,
     or by pressing the button twice — finds the booking that already exists
     instead of making another. The server enforces the same rule through a
     unique index (migration 0060); this is the courteous half.
     --------------------------------------------------------------------- */
  const SESSION_KEY = 'jpc_hotel_booking_session';

  /** What makes this a DIFFERENT booking: the property, the rooms, the dates,
   *  the party, the extras and the coupon. Change any of them and it is a new
   *  submission deserving its own key. */
  function fingerprint() {
    return JSON.stringify({
      h: detail && detail.id,
      r: picks.map(p => p.id),
      i: shell.checkIn, o: shell.checkOut,
      g: (guestData.party || []).length,
      a: addons.slice().sort(),
      c: couponCode || null,
    });
  }

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  }
  function writeSession(v) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  }

  function newKey() {
    try {
      if (window.crypto && crypto.randomUUID) return 'hb_' + crypto.randomUUID();
    } catch { /* fall through */ }
    return 'hb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  /** The session for the choices currently on screen, creating one if these
   *  choices have not been submitted before. */
  function session() {
    const fp = fingerprint();
    let s = readSession();
    if (!s || s.fp !== fp) {
      s = { fp: fp, key: newKey(), ref: null };
      writeSession(s);
    }
    return s;
  }

  /** The reference already produced for these exact choices, if any. */
  function existingRef() {
    const s = readSession();
    return (s && s.fp === fingerprint() && s.ref) ? s.ref : null;
  }

  function nights() {
    const a = shell && shell.checkIn ? new Date(shell.checkIn) : null;
    const b = shell && shell.checkOut ? new Date(shell.checkOut) : null;
    if (!a || !b || isNaN(a) || isNaN(b)) return 1;
    return Math.max(1, Math.round((b - a) / 86400000));
  }
  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-IN',
      { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }
  function heroSlug() {
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
    return (detail.image && known[detail.image]) ? detail.image
      : (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');
  }
  const imgDir = () => (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
  const signedIn = () => typeof BookingApi !== 'undefined' && BookingApi.isSignedIn();
  const methodLabel = id => (methods.find(m => m.id === id) || {}).name || id;

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */
  function methodsHtml() {
    if (!methods.length) {
      return `<div class="hr-skeleton hr-skeleton-line"></div>`;
    }
    return `
      <div class="hr-paylist" role="radiogroup" aria-labelledby="hrPayHead">
        ${methods.map(m => `
          <label class="hr-pay ${chosen === m.id ? 'is-on' : ''}">
            <input type="radio" name="hrPayMethod" value="${esc(m.id)}"
                   ${chosen === m.id ? 'checked' : ''} ${busy ? 'disabled' : ''}>
            <span class="hr-pay-body">
              <b>${esc(m.name)}</b>
              ${m.note ? `<span>${esc(m.note)}</span>` : ''}
            </span>
          </label>`).join('')}
      </div>`;
  }

  /** The notice is the most important thing on this screen, so it is not a
   *  footnote — it sits above the choice and says plainly what will and will
   *  not happen. */
  function noticeHtml() {
    if (gatewayConfigured) return '';
    return `
      <div class="hr-paynotice">
        ${icon('shield')}
        <div>
          <b>Demo checkout — no payment gateway is connected yet.</b>
          <span>
            Choose how you intend to pay and we will confirm the booking. No card
            details are collected and <em>nothing is charged</em>: the payment is
            recorded against your booking, which stays <em>pending</em> until
            payment is arranged with you directly. The same is true of flights.
          </span>
        </div>
      </div>`;
  }

  function signInHtml() {
    if (signedIn()) return '';
    return `
      <div class="hr-paynotice is-warn">
        ${icon('person')}
        <div>
          <b>Sign in to confirm this booking.</b>
          <span>
            A booking reference is issued by our booking system against your
            account, so we need you signed in before we can create one.
          </span>
        </div>
        <button type="button" class="hr-btn hr-btn-primary" id="hrPaySignIn">Sign in</button>
      </div>`;
  }

  /** Shown when this exact booking has already been submitted — reached by
   *  Back from Confirmation, or by a reload. The primary action becomes a way
   *  to SEE the booking, never a way to make a second one. */
  function alreadyHtml() {
    const ref = existingRef();
    if (!ref) return '';
    return `
      <div class="hr-paynotice is-done">
        ${icon('check')}
        <div>
          <b>Booking already submitted.</b>
          <span>
            This stay has already been sent to us as booking
            <strong>${esc(ref)}</strong>. Nothing further is needed, and
            pressing anything here will not create a second booking.
          </span>
        </div>
        <button type="button" class="hr-btn hr-btn-primary" data-view-booking="${esc(ref)}">
          View booking
        </button>
      </div>`;
  }

  function paintMain() {
    const main = $('hpMain');
    if (!main) return;
    main.innerHTML = `
      <button type="button" class="hr-backlink" data-pay-back>
        ${icon('chevron', 'hr-back-ico')} Back to Review
      </button>
      <div class="hr-hd-head">
        <div class="hr-name-row"><h1 class="hr-hd-name">Complete your booking</h1></div>
        <p class="hr-panel-note">Choose how you intend to pay for this stay.</p>
      </div>

      ${alreadyHtml()}
      ${existingRef() ? '' : signInHtml()}
      ${existingRef() || gatewayLive ? '' : noticeHtml()}

      ${existingRef() ? '' : (gatewayLive ? `
      <section class="hr-rvsec" aria-labelledby="hrPayHead">
        <div class="hr-rvsec-head"><h2 id="hrPayHead">Payment</h2></div>
        <div class="hr-rvsec-body"><div id="hpGatewayHost"></div></div>
      </section>` : `
      <section class="hr-rvsec" aria-labelledby="hrPayHead">
        <div class="hr-rvsec-head"><h2 id="hrPayHead">Payment method</h2></div>
        <div class="hr-rvsec-body" id="hrPayBody">${methodsHtml()}</div>
      </section>`)}

      ${submitError ? `
        <div class="hr-pricechange" role="alert">
          ${icon('shield')}
          <div><b>We couldn't confirm your booking.</b><span>${esc(submitError)}</span></div>
        </div>` : ''}`;
  }

  function summaryHtml() {
    const n = nights();
    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <img class="hr-sum-thumb" src="${esc(imgDir() + heroSlug() + '-480.webp')}" alt="" loading="lazy">
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
          <div class="hr-sum-meta">${picks.length} Room${picks.length > 1 ? 's' : ''} · ${(guestData.party || []).length} Guest${(guestData.party || []).length > 1 ? 's' : ''}</div>
          <div class="hr-sum-meta">${n} Night${n > 1 ? 's' : ''}</div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Price Details</div>
          ${quote ? `
            ${(quote.lines || []).map(l => {
              const neg = Number(l.amount) < 0;
              return `<div class="hr-sum-line ${neg ? 'is-discount' : ''}">
                <span>${esc(l.label)}</span>
                <b>${neg ? '−' : ''}${esc(rupees(Math.abs(Number(l.amount))))}</b></div>`;
            }).join('')}
            <div class="hr-sum-total">
              <span class="hr-sum-total-label">Amount due</span>
              <span class="hr-sum-total-value">${esc(rupees(quote.total_amount))}</span>
            </div>
            <span class="hr-sum-note">
              Inclusive of all taxes. Not charged today — see the note on the left.
            </span>` : `<div class="hr-sum-line"><span>Pricing…</span><b>—</b></div>`}
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
    const done = existingRef();
    if (done) {
      return `
      <div class="hr-actionbar-inner">
        <div class="hr-ab-item hr-ab-hide-sm">${icon('check')}
          <div><b>Booking ${esc(done)}</b><span>Already submitted</span></div></div>
        <div class="hr-ab-total">
          <b>${quote ? esc(rupees(quote.total_amount)) : '—'}</b>
          <span>Payment pending</span>
        </div>
        <div class="hr-ab-cta">
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg"
                  data-view-booking="${esc(done)}">View booking</button>
          <span>This stay has already been submitted</span>
        </div>
      </div>`;
    }
    const ready = !!chosen && !!quote && !busy && signedIn();
    let note;
    if (!signedIn()) note = 'Sign in to continue';
    else if (gatewayLive) note = 'Pay securely in the panel above';
    else if (busy) note = 'Confirming your booking…';
    else if (!chosen) note = 'Choose a payment method';
    else note = 'Demo checkout — nothing is charged';

    return `
      <div class="hr-actionbar-inner">
        <div class="hr-ab-item hr-ab-hide-sm">${icon('shield')}
          <div><b>${esc(detail.name)}</b><span>${esc(detail.location)}</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item">${icon('calendar')}
          <div><b>${esc(fmtDay(shell.checkIn))} → ${esc(fmtDay(shell.checkOut))}</b>
          <span>${nights()} night${nights() > 1 ? 's' : ''}</span></div></div>
        <div class="hr-ab-total">
          <b>${quote ? esc(rupees(quote.total_amount)) : '—'}</b>
          <span>Amount due</span>
        </div>
        <div class="hr-ab-cta">
          ${gatewayLive ? '' : `
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg" id="hpPayNow"
                  ${ready ? '' : 'disabled'}>
            ${busy ? 'Confirming…' : 'Pay now'}
          </button>`}
          <span>${esc(note)}</span>
        </div>
      </div>`;
  }

  function paintChrome() {
    const HR = typeof HotelResults !== 'undefined' ? HotelResults : null;
    const sb = $('hpSearchbar');
    if (sb && HR && HR.searchbarHtml) sb.innerHTML = HR.searchbarHtml();
    const st = $('hpStepper');
    if (st && HR && HR.stepperHtml) st.innerHTML = HR.stepperHtml(6);
  }
  function paintSummary() {
    const el = $('hpSummary');
    if (el && detail) el.innerHTML = summaryHtml();
  }
  function paintActionbar() {
    const el = $('hrActionbar');
    if (el && detail) { el.innerHTML = actionbarHtml(); el.hidden = false; }
  }
  function paint() { paintChrome(); paintMain(); paintSummary(); paintActionbar(); }

  /* ---------------------------------------------------------------------
     Submit — the only thing on this screen that writes anything.
     --------------------------------------------------------------------- */
  /* ---------------------------------------------------------------------
     THE BOOKING, WRITTEN THE SAME WAY ON BOTH PATHS.
     The demo path and the gateway path differ in exactly one thing: what they
     say about payment. The stay, the guests, the addons, the coupon and above
     all the idempotency key are identical, so a hotel booked with a provider
     configured is the same row as one booked without. Sharing this function is
     what keeps that true -- two copies would drift, and the drift would show
     up as a booking that reconciles for one product and not the other.
     --------------------------------------------------------------------- */
  async function createBooking(payment, sess) {
    /* Created through BookingStore, not BookingApi directly. The store makes
       the booking, logs the payment attempt against it, and -- the part that
       matters here -- normalises the API response into the shape every
       downstream screen already reads. Handing the raw response on instead
       left the confirmation screen with no reference and a zero total, and it
       fell back to calling a real server booking a demo one. */
    const created = await BookingStore.create({
      kind: 'hotel',
      payment,
      apiPayload: {
      /* Same key on every retry of this submission, so the server returns
         the booking it already made instead of making another. */
      idempotency_key: sess.key,
      stay: {
        hotel_id: Number(detail.id),
        room_id: Number(picks[0].id),
        room_ids: picks.map(p => Number(p.id)),
        check_in: shell.checkIn,
        check_out: shell.checkOut,
        rooms_count: picks.length,
        adults: (guestData.party || []).filter(g => g.kind === 'adult').length || 1,
        children: (guestData.party || []).filter(g => g.kind === 'child').length,
        child_ages: (guestData.party || []).filter(g => g.kind === 'child').map(g => g.age),
      },
      guests: guestData.guests || [],
      addons: addons.map(code => ({ code })),
      special_requests: guestData.special_requests || [],
      notes: guestData.notes || null,
      coupon_code: couponCode || null,
      },
    });
    /* Remember what this submission produced BEFORE navigating, so a Back
       into this screen finds it. */
    writeSession({ fp: sess.fp, key: sess.key, ref: created.id || created.booking_ref || null });
    return created;
  }

  /* ---------------------------------------------------------------------
     THE GATEWAY PATH.
     A deliberate mirror of mountGatewayScreen() in booking-products.js, which
     is the sequence already collecting real money for packages and flights:
     write the booking FIRST so a reference exists, open the provider order
     against that reference, then hand the screen to JPay. Three details look
     incidental and are not:

       * `method: null`, NOT 'gateway'. /pay accepts card, debit, upi, netbank
         and wallet only, so 'gateway' 400s on every booking -- and it did,
         silently, until the packages path was fixed. The method a customer
         really used is written later, from the provider's own answer.
       * the SAME idempotency key the demo path uses, so a retry, a reload or
         a second click resolves to one booking and one order.
       * `amountMinor` comes from the PROVIDER's echo, never from `quote`. If
         those two ever disagree, the figure shown must be the one the provider
         will actually charge.
     --------------------------------------------------------------------- */
  async function mountGateway() {
    if (gatewayMounted) return;
    const host = $('hpGatewayHost');
    if (!host) return;
    gatewayMounted = true;

    if (typeof JPay === 'undefined') {
      host.innerHTML = '<div class="hr-pricechange" role="alert">'
        + '<div><b>Payment is unavailable.</b><span>The payment screen could not '
        + 'be loaded. Please refresh and try again.</span></div></div>';
      return;
    }

    /* A placeholder while the booking is written, so the panel is never blank. */
    host.innerHTML = '<div class="jpay"><div class="jpay-status">'
      + '<div class="jpay-status-icon is-wait"><div class="jpay-spinner"></div></div>'
      + '<h3>Preparing your payment</h3><p>Just a moment.</p></div></div>';

    const sess = session();
    try {
      let ref = existingRef();
      if (!ref) {
        const created = await createBooking(
          { method: null, methodLabel: 'UPI / Razorpay',
            amount: quote && quote.total_amount, simulated: false }, sess);
        ref = created.id || created.booking_ref;
      }
      if (!ref) throw new Error('The booking could not be created.');

      const checkout = await BookingApi.startHotelCheckout(ref, sess.key);
      paintActionbar();

      JPay.mount(host, {
        bookingRef: ref,
        packageName: (detail && detail.name) || 'your stay',
        amountMinor: checkout.amount,
        checkout: checkout,

        /* RECONCILE FIRST, then a plain read.

           Asking the server to re-check with the provider is what lets this
           finish where no webhook can arrive -- a laptop that sleeps, or a
           delivery that is late or lost. It runs the SAME verifier the webhook
           runs, so nothing is trusted here that would not be trusted there.
           A reconcile failure is not fatal: it can 503 while the provider is
           briefly unreachable, and a webhook may already have confirmed the
           booking, so the plain read below still runs. */
        pollStatus: async (handler) => {
          let st = '';
          try {
            const r = await BookingApi.reconcileHotelBooking(ref, handler);
            st = String((r && r.booking_status) || '').toLowerCase();
          } catch {
            st = '';
          }
          if (!st) {
            const b = await BookingApi.getHotelBooking(ref);
            st = String((b && b.status) || '').toLowerCase();
          }
          if (st === 'confirmed' || st === 'completed') return 'confirmed';
          if (st === 'cancelled') return 'cancelled';
          return 'pending';
        },
        onRetry: async () => BookingApi.startHotelCheckout(ref, sess.key),
        onDone: () => { if (handlers.viewBooking) handlers.viewBooking(ref); },
      });
    } catch (err) {
      const msg = (BookingApi.errorText && BookingApi.errorText(err))
        || 'We could not start the payment.';
      host.innerHTML = '<div class="hr-pricechange" role="alert">'
        + '<div><b>We could not start the payment.</b><span>' + esc(msg)
        + '</span></div></div>';
    }
  }

  async function payNow() {
    if (busy || !chosen || !quote) return;
    if (!signedIn()) { openSignIn(); return; }

    /* Already submitted — go and look at it rather than making a second one.
       This is the guard for Back-from-Confirmation and for a reload; the
       double-click case is caught by `busy` a line above. */
    const already = existingRef();
    if (already) { if (handlers.viewBooking) handlers.viewBooking(already); return; }

    const sess = session();
    busy = true; submitError = null;
    paintMain(); paintActionbar();

    try {
      const created = await createBooking(
        { method: chosen, methodLabel: methodLabel(chosen) }, sess);
      busy = false;
      if (handlers.done) handlers.done(created, { method: chosen });
    } catch (err) {
      busy = false;
      submitError = (BookingApi.errorText && BookingApi.errorText(err))
        || 'Something went wrong at our end. Please try again in a moment.';
      paintMain(); paintActionbar();
      const box = document.querySelector('#hpMain .hr-pricechange');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function openSignIn() {
    /* The site's own dialog, not a second one. `?signin=1` is the documented
       way every service page asks for it. */
    if (typeof openAuth === 'function') { openAuth('login'); return; }
    if (typeof AccountCenter !== 'undefined' && AccountCenter.open) { AccountCenter.open(); return; }
    location.href = `${location.pathname}${location.search}${location.search ? '&' : '?'}signin=1`;
  }

  /* ---------------------------------------------------------------------
     Events
     --------------------------------------------------------------------- */
  function bind() {
    if (bound) return;
    const root = $('hpRoot');
    if (!root) return;
    bound = true;

    root.addEventListener('click', e => {
      if (e.target.closest('[data-pay-back]')) { if (handlers.back) handlers.back(); return; }
      if (e.target.closest('#hrPaySignIn')) { openSignIn(); return; }
      const view = e.target.closest('[data-view-booking]');
      if (view) {
        if (handlers.viewBooking) handlers.viewBooking(view.getAttribute('data-view-booking'));
        return;
      }
      if (e.target.closest('#hrModify')) {
        if (typeof HotelResults !== 'undefined' && HotelResults.modifySearch) HotelResults.modifySearch();
      }
    });

    root.addEventListener('change', e => {
      const r = e.target.closest('[name="hrPayMethod"]');
      if (!r) return;
      chosen = r.value;
      const body = $('hrPayBody');
      if (body) body.innerHTML = methodsHtml();
      paintActionbar();
    });

    const bar = $('hrActionbar');
    if (bar) bar.addEventListener('click', e => {
      const view = e.target.closest('[data-view-booking]');
      if (view) {
        if (handlers.viewBooking) handlers.viewBooking(view.getAttribute('data-view-booking'));
        return;
      }
      if (e.target.closest('#hpPayNow')) payNow();
    });
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  async function show(hotelRow, sharedState, hs, data) {
    shell = sharedState || {};
    picks = (data && data.picks) || [];
    guestData = (data && data.guestData) || { party: [], guests: [] };
    addons = (data && data.addons) || [];
    couponCode = (data && data.couponCode) || null;
    quote = (data && data.quote) || null;
    handlers = hs || {};
    submitError = null;
    busy = false;
    gatewayMounted = false;

    const root = $('hpRoot');
    if (root) root.hidden = false;
    bind();

    if (!detail || String(detail.id) !== String(hotelRow.id)) {
      try { detail = await BookingApi.getHotelDetail(hotelRow.id); }
      catch {
        detail = { id: hotelRow.id, name: hotelRow.name, location: hotelRow.location,
                   stars: hotelRow.stars, image: hotelRow.imageKey };
      }
    }
    paint();

    /* The method list and whether a gateway exists at all are the SERVER's
       answer, not a hardcoded list here. */
    try {
      const res = await BookingApi.paymentMethods();
      methods = (res && res.methods) || [];
      gatewayConfigured = !!(res && res.gateway_configured);
    } catch {
      methods = [];
      gatewayConfigured = false;
    }

    /* Whether a provider would ACTUALLY collect -- a different question from
       `gateway_configured`, and the one that decides whether this screen shows
       a real checkout or the demo picker.

       Asked WITHOUT a booking reference, because the booking does not exist
       yet: this screen is what creates it. A booking routed to a provider by
       reference alone -- a pilot -- therefore still sees the demo screen here,
       which is precisely why a per-reference pilot is a testing scaffold and
       not a shipping configuration. */
    try {
      const cfg = await BookingApi.paymentConfig();
      gatewayLive = !!(cfg && cfg.configured && cfg.key_id);
    } catch {
      gatewayLive = false;
    }

    paintMain();
    paintActionbar();
    if (gatewayLive) mountGateway();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function hide() {
    const root = $('hpRoot');
    if (root) root.hidden = true;
  }

  return { show, hide };
})();
