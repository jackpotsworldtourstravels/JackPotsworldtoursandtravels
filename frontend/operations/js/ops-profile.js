'use strict';
/* Operations Portal — Profile (merchant workspace).
   ===========================================================================
   The brief's Profile screen: Company Information, GST, PAN, Documents,
   Password, API Keys, Notification Preferences.

   WHAT IS REAL AND WHAT IS WAITING, AND WHY THE SPLIT IS WHERE IT IS
   This screen sits almost entirely on top of endpoints that do not exist yet,
   so it is worth being exact rather than vague:

     My details       GET/PUT /api/profile          REAL. full_name, phone,
                                                    gender, dob, country,
                                                    state, city, address.
     Password         POST /api/auth/change-password  REAL.
     Company identity GET /api/auth/me              REAL, but READ-ONLY —
                                                    merchant_name/merchant_id
                                                    are all the session carries.
     Financial standing GET /api/merchant/dashboard  REAL — wallet + credit.

     GST / PAN        no column, no route.   The merchants table has no GST or
                                             PAN field at all (models_v2.py),
                                             so there is nothing to read or
                                             write. Rendered disabled.
     Company editing  no route.  A merchant cannot read its own company row:
                                 /api/admin/merchants/{id} is gated on
                                 `merchant.view`, which no merchant role holds.
                                 Admin owns company records.
     Documents        PENDING_MODULES.  The `documents` router is not built —
                                        POST/GET /api/documents in
                                        docs/API_CONTRACT.md §7 has no
                                        implementation behind it.
     API keys         no route, no table.  Nothing issues or stores a key.
     Notification     admin-scoped only.  The single endpoint is
     preferences                          GET/PUT /api/admin/communication-
                                          settings/{merchant_id}, behind an
                                          admin permission. There is no
                                          merchant-self equivalent.

   Everything in that second list is rendered in its final position and
   disabled with the reason shown — see opsPendingAction in ops-core.js for
   the rules. Nothing here writes to localStorage as a stand-in for a server
   and nothing reports a save that did not happen.

   NO DUPLICATED COMPONENTS. "My details" and "Account & access" are the exact
   panels Settings already renders — this screen calls opsProfilePanel() from
   ops-settings.js rather than growing a second copy of the same form. Password
   reuses opsChangePasswordDialog() from the shell. Only the merchant-specific
   panels are new.
   =========================================================================== */

function opsInitProfile() {
  const host = $('ops-profile');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Profile</h1>
        <p>Your company record, your own details, and your sign-in security.</p>
      </div>
    </div>
    <div id="opsProfileTabs"></div>`;

  OpsTabs($('opsProfileTabs'), [
    { id: 'company', label: 'Company', render: body => opsProfileCompanyPanel(body) },
    { id: 'me', label: 'My details', render: body => opsProfilePanel(body) },
    { id: 'documents', label: 'Documents', render: body => opsProfileDocumentsPanel(body) },
    { id: 'security', label: 'Security', render: body => opsProfileSecurityPanel(body) },
    { id: 'notifications', label: 'Notification preferences',
      render: body => opsProfileNotifyPanel(body) },
  ], { hash: 'profile' });
}

/* ================================================================= company */

async function opsProfileCompanyPanel(host) {
  host.innerHTML = opsSpinner('Loading your company record…');

  const user = OpsSession.user || {};
  /* Wallet and credit are the only company-level figures a merchant session
     can read. A dashboard hiccup must not blank the identity panel beside it,
     which needs no network call at all — so this failure is swallowed to null
     and the panel says so. */
  let m = null;
  if (opsCan('ticket.view')) {
    try { m = await OpsApi.merchantDashboard(); } catch { m = null; }
  }

  host.innerHTML = `
    <div class="ops-cols-2">
      <div class="ops-panel">
        <div class="ops-panel-head">
          <h2>Company information</h2>
          <div class="ops-panel-tools"><span class="ops-tag">Read-only</span></div>
        </div>
        <div class="ops-panel-body">
          <dl class="ops-dl ops-dl-rows">
            <div><dt>Company</dt><dd>${escapeHtml(user.merchant_name || '—')}</dd></div>
            <div><dt>Merchant ID</dt><dd><span class="ops-mono">${escapeHtml(String(user.merchant_id ?? '—'))}</span></dd></div>
            <div><dt>Your role</dt><dd>${escapeHtml(opsLabel(user.role))}${
              user.merchant_role ? ` · ${escapeHtml(opsLabel(user.merchant_role))}` : ''}</dd></div>
          </dl>
          ${opsPendingNote(
            'Company details are maintained by your account manager. A merchant sign-in can read '
            + 'its company name and id but cannot edit the company record — that endpoint is '
            + 'administrator-only.')}
        </div>
      </div>

      <div class="ops-panel">
        <div class="ops-panel-head"><h2>Financial standing</h2></div>
        <div class="ops-panel-body">
          ${m ? `<div class="ops-kpis">
              ${opsKpi({ label: 'Wallet balance', value: money(Number(m.wallet_balance)), sub: 'available' })}
              ${opsKpi({ label: 'Credit limit', value: money(Number(m.credit_limit)), sub: 'sanctioned' })}
            </div>` : `<div class="ops-msg ops-msg-info" style="margin:0">
              Wallet figures are unavailable for this account.</div>`}
        </div>
        ${m ? '<div class="ops-panel-note">Live from your dashboard. Open Wallet for the transaction history behind these figures.</div>' : ''}
      </div>
    </div>

    <div class="ops-panel">
      <div class="ops-panel-head">
        <h2>Statutory registration</h2>
        <div class="ops-panel-tools"><span class="ops-tag">Pending</span></div>
      </div>
      <div class="ops-panel-body">
        <div class="ops-form ops-form-2">
          <div class="ops-field">
            <label for="opsPrGst">GSTIN</label>
            <input type="text" id="opsPrGst" placeholder="15-character GSTIN" disabled>
          </div>
          <div class="ops-field">
            <label for="opsPrPan">PAN</label>
            <input type="text" id="opsPrPan" placeholder="10-character PAN" disabled>
          </div>
        </div>
        <div class="ops-form-actions">
          <button type="button" class="ops-btn ops-btn-primary" disabled
                  title="Backend integration pending">Save</button>
        </div>
        ${opsPendingNote(
          'Backend integration pending — the merchant record has no GST or PAN field yet, so there '
          + 'is nothing to load or save. These inputs will work unchanged once those columns and '
          + 'their endpoint exist.')}
      </div>
    </div>`;
}

/* =============================================================== documents */

function opsProfileDocumentsPanel(host) {
  host.innerHTML = `
    <div class="ops-panel">
      <div class="ops-panel-head">
        <h2>Company documents</h2>
        <div class="ops-panel-tools"><span class="ops-tag">Pending</span></div>
      </div>
      <div class="ops-panel-body">
        <div class="ops-form ops-form-2">
          <div class="ops-field">
            <label for="opsPrDocType">Document type</label>
            <select id="opsPrDocType" disabled>
              <option>GST certificate</option>
              <option>PAN card</option>
              <option>Incorporation certificate</option>
              <option>Cancelled cheque</option>
              <option>Other</option>
            </select>
          </div>
          <div class="ops-field">
            <label for="opsPrDocFile">File</label>
            <input type="file" id="opsPrDocFile" disabled>
          </div>
        </div>
        <div class="ops-form-actions">
          <button type="button" class="ops-btn ops-btn-primary" disabled
                  title="Document uploads are not yet supported">Upload</button>
        </div>
        ${opsPendingNote(
          'Document uploads are not yet supported — the documents module is not built on the '
          + 'server, so there is no endpoint to receive a file. Your account already holds the '
          + '`document.upload` permission, so this screen will work as soon as the route ships.')}
      </div>
    </div>

    <div class="ops-panel">
      <div class="ops-panel-head"><h2>Uploaded documents</h2></div>
      <div class="ops-panel-body ops-flush">
        <div class="ops-table-wrap">
          <table class="ops-table">
            <thead><tr>
              <th>Document</th><th>Type</th><th>Uploaded</th><th>Status</th><th class="ops-actions">Action</th>
            </tr></thead>
            <tbody>${opsEmptyRow(5, 'No document list is available — this view needs the documents endpoint.')}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

/* ================================================================ security */

function opsProfileSecurityPanel(host) {
  host.innerHTML = `
    <div class="ops-cols-2">
      <div class="ops-panel">
        <div class="ops-panel-head"><h2>Password</h2></div>
        <div class="ops-panel-body">
          <p class="ops-muted" style="margin:0 0 10px;font-size:11.5px">
            Changing your password signs out nothing else — your other sessions stay open until
            they expire.
          </p>
          <div class="ops-form-actions" style="margin-top:0">
            <button type="button" class="ops-btn ops-btn-primary" id="opsPrPwBtn">Change password</button>
          </div>
        </div>
        <div class="ops-panel-note">
          Your email address is your sign-in identity and is not editable here — an administrator
          changes it.
        </div>
      </div>

      <div class="ops-panel">
        <div class="ops-panel-head">
          <h2>API keys</h2>
          <div class="ops-panel-tools"><span class="ops-tag">Pending</span></div>
        </div>
        <div class="ops-panel-body">
          <div class="ops-pending-block">
            <p><b>Backend integration pending.</b></p>
            <p class="ops-muted">
              This platform does not issue API keys yet — there is no table storing them and no
              endpoint to create, list or revoke one. Machine-to-machine access is not available
              through this workspace.
            </p>
          </div>
          <div class="ops-form-actions">
            <button type="button" class="ops-btn ops-btn-sm" disabled
                    title="Backend integration pending">Generate key</button>
          </div>
        </div>
      </div>
    </div>`;

  /* The shell already owns this dialog — Settings and the account menu both
     open the same one. */
  $('opsPrPwBtn').addEventListener('click', opsChangePasswordDialog);
}

/* =========================================================== notifications */

function opsProfileNotifyPanel(host) {
  const channels = [
    ['Email', 'Booking confirmations, approvals, payment receipts'],
    ['SMS', 'Time-critical updates only'],
    ['WhatsApp', 'Booking and ticket updates'],
    ['In-app', 'Everything, in the notification drawer'],
  ];
  host.innerHTML = `
    <div class="ops-panel">
      <div class="ops-panel-head">
        <h2>Notification preferences</h2>
        <div class="ops-panel-tools"><span class="ops-tag">Pending</span></div>
      </div>
      <div class="ops-panel-body">
        <div class="ops-table-wrap">
          <table class="ops-table">
            <thead><tr><th>Channel</th><th>What it carries</th><th style="width:90px">Enabled</th></tr></thead>
            <tbody>${channels.map(([name, what]) => `
              <tr>
                <td><b>${escapeHtml(name)}</b></td>
                <td class="ops-muted">${escapeHtml(what)}</td>
                <td><input type="checkbox" disabled aria-label="${escapeHtml(name)} notifications"></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="ops-form-actions">
          <button type="button" class="ops-btn ops-btn-primary" disabled
                  title="This feature will be enabled once backend support is available">Save preferences</button>
        </div>
        ${opsPendingNote(
          'This feature will be enabled once backend support is available. Communication settings '
          + 'exist on the server but only behind an administrator-scoped endpoint '
          + '(/api/admin/communication-settings) — there is no merchant-self route to read or '
          + 'write your own preferences, so these switches have nothing to bind to.')}
      </div>
      <div class="ops-panel-note">
        In the meantime your account manager can change these for you, and the notification drawer
        (🔔, top right) always shows everything regardless of channel settings.
      </div>
    </div>`;
}
