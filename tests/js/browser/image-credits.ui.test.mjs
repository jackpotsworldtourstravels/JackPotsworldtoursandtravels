// The Image Credits page: the one place the licences' attribution is shown, reachable from every footer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FRONT = join(here, '..', '..', '..', 'frontend');
const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

const countKeys = (file, name) => {
  const text = readFileSync(join(FRONT, 'assets', 'js', file), 'utf8');
  const m = text.match(new RegExp('const ' + name + '\\s*=\\s*(\\{[\\s\\S]*?[\\r\\n]\\});'));
  return Object.keys(JSON.parse(m[1])).length;
};

test('the Image Credits page lists every credited photograph, with licence links, and fits every width', { timeout: 120000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const expected = countKeys('destination-images.js', 'DESTINATION_IMAGE_CREDITS')
    + countKeys('location-images.js', 'LOCATION_IMAGE_CREDITS') + countKeys('hotel-images.js', 'HOTEL_IMAGE_CREDITS');
  for (const width of [1366, 820, 390]) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width, height: 900, mobile: width < 600 });
      await page.goto(BASE + '/image-credits.html');
      await page.waitFor(() => document.querySelectorAll('.ic-table tbody tr').length > 0, { label: 'the credits table' });
      const r = await page.eval(`(() => ({ rows: document.querySelectorAll('.ic-table tbody tr').length,
        tables: document.querySelectorAll('.ic-table').length,
        deeds: [...document.querySelectorAll('.ic-table a[href*="creativecommons.org"]')].length,
        bad: [...document.querySelectorAll('.ic-table a')].filter(a => a.protocol !== 'https:').length,
        hScroll: document.documentElement.scrollWidth > innerWidth + 1,
        footerLink: !!document.querySelector('footer a[href="image-credits.html"]') }))()`);
      assert.equal(r.rows, expected, 'a row for every credited photograph at ' + width);
      assert.equal(r.tables, 3);
      assert.ok(r.deeds > 50, 'licences link to their Creative Commons deed');
      assert.equal(r.bad, 0, 'every link is https');
      assert.equal(r.hScroll, false, 'no horizontal page scroll at ' + width);
      assert.equal(r.footerLink, true, 'the footer links to this page');
    } finally { page.close(); }
  }
});
