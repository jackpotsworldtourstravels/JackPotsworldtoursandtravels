// The Flights filter panel, in a real browser: it filters, counts, clears and lays out at every width.
//
// WHAT THIS PINS, on the live flights page (sample schedule, so no flight API is needed):
//   * a ticked airline changes the cards shown, its count is the number it leaves, Clear all restores the list,
//     and the choice lands in the URL (f_airlines) beside the untouched search parameters
//   * the chosen sort survives filtering and clearing
//   * round trips: Onward and Return airline filters act on their own leg, and every card left is still ONE onward
//     plus ONE return flight, still labelled "Sample flight - not bookable", still with its checkout guard
//   * the sticky Edit Search bar and the sort menu keep working with the panel open
//   * desktop/tablet/phone: no horizontal overflow at 1536 / 1024 / 820 / 414 / 390 / 360, and on a phone the Filters
//     button opens a sheet with Clear all and Apply that stay on screen, whose Apply text tracks the live count
//   * the panel offers nothing the sample data cannot answer: no baggage, refundability or aircraft control
//
// Needs Chrome/Edge and a server answering at JPW_BASE (default http://127.0.0.1:8000). Skips with a reason otherwise.
//
//     JPW_BASE=http://127.0.0.1:8000 node --test tests/js/browser/flight-filters.ui.test.mjs
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
  test(name, { timeout: 120000 }, async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const page = await chrome.newPage();
    try { await fn(page, t); } finally { page.close(); }
  });
}

const iso = (plusDays) => {
  const d = new Date(Date.now() + plusDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ONEWAY = () => `/flights.html?trip=oneway&from=HYD&to=BLR&depart=${iso(2)}&adults=1&cabin=economy`;
const ROUND = () => `/flights.html?trip=round&from=HYD&to=BLR&depart=${iso(2)}&ret=${iso(4)}&adults=1&cabin=economy`;
const DESKTOP = { width: 1366, height: 900, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };

async function open(page, vp, path) {
  await page.viewport(vp);
  await page.goto(BASE + path);
  await page.waitFor(() => document.querySelectorAll('#txFlightList .tx-flight, #txFlightList .jf-trip').length > 0,
    { label: 'the flight list', timeout: 20000 });
  await sleep(900);
}

const CARDS = '#txFlightList .tx-flight, #txFlightList .jf-trip';
const count = (page) => page.eval(`document.querySelectorAll('${CARDS}').length`);
const optionCount = (page, def, value) => page.eval(`(() => {
  const i = document.querySelector('[data-ff-opt="${def}"][value="${value}"]');
  const c = i && i.closest('label').querySelector('.ff-count'); return c ? Number(c.textContent) : null; })()`);
const options = (page, def) => page.eval(`[...document.querySelectorAll('[data-ff-opt="${def}"]')].map(i => i.value)`);
async function tick(page, def, value) {
  await page.eval(`document.querySelector('[data-ff-opt="${def}"][value="${value}"]').click()`);
  await sleep(700);
}

ui('one way: ticking an airline filters the cards, the count is right, the URL records it, Clear all restores', async (page) => {
  await open(page, DESKTOP, ONEWAY());
  const all = await count(page);
  assert.ok(all >= 2, 'the sample board has flights for this route');
  const airlines = await options(page, 'airlines');
  assert.ok(airlines.length >= 2, 'more than one airline to choose between');

  const first = airlines[0];
  const expected = await optionCount(page, 'airlines', first);
  const second = await optionCount(page, 'airlines', airlines[1]);
  await tick(page, 'airlines', first);
  assert.equal(await count(page), expected, 'the cards left are exactly the number beside the option');
  assert.ok(expected < all);
  const names = await page.eval(`[...document.querySelectorAll('${CARDS}')].map(c => c.innerText).join('|')`);
  assert.ok(names.includes(first), 'the remaining cards are that airline');
  assert.match(await page.eval('location.search'), /f_airlines=/);
  assert.match(await page.eval('location.search'), /from=HYD/, 'search parameters are kept');

  // two airlines is OR
  await tick(page, 'airlines', airlines[1]);
  assert.equal(await count(page), expected + second, 'two airlines show both airlines (OR within a group)');

  await page.eval(`document.querySelector('[data-ff-clear-all]').click()`);
  await sleep(700);
  assert.equal(await count(page), all, 'Clear all restores the whole list');
  assert.doesNotMatch(await page.eval('location.search'), /f_airlines=/);
});

ui('one way: the price slider narrows the list and the sort is kept through filtering and clearing', async (page) => {
  await open(page, DESKTOP, ONEWAY());
  const all = await count(page);
  await page.eval(`(() => { const s = document.getElementById('txSort'); s.value = 'cheapest'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(600);
  const prices = () => page.eval(`[...document.querySelectorAll('#txFlightList .jf-amt')].map(e => Number(e.textContent.replace(/[^0-9]/g, '')))`);
  const before = await prices();
  assert.deepEqual(before, [...before].sort((a, b) => a - b), 'cheapest first');

  // the far end of the slider is the REAL dearest fare even when it is not a multiple of the step: dragging
  // to the end must not hide the dearest flight, and a full-span range is "untouched" (no URL parameter)
  const drag = (which, v) => page.eval(`(() => { const e = document.querySelector('[data-ff-range="price"] .ff-range-${which}'); e.value = ${v}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await drag('hi', 99999999);
  await sleep(900);
  assert.equal(await count(page), all, 'the end of the slider keeps the dearest flight');
  assert.doesNotMatch(await page.eval('location.search'), /f_price=/);
  assert.ok(Math.max(...await prices()) > 0);

  // pull the maximum price down below the dearest flight
  const bounds = await page.eval(`(() => { const hi = document.querySelector('[data-ff-range="price"] .ff-range-hi'); return { min: Number(hi.min), max: Number(hi.max) }; })()`);
  assert.ok(bounds.max > bounds.min);
  await page.eval(`(() => { const hi = document.querySelector('[data-ff-range="price"] .ff-range-hi'); hi.value = ${bounds.min}; hi.dispatchEvent(new Event('input', { bubbles: true })); hi.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(900);
  assert.ok(await count(page) < all, 'the slider removed the dearer flights');
  assert.equal(await page.eval(`document.getElementById('txSort').value`), 'cheapest', 'sort preserved');
  assert.match(await page.eval(`document.querySelector('.ff-range-out').textContent`), /₹/, 'prices are shown in rupees');

  await page.eval(`document.querySelector('[data-ff-clear-all]').click()`);
  await sleep(700);
  assert.equal(await count(page), all);
  assert.equal(await page.eval(`document.getElementById('txSort').value`), 'cheapest', 'Clear all does not reset the sort');
});

ui('the panel offers nothing the sample data cannot answer', async (page) => {
  await open(page, DESKTOP, ONEWAY());
  const text = await page.eval(`document.getElementById('txFilters').innerText`);
  assert.doesNotMatch(text, /baggage|check-in|refundab|aircraft|layover/i);
  const groups = await page.eval(`[...document.querySelectorAll('#txFilters [data-ff-group]')].map(g => g.dataset.ffGroup)`);
  assert.ok(groups.includes('airlines') && groups.includes('price'));
  // every section has a heading button that collapses it
  await page.eval(`document.querySelector('[data-ff-toggle="airlines"]').click()`);
  assert.equal(await page.eval(`document.getElementById('ff-body-airlines').hidden`), true);
  await page.eval(`document.querySelector('[data-ff-toggle="airlines"]').click()`);
  assert.equal(await page.eval(`document.getElementById('ff-body-airlines').hidden`), false);
});

ui('round trip: onward and return airline filters act on their own leg, pairing and sample labels survive', async (page) => {
  await open(page, DESKTOP, ROUND());
  const all = await count(page);
  const onward = await options(page, 'airlinesOut');
  const ret = await options(page, 'airlinesRet');
  assert.ok(onward.length >= 2 && ret.length >= 2, 'a choice in each direction');
  assert.equal((await options(page, 'airlines')).length, 0, 'the one-way airline filter steps aside');

  await tick(page, 'airlinesOut', onward[0]);
  const afterOut = await count(page);
  assert.ok(afterOut > 0 && afterOut < all);
  await tick(page, 'airlinesRet', ret[1]);
  const afterBoth = await count(page);
  assert.ok(afterBoth > 0 && afterBoth <= afterOut, 'onward AND return');

  const cards = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('.jf-trip')].map(c => {
    const legs = [...c.querySelectorAll('.jft-leg')];
    return { legs: legs.length, text: c.innerText, sample: c.classList.contains('is-sample'), note: !!c.querySelector('.jft-sample') };
  }))`));
  for (const c of cards) {
    assert.equal(c.legs, 2, 'every result is one onward + one return flight');
    assert.ok(c.sample && c.note, 'still labelled as a sample flight');
    assert.match(c.text, /not bookable/i);
  }
  assert.ok(cards.every(c => c.text.includes(onward[0])), 'every card has the chosen onward airline');
  assert.ok(cards.every(c => c.text.includes(ret[1])), 'every card has the chosen return airline');

  // the selection button on a filtered sample trip still cannot lead to payment
  const guarded = await page.eval(`(async () => {
    const b = document.querySelector('.jf-trip .jft-select'); if (!b) return 'no-button';
    b.click(); await new Promise(r => setTimeout(r, 1200));
    return typeof BookingFlow !== 'undefined' && BookingFlow.stepIndex != null && BookingFlow.stepIndex >= 3 ? 'reached-payment' : 'held';
  })()`);
  assert.notEqual(guarded, 'reached-payment', 'filtering a sample trip never makes it bookable');

  await page.eval(`document.querySelector('[data-ff-clear-all]') && document.querySelector('[data-ff-clear-all]').click()`);
});

ui('the sticky Edit Search bar still works with the filter panel in play', async (page) => {
  await open(page, DESKTOP, ONEWAY());
  await tick(page, 'airlines', (await options(page, 'airlines'))[0]);
  await page.eval(`window.scrollTo({ top: document.getElementById('txFlightList').getBoundingClientRect().top + scrollY + 200, behavior: 'instant' })`);
  await sleep(900);
  const bar = JSON.parse(await page.eval(`(() => { const e = document.querySelector('.search-strip'); if (!e) return 'null'; const r = e.getBoundingClientRect();
    return JSON.stringify({ top: Math.round(r.top), h: Math.round(r.height) }); })()`));
  assert.ok(bar && bar.h > 0 && bar.top >= 0 && bar.top < 200, 'the Edit Search bar is still stuck near the top: ' + JSON.stringify(bar));
  assert.ok(await page.eval(`!!document.querySelector('.search-strip-edit')`));
});

for (const [w, h] of [[1536, 900], [1024, 800], [820, 1180], [414, 896], [390, 844], [360, 740]]) {
  for (const [kind, path] of [['one way', ONEWAY], ['round trip', ROUND]]) {
    ui(`${kind} at ${w}px: no horizontal overflow, panel or Filters button reachable`, async (page) => {
      await open(page, { width: w, height: h, mobile: w < 600 }, path());
      const m = JSON.parse(await page.eval(`(() => { const p = document.getElementById('txFilters'); const t = document.getElementById('txFilterToggle');
        const doc = document.documentElement; const bad = [...document.querySelectorAll('#txFilters *, ${CARDS}')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1) && !e.closest('.tx-filters:not(.tx-open)'); }).length;
        return JSON.stringify({ over: doc.scrollWidth - doc.clientWidth, sidebar: getComputedStyle(p).visibility === 'visible', toggle: getComputedStyle(t).display !== 'none', bad }); })()`));
      assert.ok(m.over <= 1, `horizontal overflow of ${m.over}px`);
      assert.equal(m.bad, 0, 'nothing in the panel or the cards runs off the right edge');
      assert.ok(m.sidebar || m.toggle, 'either the sidebar or the Filters button is available');
      if (w > 1000) assert.ok(m.sidebar && !m.toggle, 'wide: the sidebar, not the button');
      else assert.ok(m.toggle, 'narrow: the Filters button');
    });
  }
}

ui('phone: the Filters sheet has Clear all and Apply that stay on screen and track the live count', async (page) => {
  await open(page, PHONE, ONEWAY());
  const all = await count(page);
  await page.eval(`window.scrollTo(0, document.getElementById('txFlightList').getBoundingClientRect().top + scrollY - 200)`);
  await sleep(1200);
  await page.eval(`document.getElementById('txFilterToggle').click()`);
  await sleep(700);
  const sheet = () => page.eval(`(() => { const d = document.getElementById('txSheetDone'); const r = d.getBoundingClientRect();
    const c = d.querySelector('[data-tx-sheet-clear]'), a = d.querySelector('[data-tx-sheet-done]');
    return { clear: !!c, clearOff: c && c.disabled, apply: a.textContent, inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
      panelOpen: document.getElementById('txFilters').classList.contains('tx-open'), noScroll: document.body.classList.contains('tx-sheet-open'),
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
  let s = await sheet();
  assert.ok(s.panelOpen && s.noScroll, 'the sheet is open and the page behind is locked');
  assert.ok(s.clear && s.clearOff, 'Clear all is there and disabled while nothing is selected');
  assert.ok(s.inView && s.over <= 1, 'the footer sits inside the viewport');
  assert.match(s.apply, new RegExp(`Apply.*${all} flight`));

  const airlines = await options(page, 'airlines');
  await tick(page, 'airlines', airlines[0]);
  s = await sheet();
  assert.equal(s.clearOff, false, 'Clear all enables once something is selected');
  const left = await count(page);
  assert.match(s.apply, new RegExp(`Apply.*${left} flight`), 'Apply states the live result count');

  await page.eval(`document.querySelector('[data-tx-sheet-clear]').click()`);
  await sleep(800);
  s = await sheet();
  assert.ok(s.panelOpen, 'the sheet stays open after Clear all');
  assert.equal(await count(page), all);
  assert.equal(s.clearOff, true);

  await page.eval(`document.querySelector('[data-tx-sheet-done]').click()`);
  await sleep(500);
  assert.equal((await sheet()).panelOpen, false, 'Apply closes the sheet');
});
