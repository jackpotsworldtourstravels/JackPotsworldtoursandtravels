'use strict';
/* ===========================================================================
   Bug 4 — wishlist item titles navigate to the detail page.

   account-center.js now makes each saved item's title a link to its detail
   page: packages -> /package-details/{id}, hotels -> /hotels?hotel={id} (the
   hotels page loads the full catalogue on cold load, so its router opens the
   property). Flights and cruises are demo / client-side with no detail page,
   so they stay plain text. A deleted / no-longer-available item (no catalogue
   match) is never linked. The Remove action is untouched.

   account-center.js touches the DOM at module scope, so the pure resolver
   `wishlistHref` is extracted and run in a VM — the real code, in isolation.

   run:  node frontend/tests/wishlist-detail-link.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/account-center.js');

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

const HREF = extractFn(SRC, 'function wishlistHref(');
const sandbox = { encodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(`${HREF}\nglobalThis.wishlistHref = wishlistHref;`, sandbox);
const wishlistHref = sandbox.wishlistHref;

const item = { id: 1 };   // any resolved catalogue row

/* ---- Deep-linkable products ------------------------------------------- */
check(wishlistHref('package', item, 7) === '/package-details/7',
  'a resolved package links to /package-details/{id}');
check(wishlistHref('hotel', item, 42) === '/hotels?hotel=42',
  'a resolved hotel links to /hotels?hotel={id}');

/* ---- Products with no detail page ------------------------------------- */
check(wishlistHref('flight', item, 3) === null, 'flights have no detail page: no link');
check(wishlistHref('cruise', item, 3) === null, 'cruises have no detail page: no link');

/* ---- Graceful handling of deleted / invalid items --------------------- */
check(wishlistHref('package', null, 7) === null, 'an unresolved (deleted) item is never linked');
check(wishlistHref('hotel', item, null) === null, 'a missing item id yields no link');
check(wishlistHref('hotel', item, undefined) === null, 'an undefined item id yields no link');

/* ---- IDs are URL-encoded ---------------------------------------------- */
check(wishlistHref('package', item, 'a b') === '/package-details/a%20b',
  'the id is URL-encoded in the href');

/* ---- STRUCTURAL: render wires the link and preserves Remove ----------- */
check(/<a class="ar-title-link" href="\$\{href\}">\$\{label\}<\/a>/.test(SRC),
  'the title renders as an <a class="ar-title-link"> when a href exists');
check(/const href = wishlistHref\(w\.item_type, item, w\.item_id\);/.test(SRC),
  'render resolves the href from the saved row');
check(/data-remove-wishlist="\$\{w\.id\}"/.test(SRC),
  'the Remove button is preserved on every row');

/* ----------------------------------------------------------------------- */
if (failures.length) {
  console.error('FAIL — wishlist-detail-link.test.js');
  failures.forEach(f => console.error('  • ' + f));
  process.exit(1);
}
console.log('PASS — wishlist-detail-link.test.js (package/hotel links, no-link products, graceful deleted, Remove preserved)');
