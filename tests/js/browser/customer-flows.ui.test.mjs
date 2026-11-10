// The signed-in customer flows, in a real browser at the seven target viewports, against a LOCAL DISPOSABLE server:
// sign-in, traveller details, demo checkout (success, a failing booking call, retry), the signed-in pages, live chat
// with a staff reply, and the voice-call interface.
//
//   375x667  393x852  412x968  768x1024  960x1440  1004x764  1280x800
//
// SAFETY. This test creates accounts, bookings and chat messages, so it refuses to run unless ALL of these hold:
//   * the server is on a loopback address,
//   * it reports payment mode "demo" (no provider is ever opened, nothing is marked paid), and
//   * tests/responsive_flows_setup.py accepts the database: loopback AND a name containing "tmp" or "test".
// Run it against a throwaway database:
//
//     DATABASE_URL=postgresql+psycopg2://.../jackpots_payfix_tmp PAYMENT_MODE=demo PAYMENT_PROVIDER=mock \
//       PORT=8001 python backend/scripts/devserver.py            (after `alembic upgrade head` on that database)
//     DATABASE_URL=<the same> JPW_BASE=http://127.0.0.1:8001 node --test tests/js/browser/customer-flows.ui.test.mjs
//
// WHAT IS NOT VERIFIED HERE, by construction: real audio. The call tests drive the call UI with a fake microphone
// stream; a real call needs a microphone, a second party, and a TURN server for some networks.
//
// JPW_AUDIT=1 prints findings without failing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';
import { VIEWPORTS, MEASURE, flightsPath, openPage as open, report, sleep } from './responsive-helpers.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let chrome = null; let skipReason = null; let K = null;   // K: tokens for { customer, other, admin }

before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE)) { skipReason = `${BASE} is not a loopback address`; return; }
  const cfg = await fetch(BASE + '/api/customer/payments/config').then(r => r.json()).catch(() => null);
  if (!cfg) { skipReason = `no server answering at ${BASE}`; return; }
  if (cfg.mode !== 'demo') { skipReason = `the server reports payment mode "${cfg.mode}", not "demo" (set PAYMENT_MODE=demo, PAYMENT_PROVIDER=mock)`; return; }
  const r = spawnSync('python', [path.join(ROOT, 'tests', 'responsive_flows_setup.py')], { env: process.env, cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { skipReason = 'test accounts were not provisioned: ' + (r.stderr || r.stdout || '').trim().split('\n').pop(); return; }
  K = JSON.parse(r.stdout.trim().split('\n').pop());
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

const HS = 'document.documentElement.scrollWidth > innerWidth + 1';
const as = (who) => `localStorage.setItem('jpc_access', ${JSON.stringify(K[who].access)}); localStorage.setItem('jpc_refresh', ${JSON.stringify(K[who].refresh)}); localStorage.setItem('jpc_user_name', ${JSON.stringify(K[who].name)}); localStorage.setItem('jpc_user_role', 'customer'); localStorage.setItem('jpc_user_id', '${K[who].id}');`;
const api = (p, who, init = {}) => fetch(BASE + p, { ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (who === 'admin' ? K.admin.access : K[who].access), ...(init.headers || {}) } }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const race = (pr, ms, label) => Promise.race([pr, new Promise(r => setTimeout(() => r('TIMEOUT ' + label), ms))]);

const SHEET_BTNS = `[...document.querySelectorAll('.bk-sheet button, .bkf-foot button, .bk-bar button')].filter(b => b.getBoundingClientRect().width > 0 && !b.disabled)`;
const press = (page, prefix) => race(page.eval(`(() => { const b = ${SHEET_BTNS}.find(e => e.textContent.replace(/\\s+/g, ' ').trim().toLowerCase().startsWith(${JSON.stringify(prefix.toLowerCase())})); if (!b) return false; b.click(); return true; })()`), 5000, 'press ' + prefix);
const fill = (page, id, v) => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return false; const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const TRAVELLER = [['p0_title', 'Mr'], ['p0_first', 'Test'], ['p0_last', 'Traveller'], ['p0_dob', '1990-05-15'], ['p0_gender', 'Male'], ['p0_nat', 'India'], ['p0_email', 'responsive.tester@example.com'], ['p0_mobile', '9900001001']];
const fillTraveller = async (page, over = {}) => { for (const [id, v] of TRAVELLER) await fill(page, id, id in over ? over[id] : v); };
const heading = (page) => page.eval(`[...document.querySelectorAll('.bk-sheet h2, .bkf-h2')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim())`);
const reachable = (page, prefix) => page.eval(`(() => { const b = ${SHEET_BTNS}.find(e => e.textContent.replace(/\\s+/g, ' ').trim().toLowerCase().startsWith(${JSON.stringify(prefix.toLowerCase())})); if (!b) return { found: false }; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { found: true, inX: r.left >= -1 && r.right <= innerWidth + 1, inY: r.top < innerHeight && r.bottom > 0, free: !!e && b.contains(e) }; })()`);

async function toTraveller(page) {
  await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 15000, label: 'flight results' });
  await page.eval(`document.querySelector('.jf-select').click()`);
  await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight'), { label: 'the booking sheet' });
  await sleep(900);
  await press(page, 'continue to traveller'); await sleep(1200);
}

test('sign-in: a local test account is recognised on every viewport, and sign-out is reachable', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const { page, errors } = await open(chrome, '/', w, h, as('customer'));
    try {
      const at = ` @${w}x${h}`;
      await sleep(900);
      const s = await page.eval(`(() => { const chip = document.querySelector('.jw-hdr [data-profile-chip], .jw-hdr .pm-chip, .jw-hdr .profile-chip, #profileMenu, .jw-hdr [class*="profile"]'); const login = [...document.querySelectorAll('header a, header button')].filter(e => /login \\/ create/i.test(e.textContent) && e.getBoundingClientRect().width > 0).length; return { chip: !!chip, loginShown: login, name: localStorage.getItem('jpc_user_name') }; })()`);
      if (s.loginShown) problems.push('the header still offers "Login / Create" for a signed-in customer' + at);
      if (!s.chip) problems.push('no profile control in the header for a signed-in customer' + at);
      const me = await api('/api/customer/auth/me', 'customer');
      if (me.status !== 200) problems.push(`/me answered ${me.status}` + at);
      if (await page.eval(HS)) problems.push('sideways scroll' + at);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  report(problems, 'sign-in');
});

test('traveller details: required-field and email validation, keyboard order, and Continue, at every viewport (stops before payment)', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    const { page, errors } = await open(chrome, flightsPath(), w, h, as('customer'));
    try {
      await toTraveller(page);
      if (!(await heading(page)).includes('Traveller Details')) { problems.push('did not reach Traveller Details' + at); continue; }
      const reach = await reachable(page, 'continue to seats');
      if (!reach.found || !reach.inX) problems.push('Continue to Seats is missing or off-screen' + at);
      // 1. empty submit: a readable message, and focus moves to the first missing field
      await press(page, 'continue to seats'); await sleep(900);
      const empty = await page.eval(`({ msg: (document.getElementById('bkMsg') || {}).textContent || '', focus: document.activeElement && document.activeElement.id })`);
      if (!/first name is required/i.test(empty.msg)) problems.push('empty form: no "first name is required" message (' + empty.msg.slice(0, 50) + ')' + at);
      if (/\[object/i.test(empty.msg)) problems.push('empty form: the message reads "[object Object]"' + at);
      if (empty.focus !== 'p0_first') problems.push('empty form: focus did not move to the first missing field (' + empty.focus + ')' + at);
      // 2. keyboard: Tab moves forward through the form's own fields
      await page.key('Tab'); const next = await page.eval(`document.activeElement && document.activeElement.id`);
      if (!next || next === 'p0_first') problems.push('keyboard: Tab did not leave the first field' + at);
      // 3. a malformed email is named, not swallowed
      await fillTraveller(page, { p0_email: 'not-an-email' });
      await press(page, 'continue to seats'); await sleep(900);
      const bad = await page.eval(`(document.getElementById('bkMsg') || {}).textContent || ''`);
      if (!/email/i.test(bad)) problems.push('bad email: the message does not mention the email (' + bad.slice(0, 60) + ')' + at);
      // 4. valid data continues to the seat step
      await fillTraveller(page);
      await press(page, 'continue to seats'); await sleep(1500);
      if (!(await heading(page)).includes('Select Seats')) problems.push('valid details did not continue to Select Seats' + at);
      if (await page.eval(HS)) problems.push('sideways scroll in the traveller flow' + at);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  report(problems, 'traveller details');
});

test('demo checkout: Pay now is reachable; a failing booking call shows a readable message and can be retried; success says no money was taken', { timeout: 1200000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  let created = 0;
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    const { page, errors } = await open(chrome, flightsPath(), w, h, as('customer'));
    try {
      await toTraveller(page);
      await fillTraveller(page);
      for (let i = 0; i < 4; i++) { await press(page, 'continue'); await sleep(1600); if ((await heading(page)).includes('Complete your booking')) break; }
      if (!(await heading(page)).includes('Complete your booking')) { problems.push('did not reach the payment step' + at); continue; }
      const reach = await reachable(page, 'pay now');
      if (!reach.found || !reach.inX) problems.push('Pay now is missing or off-screen' + at);
      if (await page.eval(HS)) problems.push('sideways scroll on the payment step' + at);
      // failure + retry: the booking call answers a 422 list, as the real API does for a bad value
      const off = page.route((u, m) => /\/api\/customer\/bookings$/.test(u) && m === 'POST',
        () => ({ status: 422, json: { detail: [{ type: 'value_error', loc: ['body', 'passengers', 0, 'email'], msg: 'Value error, value is not a valid email address: please check it', input: 'x' }] } }));
      await press(page, 'pay now'); await sleep(1800);
      const failed = await page.eval(`({ txt: document.body.innerText, again: ${SHEET_BTNS}.some(b => /pay now/i.test(b.textContent)) })`);
      if (/\[object Object\]/.test(failed.txt)) problems.push('a failing booking call shows "[object Object]"' + at);
      if (!/not a valid email address/i.test(failed.txt)) problems.push('a failing booking call does not show its reason' + at);
      if (!failed.again) problems.push('after a failure the Pay now button is not available to retry' + at);
      off();
      page.log.length = 0;
      await press(page, 'pay now'); await sleep(4500);
      const ok = await page.eval(`({ tag: (document.querySelector('.jpay-demo-tag') || {}).textContent || '', h3: (document.querySelector('.jpay h3') || {}).textContent || '', txt: (document.querySelector('.jpay') || document.body).textContent.replace(/\\s+/g, ' '), btn: (() => { const b = document.querySelector('.jpay [data-jpay-done]'); if (!b) return null; const r = b.getBoundingClientRect(); return { inX: r.left >= -1 && r.right <= innerWidth + 1 }; })(), hs: ${HS} })`);
      if (ok.tag !== 'Demo payment' || ok.h3 !== 'Payment successful') problems.push(`no demo success screen (tag "${ok.tag}", heading "${ok.h3}")` + at);
      if (!/No money was taken/i.test(ok.txt)) problems.push('the success screen does not say that no money was taken' + at);
      if (!ok.btn || !ok.btn.inX) problems.push('the success screen has no reachable Continue button' + at);
      if (ok.hs) problems.push('sideways scroll on the success screen' + at);
      const posts = page.log.filter(r => r.method === 'POST').map(r => r.url);
      if (posts.some(u => /checkout|razorpay|trustbrick|hdfc/i.test(u))) problems.push('a provider checkout request was made in demo mode: ' + posts.join(' ') + at);
      created++;
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  // Nothing is marked paid: every booking this customer made is still pending, and none has a paid/confirmed state.
  const mine = await api('/api/customer/bookings', 'customer');
  const rows = Array.isArray(mine.body) ? mine.body : [];
  if (rows.length < created) problems.push(`expected at least ${created} bookings for the test customer, found ${rows.length}`);
  const paid = rows.filter(b => /^(paid|confirmed|completed)$/i.test(String(b.status)));
  if (paid.length) problems.push(`${paid.length} booking(s) were marked ${paid.map(b => b.status).join('/')} in demo mode`);
  report(problems, 'demo checkout');
});

test('signed-in pages: My Bookings, and the Account Center tabs (profile, bookings, payment history, Support Center), at every viewport', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    {
      const { page, errors } = await open(chrome, '/my-bookings', w, h, as('customer'));
      try {
        await sleep(1800);
        const m = await page.eval(MEASURE);
        const n = await page.eval(`document.querySelectorAll('#mbList > *').length`);
        if (!n) problems.push('My Bookings lists no bookings for a customer who has made some' + at);
        if (m.hScroll) problems.push(`My Bookings: sideways scroll (${m.sw}px)` + at);
        m.out.forEach(o => problems.push('My Bookings: sticks out: ' + o + at));
        if (m.nSmall) problems.push(`My Bookings: ${m.nSmall} touch target(s) under 32px: ${m.small.slice(0, 3).join(' | ')}` + at);
        m.clipped.forEach(c => problems.push('My Bookings: clipped text: ' + c + at));
        errors.forEach(e => problems.push('My Bookings: script error: ' + e + at));
      } finally { page.close(); }
    }
    {
      const { page, errors } = await open(chrome, '/', w, h, as('customer'));
      try {
        await sleep(1500);
        for (const tab of ['profile', 'bookings', 'payments', 'support']) {
          await page.eval(`openAccountCenter(${JSON.stringify(tab)})`); await sleep(1400);
          const s = await page.eval(`(() => { const tabs = document.getElementById('acctTabs'); if (!tabs) return null; let m = tabs; while (m && m.parentElement && !/modal|overlay|acct/i.test(m.className + m.id)) m = m.parentElement; const mr = (document.querySelector('.modal-overlay.open, .modal.open, #acctModal') || m).getBoundingClientRect();
            const tr = tabs.getBoundingClientRect(); const live = tab => [...tabs.querySelectorAll('.acct-tab')].some(e => e.dataset.tab === tab && e.classList.contains('active'));
            return { tabsIn: tr.width > 0 && tr.left >= -1 && tr.right <= innerWidth + 1, active: [...tabs.querySelectorAll('.acct-tab.active')].map(e => e.dataset.tab), hs: ${HS}, chat: !!document.querySelector('.acct-pane [data-lc-input], [data-lc-input]'), chatIn: (() => { const i = document.querySelector('[data-lc-input]'); if (!i) return false; const r = i.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1; })() }; })()`);
          const w_ = ` (${tab})` + at;
          if (!s) { problems.push('Account Center did not open' + w_); continue; }
          if (!s.tabsIn) problems.push('the Account Center tab list is outside the viewport' + w_);
          if (!s.active.includes(tab)) problems.push(`the ${tab} tab did not become active (${s.active})` + w_);
          if (s.hs) problems.push('sideways scroll with the Account Center open' + w_);
          if (tab === 'support' && !s.chatIn) problems.push('the Support Center shows no usable message box' + w_);
        }
        errors.forEach(e => problems.push('Account Center: script error: ' + e + at));
      } finally { page.close(); }
    }
  }
  report(problems, 'signed-in pages');
});

test('live chat: two customers and a staff agent; message delivery, isolation, mobile layout, and the offline error', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    const a = await open(chrome, '/', w, h, as('customer'));
    // A second customer needs a second origin: tabs on one origin share localStorage, so a second session there would
    // overwrite the first's token. localhost and 127.0.0.1 are different origins for the same server.
    const b = await open(chrome, '/', w, h, as('other'), BASE.replace('127.0.0.1', 'localhost'));
    try {
      const openChat = async (pg) => { await pg.eval(`document.getElementById('fabMainBtn').click()`); await sleep(600); await pg.eval(`document.getElementById('fabSupportBtn').click()`); await sleep(1800); };
      await openChat(a.page); await openChat(b.page);
      // Idle chat: nothing the page marked `hidden` (the call screen, Accept / Decline, the timer) may be drawn in it.
      const shown = await a.page.eval(`[...document.querySelectorAll('[data-lc-panel] [hidden]')].filter(e => getComputedStyle(e).display !== 'none').map(e => (e.className || e.tagName).toString().slice(0, 28))`);
      if (shown.length) problems.push('the idle chat draws hidden elements: ' + shown.slice(0, 4).join(', ') + at);
      const geo = await a.page.eval(`(() => { const pn = document.querySelector('[data-lc-panel]'); const r = pn.getBoundingClientRect(); const i = document.querySelector('[data-lc-input]').getBoundingClientRect(); const s = document.querySelector('[data-lc-send]').getBoundingClientRect();
        return { panelIn: r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, inputIn: i.width > 0 && i.right <= innerWidth + 1, sendIn: s.width > 0 && s.right <= innerWidth + 1 && s.bottom <= innerHeight + 1, hs: ${HS},
          nums: { panel: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], input: [Math.round(i.left), Math.round(i.right)], send: [Math.round(s.left), Math.round(s.top), Math.round(s.right), Math.round(s.bottom)], vh: innerHeight, vw: innerWidth } }; })()`);
      if (!geo.panelIn) problems.push('the chat panel is not fully inside the viewport' + at);
      if (!geo.inputIn || !geo.sendIn) problems.push('the chat message box or Send button is outside the viewport ' + JSON.stringify(geo.nums) + at);
      if (geo.hs) problems.push('sideways scroll with the chat open' + at);
      const tag = `hello-${w}-${Date.now()}`;
      await a.page.send('Page.bringToFront');   // a background tab does not receive key events
      await a.page.eval(`document.querySelector('[data-lc-input]').focus()`);
      await a.page.type('Customer one says ' + tag); await a.page.key('Enter'); await sleep(1500);
      const mine = await a.page.eval(`document.querySelector('[data-lc-thread]').textContent`);
      if (!mine.includes(tag)) problems.push('the customer\'s own message does not appear in their thread' + at);
      // the second customer must not see it
      const theirs = await b.page.eval(`document.querySelector('[data-lc-thread]').textContent`);
      if (theirs.includes(tag)) problems.push('ISOLATION: another customer\'s chat shows this customer\'s message' + at);
      // the staff side, by API: find the conversation, claim it, reply
      const q = await api('/api/admin/chat/conversations', 'admin');
      const conv = (q.body && q.body.conversations || []).find(c => c.customer_id === K.customer.id);
      if (!conv) { problems.push('the agent queue does not show this customer\'s conversation' + at); continue; }
      await api(`/api/admin/chat/conversations/${conv.conversation_id}/claim`, 'admin', { method: 'POST', body: '{}' });
      const reply = `agent-reply-${w}-${Date.now()}`;
      const sent = await api(`/api/admin/chat/conversations/${conv.conversation_id}/messages`, 'admin', { method: 'POST', body: JSON.stringify({ body: reply }) });
      if (sent.status >= 300) problems.push('the agent reply was refused: ' + sent.status + at);
      // delivery: a socket pushes it, or the next focus / reopen fetches it (the widget does not poll)
      let seen = false;
      for (let i = 0; i < 8 && !seen; i++) { await sleep(900); seen = (await a.page.eval(`document.querySelector('[data-lc-thread]').textContent`)).includes(reply); }
      if (!seen) { await a.page.eval(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))`); await sleep(1500); seen = (await a.page.eval(`document.querySelector('[data-lc-thread]').textContent`)).includes(reply); }
      if (!seen) problems.push('the agent\'s reply did not reach the customer\'s open chat' + at);
      const leak = await b.page.eval(`document.querySelector('[data-lc-thread]').textContent`);
      if (leak.includes(reply)) problems.push('ISOLATION: the reply to one customer appeared in another\'s chat' + at);
      // the offline error: sending while the network call fails keeps the text and says so
      const off = a.page.route((u, m) => /\/api\/customer\/chat\/messages$/.test(u) && m === 'POST', () => ({ fail: true }));
      await a.page.send('Page.bringToFront');
      await a.page.eval(`document.querySelector('[data-lc-input]').focus()`);
      await a.page.type('offline attempt'); await a.page.key('Enter'); await sleep(1500);
      const err = await a.page.eval(`({ thread: document.querySelector('[data-lc-thread]').textContent, banner: [...document.querySelectorAll('[data-lc-panel] [role=alert], [data-lc-panel] .lc-error, [data-lc-panel] .lc-failed, [data-lc-panel] [class*="error"], [data-lc-panel] [class*="fail"]')].map(e => e.textContent.trim()).join(' | '), kept: document.querySelector('[data-lc-input]').value })`);
      if (!/(couldn.?t send|could not send|failed|try again|retry|not sent|offline|network)/i.test(err.thread + ' ' + err.banner)) problems.push('a failed send shows no error to the customer' + at);
      off();
      a.errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { a.page.close(); b.page.close(); }
  }
  report(problems, 'live chat');
});

test('voice-call interface: the call screen appears, fits, and ends cleanly (UI only: no real audio is exercised)', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  // A fake microphone: an audio stream with no source, so the page can ask for one without any hardware or permission.
  const FAKE_MIC = `(() => { navigator.mediaDevices = navigator.mediaDevices || {}; navigator.mediaDevices.getUserMedia = async () => { const ac = new (window.AudioContext || window.webkitAudioContext)(); return ac.createMediaStreamDestination().stream; }; })();`;
  const DENIED = `(() => { navigator.mediaDevices = navigator.mediaDevices || {}; navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; })();`;
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    for (const [label, mic] of [['microphone allowed', FAKE_MIC], ['microphone denied', DENIED]]) {
      const { page, errors } = await open(chrome, '/', w, h, as('customer') + mic);
      try {
        await sleep(1200);
        await page.eval(`document.getElementById('fabMainBtn').click()`); await sleep(600);
        await page.eval(`document.getElementById('fabSupportBtn').click()`); await sleep(1800);
        const has = await page.eval(`(() => { const b = document.querySelector('[data-lc-call-start]'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: r.width, inX: r.left >= -1 && r.right <= innerWidth + 1, h: r.height }; })()`);
        if (!has || !has.w) { problems.push('there is no call button in the chat panel' + at); continue; }
        if (!has.inX) problems.push('the call button is outside the viewport' + at);
        if (has.w < 32 || has.h < 32) problems.push(`the call button is ${Math.round(has.w)}x${Math.round(has.h)}, under 32px` + at);
        await page.eval(`document.querySelector('[data-lc-call-start]').click()`); await sleep(2500);
        const s = await page.eval(`(() => { const c = document.querySelector('[data-lc-call]'); const r = c.getBoundingClientRect(); const end = c.querySelector('[data-lc-call-hangup]'); const er = end && end.getBoundingClientRect();
          return { shown: !c.hidden && r.width > 0, inView: r.left >= -1 && r.right <= innerWidth + 1, status: (c.querySelector('[data-lc-call-status]') || {}).textContent || '', note: (c.querySelector('[data-lc-call-note]') || {}).textContent || '', endIn: !!er && er.width > 0 && er.left >= -1 && er.right <= innerWidth + 1, hs: ${HS} }; })()`);
        if (label === 'microphone denied') {
          // Either the call screen explains the refusal, or it never opens and the chat says why: not a blank dialog.
          const said = await page.eval(`document.querySelector('[data-lc-panel]').textContent`);
          if (!/(microphone|mic|permission|allow|blocked|denied)/i.test(said + ' ' + s.status + ' ' + s.note)) problems.push('a denied microphone is not explained to the customer' + at);
        } else if (s.shown) {
          if (!s.inView) problems.push('the call screen is outside the viewport' + at);
          if (!s.endIn) problems.push('the End button is missing or outside the viewport during a call' + at);
          if (!s.status.trim() && !s.note.trim()) problems.push('the call screen shows no status text' + at);
          await page.eval(`document.querySelector('[data-lc-call-hangup]').click()`); await sleep(1500);
          const after = await page.eval(`document.querySelector('[data-lc-call]').hidden || document.querySelector('[data-lc-call]').getBoundingClientRect().width === 0`);
          if (!after) problems.push('End does not close the call screen' + at);
        } else if (!/(unavailable|offline|no agent|try again|not available|busy|couldn|could not)/i.test(s.status + ' ' + s.note + ' ' + await page.eval(`document.querySelector('[data-lc-panel]').textContent`))) {
          problems.push('starting a call neither showed the call screen nor said why it could not' + at);
        }
        if (s.hs) problems.push('sideways scroll during a call' + at);
        errors.forEach(e => problems.push('script error: ' + e + ` (${label})` + at));
      } finally { page.close(); }
    }
  }
  report(problems, 'voice-call interface');
});

test('call controls: hidden when idle, and shown correctly for an incoming call, a connected call and a finished call (the real UI, driven by the frames a server would send)', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  // A stand-in WebSocket the test can push server frames through: the page's own code runs unchanged.
  const FAKE_WS = `(() => { class Fake { constructor(url) { this.url = url; this.readyState = 0; this.sent = []; (window.__sockets = window.__sockets || []).push(this); setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen({}); }, 30); }
    send(d) { this.sent.push(d); } close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); } }
    Fake.CONNECTING = 0; Fake.OPEN = 1; Fake.CLOSING = 2; Fake.CLOSED = 3; window.WebSocket = Fake;
    window.__push = (event, data) => { const s = window.__sockets[window.__sockets.length - 1]; s.onmessage({ data: JSON.stringify({ event, data }) }); }; })();`;
  const FAKE_MIC = `(() => { navigator.mediaDevices = navigator.mediaDevices || {}; navigator.mediaDevices.getUserMedia = async () => { const ac = new (window.AudioContext || window.webkitAudioContext)(); return ac.createMediaStreamDestination().stream; }; })();`;
  const state = (page) => page.eval(`(() => { const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { drawn: cs.display !== 'none' && r.width > 0 && r.height > 0, inView: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 }; };
    const q = (s) => document.querySelector('[data-lc-panel] ' + s);
    return { call: R(q('[data-lc-call]')), answer: R(q('[data-lc-call-answer]')), live: R(q('[data-lc-call-live]')), timer: R(q('[data-lc-call-timer]')), accept: R(q('[data-lc-call-answer-btn]')), decline: R(q('[data-lc-call-decline]')),
      end: R(q('[data-lc-call-hangup]')), mute: R(q('[data-lc-call-mute]')), send: R(q('[data-lc-send]')), input: R(q('[data-lc-input]')), title: (q('[data-lc-call-title]') || {}).textContent || '', status: (q('[data-lc-call-status]') || {}).textContent || '', hs: ${HS} }; })()`);
  for (const [w, h] of VIEWPORTS) {
    const at = ` @${w}x${h}`;
    const { page, errors } = await open(chrome, '/', w, h, as('customer') + FAKE_MIC + FAKE_WS);
    try {
      await sleep(1200);
      await page.eval(`document.getElementById('fabMainBtn').click()`); await sleep(500);
      await page.eval(`document.getElementById('fabSupportBtn').click()`); await sleep(2000);
      // 1. idle: nothing of the call UI is drawn, and the composer is on screen
      let s = await state(page);
      for (const k of ['call', 'answer', 'live', 'timer', 'accept', 'decline', 'end', 'mute']) if (s[k] && s[k].drawn) problems.push(`idle: the ${k} control is drawn` + at);
      if (!s.send || !s.send.drawn || !s.send.inView) problems.push('idle: the Send button is not fully on screen' + at);
      if (!s.input || !s.input.inView) problems.push('idle: the message box is not on screen' + at);
      // 2. an agent is calling: the call screen, with Accept and Decline, and no live-call row or timer yet
      await page.eval(`window.__push('incoming_call', { call_id: 9001, admin_name: 'Test Agent' })`); await sleep(700);
      s = await state(page);
      if (!s.call || !s.call.drawn) problems.push('incoming: the call screen is not shown' + at);
      if (!s.accept || !s.accept.drawn || !s.accept.inView) problems.push('incoming: Accept is not visible on screen' + at);
      if (!s.decline || !s.decline.drawn || !s.decline.inView) problems.push('incoming: Decline is not visible on screen' + at);
      if (s.live && s.live.drawn) problems.push('incoming: the Mute / End row is drawn before the call is answered' + at);
      if (s.timer && s.timer.drawn) problems.push('incoming: the timer is drawn before the call connects' + at);
      if (!/Test Agent/.test(s.title)) problems.push('incoming: the caller is not named (' + s.title + ')' + at);
      if (s.hs) problems.push('incoming: sideways scroll' + at);
      // 3. declined: the call screen closes again
      await page.eval(`window.__push('call_status', { call_id: 9001, status: 'rejected' })`); await sleep(3400);
      s = await state(page);
      if (s.call && s.call.drawn) problems.push('after a declined call the call screen stays on screen' + at);
      if (s.answer && s.answer.drawn) problems.push('after a declined call Accept / Decline stay on screen' + at);
      // 4. a second call, answered and connected: Mute / End and the timer, not Accept / Decline
      await page.eval(`window.__push('incoming_call', { call_id: 9002, admin_name: 'Test Agent' })`); await sleep(600);
      await page.eval(`document.querySelector('[data-lc-panel] [data-lc-call-answer-btn]').click()`); await sleep(1500);
      await page.eval(`window.__push('call_status', { call_id: 9002, status: 'connected', admin_name: 'Test Agent', connected_at: new Date().toISOString() })`); await sleep(1500);
      s = await state(page);
      if (!s.call || !s.call.drawn) problems.push('connected: the call screen is not shown' + at);
      if (!s.end || !s.end.drawn || !s.end.inView) problems.push('connected: End is not visible on screen' + at);
      if (!s.mute || !s.mute.drawn || !s.mute.inView) problems.push('connected: Mute is not visible on screen' + at);
      if (!s.timer || !s.timer.drawn) problems.push('connected: the call timer is not shown' + at);
      if (s.answer && s.answer.drawn) problems.push('connected: Accept / Decline are still drawn' + at);
      if (!s.send || !s.send.drawn || !s.send.inView) problems.push('connected: the Send button is pushed off screen by the call panel' + at);
      if (s.hs) problems.push('connected: sideways scroll' + at);
      // 5. Mute toggles, then the call ends and everything goes away again
      await page.eval(`document.querySelector('[data-lc-panel] [data-lc-call-mute]').click()`); await sleep(400);
      const muted = await page.eval(`document.querySelector('[data-lc-panel] [data-lc-call-mute]').getAttribute('aria-pressed')`);
      if (muted !== 'true') problems.push('connected: Mute does not toggle (aria-pressed=' + muted + ')' + at);
      await page.eval(`window.__push('call_status', { call_id: 9002, status: 'ended' })`); await sleep(3400);
      s = await state(page);
      for (const k of ['call', 'live', 'timer', 'end', 'mute']) if (s[k] && s[k].drawn) problems.push(`after the call: the ${k} control is still drawn` + at);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  report(problems, 'call states');
});
