'use strict';
/* Super Admin Portal — Role & Permission Management.
   GET /api/super-admin/permissions/matrix        (the fixed role table)
   GET|PUT /api/super-admin/admins/{id}/permissions (per-admin extra grants)

   Two different things on one screen, and the distinction matters:

   * The matrix is READ-ONLY. Role responsibilities are fixed by design in
     app/auth/rbac.py — the spec deliberately denies a Super Admin ticket
     permissions and an Admin the ability to create admins, and that
     separation is the product, not a gap to fill with a role editor. So
     this renders it rather than offering to rewrite it.
   * Extra grants ARE editable, and are additive only. The backend cannot
     revoke a role default through this endpoint, so role-default codes
     render checked-and-disabled rather than as controls that would appear
     to work and then silently do nothing. */

/* Group the 38 codes by their module prefix so the matrix reads as
   sections rather than one long alphabetical list. */
const SA_PERM_GROUPS = [
  ['admin', 'Administrator Lifecycle'],
  ['merchant_user', 'Merchant Staff'],
  ['merchant', 'Merchant Lifecycle'],
  ['ticket', 'Tickets & Bookings'],
  ['servicerequest', 'Service Requests'],
  ['payment', 'Payments'],
  ['report', 'Reports'],
  ['chat', 'Chat'],
  ['support', 'Support'],
  ['document', 'Documents'],
  ['notification', 'Notifications'],
  ['profile', 'Profile'],
  ['system', 'System'],
  ['audit', 'Audit'],
];
const SA_MATRIX_ROLES = ['super_admin', 'admin', 'merchant_admin', 'merchant_user'];

let saPermMatrix = null;

/* Longest prefix wins, so "merchant_user.create" lands under Merchant Staff
   rather than Merchant Lifecycle. */
function saPermGroupOf(code) {
  let best = null;
  for (const [prefix, label] of SA_PERM_GROUPS) {
    if (code.startsWith(prefix + '.') && (!best || prefix.length > best[0].length)) {
      best = [prefix, label];
    }
  }
  return best ? best[1] : 'Other';
}

function saGroupCodes(codes) {
  const groups = new Map();
  codes.forEach(code => {
    const label = saPermGroupOf(code);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(code);
  });
  return groups;
}

async function loadSaPermissions() {
  const tbody = document.querySelector('#saMatrixTable tbody');
  saTableError(tbody, 5, 'Loading…');
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/permissions/matrix`,
                                     { headers: saAuthHeaders() });
    saPermMatrix = data;

    const rows = [];
    saGroupCodes(data.all_codes).forEach((codes, label) => {
      rows.push(`<tr class="sa-matrix-group"><td colspan="5">${saEscapeHtml(label)}</td></tr>`);
      codes.forEach(code => {
        const cells = SA_MATRIX_ROLES.map(role => (data.roles[role] || []).includes(code)
          ? '<td><span class="sa-tick">✓</span></td>'
          : '<td><span class="sa-cross">—</span></td>').join('');
        rows.push(`<tr><td class="sa-perm-code">${saEscapeHtml(code)}</td>${cells}</tr>`);
      });
    });
    tbody.innerHTML = rows.join('');
  } catch (err) {
    saTableError(tbody, 5, saErrorText(err, 'Failed to load the permission matrix.'));
    return;
  }
  await saLoadPermAdminPicker();
}

/* ---------- Per-admin extra grants ---------- */
async function saLoadPermAdminPicker() {
  const picker = document.getElementById('saPermAdminPicker');
  const previous = picker.value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/admins`,
                                     { params: { page_size: 100 }, headers: saAuthHeaders() });
    picker.innerHTML = '<option value="">Select an admin…</option>' + data.items.map(a =>
      `<option value="${a.id}">${saEscapeHtml(a.full_name)} — ${saEscapeHtml(a.email)}</option>`
    ).join('');
    if (previous && picker.querySelector(`option[value="${previous}"]`)) {
      picker.value = previous;
    } else {
      document.getElementById('saPermEditorBody').innerHTML =
        '<div class="empty-state">Select an administrator to review or change their extra grants.</div>';
    }
  } catch (err) {
    document.getElementById('saPermEditorBody').innerHTML =
      `<div class="empty-state">${saEscapeHtml(saErrorText(err, 'Failed to load administrators.'))}</div>`;
  }
}

async function saLoadAdminPermissions(adminId) {
  const body = document.getElementById('saPermEditorBody');
  if (!adminId) {
    body.innerHTML = '<div class="empty-state">Select an administrator to review or change their extra grants.</div>';
    return;
  }
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/admins/${adminId}/permissions`,
                                     { headers: saAuthHeaders() });
    const defaults = new Set(data.role_defaults);
    const extras = new Set(data.extra_grants);
    const allCodes = saPermMatrix?.all_codes || [...defaults, ...extras].sort();

    const groups = [];
    saGroupCodes(allCodes).forEach((codes, label) => {
      const checks = codes.map(code => {
        const isDefault = defaults.has(code);
        return `
          <label class="sa-perm-check ${isDefault ? 'is-role-default' : ''}">
            <input type="checkbox" value="${saEscapeHtml(code)}"
                   ${isDefault || extras.has(code) ? 'checked' : ''}
                   ${isDefault ? 'disabled' : ''}>
            <span class="sa-perm-code">${saEscapeHtml(code)}</span>
            ${isDefault ? '<small>role default</small>' : ''}
          </label>`;
      }).join('');
      groups.push(`
        <div class="sa-settings-group">
          <h3>${saEscapeHtml(label)}</h3>
          <div class="sa-perm-grid">${checks}</div>
        </div>`);
    });

    body.innerHTML = `
      <div id="saPermChecks">${groups.join('')}</div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button type="button" class="btn btn-coral btn-sm" id="saSavePermsBtn">Save Extra Grants</button>
        <span class="msg" id="saPermMsg"></span>
      </div>`;

    document.getElementById('saSavePermsBtn').addEventListener('click', () => saSaveAdminPermissions(adminId));
  } catch (err) {
    body.innerHTML = `<div class="empty-state">${saEscapeHtml(saErrorText(err, "Failed to load this admin's permissions."))}</div>`;
  }
}

async function saSaveAdminPermissions(adminId) {
  const msg = document.getElementById('saPermMsg');
  /* Disabled (role-default) boxes are excluded automatically — only the
     genuinely extra codes are sent, which is exactly what the endpoint
     stores. */
  const extras = [...document.querySelectorAll('#saPermChecks input:checked:not(:disabled)')]
    .map(i => i.value);
  try {
    await axios.put(`${API_BASE}/api/super-admin/admins/${adminId}/permissions`,
                    { extra_grants: extras }, { headers: saAuthHeaders() });
    msg.className = 'msg success';
    msg.textContent = extras.length
      ? `Saved — ${extras.length} extra grant${extras.length === 1 ? '' : 's'}.`
      : 'Saved — no extra grants beyond the role default.';
    showToast('Permissions updated.');
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = saErrorText(err, 'Failed to save permissions.');
  }
}

document.getElementById('saPermAdminPicker')?.addEventListener('change', e => {
  saLoadAdminPermissions(e.target.value);
});
