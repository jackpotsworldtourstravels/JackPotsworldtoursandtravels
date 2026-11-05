// The multi-city results page, in a real browser: the journey hero, the leg cards, one leg at a time.
//
// WHAT THIS PINS, on the live flights page (sample schedule, so no flight API is needed):
//   * the hero reads "Your multi-city journey" and draws a route timeline FROM THE SEARCH — two different
//     itineraries give two different timelines (nothing is hardcoded), with codes, cities, the flight count,
//     the day(s), the party, the cabin and "Sample schedule — not bookable"
//   * one leg card per leg (any number), the selected one gold; clicking a card shows THAT leg's flights,
//     writes ?leg=N, keeps the rest of the search, and Back / Forward walk the legs
//   * filters belong to the leg on screen: a filter ticked on leg 1 is still there when you come back, and does
//     not leak onto the other legs; a pick on a leg survives moving to another leg
//   * a leg with no sample schedule says so, honestly, instead of showing another leg's flights
//   * every sample result is labelled "Sample flight — not bookable", offers View Details and NO Select / Book
//     button, and nothing on the page can start a booking
//   * Edit Search opens the full editor holding the whole itinerary
//   * one-way and round trip keep their own cards and still render in the same night-band design
//   * no horizontal overflow at 1536 / 1280 / 1024 / 768 / 414 / 390 / 375 / 360, and no console errors
//
// Needs Chrome/Edge and a server answering at JPW_BASE (default http://127.0.0.1:8000). Skips with a reason otherwise.
//
//     JPW_BASE=http://127.0.0.1:8000 node --test tests/js/browser/multi-city.ui.test.mjs
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ui(name, fn) {
  test(name, { timeout: 180000 }, async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const page = await chrome.newPage();
    const errors = [];
    page.on('Runtime.exceptionThrown', e => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description || e.exceptionDetails.text || '').split('\n')[0].slice(0, 160)));
    try { await fn(page, t); assert.deepEqual(errors, [], 'no uncaught exceptions on the page'); } finally { page.close(); }
  });
}

const iso = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/** HYD to BLR, BLR to HYD (no sample schedule), HYD to DEL: leg 1 and 3 have sample flights, leg 2 has none. */
const MULTI = (extra = '') => `/flights.html?trip=multi&legs=HYD:BLR:${iso(3)},BLR:HYD:${iso(5)},HYD:DEL:${iso(7)}&adults=2&cabin=business${extra}`;
const VIEW = { width: 1366, height: 900, mobile: false };

async function open(page, path, vp = VIEW) {
  await page.viewport(vp);
  await page.goto(BASE + path);
  await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-leg-card, #txFlightList .tx-flight, #txFlightList .jf-trip, #txFlightList .tx-empty').length > 0,
    { label: 'the flight list', timeout: 20000 });
  await sleep(900);
}

const snap = (page) => page.eval(`JSON.stringify({
  search: new URLSearchParams(location.search).get('leg'),
  on: [...document.querySelectorAll('.fx-leg')].map(b => b.classList.contains('is-on')),
  pressed: [...document.querySelectorAll('.fx-leg')].map(b => b.getAttribute('aria-pressed')),
  head: ((document.getElementById('txCount') || {}).innerText || '').split('\\n')[0].trim(),
  cards: document.querySelectorAll('#txFlightList .jf-leg-card').length,
  origins: [...new Set([...document.querySelectorAll('#txFlightList .jf-leg-card .jfl-end:not(.jfl-end--to) .jfl-code')].map(e => e.textContent))],
  dests: [...new Set([...document.querySelectorAll('#txFlightList .jf-leg-card .jfl-end--to .jfl-code')].map(e => e.textContent))],
  empty: ((document.querySelector('#txFlightList .tx-empty') || {}).innerText || '').replace(/\\s+/g, ' ').trim(),
  ticked: [...document.querySelectorAll('[data-ff-opt="airlines"]:checked')].map(i => i.value),
  picks: [...document.querySelectorAll('.fx-leg-pick')].map(e => e.textContent.trim()) })`).then(JSON.parse);

ui('hero: "Your multi-city journey" and a route timeline drawn from the search, for any itinerary', async (page) => {
  await open(page, MULTI());
  assert.equal(await page.eval(`document.querySelector('h1').textContent.trim()`), 'Your multi-city journey');
  const route = JSON.parse(await page.eval(`JSON.stringify({
    codes: [...document.querySelectorAll('.fx-route .fx-code')].map(e => e.textContent),
    cities: [...document.querySelectorAll('.fx-route .fx-city')].map(e => e.textContent),
    hops: document.querySelectorAll('.fx-route .fx-hop').length, planes: document.querySelectorAll('.fx-route .fx-plane').length,
    meta: document.getElementById('txFlightsSub').textContent, pill: document.querySelector('.tx-sample').textContent.trim() })`));
  assert.deepEqual(route.codes, ['HYD', 'BLR', 'HYD', 'DEL']);
  assert.deepEqual(route.cities, ['Hyderabad', 'Bengaluru', 'Hyderabad', 'Delhi']);
  assert.equal(route.hops, 3); assert.equal(route.planes, 3, 'an airplane on every hop');
  assert.match(route.meta, /^3 flights · /); assert.match(route.meta, /2 Adults/); assert.match(route.meta, /Business/);
  assert.match(route.meta, /–/, 'two different days are shown as a range');
  assert.match(route.pill, /Sample schedule — not bookable/);

  // a different itinerary, a different timeline: four legs, one day
  const d = iso(4);
  await open(page, `/flights.html?trip=multi&legs=HYD:DEL:${d},DEL:BLR:${d},BLR:CMB:${d},CMB:TRV:${d}&adults=1&cabin=economy`);
  const four = JSON.parse(await page.eval(`JSON.stringify({ codes: [...document.querySelectorAll('.fx-route .fx-code')].map(e => e.textContent),
    legs: document.querySelectorAll('.fx-leg').length, meta: document.getElementById('txFlightsSub').textContent })`));
  assert.deepEqual(four.codes, ['HYD', 'DEL', 'BLR', 'CMB', 'TRV']);
  assert.equal(four.legs, 4, 'any number of legs gets a card');
  assert.match(four.meta, /^4 flights · \d\d \w{3} · 1 Adult · Economy$/, 'a single day is not a range');
});

ui('leg cards: one per leg, the selected one gold; every leg can be selected and shows ITS flights', async (page) => {
  await open(page, MULTI());
  let s = await snap(page);
  assert.deepEqual(s.on, [true, false, false]); assert.deepEqual(s.pressed, ['true', 'false', 'false']);
  assert.equal(s.search, null, 'the first leg needs no ?leg=');
  assert.match(s.head, /^Flight 1: Hyderabad to Bengaluru$/);
  assert.deepEqual(s.origins, ['HYD']); assert.deepEqual(s.dests, ['BLR']);
  assert.ok(s.cards > 0);
  const gold = await page.eval(`(() => { const on = getComputedStyle(document.querySelector('.fx-leg.is-on')).backgroundImage; const off = getComputedStyle(document.querySelectorAll('.fx-leg')[1]).backgroundColor; return { on, off }; })()`);
  assert.match(gold.on, /gradient/, 'the selected leg is the gold gradient'); assert.notEqual(gold.off, 'rgba(0, 0, 0, 0)', 'the others are dark navy cards');
  assert.match(await page.eval(`document.querySelector('.fx-leg').innerText`), /Flight 1 of 3[\s\S]*Hyderabad → Bengaluru[\s\S]*\d{2} \w{3}/);

  // leg 2: no sample schedule for BLR to HYD — said plainly, never another leg's flights
  await page.eval(`document.querySelector('[data-fx-leg="1"]').click()`); await sleep(1500);
  s = await snap(page);
  assert.equal(s.search, '2'); assert.deepEqual(s.on, [false, true, false]);
  assert.match(s.head, /^Flight 2: Bengaluru to Hyderabad$/);
  assert.equal(s.cards, 0); assert.match(s.empty, /No sample flights for Flight 2/i); assert.match(s.empty, /BLR to HYD/);

  // leg 3
  await page.eval(`document.querySelector('[data-fx-leg="2"]').click()`); await sleep(1500);
  s = await snap(page);
  assert.equal(s.search, '3'); assert.deepEqual(s.on, [false, false, true]);
  assert.deepEqual(s.origins, ['HYD']); assert.deepEqual(s.dests, ['DEL']); assert.ok(s.cards > 0);

  // the rest of the search is untouched by moving between legs
  const qs = await page.eval(`JSON.stringify(Object.fromEntries(new URLSearchParams(location.search)))`).then(JSON.parse);
  assert.equal(qs.trip, 'multi'); assert.equal(qs.adults, '2'); assert.equal(qs.cabin, 'business'); assert.ok(qs.legs.split(',').length >= 3 || qs.legs.includes('BLR'));

  // a shared link to a leg opens that leg, and an out-of-range leg is clamped
  await open(page, MULTI('&leg=3'));
  assert.deepEqual((await snap(page)).on, [false, false, true]);
  await open(page, MULTI('&leg=9'));
  assert.deepEqual((await snap(page)).on, [false, false, true], 'leg=9 on a three-leg trip is the last leg');
});

ui('Back and Forward walk the legs', async (page) => {
  await open(page, MULTI());
  await page.eval(`document.querySelector('[data-fx-leg="2"]').click()`); await sleep(1500);
  assert.deepEqual((await snap(page)).on, [false, false, true]);
  await page.eval(`history.back()`); await sleep(1500);
  const s = await snap(page);
  assert.deepEqual(s.on, [true, false, false], 'Back lands on leg 1 again');
  assert.match(s.head, /Flight 1: Hyderabad to Bengaluru/);
  await page.eval(`history.forward()`); await sleep(1500);
  assert.deepEqual((await snap(page)).on, [false, false, true]);
});

ui('filters apply to the leg on screen: kept per leg, never leaking onto another', async (page) => {
  await open(page, MULTI());
  const airlines = await page.eval(`[...document.querySelectorAll('[data-ff-opt="airlines"]')].map(i => i.value)`);
  assert.ok(airlines.length >= 2, 'leg 1 has a choice of airlines');
  const all1 = (await snap(page)).cards;
  await page.eval(`document.querySelector('[data-ff-opt="airlines"]').click()`); await sleep(800);
  let s = await snap(page);
  assert.equal(s.ticked.length, 1); assert.ok(s.cards > 0 && s.cards < all1, 'the filter changed leg 1');
  assert.match(await page.eval('location.search'), /f_airlines=/);

  await page.eval(`document.querySelector('[data-fx-leg="2"]').click()`); await sleep(1500);
  s = await snap(page);
  assert.deepEqual(s.ticked, [], "leg 1's airline filter does not follow you to leg 3");
  assert.doesNotMatch(await page.eval('location.search'), /f_airlines=/);
  assert.ok(s.cards > 0, 'and leg 3 still shows all its flights');

  await page.eval(`document.querySelector('[data-fx-leg="0"]').click()`); await sleep(1500);
  s = await snap(page);
  assert.equal(s.ticked.length, 1, "coming back, leg 1's filter is exactly as it was");
  assert.ok(s.cards < all1);
  // the whole panel is still on screen for the leg
  const ids = await page.eval(`[...document.querySelectorAll('#txFilters [data-ff-group]')].map(g => g.dataset.ffGroup)`);
  for (const id of ['popular', 'airlines', 'price', 'stops', 'departure', 'arrival', 'originAirport', 'destAirport', 'duration', 'cabinBag', 'checkinBag', 'refundable', 'aircraft', 'cabin'])
    assert.ok(ids.includes(id), id);
});

ui('a pick is remembered per leg, and is never a booking', async (page) => {
  await open(page, MULTI());
  await page.eval(`document.querySelector('[data-fx-pick]').click()`); await sleep(500);
  let s = await snap(page);
  assert.equal(s.picks.length, 1); assert.match(s.picks[0], /^Chosen: .+ · \d\d:\d\d$/);
  assert.equal(await page.eval(`document.querySelector('.jf-leg-card.is-picked [data-fx-pick]').getAttribute('aria-pressed')`), 'true');
  await page.eval(`document.querySelector('[data-fx-leg="2"]').click()`); await sleep(1500);
  assert.equal((await snap(page)).picks.length, 1, 'the pick on leg 1 is still shown after moving to leg 3');
  await page.eval(`document.querySelector('[data-fx-pick]').click()`); await sleep(500);
  assert.equal((await snap(page)).picks.length, 2);
  // toggling off
  await page.eval(`document.querySelector('[data-fx-pick]').click()`); await sleep(500);
  assert.equal((await snap(page)).picks.length, 1);
  // no booking flow was started by any of it
  assert.equal(await page.eval(`typeof BookingFlow !== 'undefined' && BookingFlow.stepIndex != null && !!document.querySelector('.bk-sheet.is-open, .bk-overlay.is-open')`), false);
});

ui('every sample result says "Sample flight — not bookable", opens View Details, and has no way to book', async (page) => {
  await open(page, MULTI());
  const cards = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('#txFlightList .jf-leg-card')].map(c => ({
    sample: c.classList.contains('is-sample'), banner: (c.querySelector('.jfl-sample') || {}).textContent || '',
    book: c.querySelectorAll('[data-tx-book], [data-tx-book-trip], .jft-select, .jf-select').length,
    view: !!c.querySelector('[data-tx-details]'), price: (c.querySelector('.jfl-amt') || {}).textContent, tax: (c.querySelector('.jfl-tax') || {}).textContent,
    cells: [...c.querySelectorAll('.jfl-cell b')].map(b => b.textContent), times: [...c.querySelectorAll('.jfl-time')].map(b => b.textContent) })))`));
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.ok(c.sample); assert.match(c.banner, /Sample flight — not bookable\./);
    assert.equal(c.book, 0, 'no Select / Book control');
    assert.ok(c.view, 'View Details');
    assert.match(c.price, /^₹[\d,]+$/); assert.match(c.tax, /per traveller, incl\. taxes/);
    assert.deepEqual(c.cells, ['Baggage (per traveller)', 'Fare type', 'Cancellation & date change']);
    assert.ok(c.times.every(t => /^\d\d:\d\d$/.test(t)));
  }
  // View Details opens the existing details panel inside the card, and closes again
  await page.eval(`document.querySelector('.jf-leg-card [data-tx-details]').click()`); await sleep(500);
  assert.equal(await page.eval(`!!document.querySelector('.jf-leg-card .tx-details')`), true);
  await page.eval(`document.querySelector('.jf-leg-card [data-tx-details]').click()`); await sleep(300);
  assert.equal(await page.eval(`!!document.querySelector('.jf-leg-card .tx-details')`), false);
});

ui('Edit Search opens the full editor holding the whole itinerary', async (page) => {
  await open(page, MULTI('&leg=3'));
  await page.eval(`document.querySelector('[data-search-strip]').click()`); await sleep(1800);
  const f = await page.eval(`JSON.stringify({ trip: (document.querySelector('.trip-type.is-on') || {}).dataset.trip,
    legs: [...document.querySelectorAll('#heroSearchDock input[id^="mcFrom"]')].map((e, i) => e.value + ' > ' + (document.querySelector('#heroSearchDock input[id^="mcTo"]:nth-of-type(1)') || {}).value),
    from: [...document.querySelectorAll('#heroSearchDock input[id^="mcFrom"]')].map(e => e.value), to: [...document.querySelectorAll('#heroSearchDock input[id^="mcTo"]')].map(e => e.value) })`).then(JSON.parse);
  assert.equal(f.trip, 'multi');
  assert.deepEqual(f.from.map(v => v.match(/\(([A-Z]{3})\)/)[1]), ['HYD', 'BLR', 'HYD']);
  assert.deepEqual(f.to.map(v => v.match(/\(([A-Z]{3})\)/)[1]), ['BLR', 'HYD', 'DEL']);
});

ui('one-way and round trip keep their own cards, in the same night-band design', async (page) => {
  await open(page, `/flights.html?trip=oneway&from=HYD&to=DEL&depart=${iso(3)}&adults=1&cabin=economy`);
  assert.equal(await page.eval(`document.querySelectorAll('.fx-leg, .fx-route').length`), 0, 'no leg cards or timeline on a one-way page');
  assert.ok(await page.eval(`document.querySelectorAll('#txFlightList .tx-flight:not(.jf-leg-card)').length`) > 0);
  assert.ok(await page.eval(`document.querySelectorAll('#txFlightList [data-tx-book]').length`) > 0, 'one-way still books through Select');
  const night = await page.eval(`JSON.stringify({ band: getComputedStyle(document.querySelector('.tx-scope')).backgroundColor, panel: getComputedStyle(document.getElementById('txFilters')).backgroundColor })`).then(JSON.parse);
  assert.equal(night.band, 'rgb(10, 20, 36)'); assert.equal(night.panel, 'rgb(15, 28, 49)');

  await open(page, `/flights.html?trip=round&from=HYD&to=BLR&depart=${iso(3)}&ret=${iso(5)}&adults=1&cabin=economy`);
  assert.equal(await page.eval(`document.querySelectorAll('.fx-leg, .fx-route').length`), 0);
  assert.ok(await page.eval(`document.querySelectorAll('#txFlightList .jf-trip').length`) > 0);
  assert.match(await page.eval(`document.querySelector('.tx-sample').textContent`), /Sample schedule — not bookable/);
});

for (const [w, h] of [[1536, 900], [1280, 800], [1024, 768], [768, 1024], [414, 896], [390, 844], [375, 812], [360, 740]]) {
  for (const [kind, path] of [['multi-city', () => MULTI()], ['one way', () => `/flights.html?trip=oneway&from=HYD&to=DEL&depart=${iso(3)}&adults=1&cabin=economy`],
    ['round trip', () => `/flights.html?trip=round&from=HYD&to=BLR&depart=${iso(3)}&ret=${iso(5)}&adults=1&cabin=economy`]]) {
    ui(`${kind} at ${w}px: no horizontal overflow, nothing clipped off the right edge`, async (page) => {
      await open(page, path(), { width: w, height: h, mobile: w < 600 });
      const m = JSON.parse(await page.eval(`(() => { const doc = document.documentElement;
        const bad = [...document.querySelectorAll('.fx-route *, .fx-leg, .jf-leg-card, .jf-leg-card *, .jf-trip, #txFilters *')]
          .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && !e.closest('.fx-legs') && !e.closest('.tx-filters:not(.tx-open)'); })
          .map(e => (e.className || e.tagName).toString().slice(0, 30));
        const legs = document.querySelector('.fx-legs');
        return JSON.stringify({ over: doc.scrollWidth - doc.clientWidth, bad: bad.slice(0, 5), legsScroll: legs ? legs.scrollWidth > legs.clientWidth : null }); })()`));
      assert.ok(m.over <= 1, `horizontal overflow of ${m.over}px`);
      assert.deepEqual(m.bad, [], 'nothing runs off the right edge');
    });
  }
}
