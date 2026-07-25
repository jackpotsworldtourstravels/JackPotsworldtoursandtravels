'use strict';
/* Partner Portal — Dashboard KPIs */

const DASH_ICONS = {
  total: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  approved: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/>',
  rejected: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  completed: '<path d="M20 6 9 17l-5-5"/>',
  cancelled: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  today: '<rect x="3" y="4" width="18" height="18" rx="2.5"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  revenue: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
};

async function loadDashboard() {
  const grid = document.getElementById('dashboardStatGrid');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${API_BASE}/api/partner/dashboard`, { headers: partnerAuthHeaders() });
    const card = (icon, variant, value, label) => `
      <div class="stat-card">
        <div class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${icon}</svg></div>
        <div class="stat-body"><div class="num">${value}</div><div class="label">${label}</div></div>
      </div>`;
    grid.innerHTML = [
      card(DASH_ICONS.total, 'sky', data.total_requests, 'Total Requests'),
      card(DASH_ICONS.pending, 'gold', data.pending_requests, 'Pending Requests'),
      card(DASH_ICONS.approved, 'emerald', data.approved_requests, 'Approved Requests'),
      card(DASH_ICONS.rejected, 'coral', data.rejected_requests, 'Rejected Requests'),
      card(DASH_ICONS.completed, 'emerald', data.completed_requests, 'Completed Requests'),
      card(DASH_ICONS.cancelled, 'coral', data.cancelled_requests, 'Cancelled Requests'),
      card(DASH_ICONS.today, 'sky', data.today_requests, "Today's Requests"),
      card(DASH_ICONS.revenue, 'gold', money(data.today_revenue), "Today's Revenue"),
    ].join('');
  } catch (err) {
    grid.innerHTML = '<div class="empty-state">Failed to load dashboard.</div>';
  }
}
