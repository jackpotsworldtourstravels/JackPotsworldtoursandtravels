'use strict';
/* ===========================================================================
   travel-data.js — THE ONLY FILE THAT KNOWS WHERE TRAVEL DATA COMES FROM.
   ===========================================================================
   The Explore sections (flights, hotels, cruises, packages) render from the
   NORMALISED shapes documented below and never touch a raw payload. Swapping
   today's sample data for the real Flight API is therefore a change to this
   file alone:

     1. set CONFIG.useLiveApi = true (or leave the per-source flags)
     2. point CONFIG.endpoints.flights at the real route
     3. rewrite ONLY normaliseFlight() to map the API's field names

   travel-explore.js must keep working untouched. If a change to the API ever
   forces an edit there, the boundary has been broken — fix it here instead.

   WHY EVERY GETTER IS ASYNC EVEN THOUGH THE DATA IS LOCAL
   A synchronous getter would let the UI render straight from an array, and the
   day the real API lands every call site would have to learn to await. They
   return Promises now so the network version is a drop-in.
   =========================================================================== */

const TravelData = (function () {

  const CONFIG = {
    /* Flip per source as each real endpoint lands — flights, then hotels,
       then packages. Cruises and visa stay demo for now. */
    useLiveApi: { flights: false, hotels: true, cruises: false, packages: true },
    endpoints: {
      flights: '/api/customer/flights/search',
      hotels: '/api/customer/hotels',
      cruises: '/api/customer/cruises',
      packages: '/api/customer/packages',
    },
    /* Sample flights are one day's departures from a single airport. The real
       API will carry its own origin per row and this becomes a fallback. */
    defaultOrigin: 'HYD',
  };

  /* -------------------------------------------------------------------------
     Airport reference — moved to airports.js.

     It left this file so the landing page could have an airport picker without
     also loading a flight schedule and a hotel image map for the sake of 17
     city names. See that file's header for the table and for why the UTC offset
     matters to durationMinutes() below.

     LOAD ORDER IS A REAL DEPENDENCY: airports.js must come before this script
     on every page that loads it, or every flight here loses its origin and
     destination cities. The fallback keeps that failure loud in the console
     rather than silently rendering blank routes.
     ---------------------------------------------------------------------- */
  if (typeof JPAirports === 'undefined') {
    console.error('[travel-data] airports.js must load before travel-data.js');
  }
  const IST = (typeof JPAirports !== 'undefined') ? JPAirports.IST : 330;
  const AIRPORTS = (typeof JPAirports !== 'undefined') ? JPAirports.TABLE : {};

  /* Carrier -> IATA, so airline-logos.js can resolve a vendored logo file.
     Keyed by name because the sample data names the airline; the flight number
     prefix is used as a second chance in airlineCode(). */
  const AIRLINE_IATA = {
    'Air India': 'AI',
    'Air India Express': 'IX',
    'IndiGo': '6E',
    'Akasa Air': 'QP',
    'Gulf Air': 'GF',
  };

  /* -------------------------------------------------------------------------
     SAMPLE FLIGHTS — one day of departures, supplied 2026-08-08.

     ORIGIN IS AN ASSUMPTION. The source tables list only destinations. The mix
     (Tirupati, Vijayawada, Ayodhya, Madinah, Bahrain, Jeddah) is Hyderabad's
     route map, and the page's own search defaults to HYD, so HYD it is. If the
     real data is from another base, change defaultOrigin above.

     THE TWO SOURCE TABLES OVERLAP BY ONE ROW. Table 1's "QP1405 Akasa Air ->
     Delhi 06:00" and table 2's "AKJ 1405 Akasa Air -> Delhi 06:00 -> 08:15" are
     the same departure written two ways (Akasa's IATA code is QP; AKJ is not a
     carrier code). They are merged into one row that keeps the QP number and
     gains the arrival time — listing both would show a duplicate 06:00 Delhi
     flight. 12 + 14 rows, one shared, so 25 flights.

     `arrival: null` is honest missing data, not a gap to fill: table 1 gave no
     arrival times. Those cards show the departure and omit the duration rather
     than estimating one.
     ---------------------------------------------------------------------- */
  const SAMPLE_FLIGHTS = [
    // ---- table 1 (departure only) ----
    { no: 'AI1806',  airline: 'Air India',         to: 'DEL', dep: '05:30', arr: null    },
    { no: 'AI2860',  airline: 'Air India',         to: 'DEL', dep: '07:30', arr: null    },
    { no: '6E815',   airline: 'IndiGo',            to: 'JAI', dep: '05:55', arr: null    },
    { no: '6E913',   airline: 'IndiGo',            to: 'JAI', dep: '11:50', arr: null    },
    { no: '6E6638',  airline: 'IndiGo',            to: 'JAI', dep: '19:30', arr: null    },
    { no: '6E6646',  airline: 'IndiGo',            to: 'CJB', dep: '07:20', arr: null    },
    { no: '6E468',   airline: 'IndiGo',            to: 'CJB', dep: '10:10', arr: null    },
    { no: '6E6424',  airline: 'IndiGo',            to: 'CJB', dep: '14:10', arr: null    },
    { no: '6E6308',  airline: 'IndiGo',            to: 'CJB', dep: '18:10', arr: null    },
    { no: '6E57',    airline: 'IndiGo',            to: 'MED', dep: '17:40', arr: null    },
    { no: '6E6160',  airline: 'IndiGo',            to: 'AYJ', dep: '13:55', arr: null    },
    // ---- the merged row (table 1 number + table 2 arrival) ----
    { no: 'QP1405',  airline: 'Akasa Air',         to: 'DEL', dep: '06:00', arr: '08:15' },
    // ---- table 2 (departure + arrival) ----
    { no: 'IX939',   airline: 'Air India Express', to: 'JED', dep: '05:05', arr: '08:50' },
    { no: '6E1509',  airline: 'IndiGo',            to: 'BKK', dep: '05:40', arr: '10:55' },
    { no: '6E6494',  airline: 'IndiGo',            to: 'CCU', dep: '05:55', arr: '08:05' },
    { no: '6E7452',  airline: 'IndiGo',            to: 'NAG', dep: '06:00', arr: '07:40' },
    { no: 'GF275',   airline: 'Gulf Air',          to: 'BAH', dep: '06:05', arr: '08:05' },
    { no: '6E6567',  airline: 'IndiGo',            to: 'TIR', dep: '06:10', arr: '07:20' },
    { no: '6E5278',  airline: 'IndiGo',            to: 'TRV', dep: '06:10', arr: '07:55' },
    { no: '6E7252',  airline: 'IndiGo',            to: 'IXU', dep: '06:15', arr: '07:45' },
    { no: '6E7201',  airline: 'IndiGo',            to: 'VGA', dep: '06:15', arr: '07:15' },
    { no: '6E928',   airline: 'IndiGo',            to: 'STV', dep: '06:20', arr: '07:55' },
    { no: 'IX2934',  airline: 'Air India Express', to: 'BLR', dep: '06:20', arr: '07:55' },
    { no: '6E707',   airline: 'IndiGo',            to: 'DEL', dep: '06:25', arr: '08:45' },
    { no: '6E413',   airline: 'IndiGo',            to: 'BLR', dep: '06:30', arr: '07:50' },
  ];

  /* The date the sample belongs to: "08-Aug" in the source. Kept as a real ISO
     date so sorting and formatting do not have to parse a label. */
  const SAMPLE_DATE = '2026-08-08';

  /* -------------------------------------------------------------------------
     Helpers
     ---------------------------------------------------------------------- */
  function airport(code) {
    return AIRPORTS[code] || { city: code, country: '', utc: IST };
  }

  function toMinutes(hhmm) {
    if (!hhmm) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  /** Real elapsed time, both ends converted to UTC first. Returns null when
   *  there is no arrival. A negative result means the arrival is next-day
   *  (a red-eye, or a big westward offset), so a day is added rather than
   *  showing a negative duration. */
  function durationMinutes(dep, arr, fromCode, toCode) {
    const d = toMinutes(dep);
    const a = toMinutes(arr);
    if (d === null || a === null) return null;
    const depUtc = d - airport(fromCode).utc;
    const arrUtc = a - airport(toCode).utc;
    let mins = arrUtc - depUtc;
    if (mins < 0) mins += 24 * 60;
    return mins;
  }

  function durationLabel(mins) {
    if (mins === null) return null;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  /** IATA for the logo lookup: the carrier name first, then the flight-number
   *  prefix as a fallback for a carrier the map has not been taught yet. */
  function airlineCode(name, flightNumber) {
    if (AIRLINE_IATA[name]) return AIRLINE_IATA[name];
    const m = /^([A-Z0-9]{2})\s*\d/i.exec(String(flightNumber || '').trim());
    return m ? m[1].toUpperCase() : null;
  }

  /** "6E815" -> "6E 815", which is how a carrier prints it. */
  function prettyFlightNumber(no) {
    const m = /^([A-Z0-9]{2})\s*(\d+)$/i.exec(String(no).trim());
    return m ? `${m[1].toUpperCase()} ${m[2]}` : String(no);
  }

  /* -------------------------------------------------------------------------
     NORMALISERS — the seam.

     Everything above the UI speaks these shapes. When the real API lands, only
     the right-hand side of each assignment changes.

     Flight:
       { id, flightNumber, flightNumberRaw, airline, airlineCode,
         origin:{code,city,country}, destination:{code,city,country},
         date, departure, arrival, durationMinutes, durationLabel,
         stops, nonStop, status, fare }
     ---------------------------------------------------------------------- */
  function normaliseFlight(row, i) {
    const from = CONFIG.defaultOrigin;
    const to = row.to;
    const mins = durationMinutes(row.dep, row.arr, from, to);
    return {
      id: `${row.no}-${SAMPLE_DATE}-${i}`,
      flightNumber: prettyFlightNumber(row.no),
      flightNumberRaw: row.no,
      airline: row.airline,
      airlineCode: airlineCode(row.airline, row.no),
      origin: { code: from, ...airport(from) },
      destination: { code: to, ...airport(to) },
      date: SAMPLE_DATE,
      departure: row.dep,
      arrival: row.arr,
      durationMinutes: mins,
      durationLabel: durationLabel(mins),
      /* The sample is a departures board — every row is a single sector, so
         non-stop is a fact here, not a guess. The API will say. */
      stops: 0,
      nonStop: true,
      status: 'Scheduled',
      /* DEMO COMMERCIALS.

         These were deliberately absent at first: a made-up rupee figure beside
         a real flight number reads as a real quote. This is now an explicitly
         labelled demo booking environment (every page carries a "Sample"
         badge), and a booking flow cannot be demonstrated without a fare, so
         they are generated here — the one place the real API will replace.

         Seeded from the flight number, so a fare, a seat count and a baggage
         allowance are STABLE across reloads. Random values would change while
         someone is presenting, and the summary would not match the card. */
      ...demoCommercials(row.no, mins),
    };
  }

  /** Deterministic pseudo-random in [0,1) from a string. */
  function seeded(str, salt) {
    let h = 2166136261;
    const s = String(str) + '|' + salt;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }

  function demoCommercials(no, mins) {
    /* Priced off block time, which is the honest proxy for distance when the
       sample has no distance in it. ~₹9/min plus a floor, then a per-flight
       wobble so a results page does not look generated. */
    const minutes = mins || 120;
    const base = Math.round((2200 + minutes * 9 + seeded(no, 'fare') * 1800) / 50) * 50;
    const taxes = Math.round(base * 0.18 / 10) * 10;
    const seatsLeft = 1 + Math.floor(seeded(no, 'seats') * 9);
    const refundable = seeded(no, 'refund') > 0.55;
    return {
      fare: base,
      taxes,
      total: base + taxes,
      currency: 'INR',
      seatsLeft,
      /* Below 4 the card shows it in red — the scarcity cue every booking site
         uses, and the reason seatsLeft is generated rather than fixed. */
      seatsLow: seatsLeft <= 3,
      refundable,
      fareType: refundable ? 'Refundable' : 'Non-refundable',
      baggage: {
        cabin: '7 kg',
        checkIn: seeded(no, 'bag') > 0.5 ? '20 kg' : '15 kg',
      },
    };
  }

  /* -------------------------------------------------------------------------
     SAMPLE HOTELS / CRUISES / PACKAGES

     Demo content, and labelled as such in the UI. Hotel images are the REAL
     vendored photographs under assets/hotels/ (see hotel-images.js and its
     CREDITS.md) rather than grey boxes; cruises and packages have no photo
     library, so travel-explore.js draws them a generated scene.
     ---------------------------------------------------------------------- */
  const SAMPLE_HOTELS = [
    { id: 'h1', name: 'Taj Palace',        image: 'taj-palace',        stars: 5, location: 'Banjara Hills, Hyderabad', distanceKm: 24, pricePerNight: 12500, amenities: ['Free Wi-Fi', 'Pool', 'Spa', 'Airport shuttle'] },
    { id: 'h2', name: 'Novotel Hyderabad', image: 'novotel-hyderabad', stars: 5, location: 'HITEC City, Hyderabad',    distanceKm: 28, pricePerNight: 8200,  amenities: ['Free Wi-Fi', 'Pool', 'Gym', 'Breakfast'] },
    { id: 'h3', name: 'Hyatt Regency',     image: 'hyatt-regency',     stars: 5, location: 'Road No. 2, Hyderabad',    distanceKm: 26, pricePerNight: 9600,  amenities: ['Free Wi-Fi', 'Restaurant', 'Gym'] },
    { id: 'h4', name: 'Radisson',          image: 'radisson',          stars: 4, location: 'Gachibowli, Hyderabad',    distanceKm: 22, pricePerNight: 6400,  amenities: ['Free Wi-Fi', 'Breakfast', 'Parking'] },
    { id: 'h5', name: 'Marriott',          image: 'marriott',          stars: 5, location: 'Tank Bund, Hyderabad',     distanceKm: 31, pricePerNight: 11200, amenities: ['Free Wi-Fi', 'Pool', 'Lake view'] },
    { id: 'h6', name: 'Novotel Bengaluru', image: 'novotel-bengaluru', stars: 4, location: 'Outer Ring Road, Bengaluru', distanceKm: 34, pricePerNight: 7300, amenities: ['Free Wi-Fi', 'Gym', 'Breakfast'] },
  ];

  const SAMPLE_CRUISES = [
    { id: 'c1', name: 'Arabian Gulf Discovery', route: 'Dubai · Abu Dhabi · Doha',        nights: 5, priceFrom: 48000 },
    { id: 'c2', name: 'Andaman Island Hopper',  route: 'Chennai · Port Blair · Havelock', nights: 6, priceFrom: 52500 },
    { id: 'c3', name: 'Singapore & Malacca',    route: 'Singapore · Penang · Phuket',     nights: 4, priceFrom: 39900 },
    { id: 'c4', name: 'Mediterranean Classic',  route: 'Rome · Santorini · Dubrovnik',    nights: 8, priceFrom: 96000 },
  ];

  const SAMPLE_PACKAGES = [
    { id: 'p1', name: 'Dubai',     days: 5, priceFrom: 54900, blurb: 'Desert safari, Burj Khalifa and a dhow dinner cruise.' },
    { id: 'p2', name: 'Bali',      days: 6, priceFrom: 61500, blurb: 'Ubud rice terraces, Nusa Penida and a private villa stay.' },
    { id: 'p3', name: 'Maldives',  days: 4, priceFrom: 78000, blurb: 'Overwater villa, house-reef snorkelling and a sunset cruise.' },
    { id: 'p4', name: 'Singapore', days: 5, priceFrom: 58900, blurb: 'Gardens by the Bay, Sentosa and Universal Studios.' },
    { id: 'p5', name: 'Thailand',  days: 6, priceFrom: 46500, blurb: 'Bangkok temples, Phi Phi islands and Krabi beaches.' },
    { id: 'p6', name: 'Kashmir',   days: 5, priceFrom: 32900, blurb: 'Dal Lake houseboat, Gulmarg gondola and Pahalgam valleys.' },
    { id: 'p7', name: 'Goa',       days: 4, priceFrom: 21900, blurb: 'North and South Goa beaches, Old Goa churches, a river cruise.' },
  ];

  function normaliseHotel(h) {
    return {
      id: h.id, name: h.name, imageKey: h.image, stars: h.stars,
      location: h.location, distanceKm: h.distanceKm,
      pricePerNight: h.pricePerNight, amenities: h.amenities.slice(),
      /* Only the real endpoint sends these — undefined on the sample rows,
         which the card/details renderers already treat as "not shown". */
      guestRating: h.guest_rating != null ? Number(h.guest_rating) : undefined,
      cancellationPolicy: h.cancellation_policy,
      /* Derived server-side from the property's rooms and its policy text.
         Undefined on the sample rows, which the results renderer treats as
         "not known" and omits — it never guesses a meal plan. */
      mealPlans: Array.isArray(h.meal_plans) ? h.meal_plans.slice() : undefined,
      freeCancellation: typeof h.free_cancellation === 'boolean' ? h.free_cancellation : undefined,
    };
  }
  function normaliseCruise(c) {
    return { id: c.id, name: c.name, route: c.route, nights: c.nights, priceFrom: c.priceFrom };
  }
  function normalisePackage(p) {
    return {
      id: p.id, name: p.name, days: p.days, priceFrom: p.priceFrom, blurb: p.blurb,
      /* Only the real endpoint sends this — undefined on the sample rows,
         which isInternational() already treats as "unknown, assume domestic"
         the same way a flight with no origin/destination country does. */
      isInternational: p.is_international,
    };
  }

  /* -------------------------------------------------------------------------
     Fetch — used only once a source is switched to live.
     ---------------------------------------------------------------------- */
  async function getJson(url, params) {
    const qs = params && Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString() : '';
    const base = (typeof API_BASE === 'string') ? API_BASE : '';
    const res = await fetch(`${base}${url}${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.json();
  }

  /** Resolve a source: live when switched on, otherwise the sample rows.
   *  The sample path still returns a Promise so callers never branch. */
  async function load(source, sampleRows, params) {
    if (!CONFIG.useLiveApi[source]) return sampleRows;
    const body = await getJson(CONFIG.endpoints[source], params);
    /* A list endpoint may answer with a bare array or wrap it — accept both so
       the shape of the envelope is not a second thing to get right later. */
    return Array.isArray(body) ? body : (body.results || body.items || body.data || []);
  }

  return {
    config: CONFIG,
    airports: AIRPORTS,

    async flights(params = {}) {
      const rows = await load('flights', SAMPLE_FLIGHTS, params);
      return rows.map(normaliseFlight);
    },
    async hotels(params = {}) {
      const rows = await load('hotels', SAMPLE_HOTELS, params);
      return rows.map(normaliseHotel);
    },
    async cruises(params = {}) {
      const rows = await load('cruises', SAMPLE_CRUISES, params);
      return rows.map(normaliseCruise);
    },
    async packages(params = {}) {
      const rows = await load('packages', SAMPLE_PACKAGES, params);
      return rows.map(normalisePackage);
    },

    /* Exposed for the UI's labels and for tests. */
    durationMinutes, durationLabel, prettyFlightNumber, airlineCode,
    isSample: source => !CONFIG.useLiveApi[source],
  };
})();
