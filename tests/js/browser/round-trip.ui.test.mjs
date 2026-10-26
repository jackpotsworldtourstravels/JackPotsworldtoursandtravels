// Round trips, in a real browser: the checkout hold cannot be walked around, and one-way still flows.
//
// A round trip can be chosen, reviewed and priced, but the backend books ONE flight per booking, so
// paying for it would book the onward leg alone at the combined price. These tests try to get a
// round-trip draft to Payment / Confirmation / a stored booking by every route the page offers:
//   * the Continue button on Review
//   * BookingFlow.goTo('payment') and goTo('done') - a forward jump that skips Continue's checks
//   * the browser's Back then Forward
//   * calling the Payment step's own onNext
//   * calling BookingStore.create with a round-trip draft
// and assert afterwards that the flow is still on Review, no booking request left the page, and
// nothing was stored. The one-way half proves the same engine still lets a one-way draft through.
//
// Needs Chrome/Edge and a server answering at JPW_BASE (default http://127.0.0.1:8000); the flights
// page runs on its sample schedule, so no flight API is needed. Skips with a reason otherwise.
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

const iso = (plusDays) => {
  const d = new Date(Date.now() + plusDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ROUND = () => `/flights.html?trip=round&from=HYD&to=BLR&depart=${iso(3)}&ret=${iso(5)}&adults=1&cabin=economy`;
const ONEWAY = () => `/flights.html?trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`;

/** Continue through the flow, filling the traveller form on the way, until it reaches step `stopAt`.
 *  A step paints a moment AFTER the engine's index moves (it waits for its price), so each Continue waits
 *  for the index to move - or for the flow to say why it will not - and then lets the step settle, with
 *  every wait bounded so a stuck page fails the test instead of hanging it. */
const WALK = `(async (stopAt) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const msg = () => { const e = document.getElementById('bkMsg'); return e ? e.textContent.trim() : ''; };
  const fill = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } };
  await sleep(1500);
  for (let i = 0; i < 8 && BookingFlow.stepIndex < stopAt; i++) {
    fill('p0_first', 'Test'); fill('p0_last', 'Traveller'); fill('p0_gender', 'Male'); fill('p0_dob', '1990-01-01');
    fill('p0_mobile', '9876543210'); fill('p0_email', 'test@example.com');
    const was = BookingFlow.stepIndex;
    document.getElementById('bkNext').click();
    for (let k = 0; k < 30 && BookingFlow.stepIndex === was && !msg(); k++) await sleep(150);
    await sleep(1800);
  }
  return BookingFlow.stepIndex;
})`;

const stepTitle = `(() => { const e = document.querySelector('.bk-sheet .bkf-h2, .bk-sheet .bk-step-title'); return e ? e.textContent.trim() : ''; })()`;

test('round trip: every card has both journeys, says it is a sample, and airlines can differ by direction', { timeout: 120000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try {
    await page.viewport({ width: 1280, height: 900 });
    await page.goto(BASE + ROUND());
    await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-trip').length > 0, { timeout: 15000, label: 'round-trip cards' });
    const r = await page.eval(`(() => {
      const cards = [...document.querySelectorAll('#txFlightList .jf-trip')];
      const combos = cards.map(c => [...c.querySelectorAll('.jft-airline')].map(e => e.textContent.trim()).join('>'));
      return {
        n: cards.length,
        allTwoLegs: cards.every(c => c.querySelectorAll('.jft-leg').length === 2),
        allSample: cards.every(c => !!c.querySelector('.jft-sample') && /Sample flight/i.test(c.querySelector('.jft-sample').textContent) && /not bookable/i.test(c.querySelector('.jft-sample').textContent)),
        mixed: combos.some(x => { const [a, b] = x.split('>'); return a !== b; }),
        same: combos.some(x => { const [a, b] = x.split('>'); return a === b; }),
        // the footer: baggage, fare type, cancellation / date change - three cells on every card, and
        // wherever the two directions differ the cell says which line is Onward and which is Return
        footerOk: cards.every(c => c.querySelectorAll('.jft-info .jft-info-cell').length === 3),
        mixedTermsLabelled: cards.filter(c => /Refundable/.test(c.querySelector('.jft-info-cell:nth-child(2)').textContent)
          && /Non.refundable/.test(c.querySelector('.jft-info-cell:nth-child(2)').textContent))
          .every(c => /Onward/.test(c.querySelector('.jft-info-cell:nth-child(2)').textContent) && /Return/.test(c.querySelector('.jft-info-cell:nth-child(2)').textContent)),
        // the Recommended badge sits inside the price panel, never straddling the card's edge
        badgeInside: [...document.querySelectorAll('.jf-trip .jft-badge')].every(b => {
          const c = b.closest('.jf-trip').getBoundingClientRect(), r = b.getBoundingClientRect();
          return !!b.closest('.jft-stub') && r.top >= c.top && r.bottom <= c.bottom && r.left >= c.left && r.right <= c.right;
        }),
        // nothing inside a card is cut off, horizontally or vertically
        clipped: cards.flatMap(c => [...c.querySelectorAll('*')].filter(e => { const o = getComputedStyle(e);
          return (o.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1) || (o.overflowY !== 'visible' && e.scrollHeight > e.clientHeight + 1); })
          .map(e => String(e.className).slice(0, 30))),
        sw: document.documentElement.scrollWidth, iw: innerWidth };
    })()`);
    assert.ok(r.n >= 2, 'several round-trip combinations');
    assert.ok(r.allTwoLegs, 'both journeys on every card');
    assert.ok(r.allSample, 'every sample card says "Sample flight - not bookable"');
    assert.ok(r.mixed, 'a card can pair two different airlines');
    assert.ok(r.same, 'and the same airline both ways');
    assert.ok(r.sw <= r.iw + 1, 'no horizontal scroll');
    assert.ok(r.footerOk, 'baggage / fare type / cancellation footer on every card');
    assert.ok(r.mixedTermsLabelled, 'differing onward / return terms are labelled');
    assert.ok(r.badgeInside, 'the Recommended badge is inside the price panel');
    assert.deepEqual(r.clipped, [], 'text clipped inside a card');
  } finally { page.close(); }
});

test('round trip: the pinned Edit Search bar opens the editor with the search intact, and submitting keeps it', { timeout: 240000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try {
    await page.viewport({ width: 1280, height: 900 });
    const dep = iso(3), ret = iso(5);
    await page.goto(`${BASE}/flights.html?trip=round&from=HYD&to=BLR&depart=${dep}&ret=${ret}&adults=2&children=1&cabin=premium`);
    await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-trip').length > 0, { timeout: 15000, label: 'round-trip cards' });
    await sleep(900);
    // pinned, with the whole search in the bar
    await page.eval(`window.scrollTo({ top: document.querySelector('#txFlightList').getBoundingClientRect().top + scrollY + 40, behavior: 'instant' })`);
    await sleep(500);
    const bar = await page.eval(`(() => { const d = document.getElementById('heroSearchDock'); return { pinned: d.classList.contains('is-stuck'),
      route: d.querySelector('.search-strip-main').textContent, party: d.querySelector('.search-strip-sub').textContent }; })()`);
    assert.ok(bar.pinned, 'the bar is pinned');
    assert.match(bar.route, /Hyderabad ⇄ Bengaluru/);
    assert.match(bar.party, /2 Adults/); assert.match(bar.party, /1 Child/); assert.match(bar.party, /Premium Economy/);
    assert.match(bar.party, /–/, 'both dates are shown');

    // open the editor from the pinned bar: every field holds what was searched
    await page.eval(`document.querySelector('[data-search-strip]').click()`);
    await sleep(1400);
    const f = await page.eval(`(() => { const v = id => { const e = document.getElementById(id); return e ? e.value : null; };
      const pax = document.querySelector('#fPaxField .pax-trigger-text'); const trip = document.querySelector('.trip-type.is-on');
      return { from: v('fFrom'), to: v('fTo'), cabin: v('fCabin'), pax: pax ? pax.textContent.trim() : null, trip: trip ? trip.dataset.trip : null,
        depIso: [...document.querySelectorAll('#heroSearchDock input[type=date]')].map(e => e.value) }; })()`);
    assert.equal(f.trip, 'round');
    assert.match(f.from, /Hyderabad/); assert.match(f.to, /Bengaluru/);
    assert.match(f.cabin, /Premium/i);
    assert.match(f.pax, /2 Adults/); assert.match(f.pax, /1 Child/);
    assert.ok(f.depIso.includes(dep) && f.depIso.includes(ret), `departure and return dates in the editor: ${f.depIso}`);

    // submit unchanged: the same search comes back, still paired
    await page.eval(`document.querySelector('#heroSearchDock .search-go').click()`);
    await page.waitFor(() => location.search.includes('trip=round') && document.querySelectorAll('#txFlightList .jf-trip').length > 0, { timeout: 15000, label: 'results after submit' });
    await sleep(900);
    const q = await page.eval(`Object.fromEntries(new URLSearchParams(location.search))`);
    assert.equal(q.trip, 'round'); assert.equal(q.from, 'HYD'); assert.equal(q.to, 'BLR');
    assert.equal(q.depart, dep); assert.equal(q.ret, ret);
    assert.equal(q.adults, '2'); assert.equal(q.children, '1'); assert.equal(q.cabin, 'premium');
    const after = await page.eval(`({ trips: document.querySelectorAll('#txFlightList .jf-trip').length,
      collapsed: document.querySelector('#heroSearchDock .search-card').classList.contains('is-collapsed'),
      summary: document.querySelector('.search-strip-main').textContent + ' | ' + document.querySelector('.search-strip-sub').textContent })`);
    assert.ok(after.trips > 0, 'round-trip cards after submit');
    assert.ok(after.collapsed, 'the card folds back');
    assert.match(after.summary, /⇄/); assert.match(after.summary, /2 Adults/); assert.match(after.summary, /Premium Economy/);
  } finally { page.close(); }
});

test('round trip: the layout holds at every width (no overflow, no clipped text, price panel and footer present)', { timeout: 240000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of [[1536, 900], [1440, 900], [1280, 800], [1024, 768], [768, 1024], [414, 896], [375, 812], [360, 740]]) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width: w, height: h, mobile: w < 600 });
      await page.goto(BASE + ROUND());
      await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-trip').length > 0, { timeout: 15000, label: 'round-trip cards' });
      await sleep(900);
      const r = await page.eval(`(() => {
        const cards = [...document.querySelectorAll('#txFlightList .jf-trip')];
        const bad = [];
        cards.forEach(c => {
          const cr = c.getBoundingClientRect();
          if (cr.left < -1 || cr.right > innerWidth + 1) bad.push('card outside the viewport');
          c.querySelectorAll('*').forEach(e => { const o = getComputedStyle(e);
            if ((o.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1) || (o.overflowY !== 'visible' && e.scrollHeight > e.clientHeight + 1)) bad.push('clipped: ' + String(e.className).slice(0, 30));
            if (e.getBoundingClientRect().right > cr.right + 1 && e.getBoundingClientRect().width > 0) bad.push('spills out of the card: ' + String(e.className).slice(0, 30)); });
          const btn = c.querySelector('.jft-select').getBoundingClientRect();
          if (btn.width < 90 || btn.right > cr.right + 1) bad.push('Select button cut');
          if (!c.querySelector('.jft-amt') || !c.querySelector('.jft-info')) bad.push('price or footer missing');
        });
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, bad: [...new Set(bad)] };
      })()`);
      if (r.sw > r.iw + 1) problems.push(`horizontal scroll @${w}`);
      r.bad.forEach(b => problems.push(`${b} @${w}`));
      // the pinned Edit Search bar: pinned, over the results, route / dates / party / cabin whole, Edit visible
      await page.eval(`window.scrollTo({ top: document.querySelector('#txFlightList').getBoundingClientRect().top + scrollY + 40, behavior: 'instant' })`);
      await sleep(500);
      const bar = await page.eval(`(() => {
        const d = document.getElementById('heroSearchDock'), c = d.querySelector('.search-card');
        const main = c.querySelector('.search-strip-main'), sub = c.querySelector('.search-strip-sub'), edit = c.querySelector('.search-strip-edit');
        const cr = c.getBoundingClientRect(), er = edit.getBoundingClientRect();
        return { pinned: d.classList.contains('is-stuck'), top: Math.round(cr.top),
          mainCut: main.scrollWidth > main.clientWidth + 1, subCut: sub.scrollWidth > sub.clientWidth + 1,
          editInside: er.left >= cr.left && er.right <= cr.right + 1, editText: edit.innerText.trim(),
          route: main.textContent, party: sub.textContent,
          headerGone: document.getElementById('siteHeader').getBoundingClientRect().bottom <= 0 };
      })()`);
      if (!bar.pinned) problems.push(`Edit Search bar not pinned @${w}`);
      if (!bar.headerGone) problems.push(`site header still on screen @${w}`);
      if (bar.mainCut) problems.push(`pinned route cut off ("${bar.route}") @${w}`);
      if (bar.subCut) problems.push(`pinned dates/party cut off ("${bar.party}") @${w}`);
      if (!bar.editInside) problems.push(`Edit button outside the bar @${w}`);
      if (!/⇄/.test(bar.route)) problems.push(`round trip not shown in the route @${w}`);
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'layout problems');
});

test('round trip: no route reaches Payment, Confirmation, a booking request or a stored booking', { timeout: 240000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  const requests = [];
  page.on('Network.requestWillBeSent', (e) => requests.push(`${e.request.method} ${e.request.url}`));
  try {
    await page.send('Network.enable');
    await page.viewport({ width: 1280, height: 900 });
    await page.goto(BASE + ROUND());
    await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-trip [data-tx-book-trip]').length > 0, { timeout: 15000, label: 'round-trip cards' });
    await page.eval(`localStorage.removeItem('jpc_bookings')`);
    const storeBefore = await page.eval(`JSON.stringify(Object.keys(localStorage).sort())`);

    await page.eval(`document.querySelector('#txFlightList .jf-trip [data-tx-book-trip]').click()`);
    await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight'), { label: 'the booking flow' });
    const itin = await page.eval(`document.querySelector('.bkf-itin-title').textContent`);
    assert.match(itin, /Round Trip/);

    // Walk to Review (step index 4: fare, travellers, seats, add-ons, review).
    const at = await page.eval(`${WALK}(4)`, true).catch(() => null);
    const reviewIndex = at == null ? await page.eval('BookingFlow.stepIndex') : at;
    assert.equal(reviewIndex, 4, 'reached Review');
    assert.match(await page.eval(stepTitle), /Review your booking/);

    const stillOnReview = async (how) => {
      await sleep(700);
      assert.equal(await page.eval('BookingFlow.stepIndex'), 4, `${how}: the flow moved off Review`);
      assert.match(await page.eval(stepTitle), /Review your booking/, `${how}: a different step is on screen`);
      assert.equal(await page.eval(`!!document.querySelector('#bkNext') && /Pay now/i.test(document.getElementById('bkNext').textContent)`), false, `${how}: a Pay button is showing`);
    };

    // 1. the Continue button
    await page.eval(`document.getElementById('bkNext').click()`);
    await stillOnReview('Continue to Payment');
    assert.match(await page.eval(`document.getElementById('bkMsg').textContent`), /not available|not bookable/i, 'the reason is shown');

    // 2. a forward jump, which skips Continue's checks
    await page.eval(`BookingFlow.goTo('payment')`);
    await stillOnReview("BookingFlow.goTo('payment')");
    await page.eval(`BookingFlow.goTo('done')`);
    await stillOnReview("BookingFlow.goTo('done')");

    // 3. browser Back, then Forward
    await page.eval(`history.back()`); await sleep(900);
    await page.eval(`history.forward()`); await sleep(900);
    assert.ok(await page.eval('BookingFlow.stepIndex') <= 4, 'Back then Forward went past Review');
    assert.doesNotMatch(await page.eval(`(document.getElementById('bkNext') || {}).textContent || ''`), /Pay now/i);

    // 4. the Payment step's own action, and the draft builder behind it
    const viaStep = await page.eval(`(async () => {
      try { await BookingProducts.paymentStep().onNext(BookingFlow.context); return 'ran'; }
      catch (e) { return 'refused: ' + e.message; }
    })()`, true);
    assert.match(String(viaStep), /^refused: .*(not available|not bookable)/i, 'the Payment step ran for a round-trip draft');

    // 5. the store, called directly with a round-trip draft
    const viaStore = await page.eval(`(async () => {
      try { await BookingStore.create({ kind: 'flight', title: 'x', total: 1, roundTrip: true, apiPayload: { flight: {} } }); return 'created'; }
      catch (e) { return 'refused: ' + e.message; }
    })()`, true);
    assert.match(String(viaStore), /^refused: .*Round-trip checkout is not available/, 'BookingStore.create stored a round-trip draft');

    // Nothing left the page for a booking, and nothing was kept.
    // A quote (POST .../bookings/quote) only prices; creating a booking is POST .../bookings itself,
    // and paying is .../bookings/<ref>/pay or /checkout.
    const bookingCalls = requests.filter(r => /^POST \S*\/api\/customer\/bookings\/?$/i.test(r)
      || /^(POST|PUT|PATCH) \S*\/api\/customer\/bookings\/[^/]+\/(pay|checkout)/i.test(r)
      || /\/api\/customer\/(checkout|payments?)/i.test(r));
    assert.deepEqual(bookingCalls, [], 'a booking/payment request was sent');
    assert.equal(await page.eval(`JSON.stringify(Object.keys(localStorage).sort())`), storeBefore, 'something was written to local storage');
  } finally { page.close(); }
});

test('one-way is unchanged: the same flow still goes from Review into Payment', { timeout: 240000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try {
    await page.viewport({ width: 1280, height: 900 });
    await page.goto(BASE + ONEWAY());
    await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 15000, label: 'flight cards' });
    await page.eval(`document.querySelector('#txFlightList .jf-select').click()`);
    await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight'), { label: 'the booking flow' });
    assert.match(await page.eval(`document.querySelector('.bkf-itin-title').textContent`), /One Way/);
    const reached = await page.eval(`${WALK}(5)`, true);
    assert.equal(reached, 5, 'a one-way draft was held back from Payment');
    const id = await page.eval(`(() => { const c = BookingFlow.context; return c && c.returnItem ? 'has returnItem' : 'no returnItem'; })()`);
    assert.equal(id, 'no returnItem');
  } finally { page.close(); }
});
