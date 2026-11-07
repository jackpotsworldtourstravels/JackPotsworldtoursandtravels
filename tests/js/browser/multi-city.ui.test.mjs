// The multi-city results page, in a real browser: the journey hero, the leg cards, one leg at a time.
//
// WHAT THIS PINS, on the live flights page (sample schedule, so no flight API is needed):
//   * the hero reads "Your multi-city journey" and draws a route timeline FROM THE SEARCH — two different
//     itineraries give two different timelines (nothing is hardcoded), with codes, cities, the flight count,
//     the day(s), the party, the cabin and "Sample schedule — not bookable"
//   * one leg card per leg (any number): the one on screen is the Fare Summary's pale-gold card, the others plain One-Way white; clicking a card shows THAT leg's flights,
//     writes ?leg=N, keeps the rest of the search, and Back / Forward walk the legs
//   * filters belong to the leg on screen: a filter ticked on leg 1 is still there when you come back, and does
//     not leak onto the other legs; a pick on a leg survives moving to another leg
//   * a leg with no sample schedule says so, honestly, instead of showing another leg's flights
//   * every sample result is labelled "Sample flight — not bookable" and has the One-Way SELECT and VIEW DETAILS pair; SELECT only
//     REMEMBERS the flight for the leg (data-fx-pick) - there is no Book / data-tx-book control - and nothing on the page can start a booking
//   * the leg cards, SELECT and VIEW DETAILS are the One-Way / Booking Summary design, compared property by property in computed styles
//   * the page has ONE colour identity with One-Way: the same hero overlay and photo opacity (and a photo that does not follow the leg),
//     the sample-flight banner in the Fare Summary wash, and the card, price panel and text colours read from the same tokens
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

ui('leg cards: one per leg, the one on screen the pale-gold Fare Summary card and the others white; every leg can be selected and shows ITS flights', async (page) => {
  await open(page, MULTI());
  let s = await snap(page);
  assert.deepEqual(s.on, [true, false, false]); assert.deepEqual(s.pressed, ['true', 'false', 'false']);
  assert.equal(s.search, null, 'the first leg needs no ?leg=');
  assert.match(s.head, /^Flight 1: Hyderabad to Bengaluru$/);
  assert.deepEqual(s.origins, ['HYD']); assert.deepEqual(s.dests, ['BLR']);
  assert.ok(s.cards > 0);
  /* The leg on screen is the Fare Summary's pale-gold card (--ds-wash-gold) with a firmer gold-ink outline and a filled number badge;
     a leg that is not on screen is a plain One-Way card surface: white, no gradient, the card hairline. Parity with the real Fare
     Summary card and the real One-Way card is checked property by property in the computed-styles test below. */
  const gold = await page.eval(`(() => { const cs = (e) => getComputedStyle(e); const on = document.querySelector('.fx-leg.is-on'), off = document.querySelectorAll('.fx-leg')[1];
    return { onBg: cs(on).backgroundImage, offBg: cs(off).backgroundImage, onBgc: cs(on).backgroundColor, offBgc: cs(off).backgroundColor,
      onBadge: cs(on.querySelector('.fx-leg-n')).backgroundColor, offBadge: cs(off.querySelector('.fx-leg-n')).backgroundColor, onBd: cs(on).borderTopColor, offBd: cs(off).borderTopColor }; })()`);
  assert.match(gold.onBg, /rgba\(217, 178, 111, 0\.16\).*rgba\(217, 178, 111, 0\.04\)/, 'the leg on screen carries the Fare Summary wash');
  assert.equal(gold.onBgc, 'rgb(253, 251, 248)');
  assert.equal(gold.offBg, 'none', 'a leg that is not on screen has no gold at all'); assert.equal(gold.offBgc, 'rgb(255, 255, 255)', 'it is white, like a One-Way card');
  assert.notEqual(gold.onBd, gold.offBd, 'the one on screen has a firmer outline');
  assert.notEqual(gold.onBadge, gold.offBadge, 'and a filled number badge');
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

ui('every sample result says "Sample flight — not bookable", has SELECT (a leg pick) and VIEW DETAILS, and has no way to book', async (page) => {
  await open(page, MULTI());
  const cards = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('#txFlightList .jf-leg-card')].map(c => ({
    sample: c.classList.contains('is-sample'), banner: (c.querySelector('.jfl-sample') || {}).textContent || '',
    book: c.querySelectorAll('[data-tx-book], [data-tx-book-trip], .jft-select').length,
    selects: [...c.querySelectorAll('.jf-select')].map(b => ({ text: b.textContent.trim(), pick: b.hasAttribute('data-fx-pick'), book: b.hasAttribute('data-tx-book'), pressed: b.getAttribute('aria-pressed'), arrow: !!b.querySelector('svg') })),
    more: [...c.querySelectorAll('.jf-more')].map(b => ({ text: b.textContent.trim(), details: b.hasAttribute('data-tx-details'), expanded: b.getAttribute('aria-expanded') })),
    old: !!c.querySelector('.jfl-view, .jfl-pick') || /choose for this leg/i.test(c.innerText),
    view: !!c.querySelector('[data-tx-details]'), price: (c.querySelector('.jfl-amt') || {}).textContent, tax: (c.querySelector('.jfl-tax') || {}).textContent,
    cells: [...c.querySelectorAll('.jfl-cell b')].map(b => b.textContent), times: [...c.querySelectorAll('.jfl-time')].map(b => b.textContent) })))`));
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.ok(c.sample); assert.match(c.banner, /Sample flight — not bookable\./);
    assert.equal(c.book, 0, 'no Book control (data-tx-book / data-tx-book-trip)');
    assert.deepEqual(c.selects, [{ text: 'Select', pick: true, book: false, pressed: 'false', arrow: true }], 'one SELECT, with its arrow: a leg pick, never a booking');
    assert.deepEqual(c.more, [{ text: 'View Details', details: true, expanded: 'false' }], 'one VIEW DETAILS');
    assert.equal(c.old, false, 'the old "Choose for this leg" pill and the gold View Details button are gone');
    assert.ok(c.view, 'View Details');
    assert.match(c.price, /^₹[\d,]+$/); assert.match(c.tax, /per traveller, incl\. taxes/);
    assert.deepEqual(c.cells, ['Baggage (per traveller)', 'Fare type', 'Cancellation & date change']);
    assert.ok(c.times.every(t => /^\d\d:\d\d$/.test(t)));
  }
  // View Details opens the existing details panel inside the card (the label becomes Hide Details), and closes again
  await page.eval(`document.querySelector('.jf-leg-card [data-tx-details]').click()`); await sleep(500);
  assert.equal(await page.eval(`!!document.querySelector('.jf-leg-card .tx-details')`), true);
  assert.equal(await page.eval(`document.querySelector('.jf-leg-card [data-tx-details]').textContent`), 'Hide Details');
  assert.equal(await page.eval(`document.querySelector('.jf-leg-card [data-tx-details]').getAttribute('aria-expanded')`), 'true');
  await page.eval(`document.querySelector('.jf-leg-card [data-tx-details]').click()`); await sleep(300);
  assert.equal(await page.eval(`!!document.querySelector('.jf-leg-card .tx-details')`), false);
  assert.equal(await page.eval(`document.querySelector('.jf-leg-card [data-tx-details]').textContent`), 'View Details');
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


/* =====================================================================================================================
   THE ONE-WAY / BOOKING SUMMARY DESIGN, compared in computed styles
   =====================================================================================================================
   The multi-city SELECT and VIEW DETAILS are the One-Way card's own buttons, and the journey cards are the flight Booking
   Summary's pale-gold card. "Looks the same" is not a thing to eyeball: every computed property of the real One-Way button
   is read, in each state, and the multi-city one must equal it; the real Booking Summary card (opened from a One-Way
   SELECT) is read and each journey card must carry its background, border and radius. Width is the one thing allowed to
   differ - the multi-city price panel is its own column. */
const PROPS = ['backgroundColor', 'backgroundImage', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'minHeight', 'height', 'borderTopWidth', 'borderTopColor', 'borderBottomWidth', 'borderBottomColor', 'borderRadius', 'boxShadow', 'transform', 'opacity'];
const read = (page, sel) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const cs = getComputedStyle(e), o = {}; ${JSON.stringify(PROPS)}.forEach(p => { o[p] = cs[p]; }); return o; })()`);
async function statesOf(page, sel, list) {
  await page.send('DOM.enable'); await page.send('CSS.enable');
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  assert.ok(nodeId, 'found ' + sel);
  const out = {};
  for (const [name, pseudo] of list) { await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo }); await sleep(450); out[name] = await read(page, sel); }
  await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  return out;
}
const ALL = [['rest', []], ['hover', ['hover']], ['focus-visible', ['focus', 'focus-visible']], ['active', ['hover', 'active']]];

ui('the journey cards, SELECT and VIEW DETAILS are the One-Way / Booking Summary design (computed styles, property by property)', async (page) => {
  // 1. the One-Way page: its SELECT, its VIEW DETAILS, then the Booking Summary card its SELECT opens
  await open(page, `/flights.html?trip=oneway&from=HYD&to=DEL&depart=${iso(3)}&adults=1&cabin=economy`);
  await page.waitFor(() => document.querySelectorAll('#txFlightList .jf .jf-select').length > 0, { label: 'one-way SELECT' });
  const oneSelect = await statesOf(page, '#txFlightList .jf .jf-select', ALL);
  const oneMore = await statesOf(page, '#txFlightList .jf .jf-more', ALL.slice(0, 3));
  await page.eval(`document.querySelector('#txFlightList .jf .jf-select').click()`);
  await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight .bk-price'), { label: 'the Booking Summary card', timeout: 15000 });
  await sleep(1200);
  const summary = await read(page, '.bk-sheet.is-flight .bk-price');
  // the One-Way flight card itself, read on the same page before the booking sheet opened
  await open(page, `/flights.html?trip=oneway&from=HYD&to=DEL&depart=${iso(3)}&adults=1&cabin=economy`);
  const oneCard = await read(page, '#txFlightList .tx-flight.jf:not(.tx-sk-flight)');
  await page.eval(`document.querySelector('#txFlightList .jf .jf-select').click()`);
  await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight .bk-price'), { label: 'the Booking Summary card (again)', timeout: 15000 });
  await sleep(800);

  // 2. the multi-city page
  await open(page, MULTI());
  const mSelect = await statesOf(page, '#txFlightList .jf-leg-card .jf-select', ALL);
  const mMore = await statesOf(page, '#txFlightList .jf-leg-card .jf-more', ALL.slice(0, 3));
  const cards = await page.eval(`[...document.querySelectorAll('.fx-leg')].map(e => { const cs = getComputedStyle(e); return { bgi: cs.backgroundImage, bgc: cs.backgroundColor, bw: cs.borderTopWidth, br: cs.borderRadius, bs: cs.boxShadow, bd: cs.borderTopColor, on: e.classList.contains('is-on'), color: cs.color }; })`);

  const diffs = [];
  const same = (what, a, b) => { for (const st of Object.keys(a)) for (const k of PROPS) if (a[st][k] !== b[st][k]) diffs.push(`${what} [${st}] ${k}: One-Way "${a[st][k]}" vs multi-city "${b[st][k]}"`); };
  same('SELECT', oneSelect, mSelect);
  same('VIEW DETAILS', oneMore, mMore);
  assert.deepEqual(diffs, [], 'SELECT / VIEW DETAILS differ from the One-Way ones');

  assert.match(summary.backgroundImage, /rgba\(217, 178, 111, 0\.16\).*rgba\(217, 178, 111, 0\.04\)/, 'the Booking Summary wash is what we expect to compare against');
  const on = cards.filter(c => c.on), off = cards.filter(c => !c.on);
  assert.equal(on.length, 1); assert.ok(off.length >= 1);
  for (const c of on) {                                  // the leg on screen == the Booking Summary card
    assert.equal(c.bgi, summary.backgroundImage, 'active card background gradient == Booking Summary');
    assert.equal(c.bgc, summary.backgroundColor, 'active card ground == Booking Summary');
    assert.equal(c.bw, summary.borderTopWidth); assert.equal(c.br, summary.borderRadius, 'radius == Booking Summary');
    assert.equal(c.bs.slice(0, summary.boxShadow.length), summary.boxShadow, 'shadow == Booking Summary (the outline is added after it)');
    assert.equal(c.color, 'rgb(21, 27, 39)', 'dark ink text');
  }
  for (const c of off) {                                 // a leg that is not on screen == the One-Way card surface
    assert.equal(c.bgi, 'none', 'no gold on an inactive leg'); assert.equal(c.bgc, oneCard.backgroundColor, 'ground == One-Way card');
    assert.equal(c.br, oneCard.borderRadius, 'radius == One-Way card'); assert.equal(c.bs, oneCard.boxShadow, 'shadow == One-Way card');
    assert.equal(c.color, 'rgb(21, 27, 39)', 'dark ink text');
  }
});

/* SELECT, VIEW DETAILS and the details drawer at the five widths asked for: shown whole, in order, never clipped, and doing their job. */
for (const [w, h] of [[1440, 900], [1280, 800], [768, 1024], [390, 844], [375, 667]]) {
  ui(`multi-city SELECT / VIEW DETAILS at ${w}px: whole, in order, details open and close, a pick survives changing leg, nothing books`, async (page) => {
    await open(page, MULTI(), { width: w, height: h, mobile: w < 600 });
    const geo = JSON.parse(await page.eval(`JSON.stringify((() => { const c = document.querySelector('#txFlightList .jf-leg-card'), s = c.querySelector('.jf-select'), m = c.querySelector('.jf-more'), cr = c.getBoundingClientRect(), sr = s.getBoundingClientRect(), mr = m.getBoundingClientRect();
      return { vw: innerWidth, hs: document.documentElement.scrollWidth > innerWidth + 1, card: [cr.left, cr.right], s: [sr.left, sr.right, sr.top, sr.bottom, sr.height], m: [mr.left, mr.right, mr.top, mr.bottom],
        sClip: s.scrollWidth > s.clientWidth + 1, mClip: m.scrollWidth > m.clientWidth + 1,
        legs: [...document.querySelectorAll('.fx-leg')].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right, e.scrollWidth > e.clientWidth + 1]; }) }; })())`));
    assert.equal(geo.hs, false, 'no sideways scroll');
    assert.ok(geo.s[3] <= geo.m[2] + 1, 'SELECT is above VIEW DETAILS'); assert.ok(geo.s[4] >= 36, 'SELECT is a real button height (' + geo.s[4] + 'px)');
    for (const [l, r] of [geo.s, geo.m]) { assert.ok(l >= geo.card[0] - 1 && r <= geo.card[1] + 1, 'inside its card'); assert.ok(l >= 0 && r <= geo.vw + 1, 'inside the window'); }
    assert.equal(geo.sClip || geo.mClip, false, 'neither label is clipped');
    // the journey cards sit in a horizontal strip that scrolls by design on a phone; each must be whole inside itself
    geo.legs.forEach(([l, r, clipped]) => { assert.equal(clipped, false, 'a journey card\'s content is not clipped'); assert.ok(r > l); });

    // VIEW DETAILS <-> HIDE DETAILS, and the existing details are there
    await page.eval(`document.querySelector('#txFlightList .jf-leg-card .jf-more').click()`); await sleep(600);
    const open1 = JSON.parse(await page.eval(`JSON.stringify({ label: document.querySelector('#txFlightList .jf-leg-card .jf-more').textContent, exp: document.querySelector('#txFlightList .jf-leg-card .jf-more').getAttribute('aria-expanded'),
      panel: !!document.querySelector('#txFlightList .jf-leg-card .tx-details'), text: (document.querySelector('#txFlightList .jf-leg-card .tx-details') || {}).innerText || '',
      cells: [...document.querySelectorAll('#txFlightList .jf-leg-card:first-child .jfl-cell b')].map(b => b.textContent), hs: document.documentElement.scrollWidth > innerWidth + 1 })`));
    assert.equal(open1.label, 'Hide Details'); assert.equal(open1.exp, 'true'); assert.ok(open1.panel);
    assert.match(open1.text, /Airbus A320neo/); assert.match(open1.text, /baggage/i); assert.match(open1.text, /cancel|refund/i);
    assert.deepEqual(open1.cells, ['Baggage (per traveller)', 'Fare type', 'Cancellation & date change'], 'the card keeps its own baggage / fare / cancellation row');
    assert.equal(open1.hs, false, 'details open: still no sideways scroll');
    // the drawer has its own "Select this flight": on a multi-city card it must be the leg pick, never a booking
    assert.equal(await page.eval(`document.querySelectorAll('#txFlightList [data-tx-book], #txFlightList [data-tx-book-trip]').length`), 0, 'with the details open, nothing on the page can book');
    assert.equal(await page.eval(`document.querySelector('#txFlightList .jf-leg-card .tx-details .txd-select').hasAttribute('data-fx-pick')`), true, "the drawer's Select is the leg pick");
    await page.eval(`document.querySelector('#txFlightList .jf-leg-card .jf-more').click()`); await sleep(400);
    assert.equal(await page.eval(`document.querySelector('#txFlightList .jf-leg-card .jf-more').textContent`), 'View Details');
    assert.equal(await page.eval(`!!document.querySelector('#txFlightList .jf-leg-card .tx-details')`), false);

    // the drawer's Select picks this flight for the leg (and shows "Selected"), books nothing; the card's SELECT then un-picks it
    await page.eval(`document.querySelector('#txFlightList .jf-leg-card .jf-more').click()`); await sleep(500);
    await page.eval(`document.querySelector('#txFlightList .jf-leg-card .tx-details .txd-select').click()`); await sleep(600);
    assert.equal(await page.eval(`document.querySelectorAll('.fx-leg-pick').length`), 1, "the drawer's Select picked the flight for this leg");
    assert.equal(await page.eval(`!!document.querySelector('.bk-sheet')`), false, "and booked nothing");
    await page.eval(`document.querySelector('.jf-leg-card.is-picked .jf-select').click()`); await sleep(500);
    assert.equal(await page.eval(`document.querySelectorAll('.fx-leg-pick').length`), 0);

    // SELECT picks for THIS leg, survives moving to another leg and back, un-picks on a second press, and never books
    await page.eval(`document.querySelector('#txFlightList .jf-leg-card .jf-select').click()`); await sleep(500);
    let st = JSON.parse(await page.eval(`JSON.stringify({ label: document.querySelector('.jf-leg-card.is-picked .jf-select').textContent.trim(), pressed: document.querySelector('.jf-leg-card.is-picked .jf-select').getAttribute('aria-pressed'),
      picks: [...document.querySelectorAll('.fx-leg-pick')].map(e => e.textContent.trim()), bg: getComputedStyle(document.querySelector('.jf-leg-card.is-picked .jf-select')).backgroundImage })`));
    assert.equal(st.label, 'Selected'); assert.equal(st.pressed, 'true'); assert.equal(st.picks.length, 1);
    assert.match(st.bg, /rgb\(201, 72, 47\).*rgb\(166, 58, 36\)/, 'a chosen SELECT keeps the One-Way orange');
    await page.eval(`document.querySelector('[data-fx-leg="2"]').click()`); await sleep(1500);
    await page.eval(`document.querySelector('[data-fx-leg="0"]').click()`); await sleep(1500);
    assert.equal(await page.eval(`document.querySelectorAll('.fx-leg-pick').length`), 1, 'the pick on leg 1 survived leaving it and coming back');
    assert.equal(await page.eval(`document.querySelector('.jf-leg-card.is-picked .jf-select').textContent.trim()`), 'Selected');
    await page.eval(`document.querySelector('.jf-leg-card.is-picked .jf-select').click()`); await sleep(500);
    assert.equal(await page.eval(`document.querySelectorAll('.fx-leg-pick').length`), 0);
    assert.equal(await page.eval(`document.querySelector('#txFlightList .jf-leg-card .jf-select').textContent.trim()`), 'Select');
    assert.equal(await page.eval(`!!document.querySelector('.bk-sheet')`), false, 'nothing opened a booking');
    assert.deepEqual(page.requests(r => r.method === 'POST' && /booking|checkout|payment/i.test(r.url)).map(r => r.url), [], 'and nothing was posted');
  });
}


/* =====================================================================================================================
   ONE COLOUR IDENTITY WITH ONE-WAY: hero, sample banner, card, price panel and text
   ===================================================================================================================== */
const rd = (page, sel, pseudo = null) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const cs = getComputedStyle(e, ${JSON.stringify(pseudo)});
  return { bg: cs.backgroundColor, bgi: cs.backgroundImage, color: cs.color, bt: cs.borderTopColor, bl: cs.borderLeftColor, bb: cs.borderBottomColor, shadow: cs.boxShadow, radius: cs.borderRadius, op: cs.opacity, stroke: cs.stroke,
    src: e.tagName === 'IMG' ? e.currentSrc.split('/').pop() : '' }; })()`);

ui('the hero: the same overlay and photo opacity as One-Way, and a photo that is One-Way\'s own and does not follow the leg', async (page) => {
  await open(page, `/flights.html?trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`);
  await page.waitFor(() => !!document.querySelector('.jp-jh__media img'), { label: 'the one-way hero photo' });
  await page.waitFor(() => getComputedStyle(document.querySelector('.jp-jh__media img')).opacity === '0.72', { label: 'the hero photo to finish fading in', timeout: 12000 });
  const one = { photo: await rd(page, '.jp-jh__media img'), overlay: await rd(page, '.jp-jh__media', '::after'), hero: await rd(page, '#siteHero') };

  const legs = `HYD:DEL:${iso(3)},DEL:TRV:${iso(5)}`;
  await open(page, `/flights.html?trip=multi&from=HYD&to=DEL&depart=${iso(3)}&legs=${encodeURIComponent(legs)}&adults=1&cabin=economy`);
  await page.waitFor(() => !!document.querySelector('.jp-jh__media img'), { label: 'the multi-city hero photo' });
  await page.waitFor(() => getComputedStyle(document.querySelector('.jp-jh__media img')).opacity === '0.72', { label: 'the hero photo to finish fading in', timeout: 12000 });
  const m1 = { photo: await rd(page, '.jp-jh__media img'), overlay: await rd(page, '.jp-jh__media', '::after'), hero: await rd(page, '#siteHero') };
  assert.equal(m1.overlay.bgi, one.overlay.bgi, 'the same dark overlay gradient'); assert.equal(m1.photo.op, one.photo.op, 'the same photo opacity');
  assert.equal(m1.hero.bgi, one.hero.bgi, 'the same hero ground');
  assert.equal(m1.photo.src, 'hyderabad-1600.webp', "the photo One-Way shows for 'Departures from Hyderabad' - the journey's first city, not leg 1's Delhi");
  assert.notEqual(m1.photo.src, 'delhi-1600.webp');

  // moving to the other leg changes the URL's destination, not the photo
  await page.eval(`document.querySelector('[data-fx-leg="1"]').click()`); await sleep(2500);
  assert.equal(await page.eval(`new URLSearchParams(location.search).get('to')`), 'TRV', 'the second leg is on screen');
  assert.equal((await rd(page, '.jp-jh__media img')).src, 'hyderabad-1600.webp', 'the hero photo did not change with the leg');
  assert.equal(await page.eval(`document.querySelectorAll('.jp-jh__media img').length`), 1, 'and was not swapped through a second image');

  // one-way is untouched: the photo still follows its destination
  await open(page, `/flights.html?trip=oneway&from=HYD&to=DEL&depart=${iso(3)}&adults=1&cabin=economy`);
  await page.waitFor(() => !!document.querySelector('.jp-jh__media img'), { label: 'the one-way hero photo' });
  assert.equal((await rd(page, '.jp-jh__media img')).src, 'delhi-1600.webp', 'one-way still shows its destination');
});

ui('the sample-flight banner is the Booking Summary wash (not a separate yellow), still plainly says not bookable; One-Way keeps its status pill', async (page) => {
  await open(page, `/flights.html?trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`);
  const pill = await rd(page, '#txFlightList .jf-status');
  assert.equal(pill.bg, 'rgb(227, 242, 234)'); assert.equal(pill.color, 'rgb(29, 117, 80)'); assert.match(await page.eval(`document.querySelector('#txFlightList .jf-status').textContent`), /scheduled/i);

  await open(page, MULTI());
  const banner = await rd(page, '#txFlightList .jfl-sample'); const bold = await rd(page, '#txFlightList .jfl-sample b');
  assert.match(banner.bgi, /rgba\(217, 178, 111, 0\.16\).*rgba\(217, 178, 111, 0\.04\)/, 'the Fare Summary wash'); assert.equal(banner.bg, 'rgb(253, 251, 248)');
  assert.equal(banner.bb, 'rgba(133, 96, 42, 0.28)', 'the Fare Summary hairline');
  assert.equal(banner.color, 'rgb(59, 66, 82)'); assert.equal(bold.color, 'rgb(21, 27, 39)', 'dark ink on the wash');
  const text = await page.eval(`document.querySelector('#txFlightList .jfl-sample').textContent.replace(/\\s+/g, ' ').trim()`);
  assert.match(text, /^Sample flight — not bookable\. Demonstration schedule and fares, not live availability\.$/, 'the wording is unchanged');
  // contrast: the wash is gold at .16 over rgb(253,251,248), i.e. at its darkest rgb(247,239,226); the banner's ink must clear 4.5:1 on that
  const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  assert.ok(ratio(banner.color, 'rgb(247, 240, 226)') >= 4.5, 'readable even on the darker end of the wash');
});

ui('the result card, price panel, details and text read the One-Way card\'s own colours', async (page) => {
  await open(page, `/flights.html?trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`);
  await page.waitFor(() => document.querySelectorAll('#txFlightList .tx-flight:not(.tx-sk-flight)').length > 0, { label: 'one-way cards' });
  const pair = [['card', '#txFlightList .tx-flight.jf:not(.tx-sk-flight)', '#txFlightList .jf-leg-card'], ['price panel', '#txFlightList .jf-stub', '#txFlightList .jfl-price'],
    ['airline', '.jf-airline', '.jfl-airline'], ['flight no', '.jf-no', '.jfl-no'], ['time', '.jf-time', '.jfl-time'], ['airport code', '.jf-code', '.jfl-code'], ['city', '.jf-city', '.jfl-airport'],
    ['duration', '.jf-dur', '.jfl-dur'], ['non-stop', '.jf-stops', '.jfl-stops'], ['price', '.jf-amt', '.jfl-amt'], ['tax note', '.jf-tax', '.jfl-tax']];
  const one = {}; for (const [k, a] of pair) one[k] = await rd(page, a);
  await page.eval(`document.querySelector('#txFlightList .jf-more').click()`); await sleep(700);
  const oneDrawer = { drawer: await rd(page, '#txFlightList .tx-details'), inner: await rd(page, '#txFlightList .txd-card') };

  await open(page, MULTI());
  const diffs = [];
  const want = { card: ['bg', 'bt', 'shadow', 'radius'], 'price panel': ['bg', 'bl'], airline: ['color'], 'flight no': ['color'], time: ['color'], 'airport code': ['color'], city: ['color'], duration: ['color'], 'non-stop': ['color'], price: ['color'], 'tax note': ['color'] };
  for (const [k, , b] of pair) { const m = await rd(page, b); for (const p of want[k]) if (m[p] !== one[k][p]) diffs.push(`${k}.${p}: One-Way "${one[k][p]}" vs multi-city "${m[p]}"`); }
  await page.eval(`document.querySelector('#txFlightList .jf-more').click()`); await sleep(700);
  const mDrawer = { drawer: await rd(page, '#txFlightList .tx-details'), inner: await rd(page, '#txFlightList .txd-card') };
  for (const k of ['drawer', 'inner']) for (const p of ['bg', 'bt', 'radius']) if (mDrawer[k][p] !== oneDrawer[k][p]) diffs.push(`details ${k}.${p}: One-Way "${oneDrawer[k][p]}" vs multi-city "${mDrawer[k][p]}"`);
  assert.deepEqual(diffs, [], 'the multi-city card differs from the One-Way card');

  // and the leftover one-off colours are gone: no text, rule or icon on the multi-city card is a near-miss of a token
  const stray = await page.eval(`(() => { const out = [];
    const near = [['rgb(214, 147, 19)', 'old gold code'], ['rgb(107, 115, 133)', 'old grey'], ['rgb(94, 102, 122)', 'old grey'], ['rgb(251, 247, 238)', 'old panel'], ['rgb(239, 229, 208)', 'old rule'], ['rgb(239, 231, 214)', 'old rule'],
      ['rgb(251, 235, 196)', 'old banner'], ['rgb(240, 213, 142)', 'old banner rule'], ['rgb(90, 67, 9)', 'old banner text'], ['rgb(27, 138, 87)', 'old green']];
    document.querySelectorAll('#txFlightList .jf-leg-card, #txFlightList .jf-leg-card *').forEach(e => { const cs = getComputedStyle(e);
      [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderLeftColor, cs.borderBottomColor, cs.stroke].forEach(v => { near.forEach(([c, why]) => { if (v === c) out.push(why + ' on ' + e.className); }); }); });
    return [...new Set(out)]; })()`);
  assert.deepEqual(stray, [], 'one-off colours left on the multi-city card');
});
