'use strict';
/* Classic — Profile & Settings.
   ===========================================================================
   Three panels: the account strip from GET /api/merchant/dashboard, the user
   profile (GET/PUT /api/profile), and a password change
   (POST /api/auth/change-password). Same endpoints and same payload keys as
   Premium's partner-profile.js.

   NOT here, because no merchant-facing endpoint exists for them:
     - GST number: lives in schemas/admin_merchant.py behind admin permissions
     - document vault: no endpoint at all
     - API keys: no endpoint at all
   Rather than render dead inputs, the panel says where those are handled. */

function clInitProfile() {
  $('cl-profile').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Profile &amp; Settings</h1>
        <p>Your user details and sign-in credentials.</p>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Account</h2></div>
      <div class="cl-panel-body" id="clProfAccount">
        <span class="cl-spin"></span> Loading account…
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Your details</h2></div>
      <div class="cl-panel-body">
        <div class="cl-form" id="clProfForm">
          <div class="cl-field cl-field-wide">
            <label for="clProfName">Full name<span class="cl-req">*</span></label>
            <input type="text" id="clProfName">
          </div>
          <div class="cl-field">
            <label for="clProfEmail">Email</label>
            <input type="email" id="clProfEmail" readonly>
            <small>Contact the partner desk to change your sign-in email.</small>
          </div>
          <div class="cl-field">
            <label for="clProfPhone">Phone</label>
            <input type="tel" id="clProfPhone">
          </div>
          <div class="cl-field">
            <label for="clProfGender">Gender</label>
            <select id="clProfGender">
              <option value="">—</option><option value="male">Male</option>
              <option value="female">Female</option><option value="other">Other</option>
            </select>
          </div>
          <div class="cl-field">
            <label for="clProfDob">Date of birth</label>
            <input type="date" id="clProfDob">
          </div>
          <div class="cl-field">
            <label for="clProfCountry">Country</label>
            <input type="text" id="clProfCountry">
          </div>
          <div class="cl-field">
            <label for="clProfState">State</label>
            <input type="text" id="clProfState">
          </div>
          <div class="cl-field">
            <label for="clProfCity">City</label>
            <input type="text" id="clProfCity">
          </div>
          <div class="cl-field cl-field-full">
            <label for="clProfAddress">Address</label>
            <textarea id="clProfAddress"></textarea>
          </div>
        </div>
        <div class="cl-form-actions">
          <button type="button" class="cl-btn cl-btn-primary" id="clProfSave">Save changes</button>
          <button type="button" class="cl-btn" id="clProfReload">Discard</button>
        </div>
        <div class="cl-msg" id="clProfMsg"></div>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Change password</h2></div>
      <div class="cl-panel-body">
        <div class="cl-form cl-form-3">
          <div class="cl-field">
            <label for="clPwdCurrent">Current password<span class="cl-req">*</span></label>
            <input type="password" id="clPwdCurrent" autocomplete="current-password">
          </div>
          <div class="cl-field">
            <label for="clPwdNew">New password<span class="cl-req">*</span></label>
            <input type="password" id="clPwdNew" autocomplete="new-password">
          </div>
          <div class="cl-field">
            <label for="clPwdConfirm">Confirm new password<span class="cl-req">*</span></label>
            <input type="password" id="clPwdConfirm" autocomplete="new-password">
          </div>
        </div>
        <div class="cl-form-actions">
          <button type="button" class="cl-btn cl-btn-primary" id="clPwdSave">Change password</button>
        </div>
        <div class="cl-msg" id="clPwdMsg"></div>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Handled by the partner desk</h2></div>
      <div class="cl-panel-body">
        <p style="margin:0;font-size:12.5px;color:var(--cl-ink-soft);">
          GST registration details, KYC documents and API credentials are not self-service —
          there is no merchant-facing endpoint for them. Contact
          <a href="mailto:partners@jackpotsworldtours.com">partners@jackpotsworldtours.com</a>
          and our team will make the change against your account.
        </p>
      </div>
    </div>`;

  $('clProfSave').addEventListener('click', clSaveProfile);
  $('clProfReload').addEventListener('click', clLoadProfile);
  $('clPwdSave').addEventListener('click', clChangePassword);

  return Promise.all([clLoadProfileAccount(), clLoadProfile()]);
}

async function clLoadProfileAccount() {
  try {
    const d = await MerchantApi.dashboard();
    $('clProfAccount').innerHTML = `<dl class="cl-dl">
      <div><dt>Company</dt><dd>${escapeHtml(d.company_name || localStorage.getItem(PARTNER_KEYS.companyName) || '—')}</dd></div>
      <div><dt>Merchant code</dt><dd class="cl-ref">${escapeHtml(d.merchant_code || '—')}</dd></div>
      <div><dt>Wallet balance</dt><dd>${money(d.wallet_balance)}</dd></div>
      <div><dt>Credit limit</dt><dd>${money(d.credit_limit)}</dd></div>
      <div><dt>Support</dt><dd>${escapeHtml(d.support_contact || d.support_email || '—')}</dd></div>
    </dl>`;
  } catch (err) {
    $('clProfAccount').innerHTML = `<div class="cl-msg cl-msg-err" style="margin-top:0">${
      escapeHtml(clError(err, 'Could not load account details.'))}</div>`;
  }
}

async function clLoadProfile() {
  const msg = $('clProfMsg');
  clMsg(msg, '');
  try {
    const p = await MerchantApi.getProfile();
    $('clProfName').value = p.full_name || '';
    $('clProfEmail').value = p.email || '';
    $('clProfPhone').value = p.phone || '';
    $('clProfGender').value = p.gender || '';
    $('clProfDob').value = p.dob ? String(p.dob).slice(0, 10) : '';
    $('clProfCountry').value = p.country || '';
    $('clProfState').value = p.state || '';
    $('clProfCity').value = p.city || '';
    $('clProfAddress').value = p.address || '';
  } catch (err) {
    clMsg(msg, clError(err, 'Could not load your profile.'), 'err');
  }
}

async function clSaveProfile() {
  const msg = $('clProfMsg');
  const name = $('clProfName').value.trim();
  if (!name) return clMsg(msg, 'Full name is required.', 'err');

  const btn = $('clProfSave');
  btn.disabled = true;
  clMsg(msg, 'Saving…', 'muted');
  try {
    /* Same keys Premium PUTs. Empty strings go as null, which is what the
       backend expects for "cleared", not as "". */
    const data = await MerchantApi.updateProfile({
      full_name: name,
      phone: $('clProfPhone').value || null,
      gender: $('clProfGender').value || null,
      dob: $('clProfDob').value || null,
      country: $('clProfCountry').value || null,
      state: $('clProfState').value || null,
      city: $('clProfCity').value || null,
      address: $('clProfAddress').value || null,
    });
    /* Same localStorage key Premium reads, so the name updates in both
       interfaces without a reload. */
    localStorage.setItem(PARTNER_KEYS.fullName, data.full_name);
    $('clUserName').textContent = data.full_name;
    clMsg(msg, 'Profile updated.', 'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Failed to update your profile.'), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function clChangePassword() {
  const msg = $('clPwdMsg');
  const current = $('clPwdCurrent').value;
  const next = $('clPwdNew').value;
  const confirm = $('clPwdConfirm').value;

  if (!current || !next) return clMsg(msg, 'Enter your current and new password.', 'err');
  /* Confirmation is checked here only — the endpoint takes two fields, so
     sending a mismatched pair would silently set the wrong password. */
  if (next !== confirm) return clMsg(msg, 'The new passwords do not match.', 'err');
  if (next === current) return clMsg(msg, 'The new password must be different.', 'err');

  const btn = $('clPwdSave');
  btn.disabled = true;
  clMsg(msg, 'Changing password…', 'muted');
  try {
    await MerchantApi.changePassword(current, next);
    ['clPwdCurrent', 'clPwdNew', 'clPwdConfirm'].forEach(id => { $(id).value = ''; });
    clMsg(msg, 'Password changed. It applies to both the Classic and Premium interfaces.', 'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Failed to change the password.'), 'err');
  } finally {
    btn.disabled = false;
  }
}
