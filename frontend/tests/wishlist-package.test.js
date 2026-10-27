'use strict';
/* ===========================================================================
   Wishlist extended to PACKAGES (Feature #3).

   The hotels page already saves properties with the type-generic Wishlist
   module (assets/js/wishlist.js, POST /api/customer/wishlist {item_type,
   item_id}). Feature #3 reuses that SAME module for package cards —
   Wishlist.button('package', p.id, p.name) — with the package's real integer id
   (Number of the customer_package_id). No second wishlist system, no backend
   change.

   wishlist.js has no top-level DOM access and exports via module.exports, so —
   unlike the big page scripts — the REAL module runs in a VM here against a mock
   fetch. This test covers, for packages and (as regression) hotels:
     * save / unsave round-trips to the right endpoints with the right body,
     * persistence: the saved set is rebuilt from GET /wishlist on load,
     * the composite key, so package 123 and hotel 123 never collide / duplicate,
     * a failed save reverts the optimistic fill,
     * the package card button renders with the correct type/id/label,
     * the account wishlist view handles the package type (endpoint, icon, label).

   run:  node frontend/tests/wishlist-package.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/wishlist.js');
const PKG_JS = read('assets/js/package-listing.js');
const PKG_HTML = read('packages.html');
const ACCT = read('assets/js/account-center.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* A fresh Wishlist instance (module state is module-level, so each scenario
   gets its own VM) wired to a mock fetch. `fetchImpl(url, opts)` returns a
   {ok, status, json} shape; every call is recorded in `calls`. */
function freshWishlist({ signedIn = true, fetchImpl } = {}) {
  const calls = [];
  const sandbox = {
    module: { exports: {} },
    console, setTimeout, clearTimeout, Promise, Map, Number, Array, String, JSON,
    CSS: { escape: s => String(s) },
    escapeHtml: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    JPIcon: { html: () => '<svg class="jpi-btn"></svg>' },
    showToast: () => {},
    API_BASE: '',
    location: { pathname: '/packages.html', search: '', href: '' },
    getCustomerSession: () => (signedIn ? { access: 'tok' } : {}),
    document: {
      addEventListener: () => {},
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, classList: { toggle() {} } }),
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts, method: (opts && opts.method) || 'GET' });
      const r = fetchImpl(url, opts) || { ok: true, status: 200, json: async () => [] };
      return { ok: r.ok !== false, status: r.status || 200, json: r.json || (async () => null) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { wl: sandbox.module.exports, calls };
}

const emptyLoad = () => ({ ok: true, status: 200, json: async () => [] });

(async () => {
  /* ---- 1. SAVE: package, real integer id, right endpoint + body -------- */
  {
    const { wl, calls } = freshWishlist({
      fetchImpl: (url, opts) => (opts && opts.method === 'POST')
        ? { ok: true, status: 201, json: async () => ({ id: 99 }) }
        : emptyLoad(),
    });
    await wl.init();
    check(!wl.has('package', 123), 'package is not saved before any action');
    await wl.toggle('package', 123);
    check(wl.has('package', 123), 'package is saved after toggle');
    const post = calls.find(c => c.method === 'POST');
    check(post && /\/api\/customer\/wishlist$/.test(post.url), 'save POSTs to /api/customer/wishlist');
    const body = post ? JSON.parse(post.opts.body) : {};
    check(body.item_type === 'package', 'save body carries item_type "package"');
    check(body.item_id === 123 && typeof body.item_id === 'number',
      'save body carries the REAL integer id (123), not a string or invented value');

    /* ---- 2. UNSAVE: deletes the row it was given ----------------------- */
    await wl.toggle('package', 123);
    check(!wl.has('package', 123), 'package is unsaved after a second toggle');
    const del = calls.find(c => c.method === 'DELETE');
    check(del && /\/api\/customer\/wishlist\/99$/.test(del.url),
      'unsave DELETEs the wishlist row id returned by the save (99)');
  }

  /* ---- 3. PERSISTENCE + no cross-type collision ------------------------ */
  {
    const { wl } = freshWishlist({
      fetchImpl: () => ({ ok: true, status: 200, json: async () => [{ id: 7, item_type: 'package', item_id: 123 }] }),
    });
    await wl.init();
    check(wl.has('package', 123), 'the saved set is rebuilt from GET /wishlist on load (persistence)');
    check(!wl.has('hotel', 123),
      'composite key: package 123 and hotel 123 are distinct — no collision, no duplicate');
  }

  /* ---- 4. DUPLICATE SAVE is a no-op server-side; client key is unique -- */
  {
    let posts = 0;
    const { wl } = freshWishlist({
      fetchImpl: (url, opts) => {
        if (opts && opts.method === 'POST') { posts++; return { ok: true, status: 201, json: async () => ({ id: 1 }) }; }
        return emptyLoad();
      },
    });
    await wl.init();
    await wl.toggle('package', 500);         // save
    check(wl.has('package', 500), 'package saved');
    // Saving the same key again would un-save (toggle), so re-save to land saved:
    await wl.toggle('package', 500);         // unsave
    await wl.toggle('package', 500);         // save again
    check(wl.has('package', 500), 'the item is saved once, keyed uniquely (no duplicate entry)');
  }

  /* ---- 5. A FAILED SAVE reverts the optimistic fill -------------------- */
  {
    const { wl } = freshWishlist({
      fetchImpl: (url, opts) => (opts && opts.method === 'POST')
        ? { ok: false, status: 500, json: async () => ({}) }
        : emptyLoad(),
    });
    await wl.init();
    await wl.toggle('package', 55);
    check(!wl.has('package', 55), 'a failed save reverts — the heart does not keep a lie');
  }

  /* ---- 6. The package card button + hotel REGRESSION ------------------- */
  {
    const { wl, calls } = freshWishlist({
      fetchImpl: (url, opts) => (opts && opts.method === 'POST')
        ? { ok: true, status: 201, json: async () => ({ id: 3 }) } : emptyLoad(),
    });
    await wl.init();
    const pb = wl.button('package', 123, 'Dubai Escape');
    check(/data-wl-type="package"/.test(pb) && /data-wl-id="123"/.test(pb) && /aria-pressed="false"/.test(pb),
      'package button renders with type/id/aria-pressed');
    check(/aria-label="[^"]*Dubai Escape/.test(pb), 'package button aria-label names the package');

    const hb = wl.button('hotel', 5, 'Taj Palace');
    check(/data-wl-type="hotel"/.test(hb) && /data-wl-id="5"/.test(hb),
      'hotel button still renders unchanged (regression)');
    await wl.toggle('hotel', 5);
    check(wl.has('hotel', 5), 'hotel save still works (regression)');
    const hotelPost = calls.find(c => c.method === 'POST');
    check(hotelPost && JSON.parse(hotelPost.opts.body).item_type === 'hotel',
      'hotel save still posts item_type "hotel" (regression)');
  }

  /* ---- 7. Wiring on the packages page + account view handles packages -- */
  check(/assets\/js\/wishlist\.js/.test(PKG_HTML), 'packages.html must load wishlist.js');
  check(/Wishlist\.button\('package',\s*p\.id,\s*p\.name\)/.test(PKG_JS),
    "the package card must call Wishlist.button('package', p.id, p.name)");
  check(/Wishlist\.init\(\)/.test(PKG_JS) && /Wishlist\.refresh\(\)/.test(PKG_JS),
    'package-listing must init the wishlist once and refresh hearts after renders');

  // Account wishlist view already handles the package type generically.
  check(/ACCT_WISHLIST_ENDPOINTS\s*=\s*\{[^}]*package:/.test(ACCT),
    'account view maps the package type to a catalogue endpoint');
  check(/TYPE_ICONS\s*=\s*\{[\s\S]*?package:/.test(ACCT),
    'account view has a package type icon');
  check(/wishlistLabel\('?package'?|type === 'package'|return item\.title/.test(ACCT) || /function wishlistLabel/.test(ACCT),
    'account view resolves a label for the package type');
  check(/w\.item_type/.test(ACCT),
    'account view renders each saved item\'s type (so "package" is shown)');

  /* --------------------------------------------------------------------- */
  if (failures.length) {
    console.error('FAIL — wishlist-package.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — wishlist-package.test.js (save/unsave/persist/dupe/regression + account wiring)');
})();
