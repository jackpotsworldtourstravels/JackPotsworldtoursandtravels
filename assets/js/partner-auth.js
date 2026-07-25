'use strict';
/* Partner Portal — 3-step OTP authentication flow.
   Enter email -> Send OTP -> Verify OTP -> Email Verified -> Enter Password
   -> Partner Login -> Dashboard. Plus Forgot Password (its own OTP round trip). */

let pendingEmail = '';

function showAuthStep(id) {
  document.querySelectorAll('.auth-step').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const dotForStep = { authStep1: 1, authStep2: 2, authStep3: 3 };
  const activeDot = dotForStep[id];
  document.querySelectorAll('.auth-step-dot').forEach(d => {
    const n = Number(d.dataset.stepDot);
    d.classList.toggle('active', n === activeDot);
    d.classList.toggle('done', activeDot && n < activeDot);
  });
}
function resetAuthFlow() {
  pendingEmail = '';
  document.getElementById('authEmail').value = '';
  document.getElementById('authOtp').value = '';
  document.getElementById('authPassword').value = '';
  ['authStep1Msg', 'authStep2Msg', 'authStep3Msg', 'authForgotStep1Msg', 'authForgotStep2Msg'].forEach(id => {
    document.getElementById(id).textContent = '';
  });
  showAuthStep('authStep1');
}

function setMsg(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

/* ---------- Step 1: Send OTP ---------- */
document.getElementById('sendOtpBtn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  if (!email) return setMsg('authStep1Msg', 'Enter your email address.', 'error');
  const btn = document.getElementById('sendOtpBtn');
  btn.disabled = true;
  try {
    await axios.post(`${API_BASE}/api/partner-auth/otp/request`, { email });
    pendingEmail = email;
    document.getElementById('authStep2Email').textContent = email;
    showAuthStep('authStep2');
  } catch (err) {
    setMsg('authStep1Msg', err.response?.data?.detail || 'Could not send OTP.', 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Step 2: Verify OTP ---------- */
document.getElementById('verifyOtpBtn').addEventListener('click', async () => {
  const otp = document.getElementById('authOtp').value.trim();
  if (otp.length !== 6) return setMsg('authStep2Msg', 'Enter the 6-digit code.', 'error');
  const btn = document.getElementById('verifyOtpBtn');
  btn.disabled = true;
  try {
    await axios.post(`${API_BASE}/api/partner-auth/otp/verify`, { email: pendingEmail, otp });
    showAuthStep('authStep3');
  } catch (err) {
    setMsg('authStep2Msg', err.response?.data?.detail || 'Incorrect or expired OTP.', 'error');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('resendOtpBtn').addEventListener('click', async () => {
  try {
    await axios.post(`${API_BASE}/api/partner-auth/otp/request`, { email: pendingEmail });
    setMsg('authStep2Msg', 'A new OTP has been sent.', 'success');
  } catch (err) {
    setMsg('authStep2Msg', err.response?.data?.detail || 'Could not resend OTP.', 'error');
  }
});

/* ---------- Step 3: Partner Login ---------- */
document.getElementById('partnerLoginBtn').addEventListener('click', async () => {
  const password = document.getElementById('authPassword').value;
  if (!password) return setMsg('authStep3Msg', 'Enter your password.', 'error');
  const btn = document.getElementById('partnerLoginBtn');
  btn.disabled = true;
  try {
    const { data } = await axios.post(`${API_BASE}/api/partner-auth/login`, { email: pendingEmail, password });
    storePartnerSession(data);
    resetAuthFlow();
    showPartnerPortal();
  } catch (err) {
    setMsg('authStep3Msg', err.response?.data?.detail || 'Invalid email or password.', 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Forgot password ---------- */
document.getElementById('forgotPasswordLink').addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('forgotEmail').value = pendingEmail;
  showAuthStep('authForgotStep1');
});
document.getElementById('backToLoginBtn1').addEventListener('click', () => showAuthStep('authStep1'));
document.getElementById('backToLoginBtn2').addEventListener('click', () => showAuthStep('authStep1'));

document.getElementById('forgotSendOtpBtn').addEventListener('click', async () => {
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) return setMsg('authForgotStep1Msg', 'Enter your email address.', 'error');
  const btn = document.getElementById('forgotSendOtpBtn');
  btn.disabled = true;
  try {
    const { data } = await axios.post(`${API_BASE}/api/partner-auth/forgot-password/request`, { email });
    pendingEmail = email;
    setMsg('authForgotStep1Msg', data.message, 'success');
    showAuthStep('authForgotStep2');
  } catch (err) {
    setMsg('authForgotStep1Msg', err.response?.data?.detail || 'Something went wrong.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('forgotResetBtn').addEventListener('click', async () => {
  const otp = document.getElementById('forgotOtp').value.trim();
  const newPassword = document.getElementById('forgotNewPassword').value;
  if (otp.length !== 6) return setMsg('authForgotStep2Msg', 'Enter the 6-digit code.', 'error');
  if (newPassword.length < 8) return setMsg('authForgotStep2Msg', 'Password must be at least 8 characters.', 'error');
  const btn = document.getElementById('forgotResetBtn');
  btn.disabled = true;
  try {
    await axios.post(`${API_BASE}/api/partner-auth/forgot-password/reset`, { email: pendingEmail, otp, new_password: newPassword });
    setMsg('authForgotStep2Msg', 'Password updated. Please sign in.', 'success');
    setTimeout(() => { document.getElementById('forgotOtp').value = ''; document.getElementById('forgotNewPassword').value = ''; showAuthStep('authStep1'); }, 1200);
  } catch (err) {
    setMsg('authForgotStep2Msg', err.response?.data?.detail || 'Incorrect or expired OTP.', 'error');
  } finally {
    btn.disabled = false;
  }
});

/* Boot check lives in a small inline <script> at the end of partner-portal.html,
   after every section's JS has loaded — not here, since this file loads
   before partner-dashboard.js etc. and showPartnerPortal() needs those
   loader functions (loadDashboard and friends) to already exist. */
