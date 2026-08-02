'use strict';
/* Merchant Portal — Dashboard KPIs. GET /api/merchant/dashboard (API_CONTRACT.md §6.1).
   ---------------------------------------------------------------------------
   Every card is a real <button> that navigates somewhere useful, so a number the
   merchant cares about is also the way in to acting on it. Where the destination
   supports a status filter (My Requests, Payments), the card pre-selects it —
   using the <select> values those screens already render, so nothing new is sent
   to the API and no endpoint gained a parameter. */

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

/* `to` is a section name; `filter` optionally names a status to preselect once
   there. Cards with neither stay plain, non-interactive markup — a button that
   goes nowhere is worse than a panel. */
function dashCard(icon, variant, value, label, to, filter, hint) {
  const inner = `
    <span class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${icon}</svg></span>
    <span class="stat-body">
      <span class="num">${value}</span>
      <span class="label">${escapeHtml(label)}</span>
    </span>
    ${to ? '<span class="stat-go" aria-hidden="true">›</span>' : ''}`;
  if (!to) return `<div class="stat-card">${inner}</div>`;
  return `<button type="button" class="stat-card stat-card-link" data-dash-to="${to}"
    ${filter ? `data-dash-filter="${filter}"` : ''}
    aria-label="${escapeHtml(`${label}: ${value}. ${hint || 'Open'}`)}">${inner}</button>`;
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

/* Navigates, then applies the status the card stands for by driving the target
   screen's own filter control and firing its change event — the same path a
   merchant choosing that option by hand takes. */
function dashGoTo(section, filter) {
  navigateToSection(section, () => {
    if (!filter) return;
    const selectId = section === 'payments' ? 'payStatusFilter'
      : section === 'request-history' ? 'rhStatusFilter' : null;
    const el = selectId && document.getElementById(selectId);
    if (!el) return;
    if (![...el.options].some(o => o.value === filter)) return;
    el.value = filter;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function loadDashboard() {
  const grid = document.getElementById('dashboardStatGrid');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${API_BASE}/api/merchant/dashboard`, { headers: partnerAuthHeaders() });
    const s = data.requests_by_status;
    grid.innerHTML = [
      /* wallet_balance/credit_limit are Decimal fields off finance_service and
         cross the wire as decimal STRINGS (M4) — money() does Math.round() and
         puts the currency symbol before a negative sign ("₹-1,00,000"), which
         is wrong twice over for a wallet that can legitimately be negative
         (CR-4). moneyStr() is the formatter built for exactly this class of
         field, and is already how the Admin portal and the Classic wallet
         screen render the same numbers. */
      dashCard(DASH_ICONS.wallet, 'sky', moneyStr(data.wallet_balance), 'Wallet Balance',
        'payments', '', 'Open Payments'),
      /* Credit limit is a standing account term, not a queue — there is nothing to
         open, so it stays a plain card. */
      dashCard(DASH_ICONS.credit, 'gold', moneyStr(data.credit_limit), 'Credit Limit'),
      dashCard(DASH_ICONS.pending, 'gold', s.pending_approval + s.in_review, 'Pending Approval',
        'request-history', 'pending_approval', 'See requests awaiting approval'),
      dashCard(DASH_ICONS.paymentPending, 'coral', s.payment_pending, 'Payment Pending',
        'payments', 'payment_pending', 'See payments due'),
      dashCard(DASH_ICONS.issued, 'emerald', s.ticket_issued, 'Ticket Issued',
        'payments', 'ticket_issued', 'See issued tickets'),
      dashCard(DASH_ICONS.completed, 'emerald', s.completed, 'Completed',
        'request-history', 'completed', 'See completed requests'),
      /* Filters to payment_pending, not paid: dashboard_service counts this from
         Payment rows with payment_status PENDING, and ticket_service.verify_payment
         is what moves the request on to Paid — so a payment awaiting verification
         still belongs to a request sitting in Payment Pending. Sending the merchant
         to `paid` would have shown them the requests already verified, the opposite
         set. */
      dashCard(DASH_ICONS.verify, 'sky', data.pending_payments_count, 'Payments Awaiting Verification',
        'payments', 'payment_pending', 'See the requests those payments belong to'),
      dashCard(DASH_ICONS.bell, 'coral', data.unread_notifications_count, 'Unread Notifications',
        'notifications', '', 'Open the notification centre'),
    ].join('');

    grid.querySelectorAll('[data-dash-to]').forEach(btn => {
      btn.addEventListener('click', () => {
        const to = btn.dataset.dashTo;
        /* Notifications are a drawer, not a section — open it in place. */
        if (to === 'notifications') { openNotifications(); return; }
        dashGoTo(to, btn.dataset.dashFilter || '');
      });
    });

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
