// Fare Summary (flights) and Booking Summary (hotels): pale gold, always open, no dropdown arrow.
//
// The card background is the Offers banner's wash (gold .16 -> .04) over the page paper, the text is dark navy,
// and the fare / room price, taxes, add-ons and total are on show without a click. Nothing in the card folds.
// Other dropdowns (the flight filters, the traveller review cards) must still work.
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
const VIEWPORTS = [[1920, 1080], [1440, 900], [1366, 768], [1024, 768], [820, 1180], [430, 932], [375, 812]];

/** What the card paints: its background image, a lightness reading, and the contrast of its own text on it. */
const inspect = (sel) => `(() => {
  const c = document.querySelector(${JSON.stringify(sel)}); if (!c) return null;
  const cs = getComputedStyle(c), r = c.getBoundingClientRect();
  const lum = (rgb) => { const m = rgb.match(/[\\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); };
  const texts = [...c.querySelectorAll('h2, h3, span, p, b, div')].filter(e => e.children.length === 0 && e.textContent.trim() && e.getBoundingClientRect().width > 0);
  const worst = Math.min(...texts.map(e => { const l = lum(getComputedStyle(e).color); return (1.05) / (l + .05); }).map(x => x)); // text vs a ~white ground
  return { bg: cs.backgroundImage, base: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height),
    chev: c.querySelectorAll('.bkf-chev, [data-bkf-fold], details, summary, [aria-expanded]').length,
    svgArrows: [...c.querySelectorAll('svg')].filter(s => /chev|arrow|caret/i.test(s.outerHTML.slice(0, 200)) || s.closest('.bkf-fare-seg, .bkf-fare-group')).length,
    textColors: [...new Set(texts.map(e => getComputedStyle(e).color))], worst: Math.round(worst * 100) / 100,
    hidden: [...c.querySelectorAll('.bkf-fare-body, .bk-price-total, .hr-sum-body')].some(e => getComputedStyle(e).display === 'none' || e.getBoundingClientRect().height === 0),
    text: c.textContent.replace(/\\s+/g, ' ').trim() };
})()`;

const GOLD = 'linear-gradient(90deg, rgba(217, 178, 111, 0.16), rgba(217, 178, 111, 0.04))';

test('flights: the Fare Summary is pale gold, open, and has no arrow', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width: w, height: h, mobile: w < 600 });
      await page.goto(BASE + '/flights.html');
      await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 12000, label: 'results' });
      await sleep(600);
      await page.eval(`document.querySelector('.jf-select').click()`);
      await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight .bk-price'), { label: 'the Fare Summary' });
      await sleep(1000);
      const at = ` @${w}x${h}`;
      const r = await page.eval(inspect('.bk-sheet.is-flight .bk-price'));
      if (!r.bg.includes(GOLD)) problems.push('not the Offers-banner gold wash: ' + r.bg.slice(0, 120) + at);
      if (r.chev || r.svgArrows) problems.push(`arrow/fold controls left in the card (${r.chev} controls, ${r.svgArrows} arrows)` + at);
      if (r.hidden) problems.push('part of the fare is hidden' + at);
      if (!/Fare Summary/.test(r.text) || !/Total Amount/.test(r.text) || !/₹/.test(r.text)) problems.push('fare, total or title missing: ' + r.text.slice(0, 80) + at);
      if (r.textColors.some(c => /255, 255, 255/.test(c) && !/0\.\d/.test(c))) problems.push('white text left on the gold card: ' + r.textColors + at);
      // a click on the title row must change nothing
      const before = r.h;
      await page.eval(`document.querySelector('.bk-sheet.is-flight .bkf-fare-head').click()`);
      await sleep(250);
      const after2 = await page.eval(inspect('.bk-sheet.is-flight .bk-price'));
      if (after2.h !== before || after2.hidden) problems.push('clicking the header changed the card' + at);
      if (await page.eval('document.documentElement.scrollWidth > innerWidth + 1')) problems.push('horizontal scroll' + at);
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'fare summary problems');
});

test('flights: the total carries across steps and no fold control appears on the traveller step', { timeout: 180000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try {
    await page.viewport({ width: 1440, height: 900 });
    await page.goto(BASE + '/flights.html');
    await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 12000, label: 'results' });
    await sleep(600);
    await page.eval(`document.querySelector('.jf-select').click()`);
    await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight .bk-price-total'), { label: 'the total' });
    await sleep(900);
    const total = () => page.eval(`document.querySelector('.bk-sheet.is-flight .bk-price-total').textContent.replace(/\\s+/g, ' ').trim()`);
    const first = await total();
    const clicked = await page.eval(`(() => { const b = [...document.querySelectorAll('.bk-sheet.is-flight button')].find(e => /^continue to traveller/i.test(e.textContent.trim()) && !e.disabled); if (!b) return false; b.click(); return true; })()`);
    assert.ok(clicked, 'could reach the traveller step');
    await sleep(1200);
    assert.equal(await total(), first, 'the total carries across steps');
    assert.equal(await page.eval(`document.querySelectorAll('.bk-sheet.is-flight .bk-price [data-bkf-fold]').length`), 0, 'no fold control on the traveller step');
  } finally { page.close(); }
});

test('hotels: the Booking Summary is pale gold, open, and has no arrow', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width: w, height: h, mobile: w < 600 });
      await page.goto(BASE + '/hotels.html');
      await page.waitFor(() => document.querySelectorAll('#hrCards .hr-card').length > 0, { timeout: 12000, label: 'results' });
      await sleep(600);
      await page.eval(`[...document.querySelector('#hrCards .hr-card').querySelectorAll('button')].find(b => /^select$/i.test(b.textContent.trim())).click()`);
      await page.waitFor(() => { const c = document.getElementById('hrContinue'); return c && !c.disabled; }, { label: 'Continue' });
      await page.eval(`document.getElementById('hrContinue').click()`);
      await page.waitFor(() => !!document.querySelector('#hdSummary .hr-summary'), { label: 'the Booking Summary' });
      await sleep(900);
      const at = ` @${w}x${h}`;
      const r = await page.eval(inspect('#hdSummary .hr-summary'));
      if (!r.bg.includes(GOLD)) problems.push('not the Offers-banner gold wash: ' + r.bg.slice(0, 120) + at);
      if (r.chev) problems.push('fold controls in the card' + at);
      if (r.hidden) problems.push('part of the summary is hidden' + at);
      if (!/Booking Summary/.test(r.text) || !/₹/.test(r.text)) problems.push('title or price missing' + at);
      if (r.textColors.some(c => /255, 255, 255/.test(c) && !/0\.\d/.test(c))) problems.push('white text left: ' + r.textColors + at);
      if (await page.eval('document.documentElement.scrollWidth > innerWidth + 1')) problems.push('horizontal scroll' + at);
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'booking summary problems');
});
