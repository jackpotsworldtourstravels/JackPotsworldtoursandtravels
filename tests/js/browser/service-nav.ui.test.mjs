// The header's four service links, in a real browser: Flights, Hotels, Tour Packages, Gaming Tour Packages.
//
// Each must open the matching tab of the booking card, REMOVE the "The World Awaits You." headline (not
// scroll it off-screen), collapse the hero so no blank band is left, and park the card directly under
// the fixed header — on a desktop and on a phone, from the landing page and from another page.
//
//     JPW_BASE=http://127.0.0.1:8000 node --test tests/js/browser/service-nav.ui.test.mjs
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null;
let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

function ui(name, fn) {
  test(name, { timeout: 120000 }, async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const page = await chrome.newPage();
    try { await fn(page, t); } finally { page.close(); }
  });
}

const LINKS = [
  ['flights.html', 'flights', 'Flights'],
  ['hotels.html', 'hotels', 'Hotels'],
  ['packages.html', 'packages', 'Tour Packages'],
  ['gaming-packages.html', 'gaming', 'Gaming Tour Packages'],
];
const DESKTOP = { width: 1366, height: 768, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };
const TABLET = { width: 820, height: 1180, mobile: false, drawer: true };   // the nav lives in the drawer below ~1360px
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function open(page, viewport, path = '/', needCard = true) {
  await page.viewport(viewport);
  await page.goto(BASE + path);
  await page.eval('sessionStorage.clear(); localStorage.removeItem("jp_search_tab")');
  if (!needCard) return;
  await page.waitFor(() => !!document.querySelector('.search-card') && typeof BookingCard !== 'undefined', { label: 'the booking card' });
  await page.waitFor(() => !document.documentElement.classList.contains('cine-pre'), { label: 'the opening sequence', timeout: 6000 }).catch(() => {});
}

/** Click a header link the way a visitor does: in the bar on a desktop, in the drawer on a phone. */
async function clickHeader(page, href, viewport) {
  if (viewport.mobile || viewport.drawer) {
    await page.eval(`document.querySelector('.jw-hdr__burger').click()`);
    await page.waitFor(() => { const d = document.getElementById('jwDrawer'); return d && !d.hidden && d.classList.contains('is-open'); }, { label: 'the drawer' });
    await page.eval(`document.querySelector('#jwDrawer a[href="${href}"]').click()`);
  } else {
    await page.eval(`document.querySelector('.jw-hdr__nav a[href="${href}"]').click()`);
  }
}

/** Wait until the card has stopped moving: the scroll has landed. */
async function settled(page) {
  let last = null; let same = 0;
  for (let i = 0; i < 80 && same < 5; i++) {
    const y = await page.eval(`Math.round(document.querySelector('.search-card').getBoundingClientRect().top)`);
    same = (y === last) ? same + 1 : 0; last = y;
    await sleep(80);
  }
}

const state = (page) => page.eval(`(() => {
  const h1 = document.querySelector('.cine-title'); const cs = getComputedStyle(h1.closest('.cine-copy'));
  const card = document.querySelector('.search-card').getBoundingClientRect();
  const bar = document.querySelector('#siteHeader .jw-hdr__bar');
  return { svc: document.documentElement.classList.contains('svc-nav'), tab: BookingCard.tab,
    onTab: (document.querySelector('.search-tab.is-on') || {}).dataset.tab,
    titleDisplay: cs.display, titleBox: h1.getClientRects().length, titleText: h1.offsetParent === null,
    cardTop: Math.round(card.top), cardBottom: Math.round(card.bottom), cardRight: Math.round(card.right), cardLeft: Math.round(card.left),
    barH: bar ? bar.offsetHeight : 0, scrollY: Math.round(scrollY), vw: innerWidth, vh: innerHeight,
    hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    heroTop: Math.round(document.querySelector('.cine-hero').getBoundingClientRect().top + scrollY),
    heroH: Math.round(document.querySelector('.cine-hero').getBoundingClientRect().height) }; })()`);

function assertServiceView(s, tab, label) {
  assert.equal(s.svc, true, label + ': the service view is on');
  assert.equal(s.tab, tab, label + ': BookingCard is on ' + tab);
  assert.equal(s.onTab, tab, label + ': the visible tab is ' + tab);
  assert.equal(s.titleDisplay, 'none', label + ': the headline block is display:none');
  assert.equal(s.titleBox, 0, label + ': the headline has no layout box at all');
  const under = s.cardTop - s.barH;
  assert.ok(under >= 0 && under <= 40, `${label}: the card sits right under the header (gap ${under}px, header ${s.barH}px, scrollY ${s.scrollY}, hero ${s.heroTop}/${s.heroH})`);
  assert.ok(s.cardLeft >= 0 && s.cardRight <= s.vw + 1, label + ': the card is within the viewport width');
  assert.equal(s.hScroll, false, label + ': no horizontal scroll');
}

for (const [name, viewport] of [['desktop 1366', DESKTOP], ['tablet 820', TABLET], ['phone 390', PHONE]]) {
  ui(`normal homepage keeps its hero (${name})`, async (page) => {
    await open(page, viewport);
    const s = await state(page);
    assert.equal(s.svc, false, 'no service view on a plain visit');
    assert.notEqual(s.titleDisplay, 'none');
    assert.ok(s.titleBox > 0, 'the headline is laid out');
    assert.match(await page.eval(`document.querySelector('.cine-title').textContent.replace(/\\s+/g, ' ').trim()`), /The World\s*Awaits You\./);
    assert.ok(s.heroH >= s.vh * 0.9, 'the hero is still the full-screen scene (' + s.heroH + 'px of ' + s.vh + ')');
  });

  for (const [href, tab, label] of LINKS) {
    ui(`${label} link on the landing page: tab, hidden headline, card under the header (${name})`, async (page) => {
      await open(page, viewport);
      await clickHeader(page, href, viewport);
      await settled(page);
      const s = await state(page);
      assertServiceView(s, tab, label);
      // the headline is gone from the layout — not merely above the fold
      assert.equal(await page.eval(`document.querySelector('.cine-title').getBoundingClientRect().height`), 0);
    });

    ui(`${label} link from another page lands on the card with the hero hidden (${name})`, async (page) => {
      await open(page, viewport, '/about.html', false);
      await page.waitFor(() => !!document.querySelector('.jw-hdr__nav'), { label: 'the header' });
      await clickHeader(page, href, viewport);
      await page.waitFor(() => /(^|\/)(index\.html)?$/.test(location.pathname) && !!document.querySelector('.search-card'), { label: 'the landing page' });
      await page.waitFor(() => typeof BookingCard !== 'undefined' && !!document.querySelector('.search-tab.is-on'));
      assert.equal(await page.eval(`document.documentElement.classList.contains('svc-nav')`), true, 'set before the page was shown');
      await sleep(900);
      await settled(page);
      assertServiceView(await state(page), tab, label + ' (arrival)');
      assert.equal(await page.eval(`new URLSearchParams(location.search).has('tab')`), false, 'the existing behaviour: ?tab is dropped from the address');
    });
  }
}

ui('repeated navigation between services keeps the right tab and never brings the headline back', async (page) => {
  await open(page, DESKTOP);
  for (const [href, tab, label] of [...LINKS, LINKS[1], LINKS[0]]) {
    await clickHeader(page, href, DESKTOP);
    await settled(page);
    assertServiceView(await state(page), tab, 'again: ' + label);
  }
});

ui('the card stays usable in the service view: fields visible, validation intact, hotels and packages panels work', async (page) => {
  await open(page, DESKTOP);
  await clickHeader(page, 'flights.html', DESKTOP);
  await settled(page);
  // validation: the same airport at both ends is still refused by the card
  const refused = await page.eval(`(async () => {
    const set = (id, key, text) => { const e = document.getElementById(id); e.value = text; e.dataset.key = key; };
    set('fFrom', 'DEL', 'Delhi (DEL)'); set('fTo', 'DEL', 'Delhi (DEL)');
    document.querySelector('.search-go').click(); await new Promise(r => setTimeout(r, 300));
    return location.pathname.endsWith('flights.html') ? 'navigated' : (document.getElementById('searchError') || document.querySelector('.search-error') || {}).textContent || 'stayed'; })()`);
  assert.notEqual(refused, 'navigated', 'an invalid search did not run');
  for (const [href, tab, panelField] of [['hotels.html', 'hotels', 'hDest'], ['packages.html', 'packages', 'pType']]) {
    await clickHeader(page, href, DESKTOP);
    await settled(page);
    const f = await page.eval(`(() => { const e = document.getElementById('${panelField}'); const r = e.getBoundingClientRect();
      return { shown: r.width > 0 && r.height > 0, top: r.top, bottom: r.bottom, vh: innerHeight, active: BookingCard.tab }; })()`);
    assert.equal(f.active, tab);
    assert.ok(f.shown && f.top >= 0 && f.bottom <= f.vh, tab + ': its main field is on screen and not clipped');
  }
});

ui('the Gaming link on the Gaming enquiry page itself does not bounce the visitor away', async (page) => {
  await open(page, DESKTOP, '/gaming-packages.html', false);
  await page.waitFor(() => !!document.querySelector('.jw-hdr__nav'), { label: 'the header' });
  await page.eval(`document.querySelector('.jw-hdr__nav a[href="gaming-packages.html"]').click()`);
  await sleep(800);
  assert.match(await page.eval('location.pathname'), /gaming-packages/);
});

ui('returning to the plain landing page restores the hero', async (page) => {
  await open(page, DESKTOP);
  await clickHeader(page, 'hotels.html', DESKTOP);
  await settled(page);
  assert.equal((await state(page)).svc, true);
  await page.goto(BASE + '/');                                   // the logo / a fresh visit
  await page.waitFor(() => !!document.querySelector('.cine-title'));
  const s = await state(page);
  assert.equal(s.svc, false);
  assert.ok(s.titleBox > 0);
});

ui('clicked while scrolled far down the page, the link brings the card to just under the header', async (page) => {
  await open(page, DESKTOP);
  await page.eval('window.scrollTo(0, 2400)');
  await sleep(600);
  assert.ok(await page.eval('scrollY') > 1500, 'the page really is scrolled down');
  await clickHeader(page, 'hotels.html', DESKTOP);
  await settled(page);
  const s = await state(page);
  assertServiceView(s, 'hotels', 'from far down');
});
