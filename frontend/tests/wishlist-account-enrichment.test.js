'use strict';
/* ===========================================================================
   Account wishlist CATALOGUE ENRICHMENT (shared hotel + package resolver).

   The account wishlist list enriches each saved {item_type, item_id} with its
   live catalogue row so it can show a real name and price. This fixes that
   resolver in assets/js/account-center.js:
     * it now fetches the real PUBLIC endpoints /api/customer/hotels and
       /api/customer/packages (not the non-existent /api/hotels, /api/packages),
     * it keys the catalogue by String(id) and looks up by String(item_id),
       because the catalogue id is a stringified integer and the wishlist
       item_id is an integer (42 vs "42"),
     * it reads the real fields: hotel name/pricePerNight, package name/priceFrom.

   account-center.js touches the DOM at module scope, so it cannot be required
   wholesale. Instead the three pure resolver pieces are extracted and run in a
   VM against a mock axios — the real code, in isolation.

   run:  node frontend/tests/wishlist-account-enrichment.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/account-center.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Slice `const ACCT_WISHLIST_ENDPOINTS = {...};` (to its first semicolon). */
function extractConst(src, name) {
  const at = src.indexOf(`const ${name}`);
  if (at === -1) { failures.push(`${name} not found`); return ''; }
  const end = src.indexOf(';', at);
  return src.slice(at, end + 1);
}
/* Brace-match a `function <sig>...` block. */
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

const ENDPOINTS = extractConst(SRC, 'ACCT_WISHLIST_ENDPOINTS');
const FETCH = extractFn(SRC, 'async function fetchWishlistWithCatalog(');
const LABEL = extractFn(SRC, 'function wishlistLabel(');
const PRICE = extractFn(SRC, 'function wishlistPrice(');

/* A VM holding the real resolver pieces, wired to a mock axios routed by URL. */
function makeResolver(routes) {
  const sandbox = {
    console, Promise, Map, Set, Array, String, Number, JSON,
    API_BASE: '',
    customerHeaders: () => ({}),
    money: n => '₹' + Number(n).toLocaleString('en-IN'),
    axios: {
      get: async (url) => {
        for (const [frag, resp] of routes) {
          if (url.includes(frag)) {
            if (resp instanceof Error) throw resp;
            return { data: resp };
          }
        }
        const e = new Error('404'); e.status = 404; throw e;
      },
    },
  };
  const script = `
    ${ENDPOINTS}
    ${FETCH}
    ${LABEL}
    ${PRICE}
    globalThis.__api = { fetchWishlistWithCatalog, wishlistLabel, wishlistPrice, ACCT_WISHLIST_ENDPOINTS };
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox.__api;
}

/* Mirror loadAcctWishlist's own lookup, so the test resolves exactly as it does. */
const lookup = (catalogs, w) => catalogs[w.item_type] && catalogs[w.item_type].get(String(w.item_id));

(async () => {
  /* ---- Correct endpoints ---------------------------------------------- */
  {
    const { ACCT_WISHLIST_ENDPOINTS: EP } = makeResolver([]);
    check(EP.hotel === 'customer/hotels', 'hotel enrichment must hit /api/customer/hotels');
    check(EP.package === 'customer/packages', 'package enrichment must hit /api/customer/packages');
  }

  /* ---- Hotel enrichment + ID matching (int item_id vs string id) ------- */
  {
    const api = makeResolver([
      ['/wishlist', [{ id: 1, item_type: 'hotel', item_id: 42 }]],
      ['customer/hotels', [{ id: '42', name: 'Taj Palace', pricePerNight: 12500 }, { id: '43', name: 'Novotel', pricePerNight: 8200 }]],
    ]);
    const { data, catalogs } = await api.fetchWishlistWithCatalog();
    const item = lookup(catalogs, data[0]);
    check(!!item, 'a saved hotel resolves despite item_id being a number and catalogue id a string');
    check(api.wishlistLabel('hotel', item) === 'Taj Palace', 'hotel label is the real name');
    check(api.wishlistPrice('hotel', item) === '₹12,500', 'hotel price is pricePerNight, formatted');
    // The raw map must be keyed by string, so a numeric get would miss.
    check(catalogs.hotel.get('42') && !catalogs.hotel.get(42),
      'catalogue map is keyed by String(id) (numeric lookup misses)');
  }

  /* ---- Package enrichment --------------------------------------------- */
  {
    const api = makeResolver([
      ['/wishlist', [{ id: 9, item_type: 'package', item_id: 7 }]],
      ['customer/packages', [{ id: '7', name: 'Dubai Escape', priceFrom: 54900 }]],
    ]);
    const { data, catalogs } = await api.fetchWishlistWithCatalog();
    const item = lookup(catalogs, data[0]);
    check(!!item, 'a saved package resolves');
    check(api.wishlistLabel('package', item) === 'Dubai Escape', 'package label is the real name (not item.title)');
    check(api.wishlistPrice('package', item) === '₹54,900', 'package price is priceFrom, formatted (not item.price)');
  }

  /* ---- Missing catalogue item (genuinely gone) ------------------------- */
  {
    const api = makeResolver([
      ['/wishlist', [{ id: 2, item_type: 'hotel', item_id: 999 }]],
      ['customer/hotels', [{ id: '42', name: 'Taj Palace', pricePerNight: 12500 }]],
    ]);
    const { data, catalogs } = await api.fetchWishlistWithCatalog();
    const item = lookup(catalogs, data[0]);
    check(!item, 'an item_id absent from the catalogue resolves to nothing');
    check(api.wishlistLabel('hotel', item) === 'hotel #? (no longer available)', 'a missing item keeps the graceful fallback label');
    check(api.wishlistPrice('hotel', item) === '—', 'a missing item shows no price');
  }

  /* ---- Failed catalogue request (one type 404s) ----------------------- */
  {
    const api = makeResolver([
      ['/wishlist', [{ id: 3, item_type: 'package', item_id: 7 }]],
      ['customer/packages', new Error('boom')],   // the catalogue fetch fails
    ]);
    const { data, catalogs } = await api.fetchWishlistWithCatalog();
    check(catalogs.package instanceof Map && catalogs.package.size === 0,
      'a failed catalogue fetch yields an empty map, not a thrown wishlist');
    const item = lookup(catalogs, data[0]);
    check(api.wishlistLabel('package', item) === 'package #? (no longer available)',
      'a failed fetch degrades to the fallback, not an error');
  }

  /* ---- Mixed types in one wishlist resolve independently --------------- */
  {
    const api = makeResolver([
      ['/wishlist', [{ id: 4, item_type: 'hotel', item_id: 42 }, { id: 5, item_type: 'package', item_id: 7 }]],
      ['customer/hotels', [{ id: '42', name: 'Taj Palace', pricePerNight: 12500 }]],
      ['customer/packages', [{ id: '7', name: 'Dubai Escape', priceFrom: 54900 }]],
    ]);
    const { data, catalogs } = await api.fetchWishlistWithCatalog();
    check(api.wishlistLabel('hotel', lookup(catalogs, data[0])) === 'Taj Palace'
       && api.wishlistLabel('package', lookup(catalogs, data[1])) === 'Dubai Escape',
      'hotel and package entries in one wishlist both enrich correctly');
  }

  /* ---- STRUCTURAL: lookup keys by String; remove behavior unchanged ---- */
  check(/get\(String\(w\.item_id\)\)/.test(SRC),
    'loadAcctWishlist must look up the catalogue by String(w.item_id)');
  check(/data-remove-wishlist="\$\{w\.id\}"/.test(SRC),
    'the Remove button must still target the wishlist row id');
  check(/axios\.delete\(`\$\{API_BASE\}\/api\/customer\/wishlist\/\$\{btn\.dataset\.removeWishlist\}`/.test(SRC),
    'Remove must still DELETE /api/customer/wishlist/{id} (behavior preserved)');

  /* --------------------------------------------------------------------- */
  if (failures.length) {
    console.error('FAIL — wishlist-account-enrichment.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — wishlist-account-enrichment.test.js (hotel + package enrichment, id matching, missing, failed, remove)');
})();
