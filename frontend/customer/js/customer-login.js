'use strict';
/* ==========================================================================
   CUSTOMER PORTAL — sign in
   ==========================================================================
   Two panes: password, then the code. Exactly the flow the three internal
   portals use, against /api/customer/auth/* instead of /api/auth/*.
   ========================================================================== */

const CXL = {
  step1: 'cxlStep1', step2: 'cxlStep2',
  form: 'cxlForm', identifier: 'cxlIdentifier', password: 'cxlPassword',
  remember: 'cxlRemember', msg: 'cxlMsg',
  otp: 'cxlOtp', otpSub: 'cxlOtpSub', otpMsg: 'cxlOtpMsg', devBox: 'cxlDev',
  verify: 'cxlVerify', resend: 'cxlResend', back: 'cxlBack',
};

/* Holds the challenge token between the two steps. Deliberately a module
   variable and not localStorage: it is worthless once spent, and a half-
   finished login left in storage is a thing to reason about later. */
let cxlChallenge = null;

function cxlCard() {
  return `
    <div class="cx-stepper">
      <div class="cx-dot is-active" data-dot="1">1</div>
      <div class="cx-line"></div>
      <div class="cx-dot" data-dot="2">2</div>
    </div>

    <div class="cx-step is-active" id="${CXL.step1}" data-step-no="1">
      ${cxHead('user', 'Welcome Back', 'Sign in to manage your trips and bookings.')}
      <form id="${CXL.form}" novalidate>
        ${cxField(CXL.identifier, 'Email or Mobile Number', 'user',
                  'type="text" autocomplete="username" spellcheck="false" placeholder="you@example.com or +919876543210"')}
        ${cxField(CXL.password, 'Password', 'lock',
                  'type="password" autocomplete="current-password" placeholder="Enter your password"',
                  { eye: true })}

        <div class="cx-row">
          <label class="cx-remember"><input type="checkbox" id="${CXL.remember}"> Remember me</label>
          <a class="cx-link" href="forgot-password.html">Forgot Password?</a>
        </div>

        <button type="submit" class="cx-btn">Sign In ${cxIco('arrow')}</button>
        <div class="cx-msg" id="${CXL.msg}"></div>
      </form>

      <div class="cx-switch">New here? <a href="register.html">Create an account</a></div>
    </div>

    ${cxOtpStep(CXL)}`;
}

/* ------------------------------------------------------------------ boot */
cxRedirectIfSignedIn();

document.getElementById('cxShell').innerHTML = cxAuthShell(cxlCard(), {
  heading: 'Your next journey',
  tagline: 'Sign in to see your bookings, travellers and trip documents in one place.',
});
document.querySelector('#' + CXL.step2).dataset.stepNo = '2';
cxBindEyes();
cxBindClearOnInput();
cxBindRemember(CXL.form, CXL.identifier, CXL.remember);

/* Arriving from the public site's Login modal, which hands the typed address
   over so it is not typed twice. AFTER cxBindRemember, so a value carried in
   the link wins over a remembered one — it is the more recent intent. Only
   the address ever travels; app.js deliberately leaves the password behind. */
const cxlHandoff = new URLSearchParams(location.search).get('identifier');
if (cxlHandoff) {
  document.getElementById(CXL.identifier).value = cxlHandoff;
  document.getElementById(CXL.password).focus();
} else {
  document.getElementById(CXL.identifier).focus();
}

/* ------------------------------------------------------------ step one */
document.getElementById(CXL.form).addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const identifier = document.getElementById(CXL.identifier).value.trim();
  const password = document.getElementById(CXL.password).value;

  cxMsg(CXL.msg, '');
  cxClearFieldErrors();

  if (!identifier) { cxFieldError(CXL.identifier, 'Enter your email address or mobile number'); return; }
  if (!password) { cxFieldError(CXL.password, 'Enter your password'); return; }

  cxBusy(btn, true, 'Signing in…');
  try {
    const data = await cxFetch('/api/customer/auth/login', {
      method: 'POST', body: { identifier, password },
    });
    cxlChallenge = data.challenge_token;
    document.getElementById(CXL.otpSub).textContent = data.message;
    cxDevOtp(CXL.devBox, data.dev_otp);
    cxStep(CXL.step2);
    document.getElementById(CXL.otp).focus();
  } catch (err) {
    cxMsg(CXL.msg, err.message);
  } finally {
    cxBusy(btn, false);
  }
});

/* ------------------------------------------------------------ step two */
async function cxlVerify() {
  const btn = document.getElementById(CXL.verify);
  const code = document.getElementById(CXL.otp).value.trim();
  cxMsg(CXL.otpMsg, '');
  cxClearFieldErrors();

  if (code.length < 4) { cxFieldError(CXL.otp, 'Enter the 6-digit code'); return; }

  cxBusy(btn, true, 'Verifying…');
  try {
    const tokens = await cxFetch('/api/customer/auth/verify-otp', {
      method: 'POST', body: { challenge_token: cxlChallenge, code },
    });
    cxSession.save(tokens);
    cxMsg(CXL.otpMsg, 'Signed in — taking you to your account…', 'is-ok');
    location.replace('dashboard.html');
  } catch (err) {
    // A dead challenge means the 10-minute window closed. Sending them back to
    // step one is the only thing that can work, so say so rather than leaving
    // them retrying a code against a token the server has forgotten.
    if (err.status === 401) {
      cxMsg(CXL.msg, err.message);
      cxStep(CXL.step1);
    } else {
      cxMsg(CXL.otpMsg, err.message);
    }
  } finally {
    cxBusy(btn, false);
  }
}

document.getElementById(CXL.verify).addEventListener('click', cxlVerify);
document.getElementById(CXL.otp).addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); cxlVerify(); }
});

document.getElementById(CXL.resend).addEventListener('click', async () => {
  const btn = document.getElementById(CXL.resend);
  cxBusy(btn, true, 'Sending…');
  try {
    const data = await cxFetch('/api/customer/auth/resend-otp', {
      method: 'POST', body: { challenge_token: cxlChallenge },
    });
    cxlChallenge = data.challenge_token;
    cxDevOtp(CXL.devBox, data.dev_otp);
    cxMsg(CXL.otpMsg, 'A new code has been sent.', 'is-ok');
  } catch (err) {
    cxMsg(CXL.otpMsg, err.message);
  } finally {
    cxBusy(btn, false);
  }
});

document.getElementById(CXL.back).addEventListener('click', () => {
  cxlChallenge = null;
  document.getElementById(CXL.otp).value = '';
  cxMsg(CXL.otpMsg, '');
  cxDevOtp(CXL.devBox, null);
  cxStep(CXL.step1);
});
