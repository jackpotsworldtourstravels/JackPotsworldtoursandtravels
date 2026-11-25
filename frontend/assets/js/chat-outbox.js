'use strict';
/* ===========================================================================
   Support-chat OUTBOX — offline message persistence (Issue #24).

   WHAT PROBLEM THIS SOLVES. live-chat.js keeps every message in an in-memory
   `state.messages` array and reloads the thread from the server (`GET
   /conversation`) each time the panel opens. That is correct for messages the
   server already has — but a message the customer typed while OFFLINE (or on a
   connection that dropped mid-send) lives ONLY in that in-memory array as a
   `pending`/`failed` bubble. Reload the page, or close and reopen the panel,
   and `load()` overwrites `state.messages` with the server's copy — which never
   had that message — so the customer's unsent words silently vanish.

   This module is the durable half of the outbox: it persists the unsent set to
   localStorage, scoped to ONE conversation, and merges it back on reload WITHOUT
   creating duplicates. It is deliberately a tiny, DOM-free, pure-ish module so
   it can be unit-tested in isolation and reused by live-chat.js as a global.

   OWNERSHIP / ACCOUNT SWITCHING. The outbox is keyed to a single `owner` — the
   customer's `conversation_id`. A read for a DIFFERENT owner returns nothing and
   the stored set is treated as not-ours: so when a second customer signs in on
   the same browser (account switch) or the customer logs out, the previous
   person's unsent drafts are never shown to, retried by, or attributed to
   anyone else. `clear()` wipes it outright on sign-out.

   DEDUP. Every message carries a `client_msg_id`; the server stores it at most
   once (a unique index). `merge()` drops any outbox item whose `client_msg_id`
   already appears in the server list — i.e. it DID reach the server after all —
   so a reconnect that replays the outbox can never double-post.

   localStorage can throw (private mode, quota, disabled) or return junk; every
   access is guarded and failure degrades to "no persistence", never an error.
   =========================================================================== */
(function (root) {
  'use strict';

  const KEY = 'jpc_chat_outbox';
  const MAX = 50; // a sane cap; a real person does not queue 50 unsent lines.

  function store() {
    try { return root.localStorage || null; } catch (_) { return null; }
  }

  /** The raw {owner, items[]} record, always well-formed even from junk. */
  function readRaw() {
    const s = store();
    if (!s) return { owner: null, items: [] };
    let v;
    try { v = JSON.parse(s.getItem(KEY) || '{}'); } catch (_) { return { owner: null, items: [] }; }
    if (!v || typeof v !== 'object') return { owner: null, items: [] };
    return { owner: v.owner == null ? null : v.owner, items: Array.isArray(v.items) ? v.items : [] };
  }

  function writeRaw(owner, items) {
    const s = store();
    if (!s) return;
    try {
      s.setItem(KEY, JSON.stringify({ owner: owner == null ? null : owner, items: items.slice(-MAX) }));
    } catch (_) { /* quota / disabled: persistence is best-effort */ }
  }

  function sameOwner(a, b) {
    return a != null && b != null && String(a) === String(b);
  }

  /** The unsent items belonging to THIS owner. A mismatch (account switch /
   *  logout / fresh browser) yields [] — another person's drafts are not ours. */
  function pending(owner) {
    const raw = readRaw();
    return sameOwner(raw.owner, owner) ? raw.items.slice() : [];
  }

  /** Persist one unsent message for `owner` (keyed by client_msg_id — a repeat
   *  replaces, never duplicates). Switching owner starts a fresh set. */
  function remember(owner, msg) {
    if (!msg || !msg.client_msg_id) return;
    const raw = readRaw();
    const base = sameOwner(raw.owner, owner) ? raw.items : [];
    const items = base.filter(m => m.client_msg_id !== msg.client_msg_id);
    items.push({ client_msg_id: msg.client_msg_id, body: msg.body, created_at: msg.created_at });
    writeRaw(owner, items);
  }

  /** Drop one message from the outbox once it is confirmed delivered. */
  function forget(owner, clientMsgId) {
    const raw = readRaw();
    if (!sameOwner(raw.owner, owner)) return;
    writeRaw(owner, raw.items.filter(m => m.client_msg_id !== clientMsgId));
  }

  /** Wipe the outbox entirely (sign-out). */
  function clear() {
    const s = store();
    if (s) { try { s.removeItem(KEY); } catch (_) { /* ignore */ } }
  }

  /** Server messages + any still-unsent outbox items, without duplicates.
   *  An outbox item whose client_msg_id already appears server-side is dropped
   *  (it reached the server; the idempotency key matched). The rest are appended
   *  as `pending` bubbles so the customer still sees — and can retry — them. */
  function merge(serverMessages, outboxItems) {
    const server = Array.isArray(serverMessages) ? serverMessages : [];
    const seen = new Set(server.map(m => m && m.client_msg_id).filter(Boolean));
    const extras = (Array.isArray(outboxItems) ? outboxItems : [])
      .filter(m => m && m.client_msg_id && !seen.has(m.client_msg_id))
      .map(m => ({
        client_msg_id: m.client_msg_id,
        sender_type: 'customer',
        message_type: 'text',
        body: m.body,
        created_at: m.created_at,
        pending: true,
      }));
    return server.concat(extras);
  }

  const api = { KEY, readRaw, writeRaw, pending, remember, forget, clear, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatOutbox = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
