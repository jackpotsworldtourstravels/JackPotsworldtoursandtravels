'use strict';
/* ===========================================================================
   The HDFC gateway order id on the payment SUCCESS screen.

   HDFC's verification request asks the final success page to show the order
   number. Our page already shows the Booking ID (our own reference); this adds
   the payment gateway's own order id next to it — but ONLY once the server has
   verified the payment, and ONLY from the server's reconcile answer, never from
   anything the browser was handed.

   Two source files cooperate:
     * booking-pay.js   pollStatus() reads r.gateway_order_id off the reconcile
                        response and passes it on as `gatewayOrderId`.
     * payment-screen.js  JPay keeps it on its state and successView() draws a
                        "Gateway order ID" row when it is present.

   There is no DOM test runner in this project (see the note in
   hotel-image-map.provider.test.js), so this is a self-contained Node harness,
   mirroring offers-strip.test.js. It:

     1. BEHAVIOURAL — extracts successView() and demoSuccessView() by
        brace-matching, renders each in a VM with tiny shims, and asserts the
        gateway-order-id row appears when (and only when) an id is present, and
        never on the demo screen (no money, no gateway).
     2. WIRING — asserts booking-pay.js reads r.gateway_order_id and returns
        gatewayOrderId, and payment-screen.js keeps it on state and fills it
        from the reconcile result.
     3. SAFETY/REGRESSION — asserts the id is taken only from the server's
        reconcile answer (never from the URL/location), and that successView is
        still the SUCCESS-only screen whose row is conditional, so nothing is
        shown before the payment is verified.

   run:  node frontend/tests/hdfc-success-order-id.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const SCREEN_JS = read('assets/js/payment-screen.js');
const PAY_JS = read('assets/js/booking-pay.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Pull one `function <name>(s) { ... }` out of a source file by matching braces
   from the opening brace to its close. Returns the whole declaration. */
function extractFn(src, name, label) {
  const sig = `function ${name}(s)`;
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${label}: ${name}() not found`); return null; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${label}: ${name}() braces did not balance`);
  return null;
}

/* Render an extracted view function against a state object, with the same
   helpers the real module gives it. esc mirrors the module's escaper so what
   we assert on is what the page writes. */
function renderView(fnSrc, name, state) {
  const sandbox = { String, out: null, state };
  const script = `
    const esc = s => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const successMark = () => '<tick/>';
    const rupees = (m, c) => '₹' + String(m) + (c ? ' ' + c : '');
    ${fnSrc}
    out = ${name}(state);
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox.out;
}

const GID = 'JP0123456789abcdef01';   // an HDFC-shaped gateway order id

(async () => {
  /* ---------------------------------------------------------------- *
   * 1. BEHAVIOURAL — successView() shows the gateway order id iff set
   * ---------------------------------------------------------------- */
  const successFn = extractFn(SCREEN_JS, 'successView', 'payment-screen.js');
  if (successFn) {
    const withId = renderView(successFn, 'successView', {
      bookingRef: 'JPH000777', packageName: 'Goa Getaway',
      amountMinor: 5600, currency: 'INR', gatewayOrderId: GID,
    });
    check(withId.includes('Booking ID') && withId.includes('JPH000777'),
      'successView must still show the Booking ID');
    check(withId.includes('Gateway order ID') && withId.includes(GID),
      'successView must show the gateway order id when one is present');
    // Ordered after the Booking ID row, before Package, so it reads as a pair.
    check(withId.indexOf('JPH000777') < withId.indexOf(GID)
      && withId.indexOf(GID) < withId.indexOf('Goa Getaway'),
      'the gateway order id should sit between the Booking ID and the package');

    const withoutId = renderView(successFn, 'successView', {
      bookingRef: 'JPH000777', packageName: 'Goa Getaway',
      amountMinor: 5600, currency: 'INR', gatewayOrderId: null,
    });
    check(withoutId.includes('Booking ID') && withoutId.includes('JPH000777'),
      'successView must show the Booking ID even when there is no gateway id');
    check(!withoutId.includes('Gateway order ID'),
      'successView must NOT show a gateway-order-id row when none is set '
      + '(amount/status verified but the id has not come back)');
    // The success message and amount are untouched by this change.
    check(withId.includes('Payment Successful!') && withId.includes('Paid Successfully'),
      'successView must keep the clear success message and paid status');
  }

  /* ---------------------------------------------------------------- *
   * 2. BEHAVIOURAL — the DEMO success screen never shows a gateway id
   *    (demo opens no provider and takes no money).
   * ---------------------------------------------------------------- */
  const demoFn = extractFn(SCREEN_JS, 'demoSuccessView', 'payment-screen.js');
  if (demoFn) {
    const demo = renderView(demoFn, 'demoSuccessView', {
      bookingRef: 'JPH000777', packageName: 'Goa', amountMinor: 5600,
      methodLabel: 'UPI', gatewayOrderId: GID,   // even if one were handed in
    });
    check(!demo.includes('Gateway order ID') && !demo.includes(GID),
      'the demo success screen must never show a gateway order id');
  }

  /* ---------------------------------------------------------------- *
   * 3. WIRING — the id flows server -> pollStatus -> JPay state -> view
   * ---------------------------------------------------------------- */
  check(/\br\.gateway_order_id\b/.test(PAY_JS),
    'booking-pay.js pollStatus must read r.gateway_order_id from the reconcile response');
  check(/return\s*\{\s*status,\s*amountMinor,\s*currency,\s*gatewayOrderId\s*\}/.test(PAY_JS),
    'booking-pay.js pollStatus must return gatewayOrderId to JPay');
  check(/gatewayOrderId:\s*opts\.gatewayOrderId\s*\|\|\s*null/.test(SCREEN_JS),
    'payment-screen.js must keep gatewayOrderId on JPay state');
  check(/s\.gatewayOrderId\s*=\s*res\.gatewayOrderId/.test(SCREEN_JS),
    'payment-screen.js askServer must fill s.gatewayOrderId from the reconcile result');
  check(/if\s*\(\s*res\.gatewayOrderId\s*&&\s*!s\.gatewayOrderId\s*\)/.test(SCREEN_JS),
    'payment-screen.js must set the gateway id once and never overwrite it');

  /* ---------------------------------------------------------------- *
   * 4. SAFETY / REGRESSION
   *    - the id comes only from the server reconcile answer, never the URL;
   *    - the success row is conditional, so it cannot appear before the
   *      payment is verified (the server returns an id only for a capture).
   * ---------------------------------------------------------------- */
  // In pollStatus, gatewayOrderId is only ever assigned from r.gateway_order_id.
  const assigns = PAY_JS.match(/gatewayOrderId\s*=\s*[^;]+/g) || [];
  check(assigns.length >= 1 && assigns.every(a => /r\.gateway_order_id/.test(a)),
    'booking-pay.js must derive gatewayOrderId only from the server response '
    + '(never from the URL or any browser-supplied value)');
  check(!/location[^\n]*gateway/i.test(PAY_JS) && !/gateway[^\n]*location/i.test(PAY_JS),
    'the gateway order id must never be read from window.location');
  if (successFn) {
    check(/\$\{s\.gatewayOrderId/.test(successFn) || /s\.gatewayOrderId\s*\?/.test(successFn),
      'the gateway-order-id row in successView must be conditional on s.gatewayOrderId');
  }
  // successView remains the SUCCESS-only screen (reached only when the server
  // confirmed the booking) — its guard comment is intact.
  check(/only reachable[\s\S]{0,80}SERVER has said the booking is confirmed/.test(SCREEN_JS),
    'successView must stay the server-confirmed-only screen');

  /* ---------------------------------------------------------------- */
  if (failures.length) {
    console.error('FAIL — hdfc-success-order-id.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — hdfc-success-order-id.test.js (behavioural + wiring + safety)');
})();
