'use strict';
/* Super Admin Portal — Profile, Edit Profile, Change Password. */

async function loadSaProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/profile`, { headers: saAuthHeaders() });
    document.getElementById('saProfileName').textContent = data.full_name;
    document.getElementById('saProfileEmail').textContent = data.email;
    document.getElementById('saProfilePhone').textContent = data.phone_number;
    document.getElementById('saProfileCreated').textContent = saFmtDate(data.created_date);
    document.getElementById('saProfilePhoto').textContent = (data.full_name.trim()[0] || 'S').toUpperCase();
  } catch (err) { /* section just shows placeholders if this fails */ }
}

/* ---------- Edit Profile ---------- */
const saEditProfileModalOverlay = document.getElementById('saEditProfileModalOverlay');
document.getElementById('saEditProfileBtn').addEventListener('click', () => {
  const f = document.getElementById('saEditProfileForm').elements;
  f.full_name.value = document.getElementById('saProfileName').textContent;
  f.phone_number.value = document.getElementById('saProfilePhone').textContent;
  document.getElementById('saEditProfileMsg').textContent = '';
  saEditProfileModalOverlay.classList.add('open');
});
document.getElementById('saEditProfileCancelBtn').addEventListener('click', () => saEditProfileModalOverlay.classList.remove('open'));
document.getElementById('saEditProfileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = document.getElementById('saEditProfileMsg');
  if (!f.full_name.value.trim()) { msg.className = 'msg error'; msg.textContent = 'Full Name is required.'; return; }
  try {
    // TODO (backend): app/services/super_admin_service.py::update_profile
    // has the matching TODO for the real PostgreSQL UPDATE.
    await axios.patch(`${API_BASE}/api/super-admin/profile`, {
      full_name: f.full_name.value.trim(), phone_number: f.phone_number.value.trim(),
    }, { headers: saAuthHeaders() });
    saEditProfileModalOverlay.classList.remove('open');
    loadSaProfile();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Failed to update profile.';
  }
});

/* ---------- Change Password ---------- */
const saChangePasswordModalOverlay = document.getElementById('saChangePasswordModalOverlay');
document.getElementById('saChangePasswordBtn').addEventListener('click', () => {
  document.getElementById('saChangePasswordForm').reset();
  document.getElementById('saChangePasswordMsg').textContent = '';
  saChangePasswordModalOverlay.classList.add('open');
});
document.getElementById('saChangePasswordCancelBtn').addEventListener('click', () => saChangePasswordModalOverlay.classList.remove('open'));
document.getElementById('saChangePasswordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = document.getElementById('saChangePasswordMsg');
  const pw = f.new_password.value;
  if (pw.length < 8 || !/[A-Z]/.test(pw) || !/\d/.test(pw)) {
    msg.className = 'msg error';
    msg.textContent = 'New password must be at least 8 characters and include an uppercase letter and a number.';
    return;
  }
  if (pw !== f.confirm_new_password.value) {
    msg.className = 'msg error';
    msg.textContent = 'New Password and Confirm New Password do not match.';
    return;
  }
  try {
    // TODO (backend): app/services/super_admin_service.py::change_password
    // has the matching TODO for validating against + updating the real
    // password hash in PostgreSQL.
    await axios.post(`${API_BASE}/api/super-admin/change-password`, {
      current_password: f.current_password.value, new_password: pw, confirm_new_password: f.confirm_new_password.value,
    }, { headers: saAuthHeaders() });
    saChangePasswordModalOverlay.classList.remove('open');
    msg.className = 'msg success';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Failed to change password.';
  }
});
