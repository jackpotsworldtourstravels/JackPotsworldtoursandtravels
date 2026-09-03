/* ===========================================================================
   JackPots World — branded payment screen (Phase 4)

   WHAT THIS FILE DOES, AND THE ONE THING IT REFUSES TO DO

   It renders our own screen — the amount in rupees, the method, what is about
   to happen — and then hands the customer to Razorpay's checkout to actually
   authorise the payment. It never sees a UPI PIN, a card number, a CVV or a
   bank password, because it never asks for one: there is no input element in
   this file that could take a credential, and Razorpay's checkout draws itself
   over the page rather than inside anything we control.

   AND IT NEVER DECIDES THAT A PAYMENT SUCCEEDED.
   Razorpay's `handler` callback fires in the customer's browser. A browser can
   be closed at that moment, scripted, or simply lied to. So the callback does
   exactly one thing here: it switches the screen to "Payment Processing" and
   starts asking OUR server whether the booking has been confirmed. The answer
   comes from the webhook path, server-side, or it does not come at all.

   WHY THERE IS NO PHONEPE / GOOGLE PAY / PAYTM BUTTON

   Because a browser cannot know. Razorpay documents that
   `getSupportedUpiIntentApps` and `getAppsWhichSupportUpi` are Android-native
   SDK calls — there is no web equivalent — and that its own checkout shows the
   top PSP apps "irrespective of the installation status". Rendering three
   branded tiles here would therefore be a guess dressed as a fact, and tapping
   one that is not installed is a dead end the customer would blame on us.

   What this screen CAN say truthfully is what Razorpay documents about the
   device it is running on:

       desktop  -> "UPI Intent is not supported. A QR code is displayed."
       mobile   -> UPI Intent; Razorpay shows the app tray.

   That is the only device-dependent claim made below, and it comes from the
   same rule Razorpay implements. The actual list of apps is drawn by Razorpay,
   inside Razorpay, from what the device actually has.

   UPI COLLECT IS NOT IMPLEMENTED AND CANNOT BE.
   NPCI withdrew it for merchant payments on 28 February 2026. There is no
   "enter your UPI ID" field anywhere in this file, and adding one would be
   both non-compliant and useless.
   =========================================================================== */

const JPay = (function () {
  'use strict';

  const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

  /* The seven states the screen can be in. Named rather than boolean-flagged so
     an impossible combination (processing AND failed) cannot be represented. */
  const STATE = {
    READY: 'ready',            // 1. Ready to Pay
    OPENING: 'opening',        // 2. Opening Payment
    PROCESSING: 'processing',  // 3. Payment Processing (backend confirming)
    SUCCESS: 'success',        // 4. Payment Successful
    FAILED: 'failed',          // 5. Payment Failed
    CANCELLED: 'cancelled',    // 6. Payment Cancelled
    PENDING: 'pending',        // 7. Payment Pending (taking longer than expected)
  };

  /* How long we keep asking our own server before telling the customer it is
     taking longer than usual. Not a timeout on the PAYMENT — the payment is
     Razorpay's business and may still land; this is a timeout on the spinner. */
  const POLL_EVERY_MS = 2500;
  const POLL_FOR_MS = 90000;

  let scriptPromise = null;

  /* ---------------------------------------------------------------------
     Utilities
     --------------------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** Paise to a rupee string with Indian digit grouping. */
  function rupees(minor) {
    const value = Number(minor || 0) / 100;
    try {
      return '₹' + value.toLocaleString('en-IN', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
    } catch {
      return '₹' + value.toFixed(2);
    }
  }

  /** Is this a device Razorpay will offer UPI Intent on?
   *
   *  Razorpay's rule, quoted: "On Desktop Web, UPI Intent is not supported, a
   *  QR code is automatically displayed instead." So the question is only
   *  whether this is a phone, and the answer decides which sentence we show —
   *  never which apps, which we cannot know. */
  function isMobileDevice() {
    try {
      if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
        return navigator.userAgentData.mobile;
      }
    } catch { /* fall through */ }
    return /android|iphone|ipad|ipod|windows phone/i.test(navigator.userAgent || '');
  }

  /** Load Razorpay's checkout script once, on demand.
   *
   *  Loaded here rather than in every page's <head> so a page that never
   *  reaches payment never fetches a third-party script — and so a customer
   *  who never pays is never announced to Razorpay. */
  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve(true);
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = CHECKOUT_SRC;
      el.async = true;
      el.onload = () => resolve(true);
      el.onerror = () => {
        scriptPromise = null;
        reject(new Error('Could not load the payment checkout.'));
      };
      document.head.appendChild(el);
    });
    return scriptPromise;
  }

  /* ---------------------------------------------------------------------
     Markup
     --------------------------------------------------------------------- */
  function iconLock() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
  }

  function iconPhone() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg>`;
  }

  function iconQr() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v3M17 20h4"/></svg>`;
  }

  function iconTick() {
    return `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5"/></svg>`;
  }

  function iconCross() {
    return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12"/></svg>`;
  }

  function amountCard(s) {
    return `
      <div class="jpay-amount-card">
        <div class="jpay-brand"><span class="jpay-brand-dot"></span>JackPots World Tours &amp; Travels</div>
        <div class="jpay-amount-label">Amount payable</div>
        <div class="jpay-amount">${esc(rupees(s.amountMinor))}</div>
        <div class="jpay-amount-sub">${esc(s.packageName || 'Tour package')}</div>
        ${s.bookingRef ? `<div class="jpay-ref">${esc(s.bookingRef)}</div>` : ''}
      </div>`;
  }

  /** The one device-dependent sentence, and its source. */
  function howToBlock() {
    const mobile = isMobileDevice();
    return `
      <div class="jpay-howto">
        <span class="jpay-howto-icon">${mobile ? iconPhone() : iconQr()}</span>
        <div>
          <b>${mobile ? 'You will choose your UPI app' : 'You will scan a QR code'}</b>
          <p>${mobile
            ? 'Razorpay opens your installed UPI apps so you can approve the payment there. '
              + 'We never see your UPI PIN.'
            : 'Razorpay shows a QR code to scan with any UPI app on your phone. '
              + 'Approve it in the app — we never see your UPI PIN.'}</p>
        </div>
      </div>`;
  }

  function readyView(s) {
    return `
      <div class="jpay">
        ${amountCard(s)}
        <h2 class="jpay-title">Complete your UPI payment</h2>
        <p class="jpay-sub">Choose how you would like to pay. You will approve the payment
           inside your bank or UPI app — never on this page.</p>
        ${s.error ? `<div class="jpay-error" role="alert">${esc(s.error)}</div>` : ''}
        <div class="jpay-methods" role="radiogroup" aria-label="Payment method">
          <label class="jpay-method is-on">
            <input type="radio" name="jpayMethod" value="upi" checked>
            <span class="jpay-method-body">
              <b>UPI</b>
              <span>Pay from any UPI app — Razorpay shows the ones available on your device.</span>
            </span>
            <span class="jpay-method-tag">Recommended</span>
          </label>
          <label class="jpay-method">
            <input type="radio" name="jpayMethod" value="other">
            <span class="jpay-method-body">
              <b>Other payment methods</b>
              <span>Cards, net banking and wallets, if enabled on this account.
                    Razorpay shows exactly what is available.</span>
            </span>
          </label>
        </div>
        ${howToBlock()}
        <div class="jpay-actions">
          <button type="button" class="jpay-cta" data-jpay-pay>
            Pay ${esc(rupees(s.amountMinor))}
          </button>
        </div>
        <div class="jpay-secure">${iconLock()} Payments are processed securely by Razorpay</div>
      </div>`;
  }

  function statusView(s) {
    const views = {
      [STATE.OPENING]: {
        cls: 'is-wait', icon: '<div class="jpay-spinner"></div>',
        h: 'Opening payment', p: 'Taking you to the secure checkout…',
      },
      [STATE.PROCESSING]: {
        cls: 'is-wait', icon: '<div class="jpay-spinner"></div>',
        h: 'Payment processing',
        p: 'We are confirming your payment with the bank. This usually takes a few '
           + 'seconds — please do not close this page.',
      },
      [STATE.PENDING]: {
        cls: 'is-wait', icon: '<div class="jpay-spinner"></div>',
        h: 'Payment processing',
        p: 'This is taking longer than usual. Your payment may still be going through — '
           + 'we will confirm your booking as soon as the bank tells us. '
           + 'You can safely check My Trips in a few minutes.',
      },
      [STATE.CANCELLED]: {
        cls: 'is-bad', icon: iconCross(),
        h: 'Payment cancelled',
        p: 'You closed the payment window before it finished. '
           + 'Nothing has been charged and your booking is still held.',
      },
      [STATE.FAILED]: {
        cls: 'is-bad', icon: iconCross(),
        h: 'Payment unsuccessful',
        p: s.error || 'The payment did not go through. Nothing has been charged.',
      },
    }[s.state];

    if (!views) return '';

    const retry = (s.state === STATE.FAILED || s.state === STATE.CANCELLED)
      ? `<div class="jpay-actions">
           <button type="button" class="jpay-cta" data-jpay-retry>Try payment again</button>
         </div>`
      : '';

    return `
      <div class="jpay">
        ${amountCard(s)}
        <div class="jpay-status">
          <div class="jpay-status-icon ${views.cls}">${views.icon}</div>
          <h3>${esc(views.h)}</h3>
          <p>${esc(views.p)}</p>
        </div>
        ${retry}
      </div>`;
  }

  /** The only screen that may say the money arrived — and it is only reachable
   *  when OUR SERVER has said the booking is confirmed. */
  function successView(s) {
    return `
      <div class="jpay">
        <div class="jpay-status">
          <div class="jpay-status-icon is-ok">${iconTick()}</div>
          <h3>Payment successful</h3>
          <p>Your booking is confirmed. A confirmation has been saved to My Trips.</p>
        </div>
        <dl class="jpay-summary">
          <div class="jpay-summary-row"><dt>Booking ID</dt><dd>${esc(s.bookingRef || '—')}</dd></div>
          <div class="jpay-summary-row"><dt>Package</dt><dd>${esc(s.packageName || '—')}</dd></div>
          <div class="jpay-summary-row"><dt>Amount</dt><dd class="num">${esc(rupees(s.amountMinor))}</dd></div>
          <div class="jpay-summary-row"><dt>Payment status</dt><dd class="is-paid">Paid</dd></div>
        </dl>
        <div class="jpay-actions">
          <button type="button" class="jpay-cta" data-jpay-done>View my trip</button>
        </div>
      </div>`;
  }

  function viewFor(s) {
    if (s.state === STATE.READY) return readyView(s);
    if (s.state === STATE.SUCCESS) return successView(s);
    return statusView(s);
  }

  /* ---------------------------------------------------------------------
     The screen
     --------------------------------------------------------------------- */
  /**
   * @param {HTMLElement} root       where to draw
   * @param {object} opts
   *   bookingRef, packageName, amountMinor  what is being paid
   *   checkout   {provider, order_id, amount, currency, key_id, options}
   *   pollStatus async () => 'confirmed' | 'pending' | 'cancelled'
   *   onDone     called when the customer leaves a terminal screen
   *   onRetry    async () => a FRESH checkout object, for Try again
   */
  function mount(root, opts) {
    const s = {
      state: STATE.READY,
      error: null,
      bookingRef: opts.bookingRef,
      packageName: opts.packageName,
      amountMinor: opts.amountMinor,
      checkout: opts.checkout,
    };
    let pollTimer = null;
    let pollStartedAt = 0;

    /* Razorpay's handler payload, when the browser still has it. */
    let lastHandler = null;

    function render() {
      root.innerHTML = viewFor(s);
      bind();
    }

    function to(state, error) {
      s.state = state;
      s.error = error || null;
      render();
    }

    function bind() {
      root.querySelectorAll('.jpay-method input').forEach(input => {
        input.addEventListener('change', () => {
          root.querySelectorAll('.jpay-method').forEach(l => {
            l.classList.toggle('is-on', l.contains(input) && input.checked);
          });
        });
      });
      const pay = root.querySelector('[data-jpay-pay]');
      if (pay) pay.addEventListener('click', () => { pay.disabled = true; openCheckout(); });
      const retry = root.querySelector('[data-jpay-retry]');
      if (retry) retry.addEventListener('click', () => { retry.disabled = true; restart(); });
      const done = root.querySelector('[data-jpay-done]');
      if (done && opts.onDone) done.addEventListener('click', () => opts.onDone());
    }

    async function restart() {
      to(STATE.OPENING);
      try {
        /* A retry asks the server for a checkout again. Because the request
           carries the same idempotency key, the server returns the order it
           already opened rather than a second one — so "Try again" cannot
           produce two orders for one booking. */
        s.checkout = await opts.onRetry();
        openCheckout();
      } catch (err) {
        to(STATE.FAILED, (err && err.message) || 'Could not restart the payment.');
      }
    }

    async function openCheckout() {
      to(STATE.OPENING);
      let Razorpay;
      try {
        await loadCheckout();
        Razorpay = window.Razorpay;
        if (!Razorpay) throw new Error('The payment checkout did not load.');
      } catch (err) {
        to(STATE.FAILED, 'We could not load the secure checkout. Check your connection and try again.');
        return;
      }

      const c = s.checkout || {};
      const options = Object.assign({}, c.options || {}, {
        /* PUBLISHABLE KEY ONLY. The key secret and the webhook secret live on
           the server and are never sent to a browser — there is no field in
           the checkout response that could carry one. */
        key: c.key_id,
        /* Both come from the server, which read them off the booking row. The
           browser is echoing them back to Razorpay, not choosing them: the
           order was already created for this exact figure, and Razorpay
           charges the order, not this number. */
        amount: c.amount,
        currency: c.currency || 'INR',
        order_id: c.order_id,

        /* NOT AUTHORITATIVE. See the file header.
           The response IS passed on now, but only as corroboration: the server
           checks its signature against the order id IT stored and then asks the
           provider anyway. Nothing here decides that a payment succeeded. */
        handler: function (response) {
          beginConfirming(response);
        },
        modal: {
          ondismiss: function () {
            /* Closing the window is not a failure — nothing was charged, and
               the booking is still held. Said plainly so the customer does not
               think they have lost their place. */
            to(STATE.CANCELLED);
          },
        },
      });

      try {
        const rzp = new Razorpay(options);
        /* Razorpay's own failure event. Carries a description written for
           developers, so it is not shown verbatim. */
        if (typeof rzp.on === 'function') {
          rzp.on('payment.failed', function () {
            to(STATE.FAILED, 'The payment did not go through. Nothing has been charged.');
          });
        }
        rzp.open();
      } catch (err) {
        to(STATE.FAILED, 'We could not open the secure checkout. Please try again.');
      }
    }

    /** Razorpay says it is done. We do not believe it yet — we ask our server.
     *
     *  This is the whole point of the design: the browser's word starts a
     *  question, it does not provide an answer. The answer arrives when the
     *  webhook has been verified server-side and the booking has moved. */
    function beginConfirming(handlerResponse) {
      /* Held for the poll below. A reload loses it, which is why the server
         treats every field as optional and reconciles the same way without it. */
      lastHandler = handlerResponse || null;
      to(STATE.PROCESSING);
      pollStartedAt = Date.now();
      clearTimeout(pollTimer);
      askServer();
    }

    async function askServer() {
      if (!opts.pollStatus) return;
      let status = 'pending';
      try {
        status = await opts.pollStatus(lastHandler);
      } catch {
        status = 'pending';   // a hiccup is not a failure
      }

      if (status === 'confirmed') { clearTimeout(pollTimer); to(STATE.SUCCESS); return; }
      if (status === 'cancelled') { clearTimeout(pollTimer); to(STATE.FAILED); return; }

      if (Date.now() - pollStartedAt > POLL_FOR_MS) {
        /* Still not confirmed. NOT reported as a failure — the money may well
           have moved and the confirmation may be seconds away. Saying "failed"
           here would be the same lie as saying "paid", in the other direction. */
        if (s.state !== STATE.PENDING) to(STATE.PENDING);
        return;
      }
      pollTimer = setTimeout(askServer, POLL_EVERY_MS);
    }

    render();

    return {
      destroy() { clearTimeout(pollTimer); },
      state() { return s.state; },
    };
  }

  return { mount, STATE, rupees, isMobileDevice, loadCheckout };
})();

if (typeof window !== 'undefined') window.JPay = JPay;
