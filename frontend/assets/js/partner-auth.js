'use strict';
/* Merchant Portal — Login -> Password -> OTP -> Dashboard (docs/API_CONTRACT.md §1).
   Uses the shared /api/auth/login|verify-otp|resend-otp endpoints (portal="merchant"),
   via the helpers in assets/js/auth.js. Replaces the old email-first, partner-only
   /api/partner-auth/* flow, which called endpoints that no longer exist. */

let pendingChallengeToken = '';
let pendingEmail = '';

function showAuthStep(id) {
  document.querySelectorAll('.auth-step').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const dotForStep = { authStep1: 1, authStep2: 2 };
  const activeDot = dotForStep[id];
  document.querySelectorAll('.auth-step-dot').forEach(d => {
    const n = Number(d.dataset.stepDot);
    d.classList.toggle('active', n === activeDot);
    d.classList.toggle('done', activeDot && n < activeDot);
  });
}
function resetAuthFlow() {
  pendingChallengeToken = '';
  pendingEmail = '';
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authOtp').value = '';
  ['authStep1Msg', 'authStep2Msg'].forEach(id => { document.getElementById(id).textContent = ''; });
  showAuthStep('authStep1');
}
function setMsg(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

/* ---------- Step 1: email + password -> OTP challenge ---------- */
document.getElementById('partnerLoginBtn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!email || !password) return setMsg('authStep1Msg', 'Enter your email and password.', 'error');
  const btn = document.getElementById('partnerLoginBtn');
  btn.disabled = true;
  try {
    const challenge = await startPortalLogin('merchant', email, password);
    pendingChallengeToken = challenge.challenge_token;
    pendingEmail = email;
    document.getElementById('authStep2Sub').textContent = challenge.dev_otp
      ? `Dev mode — code: ${challenge.dev_otp}`
      : `Enter the 6-digit code sent to ${email}`;
    setMsg('authStep1Msg', '', '');
    showAuthStep('authStep2');
  } catch (err) {
    setMsg('authStep1Msg', err.response?.data?.detail || 'Invalid email or password.', 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Step 2: verify OTP -> tokens ---------- */
document.getElementById('verifyOtpBtn').addEventListener('click', async () => {
  const code = document.getElementById('authOtp').value.trim();
  if (code.length < 4) return setMsg('authStep2Msg', 'Enter the code sent to your email.', 'error');
  const btn = document.getElementById('verifyOtpBtn');
  btn.disabled = true;
  try {
    const data = await verifyPortalOtp(pendingChallengeToken, code);
    storePortalTokens('merchant', data);
    resetAuthFlow();
    showPartnerPortal();
  } catch (err) {
    setMsg('authStep2Msg', err.response?.data?.detail || 'Incorrect or expired code.', 'error');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('resendOtpBtn').addEventListener('click', async () => {
  try {
    const challenge = await resendPortalOtp(pendingChallengeToken);
    pendingChallengeToken = challenge.challenge_token;
    setMsg('authStep2Msg', challenge.dev_otp ? `Dev mode — new code: ${challenge.dev_otp}` : 'A new code has been sent.', 'success');
  } catch (err) {
    setMsg('authStep2Msg', err.response?.data?.detail || 'Could not resend the code.', 'error');
  }
});
document.getElementById('backToCredsBtn').addEventListener('click', () => {
  pendingChallengeToken = '';
  showAuthStep('authStep1');
});

/* Boot check lives in a small inline <script> at the end of partner-portal.html,
   after every section's JS has loaded — not here, since this file loads
   before partner-dashboard.js etc. and showPartnerPortal() needs those
   loader functions (loadDashboard and friends) to already exist. */
