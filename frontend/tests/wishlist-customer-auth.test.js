'use strict';
/* ===========================================================================
   Wishlist state reads the CUSTOMER session, never the admin/shared token.

   The landing page (assets/js/app.js) keeps the wishlist hearts in sync with
   refreshWishlistState(). That function is invoked at the top level (~line 297)
   BEFORE app.js rebinds `getStoredAuth = getCustomerAuth` (~line 756). So a bare
   getStoredAuth() inside it read the shared jwt_* (admin) drawer — not the
   traveller's jpc_* session — which meant:

     * a signed-in customer (jpc_access set, jwt_access empty) loaded the page
       with EMPTY hearts: getStoredAuth() saw no jwt_access and returned early;
     * if an admin had used the same browser, the ADMIN token in jwt_access was
       sent to the customer-scoped /api/customer/wishlist, which rejects it.

   The fix points refreshWishlistState() at getCustomerSession() — the jpc_*-first
   accessor wishlist.js and the Account Center already use, which never returns an
   admin session — and fires a refresh after completeCustomerSignIn() so the
   hearts fill on login without a page reload.

   There is no DOM test runner in this project (see hotel-image-map.provider.test.js),
   so this is a self-contained Node harness, like flight-sort-chips.test.js. It:

     1. BEHAVIOURAL — extracts refreshWishlistState() by brace-matching and runs
        it in a VM, asserting which token reaches the request:
          * the CUSTOMER jpc token is used even when an ADMIN jwt token is also
            present (never the admin token);
          * the real load bug: jwt_access empty but a customer signed in -> the
            request still fires with the customer token (old code fetched nothing);
          * a GUEST session (a real jpc_* token) is honoured unchanged;
          * nobody signed in -> no request, map cleared;
          * an empty customer session while an ADMIN jwt token is present -> no
            request, and the admin token is never used;
          * the saved map is rebuilt from the response (existing behaviour kept);
          * no getCustomerSession on the page -> NO request and no fallback to
            getStoredAuth (the leak this closes), without throwing.
     2. STRUCTURAL — refreshWishlistState() reads getCustomerSession (not a bare
        getStoredAuth); completeCustomerSignIn() calls refreshWishlistState()
        AFTER setStoredAuth(); and the page triggers exactly one top-level
        refreshWishlistState() on load (no duplicate request).

   run:  node frontend/tests/wishlist-customer-auth.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const APP = read('assets/js/app.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Pull one `function <name>(...) { ... }` out of a source by brace-matching. */
function extractFn(src, sig, label) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${label}: ${sig} not found`); return null; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${label}: ${sig} braces did not balance`);
  return null;
}

const fnSrc = extractFn(APP, 'async function refreshWishlistState(', 'app.js');

/* Run refreshWishlistState() in a VM with injectable session accessors and a
   recording axios. `sessions` controls what each accessor returns; omit
   getCustomerSession entirely with `noCustomerSession` to test no-fallback behavior. */
async function runRefresh({ customer, stored, rows = [], noCustomerSession = false } = {}) {
  const calls = [];
  const sandbox = {
    Map, console, Promise, String, Array, Number,
    API_BASE: '',
    axios: {
      get: async (url, cfg) => {
        calls.push({ url, auth: cfg && cfg.headers && cfg.headers.Authorization });
        return { data: rows };
      },
    },
    getStoredAuth: () => (stored || { access: null }),
  };
  if (!noCustomerSession) sandbox.getCustomerSession = () => (customer || { access: null });
  const script = `
    let wishlistMap = new Map();
    ${fnSrc}
    globalThis.__run = async () => { await refreshWishlistState(); return wishlistMap; };
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const map = await sandbox.__run();
  return { calls, map };
}

(async () => {
  if (!fnSrc) { report(); return; }

  /* ---- 1. CUSTOMER token is used even when an ADMIN token is present ---- */
  {
    const { calls } = await runRefresh({
      customer: { access: 'CUSTOMER_JPC' },
      stored: { access: 'ADMIN_JWT', role: 'admin' },
    });
    check(calls.length === 1, 'a signed-in customer triggers exactly one wishlist request');
    check(calls[0] && calls[0].auth === 'Bearer CUSTOMER_JPC',
      'the request carries the CUSTOMER jpc token');
    check(!calls.some(c => c.auth === 'Bearer ADMIN_JWT'),
      'the admin/shared jwt token is NEVER sent to the customer wishlist endpoint');
    check(calls[0] && /\/api\/customer\/wishlist$/.test(calls[0].url),
      'the request goes to /api/customer/wishlist');
  }

  /* ---- 2. The real load bug: jwt_access empty, a customer signed in ----- */
  {
    const { calls } = await runRefresh({
      customer: { access: 'CUSTOMER_JPC' },
      stored: { access: null },   // jwt_* drawer empty, as on load before the rebind
    });
    check(calls.length === 1 && calls[0].auth === 'Bearer CUSTOMER_JPC',
      'the hearts load for a signed-in customer even when jwt_access is empty '
      + '(the pre-rebind binding fetched nothing here)');
  }

  /* ---- 3. A GUEST holds a real jpc_* session — behaviour unchanged ------ */
  {
    const { calls } = await runRefresh({
      customer: { access: 'GUEST_JPC' },   // POST /auth/guest stores tokens in jpc_*
      stored: { access: null },
    });
    check(calls.length === 1 && calls[0].auth === 'Bearer GUEST_JPC',
      'a guest session (jpc_*) loads its wishlist exactly like an account');
  }

  /* ---- 4. Nobody signed in -> no request, map cleared ------------------- */
  {
    const { calls, map } = await runRefresh({
      customer: { access: null },
      stored: { access: null },
    });
    check(calls.length === 0, 'an anonymous visitor makes no wishlist request');
    check(map instanceof Map && map.size === 0, 'the wishlist map is cleared when nobody is signed in');
  }

  /* ---- 4b. Empty customer session + admin token present -> no request --- */
  {
    const { calls, map } = await runRefresh({
      customer: { access: null },              // no customer signed in
      stored: { access: 'ADMIN_JWT', role: 'admin' },  // but an admin token lingers
    });
    check(calls.length === 0,
      'an empty customer session makes NO wishlist request even when an admin token is present');
    check(!calls.some(c => c.auth === 'Bearer ADMIN_JWT'),
      'the admin jwt token is never used as a fallback');
    check(map instanceof Map && map.size === 0, 'the map is cleared, not populated from an admin session');
  }

  /* ---- 5. The saved map is rebuilt from the response (regression) ------- */
  {
    const { map } = await runRefresh({
      customer: { access: 'CUSTOMER_JPC' },
      rows: [
        { id: 7, item_type: 'package', item_id: 123 },
        { id: 9, item_type: 'hotel', item_id: 5 },
      ],
    });
    check(map.get('package:123') === 7 && map.get('hotel:5') === 9,
      'the saved set is rebuilt from GET /wishlist, keyed "type:id" -> row id');
  }

  /* ---- 6. No getCustomerSession on the page -> NO request, NO fallback --- */
  {
    let threw = false;
    let calls = [];
    let map = null;
    try {
      ({ calls, map } = await runRefresh({
        noCustomerSession: true,
        stored: { access: 'ADMIN_JWT', role: 'admin' },  // present, must be ignored
      }));
    } catch (e) { threw = true; }
    check(!threw, 'refreshWishlistState() degrades without getCustomerSession instead of throwing');
    check(calls.length === 0,
      'with no getCustomerSession it makes NO request — it does NOT fall back to getStoredAuth');
    check(!calls.some(c => c.auth === 'Bearer ADMIN_JWT'),
      'the admin jwt token is never sent when getCustomerSession is unavailable');
    check(map instanceof Map && map.size === 0, 'the wishlist map is cleared when getCustomerSession is unavailable');
  }

  /* ---- 7. STRUCTURAL — the wiring that makes the above true ------------- */
  // refreshWishlistState reads getCustomerSession and does NOT reference getStoredAuth at all.
  // Strip comments first: the function's own explanatory note names getStoredAuth to say
  // it must NOT be used, and we are asserting about the executable code, not the prose.
  const fnCode = fnSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // line comments (leave http:// alone)
  check(/getCustomerSession/.test(fnCode),
    'refreshWishlistState() must read getCustomerSession()');
  check(!/getStoredAuth/.test(fnCode),
    'refreshWishlistState() must NOT reference getStoredAuth() in code — no admin/shared-token fallback');

  // completeCustomerSignIn calls refreshWishlistState() AFTER setStoredAuth().
  const signIn = extractFn(APP, 'function completeCustomerSignIn(', 'app.js');
  check(signIn && /refreshWishlistState\(\)/.test(signIn),
    'completeCustomerSignIn() must refresh the wishlist after a successful login');
  if (signIn) {
    const afterStore = signIn.indexOf('setStoredAuth(');
    const refreshAt = signIn.indexOf('refreshWishlistState()');
    check(afterStore !== -1 && refreshAt > afterStore,
      'the login refresh must run AFTER the jpc_* session is stored (setStoredAuth)');
  }

  // Exactly one top-level refreshWishlistState() invocation on load (no dup request).
  const topLevelCalls = (APP.match(/^refreshWishlistState\(\);$/gm) || []).length;
  check(topLevelCalls === 1,
    `exactly one top-level refreshWishlistState() on load (found ${topLevelCalls}) — no duplicate request`);

  report();
})();

function report() {
  if (failures.length) {
    console.error('FAIL — wishlist-customer-auth.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — wishlist-customer-auth.test.js (customer jpc token used, admin jwt never, refresh-on-login wired)');
}
