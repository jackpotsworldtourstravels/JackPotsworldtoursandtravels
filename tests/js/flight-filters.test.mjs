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

function load(files = ['round-trip.js', 'filter-engine.js', 'flight-filters.js'], extra = {}) {
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
  const own = new Set(['apply', 'defs', 'popular', 'availableSorts', 'sortRows', 'sections']);
  const F = new Proxy(raw, {
    get(t, k) {
      const v = t[k];
      return own.has(k) ? (...a) => Array.from(v.apply(t, a)) : (typeof v === 'function' ? v.bind(t) : v);
    },
  });
  F.setRows(rows);
  return { ctx, F, raw };
}

/** { id: state } for every section on screen, plus the reasons of the unavailable ones. */
const states = F => Object.fromEntries(F.sections().map(x => [x.id, x.state]));
const reasons = F => Object.fromEntries(F.sections().filter(x => x.state === 'unavailable').map(x => [x.id, x.why]));
const renderHtml = (F) => { const host = fakeHost(); F.mount(host, () => {}); F.refresh(); return host.innerHTML; };

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

const ONE_WAY_IDS = ['airlines', 'price', 'stops', 'departure', 'arrival', 'originAirport', 'destAirport', 'duration',
  'cabinBag', 'checkinBag', 'refundable', 'aircraft', 'cabin'];

test('every applicable section is on screen for the sample board, in order — each one available, single or unavailable', () => {
  const { F } = panel(SAMPLE);
  assert.deepEqual(F.sections().map(x => x.id), ONE_WAY_IDS, 'all thirteen, in the reading order, no layover (all non-stop)');
  assert.deepEqual(states(F), {
    airlines: 'available', price: 'available', stops: 'available', departure: 'available', arrival: 'available',
    originAirport: 'single', destAirport: 'single', duration: 'available',
    cabinBag: 'unavailable', checkinBag: 'unavailable', refundable: 'unavailable', aircraft: 'unavailable', cabin: 'unavailable',
  });
  const why = reasons(F);
  assert.match(why.cabinBag, /sample flights/i);
  assert.match(why.refundable, /sample flights/i);
  assert.match(why.aircraft, /not provided in the flight data/i);
  assert.match(why.cabin, /searched/i);
  assert.ok(Object.keys(why).every(k => !/\d/.test(why[k])), 'a reason states no figure');
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

test('sample (generated) baggage, refund terms and aircraft stay on screen as UNAVAILABLE — disabled, with the reason, no values', () => {
  const { F } = panel(SAMPLE);
  assert.ok(SAMPLE.every(f => f.baggage && f.baggage.checkIn), 'the sample rows do carry generated baggage');
  const html = renderHtml(F);
  for (const id of ['cabinBag', 'checkinBag', 'refundable', 'aircraft', 'cabin']) {
    assert.match(html, new RegExp(`data-ff-group="${id}" data-ff-state="unavailable"`), id + ' section is on screen');
  }
  assert.match(html, /Baggage allowances are not provided for sample flights\./);
  assert.match(html, /Refund terms are not provided for sample flights\./);
  assert.doesNotMatch(html, /data-ff-opt="(cabinBag|checkinBag|aircraft|cabin)"/, 'no live control for them');
  assert.doesNotMatch(html, /\bkg\b|\bbag(s)?\b.*\d|Airbus|Boeing/i, 'none of the generated values reaches the panel');
  // the fixed vocabulary of refundability is listed, but every option is disabled with a dash
  const refund = html.slice(html.indexOf('data-ff-group="refundable"'), html.indexOf('data-ff-group="aircraft"'));
  assert.match(refund, /Refundable/); assert.match(refund, /Non-refundable/);
  assert.equal((refund.match(/ disabled/g) || []).length, 2, 'both options disabled');
  assert.equal((refund.match(/<span class="ff-count">–<\/span>/g) || []).length, 2);
  // and nothing the sample generated can be selected through the URL either
  F.readParams(k => ({ f_refundable: 'yes', f_checkinBag: '20 kg' }[k]));
  F.setRows(SAMPLE);
  assert.equal(F.apply(SAMPLE).length, 4, 'a stale link cannot filter by generated data');
});

test('baggage, refundability and aircraft filter live rows that carry real values', () => {
  const { F } = panel(LIVE);
  assert.deepEqual(states(F).checkinBag, 'available');
  assert.deepEqual(states(F).refundable, 'available');
  assert.deepEqual(states(F).aircraft, 'available');
  assert.deepEqual(states(F).cabinBag, 'single', 'every live row has the same cabin allowance: one value, nothing to choose');
  F.readParams(k => ({ f_checkinBag: '25 kg' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.airline).sort(), ['Air India', 'Vistara']);
  F.clear();
  F.readParams(k => ({ f_refundable: 'yes' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.airline).sort(), ['IndiGo', 'Vistara']);
  F.clear();
  F.readParams(k => ({ f_aircraft: 'Boeing 787' }[k]));
  assert.deepEqual(F.apply(LIVE).map(f => f.airline), ['Air India']);
});

test('Duffel-shaped baggage (bag COUNTS) is worded as bags by type, never as kilograms', () => {
  // integrations/duffel/mapper.py: baggage = { cabin: int|None, checkIn: int|None } — Duffel's `quantity`
  const duffel = [1, 2, 1, 0].map((n, i) => flight({ sample: false, airline: ['IndiGo', 'Air India'][i % 2], total: 5000 + i * 700,
    baggage: { cabin: 1, checkIn: n }, refundable: null }));
  const { F } = panel(duffel);
  assert.equal(states(F).checkinBag, 'available');
  assert.equal(states(F).cabinBag, 'single');
  const html = renderHtml(F);
  assert.match(html, /1 checked bag/); assert.match(html, /2 checked bags/); assert.match(html, /No checked bag/);
  assert.match(html, /1 cabin bag/);
  assert.doesNotMatch(html, /\bkg\b/i, 'a bag count is never shown as kilograms');
  F.readParams(k => ({ f_checkinBag: '2 checked bags' }[k]));
  assert.equal(F.apply(duffel).length, 1);
  // Duffel silent on refundability is UNKNOWN, not "non-refundable": the section says it was not provided
  assert.equal(states(F).refundable, 'unavailable');
  assert.match(reasons(F).refundable, /not provided by the supplier/i);
  // a count whose type is unknown, or a bare numeric string, is not guessed into a unit
  const odd = [flight({ sample: false, baggage: { cabin: '7', checkIn: 20 } }), flight({ sample: false, baggage: { cabin: '7', checkIn: 20 } })];
  const p2 = panel(odd).F;
  assert.equal(states(p2).cabinBag, 'unavailable', "'7' has no unit");
  assert.equal(states(p2).checkinBag, 'single', '20 bags of checked luggage, worded as a count of bags');
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

test('return-journey sections never render for a one-way search', () => {
  const { F } = panel(SAMPLE);
  assert.ok(!F.sections().some(x => /Out$|Ret$/.test(x.id)));
  assert.ok(!F.defs().some(d => /Out$|Ret$/.test(d)));
});

/* ----------------------------------------------------------- popular filters */
test('Popular filters: every shortcut is listed; one the data cannot answer is disabled and says why', () => {
  const sample = panel(SAMPLE).F;
  const byLabel = F => Object.fromEntries(F.popular().map(p => [p.label, p]));
  const pop = byLabel(sample);
  assert.deepEqual(Object.keys(pop), ['Non-stop', '1 stop', 'Refundable', 'Morning departure', 'Evening departure']);
  assert.equal(pop['Non-stop'].disabled, false, 'every sample flight is non-stop: the shortcut has results');
  assert.equal(pop['Non-stop'].count, 4);
  assert.equal(pop['1 stop'].disabled, true); assert.match(pop['1 stop'].why, /None of these results match/);
  assert.equal(pop['Refundable'].disabled, true); assert.match(pop['Refundable'].why, /not provided for sample flights/);
  assert.equal(pop['Morning departure'].disabled, false);
  assert.equal(pop['Evening departure'].disabled, true, 'no sample flight departs 4 PM – 9 PM');

  const live = panel(LIVE);
  const lp = byLabel(live.F);
  for (const l of ['Non-stop', '1 stop', 'Refundable']) assert.equal(lp[l].disabled, false, l);

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
  assert.ok(byLabel(live.F)['Non-stop'].on);
  // synchronised both ways: the main Stops checkbox for the same option is now ticked
  assert.match(host.innerHTML, /data-ff-opt="stops" value="0" checked/);
  tick('stops|0', false);
  assert.equal(live.F.apply(LIVE).length, 4);
  tick('refundable|yes', true);
  assert.deepEqual(live.F.apply(LIVE).map(f => f.refundable), [true, true]);
  // a disabled shortcut renders disabled, with its reason, and no handler can tick it
  const sHtml = renderHtml(sample);
  assert.match(sHtml, /data-ff-pop="refundable\|yes"[^>]* disabled/);
  assert.match(sHtml, /Refund terms are not provided for sample flights\./);
});

test('Popular filters: round trips offer the per-direction shortcuts', () => {
  const { F } = panel(TRIPS);
  assert.deepEqual(F.popular().map(p => p.label),
    ['Non-stop onward', 'Non-stop return', 'Refundable', 'Morning onward departure', 'Evening return departure']);
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

/* ---------------------------------------------------- unavailable vs empty vs available */
test('sections stay on screen when the data is missing — each says exactly what is missing', () => {
  // rows with no times, no duration, no airport, no airline: nothing a filter could read
  const bare = [0, 1, 2].map(i => ({ id: 'B' + i, total: 4000 + i * 500, fare: 3500 + i * 500, currency: 'INR', sample: false, stops: 0, nonStop: true }));
  const { F } = panel(bare);
  assert.deepEqual(F.sections().map(x => x.id), ONE_WAY_IDS, 'all thirteen are still listed');
  const st = states(F);
  assert.equal(st.price, 'available');
  for (const id of ['airlines', 'departure', 'arrival', 'originAirport', 'destAirport', 'duration']) assert.equal(st[id], 'unavailable', id);
  assert.match(reasons(F).departure, /Departure times were not provided/);
  assert.match(reasons(F).duration, /duration is not published/i);
  assert.match(reasons(F).airlines, /Airline names were not provided/);
  const html = renderHtml(F);
  // unavailable fixed vocabularies list their options disabled, with a dash, so the traveller sees what would be offered
  const dep = html.slice(html.indexOf('data-ff-group="departure"'), html.indexOf('data-ff-group="arrival"'));
  assert.match(dep, /Unavailable/); assert.equal((dep.match(/ disabled/g) || []).length, 5);
  assert.match(dep, /Early morning/);
  // a free-form section has no options to invent: just the reason
  const air = html.slice(html.indexOf('data-ff-group="airlines"'), html.indexOf('data-ff-group="price"'));
  assert.doesNotMatch(air, /<input/);
  // a working section still works
  F.readParams(k => ({ f_price: '4000-4500' }[k]));
  assert.equal(F.apply(bare).length, 2);
});

test('EMPTY results are not UNAVAILABLE data: filtering everything out leaves every section as it was', () => {
  const { F } = panel(SAMPLE);
  const before = states(F);
  F.readParams(k => ({ f_airlines: 'SpiceJet', f_departure: 'night' }[k]));
  assert.deepEqual(F.apply(SAMPLE), [], 'no flight matches');
  assert.deepEqual(states(F), before, 'the sections are judged on the SEARCH results, not on what is left after filtering');
  const html = renderHtml(F);
  // the option that matches nothing in combination reads 0, enabled — a fact about this selection
  assert.match(html, /data-ff-opt="airlines" value="IndiGo"[\s\S]*?<span class="ff-count">0<\/span>/);
  // an option NO result in the search has is disabled — a fact about the data
  assert.match(html, /data-ff-opt="stops" value="1"\s+disabled/);
  assert.match(html, /data-ff-opt="departure" value="evening"[^>]* disabled/);
  assert.doesNotMatch(html, /data-ff-opt="departure" value="night"[^>]* disabled/, 'night has a flight, so it is not disabled');
});

test('round trip: a leg without data is unavailable on its own; the other leg keeps working', () => {
  const trips = TRIPS.map(t => tripOf(t.out, { ...t.ret, durationMinutes: null }, { total: t.total }));
  const { F } = panel(trips);
  const st = states(F);
  assert.equal(st.durationOut, 'available');
  assert.equal(st.durationRet, 'unavailable');
  assert.match(reasons(F).durationRet, /return flights/);
  assert.ok(!/onward/.test(reasons(F).durationRet));
  F.readParams(k => ({ f_durationOut: '80-80', f_airlinesRet: 'SpiceJet' }[k]));
  assert.ok(F.apply(trips).length > 0);
  assert.ok(F.apply(trips).every(t => t.ret.airline === 'SpiceJet'), 'the working return filter still applies');
  // the round-trip sidebar lists every Onward/Return pair, in order
  assert.deepEqual(F.sections().map(x => x.id), ['airlinesOut', 'airlinesRet', 'price', 'stopsOut', 'stopsRet', 'departureOut',
    'departureRet', 'arrivalOut', 'arrivalRet', 'originAirport', 'destAirport', 'durationOut', 'durationRet',
    'cabinBag', 'checkinBag', 'refundable', 'aircraft', 'cabin']);
  assert.match(reasons(F).cabinBag, /cannot be compared across a round trip/i);
});

test('layover appears only when a result connects, and says it is not available (the backend sends none)', () => {
  assert.ok(!panel(SAMPLE).F.sections().some(x => x.id === 'layover'));
  const conn = [flight({ sample: false, stops: 1, nonStop: false }), flight({ sample: false })];
  const { F } = panel(conn);
  assert.equal(states(F).layover, 'unavailable');
  assert.equal(reasons(F).layover, 'Layover details are not available for these flights.');
  assert.equal(states(F).stops, 'available');
});

test('currency: a non-rupee fare is never shown as rupees — the price section is unavailable and says why', () => {
  const usd = [flight({ total: 41, currency: 'USD', sample: false }), flight({ total: 63, currency: 'USD', sample: false })];
  const { F } = panel(usd);
  assert.equal(states(F).price, 'unavailable');
  assert.match(reasons(F).price, /not in rupees/);
  const html = renderHtml(F);
  assert.doesNotMatch(html, /₹/, 'no rupee sign anywhere in the panel');
  F.readParams(k => ({ f_price: '41-45' }[k]));
  assert.equal(F.apply(usd).length, 2, 'a hidden slider filters nothing');
});

test('single value: data is present but identical — shown as a note, not as unavailable', () => {
  const same = [0, 1, 2].map(i => flight({ airline: 'IndiGo', total: 5000, durationMinutes: 90, departure: '06:' + (10 + i) }));
  const { F } = panel(same);
  assert.equal(states(F).airlines, 'single');
  assert.equal(states(F).price, 'single');
  assert.equal(states(F).duration, 'single');
  const html = renderHtml(F);
  assert.match(html, /Same for every result: ₹5,000/);
  assert.match(html, /Every result is the same here/);
  assert.doesNotMatch(html, /data-ff-range="price"/, 'no slider with nothing to slide');
});

test('no invented values: airports without a name table entry stay as codes; nothing generated reaches a label', () => {
  const rows = [flight({ origin: { code: 'XYZ' }, destination: { code: 'QQQ' } }), flight({ origin: { code: 'XYZ' }, destination: { code: 'QQQ' } })];
  const { F } = panel(rows, { TravelData: { airport: c => ({ city: c, name: '' }) } });
  const html = renderHtml(F);
  assert.match(html, /value="XYZ"[\s\S]*?<span class="ff-opt-label">XYZ<\/span>/);
  assert.doesNotMatch(html, /Airport[^<]*\(XYZ\)/, 'no airport name is made up');
});

test('hotels: a panel without `layout` never renders an unavailable section or a disabled option', () => {
  const ctx = load(['filter-engine.js']);
  const P = vm.runInContext(`FilterEngine.create({ defs: [
    { id: 'k', label: 'K', type: 'list', get: r => r.k }, { id: 'm', label: 'M', type: 'list', get: r => r.m }], sorts: [], prefix: 'h_' })`, ctx);
  P.setRows([{ k: 'a' }, { k: 'b' }]);          // `m` has no data at all
  const html = renderHtml(P);
  assert.match(html, /data-ff-opt="k"/);
  assert.doesNotMatch(html, /is-unavailable|ff-status|disabled|ff-unavail/);
  assert.doesNotMatch(html, /data-ff-group="m"/, 'a hotel filter with no data is still simply hidden');
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
