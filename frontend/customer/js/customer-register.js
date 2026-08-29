'use strict';
/* ==========================================================================
   CUSTOMER PORTAL — create an account
   ==========================================================================
   Signup finishes at the SAME verification step as a login, so a new customer
   lands signed in rather than being bounced to a login form to type the
   password they just chose.

   EVERY RULE HERE IS ALSO ENFORCED SERVER-SIDE (schemas/customer.py). These
   checks exist to give the field that is wrong a message next to it, not to
   be the protection — the endpoint is reachable without this page.
   ========================================================================== */

const CXR = {
  step1: 'cxrStep1', step2: 'cxrStep2',
  form: 'cxrForm',
  name: 'cxrName', email: 'cxrEmail', mobile: 'cxrMobile', dob: 'cxrDob',
  password: 'cxrPassword', confirm: 'cxrConfirm', msg: 'cxrMsg',
  otp: 'cxrOtp', otpSub: 'cxrOtpSub', otpMsg: 'cxrOtpMsg', devBox: 'cxrDev',
  verify: 'cxrVerify', resend: 'cxrResend', back: 'cxrBack',
};

let cxrChallenge = null;

function cxrCard() {
  return `
    <div class="cx-stepper">
      <div class="cx-dot is-active" data-dot="1">1</div>
      <div class="cx-line"></div>
      <div class="cx-dot" data-dot="2">2</div>
    </div>

    <div class="cx-step is-active" id="${CXR.step1}" data-step-no="1">
      ${cxHead('user', 'Create Your Account', 'A few details and you are ready to book.')}
      <form id="${CXR.form}" novalidate>
        ${cxField(CXR.name, 'Full Name', 'user',
                  'type="text" autocomplete="name" placeholder="As printed on your passport"')}
        ${cxField(CXR.email, 'Email Address', 'mail',
                  'type="email" autocomplete="email" spellcheck="false" placeholder="you@example.com"')}
        ${cxField(CXR.mobile, 'Mobile Number', 'phone',
                  'type="tel" autocomplete="tel" placeholder="+91 98765 43210"')}
        ${cxField(CXR.dob, 'Date of Birth', 'cake',
                  'type="date" autocomplete="bday"', { hint: 'Optional.' })}
        ${cxField(CXR.password, 'Password', 'lock',
                  'type="password" autocomplete="new-password" placeholder="At least 8 characters"',
                  { eye: true, hint: 'Use 8 characters or more.' })}
        ${cxField(CXR.confirm, 'Confirm Password', 'lock',
                  'type="password" autocomplete="new-password" placeholder="Re-enter your password"',
                  { eye: true })}

        <button type="submit" class="cx-btn">Create Account ${cxIco('arrow')}</button>
        <div class="cx-msg" id="${CXR.msg}"></div>
      </form>

      <div class="cx-switch">Already have an account? <a href="index.html">Sign in</a></div>
    </div>

    ${cxOtpStep(CXR)}`;
}

/* ------------------------------------------------------------------ boot */
cxRedirectIfSignedIn();

document.getElementById('cxShell').innerHTML = cxAuthShell(cxrCard(), {
  heading: 'Travel made',
  headingAccent: 'simple.',
  tagline: 'Create an account to book flights, hotels and holidays &mdash; and keep every trip in one place.',
});
document.querySelector('#' + CXR.step2).dataset.stepNo = '2';
cxBindEyes();
cxBindClearOnInput();

/* The date picker must not offer tomorrow as a birthday. Set from the browser
   clock rather than hardcoded, so it stays right next year. */
document.getElementById(CXR.dob).max = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------ validation */
const CX_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CX_MOBILE_RE = /^\+?\d{8,15}$/;

function cxrValidate(values) {
  let firstBad = null;
  const bad = (id, msg) => { cxFieldError(id, msg); firstBad = firstBad || id; };

  if (values.full_name.length < 2) bad(CXR.name, 'Enter your full name');
  if (!CX_EMAIL_RE.test(values.email)) bad(CXR.email, 'Enter a valid email address');
  if (!CX_MOBILE_RE.test(values.mobile)) {
    bad(CXR.mobile, 'Enter 8–15 digits, optionally starting with +');
  }
  if (values.password.length < 8) bad(CXR.password, 'Use at least 8 characters');
  // bcrypt truncates past 72 bytes, so a longer password would silently not be
  // the password they typed. The server rejects it; say so here first.
  if (values.password.length > 72) bad(CXR.password, 'Use 72 characters or fewer');
  if (values.confirm_password !== values.password) bad(CXR.confirm, 'Passwords do not match');

  return firstBad;
}

/* ------------------------------------------------------------- step one */
document.getElementById(CXR.form).addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  cxMsg(CXR.msg, '');
  cxClearFieldErrors();

  const dob = document.getElementById(CXR.dob).value;
  const values = {
    full_name: document.getElementById(CXR.name).value.trim().replace(/\s+/g, ' '),
    email: document.getElementById(CXR.email).value.trim().toLowerCase(),
    // Spaces and dashes are stripped so "+91 98765 43210" and "+919876543210"
    // are one number — the same normalisation the service applies before the
    // unique index sees it.
    mobile: document.getElementById(CXR.mobile).value.trim().replace(/[\s-]/g, ''),
    password: document.getElementById(CXR.password).value,
    confirm_password: document.getElementById(CXR.confirm).value,
  };
  if (dob) values.date_of_birth = dob;

  const firstBad = cxrValidate(values);
  if (firstBad) { document.getElementById(firstBad).focus(); return; }

  cxBusy(btn, true, 'Creating your account…');
  try {
    const data = await cxFetch('/api/customer/auth/signup', { method: 'POST', body: values });
    cxrChallenge = data.challenge_token;
    document.getElementById(CXR.otpSub).textContent = data.message;
    cxDevOtp(CXR.devBox, data.dev_otp);
    cxStep(CXR.step2);
    document.getElementById(CXR.otp).focus();
  } catch (err) {
    // Put a duplicate against the field it belongs to — a message at the
    // bottom of a six-field form does not say which one to change.
    const m = err.message.toLowerCase();
    if (err.status === 400 && m.includes('email') && !m.includes('mobile')) {
      cxFieldError(CXR.email, err.message);
      document.getElementById(CXR.email).focus();
    } else if (err.status === 400 && m.includes('mobile') && !m.includes('email')) {
      cxFieldError(CXR.mobile, err.message);
      document.getElementById(CXR.mobile).focus();
    } else {
      cxMsg(CXR.msg, err.message);
    }
  } finally {
    cxBusy(btn, false);
  }
});

/* ------------------------------------------------------------- step two */
async function cxrVerify() {
  const btn = document.getElementById(CXR.verify);
  const code = document.getElementById(CXR.otp).value.trim();
  cxMsg(CXR.otpMsg, '');
  cxClearFieldErrors();
  if (code.length < 4) { cxFieldError(CXR.otp, 'Enter the 6-digit code'); return; }

  cxBusy(btn, true, 'Verifying…');
  try {
    const tokens = await cxFetch('/api/customer/auth/verify-otp', {
      method: 'POST', body: { challenge_token: cxrChallenge, code },
    });
    cxSession.save(tokens);
    cxMsg(CXR.otpMsg, 'Account verified — taking you to your account…', 'is-ok');
    location.replace('dashboard.html');
  } catch (err) {
    // The account EXISTS at this point — signup committed before the code was
    // sent. Going back to step one would offer to create it again and collide
    // on the email, so the way out is the login page, not the form behind us.
    if (err.status === 401) {
      cxMsg(CXR.otpMsg,
        'That verification window has closed. Your account was created — please sign in.');
      setTimeout(() => location.replace('index.html'), 2600);
    } else {
      cxMsg(CXR.otpMsg, err.message);
    }
  } finally {
    cxBusy(btn, false);
  }
}

document.getElementById(CXR.verify).addEventListener('click', cxrVerify);
document.getElementById(CXR.otp).addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); cxrVerify(); }
});

document.getElementById(CXR.resend).addEventListener('click', async () => {
  const btn = document.getElementById(CXR.resend);
  cxBusy(btn, true, 'Sending…');
  try {
    const data = await cxFetch('/api/customer/auth/resend-otp', {
      method: 'POST', body: { challenge_token: cxrChallenge },
    });
    cxrChallenge = data.challenge_token;
    cxDevOtp(CXR.devBox, data.dev_otp);
    cxMsg(CXR.otpMsg, 'A new code has been sent.', 'is-ok');
  } catch (err) {
    cxMsg(CXR.otpMsg, err.message);
  } finally {
    cxBusy(btn, false);
  }
});

/* Same reasoning as the 401 above: the account is already created, so "back"
   goes to the sign-in page rather than to a form that would re-submit it. */
document.getElementById(CXR.back).addEventListener('click', () => {
  location.href = 'index.html';
});
