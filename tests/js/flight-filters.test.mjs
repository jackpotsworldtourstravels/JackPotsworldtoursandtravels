// The Flights filter panel, as logic — no browser, no network, no backend.
//
// Run:  node --test tests/js/flight-filters.test.mjs
//
// WHAT THIS PINS
//   flight-filters.js   every filter definition and sort, against rows shaped like the sample board AND like
//                       the connecting / live rows the panel must handle the day they arrive
//   filter-engine.js    OR within a group, AND across groups, counts computed against the OTHER filters, ranges,
//                       the URL codec, clear-all, and the "Popular filters" shortcuts
//   data honesty        baggage, refundability and aircraft are read only from rows that are not sample data; a
//                       control the data cannot answer is not rendered at all
//   round trips         onward and return legs filter independently, and the single-flight filters step aside
//   safety              filtering never touches a row's `sample` flag or any other field
//
// The browser scripts are plain globals, loaded into a vm context with a stand-in DOM that records the HTML the
// panel renders and the listeners it registers. The responsive layout is tests/js/browser/flight-filters.ui.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// JPW_JS points the tests at another copy of the scripts (delete a guard in a scratch copy and the matching test must fail).
const JS = path.resolve(process.env.JPW_JS || path.join(HERE, '../../frontend/assets/js')) + path.sep;

/* ------------------------------------------------------------------ a page */
function fakeHost() {
  const listeners = {};
  return {
    innerHTML: '',
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    fire(type, ev) { (listeners[type] || []).forEach(fn => fn(ev)); },
  };
}

function load(files = ['filter-engine.js', 'flight-filters.js'], extra = {}) {
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, URLSearchParams, Math, JSON,
    CSS: { escape: s => String(s) },
    document: { activeElement: null, addEventListener() {}, getElementById: () => null },
    ...extra,
  });
  files.forEach(f => vm.runInContext(fs.readFileSync(JS + f, 'utf8'), ctx, { filename: f }));
  return ctx;
}
const ev = (ctx, expr) => vm.runInContext(expr, ctx);

/** A fresh panel (FlightFilters is a singleton per context, so each test gets its own context).
 *  Arrays the panel returns are made in the vm's realm; Array.from brings them into this one so
 *  deepStrictEqual compares them by content. The rows inside are the caller's own objects. */
function panel(rows, extra) {
  const ctx = load(undefined, extra);
  const raw = ev(ctx, 'FlightFilters');
  const own = new Set(['apply', 'defs', 'popular', 'availableSorts', 'sortRows']);
  const F = new Proxy(raw, {
    get(t, k) {
      const v = t[k];
      return own.has(k) ? (...a) => Array.from(v.apply(t, a)) : (typeof v === 'function' ? v.bind(t) : v);
    },
  });
  F.setRows(rows);
  return { ctx, F, raw };
}

/* ---------------------------------------------------------------- fixtures */
const AP = {
  HYD: { city: 'Hyderabad', name: 'Rajiv Gandhi International Airport' },
  BLR: { city: 'Bengaluru', name: 'Kempegowda International Airport' },
  DEL: { city: 'Delhi', name: 'Indira Gandhi International Airport' },
  BOM: { city: 'Mumbai', name: '' },
};
const airport = code => ({ code, ...(AP[code] || { city: code, name: '' }) });

let n = 0;
/** A single flight. `sample: false` rows stand for live supplier rows. */
const flight = (o = {}) => Object.assign({
  id: 'F' + (++n), airline: 'IndiGo', airlineCode: '6E', flightNumber: '6E ' + (100 + n),
  origin: airport('HYD'), destination: airport('BLR'),
  departure: '06:30', arrival: '07:50', durationMinutes: 80, stops: 0, nonStop: true,
  fare: 4000, taxes: 720, total: 4720, sample: true,
}, o);

/** Live-style rows: connecting itineraries with layovers, real baggage and aircraft. */
const LIVE = [
  flight({ airline: 'IndiGo', airlineCode: '6E', total: 5200, departure: '05:10', arrival: '07:00', durationMinutes: 110,
    sample: false, refundable: true, baggage: { cabin: '7 kg', checkIn: '15 kg' }, aircraft: 'Airbus A320neo' }),
  flight({ airline: 'Air India', airlineCode: 'AI', total: 6900, departure: '13:15', arrival: '18:40', durationMinutes: 325,
    stops: 1, nonStop: false, layovers: [{ airport: 'BOM', minutes: 95 }], sample: false, refundable: false,
    baggage: { cabin: '7 kg', checkIn: '25 kg' }, aircraft: 'Boeing 787' }),
  flight({ airline: 'Vistara', airlineCode: 'UK', total: 8400, departure: '21:40', arrival: '09:05', durationMinutes: 685,
    stops: 2, nonStop: false, layovers: [{ airport: 'BOM', minutes: 120 }, { airport: 'DEL', minutes: 200 }],
    sample: false, refundable: true, baggage: { cabin: '7 kg', checkIn: '25 kg' }, aircraft: 'Airbus A320neo' }),
  flight({ airline: 'IndiGo', airlineCode: '6E', total: 7100, departure: '17:30', arrival: '20:50', durationMinutes: 200,
    stops: 1, nonStop: false, layovers: [{ airport: 'DEL', minutes: 60 }], sample: false, refundable: false,
    baggage: { cabin: '7 kg', checkIn: '15 kg' }, aircraft: 'Airbus A321' }),
];

/** The sample departures board: all non-stop, single sector, seeded baggage and refundability. */
const SAMPLE = [
  flight({ airline: 'IndiGo', total: 4720, departure: '06:30', arrival: '07:50', durationMinutes: 80,
    refundable: true, baggage: { cabin: '7 kg', checkIn: '20 kg' } }),
  flight({ airline: 'Air India', airlineCode: 'AI', total: 5900, departure: '11:05', arrival: '12:30', durationMinutes: 85,
    refundable: false, baggage: { cabin: '7 kg', checkIn: '15 kg' } }),
  flight({ airline: 'SpiceJet', airlineCode: 'SG', total: 4300, departure: '15:40', arrival: '17:10', durationMinutes: 90,
    refundable: true, baggage: { cabin: '7 kg', checkIn: '20 kg' } }),
  flight({ airline: 'IndiGo', total: 6100, departure: '22:15', arrival: '23:40', durationMinutes: 85,
    refundable: false, baggage: { cabin: '7 kg', checkIn: '15 kg' } }),
];

const tripOf = (out, ret, o = {}) => Object.assign({
  isTrip: true, id: out.id + '+' + ret.id, out, ret, sample: !!(out.sample || ret.sample),
  airline: out.airline, airlineCode: out.airlineCode, retAirline: ret.airline, retAirlineCode: ret.airlineCode,
  origin: out.origin, destination: out.destination, departure: out.departure, arrival: out.arrival,
  stops: Math.max(out.stops || 0, ret.stops || 0), nonStop: !((out.stops || 0) || (ret.stops || 0)),
  durationMinutes: out.durationMinutes + ret.durationMinutes, fare: out.fare + ret.fare,
  total: out.total + ret.total,
}, o);

const back = (o = {}) => flight(Object.assign({ origin: airport('BLR'), destination: airport('HYD') }, o));
const ids = list => list.map(f => f.id);

/* ---------------------------------------------------------------- the tests */

test('only filters the data can answer are shown (the sample board is one sector, non-stop)', () => {
  const { F } = panel(SAMPLE);
  const shown = F.defs();
  for (const id of ['airlines', 'price', 'departure', 'arrival', 'duration']) assert.ok(shown.includes(id), id + ' shown');
  for (const id of ['stops', 'layover', 'originAirport', 'destAirport', 'cabinBag', 'checkinBag',
    'refundable', 'aircraft', 'airlinesOut', 'airlinesRet', 'departureRet', 'stopsRet', 'durationRet'])
    assert.ok(!shown.includes(id), id + ' must stay hidden');
});

test('stops: multi-select is OR within the group, Non-stop / 1 stop / 2+ stops are real buckets', () => {
  const { F } = panel(LIVE);
  assert.ok(F.defs().includes('stops'));
  assert.deepEqual(F.popular().filter(p => p.def === 'stops').map(p => p.value), ['0', '1']);
  const rows = F.apply(LIVE);
  assert.equal(rows.length, 4);
  // no API for ticking from here: drive it through the URL codec, the same path a shared link uses
  F.readParams(k => ({ f_stops: '0' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.stops), [0]);
  F.clear();
  F.readParams(k => ({ f_stops: '0~1' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.stops).sort(), [0, 1, 1]);
  F.clear();
  F.readParams(k => ({ f_stops: '2+' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.stops), [2]);
});

test('price range: bounds come from the rows, the filter keeps rows inside lo..hi inclusive, in rupees', () => {
  const { F } = panel(SAMPLE);
  assert.equal(F.priceOf(SAMPLE[0]), 4720);
  F.readParams(k => ({ f_price: '4720-5900' }[k]));
  assert.deepEqual(F.apply(SAMPLE).map(f => f.total).sort((a, b) => a - b), [4720, 5900]);
  const html = renderOf(SAMPLE);
  assert.match(html, /₹4,300/); assert.match(html, /₹6,100/);
  assert.match(html, /data-ff-bound="lo"/); assert.match(html, /data-ff-bound="hi"/);
});

function renderOf(rows, setup) {
  const { ctx, F } = panel(rows);
  const host = fakeHost();
  F.mount(host, () => {});
  if (setup) setup(F, host, ctx);
  F.refresh();
  return host.innerHTML;
}

test('airlines: every carrier is an option with an accurate count, ticking two is OR', () => {
  const { F } = panel(SAMPLE);
  const html = renderOf(SAMPLE);
  assert.match(html, /data-ff-opt="airlines" value="IndiGo"[\s\S]*?<span class="ff-count">2<\/span>/);
  assert.match(html, /data-ff-opt="airlines" value="Air India"[\s\S]*?<span class="ff-count">1<\/span>/);
  F.readParams(k => ({ f_airlines: 'IndiGo~SpiceJet' }[k]));
  assert.deepEqual(F.apply(SAMPLE).map(f => f.airline).sort(), ['IndiGo', 'IndiGo', 'SpiceJet']);
});

test('counts are computed against the OTHER filters, not the whole list', () => {
  const { F } = panel(SAMPLE);
  // evening/night departures only: 22:15 IndiGo. The airline group's own selection never narrows its own counts,
  // but the time filter does.
  F.readParams(k => ({ f_departure: 'night' }[k]));
  const host = fakeHost();
  F.mount(host, () => {});
  F.refresh();
  assert.match(host.innerHTML, /data-ff-opt="airlines" value="IndiGo"[\s\S]*?<span class="ff-count">1<\/span>/);
  assert.match(host.innerHTML, /data-ff-opt="airlines" value="SpiceJet"[\s\S]*?<span class="ff-count">0<\/span>/);
});

test('departure and arrival time windows are separate filters and combine with AND', () => {
  const { F } = panel(SAMPLE);
  F.readParams(k => ({ f_departure: 'morning~afternoon' }[k]));
  assert.deepEqual(F.apply(SAMPLE).map(f => f.departure).sort(), ['06:30', '11:05', '15:40']);
  F.readParams(k => ({ f_arrival: 'afternoon' }[k]));
  // morning/afternoon departures AND afternoon arrival (12 PM – 4 PM): only the 11:05 -> 12:30 flight
  assert.deepEqual(F.apply(SAMPLE).map(f => f.departure), ['11:05']);
  assert.equal(F.windowOf(F.minutesOf('23:59')), 'night');
  assert.equal(F.windowOf(F.minutesOf('00:00')), 'early');
});

test('duration range filters by real journey minutes', () => {
  const { F } = panel(LIVE);
  F.readParams(k => ({ f_duration: '110-200' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.durationMinutes).sort((a, b) => a - b), [110, 200]);
});

test('layover duration appears for rows that state a layover, and filters them', () => {
  const { F } = panel(LIVE);
  assert.ok(F.defs().includes('layover'));
  assert.ok(!F.defs().includes('layoverAirport'), 'no layover-airport filter: the backend contract has no such field');
  assert.equal(F.layoverOf(LIVE[2]), 320, 'two layovers sum to total layover time');
  F.readParams(k => ({ f_layover: '60-100' }[k]));
  // a non-stop has no layover to be too long, so it stays; the 320-minute two-stop is the one ruled out
  assert.deepEqual(F.apply(LIVE).map(f => f.stops).sort(), [0, 1, 1]);
  assert.ok(F.apply(LIVE).every(f => F.layoverOf(f) == null || (F.layoverOf(f) >= 60 && F.layoverOf(f) <= 100)));
});

test('departure and arrival airports list real airports, named, and select separately', () => {
  const rows = [
    flight({ origin: airport('HYD'), destination: airport('BLR') }),
    flight({ origin: airport('HYD'), destination: airport('DEL') }),
    flight({ origin: airport('BLR'), destination: airport('DEL') }),
  ];
  const td = { airport: c => ({ ...(AP[c] || { city: c }) }) };
  const { F } = panel(rows, { TravelData: td });
  assert.deepEqual(F.defs().filter(d => d.endsWith('Airport')).sort(), ['destAirport', 'originAirport']);
  assert.equal(F.airportLabel('HYD'), 'Hyderabad – Rajiv Gandhi International Airport (HYD)');
  assert.equal(F.airportLabel('BOM'), 'Mumbai (BOM)', 'no airport name is invented');
  assert.equal(F.airportLabel('XYZ'), 'XYZ');
  F.readParams(k => ({ f_originAirport: 'HYD' }[k]));
  assert.equal(F.apply(rows).length, 2);
  F.readParams(k => ({ f_destAirport: 'DEL' }[k]));
  assert.equal(F.apply(rows).length, 1, 'origin AND destination');
});

test('baggage, refundability and aircraft are NOT offered for sample (generated) rows', () => {
  const { F } = panel(SAMPLE);
  assert.ok(SAMPLE.every(f => f.baggage && f.baggage.checkIn), 'the sample rows do carry generated baggage');
  const html = renderOf(SAMPLE);
  assert.doesNotMatch(html, /baggage|Check-in|Refundab|Aircraft/i, 'no control over invented data');
  assert.ok(!F.defs().some(d => ['cabinBag', 'checkinBag', 'refundable', 'aircraft'].includes(d)));
});

test('baggage, refundability and aircraft filter live rows that carry real values', () => {
  const { F } = panel(LIVE);
  for (const id of ['checkinBag', 'refundable', 'aircraft']) assert.ok(F.defs().includes(id), id);
  assert.ok(!F.defs().includes('cabinBag'), 'every live row has the same cabin allowance: nothing to choose');
  F.readParams(k => ({ f_checkinBag: '25 kg' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.airline).sort(), ['Air India', 'Vistara']);
  F.clear();
  F.readParams(k => ({ f_refundable: 'yes' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.airline).sort(), ['IndiGo', 'Vistara']);
  F.clear();
  F.readParams(k => ({ f_aircraft: 'Boeing 787' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.airline), ['Air India']);
});

test('Duffel-shaped baggage (bare integer counts) is not turned into a filter', () => {
  // integrations/duffel/mapper.py: baggage = { cabin: int|None, checkIn: int|None } — Duffel's `quantity`, a count of bags
  const duffel = [1, 2, 1, 2].map((n, i) => flight({ sample: false, airline: ['IndiGo', 'Air India'][i % 2], total: 5000 + i * 700,
    baggage: { cabin: 1, checkIn: n }, refundable: null }));
  const { F } = panel(duffel);
  assert.ok(!F.defs().includes('checkinBag') && !F.defs().includes('cabinBag'), 'a bare number has no unit: nothing to filter by');
  assert.ok(!F.defs().includes('refundable'), 'refundable: null (Duffel silent) is unknown, not "non-refundable"');
  // a stated unit is offered; mixed or absent values are ignored
  const stated = [flight({ sample: false, baggage: { checkIn: '15 kg' } }), flight({ sample: false, baggage: { checkIn: '25 kg' } }),
    flight({ sample: false, baggage: { checkIn: null } })];
  const p2 = panel(stated).F;
  assert.ok(p2.defs().includes('checkinBag'));
  p2.readParams(k => ({ f_checkinBag: '25 kg' }[k]));
  assert.equal(p2.apply(stated).length, 1, 'rows with no stated allowance are not counted');
});

test('the price filter is offered only while every row is in rupees', () => {
  const inr = [flight({ total: 4000 }), flight({ total: 6000, currency: 'INR' })];
  assert.ok(panel(inr).F.defs().includes('price'));
  const mixed = [flight({ total: 40, currency: 'USD' }), flight({ total: 60, currency: 'USD' })];
  assert.ok(!panel(mixed).F.defs().includes('price'), 'a supplier currency other than INR: no slider labelled with ₹');
  const half = [flight({ total: 4000, currency: 'INR' }), flight({ total: 60, currency: 'GBP' })];
  assert.ok(!panel(half).F.defs().includes('price'));
  // and a hidden slider filters nothing
  const p = panel(mixed).F;
  p.readParams(k => ({ f_price: '40-45' }[k]));
  assert.equal(p.apply(mixed).length, 2);
});

test('combined filters: OR within a group, AND across groups', () => {
  const { F } = panel(LIVE);
  F.readParams(k => ({ f_airlines: 'IndiGo~Air India', f_stops: '1', f_refundable: 'no' }[k]));
  // IndiGo or Air India, AND exactly one stop, AND non-refundable: Air India (BOM) and the IndiGo via DEL
  assert.deepEqual(F.apply(LIVE).map(f => f.layovers[0].airport).sort(), ['BOM', 'DEL']);
  F.readParams(k => ({ f_price: '5000-7100' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.total).sort((a, b) => a - b), [6900, 7100]);
  F.readParams(k => ({ f_departure: 'afternoon' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.airline), ['Air India']);
});

test('clear() removes every selection, and so does clearing leaves sorting alone', () => {
  const { F } = panel(SAMPLE);
  F.readParams(k => ({ f_airlines: 'IndiGo', f_departure: 'night', f_sort: 'cheapest' }[k]));
  assert.equal(F.activeCount(), 2);
  assert.equal(F.sort, 'cheapest');
  F.clear();
  assert.equal(F.activeCount(), 0);
  assert.equal(F.apply(SAMPLE).length, 4);
  assert.equal(F.sort, 'cheapest', 'Clear all is for filters; the chosen sort stays');
});

test('the URL codec round-trips every kind of control and drops values the rows cannot honour', () => {
  const { F } = panel(SAMPLE);
  F.clear();
  F.readParams(k => ({ f_airlines: 'IndiGo~Air India', f_price: '4720-5900', f_departure: 'morning', f_sort: 'fastest' }[k]));
  const out = F.writeParams({ from: 'HYD', to: 'BLR' });
  assert.equal(out.from, 'HYD'); assert.equal(out.to, 'BLR', 'search parameters are preserved');
  assert.deepEqual(out.f_airlines.split('~').sort(), ['Air India', 'IndiGo']);
  assert.equal(out.f_price, '4720-5900');
  assert.equal(out.f_departure, 'morning');
  assert.equal(out.f_sort, 'fastest');
  // a stale airline from an old link is dropped on the next rows rather than filtering everything away
  F.clear();
  F.readParams(k => ({ f_airlines: 'Ghost Air' }[k]));
  F.setRows(SAMPLE);
  assert.equal(F.apply(SAMPLE).length, 4);
});

test('sorting: Best, Cheapest, Fastest, departure and arrival orders, offered only when the data allows', () => {
  const { F } = panel(SAMPLE);
  const by = id => F.sortRows(SAMPLE, id).map(f => f.total);
  assert.deepEqual(by('cheapest'), [4300, 4720, 5900, 6100]);
  assert.equal(F.sortRows(SAMPLE, 'fastest')[0].durationMinutes, 80);
  assert.deepEqual(F.sortRows(SAMPLE, 'dep-asc').map(f => f.departure), ['06:30', '11:05', '15:40', '22:15']);
  assert.deepEqual(F.sortRows(SAMPLE, 'dep-desc').map(f => f.departure), ['22:15', '15:40', '11:05', '06:30']);
  assert.deepEqual(F.sortRows(SAMPLE, 'arr-desc').map(f => f.arrival)[0], '23:40');
  const ids1 = F.availableSorts().map(s => s.id);
  assert.ok(ids1.includes('best') && ids1.includes('cheapest') && !ids1.includes('layover-asc'), 'no layover sort for non-stops');
  const live = panel(LIVE).F;
  assert.ok(live.availableSorts().some(s => s.id === 'layover-asc'));
  // filtering and sorting compose: the sort applies to the filtered set
  F.readParams(k => ({ f_airlines: 'IndiGo', f_sort: 'cheapest' }[k]));
  assert.deepEqual(F.apply(SAMPLE).map(f => f.total), [4720, 6100]);
});

test('empty result: filters that rule everything out yield an empty list, never an error', () => {
  const { F } = panel(SAMPLE);
  F.readParams(k => ({ f_airlines: 'SpiceJet', f_departure: 'night' }[k]));
  assert.deepEqual(F.apply(SAMPLE), []);
  assert.ok(F.activeCount() > 0, 'the page can tell "filters caused this" from "the route is empty"');
  assert.deepEqual(panel([]).F.apply([]), []);
});

/* ---------------------------------------------------------- round trips */
const out1 = flight({ airline: 'IndiGo', airlineCode: '6E', departure: '06:30', arrival: '07:50', durationMinutes: 80, total: 4720 });
const out2 = flight({ airline: 'Air India', airlineCode: 'AI', departure: '18:10', arrival: '19:40', durationMinutes: 90, total: 5900 });
const ret1 = back({ airline: 'SpiceJet', airlineCode: 'SG', departure: '08:00', arrival: '09:30', durationMinutes: 90, total: 4300 });
const ret2 = back({ airline: 'Akasa Air', airlineCode: 'QP', departure: '19:30', arrival: '21:00', durationMinutes: 90, total: 5200 });
const TRIPS = [tripOf(out1, ret1), tripOf(out1, ret2), tripOf(out2, ret1), tripOf(out2, ret2)];

test('round trip: onward and return get independent airline and time filters; single-flight ones step aside', () => {
  const { F } = panel(TRIPS);
  const shown = F.defs();
  for (const id of ['airlinesOut', 'airlinesRet', 'departureOut', 'departureRet', 'arrivalOut', 'arrivalRet', 'price'])
    assert.ok(shown.includes(id), id + ' shown for a round trip');
  for (const id of ['airlines', 'departure', 'arrival', 'duration']) assert.ok(!shown.includes(id), id + ' is the one-way filter');

  F.readParams(k => ({ f_airlinesOut: 'IndiGo' }[k]));
  assert.equal(F.apply(TRIPS).length, 2);
  F.readParams(k => ({ f_airlinesRet: 'Akasa Air' }[k]));
  assert.equal(F.apply(TRIPS).length, 1, 'onward AND return');
  assert.equal(F.apply(TRIPS)[0].out.airline, 'IndiGo');
  assert.equal(F.apply(TRIPS)[0].ret.airline, 'Akasa Air');
  F.clear();
  F.readParams(k => ({ f_departureRet: 'evening' }[k]));
  assert.deepEqual(F.apply(TRIPS).map(t => t.ret.departure), ['19:30', '19:30']);
  F.readParams(k => ({ f_departureOut: 'morning' }[k]));
  assert.deepEqual(F.apply(TRIPS).map(t => t.out.departure + '>' + t.ret.departure), ['06:30>19:30'],
    'both directions satisfied at once');
});

test('round trip: pairing survives filtering — every result is still one onward + one return flight', () => {
  const { F } = panel(TRIPS);
  F.readParams(k => ({ f_airlinesOut: 'Air India', f_price: '10000-11000' }[k]));
  for (const t of F.apply(TRIPS)) {
    assert.ok(t.isTrip && t.out && t.ret);
    assert.equal(t.out.origin.code, t.ret.destination.code);
    assert.equal(t.out.destination.code, t.ret.origin.code);
  }
});

test('round trip: per-leg stops and duration appear only when legs differ, and filter their own leg', () => {
  const conn = flight({ airline: 'IndiGo', stops: 1, nonStop: false, layovers: [{ airport: 'DEL', minutes: 70 }],
    departure: '09:00', arrival: '14:00', durationMinutes: 240, total: 5200 });
  const rows = [tripOf(out1, ret1), tripOf(conn, ret1), tripOf(out1, back({ stops: 1, nonStop: false, durationMinutes: 300,
    airline: 'Vistara', airlineCode: 'UK' }))];
  const { F } = panel(rows);
  for (const id of ['stopsOut', 'stopsRet', 'durationOut', 'durationRet']) assert.ok(F.defs().includes(id), id);
  F.readParams(k => ({ f_stopsOut: '1' }[k]));
  assert.equal(F.apply(rows).length, 1);
  assert.equal(F.apply(rows)[0].out.stops, 1);
  F.clear();
  F.readParams(k => ({ f_stopsRet: '1' }[k]));
  assert.equal(F.apply(rows)[0].ret.airline, 'Vistara');
  F.clear();
  F.readParams(k => ({ f_durationRet: '90-100' }[k]));
  assert.equal(F.apply(rows).length, 2, 'return duration 90 only');
});

test('return-journey filters never render for a one-way search', () => {
  const { F } = panel(SAMPLE);
  assert.ok(!F.defs().some(d => /Out$|Ret$/.test(d)));
});

/* ----------------------------------------------------------- popular filters */
test('Popular filters: shortcuts appear only when the data offers them and tick the real group option', () => {
  assert.deepEqual(panel(SAMPLE).F.popular().map(p => p.label), ['Morning departure'],
    'a sample board offers no stops / refundable shortcuts, and no flight departs 4 PM – 9 PM');

  const live = panel(LIVE);
  const labels = live.F.popular().map(p => p.label);
  for (const l of ['Non-stop', '1 stop', 'Refundable']) assert.ok(labels.includes(l), l);

  // tick "Non-stop" through the panel's own change handler
  const host = fakeHost();
  live.F.mount(host, () => {});
  live.F.refresh();
  assert.match(host.innerHTML, /Popular filters/);
  const tick = (value, checked) => host.fire('change', {
    target: { closest: sel => (sel === '[data-ff-pop]' ? { dataset: { ffPop: value }, checked } : null) },
  });
  tick('stops|0', true);
  assert.deepEqual(live.F.apply(LIVE).map(f => f.stops), [0]);
  assert.equal(live.F.activeCount(), 1, 'it is the Stops group that is active, not a second filter');
  assert.equal(live.F.writeParams({}).f_stops, '0', 'and the URL says so');
  assert.ok(live.F.popular().find(p => p.value === '0' && p.def === 'stops').on);
  tick('stops|0', false);
  assert.equal(live.F.apply(LIVE).length, 4);
  tick('refundable|yes', true);
  assert.deepEqual(live.F.apply(LIVE).map(f => f.refundable), [true, true]);
});

test('Popular filters: round trips offer the per-direction shortcuts', () => {
  const { F } = panel(TRIPS);
  const labels = F.popular().map(p => p.label);
  assert.ok(labels.includes('Morning onward departure'));
  assert.ok(labels.includes('Evening return departure'));
  assert.ok(!labels.includes('Morning departure'));
});

test('a panel without `popular` (hotels) renders no Popular block', () => {
  const ctx = load(['filter-engine.js']);
  const P = vm.runInContext(`FilterEngine.create({ defs: [{ id: 'k', label: 'K', type: 'list', get: r => r.k }], sorts: [], prefix: 'h_' })`, ctx);
  P.setRows([{ k: 'a' }, { k: 'b' }]);
  const host = fakeHost();
  P.mount(host, () => {});
  P.refresh();
  assert.doesNotMatch(host.innerHTML, /Popular/);
  assert.match(host.innerHTML, /data-ff-opt="k"/);
});

/* ------------------------------------------------------------------ safety */
test('filtering and sorting never change a row: sample flights stay sample, and no flag becomes bookable', () => {
  const rows = SAMPLE.map(f => Object.freeze({ ...f, origin: Object.freeze(f.origin) }));
  const { F } = panel(rows);
  F.readParams(k => ({ f_airlines: 'IndiGo', f_sort: 'cheapest' }[k]));
  const out = F.apply(rows);
  assert.ok(out.length > 0);
  assert.ok(out.every(f => f.sample === true), 'every filtered sample flight is still sample');
  assert.ok(out.every(f => rows.includes(f)), 'the very same row objects, not copies');
  assert.deepEqual(ids(rows), ids(SAMPLE.map((f, i) => rows[i])), 'input order untouched');
  for (const t of TRIPS) assert.equal(t.sample, true);
  assert.ok(panel(TRIPS).F.apply(TRIPS).every(t => t.sample === true));
});

test('the filter scripts contain no booking, payment or network code', () => {
  for (const f of ['filter-engine.js', 'flight-filters.js']) {
    const src = fs.readFileSync(JS + f, 'utf8');
    assert.doesNotMatch(src, /\b(fetch|axios|XMLHttpRequest|BookingStore|BookingFlow|payment|checkout)\b/i, f);
  }
});
