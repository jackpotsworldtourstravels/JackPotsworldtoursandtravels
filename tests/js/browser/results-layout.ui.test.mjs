// Flight and hotel results pages: no Booking Summary rail, and the result cards run to the right edge of the
// date strip / search summary above them.
//
// The grid is the filters and the results (two tracks from 901px wide up, one below). The cards' right edge must
// equal the right edge of the strip above (flights: the date-and-day timeline; hotels: the stay summary bar).
// The later booking steps keep their own Booking Summary, and selecting a flight / hotel still works.
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
const WIDTHS = [[1920, 1080], [1440, 900], [1366, 768], [1280, 720], [1100, 800], [1024, 768], [820, 1180], [430, 932], [375, 812]];

async function open(page, path, w, h, ready) {
  await page.viewport({ width: w, height: h, mobile: w < 600 });
  await page.goto(BASE + path);
  await page.waitFor(ready, { timeout: 12000, label: 'the results' });
  await sleep(800);
}

test('flights: no summary rail; every flight card ends where the date strip ends', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of WIDTHS) {
    const page = await chrome.newPage();
    try {
      await open(page, '/flights.html', w, h, () => document.querySelectorAll('#txFlightList .tx-flight').length > 0);
      const r = await page.eval(`(() => {
        const R = (e) => e.getBoundingClientRect();
        const strip = R(document.getElementById('fxDates')), res = R(document.querySelector('.tx-results-col'));
        const cards = [...document.querySelectorAll('#txFlightList .tx-flight')].map(R);
        const grid = getComputedStyle(document.querySelector('.tx-layout-3')).gridTemplateColumns.split(' ').length;
        const rail = R(document.querySelector('.tx-rail-col'));
        const c0 = document.querySelector('#txFlightList .tx-flight');
        return { summary: !!document.getElementById('txSummary') || !!document.querySelector('.tx-summary-rail'),
          stripRight: Math.round(strip.right), resLeft: Math.round(res.left),
          cardRights: [...new Set(cards.map(c => Math.round(c.right)))], cardLefts: [...new Set(cards.map(c => Math.round(c.left)))],
          grid, railRight: Math.round(rail.right), w: Math.round(cards[0].width),
          hasSelect: !!c0.querySelector('.jf-select'), hasPrice: /₹/.test(c0.textContent),
          hScroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
      const at = ` @${w}`;
      if (r.summary) problems.push('the Booking Summary rail is still on the page' + at);
      if (r.cardRights.length !== 1 || Math.abs(r.cardRights[0] - r.stripRight) > 1) problems.push(`card right ${r.cardRights} != date strip right ${r.stripRight}` + at);
      if (r.cardLefts.length !== 1 || Math.abs(r.cardLefts[0] - r.resLeft) > 1) problems.push('card left is not the results column left' + at);
      if (r.grid !== (w >= 901 ? 2 : 1)) problems.push(`the grid has ${r.grid} tracks` + at);
      if (w >= 901 && r.railRight > r.resLeft) problems.push('filters overlap the results' + at);
      if (w >= 1270 && r.w < 900) problems.push(`cards are only ${r.w}px wide` + at);
      if (!r.hasSelect || !r.hasPrice) problems.push('a card lost its fare or Select button' + at);
      if (r.hScroll) problems.push('horizontal scroll' + at);
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'flight results layout problems');
});

test('hotels: no summary rail; every hotel card ends where the stay summary ends', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of WIDTHS) {
    const page = await chrome.newPage();
    try {
      await open(page, '/hotels.html', w, h, () => document.querySelectorAll('#hrCards .hr-card').length > 0);
      const r = await page.eval(`(() => {
        const R = (e) => e.getBoundingClientRect(), bar = R(document.getElementById('hrSearchbar'));
        const cards = [...document.querySelectorAll('#hrCards .hr-card')].map(R);
        const grid = getComputedStyle(document.querySelector('.hr-layout')).gridTemplateColumns.split(' ').length;
        const c0 = document.querySelector('#hrCards .hr-card'); const flt = document.getElementById('hrFilters');
        return { summary: !!document.getElementById('hrSummary'),
          laterSummaries: ['hdSummary', 'hrmSummary', 'hgSummary', 'hvSummary', 'hpSummary', 'hcSummary'].filter(id => document.getElementById(id)).length,
          barRight: Math.round(bar.right), cardRights: [...new Set(cards.map(c => Math.round(c.right)))], grid,
          filtersBeforeCards: innerWidth < 901 || R(flt).right <= cards[0].left + 1,
          hasPrice: /₹/.test(c0.textContent), hasSelect: !!c0.querySelector('.hc-select'), hasRooms: !!c0.querySelector('.hc-cta'),
          hasName: !!c0.querySelector('h2, h3, [class*="name"], [class*="title"]'),
          hScroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
      const at = ` @${w}`;
      if (r.summary) problems.push('the Booking Summary rail is still on the results screen' + at);
      if (r.laterSummaries !== 6) problems.push('a LATER step lost its summary container' + at + ` (${r.laterSummaries}/6)`);
      if (r.cardRights.length !== 1 || Math.abs(r.cardRights[0] - r.barRight) > 1) problems.push(`card right ${r.cardRights} != stay summary right ${r.barRight}` + at);
      if (r.grid !== (w >= 901 ? 2 : 1)) problems.push(`the grid has ${r.grid} tracks` + at);
      if (!r.filtersBeforeCards) problems.push('filters overlap the results' + at);
      if (!r.hasPrice || !r.hasSelect || !r.hasRooms || !r.hasName) problems.push('a hotel card lost its price, name or actions' + at);
      if (r.hScroll) problems.push('horizontal scroll' + at);
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'hotel results layout problems');
});

test('selecting still works: a flight opens the booking sheet; a hotel continues to its details with a summary', { timeout: 180000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const f = await chrome.newPage();
  try {
    const errors = []; f.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails.text)));
    await open(f, '/flights.html', 1440, 900, () => document.querySelectorAll('#txFlightList .jf-select').length > 0);
    await f.eval(`document.querySelector('.jf-select').click()`);
    await f.waitFor(() => document.querySelectorAll('[role=dialog]:not([hidden])').length > 0, { label: 'the booking sheet' });
    assert.deepEqual(errors, [], 'no script errors choosing a flight');
  } finally { f.close(); }
  const hp = await chrome.newPage();
  try {
    const errors = []; hp.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails.text)));
    await open(hp, '/hotels.html', 1440, 900, () => document.querySelectorAll('#hrCards .hr-card').length > 0);
    await hp.eval(`[...document.querySelector('#hrCards .hr-card').querySelectorAll('button')].find(b => /^select$/i.test(b.textContent.trim())).click()`);
    await hp.waitFor(() => { const c = document.getElementById('hrContinue'); return c && !c.disabled; }, { label: 'Continue enabled' });
    await hp.eval(`document.getElementById('hrContinue').click()`);
    await hp.waitFor(() => /[?&]hotel=/.test(location.search), { label: 'the hotel details step' });
    await hp.waitFor(() => !!document.querySelector('#hdSummary .hr-summary'), { label: 'the details step summary' });
    assert.deepEqual(errors, [], 'no script errors choosing a hotel');
  } finally { hp.close(); }
});
