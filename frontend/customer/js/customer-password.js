'use strict';
/* ==========================================================================
   CUSTOMER PORTAL — forgot password / reset password
   ==========================================================================
   One file, two screens, chosen by `data-cx-screen` on the shell element —
   they are two halves of one flow and share every helper.

   THERE IS NO OTP STEP IN THIS FLOW, and that is the backend's design rather
   than an omission: /forgot-password mails a tokenised LINK and
   /reset-password takes {token, new_password}. There is no endpoint a code
   screen here could submit to.
   ========================================================================== */

const CXP = {
  step1: 'cxpStep1', step2: 'cxpStep2',
  form: 'cxpForm', email: 'cxpEmail', msg: 'cxpMsg',
  password: 'cxpPassword', confirm: 'cxpConfirm', sub: 'cxpSub',
};

/* -------------------------------------------------------------- forgot --- */
function cxpForgotCard() {
  return `
    <div class="cx-step is-active" id="${CXP.step1}" data-step-no="1">
      ${cxHead('key', 'Forgot Password', 'Enter your registered email and we will send you a reset link.')}
      <form id="${CXP.form}" novalidate>
        ${cxField(CXP.email, 'Email Address', 'mail',
                  'type="email" autocomplete="username" spellcheck="false" placeholder="Enter your registered email"')}
        <button type="submit" class="cx-btn">Send Reset Link ${cxIco('arrow')}</button>
        <div class="cx-msg" id="${CXP.msg}"></div>
        <a class="cx-btn cx-btn-ghost" href="index.html">&larr; Back to Sign In</a>
      </form>
    </div>

    <div class="cx-step" id="${CXP.step2}" data-step-no="2">
      ${cxHead('check', 'Check Your Email',
               'If that address is registered we have sent a reset link to it.', { done: true })}
      <div class="cx-msg is-info" id="cxpSentNote"></div>
      <a class="cx-btn" href="index.html">Go to Sign In ${cxIco('arrow')}</a>
    </div>`;
}

/* --------------------------------------------------------------- reset --- */
function cxpResetCard() {
  return `
    <div class="cx-step is-active" id="${CXP.step1}" data-step-no="1">
      ${cxHead('lock', 'Reset Password', 'Choose a new password for your account.', { subId: CXP.sub })}
      <form id="${CXP.form}" novalidate>
        ${cxField(CXP.password, 'New Password', 'lock',
                  'type="password" autocomplete="new-password" placeholder="At least 8 characters"',
                  { eye: true, hint: 'Use 8 characters or more.' })}
        ${cxField(CXP.confirm, 'Confirm Password', 'lock',
                  'type="password" autocomplete="new-password" placeholder="Re-enter the new password"',
                  { eye: true })}
        <button type="submit" class="cx-btn">Update Password ${cxIco('arrow')}</button>
        <div class="cx-msg" id="${CXP.msg}"></div>
        <a class="cx-btn cx-btn-ghost" href="index.html">&larr; Back to Sign In</a>
      </form>
    </div>

    <div class="cx-step" id="${CXP.step2}" data-step-no="2">
      ${cxHead('check', 'Password Updated',
               'Your password has been changed. For your security every other session has been signed out.',
               { done: true })}
      <a class="cx-btn" href="index.html">Go to Sign In ${cxIco('arrow')}</a>
    </div>`;
}

/* ---------------------------------------------------------------- boot --- */
const cxpShell = document.getElementById('cxShell');
const cxpScreen = cxpShell.dataset.cxScreen;
const cxpIsReset = cxpScreen === 'reset';

cxpShell.innerHTML = cxAuthShell(cxpIsReset ? cxpResetCard() : cxpForgotCard(), {
  heading: cxpIsReset ? 'Almost' : 'Happens to',
  headingAccent: cxpIsReset ? 'there.' : 'everyone.',
  tagline: cxpIsReset
    ? 'Choose a new password and you are back to planning your next trip.'
    : 'Tell us your registered email address and we will send you a link to set a new password.',
});
cxBindEyes();
cxBindClearOnInput();

/* The token rides in the query string of the emailed link. Read once. */
const cxpToken = new URLSearchParams(location.search).get('token');

if (cxpIsReset) {
  if (!cxpToken) {
    // Nothing on this screen can work without it, so say so and disable the
    // form rather than letting someone fill it in and fail at submit.
    document.getElementById(CXP.sub).textContent =
      'This reset link is incomplete. Please open the link from your email again, or request a new one.';
    document.getElementById(CXP.form).querySelectorAll('input, button[type="submit"]')
      .forEach(el => { el.disabled = true; });
    cxMsg(CXP.msg, 'No reset token found in the link.', 'is-error');
  }

  document.getElementById(CXP.form).addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const pw = document.getElementById(CXP.password).value;
    const confirm = document.getElementById(CXP.confirm).value;

    cxMsg(CXP.msg, '');
    cxClearFieldErrors();
    if (pw.length < 8) { cxFieldError(CXP.password, 'Use at least 8 characters'); return; }
    if (pw.length > 72) { cxFieldError(CXP.password, 'Use 72 characters or fewer'); return; }
    if (pw !== confirm) { cxFieldError(CXP.confirm, 'Passwords do not match'); return; }

    cxBusy(btn, true, 'Updating…');
    try {
      await cxFetch('/api/customer/auth/reset-password', {
        method: 'POST',
        body: { token: cxpToken, new_password: pw, confirm_password: confirm },
      });
      // The reset revoked every session server-side; drop the local copy too so
      // a stale token in this browser cannot be presented afterwards.
      cxSession.clear();
      cxStep(CXP.step2);
    } catch (err) {
      cxMsg(CXP.msg, err.message);
    } finally {
      cxBusy(btn, false);
    }
  });
} else {
  document.getElementById(CXP.form).addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const email = document.getElementById(CXP.email).value.trim().toLowerCase();

    cxMsg(CXP.msg, '');
    cxClearFieldErrors();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      cxFieldError(CXP.email, 'Enter a valid email address');
      return;
    }

    cxBusy(btn, true, 'Sending…');
    try {
      const data = await cxFetch('/api/customer/auth/forgot-password', {
        method: 'POST', body: { email },
      });
      // The API answers identically whether or not the address is registered,
      // so this screen must not imply an account was found.
      const note = document.getElementById('cxpSentNote');
      if (data.reset_link) {
        // Debug mode only — the server returns the link directly when it has
        // no SMTP to send it with, so local testing has a way through.
        note.innerHTML =
          `Email is not configured on this server. <a class="cx-link" href="${data.reset_link}">Open the reset link</a>`;
      } else {
        note.textContent = 'The link is valid for a limited time. Check your spam folder if it does not arrive.';
      }
      cxStep(CXP.step2);
    } catch (err) {
      cxMsg(CXP.msg, err.message);
    } finally {
      cxBusy(btn, false);
    }
  });
}
