'use strict';
/* Super Admin Portal — Dashboard KPIs and system overview.
   GET /api/super-admin/dashboard (API_CONTRACT.md §6.1).

   Deliberately a *system* overview, not an operational one: no ticket or
   payment queues appear here because a Super Admin holds neither
   ticket.* nor payment.* (app/auth/rbac.py::_SUPER_ADMIN), so surfacing
   those counts would only advertise actions the portal can't take. */

const SA_DASH_ICONS = {
  admins: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  merchants: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="m17 11 2 2 4-4"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
  schema: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
};

/* `textValue` switches the number to the wrapping text treatment — a version
   string is not a KPI count and doesn't fit .num's 23px numeric styling. */
function saDashCard(icon, variant, value, label, sub, textValue) {
  return `
    <div class="stat-card">
      <div class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${icon}</svg></div>
      <div class="stat-body">
        <div class="num${textValue ? ' sa-num-text' : ''}">${saEscapeHtml(value)}</div>
        <div class="label">${saEscapeHtml(label)}</div>
        ${sub ? `<div class="label" style="opacity:.75;">${saEscapeHtml(sub)}</div>` : ''}
      </div>
    </div>`;
}

function saActivityRow(a) {
  return `
    <tr>
      <td>${fmtDateTime(a.created_at)}</td>
      <td>${saEscapeHtml(a.user_name || 'System')}</td>
      <td>${saEscapeHtml(a.module)}</td>
      <td>${saEscapeHtml(a.action)}</td>
      <td>${saEscapeHtml(a.description || '—')}</td>
    </tr>`;
}

/* The container starts as .empty-state, which is a centering flex box — real
   content dropped into it would shrink-to-fit and overflow its panel rather
   than filling it. So the class goes on and off with the placeholder. */
function saSetPanelContent(el, html, isPlaceholder) {
  el.className = isPlaceholder ? 'empty-state' : '';
  el.innerHTML = html;
}

async function loadSaDashboard() {
  const grid = document.getElementById('saDashboardStatGrid');
  const activity = document.getElementById('saDashboardActivity');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  saSetPanelContent(activity, 'Loading…', true);
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/dashboard`, { headers: saAuthHeaders() });
    const a = data.admins, m = data.merchants;
    grid.innerHTML = [
      saDashCard(SA_DASH_ICONS.admins, 'sky', a.total, 'Administrators',
                 `${a.active} active · ${a.suspended} suspended`),
      saDashCard(SA_DASH_ICONS.merchants, 'gold', m.total, 'Merchants',
                 `${m.active} active · ${m.pending_approval} awaiting approval`),
      saDashCard(SA_DASH_ICONS.users, 'emerald', data.total_merchant_users, 'Merchant Users'),
      saDashCard(SA_DASH_ICONS.chat, 'coral', data.open_chat_threads, 'Open Chat Threads'),
      saDashCard(SA_DASH_ICONS.schema, '', data.schema_version, 'Schema Version', '', true),
    ].join('');

    if (data.recent_activity.length) {
      saSetPanelContent(activity, `
        <div class="table-wrap"><table><thead><tr>
          <th>When</th><th>User</th><th>Module</th><th>Action</th><th>Description</th>
        </tr></thead><tbody>${data.recent_activity.map(saActivityRow).join('')}</tbody></table></div>`, false);
    } else {
      saSetPanelContent(activity, 'No recorded activity yet.', true);
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">${saEscapeHtml(saErrorText(err, 'Failed to load dashboard.'))}</div>`;
    saSetPanelContent(activity, 'Failed to load activity.', true);
  }
}
