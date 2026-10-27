'use strict';
/* ===========================================================================
   Wishlist "Compare" — side-by-side table from catalogue data, in isolation.

   compareTableHtml(items, type) builds the comparison from the enriched
   catalogue items the wishlist already fetched. This extracts it (and the
   WISHLIST_COMPARE_SPECS it reads, plus the real escapeHtml/money) into a VM
   and checks: real values only, all-empty attributes dropped, a package rating
   shown only with its source, escaping, and the <2-items guard.

   run:  node frontend/tests/wishlist-compare.test.js
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
function extractConst(src, name) {
  const at = src.indexOf(`const ${name}`);
  if (at === -1) { failures.push(`${name} not found`); return ''; }
  const end = src.indexOf('};', at);
  return src.slice(at, end + 2);
}

const ESCAPE = extractFn(FORMATTERS, 'function escapeHtml(');
const MONEY = extractFn(FORMATTERS, 'function money(');
const SPECS = extractConst(SRC, 'WISHLIST_COMPARE_SPECS');
const TABLE = extractFn(SRC, 'function compareTableHtml(');

function makeApi() {
  const sandbox = { console, String, Array, Math };
  vm.createContext(sandbox);
  vm.runInContext(`${ESCAPE}\n${MONEY}\n${SPECS}\n${TABLE}\nglobalThis.__t = compareTableHtml;`, sandbox);
  return sandbox.__t;
}

(async () => {
  const table = makeApi();

  /* ---- Two hotels compare on the real attributes ----------------------- */
  {
    const h1 = { name: 'Taj', pricePerNight: 12500, stars: 5, guest_rating: 4.6, location: 'Hyderabad', free_cancellation: true, meal_plans: ['Breakfast'] };
    const h2 = { name: 'Novotel', pricePerNight: 8200, stars: 4, guest_rating: 4.1, location: 'Vizag', free_cancellation: false, meal_plans: [] };
    const html = table([h1, h2], 'hotel');
    check(html.includes('>Taj<') && html.includes('>Novotel<'), 'both hotel names head the columns');
    check(html.includes('₹12,500') && html.includes('₹8,200'), 'price/night uses money()');
    check(html.includes('Free cancellation') && html.includes('>Yes<') && html.includes('>No<'),
      'free cancellation shows Yes/No from the real flag');
    check(html.includes('Breakfast'), 'a meal plan one hotel has is shown');
  }

  /* ---- An attribute NONE of the items has is dropped entirely ----------- */
  {
    const a = { name: 'A', pricePerNight: 100, meal_plans: [] };
    const b = { name: 'B', pricePerNight: 200, meal_plans: [] };
    const html = table([a, b], 'hotel');
    check(!html.includes('Meal plans'), 'an attribute neither item has is omitted, not shown blank');
  }

  /* ---- Packages: rating shown only WITH its source (honesty) ------------ */
  {
    const p1 = { name: 'Dubai', priceFrom: 54900, destination: 'Dubai', nights: 5, trip_type: 'international', rating: 4.5, rating_source: 'Google' };
    const p2 = { name: 'Goa', priceFrom: 30000, destination: 'Goa', nights: 3, trip_type: 'domestic' };
    const html = table([p1, p2], 'package');
    check(html.includes('₹54,900') && html.includes('5 nights'), 'package price and nights render');
    check(html.includes('4.5 / 5 (Google)'), 'a rating WITH a source is shown');

    const noSource = table(
      [{ name: 'X', priceFrom: 1, rating: 4, rating_source: null }, { name: 'Y', priceFrom: 2 }], 'package');
    check(!noSource.includes('Rating'), 'a rating with NO source is never shown (matches the API honesty rule)');
  }

  /* ---- Escaping + the two-item guard ----------------------------------- */
  {
    const html = table([{ name: '<b>x</b>', pricePerNight: 1 }, { name: 'ok', pricePerNight: 2 }], 'hotel');
    check(html.includes('&lt;b&gt;x&lt;/b&gt;') && !/<b>x<\/b>/.test(html), 'item names are HTML-escaped');
    check(table([{ name: 'solo', pricePerNight: 1 }], 'hotel') === '', 'fewer than two items yields no table');
  }

  /* ---- STRUCTURAL: wired into the wishlist loader ---------------------- */
  check(/appendWishlistCompare\(container, data, catalogs\);/.test(SRC),
    'loadAcctWishlist offers the compare toolbar after rendering');
  check(/data-compare="\$\{t\}"/.test(SRC), 'the compare buttons carry their type');

  if (failures.length) {
    console.error('FAIL — wishlist-compare.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — wishlist-compare.test.js (real-data rows, empty-drop, rating-source honesty, escaping, guard)');
})();
