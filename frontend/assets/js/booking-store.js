'use strict';
/* ===========================================================================
   booking-store.js — where a completed demo booking lives.
   ===========================================================================
   THIS IS THE OTHER SEAM. travel-data.js and booking-data.js are read paths;
   this is the write path. Every function is async and returns the same shapes a
   real endpoint would, so switching to the server is this file only:

       BookingStore.config.useLiveApi = true
       BookingStore.config.endpoints.create = '/api/customer/bookings'

   Bookings are kept in localStorage under the customer namespace (jpc_*), so
   they survive a reload — a demo where My Bookings empties on refresh is not a
   demo of anything.

   THE BOOKING IS STAMPED, NOT INVENTED AT READ TIME. Reference, PNR, ticket
   numbers and the booked-at timestamp are written once at creation. Generating
   them in the renderer would give a different PNR every time the page painted.
   =========================================================================== */

const BookingStore = (function () {

  const KEY = 'jpc_bookings';

  const CONFIG = {
    useLiveApi: false,
    endpoints: {
      create: '/api/customer/bookings',
      list:   '/api/customer/bookings',
      cancel: '/api/customer/bookings/{id}/cancel',
    },
  };

  /* Product -> how it is labelled and which reference series it uses. */
  const KINDS = {
    flight:  { label: 'Flight',       prefix: 'FL', icon: 'flights' },
    hotel:   { label: 'Hotel',        prefix: 'HT', icon: 'hotels' },
    cruise:  { label: 'Cruise',       prefix: 'CR', icon: 'cruises' },
    package: { label: 'Tour Package', prefix: 'TP', icon: 'packages' },
    visa:    { label: 'Visa',         prefix: 'VA', icon: 'visa' },
  };

  /* ---------------------------------------------------------------------
     Reference generation

     Shapes chosen to look like the real thing, because that is the point of a
     demo: a 6-character alphanumeric PNR, and an IATA-style ticket number
     (3-digit airline code, then 10 digits).
     --------------------------------------------------------------------- */
  /* I and O are omitted on purpose — airlines leave them out of PNRs because
     they are unreadable next to 1 and 0 on a printed ticket. */
  const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

  function randomFrom(alphabet, length) {
    let out = '';
    const buf = new Uint32Array(length);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (let i = 0; i < length; i++) out += alphabet[buf[i] % alphabet.length];
    return out;
  }

  function makePnr() { return randomFrom(PNR_ALPHABET, 6); }

  function makeTicketNumber(airlineCode) {
    /* Real prefixes: 098 Air India, 6E IndiGo does not issue 13-digit stock,
       but a demo ticket needs to look like a ticket. */
    const PREFIX = { AI: '098', IX: '098', QP: '941', GF: '072', '6E': '312' };
    const p = PREFIX[airlineCode] || '098';
    return `${p}-${randomFrom('0123456789', 10)}`;
  }

  function makeReference(kind) {
    const k = KINDS[kind] || { prefix: 'BK' };
    return `JW${k.prefix}${randomFrom('0123456789', 7)}`;
  }

  /* ---------------------------------------------------------------------
     Persistence
     --------------------------------------------------------------------- */
  function readAll() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch { return []; }        // corrupted value must not break the page
  }
  function writeAll(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); }
    catch { /* private mode / quota — the booking still shows this session */ }
  }

  /** Whose bookings these are. Demo bookings made signed-out belong to
   *  'guest' so signing in later does not silently adopt them. */
  function currentCustomerId() {
    try {
      return (typeof getCustomerAuth === 'function' && getCustomerAuth().access)
        ? (getCustomerAuth().userId || 'me') : 'guest';
    } catch { return 'guest'; }
  }

  async function getJson(url, options) {
    const base = (typeof API_BASE === 'string') ? API_BASE : '';
    const res = await fetch(`${base}${url}`, options);
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.json();
  }

  /* ---------------------------------------------------------------------
     API
     --------------------------------------------------------------------- */

  /**
   * Persist a completed booking.
   * @param {object} draft { kind, title, subtitle, travelDate, total, currency,
   *                         passengers, items, addons, payment, meta }
   * @returns the stored booking, stamped with its references.
   */
  async function create(draft) {
    if (CONFIG.useLiveApi) {
      return getJson(CONFIG.endpoints.create, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(typeof customerAuthHeaders === 'function' ? customerAuthHeaders() : {}) },
        body: JSON.stringify(draft),
      });
    }

    const now = new Date();
    const kind = draft.kind || 'flight';
    const booking = {
      ...draft,
      id: makeReference(kind),
      kind,
      kindLabel: (KINDS[kind] || {}).label || kind,
      icon: (KINDS[kind] || {}).icon || 'flights',
      status: 'Confirmed',
      bookedAt: now.toISOString(),
      customerId: currentCustomerId(),
      /* Only air travel carries a PNR and a ticket number. Stamping a hotel
         with one would look wrong to anyone who books travel for a living. */
      pnr: kind === 'flight' ? makePnr() : null,
      ticketNumber: kind === 'flight' ? makeTicketNumber(draft.airlineCode) : null,
      demo: true,
    };

    const all = readAll();
    all.unshift(booking);          // newest first, which is how the list reads
    writeAll(all);
    return booking;
  }

  /** Every booking for the signed-in customer, newest first. */
  async function list() {
    if (CONFIG.useLiveApi) {
      const body = await getJson(CONFIG.endpoints.list, {
        headers: (typeof customerAuthHeaders === 'function' ? customerAuthHeaders() : {}),
      });
      return Array.isArray(body) ? body : (body.results || body.items || []);
    }
    const me = currentCustomerId();
    /* A guest's demo bookings stay visible once they sign in — otherwise the
       booking someone just made vanishes the moment they log in to look at it,
       which in a demo reads as a bug. */
    return readAll().filter(b => b.customerId === me || b.customerId === 'guest');
  }

  async function get(id) {
    return (await list()).find(b => b.id === id) || null;
  }

  /** Demo cancellation: status only, and the row stays in the list. */
  async function cancel(id) {
    if (CONFIG.useLiveApi) {
      return getJson(CONFIG.endpoints.cancel.replace('{id}', encodeURIComponent(id)), {
        method: 'POST',
        headers: (typeof customerAuthHeaders === 'function' ? customerAuthHeaders() : {}),
      });
    }
    const all = readAll();
    const b = all.find(x => x.id === id);
    if (!b) return null;
    b.status = 'Cancelled';
    b.cancelledAt = new Date().toISOString();
    writeAll(all);
    return b;
  }

  /** Demo housekeeping — used by the empty-state's "clear demo bookings". */
  async function clearAll() { writeAll([]); }

  return { config: CONFIG, KINDS, create, list, get, cancel, clearAll,
           makePnr, makeReference };
})();
