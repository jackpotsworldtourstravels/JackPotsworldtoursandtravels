// One outer measure for the whole flight and hotel booking flows — the flight results page's.
//
// The results page (1360px measure, 32px gutters, 20px on a tablet or phone) is the owner's reference. The flight
// booking sheet (fare, travellers, seats, add-ons, review, payment) and every hotel step read the same
// --bk-measure / --bk-gutter (jw-system.css), so the page no longer jumps narrower or wider from phase to phase.
//
// For each viewport, in a real browser, this walks the phases that can be reached without typing a traveller's
// details — flights: results -> fare -> traveller details; hotels: results -> details -> room selection — and checks
//   * the CONTENT width of every phase is the same as the results page's, in both flows,
//   * the left/right content boundaries agree within a scrollbar's width (the booking sheet overlays the page),
//   * the sticky bottom bar spans the same boundaries as the content above it,
//   * nothing overflows sideways.
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
const VIEWPORTS = [[1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1024, 768], [820, 1180], [768, 1024], [430, 932], [390, 844], [375, 812]];

/** The content box (padding removed) of an element, as left/right/width. */
const box = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
  const l = b.left + parseFloat(cs.paddingLeft), r = b.right - parseFloat(cs.paddingRight); return { l: Math.round(l), r: Math.round(r), w: Math.round(r - l), outer: Math.round(b.width) }; })()`;

test('flights: results, fare and traveller details share one content width', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width: w, height: h, mobile: w < 600 });
      await page.goto(BASE + '/flights.html');
      await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 12000, label: 'results' });
      await sleep(700);
      const results = await page.eval(box('.tx-section'));
      const strip = await page.eval(box('.tx-layout-3'));
      const hs0 = await page.eval('document.documentElement.scrollWidth > innerWidth + 1');
      await page.eval(`document.querySelector('.jf-select').click()`);
      await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight'), { label: 'the booking sheet' });
      await sleep(900);
      const fare = await page.eval(box('.bk-sheet.is-flight'));
      const bar = await page.eval(`(() => { const e = document.querySelector('.bk-foot, .bk-bar, .bk-actionbar'); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; })()`);
      const clicked = await page.eval(`(() => { const b = [...document.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width > 0 && !e.disabled).find(e => /^continue to traveller/i.test(e.textContent.trim())); if (!b) return false; b.click(); return true; })()`);
      await sleep(1400);
      const traveller = await page.eval(box('.bk-sheet.is-flight'));
      const hs1 = await page.eval('document.documentElement.scrollWidth > innerWidth + 1');
      const at = ` @${w}x${h}`;
      if (Math.abs(results.w - fare.w) > 2) problems.push(`results content ${results.w}px vs fare ${fare.w}px` + at);
      if (Math.abs(results.l - fare.l) > 16 || Math.abs(results.r - fare.r) > 16) problems.push(`side boundaries move between phases (${results.l}-${results.r} -> ${fare.l}-${fare.r})` + at);
      if (!clicked) problems.push('could not continue to the traveller step' + at);
      else if (traveller.w !== fare.w || traveller.l !== fare.l) problems.push(`traveller step ${traveller.l}-${traveller.r} vs fare ${fare.l}-${fare.r}` + at);
      if (strip && Math.abs(strip.w - results.w) > 2) problems.push('the results grid is narrower than its section' + at);
      if (bar && (Math.abs(bar.l - (fare.l - 32)) > 40 || bar.r < fare.r)) problems.push('the sticky bar does not span the content' + at);
      if (hs0 || hs1) problems.push('horizontal scroll' + at);
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'flight width problems');
});

test('hotels: results, details and room selection share one content width, and so does the sticky bar', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width: w, height: h, mobile: w < 600 });
      await page.goto(BASE + '/hotels.html');
      await page.waitFor(() => document.querySelectorAll('#hrCards .hr-card').length > 0, { timeout: 12000, label: 'results' });
      await sleep(700);
      const step = () => page.eval(`(() => { const sc = [...document.querySelectorAll('.hr-scope')].find(e => !e.hidden && e.getBoundingClientRect().height > 0); if (!sc) return null;
        const wr = sc.querySelector('.hr-wrap'), b = wr.getBoundingClientRect(), cs = getComputedStyle(wr); const ab = document.querySelector('.hr-actionbar-inner'); const a = ab && ab.getBoundingClientRect();
        return { id: sc.id, l: Math.round(b.left + parseFloat(cs.paddingLeft)), r: Math.round(b.right - parseFloat(cs.paddingRight)), barL: a && a.width ? Math.round(a.left + parseFloat(getComputedStyle(ab).paddingLeft)) : null,
          barR: a && a.width ? Math.round(a.right - parseFloat(getComputedStyle(ab).paddingRight)) : null, hScroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
      const phases = { results: await step() };
      await page.eval(`[...document.querySelector('#hrCards .hr-card').querySelectorAll('button')].find(b => /^select$/i.test(b.textContent.trim())).click()`);
      await page.waitFor(() => { const c = document.getElementById('hrContinue'); return c && !c.disabled; }, { label: 'Continue' });
      await page.eval(`document.getElementById('hrContinue').click()`);
      await page.waitFor(() => /[?&]hotel=/.test(location.search) && !document.getElementById('hdRoot').hidden, { label: 'details' });
      await sleep(900);
      phases.details = await step();
      const toRooms = await page.eval(`(() => { const b = [...document.querySelectorAll('button, a')].filter(e => e.getBoundingClientRect().width > 0 && !e.disabled).find(e => /continue to room selection/i.test(e.textContent)); if (!b) return false; b.click(); return true; })()`);
      if (toRooms) { await sleep(1800); phases.rooms = await step(); }
      const at = ` @${w}x${h}`;
      if (!toRooms) problems.push('could not continue to room selection' + at);
      const base = phases.results;
      for (const [name, p] of Object.entries(phases)) {
        if (!p) { problems.push(name + ' step not visible' + at); continue; }
        if (p.l !== base.l || p.r !== base.r) problems.push(`${name} content ${p.l}-${p.r} vs results ${base.l}-${base.r}` + at);
        if (p.barL != null && (p.barL !== p.l || p.barR !== p.r)) problems.push(`${name}: the sticky bar (${p.barL}-${p.barR}) is not on the content edges (${p.l}-${p.r})` + at);
        if (p.hScroll) problems.push(`${name}: horizontal scroll` + at);
      }
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'hotel width problems');
});

test('flights and hotels use the same content width as each other', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const widths = {};
    for (const [name, path, ready, sel] of [['flights', '/flights.html', () => document.querySelectorAll('#txFlightList .tx-flight').length > 0, '.tx-section'],
      ['hotels', '/hotels.html', () => document.querySelectorAll('#hrCards .hr-card').length > 0, '#hrRoot .hr-wrap']]) {
      const page = await chrome.newPage();
      try {
        await page.viewport({ width: w, height: h, mobile: w < 600 });
        await page.goto(BASE + path);
        await page.waitFor(ready, { timeout: 12000, label: name });
        await sleep(600);
        widths[name] = await page.eval(box(sel));
      } finally { page.close(); }
    }
    if (Math.abs(widths.flights.w - widths.hotels.w) > 2) problems.push(`flights ${widths.flights.w}px vs hotels ${widths.hotels.w}px @${w}`);
    if (w >= 1456 && Math.abs(widths.flights.w - 1296) > 2) problems.push(`the reference content width is 1296px, got ${widths.flights.w} @${w}`);
  }
  assert.deepEqual(problems, [], 'flights and hotels differ');
});
