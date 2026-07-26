'use strict';
/* Super Admin Portal — login. Single-step (username/email + password) —
   no OTP step, unlike the Partner Portal, per the Super Admin spec. */

document.getElementById('saLoginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('saLoginMsg');
  const username = document.getElementById('saUsername').value.trim();
  const password = document.getElementById('saPassword').value;
  msg.className = 'msg'; msg.textContent = '';

  if (!username || !password) {
    msg.className = 'msg error';
    msg.textContent = 'Enter your username/email and password.';
    return;
  }

  try {
    // TODO (backend): once app/services/super_admin_service.py is wired to
    // PostgreSQL, this same call authenticates against the real table —
    // nothing here on the frontend needs to change.
    const { data } = await axios.post(`${SA_API_BASE}/api/super-admin/auth/login`, {
      username_or_email: username, password,
    });
    storeSuperAdminSession(data);
    showSuperAdminPortal();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Login failed.';
  }
});
