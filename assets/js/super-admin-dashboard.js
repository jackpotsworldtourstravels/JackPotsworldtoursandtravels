'use strict';
/* Super Admin Portal — Dashboard KPIs.
   Static values per your instructions — backend/app/services/super_admin_service.py
   ::get_dashboard_stats() has the matching TODOs for the real counts. */

const SA_DASH_ICONS = {
  admins: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  merchants: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="m17 11 2 2 4-4"/>',
};

async function loadSaDashboard() {
  const grid = document.getElementById('saDashboardStatGrid');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${SA_API_BASE}/api/super-admin/dashboard/stats`, { headers: saAuthHeaders() });
    const card = (icon, variant, value, label) => `
      <div class="stat-card">
        <div class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${icon}</svg></div>
        <div class="stat-body"><div class="num">${value}</div><div class="label">${label}</div></div>
      </div>`;
    grid.innerHTML = [
      card(SA_DASH_ICONS.admins, 'sky', data.total_admins, 'Total Admins'),
      card(SA_DASH_ICONS.merchants, 'gold', data.total_merchants, 'Total Merchants'),
      card(SA_DASH_ICONS.users, '', data.total_users, 'Total Users'),
    ].join('');
  } catch (err) {
    grid.innerHTML = '<div class="empty-state">Failed to load dashboard.</div>';
  }
}
