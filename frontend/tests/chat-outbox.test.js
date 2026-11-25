'use strict';
/* ===========================================================================
   Support-chat OUTBOX — offline message persistence (Issue #24).

   chat-outbox.js is a DOM-free module (module.exports), so the REAL module runs
   in a VM here against a mock localStorage. This covers the behaviours
   live-chat.js depends on:
     * persist (remember) + restore (pending) round-trip, scoped to one owner,
     * ACCOUNT SWITCH / LOGOUT isolation: a different owner never sees another
       customer's unsent drafts,
     * forget on delivery, clear on sign-out,
     * DEDUP via merge(): an outbox item the server already has (same
       client_msg_id) is dropped; an unsent one is appended as a pending bubble,
     * remember is idempotent per client_msg_id (no duplicate drafts),
     * localStorage that throws (private mode / quota / disabled) degrades to
       "no persistence" rather than throwing.

   run:  node --test frontend/tests/chat-outbox.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'assets/js/chat-outbox.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/** A fresh ChatOutbox bound to a mock localStorage. `throwing` makes every
 *  storage access raise, to prove graceful degradation. */
function freshOutbox({ throwing = false } = {}) {
  const backing = new Map();
  const localStorage = throwing
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } }
    : {
        getItem: k => (backing.has(k) ? backing.get(k) : null),
        setItem: (k, v) => backing.set(k, String(v)),
        removeItem: k => backing.delete(k),
      };
  const sandbox = { module: { exports: {} }, window: { localStorage }, console, JSON, Set, Array, String };
  vm.runInNewContext(SRC, sandbox);
  return { ob: sandbox.module.exports, backing };
}

(function run() {
  // 1. remember + pending round-trip, scoped to an owner.
  {
    const { ob } = freshOutbox();
    ob.remember(7, { client_msg_id: 'a', body: 'hi', created_at: 't1' });
    ob.remember(7, { client_msg_id: 'b', body: 'there', created_at: 't2' });
    const items = ob.pending(7);
    check(items.length === 2, '1: both unsent messages are persisted for the owner');
    check(items[0].client_msg_id === 'a' && items[1].body === 'there', '1: round-trips body + id in order');
  }

  // 2. ACCOUNT SWITCH / LOGOUT: a different owner sees nothing.
  {
    const { ob } = freshOutbox();
    ob.remember(7, { client_msg_id: 'a', body: 'secret draft', created_at: 't1' });
    check(ob.pending(8).length === 0, '2: a different customer (account switch) gets no drafts');
    check(ob.pending(null).length === 0, '2: a logged-out reader (null owner) gets no drafts');
    // and remembering for the new owner replaces, never merges across owners
    ob.remember(8, { client_msg_id: 'z', body: 'mine', created_at: 't2' });
    const eight = ob.pending(8);
    check(eight.length === 1 && eight[0].client_msg_id === 'z', '2: new owner starts a fresh set');
    check(ob.pending(7).length === 0, '2: the previous owner\'s drafts are now gone, not leaked');
  }

  // 3. forget on delivery removes exactly one; others stay.
  {
    const { ob } = freshOutbox();
    ob.remember(7, { client_msg_id: 'a', body: 'x', created_at: 't1' });
    ob.remember(7, { client_msg_id: 'b', body: 'y', created_at: 't2' });
    ob.forget(7, 'a');
    const items = ob.pending(7);
    check(items.length === 1 && items[0].client_msg_id === 'b', '3: forget drops only the delivered id');
    ob.forget(8, 'b'); // wrong owner: no-op
    check(ob.pending(7).length === 1, '3: forget for a different owner is a no-op');
  }

  // 4. clear wipes everything (sign-out).
  {
    const { ob } = freshOutbox();
    ob.remember(7, { client_msg_id: 'a', body: 'x', created_at: 't1' });
    ob.clear();
    check(ob.pending(7).length === 0, '4: clear() wipes the outbox on sign-out');
  }

  // 5. merge(): dedup by client_msg_id + append unsent as pending.
  {
    const { ob } = freshOutbox();
    const server = [
      { message_id: 1, client_msg_id: 'a', body: 'arrived', sender_type: 'customer' },
      { message_id: 2, body: 'from admin', sender_type: 'admin' },
    ];
    const queued = [
      { client_msg_id: 'a', body: 'arrived', created_at: 't1' }, // already on server → dropped
      { client_msg_id: 'c', body: 'still unsent', created_at: 't3' }, // unseen → appended
    ];
    const merged = ob.merge(server, queued);
    check(merged.length === 3, '5: merged = 2 server + 1 genuinely-unsent (the dup is dropped)');
    const extra = merged[2];
    check(extra.client_msg_id === 'c' && extra.pending === true && extra.sender_type === 'customer',
      '5: the unsent one is appended as a pending customer bubble');
    const ids = merged.map(m => m.client_msg_id).filter(Boolean);
    check(new Set(ids).size === ids.length,
      '5: no client_msg_id appears twice after merge (duplicate prevention)');
  }

  // 6. remember is idempotent per client_msg_id (a retry does not duplicate).
  {
    const { ob } = freshOutbox();
    ob.remember(7, { client_msg_id: 'a', body: 'v1', created_at: 't1' });
    ob.remember(7, { client_msg_id: 'a', body: 'v1', created_at: 't1' });
    check(ob.pending(7).length === 1, '6: remembering the same client_msg_id twice keeps one copy');
  }

  // 7. a throwing localStorage degrades gracefully (never throws).
  {
    let threw = false;
    try {
      const { ob } = freshOutbox({ throwing: true });
      ob.remember(7, { client_msg_id: 'a', body: 'x', created_at: 't1' });
      check(ob.pending(7).length === 0, '7: with storage denied, nothing persists but nothing throws');
      ob.forget(7, 'a'); ob.clear();
      check(Array.isArray(ob.merge([], [{ client_msg_id: 'c', body: 'y' }])), '7: merge still works without storage');
    } catch (_) { threw = true; }
    check(!threw, '7: a denied/throwing localStorage never propagates an error');
  }

  if (failures.length) {
    console.error('FAIL — chat-outbox.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — chat-outbox.test.js (persist/restore, account-switch isolation, forget/clear, merge-dedup, graceful degrade)');
})();
