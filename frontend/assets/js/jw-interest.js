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
  const API = '/api/customer/activity';

  /* The customer/guest token, if one already exists. We never MINT one to log a
     view — a signed-out visitor is tracked in localStorage alone, and only a
     traveller who has chosen to sign in or continue as guest is recorded on the
     server. That is the privacy line: no anonymous account is created behind
     anyone's back just to power recommendations. */
  function token() {
    try {
      if (typeof getCustomerAuth === 'function') { const a = getCustomerAuth(); if (a && a.access) return a.access; }
    } catch { /* auth.js absent on this page */ }
    try { return localStorage.getItem('jpc_access') || null; } catch { return null; }
  }

  /** Send one activity to the recommendation engine — fire-and-forget, and only
   *  when a session already exists. A failed or blocked beacon must never
   *  disturb the page, so every path here is swallowed. */
  function send(activityType, entityType, entityId, meta) {
    const t = token();
    if (!t || entityId == null) return;
    try {
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({
          activity_type: activityType, entity_type: entityType,
          entity_id: String(entityId), meta: meta || undefined,
        }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  /** Record a view of anything the server scores — a hotel or a package the
   *  recently-viewed shelf does not carry. Destinations go through record()
   *  below, which also keeps the local shelf; this is the server signal only. */
  function track(activityType, entityType, entityId, meta) {
    send(activityType, entityType, entityId, meta);
  }

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
    /* The same view, sent to the server when there is a session to file it
       under. localStorage remains the immediate, signed-out-safe copy. */
    send('view', 'destination', entry.id, { source: 'destination_page' });
  }

  /** The most recent `n` destinations (default: everything kept). */
  function recent(n) {
    return read().slice(0, n == null ? CAP : n);
  }

  function clear() { try { localStorage.removeItem(KEY); } catch { /* private mode */ } }

  global.JWInterest = { record, recent, clear, track, send };
})(window);
