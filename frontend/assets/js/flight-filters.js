'use strict';
/* ===========================================================================
   flight-filters.js — the results-page filter engine.
   ===========================================================================
   ONE DEFINITION PER FILTER, AND NOTHING ELSE KNOWS THEY EXIST.

   Every filter in DEFS below declares four things: how to read its value off a
   flight, how to turn that into options, how to test a flight against a chosen
   value, and how it is written to the URL. The sidebar renderer, the predicate,
   the URL codec and the "clear all" button are all generic over that list. To
   add a filter you add a definition; you do not touch the renderer, the state,
   or travel-explore.js.

   A FILTER IS SHOWN ONLY WHEN THE DATA CAN ANSWER IT.

   This is the rule the whole module is built around, and it is what makes the
   list above future-proof rather than aspirational. `available()` asks the
   ROWS, never a feature flag:

     a list filter needs two or more distinct values — one option is not a
     choice, it is a description of every result
     a range filter needs a spread — min === max slides nothing

   So `aircraft`, `cabin`, `fareCategory` and `layover` are fully defined here
   and render nothing today, because no flight carries those fields yet. The
   day the API returns them they appear on their own, with counts, in the URL
   and in "clear all", with no code change. That is deliberate: the alternative
   is a greyed-out row promising a filter that does not work, which tells the
   traveller less than showing nothing at all.

   WHY `fareCategory` AND NOT `fareType`. travel-data.js already has a
   `fareType`, and it holds "Refundable"/"Non-refundable" — that is
   refundability, which has its own filter below. The spec's Fare Type is
   Regular/Student/Senior Citizen/Armed Forces/Corporate, a different axis
   entirely, so it reads a different field. Pointing them at the same one would
   put the same two options under two headings.

   COUNTS ARE COMPUTED AGAINST THE OTHER FILTERS, NOT THE WHOLE SET. The number
   beside "IndiGo" is how many results you would get by ticking it, given
   everything else already ticked — which is the only number that is not a lie
   once a second filter is on. See rowsExcluding().
   =========================================================================== */

const FlightFilters = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

  /* Five windows, per the spec. The four-window set this replaces had no
     "night": everything after 6 PM was one bucket, so a red-eye and a 7 PM
     departure were the same choice. */
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

  const windowLabel = id => {
    const w = TIME_WINDOWS.find(x => x.id === id);
    return w ? w.label : id;
  };
  const windowNote = id => {
    const w = TIME_WINDOWS.find(x => x.id === id);
    return w ? w.note : '';
  };
  const windowOrder = id => TIME_WINDOWS.findIndex(x => x.id === id);

  /** The fare a filter and a sort should both read. `total` is what the
   *  traveller pays; `fare` is the base. Falling back keeps a row with only one
   *  of them from dropping out of the price filter entirely. */
  const priceOf = f => (f && (f.total != null ? f.total : f.fare));

  const durationOf = f => (f && f.durationMinutes != null ? f.durationMinutes : null);

  /** Total time on the ground between sectors. Absent from every row today —
   *  the sample is a departures board of single sectors — which is exactly why
   *  the layover filter and the "lowest layover" sort are both hidden. */
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
    if (n == null) return null;
    return n === 0 ? '0' : n === 1 ? '1' : '2+';
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

  /* =======================================================================
     The definitions
     ======================================================================= */

  /** @typedef {Object} FilterDef
   *  @property {string} id        stable key; also the URL parameter (f_<id>)
   *  @property {string} label     section heading
   *  @property {'list'|'radio'|'range'} type
   *  @property {Function} get     flight -> value (list/radio) or number (range)
   *  @property {Function} [label_] option key -> display label
   *  @property {Function} [note]   option key -> small print under the label
   *  @property {Function} [order]  option key -> sort rank, lowest first
   *  @property {boolean} [search]  render a "search within" box
   *  @property {Function} [format] range: number -> display label
   *  @property {number} [step]     range step
   */
  const DEFS = [
    {
      id: 'stops', label: 'Stops', type: 'list',
      get: stopsBucket,
      label_: k => STOPS_LABEL[k] || k,
      order: k => (k === '0' ? 0 : k === '1' ? 1 : 2),
    },
    {
      id: 'airlines', label: 'Airlines', type: 'list', search: true,
      get: f => f.airline,
      logo: f => f.airlineCode,
    },
    {
      id: 'price', label: 'Price', type: 'range',
      get: priceOf, format: money, step: 50,
    },
    {
      id: 'departure', label: 'Departure time', type: 'list',
      get: f => windowOf(minutesOf(f.departure)),
      label_: windowLabel, note: windowNote, order: windowOrder,
    },
    {
      id: 'arrival', label: 'Arrival time', type: 'list',
      get: f => windowOf(minutesOf(f.arrival)),
      label_: windowLabel, note: windowNote, order: windowOrder,
    },
    {
      id: 'duration', label: 'Flight duration', type: 'range',
      get: durationOf, format: hhmmLabel, step: 5,
    },
    {
      /* Connecting flights only. Hidden while every result is non-stop, which
         is the spec's own rule and also what available() would decide anyway:
         a layover of null for every row yields no spread. */
      id: 'layover', label: 'Layover duration', type: 'range',
      get: layoverOf, format: hhmmLabel, step: 5,
    },
    {
      id: 'originAirport', label: 'Departure airport', type: 'list',
      get: f => f.origin && f.origin.code, label_: airportLabel,
    },
    {
      id: 'destAirport', label: 'Arrival airport', type: 'list',
      get: f => f.destination && f.destination.code, label_: airportLabel,
    },
    {
      /* One fare type at a time, per the spec. `radio` rather than `list`. */
      id: 'fareCategory', label: 'Fare type', type: 'radio',
      get: f => f.fareCategory,
    },
    {
      id: 'cabin', label: 'Cabin class', type: 'list',
      get: f => f.cabin,
    },
    {
      id: 'refundable', label: 'Refundability', type: 'list',
      get: f => (f.refundable == null ? null : (f.refundable ? 'yes' : 'no')),
      label_: k => (k === 'yes' ? 'Refundable' : 'Non-refundable'),
      order: k => (k === 'yes' ? 0 : 1),
    },
    {
      id: 'cabinBag', label: 'Cabin baggage', type: 'list',
      get: f => f.baggage && f.baggage.cabin,
    },
    {
      id: 'checkinBag', label: 'Check-in baggage', type: 'list',
      get: f => f.baggage && f.baggage.checkIn,
    },
    {
      id: 'aircraft', label: 'Aircraft', type: 'list',
      get: f => f.aircraft,
    },
  ];

  const DEF_BY_ID = new Map(DEFS.map(d => [d.id, d]));

  /* =======================================================================
     Sorting — same treatment: a mode is offered only if the data supports it
     ======================================================================= */
  const num = (v, fallback) => (v == null || Number.isNaN(v) ? fallback : v);

  const SORTS = [
    {
      id: 'best', label: 'Best',
      /* Price and time both matter and neither alone is "best". Each is scaled
         to 0..1 across the CURRENT result set, then added — so the winner is
         the flight closest to cheap-and-quick rather than the cheapest slow one
         or the fastest expensive one. Scaled per result set rather than against
         a constant, because a ₹4,000 spread on a short hop and a ₹40,000 one on
         a long-haul should both use the whole scale. */
      prepare(rows) {
        const prices = rows.map(priceOf).filter(v => v != null);
        const durs = rows.map(durationOf).filter(v => v != null);
        const span = arr => {
          const lo = Math.min(...arr), hi = Math.max(...arr);
          return { lo, span: hi - lo || 1 };
        };
        const p = prices.length ? span(prices) : null;
        const d = durs.length ? span(durs) : null;
        return f => {
          let s = 0;
          if (p) s += (num(priceOf(f), p.lo) - p.lo) / p.span;
          if (d) s += (num(durationOf(f), d.lo) - d.lo) / d.span;
          return s;
        };
      },
    },
    { id: 'cheapest', label: 'Cheapest', key: f => num(priceOf(f), Infinity),
      available: rows => rows.some(f => priceOf(f) != null) },
    { id: 'fastest', label: 'Fastest', key: f => num(durationOf(f), Infinity),
      available: rows => rows.some(f => durationOf(f) != null) },
    { id: 'dep-asc', label: 'Earliest departure', key: f => num(minutesOf(f.departure), Infinity) },
    { id: 'dep-desc', label: 'Latest departure', key: f => -num(minutesOf(f.departure), -Infinity) },
    { id: 'arr-asc', label: 'Earliest arrival', key: f => num(minutesOf(f.arrival), Infinity),
      available: rows => rows.some(f => minutesOf(f.arrival) != null) },
    { id: 'arr-desc', label: 'Latest arrival', key: f => -num(minutesOf(f.arrival), -Infinity),
      available: rows => rows.some(f => minutesOf(f.arrival) != null) },
    { id: 'layover-asc', label: 'Lowest layover', key: f => num(layoverOf(f), Infinity),
      available: rows => rows.some(f => layoverOf(f) != null) },
    { id: 'airline', label: 'Airline name', key: f => String(f.airline || ''),
      available: rows => new Set(rows.map(f => f.airline).filter(Boolean)).size > 1 },
  ];

  const SORT_BY_ID = new Map(SORTS.map(s => [s.id, s]));
  const DEFAULT_SORT = 'best';

  function availableSorts(rows) {
    return SORTS.filter(s => !s.available || s.available(rows));
  }

  function sortRows(rows, sortId) {
    const def = SORT_BY_ID.get(sortId) || SORT_BY_ID.get(DEFAULT_SORT);
    const out = rows.slice();
    const key = def.prepare ? def.prepare(rows) : def.key;
    out.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (typeof ka === 'string' || typeof kb === 'string') {
        return String(ka).localeCompare(String(kb))
          || num(minutesOf(a.departure), 0) - num(minutesOf(b.departure), 0);
      }
      return (ka - kb) || num(minutesOf(a.departure), 0) - num(minutesOf(b.departure), 0);
    });
    return out;
  }

  /* =======================================================================
     Facets and availability
     ======================================================================= */

  /** Distinct values for a list/radio filter, with counts, over `rows`. */
  function optionsFor(def, rows) {
    const counts = new Map();
    rows.forEach(f => {
      const v = def.get(f);
      if (v == null || v === '') return;
      counts.set(v, (counts.get(v) || 0) + 1);
    });
    const list = [...counts.entries()].map(([key, count]) => ({
      key: String(key),
      label: def.label_ ? def.label_(key) : String(key),
      note: def.note ? def.note(key) : '',
      count,
    }));
    if (def.order) list.sort((a, b) => def.order(a.key) - def.order(b.key));
    else list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return list;
  }

  /** Low and high for a range filter over `rows`, or null if there is no spread. */
  function boundsFor(def, rows) {
    const vals = rows.map(def.get).filter(v => v != null && !Number.isNaN(v));
    if (!vals.length) return null;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return hi > lo ? { lo, hi } : null;
  }

  /** THE RULE. A filter earns its place in the sidebar only if the rows can
   *  answer it — two or more options, or a range with a spread. */
  function isAvailable(def, rows) {
    if (def.type === 'range') return boundsFor(def, rows) != null;
    return optionsFor(def, rows).length > 1;
  }

  /* =======================================================================
     State
     ======================================================================= */
  /* value shapes:  list  -> Set<string>
                    radio -> string | ''
                    range -> {lo, hi} | null  (null = untouched, full span) */
  const values = new Map();
  const collapsed = new Set();       // section ids the traveller has folded away
  const searchText = new Map();      // id -> "search within" query
  let rows = [];                     // the unfiltered result set
  let onChange = null;
  let host = null;
  let sortId = DEFAULT_SORT;
  let dragging = false;              // suppresses rebuilds mid-drag

  function blankValue(def) {
    if (def.type === 'list') return new Set();
    if (def.type === 'radio') return '';
    return null;
  }

  function valueOf(def) {
    if (!values.has(def.id)) values.set(def.id, blankValue(def));
    return values.get(def.id);
  }

  const isSet = def => {
    const v = valueOf(def);
    if (def.type === 'list') return v.size > 0;
    if (def.type === 'radio') return !!v;
    return v != null;
  };

  function activeCount() {
    return DEFS.filter(d => isAvailable(d, rows) && isSet(d)).length;
  }

  /* =======================================================================
     Testing a flight
     ======================================================================= */
  function testOne(def, f) {
    const v = valueOf(def);
    if (def.type === 'list') {
      if (!v.size) return true;
      const got = def.get(f);
      return got != null && v.has(String(got));
    }
    if (def.type === 'radio') {
      if (!v) return true;
      const got = def.get(f);
      return got != null && String(got) === v;
    }
    if (!v) return true;
    const got = def.get(f);
    /* A row with no value for a range filter is KEPT. Dropping it would let a
       slider nobody moved quietly delete results the moment one row lacks a
       duration — an absent value is not a value outside the range. */
    if (got == null) return true;
    return got >= v.lo && got <= v.hi;
  }

  /** Rows passing every filter EXCEPT `skipId`. The counts beside each option
   *  are computed against this, so they answer "how many if I tick that too". */
  function rowsExcluding(skipId) {
    const active = DEFS.filter(d => d.id !== skipId && isSet(d) && isAvailable(d, rows));
    if (!active.length) return rows;
    return rows.filter(f => active.every(d => testOne(d, f)));
  }

  /** The public predicate: does this flight survive every filter? */
  function test(f) {
    return DEFS.every(d => !isAvailable(d, rows) || testOne(d, f));
  }

  function apply(list) {
    return sortRows((list || rows).filter(test), sortId);
  }

  /* =======================================================================
     URL
     =======================================================================
     Namespaced `f_` so a filter can never collide with a search criterion
     (from/to/depart/cabin/adults). Multi-values join on "~": it survives a URL
     unescaped and cannot appear inside an airline name or an airport code,
     which a comma very nearly can. */
  const PREFIX = 'f_';

  function writeParams(params) {
    DEFS.forEach(def => {
      const k = PREFIX + def.id;
      delete params[k];
      if (!isAvailable(def, rows) || !isSet(def)) return;
      const v = valueOf(def);
      if (def.type === 'list') params[k] = [...v].join('~');
      else if (def.type === 'radio') params[k] = v;
      else params[k] = `${v.lo}-${v.hi}`;
    });
    params.sort = sortId === DEFAULT_SORT ? undefined : sortId;
    if (params.sort === undefined) delete params.sort;
    return params;
  }

  function readParams(get) {
    DEFS.forEach(def => {
      const raw = get(PREFIX + def.id);
      if (raw == null || raw === '') return;
      if (def.type === 'list') values.set(def.id, new Set(String(raw).split('~').filter(Boolean)));
      else if (def.type === 'radio') values.set(def.id, String(raw));
      else {
        const m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(String(raw));
        if (m) values.set(def.id, { lo: Number(m[1]), hi: Number(m[2]) });
      }
    });
    const s = get('sort');
    if (s && SORT_BY_ID.has(s)) sortId = s;
  }

  /** Drop anything the current rows cannot honour — a stale airline from a URL
   *  for a route that no longer flies it would otherwise filter to nothing with
   *  no visible cause. */
  function reconcile() {
    DEFS.forEach(def => {
      if (!isAvailable(def, rows)) return;
      if (def.type === 'range') {
        const b = boundsFor(def, rows);
        const v = valueOf(def);
        if (!v || !b) return;
        values.set(def.id, { lo: Math.max(b.lo, v.lo), hi: Math.min(b.hi, v.hi) });
        const nv = valueOf(def);
        if (nv.lo >= nv.hi) values.set(def.id, null);
        return;
      }
      const keys = new Set(optionsFor(def, rows).map(o => o.key));
      const v = valueOf(def);
      if (def.type === 'list') {
        [...v].forEach(k => { if (!keys.has(k)) v.delete(k); });
      } else if (v && !keys.has(v)) {
        values.set(def.id, '');
      }
    });
  }

  function clearAll() {
    DEFS.forEach(def => values.set(def.id, blankValue(def)));
    searchText.clear();
  }

  /* =======================================================================
     Rendering
     ======================================================================= */
  function sectionHtml(def) {
    const open = !collapsed.has(def.id);
    const body = def.type === 'range' ? rangeHtml(def) : listHtml(def);
    const n = isSet(def)
      ? (def.type === 'list' ? valueOf(def).size : 1)
      : 0;

    return `<section class="ff-group" data-ff-group="${esc(def.id)}">
      <h4 class="ff-head">
        <button type="button" class="ff-toggle" data-ff-toggle="${esc(def.id)}"
                aria-expanded="${open}" aria-controls="ff-body-${esc(def.id)}">
          <span class="ff-title">${esc(def.label)}</span>
          ${n ? `<span class="ff-badge">${n}</span>` : ''}
          <svg class="ff-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </h4>
      <div class="ff-body" id="ff-body-${esc(def.id)}"${open ? '' : ' hidden'}>${body}</div>
    </section>`;
  }

  function listHtml(def) {
    const scoped = rowsExcluding(def.id);
    const opts = optionsFor(def, rows).map(o => ({
      ...o,
      /* Count against the OTHER filters — see the header. */
      count: scoped.filter(f => String(def.get(f)) === o.key).length,
    }));

    const q = (searchText.get(def.id) || '').trim().toLowerCase();
    const shown = q ? opts.filter(o => o.label.toLowerCase().includes(q)) : opts;
    const v = valueOf(def);
    const inputType = def.type === 'radio' ? 'radio' : 'checkbox';

    /* A search box over three carriers is furniture; over a dozen it is the
       only way to find one. Five is where a list stops being scannable at a
       glance, and it appears on its own as a route gains airlines — the same
       data-decides-the-UI rule the rest of the panel runs on. */
    const search = def.search && opts.length >= 5 ? `
      <div class="ff-search">
        <label class="sr-only" for="ff-q-${esc(def.id)}">Search ${esc(def.label)}</label>
        <input id="ff-q-${esc(def.id)}" type="search" autocomplete="off"
               placeholder="Search ${esc(def.label.toLowerCase())}"
               data-ff-search="${esc(def.id)}" value="${esc(searchText.get(def.id) || '')}">
      </div>` : '';

    const clear = isSet(def)
      ? `<button type="button" class="ff-clear-one" data-ff-clear="${esc(def.id)}">Clear</button>`
      : '';

    const rowsHtml = shown.length ? shown.map(o => {
      const on = def.type === 'radio' ? v === o.key : v.has(o.key);
      const logo = def.logo ? logoFor(def, o.key) : '';
      return `<label class="ff-opt${o.count ? '' : ' is-empty'}">
        <input type="${inputType}" ${def.type === 'radio' ? `name="ff-${esc(def.id)}"` : ''}
               data-ff-opt="${esc(def.id)}" value="${esc(o.key)}" ${on ? 'checked' : ''}>
        ${logo}
        <span class="ff-opt-text">
          <span class="ff-opt-label">${esc(o.label)}</span>
          ${o.note ? `<span class="ff-opt-note">${esc(o.note)}</span>` : ''}
        </span>
        <span class="ff-count">${o.count}</span>
      </label>`;
    }).join('') : `<p class="ff-none">No matches for “${esc(q)}”.</p>`;

    return search + `<div class="ff-opts">${rowsHtml}</div>` + clear;
  }

  function logoFor(def, key) {
    const row = rows.find(f => String(def.get(f)) === key);
    const code = row && def.logo(row);
    if (!code) return '';
    const files = (typeof AIRLINE_LOGO_FILES !== 'undefined') ? AIRLINE_LOGO_FILES : null;
    const dir = (typeof AIRLINE_LOGO_DIR === 'string') ? AIRLINE_LOGO_DIR : 'assets/images/airlines/';
    if (files && files[code]) {
      return `<img class="ff-logo" src="${esc(dir + files[code])}" alt="" loading="lazy" width="20" height="20">`;
    }
    return `<span class="ff-logo ff-logo-code" aria-hidden="true">${esc(code)}</span>`;
  }

  function rangeHtml(def) {
    const b = boundsFor(def, rows);
    if (!b) return '';
    const v = valueOf(def) || { lo: b.lo, hi: b.hi };
    const step = def.step || 1;
    const fmt = def.format || String;
    return `
      <div class="ff-range" data-ff-range="${esc(def.id)}">
        <output class="ff-range-out">${esc(fmt(v.lo))} – ${esc(fmt(v.hi))}</output>
        <div class="ff-range-track">
          <div class="ff-range-fill"></div>
          <label class="sr-only" for="ff-lo-${esc(def.id)}">Minimum ${esc(def.label)}</label>
          <input id="ff-lo-${esc(def.id)}" class="ff-range-lo" type="range"
                 min="${b.lo}" max="${b.hi}" step="${step}" value="${v.lo}"
                 data-ff-bound="lo" aria-label="Minimum ${esc(def.label)}">
          <label class="sr-only" for="ff-hi-${esc(def.id)}">Maximum ${esc(def.label)}</label>
          <input id="ff-hi-${esc(def.id)}" class="ff-range-hi" type="range"
                 min="${b.lo}" max="${b.hi}" step="${step}" value="${v.hi}"
                 data-ff-bound="hi" aria-label="Maximum ${esc(def.label)}">
        </div>
        <div class="ff-range-ends"><span>${esc(fmt(b.lo))}</span><span>${esc(fmt(b.hi))}</span></div>
      </div>`;
  }

  /* -----------------------------------------------------------------------
     Keeping focus across a repaint.

     Every change repaints the whole panel, which detaches the control that was
     just used — and focus goes with it, to <body>. With a mouse that is
     invisible; on a keyboard it means ticking one filter throws you back to the
     top of the document, so the second filter cannot be reached without
     tabbing the whole page again. These two functions are what make the panel
     keyboard-operable at all.

     A SELECTOR, NOT THE NODE. The node is gone after the repaint; what survives
     is how to describe it, which is exactly what the data- attributes already
     say.
     ----------------------------------------------------------------------- */
  function focusSelector(el) {
    if (!el || !host || !host.contains(el)) return null;
    const d = el.dataset || {};
    if (d.ffOpt) return `[data-ff-opt="${CSS.escape(d.ffOpt)}"][value="${CSS.escape(el.value)}"]`;
    if (d.ffSearch) return `[data-ff-search="${CSS.escape(d.ffSearch)}"]`;
    if (d.ffToggle) return `[data-ff-toggle="${CSS.escape(d.ffToggle)}"]`;
    if (d.ffClear) return `[data-ff-clear="${CSS.escape(d.ffClear)}"]`;
    if (el.hasAttribute('data-ff-clear-all')) return '[data-ff-clear-all]';
    if (d.ffBound) {
      const box = el.closest('[data-ff-range]');
      return box
        ? `[data-ff-range="${CSS.escape(box.dataset.ffRange)}"] [data-ff-bound="${CSS.escape(d.ffBound)}"]`
        : null;
    }
    return null;
  }

  /** The group a control belongs to, so focus has somewhere to land when the
   *  control itself is gone — a "Clear" button removes itself by definition. */
  function groupOf(el) {
    const g = el && el.closest && el.closest('[data-ff-group]');
    return g ? g.dataset.ffGroup : null;
  }

  function render() {
    if (!host || dragging) return;

    const active = document.activeElement;
    const want = focusSelector(active);
    const fallbackGroup = want ? groupOf(active) : null;
    /* A text box also has a caret, and putting focus back without it jumps the
       cursor to the start mid-word. */
    const caret = (active && active.tagName === 'INPUT' && active.type === 'search')
      ? active.selectionStart : null;

    const shownDefs = DEFS.filter(d => isAvailable(d, rows));
    const n = activeCount();

    host.innerHTML = `
      <div class="ff-top">
        <h3 class="ff-heading">Filters${n ? ` <span class="ff-badge">${n}</span>` : ''}</h3>
        ${n ? '<button type="button" class="ff-clear-all" data-ff-clear-all>Clear all</button>' : ''}
      </div>
      ${shownDefs.map(sectionHtml).join('')}`;

    paintRangeFills();

    if (!want) return;
    const again = host.querySelector(want)
      || (fallbackGroup && host.querySelector(`[data-ff-toggle="${CSS.escape(fallbackGroup)}"]`));
    if (!again) return;
    again.focus();
    if (caret != null && again.setSelectionRange) {
      try { again.setSelectionRange(caret, caret); } catch { /* not a text input any more */ }
    }
  }

  /** The coloured band between the two thumbs. Set from JS because it depends
   *  on both values, which CSS alone cannot see. */
  function paintRangeFills() {
    if (!host) return;
    host.querySelectorAll('[data-ff-range]').forEach(box => {
      const lo = box.querySelector('.ff-range-lo');
      const hi = box.querySelector('.ff-range-hi');
      const fill = box.querySelector('.ff-range-fill');
      if (!lo || !hi || !fill) return;
      const min = Number(lo.min), max = Number(lo.max);
      const span = (max - min) || 1;
      fill.style.left = ((Number(lo.value) - min) / span * 100) + '%';
      fill.style.right = ((max - Number(hi.value)) / span * 100) + '%';
    });
  }

  /* =======================================================================
     Events
     ======================================================================= */
  let debounceTimer = 0;
  function announce(immediate) {
    clearTimeout(debounceTimer);
    /* Ranges fire on every pixel of a drag; a rebuild plus a re-filter per
       pixel is what makes a slider feel like it is fighting back. Checkboxes
       are one event and answer at once. */
    if (immediate) { if (onChange) onChange(); return; }
    debounceTimer = setTimeout(() => { if (onChange) onChange(); }, 140);
  }

  function bind() {
    if (!host) return;

    host.addEventListener('click', e => {
      const toggle = e.target.closest('[data-ff-toggle]');
      if (toggle) {
        const id = toggle.dataset.ffToggle;
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        const body = host.querySelector(`#ff-body-${CSS.escape(id)}`);
        const open = !collapsed.has(id);
        toggle.setAttribute('aria-expanded', String(open));
        if (body) body.hidden = !open;
        return;
      }
      const one = e.target.closest('[data-ff-clear]');
      if (one) {
        const def = DEF_BY_ID.get(one.dataset.ffClear);
        if (def) { values.set(def.id, blankValue(def)); render(); announce(true); }
        return;
      }
      if (e.target.closest('[data-ff-clear-all]')) {
        clearAll(); render(); announce(true);
      }
    });

    host.addEventListener('change', e => {
      const opt = e.target.closest('[data-ff-opt]');
      if (!opt) return;
      const def = DEF_BY_ID.get(opt.dataset.ffOpt);
      if (!def) return;
      if (def.type === 'radio') {
        values.set(def.id, opt.checked ? opt.value : '');
      } else {
        const set = valueOf(def);
        if (opt.checked) set.add(opt.value); else set.delete(opt.value);
      }
      render();
      announce(true);
    });

    /* Ranges: `input` for the live readout, `change` for the commit. */
    host.addEventListener('input', e => {
      const bound = e.target.closest('[data-ff-bound]');
      if (bound) { onRangeInput(bound); return; }

      const search = e.target.closest('[data-ff-search]');
      if (search) {
        searchText.set(search.dataset.ffSearch, search.value);
        /* No bespoke focus restore here: render() puts the caret back for any
           control, this one included. Narrowing the list does not change what
           is selected, so nothing needs re-filtering. */
        render();
      }
    });

    host.addEventListener('pointerdown', e => {
      if (e.target.closest('[data-ff-bound]')) dragging = true;
    });
    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      render();
    };
    document.addEventListener('pointerup', stopDrag);
    document.addEventListener('pointercancel', stopDrag);
    /* Keyboard users never fire pointerup — commit on change too. */
    host.addEventListener('change', e => {
      if (e.target.closest('[data-ff-bound]')) announce(true);
    });
  }

  function onRangeInput(input) {
    const box = input.closest('[data-ff-range]');
    const def = DEF_BY_ID.get(box.dataset.ffRange);
    if (!def) return;
    const lo = box.querySelector('.ff-range-lo');
    const hi = box.querySelector('.ff-range-hi');
    let a = Number(lo.value), b = Number(hi.value);
    /* The thumbs must not cross. Push the other one rather than refusing the
       drag, which reads as the slider being stuck. */
    if (a > b) {
      if (input.dataset.ffBound === 'lo') { b = a; hi.value = String(b); }
      else { a = b; lo.value = String(a); }
    }
    values.set(def.id, { lo: a, hi: b });
    const out = box.querySelector('.ff-range-out');
    const fmt = def.format || String;
    if (out) out.textContent = `${fmt(a)} – ${fmt(b)}`;
    paintRangeFills();
    announce(false);
  }

  /* =======================================================================
     Public surface
     ======================================================================= */
  return {
    TIME_WINDOWS, minutesOf, windowOf, priceOf, durationOf, layoverOf, stopsOf,

    /** Build the sidebar into `el` and call `cb` whenever the selection changes. */
    mount(el, cb) {
      host = typeof el === 'string' ? document.getElementById(el) : el;
      onChange = cb;
      if (host) { host.classList.add('ff-scope'); bind(); }
      return !!host;
    },

    /** Hand over a new result set. Re-derives availability, drops anything the
     *  new rows cannot honour, and repaints. */
    setRows(list) {
      rows = Array.isArray(list) ? list : [];
      reconcile();
      if (!SORT_BY_ID.has(sortId) || !availableSorts(rows).some(s => s.id === sortId)) {
        sortId = DEFAULT_SORT;
      }
      render();
    },

    refresh: render,
    test, apply, sortRows,
    activeCount,
    clear() { clearAll(); render(); },

    get sort() { return sortId; },
    set sort(v) { if (SORT_BY_ID.has(v)) sortId = v; },
    availableSorts: () => availableSorts(rows),
    DEFAULT_SORT,

    writeParams, readParams,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FlightFilters;
