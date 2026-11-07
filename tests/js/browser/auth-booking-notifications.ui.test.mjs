// Sign-in dialog, flight Review/Payment steps, notification bell and the Clear All button — in a real browser at
// phone, tablet and desktop widths.
//
//   node --test tests/js/browser/auth-booking-notifications.ui.test.mjs
//
// SELF-CONTAINED AND SAFE. It serves frontend/ from a throw-away static server on a loopback port and answers every
// /api/* call itself through the DevTools request interceptor (cdp.mjs), so it needs no backend, no database, no
// credentials, and can create nothing real. Any /api call it has not been given an answer for gets a 404, and the
// payment step is only REACHED, never paid: no provider is contacted.
//
// WHAT IT PINS
//   1. Sign-in offers EMAIL only: no Mobile Number option, no country select, no `authMethod` radios. The email ->
//      OTP request (POST /api/customer/auth/request-otp {identifier}) and OTP verification still work, and an unknown
//      email is reported beside the field.
//   1b. Create account asks for name, email and mobile ONLY - no password, no confirm - and POST /signup carries none;
//      the emailed code (verify-otp) is still what starts the session.
//   1c. The standalone customer page (customer/register.html) is passwordless too: name, email, mobile, optional date of
//      birth; POST /signup carries no password; no session until the emailed code is spent; a wrong code signs nobody in.
//   2. Review shows Traveller Details and Contact Details as two labelled subsections of ONE card; every field kept.
//   3. Payment method names are medium/semi-medium (500-600), not 700+; the methods still select.
//   4. The bell shows the latest TWO notifications, "Show All Notifications" opens Profile -> Notifications, the unread
//      count is still the server's, and a row click still marks it read.
//   5. Clear All has an opaque background in every state (rest, hover, focus, active).
//
// Requires Chrome or Edge (set CHROME_PATH otherwise) and network access to the axios CDN the pages load.
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const VIEWPORTS = [[375, 667], [768, 1024], [1280, 800]];          // phone, tablet, desktop
const HS = 'document.documentElement.scrollWidth > innerWidth + 1';

let chrome = null; let server = null; let ORIGIN = ''; let skipReason = null;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function startStatic() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      let file = path.join(FRONTEND, p);
      if (!file.startsWith(FRONTEND)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (fs.existsSync(file + '.html')) file += '.html';
        else if (fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
        else { res.writeHead(404); res.end('not found'); return; }
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  server = await startStatic();
  ORIGIN = `http://127.0.0.1:${server.address().port}`;
  chrome = await Chrome.launch();
});
after(async () => {
  if (chrome) await chrome.close();
  if (server) await new Promise(r => server.close(r));
});

/* ---- API answers ------------------------------------------------------ */
const NOTES = [
  { id: 5, notification_type: 'booking_confirmed', title: 'Booking confirmed', message: 'Your flight HYD to DEL is confirmed. Have a lovely trip.', is_read: false, created_at: new Date(Date.now() - 5 * 60e3).toISOString(), related_ref: 'JP-1005' },
  { id: 4, notification_type: 'booking_payment', title: 'Payment received', message: 'We received your payment.', is_read: false, created_at: new Date(Date.now() - 3600e3).toISOString(), related_ref: null },
  { id: 3, notification_type: 'general', title: 'Welcome to JackPots World', message: 'Your account is ready.', is_read: true, created_at: new Date(Date.now() - 86400e3).toISOString(), related_ref: null },
  { id: 2, notification_type: 'general', title: 'Third', message: 'Third.', is_read: true, created_at: new Date(Date.now() - 2 * 86400e3).toISOString(), related_ref: null },
  { id: 1, notification_type: 'general', title: 'Fourth', message: 'Fourth.', is_read: true, created_at: new Date(Date.now() - 3 * 86400e3).toISOString(), related_ref: null },
];
const CUSTOMER = { customer_id: 1, customer_code: 'C-1', full_name: 'Test Traveller', email: 'test.traveller@example.com', mobile: '+919900001001', is_guest: false };

/** Every /api call is answered here. Unlisted ones are a 404, so a stray call is visible rather than silently real. */
function mockApi(page, state = {}) {
  page.route(() => true, () => ({ status: 404, json: { detail: 'not mocked' } }));                       // lowest priority
  page.route(u => /\/auth\/google\/config/.test(u), () => ({ json: { enabled: false, client_id: null } }));
  page.route((u, m) => /\/auth\/request-otp/.test(u) && m === 'POST', () => state.unknownEmail
    ? { status: 404, json: { detail: "We couldn't find an account with those details." } }
    : { status: 200, json: { otp_required: true, challenge_token: 'chal', delivery: 'dev', message: 'dev', dev_otp: '123456' } });
  page.route((u, m) => /\/auth\/signup/.test(u) && m === 'POST', () => ({ status: 201, json: { otp_required: true, challenge_token: 'chal-su', delivery: 'dev', message: 'dev', dev_otp: '123456' } }));
  page.route((u, m) => /\/auth\/verify-otp/.test(u) && m === 'POST', () => ({ json: { access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', customer: CUSTOMER } }));
  page.route((u, m) => /\/customer\/notifications\/unread-count/.test(u) && m === 'GET', () => ({ json: { unread: NOTES.filter(n => !n.is_read).length } }));
  page.route((u, m) => /\/customer\/notifications\/\d+\/read/.test(u) && m === 'PATCH', () => ({ status: 204, body: '' }));
  page.route((u, m) => /\/customer\/notifications\/read-all/.test(u) && m === 'PATCH', () => ({ status: 204, body: '' }));
  page.route((u, m) => /\/customer\/notifications(\?.*)?$/.test(u) && m === 'GET', () => ({ json: NOTES }));
  page.route(u => /\/customer\/auth\/me/.test(u), () => ({ json: CUSTOMER }));
}

async function open(pathname, [w, h], { signedIn = false, state } = {}) {
  const page = await chrome.newPage();
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description || e.exceptionDetails.text || '').split('\n')[0].slice(0, 160)));
  mockApi(page, state);
  await page.viewport({ width: w, height: h, mobile: w < 600 });
  if (w <= 1280) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  /* One browser profile serves every test, and localStorage is per-origin: wipe it once per tab so a session left behind by
     an earlier page (the sign-in test ends signed in) cannot make the next page start signed in. */
  await page.addInitScript(`try { if (!sessionStorage.getItem('__jpw_clean')) { localStorage.clear(); sessionStorage.setItem('__jpw_clean', '1'); } } catch (e) {}`);
  if (signedIn) {
    await page.addInitScript(`localStorage.setItem('jpc_access', 'a.b.c'); localStorage.setItem('jpc_refresh', 'r');
      localStorage.setItem('jpc_user_name', 'Test Traveller'); localStorage.setItem('jpc_user_role', 'customer'); localStorage.setItem('jpc_user_id', '1');`);
  }
  await page.goto(ORIGIN + pathname);
  await sleep(700);
  return { page, errors };
}

const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[hidden]'); })()`;
const setValue = (page, id, v) => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return false;
  const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(v)});
  e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

/* ======================================================================= */
test('sign-in: email only - no Mobile Number option - and the OTP flow still works (phone, tablet, desktop)', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const vp of VIEWPORTS) {
    const at = ` @${vp.join('x')}`;
    const { page, errors } = await open('/index.html', vp);
    try {
      await page.waitFor(() => !!document.querySelector('[data-pm-auth]'), { timeout: 15000, label: 'the header Login / Create link' });
      await page.eval(`document.querySelector('[data-pm-auth]').click()`);          // the header's "Login / Create"
      await page.waitFor(() => document.getElementById('authOverlay').classList.contains('open'), { label: 'the sign-in dialog' });
      await sleep(400);

      const gone = await page.eval(`({
        radios: document.querySelectorAll('input[name="authMethod"]').length,
        mobile: !!document.getElementById('authMobile'), dial: !!document.getElementById('authDial'),
        text: document.getElementById('authStepEmail').innerText,
      })`);
      if (gone.radios) problems.push('the Mobile/Email method toggle is still in the sign-in step' + at);
      if (gone.mobile || gone.dial) problems.push('the mobile number field or country select is still in the sign-in step' + at);
      if (/mobile/i.test(gone.text)) problems.push('"mobile" is still on the sign-in step: ' + gone.text.replace(/\s+/g, ' ').slice(0, 120) + at);
      if (!(await page.eval(visible('#authEmail')))) problems.push('the email field is not visible' + at);
      if (!(await page.eval(visible('#authContinueBtn')))) problems.push('Continue is not visible' + at);
      if (!(await page.eval(`document.getElementById('authContinueBtn').disabled`))) problems.push('Continue is enabled with nothing typed' + at);
      if (!(await page.eval(`!!document.getElementById('googleBtnMount') && !!document.querySelector('[data-step="signup"]')`))) problems.push('the Google mount or the Create-an-account link is gone' + at);
      if (await page.eval(HS)) problems.push('sideways scroll with the dialog open' + at);

      // a malformed email is refused beside the field and no request is made
      await setValue(page, 'authEmail', 'not-an-email');
      await page.eval(`document.getElementById('authEmailForm').requestSubmit()`);
      await sleep(250);
      if (!/valid email/i.test(await page.eval(`document.getElementById('authEmailErr').textContent`))) problems.push('no "valid email" message for a malformed address' + at);
      if (page.requests('/auth/request-otp').length) problems.push('an OTP was requested for a malformed email' + at);

      // a good email requests a code with the email as the identifier, then reaches the OTP step
      await setValue(page, 'authEmail', 'test.traveller@example.com');
      if (await page.eval(`document.getElementById('authContinueBtn').disabled`)) problems.push('Continue stays disabled after typing an email' + at);
      await page.eval(`document.getElementById('authEmailForm').requestSubmit()`);
      await page.waitFor(() => !document.getElementById('loginStepOtp').hidden, { label: 'the OTP step' });
      const req = page.requests('/auth/request-otp')[0];
      if (!req || JSON.parse(req.body).identifier !== 'test.traveller@example.com') problems.push('request-otp did not carry the email as the identifier: ' + (req && req.body) + at);
      const sub = await page.eval(`document.getElementById('otpDest').textContent + '|' + document.getElementById('liBackLabel').textContent`);
      if (!/t\*\*\*@example\.com/.test(sub) || !/email/i.test(sub.split('|')[1])) problems.push('the OTP step does not show the masked email / "Change email address": ' + sub + at);

      // the six digits are spent at verify-otp with the challenge from request-otp
      await page.eval(`document.querySelectorAll('#otpBoxes .otp-box').forEach((b, i) => { b.value = '123456'[i]; b.dispatchEvent(new Event('input', { bubbles: true })); })`);
      await sleep(200);
      await page.eval(`document.getElementById('otpForm').requestSubmit()`);
      await sleep(900);
      const ver = page.requests('/auth/verify-otp')[0];
      if (!ver) problems.push('verify-otp was never called' + at);
      else { const b = JSON.parse(ver.body); if (b.challenge_token !== 'chal' || b.code !== '123456') problems.push('verify-otp body is wrong: ' + ver.body + at); }
      if (!(await page.eval(`localStorage.getItem('jpc_access') === 'a.b.c'`))) problems.push('the session was not stored after a verified code' + at);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'sign-in');
});

test('create account: no password fields, signup posts without one, and the emailed code still starts the session (phone, tablet, desktop)', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const vp of VIEWPORTS) {
    const at = ` @${vp.join('x')}`;
    const { page, errors } = await open('/index.html', vp);
    try {
      await page.waitFor(() => !!document.querySelector('[data-pm-auth]'), { timeout: 15000, label: 'the header Login / Create link' });
      await page.eval(`document.querySelector('[data-pm-auth]').click()`);
      await page.waitFor(() => document.getElementById('authOverlay').classList.contains('open'), { label: 'the dialog' });
      await page.eval(`document.querySelector('#authStepEmail [data-step="signup"]').click()`);
      await page.waitFor(() => !document.getElementById('authStepSignup').hidden, { label: 'the Create your account step' });
      await sleep(300);

      const f = await page.eval(`(() => { const v = document.getElementById('authStepSignup');
        return { pw: v.querySelectorAll('input[type="password"]').length, ids: ['suPass', 'suPass2', 'suPassStrength', 'suPassErr', 'suPass2Err'].filter(i => document.getElementById(i)),
          text: v.innerText.replace(/\s+/g, ' '), inputs: [...v.querySelectorAll('input:not([type=hidden]), select')].map(e => e.id),
          btn: (document.getElementById('suRequestBtn') || {}).textContent, hs: ${HS} }; })()`);
      if (f.pw || f.ids.length) problems.push('password fields are still in Create account: ' + f.ids + ' (' + f.pw + ' password inputs)' + at);
      if (/password/i.test(f.text)) problems.push('"password" is still on the Create account step: ' + f.text.slice(0, 160) + at);
      for (const need of ['suName', 'suEmail', 'suMobile', 'suDial']) if (!f.inputs.includes(need)) problems.push('field ' + need + ' is missing' + at);
      if (!/Create Account/i.test(f.btn || '')) problems.push('the Create Account button is missing: ' + f.btn + at);
      if (f.hs) problems.push('sideways scroll on Create account' + at);

      // inline validation still works, and nothing is sent for an invalid form
      await page.eval(`document.getElementById('signupForm').requestSubmit()`);
      await sleep(250);
      if (!/full name/i.test(await page.eval(`document.getElementById('suNameErr').textContent`))) problems.push('no name error for an empty form' + at);
      await setValue(page, 'suName', 'Asha Rao'); await setValue(page, 'suEmail', 'asha.rao@example.com'); await setValue(page, 'suMobile', '12');
      await page.eval(`document.getElementById('signupForm').requestSubmit()`);
      await sleep(250);
      if (!/valid mobile/i.test(await page.eval(`document.getElementById('suMobileErr').textContent`))) problems.push('no mobile error for a short number' + at);
      if (page.requests('/auth/signup').length) problems.push('/signup was called for an invalid form' + at);

      // a valid form posts name, email and the dial-coded mobile - and NO password keys - then reaches the code step
      await setValue(page, 'suMobile', '98765 43210');
      await page.eval(`document.getElementById('signupForm').requestSubmit()`);
      await page.waitFor(() => !document.getElementById('loginStepOtp').hidden, { label: 'the code step after signup' });
      const req = page.requests('/auth/signup')[0];
      const body = req ? JSON.parse(req.body) : {};
      if (!req) problems.push('/signup was never called' + at);
      else {
        if (body.full_name !== 'Asha Rao' || body.email !== 'asha.rao@example.com' || body.mobile !== '+919876543210') problems.push('signup body is wrong: ' + req.body + at);
        if (Object.keys(body).some(k => /pass/i.test(k))) problems.push('signup still sends a password field: ' + Object.keys(body) + at);
      }
      const dest = await page.eval(`document.getElementById('otpDest').textContent + '|' + document.getElementById('liBackLabel').textContent`);
      if (!/a\*\*\*@example\.com/.test(dest) || !/Change your details/.test(dest)) problems.push('the signup code step is not the masked-email / "Change your details" one: ' + dest + at);

      // identity check intact: no session until the code is spent, then verify-otp starts it
      if (await page.eval(`!!localStorage.getItem('jpc_access')`)) problems.push('a session existed before the emailed code was spent' + at);
      await page.eval(`document.querySelectorAll('#otpBoxes .otp-box').forEach((b, i) => { b.value = '123456'[i]; b.dispatchEvent(new Event('input', { bubbles: true })); })`);
      await sleep(200);
      await page.eval(`document.getElementById('otpForm').requestSubmit()`);
      await sleep(900);
      const ver = page.requests('/auth/verify-otp')[0];
      if (!ver || JSON.parse(ver.body).challenge_token !== 'chal-su') problems.push('verify-otp was not called with the signup challenge' + at);
      if (!(await page.eval(`localStorage.getItem('jpc_access') === 'a.b.c'`))) problems.push('no session after the signup code was verified' + at);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'create account');
});

test('customer/register.html: no password fields, signup posts without one, and ONLY the emailed code starts a session (phone, tablet, desktop)', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const vp of VIEWPORTS) {
    const at = ` @${vp.join('x')}`;
    const page = await chrome.newPage();
    const errors = [];
    page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description || e.exceptionDetails.text || '').split('\n')[0].slice(0, 160)));
    mockApi(page);
    await page.viewport({ width: vp[0], height: vp[1], mobile: vp[0] < 600 });
    await page.addInitScript(`try { if (!sessionStorage.getItem('__jpw_clean')) { localStorage.clear(); sessionStorage.setItem('__jpw_clean', '1'); } } catch (e) {}`);
    /* TEST-ONLY. customer-core.js sends API calls to http://127.0.0.1:8000 when served from any other local port; the
       interceptor cannot answer a CORS preflight, so those calls are rewritten to this page's own origin (and so to the mocks). */
    await page.addInitScript(`(() => { const f = window.fetch; window.fetch = (u, o) => f(String(u).replace('http://127.0.0.1:8000', '').replace('http://localhost:8000', ''), o); })();`);
    try {
      await page.goto(ORIGIN + '/customer/register.html');
      await page.waitFor(() => !!document.getElementById('cxrForm'), { timeout: 15000, label: 'the register form' });
      await sleep(300);
      const f = await page.eval(`(() => { const form = document.getElementById('cxrForm');
        return { pw: document.querySelectorAll('input[type="password"]').length, ids: ['cxrPassword', 'cxrConfirm'].filter(i => document.getElementById(i)),
          eyes: document.querySelectorAll('[data-cx-eye]').length, text: form.innerText.replace(/\\s+/g, ' '),
          inputs: [...form.querySelectorAll('input')].map(e => e.id), hs: ${HS},
          btn: (form.querySelector('button[type="submit"]') || {}).textContent.trim() }; })()`);
      if (f.pw || f.ids.length || f.eyes) problems.push(`password fields remain on customer/register.html (${f.pw} password inputs, ids ${f.ids}, ${f.eyes} show/hide toggles)` + at);
      if (/password/i.test(f.text)) problems.push('"password" is still on the form: ' + f.text.slice(0, 140) + at);
      if (f.inputs.join(',') !== 'cxrName,cxrEmail,cxrMobile,cxrDob') problems.push('expected name, email, mobile, date of birth; found ' + f.inputs + at);
      if (!/Create Account/i.test(f.btn)) problems.push('Create Account button missing: ' + f.btn + at);
      if (f.hs) problems.push('sideways scroll on the register page' + at);

      // inline validation survives, and nothing is posted for an invalid form
      await page.eval(`document.getElementById('cxrForm').requestSubmit()`);
      await sleep(250);
      if (!/full name/i.test(await page.eval(`document.getElementById('cxrForm').innerText`))) problems.push('no name error for an empty form' + at);
      await setValue(page, 'cxrName', 'Asha Rao'); await setValue(page, 'cxrEmail', 'Asha.Rao@Example.com'); await setValue(page, 'cxrMobile', '12');
      await page.eval(`document.getElementById('cxrForm').requestSubmit()`);
      await sleep(250);
      if (!/8.15 digits/i.test(await page.eval(`document.getElementById('cxrForm').innerText`))) problems.push('no mobile error for a short number' + at);
      if (page.requests('/auth/signup').length) problems.push('/signup was called for an invalid form' + at);

      // a valid form posts the details and NO password keys, and reaches the code step with no session
      await setValue(page, 'cxrMobile', '+91 98765 43210');
      await page.eval(`document.getElementById('cxrForm').requestSubmit()`);
      await page.waitFor(() => document.getElementById('cxrStep2').classList.contains('is-active'), { label: 'the code step' });
      const req = page.requests('/auth/signup')[0];
      const body = req ? JSON.parse(req.body) : {};
      if (!req) problems.push('/signup was never called' + at);
      else {
        if (body.full_name !== 'Asha Rao' || body.email !== 'asha.rao@example.com' || body.mobile !== '+919876543210') problems.push('signup body is wrong: ' + req.body + at);
        if (Object.keys(body).some(k => /pass/i.test(k))) problems.push('signup still sends a password field: ' + Object.keys(body) + at);
        if ('date_of_birth' in body) problems.push('an empty optional date of birth was sent' + at);
      }
      if (await page.eval(`!!localStorage.getItem('jpc_access') || !!localStorage.getItem('jpc_refresh')`)) problems.push('a session exists before the emailed code was spent' + at);

      // a WRONG code signs nobody in and keeps them on the code step
      const off = page.route((u, m) => /\/auth\/verify-otp/.test(u) && m === 'POST', () => ({ status: 400, json: { detail: 'Incorrect verification code' } }));
      await setValue(page, 'cxrOtp', '000000');
      await page.eval(`document.getElementById('cxrVerify').click()`);
      await sleep(900);
      off();
      if (await page.eval(`!!localStorage.getItem('jpc_access')`)) problems.push('a WRONG code started a session' + at);
      if (!(await page.eval(`document.getElementById('cxrStep2').classList.contains('is-active')`))) problems.push('left the code step after a wrong code' + at);
      if (!/incorrect/i.test(await page.eval(`document.getElementById('cxrOtpMsg').textContent`))) problems.push('no error shown for a wrong code' + at);

      // the right code spends the signup challenge and starts the session
      await setValue(page, 'cxrOtp', '123456');
      await page.eval(`document.getElementById('cxrVerify').click()`);
      await sleep(900);
      const ver = page.requests('/auth/verify-otp').pop();
      if (!ver || JSON.parse(ver.body).challenge_token !== 'chal-su' || JSON.parse(ver.body).code !== '123456') problems.push('verify-otp was not called with the signup challenge and code: ' + (ver && ver.body) + at);
      if (!(await page.eval(`localStorage.getItem('jpc_access') === 'a.b.c'`))) problems.push('no session after the right code' + at);
      /* After the right code the page navigates to dashboard.html; Chrome may abort a cross-document ViewTransition during that
         navigation ("Transition was aborted because of invalid state"). That is the browser, not the page's own script. */
      errors.filter(e => !/ViewTransition|Transition was aborted/i.test(e)).forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'customer register page');
});

test('sign-in: an unknown email is reported beside the field', { timeout: 120000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const { page } = await open('/index.html', [1280, 800], { state: { unknownEmail: true } });
  try {
    await page.waitFor(() => !!document.querySelector('[data-pm-auth]'), { timeout: 15000, label: 'the header Login / Create link' });
    await page.eval(`document.querySelector('[data-pm-auth]').click()`);
    await page.waitFor(() => document.getElementById('authOverlay').classList.contains('open'), { label: 'the dialog' });
    await setValue(page, 'authEmail', 'nobody@example.com');
    await page.eval(`document.getElementById('authEmailForm').requestSubmit()`);
    await sleep(700);
    const err = await page.eval(`document.getElementById('authEmailErr').textContent`);
    assert.match(err, /couldn.t find an account with this email/i);
    assert.ok(!(await page.eval(`!document.getElementById('loginStepOtp').hidden`)), 'stayed on the email step');
  } finally { page.close(); }
});

/* ======================================================================= */
const TRAVELLER = [['p0_title', 'Mr'], ['p0_first', 'Test'], ['p0_last', 'Traveller'], ['p0_dob', '1990-05-15'], ['p0_gender', 'Male'], ['p0_nat', 'India'],
  ['p0_email', 'responsive.tester@example.com'], ['p0_mobile', '9900001001']];
const SHEET_BTNS = `[...document.querySelectorAll('.bk-sheet button, .bkf-foot button, .bk-bar button')].filter(b => b.getBoundingClientRect().width > 0)`;
const press = (page, prefix) => page.eval(`(() => { const b = ${SHEET_BTNS}.find(e => e.textContent.replace(/\\s+/g, ' ').trim().toLowerCase().startsWith(${JSON.stringify(prefix.toLowerCase())})); if (!b) return false; b.click(); return true; })()`);
const heading = (page) => page.eval(`[...document.querySelectorAll('.bk-sheet h2, .bkf-h2')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim()).join(' | ')`);

/** Flight results -> Select -> Traveller Details, filled -> Continue until `until()` is true. */
async function driveTo(page, until) {
  await page.waitFor(() => document.querySelectorAll('#txFlightList .jf-select').length > 0, { timeout: 20000, label: 'flight results' });
  await page.eval(`document.querySelector('.jf-select').click()`);
  await page.waitFor(() => !!document.querySelector('.bk-sheet.is-flight'), { label: 'the booking sheet' });
  await sleep(900);
  await press(page, 'continue to traveller'); await sleep(1200);
  for (const [id, v] of TRAVELLER) await setValue(page, id, v);
  for (let i = 0; i < 6; i++) {
    if (await page.eval(`(${until.toString()})()`)) return true;
    await press(page, 'continue'); await sleep(1500);
  }
  return !!(await page.eval(`(${until.toString()})()`));
}

test('flight Review: Traveller Details and Contact Details are ONE card with two labelled subsections; payment names are medium weight', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const vp of VIEWPORTS) {
    const at = ` @${vp.join('x')}`;
    const { page, errors } = await open(flightsPath(), vp);
    try {
      const atReview = await driveTo(page, () => !!document.querySelector('[data-rv-section="travellers"]'));
      if (!atReview) { problems.push('did not reach the Review step; headings: ' + await heading(page) + at); continue; }
      await sleep(400);
      const r = await page.eval(`(() => {
        const trav = document.querySelector('[data-rv-section="travellers"]'), con = document.querySelector('[data-rv-section="contact"]');
        const card = trav && trav.closest('.bkf-rvcard');
        const titles = [...document.querySelectorAll('.bkf-rvtitle span')].map(e => e.textContent.trim());
        const edits = (e) => e ? [...e.querySelectorAll('[data-bkf-edit], .bkf-edit')].length : 0;
        return {
          sameCard: !!card && !!con && card.contains(con),
          titles, nTrav: titles.filter(x => x === 'Traveller Details').length, nCon: titles.filter(x => x === 'Contact Details').length,
          cardsWithContactTitle: [...document.querySelectorAll('.bkf-rvcard')].filter(c => c.querySelector(':scope > .bkf-card-head .bkf-rvtitle')?.textContent.trim() === 'Contact Details').length,
          conText: con ? con.innerText.replace(/\\s+/g, ' ') : '', travText: trav ? trav.innerText.replace(/\\s+/g, ' ') : '',
          order: con && trav ? !!(trav.compareDocumentPosition(con) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
          editsTrav: edits(trav), editsCon: edits(con),
          visible: [trav, con].every(e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0),
          inX: card ? (card.getBoundingClientRect().left >= -1 && card.getBoundingClientRect().right <= innerWidth + 1) : false,
          hs: ${HS},
        };
      })()`);
      if (!r.sameCard) problems.push('Contact Details is not inside the Traveller Details card' + at);
      if (r.nTrav !== 1 || r.nCon !== 1) problems.push(`expected one Traveller Details and one Contact Details title, got ${r.nTrav}/${r.nCon}` + at);
      if (r.cardsWithContactTitle) problems.push('a separate Contact Details card still exists' + at);
      if (!r.order) problems.push('Contact Details does not follow Traveller Details' + at);
      if (!/Lead Traveller/.test(r.travText) || !/Test Traveller/.test(r.travText) || !/Details Verified/.test(r.travText)) problems.push('traveller fields missing: ' + r.travText.slice(0, 160) + at);
      if (!/responsive\.tester@example\.com/.test(r.travText) || !/9900001001/.test(r.travText)) problems.push('the traveller\'s own email/phone line is missing' + at);
      if (!/Email/.test(r.conText) || !/responsive\.tester@example\.com/.test(r.conText) || !/Mobile/.test(r.conText) || !/9900001001/.test(r.conText)) problems.push('contact fields missing: ' + r.conText + at);
      if (!/We will send booking updates on this contact/.test(r.conText)) problems.push('the contact confirmation line is missing' + at);
      if (r.editsTrav < 1 || r.editsCon < 1) problems.push(`each subsection keeps its Edit control (traveller ${r.editsTrav}, contact ${r.editsCon})` + at);
      if (!r.visible) problems.push('a subsection is not visible' + at);
      if (!r.inX) problems.push('the card overflows the viewport' + at);
      if (r.hs) problems.push('sideways scroll on Review' + at);

      // continue to payment: reached, methods present, names are not heavy, and they still select
      const atPay = await driveTo(page, () => !!document.querySelector('.bk-pay'));
      if (!atPay) { problems.push('did not reach the payment step from Review; headings: ' + await heading(page) + at); continue; }
      await sleep(400);
      const pay = await page.eval(`(() => {
        const rows = [...document.querySelectorAll('.bk-sheet.is-flight .bk-pay')].filter(e => e.getBoundingClientRect().width > 0);
        const names = rows.map(e => ({ t: e.querySelector('.bk-pay-body b')?.textContent.trim(), w: Number(getComputedStyle(e.querySelector('.bk-pay-body b')).fontWeight),
          fs: getComputedStyle(e.querySelector('.bk-pay-body b')).fontSize, icon: !!e.querySelector('.bk-pay-ic svg') }));
        const first = rows.find(e => !e.classList.contains('is-on')) || rows[0];
        first && first.click();
        return { names, selected: rows.filter(e => e.classList.contains('is-on')).length, hs: ${HS} };
      })()`);
      if (pay.names.length < 3) problems.push('fewer than three payment methods: ' + JSON.stringify(pay.names) + at);
      pay.names.forEach(n => { if (n.w > 600 || n.w < 500) problems.push(`payment name "${n.t}" has weight ${n.w}, expected 500-600` + at); if (!n.icon) problems.push(`payment "${n.t}" lost its icon` + at); });
      if (pay.selected !== 1) problems.push(`exactly one payment method should be selected, found ${pay.selected}` + at);
      if (pay.hs) problems.push('sideways scroll on the payment step' + at);
      if (page.requests(u => /checkout|razorpay|trustbrick|hdfc|payments/i.test(u.url) && u.method === 'POST').length) problems.push('a payment provider request was made while only reaching the payment step' + at);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'flight booking');
});

/* ======================================================================= */
test('notification bell: latest two only, "Show All Notifications" opens Profile -> Notifications, counts and clicks intact (phone, tablet, desktop)', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const vp of VIEWPORTS) {
    const at = ` @${vp.join('x')}`;
    const { page, errors } = await open('/index.html', vp, { signedIn: true });
    try {
      /* At <= 640px the site header HIDES the bell by design (jw-system.css; Notifications is reached from the profile
         menu there). To prove the dropdown PANEL itself fits a phone, the bell is un-hidden for this check only. */
      if (vp[0] <= 640) await page.eval(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '.jw-hdr .jw-hdr__acct, html.jp-signed-in .jw-hdr .jw-hdr__acct { display: grid !important; }' }))`);
      const bell = await page.eval(`(() => { const b = [...document.querySelectorAll('[data-nav-acct="notifications"]')].find(e => e.getBoundingClientRect().width > 0); if (!b) return null; return !!b.querySelector('.jp-nb-badge') ? b.querySelector('.jp-nb-badge').textContent : '' })()`);
      if (bell === null) { problems.push('no visible notification bell' + at); continue; }
      if (bell !== '2') problems.push(`badge should show the server's unread count (2), shows "${bell}"` + at);
      await page.eval(`[...document.querySelectorAll('[data-nav-acct="notifications"]')].find(e => e.getBoundingClientRect().width > 0).click()`);
      await page.waitFor(() => !!document.querySelector('.jp-nb-panel .jp-nb-item'), { label: 'the dropdown' });
      await sleep(300);
      const d = await page.eval(`(() => {
        const p = document.querySelector('.jp-nb-panel'), r = p.getBoundingClientRect();
        const items = [...p.querySelectorAll('.jp-nb-item')];
        return { n: items.length, titles: items.map(i => i.querySelector('.jp-nb-t').textContent.trim()), times: items.map(i => i.querySelector('.jp-nb-time').textContent.trim()),
          unreadRows: items.filter(i => i.classList.contains('is-unread')).length,
          w: Math.round(r.width), h: Math.round(r.height), inView: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1,
          foot: [...p.querySelectorAll('button')].map(b => b.textContent.trim()), hs: ${HS},
          footBelow: (() => { const f = p.querySelector('[data-nb-viewall]'); return !!f && f.getBoundingClientRect().top >= items[items.length - 1].getBoundingClientRect().bottom - 1; })() };
      })()`);
      if (d.n !== 2) problems.push(`the dropdown should list exactly 2 notifications, lists ${d.n}` + at);
      if (d.titles.join('|') !== 'Booking confirmed|Payment received') problems.push('the two shown are not the latest two: ' + d.titles + at);
      if (d.times.some(x => !x)) problems.push('a timestamp is missing' + at);
      if (d.unreadRows !== 2) problems.push('unread styling lost' + at);
      if (!d.foot.includes('Show All Notifications')) problems.push('no "Show All Notifications": ' + d.foot + at);
      if (d.foot.some(x => /^View all/i.test(x))) problems.push('the old "View all" label is still there' + at);
      if (!d.footBelow) problems.push('"Show All Notifications" is not below the notifications' + at);
      /* wider than a phone: the compact 320px panel; <= 480px the existing rule spans the viewport minus 12px gutters */
      const maxW = vp[0] > 480 ? 321 : vp[0] - 24 + 1;
      if (d.w > maxW) problems.push(`the dropdown is ${d.w}px wide; the most allowed here is ${maxW - 1}px` + at);
      if (!d.inView) problems.push('the dropdown does not fit the viewport' + at);
      if (d.hs) problems.push('sideways scroll with the dropdown open' + at);

      // a row click still marks that notification read on the server
      page.log.length = 0;
      await page.eval(`document.querySelector('.jp-nb-item[data-nb-id="4"]').click()`);
      await sleep(500);
      if (!page.requests(r => /\/notifications\/4\/read/.test(r.url) && r.method === 'PATCH').length) problems.push('clicking a notification did not PATCH /notifications/4/read' + at);

      // Show All Notifications -> the Account Center on its Notifications tab
      await page.eval(`document.querySelector('[data-nb-viewall]').click()`);
      await page.waitFor(() => { const p = document.getElementById('acctPanel-notifications'); return !!p && p.getBoundingClientRect().width > 0 && document.getElementById('acctNotificationsList').querySelectorAll('.acct-notif-item').length > 0; }, { label: 'Profile -> Notifications' });
      const all = await page.eval(`({ items: document.querySelectorAll('#acctNotificationsList .acct-notif-item').length, panelOpen: document.getElementById('accountModalOverlay').classList.contains('open'),
        dropdownGone: !document.querySelector('.jp-nb-panel') })`);
      if (all.items !== NOTES.length) problems.push(`Profile -> Notifications should list all ${NOTES.length}, lists ${all.items}` + at);
      if (!all.panelOpen) problems.push('the account modal is not open after Show All' + at);
      if (!all.dropdownGone) problems.push('the dropdown stayed open after Show All' + at);
      errors.forEach(e => problems.push('script error: ' + e + at));
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'notification bell');
});

/* ======================================================================= */
test('Profile -> Notifications: Clear All has an opaque background at rest, hover, focus and active', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const vp of VIEWPORTS) {
    const at = ` @${vp.join('x')}`;
    const { page } = await open('/index.html', vp, { signedIn: true });
    try {
      await page.eval(`AccountCenter.open('notifications')`);
      await page.waitFor(() => { const b = document.getElementById('acctClearAllBtn'); return !!b && b.getBoundingClientRect().width > 0; }, { label: 'the Clear All button' });
      await sleep(900);                                   // let the modal's opening transition finish
      /* LAYOUT size (offsetWidth/Height), not getBoundingClientRect: the latter includes transforms (the modal's open animation,
         the button's hover lift) and would report a "size change" that is only motion. */
      const before = await page.eval(`(() => { const b = document.getElementById('acctClearAllBtn');
        return { w: b.offsetWidth, h: b.offsetHeight, text: b.textContent.trim() }; })()`);
      if (before.text !== 'Clear All') problems.push('label changed: ' + before.text + at);

      await page.send('DOM.enable'); await page.send('CSS.enable');
      const { root } = await page.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#acctClearAllBtn' });
      const paint = () => page.eval(`(() => { const s = getComputedStyle(document.getElementById('acctClearAllBtn')); return { bg: s.backgroundColor, img: s.backgroundImage, op: s.opacity }; })()`);
      const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 0; const p = m[1].split(',').map(x => parseFloat(x)); return p.length === 4 ? p[3] : 1; };
      for (const state of [[], ['hover'], ['focus', 'focus-visible'], ['active'], ['hover', 'active']]) {
        await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state });
        const p = await paint();
        const label = state.join('+') || 'rest';
        if (alpha(p.bg) !== 1) problems.push(`Clear All is not opaque at ${label}: ${p.bg}` + at);
        if (p.op !== '1') problems.push(`Clear All opacity ${p.op} at ${label}` + at);
      }
      await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      const after = await page.eval(`(() => { const b = document.getElementById('acctClearAllBtn'); return { w: b.offsetWidth, h: b.offsetHeight }; })()`);
      if (after.w !== before.w || after.h !== before.h) problems.push('size changed between states' + at);

      // functionality: Clear All asks first, then DELETEs the read notifications
      await page.eval(`window.confirm = () => true; document.getElementById('acctClearAllBtn').click()`);
      await sleep(500);
      if (!page.requests(r => /\/customer\/notifications\/read$/.test(r.url) && r.method === 'DELETE').length) problems.push('Clear All no longer issues DELETE /notifications/read' + at);
    } finally { page.close(); }
  }
  assert.deepEqual(problems, [], 'Clear All');
});
