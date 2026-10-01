/* ===========================================================================
   search-persist.js — per-product search persistence.

   ONE small store, shared by every page that carries a search. It keeps the
   LAST structured search for each product separately, so switching products or
   coming back to a page restores what was asked for rather than a default.

   WHY A SHARED MODULE AND NOT PER-PAGE localStorage CALLS. Four products, two
   kinds of page (the landing card and the results pages) and a handful of
   widgets all need the same three operations with the same keys and the same
   guards. Written once here, they cannot drift: a results page cannot invent a
   key the landing card does not read, and the PII guard below cannot be
   forgotten at one of the call sites.

   WHAT IS STORED. Only the structured search VALUES — the same object a page's
   criteria()/state already holds (airports, dates, party, cabin, destination,
   rooms, trip type, …). Never DOM HTML, never anything the page can re-derive.

   WHAT IS NOT STORED. No passwords, payment or card details, OTPs or tokens,
   and no enquiry contact details (name / email / phone). `sanitize()` strips
   those keys defensively even if a caller passes them, and callers that handle
   an enquiry (the hotel Group desk, the gaming enquiry form) do not call save()
   for the contact fields at all.

   PRECEDENCE, decided by the CALLERS, not here: an explicit search in the URL
   wins over a stored one, which wins over the page's own defaults. This module
   only remembers; each page chooses when to read it.

   Degrades silently. Private mode, a full quota or a blocked store all leave
   `available()` false and every call a no-op, so a page that cannot persist
   still works exactly as it did before persistence existed.
   =========================================================================== */
(function (global) {
  'use strict';

  /* One namespace, one key per product: the states can never overwrite one
     another because they never share a key. */
  var NS = 'jp.search.';
  var TAB_KEY = 'jp.search.tab';   // the landing card's last-open product tab
  var VERSION = 1;                 // bump to invalidate every stored search

  /* Keys that must never be persisted, whatever a caller passes. These are
     sensitive (there is none here today, but the guard is the contract) or
     belong to an enquiry rather than a repeatable search. */
  var BLOCKED = [
    'name', 'email', 'phone', 'mobile', 'company', 'notes',
    'password', 'card', 'cardNumber', 'cvv', 'cvc', 'otp', 'token',
  ];

  function probe() {
    try {
      var k = '__jp_search_probe__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  var OK = probe();

  /* A shallow copy with the blocked keys removed. Scalars, arrays and plain
     nested objects (roomsDetail is an array of {adults, childAges}) are kept as
     they are — they are exactly what the seeders read back. Functions and
     undefined are dropped because JSON would drop them anyway. */
  function sanitize(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      if (BLOCKED.indexOf(k) !== -1) return;
      var v = obj[k];
      if (v === undefined || typeof v === 'function') return;
      out[k] = v;
    });
    return out;
  }

  function save(product, criteria) {
    if (!OK || !product) return;
    try {
      var payload = { v: VERSION, t: Date.now(), data: sanitize(criteria) };
      global.localStorage.setItem(NS + product, JSON.stringify(payload));
    } catch (e) { /* quota or private mode — the search is simply re-run */ }
  }

  function load(product) {
    if (!OK || !product) return null;
    try {
      var raw = global.localStorage.getItem(NS + product);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || p.v !== VERSION || !p.data || typeof p.data !== 'object') return null;
      return p.data;
    } catch (e) { return null; }
  }

  function clear(product) {
    if (!OK) return;
    try { global.localStorage.removeItem(NS + (product || '')); } catch (e) { /* ignore */ }
  }

  function saveTab(tab) {
    if (!OK || !tab) return;
    try { global.localStorage.setItem(TAB_KEY, String(tab)); } catch (e) { /* ignore */ }
  }

  function loadTab() {
    if (!OK) return null;
    try { return global.localStorage.getItem(TAB_KEY) || null; } catch (e) { return null; }
  }

  global.JPSearchStore = {
    save: save,
    load: load,
    clear: clear,
    saveTab: saveTab,
    loadTab: loadTab,
    available: function () { return OK; },
  };
})(window);
