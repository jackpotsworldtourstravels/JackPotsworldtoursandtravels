// Packages page: the filter list must not appear late and push the results down.
//
// Up to 1000px wide the filters are a drawer — closed by default, opened by the "Filters" button —
// because they are built after the list arrives and, stacked above the results, are ~800px tall.
// Wider than that they are the side column they always were.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/packages').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const probe = (page) => page.eval(`(() => { const r = document.getElementById('pklRail'), t = document.getElementById('pklFilterToggle'), g = document.getElementById('pklGrid');
  return { railShown: r.getClientRects().length > 0, railInputs: r.querySelectorAll('input, select').length,
    toggleShown: t.getClientRects().length > 0, expanded: t.getAttribute('aria-expanded'),
    gridTop: Math.round(g.getBoundingClientRect().top + scrollY), cards: g.children.length }; })()`);

test('tablet: the filters are a closed drawer, the results do not move when they are built, and the button opens them', { timeout: 120000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try {
    await page.viewport({ width: 820, height: 1000, mobile: false });
    await page.goto(BASE + '/packages.html');
    await page.waitFor(() => document.getElementById('pklGrid').children.length > 0 && !document.getElementById('pklGrid').querySelector('.sk'), { label: 'the packages' });
    const early = await probe(page);
    await sleep(2500);                                    // the facets (the filters) have long arrived
    const late = await probe(page);
    assert.equal(late.toggleShown, true, 'the Filters button is there');
    assert.equal(late.railShown, false, 'closed by default');
    assert.equal(late.expanded, 'false');
    assert.ok(Math.abs(late.gridTop - early.gridTop) <= 25, `the results did not move when the filters were built (${early.gridTop} -> ${late.gridTop})`);
    await page.eval(`document.getElementById('pklFilterToggle').click()`);
    const open = await probe(page);
    assert.equal(open.railShown, true, 'the button opens the filters in place');
    assert.ok(open.railInputs > 0, 'with real filters in it');
    assert.equal(open.expanded, 'true');
    await page.eval(`document.getElementById('pklFilterToggle').click()`);
    assert.equal((await probe(page)).railShown, false, 'and closes them again');
  } finally { page.close(); }
});

test('desktop: no drawer button, and the filters are the side column', { timeout: 120000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try {
    await page.viewport({ width: 1440, height: 900, mobile: false });
    await page.goto(BASE + '/packages.html');
    await page.waitFor(() => document.getElementById('pklRail').querySelectorAll('input, select').length > 0, { label: 'the filters' });
    const r = await probe(page);
    assert.equal(r.toggleShown, false);
    assert.equal(r.railShown, true);
  } finally { page.close(); }
});
