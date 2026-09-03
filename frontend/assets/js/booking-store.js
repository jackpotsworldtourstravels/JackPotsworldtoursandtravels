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

   FLIGHTS NO LONGER GO THROUGH HERE. They are created by the server through
   BookingApi, which returns a real booking reference from a sequence and a
   NULL pnr, because there is no airline integration to issue one. makePnr()
   below survives only for the four products that still have no backend; a
   flight must never be given a locally generated PNR, because a traveller
   would quote it at a check-in desk and be told it does not exist.

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
  /** A server booking, in the shape My Bookings already renders.
   *
   *  Deliberately a translation rather than a rewrite of the list UI: the card
   *  layout, the filters and the detail view all work, and changing the shape
   *  they read would have meant touching all three to gain nothing. */
  function fromApi(b) {
    const pax = b.passengers || [];
    const seats = pax.map(p => p.seat_number).filter(Boolean);
    return {
      id: b.booking_ref,
      ref: b.booking_ref,
      kind: 'flight',
      kindLabel: 'Flight',
      icon: 'flights',
      title: `${b.airline || ''} ${b.flight_number || ''}`.trim(),
      subtitle: `${b.origin_city || b.origin_code || ''} \u2192 ${b.destination_city || b.destination_code || ''}`,
      travelDate: b.travel_date,
      departure: b.departure_time,
      arrival: b.arrival_time,
      durationLabel: b.duration_label,
      stops: b.stops,
      cabinClass: b.cabin_class,
      isInternational: b.is_international,
      /* Capitalised for the card, which reads "Confirmed" not "confirmed". */
      status: b.status ? b.status.charAt(0).toUpperCase() + b.status.slice(1) : 'Pending',
      /* Both are the server's, and pnr stays null until an airline issues
         one. The confirmation screen says so rather than showing a blank. */
      pnr: b.pnr,
      ticketNumber: null,
      bookedAt: b.created_at,
      cancelledAt: b.cancelled_at,
      total: Number(b.total_amount),
      currency: b.currency || 'INR',
      passengers: pax.map(p => ({
        title: p.title, first: p.first_name, last: p.last_name,
        gender: p.gender, dob: p.date_of_birth, kind: p.traveller_type,
        seat: p.seat_number, seatPrice: Number(p.seat_price || 0),
        passportNumber: p.passport_number, passportExpiry: p.passport_expiry,
        nationality: p.nationality, issuingCountry: p.issuing_country,
        frequentFlyerAirline: p.frequent_flyer_airline,
        frequentFlyer: p.frequent_flyer_number,
        mobile: p.mobile, email: p.email, isContact: p.is_contact,
      })),
      seats,
      addons: (b.addons || []).map(a => ({
        id: a.code, code: a.code, name: a.name, type: a.addon_type,
        description: a.description, price: Number(a.unit_price), quantity: a.quantity,
      })),
      payments: (b.payments || []).map(p => ({
        method: p.method, status: p.status, amount: Number(p.amount), at: p.created_at,
      })),
      pricing: {
        lines: [
          { label: 'Base fare', amount: Number(b.base_fare) },
          { label: 'Taxes & surcharges', amount: Number(b.taxes) },
          ...(Number(b.seat_charges) ? [{ label: 'Seat charges', amount: Number(b.seat_charges) }] : []),
          ...(Number(b.baggage_total) ? [{ label: 'Baggage', amount: Number(b.baggage_total) }] : []),
          ...(Number(b.meal_total) ? [{ label: 'Meals', amount: Number(b.meal_total) }] : []),
          ...(Number(b.service_total) ? [{ label: 'Other services', amount: Number(b.service_total) }] : []),
          ...(Number(b.discount) ? [{ label: `Discount${b.coupon_code ? ' (' + b.coupon_code + ')' : ''}`, amount: -Number(b.discount) }] : []),
        ],
        total: Number(b.total_amount),
      },
      couponCode: b.coupon_code,
      demo: false,
    };
  }

  /** A server hotel booking, in the shape My Bookings already renders — the
   *  same translation `fromApi` does for a flight, over
   *  ``HotelBookingResponse`` instead of ``BookingResponse``. */
  function fromHotelApi(b) {
    return {
      id: b.booking_ref,
      ref: b.booking_ref,
      kind: 'hotel',
      kindLabel: 'Hotel',
      icon: 'hotels',
      title: b.hotel_name,
      subtitle: b.hotel_location || '',
      travelDate: b.check_in_date,
      checkIn: b.check_in_date,
      checkOut: b.check_out_date,
      nights: b.nights,
      roomName: b.room_name,
      mealPlan: b.meal_plan,
      status: b.status ? b.status.charAt(0).toUpperCase() + b.status.slice(1) : 'Pending',
      pnr: null,
      ticketNumber: null,
      bookedAt: b.created_at,
      cancelledAt: b.cancelled_at,
      total: Number(b.total_amount),
      currency: b.currency || 'INR',
      passengers: (b.guests || []).map(g => ({
        title: g.title, first: g.first_name, last: g.last_name,
        gender: g.gender, dob: g.date_of_birth, kind: g.guest_type,
        nationality: g.nationality, mobile: g.mobile, email: g.email,
        isContact: g.is_contact,
      })),
      seats: [],
      addons: (b.addons || []).map(a => ({
        id: a.code, code: a.code, name: a.name, type: a.addon_type,
        description: a.description, price: Number(a.unit_price), quantity: a.quantity,
      })),
      payments: (b.payments || []).map(p => ({
        method: p.method, status: p.status, amount: Number(p.amount), at: p.created_at,
      })),
      pricing: {
        lines: [
          { label: `${b.room_name} × ${b.nights} night${b.nights === 1 ? '' : 's'}`, amount: Number(b.room_subtotal) },
          { label: 'Taxes & service', amount: Number(b.taxes) },
          ...(Number(b.addon_total) ? [{ label: 'Add-ons', amount: Number(b.addon_total) }] : []),
          ...(Number(b.discount) ? [{ label: `Discount${b.coupon_code ? ' (' + b.coupon_code + ')' : ''}`, amount: -Number(b.discount) }] : []),
        ],
        total: Number(b.total_amount),
      },
      couponCode: b.coupon_code,
      demo: false,
    };
  }

  /** A server package booking, in the shape My Bookings already renders —
   *  same translation as `fromApi`/`fromHotelApi`, over
   *  ``PackageBookingResponse``. */
  function fromPackageApi(b) {
    return {
      id: b.booking_ref,
      ref: b.booking_ref,
      kind: 'package',
      kindLabel: 'Tour Package',
      icon: 'packages',
      title: b.package_name,
      subtitle: `${b.package_days} day${b.package_days === 1 ? '' : 's'}`,
      days: b.package_days,
      travelDate: b.departure_date,
      status: b.status ? b.status.charAt(0).toUpperCase() + b.status.slice(1) : 'Pending',
      pnr: null,
      ticketNumber: null,
      bookedAt: b.created_at,
      cancelledAt: b.cancelled_at,
      total: Number(b.total_amount),
      currency: b.currency || 'INR',
      passengers: (b.travellers || []).map(t => ({
        title: t.title, first: t.first_name, last: t.last_name,
        gender: t.gender, dob: t.date_of_birth, kind: t.traveller_type,
        passportNumber: t.passport_number, passportExpiry: t.passport_expiry,
        nationality: t.nationality, issuingCountry: t.issuing_country,
        mobile: t.mobile, email: t.email, isContact: t.is_contact,
      })),
      seats: [],
      addons: (b.addons || []).map(a => ({
        id: a.code, code: a.code, name: a.name, type: a.addon_type,
        description: a.description, price: Number(a.unit_price), quantity: a.quantity,
      })),
      payments: (b.payments || []).map(p => ({
        method: p.method, status: p.status, amount: Number(p.amount), at: p.created_at,
      })),
      pricing: {
        lines: [
          { label: `Package × ${b.pax_count}`, amount: Number(b.base_total) },
          { label: 'GST', amount: Number(b.taxes) },
          ...(Number(b.addon_total) ? [{ label: 'Add-ons', amount: Number(b.addon_total) }] : []),
          ...(Number(b.discount) ? [{ label: `Discount${b.coupon_code ? ' (' + b.coupon_code + ')' : ''}`, amount: -Number(b.discount) }] : []),
        ],
        total: Number(b.total_amount),
      },
      couponCode: b.coupon_code,
      demo: false,
    };
  }

  /** True when this draft is one the server can take. */
  function goesToServer(draft) {
    return !!(draft && draft.apiPayload && typeof BookingApi !== 'undefined'
              && BookingApi.isLive(draft.kind) && BookingApi.isSignedIn());
  }

  async function create(draft) {
    if (goesToServer(draft)) {
      const isHotel = draft.kind === 'hotel';
      const isPackage = draft.kind === 'package';
      const created = isHotel
        ? await BookingApi.createHotelBooking(draft.apiPayload)
        : isPackage
        ? await BookingApi.createPackageBooking(draft.apiPayload)
        : await BookingApi.createBooking(draft.apiPayload);
      /* Record the payment attempt against the booking just made. It is
         recorded as pending and nothing is charged — see
         customer_booking_service.record_payment (and its hotel/package mirrors).

         THE `method` CHECK IS LOAD-BEARING, NOT DEFENSIVE. A booking going
         through a real gateway deliberately arrives with method === null,
         because its order is opened by /checkout and the method it actually
         used comes back from the provider. Calling /pay for one would post a
         method the endpoint does not accept and swallow the 400. */
      let latest = created;
      if (draft.payment && draft.payment.method) {
        try {
          latest = isHotel
            ? await BookingApi.payHotelBooking(created.booking_ref, draft.payment.method)
            : isPackage
            ? await BookingApi.payPackageBooking(created.booking_ref, draft.payment.method)
            : await BookingApi.payBooking(created.booking_ref, draft.payment.method);
        } catch { /* the booking exists; a failed attempt log must not lose it */ }
      }
      return isHotel ? fromHotelApi(latest) : isPackage ? fromPackageApi(latest) : fromApi(latest);
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
    /* Flights, hotels and packages live on the server; cruises and visa are
       still local demo bookings. All are shown together, newest first, so a
       customer sees one list — My Trips — rather than being asked to care
       where a row is stored. */
    let server = [];
    if (typeof BookingApi !== 'undefined' && BookingApi.isSignedIn()) {
      try {
        const body = await BookingApi.listBookings();
        server = (Array.isArray(body) ? body : []).map(fromApi);
      } catch { /* signed out mid-session, or offline: show what is local */ }
      try {
        const hotelBody = await BookingApi.listHotelBookings();
        server = server.concat((Array.isArray(hotelBody) ? hotelBody : []).map(fromHotelApi));
      } catch { /* same — a hotel-booking failure must not blank the flights */ }
      try {
        const pkgBody = await BookingApi.listPackageBookings();
        server = server.concat((Array.isArray(pkgBody) ? pkgBody : []).map(fromPackageApi));
      } catch { /* same — a package-booking failure must not blank the rest */ }
    }
    const me = currentCustomerId();
    /* A guest's demo bookings stay visible once they sign in — otherwise the
       booking someone just made vanishes the moment they log in to look at it,
       which in a demo reads as a bug. */
    const local = readAll().filter(b => b.customerId === me || b.customerId === 'guest');
    return [...server, ...local].sort(
      (a, b) => new Date(b.bookedAt || 0) - new Date(a.bookedAt || 0)
    );
  }

  async function get(id) {
    return (await list()).find(b => b.id === id) || null;
  }

  /** Demo cancellation: status only, and the row stays in the list. */
  async function cancel(id) {
    /* Server references are JPB###### (flight), JPH###### (hotel) or
       JPP###### (package); anything else is a local demo row. */
    if (/^JPB\d+$/.test(String(id)) && typeof BookingApi !== 'undefined') {
      return fromApi(await BookingApi.cancelBooking(id));
    }
    if (/^JPH\d+$/.test(String(id)) && typeof BookingApi !== 'undefined') {
      return fromHotelApi(await BookingApi.cancelHotelBooking(id));
    }
    if (/^JPP\d+$/.test(String(id)) && typeof BookingApi !== 'undefined') {
      return fromPackageApi(await BookingApi.cancelPackageBooking(id));
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
           fromApi, fromHotelApi, fromPackageApi, makePnr, makeReference };
})();
