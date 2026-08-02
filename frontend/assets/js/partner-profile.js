'use strict';
/* Merchant Portal — Profile: view/update account info + change password.
   GET/PUT /api/profile (API_CONTRACT.md §6.6), change-password via the existing,
   already-live /api/auth/change-password (shared by all three portals). */

let profileFormWired = false;

/* Account standing at the top of Profile. GET /api/profile carries the identity
   fields only (merchant_name, contact details), so the money comes from
   GET /api/merchant/dashboard — the merchant-readable endpoint that already backs
   Home's strip and the Dashboard KPIs. No new endpoint, and nothing is shown that
   the API doesn't return: GST, documents and API keys have no merchant-facing
   source, so they are absent rather than blank. */
async function loadAccountSummary(merchantName) {
  const host = document.getElementById('profAccountSummary');
  if (!host) return;
  const card = (label, value, hint, variant) => `
    <div class="acct-card${variant ? ` acct-${variant}` : ''}">
      <div class="acct-label">${escapeHtml(label)}</div>
      <div class="acct-value">${value}</div>
      ${hint ? `<div class="acct-hint">${escapeHtml(hint)}</div>` : ''}
    </div>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/merchant/dashboard`, { headers: partnerAuthHeaders() });
    host.innerHTML = [
      card('Company', escapeHtml(merchantName || '—'), 'Registered partner account'),
      // Decimal strings off finance_service (M4) — moneyStr(), not money(),
      // which mishandles a negative CR-4 wallet balance.
      card('Wallet balance', moneyStr(data.wallet_balance), 'Available to settle requests', 'money'),
      card('Credit limit', moneyStr(data.credit_limit), 'Agreed with our team', 'money'),
      card('Support', '24×7 partner desk',
        'Open Live Chat Support from the account menu for a threaded reply'),
    ].join('');
  } catch (err) {
    /* Standing is supporting detail — a failure here must not stop the merchant
       editing their profile below. */
    host.innerHTML = '';
  }
}

async function loadProfile() {
  if (!profileFormWired) wireProfileForms();
  try {
    const { data } = await axios.get(`${API_BASE}/api/profile`, { headers: partnerAuthHeaders() });
    document.getElementById('profCompanyName').value = data.merchant_name || '';
    document.getElementById('profFullName').value = data.full_name;
    document.getElementById('profEmail').value = data.email;
    document.getElementById('profPhone').value = data.mobile || '';
    document.getElementById('profGender').value = data.gender || '';
    document.getElementById('profDob').value = data.dob || '';
    document.getElementById('profCountry').value = data.country || '';
    document.getElementById('profState').value = data.state || '';
    document.getElementById('profCity').value = data.city || '';
    document.getElementById('profAddress').value = data.address || '';
    loadAccountSummary(data.merchant_name);
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
      const { data } = await axios.put(`${API_BASE}/api/profile`, {
        full_name: document.getElementById('profFullName').value,
        phone: document.getElementById('profPhone').value || null,
        gender: document.getElementById('profGender').value || null,
        dob: document.getElementById('profDob').value || null,
        country: document.getElementById('profCountry').value || null,
        state: document.getElementById('profState').value || null,
        city: document.getElementById('profCity').value || null,
        address: document.getElementById('profAddress').value || null,
      }, { headers: partnerAuthHeaders() });
      localStorage.setItem(PARTNER_KEYS.fullName, data.full_name);
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
      await axios.post(`${API_BASE}/api/auth/change-password`, {
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
