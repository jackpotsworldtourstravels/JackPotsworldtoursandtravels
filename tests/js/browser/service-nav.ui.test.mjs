// The header's four service links, in a real browser: Flights, Hotels, Tour Packages, Gaming Tour Packages.
//
// (Gaming Tour Packages is not one of them: it is an enquiry, and its link goes to the enquiry form — see the
// last tests in this file.)
// Flights, Hotels and Tour Packages must open the matching tab of the booking card and bring the hero scene into
// view WHOLE: the "The World Awaits You." headline stays visible (just under the header), the card is below it,
// not covered by the header, with no overlap and no blank band — on a desktop, a tablet and a phone, from the
// landing page and from another page. A plain visit to the landing page is untouched.
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
  const h1 = document.querySelector('.cine-title'); const cs = getComputedStyle(h1.closest('.cine-copy')); const hb = h1.getBoundingClientRect();
  const card = document.querySelector('.search-card').getBoundingClientRect();
  const bar = document.querySelector('#siteHeader .jw-hdr__bar');
  return { svc: document.documentElement.classList.contains('svc-nav'), tab: BookingCard.tab,
    onTab: (document.querySelector('.search-tab.is-on') || {}).dataset.tab,
    titleDisplay: cs.display, titleBox: h1.getClientRects().length, titleTop: Math.round(hb.top), titleBottom: Math.round(hb.bottom),
    cardTop: Math.round(card.top), cardBottom: Math.round(card.bottom), cardRight: Math.round(card.right), cardLeft: Math.round(card.left),
    barH: bar ? bar.offsetHeight : 0, scrollY: Math.round(scrollY), vw: innerWidth, vh: innerHeight,
    hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    heroTop: Math.round(document.querySelector('.cine-hero').getBoundingClientRect().top + scrollY),
    heroH: Math.round(document.querySelector('.cine-hero').getBoundingClientRect().height) }; })()`);

function assertHeroAndCard(s, tab, label) {
  const where = `(header ${s.barH}px, scrollY ${s.scrollY}, title ${s.titleTop}-${s.titleBottom}, card ${s.cardTop}-${s.cardBottom}, viewport ${s.vh})`;
  assert.equal(s.svc, false, label + ': no hidden-hero state');
  assert.equal(s.tab, tab, label + ': BookingCard is on ' + tab);
  assert.equal(s.onTab, tab, label + ': the visible tab is ' + tab);
  assert.notEqual(s.titleDisplay, 'none', label + ': the headline block is shown');
  assert.ok(s.titleBox > 0, label + ': the headline has a layout box');
  assert.ok(s.titleTop >= s.barH - 2 && s.titleBottom <= s.vh, `${label}: the headline is fully visible, below the header ${where}`);
  assert.ok(s.titleBottom <= s.cardTop + 2, `${label}: the headline does not overlap the card ${where}`);
  assert.ok(s.cardTop >= s.barH && s.cardTop < s.vh, `${label}: the card starts below the header and on screen ${where}`);
  assert.ok(s.cardLeft >= 0 && s.cardRight <= s.vw + 1, label + ': the card is within the viewport width');
  assert.ok(s.heroH >= s.vh * 0.9, `${label}: the hero keeps its normal height (${s.heroH}px of ${s.vh}px)`);
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
    ui(`${label} link on the landing page: tab active, headline visible, card clear of the header (${name})`, async (page) => {
      await open(page, viewport);
      await clickHeader(page, href, viewport);
      await settled(page);
      const s = await state(page);
      assertHeroAndCard(s, tab, label);
    });

    ui(`${label} link from another page lands on the hero with its card on the right tab (${name})`, async (page) => {
      await open(page, viewport, '/about.html', false);
      await page.waitFor(() => !!document.querySelector('.jw-hdr__nav'), { label: 'the header' });
      await clickHeader(page, href, viewport);
      await page.waitFor(() => /(^|\/)(index\.html)?$/.test(location.pathname) && !!document.querySelector('.search-card'), { label: 'the landing page' });
      await page.waitFor(() => typeof BookingCard !== 'undefined' && !!document.querySelector('.search-tab.is-on'));
      await sleep(900);
      await settled(page);
      assertHeroAndCard(await state(page), tab, label + ' (arrival)');
      assert.equal(await page.eval(`new URLSearchParams(location.search).has('tab')`), false, 'the existing behaviour: ?tab is dropped from the address');
    });
  }
}

ui('repeated navigation between services keeps the right tab, and the headline stays', async (page) => {
  await open(page, DESKTOP);
  for (const [href, tab, label] of [...LINKS, LINKS[1], LINKS[0]]) {
    await clickHeader(page, href, DESKTOP);
    await settled(page);
    assertHeroAndCard(await state(page), tab, 'again: ' + label);
  }
});

ui('the card stays usable after the header link: fields visible, validation intact, hotels and packages panels work', async (page) => {
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
    assert.ok(f.shown && f.top >= 0, tab + ': its main field is on screen and not under the header');
  }
});

ui('the Gaming link on the Gaming enquiry page itself does not bounce the visitor away', async (page) => {
  await open(page, DESKTOP, '/gaming-packages.html', false);
  await page.waitFor(() => !!document.querySelector('.jw-hdr__nav'), { label: 'the header' });
  await page.eval(`document.querySelector('.jw-hdr__nav a[href="gaming-packages.html"]').click()`);
  await sleep(800);
  assert.match(await page.eval('location.pathname'), /gaming-packages/);
});

ui('a plain visit after using the header links is the normal homepage', async (page) => {
  await open(page, DESKTOP);
  await clickHeader(page, 'hotels.html', DESKTOP);
  await settled(page);
  await page.goto(BASE + '/');                                   // the logo / a fresh visit
  await page.waitFor(() => !!document.querySelector('.cine-title'));
  const s = await state(page);
  assert.equal(s.svc, false);
  assert.ok(s.titleBox > 0);
});

ui('clicked while scrolled far down the page, the link brings the headline and card back into view', async (page) => {
  await open(page, DESKTOP);
  await page.eval('window.scrollTo(0, 2400)');
  await sleep(600);
  assert.ok(await page.eval('scrollY') > 1500, 'the page really is scrolled down');
  await clickHeader(page, 'hotels.html', DESKTOP);
  await settled(page);
  const s = await state(page);
  assertHeroAndCard(s, 'hotels', 'from far down');
});

// ===========================================================================
// Gaming Tour Packages: the header link and the booking card's Gaming tab lead to the SAME enquiry page
// ===========================================================================
const GAMING_PAGE = /\/gaming-packages(\.html)?$/;

for (const [name, viewport] of [['desktop 1366', DESKTOP], ['tablet 820', TABLET], ['phone 390', PHONE]]) {
  ui(`Gaming header link on the landing page opens the enquiry form, not the card (${name})`, async (page) => {
    await open(page, viewport);
    const before = await page.eval('scrollY');
    await clickHeader(page, 'gaming-packages.html', viewport);
    await page.waitFor(() => /\/gaming-packages(\.html)?$/.test(location.pathname), { label: 'the enquiry page' });
    assert.equal(await page.eval('location.search'), '', 'no stray parameters');
    await page.waitFor(() => !!document.querySelector('form'), { label: 'the enquiry form' });
    assert.equal(await page.eval(`document.documentElement.classList.contains('svc-nav')`), false);
    assert.equal(before, 0);
  });

  ui(`Gaming header link from another page opens the enquiry form (${name})`, async (page) => {
    await open(page, viewport, '/about.html', false);
    await page.waitFor(() => !!document.querySelector('.jw-hdr__nav'), { label: 'the header' });
    await clickHeader(page, 'gaming-packages.html', viewport);
    await page.waitFor(() => /\/gaming-packages(\.html)?$/.test(location.pathname), { label: 'the enquiry page' });
    assert.equal(await page.eval('location.search'), '');
  });
}

ui('the card own Gaming tab leads to the same page as the header link', async (page) => {
  await open(page, DESKTOP);
  await page.eval(`document.querySelector('.search-tab[data-tab="gaming"]').click()`);
  await page.waitFor(() => /\/gaming-packages(\.html)?$/.test(location.pathname), { label: 'the enquiry page' });
  const viaCard = await page.eval('location.pathname + location.search');
  await open(page, DESKTOP);
  await clickHeader(page, 'gaming-packages.html', DESKTOP);
  await page.waitFor(() => /\/gaming-packages(\.html)?$/.test(location.pathname), { label: 'the enquiry page' });
  assert.equal(await page.eval('location.pathname + location.search'), viaCard, 'one destination, whichever door was used');
});

ui('the Gaming enquiry form loads with its fields and its Gaming link stays put', async (page) => {
  await open(page, DESKTOP, '/gaming-packages.html', false);
  await page.waitFor(() => !!document.querySelector('form') && document.querySelectorAll('form input, form select, form textarea').length >= 4, { label: 'the form fields' });
  const submit = await page.eval(`!!document.querySelector('form button[type="submit"], form [type="submit"]')`);
  assert.equal(submit, true, 'it can still be submitted');
  await page.waitFor(() => !!document.querySelector('.jw-hdr__nav'));
  await page.eval(`document.querySelector('.jw-hdr__nav a[href="gaming-packages.html"]').click()`);
  await sleep(700);
  assert.match(await page.eval('location.pathname'), GAMING_PAGE);
});
