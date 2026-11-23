'use strict';
/* ===========================================================================
   booking-api-exports.test.js — the two methods the round-trip / multi-city
   flight flow needs, and the cache tag that keeps them reaching the browser.

   WHY THIS EXISTS. Production showed `BookingApi.flightPayloadFor is not a
   function` on a round-trip booking while the file on disk plainly defined it.
   Two separate things have to hold for that call to work, and only one of them
   was being tested:

     1. booking-api.js must actually export flightPayloadFor() (used to build
        each leg, booking-products.js) and createMultiSegmentBooking() (the
        write seam, booking-store.js). A unit test never loaded the real IIFE,
        so a method dropped from the returned object would pass unnoticed.

     2. Every page that opens a flight booking must reference booking-api.js
        with a ?v= tag equal to the file's CURRENT content hash. The server
        marks any ?v= URL immutable for a year (backend/app/main.py), so a tag
        left stale after the file changed keeps browsers on the OLD script —
        which is exactly how the two methods went missing in the live object
        while a fresh fetch of the source had them. scripts/stamp_asset_versions.py
        owns the tag; tests/verify_asset_versions.py checks every asset. This
        pins the specific file the booking flow dies without.

   run:  node frontend/tests/booking-api-exports.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const readLF = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* ---- 1. The real object exports every method the booking flow calls. ------
   booking-api.js is `const BookingApi = (function(){...})()`. A top-level
   const does not attach to a vm context's global, so the source is run with a
   one-line tail that hands the value out. The IIFE touches no globals at load
   time (API_BASE, getCustomerAuth, fetch are read only when a method runs), so
   an empty sandbox is enough to evaluate it. */
const SRC = readLF('assets/js/booking-api.js');
const sandbox = {};
let BookingApi = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\nthis.__BookingApi = BookingApi;`, sandbox, { filename: 'booking-api.js' });
  BookingApi = sandbox.__BookingApi;
} catch (err) {
  failures.push(`booking-api.js failed to evaluate: ${err && err.message}`);
}

check(BookingApi && typeof BookingApi === 'object', 'BookingApi evaluates to an object');

// The methods whose absence broke round-trip / multi-city in production, plus
// the one-way write seam so this test also pins the single-flight path.
const REQUIRED_METHODS = [
  'flightPayloadFor',        // builds each leg of a round-trip / multi-city journey
  'createMultiSegmentBooking', // the round-trip / multi-city write seam
  'flightPayload',           // one-way leg
  'createBooking',           // one-way write seam
];
for (const m of REQUIRED_METHODS) {
  check(BookingApi && typeof BookingApi[m] === 'function',
    `BookingApi.${m} must be a function (missing from the exported object)`);
}

/* flightPayloadFor() must genuinely shape a leg, not just exist — it is what
   each round-trip / multi-city segment is built from. */
if (BookingApi && typeof BookingApi.flightPayloadFor === 'function') {
  const leg = BookingApi.flightPayloadFor(
    { id: 'AI101', flightNumber: 'AI101', airline: 'Air India',
      origin: { code: 'DEL', city: 'Delhi' }, destination: { code: 'BOM', city: 'Mumbai' },
      date: '2026-12-01', departure: '09:00', arrival: '11:10' }, 'economy');
  check(leg && leg.flight_key === 'AI101' && leg.origin_code === 'DEL'
        && leg.destination_code === 'BOM' && leg.cabin_class === 'economy',
    'flightPayloadFor() shapes a leg into the FlightInput payload');
}

/* ---- 2. Every flight-booking page references booking-api.js at its current
         content hash — the freshness guard for the production bug. ---------- */
const want = crypto.createHash('sha1')
  .update(Buffer.from(SRC, 'utf8')).digest('hex').slice(0, 10);

// Customer pages that can open a flight booking and therefore load booking-api.js.
const BOOKING_PAGES = ['flights.html', 'hotels.html', 'package.html', 'my-bookings.html'];
const tagRe = /booking-api\.js\?v=([A-Za-z0-9._-]+)/;
for (const page of BOOKING_PAGES) {
  const html = readLF(page);
  const m = tagRe.exec(html);
  check(m, `${page} must load assets/js/booking-api.js with a ?v= tag`);
  if (m) {
    check(m[1] === want,
      `${page} loads booking-api.js?v=${m[1]} but the file hashes to ${want} — `
      + `stale tag; browsers keep the old script for a year. Run scripts/stamp_asset_versions.py`);
  }
}

if (failures.length) {
  console.error('FAIL — booking-api-exports.test.js');
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log('PASS — booking-api-exports.test.js '
  + '(flightPayloadFor/createMultiSegmentBooking exported; booking pages at current hash)');
