// The controls that are the product, driven at each of the seven target viewports (375x667, 393x852, 412x968,
// 768x1024, 960x1440, 1004x764, 1280x800): the header menu, the landing search card's three tabs, the flight and hotel
// results with their filters and booking steps, the date field, the gaming enquiry form, a fold / unfold change of
// viewport without a reload, and the keyboard.
//
// The date field itself is the browser's native <input type=date> picker, which lives outside the page and cannot be
// driven or measured from here: what is checked is that opening it throws nothing and does not widen the page.
//
// JPW_AUDIT=1 prints findings without failing.
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';
import { VIEWPORTS, MEASURE, flightsPath, openPage as open, report, sleep } from './responsive-helpers.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

const HS = 'document.documentElement.scrollWidth > innerWidth + 1';
const box = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width) }; })()`;

test('the header menu opens, fits the screen, and closes with Escape', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const { page, errors } = await open(chrome, '/', w, h);
    try {
      const at = ` @${w}x${h}`;
      const burger = await page.eval(`(() => { const b = document.querySelector('.jw-hdr__burger'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 && getComputedStyle(b).display !== 'none' ? { l: r.left, r: r.right } : null; })()`);
      if (burger) {
        if (burger.l < 0 || burger.r > w) problems.push('the menu button is off-screen' + at);
        await page.eval(`document.querySelector('.jw-hdr__burger').click()`);
        await page.waitFor(() => !document.getElementById('jwDrawer').hidden, { label: 'the drawer' });
        await sleep(500);
        const d = await page.eval(box('#jwDrawer'));
        if (!d || d.l < -1 || d.r > w + 1) problems.push(`the menu drawer is outside the screen (${d && d.l}..${d && d.r})` + at);
        const links = await page.eval(`[...document.querySelectorAll('#jwDrawer a')].filter(a => a.getBoundingClientRect().width > 0).length`);
        if (links < 4) problems.push(`only ${links} link(s) visible in the menu` + at);
        if (await page.eval(HS)) problems.push('sideways scroll with the menu open' + at);
        await page.key('Escape');
        await sleep(500);
        if (await page.eval(`document.querySelector('.jw-hdr__burger').getAttribute('aria-expanded') === 'true'`)) problems.push('Escape does not close the menu' + at);
      } else {
        const nav = await page.eval(`(() => [...document.querySelectorAll('header a')].filter(a => /flights|hotels|tour packages/i.test(a.textContent) && a.getBoundingClientRect().width > 0).map(x => { const r = x.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }))()`);
        if (nav.length < 3) problems.push(`the header shows ${nav.length} of the 3 service links and no menu button` + at);
        if (nav.some(([l, r]) => l < 0 || r > w)) problems.push('a header link is off-screen' + at);
      }
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  report(problems, 'header menu');
});

test('the landing search card: the Flights, Hotels and Tour Packages tabs fit and switch', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const { page, errors } = await open(chrome, '/', w, h);
    try {
      for (const tab of ['flights', 'hotels', 'packages']) {
        const at = ` ${tab} @${w}x${h}`;
        const ok = await page.eval(`(() => { const b = document.querySelector('.search-tab[data-tab="${tab}"]'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
        if (!ok) { problems.push('no tab button' + at); continue; }
        await sleep(450);
        const s = await page.eval(`(() => { const R = (e) => e.getBoundingClientRect(), on = document.querySelector('.search-tab.is-on'), card = document.querySelector('.search-card');
          const tabs = [...document.querySelectorAll('.search-tab')].filter(b => R(b).width > 0).map(b => { const r = R(b); return [b.dataset.tab, Math.round(r.left), Math.round(r.right)]; });
          const panel = card && [...card.querySelectorAll('.search-panel')].find(p => R(p).width > 0 && getComputedStyle(p).display !== 'none');
          const scrolls = (e) => { for (let n = e.parentElement; n && n !== card; n = n.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(n).overflowX) && R(n).right <= innerWidth + 1) return true; } return false; };   // a row that scrolls itself (the special-fare chips) may hold controls past the edge
          const fields = panel ? [...panel.querySelectorAll('input:not([type=hidden]), button, select')].filter(e => R(e).width > 0 && !scrolls(e)).map(e => { const r = R(e); return [Math.round(r.left), Math.round(r.right)]; }) : [];
          const go = card && [...card.querySelectorAll('button')].find(b => /^search/i.test(b.textContent.trim()) && R(b).width > 0);
          return { on: on && on.dataset.tab, tabs, nFields: fields.length, outFields: fields.filter(([l, r]) => l < -1 || r > innerWidth + 1).length, go: !!go, goIn: go ? (R(go).left >= -1 && R(go).right <= innerWidth + 1) : false, hs: ${HS} }; })()`);
        if (s.on !== tab) problems.push(`the ${tab} tab does not become active (on: ${s.on})` + at);
        const mine = s.tabs.filter(([n]) => ['flights', 'hotels', 'packages'].includes(n));
        if (mine.length < 3 || mine.some(([, l, r]) => l < -1 || r > w + 1)) problems.push('a required tab is cut off: ' + JSON.stringify(mine) + at);
        if (!s.nFields) problems.push('the panel shows no controls' + at);
        if (s.outFields) problems.push(`${s.outFields} control(s) outside the viewport` + at);
        if (!s.go || !s.goIn) problems.push('the Search button is missing or outside the viewport' + at);
        if (s.hs) problems.push('sideways scroll' + at);
      }
      errors.forEach(e => problems.push('script error: ' + e + ` @${w}x${h}`));
    } finally { page.close(); }
  }
  report(problems, 'landing search card');
});

test('flight results: filters open, cards fit, the booking sheet and Fare Summary fit', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    const { page, errors } = await open(chrome, flightsPath(), w, h);
    try {
      await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 12000, label: 'flights' });
      const toggle = await page.eval(`(() => { const b = document.getElementById('txFilterToggle'); return !!b && b.getBoundingClientRect().width > 0; })()`);
      if (toggle) {
        await page.eval(`document.getElementById('txFilterToggle').click()`); await sleep(500);
        const f = await page.eval(box('#txFilters'));
        if (!f || f.w === 0 || f.l < -1 || f.r > w + 1) problems.push('flight filters do not open inside the screen' + at);
        await page.key('Escape'); await sleep(300);
      }
      const c = await page.eval(box('#txFlightList .tx-flight'));
      if (c.l < -1 || c.r > w + 1) problems.push('a flight card is outside the viewport' + at);
      await page.eval(`document.querySelector('.jf-select').click()`);
      await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight'), { label: 'the booking sheet' });
      await sleep(900);
      const sh = await page.eval(`(() => { const s = document.querySelector('.bk-sheet.is-flight').getBoundingClientRect(); const b = [...document.querySelectorAll('button')].find(e => /^continue to traveller/i.test(e.textContent.trim()) && e.getBoundingClientRect().width > 0); const br = b && b.getBoundingClientRect(); const p = document.querySelector('.bk-sheet.is-flight .bk-price'); const pr = p && p.getBoundingClientRect();
        return { sl: s.left, sr: s.right, btn: !!b, btnIn: !!br && br.left >= -1 && br.right <= innerWidth + 1, price: !!p, priceIn: !!pr && pr.left >= -1 && pr.right <= innerWidth + 1, hs: ${HS} }; })()`);
      if (sh.sl < -1 || sh.sr > w + 1) problems.push('the booking sheet is wider than the screen' + at);
      if (!sh.btn || !sh.btnIn) problems.push('Continue to traveller details is missing or off-screen' + at);
      if (!sh.price || !sh.priceIn) problems.push('the Fare Summary is missing or off-screen' + at);
      if (sh.hs) problems.push('sideways scroll in the booking sheet' + at);
      errors.forEach(e => problems.push('script error (flights): ' + e + at));
    } finally { page.close(); }
  }
  report(problems, 'flight results and booking sheet');
});

test('hotel results: filters open, cards fit, a hotel can be chosen and its Booking Summary fits', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    const { page, errors } = await open(chrome, '/hotels.html', w, h);
    try {
      await page.waitFor(() => document.querySelectorAll('#hrCards .hr-card').length > 0, { timeout: 12000, label: 'hotels' });
      const toggle = await page.eval(`(() => { const b = document.getElementById('hrFilterOpen'); return !!b && b.getBoundingClientRect().width > 0; })()`);
      if (toggle) {
        await page.eval(`document.getElementById('hrFilterOpen').click()`); await sleep(500);
        const f = await page.eval(box('#hrFilters'));
        if (!f || f.w === 0 || f.l < -1 || f.r > w + 1) problems.push('hotel filters do not open inside the screen' + at);
        await page.key('Escape'); await sleep(300);
      }
      const c = await page.eval(box('#hrCards .hr-card'));
      if (c.l < -1 || c.r > w + 1) problems.push('a hotel card is outside the viewport' + at);
      await page.eval(`[...document.querySelector('#hrCards .hr-card').querySelectorAll('button')].find(b => /^select$/i.test(b.textContent.trim())).click()`);
      await page.waitFor(() => { const b = document.getElementById('hrContinue'); return b && !b.disabled; }, { label: 'Continue' });
      const bar = await page.eval(`(() => { const b = document.getElementById('hrContinue').getBoundingClientRect(); return { l: b.left, r: b.right, b: b.bottom, hs: ${HS} }; })()`);
      if (bar.l < -1 || bar.r > w + 1 || bar.b > h + 1) problems.push('the Continue button is off-screen after choosing a hotel' + at);
      if (bar.hs) problems.push('sideways scroll after choosing a hotel' + at);
      await page.eval(`document.getElementById('hrContinue').click()`);
      await page.waitFor(() => !!document.querySelector('#hdSummary .hr-summary'), { label: 'the Booking Summary' });
      await sleep(700);
      const sm = await page.eval(`(() => { const r = document.querySelector('#hdSummary .hr-summary').getBoundingClientRect(); return { l: r.left, r: r.right, hs: ${HS} }; })()`);
      if (sm.l < -1 || sm.r > w + 1) problems.push('the Booking Summary is outside the viewport' + at);
      if (sm.hs) problems.push('sideways scroll on the hotel details step' + at);
      errors.forEach(e => problems.push('script error (hotels): ' + e + at));
    } finally { page.close(); }
  }
  report(problems, 'hotel results and booking steps');
});

test('the date field opens without error; the gaming enquiry form is usable', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    const { page, errors } = await open(chrome, '/', w, h);
    try {
      await page.eval(`(() => { const f = document.getElementById('fDep'); f.scrollIntoView({ block: 'center' }); f.click(); })()`);
      await sleep(600);
      if (await page.eval(HS)) problems.push('sideways scroll with the date field open' + at);
      await page.key('Escape'); await sleep(300);
      errors.forEach(e => problems.push('script error (date): ' + e + at));
    } finally { page.close(); }
    const g = await open(chrome, '/gaming-packages.html', w, h);
    try {
      const f = await g.page.eval(`(() => { const fs = [...document.querySelectorAll('form input:not([type=hidden]), form select, form textarea, form button')].filter(e => e.getBoundingClientRect().width > 0); const out = fs.filter(e => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).length; return { n: fs.length, out, hs: ${HS} }; })()`);
      if (!f.n) problems.push('the gaming enquiry form shows no controls' + at);
      if (f.out) problems.push(`${f.out} enquiry control(s) outside the viewport` + at);
      if (f.hs) problems.push('sideways scroll on the enquiry page' + at);
      g.errors.forEach(e => problems.push('script error (gaming): ' + e + at));
    } finally { g.page.close(); }
  }
  report(problems, 'date field and enquiry form');
});

test('folding and unfolding: changing the viewport 412 <-> 768 <-> 960 without a reload keeps every page whole', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const path of ['/', '/flights.html', '/hotels.html', '/packages.html']) {
    const { page, errors } = await open(chrome, path, 412, 968);
    try {
      for (const [w, h] of [[768, 1024], [412, 968], [960, 1440], [412, 968]]) {
        await page.viewport({ width: w, height: h, mobile: w <= 480 });
        await sleep(700);
        const m = await page.eval(MEASURE);
        const at = ` ${path} resized to ${w}x${h}`;
        if (m.hScroll) problems.push(`sideways scroll (${m.sw}px)` + at);
        m.out.forEach(o => problems.push('sticks out: ' + o + at));
        if (!m.header) problems.push('no visible header' + at);
      }
      errors.forEach(e => problems.push('script error: ' + e + ` ${path}`));
    } finally { page.close(); }
  }
  report(problems, 'fold / unfold');
});

test('keyboard: Tab walks through the page with a visible focus ring, at a phone and a landscape-tablet width', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of [[393, 852], [1004, 764]]) {
    const { page } = await open(chrome, '/', w, h);
    try {
      const seen = new Set(); let ringless = 0;
      for (let i = 0; i < 40; i++) {
        await page.key('Tab');
        const f = await page.eval(`(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e);
          return { k: e.tagName + '#' + e.id + '.' + (e.className || '').toString().split(' ')[0], ring: cs.outlineStyle !== 'none' || /rgb/.test(cs.boxShadow) }; })()`);
        if (f) { seen.add(f.k); if (!f.ring) ringless++; }
      }
      const at = ` @${w}x${h}`;
      if (seen.size < 12) problems.push(`Tab visited only ${seen.size} distinct controls in 40 presses` + at);
      if (ringless > 6) problems.push(`${ringless} of 40 focused controls showed no focus ring` + at);
    } finally { page.close(); }
  }
  report(problems, 'keyboard');
});

test('desktop with a mouse is unchanged: the touch-target rules do not apply at 1440 and 1920', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of [[1440, 900], [1920, 1080]]) {
    const page = await chrome.newPage();
    try {
      await page.viewport({ width: w, height: h, mobile: false });
      for (const path of ['/about.html', '/flights.html', '/', '/register.html']) {
        await page.goto(BASE + path); await sleep(1200);
        const r = await page.eval(`(() => { const out = {}; const pick = (k, sel) => { const e = document.querySelector(sel); if (e) { const cs = getComputedStyle(e); out[k] = cs.paddingTop + '/' + cs.marginTop + '/' + cs.display; } };
          pick('crumb', '.sp-crumb a'); pick('footerLegal', '.bf-links a'); pick('pax', '.pax-trigger'); const tr = document.querySelector('.terms-row'); if (tr) out.terms = getComputedStyle(tr).minHeight; out.coarse = matchMedia('(pointer: coarse)').matches; return out; })()`);
        const at = ` ${path} @${w}x${h}`;
        if (r.coarse) problems.push('the test browser reports a coarse pointer' + at);
        if (r.crumb && r.crumb !== '0px/0px/inline') problems.push('breadcrumb link changed on desktop: ' + r.crumb + at);
        if (r.footerLegal && /^9px/.test(r.footerLegal)) problems.push('footer link padded on desktop: ' + r.footerLegal + at);
        if (r.pax && r.pax.startsWith('9px')) problems.push('passengers button padded on desktop: ' + r.pax + at);
        if (r.terms && r.terms !== '0px') problems.push('the register terms row has a min-height on desktop (' + r.terms + '); it must keep the compact row' + at);
      }
    } finally { page.close(); }
  }
  report(problems, 'desktop unchanged');
});

test('the floating assistant takes taps only on its visible circles: the closed menu is click-through, the button and the opened circles work', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const { page, errors } = await open(chrome, '/', w, h);
    try {
      const at = ` @${w}x${h}`;
      await sleep(600);
      const closed = await page.eval(`(() => { const m = document.getElementById('fabMenu'), it = document.getElementById('fabItems'), main = document.getElementById('fabMainBtn'); if (!m || !it || !main) return null;
        const ir = it.getBoundingClientRect(), mr = m.getBoundingClientRect(), br = main.getBoundingClientRect();
        const caught = []; for (let y = ir.top + 4; y < br.top - 2; y += 20) for (const x of [ir.left + 4, (ir.left + ir.right) / 2, ir.right - 4]) { const e = document.elementFromPoint(x, y); if (e && m.contains(e)) caught.push(Math.round(x) + ',' + Math.round(y)); }
        const c = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
        return { caught: caught.length, sample: caught.slice(0, 3), mainHit: !!c && main.contains(c), tall: Math.round(mr.height) }; })()`);
      if (!closed) { problems.push('the assistant button is not on the page' + at); continue; }
      if (closed.caught) problems.push(`the closed assistant menu still catches taps at ${closed.caught} point(s), e.g. ${closed.sample.join(' ')}` + at);
      if (!closed.mainHit) problems.push('the assistant button itself cannot be tapped' + at);
      await page.eval(`document.getElementById('fabMainBtn').click()`);
      await sleep(900);
      const open_ = await page.eval(`(() => { const m = document.getElementById('fabMenu'); const items = [...m.querySelectorAll('.fab-item')].filter(i => getComputedStyle(i).display !== 'none'); const hit = items.filter(i => { const r = i.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e && i.contains(e); }).length; return { open: m.classList.contains('open'), items: items.length, hit }; })()`);
      if (!open_.open) problems.push('tapping the assistant button does not open its menu' + at);
      if (open_.items < 1 || open_.hit !== open_.items) problems.push(`only ${open_.hit} of ${open_.items} opened circles can be tapped` + at);
      await page.eval(`document.getElementById('fabMainBtn').click()`);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  report(problems, 'floating assistant');
});

test('register: the terms row is a 32px tap row on every touch viewport', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const { page } = await open(chrome, '/register.html', w, h);
    try {
      const r = await page.eval(`(() => { const tr = document.querySelector('.terms-row'); const b = tr.getBoundingClientRect(); return { min: getComputedStyle(tr).minHeight, h: Math.round(b.height), hs: ${HS} }; })()`);
      const at = ` @${w}x${h}`;
      if (r.min !== '32px') problems.push(`the terms row min-height is ${r.min}, not 32px` + at);
      if (r.h < 32) problems.push(`the terms row is ${r.h}px tall` + at);
      if (r.hs) problems.push('sideways scroll on the register page' + at);
    } finally { page.close(); }
  }
  report(problems, 'register terms row');
});
