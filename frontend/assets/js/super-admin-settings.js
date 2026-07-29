'use strict';
/* Super Admin Portal — System Configuration / Global Settings.
   GET /api/super-admin/system-info.

   Read-only, and that is a deliberate design decision rather than an
   unfinished screen: runtime configuration lives in backend/.env
   (app/config.py), so there is no settings table to write to and no write
   endpoint to call. Secrets — SMTP credentials, the JWT signing key, the
   database URL — are never returned by the endpoint at all, so they cannot
   leak through this view. The screen says as much, so a Super Admin isn't
   left hunting for an edit button that was never meant to exist. */

function saSettingsRow(label, value) {
  return `<dt>${saEscapeHtml(label)}</dt><dd>${saEscapeHtml(value)}</dd>`;
}

function saYesNo(v) { return v ? 'Yes' : 'No'; }

async function loadSaSettings() {
  const body = document.getElementById('saSettingsBody');
  /* saSetPanelContent (super-admin-dashboard.js) swaps the .empty-state
     centering flex box off before real content goes in. */
  saSetPanelContent(body, 'Loading…', true);
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/system-info`,
                                     { headers: saAuthHeaders() });
    const a = data.auth, c = data.communication;
    saSetPanelContent(body, `
      <div class="sa-settings-group">
        <h3>Platform</h3>
        <dl class="sa-kv">
          ${saSettingsRow('Schema version', data.schema_version)}
          ${saSettingsRow('Debug mode', saYesNo(data.debug_mode))}
          ${saSettingsRow('Allowed origins (CORS)', data.cors_origins.join(', ') || '—')}
        </dl>
      </div>

      <div class="sa-settings-group">
        <h3>Authentication &amp; Sessions</h3>
        <dl class="sa-kv">
          ${saSettingsRow('JWT algorithm', a.jwt_algorithm)}
          ${saSettingsRow('Access token lifetime', `${a.access_token_expire_minutes} minutes`)}
          ${saSettingsRow('Refresh token lifetime', `${a.refresh_token_expire_days} days`)}
          ${saSettingsRow('Password reset link lifetime', `${a.reset_token_expire_minutes} minutes`)}
        </dl>
      </div>

      <div class="sa-settings-group">
        <h3>One-Time Password Policy</h3>
        <dl class="sa-kv">
          ${saSettingsRow('OTP validity', `${a.otp_ttl_minutes} minutes`)}
          ${saSettingsRow('Max verification attempts', a.otp_max_verify_attempts)}
          ${saSettingsRow('Max OTP requests per hour', a.otp_max_requests_per_hour)}
        </dl>
      </div>

      <div class="sa-settings-group">
        <h3>Communication</h3>
        <dl class="sa-kv">
          ${saSettingsRow('OTP delivery mode', c.otp_delivery_mode)}
          ${saSettingsRow('SMTP configured', saYesNo(c.smtp_configured))}
          ${saSettingsRow('SMTP host', c.smtp_host || '—')}
          ${saSettingsRow('Sender name', c.smtp_from_name || '—')}
          ${saSettingsRow('Frontend base URL', c.frontend_base_url)}
        </dl>
        ${c.smtp_configured ? '' : `
          <div class="empty-state" style="text-align:left; margin-top:12px;">
            SMTP is not configured, so the platform is in <strong>dev delivery mode</strong>:
            one-time passwords are returned inline at sign-in instead of being emailed.
            Set SMTP_HOST and SMTP_FROM_EMAIL in the backend environment to switch to email delivery.
          </div>`}
      </div>`, false);
  } catch (err) {
    saSetPanelContent(body, saEscapeHtml(saErrorText(err, 'Failed to load system configuration.')), true);
  }
}
