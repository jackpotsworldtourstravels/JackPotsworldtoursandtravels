'use strict';
/* Merchant Portal — Profile & Settings.
   ===========================================================================
   A profile card, the user's own details, security, and an honest account of
   what is not self-service.

     GET/PUT /api/profile              the user's own record
     POST    /api/auth/change-password
     GET     /api/merchant/wallet      the account strip's balance

   NOT HERE, because no merchant-facing endpoint exists for them:
     - company name, GST registration and address — schemas/admin_merchant.py,
       behind admin permissions
     - KYC documents — no endpoint at all
     - API credentials — no endpoint at all
     - team members — created and closed by the partner desk
   Rather than render dead inputs that save nothing, the Company panel shows
   what we hold and says who changes it. A settings screen full of controls that
   silently do not work is worse than one that is honest about its scope.

   CREDIT IS NOT ON THIS SCREEN EITHER. The account strip used to be able to
   show a credit limit beside the wallet; it now shows the wallet alone, which
   is the portal's single finance surface. */

function clInitProfile() {
  const company = localStorage.getItem(PARTNER_KEYS.companyName) || '—';
  const name = localStorage.getItem(PARTNER_KEYS.fullName) || 'Merchant';
  const role = clRoleLabel(clSessionUser()) || 'Merchant User';

  $('cl-profile').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Profile &amp; Settings</h1>
      </div>
    </div>

    <!-- ---- profile card ---- -->
    <div class="cl-panel">
      <div class="cl-panel-body">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <span class="cl-avatar cl-avatar-lg" aria-hidden="true"
                style="width:72px;height:72px;font-size:25px;">${escapeHtml(clInitials(name))}</span>
          <div style="min-width:0;flex:1;">
            <h2 style="font-size:21px;" id="clProfHeadName">${escapeHtml(name)}</h2>
            <div class="cl-chip-row" style="margin-top:8px;">
              <span class="cl-tag cl-tag-info">${escapeHtml(role)}</span>
              <span class="cl-tag cl-tag-plain">${clIco('building', { size: 13 })} ${escapeHtml(company)}</span>
              <span class="cl-tag cl-tag-ok" id="clProfEmailChip">—</span>
            </div>
          </div>
          <div id="clProfAccount" style="margin-left:auto;"></div>
        </div>
      </div>
    </div>

    <div class="cl-grid-2">
      <!-- ---- your details ---- -->
      <div class="cl-panel">
        <div class="cl-panel-head"><h2>${clIco('user')}Your details</h2></div>
        <div class="cl-panel-body">
          <div class="cl-form cl-form-2" id="clProfForm">
            <div class="cl-field cl-field-full">
              <label for="clProfName">Full name<span class="cl-req">*</span></label>
              <input type="text" id="clProfName" autocomplete="name">
            </div>
            <div class="cl-field">
              <label for="clProfEmail">Email</label>
              <input type="email" id="clProfEmail" readonly>
              <small>Contact the partner desk to change your sign-in email.</small>
            </div>
            <div class="cl-field">
              <label for="clProfPhone">Phone</label>
              <input type="tel" id="clProfPhone" autocomplete="tel">
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
              <input type="text" id="clProfCountry" autocomplete="country-name">
            </div>
            <div class="cl-field">
              <label for="clProfState">State</label>
              <input type="text" id="clProfState">
            </div>
            <div class="cl-field cl-field-full">
              <label for="clProfCity">City</label>
              <input type="text" id="clProfCity">
            </div>
            <div class="cl-field cl-field-full">
              <label for="clProfAddress">Address</label>
              <textarea id="clProfAddress" autocomplete="street-address"></textarea>
            </div>
          </div>
          <div class="cl-form-actions">
            <button type="button" class="cl-btn cl-btn-primary" id="clProfSave">Save changes</button>
            <button type="button" class="cl-btn" id="clProfReload">Discard</button>
          </div>
          <div class="cl-msg" id="clProfMsg"></div>
        </div>
      </div>

      <div>
        <!-- ---- security ---- -->
        <div class="cl-panel">
          <div class="cl-panel-head"><h2>${clIco('lock')}Password</h2></div>
          <div class="cl-panel-body">
            <div class="cl-form cl-form-2">
              <div class="cl-field cl-field-full">
                <label for="clPwdCurrent">Current password<span class="cl-req">*</span></label>
                <input type="password" id="clPwdCurrent" autocomplete="current-password">
              </div>
              <div class="cl-field">
                <label for="clPwdNew">New password<span class="cl-req">*</span></label>
                <input type="password" id="clPwdNew" autocomplete="new-password">
              </div>
              <div class="cl-field">
                <label for="clPwdConfirm">Confirm<span class="cl-req">*</span></label>
                <input type="password" id="clPwdConfirm" autocomplete="new-password">
              </div>
            </div>
            <div class="cl-form-actions">
              <button type="button" class="cl-btn cl-btn-primary" id="clPwdSave">Change password</button>
            </div>
            <div class="cl-msg" id="clPwdMsg"></div>
          </div>
        </div>

        <!-- ---- sign-in security ---- -->
        <div class="cl-panel">
          <div class="cl-panel-head"><h2>${clIco('shield')}Sign-in security</h2></div>
          <div class="cl-panel-body">
            <dl class="cl-dl">
              <div><dt>Two-step verification</dt>
                <dd><span class="cl-tag cl-tag-ok">Always on</span></dd></div>
              <div><dt>How it works</dt>
                <dd>Every sign-in sends a one-time code to your registered email. It cannot be
                    turned off, on any merchant account.</dd></div>
              <div><dt>Session</dt>
                <dd>Expires on its own; signing out here ends it immediately.</dd></div>
            </dl>
          </div>
          <div class="cl-panel-note">
            Suspect an account has been compromised? Change the password here and call the partner
            desk — they can close the account the same day.
          </div>
        </div>

        <!-- ---- preferences ---- -->
        <div class="cl-panel">
          <div class="cl-panel-head"><h2>${clIco('settings')}Preferences</h2></div>
          <div class="cl-panel-body">
            <div class="cl-field">
              <label>Appearance</label>
              <div class="cl-theme" id="clProfTheme" role="group" aria-label="Colour theme"
                   style="align-self:flex-start;">
                <button type="button" class="cl-theme-btn" data-cl-theme="light" title="Light" aria-label="Light theme">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
                <button type="button" class="cl-theme-btn" data-cl-theme="dark" title="Dark" aria-label="Dark theme">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
                <button type="button" class="cl-theme-btn" data-cl-theme="system" title="System" aria-label="Match system theme">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>
              </div>
              <small>Stored on this device only, and separate from the other portals' themes.</small>
            </div>
          </div>
          <div class="cl-panel-note">
            Notification delivery, language and currency are not configurable — every merchant
            account is notified in-app and by email, in English, in rupees.
          </div>
        </div>
      </div>
    </div>

    <!-- ---- company ---- -->
    <div class="cl-panel">
      <div class="cl-panel-head"><h2>${clIco('building')}Company &amp; business information</h2></div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Registered account</dt><dd>${escapeHtml(company)}</dd></div>
          <div><dt>Your role</dt><dd>${escapeHtml(role)}</dd></div>
          <div><dt>Settlement</dt><dd>Wallet — tickets are debited when they are issued</dd></div>
          <div><dt>Partner desk</dt>
            <dd><a href="mailto:${CL_SUPPORT_EMAIL}">${escapeHtml(CL_SUPPORT_EMAIL)}</a></dd></div>
        </dl>
      </div>
      <div class="cl-panel-note">
        GST registration, the registered business address, KYC paperwork, API credentials and the
        list of users on this account are all handled by the partner desk — there is no
        merchant-facing endpoint for any of them, so this screen does not pretend to offer one.
        Write to <a href="mailto:${CL_SUPPORT_EMAIL}">${CL_SUPPORT_EMAIL}</a> or
        <a href="#" data-cl-prof-support>open a support conversation</a> and our team will make the
        change against your account.
      </div>
    </div>`;

  $('clProfSave').addEventListener('click', clSaveProfile);
  $('clProfReload').addEventListener('click', clLoadProfile);
  $('clPwdSave').addEventListener('click', clChangePassword);
  $('cl-profile').querySelector('[data-cl-prof-support]').addEventListener('click', e => {
    e.preventDefault(); clGo('support');
  });
  /* The Preferences theme control is a third group of the same buttons. Wiring
     it here rather than in clInitTheme, which runs once at boot and long before
     this screen exists, and re-applying the stored choice so it renders with
     the right one active. */
  clBindProfileTheme();

  return Promise.all([clLoadProfileAccount(), clLoadProfile()]);
}

/* Mirrors clInitTheme's contract exactly — same storage key, same resolution —
   so the three control groups can never disagree. */
function clBindProfileTheme() {
  const KEY = 'classic_ui_theme';
  const choice = localStorage.getItem(KEY) || 'light';
  const sync = c => document.querySelectorAll('[data-cl-theme]').forEach(b => {
    const on = b.dataset.clTheme === c;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  sync(choice);
  $('clProfTheme').querySelectorAll('[data-cl-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = btn.dataset.clTheme;
      localStorage.setItem(KEY, c);
      document.documentElement.setAttribute('data-theme',
        c === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : c);
      sync(c);
    });
  });
}

/* The wallet, not the raw dashboard payload: `GET /api/merchant/wallet` is
   served by the one service allowed to compute money, and it is the same figure
   the Wallet screen shows. */
async function clLoadProfileAccount() {
  try {
    const w = await MerchantApi.wallet();
    const owes = moneyIsPositive(w.outstanding);
    $('clProfAccount').innerHTML = `
      <div class="cl-inline-stat" style="flex-direction:column;align-items:flex-start;gap:2px;padding:12px 18px;">
        <span class="cl-kpi-label">${owes ? 'Outstanding' : 'Wallet balance'}</span>
        <b style="font-size:20px;">${escapeHtml(moneyStr(owes ? w.outstanding : w.balance))}</b>
      </div>`;
  } catch {
    /* A failed balance must not take the profile form down with it. */
    $('clProfAccount').innerHTML = '';
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
    $('clProfEmailChip').textContent = p.email || '—';
  } catch (err) {
    clMsg(msg, clError(err, 'Could not load your profile.'), 'err');
  }
}

async function clSaveProfile() {
  const msg = $('clProfMsg');
  const name = $('clProfName').value.trim();
  const field = $('clProfName').closest('.cl-field');
  field.classList.remove('cl-invalid');
  if (!name) {
    field.classList.add('cl-invalid');
    $('clProfName').focus();
    return clMsg(msg, 'Full name is required.', 'err');
  }

  const btn = $('clProfSave');
  btn.disabled = true;
  btn.classList.add('loading');
  clMsg(msg, '');
  try {
    /* Empty strings go as null, which is what the backend expects for
       "cleared", not as "". */
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
    /* The same localStorage key every portal reads, so the name updates in the
       header without a reload. */
    localStorage.setItem(PARTNER_KEYS.fullName, data.full_name);
    clPaintIdentity();
    $('clProfHeadName').textContent = data.full_name;
    clMsg(msg, 'Profile updated.', 'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Failed to update your profile.'), 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

async function clChangePassword() {
  const msg = $('clPwdMsg');
  const current = $('clPwdCurrent').value;
  const next = $('clPwdNew').value;
  const confirm = $('clPwdConfirm').value;

  ['clPwdCurrent', 'clPwdNew', 'clPwdConfirm'].forEach(id =>
    $(id).closest('.cl-field').classList.remove('cl-invalid'));

  const fail = (text, id) => {
    if (id) { $(id).closest('.cl-field').classList.add('cl-invalid'); $(id).focus(); }
    clMsg(msg, text, 'err');
  };

  if (!current) return fail('Enter your current password.', 'clPwdCurrent');
  if (!next) return fail('Enter a new password.', 'clPwdNew');
  /* Confirmation is checked here only — the endpoint takes two fields, so
     sending a mismatched pair would silently set the wrong password. */
  if (next !== confirm) return fail('The new passwords do not match.', 'clPwdConfirm');
  if (next === current) return fail('The new password must be different.', 'clPwdNew');

  const btn = $('clPwdSave');
  btn.disabled = true;
  btn.classList.add('loading');
  clMsg(msg, '');
  try {
    await MerchantApi.changePassword(current, next);
    ['clPwdCurrent', 'clPwdNew', 'clPwdConfirm'].forEach(id => { $(id).value = ''; });
    clMsg(msg, 'Password changed. Use it the next time you sign in.', 'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Failed to change the password.'), 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}
