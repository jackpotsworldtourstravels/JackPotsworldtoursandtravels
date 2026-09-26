'use strict';
/* ===========================================================================
   jw-interest.js — a small, private memory of what a traveller has been
   looking at, so the landing page can pick up where they left off.
   ===========================================================================
   ONE SIGNAL, KEPT LOCALLY. It records the destinations a person actually
   opened — nothing is sent anywhere, nothing is read from the account, and a
   signed-out visitor is served exactly the same way as a signed-in one. The
   store is a short list in localStorage; clearing site data clears it, which is
   the right amount of permanence for "recently viewed".

   IT NEVER NAMES A PLACE ITSELF. Every entry is handed to record() by a page
   that already loaded that destination from the API, so this file carries no
   city list and cannot show somewhere the catalogue does not.

   FAIL-QUIET. Private-mode storage throws on write and can come back empty on
   read; both are caught and treated as "no history", so the worst case is the
   Recommended shelf simply not appearing — never an error on the page.
   =========================================================================== */
(function (global) {
  const KEY = 'jw_recent_dest';
  const CAP = 8;              /* more than any shelf shows; trims the oldest */

  function read() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, CAP))); } catch { /* private mode */ }
  }

  /** Remember a destination the traveller just opened. Deduped by id and moved
   *  to the front, so the list is most-recent-first. Only the few fields a card
   *  needs are kept — id (the slug the page routes on), name, country and the
   *  image key — never anything about who is looking. */
  function record(dest) {
    if (!dest || dest.id == null || !dest.name) return;
    const entry = {
      id: String(dest.id),
      name: String(dest.name),
      country: dest.country || '',
      image: dest.image || '',
      at: Date.now(),
    };
    const list = read().filter(d => d.id !== entry.id);
    list.unshift(entry);
    write(list);
  }

  /** The most recent `n` destinations (default: everything kept). */
  function recent(n) {
    return read().slice(0, n == null ? CAP : n);
  }

  function clear() { try { localStorage.removeItem(KEY); } catch { /* private mode */ } }

  global.JWInterest = { record, recent, clear };
})(window);
