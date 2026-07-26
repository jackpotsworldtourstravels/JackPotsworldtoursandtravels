'use strict';
/* Super Admin Portal — Admin Management.
   Frontend validation only, exactly as instructed — no uniqueness checks
   happen here (those need the real database; see the TODOs in
   backend/app/services/super_admin_service.py::create_admin). */

async function loadSaAdmins() {
  const tbody = document.querySelector('#saAdminsTable tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Loading…</td></tr>`;
  try {
    const { data } = await axios.get(`${SA_API_BASE}/api/super-admin/admins`, { headers: saAuthHeaders() });
    tbody.innerHTML = data.map(a => `
      <tr>
        <td>${saEscapeHtml(a.admin_id)}</td>
        <td>${saEscapeHtml(a.full_name)}</td>
        <td>${saEscapeHtml(a.username)}</td>
        <td>${saEscapeHtml(a.email)}</td>
        <td>${saEscapeHtml(a.country_code)} ${saEscapeHtml(a.phone_number)}</td>
        <td><span class="badge ${a.status === 'active' ? 'active' : 'inactive'}">${a.status === 'active' ? 'Active' : 'Inactive'}</span></td>
        <td>${saFmtDate(a.created_at)}</td>
        <td>
          <button class="btn btn-sm ${a.status === 'active' ? 'btn-danger' : 'btn-navy'}" data-toggle-admin="${a.admin_id}" data-next="${a.status === 'active' ? 'inactive' : 'active'}">${a.status === 'active' ? 'Deactivate' : 'Activate'}</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="8" class="empty-state">No admins yet — click &ldquo;+ Add Admin&rdquo; to create one.</td></tr>`;
    tbody.querySelectorAll('[data-toggle-admin]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.post(`${SA_API_BASE}/api/super-admin/admins/${btn.dataset.toggleAdmin}/${btn.dataset.next}`, {}, { headers: saAuthHeaders() });
          loadSaAdmins();
          saLoadedSections.delete('dashboard');
        } catch (err) { alert('Failed to update admin.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load admins.</td></tr>`;
  }
}

const saAddAdminModalOverlay = document.getElementById('saAddAdminModalOverlay');
document.getElementById('saAddAdminBtn').addEventListener('click', () => {
  document.getElementById('saAddAdminForm').reset();
  document.getElementById('saAddAdminMsg').textContent = '';
  saAddAdminModalOverlay.classList.add('open');
});
document.getElementById('saAddAdminCancelBtn').addEventListener('click', () => saAddAdminModalOverlay.classList.remove('open'));

function saValidateAddAdmin(f) {
  if (!f.full_name.value.trim()) return 'Full Name is required.';
  if (!f.username.value.trim() || f.username.value.trim().length < 3) return 'Username is required (minimum 3 characters).';
  if (!f.email.value.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return 'A valid Email Address is required.';
  if (!/^\d{6,15}$/.test(f.phone_number.value.trim())) return 'Phone Number must be 6–15 digits, numbers only.';
  const pw = f.password.value;
  if (pw.length < 8 || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Password must be at least 8 characters and include an uppercase letter and a number.';
  if (pw !== f.confirm_password.value) return 'Password and Confirm Password do not match.';
  return null;
}

document.getElementById('saAddAdminForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = document.getElementById('saAddAdminMsg');
  const validationError = saValidateAddAdmin(f);
  if (validationError) {
    msg.className = 'msg error';
    msg.textContent = validationError;
    return;
  }
  try {
    // TODO (backend): app/services/super_admin_service.py::create_admin has
    // the matching TODOs for real uniqueness checks + the PostgreSQL INSERT.
    await axios.post(`${SA_API_BASE}/api/super-admin/admins`, {
      full_name: f.full_name.value.trim(), username: f.username.value.trim(), email: f.email.value.trim(),
      phone_number: f.phone_number.value.trim(), country_code: f.country_code.value,
      password: f.password.value, confirm_password: f.confirm_password.value,
    }, { headers: saAuthHeaders() });
    saAddAdminModalOverlay.classList.remove('open');
    loadSaAdmins();
    saLoadedSections.delete('dashboard');
  } catch (err) {
    msg.className = 'msg error';
    const detail = err.response?.data?.detail;
    msg.textContent = Array.isArray(detail) ? detail[0]?.msg : (detail || 'Failed to create admin.');
  }
});
