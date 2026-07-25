'use strict';
/* Partner Portal — Profile: view/update partner user info + change password */

let profileFormWired = false;

async function loadProfile() {
  if (!profileFormWired) wireProfileForms();
  try {
    const { data } = await axios.get(`${API_BASE}/api/partner/profile`, { headers: partnerAuthHeaders() });
    document.getElementById('profCompanyName').value = data.company_name;
    document.getElementById('profCompanyCode').value = data.company_code;
    document.getElementById('profPartnerId').value = data.partner_id;
    document.getElementById('profFullName').value = data.full_name;
    document.getElementById('profEmail').value = data.email;
    document.getElementById('profPhone').value = data.phone_number || '';
  } catch (err) {
    document.getElementById('profileMsg').textContent = 'Failed to load profile.';
    document.getElementById('profileMsg').className = 'msg error';
  }
}

function wireProfileForms() {
  profileFormWired = true;

  document.getElementById('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = document.getElementById('profileMsg');
    try {
      const { data } = await axios.patch(`${API_BASE}/api/partner/profile`, {
        full_name: document.getElementById('profFullName').value,
        phone_number: document.getElementById('profPhone').value || null,
      }, { headers: partnerAuthHeaders() });
      localStorage.setItem('partner_user_name', data.full_name);
      document.getElementById('partnerChipName').textContent = data.full_name;
      msg.textContent = 'Profile updated.'; msg.className = 'msg success';
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to update profile.'; msg.className = 'msg error';
    }
  });

  document.getElementById('passwordForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = document.getElementById('passwordMsg');
    try {
      await axios.post(`${API_BASE}/api/partner/profile/change-password`, {
        current_password: document.getElementById('pwdCurrent').value,
        new_password: document.getElementById('pwdNew').value,
      }, { headers: partnerAuthHeaders() });
      msg.textContent = 'Password changed.'; msg.className = 'msg success';
      document.getElementById('passwordForm').reset();
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to change password.'; msg.className = 'msg error';
    }
  });
}
