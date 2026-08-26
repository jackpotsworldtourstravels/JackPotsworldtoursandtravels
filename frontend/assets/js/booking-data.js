'use strict';
/* ===========================================================================
   booking-data.js — everything a BOOKING needs that a listing does not.
   ===========================================================================
   travel-data.js answers "what is on sale". This answers "what does buying it
   involve": seat maps, room types, cabin grades, add-ons, visa requirements,
   and the reference lists the traveller forms are built from.

   Same contract as travel-data.js, for the same reason — when the real
   endpoints land, only this file changes:

       BookingData.config.useLiveApi.seatMap = true
       BookingData.config.endpoints.seatMap  = '/api/customer/flights/seatmap'

   Every getter is async so the network version is a drop-in.

   DETERMINISM IS A DEMO REQUIREMENT, NOT A DETAIL. Occupied seats, room counts
   and prices are seeded from the item's own id, so they are identical on every
   reload. Random values would rearrange the aircraft between the results page
   and the summary while somebody is presenting.
   =========================================================================== */

const BookingData = (function () {

  const CONFIG = {
    useLiveApi: { seatMap: false, addons: false, rooms: true, cabins: false, visa: false, departures: true },
    endpoints: {
      seatMap: '/api/customer/flights/seatmap',
      addons:  '/api/customer/addons',
      rooms:   '/api/customer/hotels/rooms',
      cabins:  '/api/customer/cruises/cabins',
      visa:    '/api/customer/visa/requirements',
      departures: '/api/customer/packages/departures',
    },
  };

  /* ---------------------------------------------------------------------
     Deterministic pseudo-randomness
     --------------------------------------------------------------------- */
  function seeded(str, salt) {
    let h = 2166136261;
    const s = String(str) + '|' + salt;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }

  /* ---------------------------------------------------------------------
     Reference lists for the traveller forms
     --------------------------------------------------------------------- */
  const TITLES = ['Mr', 'Ms', 'Mrs', 'Dr', 'Mstr'];
  const GENDERS = ['Male', 'Female', 'Other'];
  const CABIN_CLASSES = [
    { id: 'economy',  label: 'Economy',         multiplier: 1 },
    { id: 'premium',  label: 'Premium Economy', multiplier: 1.6 },
    { id: 'business', label: 'Business',        multiplier: 2.9 },
    { id: 'first',    label: 'First',           multiplier: 4.2 },
  ];
  /* Enough to be credible in a dropdown without pretending to be ISO 3166. */
  const NATIONALITIES = [
    'India', 'United Arab Emirates', 'Saudi Arabia', 'Singapore', 'Thailand',
    'United Kingdom', 'United States', 'Australia', 'Canada', 'Germany',
    'France', 'Malaysia', 'Sri Lanka', 'Nepal', 'Qatar', 'Oman', 'Bahrain',
    'Kuwait', 'Maldives', 'Indonesia',
  ];

  /* ---------------------------------------------------------------------
     Add-ons. Per product, because a cruise has no baggage allowance and a
     visa application has no lounge.
     --------------------------------------------------------------------- */
  const ADDONS = {
    flight: [
      { id: 'bag10',     name: 'Extra baggage 10 kg', price: 1600, icon: 'transfers', per: 'passenger' },
      { id: 'meal',      name: 'Special meal',        price: 450,  icon: 'activities', per: 'passenger' },
      { id: 'wheelchair',name: 'Wheelchair assistance', price: 0,  icon: 'insurance', per: 'passenger',
        note: 'Complimentary — requested with the airline' },
      { id: 'priority',  name: 'Priority boarding',   price: 600,  icon: 'flights', per: 'passenger' },
      { id: 'insurance', name: 'Travel insurance',    price: 899,  icon: 'insurance', per: 'passenger' },
      { id: 'transfer',  name: 'Airport transfer',    price: 1250, icon: 'transfers', per: 'booking' },
      { id: 'lounge',    name: 'Lounge access',       price: 1100, icon: 'hotels', per: 'passenger' },
    ],
    hotel: [
      { id: 'breakfast', name: 'Daily breakfast',     price: 750,  icon: 'hotels', per: 'booking' },
      { id: 'airportpick', name: 'Airport pickup',    price: 1250, icon: 'transfers', per: 'booking' },
      { id: 'latecheckout', name: 'Late checkout',    price: 900,  icon: 'hotels', per: 'booking' },
      { id: 'insurance', name: 'Travel insurance',    price: 899,  icon: 'insurance', per: 'booking' },
    ],
    cruise: [
      { id: 'drinks',    name: 'Beverage package',    price: 6400, icon: 'cruises', per: 'passenger' },
      { id: 'shore',     name: 'Shore excursions',    price: 8200, icon: 'activities', per: 'passenger' },
      { id: 'spa',       name: 'Spa credit',          price: 3500, icon: 'hotels', per: 'passenger' },
      { id: 'insurance', name: 'Travel insurance',    price: 1899, icon: 'insurance', per: 'passenger' },
    ],
    package: [
      { id: 'upgrade',   name: 'Hotel upgrade',       price: 7500, icon: 'hotels', per: 'booking' },
      { id: 'guide',     name: 'Private guide',       price: 5200, icon: 'activities', per: 'booking' },
      { id: 'transfer',  name: 'Airport transfer',    price: 1250, icon: 'transfers', per: 'booking' },
      { id: 'insurance', name: 'Travel insurance',    price: 1499, icon: 'insurance', per: 'passenger' },
    ],
  };

  /* ---------------------------------------------------------------------
     Seat map — a 3-3 narrow-body, which is what every aircraft in the sample
     data actually is (A320/737 family).
     --------------------------------------------------------------------- */
  const SEAT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const SEAT_TYPE = { A: 'window', B: 'middle', C: 'aisle', D: 'aisle', E: 'middle', F: 'window' };

  function buildSeatMap(flightKey, rowCount) {
    const rows = [];
    const total = rowCount || 30;
    for (let r = 1; r <= total; r++) {
      /* Exit rows have legroom and cost more — and airlines will not seat an
         infant in one, which the traveller step enforces. */
      const exit = r === 1 || r === 14 || r === 15;
      const seats = SEAT_LETTERS.map(letter => {
        const id = `${r}${letter}`;
        const type = SEAT_TYPE[letter];
        /* ~38% taken, clustered toward the front the way a real load is. */
        const bias = 0.55 - (r / total) * 0.34;
        const occupied = seeded(flightKey, 'seat' + id) < bias;
        let price = type === 'window' ? 350 : type === 'aisle' ? 300 : 150;
        if (exit) price += 450;
        if (r <= 4) price += 200;
        return { id, row: r, letter, type, occupied, price, exit };
      });
      rows.push({ row: r, exit, seats });
    }
    return { aircraft: 'Airbus A320neo', layout: '3-3', rows };
  }

  /* ---------------------------------------------------------------------
     Hotel rooms / cruise cabins
     --------------------------------------------------------------------- */
  function buildRooms(hotel) {
    const base = hotel.pricePerNight;
    return [
      { id: 'std',   name: 'Superior Room',    beds: '1 King or 2 Twin', size: '28 m²',
        price: base, maxGuests: 2, perks: ['Free Wi-Fi', 'Breakfast optional'] },
      { id: 'deluxe',name: 'Deluxe Room',      beds: '1 King',           size: '34 m²',
        price: Math.round(base * 1.28 / 50) * 50, maxGuests: 3,
        perks: ['Free Wi-Fi', 'Breakfast included', 'City view'] },
      { id: 'suite', name: 'Executive Suite',  beds: '1 King + sofa',    size: '52 m²',
        price: Math.round(base * 1.85 / 50) * 50, maxGuests: 4,
        perks: ['Free Wi-Fi', 'Breakfast included', 'Lounge access', 'Late checkout'] },
    ].map(r => ({
      ...r,
      /* Two or three left reads as a real inventory position; ten does not. */
      left: 1 + Math.floor(seeded(hotel.id + r.id, 'left') * 5),
    }));
  }

  function buildCabins(cruise) {
    const base = cruise.priceFrom;
    return [
      { id: 'interior', name: 'Interior Stateroom', size: '16 m²', occupancy: 2,
        price: base, perks: ['All meals', 'Onboard entertainment'] },
      { id: 'ocean',    name: 'Ocean View',         size: '19 m²', occupancy: 2,
        price: Math.round(base * 1.22 / 100) * 100, perks: ['All meals', 'Picture window'] },
      { id: 'balcony',  name: 'Balcony Stateroom',  size: '23 m²', occupancy: 3,
        price: Math.round(base * 1.55 / 100) * 100, perks: ['All meals', 'Private balcony', 'Priority boarding'] },
      { id: 'suite',    name: 'Owner’s Suite', size: '41 m²', occupancy: 4,
        price: Math.round(base * 2.4 / 100) * 100, perks: ['All meals', 'Butler service', 'Speciality dining'] },
    ].map(c => ({ ...c, left: 1 + Math.floor(seeded(cruise.id + c.id, 'left') * 6) }));
  }

  /** Departure dates for a package — the next few Saturdays, which is how
   *  group departures are actually sold. */
  function buildDepartures(pkg) {
    const out = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
    for (let i = 0; i < 6; i++) {
      const iso = d.toISOString().slice(0, 10);
      out.push({
        date: iso,
        seatsLeft: 2 + Math.floor(seeded(pkg.id + iso, 'seats') * 12),
        /* Later departures cost more — school holidays, and it makes the
           picker do something. */
        price: pkg.priceFrom + i * 1500,
      });
      d.setDate(d.getDate() + 7);
    }
    return out;
  }

  /* ---------------------------------------------------------------------
     Visa requirements
     --------------------------------------------------------------------- */
  const VISA = {
    'United Arab Emirates': {
      types: [
        { id: 'tourist14', name: 'Tourist visa — 14 days', fee: 5800, processing: '3–4 working days' },
        { id: 'tourist30', name: 'Tourist visa — 30 days', fee: 7200, processing: '3–5 working days' },
        { id: 'transit',   name: 'Transit visa — 48 hours', fee: 2600, processing: '2 working days' },
      ],
      documents: ['Passport valid 6+ months', 'Passport-size photograph (white background)',
                  'Confirmed return ticket', 'Hotel booking or host details'],
    },
    'Singapore': {
      types: [
        { id: 'tourist30', name: 'Tourist visa — 30 days', fee: 3400, processing: '4–6 working days' },
        { id: 'multi',     name: 'Multiple entry — 2 years', fee: 6900, processing: '5–7 working days' },
      ],
      documents: ['Passport valid 6+ months', 'Form 14A', 'Recent photograph',
                  'Covering letter', 'Bank statement (3 months)'],
    },
    'Thailand': {
      types: [
        { id: 'voa',       name: 'Visa on arrival — 15 days', fee: 2400, processing: 'On arrival' },
        { id: 'tourist60', name: 'Tourist visa — 60 days', fee: 4100, processing: '5 working days' },
      ],
      documents: ['Passport valid 6+ months', 'Confirmed return ticket',
                  'Proof of accommodation', 'Recent photograph'],
    },
    'Saudi Arabia': {
      types: [
        { id: 'umrah',   name: 'Umrah visa', fee: 8600, processing: '5–7 working days' },
        { id: 'tourist', name: 'Tourist e-visa — 1 year', fee: 9400, processing: '3–5 working days' },
      ],
      documents: ['Passport valid 6+ months', 'Passport-size photograph',
                  'Confirmed flight booking', 'Hotel booking', 'Vaccination certificate'],
    },
    'United Kingdom': {
      types: [
        { id: 'visitor6', name: 'Standard visitor — 6 months', fee: 12400, processing: '15 working days' },
      ],
      documents: ['Passport valid for the whole stay', 'Bank statements (6 months)',
                  'Employment letter', 'Travel itinerary', 'Accommodation proof'],
    },
  };

  /* ---------------------------------------------------------------------
     Fetch (used only once a source is switched to live)
     --------------------------------------------------------------------- */
  async function getJson(url, params) {
    const qs = params && Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString() : '';
    const base = (typeof API_BASE === 'string') ? API_BASE : '';
    const res = await fetch(`${base}${url}${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.json();
  }
  async function load(source, build, params) {
    if (!CONFIG.useLiveApi[source]) return build();
    const body = await getJson(CONFIG.endpoints[source], params);
    return Array.isArray(body) ? body : (body.results || body.items || body.data || body);
  }

  return {
    config: CONFIG,
    TITLES, GENDERS, NATIONALITIES, CABIN_CLASSES,

    /* Flights ask the server, which is now the authority on both the cabin
       and what a seat costs — the local generator below is the fallback for
       an offline demo, and produces the same aircraft because the Python is a
       port of it. The other products have no backend and stay local. */
    async seatMap(flight) {
      if (typeof BookingApi !== 'undefined' && BookingApi.isLive('flight')) {
        try {
          return await BookingApi.seatMap(String(flight.id || flight.flightNumberRaw), 30);
        } catch { /* fall through to the local cabin */ }
      }
      return load('seatMap', () => buildSeatMap(flight.flightNumberRaw || flight.id, 30),
                  { flight: flight.flightNumberRaw, date: flight.date });
    },
    /** Flat list, the shape the add-ons step renders. The server groups them
     *  (baggage / meal / service); the group is kept on each row so the step
     *  can head them without a second request. */
    async addons(productType) {
      if (productType === 'flight' && typeof BookingApi !== 'undefined'
          && BookingApi.isLive('flight')) {
        try {
          const c = await BookingApi.addons('flight');
          const flat = [];
          ['baggage', 'meal', 'service'].forEach(group => {
            (c[group] || []).forEach(a => flat.push({
              id: a.code, code: a.code, name: a.name, price: a.price,
              note: a.description, group,
              per: a.per, icon: group === 'meal' ? 'activities'
                    : group === 'baggage' ? 'transfers' : 'insurance',
            }));
          });
          flat.included = c.included_baggage || [];
          return flat;
        } catch { /* fall through to the local catalogue */ }
      }
      /* Hotels have their own real catalogue now (breakfast, transfers, late
         checkout, insurance) — same flattening as flights, kept in its own
         branch so cruises and packages are untouched by this. */
      if (productType === 'hotel' && typeof BookingApi !== 'undefined'
          && BookingApi.isLive('hotel')) {
        try {
          const c = await BookingApi.hotelAddons();
          const flat = [];
          ['meal', 'service'].forEach(group => {
            (c[group] || []).forEach(a => flat.push({
              id: a.code, code: a.code, name: a.name, price: a.price,
              note: a.description, group, per: a.per,
              icon: group === 'meal' ? 'activities' : 'insurance',
            }));
          });
          return flat;
        } catch { /* fall through to the local catalogue */ }
      }
      /* Packages: hotel upgrade, private guide, airport transfer, travel
         insurance — same idea, own branch so cruises stay untouched. */
      if (productType === 'package' && typeof BookingApi !== 'undefined'
          && BookingApi.isLive('package')) {
        try {
          const c = await BookingApi.packageAddons();
          const flat = [];
          (c.service || []).forEach(a => flat.push({
            id: a.code, code: a.code, name: a.name, price: a.price,
            note: a.description, group: 'service', per: a.per, icon: 'insurance',
          }));
          return flat;
        } catch { /* fall through to the local catalogue */ }
      }
      return load('addons', () => (ADDONS[productType] || []).slice(), { type: productType });
    },
    async rooms(hotel) {
      return load('rooms', () => buildRooms(hotel), { hotel: hotel.id });
    },
    async cabins(cruise) {
      return load('cabins', () => buildCabins(cruise), { cruise: cruise.id });
    },
    async departures(pkg) {
      return load('departures', () => buildDepartures(pkg), { package: pkg.id });
    },
    async visaCountries() {
      return load('visa', () => Object.keys(VISA).sort());
    },
    async visaRequirements(country) {
      return load('visa', () => VISA[country] || { types: [], documents: [] }, { country });
    },

    isSample: source => !CONFIG.useLiveApi[source],
  };
})();
