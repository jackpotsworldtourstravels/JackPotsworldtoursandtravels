// The site's images, in a real browser, at the widths people actually use.
//
// Runs image-audit.mjs over the pages that carry the most art — the landing page, the
// destination shelf and its pages, hotels, packages, flights — at 1920, 1366, 1024, 768,
// 430 and 375 pixels, and requires ZERO: failed image requests, wrong content types,
// images that finished loading with no pixels, CSS backgrounds that do not load,
// photographs squashed to the wrong aspect ratio, images wider than their box, and
// console errors. The full-site crawl is `node tests/js/browser/image-audit.mjs`.
//
// Skipped, with the reason, when there is no Chrome or no server (like the other browser tests).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findChrome } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const PAGES = ['/', '/destinations.html', '/destination/goa', '/hotels.html', '/packages.html', '/flights.html'];
const WIDTHS = '1920,1366,1024,768,430,375';

test('no broken, mistyped, squashed or overflowing image on the main pages at any common width', { timeout: 900000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome or Edge found (set CHROME_PATH)'); return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { t.skip(`no server answering at ${BASE} (set JPW_BASE)`); return; }
  const out = execFileSync(process.execPath, [join(here, 'image-audit.mjs'), `--widths=${WIDTHS}`, `--only=${PAGES.join(',')}`],
    { env: Object.assign({}, process.env, { JPW_BASE: BASE }), maxBuffer: 1 << 26 }).toString();
  const report = JSON.parse(out);
  assert.equal(report.pages, PAGES.length * WIDTHS.split(',').length, 'every page was loaded at every width');
  assert.deepEqual(report.problems, [], JSON.stringify(report.problems, null, 1).slice(0, 2000));
});
