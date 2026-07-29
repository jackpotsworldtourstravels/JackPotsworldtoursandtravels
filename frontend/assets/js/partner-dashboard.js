'use strict';
/* Merchant Portal — Dashboard KPIs. GET /api/merchant/dashboard (API_CONTRACT.md §6.1). */

const DASH_ICONS = {
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><circle cx="17" cy="15" r="1.5"/>',
  credit: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/>',
  pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  paymentPending: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  issued: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  completed: '<path d="M20 6 9 17l-5-5"/>',
  verify: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
};

function dashCard(icon, variant, value, label) {
  return `
    <div class="stat-card">
      <div class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${icon}</svg></div>
      <div class="stat-body"><div class="num">${value}</div><div class="label">${label}</div></div>
    </div>`;
}

function dashRecentRow(r) {
  return `
    <tr>
      <td>${escapeHtml(r.request_number)}</td>
      <td>${escapeHtml(r.title || '—')}</td>
      <td><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></td>
      <td>${money(r.total_amount)}</td>
      <td>${fmtDate(r.created_at)}</td>
    </tr>`;
}

async function loadDashboard() {
  const grid = document.getElementById('dashboardStatGrid');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${API_BASE}/api/merchant/dashboard`, { headers: partnerAuthHeaders() });
    const s = data.requests_by_status;
    grid.innerHTML = [
      dashCard(DASH_ICONS.wallet, 'sky', money(data.wallet_balance), 'Wallet Balance'),
      dashCard(DASH_ICONS.credit, 'gold', money(data.credit_limit), 'Credit Limit'),
      dashCard(DASH_ICONS.pending, 'gold', s.pending_approval + s.in_review, 'Pending Approval'),
      dashCard(DASH_ICONS.paymentPending, 'coral', s.payment_pending, 'Payment Pending'),
      dashCard(DASH_ICONS.issued, 'emerald', s.ticket_issued, 'Ticket Issued'),
      dashCard(DASH_ICONS.completed, 'emerald', s.completed, 'Completed'),
      dashCard(DASH_ICONS.verify, 'sky', data.pending_payments_count, 'Payments Awaiting Verification'),
      dashCard(DASH_ICONS.bell, 'coral', data.unread_notifications_count, 'Unread Notifications'),
    ].join('');

    const recentWrap = document.getElementById('dashboardRecentWrap');
    if (recentWrap) {
      recentWrap.innerHTML = data.recent_requests.length ? `
        <div class="panel">
          <div class="panel-head"><h2>Recent Requests</h2>
            <button type="button" class="btn btn-ghost btn-sm" id="dashViewAllBtn">View all</button>
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th>Request #</th><th>Item</th><th>Status</th><th>Amount</th><th>Created</th>
          </tr></thead><tbody>${data.recent_requests.map(dashRecentRow).join('')}</tbody></table></div>
        </div>` : '';
      document.getElementById('dashViewAllBtn')?.addEventListener('click', () => navigateToSection('request-history'));
    }
  } catch (err) {
    grid.innerHTML = '<div class="empty-state">Failed to load dashboard.</div>';
  }
}
