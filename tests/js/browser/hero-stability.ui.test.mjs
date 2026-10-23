// The landing hero: a booking card that is as tall as its own panel, and a hero picture that stays put as the
// page scrolls AND as the tab changes.
//
// CONTRACT NOW (this replaces "one card size across the three tabs"): the card used to be pinned to the height
// of its fullest panel so the hero would not change height between tabs, which left Hotels and Tour Packages
// with 45-90px of empty card. The pin is gone; what keeps the picture still is that it and its shade are sized
// by the SCREEN (116svh from -8svh), not by the hero. So:
//   * from 901px up, the card fits its panel (Flights > Hotels > Tour Packages) and the title does not move;
//   * the photograph's rectangle is identical on every tab, at every width;
//   * the photograph covers at least the first screen of the hero (a tall phone hero fades into the night
//     ground below that, instead of stretching the picture to fit).
//
// BEFORE: choosing a tab resized the card (475 / 390 / 326px on a desktop), and the hero's scroll motion
// shrank the picture's stage to 90% (black bars down both sides and along the bottom), drifted the photo
// down inside it, and scaled the card to 93% — so the card looked smaller whenever the page was scrolled.
//
//   * from 901px wide up, the card is the same height on all three tabs (and the same width everywhere);
//   * below 901px each tab keeps the height its own fields need (a deliberate choice, see home-cinema.css),
//     but the WIDTH and alignment are identical;
//   * at every scroll position the stage covers the hero exactly, the photograph covers the stage, the
//     card is not scaled, and nothing overflows sideways;
//   * every tab's main field is inside the card and visible.
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

// the ten requested sizes, then intermediate widths (and the widths browser zoom of 125-200% produces)
const VIEWPORTS = [[1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1024, 768], [820, 1180], [768, 1024], [430, 932], [390, 844], [375, 812],
  [1280, 720], [1100, 800], [960, 700], [700, 900], [600, 900], [500, 900]];
const TABS = { flights: 'fFrom', hotels: 'hDest', packages: 'pType' };

const cardInfo = (page, tab) => page.eval(`(async () => {
  window.scrollTo(0, 0);
  document.querySelector('.search-tab[data-tab="${tab}"]').click();
  await new Promise(r => setTimeout(r, 700));
  const c = document.querySelector('.search-card'), b = c.getBoundingClientRect();
  const f = document.getElementById('${TABS[tab]}'), fb = f.getBoundingClientRect();
  return { top: Math.round(b.top + scrollY), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height), transform: getComputedStyle(c).transform,
    fieldVisible: fb.width > 0 && fb.height > 0 && fb.left >= b.left - 1 && fb.right <= b.right + 1, fieldInCard: fb.top >= b.top - 1,
    hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    photo: (() => { const r = document.querySelector('.cine-photo').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)].join(','); })() };
})()`);

test('a card fitted to its panel, and a hero picture that stays still across tabs and scroll, at every viewport', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width: w, height: h, mobile: w < 600 });
      await page.goto(BASE + '/index.html');
      await page.waitFor(() => !!document.querySelector('.search-card') && !document.documentElement.classList.contains('cine-pre'), { timeout: 8000, label: 'the hero' }).catch(() => {});
      // the opening sequence lifts and tilts the card on a transform; measure only once it has landed
      await page.waitFor(() => { const d = document.querySelector('.cine-dock'); const t = getComputedStyle(d).transform; return (t === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t)) && getComputedStyle(d).opacity === '1'; }, { timeout: 10000, label: 'the opening sequence' }).catch(() => {});
      await sleep(1500);
      const at = ` @${w}x${h}`;
      const info = {};
      for (const tab of Object.keys(TABS)) info[tab] = await cardInfo(page, tab);
      const { flights: f, hotels: ho, packages: p } = info;
      if (new Set([f.w, ho.w, p.w]).size > 1) problems.push('card width differs between tabs' + at + `: ${f.w}/${ho.w}/${p.w}`);
      if (new Set([f.left, ho.left, p.left]).size > 1) problems.push('card alignment differs between tabs' + at);
      if (Math.max(f.top, ho.top, p.top) - Math.min(f.top, ho.top, p.top) > 3) problems.push('card moves between tabs' + at + `: ${f.top}/${ho.top}/${p.top}`);
      if (w >= 901 && !(f.h > ho.h && ho.h > p.h)) problems.push('the card is not fitted to its panel' + at + `: ${f.h}/${ho.h}/${p.h}`);
      if (new Set([f.photo, ho.photo, p.photo]).size > 1) problems.push('the photograph moves or rescales between tabs' + at + `: ${f.photo} | ${ho.photo} | ${p.photo}`);
      for (const [tab, i] of Object.entries(info)) {
        if (i.transform !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(i.transform)) problems.push(`${tab} card is transformed` + at + ': ' + i.transform);
        if (!i.fieldVisible || !i.fieldInCard) problems.push(`${tab}: its main field is not inside the card` + at);
        if (i.hScroll) problems.push(`${tab}: horizontal scroll` + at);
      }
      // scroll through the hero and check the picture and the card at several positions
      await page.eval(`document.querySelector('.search-tab[data-tab="hotels"]').click()`);
      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        await page.eval(`window.scrollTo(0, ${Math.round(h * frac)})`);
        await sleep(900);
        const s = await page.eval(`(() => { const R = (e) => e.getBoundingClientRect(), hero = R(document.querySelector('.cine-hero')),
          st = document.getElementById('cineStage'), md = document.querySelector('.cine-media'), dk = document.querySelector('.cine-dock');
          const stR = R(st), mdR = R(md);
          return { stageInset: [Math.round(stR.left - hero.left), Math.round(hero.right - stR.right), Math.round(stR.top - hero.top), Math.round(hero.bottom - stR.bottom)],
            mediaCovers: mdR.left <= hero.left + 1 && mdR.right >= hero.right - 1 && mdR.top <= hero.top + 1
              && mdR.bottom >= Math.min(hero.bottom, hero.top + innerHeight) - 1,
            stageTf: getComputedStyle(st).transform, mediaTf: getComputedStyle(md).transform, dockTf: getComputedStyle(dk).transform }; })()`);
        const where = ` @${w}x${h} scroll ${Math.round(frac * 100)}%`;
        if (s.stageInset.some(v => Math.abs(v) > 1)) problems.push('the picture stage shrank (black edges)' + where + ': ' + s.stageInset);
        if (!s.mediaCovers) problems.push('the photograph does not cover the hero' + where);
        const id = /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/;
        if (!id.test(s.stageTf) || !id.test(s.mediaTf) || !id.test(s.dockTf)) problems.push('stage/photo/card is scaled or moved by scroll' + where + `: ${s.stageTf} | ${s.mediaTf} | ${s.dockTf}`);
      }
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'hero stability problems');
});
