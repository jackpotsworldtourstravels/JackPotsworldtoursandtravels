// The fixed booking footer - Secure Booking, the route / stay, Total Amount and the Continue button - on the flight
// and hotel booking phases, at 1440, 1280, 768, 390 and 375px.
//
//   node --test tests/js/browser/booking-footer.ui.test.mjs
//
// WHAT WAS WRONG: the bar was a 94-95% cream over a cream page with a 40px-blur shadow, so the form behind it showed
// through and it had no readable edge; the flight bar's side padding (clamp(14px, 2.2vw, 32px)) did not match the
// sheet's gutter (--bk-gutter), so it sat 4-6px in from the window; and below 1100px / 720px the route, the stay and
// "Secure booking" were simply hidden. WHAT THIS PINS, for every phase it can reach:
//   * the bar's ground is OPAQUE and runs the full width of the window (so its left and right edges are the window's),
//   * its top edge is a visible rule, and it ends at the bottom of the window,
//   * every section is shown (nothing is display:none), inside the bar, inside the window, and none overlaps another,
//   * the Continue button is whole: inside the window, its label not clipped, the same padding each side as the bar,
//   * no sideways scroll, and the page leaves room above the bar so the last content is not trapped under it.
//
// FLIGHTS are self-contained: a throw-away static server for frontend/ and every /api call answered by the DevTools
// interceptor (cdp.mjs), so no backend or database is touched. HOTELS need the catalogue the local server provides:
// they run against JPW_BASE (default http://127.0.0.1:8000, read-only) and skip when nothing answers there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';
import { flightsPath } from './responsive-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FRONTEND = path.join(ROOT, 'frontend');
const HOTEL_BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const VIEWPORTS = [[1440, 900], [1280, 800], [768, 1024], [390, 844], [375, 667]];
const HS = 'document.documentElement.scrollWidth > innerWidth + 1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

let chrome = null; let server = null; let ORIGIN = ''; let skipReason = null; let hotelSkip = null;

before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
      let file = path.join(FRONTEND, p);
      if (!file.startsWith(FRONTEND)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (fs.existsSync(file + '.html')) file += '.html'; else { res.writeHead(404); res.end('not found'); return; }
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  ORIGIN = `http://127.0.0.1:${server.address().port}`;
  chrome = await Chrome.launch();
  const up = await fetch(HOTEL_BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) hotelSkip = `no server answering at ${HOTEL_BASE} (set JPW_BASE) - the hotel phases need its catalogue`;
});
after(async () => {
  if (chrome) await chrome.close();
  if (server) await new Promise(r => server.close(r));
});

const setValue = (page, id, v) => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return false;
  const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(v)});
  e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const press = (page, prefix) => page.eval(`(() => { const b = [...document.querySelectorAll('.bk-sheet button, .bkf-foot button, .bk-bar button')].filter(b => b.getBoundingClientRect().width > 0).find(e => e.textContent.replace(/\\s+/g, ' ').trim().toLowerCase().startsWith(${JSON.stringify(prefix)})); if (!b) return false; b.click(); return true; })()`);

/** Everything the bar must satisfy, measured in the page. `kind` is 'flight' or 'hotel'. */
const MEASURE_BAR = (kind, atEnd = false) => `(() => {
  const kind = ${JSON.stringify(kind)}, atEnd = ${JSON.stringify(atEnd)}, vw = innerWidth, vh = innerHeight;
  const bar = kind === 'flight' ? document.getElementById('bkFoot') : document.getElementById('hrActionbar');
  if (!bar || bar.hidden || getComputedStyle(bar).display === 'none') return null;
  const br = bar.getBoundingClientRect();
  const ground = kind === 'flight' ? getComputedStyle(bar, '::before') : getComputedStyle(bar);
  const alpha = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return 0; const p = m[1].split(',').map(parseFloat); return p.length === 4 ? p[3] : 1; };
  const selectors = kind === 'flight'
    ? { trust: '.bkf-foot-trust', route: '.bkf-foot-legs', total: '.bkf-foot-total', cta: '#bkNext' }
    : { items: '.hr-ab-item', total: '.hr-ab-total', cta: '.hr-ab-cta .hr-btn' };
  const parts = []; const problems = [];
  for (const [name, sel] of Object.entries(selectors)) {
    bar.querySelectorAll(sel).forEach((e, i) => {
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      if (cs.display === 'none' || r.width === 0 || r.height === 0) { problems.push(name + (i || '') + ' is not shown'); return; }
      parts.push({ name: name + i, r });
      if (r.left < -0.5 || r.right > vw + 0.5) problems.push(name + i + ' is outside the window (' + Math.round(r.left) + '..' + Math.round(r.right) + ')');
      if (r.top < br.top - 1 || r.bottom > br.bottom + 1) problems.push(name + i + ' sticks out of the bar vertically');
    });
  }
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i].r, b = parts[j].r;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push(parts[i].name + ' overlaps ' + parts[j].name);
  }
  const cta = bar.querySelector(kind === 'flight' ? '#bkNext' : '.hr-ab-cta .hr-btn'), cr = cta && cta.getBoundingClientRect();
  const labelClipped = !!cta && cta.scrollWidth > cta.clientWidth + 1;
  /* the same padding each side: the gap from the bar's content edge to the first / last section */
  const first = parts.length ? Math.min(...parts.map(p => p.r.left)) : 0, last = parts.length ? Math.max(...parts.map(p => p.r.right)) : 0;
  const body = kind === 'flight' ? document.querySelector('.bk-body') : null;
  return { vw, vh, bar: [br.left, br.right, br.top, br.bottom],
    groundAlpha: alpha(ground.backgroundColor), groundW: parseFloat(ground.width) || 0, topRule: ground.borderTopWidth + ' ' + ground.borderTopColor,
    shadow: ground.boxShadow !== 'none', problems, hs: ${HS}, ctaRight: cr && cr.right, ctaLeft: cr && cr.left, ctaW: cr && cr.width, labelClipped,
    /* Clearance only means something at the END of the page (a sticky bar overlaps content mid-scroll by design): the gap
       between the bar and the content's real bottom edge, i.e. the body box less its own bottom padding. */
    padL: first - 0, padR: vw - last, n: parts.length,
    clearance: (atEnd && body) ? br.top - (body.getBoundingClientRect().bottom - parseFloat(getComputedStyle(body).paddingBottom)) : null };
})()`;

function judge(m, at, kind, { requireWide = true } = {}) {
  const out = [];
  if (!m) return ['the bar is not on screen' + at];
  if (m.groundAlpha !== 1) out.push('the bar background is not opaque (alpha ' + m.groundAlpha + ')' + at);
  if (kind === 'flight' && m.groundW < m.vw - 1) out.push('the bar ground (' + Math.round(m.groundW) + 'px) does not span the window (' + m.vw + 'px)' + at);
  if (kind === 'hotel' && (m.bar[0] > 1 || m.bar[1] < m.vw - 20)) out.push('the bar does not span the window: ' + m.bar.map(Math.round) + at);
  if (!/^1px /.test(m.topRule) || /rgba?\(0, 0, 0, 0\)/.test(m.topRule)) out.push('no visible top rule: ' + m.topRule + at);
  if (!m.shadow) out.push('no shadow above the bar' + at);
  if (m.bar[3] > m.vh + 1) out.push('the bar runs past the bottom of the window (' + Math.round(m.bar[3]) + ' > ' + m.vh + ')' + at);
  if (m.hs) out.push('sideways scroll' + at);
  m.problems.forEach(p => out.push(p + at));
  if (m.labelClipped) out.push('the Continue label is clipped' + at);
  if (!m.ctaW || m.ctaW < 120) out.push('the Continue button is too narrow (' + Math.round(m.ctaW) + 'px)' + at);
  if (m.ctaRight > m.vw - 8) out.push('the Continue button is within 8px of the window edge (' + Math.round(m.ctaRight) + ' of ' + m.vw + ')' + at);
  if (Math.abs(m.padL - (m.vw - m.padR)) > 0 && requireWide && Math.abs(m.padL - m.padR) > 24) out.push(`unequal side padding: ${Math.round(m.padL)} left, ${Math.round(m.padR)} right` + at);
  if (m.clearance !== null && m.clearance < 8) out.push('the last content sits under the bar (clearance ' + Math.round(m.clearance) + 'px)' + at);
  return out;
}

const TRAVELLER = [['p0_title', 'Mr'], ['p0_first', 'Test'], ['p0_last', 'Traveller'], ['p0_dob', '1990-05-15'], ['p0_gender', 'Male'], ['p0_nat', 'India'],
  ['p0_email', 'responsive.tester@example.com'], ['p0_mobile', '9900001001']];

test('flights: the fixed footer is solid, whole and complete at every width (fare, traveller details, review, payment)', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const page = await chrome.newPage();
    const errors = [];
    page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description || e.exceptionDetails.text || '').split('\n')[0].slice(0, 160)));
    page.route(() => true, () => ({ status: 404, json: { detail: 'not mocked' } }));           // no backend: the flight board is sample data
    await page.viewport({ width: w, height: h, mobile: w < 600 });
    try {
      await page.goto(ORIGIN + flightsPath());
      await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 20000, label: 'flight results' });
      await page.eval(`document.querySelector('.jf-select').click()`);
      await page.waitFor(() => !!document.getElementById('bkFoot'), { label: 'the booking sheet' });
      await sleep(900);
      const phases = [];
      const snap = async (name, atEnd = false) => { await sleep(350); phases.push(name); problems.push(...judge(await page.eval(MEASURE_BAR('flight', atEnd)), ` [flight ${name} @${w}x${h}]`, 'flight')); };
      await snap('fare');
      await press(page, 'continue to traveller'); await sleep(1200);
      await snap('traveller details');
      for (const [id, v] of TRAVELLER) await setValue(page, id, v);
      await page.eval(`window.scrollTo(0, document.body.scrollHeight)`);
      await snap('traveller details, scrolled to the end', true);
      for (let i = 0; i < 6 && !(await page.eval(`!!document.querySelector('[data-rv-section]')`)); i++) { await press(page, 'continue'); await sleep(1500); }
      await page.eval(`window.scrollTo(0, 0)`);
      await snap('review');
      for (let i = 0; i < 4 && !(await page.eval(`!!document.querySelector('.bk-pay')`)); i++) { await press(page, 'continue'); await sleep(1500); }
      await snap('payment');
      if (phases.length < 5) problems.push('did not walk all phases: ' + phases);
      errors.forEach(e => problems.push('script error: ' + e + ` [@${w}x${h}]`));
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'flight footer');
});

test('hotels: the fixed action bar is solid, whole and complete at every width (results, details, rooms)', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  if (hotelSkip) { t.skip(hotelSkip); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const page = await chrome.newPage();
    await page.viewport({ width: w, height: h, mobile: w < 600 });
    try {
      await page.goto(HOTEL_BASE + '/hotels.html'); await sleep(2500);
      await page.eval(`(() => { const b = [...document.querySelectorAll('.hr-card button')].find(b => /^select/i.test(b.textContent.trim())); if (b) b.click(); })()`);
      await sleep(1500);
      for (let i = 1; i <= 3; i++) {
        const at = ` [hotel phase ${i} @${w}x${h}]`;
        const m = await page.eval(MEASURE_BAR('hotel'));
        problems.push(...judge(m, at, 'hotel'));
        if (m) {
          const room = await page.eval(`parseFloat(getComputedStyle(document.getElementById('hrRoot')).paddingBottom)`);
          if (room < m.bar[3] - m.bar[2] - 1) problems.push(`the page keeps ${Math.round(room)}px clear at the foot but the bar is ${Math.round(m.bar[3] - m.bar[2])}px tall` + at);
        }
        const ok = await page.eval(`(() => { const b = document.querySelector('#hrActionbar .hr-btn'); if (!b || b.disabled) return false; b.click(); return true; })()`);
        if (!ok) break;
        await sleep(1800);
      }
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'hotel action bar');
});
