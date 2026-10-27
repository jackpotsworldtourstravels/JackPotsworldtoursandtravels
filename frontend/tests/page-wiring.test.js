'use strict';
/* ===========================================================================
   page-wiring.test.js — the integration seams the per-function unit tests
   cannot see.

   WHY THIS EXISTS. recently-viewed.test.js, saved-travellers.test.js and
   wishlist-compare.test.js each lift a pure function out of account-center.js
   and exercise it in a VM. That proves the rendering logic, but it never loads
   a real page, so two whole-page regressions slipped through:

     1. The Account Center markup lives in TWO places — the MARKUP constant in
        account-center.js (injected on pages that have no static copy) AND a
        static copy hard-coded in index.html (ensureMarkup() keeps that one and
        skips the inject). The new "Recently Viewed" and "Saved Travellers"
        tabs were added to MARKUP but not to index.html's copy, so the homepage
        silently dropped both tabs.

     2. A hotel view is recorded by hotel-rooms.js calling JWInterest.track(),
        but that call is guarded (`typeof JWInterest !== 'undefined'`) so it is
        a no-op on any page that forgets to load jw-interest.js. hotels.html
        forgot, so hotel views were never recorded and never reached "Recently
        Viewed" — while packages (package.html loads it) worked.

   Both are "the wiring is split across files and one copy drifted". These
   assertions pin the copies together.

   run:  node frontend/tests/page-wiring.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* ---- 1. index.html's static Account Center must carry every tab the shared
         MARKUP does, plus the matching panels. ------------------------------ */
const index = read('index.html');
const center = read('assets/js/account-center.js');

// The tabs the feature batch added. If MARKUP gains more later, this list is
// the single place to extend — and it still catches a stale index.html.
const REQUIRED_TABS = ['recently', 'travellers'];
for (const tab of REQUIRED_TABS) {
  check(center.includes(`data-tab="${tab}"`),
    `account-center.js MARKUP is missing data-tab="${tab}" (test or source drifted)`);
  check(index.includes(`data-tab="${tab}"`),
    `index.html static Account Center is missing the "${tab}" tab — it must mirror account-center.js MARKUP`);
}

// The panels those tabs switch to, and the traveller form the panel needs.
const REQUIRED_PANEL_IDS = ['acctPanel-recently', 'acctPanel-travellers', 'acctRecentlyList',
  'acctTravellersList', 'acctTravellerForm'];
for (const id of REQUIRED_PANEL_IDS) {
  check(index.includes(`id="${id}"`),
    `index.html static Account Center is missing #${id} — the "${id}" panel/control did not get mirrored from MARKUP`);
}

/* ---- 2. Any page that records views through a tracker must load the tracker.
         JWInterest.track() is a guarded no-op without jw-interest.js. --------- */
// Scripts that call JWInterest.track / JWInterest.record, and so need it loaded.
const TRACKER_CALLERS = ['hotel-rooms.js', 'package.js', 'destination.js'];
const htmlFiles = fs.readdirSync(path.join(__dirname, '..'))
  .filter(f => f.endsWith('.html'));

for (const file of htmlFiles) {
  const html = read(file);
  const loadsATracker = TRACKER_CALLERS.some(js =>
    new RegExp(`src=["'][^"']*${js.replace('.', '\\.')}`).test(html));
  if (!loadsATracker) continue;
  check(/src=["'][^"']*jw-interest\.js/.test(html),
    `${file} loads a view-tracking script (${TRACKER_CALLERS.join('/')}) but not jw-interest.js — views will silently never record`);
}

if (failures.length) {
  console.error('FAIL — page-wiring.test.js');
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log('PASS — page-wiring.test.js (index.html Account Center tabs/panels; tracker pages load jw-interest.js)');
