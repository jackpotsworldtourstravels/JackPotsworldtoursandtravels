'use strict';
/* ===========================================================================
   Coupon offers strip on the HOTEL and PACKAGE results pages (Feature #1).

   The flights results page shows a strip of REAL coupons from
   GET /api/customer/coupons (renderOffers in travel-explore.js, host #fxOffers).
   Hotels and packages now carry the same strip, from the same endpoint, with
   the same honest rule: show only what the backend returns, and show NOTHING
   when the table is empty or the call fails. These are the functions that do
   it — renderOffers() in hotel-results.js (host #hrOffers) and in
   package-listing.js (host #pklOffers).

   There is no DOM test runner in this project (see the note in
   hotel-image-map.provider.test.js), so this is a self-contained Node harness,
   mirroring search-live-region.test.js. It does three things:

     1. BEHAVIOURAL — it extracts each renderOffers() by brace-matching, runs it
        in a VM with a tiny shim, and asserts:
          * a non-empty coupon list renders a strip carrying the code + title,
          * an empty list renders NOTHING,
          * a failed request renders NOTHING (and does not throw).
     2. STRUCTURAL — it asserts both HTML pages carry the host element, both
        functions are wired into the render path, and the honest guards are
        present.
     3. REGRESSION — it asserts each renderOffers body is DISPLAY ONLY: it names
        no pricing, quote, checkout, payment or coupon-VALIDATION call, so it
        cannot have altered checkout behaviour; and it asserts the booking
        flow's own coupon validation (booking-flow.js) is still present.

   run:  node frontend/tests/offers-strip.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const HOTEL_JS = read('assets/js/hotel-results.js');
const PKG_JS = read('assets/js/package-listing.js');
const HOTEL_HTML = read('hotels.html');
const PKG_HTML = read('packages.html');
const BOOKING_FLOW = read('assets/js/booking-flow.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Pull one `async function renderOffers() { ... }` out of a source file by
   matching braces from the function's opening brace to its close. Returns the
   whole declaration, ready to eval in a VM. */
function extractRenderOffers(src, label) {
  const sig = 'async function renderOffers()';
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${label}: renderOffers() not found`); return null; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${label}: renderOffers() braces did not balance`);
  return null;
}

/* The same escaper the real modules use, so the VM renders what the page does. */
const escShim = "const esc = s => String(s == null ? '' : s)"
  + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')"
  + ".replace(/\"/g,'&quot;').replace(/'/g,'&#39;');";

/* Run an extracted renderOffers once against a given data source, and return
   the host's innerHTML afterwards. `provider` is the shim the function talks to
   (BookingApi for hotels, getJson for packages). */
async function runOffers(fnSrc, hostId, providerSetup) {
  const host = { innerHTML: '' };
  const sandbox = {
    host,
    document: { getElementById: id => (id === hostId ? host : null) },
    Promise, Array, String, setTimeout, console,
  };
  providerSetup(sandbox);
  const script = `
    ${escShim}
    const $ = id => document.getElementById(id);
    let offersLoaded = false;
    ${fnSrc}
    globalThis.__done = renderOffers();
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  await sandbox.__done;
  return host.innerHTML;
}

/* Call renderOffers() TWICE against one fresh module scope (so the offersLoaded
   guard is shared, as it is on a real page across re-renders) and report how
   many times the coupon source was hit. The provider setup increments
   sandbox.calls.n on every request, so the count is the real fetch count. */
async function runOffersTwice(fnSrc, hostId, providerSetup) {
  const host = { innerHTML: '' };
  const calls = { n: 0 };
  const sandbox = {
    host, calls,
    document: { getElementById: id => (id === hostId ? host : null) },
    Promise, Array, String, setTimeout, console,
  };
  providerSetup(sandbox, calls);
  const script = `
    ${escShim}
    const $ = id => document.getElementById(id);
    let offersLoaded = false;
    ${fnSrc}
    globalThis.__done = (async () => { await renderOffers(); await renderOffers(); })();
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  await sandbox.__done;
  return { calls: calls.n, html: host.innerHTML };
}

const SAMPLE = [
  { code: 'JPFLY500', title: 'Flat ₹500 off' },
  { code: 'STAYMORE', title: '' },
];

(async () => {
  /* ---------------------------------------------------------------- *
   * 1. BEHAVIOURAL — hotels (talks to BookingApi.coupons('hotel'))
   * ---------------------------------------------------------------- */
  const hotelFn = extractRenderOffers(HOTEL_JS, 'hotel-results.js');
  if (hotelFn) {
    const okHotel = sb => { sb.BookingApi = { isLive: () => true, coupons: () => Promise.resolve(SAMPLE) }; };
    const emptyHotel = sb => { sb.BookingApi = { isLive: () => true, coupons: () => Promise.resolve([]) }; };
    const failHotel = sb => { sb.BookingApi = { isLive: () => true, coupons: () => Promise.reject(new Error('boom')) }; };

    const h1 = await runOffers(hotelFn, 'hrOffers', okHotel);
    check(/fx-offers/.test(h1) && h1.includes('JPFLY500') && h1.includes('Flat'),
      'hotel: a non-empty coupon list should render the strip with code + title');
    check(h1.includes('STAYMORE'),
      'hotel: every returned coupon should render (even one with no title)');

    const h2 = await runOffers(hotelFn, 'hrOffers', emptyHotel);
    check(h2 === '', 'hotel: an empty coupon list must render NOTHING');

    const h3 = await runOffers(hotelFn, 'hrOffers', failHotel);
    check(h3 === '', 'hotel: a failed request must render NOTHING and not throw');

    check(hotelFn.includes("BookingApi.coupons('hotel')"), 'hotel: must query the hotel product');
    check(hotelFn.includes("isLive('hotel')"), 'hotel: must gate on BookingApi.isLive(hotel)');
  }

  /* ---------------------------------------------------------------- *
   * 2. BEHAVIOURAL — packages (talks to the page's own getJson())
   * ---------------------------------------------------------------- */
  const pkgFn = extractRenderOffers(PKG_JS, 'package-listing.js');
  if (pkgFn) {
    let lastUrl = '';
    const okPkg = sb => { sb.getJson = url => { lastUrl = url; return Promise.resolve(SAMPLE); }; };
    const emptyPkg = sb => { sb.getJson = () => Promise.resolve([]); };
    const failPkg = sb => { sb.getJson = () => Promise.reject(Object.assign(new Error('x'), { status: 500 })); };

    const p1 = await runOffers(pkgFn, 'pklOffers', okPkg);
    check(/fx-offers/.test(p1) && p1.includes('JPFLY500'),
      'package: a non-empty coupon list should render the strip with code + title');
    check(lastUrl === '/api/customer/coupons?product_type=package',
      'package: must query the coupons endpoint with product_type=package');

    const p2 = await runOffers(pkgFn, 'pklOffers', emptyPkg);
    check(p2 === '', 'package: an empty coupon list must render NOTHING');

    const p3 = await runOffers(pkgFn, 'pklOffers', failPkg);
    check(p3 === '', 'package: a failed request must render NOTHING and not throw');
  }

  /* ---------------------------------------------------------------- *
   * 3. DEDUPE — calling renderOffers() twice fetches coupons ONCE.
   *
   * The offersLoaded guard means repeated renders (a filter, a sort, a reload
   * of the same list) must not refetch the coupon table. Each provider counts
   * its own requests; after two calls the count must be exactly 1, and the
   * strip must still be rendered from that single fetch.
   * ---------------------------------------------------------------- */
  if (hotelFn) {
    const okHotelCount = sb => { sb.BookingApi = { isLive: () => true, coupons: () => { sb.calls.n++; return Promise.resolve(SAMPLE); } }; };
    const r = await runOffersTwice(hotelFn, 'hrOffers', okHotelCount);
    check(r.calls === 1, `hotel: two renderOffers() calls must fetch coupons exactly once (got ${r.calls})`);
    check(r.html.includes('JPFLY500'), 'hotel: the strip must still render from the single fetch');
  }
  if (pkgFn) {
    const okPkgCount = sb => { sb.getJson = () => { sb.calls.n++; return Promise.resolve(SAMPLE); }; };
    const r = await runOffersTwice(pkgFn, 'pklOffers', okPkgCount);
    check(r.calls === 1, `package: two renderOffers() calls must fetch coupons exactly once (got ${r.calls})`);
    check(r.html.includes('JPFLY500'), 'package: the strip must still render from the single fetch');
  }

  /* ---------------------------------------------------------------- *
   * 4. STRUCTURAL — hosts present and the function is wired in
   * ---------------------------------------------------------------- */
  check(/id="hrOffers"/.test(HOTEL_HTML), 'hotels.html must carry the #hrOffers host');
  check(/id="pklOffers"/.test(PKG_HTML), 'packages.html must carry the #pklOffers host');
  // Called somewhere beyond its own definition (the render path).
  check((HOTEL_JS.match(/renderOffers\(\)/g) || []).length >= 2,
    'hotel-results.js must CALL renderOffers() from the render path');
  check((PKG_JS.match(/renderOffers\(\)/g) || []).length >= 2,
    'package-listing.js must CALL renderOffers() from the render path');

  /* ---------------------------------------------------------------- *
   * 5. REGRESSION — display only, checkout untouched
   * ---------------------------------------------------------------- */
  const forbidden = /validate|quote|checkout|payment|\bpay\b|\bprice\b/i;
  if (hotelFn) check(!forbidden.test(hotelFn),
    'hotel renderOffers must be display-only (no pricing/quote/checkout/validate call)');
  if (pkgFn) check(!forbidden.test(pkgFn),
    'package renderOffers must be display-only (no pricing/quote/checkout/validate call)');
  check(/validateCoupon/.test(BOOKING_FLOW),
    'booking-flow.js coupon validation must still be present (not touched by this feature)');

  /* ---------------------------------------------------------------- */
  if (failures.length) {
    console.error('FAIL — offers-strip.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — offers-strip.test.js (behavioural + structural + regression)');
})();
