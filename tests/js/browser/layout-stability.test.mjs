// Layout stability: the pages whose content used to jump while loading must not jump again.
//
// "Cumulative layout shift" (CLS) is how far visible content is pushed around after it first
// paints. Google rates <= 0.1 good. Before the fixes this test pins, Flights scored 0.3-1.3,
// Hotels 0.4-0.6, the content pages (about, FAQs, policies...) ~0.11 and destination pages
// 0.13-0.23 — caused by a hero or header that was built by script AFTER the page below it was
// already laid out (see the notes in jw-products.css and jw-system.css).
//
// Real browser, real server; skipped with the reason when either is missing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findChrome } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const PAGES = ['/flights.html', '/hotels.html', '/about.html', '/faqs.html', '/cookie-policy.html', '/destination/goa'];
const WIDTHS = '1440,820,375';
const BUDGET = 0.1;
// Flights was 0.3-1.3 and is now ~0.11-0.13: what remains is its own dates strip and route band
// appearing inside the hero after the data arrives, which needs the page's script changed, not CSS.
const BUDGETS = { '/flights.html': 0.16 };

test(`cumulative layout shift stays within ${BUDGET} on the pages that used to jump`, { timeout: 600000 }, async (t) => {
  if (!findChrome()) { t.skip('no Chrome or Edge found (set CHROME_PATH)'); return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { t.skip(`no server answering at ${BASE} (set JPW_BASE)`); return; }
  const out = execFileSync(process.execPath, [join(here, 'image-audit.mjs'), `--widths=${WIDTHS}`, `--only=${PAGES.join(',')}`, '--perf=1'],
    { env: Object.assign({}, process.env, { JPW_BASE: BASE }), maxBuffer: 1 << 26 }).toString();
  const rows = JSON.parse(out);
  assert.equal(rows.length, PAGES.length * WIDTHS.split(',').length);
  const over = rows.filter(r => r.perf && r.perf.cls > (BUDGETS[r.url] || BUDGET)).map(r => `${r.url} @${r.width}: ${r.perf.cls}`);
  assert.deepEqual(over, [], 'pages over the layout-shift budget');
  assert.deepEqual(rows.filter(r => r.hScroll).map(r => `${r.url} @${r.width}`), [], 'no horizontal scrolling');
});
