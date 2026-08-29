'use strict';
/* ===========================================================================
   booking-api.js — the booking flow's line to the server.
   ===========================================================================
   THE ONE PLACE THE BOOKING FLOW TALKS TO THE BACKEND. booking-data.js and
   booking-store.js were written against a seam ("when the real endpoints land,
   only this file changes") and this is what landed behind it.

   WHAT MOVED, AND WHY IT MATTERS. The browser used to build its own seat map,
   know its own add-on prices, add the fare up itself and mint its own PNR. All
   four are now the server's job:

     seat map   GET  /api/customer/flights/seatmap
     add-ons    GET  /api/customer/addons
     the fare   POST /api/customer/bookings/quote
     the booking POST /api/customer/bookings

   Note what quote() sends: the flight, the party, seat ids, add-on codes, a
   coupon — and no money at all. A total this file computed would be a total
   the server had no reason to believe, so it does not compute one. Whatever
   the Fare Summary shows is the last answer the server gave.

   PRODUCTS OTHER THAN FLIGHTS ARE UNTOUCHED. Hotels, cruises, packages and
   visa still run on booking-data.js's local generators, because they have no
   backend yet. isLive() is what each call site checks, so the four of them
   keep working exactly as before rather than failing against endpoints that do
   not exist for them.
   =========================================================================== */

const BookingApi = (function () {

  /* Same base the rest of the site uses — same-origin in production, the local
     uvicorn in development. Deliberately read from the global rather than
     redefined, so there is one answer to "where is the API". */
  const base = () => (typeof API_BASE === 'string' ? API_BASE : '');

  /** Flights, hotels and packages have a booking backend. Cruises and visa
   *  stay local for now. */
  function isLive(productKind) {
    return productKind === 'flight' || productKind === 'hotel' || productKind === 'package';
  }

  function authHeaders() {
    try {
      const a = (typeof getCustomerAuth === 'function') ? getCustomerAuth() : null;
      return (a && a.access) ? { Authorization: `Bearer ${a.access}` } : {};
    } catch { return {}; }
  }

  function isSignedIn() {
    try {
      return !!(typeof getCustomerAuth === 'function' && getCustomerAuth().access);
    } catch { return false; }
  }

  /** Pull the readable message out of a FastAPI error rather than showing
   *  "Request failed with status code 400" to somebody booking a holiday. */
  function errorText(err, fallback) {
    const d = err && err.data;
    if (typeof d === 'string' && d) return d;
    if (d && typeof d.detail === 'string') return d.detail;
    if (d && Array.isArray(d.detail) && d.detail.length) {
      const first = d.detail[0];
      return first.msg ? first.msg.replace(/^Value error,\s*/, '') : fallback;
    }
    return (err && err.message) || fallback || 'Something went wrong. Please try again.';
  }

  /* fetch, not axios: axios is loaded on index.html but NOT on the travel
     pages, which is where the booking flow actually runs. booking-store.js
     already talks to the API with fetch for the same reason — using it here
     keeps this file working on every page that can open a booking, with no
     new dependency to load. */
  class ApiError extends Error {
    constructor(status, data) {
      super((data && data.detail) || `Request failed (${status})`);
      this.status = status;
      this.data = data;
      /* Kept so existing `err.response.status` checks keep reading true. */
      this.response = { status, data };
    }
  }

  async function request(method, path, { params, body } = {}) {
    let url = `${base()}${path}`;
    if (params) {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
      ).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  const get = (path, params) => request('GET', path, { params });
  const post = (path, body) => request('POST', path, { body: body || {} });

  /* ---------------------------------------------------------------------
     Catalogue
     --------------------------------------------------------------------- */
  const seatMap = (flightKey, rows) =>
    get('/api/customer/flights/seatmap', { flight_key: flightKey, ...(rows ? { rows } : {}) });

  const addons = (productType) =>
    get('/api/customer/addons', { product_type: productType || 'flight' });

  const reference = () => get('/api/customer/reference');

  const paymentMethods = () => get('/api/customer/payment-methods');

  /* ---------------------------------------------------------------------
     Pricing
     --------------------------------------------------------------------- */
  /**
   * Ask the server what the booking currently costs.
   * @param {object} flight  the FlightInput payload — see flightPayload()
   * @param {string[]} passengerTypes  'adult' | 'child' | 'infant', in order
   * @param {object[]} seats  [{ passenger_index, seat_number }]
   * @param {object[]} addonCodes  [{ code, passenger_index? }]
   */
  const quote = (flight, passengerTypes, seats, addonCodes, couponCode) =>
    post('/api/customer/bookings/quote', {
      flight,
      passenger_types: passengerTypes,
      seats: seats || [],
      addons: addonCodes || [],
      coupon_code: couponCode || null,
    });

  /** Coupons that could apply to a product — the "view available" panel.
   *  Listing is not applying: what a code is worth depends on the fare, which
   *  is what validateCoupon() answers. */
  const coupons = (productType) =>
    get('/api/customer/coupons', { product_type: productType || 'flight' });

  const validateCoupon = (code, flight, passengerTypes) =>
    post('/api/customer/coupons/validate', {
      code, flight, passenger_types: passengerTypes,
    });

  /* ---------------------------------------------------------------------
     Travellers — the saved list, and the passport auto-fill behind it
     --------------------------------------------------------------------- */
  const travellers = () => get('/api/customer/travellers');

  /** Returns the saved traveller with this passport, or null.
   *  A 404 is the normal "we have not seen this passport" answer, not an
   *  error worth surfacing — the traveller simply fills the form in. */
  async function lookupPassport(passportNumber) {
    try {
      return await get('/api/customer/travellers/lookup', { passport_number: passportNumber });
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }

  const saveTraveller = (payload) => post('/api/customer/travellers', payload);

  /** Whether the traveller step should offer a "Upload Passport" control at
   *  all — a deployment with no OCR provider configured answers `false`, and
   *  the form renders no control rather than one that fails when pressed.
   *  Never throws: a check that itself failed should read the same as "no". */
  async function ocrAvailability() {
    try {
      const res = await get('/api/customer/travellers/passport/availability');
      return !!(res && res.available);
    } catch { return false; }
  }

  /** Upload a passport photo/PDF and get back the fields it could read, each
   *  with its own confidence. Multipart, so it bypasses `request()`'s JSON
   *  body — the browser sets its own `Content-Type` boundary. */
  async function extractPassport(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${base()}/api/customer/travellers/passport/extract`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  /* ---------------------------------------------------------------------
     Bookings
     --------------------------------------------------------------------- */
  const createBooking = (payload) => post('/api/customer/bookings', payload);

  const listBookings = () => get('/api/customer/bookings');

  const getBooking = (ref) => get(`/api/customer/bookings/${encodeURIComponent(ref)}`);

  const payBooking = (ref, method) =>
    post(`/api/customer/bookings/${encodeURIComponent(ref)}/pay`, { method });

  const cancelBooking = (ref) =>
    post(`/api/customer/bookings/${encodeURIComponent(ref)}/cancel`, {});

  /* ---------------------------------------------------------------------
     Hotels — its own path, its own table, its own reference series (JPH######).
     Mirrors the flight functions above one-for-one; kept separate rather than
     branching every flight function on kind, so neither reads like the other
     product's code.
     --------------------------------------------------------------------- */
  const searchHotels = () => get('/api/customer/hotels');

  const getHotelDetail = (hotelId) => get(`/api/customer/hotels/${encodeURIComponent(hotelId)}`);

  const hotelAddons = () => get('/api/customer/hotels/addons');

  const quoteHotel = (stay, addonCodes, couponCode) =>
    post('/api/customer/hotel-bookings/quote', {
      stay, addons: addonCodes || [], coupon_code: couponCode || null,
    });

  const createHotelBooking = (payload) => post('/api/customer/hotel-bookings', payload);

  const listHotelBookings = () => get('/api/customer/hotel-bookings');

  const getHotelBooking = (ref) => get(`/api/customer/hotel-bookings/${encodeURIComponent(ref)}`);

  const payHotelBooking = (ref, method) =>
    post(`/api/customer/hotel-bookings/${encodeURIComponent(ref)}/pay`, { method });

  const cancelHotelBooking = (ref) =>
    post(`/api/customer/hotel-bookings/${encodeURIComponent(ref)}/cancel`, {});

  /** The stay, in the shape StayInput wants. ``ctx.room.id`` is the string
   *  form of the real room id (see getHotelDetail/hotelRoomsPayload) — Number()
   *  here is the one place it becomes the integer the schema requires. */
  function hotelPayload(ctx) {
    /* Room Selection produces one room per room booked, which is what lets a
       stay mix room types (StayInput.room_ids, migration 0058). Absent — any
       flow that has not been through that screen — the stay is still
       `rooms_count` of the single `room_id`, exactly as before. */
    const picks = Array.isArray(ctx.roomPicks) ? ctx.roomPicks.filter(Boolean) : [];
    const roomsCount = ctx.roomCount || 1;

    /* The ages the search panel collected. `StayInput` has always accepted
       child_ages and `customer_hotel_bookings` has always had a column for
       them; this used to send a hard-coded empty list, so no age ever reached
       either. `ctx.roomsList` is where the search panel keeps them. */
    const list = Array.isArray(ctx.roomsList) ? ctx.roomsList : null;
    const ages = list
      ? list.flatMap(r => Array.from({ length: Number(r.children) || 0 },
          (_, i) => Number((r.childAges || [])[i] ?? 8)))
      : [];

    return {
      hotel_id: Number(ctx.item && ctx.item.id),
      room_id: Number(picks.length ? picks[0].id : (ctx.room && ctx.room.id)),
      ...(picks.length === roomsCount ? { room_ids: picks.map(p => Number(p.id)) } : {}),
      check_in: ctx.checkIn,
      check_out: ctx.checkOut,
      rooms_count: roomsCount,
      adults: (ctx.paxKinds || []).filter(k => String(k).toLowerCase() !== 'child').length || 1,
      children: (ctx.paxKinds || []).filter(k => String(k).toLowerCase() === 'child').length,
      child_ages: ages,
    };
  }

  /** Add-ons, as codes — every hotel extra is billed once per booking, so
   *  there is no passenger_index to carry. */
  function hotelAddonPayload(ctx) {
    return (ctx.addons || [])
      .map(a => (a && (a.code || a.id) ? { code: a.code || a.id } : null))
      .filter(Boolean);
  }

  /* ---------------------------------------------------------------------
     Packages — its own path, its own table, its own reference series
     (JPP######). Mirrors the hotel functions above one-for-one.
     --------------------------------------------------------------------- */
  const packageAddons = () => get('/api/customer/packages/addons');

  const quotePackage = (trip, addonCodes, couponCode) =>
    post('/api/customer/package-bookings/quote', {
      trip, addons: addonCodes || [], coupon_code: couponCode || null,
    });

  const createPackageBooking = (payload) => post('/api/customer/package-bookings', payload);

  const listPackageBookings = () => get('/api/customer/package-bookings');

  const getPackageBooking = (ref) => get(`/api/customer/package-bookings/${encodeURIComponent(ref)}`);

  const payPackageBooking = (ref, method) =>
    post(`/api/customer/package-bookings/${encodeURIComponent(ref)}/pay`, { method });

  const cancelPackageBooking = (ref) =>
    post(`/api/customer/package-bookings/${encodeURIComponent(ref)}/cancel`, {});

  /** The trip, in the shape TripInput wants. ``ctx.departure.id`` and
   *  ``ctx.item.id`` are the string forms of the real ids returned by the
   *  departures/packages endpoints — Number() here is the one place either
   *  becomes the integer the schema requires. */
  function packagePayload(ctx) {
    return {
      package_id: Number(ctx.item && ctx.item.id),
      departure_id: Number(ctx.departure && ctx.departure.id),
      pax_count: ctx.paxCount || 1,
    };
  }

  /** Add-ons, as codes. Travel insurance is priced per traveller server-side
   *  when no traveller_index is given, same as a flight per-passenger add-on. */
  function packageAddonPayload(ctx) {
    return (ctx.addons || [])
      .map(a => (a && (a.code || a.id) ? { code: a.code || a.id, traveller_index: null } : null))
      .filter(Boolean);
  }

  /* ---------------------------------------------------------------------
     Shaping the draft into what the API expects
     --------------------------------------------------------------------- */
  /** Minutes from a "2h 25m" style label, so the server can re-derive the
   *  fare. Returns null when the label says nothing useful — the server
   *  falls back to its own default rather than being handed a guess. */
  function durationMinutes(item) {
    if (typeof item.durationMinutes === 'number') return item.durationMinutes;
    const label = item.durationLabel || '';
    const h = /(\d+)\s*h/.exec(label);
    const m = /(\d+)\s*m/.exec(label);
    if (!h && !m) return null;
    return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
  }

  /** The itinerary, in the shape FlightInput wants. */
  function flightPayload(ctx) {
    const f = ctx.item || {};
    return {
      flight_key: String(f.id || f.flightNumber || 'unknown'),
      flight_number: String(f.flightNumber || 'XX000'),
      airline: f.airline || null,
      origin_code: (f.origin && f.origin.code) || null,
      origin_city: (f.origin && f.origin.city) || null,
      destination_code: (f.destination && f.destination.code) || null,
      destination_city: (f.destination && f.destination.city) || null,
      travel_date: f.date || null,
      departure_time: f.departure || null,
      arrival_time: f.arrival || null,
      duration_label: f.durationLabel || null,
      duration_minutes: durationMinutes(f),
      stops: f.stops || 0,
      cabin_class: ctx.cabin || 'economy',
      is_international: !!isInternational(f),
    };
  }

  /** International if either end is outside India.
   *
   *  This is what turns the passport rules on, so it is deliberately
   *  conservative: anything the itinerary does not clearly mark as domestic
   *  counts as international, because asking for a passport that turns out not
   *  to be needed is a smaller failure than not asking for one that was. */
  function isInternational(item) {
    if (!item) return false;
    if (typeof item.isInternational === 'boolean') return item.isInternational;
    const home = c => !c || String(c).trim().toLowerCase() === 'india';
    const oc = item.origin && (item.origin.country || item.origin.nation);
    const dc = item.destination && (item.destination.country || item.destination.nation);
    if (oc === undefined && dc === undefined) return false;   // domestic sample data
    return !(home(oc) && home(dc));
  }

  /** Seats, as [{ passenger_index, seat_number }] — prices deliberately absent. */
  function seatPayload(ctx) {
    return (ctx.seats || [])
      .map((s, i) => (s && s.id ? { passenger_index: i, seat_number: s.id } : null))
      .filter(Boolean);
  }

  /** Add-ons, as codes. What each costs is the server's business. */
  function addonPayload(ctx) {
    return (ctx.addons || [])
      .map(a => (a && (a.code || a.id) ? {
        code: a.code || a.id,
        passenger_index: (a.passengerIndex === undefined ? null : a.passengerIndex),
      } : null))
      .filter(Boolean);
  }

  function passengerTypes(ctx) {
    const kinds = ctx.paxKinds || [];
    const n = Math.max(1, ctx.paxCount || 1);
    return Array.from({ length: n }, (_, i) => String(kinds[i] || 'Adult').toLowerCase());
  }

  return {
    isLive, isSignedIn, errorText,
    seatMap, addons, reference, paymentMethods,
    quote, validateCoupon, coupons,
    travellers, lookupPassport, saveTraveller, ocrAvailability, extractPassport,
    createBooking, listBookings, getBooking, payBooking, cancelBooking,
    flightPayload, seatPayload, addonPayload, passengerTypes,
    isInternational, durationMinutes,
    searchHotels, getHotelDetail, hotelAddons, quoteHotel,
    createHotelBooking, listHotelBookings, getHotelBooking,
    payHotelBooking, cancelHotelBooking, hotelPayload, hotelAddonPayload,
    packageAddons, quotePackage, createPackageBooking, listPackageBookings,
    getPackageBooking, payPackageBooking, cancelPackageBooking,
    packagePayload, packageAddonPayload,
  };
})();
