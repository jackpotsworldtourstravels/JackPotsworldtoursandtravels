'use strict';
/* Admin Portal — Login -> Password -> OTP -> Dashboard (docs/API_CONTRACT.md §1).
   Uses the shared /api/auth/login|verify-otp|resend-otp endpoints (portal="admin"), via the
   helpers in assets/js/auth.js. Admin previously had no dedicated login of its own — it relied
   on the public site's shared customer/admin login page and a role check. This is net new. */

let adminPendingChallengeToken = '';

function showAdminAuthStep(id) {
  document.querySelectorAll('#adminAuthShell .auth-step').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const dotForStep = { adminAuthStep1: 1, adminAuthStep2: 2 };
  const activeDot = dotForStep[id];
  document.querySelectorAll('#adminAuthStepper .auth-step-dot').forEach(d => {
    const n = Number(d.dataset.stepDot);
    d.classList.toggle('active', n === activeDot);
    d.classList.toggle('done', activeDot && n < activeDot);
  });
}
function resetAdminAuthFlow() {
  adminPendingChallengeToken = '';
  document.getElementById('adminEmail').value = '';
  document.getElementById('adminPassword').value = '';
  document.getElementById('adminOtp').value = '';
  document.getElementById('adminLoginMsg').textContent = '';
  document.getElementById('adminAuthStep2Msg').textContent = '';
  showAdminAuthStep('adminAuthStep1');
}

/* ---------- Step 1: email + password -> OTP challenge ---------- */
document.getElementById('adminLoginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('adminLoginMsg');
  const email = document.getElementById('adminEmail').value.trim();
  const password = document.getElementById('adminPassword').value;
  msg.className = 'msg'; msg.textContent = '';

  if (!email || !password) {
    msg.className = 'msg error';
    msg.textContent = 'Enter your email and password.';
    return;
  }
  try {
    const challenge = await startPortalLogin('admin', email, password);
    adminPendingChallengeToken = challenge.challenge_token;
    document.getElementById('adminAuthStep2Sub').textContent = challenge.dev_otp
      ? `Dev mode — code: ${challenge.dev_otp}`
      : `Enter the 6-digit code sent to ${email}`;
    showAdminAuthStep('adminAuthStep2');
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Invalid email or password.';
  }
});

/* ---------- Step 2: verify OTP -> tokens ---------- */
document.getElementById('adminVerifyOtpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('adminAuthStep2Msg');
  const code = document.getElementById('adminOtp').value.trim();
  if (code.length < 4) { msg.className = 'msg error'; msg.textContent = 'Enter the code sent to your email.'; return; }
  const btn = document.getElementById('adminVerifyOtpBtn');
  btn.disabled = true;
  try {
    const data = await verifyPortalOtp(adminPendingChallengeToken, code);
    storePortalTokens('admin', data);
    resetAdminAuthFlow();
    showAdminPortal();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Incorrect or expired code.';
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('adminResendOtpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('adminAuthStep2Msg');
  try {
    const challenge = await resendPortalOtp(adminPendingChallengeToken);
    adminPendingChallengeToken = challenge.challenge_token;
    msg.className = 'msg success';
    msg.textContent = challenge.dev_otp ? `Dev mode — new code: ${challenge.dev_otp}` : 'A new code has been sent.';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Could not resend the code.';
  }
});
document.getElementById('adminBackToCredsBtn').addEventListener('click', () => {
  adminPendingChallengeToken = '';
  showAdminAuthStep('adminAuthStep1');
});
