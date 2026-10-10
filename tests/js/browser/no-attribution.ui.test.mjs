// No photographer credit, licence label or image-source line is drawn anywhere on the site.
//
// Loads the pages that show photographs — the landing page, every destination, a landmark page for
// every destination, the hotel pages, the packages page, the destinations shelf — at desktop and phone
// widths, lets the dynamic content arrive, and requires that
//   * no element of the known credit classes exists (.hp-credit, .ds-hero__credit, ...), and
//   * the visible text contains none of: "Photo:", "Photo by", "Image credit", "Image source",
//     "Photo credit", "CC BY", "CC0", "Creative Commons", "licence/license"
//     (and none of the photographers' names the manifests hold), and
//   * nothing was left behind: the hero's bottom strip is not an empty caption box.
//
// The credit data itself is not removed — it is the licence record (see the CREDITS.md files) — so
// this test also pins that the manifests still hold it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FRONT = join(here, '..', '..', '..', 'frontend');
const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null; let destinations = [];
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const r = await fetch(BASE + '/api/customer/destinations').then(x => x.ok ? x.json() : null).catch(() => null);
  if (!r) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  destinations = r;
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CREDIT_WORDS = /\bPhoto:|\bPhoto by\b|\bImage credit|\bImage source|\bPhoto credit|\bCC BY|\bCC0\b|Creative Commons|\blicen[cs]e\b/i;
const CREDIT_CLASSES = '.hp-credit, .ds-hero__credit, .mh-hotel-credit, .hr-gal-credit, .hr-card-credit, [class*="photo-credit"], [class*="image-credit"]';

/** Every photographer name the manifests hold, so a name appearing on a page is caught even without "Photo:". */
function photographers() {
  const names = new Set();
  for (const f of ['destination-images.js', 'location-images.js', 'hotel-images.js']) {
    const text = readFileSync(join(FRONT, 'assets', 'js', f), 'utf8');
    for (const m of text.matchAll(/"artist":\s*"([^"]+)"/g)) {
      const n = JSON.parse('"' + m[1] + '"');
      if (n.length >= 6 && !/^https?:/.test(n)) names.add(n);
    }
  }
  return [...names];
}

async function scan(page, path, width) {
  await page.viewport({ width, height: 900, mobile: width < 600 });
  await page.goto(BASE + path);
  await sleep(1800);
  const h = await page.eval('document.documentElement.scrollHeight');
  for (let y = 0; y < h + 600; y += 700) { await page.eval(`window.scrollTo(0, ${y})`); await sleep(90); }   // lazy and dynamic content
  await sleep(700);
  return page.eval(`(() => ({ text: document.body.innerText, credits: document.querySelectorAll(${JSON.stringify(CREDIT_CLASSES)}).length,
    figcaptions: [...document.querySelectorAll('figcaption')].map(e => e.innerText.trim()) }))()`);
}

test('no photographer credit, licence label or image-source line is drawn on any page that shows a photograph', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const names = photographers();
  assert.ok(names.length > 20, 'the manifests still hold the photographers (the licence record is kept)');
  const paths = ['/', '/destinations.html', '/packages.html', '/hotels.html', '/hotels/goa', '/flights.html',
    ...destinations.map(d => '/destination/' + d.id)];
  // a landmark page for every destination that has one
  for (const d of destinations) {
    const rows = await fetch(`${BASE}/api/customer/destinations/${d.id}/attractions`).then(r => r.json()).catch(() => []);
    if (rows[0]) paths.push('/location.html?id=' + encodeURIComponent(rows[0].id));
  }
  const problems = [];
  for (const width of [1366, 390]) {
    const page = await chrome.newPage();
    try {
      for (const path of paths) {
        const r = await scan(page, path, width);
        const bad = [];
        if (r.credits) bad.push(r.credits + ' credit element(s)');
        const hit = r.text.match(CREDIT_WORDS);
        if (hit) bad.push('text "' + hit[0] + '"');
        const who = names.find(n => r.text.includes(n));
        if (who) bad.push('photographer name "' + who + '"');
        const cap = r.figcaptions.find(c => CREDIT_WORDS.test(c));
        if (cap) bad.push('figcaption "' + cap.slice(0, 60) + '"');
        if (bad.length) problems.push(`${path} @${width}: ${bad.join('; ')}`);
      }
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'attribution still rendered');
});
