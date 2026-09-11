/* ===========================================================================
   ONE PAYMENT OPENER FOR EVERY SCREEN THAT LISTS A BOOKING.

   Four screens can start a payment, and they divide cleanly in two:

     * The booking FLOW -- booking-products.js for packages and flights,
       hotel-payment.js for hotels -- has no booking yet. It must write one
       before a provider has anything to open an order against, so it keeps its
       own lead-in and calls JPay itself.

     * The screens that LIST bookings -- my-bookings.html and the account-centre
       panel -- are handed a booking that already exists. Their logic was
       identical, and a fourth hand-written copy was about to be added to the
       panel. It lives here once instead.

   WHY THAT MATTERS MORE THAN TIDINESS.
   Each copy of this sequence carries the same three easily-lost details: the
   amount must come from the provider's echo and never from a local total; the
   idempotency key must not vary, or a second click opens a second order against
   one booking; and the status poll must reconcile before it reads, or a payment
   whose webhook never arrives waits forever. Copies drift on exactly those
   points, and the drift is invisible until somebody is charged twice.
   =========================================================================== */

const BookingPay = (function () {

  /* The endpoint set per product. A product belongs here only once it has BOTH
     a checkout and a reconcile endpoint on the server; listing one without
     them draws a Pay button that can only fail. Cruises have neither. */
  const API = {
    package: {
      checkout: (ref, key) => BookingApi.startPackageCheckout(ref, key),
      reconcile: (ref, handler) => BookingApi.reconcilePackageBooking(ref, handler),
      read: (ref) => BookingApi.getPackageBooking(ref),
    },
    flight: {
      checkout: (ref, key) => BookingApi.startFlightCheckout(ref, key),
      reconcile: (ref, handler) => BookingApi.reconcileFlightBooking(ref, handler),
      read: (ref) => BookingApi.getBooking(ref),
    },
    hotel: {
      checkout: (ref, key) => BookingApi.startHotelCheckout(ref, key),
      reconcile: (ref, handler) => BookingApi.reconcileHotelBooking(ref, handler),
      read: (ref) => BookingApi.getHotelBooking(ref),
    },
  };

  const supports = (kind) => !!API[kind];

  /* Derived from the reference and never varying, so a second click, a reload
     or a return visit all resolve to the one order rather than opening another
     against the same booking. The `mb-` prefix is kept because orders already
     exist under it; changing it would orphan them. */
  const keyFor = (ref) => `mb-${ref}`;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* A self-contained overlay, styled inline on purpose: this is mounted from
     the account panel on pages that never loaded booking.css, and a payment
     screen that depends on a stylesheet being present elsewhere is a payment
     screen that will one day render as unstyled text over a live checkout. */
  function makeOverlay() {
    const ov = document.createElement('div');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Payment');
    ov.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:100000', 'padding:24px',
      'overflow:auto', 'background:rgba(8,12,24,.72)',
      '-webkit-backdrop-filter:blur(2px)', 'backdrop-filter:blur(2px)',
    ].join(';');
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';
    return ov;
  }

  function closeOverlay(ov) {
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.style.overflow = '';
  }

  /**
   * Open a provider checkout for a booking that ALREADY EXISTS.
   *
   * @param {object} o
   *   ref           the booking reference
   *   kind          'package' | 'flight' | 'hotel'
   *   title         what to show the traveller they are paying for
   *   host          where to draw; omit to get a managed full-screen overlay
   *   onDone        called after the traveller leaves a terminal screen
   *   onUnavailable called with a message when payment cannot be offered
   *   onError       called with a message when opening the order failed
   */
  async function open(o) {
    const ref = o.ref;
    const api = API[o.kind];
    const say = o.onUnavailable || function () {};

    if (!api) {
      say('Online payment is not available for this booking yet.');
      return;
    }
    if (typeof JPay === 'undefined') {
      say('The payment screen could not be loaded. Please refresh and try again.');
      return;
    }

    /* THE REFERENCE IS THE POINT. paymentConfig() asked without one answers for
       the deployment as a whole; asked with this booking's reference it answers
       for this booking, which is the only question worth asking here. */
    let cfg;
    try {
      cfg = await BookingApi.paymentConfig(ref);
    } catch {
      say('We could not reach the payment service. Please try again.');
      return;
    }
    /* Both halves are required: a provider with no publishable key cannot open
       a checkout, and continuing would fail in front of the traveller. */
    if (!(cfg && cfg.configured && cfg.key_id)) {
      say('Online payment is not available for this booking yet.');
      return;
    }

    const managed = !o.host;
    const host = o.host || makeOverlay();

    /* Hidden until there is something only we can say. Razorpay covers the page
       with its own modal, so anything drawn here before that lands is a change
       to the traveller's screen that buys nothing. */
    const setChrome = (needed) => { host.style.display = needed ? 'block' : 'none'; };

    /* A borrowed host is not ours to leave altered. my-bookings.html lends the
       same overlay to its booking-detail modal, which shows itself with a CSS
       class -- an inline display left behind here would outrank that class and
       the detail modal would quietly stop opening, nowhere near this code. */
    const prevDisplay = managed ? '' : host.style.display;
    const finish = () => {
      if (managed) closeOverlay(host);
      else host.style.display = prevDisplay;
    };

    setChrome(false);

    const key = keyFor(ref);
    try {
      const checkout = await api.checkout(ref, key);
      JPay.mount(host, {
        /* Open the provider directly: this is a Pay button, and the traveller
           has already said they want to pay. */
        autoOpen: true,
        onChrome: setChrome,
        bookingRef: ref,
        packageName: o.title || ref,
        /* The PROVIDER's figure, echoed by our server -- never a local total. */
        amountMinor: checkout.amount,
        checkout: checkout,

        /* RECONCILE FIRST, then a plain read.

           Asking the server to re-check with the provider is what lets this
           finish where no webhook can arrive -- a laptop that sleeps, a delivery
           that is late or lost. It runs the SAME verifier the webhook runs, so
           nothing is trusted here that would not be trusted there. A reconcile
           failure is not fatal: it can 503 while the provider is briefly
           unreachable, and a webhook may already have confirmed the booking, so
           the plain read below still runs. */
        pollStatus: async (handler) => {
          let st = '';
          try {
            const r = await api.reconcile(ref, handler);
            st = String((r && r.booking_status) || '').toLowerCase();
          } catch {
            st = '';
          }
          if (!st) {
            const got = await api.read(ref);
            st = String((got && got.status) || '').toLowerCase();
          }
          if (st === 'confirmed' || st === 'completed') return 'confirmed';
          if (st === 'cancelled') return 'cancelled';
          return 'pending';
        },
        onRetry: async () => api.checkout(ref, key),
        onDone: async () => {
          finish();
          if (o.onDone) await o.onDone();
        },
      });
    } catch (err) {
      const msg = (typeof BookingApi !== 'undefined' && BookingApi.errorText)
        ? BookingApi.errorText(err, 'We could not start the payment.')
        : 'We could not start the payment.';
      if (o.onError) { finish(); o.onError(msg); return; }
      setChrome(true);
      host.innerHTML = '<div class="jpay"><div class="jpay-error" role="alert">'
        + esc(msg) + '</div><div class="jpay-actions">'
        + '<button type="button" class="jpay-cta" data-bkpay="close">Close</button>'
        + '</div></div>';
      const btn = host.querySelector('[data-bkpay="close"]');
      if (btn) btn.addEventListener('click', async () => {
        finish();
        if (o.onDone) await o.onDone();
      });
    }
  }

  return { open, supports, API, keyFor };
})();

if (typeof window !== 'undefined') window.BookingPay = BookingPay;
