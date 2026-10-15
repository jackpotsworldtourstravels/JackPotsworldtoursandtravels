// Flights and Hotels share one hero layout: the heading starts at the same distance from the header, and the
// white booking-summary card sits at the same vertical level, with the same inset, width, height and corners.
// (Flights has a route graphic and a sub-line; Hotels a stay graphic and a rates badge — the content differs, the
// frame does not.) Also: the Flights marketing sub-sentence stays removed, nothing overlaps the card, and the
// card does not move once the data has loaded.
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

const measure = (page) => page.eval(`(() => {
  const hero = document.getElementById('siteHero');
  const card = [...hero.querySelectorAll('.search-card, .jp-jh__sum')].find(e => e.getBoundingClientRect().height > 0);   // the phone's Hotels hero shows its folded summary instead
  const R = (e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top + scrollY), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom + scrollY) }; };
  const band = hero.querySelector('.jp-jh__band'), h1 = hero.querySelector('h1');
  const cs = getComputedStyle(card);
  const head = band.querySelector('.tx-head, .hr-results-head');
  return { hero: R(hero), band: R(band), h1: R(h1), card: R(card), radius: cs.borderTopLeftRadius,
    headBottom: Math.round(Math.max(...[...head.querySelectorAll('*')].map(e => e.getBoundingClientRect().bottom)) + scrollY),
    hasSubSentence: /Compare real-time fares/.test(document.body.innerText), hScroll: document.documentElement.scrollWidth > innerWidth + 1 };
})()`);

test('Flights and Hotels heroes line up at every width', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768], [1024, 768], [768, 1024], [430, 900], [375, 800]]) {
    const out = {};
    for (const pg of ['flights', 'hotels']) {
      const page = await chrome.newPage();
      try {
        await page.viewport({ width: w, height: h, mobile: w < 600 });
        await page.goto(`${BASE}/${pg}.html`);
        await page.waitFor(() => [...document.querySelectorAll('#siteHero .search-card, #siteHero .jp-jh__sum')].some(e => e.getBoundingClientRect().height > 0), { label: pg + ' card' });
        await sleep(1500);
        const early = await measure(page);
        await sleep(2500);                                         // the data has arrived
        out[pg] = await measure(page);
        if (Math.abs(out[pg].card.top - early.card.top) > 3) problems.push(`${pg} @${w}: the card moved after load (${early.card.top} -> ${out[pg].card.top})`);
      } finally { page.close(); }
    }
    const f = out.flights; const hh = out.hotels; const at = ` @${w}`;
    if (f.card.top !== hh.card.top) problems.push('card top differs' + at + `: ${f.card.top} vs ${hh.card.top}`);
    if (Math.abs(f.card.h - hh.card.h) > 1) problems.push('card height differs' + at + `: ${f.card.h} vs ${hh.card.h}`);
    if (Math.abs(f.card.w - hh.card.w) > 2 || Math.abs(f.card.left - hh.card.left) > 2) problems.push('card width/inset differs' + at + `: ${f.card.left}/${f.card.w} vs ${hh.card.left}/${hh.card.w}`);
    if (f.radius !== hh.radius) problems.push('card corners differ' + at + `: ${f.radius} vs ${hh.radius}`);
    if (f.hero.h !== hh.hero.h) problems.push('hero height differs' + at + `: ${f.hero.h} vs ${hh.hero.h}`);
    if (Math.abs(f.h1.top - hh.h1.top) > (w < 700 ? 10 : 8)) problems.push('heading top differs' + at + `: ${f.h1.top} vs ${hh.h1.top}`);
    for (const [pg, r] of Object.entries(out)) {
      if (r.headBottom > r.card.top - 4) problems.push(`${pg}${at}: hero text reaches the card (${r.headBottom} > ${r.card.top})`);
      if (r.band.bottom > r.card.top + 2) problems.push(`${pg}${at}: the band overlaps the card`);
      if (r.hScroll) problems.push(`${pg}${at}: horizontal scroll`);
    }
    if (f.hasSubSentence) problems.push('the Flights sub-sentence is back' + at);
  }
  assert.deepEqual(problems, [], 'hero alignment problems');
});
