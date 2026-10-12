// The destination page's at-a-glance box: cream plate, thin gold border, circular icons, faint line-art — in the SAME
// place and footprint as the plain grid it replaced (beside the heading from 1025px, 184px tall; under it below that,
// one 93px row on a tablet and a 2x2 block on a phone) — and STILL: no animation of any kind on it.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null; let dests = [];
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  dests = await fetch(BASE + '/api/customer/destinations').then(r => r.ok ? r.json() : []).catch(() => []);
  if (!dests.length) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const probe = (page) => page.eval(`(() => {
  const box = document.querySelector('.dl-glance'); if (!box) return null;
  const panels = [...box.querySelectorAll('.dl-gl')]; const R = (e) => e.getBoundingClientRect();
  const bs = getComputedStyle(box);
  const anim = [box, ...box.querySelectorAll('*')].filter(e => ['', '::before', '::after'].some(ps => { const c = getComputedStyle(e, ps || null);
    return (c.animationName && c.animationName !== 'none') || (parseFloat(c.transitionDuration) > 0 && c.transitionProperty !== 'none' && /box-shadow|border|background|opacity|transform/.test(c.transitionProperty)); })).length;
  return { labels: panels.map(p => p.querySelector('dt').textContent), values: panels.map(p => p.querySelector('dd').textContent),
    widths: panels.map(p => Math.round(R(p).width)), tops: panels.map(p => Math.round(R(p).top)), boxW: Math.round(R(box).width), boxH: Math.round(R(box).height),
    radius: parseFloat(bs.borderTopLeftRadius), border: bs.borderTopColor, borderW: parseFloat(bs.borderTopWidth), bg: bs.backgroundImage.slice(0, 60),
    icons: panels.map(p => { const i = p.querySelector('.dl-gl-icon'); const c = getComputedStyle(i); return { round: c.borderRadius, w: Math.round(R(i).width), h: Math.round(R(i).height), svg: !!i.querySelector('svg') }; }),
    art: panels.map(p => !!p.querySelector('.dl-gl-art')), underline: panels.map(p => getComputedStyle(p.querySelector('dt'), '::after').height),
    valueFont: getComputedStyle(panels[0].querySelector('dd')).fontFamily.slice(0, 20), labelCase: getComputedStyle(panels[0].querySelector('dt')).textTransform,
    animated: anim, hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    boxLeft: Math.round(R(box).left), boxTop: Math.round(R(box).top + scrollY), headRight: Math.round(R(document.querySelector('#overview h2')).right),
    headBottom: Math.round(R(document.querySelector('#overview h2')).bottom + scrollY),
    hero: [...document.querySelectorAll('.dl-stat b')].map(b => b.textContent.trim()) }; })()`);

test('the glance box matches the reference design, uses live data, and does not animate', { timeout: 180000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try {
    for (const width of [1366, 820, 390]) {
      await page.viewport({ width, height: 900, mobile: width < 600 });
      await page.goto(BASE + '/destination/' + dests[0].id);
      await page.waitFor(() => !!document.querySelector('.dl-glance .dl-gl dd'), { label: 'the box' });
      await sleep(600);
      const r = await probe(page);
      const at = ` at ${width}px`;
      assert.deepEqual(r.labels, ['Country', 'Famous places', 'Hotels near them', 'Tour packages'], 'four panels, in order' + at);
      assert.equal(r.values[0], dests[0].country, 'the country is the API\'s' + at);
      assert.ok(r.values.slice(1).every(v => /^\d+$/.test(v)), 'the counts are numbers from the page data' + at);
      assert.equal(r.labelCase, 'uppercase');
      assert.match(r.valueFont, /Playfair|serif|Georgia/i, 'serif values');
      assert.equal(r.radius >= 12 && r.radius <= 20, true, 'subtly rounded corners' + at);
      assert.ok(r.borderW >= 1 && r.borderW <= 2, 'a thin border' + at);
      assert.match(r.border, /^rgb\(196, 152, 63\)$/, 'gold border' + at);
      assert.match(r.bg, /gradient/, 'ivory ground' + at);
      assert.ok(r.icons.every(i => i.svg && i.w === i.h && /50%/.test(i.round)), 'four circular icons' + at);
      assert.ok(r.art.every(Boolean), 'line-art in every panel' + at);
      assert.ok(r.underline.every(h => h === '2px'), 'gold underline accents' + at);
      assert.deepEqual(r.animated, 0, 'nothing on the box is animated' + at);
      assert.equal(r.hScroll, false, 'no horizontal scroll' + at);
      if (width > 1024) {
        assert.ok(Math.abs(r.boxH - 184) <= 2, `the old grid's 184px height is kept (${r.boxH}) at ${width}`);
        assert.ok(r.boxW >= 640 && r.boxW <= 700, `the old grid's ~667px width is kept (${r.boxW}) at ${width}`);
        assert.ok(r.boxLeft >= r.headRight - 20, 'it sits BESIDE the heading, where the grid sat' + at);
        assert.ok(Math.max(...r.widths.slice(0, 3)) - Math.min(...r.widths.slice(0, 3)) <= 2, 'three equal panels' + at);
        assert.ok(r.tops[3] > r.tops[0] && r.widths[3] >= r.boxW - 4, 'Tour packages is a full-width row' + at);
      } else if (width > 640) {
        assert.ok(r.boxH <= 112, `one compact row on a tablet (${r.boxH}px; the old grid was 93) at ${width}`);
        assert.ok(new Set(r.tops).size === 1, 'four panels in one row' + at);
        assert.ok(r.boxTop >= r.headBottom - 2, 'under the heading, as before' + at);
      } else {
        assert.ok(r.boxH <= 200, `a compact 2x2 block on a phone (${r.boxH}px; the old grid was 184-199) at ${width}`);
        assert.equal(new Set(r.tops).size, 2, 'two rows of two' + at);
      }
      if (r.hero.length >= 3) assert.deepEqual(r.values.slice(1), r.hero.slice(0, 3).map(String), 'matches the hero\'s own counts' + at);
    }
  } finally { page.close(); }
});

test('a long country name fits inside its panel', { timeout: 120000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const long = dests.find(d => (d.country || '').length > 12);
  if (!long) { t.skip('no destination with a long country name'); return; }
  const page = await chrome.newPage();
  try {
    await page.viewport({ width: 1366, height: 900, mobile: false });
    await page.goto(BASE + '/destination/' + long.id);
    await page.waitFor(() => !!document.querySelector('.dl-glance .dl-gl dd'));
    await sleep(500);
    const fit = await page.eval(`(() => { const p = document.querySelector('.dl-gl--country'), d = p.querySelector('dd'); return d.getBoundingClientRect().right <= p.getBoundingClientRect().right && d.getBoundingClientRect().bottom <= p.getBoundingClientRect().bottom; })()`);
    assert.equal(fit, true);
  } finally { page.close(); }
});
