// Round trips, as logic — no browser, no network, no backend.
//
// Run:  node --test tests/js/round-trip.test.mjs
//
// WHAT THIS PINS
//   round-trip.js   pairing, pricing (cabin, infants, supplier-priced legs),
//                   tri-state refundability, baggage text
//   travel-data.js  the `sample` flag, the derived return board, and the search
//                   request both directions send (party + cabin)
//   checkout hold   a round-trip draft cannot reach payment or be stored as a
//                   booking, at every layer that is reachable without a browser:
//                   the flow definition's step blocks, the Payment step, and
//                   BookingStore.create. The engine's own enforcement
//                   (BookingFlow.goTo / history / Continue) is real DOM and is
//                   tests/js/browser/round-trip.ui.test.mjs.
//
// The browser scripts are plain globals, so they are loaded into a vm context
// with just enough stand-ins (storage, window, a DOM that does nothing) to
// define themselves. Nothing here is mocked that the rule under test depends on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// JPW_JS points the tests at another copy of the scripts: how a guard is shown to be load-bearing
// (delete it in a scratch copy and the matching test must fail).
const JS = path.resolve(process.env.JPW_JS || path.join(HERE, '../../frontend/assets/js')) + path.sep;
const RoundTrip = createRequire(import.meta.url)(JS + 'round-trip.js');

/* ---------------------------------------------------------------- a vm page */
const noop = () => {};
function page(extra = {}) {
  const store = new Map();
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, URLSearchParams, Date, Math, JSON, Promise, AbortController,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    window: { addEventListener: noop, matchMedia: () => ({ matches: false }), scrollTo: noop, crypto: globalThis.crypto },
    document: {
      addEventListener: noop, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], documentElement: { style: { setProperty: noop } },
      body: { classList: { add: noop, remove: noop } },
    },
    history: { pushState: noop, go: noop, back: noop },
    location: { search: '' },
    fetch: () => { throw new Error('no network in this test'); },
    ...extra,
  });
  ctx.window.window = ctx.window;
  ctx.__store = store;
  return ctx;
}
function load(ctx, files) {
  files.forEach(f => vm.runInContext(fs.readFileSync(JS + f, 'utf8'), ctx, { filename: f }));
  return ctx;
}
const get = (ctx, expr) => vm.runInContext(expr, ctx);

/* ---------------------------------------------------------------- fixtures */
/** A leg priced per traveller, as the sample board is. */
const leg = (o = {}) => Object.assign({
  id: 'L1', airline: 'IndiGo', airlineCode: '6E', flightNumber: '6E 413',
  origin: { code: 'HYD' }, destination: { code: 'BLR' },
  departure: '06:30', arrival: '07:50', durationMinutes: 80, stops: 0,
  fare: 4000, taxes: 720, total: 4720, refundable: false, sample: true,
  priceBasis: 'per-traveller',
}, o);
const back = (o = {}) => leg(Object.assign({
  id: 'R1', airline: 'Air India Express', airlineCode: 'IX', flightNumber: 'IX 2935',
  origin: { code: 'BLR' }, destination: { code: 'HYD' },
  departure: '12:35', arrival: '14:10', durationMinutes: 95,
  fare: 3200, taxes: 580, total: 3780, refundable: true,
}, o));

/* =========================================================== 1. PRICING */
test('economy, one adult: the pair costs the two legs\' own totals added', () => {
  const p = RoundTrip.priceTrip(leg(), back(), { pax: { adults: 1 }, multiplier: 1 });
  assert.equal(p.known, true);
  assert.equal(p.basis, 'per-traveller');
  assert.equal(p.perTraveller, 4720 + 3780);
  assert.equal(p.party, 8500);
  assert.equal(p.fare, 7200);
  assert.equal(p.taxes, 1300);
});

test('the cabin multiplier scales fare and taxes, rounded per leg BEFORE adding (as the server does)', () => {
  // 4145*1.6 = 6632, 746*1.6 = 1193.6 -> 1194 ; 3355*1.6 = 5368, 604*1.6 = 966.4 -> 966
  const o = leg({ fare: 4145, taxes: 746, total: 4891 });
  const r = back({ fare: 3355, taxes: 604, total: 3959 });
  const p = RoundTrip.priceTrip(o, r, { pax: { adults: 1 }, multiplier: 1.6 });
  assert.equal(p.fare, 6632 + 5368);
  assert.equal(p.taxes, 1194 + 966);
  assert.equal(p.perTraveller, 12000 + 2160);
});

test('an infant is not charged: the party is adults + children, never fewer than one', () => {
  const o = leg(); const r = back();
  const paying = (pax) => RoundTrip.priceTrip(o, r, { pax, multiplier: 1 });
  assert.equal(paying({ adults: 2, children: 1, infants: 1 }).party, 8500 * 3);
  assert.equal(paying({ adults: 2, children: 1, infants: 1 }).party, paying({ adults: 2, children: 1, infants: 0 }).party);
  assert.equal(paying({ adults: 1, children: 0, infants: 2 }).party, 8500);
  assert.equal(paying({ adults: 0, children: 0, infants: 1 }).paying, 1);
  assert.equal(RoundTrip.payingTravellers({ adults: 3, children: 2, infants: 4 }), 5);
});

test('cabin and party combine: premium economy for 2 adults + 1 child', () => {
  const p = RoundTrip.priceTrip(leg({ fare: 4145, taxes: 746 }), back({ fare: 3355, taxes: 604 }),
    { pax: { adults: 2, children: 1, infants: 1 }, multiplier: 1.6 });
  assert.equal(p.perTraveller, 14160);
  assert.equal(p.party, 14160 * 3);
  assert.equal(p.fare, 12000 * 3);
  assert.equal(p.taxes, 2160 * 3);
});

test('a SUPPLIER-priced pair already covers the party and cabin: added as it is, never multiplied again', () => {
  const o = leg({ priceBasis: 'party', fare: 9000, taxes: 1000, total: 10000 });
  const r = back({ priceBasis: 'party', fare: 8000, taxes: 800, total: 8800 });
  const p = RoundTrip.priceTrip(o, r, { pax: { adults: 3, children: 1, infants: 1 }, multiplier: 2.9 });
  assert.equal(p.basis, 'party');
  assert.equal(p.party, 18800);
  assert.equal(p.perTraveller, null, 'a whole-party figure has no honest per-traveller split');
  assert.equal(p.fare, 17000);
  assert.equal(p.taxes, 1800);
});

test('two legs priced on different bases are not added: the price is unknown, not invented', () => {
  const p = RoundTrip.priceTrip(leg(), back({ priceBasis: 'party' }), { pax: { adults: 1 }, multiplier: 1 });
  assert.equal(p.known, false);
  assert.equal(p.party, null);
});

test('a leg with no fare leaves the pair unpriced, and the row says so (total null)', () => {
  const t = RoundTrip.makeTrip(leg({ total: null, fare: null }), back(), { pax: { adults: 1 }, multiplier: 1 });
  assert.equal(t.price.known, false);
  assert.equal(t.total, null);
});

test('the row\'s `total` (what price filter, sort and date strip read) is the cabin- and party-correct figure', () => {
  const o = leg({ fare: 4145, taxes: 746 }); const r = back({ fare: 3355, taxes: 604 });
  const perTraveller = RoundTrip.makeTrip(o, r, { pax: { adults: 2 }, multiplier: 1.6 });
  assert.equal(perTraveller.total, 14160);
  const supplier = RoundTrip.makeTrip(leg({ priceBasis: 'party', total: 10000, fare: 9000, taxes: 1000 }),
    back({ priceBasis: 'party', total: 8800, fare: 8000, taxes: 800 }), { pax: { adults: 2 }, multiplier: 1 });
  assert.equal(supplier.total, 18800);
});

/* ================================================ 2. REFUNDABILITY, BAGGAGE */
test('refundability is tri-state: unknown never becomes non-refundable', () => {
  const c = RoundTrip.combineRefundable;
  assert.equal(c(true, true), true);
  assert.equal(c(true, false), false);
  assert.equal(c(false, null), false);
  assert.equal(c(true, null), null);
  assert.equal(c(null, null), null);
  assert.equal(c(undefined, true), null);
});

test('an unknown leg is labelled "not published" and its rule text states no policy', () => {
  assert.equal(RoundTrip.refundLabel(true), 'Refundable');
  assert.equal(RoundTrip.refundLabel(false), 'Non-refundable');
  assert.match(RoundTrip.refundLabel(null), /not published/i);
  assert.doesNotMatch(RoundTrip.refundLabel(undefined), /^Non-refundable/);
  const unknown = RoundTrip.ruleText(null);
  assert.doesNotMatch(unknown, /forfeits|4 hours/i);
  assert.match(unknown, /not published/i);
  assert.match(RoundTrip.ruleText(false), /forfeits the fare/);
});

test('the footer short terms: known cases state the rule, unknown states none', () => {
  assert.match(RoundTrip.ruleShort(true), /date change for a fee/i);
  assert.match(RoundTrip.ruleShort(false), /^Non-refundable/);
  const unknown = RoundTrip.ruleShort(null);
  assert.match(unknown, /not published/i);
  assert.doesNotMatch(unknown, /fee|forfeit|non-refundable/i, 'no policy is stated for an unknown leg');
  assert.equal(RoundTrip.ruleShort(undefined), unknown);
});

test('a trip with an unknown leg beside a refundable one has no fareType and is not "Non-refundable"', () => {
  const t = RoundTrip.makeTrip(leg({ refundable: null }), back({ refundable: true }), { pax: { adults: 1 }, multiplier: 1 });
  assert.equal(t.refundable, null);
  assert.equal(t.fareType, null);
  const both = RoundTrip.makeTrip(leg({ refundable: true }), back({ refundable: true }), { pax: { adults: 1 }, multiplier: 1 });
  assert.equal(both.refundable, true);
  assert.equal(both.fareType, 'Refundable');
});

test('baggage: text that states its unit is kept; a bare count is bags, never kilograms; unknown is not guessed', () => {
  // the sample board's own text, unchanged
  assert.equal(RoundTrip.bagLabel('7 kg', 'cabin'), '7 kg');
  assert.equal(RoundTrip.bagLabel('20 kg', 'checkIn'), '20 kg');
  assert.equal(RoundTrip.bagLabel(' 15 kg '), '15 kg');
  // the Duffel adapter sends a COUNT of bags (mapper.py `_baggage`): named by type, singular and plural
  assert.equal(RoundTrip.bagLabel(1, 'cabin'), '1 cabin bag');
  assert.equal(RoundTrip.bagLabel(2, 'cabin'), '2 cabin bags');
  assert.equal(RoundTrip.bagLabel(1, 'checkIn'), '1 checked bag');
  assert.equal(RoundTrip.bagLabel(3, 'checkIn'), '3 checked bags');
  assert.equal(RoundTrip.bagLabel(0, 'checkIn'), 'No checked bag', 'a stated 0 is "none", not missing');
  assert.equal(RoundTrip.bagLabel(0, 'cabin'), 'No cabin bag');
  for (const [v, k] of [[1, 'cabin'], [2, 'checkIn'], [7, 'cabin'], [15, 'checkIn'], [0, 'cabin']]) {
    assert.doesNotMatch(RoundTrip.bagLabel(v, k), /\bkg\b/i, `${v} is never shown as kilograms`);
  }
  // type or unit cannot be told: nothing is shown rather than a guessed unit
  assert.equal(RoundTrip.bagLabel(1), null, 'a count with no baggage type');
  assert.equal(RoundTrip.bagLabel(7, 'other'), null);
  assert.equal(RoundTrip.bagLabel('15'), null, 'a bare numeric string has no unit');
  assert.equal(RoundTrip.bagLabel('7', 'cabin'), null);
  assert.equal(RoundTrip.bagLabel(1.5, 'cabin'), null);
  assert.equal(RoundTrip.bagLabel(-1, 'cabin'), null);
  assert.equal(RoundTrip.bagLabel(NaN, 'cabin'), null);
  assert.equal(RoundTrip.bagLabel(null, 'cabin'), null);
  assert.equal(RoundTrip.bagLabel(undefined, 'cabin'), null);
  assert.equal(RoundTrip.bagLabel('', 'cabin'), null);
});

test('baggage phrases: unit text gets its heading, a counted bag already names itself', () => {
  assert.equal(RoundTrip.bagPhrase('7 kg', 'cabin'), 'Cabin 7 kg');
  assert.equal(RoundTrip.bagPhrase('15 kg', 'checkIn'), 'Check‑in 15 kg');
  assert.equal(RoundTrip.bagPhrase(1, 'cabin'), '1 cabin bag');
  assert.equal(RoundTrip.bagPhrase(2, 'checkIn'), '2 checked bags');
  assert.equal(RoundTrip.bagPhrase(1, undefined), null);
  assert.equal(RoundTrip.bagPhrase('15', 'checkIn'), null);
  assert.equal(RoundTrip.bagPhrase(null, 'cabin'), null);
});

test('single-flight card and details print baggage the same honest way (bagFact in travel-explore.js)', () => {
  const src = fs.readFileSync(JS + 'travel-explore.js', 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  function bagFact(');
  assert.ok(start > 0, 'bagFact exists');
  const end = src.indexOf('\n  }\n', start) + 5;
  const bagFact = vm.runInNewContext('(' + src.slice(start, end).trim() + ')', {
    RoundTrip, esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  });
  // sample-board text: markup exactly as before
  assert.equal(bagFact({ cabin: '7 kg', checkIn: '15 kg' }, 'cabin', 'li', 'jf-fact'), '<li class="jf-fact"><span>Cabin</span> 7 kg</li>');
  assert.equal(bagFact({ cabin: '7 kg', checkIn: '15 kg' }, 'checkIn', 'detail'), '<li><span>Check-in</span><b>15 kg</b></li>');
  // Duffel-shaped counts
  assert.equal(bagFact({ cabin: 1, checkIn: 2 }, 'cabin', 'li', 'jf-fact'), '<li class="jf-fact">1 cabin bag</li>');
  assert.equal(bagFact({ cabin: 1, checkIn: 2 }, 'checkIn', 'li', 'jf-fact'), '<li class="jf-fact">2 checked bags</li>');
  assert.equal(bagFact({ cabin: 1, checkIn: 2 }, 'checkIn', 'detail'), '<li><b>2 checked bags</b></li>');
  assert.equal(bagFact({ cabin: 1, checkIn: 0 }, 'checkIn', 'li', 'jf-fact'), '<li class="jf-fact">No checked bag</li>');
  // unknown: nothing printed, and no crash when a row has no baggage object at all
  assert.equal(bagFact({ cabin: null, checkIn: undefined }, 'cabin', 'li', 'jf-fact'), '');
  assert.equal(bagFact({ cabin: '15' }, 'cabin', 'detail'), '');
  assert.equal(bagFact(undefined, 'cabin', 'li', 'jf-fact'), '');
  assert.equal(bagFact(null, 'checkIn', 'detail'), '');
});

/* ================================================================ 3. PAIRING */
const clock = {
  // minutes after midnight on `day` in the origin's own offset; IST throughout
  departureInstant(f, iso) {
    const [h, m] = f.departure.split(':').map(Number);
    const [y, mo, d] = iso.split('-').map(Number);
    return Date.UTC(y, mo - 1, d) + (h * 60 + m - 330) * 60000;
  },
  arrivalInstant(f, iso) {
    const dep = this.departureInstant(f, iso);
    return f.durationMinutes != null ? dep + f.durationMinutes * 60000 : null;
  },
};
const ctx = (o = {}) => Object.assign({
  from: 'HYD', to: 'BLR', day: '2030-01-10', ret: '2030-01-12',
  pax: { adults: 1 }, multiplier: 1, departed: () => false,
  departureInstant: (f, i) => clock.departureInstant(f, i),
  arrivalInstant: (f, i) => clock.arrivalInstant(f, i),
}, o);

test('every onward x every return is a pair, so airlines can differ by direction', () => {
  const outs = [leg({ id: 'O1', airline: 'IndiGo' }), leg({ id: 'O2', airline: 'Air India', airlineCode: 'AI' })];
  const backs = [back({ id: 'B1', airline: 'IndiGo' }), back({ id: 'B2', airline: 'Air India', airlineCode: 'AI' })];
  const trips = RoundTrip.pairTrips(outs, backs, ctx());
  assert.equal(trips.length, 4);
  const combos = trips.map(t => t.out.airline + '>' + t.ret.airline).sort();
  assert.deepEqual(combos, ['Air India>Air India', 'Air India>IndiGo', 'IndiGo>Air India', 'IndiGo>IndiGo']);
  assert.equal(new Set(trips.map(t => t.id)).size, 4, 'no duplicated pair');
  trips.forEach(t => {
    assert.equal(t.out.date, '2030-01-10');
    assert.equal(t.ret.date, '2030-01-12');
    assert.equal(t.total, t.out.total + t.ret.total);
  });
});

test('only flights in the right direction are paired; nothing is invented to fill a gap', () => {
  const wrongWay = leg({ id: 'X', origin: { code: 'DEL' }, destination: { code: 'BLR' } });
  const trips = RoundTrip.pairTrips([wrongWay], [back()], ctx());
  assert.equal(trips.length, 0);
  assert.equal(RoundTrip.pairTrips([leg()], [leg({ id: 'Y' })], ctx()).length, 0, 'a second outbound is not a return');
});

test('a return before the onward day is no trip', () => {
  assert.equal(RoundTrip.pairTrips([leg()], [back()], ctx({ ret: '2030-01-09' })).length, 0);
});

test('a departed onward flight is not offered', () => {
  const gone = leg({ id: 'GONE' });
  const trips = RoundTrip.pairTrips([gone, leg({ id: 'OK' })], [back()], ctx({ departed: f => f.id === 'GONE' }));
  assert.deepEqual(trips.map(t => t.out.id), ['OK']);
});

test('same day: the return must leave at least 90 minutes after the onward lands (boundary exact)', () => {
  const same = ctx({ ret: '2030-01-10' });                // onward lands 07:50
  const at = hhmm => back({ id: 'R' + hhmm, departure: hhmm });
  assert.equal(RoundTrip.pairTrips([leg()], [at('09:20')], same).length, 1, '07:50 + 90 min = 09:20 is allowed');
  assert.equal(RoundTrip.pairTrips([leg()], [at('09:19')], same).length, 0, 'one minute short is not');
  assert.equal(RoundTrip.pairTrips([leg()], [at('06:00')], same).length, 0, 'before the onward even lands');
});

test('same day with an unpublished onward arrival cannot be checked, so it is left out', () => {
  const noArrival = leg({ arrival: null, durationMinutes: null });
  assert.equal(RoundTrip.pairTrips([noArrival], [back()], ctx({ ret: '2030-01-10' })).length, 0);
  assert.equal(RoundTrip.pairTrips([noArrival], [back()], ctx()).length, 1, 'on different days it is fine');
});

test('a trip is sample if EITHER leg is sample, and live only when both are live', () => {
  const mk = (a, b) => RoundTrip.pairTrips([leg({ sample: a })], [back({ sample: b })], ctx())[0];
  assert.equal(mk(true, true).sample, true);
  assert.equal(mk(true, false).sample, true);
  assert.equal(mk(false, true).sample, true);
  assert.equal(mk(false, false).sample, false);
});

test('pairing prices every trip for THIS party and cabin', () => {
  const trips = RoundTrip.pairTrips([leg()], [back()],
    ctx({ pax: { adults: 2, children: 0, infants: 1 }, multiplier: 2.9 }));
  const p = trips[0].price;
  assert.equal(p.paying, 2);
  assert.equal(p.perTraveller, Math.round(4000 * 2.9) + Math.round(720 * 2.9) + Math.round(3200 * 2.9) + Math.round(580 * 2.9));
  assert.equal(p.party, p.perTraveller * 2);
});

/* ====================================================== 4. TRAVEL DATA / SAMPLE */
function travelData() {
  const c = load(page(), ['airports.js', 'travel-data.js']);
  return { c, TD: get(c, 'TravelData') };
}

test('every sample row says so: `sample` is data on the row, not a page badge', async () => {
  const { TD } = travelData();
  const outs = await TD.flights();
  const backs = await TD.returnFlights();
  assert.ok(outs.length > 0 && backs.length > 0);
  outs.forEach(f => { assert.equal(f.sample, true); assert.equal(f.sampleReturn, false); assert.equal(f.priceBasis, 'per-traveller'); });
  backs.forEach(f => { assert.equal(f.sample, true); assert.equal(f.sampleReturn, true); });
});

test('the derived return board flies the other way, to Hyderabad, and is never in the one-way list', async () => {
  const { TD } = travelData();
  const outs = await TD.flights();
  const backs = await TD.returnFlights();
  backs.forEach(f => assert.equal(f.destination.code, 'HYD'));
  assert.ok(outs.every(f => f.origin.code === 'HYD'), 'a one-way search never sees a derived return row');
  const ids = new Set(outs.map(f => f.id));
  assert.ok(backs.every(f => !ids.has(f.id)), 'return ids cannot collide with outbound ids');
});

test('the search request carries the party and the cabin, in the supplier\'s vocabulary', () => {
  const { TD } = travelData();
  // JSON round-trip: the object was made in the vm's realm, deepStrictEqual compares prototypes too.
  assert.deepEqual(JSON.parse(JSON.stringify(TD.flightQuery({ from: 'BLR', to: 'HYD', date: '2030-01-12', pax: { adults: 2, children: 1, infants: 1 }, cabin: 'premium' }))),
    { from: 'BLR', to: 'HYD', date: '2030-01-12', adults: 2, children: 1, infants: 1, cabin: 'premium_economy' });
  const q = TD.flightQuery({ from: 'A', to: 'B', date: 'd', pax: {}, cabin: 'business' });
  assert.equal(q.adults, 1, 'never a search for nobody');
  assert.equal(q.cabin, 'business');
  assert.equal(TD.flightQuery({ from: 'A', to: 'B', date: 'd', pax: { adults: 1 }, cabin: 'nonsense' }).cabin, 'economy');
});

test('live mode is never reached by default, and a live row is neither sample nor per-traveller', async () => {
  const { c, TD } = travelData();
  assert.equal(TD.config.useLiveApi.flights, false, 'flights stay on the sample schedule');
  // Simulate the switch being flipped, with a stand-in for the endpoint, to pin what a
  // supplier row means and that BOTH directions would be searched with the same party.
  const seen = [];
  c.fetch = async url => {
    seen.push(String(url));
    return { ok: true, json: async () => ({ results: [{ no: 'XX100', airline: 'Test Air', to: 'BLR', dep: '06:00', arr: '07:00', supplier: 'duffel' }] }) };
  };
  TD.config.useLiveApi.flights = true;
  const q = d => TD.flightQuery({ from: 'HYD', to: 'BLR', date: d, pax: { adults: 2, children: 0, infants: 1 }, cabin: 'premium' });
  const outs = await TD.flights(q('2030-01-10'));
  const backs = await TD.returnFlights(TD.flightQuery({ from: 'BLR', to: 'HYD', date: '2030-01-12', pax: { adults: 2, children: 0, infants: 1 }, cabin: 'premium' }));
  assert.equal(outs[0].sample, false);
  assert.equal(outs[0].priceBasis, 'party');
  assert.equal(backs[0].sample, false);
  assert.equal(backs[0].sampleReturn, false, 'a live feed never falls back to the sample return board');
  assert.equal(seen.length, 2);
  for (const u of seen) {
    assert.match(u, /adults=2/); assert.match(u, /infants=1/); assert.match(u, /cabin=premium_economy/);
  }
  assert.match(seen[1], /from=BLR/); assert.match(seen[1], /to=HYD/); assert.match(seen[1], /date=2030-01-12/);
});

/* ===================================================== 5. CHECKOUT HOLD, NO BROWSER */
function flowsPage() {
  const c = page();
  load(c, ['airports.js', 'travel-data.js', 'booking-data.js', 'booking-api.js', 'booking-store.js',
    'booking-flow.js', 'booking-products.js', 'booking-flows.js']);
  return c;
}
async function itemPair(c, sample = true) {
  const TD = get(c, 'TravelData');
  const o = (await TD.flights()).find(f => f.destination.code === 'BLR');
  const r = (await TD.returnFlights()).find(f => f.origin.code === 'BLR');
  o.date = '2030-01-10'; r.date = '2030-01-12';
  o.sample = sample; r.sample = sample;
  return [o, r];
}

test('BookingProducts.checkoutHold: nothing is held — one-way, round-trip and multi-city are all bookable, sample or live', async () => {
  const c = flowsPage();
  const P = get(c, 'BookingProducts');
  const [o, r] = await itemPair(c);            // sample=true board rows
  // A SAMPLE flight no longer holds checkout: demo flights are bookable in demo mode.
  assert.equal(P.checkoutHold({ item: o }), null, 'one-way sample is free to continue');
  assert.equal(P.checkoutHold({ item: o, returnItem: r }), null, 'round-trip sample is free');
  assert.equal(P.checkoutHold({ item: o, legs: [o, r] }), null, 'multi-city with a sample leg is free');
  // A LIVE flight is free too (round-trip / multi-city are bookable via the multi-segment endpoint).
  assert.equal(P.checkoutHold({ item: { ...o, sample: false }, returnItem: { ...r, sample: false } }), null, 'round-trip live is free');
  assert.equal(P.checkoutHold({ item: o, segments: [{}, {}, {}] }), null, 'multi-city is free');
  assert.equal(P.checkoutHold(null), null);
});

test('a round-trip flow definition blocks nothing: Payment and the confirmation step are free, Review continues, and it seeds two segments', async () => {
  const c = flowsPage();
  const F = get(c, 'BookingFlows');
  const [o, r] = await itemPair(c);
  const def = F.flight(o, { pax: { adults: 1, children: 0, infants: 0 }, cabin: 'economy', returnItem: r });
  const draft = Object.assign({}, def.seed);
  const step = id => def.steps.find(s => s.id === id);
  assert.equal(typeof step('payment').block, 'function', 'the engine can still ask the Payment step');
  assert.equal(typeof step('done').block, 'function');
  assert.equal(step('payment').block(draft), null, 'Payment is no longer blocked for a round trip');
  assert.equal(step('done').block(draft), null, 'the confirmation step is no longer blocked');
  assert.equal(step('summary').validate(draft), true, 'Review continues');
  assert.equal(def.seed.segments.length, 2, 'one booking, one segment per direction');
  assert.equal(def.seed.returnItem.id, r.id);
});

test('a multi-city flow definition (three legs) blocks nothing and seeds three segments', async () => {
  const c = flowsPage();
  const F = get(c, 'BookingFlows');
  const [o, r] = await itemPair(c);
  const l3 = Object.assign({}, o, { id: 'L3', date: '2030-01-14' });
  const legs = [o, r, l3];
  const def = F.flight(o, { pax: { adults: 1, children: 0, infants: 0 }, cabin: 'economy', legs });
  const draft = Object.assign({}, def.seed);
  const step = id => def.steps.find(s => s.id === id);
  assert.equal(step('payment').block(draft), null, 'Payment is free for a multi-city trip');
  assert.equal(step('done').block(draft), null);
  assert.equal(step('summary').validate(draft), true);
  assert.equal(def.seed.segments.length, 3, 'one booking, one segment per leg');
});

test('the same definition for a ONE-WAY flight blocks nothing', async () => {
  const c = flowsPage();
  const F = get(c, 'BookingFlows');
  const [o] = await itemPair(c);
  const def = F.flight(o, { pax: { adults: 1, children: 0, infants: 0 }, cabin: 'economy' });
  const draft = Object.assign({}, def.seed);
  const step = id => def.steps.find(s => s.id === id);
  assert.equal(step('payment').block(draft), null);
  assert.equal(step('done').block(draft), null);
  assert.equal(step('summary').validate(draft), true);
  assert.equal(def.seed.segments, undefined);
});

test('a round-trip draft builds ONE multi-segment booking (two segments) and goes to the multi-segment endpoint, not the single-flight one', async () => {
  const c = flowsPage();
  const P = get(c, 'BookingProducts');
  const Store = get(c, 'BookingStore');
  const Api = get(c, 'BookingApi');
  const [o, r] = await itemPair(c);                    // sample board rows
  const calls = { multi: 0, single: 0, pay: 0 };
  let sentPayload = null;
  Api.isLive = () => true;
  Api.isSignedIn = () => true;
  Api.createMultiSegmentBooking = async (p) => { calls.multi++; sentPayload = p; return { booking_ref: 'JPB9', passengers: [], status: 'pending' }; };
  Api.createBooking = async () => { calls.single++; return { booking_ref: 'X', passengers: [], status: 'pending' }; };
  Api.payBooking = async () => { calls.pay++; return { booking_ref: 'JPB9', passengers: [], status: 'pending' }; };

  const ctx = {
    kind: 'flight', item: o, returnItem: r, cabin: 'economy',
    passengers: [{ kind: 'Adult', first: 'A', last: 'B' }], seats: [], addons: [],
    pricing: { total: 8500, lines: [] }, summaryTitle: 'HYD ⇄ BLR round trip',
    payment: { method: 'upi' },
  };
  const draft = P.flowDraft(ctx);                      // checkoutHold no longer throws here
  assert.equal(draft.roundTrip, true);
  assert.equal(draft.apiMulti, true);
  assert.equal(draft.apiPayload.segments.length, 2, 'one booking owning one segment per direction');

  await Store.create(draft);
  assert.equal(calls.multi, 1, 'exactly one multi-segment booking was created');
  assert.equal(calls.single, 0, 'the single-flight endpoint was not used');
  assert.equal(sentPayload.segments.length, 2, 'both legs were sent as segments of ONE booking (one confirmation per booking, not per segment)');
  assert.equal(c.__store.size, 0, 'it went to the server; nothing was stored locally');
});

test('a multi-city draft (three legs) builds ONE multi-segment booking with three segments', async () => {
  const c = flowsPage();
  const P = get(c, 'BookingProducts');
  const Store = get(c, 'BookingStore');
  const Api = get(c, 'BookingApi');
  const [o, r] = await itemPair(c);
  const l3 = Object.assign({}, o, { id: 'L3', date: '2030-01-14' });
  const calls = { multi: 0, single: 0 };
  Api.isLive = () => true;
  Api.isSignedIn = () => true;
  Api.createMultiSegmentBooking = async () => { calls.multi++; return { booking_ref: 'JPB10', passengers: [], status: 'pending' }; };
  Api.createBooking = async () => { calls.single++; return {}; };
  Api.payBooking = async () => ({ booking_ref: 'JPB10', passengers: [], status: 'pending' });

  const ctx = {
    kind: 'flight', item: o, legs: [o, r, l3], cabin: 'economy',
    passengers: [{ kind: 'Adult', first: 'A', last: 'B' }], seats: [], addons: [],
    pricing: { total: 12000, lines: [] }, summaryTitle: 'HYD multi-city', payment: { method: 'upi' },
  };
  const draft = P.flowDraft(ctx);
  assert.equal(draft.apiMulti, true);
  assert.equal(draft.apiPayload.segments.length, 3);
  await Store.create(draft);
  assert.equal(calls.multi, 1, 'one multi-segment booking for the whole itinerary');
  assert.equal(calls.single, 0);
});

test('a multi-segment draft (round-trip / multi-city) is refused on the LOCAL fallback — the demo store cannot represent several legs, so sign-in is required', async () => {
  const c = load(page(), ['airports.js', 'travel-data.js', 'booking-data.js', 'booking-api.js', 'booking-store.js']);
  const Store = get(c, 'BookingStore');
  const Api = get(c, 'BookingApi');
  const calls = { multi: 0, single: 0 };
  Api.isLive = () => true;
  Api.isSignedIn = () => false;                        // cannot reach the server → local fallback
  Api.createMultiSegmentBooking = async () => { calls.multi++; return {}; };
  Api.createBooking = async () => { calls.single++; return {}; };
  const base = { kind: 'flight', title: 't', total: 8500, payment: { method: 'upi' }, apiPayload: { segments: [{}, {}] }, apiMulti: true };

  await assert.rejects(() => Store.create({ ...base, roundTrip: true }), /signed in/i);
  await assert.rejects(() => Store.create({ ...base, returnItem: { id: 'R' } }), /signed in/i);
  assert.deepEqual(calls, { multi: 0, single: 0 }, 'nothing reached the server and nothing was flattened to one leg');
  assert.equal(c.__store.size, 0, 'and nothing was stored locally either');
});

test('BookingStore.create still books a one-way draft (server path and local fallback)', async () => {
  const c = load(page(), ['airports.js', 'travel-data.js', 'booking-data.js', 'booking-api.js', 'booking-store.js']);
  const Store = get(c, 'BookingStore');
  const Api = get(c, 'BookingApi');
  let created = 0;
  Api.isLive = () => true;
  Api.isSignedIn = () => true;
  Api.createBooking = async () => { created++; return { booking_ref: 'JPB1', passengers: [], status: 'pending' }; };
  Api.payBooking = async () => ({ booking_ref: 'JPB1', passengers: [], status: 'pending' });
  const draft = { kind: 'flight', title: 't', total: 4720, payment: { method: 'upi' }, apiPayload: { flight: {} }, roundTrip: false };
  await Store.create(draft);
  assert.equal(created, 1);

  Api.isSignedIn = () => false;
  const local = await Store.create({ kind: 'flight', title: 't', total: 4720, airlineCode: '6E', roundTrip: false });
  assert.equal(local.status, 'Confirmed');
  assert.equal(c.__store.size, 1);
});
