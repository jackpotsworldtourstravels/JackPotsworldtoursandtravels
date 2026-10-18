// Shared by the responsive browser tests: the seven target viewports, the in-page measurement, and page opening.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
export const AUDIT = !!process.env.JPW_AUDIT;
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const VIEWPORTS = [[375, 667], [393, 852], [412, 968], [768, 1024], [960, 1440], [1004, 764], [1280, 800]];
/** Desktop with a mouse (no touch emulation) and the narrow / short / landscape-phone sizes. */
export const DESKTOP_VIEWPORTS = [[1440, 900], [1920, 1080]];
export const EDGE_VIEWPORTS = [[320, 568], [667, 375], [812, 375]];
export const ALL_VIEWPORTS = [...VIEWPORTS, ...DESKTOP_VIEWPORTS, ...EDGE_VIEWPORTS];

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../frontend');
// Staff portals have their own responsive script (tests/verify_responsive.py); these directories are not the customer site.
const NOT_CUSTOMER_SITE = new Set(['admin', 'manager', 'merchant', 'merchant-classic', 'operations', 'super-admin', 'assets', 'components', 'shared', 'tests']);

/** Every customer-facing static page, read from the frontend directory so a new page is covered the day it is added. */
export function staticPages() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!(rel === '' && NOT_CUSTOMER_SITE.has(e.name))) walk(path.join(dir, e.name), rel + e.name + '/'); }
      else if (e.name.endsWith('.html')) out.push(rel + e.name);
    }
  };
  walk(FRONTEND, '');
  return out.sort().map(f => f === 'index.html' ? '/' : f === 'customer/index.html' ? '/customer/' : '/' + f);
};

/** The templated pages, sampled from the live catalogue: destination, attraction, hotels near an attraction, package. */
export async function familyPages(base = BASE) {
  const j = (u) => fetch(base + u).then(r => r.json()).catch(() => []);
  const dests = await j('/api/customer/destinations');
  const out = [];
  for (const d of dests.slice(0, 3)) out.push('/destination/' + d.slug);
  for (const d of dests.slice(0, 2)) {
    const a = (await j(`/api/customer/destinations/${d.slug}/attractions`))[0];
    if (a) out.push(`/destination/${d.slug}/${a.slug}`, `/hotels/${d.slug}/${a.slug}`);
  }
  for (const pk of (await j('/api/customer/packages?page_size=50')).slice(0, 2)) out.push('/package/' + pk.id, '/package-details/' + pk.id);
  out.push('/no-such-page-404');
  return out;
};

/** Pages whose single card has no site header or footer, by design. */
/** The Flights results page lists a sample schedule of today's departures that are still ahead, so by late evening today's list is
 *  empty and every test that waits for a flight card would fail. Asking for tomorrow (the page honours ?depart=) is time-independent. */
export const flightsPath = () => { const d = new Date(Date.now() + 24 * 3600 * 1000); const p = (n) => String(n).padStart(2, '0'); return `/flights.html?depart=${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

export const AUTH_CARD = new Set(['/login.html', '/register.html', '/forgot-password.html', '/reset-password.html', '/customer/forgot-password.html', '/customer/register.html', '/customer/reset-password.html', '/portal-login.html', '/partner-login.html', '/ticket-verify.html']);

/** Everything that can be measured on a loaded page, in one evaluation. */
export const MEASURE = `(() => {
  const W = innerWidth, vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0; };
  const path = (e) => { const p = []; for (let n = e; n && n.nodeType === 1 && p.length < 3; n = n.parentElement) p.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList[0] ? '.' + n.classList[0] : '')); return p.join(' < '); };
  const scrollsItself = (e) => { for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) { const s = getComputedStyle(n); if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && n.getBoundingClientRect().right <= W + 1) return true; if (s.position === 'fixed') break; } return false; };
  const hScroll = document.documentElement.scrollWidth > W + 1;
  const out = []; const seen = new Set();
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e)) continue; const r = e.getBoundingClientRect();
    if (r.right > W + 1 && r.left < W && !scrollsItself(e) && !e.closest('[aria-hidden="true"], svg, [hidden]')) { const k = path(e); if (!seen.has(k)) { seen.add(k); out.push(k + ' right=' + Math.round(r.right)); } }
  }
  const small = [], zoom = [];
  const touch = matchMedia('(pointer: coarse)').matches;   // phones and tablets run with touch emulation; the 1440 / 1920 desktop runs do not
  if (touch) for (const e of document.querySelectorAll('a[href], button, [role=button], select, input:not([type=hidden]), textarea, summary')) {
    if (!vis(e) || e.disabled || e.classList.contains('skip-link')) continue; let r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    if (r.right <= 0 || r.bottom <= 0 || r.left >= W) continue;                                           // parked off-screen
    const fld = /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && e.closest('.field, .fld, label'); if (fld && !/(checkbox|radio)/.test(e.type || '')) r = fld.getBoundingClientRect();   // the whole field is the tap area
    if (e.tagName === 'A' && cs.display === 'inline' && e.closest('p, li, span, td, label')) continue;    // a link inside a sentence
    if (e.closest('footer') && e.tagName === 'A' && r.height >= 24) continue;                              // footer link rows: 24px floor
    if (e.type === 'range') continue;   // a slider's thumb is its target; the dual price sliders are measured by eye, not by box
    if (e.type === 'checkbox' || e.type === 'radio') { if (e.closest('label') && e.closest('label').getBoundingClientRect().height >= 32) continue; }
    if (r.height < 32 || r.width < 32) small.push(path(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (e.textContent || e.getAttribute('aria-label') || e.placeholder || '').trim().slice(0, 18) + '"');
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && !/(checkbox|radio|range|submit|button|file|color)/.test(e.type || '') && parseFloat(cs.fontSize) < 16 && W <= 480) zoom.push(path(e) + ' ' + cs.fontSize);
  }
  const clipped = [];
  for (const e of document.querySelectorAll('h1, h2, h3, h4, p, a, button, label, span, li, td, th, dt, dd, b, strong')) {
    if (!vis(e) || e.closest('svg')) continue; const cs = getComputedStyle(e);
    if (/(hidden|clip)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && cs.whiteSpace !== 'nowrap' && !e.closest('[aria-hidden="true"]') && e.children.length === 0 && (e.textContent || '').trim())
      clipped.push(path(e) + ' scroll=' + e.scrollWidth + ' client=' + e.clientWidth);
  }
  // An element the page marked hidden must not be drawn. A rule that gives it a display (display: flex ...) beats the browser's
  // [hidden] { display: none }, which is how a call screen, its Accept / Decline buttons and a timer ended up inside the chat.
  const hiddenShown = [];
  for (const e of document.querySelectorAll('[hidden]')) { if (e.closest('template, svg') || /^(SCRIPT|STYLE|META|LINK|TITLE)$/.test(e.tagName)) continue; const cs = getComputedStyle(e); if (cs.display !== 'none') hiddenShown.push(path(e) + ' display:' + cs.display + ' ' + Math.round(e.getBoundingClientRect().height) + 'px'); }
  const hdr = document.querySelector('header, #siteHeader, .jw-header'), ftr = document.querySelector('footer');
  const fr = ftr && ftr.getBoundingClientRect();
  return { hScroll, sw: document.documentElement.scrollWidth, hiddenShown: hiddenShown.slice(0, 6), out: out.slice(0, 6), small: small.slice(0, 8), nSmall: small.length, zoom: zoom.slice(0, 4), clipped: clipped.slice(0, 5),
    header: !!hdr && vis(hdr), footer: !!ftr, footerOk: !ftr || (fr.left >= -1 && fr.right <= W + 1) };
})()`;

export async function openPage(chrome, path, w, h, init, origin) {
  const page = await chrome.newPage();
  const errors = [], failed = [];
  await page.send('Network.enable');
  page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description || e.exceptionDetails.text || '').split('\n')[0].slice(0, 120)));
  page.on('Network.loadingFailed', (e) => { if (!e.canceled) failed.push(e.errorText + ' ' + (e.requestId || '')); });
  page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/favicon|accounts\.google\.com/.test(e.response.url) && !(path.includes('no-such') && e.type === 'Document')) failed.push(e.response.status + ' ' + e.response.url.replace(BASE, '')); });
  await page.viewport({ width: w, height: h, mobile: Math.min(w, h) <= 480 });
  if (w <= 1280) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });   // every phone / tablet viewport is touch; 1440 and 1920 are a desktop mouse   // every target viewport is a touch device: pointer: coarse, hover: none
  if (init) await page.addInitScript(init);   // e.g. a signed-in session, in place before the page's own scripts run
  // A page that never fires its load event (a stalled third-party script) must be a finding, not a hung audit.
  const loaded = await Promise.race([page.goto((origin || BASE) + path).then(() => true), sleep(20000).then(() => false)]);
  if (!loaded) errors.push('the page did not finish loading within 20 s');
  await sleep(900);
  return { page, errors, failed };
}

export const report = (problems, title) => {
  if (AUDIT) { console.log(`\n--- ${title}: ${problems.length} finding(s)`); problems.forEach(p => console.log('  ' + p)); return; }
  assert.deepEqual(problems, [], title);
};

