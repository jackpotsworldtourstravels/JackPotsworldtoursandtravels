// Clean URLs on the public B2C site, in a real browser against a real server.
//
// WHAT THIS PINS
//   * every public page answers at its clean address (`/flights`, `/about` ...) and `/` is the landing page;
//   * the old `<page>.html` address answers 301 to the clean one, and a REAL BROWSER ends up on the clean
//     URL with the query string intact (a flight search keeps every parameter and still renders results);
//   * `/index.html?signin=1` lands on `/?signin=1` and the sign-in dialog opens;
//   * pages that are not on the redirect list, and every portal directory, are not redirected;
//   * the header, logo and footer on the public pages link to clean URLs only - none to an audited `.html`
//     page - and clicking them lands on the clean URL;
//   * one self-referencing canonical per page, og:url equal to it;
//   * CSS, JavaScript and images load (no 4xx / 5xx / failed request) on the clean URLs.
//
// Needs Chrome/Edge and a server answering at JPW_BASE (default http://127.0.0.1:8000). Skips with a reason otherwise.
//
//     JPW_BASE=http://127.0.0.1:8000 node --test tests/js/browser/clean-urls.ui.test.mjs
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const SITE = 'https://jackpotsworldtours.com';
let chrome = null; let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The audited list (must equal LEGACY_HTML_REDIRECTS in backend/app/main.py).
const PAGES = ['index', 'flights', 'hotels', 'packages', 'gaming-packages', 'destinations', 'activities', 'visa', 'cruises',
  'about', 'contact-us', 'faqs', 'customer-support', 'payment-security', 'privacy-policy', 'terms-and-conditions',
  'cancellation-refund-policy', 'image-credits', 'cookie-policy', 'disclaimer', 'my-bookings', 'login', 'register',
  'forgot-password', 'reset-password'];
const clean = (p) => (p === 'index' ? '/' : '/' + p);
const iso = (plusDays) => {
  const d = new Date(Date.now() + plusDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const get = (path, opts = {}) => fetch(BASE + path, { redirect: 'manual', ...opts });
const ui = (name, fn) => test(name, { timeout: 120000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const page = await chrome.newPage();
  try { await page.viewport({ width: 1280, height: 900 }); await fn(page, t); } finally { page.close(); }
});

// ---------------------------------------------------------------------------------------------------------
// HTTP level: no browser needed beyond the skip gate
// ---------------------------------------------------------------------------------------------------------
test('every public page answers 200 at its clean URL', async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  for (const p of PAGES) {
    const r = await get(clean(p));
    assert.equal(r.status, 200, `${clean(p)} -> ${r.status}`);
    assert.match(r.headers.get('content-type') || '', /text\/html/, clean(p));
  }
});

test('every legacy .html address is a permanent redirect to the clean one (GET and HEAD)', async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  for (const p of PAGES) {
    for (const method of ['GET', 'HEAD']) {
      const r = await get(`/${p}.html`, { method });
      assert.equal(r.status, 301, `${method} /${p}.html -> ${r.status}`);
      assert.equal(r.headers.get('location'), clean(p), `${method} /${p}.html`);
    }
  }
});

test('the query string survives the redirect byte for byte', async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const cases = [
    [`/flights.html?trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`, `/flights?trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`],
    ['/flights.html?trip=multi&legs=HYD:BLR:2026-12-01,BLR:HYD:2026-12-03&adults=2&cabin=business', '/flights?trip=multi&legs=HYD:BLR:2026-12-01,BLR:HYD:2026-12-03&adults=2&cabin=business'],
    ['/hotels.html?dest=Banjara%20Hills', '/hotels?dest=Banjara%20Hills'],
    ['/packages.html?type=Goa&month=2026-12', '/packages?type=Goa&month=2026-12'],
    ['/index.html?signin=1', '/?signin=1'],
    ['/index.html?account=profile', '/?account=profile'],
    ['/reset-password.html?token=abc.DEF-123_x', '/reset-password?token=abc.DEF-123_x'],
  ];
  for (const [from, to] of cases) {
    const r = await get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get('location'), to, from);
  }
});

test('pages that are not on the list, and every portal, are NOT redirected', async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  for (const path of ['/partner-login.html', '/portal-login.html', '/design-system.html', '/destination.html',
    '/destination-hotels.html', '/location.html', '/package.html', '/ticket-verify.html',
    '/admin/', '/admin/index.html', '/manager/', '/manager/index.html', '/merchant/', '/merchant/index.html',
    '/merchant-classic/', '/operations/', '/super-admin/', '/super-admin/index.html', '/customer/', '/customer/index.html']) {
    const r = await get(path);
    assert.equal(r.status, 200, `${path} -> ${r.status} ${r.headers.get('location') || ''}`);
  }
  assert.equal((await get('/no-such-page')).status, 404);
});

test('assets and the API are untouched', async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  for (const path of ['/assets/js/site-footer.js', '/assets/js/travel-explore.js', '/assets/css/flights-ref.css', '/api/health']) {
    assert.equal((await get(path)).status, 200, path);
  }
});

// ---------------------------------------------------------------------------------------------------------
// A real browser
// ---------------------------------------------------------------------------------------------------------
ui('a flight search on the old .html address lands on the clean URL with every parameter, and still shows results', async (page) => {
  const q = `trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`;
  await page.goto(`${BASE}/flights.html?${q}`);
  await page.waitFor(() => document.querySelectorAll('#txFlightList .tx-flight, #txFlightList .jf-trip').length > 0, { timeout: 20000, label: 'flight results' });
  const here = await page.eval(`({ path: location.pathname, search: location.search })`);
  assert.equal(here.path, '/flights');
  const got = new URLSearchParams(here.search);
  for (const [k, v] of new URLSearchParams(q)) assert.equal(got.get(k), v, `parameter ${k}`);
});

ui('the clean flights URL (no redirect) shows results too', async (page) => {
  await page.goto(`${BASE}/flights?trip=oneway&from=HYD&to=BLR&depart=${iso(3)}&adults=1&cabin=economy`);
  await page.waitFor(() => document.querySelectorAll('#txFlightList .tx-flight, #txFlightList .jf-trip').length > 0, { timeout: 20000, label: 'flight results' });
  assert.equal(await page.eval('location.pathname'), '/flights');
});

ui('hotels and packages on their clean URLs render their results', async (page) => {
  await page.goto(`${BASE}/hotels`);
  await page.waitFor(() => document.querySelectorAll('#hrCards .hr-card').length > 0, { timeout: 20000, label: 'hotel cards' });
  assert.equal(await page.eval('location.pathname'), '/hotels');
  await page.goto(`${BASE}/packages`);
  await page.waitFor(() => document.body.innerText.length > 800 && !!document.querySelector('.pkl-card, .lp-card, [data-package-id], .tx-card'), { timeout: 20000, label: 'package cards' });
  assert.equal(await page.eval('location.pathname'), '/packages');
});

ui('/index.html?signin=1 lands on /?signin=1 and the sign-in dialog opens', async (page) => {
  await page.goto(`${BASE}/index.html?signin=1`);
  await page.waitFor(() => document.getElementById('authOverlay') && document.getElementById('authOverlay').classList.contains('open'), { timeout: 15000, label: 'sign-in dialog' });
  assert.equal(await page.eval('location.pathname'), '/', 'ends on the clean landing URL');
});

ui('/ itself opens the sign-in dialog with ?signin=1 (the form the site now links to)', async (page) => {
  await page.goto(`${BASE}/?signin=1`);
  await page.waitFor(() => document.getElementById('authOverlay') && document.getElementById('authOverlay').classList.contains('open'), { timeout: 15000, label: 'sign-in dialog' });
});

ui('header, logo and footer link to clean URLs only, on every main public page', async (page) => {
  const audited = JSON.stringify(PAGES);
  for (const path of ['/', '/flights', '/hotels', '/packages', '/about', '/gaming-packages']) {
    await page.goto(BASE + path);
    await sleep(1800);
    const bad = await page.eval(`(() => {
      const pages = ${audited};
      const re = new RegExp('^(?:\\\\./|/)?(' + pages.join('|') + ')\\\\.html(?:[?#]|$)');
      const hrefs = [...document.querySelectorAll('header a[href], nav a[href], footer a[href], .jw-hdr a[href], .jw-footer a[href]')]
        .map(a => a.getAttribute('href'));
      return hrefs.filter(h => re.test(h || ''));
    })()`);
    assert.deepEqual(bad, [], `${path} still links to an audited .html address`);
    const nav = await page.eval(`[...document.querySelectorAll('.jw-hdr__nav a[href], header nav a[href]')].map(a => a.getAttribute('href')).filter(h => /^\\/(flights|hotels|packages|gaming-packages)$/.test(h))`);
    for (const must of ['/flights', '/hotels', '/packages']) assert.ok(nav.includes(must), `${path}: header nav has ${must}`);
  }
});

ui('clicking the header tabs and the logo lands on a clean URL', async (page) => {
  // From any page except the landing page, Flights / Hotels / Tour Packages mean "start a new search": they open the
  // landing page with that product's card (jw-header.js startNew). That used to be index.html?tab=x and is now /?tab=x.
  for (const tab of ['hotels', 'packages', 'flights']) {
    await page.goto(`${BASE}/about`);
    await sleep(1200);
    const href = await page.eval(`(() => { const a = document.querySelector('.jw-hdr__nav a[href="/${tab}"], header nav a[href="/${tab}"]'); if (!a) throw new Error('no header link /${tab}'); const h = a.getAttribute('href'); a.click(); return h; })()`);
    assert.equal(href, `/${tab}`, 'the header link itself is the clean URL');
    await page.waitFor(() => location.pathname === '/', { timeout: 10000, label: `the landing page for a new ${tab} search` });
    // The landing page consumes ?tab= and strips it, so assert on its effect: that product's card is the open one.
    await page.waitFor(() => !!document.querySelector('.search-tab.is-on'), { timeout: 10000, label: 'an open search card' });
    assert.equal(await page.eval(`document.querySelector('.search-tab.is-on').dataset.tab`), tab, `the ${tab} card is open`);
    assert.ok(!/\.html/.test(await page.eval('location.href')), 'no .html in the URL');
  }
  // A modified click keeps the link's own href: that IS the clean product URL.
  await page.goto(`${BASE}/about`);
  await sleep(1200);
  await page.eval(`(() => { const a = document.querySelector('.jw-hdr__nav a[href="/hotels"]'); location.assign(a.href); })()`);
  await page.waitFor(() => location.pathname === '/hotels', { timeout: 10000, label: 'the link target /hotels' });
  // The logo goes home.
  await sleep(1200);
  await page.eval(`document.querySelector('.jw-hdr__logo, header a.logo, a.logo').click()`);
  await page.waitFor(() => location.pathname === '/', { timeout: 10000, label: 'logo -> home' });
});

ui('the footer links work and resolve to 200 on clean URLs', async (page) => {
  await page.goto(`${BASE}/about`);
  await sleep(1500);
  const hrefs = await page.eval(`[...document.querySelectorAll('footer a[href]')].map(a => a.getAttribute('href')).filter(h => h.startsWith('/') && !h.startsWith('//'))`);
  assert.ok(hrefs.length >= 10, `footer has ${hrefs.length} internal links`);
  for (const h of new Set(hrefs)) {
    const r = await get(h.split('#')[0] || '/');
    assert.equal(r.status, 200, `${h} -> ${r.status}`);
    assert.ok(!/\.html(\?|#|$)/.test(h), `${h} is not clean`);
  }
});

ui('canonical and og:url are the clean absolute URL, once, on each indexable page', async (page) => {
  for (const p of ['index', 'flights', 'hotels', 'packages', 'gaming-packages', 'destinations', 'about', 'contact-us', 'faqs', 'privacy-policy']) {
    await page.goto(BASE + clean(p));
    const tags = await page.eval(`({ canon: [...document.querySelectorAll('link[rel="canonical"]')].map(l => l.href),
      og: [...document.querySelectorAll('meta[property="og:url"]')].map(m => m.content) })`);
    const want = SITE + (p === 'index' ? '/' : clean(p));
    assert.deepEqual(tags.canon, [want], `${p}: canonical`);
    assert.deepEqual(tags.og, [want], `${p}: og:url`);
  }
});

ui('CSS, JavaScript and images load on the clean URLs (no failed or 4xx/5xx request)', async (page) => {
  let failures = []; const urls = new Map();
  await page.send('Network.enable');
  page.on('Network.responseReceived', (e) => {
    urls.set(e.requestId, e.response.url);
    if (e.response.status >= 400 && new URL(e.response.url).origin === BASE) failures.push(`${e.response.status} ${e.response.url}`);
  });
  page.on('Network.loadingFailed', (e) => { if (!e.canceled) failures.push(`failed ${e.errorText} ${urls.get(e.requestId) || e.requestId}`); });
  for (const path of ['/', '/flights', '/hotels', '/packages', '/about']) {
    failures = [];
    await page.goto(BASE + path);
    await sleep(3500);
    assert.deepEqual(failures.filter(f => !/favicon/.test(f)), [], `${path}: failed requests`);
  }
});
