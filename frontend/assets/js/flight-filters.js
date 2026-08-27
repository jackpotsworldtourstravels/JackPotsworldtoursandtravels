'use strict';
/* ===========================================================================
   flight-filters.js — what a flight can be filtered and sorted BY.
   ===========================================================================
   The panel itself — rendering, counts, collapsing, the slider, focus, the URL
   codec — is filter-engine.js. This file is the flight half: a list of
   definitions and a list of sorts, plus the few readers they share.

   EVERY FILTER THE PRODUCT WILL EVER WANT IS DEFINED HERE, including the ones
   no flight currently carries. The engine shows a filter only when the rows can
   answer it, so `aircraft`, `cabin`, `fareCategory` and `layover` render
   nothing today and appear on their own — with counts, in the URL, in
   "clear all" — the day the API returns those fields. No code changes here or
   anywhere else. Nothing is invented to fill the gap in the meantime.

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
  const airportLabel = code => {
    const a = (typeof TravelData !== 'undefined' && TravelData.airports)
      ? TravelData.airports[code] : null;
    return a && a.city ? `${a.city} (${code})` : String(code);
  };

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

  const DEFS = [
    { id: 'stops', label: 'Stops', type: 'list',
      get: stopsBucket, label_: k => STOPS_LABEL[k] || k,
      order: k => (k === '0' ? 0 : k === '1' ? 1 : 2) },

    { id: 'airlines', label: 'Airlines', type: 'list', search: true,
      get: f => f.airline, icon: airlineIcon },

    { id: 'price', label: 'Price', type: 'range', get: priceOf, format: money, step: 50 },

    { id: 'departure', label: 'Departure time', type: 'list',
      get: f => windowOf(minutesOf(f.departure)),
      label_: winLabel, note: winNote, order: winOrder },

    { id: 'arrival', label: 'Arrival time', type: 'list',
      get: f => windowOf(minutesOf(f.arrival)),
      label_: winLabel, note: winNote, order: winOrder },

    { id: 'duration', label: 'Flight duration', type: 'range',
      get: durationOf, format: hhmmLabel, step: 5 },

    /* Connecting flights only. Hidden while every result is non-stop, which is
       what the engine's availability rule decides anyway. */
    { id: 'layover', label: 'Layover duration', type: 'range',
      get: layoverOf, format: hhmmLabel, step: 5 },

    { id: 'originAirport', label: 'Departure airport', type: 'list',
      get: f => f.origin && f.origin.code, label_: airportLabel },

    { id: 'destAirport', label: 'Arrival airport', type: 'list',
      get: f => f.destination && f.destination.code, label_: airportLabel },

    /* One fare type at a time, per the spec — hence `radio`. */
    { id: 'fareCategory', label: 'Fare type', type: 'radio', get: f => f.fareCategory },

    { id: 'cabin', label: 'Cabin class', type: 'list', get: f => f.cabin },

    { id: 'refundable', label: 'Refundability', type: 'list',
      get: f => (f.refundable == null ? null : (f.refundable ? 'yes' : 'no')),
      label_: k => (k === 'yes' ? 'Refundable' : 'Non-refundable'),
      order: k => (k === 'yes' ? 0 : 1) },

    { id: 'cabinBag', label: 'Cabin baggage', type: 'list', get: f => f.baggage && f.baggage.cabin },
    { id: 'checkinBag', label: 'Check-in baggage', type: 'list', get: f => f.baggage && f.baggage.checkIn },
    { id: 'aircraft', label: 'Aircraft', type: 'list', get: f => f.aircraft },
  ];

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
    defs: DEFS, sorts: SORTS, prefix: 'f_', defaultSort: 'best',
    tiebreak: (a, b) => n(minutesOf(a.departure), 0) - n(minutesOf(b.departure), 0),
  });

  /* The readers travel-explore.js and the tests use, alongside the panel. */
  return Object.assign(panel, {
    TIME_WINDOWS, minutesOf, windowOf, priceOf, durationOf, layoverOf, stopsOf,
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FlightFilters;
