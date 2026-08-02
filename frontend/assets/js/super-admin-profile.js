'use strict';
/* Super Admin Portal — Profile & Security.
   GET|PUT /api/profile          — the shared profile endpoint every portal uses
   POST /api/auth/change-password
   GET /api/super-admin/activity — this account's own Auth-module history

   "Security" here is the sign-in trail: the activity endpoint already records
   Login / Logout / OTP requested with IP, browser and device
   (app/services/activity_service.py), so the recent-sign-ins table is a
   filtered read of it rather than a new endpoint. Email is deliberately not
   editable — changing the sign-in identity is a separate, higher-friction
   flow, out of scope for this milestone (see app/routers/profile.py). */

let saProfileEmail = '';

async function loadSaProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/profile`, { headers: saAuthHeaders() });
    saProfileEmail = data.email;
    document.getElementById('saProfileName').textContent = data.full_name;
    document.getElementById('saProfileEmail').textContent = data.email;
    /* Read `mobile`, write `phone` — UserResponse exposes the column as
       `mobile` while UpdateProfileRequest takes `phone`. Same asymmetry the
       Merchant Portal's partner-profile.js already handles. */
    document.getElementById('saProfilePhone').textContent = data.mobile || '—';
    document.getElementById('saProfileLastLogin').textContent =
      data.last_login ? fmtDateTime(data.last_login) : 'Never';
    document.getElementById('saProfilePhoto').textContent =
      (data.full_name?.trim()[0] || 'S').toUpperCase();

    /* Keep the topbar chip and the stored name in step with an edit. */
    document.getElementById('saChipName').textContent = data.full_name;
    document.getElementById('saChipAvatar').textContent = (data.full_name?.trim()[0] || 'S').toUpperCase();
    localStorage.setItem(SA_KEYS.fullName, data.full_name);
  } catch (err) {
    showToast(saErrorText(err, 'Failed to load your profile.'), true);
  }
  loadSaSignIns();
}

/* SEVEN PER PAGE, AND OLDER ONES ARE PAGED IN — not "the last 7 and the rest
   are gone". The endpoint already pages, so `page_size: 7` plus the portal's
   standard pager is the whole implementation; nothing is fetched that is not
   shown, which is the opposite of slicing a larger page in the browser. */
const SA_SIGNIN_PAGE_SIZE = 7;

async function loadSaSignIns(page = 1) {
  const tbody = document.querySelector('#saSecurityTable tbody');
  saTableError(tbody, 4, 'Loading…');
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/activity`, {
      params: { module: 'Auth', search: saProfileEmail, page, page_size: SA_SIGNIN_PAGE_SIZE },
      headers: saAuthHeaders(),
    });
    tbody.innerHTML = data.items.length ? data.items.map(e => `
      <tr>
        <td>${fmtDateTime(e.created_at)}</td>
        <td>${saEscapeHtml(e.action)}</td>
        <td>${saEscapeHtml(e.ip_address || '—')}</td>
        <td>${saEscapeHtml(e.browser || '—')}${e.device ? ` · ${saEscapeHtml(e.device)}` : ''}</td>
      </tr>`).join('')
      : '<tr><td colspan="4" class="empty-state">No sign-in activity recorded yet.</td></tr>';
    saRenderPagination('saSecurityPagination', data.page, data.total_pages, data.total, loadSaSignIns);
  } catch (err) {
    saTableError(tbody, 4, saErrorText(err, 'Failed to load sign-in history.'));
  }
}

/* ---------- Edit Profile ---------- */
const saEditProfileModalOverlay = document.getElementById('saEditProfileModalOverlay');
document.getElementById('saEditProfileBtn')?.addEventListener('click', () => {
  const f = document.getElementById('saEditProfileForm').elements;
  f.full_name.value = document.getElementById('saProfileName').textContent;
  const phone = document.getElementById('saProfilePhone').textContent;
  f.phone.value = phone === '—' ? '' : phone;
  const msg = document.getElementById('saEditProfileMsg');
  msg.textContent = '';
  msg.className = 'msg';
  saEditProfileModalOverlay.classList.add('open');
});
document.getElementById('saEditProfileCancelBtn')?.addEventListener('click',
  () => saEditProfileModalOverlay.classList.remove('open'));

document.getElementById('saEditProfileForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = document.getElementById('saEditProfileMsg');
  if (!f.full_name.value.trim()) {
    msg.className = 'msg error';
    msg.textContent = 'Full Name is required.';
    return;
  }
  try {
    await axios.put(`${API_BASE}/api/profile`, {
      full_name: f.full_name.value.trim(),
      phone: f.phone.value.trim() || null,
    }, { headers: saAuthHeaders() });
    saEditProfileModalOverlay.classList.remove('open');
    showToast('Profile updated.');
    loadSaProfile();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = saErrorText(err, 'Failed to update your profile.');
  }
});

/* ---------- Change Password ---------- */
const saChangePasswordModalOverlay = document.getElementById('saChangePasswordModalOverlay');
document.getElementById('saChangePasswordBtn')?.addEventListener('click', () => {
  document.getElementById('saChangePasswordForm').reset();
  const msg = document.getElementById('saChangePasswordMsg');
  msg.textContent = '';
  msg.className = 'msg';
  saChangePasswordModalOverlay.classList.add('open');
});
document.getElementById('saChangePasswordCancelBtn')?.addEventListener('click',
  () => saChangePasswordModalOverlay.classList.remove('open'));

document.getElementById('saChangePasswordForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = document.getElementById('saChangePasswordMsg');
  if (f.new_password.value.length < 8) {
    msg.className = 'msg error';
    msg.textContent = 'The new password must be at least 8 characters.';
    return;
  }
  try {
    await axios.post(`${API_BASE}/api/auth/change-password`, {
      current_password: f.current_password.value,
      new_password: f.new_password.value,
    }, { headers: saAuthHeaders() });
    saChangePasswordModalOverlay.classList.remove('open');
    showToast('Password changed.');
    /* The sign-in trail is the natural place this shows up. */
    loadSaSignIns();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = saErrorText(err, 'Failed to change your password.');
  }
});
