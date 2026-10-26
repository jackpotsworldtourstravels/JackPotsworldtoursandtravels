// The global header carries neither Wishlist (heart) nor My trips (suitcase) — no browser, no network.
//
// Run:  node --test tests/js/header-icons.test.mjs
//
// WHAT THIS PINS
//   jw-header.js   the one header definition every page renders: the markup it returns has no Wishlist or
//                  My trips control (bar or mobile drawer) and still has the logo, the five links, the
//                  notification bell, Partners, the profile slot and the burger
//   index.html     carries a static copy of that markup for crawlers; it must match
//   hero-shell.js  its fallback header (pages without jw-header.js) has neither control either
//   every *.html   no page ships a header control that opens the Wishlist or Bookings tab of the Account Center
// The wishlist and bookings FEATURES (wishlist.js, the Account Center tabs, the hotel/package save hearts,
// my-bookings.html) are not header controls and are deliberately untouched; the last test pins that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function headerMarkup(active = 'index.html') {
  const ctx = { window: {}, document: {} };
  vm.createContext(ctx);
  vm.runInContext(read('assets/js/jw-header.js') + '\nthis.JWHeader = JWHeader;', ctx);
  return ctx.JWHeader.html(active);
}

const GONE = [/data-nav-acct="wishlist"/, /data-nav-acct="bookings"/, /aria-label="Wishlist"/, /aria-label="My trips"/,
  /data-ds-tip="Wishlist"/, /data-ds-tip="My trips"/, /My trips/i, /my-bookings\.html/];

test('JWHeader.html has no Wishlist or My trips control, in the bar or the drawer', () => {
  for (const active of ['index.html', 'flights.html', 'hotels.html', 'packages.html']) {
    const html = headerMarkup(active);
    for (const re of GONE) assert.ok(!re.test(html), `${active}: header still matches ${re}`);
  }
});

test('JWHeader.html keeps every other header element', () => {
  const html = headerMarkup('flights.html');
  for (const label of ['Flights', 'Hotels', 'Tour Packages', 'Gaming Tour Packages', 'Contact'])
    assert.ok(html.includes(`<span>${label}</span>`), `missing nav link ${label}`);
  for (const href of ['flights.html', 'hotels.html', 'packages.html', 'gaming-packages.html', 'index.html#jwFContact'])
    assert.ok(html.includes(`href="${href}"`), `missing href ${href}`);
  assert.ok(html.includes('jw-hdr__logo'), 'logo');
  assert.ok(html.includes('data-nav-acct="notifications"'), 'notification bell');
  assert.ok(html.includes('jw-hdr__partner'), 'Partners button');
  assert.ok(html.includes('data-profile-menu'), 'guest/profile menu slot');
  assert.ok(html.includes('jw-hdr__burger'), 'mobile menu button');
  assert.ok(html.includes('partner-login.html'), 'drawer partner link');
  assert.ok(html.includes('aria-current="page"'), 'current page marker');
  assert.equal((html.match(/jw-hdr__icon/g) || []).length, 1, 'the bell is the only icon button left');
});

test('index.html static header matches the shared markup (no Wishlist / My trips)', () => {
  const page = read('index.html');
  const start = page.indexOf('<div class="jw-hdr__bar">');
  assert.ok(start > 0, 'static header present');
  const end = page.indexOf('</header>', start);
  const staticHdr = page.slice(start, end);
  for (const re of GONE) assert.ok(!re.test(staticHdr), `index.html header still matches ${re}`);
  assert.ok(staticHdr.includes('data-nav-acct="notifications"'));
  assert.equal((staticHdr.match(/jw-hdr__icon/g) || []).length, 1);
});

test('the hero-shell fallback header has neither control', () => {
  const src = read('assets/js/hero-shell.js');
  const a = src.indexOf('function headerHtml');
  const b = src.indexOf('Footer', a);
  const fn = src.slice(a, b);
  assert.ok(!/data-nav-acct="wishlist"/.test(fn) && !/class="hr-wish/.test(fn), 'wishlist control');
  assert.ok(!/data-nav-acct="bookings"/.test(fn), 'my bookings control');
  assert.ok(/data-nav-acct="notifications"/.test(fn), 'bell stays');
});

test('no page ships a header control for Wishlist or Bookings', () => {
  const pages = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!['assets', 'tests'].includes(e.name)) walk(path.join(d, e.name)); }
      else if (e.name.endsWith('.html')) pages.push(path.join(d, e.name));
    }
  })(ROOT);
  assert.ok(pages.length > 20, 'found the site pages');
  for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    assert.ok(!/<(button|a)\b[^>]*data-nav-acct="(wishlist|bookings)"/.test(html), `${path.relative(ROOT, p)} has a header opener`);
    assert.ok(!/class="[^"]*jw-hdr__icon[^"]*"[^>]*aria-label="(Wishlist|My trips)"/.test(html), `${path.relative(ROOT, p)} has a header icon`);
  }
});

test('the features themselves are untouched', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/js/wishlist.js')), 'wishlist.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'my-bookings.html')), 'my-bookings.html');
  const idx = read('index.html');
  assert.ok(idx.includes('data-tab="wishlist"') && idx.includes('id="acctPanel-wishlist"'), 'Account Center wishlist tab');
  assert.ok(read('assets/js/hotel-results.js').toLowerCase().includes('wishlist'), 'hotel save hearts');
});
