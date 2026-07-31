'use strict';
/* Super Admin Portal — Login -> Password -> OTP -> Dashboard (docs/API_CONTRACT.md §1).
   Uses the shared /api/auth/login|verify-otp|resend-otp endpoints (portal="super_admin"),
   via the helpers in assets/js/auth.js. Replaces the old single-step, no-OTP flow against
   the now-dead /api/super-admin/auth/login endpoint. */

let saPendingChallengeToken = '';

function saShowAuthStep(id) {
  document.querySelectorAll('#saAuthShell .auth-step').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const dotForStep = { saAuthStep1: 1, saAuthStep2: 2 };
  const activeDot = dotForStep[id];
  document.querySelectorAll('#saAuthStepper .auth-step-dot').forEach(d => {
    const n = Number(d.dataset.stepDot);
    d.classList.toggle('active', n === activeDot);
    d.classList.toggle('done', activeDot && n < activeDot);
  });
}
function saResetAuthFlow() {
  saPendingChallengeToken = '';
  document.getElementById('saUsername').value = '';
  document.getElementById('saPassword').value = '';
  document.getElementById('saOtp').value = '';
  document.getElementById('saLoginMsg').textContent = '';
  document.getElementById('saAuthStep2Msg').textContent = '';
  saShowAuthStep('saAuthStep1');
}

/* ---------- Step 1: email + password -> OTP challenge ---------- */
document.getElementById('saLoginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('saLoginMsg');
  const email = document.getElementById('saUsername').value.trim();
  const password = document.getElementById('saPassword').value;
  msg.className = 'msg'; msg.textContent = '';

  if (!email || !password) {
    msg.className = 'msg error';
    msg.textContent = 'Enter your email and password.';
    return;
  }
  try {
    const challenge = await startPortalLogin('super_admin', email, password);
    saPendingChallengeToken = challenge.challenge_token;
    document.getElementById('saAuthStep2Sub').textContent = challenge.dev_otp
      ? `Dev mode — code: ${challenge.dev_otp}`
      : `Enter the 6-digit code sent to ${email}`;
    saShowAuthStep('saAuthStep2');
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Invalid email or password.';
  }
});

/* ---------- Step 2: verify OTP -> tokens ---------- */
document.getElementById('saVerifyOtpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('saAuthStep2Msg');
  const code = document.getElementById('saOtp').value.trim();
  if (code.length < 4) { msg.className = 'msg error'; msg.textContent = 'Enter the code sent to your email.'; return; }
  const btn = document.getElementById('saVerifyOtpBtn');
  btn.disabled = true;
  try {
    const data = await verifyPortalOtp(saPendingChallengeToken, code);
    storePortalTokens('super_admin', data);
    saResetAuthFlow();
    showSuperAdminPortal();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Incorrect or expired code.';
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('saResendOtpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('saAuthStep2Msg');
  try {
    const challenge = await resendPortalOtp(saPendingChallengeToken);
    saPendingChallengeToken = challenge.challenge_token;
    msg.className = 'msg success';
    msg.textContent = challenge.dev_otp ? `Dev mode — new code: ${challenge.dev_otp}` : 'A new code has been sent.';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Could not resend the code.';
  }
});
document.getElementById('saBackToCredsBtn').addEventListener('click', () => {
  saPendingChallengeToken = '';
  saShowAuthStep('saAuthStep1');
});
