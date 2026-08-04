'use strict';
/* Operations Portal — Settings.
   ===========================================================================
   Four groups, each present only when the account can reach it:

     Profile        GET/PUT /api/profile              profile.manage (everyone)
     Workspace      local only — density, desk, saved column layouts
     Broadcast      POST /api/admin/notifications/broadcast   notification.send
     Permissions    GET /api/super-admin/permissions/matrix   system.activity.view

   The workspace group is the one thing in this portal that is genuinely local:
   density, the current desk and per-grid column visibility are stored in
   localStorage because they are properties of THIS operator at THIS
   workstation, not of the account. A shared finance terminal and someone's
   laptop should not fight over the same row height. The panel says so, and
   offers a reset, so nobody hunts for a server-side setting that does not exist.
   =========================================================================== */

function opsInitSettings() {
  const host = $('ops-settings');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Settings</h1>
        <p>Your profile, this workstation's preferences, and the platform tools your role reaches.</p>
      </div>
    </div>
    <div id="opsSettingsTabs"></div>`;

  OpsTabs($('opsSettingsTabs'), [
    { id: 'profile', label: 'Profile', render: body => opsProfilePanel(body) },
    { id: 'workspace', label: 'Workspace', render: body => opsWorkspacePanel(body) },
    { id: 'broadcast', label: 'Broadcast', when: opsCan('notification.send'),
      render: body => opsBroadcastPanel(body) },
    { id: 'permissions', label: 'Roles & permissions', when: opsCan('system.activity.view'),
      render: body => opsMatrixPanel(body) },
  ], { hash: 'settings' });
}

/* ================================================================ profile */

async function opsProfilePanel(host) {
  host.innerHTML = opsSpinner('Loading your profile…');
  let p;
  try {
    p = await OpsApi.getProfile();
  } catch (err) {
    host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load your profile.'))}</div>
    </div></div>`;
    return;
  }

  const v = k => escapeHtml(String(p[k] ?? ''));
  host.innerHTML = `
    <div class="ops-cols-2">
      <div class="ops-panel">
        <div class="ops-panel-head"><h2>My details</h2></div>
        <div class="ops-panel-body">
          <div class="ops-form ops-form-2">
            <div class="ops-field ops-field-full"><label for="opsPfName">Full name<span class="ops-req">*</span></label>
              <input type="text" id="opsPfName" value="${v('full_name')}"></div>
            <div class="ops-field"><label for="opsPfPhone">Phone</label>
              <input type="text" id="opsPfPhone" value="${escapeHtml(p.mobile || '')}"></div>
            <div class="ops-field"><label for="opsPfGender">Gender</label>
              <select id="opsPfGender"><option value="">—</option>
                ${opsSelectOptions(['male', 'female', 'other'], p.gender || '')}</select></div>
            <div class="ops-field"><label for="opsPfDob">Date of birth</label>
              <input type="date" id="opsPfDob" value="${v('dob').slice(0, 10)}"></div>
            <div class="ops-field"><label for="opsPfCountry">Country</label>
              <input type="text" id="opsPfCountry" value="${v('country')}"></div>
            <div class="ops-field"><label for="opsPfState">State</label>
              <input type="text" id="opsPfState" value="${v('state')}"></div>
            <div class="ops-field"><label for="opsPfCity">City</label>
              <input type="text" id="opsPfCity" value="${v('city')}"></div>
            <div class="ops-field ops-field-full"><label for="opsPfAddr">Address</label>
              <input type="text" id="opsPfAddr" value="${v('address')}"></div>
          </div>
          <div class="ops-form-actions">
            <button type="button" class="ops-btn ops-btn-primary" id="opsPfSave">Save</button>
            <button type="button" class="ops-btn" id="opsPfPw">Change password</button>
            <span class="ops-field-hint ops-spacer"><span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">S</span> saves</span>
          </div>
          <div class="ops-msg" id="opsPfMsg"></div>
        </div>
        <div class="ops-panel-note">
          Your email address is your sign-in identity and is not editable here — an administrator
          changes it.
        </div>
      </div>

      <div class="ops-panel">
        <div class="ops-panel-head"><h2>Account &amp; access</h2></div>
        <div class="ops-panel-body">
          <dl class="ops-dl ops-dl-rows">
            <div><dt>Email</dt><dd>${v('email')}</dd></div>
            <div><dt>Role</dt><dd>${escapeHtml(opsLabel(p.role))}</dd></div>
            ${p.merchant_role ? `<div><dt>Merchant role</dt><dd>${escapeHtml(opsLabel(p.merchant_role))}</dd></div>` : ''}
            ${p.merchant_name ? `<div><dt>Company</dt><dd>${escapeHtml(p.merchant_name)} <span class="ops-muted">(id ${escapeHtml(String(p.merchant_id))})</span></dd></div>` : ''}
            <div><dt>Portal</dt><dd>${escapeHtml(opsLabel(p.portal))}</dd></div>
            <div><dt>Status</dt><dd>${p.is_active ? '<span class="ops-tag ops-tag-ok">Active</span>' : '<span class="ops-tag ops-tag-err">Inactive</span>'}</dd></div>
            <div><dt>Last login</dt><dd>${escapeHtml(p.last_login ? fmtDateTime(p.last_login) : '—')}</dd></div>
          </dl>
          <div class="ops-kpi-label" style="margin-top:12px">Effective permissions (${(p.permissions || []).length})</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px">
            ${(p.permissions || []).slice().sort().map(c =>
              `<span class="ops-tag ops-tag-sq ops-mono">${escapeHtml(c)}</span>`).join('')
              || '<span class="ops-muted">None.</span>'}
          </div>
        </div>
        <div class="ops-panel-note">
          This list is what the API enforces and what this workspace uses to decide which modules
          appear in the sidebar — it is the union of your role's defaults, your merchant role's
          defaults, and any extra grants on your account.
        </div>
      </div>
    </div>`;

  const save = async () => {
    const msg = $('opsPfMsg');
    const full_name = $('opsPfName').value.trim();
    if (!full_name) return opsMsg(msg, 'A full name is required.', 'err');
    $('opsPfSave').disabled = true;
    opsMsg(msg, 'Saving…', 'muted');
    try {
      await OpsApi.updateProfile({
        full_name,
        phone: $('opsPfPhone').value.trim() || undefined,
        gender: $('opsPfGender').value || undefined,
        dob: $('opsPfDob').value || undefined,
        country: $('opsPfCountry').value.trim() || undefined,
        state: $('opsPfState').value.trim() || undefined,
        city: $('opsPfCity').value.trim() || undefined,
        address: $('opsPfAddr').value.trim() || undefined,
      });
      opsMsg(msg, 'Saved.', 'ok');
      /* The toolbar shows the name, so it has to follow the change. */
      OpsSession.user.full_name = full_name;
      $('opsUserName').textContent = full_name;
    } catch (err) {
      opsMsg(msg, opsError(err, 'The profile could not be saved.'), 'err');
    } finally {
      $('opsPfSave').disabled = false;
    }
  };
  $('opsPfSave').addEventListener('click', save);
  $('opsPfPw').addEventListener('click', opsChangePasswordDialog);
  $('ops-settings').addEventListener('ops:save', e => { e.preventDefault(); save(); });
}

/* ============================================================== workspace */

function opsWorkspacePanel(host) {
  const density = localStorage.getItem('ops_density') || 'compact';
  const desk = opsCurrentDesk();
  /* How many distinct GRIDS have a saved layout, not how many keys exist — one
     grid can have all three (visibility, order, widths) and counting keys
     would treat that as three tables. */
  const savedGrids = [...new Set(
    Object.keys(localStorage)
      .map(k => /^ops_(?:cols|colo|colw)_(.+)$/.exec(k))
      .filter(Boolean)
      .map(mm => mm[1]),
  )];

  host.innerHTML = `
    <div class="ops-cols-2">
      <div class="ops-panel">
        <div class="ops-panel-head"><h2>Display</h2></div>
        <div class="ops-panel-body">
          <div class="ops-form ops-form-2">
            <div class="ops-field">
              <label for="opsWsDensity">Row density</label>
              <select id="opsWsDensity">
                <option value="compact"${density === 'compact' ? ' selected' : ''}>Compact — most rows per screen</option>
                <option value="relaxed"${density === 'relaxed' ? ' selected' : ''}>Relaxed — easier to hit with a mouse</option>
              </select>
            </div>
            <div class="ops-field">
              <label for="opsWsDesk">Default desk</label>
              <select id="opsWsDesk">${opsSelectOptions(
                OPS_DESKS.map(d => ({ value: d.id, label: d.label })), desk)}</select>
              <span class="ops-field-hint">Narrows the sidebar. Never changes what you may access.</span>
            </div>
          </div>
          <div class="ops-form-actions">
            <button type="button" class="ops-btn ops-btn-primary" id="opsWsApply">Apply</button>
            <button type="button" class="ops-btn" id="opsWsCols">Reset all column layouts${savedGrids.length ? ` (${savedGrids.length})` : ''}</button>
          </div>
          <div class="ops-msg" id="opsWsMsg"></div>
        </div>
        <div class="ops-panel-note">
          These are stored in this browser, for this workstation — not on your account. A shared
          terminal and your own laptop keep their own settings, and clearing site data resets them.
        </div>
      </div>

      <div class="ops-panel">
        <div class="ops-panel-head"><h2>Keyboard &amp; interfaces</h2></div>
        <div class="ops-panel-body">
          <dl class="ops-dl ops-dl-rows">
            <div><dt><span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">K</span></dt><dd>Global search</dd></div>
            <div><dt><span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">F</span></dt><dd>Global search (same box)</dd></div>
            <div><dt><span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">N</span></dt><dd>New request</dd></div>
            <div><dt><span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">S</span></dt><dd>Save the form on screen</dd></div>
            <div><dt><span class="ops-kbd">Esc</span></dt><dd>Close dialog, drawer, menu, search</dd></div>
            <div><dt><span class="ops-kbd">?</span></dt><dd>Shortcut list</dd></div>
          </dl>
          <div class="ops-form-actions">
            <a class="ops-btn" href="${escapeHtml(OpsSession.portal === 'merchant' ? '../merchant/index.html'
              : OpsSession.portal === 'admin' ? '../admin/index.html' : '../super-admin/index.html')}">
              Open the Version 1 portal</a>
            ${OpsSession.portal === 'merchant' ? '<a class="ops-btn" href="../merchant-classic/index.html">Classic merchant portal</a>' : ''}
          </div>
        </div>
        <div class="ops-panel-note">
          All interfaces share one backend and one session: you are already signed in to them, and
          signing out of any one signs you out of all of them.
        </div>
      </div>
    </div>`;

  $('opsWsApply').addEventListener('click', () => {
    localStorage.setItem('ops_density', $('opsWsDensity').value);
    localStorage.setItem('ops_desk', $('opsWsDesk').value);
    opsApplyDensity();
    opsRenderDeskMenu();
    opsRenderNav();
    opsMsg($('opsWsMsg'), 'Applied.', 'ok');
  });
  $('opsWsCols').addEventListener('click', async () => {
    if (!await opsConfirm('Show every column again in every table, discarding the visibility, order and widths saved in this browser?', 'Reset')) return;
    /* All three per-grid layout keys, not just visibility — ops_cols_ (shown/
       hidden), ops_colo_ (order) and ops_colw_ (widths). Clearing only the
       first would leave a table still reordered and still resized after the
       operator was told their layouts were cleared. */
    Object.keys(localStorage)
      .filter(k => /^ops_(cols|colo|colw)_/.test(k))
      .forEach(k => localStorage.removeItem(k));
    /* Every grid reads its layout at construction, so they have to be rebuilt. */
    opsLoaded.clear();
    opsMsg($('opsWsMsg'), 'Column layouts cleared. Tables rebuild as you open them.', 'ok');
  });
}

/* ============================================================== broadcast */

function opsBroadcastPanel(host) {
  host.innerHTML = `
    <div class="ops-panel">
      <div class="ops-panel-head"><h2>Broadcast a notification</h2></div>
      <div class="ops-panel-body">
        <div class="ops-form ops-form-2">
          <div class="ops-field ops-field-full">
            <label for="opsBcTitle">Title<span class="ops-req">*</span></label>
            <input type="text" id="opsBcTitle" placeholder="e.g. Fare revision effective 1 August">
          </div>
          <div class="ops-field ops-field-full">
            <label for="opsBcMsg">Message<span class="ops-req">*</span></label>
            <textarea id="opsBcMsg" rows="4"></textarea>
          </div>
          <div class="ops-field ops-field-full">
            <label>Recipients</label>
            <label class="ops-check"><input type="radio" name="opsBcWho" value="all" checked>
              Every active merchant</label>
            <label class="ops-check"><input type="radio" name="opsBcWho" value="some">
              Selected merchants only</label>
          </div>
          <div class="ops-field ops-field-full ops-hidden" id="opsBcPick">
            <label>Choose merchants</label>
            <div id="opsBcList" style="border:1px solid var(--ops-line);border-radius:3px;padding:5px;max-height:190px;overflow:auto">
              ${opsSpinner('Loading merchants…')}
            </div>
          </div>
        </div>
        <div class="ops-form-actions">
          <button type="button" class="ops-btn ops-btn-primary" id="opsBcSend">Send broadcast</button>
          <span class="ops-field-hint ops-spacer">This reaches every user of the chosen merchants.</span>
        </div>
        <div class="ops-msg" id="opsBcResult"></div>
      </div>
      <div class="ops-panel-note">
        A merchant with <b>in-portal notifications</b> switched off in its communication settings is
        <b>skipped, not force-sent</b> — the result below reports sent and skipped separately, so a
        lower number than you expected is a settings question rather than a failure.
      </div>
    </div>`;

  opsAll('[name="opsBcWho"]').forEach(r =>
    r.addEventListener('change', () => {
      const some = opsEl('[name="opsBcWho"]:checked').value === 'some';
      $('opsBcPick').classList.toggle('ops-hidden', !some);
    }));

  OpsApi.listMerchants({ page_size: OPS_PAGE_MAX }).then(d => {
    const rows = d.items || [];
    $('opsBcList').innerHTML = rows.length ? rows.map(m => `
      <label class="ops-check"><input type="checkbox" data-ops-bc="${m.id}">
        ${escapeHtml(m.company_name)} <span class="ops-muted">${escapeHtml(m.merchant_code)} · ${escapeHtml(opsLabel(m.status))}</span>
      </label>`).join('') : '<span class="ops-muted">No merchants.</span>';
  }).catch(err => {
    $('opsBcList').innerHTML = `<span class="ops-muted">${escapeHtml(opsError(err, 'Could not load merchants.'))}</span>`;
  });

  $('opsBcSend').addEventListener('click', async () => {
    const title = $('opsBcTitle').value.trim();
    const message = $('opsBcMsg').value.trim();
    const msg = $('opsBcResult');
    if (!title) return opsMsg(msg, 'A title is required.', 'err');
    if (!message) return opsMsg(msg, 'A message is required.', 'err');

    const some = opsEl('[name="opsBcWho"]:checked').value === 'some';
    const merchantIds = some ? opsAll('[data-ops-bc]:checked').map(cb => Number(cb.dataset.opsBc)) : [];
    if (some && !merchantIds.length) return opsMsg(msg, 'Select at least one merchant.', 'err');

    if (!await opsConfirm(
      some ? `Send this to every user of ${merchantIds.length} merchant(s)?`
           : 'Send this to every user of every active merchant?', 'Send')) return;

    $('opsBcSend').disabled = true;
    opsMsg(msg, 'Sending…', 'muted');
    try {
      const res = await OpsApi.broadcast({ merchantIds, title, message });
      opsMsg(msg, `${res.sent} notification(s) sent${res.skipped ? `, ${res.skipped} skipped (notifications disabled)` : ''}.`, 'ok');
      $('opsBcTitle').value = '';
      $('opsBcMsg').value = '';
    } catch (err) {
      opsMsg(msg, opsError(err, 'The broadcast failed.'), 'err');
    } finally {
      $('opsBcSend').disabled = false;
    }
  });
}

/* ============================================================ permissions */

async function opsMatrixPanel(host) {
  host.innerHTML = opsSpinner('Loading the permission matrix…');
  try {
    const m = await OpsApi.permissionMatrix();
    const roles = m.roles || {};
    const merchantRoles = m.merchant_roles || {};
    const all = (m.all_codes || []).slice().sort();

    const table = (title, map, note) => {
      const names = Object.keys(map);
      return `
        <div class="ops-panel">
          <div class="ops-panel-head"><h2>${escapeHtml(title)}</h2>
            <div class="ops-panel-tools ops-muted">${names.length} roles · ${all.length} codes</div>
          </div>
          <div class="ops-panel-body ops-flush">
            <div class="ops-table-wrap tall">
              <table class="ops-table">
                <thead><tr><th>Permission</th>${names.map(n =>
                  `<th style="text-align:center">${escapeHtml(opsLabel(n))}</th>`).join('')}</tr></thead>
                <tbody>${all.map(code => {
                  const held = names.map(n => (map[n] || []).includes(code));
                  if (!held.some(Boolean)) return '';    /* codes no role in this table holds */
                  return `<tr>
                    <td class="ops-mono">${escapeHtml(code)}</td>
                    ${held.map(h => `<td style="text-align:center">${h
                      ? '<span style="color:var(--ops-ok);font-weight:700">✓</span>'
                      : '<span class="ops-muted">·</span>'}</td>`).join('')}
                  </tr>`;
                }).join('')}</tbody>
              </table>
            </div>
          </div>
          <div class="ops-panel-note">${note}</div>
        </div>`;
    };

    host.innerHTML =
      table('Portal roles', roles, `
        <b>This matrix is fixed and read-only by design</b>, not for want of an editor. The
        separation it encodes is the point: a Super Admin deliberately cannot raise tickets, and an
        Admin deliberately cannot create Admins. Where an individual genuinely needs more, an extra
        grant is added to <b>that person</b> under Users → Administrators → Permissions, which
        leaves the role boundaries intact.`)
      + table('Merchant sub-roles', merchantRoles, `
        A merchant user's effective permissions are the <b>union</b> of their account role and their
        merchant sub-role, so a merchant_user with the Finance sub-role can pay and report without
        being able to raise a booking.`);
  } catch (err) {
    host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load the matrix.'))}</div>
    </div></div>`;
  }
}
