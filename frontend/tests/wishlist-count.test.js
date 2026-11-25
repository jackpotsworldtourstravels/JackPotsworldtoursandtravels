'use strict';
/* ===========================================================================
   Wishlist COUNT synchronisation (Issue #17).

   wishlist.js runs REAL in a VM here (module.exports) against a mock fetch and a
   mock document that records every `wishlist:change` event. Covers:
     * count() == the UNIQUE number of saved items (composite type:id key, so a
       hotel and a package sharing an id are two, not one, and no collision),
     * add / remove move the count and fire wishlist:change with the new count,
     * a failed save/remove rolls the count back (and fires the corrected count),
     * load() rebuilds the count from the server and announces it,
     * reset() (sign-out / account switch) zeroes the count and announces it.

   run:  node --test frontend/tests/wishlist-count.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'assets/js/wishlist.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

function freshWishlist({ signedIn = true, fetchImpl } = {}) {
  const events = [];
  const calls = [];
  const sandbox = {
    module: { exports: {} },
    console, setTimeout, clearTimeout, Promise, Map, Number, Array, String, JSON,
    CSS: { escape: s => String(s) },
    escapeHtml: s => String(s == null ? '' : s),
    JPIcon: { html: () => '<svg></svg>' },
    showToast: () => {},
    API_BASE: '',
    location: { pathname: '/hotels.html', search: '', href: '' },
    getCustomerSession: () => (signedIn ? { access: 'tok' } : {}),
    CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
    document: {
      addEventListener: () => {},
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, classList: { toggle() {} } }),
      dispatchEvent: ev => { if (ev && ev.type === 'wishlist:change') events.push(ev.detail.count); return true; },
    },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => [] })),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  return { wl: sandbox.module.exports, events, calls };
}

(async function run() {
  // 1. load() rebuilds a UNIQUE count and announces it.
  {
    const rows = [
      { item_type: 'hotel', item_id: 123, id: 1 },
      { item_type: 'package', item_id: 123, id: 2 }, // SAME id, different type → distinct
      { item_type: 'hotel', item_id: 123, id: 1 },   // exact dup row → one entry
    ];
    const { wl, events } = freshWishlist({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => rows }) });
    await wl.init();
    check(wl.count() === 2, '1: count is the unique number of items (hotel:123 + package:123 = 2, dup ignored)');
    check(events[events.length - 1] === 2, '1: load fires wishlist:change with the loaded count');
  }

  // 2. add increments and announces; count stays unique.
  {
    const { wl, events } = freshWishlist({ fetchImpl: async (url, opts) => {
      if ((opts && opts.method) === 'POST') return { ok: true, status: 201, json: async () => ({ id: 9 }) };
      return { ok: true, status: 200, json: async () => [] };
    } });
    await wl.init();
    check(wl.count() === 0, '2: starts empty');
    await wl.toggle('package', 55);
    check(wl.count() === 1, '2: add moves the count to 1');
    check(events[events.length - 1] === 1, '2: add fires wishlist:change with 1');
  }

  // 3. remove decrements and announces.
  {
    const { wl, events } = freshWishlist({ fetchImpl: async (url, opts) => {
      if ((opts && opts.method) === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [{ item_type: 'hotel', item_id: 7, id: 3 }] };
    } });
    await wl.init();
    check(wl.count() === 1, '3: loaded one item');
    await wl.toggle('hotel', 7);
    check(wl.count() === 0, '3: remove moves the count to 0');
    check(events[events.length - 1] === 0, '3: remove fires wishlist:change with 0');
  }

  // 4. a FAILED save rolls the count back.
  {
    const { wl, events } = freshWishlist({ fetchImpl: async (url, opts) => {
      if ((opts && opts.method) === 'POST') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [] };
    } });
    await wl.init();
    await wl.toggle('hotel', 42); // optimistic +1, then server 500 → rollback
    check(wl.count() === 0, '4: a failed save leaves the count at 0 (rolled back)');
    check(events[events.length - 1] === 0, '4: the corrected count (0) is announced after rollback');
  }

  // 5. reset() zeroes the count and announces it (sign-out / account switch).
  {
    const { wl, events } = freshWishlist({ fetchImpl: async () => ({ ok: true, status: 200, json: async () =>
      [{ item_type: 'hotel', item_id: 7, id: 3 }, { item_type: 'package', item_id: 8, id: 4 }] }) });
    await wl.init();
    check(wl.count() === 2, '5: two items before reset');
    wl.reset();
    check(wl.count() === 0, '5: reset() clears the count');
    check(events[events.length - 1] === 0, '5: reset() announces 0 so the badge clears on logout/switch');
  }

  if (failures.length) {
    console.error('FAIL — wishlist-count.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — wishlist-count.test.js (unique count, add/remove, rollback, load, reset)');
})();
