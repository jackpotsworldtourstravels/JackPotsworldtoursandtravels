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
};

/* A DASHBOARD CARD IS A HEADING AND A VALUE. NOTHING ELSE.
   The `sub` line (an active/suspended breakdown) is gone by request, along
   with the Merchant Users, Open Chat Threads and Schema Version cards and the
   Recent System Activity panel. `saActivityRow`, `saSetPanelContent` and the
   unused icons went with them.

   NOTE the response is unchanged: /api/super-admin/dashboard still returns
   `total_merchant_users`, `open_chat_threads`, `schema_version` and
   `recent_activity`, and the Super Admin still holds the permissions to read
   them. Only what this screen renders narrowed, so nothing server-side had to
   move and nothing else that consumes that payload is affected. */
function saDashCard(icon, variant, value, label) {
  return `
    <div class="stat-card">
      <div class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${icon}</svg></div>
      <div class="stat-body">
        <div class="num">${saEscapeHtml(value)}</div>
        <div class="label">${saEscapeHtml(label)}</div>
      </div>
    </div>`;
}

async function loadSaDashboard() {
  const grid = document.getElementById('saDashboardStatGrid');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/dashboard`, { headers: saAuthHeaders() });
    grid.innerHTML = [
      saDashCard(SA_DASH_ICONS.admins, 'sky', data.admins.total, 'Administrators'),
      saDashCard(SA_DASH_ICONS.merchants, 'gold', data.merchants.total, 'Merchants'),
    ].join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">${saEscapeHtml(saErrorText(err, 'Failed to load dashboard.'))}</div>`;
  }
}
