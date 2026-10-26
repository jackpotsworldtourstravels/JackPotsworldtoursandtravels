'use strict';
/* ===========================================================================
   flight-filters.js — what a flight can be filtered and sorted BY.
   ===========================================================================
   The panel itself — rendering, counts, collapsing, the slider, focus, the URL
   codec — is filter-engine.js. This file is the flight half: a list of
   definitions and a list of sorts, plus the few readers they share.

   EVERY FILTER THE PRODUCT WILL EVER WANT IS DEFINED HERE, and the sidebar shows
   every one that APPLIES to the search (`layout` below) — whether or not these
   results can answer it. A section the data cannot answer stays on screen, says
   why in one sentence (`WHY`), and is disabled: "Unavailable for this search" is
   not the same thing as "no flight matches". When the API starts returning
   aircraft, cabin or layovers they switch on by themselves, with counts, in the
   URL and in "clear all". Nothing is invented to fill a gap: baggage,
   refundability and aircraft are read only from rows that are not sample data
   (see `real` below), and a price slider needs every fare in rupees.

   WHAT THE BACKEND CONTRACT ACTUALLY CARRIES (integrations/duffel/mapper.py,
   checked against this file): stops, durationMinutes, departure/arrival (local
   HH:MM), airline, origin/destination code and city, total/fare/taxes + currency,
   refundable (true/false/null), baggage { cabin, checkIn } as bag COUNTS. It carries
   NO layover, aircraft or per-offer cabin field, and no airport NAME — so those
   sections read "not available" rather than guess.

   WHY `fareCategory` AND NOT `fareType`. travel-data.js already has a
   `fareType`, holding "Refundable"/"Non-refundable" — that is refundability,
   which has its own filter below. The spec's Fare Type is Regular / Student /
   Senior Citizen / Armed Forces / Corporate, a different axis, so it reads a
   different field. Pointing both at one field would put the same two options
   under two headings.
   =========================================================================== */

const FlightFilters = (function () {

  /* Five windows. The four-window set this replaced had no "night": everything
     after 6 PM was one bucket, so a red-eye and a 7 PM departure were the same
     choice. Shared by departure and arrival — one list, not two that drift. */
  const TIME_WINDOWS = [
    { id: 'early',     label: 'Early morning', note: '12 AM – 6 AM',  from: 0,    to: 359  },
    { id: 'morning',   label: 'Morning',       note: '6 AM – 12 PM',  from: 360,  to: 719  },
    { id: 'afternoon', label: 'Afternoon',     note: '12 PM – 4 PM',  from: 720,  to: 959  },
    { id: 'evening',   label: 'Evening',       note: '4 PM – 9 PM',   from: 960,  to: 1259 },
    { id: 'night',     label: 'Night',         note: '9 PM – 12 AM',  from: 1260, to: 1439 },
  ];

  const minutesOf = hhmm => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const windowOf = mins => {
    if (mins == null) return null;
    const w = TIME_WINDOWS.find(x => mins >= x.from && mins <= x.to);
    return w ? w.id : null;
  };
  const winLabel = id => (TIME_WINDOWS.find(x => x.id === id) || {}).label || id;
  const winNote = id => (TIME_WINDOWS.find(x => x.id === id) || {}).note || '';
  const winOrder = id => TIME_WINDOWS.findIndex(x => x.id === id);

  /** `total` is what the traveller pays; `fare` is the base. Falling back keeps
   *  a row carrying only one of them inside the price filter. */
  const priceOf = f => (f && (f.total != null ? f.total : f.fare));
  const durationOf = f => (f && f.durationMinutes != null ? f.durationMinutes : null);

  /** Absent from every row today — the sample is a departures board of single
   *  sectors — which is exactly why the layover filter and the "lowest layover"
   *  sort are both hidden. */
  const layoverOf = f => {
    if (!f) return null;
    if (f.layoverMinutes != null) return f.layoverMinutes;
    if (Array.isArray(f.layovers) && f.layovers.length) {
      return f.layovers.reduce((a, l) => a + (l.minutes || 0), 0);
    }
    return null;
  };

  const stopsOf = f => {
    if (!f) return null;
    if (f.stops != null) return f.stops;
    return f.nonStop ? 0 : null;
  };
  const stopsBucket = f => {
    const n = stopsOf(f);
    return n == null ? null : n === 0 ? '0' : n === 1 ? '1' : '2+';
  };
  const STOPS_LABEL = { '0': 'Non-stop', '1': '1 stop', '2+': '2+ stops' };

  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const hhmmLabel = mins => {
    const m = Math.max(0, Math.round(mins || 0));
    const h = Math.floor(m / 60);
    return h ? `${h}h ${m % 60}m` : `${m}m`;
  };
  /** "Hyderabad – Rajiv Gandhi International Airport (HYD)". The name is the
   *  airport's own, from the reference table; a code with no entry is the code
   *  alone, never a guessed name. */
  const airportLabel = code => {
    const td = (typeof TravelData !== 'undefined') ? TravelData : null;
    const a = td && td.airport ? td.airport(code) : (td && td.airports ? td.airports[code] : null);
    if (!a || !a.city || a.city === code) return String(code);
    return a.name ? `${a.city} – ${a.name} (${code})` : `${a.city} (${code})`;
  };

  /* WHAT IS RELIABLE. While flights run on the sample schedule, refundability
     and baggage are generated from the flight number (travel-data.js seeds them
     so a results page looks lived-in). They are demo content, and a filter over
     invented allowances would tell a traveller "20 kg" when no airline said so.
     So those filters read a row only when it is NOT sample data; the day a live
     row carries them, they appear on their own. */
  const real = (f, v) => (f && !f.sample ? v : null);
  /* BAGGAGE. The Duffel adapter (integrations/duffel/mapper.py, `_baggage`) sends
     { cabin, checkIn } as bag COUNTS (Duffel's `quantity`, the minimum over the segments), null when
     Duffel is silent; the sample board sends text with a unit ("7 kg"). RoundTrip.bagLabel words each
     honestly — "1 cabin bag", "2 checked bags", "No checked bag", or "20 kg" — and returns null for
     anything whose unit or type it cannot tell, so a count is never shown as kilograms. A sample row
     is never read at all (its allowances are generated), and a round-trip row carries no baggage. */
  const bag = (f, k) => {
    if (!f || f.sample || f.isTrip) return null;
    const t = (typeof RoundTrip !== 'undefined' && f.baggage) ? RoundTrip.bagLabel(f.baggage[k], k) : null;
    return t || null;
  };

  /* One leg of a round trip, read independently of the other. */
  const legStops = leg => f => {
    if (!f.isTrip) return null;
    const n = stopsOf(f[leg]);
    return n == null ? null : n === 0 ? '0' : n === 1 ? '1' : '2+';
  };
  const legDuration = leg => f => (f.isTrip ? durationOf(f[leg]) : null);

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

  /** Vendored carrier logo, or the IATA code as a legible tile. */
  function airlineIcon(key, row) {
    const code = row && row.airlineCode;
    if (!code) return '';
    const files = (typeof AIRLINE_LOGO_FILES !== 'undefined') ? AIRLINE_LOGO_FILES : null;
    const dir = (typeof AIRLINE_LOGO_DIR === 'string') ? AIRLINE_LOGO_DIR : 'assets/images/airlines/';
    return files && files[code]
      ? `<img class="ff-logo" src="${esc(dir + files[code])}" alt="" loading="lazy" width="20" height="20">`
      : `<span class="ff-logo ff-logo-code" aria-hidden="true">${esc(code)}</span>`;
  }

  /* ROUND-TRIP ROWS (travel-explore.js, `isTrip`) carry `out` and `ret`, the
     two real flights. Their own top-level fields describe the ONWARD leg, so the
     single-flight filters below would silently mean "onward" for a trip. Each
     direction therefore gets its own explicitly named filter, and the generic
     airline / departure / arrival ones step aside (null = "this row cannot
     answer", which hides a filter rather than showing it empty). A one-way list
     has no `isTrip` rows, so the *Out / *Ret filters never render there and
     every single-flight filter reads exactly as before. */
  const single = f => !f.isTrip;
  const legIcon = leg => (key, row) => airlineIcon(key, { airlineCode: row && row[leg] });

  /* FIXED VOCABULARIES: every option is always shown (the engine's `options`); one no result has is
     disabled with a 0 — an EMPTY option, not an unavailable filter. */
  const STOPS_OPTIONS = [
    { key: '0', label: 'Non-stop' }, { key: '1', label: '1 stop' }, { key: '2+', label: '2+ stops' },
  ];
  const TIME_OPTIONS = TIME_WINDOWS.map(w => ({ key: w.id, label: w.label, note: w.note }));
  const REFUND_OPTIONS = [{ key: 'yes', label: 'Refundable' }, { key: 'no', label: 'Non-refundable' }];

  /* WHY A SECTION MAY BE UNAVAILABLE — one sentence each, shown to the traveller when NO row carries
     what the filter reads. They name the real cause (checked against the Duffel mapper and the sample
     board); none of them claims a supplier feature exists. */
  const allSample = rows => rows.length > 0 && rows.every(f => f.sample);
  const isTripSet = rows => rows.some(f => f.isTrip);
  const WHY = {
    stops:    () => 'Stop counts were not provided for these flights.',
    stopsOut: () => 'Stop counts were not provided for the onward flights.',
    stopsRet: () => 'Stop counts were not provided for the return flights.',
    airlines: () => 'Airline names were not provided for these flights.',
    airlinesOut: () => 'Airline names were not provided for the onward flights.',
    airlinesRet: () => 'Airline names were not provided for the return flights.',
    price: rows => (rows.some(f => f.currency && f.currency !== 'INR')
      ? 'Fares in this search are not in rupees, so a rupee price range is not shown.'
      : 'Fares were not published for these flights.'),
    departure:    () => 'Departure times were not provided for these flights.',
    departureOut: () => 'Departure times were not provided for the onward flights.',
    departureRet: () => 'Departure times were not provided for the return flights.',
    arrival:    () => 'Arrival times were not provided for these flights.',
    arrivalOut: () => 'Arrival times were not provided for the onward flights.',
    arrivalRet: () => 'Arrival times were not provided for the return flights.',
    duration:    () => 'Journey duration is not published for these flights.',
    durationOut: () => 'Journey duration is not published for the onward flights.',
    durationRet: () => 'Journey duration is not published for the return flights.',
    layover: () => 'Layover details are not available for these flights.',
    originAirport: () => 'Airport details were not provided for these flights.',
    destAirport:   () => 'Airport details were not provided for these flights.',
    baggage: rows => (isTripSet(rows)
      ? "Baggage cannot be compared across a round trip's two flights."
      : allSample(rows)
        ? 'Baggage allowances are not provided for sample flights.'
        : 'Baggage allowances were not provided by the supplier for these flights.'),
    refundable: rows => (allSample(rows)
      ? 'Refund terms are not provided for sample flights.'
      : 'Refund terms were not provided by the supplier for these flights.'),
    aircraft: () => 'Aircraft type is not provided in the flight data.',
    cabin: () => 'Cabin class is not reported per flight. Results are for the class you searched.',
  };

  const DEFS = [
    { id: 'stops', label: 'Stops', type: 'list', options: STOPS_OPTIONS, why: WHY.stops,
      get: stopsBucket, label_: k => STOPS_LABEL[k] || k,
      order: k => (k === '0' ? 0 : k === '1' ? 1 : 2) },

    { id: 'stopsOut', label: 'Onward stops', type: 'list', options: STOPS_OPTIONS, why: WHY.stopsOut,
      get: legStops('out'), label_: k => STOPS_LABEL[k] || k,
      order: k => (k === '0' ? 0 : k === '1' ? 1 : 2) },
    { id: 'stopsRet', label: 'Return stops', type: 'list', options: STOPS_OPTIONS, why: WHY.stopsRet,
      get: legStops('ret'), label_: k => STOPS_LABEL[k] || k,
      order: k => (k === '0' ? 0 : k === '1' ? 1 : 2) },

    { id: 'airlines', label: 'Airlines', type: 'list', search: true, why: WHY.airlines,
      get: f => (single(f) ? f.airline : null), icon: airlineIcon },
    { id: 'airlinesOut', label: 'Onward airlines', type: 'list', search: true, why: WHY.airlinesOut,
      get: f => (f.isTrip ? f.out.airline : null), icon: legIcon('airlineCode') },
    { id: 'airlinesRet', label: 'Return airlines', type: 'list', search: true, why: WHY.airlinesRet,
      get: f => (f.isTrip ? f.retAirline : null), icon: legIcon('retAirlineCode') },

    /* The slider speaks rupees. A supplier row states its own currency (mapper.py: `currency`), and
       nothing here converts, so the filter is offered only while every row that names a currency
       names INR — never a slider labelled ₹ over dollar amounts. */
    { id: 'price', label: 'Price range', type: 'range', get: priceOf, format: money, step: 50, exact: true,
      why: WHY.price, available: rows => rows.every(f => !f.currency || f.currency === 'INR') },

    { id: 'departure', label: 'Departure time', type: 'list', options: TIME_OPTIONS, why: WHY.departure,
      get: f => (single(f) ? windowOf(minutesOf(f.departure)) : null),
      label_: winLabel, note: winNote, order: winOrder },
    { id: 'departureOut', label: 'Onward departure time', type: 'list', options: TIME_OPTIONS, why: WHY.departureOut,
      get: f => (f.isTrip ? windowOf(minutesOf(f.out.departure)) : null),
      label_: winLabel, note: winNote, order: winOrder },
    { id: 'departureRet', label: 'Return departure time', type: 'list', options: TIME_OPTIONS, why: WHY.departureRet,
      get: f => (f.isTrip ? windowOf(minutesOf(f.ret.departure)) : null),
      label_: winLabel, note: winNote, order: winOrder },

    { id: 'arrival', label: 'Arrival time', type: 'list', options: TIME_OPTIONS, why: WHY.arrival,
      get: f => (single(f) ? windowOf(minutesOf(f.arrival)) : null),
      label_: winLabel, note: winNote, order: winOrder },
    { id: 'arrivalOut', label: 'Onward arrival time', type: 'list', options: TIME_OPTIONS, why: WHY.arrivalOut,
      get: f => (f.isTrip ? windowOf(minutesOf(f.out.arrival)) : null),
      label_: winLabel, note: winNote, order: winOrder },
    { id: 'arrivalRet', label: 'Return arrival time', type: 'list', options: TIME_OPTIONS, why: WHY.arrivalRet,
      get: f => (f.isTrip ? windowOf(minutesOf(f.ret.arrival)) : null),
      label_: winLabel, note: winNote, order: winOrder },

    /* One-way only: a round trip has a duration per direction, below, and a sum of the two is
       not a number either direction can be chosen by. */
    { id: 'duration', label: 'Flight duration', type: 'range', why: WHY.duration,
      get: f => (single(f) ? durationOf(f) : null), format: hhmmLabel, step: 5, exact: true },
    { id: 'durationOut', label: 'Onward duration', type: 'range', why: WHY.durationOut,
      get: legDuration('out'), format: hhmmLabel, step: 5, exact: true },
    { id: 'durationRet', label: 'Return duration', type: 'range', why: WHY.durationRet,
      get: legDuration('ret'), format: hhmmLabel, step: 5, exact: true },

    /* Shown only when a result connects (see `layout`). The backend contract carries no layover field
       (the Duffel mapper sends `stops` only), so today it reads "not available for these flights". */
    { id: 'layover', label: 'Layover duration', type: 'range', why: WHY.layover,
      get: layoverOf, format: hhmmLabel, step: 5, exact: true },

    { id: 'originAirport', label: 'Departure airport', type: 'list', why: WHY.originAirport,
      get: f => f.origin && f.origin.code, label_: airportLabel },

    { id: 'destAirport', label: 'Arrival airport', type: 'list', why: WHY.destAirport,
      get: f => f.destination && f.destination.code, label_: airportLabel },

    /* One fare type at a time, per the spec — hence `radio`. Not in the sidebar layout: nothing
       supplies a fare category yet. */
    { id: 'fareCategory', label: 'Fare type', type: 'radio', get: f => f.fareCategory },

    { id: 'cabin', label: 'Cabin class', type: 'list', why: WHY.cabin, get: f => f.cabin },

    { id: 'refundable', label: 'Refundability', type: 'list', options: REFUND_OPTIONS, why: WHY.refundable,
      get: f => (f.refundable == null || f.sample ? null : (f.refundable ? 'yes' : 'no')),
      label_: k => (k === 'yes' ? 'Refundable' : 'Non-refundable'),
      order: k => (k === 'yes' ? 0 : 1) },

    { id: 'cabinBag', label: 'Cabin baggage', type: 'list', why: WHY.baggage, get: f => bag(f, 'cabin') },
    { id: 'checkinBag', label: 'Check-in baggage', type: 'list', why: WHY.baggage, get: f => bag(f, 'checkIn') },
    { id: 'aircraft', label: 'Aircraft', type: 'list', why: WHY.aircraft, get: f => real(f, f.aircraft) },
  ];

  /* THE SIDEBAR, in the order a traveller reads it. Every id here is on screen for these results,
     available or not (filter-engine.js, `layout`). A round trip swaps each of airlines / stops /
     times / duration for an Onward and a Return section, which are read — and can be unavailable —
     independently. Layover appears only when a result actually connects. */
  const ONE_WAY = ['airlines', 'price', 'stops', 'departure', 'arrival', 'originAirport', 'destAirport',
    'duration', 'layover', 'cabinBag', 'checkinBag', 'refundable', 'aircraft', 'cabin'];
  const ROUND_TRIP = ['airlinesOut', 'airlinesRet', 'price', 'stopsOut', 'stopsRet', 'departureOut', 'departureRet',
    'arrivalOut', 'arrivalRet', 'originAirport', 'destAirport', 'durationOut', 'durationRet', 'layover',
    'cabinBag', 'checkinBag', 'refundable', 'aircraft', 'cabin'];
  const connects = f => (stopsOf(f) || 0) > 0 || (!!f.isTrip && ((stopsOf(f.out) || 0) > 0 || (stopsOf(f.ret) || 0) > 0));
  function layout(rows) {
    const trip = rows.some(f => f.isTrip);
    const hasConnection = rows.some(connects);
    return (trip ? ROUND_TRIP : ONE_WAY).filter(id => id !== 'layover' || hasConnection);
  }

  /* The shortcuts above the groups. Each ticks one option of its own group (filter-engine.js,
     `popular`) and is always listed; one the data cannot answer is disabled and says why. */
  const POPULAR_ONE_WAY = [
    { def: 'stops',      value: '0',       label: 'Non-stop' },
    { def: 'stops',      value: '1',       label: '1 stop' },
    { def: 'refundable', value: 'yes',     label: 'Refundable' },
    { def: 'departure',  value: 'morning', label: 'Morning departure' },
    { def: 'departure',  value: 'evening', label: 'Evening departure' },
  ];
  const POPULAR_ROUND_TRIP = [
    { def: 'stopsOut',     value: '0',       label: 'Non-stop onward' },
    { def: 'stopsRet',     value: '0',       label: 'Non-stop return' },
    { def: 'refundable',   value: 'yes',     label: 'Refundable' },
    { def: 'departureOut', value: 'morning', label: 'Morning onward departure' },
    { def: 'departureRet', value: 'evening', label: 'Evening return departure' },
  ];
  const popular = rows => (rows.some(f => f.isTrip) ? POPULAR_ROUND_TRIP : POPULAR_ONE_WAY);

  const n = (v, fallback) => (v == null || Number.isNaN(v) ? fallback : v);

  const SORTS = [
    { id: 'best', label: 'Best',
      /* Price and time both matter and neither alone is "best". Each is scaled
         to 0..1 across the CURRENT result set and added, so the winner is the
         flight closest to cheap-and-quick rather than the cheapest slow one.
         Scaled per set, because a ₹4,000 spread on a short hop and a ₹40,000
         one on a long-haul should both use the whole scale. */
      prepare(rows) {
        const span = arr => { const lo = Math.min(...arr); return { lo, span: Math.max(...arr) - lo || 1 }; };
        const prices = rows.map(priceOf).filter(v => v != null);
        const durs = rows.map(durationOf).filter(v => v != null);
        const p = prices.length ? span(prices) : null;
        const d = durs.length ? span(durs) : null;
        return f => {
          let s = 0;
          if (p) s += (n(priceOf(f), p.lo) - p.lo) / p.span;
          if (d) s += (n(durationOf(f), d.lo) - d.lo) / d.span;
          return s;
        };
      } },
    { id: 'cheapest', label: 'Cheapest', key: f => n(priceOf(f), Infinity),
      available: rows => rows.some(f => priceOf(f) != null) },
    { id: 'fastest', label: 'Fastest', key: f => n(durationOf(f), Infinity),
      available: rows => rows.some(f => durationOf(f) != null) },
    { id: 'dep-asc', label: 'Earliest departure', key: f => n(minutesOf(f.departure), Infinity) },
    { id: 'dep-desc', label: 'Latest departure', key: f => -n(minutesOf(f.departure), -Infinity) },
    { id: 'arr-asc', label: 'Earliest arrival', key: f => n(minutesOf(f.arrival), Infinity),
      available: rows => rows.some(f => minutesOf(f.arrival) != null) },
    { id: 'arr-desc', label: 'Latest arrival', key: f => -n(minutesOf(f.arrival), -Infinity),
      available: rows => rows.some(f => minutesOf(f.arrival) != null) },
    { id: 'layover-asc', label: 'Lowest layover', key: f => n(layoverOf(f), Infinity),
      available: rows => rows.some(f => layoverOf(f) != null) },
    { id: 'airline', label: 'Airline name', key: f => String(f.airline || ''),
      available: rows => new Set(rows.map(f => f.airline).filter(Boolean)).size > 1 },
  ];

  const panel = FilterEngine.create({
    defs: DEFS, sorts: SORTS, prefix: 'f_', defaultSort: 'best', popular, layout,
    tiebreak: (a, b) => n(minutesOf(a.departure), 0) - n(minutesOf(b.departure), 0),
  });

  /* The readers travel-explore.js and the tests use, alongside the panel. */
  return Object.assign(panel, {
    TIME_WINDOWS, minutesOf, windowOf, priceOf, durationOf, layoverOf, stopsOf, airportLabel, layout,
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FlightFilters;
