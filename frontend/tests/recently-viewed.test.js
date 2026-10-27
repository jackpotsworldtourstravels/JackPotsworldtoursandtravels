'use strict';
/* ===========================================================================
   Account "Recently viewed" — row render + wiring, in isolation.

   /api/customer/recently-viewed returns hotels and packages the customer
   opened. account-center.js renders each with recentlyViewedRowHtml(it); this
   extracts that pure function (plus the real escapeHtml/money from
   shared/formatters.js) and runs it in a VM, then makes structural assertions
   on the loader and tab wiring.

   run:  node frontend/tests/recently-viewed.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/account-center.js');
const FORMATTERS = read('shared/formatters.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

function extractFn(src, sig) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${sig} not found`); return ''; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${sig} braces unbalanced`);
  return '';
}

const ESCAPE = extractFn(FORMATTERS, 'function escapeHtml(');
const MONEY = extractFn(FORMATTERS, 'function money(');
const ROW = extractFn(SRC, 'function recentlyViewedRowHtml(');

function makeApi() {
  const sandbox = {
    console, String, Number, Math, encodeURIComponent,
    JPIcon: undefined,
    TYPE_ICONS: { hotel: 'bedDouble', package: 'palmtree' },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${ESCAPE}\n${MONEY}\n${ROW}\nglobalThis.__row = recentlyViewedRowHtml;`, sandbox);
  return sandbox.__row;
}

(async () => {
  const row = makeApi();

  /* ---- Hotel row: deep-links to the hotels page by ?hotel= -------------- */
  {
    const html = row({ type: 'hotel', id: 42, name: 'Taj Palace', price: 12500, location: 'Banjara Hills, Hyderabad' });
    check(html.includes('href="/hotels?hotel=42"'), 'a hotel links back to the hotels page by id');
    check(/class="ar-title"[^>]*>Taj Palace</.test(html), 'the hotel name is shown');
    check(html.includes('₹12,500'), 'the price is formatted with money()');
    check(html.includes('Banjara Hills, Hyderabad'), 'the location is shown when present');
    check(html.includes('View again'), 'there is a "View again" action');
  }

  /* ---- Package row: deep-links to the package page ---------------------- */
  {
    const html = row({ type: 'package', id: 7, name: 'Dubai Escape', price: 54900, location: 'Dubai' });
    check(html.includes('href="/package/7"'), 'a package links back to its own page by id');
    check(html.includes('₹54,900'), 'the package price is formatted');
  }

  /* ---- Missing price/location degrade cleanly --------------------------- */
  {
    const html = row({ type: 'hotel', id: 2, name: 'Novotel', price: null, location: null });
    check(!html.includes('₹'), 'no price is shown when price is null (no "₹" / no NaN)');
    check(!html.includes(' · null'), 'a null location is not printed');
  }

  /* ---- XSS: the name is escaped through the real escapeHtml ------------- */
  {
    const html = row({ type: 'package', id: 1, name: '<img src=x onerror=alert(1)>', price: 100, location: null });
    check(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name is HTML-escaped');
    check(!/<img src=x onerror/.test(html), 'the raw tag never reaches the markup');
  }

  /* ---- STRUCTURAL: loader hits the endpoint; tab is wired --------------- */
  check(/axios\.get\(`\$\{API_BASE\}\/api\/customer\/recently-viewed`/.test(SRC),
    'loadAcctRecentlyViewed GETs /api/customer/recently-viewed');
  check(/if \(name === 'recently'\) return loadAcctRecentlyViewed\(\);/.test(SRC),
    'the "recently" tab is dispatched to its loader');
  check(/data-tab="recently"/.test(SRC), 'the Recently Viewed tab is present in the nav');

  if (failures.length) {
    console.error('FAIL — recently-viewed.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — recently-viewed.test.js (hotel/package links, price/location, escaping, wiring)');
})();
