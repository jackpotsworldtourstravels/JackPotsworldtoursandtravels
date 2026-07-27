'use strict';
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

/* Escape user-supplied text before inserting into innerHTML templates */
/* escapeHtml/money/fmtDate/fmtDateTime/fmtTime now live in shared/formatters.js. */

const access = localStorage.getItem('jwt_access');
const role = localStorage.getItem('jwt_user_role');
if (!access || role !== 'admin') {
  window.location.href = '../index.html';
}
document.getElementById('adminName').textContent = localStorage.getItem('jwt_user_name') || '';

/* authHeaders() now lives in assets/js/auth.js, loaded before this file. */

/* Render Prev/Next pagination controls into a container; onChange(newPage) reloads the table */
function renderPagination(containerId, page, totalPages, total, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (total === 0) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <span>Page ${page} of ${totalPages} (${total} total)</span>
    <button type="button" class="btn btn-ghost btn-sm" data-page-prev ${page <= 1 ? 'disabled' : ''}>&larr; Prev</button>
    <button type="button" class="btn btn-ghost btn-sm" data-page-next ${page >= totalPages ? 'disabled' : ''}>Next &rarr;</button>
  `;
  container.querySelector('[data-page-prev]').addEventListener('click', () => onChange(page - 1));
  container.querySelector('[data-page-next]').addEventListener('click', () => onChange(page + 1));
}
const PAGE_SIZE = 10;
let usersPage = 1, bookingsPage = 1, paymentsPage = 1, contactPage = 1;
let reviewsPage = 1, wishlistPage = 1, notificationsPage = 1, activityPage = 1;

document.getElementById('logoutBtn').addEventListener('click', async e => {
  e.preventDefault();
  try { await axios.post(`${API_BASE}/api/auth/logout`, {}, { headers: authHeaders() }); } catch (err) { /* ignore */ }
  localStorage.removeItem('jwt_access');
  localStorage.removeItem('jwt_refresh');
  localStorage.removeItem('jwt_user_name');
  localStorage.removeItem('jwt_user_role');
  window.location.href = '../index.html';
});

/* ---------- Section navigation ---------- */
const sectionTitles = {
  reports: 'Dashboard', users: 'Users', 'active-users': 'Active Users', customers: 'Customers', flights: 'Flights', hotels: 'Hotels', cruises: 'Cruises',
  packages: 'Tour Packages', bookings: 'All Transactions', 'booking-management': 'Booking Management Center', payments: 'Payment Management', 'payment-management': 'Payment Management Center', refunds: 'Refunds', 'partner-requests': 'Partner Requests', contact: 'Support Management', newsletter: 'Newsletter',
  'user-analytics': 'User Analytics', 'reports-export': 'Reports',
  reviews: 'Complaint Management', wishlist: 'Wishlist', notifications: 'Communication', activity: 'User Activity Monitor', inventory: 'Inventory', pricing: 'Coupons & Discounts',
  profile: 'Profile',
};
const loadedSections = new Set();

/* Shared by the sidebar nav clicks and any programmatic jump (Quick Actions, global search results) —
   `onArrive` runs after the section is loaded (or immediately if it was already loaded), so callers can
   apply a filter/scroll without duplicating loadSection's logic. */
function navigateToSection(name, onArrive) {
  document.querySelectorAll('.nav-item[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  document.getElementById('pageTitle').textContent = sectionTitles[name];
  if (!loadedSections.has(name)) {
    loadedSections.add(name);
    Promise.resolve(loadSection(name)).then(() => onArrive?.());
  } else {
    onArrive?.();
  }
}
document.querySelectorAll('.nav-item[data-section]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    navigateToSection(link.dataset.section);
  });
});

function loadSection(name) {
  if (name === 'reports') return loadReports();
  if (name === 'users') return loadMerchants();
  if (name === 'active-users') return loadActiveUsers();
  if (name === 'customers') return loadCustomers();
  if (name === 'user-analytics') return loadUserAnalytics();
  if (name === 'reports-export') return loadReportsExport();
  if (name === 'bookings') return loadBookings();
  if (name === 'payments') return loadPayments();
  if (name === 'contact') return loadContact();
  if (name === 'newsletter') return loadNewsletter();
  if (name === 'reviews') return loadReviewsAdmin();
  if (name === 'wishlist') return loadWishlistAdmin();
  if (name === 'notifications') return initNotificationForm();
  if (name === 'activity') return loadActivityLog();
  if (name === 'inventory') return loadInventory();
  if (name === 'pricing') return loadPricingSection();
  if (name === 'booking-management') return loadBookingManagement();
  if (name === 'payment-management') return loadPaymentManagement();
  if (name === 'refunds') return loadRefunds();
  if (name === 'partner-requests') return initPartnerRequests();
  if (name === 'profile') return loadAdminProfile();
  if (['flights', 'hotels', 'cruises', 'packages'].includes(name)) return renderContentSection(name);
}

/* ---------- Loading skeletons ---------- */
function statGridSkeleton(count = 8) {
  return `<div class="skeleton-stat-grid">${Array.from({ length: count }).map(() => `
    <div class="skeleton-stat-card">
      <div class="skeleton icon"></div>
      <div class="skeleton-lines"><div class="skeleton line-lg"></div><div class="skeleton line-sm"></div></div>
    </div>`).join('')}</div>`;
}
function rowsSkeleton(count = 5) {
  return `<div class="skeleton-rows">${Array.from({ length: count }).map(() => '<div class="skeleton"></div>').join('')}</div>`;
}

/* ---------- Global search ---------- */
/* Federates the three list endpoints that already support server-side `search` —
   customers, booking-management, payment-management — no new backend endpoint. */
let globalSearchTimer;
const gsInput = document.getElementById('globalSearchInput');
const gsDropdown = document.getElementById('globalSearchDropdown');
async function runGlobalSearch(q) {
  gsDropdown.innerHTML = rowsSkeleton(3);
  gsDropdown.classList.add('open');
  try {
    const [customers, bookings, payments] = await Promise.all([
      axios.get(`${API_BASE}/api/admin/customers`, { headers: authHeaders(), params: { search: q, page: 1, page_size: 4 } }).catch(() => null),
      axios.get(`${API_BASE}/api/admin/booking-management/bookings`, { headers: authHeaders(), params: { search: q, page: 1, page_size: 4 } }).catch(() => null),
      axios.get(`${API_BASE}/api/admin/payment-management/payments`, { headers: authHeaders(), params: { search: q, page: 1, page_size: 4 } }).catch(() => null),
    ]);
    const groups = [];
    if (customers?.data?.items?.length) {
      groups.push({ label: 'Customers', rows: customers.data.items.map(c => ({
        title: c.full_name, meta: c.email, action: () => navigateToSection('customers', () => {
          document.getElementById('customerSearch').value = c.email; loadCustomers(1);
        }),
      })) });
    }
    if (bookings?.data?.items?.length) {
      groups.push({ label: 'Bookings', rows: bookings.data.items.map(b => ({
        title: `#${b.id} — ${b.customer_name || 'Booking'}`, meta: `${b.booking_type} · ${b.destination || ''}`.trim(),
        action: () => navigateToSection('booking-management', () => {
          document.getElementById('bmSearch').value = String(b.id); loadBookingManagement(1);
        }),
      })) });
    }
    if (payments?.data?.items?.length) {
      groups.push({ label: 'Payments', rows: payments.data.items.map(p => ({
        title: p.transaction_ref || `Payment #${p.id}`, meta: `${p.customer_name || ''} · ${money(p.amount)}`,
        action: () => navigateToSection('payment-management', () => {
          document.getElementById('pmSearch').value = p.transaction_ref || String(p.id); loadPaymentManagement(1);
        }),
      })) });
    }
    if (!groups.length) {
      gsDropdown.innerHTML = '<div class="empty-state">No matches.</div>';
      return;
    }
    gsDropdown.innerHTML = groups.map(g => `
      <div class="gs-group-label">${g.label}</div>
      ${g.rows.map((r, i) => `<div class="gs-result-item" data-group="${g.label}" data-idx="${i}"><span class="gs-title">${escapeHtml(r.title)}</span><span class="gs-meta">${escapeHtml(r.meta || '')}</span></div>`).join('')}
    `).join('');
    gsDropdown.querySelectorAll('[data-group]').forEach(el => {
      const group = groups.find(g => g.label === el.dataset.group);
      el.addEventListener('click', () => {
        group.rows[Number(el.dataset.idx)].action();
        gsDropdown.classList.remove('open');
        gsInput.value = '';
      });
    });
  } catch (err) {
    gsDropdown.innerHTML = '<div class="empty-state">Search failed.</div>';
  }
}
gsInput.addEventListener('input', () => {
  clearTimeout(globalSearchTimer);
  const q = gsInput.value.trim();
  if (q.length < 2) { gsDropdown.classList.remove('open'); return; }
  globalSearchTimer = setTimeout(() => runGlobalSearch(q), 350);
});
document.addEventListener('click', e => {
  if (!e.target.closest('#globalSearchWrap')) gsDropdown.classList.remove('open');
});

/* ---------- Reports ---------- */
let lastReportsData = null;
async function loadReports() {
  try {
    const [{ data }, customerStats, bookingCard] = await Promise.all([
      axios.get(`${API_BASE}/api/admin/reports`, { headers: authHeaders() }),
      axios.get(`${API_BASE}/api/admin/customers/stats`, { headers: authHeaders() }).then(r => r.data).catch(() => ({})),
      axios.get(`${API_BASE}/api/admin/booking-management/dashboard-card`, { headers: authHeaders() }).then(r => r.data).catch(() => ({})),
    ]);
    lastReportsData = data;
    const statIcon = (variant, path) => `<div class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${path}</svg></div>`;
    const ICONS = {
      users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="m17 11 2 2 4-4"/>',
      booking: '<path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2Z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/>',
      revenue: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
      flight: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-1 .1-1.3.5l-.7.7 4.2 3-1.5 1.5-2.5-.5-.7.7 2 2 2 2 .7-.7-.5-2.5 1.5-1.5 3 4.2.7-.7c.4-.3.6-.8.5-1.3Z"/>',
      hotel: '<path d="M3 21V7a2 2 0 0 1 2-2h6v16"/><path d="M11 9h8a2 2 0 0 1 2 2v10"/><path d="M3 21h18"/>',
      cruise: '<path d="M2 21c1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0"/><path d="M4 18l1-9h14l1 9"/><path d="M10 9V4h4v5"/>',
      package: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
      check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/>',
      cancel: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
      mail: '<path d="m22 2-11 11"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
      contact: '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m3 6 9 7 9-7"/>',
      merchant: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/>',
    };
    const typeLabels = { gaming_company: 'Gaming', corporate_company: 'Corporate', travel_agency: 'Travel Agency', business_partner: 'Business Partner', unspecified: 'Unspecified' };
    const merchantBreakdown = Object.entries(data.merchants_by_type || {}).map(([k, v]) => `${typeLabels[k] || k}: ${v}`).join(' · ');
    document.getElementById('statGridRow1').innerHTML = `
      <div class="stat-card">${statIcon('coral', ICONS.merchant)}<div class="stat-body"><div class="num">${data.total_merchants}</div><div class="label">Total Merchants</div>${merchantBreakdown ? `<div class="stat-sub">${merchantBreakdown}</div>` : ''}</div></div>
      <div class="stat-card">${statIcon('', ICONS.users)}<div class="stat-body"><div class="num">${data.total_merchant_users}</div><div class="label">Total Users</div></div></div>
      <div class="stat-card">${statIcon('', ICONS.userCheck)}<div class="stat-body"><div class="num">${customerStats.total_customers ?? 0}</div><div class="label">Total Customers</div></div></div>
      <div class="stat-card">${statIcon('sky', ICONS.booking)}<div class="stat-body"><div class="num">${data.total_bookings}</div><div class="label">Total Bookings</div></div></div>
    `;
    document.getElementById('statGridRow2').innerHTML = `
      <div class="stat-card">${statIcon('gold', ICONS.clock)}<div class="stat-body"><div class="num gold">${data.pending_partner_requests}</div><div class="label">Pending Requests</div></div></div>
      <div class="stat-card">${statIcon('coral', ICONS.cancel)}<div class="stat-body"><div class="num coral">${data.active_cancellation_requests}</div><div class="label">Cancellation Requests</div></div></div>
      <div class="stat-card">${statIcon('emerald', ICONS.flight)}<div class="stat-body"><div class="num">${bookingCard.upcoming_trips ?? 0}</div><div class="label">Upcoming Departures</div></div></div>
    `;
    const types = Object.entries(data.bookings_by_type);
    renderBookingSourcesChart(types);

    loadActivityFeed();
    loadDashboardRecentBookings();
    loadMonthlyCharts();
  } catch (err) {
    document.getElementById('statGridRow1').innerHTML = `<div class="msg error">Failed to load reports.</div>`;
  }
}

/* ---------- Dashboard: Recent Bookings (premium preview) ----------
   Reuses the existing booking-management list/detail/action endpoints and the shared
   bookingReference/showAdminTicket/ACTIVITY_EMOJI helpers — no new backend, this only
   rebuilds the presentation layer. Deliberately decoupled from the Booking Management
   Center's own modal (openBookingDetail/handleBookingAction/bmModalOverlay) so this
   preview's side drawer never opens or interferes with that section's UI. */
const BM2_TRAVEL_ICON = {
  flight: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-1 .1-1.3.5l-.7.7 4.2 3-1.5 1.5-2.5-.5-.7.7 2 2 2 2 .7-.7-.5-2.5 1.5-1.5 3 4.2.7-.7c.4-.3.6-.8.5-1.3Z"/>',
  hotel: '<path d="M3 21V7a2 2 0 0 1 2-2h6v16"/><path d="M11 9h8a2 2 0 0 1 2 2v10"/><path d="M3 21h18"/>',
  cruise: '<path d="M2 21c1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0"/><path d="M4 18l1-9h14l1 9"/><path d="M10 9V4h4v5"/>',
  package: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/>',
};
function bm2Initials(name) {
  return (name || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
}
function bm2PaymentBadge(status) {
  if (status === 'success') return { cls: 'paid', label: 'Paid' };
  if (status === 'failed') return { cls: 'failed', label: 'Failed' };
  if (status === 'refunded') return { cls: 'refunded', label: 'Refunded' };
  return { cls: 'pending', label: 'Pending' };
}
function bm2StatusBadge(status, travelDate) {
  if (status === 'confirmed' && travelDate && new Date(travelDate) > new Date()) return { cls: 'upcoming', label: 'Upcoming' };
  return { cls: status, label: status.charAt(0).toUpperCase() + status.slice(1) };
}

async function loadDashboardRecentBookings() {
  const body = document.getElementById('dashBookingsBody');
  if (!body) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/bookings`, { headers: authHeaders(), params: { page: 1, page_size: 10, sort: 'newest' } });
    renderDashboardBookingsTable(data.items);
  } catch (err) {
    body.innerHTML = `<div class="bm2-empty"><div class="bm2-empty-title">Failed to load bookings.</div></div>`;
  }
}

function renderDashboardBookingsTable(items) {
  const body = document.getElementById('dashBookingsBody');
  if (!items.length) {
    body.innerHTML = `
      <div class="bm2-empty">
        <svg class="icon" viewBox="0 0 24 24" style="margin:0 auto;"><rect x="3" y="7" width="18" height="14" rx="2.5"/><path d="M8 3v6M16 3v6M3 11h18"/></svg>
        <div class="bm2-empty-title">No bookings found</div>
        <button type="button" class="btn btn-navy btn-sm" id="dashBookingsEmptyViewAll">View all bookings</button>
      </div>`;
    document.getElementById('dashBookingsEmptyViewAll')?.addEventListener('click', () => navigateToSection('booking-management'));
    return;
  }
  body.innerHTML = items.map(b => {
    const payBadge = bm2PaymentBadge(b.payment_status);
    const statusBadge = bm2StatusBadge(b.booking_status, b.travel_date);
    const canCancel = !['cancelled', 'completed'].includes(b.booking_status);
    const canRefund = b.payment_status === 'success';
    return `
    <div class="bm2-row bm2-body-row" data-booking-row="${b.id}">
      <div class="bm2-check"><input type="checkbox" class="bm2-row-check" aria-label="Select booking #${b.id}"></div>
      <div>
        <div class="bm2-id">#${b.id}</div>
        <div class="bm2-id-sub">${bookingReference(b.id)}</div>
      </div>
      <div class="bm2-cust">
        <div class="bm2-avatar">${bm2Initials(b.customer_name)}</div>
        <div class="bm2-cust-info">
          <div class="bm2-cust-name">${escapeHtml(b.customer_name)}</div>
          <div class="bm2-cust-meta">${escapeHtml(b.customer_email)}</div>
        </div>
      </div>
      <div class="bm2-travel">
        <div class="bm2-travel-icon ${b.booking_type}"><svg class="icon" viewBox="0 0 24 24">${BM2_TRAVEL_ICON[b.booking_type] || ''}</svg></div>
        <div class="bm2-travel-info">
          <div class="bm2-travel-type">${escapeHtml(b.booking_type)}</div>
          <div class="bm2-travel-route" title="${escapeHtml(b.destination)}">${escapeHtml(b.destination)}</div>
        </div>
      </div>
      <div class="bm2-amount">${money(b.total_amount)}</div>
      <div><span class="bm2-badge ${payBadge.cls}">${payBadge.label}</span></div>
      <div><span class="bm2-badge ${statusBadge.cls}">${statusBadge.label}</span></div>
      <div class="bm2-date">${b.travel_date ? fmtDate(b.travel_date) : '—'}</div>
      <div class="bm2-actions">
        <button type="button" class="bm2-icon-btn" data-row-view="${b.id}" title="View details" aria-label="View details">
          <svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <div class="bm2-more-wrap">
          <button type="button" class="bm2-icon-btn" data-row-more="${b.id}" title="More actions" aria-label="More actions">
            <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
          </button>
          <div class="bm2-more-menu" data-more-menu="${b.id}">
            <button type="button" class="bm2-more-item" data-row-act="view" data-id="${b.id}"><svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg> View Details</button>
            <button type="button" class="bm2-more-item" data-row-act="ticket" data-id="${b.id}"><svg class="icon" viewBox="0 0 24 24"><path d="M12 3v13"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg> Download Ticket</button>
            <button type="button" class="bm2-more-item" data-row-act="print" data-id="${b.id}"><svg class="icon" viewBox="0 0 24 24"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M6 17v4h12v-4"/></svg> Print Ticket</button>
            ${canRefund ? `<div class="bm2-more-divider"></div><button type="button" class="bm2-more-item" data-row-act="refund" data-id="${b.id}"><svg class="icon" viewBox="0 0 24 24"><path d="M3 10h18M7 15h4"/><rect x="3" y="5" width="18" height="14" rx="2"/></svg> Refund</button>` : ''}
            ${canCancel ? `<button type="button" class="bm2-more-item danger" data-row-act="cancel" data-id="${b.id}"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg> Cancel Booking</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
  wireDashboardBookingsRows();
}

function wireDashboardBookingsRows() {
  const body = document.getElementById('dashBookingsBody');
  body.querySelectorAll('[data-booking-row]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.bm2-check, .bm2-actions')) return;
      openBookingDrawer(row.dataset.bookingRow);
    });
  });
  body.querySelectorAll('[data-row-view]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openBookingDrawer(btn.dataset.rowView); });
  });
  body.querySelectorAll('[data-row-more]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const menu = body.querySelector(`[data-more-menu="${btn.dataset.rowMore}"]`);
      const wasOpen = menu.classList.contains('open');
      body.querySelectorAll('.bm2-more-menu.open').forEach(m => m.classList.remove('open'));
      if (!wasOpen) menu.classList.add('open');
    });
  });
  body.querySelectorAll('[data-row-act]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      body.querySelectorAll('.bm2-more-menu.open').forEach(m => m.classList.remove('open'));
      const action = btn.dataset.rowAct, id = btn.dataset.id;
      if (action === 'view') openBookingDrawer(id);
      else openBookingDrawer(id, action);
    });
  });
  const selectAll = document.getElementById('dashBookingsSelectAll');
  if (selectAll) {
    selectAll.checked = false;
    selectAll.onchange = () => {
      body.querySelectorAll('.bm2-row-check').forEach(cb => {
        cb.checked = selectAll.checked;
        cb.closest('.bm2-body-row').classList.toggle('bm2-selected', selectAll.checked);
      });
    };
  }
  body.querySelectorAll('.bm2-row-check').forEach(cb => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => cb.closest('.bm2-body-row').classList.toggle('bm2-selected', cb.checked));
  });
}
document.addEventListener('click', e => {
  if (!e.target.closest('.bm2-more-wrap')) document.querySelectorAll('.bm2-more-menu.open').forEach(m => m.classList.remove('open'));
});
document.getElementById('dashBookingsRefreshBtn')?.addEventListener('click', () => loadDashboardRecentBookings());
document.getElementById('dashBookingsViewAllBtn')?.addEventListener('click', () => navigateToSection('booking-management'));

/* ---------- Booking drawer (dedicated to this preview — does not touch bmModalOverlay) ---------- */
const bookingDrawerOverlay = document.getElementById('bookingDrawerOverlay');
let drawerBookingData = null;

async function openBookingDrawer(id, pendingAction) {
  bookingDrawerOverlay.classList.add('open');
  document.getElementById('drawerTitle').textContent = `Booking #${id}`;
  document.getElementById('drawerSubtitle').textContent = 'Loading…';
  document.getElementById('drawerBody').innerHTML = rowsSkeleton(6);
  document.getElementById('drawerFooter').innerHTML = '';
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/bookings/${id}`, { headers: authHeaders() });
    drawerBookingData = data;
    renderBookingDrawer(data);
    if (pendingAction) await handleDrawerAction(pendingAction);
  } catch (err) {
    document.getElementById('drawerSubtitle').textContent = 'Failed to load booking.';
    document.getElementById('drawerBody').innerHTML = `<div class="bm2-empty"><div class="bm2-empty-title">Could not load this booking.</div></div>`;
  }
}
function closeBookingDrawer() { bookingDrawerOverlay.classList.remove('open'); }
document.getElementById('drawerCloseBtn').addEventListener('click', closeBookingDrawer);
bookingDrawerOverlay.addEventListener('click', e => { if (e.target === bookingDrawerOverlay) closeBookingDrawer(); });

function renderBookingDrawer(b) {
  const payBadge = bm2PaymentBadge(b.payments?.[0]?.status);
  const statusBadge = bm2StatusBadge(b.status, b.travel_date);
  document.getElementById('drawerTitle').textContent = `Booking #${b.id}`;
  document.getElementById('drawerSubtitle').textContent = b.destination;

  document.getElementById('drawerBody').innerHTML = `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
      <span class="bm2-badge ${statusBadge.cls}">${statusBadge.label}</span>
      <span class="bm2-badge ${payBadge.cls}">${payBadge.label}</span>
    </div>

    <div class="drawer-section-title">Passenger</div>
    <div class="info-grid">
      <div class="info-item"><label>Name</label><div>${escapeHtml(b.customer.full_name)}</div></div>
      <div class="info-item"><label>Email</label><div>${escapeHtml(b.customer.email)}</div></div>
      <div class="info-item"><label>Phone</label><div>${b.customer.mobile ? escapeHtml(b.customer.mobile) : '—'}</div></div>
      <div class="info-item"><label>Travelers</label><div>${b.quantity}</div></div>
    </div>

    <div class="drawer-section-title">Trip</div>
    <div class="info-grid">
      <div class="info-item"><label>Destination</label><div>${escapeHtml(b.destination)}</div></div>
      <div class="info-item"><label>Travel Type</label><div style="text-transform:capitalize;">${escapeHtml(b.booking_type)}</div></div>
      <div class="info-item"><label>Travel Date</label><div>${b.travel_date ? fmtDate(b.travel_date) : '—'}</div></div>
      <div class="info-item"><label>PNR / Reference</label><div>${bookingReference(b.id)}</div></div>
    </div>

    <div class="drawer-section-title">Payment</div>
    ${b.payments?.length ? `<div class="table-wrap"><table><thead><tr><th>Ref</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead><tbody>${
      b.payments.map(p => `<tr><td>${escapeHtml(p.transaction_ref)}</td><td>${money(p.amount)}</td><td style="text-transform:capitalize">${escapeHtml(p.method)}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td></tr>`).join('')
    }</tbody></table></div>` : `<div class="empty-state">No payment recorded.</div>`}
    <div class="info-grid" style="margin-top:12px;">
      <div class="info-item"><label>Total Amount</label><div>${money(b.total_price)}</div></div>
      <div class="info-item"><label>Booked On</label><div>${fmtDateTime(b.created_at)}</div></div>
    </div>

    <div class="drawer-section-title">Timeline</div>
    ${b.timeline?.length ? `<div class="timeline">${b.timeline.map(t => `
      <div class="timeline-item">
        <span class="timeline-dot"></span>
        <div class="timeline-body">
          <div class="timeline-text">${ACTIVITY_EMOJI[t.activity_type] || '📌'} ${escapeHtml(t.description || t.activity_type || 'Activity')}</div>
          <div class="timeline-time">${fmtDateTime(t.created_at)} · ${escapeHtml(t.actor)}</div>
        </div>
      </div>`).join('')}</div>` : `<div class="empty-state">No timeline events recorded yet.</div>`}
  `;

  const refundablePayment = b.payments?.find(p => p.status === 'success');
  const canCancel = !['cancelled', 'completed'].includes(b.status);
  const footerBtns = [
    `<button type="button" class="btn btn-ghost btn-sm" data-drawer-act="invoice">Invoice</button>`,
    `<button type="button" class="btn btn-ghost btn-sm" data-drawer-act="ticket">Download Ticket</button>`,
    `<button type="button" class="btn btn-ghost btn-sm" data-drawer-act="print">Print</button>`,
  ];
  if (refundablePayment) footerBtns.push(`<button type="button" class="btn btn-danger btn-sm" data-drawer-act="refund" data-payment-id="${refundablePayment.id}">Refund</button>`);
  if (canCancel) footerBtns.push(`<button type="button" class="btn btn-danger btn-sm" data-drawer-act="cancel">Cancel Booking</button>`);
  document.getElementById('drawerFooter').innerHTML = footerBtns.join('');
  document.getElementById('drawerFooter').querySelectorAll('[data-drawer-act]').forEach(btn => {
    btn.addEventListener('click', () => handleDrawerAction(btn.dataset.drawerAct, btn.dataset));
  });
}

async function handleDrawerAction(action, dataset = {}) {
  const b = drawerBookingData;
  if (!b) return;
  try {
    if (action === 'invoice') {
      const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/bookings/${b.id}/invoice`, { headers: authHeaders(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `invoice-booking-${b.id}.csv`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (action === 'ticket') return showAdminTicket(b);
    if (action === 'print') {
      bookingDrawerOverlay.classList.add('print-target');
      window.print();
      setTimeout(() => bookingDrawerOverlay.classList.remove('print-target'), 500);
      return;
    }
    if (action === 'refund') {
      const paymentId = dataset.paymentId || b.payments?.find(p => p.status === 'success')?.id;
      if (!paymentId) return;
      if (!confirm('Refund this payment? This cancels the booking and restores inventory.')) return;
      await axios.post(`${API_BASE}/api/admin/payment-management/payments/${paymentId}/refund`, {}, { headers: authHeaders() });
      loadPaymentManagement(pmPage);
      if (loadedSections.has('refunds')) loadRefunds(rfPage);
    }
    if (action === 'cancel') {
      if (!confirm('Cancel this booking? This restores inventory and refunds the payment.')) return;
      await axios.post(`${API_BASE}/api/admin/booking-management/bookings/${b.id}/cancel`, {}, { headers: authHeaders() });
    }
    const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/bookings/${b.id}`, { headers: authHeaders() });
    drawerBookingData = data;
    renderBookingDrawer(data);
    loadDashboardRecentBookings();
    loadBookingManagement(bmPage);
  } catch (err) {
    alert(err.response?.data?.detail || 'Action failed.');
  }
}

function renderTopList(elId, items) {
  const el = document.getElementById(elId);
  el.innerHTML = (items && items.length)
    ? `<div class="top-list">${items.map(i => `
        <div class="top-list-row">
          <span class="top-list-name">${escapeHtml(i.name)}</span>
          <span class="top-list-meta">${i.bookings} booking${i.bookings === 1 ? '' : 's'} · ${money(i.revenue)}</span>
        </div>`).join('')}</div>`
    : `<div class="empty-state">No bookings yet.</div>`;
}

/* ---------- Recent activity feed (live) ---------- */
const ACTIVITY_EMOJI = {
  Registration: '🆕', Login: '🔐', Logout: '🚪', 'Profile Update': '✏️', 'Password Change': '🔑',
  'Booking Created': '🧳', 'Booking Cancelled': '❌', 'Payment Completed': '💳', 'Payment Refunded': '↩️',
  'Wishlist Added': '❤️', 'Wishlist Removed': '💔', 'Review Submitted': '⭐', 'Support Ticket Created': '🎫',
  'Notification Read': '🔔', Search: '🔍', 'Admin Action': '🛠️',
};
async function loadActivityFeed() {
  const el = document.getElementById('activityFeed');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/activity-logs/recent`, { headers: authHeaders(), params: { limit: 20 } });
    el.innerHTML = data.length
      ? data.map(a => `
          <div class="live-feed-item">
            <span class="live-feed-emoji">${ACTIVITY_EMOJI[a.activity_type] || '📌'}</span>
            <div class="live-feed-body">
              <div class="live-feed-text">${escapeHtml(a.description || a.action)}</div>
              <div class="live-feed-time">${a.user_email ? escapeHtml(a.user_email) + ' · ' : ''}${new Date(a.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            </div>
          </div>`).join('')
      : `<div class="empty-state">No activity yet.</div>`;
  } catch (err) { /* feed just won't refresh this cycle */ }
}

/* ---------- Online users (live) ---------- */
/* Live activity feed on the Dashboard section auto-refreshes every 15s while it's the visible section */
setInterval(() => {
  if (document.getElementById('section-reports').classList.contains('active')) {
    loadActivityFeed();
  }
}, 15000);

/* ---------- Monthly charts ---------- */
let revenueChartInstance, bookingsChartInstance, bookingSourcesChartInstance;
/* Booking Sources pie chart — reuses the same bookings_by_type data already fetched for the
   Booking Distribution card in loadReports(), no extra API call. */
function renderBookingSourcesChart(typeEntries) {
  const canvas = document.getElementById('bookingSourcesChart');
  if (!canvas) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const palette = ['#0A2540', '#FF4D4D', '#FFB020', '#12B76A', '#2F80ED', '#8A5CF6'];
  bookingSourcesChartInstance?.destroy();
  if (!typeEntries.length) return;
  bookingSourcesChartInstance = new Chart(canvas, {
    type: 'pie',
    data: {
      labels: typeEntries.map(([type]) => type.charAt(0).toUpperCase() + type.slice(1)),
      datasets: [{ data: typeEntries.map(([, count]) => count), backgroundColor: palette, borderColor: isDark ? '#131B2E' : '#fff', borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: isDark ? '#93A2BE' : '#5B6B82', padding: 14, usePointStyle: true } } },
    },
  });
}
async function loadMonthlyCharts() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/reports/monthly`, { headers: authHeaders() });
    const labels = data.map(m => m.month);
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const chartColors = {
      navy: isDark ? '#5B8DEF' : '#0A2540', coral: '#FF4D4D',
      line: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(10,37,64,0.08)',
      tick: isDark ? '#93A2BE' : '#5B6B82',
    };

    bookingsChartInstance?.destroy();
    bookingsChartInstance = new Chart(document.getElementById('bookingsChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Bookings', data: data.map(m => m.bookings),
          borderColor: chartColors.coral, backgroundColor: 'rgba(255,77,77,0.12)',
          tension: 0.3, fill: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0, color: chartColors.tick }, grid: { color: chartColors.line } },
          x: { grid: { display: false }, ticks: { color: chartColors.tick } },
        },
      },
    });

    revenueChartInstance?.destroy();
    revenueChartInstance = new Chart(document.getElementById('revenueChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Revenue (₹)', data: data.map(m => m.revenue), backgroundColor: chartColors.navy, borderRadius: 6 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: chartColors.line }, ticks: { color: chartColors.tick } },
          x: { grid: { display: false }, ticks: { color: chartColors.tick } },
        },
      },
    });
  } catch (err) { /* charts just won't render */ }
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-export]');
  if (!btn) return;
  const kind = btn.dataset.export;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/reports/export/${kind}`, { headers: authHeaders(), responseType: 'blob' });
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) { alert('Failed to export CSV.'); }
});

/* ---------- Merchant Management ---------- */
const COMPANY_TYPE_LABELS = { gaming_company: 'Gaming Company', corporate_company: 'Corporate Company', travel_agency: 'Travel Agency', business_partner: 'Business Partner' };
const ROLE_TYPE_LABELS = { admin: 'Admin', user: 'User', maker: 'Maker', checker: 'Checker' };
const MEMBER_ROLE_LABELS = { admin: 'Admin', user: 'User', data_operator: 'Data Operator', request_ticket: 'Request Ticket', cancellation_ticket: 'Cancellation Ticket', supervisor: 'Supervisor', manager: 'Manager' };
const ROLE_TYPE_MEMBER_ROLES = { admin: ['admin'], user: ['user'], maker: ['data_operator', 'request_ticket', 'cancellation_ticket'], checker: ['supervisor', 'manager'] };

let merchantsPage = 1;
let merchantSearchTimer = null;
const merchantSelectedIds = new Set();

function updateMerchantBulkBar() {
  const bar = document.getElementById('merchantBulkBar');
  const count = merchantSelectedIds.size;
  document.getElementById('merchantBulkCount').textContent = `${count} selected`;
  bar.classList.toggle('open', count > 0);
}

async function loadMerchants(page = merchantsPage) {
  merchantsPage = page;
  merchantSelectedIds.clear();
  updateMerchantBulkBar();
  showMerchantView('list');
  document.getElementById('merchantDetailPanel').innerHTML = '';
  const tbody = document.querySelector('#merchantsTable tbody');
  tbody.innerHTML = `<tr><td colspan="10" class="empty-state">Loading…</td></tr>`;
  const search = document.getElementById('merchantSearch').value;
  const status = document.getElementById('merchantStatusFilter').value;
  const dateFrom = document.getElementById('merchantDateFrom').value;
  const dateTo = document.getElementById('merchantDateTo').value;
  const sort = document.getElementById('merchantSort').value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/merchants`, {
      headers: authHeaders(),
      params: {
        search: search || undefined, status: status || undefined,
        date_from: dateFrom || undefined, date_to: dateTo || undefined,
        sort, page, page_size: PAGE_SIZE,
      },
    });
    renderPagination('merchantsPagination', data.page, data.total_pages, data.total, loadMerchants);
    document.getElementById('merchantSelectAll').checked = false;
    tbody.innerHTML = data.items.map(m => `
      <tr>
        <td class="mm-checkbox-col"><input type="checkbox" class="mm-row-check" data-select-merchant="${m.partner_id}" ${merchantSelectedIds.has(m.partner_id) ? 'checked' : ''}></td>
        <td>MRC-${m.partner_id}</td>
        <td>${escapeHtml(m.company_name)}</td>
        <td>${escapeHtml(COMPANY_TYPE_LABELS[m.company_type] || '—')}</td>
        <td>${escapeHtml(m.contact_person || '—')}</td>
        <td>${escapeHtml(m.email)}</td>
        <td>${escapeHtml(m.phone_number || '—')}</td>
        <td><span class="badge ${m.status === 'active' ? 'active' : 'inactive'}">${m.status === 'active' ? 'Active' : 'Inactive'}</span></td>
        <td>${fmtDate(m.created_at)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-view-merchant="${m.partner_id}">View</button>
          <button class="btn btn-ghost btn-sm" data-edit-merchant="${m.partner_id}">Edit</button>
          <button class="btn btn-sm ${m.status === 'active' ? 'btn-danger' : 'btn-navy'}" data-toggle-merchant="${m.partner_id}" data-next="${m.status === 'active' ? 'inactive' : 'active'}">${m.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-danger btn-sm" data-delete-merchant="${m.partner_id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="10" class="empty-state">No merchants found.</td></tr>`;
    tbody.querySelectorAll('[data-select-merchant]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.selectMerchant);
        if (cb.checked) merchantSelectedIds.add(id); else merchantSelectedIds.delete(id);
        updateMerchantBulkBar();
      });
    });
    tbody.querySelectorAll('[data-view-merchant]').forEach(btn => btn.addEventListener('click', () => openMerchantDetail(btn.dataset.viewMerchant)));
    tbody.querySelectorAll('[data-edit-merchant]').forEach(btn => btn.addEventListener('click', () => openOnboardMerchantModal(btn.dataset.editMerchant)));
    tbody.querySelectorAll('[data-toggle-merchant]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.post(`${API_BASE}/api/admin/merchants/${btn.dataset.toggleMerchant}/${btn.dataset.next === 'active' ? 'activate' : 'deactivate'}`, {}, { headers: authHeaders() });
          loadMerchants();
        } catch (err) { alert(err.response?.data?.detail || 'Failed to update merchant.'); }
      });
    });
    tbody.querySelectorAll('[data-delete-merchant]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this merchant? This cannot be undone.')) return;
        try {
          await axios.delete(`${API_BASE}/api/admin/merchants/${btn.dataset.deleteMerchant}`, { headers: authHeaders() });
          loadMerchants(1);
        } catch (err) { alert(err.response?.data?.detail || 'Failed to delete merchant.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">Failed to load merchants.</td></tr>`;
  }
}
document.getElementById('onboardMerchantBtn').addEventListener('click', () => openOnboardMerchantModal(null));
document.getElementById('topCreateMerchantUserBtn').addEventListener('click', () => openCreateMerchantUserPage(null, null));
document.getElementById('merchantsRefreshBtn').addEventListener('click', () => loadMerchants(merchantsPage));
document.getElementById('merchantSearch').addEventListener('input', () => {
  clearTimeout(merchantSearchTimer);
  merchantSearchTimer = setTimeout(() => loadMerchants(1), 350);
});
document.getElementById('merchantStatusFilter').addEventListener('change', () => loadMerchants(1));
document.getElementById('merchantDateFrom').addEventListener('change', () => loadMerchants(1));
document.getElementById('merchantDateTo').addEventListener('change', () => loadMerchants(1));
document.getElementById('merchantSort').addEventListener('change', () => loadMerchants(1));
document.getElementById('merchantSelectAll').addEventListener('change', e => {
  document.querySelectorAll('#merchantsTable [data-select-merchant]').forEach(cb => {
    cb.checked = e.target.checked;
    const id = Number(cb.dataset.selectMerchant);
    if (e.target.checked) merchantSelectedIds.add(id); else merchantSelectedIds.delete(id);
  });
  updateMerchantBulkBar();
});
document.getElementById('merchantBulkClearBtn').addEventListener('click', () => loadMerchants(merchantsPage));
async function merchantBulkSetStatus(action) {
  const ids = [...merchantSelectedIds];
  if (!ids.length) return;
  try {
    await Promise.all(ids.map(id => axios.post(`${API_BASE}/api/admin/merchants/${id}/${action}`, {}, { headers: authHeaders() })));
  } catch (err) { alert('Some merchants could not be updated.'); }
  loadMerchants(merchantsPage);
}
document.getElementById('merchantBulkActivateBtn').addEventListener('click', () => merchantBulkSetStatus('activate'));
document.getElementById('merchantBulkDeactivateBtn').addEventListener('click', () => merchantBulkSetStatus('deactivate'));

/* ---------- Onboard / Edit Merchant modal ---------- */
async function openOnboardMerchantModal(partnerId) {
  const overlay = document.getElementById('onboardMerchantModalOverlay');
  const body = document.getElementById('onboardMerchantModalBody');
  let m = null;
  if (partnerId) {
    try { m = (await axios.get(`${API_BASE}/api/admin/merchants/${partnerId}`, { headers: authHeaders() })).data; }
    catch (err) { alert('Failed to load merchant.'); return; }
  }
  const v = (field, fallback = '') => m ? (m[field] ?? fallback) : fallback;
  body.innerHTML = `
    <h2>${m ? 'Edit Merchant' : 'Onboard Merchant'}</h2>
    <form id="onboardMerchantForm">
      <div class="form-grid">
        <div class="form-field"><label>Merchant Name</label><input name="company_name" required value="${escapeHtml(v('company_name'))}"></div>
        <div class="form-field"><label>Company Type</label>
          <select name="company_type" required>
            ${Object.entries(COMPANY_TYPE_LABELS).map(([val, label]) => `<option value="${val}" ${v('company_type') === val ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <div class="form-field"><label>Contact Person</label><input name="contact_person" required value="${escapeHtml(v('contact_person'))}"></div>
        <div class="form-field"><label>Email</label><input name="email" type="email" required value="${escapeHtml(v('email'))}"></div>
        <div class="form-field"><label>Phone Number</label><input name="phone_number" required value="${escapeHtml(v('phone_number'))}"></div>
        <div class="form-field"><label>Address</label><input name="address" value="${escapeHtml(v('address'))}"></div>
        <div class="form-field"><label>City</label><input name="city" value="${escapeHtml(v('city'))}"></div>
        <div class="form-field"><label>State</label><input name="state" value="${escapeHtml(v('state'))}"></div>
        <div class="form-field"><label>Country</label><input name="country" value="${escapeHtml(v('country'))}"></div>
        <div class="form-field"><label>GST Number (optional)</label><input name="gst_number" value="${escapeHtml(v('gst_number'))}"></div>
        <div class="form-field"><label>PAN Number (optional)</label><input name="pan_number" value="${escapeHtml(v('pan_number'))}"></div>
        ${m ? '' : `<div class="form-field"><label>Status</label><select name="status"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>`}
      </div>
      <div class="msg" id="onboardMerchantMsg"></div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-coral">${m ? 'Save Changes' : 'Save Merchant'}</button>
        <button type="button" class="btn btn-ghost" id="onboardMerchantCancelBtn">Cancel</button>
      </div>
    </form>
  `;
  overlay.classList.add('open');
  document.getElementById('onboardMerchantCancelBtn').addEventListener('click', () => overlay.classList.remove('open'));
  document.getElementById('onboardMerchantForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const msg = document.getElementById('onboardMerchantMsg');
    const payload = {
      company_name: f.company_name.value, company_type: f.company_type.value, contact_person: f.contact_person.value,
      email: f.email.value, phone_number: f.phone_number.value, address: f.address.value || null,
      city: f.city.value || null, state: f.state.value || null, country: f.country.value || null,
      gst_number: f.gst_number.value || null, pan_number: f.pan_number.value || null,
    };
    if (!m) payload.status = f.status.value;
    try {
      if (m) await axios.patch(`${API_BASE}/api/admin/merchants/${partnerId}`, payload, { headers: authHeaders() });
      else await axios.post(`${API_BASE}/api/admin/merchants`, payload, { headers: authHeaders() });
      overlay.classList.remove('open');
      loadMerchants();
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to save merchant.';
      msg.className = 'msg error';
    }
  });
}

/* ---------- Merchant Details ---------- */
async function openMerchantDetail(partnerId) {
  const detailPanel = document.getElementById('merchantDetailPanel');
  showMerchantView('detail');
  detailPanel.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  try {
    const { data: m } = await axios.get(`${API_BASE}/api/admin/merchants/${partnerId}`, { headers: authHeaders() });
    detailPanel.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h2>${escapeHtml(m.company_name)}</h2>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-coral btn-sm" id="createMerchantUserBtn">+ Create User</button>
            <button class="btn btn-ghost btn-sm" id="backToMerchantsBtn">← Back to Merchants</button>
          </div>
        </div>
        <div class="info-grid">
          <div class="info-item"><label>Merchant ID</label><div>MRC-${m.partner_id}</div></div>
          <div class="info-item"><label>Merchant Name</label><div>${escapeHtml(m.company_name)}</div></div>
          <div class="info-item"><label>Company Type</label><div>${escapeHtml(COMPANY_TYPE_LABELS[m.company_type] || '—')}</div></div>
          <div class="info-item"><label>Contact Person</label><div>${escapeHtml(m.contact_person || '—')}</div></div>
          <div class="info-item"><label>Email</label><div>${escapeHtml(m.email)}</div></div>
          <div class="info-item"><label>Phone</label><div>${escapeHtml(m.phone_number || '—')}</div></div>
          <div class="info-item"><label>Status</label><div><span class="badge ${m.status === 'active' ? 'active' : 'inactive'}">${m.status === 'active' ? 'Active' : 'Inactive'}</span></div></div>
          <div class="info-item"><label>Created Date</label><div>${fmtDate(m.created_at)}</div></div>
          <div class="info-item"><label>Number of Users</label><div>${m.user_count}</div></div>
          <div class="info-item"><label>Number of Bookings</label><div>${m.booking_count}</div></div>
          <div class="info-item"><label>Number of Requests</label><div>${m.request_count}</div></div>
        </div>
      </div>
      <div class="panel">
        <h2 style="font-size:14px;margin-bottom:10px;">Users</h2>
        <div class="table-wrap"><table id="merchantUsersTable"><thead><tr>
          <th>User ID</th><th>Full Name</th><th>Username</th><th>Email</th><th>Phone</th><th>Role Type</th><th>Member Role</th><th>Status</th><th>Actions</th>
        </tr></thead><tbody></tbody></table></div>
      </div>
    `;
    document.getElementById('backToMerchantsBtn').addEventListener('click', loadMerchants);
    document.getElementById('createMerchantUserBtn').addEventListener('click', () => openCreateMerchantUserPage(partnerId, m.company_name));
    loadMerchantUsersTable(partnerId);
  } catch (err) {
    detailPanel.innerHTML = `<div class="panel"><div class="empty-state">Failed to load merchant.</div></div>`;
  }
}

async function loadMerchantUsersTable(partnerId) {
  const tbody = document.querySelector('#merchantUsersTable tbody');
  tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Loading…</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/merchants/${partnerId}/users`, { headers: authHeaders() });
    tbody.innerHTML = data.map(u => `
      <tr>
        <td>USR-${u.partner_user_id}</td>
        <td>${escapeHtml(u.full_name)}</td>
        <td>${escapeHtml(u.username || '—')}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.phone_number || '—')}</td>
        <td>${escapeHtml(ROLE_TYPE_LABELS[u.role_type] || '—')}</td>
        <td>${escapeHtml(MEMBER_ROLE_LABELS[u.member_role] || '—')}</td>
        <td><span class="badge ${u.status === 'active' ? 'active' : 'inactive'}">${u.status === 'active' ? 'Active' : 'Inactive'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-view-mu="${u.partner_user_id}">View</button>
          <button class="btn btn-sm ${u.status === 'active' ? 'btn-danger' : 'btn-navy'}" data-toggle-mu="${u.partner_user_id}" data-next="${u.status === 'active' ? 'inactive' : 'active'}">${u.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-ghost btn-sm" data-reset-mu="${u.partner_user_id}">Reset Password</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="9" class="empty-state">No users yet for this merchant.</td></tr>`;
    tbody.querySelectorAll('[data-view-mu]').forEach(btn => btn.addEventListener('click', () => {
      const u = data.find(x => String(x.partner_user_id) === btn.dataset.viewMu);
      alert(`${u.full_name}\nUsername: ${u.username || '—'}\nEmail: ${u.email}\nPhone: ${u.phone_number || '—'}\nRole Type: ${ROLE_TYPE_LABELS[u.role_type] || '—'}\nMember Role: ${MEMBER_ROLE_LABELS[u.member_role] || '—'}\nStatus: ${u.status}`);
    }));
    tbody.querySelectorAll('[data-toggle-mu]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.post(`${API_BASE}/api/admin/merchants/users/${btn.dataset.toggleMu}/${btn.dataset.next === 'active' ? 'activate' : 'deactivate'}`, {}, { headers: authHeaders() });
          loadMerchantUsersTable(partnerId);
        } catch (err) { alert('Failed to update user.'); }
      });
    });
    tbody.querySelectorAll('[data-reset-mu]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Reset this user\'s password?')) return;
        try {
          const { data: r } = await axios.post(`${API_BASE}/api/admin/merchants/users/${btn.dataset.resetMu}/reset-password`, {}, { headers: authHeaders() });
          alert(`New password: ${r.new_password}\n\nShare this with the merchant user securely.`);
        } catch (err) { alert('Failed to reset password.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load users.</td></tr>`;
  }
}

/* ---------- Create Merchant User -- dedicated full page ----------
   This is NOT a modal/dialog/popup. It is a third view inside
   #section-users (alongside the merchant list and merchant detail views),
   shown by hiding the other two and rendering full-page content into
   #merchantCreateUserPanel -- the same "swap the visible panel" mechanism
   openMerchantDetail() already uses to move from the list to a merchant's
   detail view. showMerchantView() below is the single place that decides
   which of the three is visible.

   Called two ways:
   - From Merchant Detail's own "+ Create User" button: partnerId + merchantName
     are already known, so the Merchant field is shown as read-only text
     (unchanged behavior) and "Back"/"Cancel" return to that merchant's detail view.
   - From Merchant Management's top-level "+ Create User" button: partnerId is
     null, so a Merchant dropdown is shown instead, populated from the same
     /api/admin/merchants endpoint the list page uses. "Back"/"Cancel" return
     to the merchant list. */
function showMerchantView(view) {
  document.getElementById('merchantBreadcrumb').innerHTML = view === 'create-user'
    ? 'Admin Portal / <a href="#" id="mmBreadcrumbBackLink">Merchant Management</a> / <span>Create User</span>'
    : 'Admin Portal / <span>Merchant Management</span>';
  document.getElementById('merchantListPanel').style.display = view === 'list' ? '' : 'none';
  document.getElementById('merchantDetailPanel').style.display = view === 'detail' ? '' : 'none';
  document.getElementById('merchantCreateUserPanel').style.display = view === 'create-user' ? '' : 'none';
  document.getElementById('mmBreadcrumbBackLink')?.addEventListener('click', e => { e.preventDefault(); loadMerchants(merchantsPage); });
}

async function openCreateMerchantUserPage(partnerId, merchantName) {
  const panel = document.getElementById('merchantCreateUserPanel');
  const goBack = () => partnerId ? openMerchantDetail(partnerId) : loadMerchants(merchantsPage);

  let merchantOptions = [];
  if (!partnerId) {
    panel.innerHTML = `<div class="panel"><div class="empty-state">Loading merchants…</div></div>`;
    showMerchantView('create-user');
    try {
      const { data } = await axios.get(`${API_BASE}/api/admin/merchants`, {
        headers: authHeaders(), params: { status: 'active', sort: 'name_asc', page: 1, page_size: 100 },
      });
      merchantOptions = data.items;
    } catch (err) {
      panel.innerHTML = `<div class="panel"><div class="msg error">Failed to load merchants.</div></div>`;
      return;
    }
    if (!merchantOptions.length) {
      panel.innerHTML = `<div class="panel"><div class="empty-state">No active merchants to assign a user to. Onboard a merchant first.</div></div>`;
      return;
    }
  } else {
    showMerchantView('create-user');
  }

  const merchantFieldHtml = partnerId
    ? `<div class="form-field"><label>Merchant Name</label><input value="${escapeHtml(merchantName)}" disabled></div>`
    : `<div class="form-field"><label>Merchant<span class="mm-required">*</span></label>
        <select name="partner_id" id="cmuPartnerId" required>
          ${merchantOptions.map(m => `<option value="${m.partner_id}">${escapeHtml(m.company_name)} (MRC-${m.partner_id})</option>`).join('')}
        </select>
        <div class="field-error"></div>
      </div>`;

  panel.innerHTML = `
    <div class="mm-page-head">
      <div class="mm-page-head-left">
        <button type="button" class="mm-back-btn" id="cmuBackBtn" aria-label="Back to Merchant Management">
          <svg class="icon" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div>
          <div class="mm-page-title">Create Merchant User</div>
          <div class="mm-page-sub">${partnerId ? `Adding a user under ${escapeHtml(merchantName)}` : 'Add a new login for one of your onboarded merchants'}</div>
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="cmuCancelTopBtn">Cancel</button>
    </div>

    <form id="createMerchantUserForm" novalidate>
      <div class="panel mm-form-section">
        <h3>Merchant Information</h3>
        <div class="mm-section-sub">Which merchant this login belongs to.</div>
        <div class="form-grid">
          ${merchantFieldHtml}
          <div class="form-field"><label>User ID</label><input value="Auto-generated on save" disabled></div>
        </div>
      </div>

      <div class="panel mm-form-section">
        <h3>Account Information</h3>
        <div class="mm-section-sub">Identity and contact details for this user.</div>
        <div class="form-grid">
          <div class="form-field"><label>User Full Name<span class="mm-required">*</span></label><input name="full_name" required><div class="field-error"></div></div>
          <div class="form-field"><label>Username<span class="mm-required">*</span></label><input name="username" required minlength="3"><div class="field-error"></div></div>
          <div class="form-field"><label>Email ID<span class="mm-required">*</span></label><input name="email" type="email" required><div class="field-error"></div></div>
          <div class="form-field"><label>Phone Number<span class="mm-required">*</span></label><input name="phone_number" required><div class="field-error"></div></div>
        </div>
      </div>

      <div class="panel mm-form-section">
        <h3>Authentication</h3>
        <div class="mm-section-sub">Login credentials for this user.</div>
        <div class="form-grid">
          <div class="form-field"><label>Password<span class="mm-required">*</span></label><input name="password" type="password" required minlength="8"><div class="field-error"></div></div>
          <div class="form-field"><label>Confirm Password<span class="mm-required">*</span></label><input name="confirm_password" type="password" required minlength="8"><div class="field-error"></div></div>
        </div>
      </div>

      <div class="panel mm-form-section">
        <h3>Permissions</h3>
        <div class="mm-section-sub">Access level within the Merchant Portal.</div>
        <div class="form-grid">
          <div class="form-field"><label>Role Type<span class="mm-required">*</span></label>
            <select name="role_type" id="cmuRoleType" required>
              ${Object.entries(ROLE_TYPE_LABELS).map(([val, label]) => `<option value="${val}">${label}</option>`).join('')}
            </select>
          </div>
          <div class="form-field"><label>Member Role<span class="mm-required">*</span></label><select name="member_role" id="cmuMemberRole" required></select></div>
        </div>
      </div>

      <div class="panel">
        <div class="msg" id="createMerchantUserMsg"></div>
        <div class="mm-form-actions">
          <button type="button" class="btn btn-ghost" id="createMerchantUserCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-coral" id="createMerchantUserSubmitBtn">Create User</button>
        </div>
      </div>
    </form>
  `;

  const refreshMemberRoles = () => {
    const roleType = document.getElementById('cmuRoleType').value;
    document.getElementById('cmuMemberRole').innerHTML = ROLE_TYPE_MEMBER_ROLES[roleType]
      .map(val => `<option value="${val}">${MEMBER_ROLE_LABELS[val]}</option>`).join('');
  };
  document.getElementById('cmuRoleType').addEventListener('change', refreshMemberRoles);
  refreshMemberRoles();
  document.getElementById('cmuBackBtn').addEventListener('click', goBack);
  document.getElementById('cmuCancelTopBtn').addEventListener('click', goBack);
  document.getElementById('createMerchantUserCancelBtn').addEventListener('click', goBack);

  const form = document.getElementById('createMerchantUserForm');
  const fieldError = name => form.querySelector(`[name="${name}"]`)?.closest('.form-field')?.querySelector('.field-error');
  const setFieldError = (name, text) => { const el = fieldError(name); if (el) el.textContent = text || ''; };
  const validateField = name => {
    const f = form.elements[name];
    if (!f) return true;
    if (f.hasAttribute('required') && !f.value.trim()) { setFieldError(name, 'This field is required.'); return false; }
    if (name === 'email' && f.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value)) { setFieldError(name, 'Enter a valid email address.'); return false; }
    if ((name === 'password' || name === 'confirm_password') && f.value && f.value.length < 8) { setFieldError(name, 'Must be at least 8 characters.'); return false; }
    if (name === 'confirm_password' && f.value && form.elements.password.value !== f.value) { setFieldError(name, 'Passwords do not match.'); return false; }
    if (name === 'username' && f.value && f.value.trim().length < 3) { setFieldError(name, 'Must be at least 3 characters.'); return false; }
    setFieldError(name, '');
    return true;
  };
  const validatedFields = ['full_name', 'username', 'email', 'phone_number', 'password', 'confirm_password'].concat(partnerId ? [] : ['partner_id']);
  validatedFields.forEach(name => form.elements[name]?.addEventListener('blur', () => validateField(name)));
  form.elements.password?.addEventListener('input', () => { if (form.elements.confirm_password.value) validateField('confirm_password'); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const msg = document.getElementById('createMerchantUserMsg');
    msg.textContent = ''; msg.className = 'msg';
    const allValid = validatedFields.map(validateField).every(Boolean);
    if (!allValid) return;

    const targetPartnerId = partnerId || f.partner_id.value;
    const submitBtn = document.getElementById('createMerchantUserSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
    try {
      await axios.post(`${API_BASE}/api/admin/merchants/${targetPartnerId}/users`, {
        full_name: f.full_name.value, username: f.username.value, email: f.email.value, phone_number: f.phone_number.value,
        password: f.password.value, confirm_password: f.confirm_password.value,
        role_type: f.role_type.value, member_role: f.member_role.value,
      }, { headers: authHeaders() });
      msg.textContent = 'User created successfully.';
      msg.className = 'msg success';
      setTimeout(() => {
        if (partnerId) openMerchantDetail(partnerId);
        else loadMerchants(merchantsPage);
      }, 700);
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to create user.';
      msg.className = 'msg error';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create User';
    }
  });
}

/* ---------- Active Users ---------- */
async function loadActiveUsers() {
  const tbody = document.querySelector('#activeUsersTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/users`, { headers: authHeaders(), params: { page: 1, page_size: 1000 } });
    const active = data.items.filter(u => u.is_active);
    tbody.innerHTML = active.map(u => `
      <tr><td>${escapeHtml(u.full_name)}</td><td>${escapeHtml(u.email)}</td><td style="text-transform:capitalize">${escapeHtml(u.role)}</td></tr>
    `).join('') || `<tr><td colspan="3" class="empty-state">No active users.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">Failed to load active users.</td></tr>`;
  }
}

/* ---------- Inventory Management ---------- */
let inventorySearchTimer;
const TYPE_LABEL = { flight: 'Flight', hotel: 'Hotel', cruise: 'Cruise', package: 'Package' };

async function loadInventoryStats() {
  const el = document.getElementById('inventoryStatGrid');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/inventory/stats`, { headers: authHeaders() });
    el.innerHTML = `
      <div class="stat-card"><div class="stat-icon"><svg class="icon" viewBox="0 0 24 24"><path d="M3.3 7 12 12l8.7-5"/><line x1="12" y1="22" x2="12" y2="12"/></svg></div><div class="stat-body"><div class="num">${data.total_items}</div><div class="label">Total Items</div></div></div>
      <div class="stat-card"><div class="stat-icon emerald"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/></svg></div><div class="stat-body"><div class="num">${data.healthy}</div><div class="label">Healthy Stock</div></div></div>
      <div class="stat-card"><div class="stat-icon gold"><svg class="icon" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/></svg></div><div class="stat-body"><div class="num">${data.low_stock}</div><div class="label">Low Stock</div></div></div>
      <div class="stat-card"><div class="stat-icon coral"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg></div><div class="stat-body"><div class="num">${data.sold_out}</div><div class="label">Sold Out</div></div></div>
    `;
  } catch (err) { el.innerHTML = `<div class="msg error">Failed to load inventory stats.</div>`; }
}

async function loadInventory() {
  const tbody = document.querySelector('#inventoryTable tbody');
  const search = document.getElementById('inventorySearch').value;
  const itemType = document.getElementById('inventoryTypeFilter').value;
  const statusFilter = document.getElementById('inventoryStatusFilter').value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/inventory`, {
      headers: authHeaders(),
      params: {
        search: search || undefined,
        item_type: itemType || undefined,
        low_stock_only: statusFilter === 'low_stock' ? true : undefined,
        sold_out_only: statusFilter === 'sold_out' ? true : undefined,
      },
    });
    tbody.innerHTML = data.map(i => {
      const badge = i.is_sold_out ? '<span class="badge sold-out">Sold Out</span>' : i.is_low_stock ? '<span class="badge low-stock">Low Stock</span>' : '<span class="badge healthy">Healthy</span>';
      return `
      <tr>
        <td>${TYPE_LABEL[i.item_type]}</td>
        <td>${escapeHtml(i.name)}</td>
        <td>${money(i.price)}</td>
        <td>${i.available}</td>
        <td>${i.low_stock_threshold}</td>
        <td>${badge}</td>
        <td><button class="btn btn-ghost btn-sm" data-adjust-inventory="${i.item_type}:${i.item_id}" data-available="${i.available}" data-threshold="${i.low_stock_threshold}" data-name="${escapeHtml(i.name)}">Adjust</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="7" class="empty-state">No inventory items found.</td></tr>`;
    tbody.querySelectorAll('[data-adjust-inventory]').forEach(btn => {
      btn.addEventListener('click', () => openInventoryAdjustModal(btn));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Failed to load inventory.</td></tr>`;
  }
  loadInventoryStats();
}
document.getElementById('inventorySearch').addEventListener('input', () => {
  clearTimeout(inventorySearchTimer);
  inventorySearchTimer = setTimeout(loadInventory, 350);
});
document.getElementById('inventoryTypeFilter').addEventListener('change', loadInventory);
document.getElementById('inventoryStatusFilter').addEventListener('change', loadInventory);

const inventoryAdjustModalOverlay = document.getElementById('inventoryAdjustModalOverlay');
const inventoryAdjustForm = document.getElementById('inventoryAdjustForm');
let inventoryAdjustTarget = null;
function openInventoryAdjustModal(btn) {
  inventoryAdjustTarget = btn.dataset.adjustInventory;
  document.getElementById('inventoryAdjustTitle').textContent = `Adjust Inventory — ${btn.dataset.name}`;
  inventoryAdjustForm.elements.available.value = btn.dataset.available;
  inventoryAdjustForm.elements.low_stock_threshold.value = btn.dataset.threshold;
  document.getElementById('inventoryAdjustMsg').textContent = '';
  inventoryAdjustModalOverlay.classList.add('open');
}
document.getElementById('inventoryAdjustCancelBtn').addEventListener('click', () => inventoryAdjustModalOverlay.classList.remove('open'));
inventoryAdjustForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('inventoryAdjustMsg');
  const [itemType, itemId] = inventoryAdjustTarget.split(':');
  const payload = {
    available: Number(inventoryAdjustForm.elements.available.value),
    low_stock_threshold: Number(inventoryAdjustForm.elements.low_stock_threshold.value),
  };
  try {
    await axios.patch(`${API_BASE}/api/admin/inventory/${itemType}/${itemId}`, payload, { headers: authHeaders() });
    inventoryAdjustModalOverlay.classList.remove('open');
    loadInventory();
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to adjust inventory.';
    msg.className = 'msg error';
  }
});

/* ---------- Booking Management Center ---------- */
let bmPage = 1;
let bmSearchTimer;
let currentBookingId = null;
let currentBookingData = null;
const BM_STATUS_BADGE = s => `<span class="badge ${s === 'completed' ? 'confirmed' : s}">${s}</span>`;

async function loadBookingAnalytics(targetId = 'bmStatGrid') {
  const el = document.getElementById(targetId);
  if (!el) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/analytics`, { headers: authHeaders() });
    el.innerHTML = `
      <div class="stat-card"><div class="stat-icon"><svg class="icon" viewBox="0 0 24 24"><path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2Z"/></svg></div><div class="stat-body"><div class="num">${data.total_bookings}</div><div class="label">Total Bookings</div></div></div>
      <div class="stat-card"><div class="stat-icon sky"><svg class="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/></svg></div><div class="stat-body"><div class="num">${data.today_bookings}</div><div class="label">Today's Bookings</div></div></div>
      <div class="stat-card"><div class="stat-icon emerald"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/></svg></div><div class="stat-body"><div class="num">${data.confirmed}</div><div class="label">Confirmed</div></div></div>
      <div class="stat-card"><div class="stat-icon gold"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></div><div class="stat-body"><div class="num">${data.pending}</div><div class="label">Pending</div></div></div>
      <div class="stat-card"><div class="stat-icon coral"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg></div><div class="stat-body"><div class="num">${data.cancelled}</div><div class="label">Cancelled</div></div></div>
      <div class="stat-card"><div class="stat-icon"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/></svg></div><div class="stat-body"><div class="num">${data.completed}</div><div class="label">Completed</div></div></div>
      <div class="stat-card"><div class="stat-icon emerald"><svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="stat-body"><div class="num">${money(data.revenue)}</div><div class="label">Revenue</div></div></div>
      <div class="stat-card"><div class="stat-icon sky"><svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="stat-body"><div class="num">${money(data.average_booking_value)}</div><div class="label">Avg Booking Value</div></div></div>
    `;
  } catch (err) { el.innerHTML = `<div class="msg error">Failed to load booking analytics.</div>`; }
}

async function loadBookingManagement(page = bmPage) {
  bmPage = page;
  const tbody = document.querySelector('#bmTable tbody');
  const params = {
    search: document.getElementById('bmSearch').value || undefined,
    booking_type: document.getElementById('bmTypeFilter').value || undefined,
    booking_status: document.getElementById('bmStatusFilter').value || undefined,
    payment_status: document.getElementById('bmPaymentFilter').value || undefined,
    date_from: document.getElementById('bmDateFrom').value || undefined,
    date_to: document.getElementById('bmDateTo').value || undefined,
    sort: document.getElementById('bmSort').value,
    page, page_size: PAGE_SIZE,
  };
  tbody.innerHTML = `<tr><td colspan="11">${rowsSkeleton(4)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/bookings`, { headers: authHeaders(), params });
    renderPagination('bmPagination', data.page, data.total_pages, data.total, loadBookingManagement);
    tbody.innerHTML = data.items.map(b => `
      <tr>
        <td>#${b.id}</td>
        <td>${escapeHtml(b.customer_name)}<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(b.customer_email)}</div></td>
        <td style="text-transform:capitalize">${escapeHtml(b.booking_type)}</td>
        <td>${escapeHtml(b.destination)}</td>
        <td>${fmtDate(b.booking_date)}</td>
        <td>${b.travel_date ? fmtDate(b.travel_date) : '—'}</td>
        <td>${b.passengers}</td>
        <td>${money(b.total_amount)}</td>
        <td>${b.payment_status ? `<span class="badge ${b.payment_status}">${b.payment_status === 'success' ? 'paid' : escapeHtml(b.payment_status)}</span>` : '—'}</td>
        <td>${BM_STATUS_BADGE(b.booking_status)}</td>
        <td><button class="btn btn-ghost btn-sm" data-view-booking="${b.id}">View</button></td>
      </tr>
    `).join('') || `<tr><td colspan="11" class="empty-state">No bookings found.</td></tr>`;
    tbody.querySelectorAll('[data-view-booking]').forEach(btn => {
      btn.addEventListener('click', () => openBookingDetail(btn.dataset.viewBooking));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state">Failed to load bookings.</td></tr>`;
  }
  loadBookingAnalytics();
}
['bmTypeFilter', 'bmStatusFilter', 'bmPaymentFilter', 'bmDateFrom', 'bmDateTo', 'bmSort'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => loadBookingManagement(1));
});
document.getElementById('bmSearch').addEventListener('input', () => {
  clearTimeout(bmSearchTimer);
  bmSearchTimer = setTimeout(() => loadBookingManagement(1), 350);
});

/* ---------- Booking detail modal ---------- */
const bmModalOverlay = document.getElementById('bmModalOverlay');

async function openBookingDetail(id) {
  currentBookingId = id;
  bmModalOverlay.classList.add('open');
  document.getElementById('bmProfileName').textContent = 'Loading…';
  document.getElementById('bmProfileMeta').textContent = '';
  document.getElementById('bmProfileActions').innerHTML = '';
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/bookings/${id}`, { headers: authHeaders() });
    currentBookingData = data;
    renderBookingDetail(data);
  } catch (err) {
    document.getElementById('bmProfileName').textContent = 'Failed to load booking';
  }
}
document.getElementById('bmModalCloseBtn').addEventListener('click', () => bmModalOverlay.classList.remove('open'));

function renderBookingDetail(b) {
  document.getElementById('bmProfileAvatar').textContent = b.booking_type[0].toUpperCase();
  document.getElementById('bmProfileName').textContent = `Booking #${b.id} — ${b.destination}`;
  document.getElementById('bmProfileBadges').innerHTML = BM_STATUS_BADGE(b.status);
  document.getElementById('bmProfileMeta').textContent = `${b.customer.full_name} · ${b.customer.email} · Booked ${fmtDateTime(b.created_at)}`;

  const actions = [];
  actions.push(`<button class="btn btn-ghost btn-sm" data-bm-act="view-customer">View Customer</button>`);
  if (b.status === 'pending') {
    actions.push(`<button class="btn btn-navy btn-sm" data-bm-act="approve">Approve</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" data-bm-act="reject">Reject</button>`);
  }
  if (b.status === 'confirmed') {
    actions.push(`<button class="btn btn-navy btn-sm" data-bm-act="complete">Mark Completed</button>`);
  }
  if (b.status !== 'cancelled') {
    actions.push(`<button class="btn btn-ghost btn-sm" data-bm-act="reschedule">Reschedule</button>`);
    actions.push(`<button class="btn btn-ghost btn-sm" data-bm-act="passengers">Update Passengers</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" data-bm-act="cancel">Cancel Booking</button>`);
  }
  const refundablePayment = b.payments.find(p => p.status === 'success');
  if (refundablePayment) {
    actions.push(`<button class="btn btn-danger btn-sm" data-bm-act="refund" data-payment-id="${refundablePayment.id}">Refund Payment</button>`);
  }
  actions.push(`<button class="btn btn-ghost btn-sm" data-bm-act="ticket">Download Ticket</button>`);
  actions.push(`<button class="btn btn-ghost btn-sm" data-bm-act="invoice">Download Invoice</button>`);
  actions.push(`<button class="btn btn-ghost btn-sm" data-bm-act="print">Print Booking</button>`);
  document.getElementById('bmProfileActions').innerHTML = actions.join('');
  document.getElementById('bmProfileActions').querySelectorAll('[data-bm-act]').forEach(btn => {
    btn.addEventListener('click', () => handleBookingAction(btn.dataset.bmAct, btn.dataset));
  });

  document.getElementById('bmTab-overview').innerHTML = `
    <div class="analytics-grid">
      <div class="analytics-tile"><div class="num" style="font-size:15px;text-transform:capitalize;">${escapeHtml(b.booking_type)}</div><div class="label">Booking Type</div></div>
      <div class="analytics-tile"><div class="num">${b.quantity}</div><div class="label">Passengers</div></div>
      <div class="analytics-tile"><div class="num">${money(b.total_price)}</div><div class="label">Total Amount</div></div>
      <div class="analytics-tile"><div class="num" style="font-size:15px;">${b.travel_date ? fmtDate(b.travel_date) : '—'}</div><div class="label">Travel Date</div></div>
      <div class="analytics-tile"><div class="num" style="font-size:15px;">${fmtDateTime(b.updated_at)}</div><div class="label">Last Updated</div></div>
      <div class="analytics-tile"><div class="num" style="font-size:15px;">${fmtDateTime(b.created_at)}</div><div class="label">Created</div></div>
    </div>
    <h2 style="font-size:14px;margin-bottom:12px;">Customer &amp; traveler details</h2>
    <div class="info-grid">
      <div class="info-item"><label>Customer Name</label><div>${escapeHtml(b.customer.full_name)}</div></div>
      <div class="info-item"><label>Email</label><div>${escapeHtml(b.customer.email)}</div></div>
      <div class="info-item"><label>Mobile</label><div>${b.customer.mobile ? escapeHtml(b.customer.mobile) : '—'}</div></div>
      <div class="info-item"><label>Travelers</label><div>${b.quantity} traveler(s), primary contact ${escapeHtml(b.customer.full_name)}</div></div>
    </div>
  `;

  document.getElementById('bmTab-payment').innerHTML = b.payments.length
    ? `<div class="table-wrap"><table><thead><tr><th>Transaction ID</th><th>Amount</th><th>Method</th><th>Date</th><th>Status</th><th>Refund Ref</th><th>Refund Date</th></tr></thead><tbody>${
        b.payments.map(p => `<tr><td>${escapeHtml(p.transaction_ref)}</td><td>${money(p.amount)}</td><td style="text-transform:capitalize">${escapeHtml(p.method)}</td><td>${fmtDateTime(p.created_at)}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td><td>${p.refund_reference ? escapeHtml(p.refund_reference) : '—'}</td><td>${p.refunded_at ? fmtDateTime(p.refunded_at) : '—'}</td></tr>`).join('')
      }</tbody></table></div>`
    : `<div class="empty-state">No payment recorded.</div>`;

  document.getElementById('bmTab-timeline').innerHTML = b.timeline.length
    ? `<div class="timeline">${b.timeline.map(t => `
        <div class="timeline-item">
          <span class="timeline-dot"></span>
          <div class="timeline-body">
            <div class="timeline-text">${ACTIVITY_EMOJI[t.activity_type] || '📌'} ${escapeHtml(t.description || t.activity_type || 'Activity')}</div>
            <div class="timeline-time">${fmtDateTime(t.created_at)} · ${escapeHtml(t.actor)}</div>
          </div>
        </div>`).join('')}</div>`
    : `<div class="empty-state">No timeline events recorded yet.</div>`;

  document.getElementById('bmTab-inventory').innerHTML = b.inventory
    ? `<div class="analytics-grid">
        <div class="analytics-tile"><div class="num" style="font-size:15px;">${escapeHtml(b.inventory.name)}</div><div class="label">Item</div></div>
        <div class="analytics-tile"><div class="num">${b.inventory.available}</div><div class="label">Currently Available</div></div>
        <div class="analytics-tile"><div class="num">${b.inventory.low_stock_threshold}</div><div class="label">Low-stock Threshold</div></div>
        <div class="analytics-tile"><div class="num" style="font-size:15px;">${b.inventory.is_sold_out ? '<span class="badge sold-out">Sold Out</span>' : b.inventory.is_low_stock ? '<span class="badge low-stock">Low Stock</span>' : '<span class="badge healthy">Healthy</span>'}</div><div class="label">Status</div></div>
      </div>`
    : `<div class="empty-state">This catalog item no longer exists.</div>`;
}

document.getElementById('bmProfileTabs').querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#bmProfileTabs .profile-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('#bmModalOverlay .profile-tab-panel').forEach(p => p.classList.toggle('active', p.id === `bmTab-${tab.dataset.tab}`));
  });
});

async function handleBookingAction(action, dataset) {
  const id = currentBookingId;
  const base = `${API_BASE}/api/admin/booking-management/bookings/${id}`;
  try {
    if (action === 'view-customer') { bmModalOverlay.classList.remove('open'); return openCustomerProfile(currentBookingData.customer.id); }
    if (action === 'reschedule') return openBmSmallModal('reschedule');
    if (action === 'passengers') return openBmSmallModal('passengers');
    if (action === 'invoice') {
      const { data } = await axios.get(`${base}/invoice`, { headers: authHeaders(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `invoice-booking-${id}.csv`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (action === 'ticket') return showAdminTicket(currentBookingData);
    if (action === 'print') {
      bmModalOverlay.classList.add('print-target');
      window.print();
      setTimeout(() => bmModalOverlay.classList.remove('print-target'), 500);
      return;
    }
    if (action === 'refund') {
      /* Reuses the exact same refund action Payment Management already uses — no duplicate refund logic. */
      await handlePaymentAction('refund', { id: dataset.paymentId });
      openBookingDetail(id);
      return;
    }
    if (action === 'approve') await axios.post(`${base}/approve`, {}, { headers: authHeaders() });
    else if (action === 'reject') { if (!confirm('Reject this pending booking?')) return; await axios.post(`${base}/reject`, {}, { headers: authHeaders() }); }
    else if (action === 'complete') await axios.post(`${base}/complete`, {}, { headers: authHeaders() });
    else if (action === 'cancel') { if (!confirm('Cancel this booking? This restores inventory and refunds the payment.')) return; await axios.post(`${base}/cancel`, {}, { headers: authHeaders() }); }
    openBookingDetail(id);
    loadBookingManagement(bmPage);
  } catch (err) {
    alert(err.response?.data?.detail || 'Action failed.');
  }
}

/* ---------- Admin ticket view (mirrors the customer-facing ticket in index.html) ---------- */
const CATALOG_ENDPOINTS = { flight: 'flights', hotel: 'hotels', cruise: 'cruises', package: 'packages' };
const adminCatalogItemCache = new Map();
async function fetchCatalogItem(type, id) {
  const cacheKey = `${type}-${id}`;
  if (adminCatalogItemCache.has(cacheKey)) return adminCatalogItemCache.get(cacheKey);
  const endpoint = CATALOG_ENDPOINTS[type];
  if (!endpoint) return null;
  try {
    const { data } = await axios.get(`${API_BASE}/api/${endpoint}/${id}`);
    adminCatalogItemCache.set(cacheKey, data);
    return data;
  } catch (err) {
    return null;
  }
}
function bookingReference(bookingId) { return 'JWT-' + String(bookingId).padStart(6, '0'); }

async function showAdminTicket(b) {
  const itemId = b.inventory?.item_id;
  const item = itemId ? await fetchCatalogItem(b.booking_type, itemId) : null;
  const reference = bookingReference(b.id);
  const isFlight = b.booking_type === 'flight';
  const payment = b.payments?.[0];

  let itemTitle = `${b.booking_type} — #${b.id}`;
  let itemSub = '';
  let dateValue = fmtDate(b.travel_date || (isFlight ? item?.departure_time : null));
  let sourceDestRow = '';
  let timeRow = '';
  let seatRow = '';

  if (item) {
    if (isFlight) {
      itemTitle = `${item.airline} · ${item.cabin_class}`;
      sourceDestRow = `
        <div class="ticket-row"><span>From</span><span>${escapeHtml(item.from_airport)}</span></div>
        <div class="ticket-row"><span>To</span><span>${escapeHtml(item.to_airport)}</span></div>`;
      timeRow = `<div class="ticket-row"><span>Time</span><span>${fmtTime(item.departure_time)} – ${fmtTime(item.arrival_time)}</span></div>`;
      seatRow = `<div class="ticket-row"><span>Seat Number</span><span>Assigned at check-in</span></div>`;
    } else if (b.booking_type === 'hotel') { itemTitle = item.name; itemSub = item.location; }
    else if (b.booking_type === 'cruise') { itemTitle = item.name; itemSub = `Departs ${item.departure_port}`; }
    else if (b.booking_type === 'package') { itemTitle = item.title; itemSub = item.package_type; }
  }

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(reference)}`;

  document.getElementById('adminTicketBody').innerHTML = `
    <div class="ticket-head">
      <img src="../assets/images/jackpots-logo-full.png" alt="JackPots World Tours & Travels">
      <div>
        <div class="th-name">${escapeHtml(itemTitle)}</div>
        ${itemSub ? `<div class="th-sub">${escapeHtml(itemSub)}</div>` : ''}
      </div>
    </div>
    <div class="ticket-row"><span>Booking ID</span><span>#${b.id}</span></div>
    <div class="ticket-row"><span>PNR / Booking Reference</span><span>${reference}</span></div>
    <div class="ticket-row"><span>Passenger Name</span><span>${escapeHtml(b.customer?.full_name || '—')}</span></div>
    <div class="ticket-row"><span>Type</span><span style="text-transform:capitalize">${b.booking_type}</span></div>
    ${sourceDestRow}
    <div class="ticket-row"><span>Date</span><span>${dateValue}</span></div>
    ${timeRow}
    ${seatRow}
    <div class="ticket-row"><span>Quantity</span><span>${b.quantity}</span></div>
    <div class="ticket-row"><span>Booking Status</span><span style="text-transform:capitalize">${b.status}</span></div>
    ${payment ? `<div class="ticket-row"><span>Payment Status</span><span style="text-transform:capitalize">${payment.status}</span></div>` : ''}
    <div class="ticket-row"><span>Total Amount</span><span>${money(b.total_price)}</span></div>
    <div class="ticket-row"><span>Booked On</span><span>${fmtDate(b.created_at)}</span></div>
    <div class="ticket-qr">
      <img src="${qrUrl}" alt="Booking QR code" width="130" height="130">
      <div class="tq-ref">${reference}</div>
    </div>
    <div class="ticket-actions">
      <button type="button" class="btn btn-coral btn-sm" id="adminTicketPrintBtn">Print / Save as PDF</button>
      <button type="button" class="btn btn-ghost btn-sm" id="adminTicketCloseBtn">Close</button>
    </div>
  `;
  document.getElementById('adminTicketOverlay').classList.add('open');
  document.getElementById('adminTicketPrintBtn').addEventListener('click', () => {
    document.getElementById('adminTicketOverlay').classList.add('print-target');
    window.print();
    setTimeout(() => document.getElementById('adminTicketOverlay').classList.remove('print-target'), 500);
  });
  document.getElementById('adminTicketCloseBtn').addEventListener('click', () => {
    document.getElementById('adminTicketOverlay').classList.remove('open');
  });
}

/* ---------- Reschedule / passenger-count small modal (shared) ---------- */
const bmSmallModalOverlay = document.getElementById('bmSmallModalOverlay');
const bmSmallModalForm = document.getElementById('bmSmallModalForm');
let bmSmallModalMode = 'reschedule';
function openBmSmallModal(mode) {
  bmSmallModalMode = mode;
  document.getElementById('bmSmallModalMsg').textContent = '';
  const input = document.getElementById('bmSmallModalInput');
  if (mode === 'reschedule') {
    document.getElementById('bmSmallModalTitle').textContent = 'Reschedule Booking';
    document.getElementById('bmSmallModalLabel').textContent = 'New Travel Date';
    input.type = 'date';
    input.value = currentBookingData.travel_date || '';
  } else {
    document.getElementById('bmSmallModalTitle').textContent = 'Update Passenger Count';
    document.getElementById('bmSmallModalLabel').textContent = 'Passengers (max 10)';
    input.type = 'number';
    input.min = 1; input.max = 10;
    input.value = currentBookingData.quantity;
  }
  bmSmallModalOverlay.classList.add('open');
}
document.getElementById('bmSmallModalCancelBtn').addEventListener('click', () => bmSmallModalOverlay.classList.remove('open'));
bmSmallModalForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('bmSmallModalMsg');
  const value = document.getElementById('bmSmallModalInput').value;
  const base = `${API_BASE}/api/admin/booking-management/bookings/${currentBookingId}`;
  try {
    if (bmSmallModalMode === 'reschedule') {
      await axios.patch(`${base}/reschedule`, { travel_date: value }, { headers: authHeaders() });
    } else {
      await axios.patch(`${base}/passengers`, { quantity: Number(value) }, { headers: authHeaders() });
    }
    bmSmallModalOverlay.classList.remove('open');
    openBookingDetail(currentBookingId);
    loadBookingManagement(bmPage);
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to save.';
    msg.className = 'msg error';
  }
});

/* ---------- Payment Management Center ---------- */
let pmPage = 1;
let pmSearchTimer;

async function loadPaymentAnalytics(targetId = 'pmStatGrid') {
  const el = document.getElementById(targetId);
  if (!el) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/payment-management/analytics`, { headers: authHeaders() });
    el.innerHTML = `
      <div class="stat-card"><div class="stat-icon"><svg class="icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2.5"/><line x1="2" y1="10" x2="22" y2="10"/></svg></div><div class="stat-body"><div class="num">${data.total_transactions}</div><div class="label">Total Transactions</div></div></div>
      <div class="stat-card"><div class="stat-icon emerald"><svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="stat-body"><div class="num emerald">${money(data.total_revenue)}</div><div class="label">Total Revenue</div></div></div>
      <div class="stat-card"><div class="stat-icon sky"><svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="stat-body"><div class="num emerald">${money(data.today_revenue)}</div><div class="label">Today's Revenue</div></div></div>
      <div class="stat-card"><div class="stat-icon gold"><svg class="icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></div><div class="stat-body"><div class="num">${money(data.total_refunded)}</div><div class="label">Total Refunded</div></div></div>
      <div class="stat-card"><div class="stat-icon emerald"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/></svg></div><div class="stat-body"><div class="num">${data.success_count}</div><div class="label">Successful</div></div></div>
      <div class="stat-card"><div class="stat-icon coral"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg></div><div class="stat-body"><div class="num">${data.failed_count}</div><div class="label">Failed</div></div></div>
      <div class="stat-card"><div class="stat-icon"><svg class="icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></div><div class="stat-body"><div class="num">${data.refunded_count}</div><div class="label">Refunded</div></div></div>
    `;
  } catch (err) { el.innerHTML = `<div class="msg error">Failed to load payment analytics.</div>`; }
}

async function loadPaymentManagement(page = pmPage) {
  pmPage = page;
  const tbody = document.querySelector('#pmTable tbody');
  const params = {
    search: document.getElementById('pmSearch').value || undefined,
    payment_status: document.getElementById('pmStatusFilter').value || undefined,
    date_from: document.getElementById('pmDateFrom').value || undefined,
    date_to: document.getElementById('pmDateTo').value || undefined,
    sort: document.getElementById('pmSort').value,
    page, page_size: PAGE_SIZE,
  };
  tbody.innerHTML = `<tr><td colspan="10">${rowsSkeleton(4)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/payment-management/payments`, { headers: authHeaders(), params });
    renderPagination('pmPagination', data.page, data.total_pages, data.total, loadPaymentManagement);
    tbody.innerHTML = data.items.map(p => `
      <tr>
        <td>${escapeHtml(p.transaction_ref)}</td>
        <td>${escapeHtml(p.customer_name)}<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.customer_email)}</div></td>
        <td>#${p.booking_id} <span style="color:var(--text-muted);font-size:12px;">${escapeHtml(p.destination)}</span></td>
        <td>${money(p.amount)}</td>
        <td>${escapeHtml(p.gateway)}</td>
        <td style="text-transform:capitalize">${escapeHtml(p.method)}</td>
        <td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td>
        <td>${escapeHtml(p.refund_status)}</td>
        <td>${fmtDateTime(p.created_at)}</td>
        <td class="cust-actions">
          ${p.status === 'success' ? `<button class="btn btn-danger btn-sm" data-pm-act="refund" data-id="${p.id}">Refund</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-pm-act="invoice" data-booking="${p.booking_id}">Invoice</button>
          <button class="btn btn-ghost btn-sm" data-pm-act="view-booking" data-booking="${p.booking_id}">View Booking</button>
          <button class="btn btn-ghost btn-sm" data-pm-act="view-customer" data-customer="${p.customer_id}">View Customer</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="10" class="empty-state">No payments found.</td></tr>`;
    tbody.querySelectorAll('[data-pm-act]').forEach(btn => {
      btn.addEventListener('click', () => handlePaymentAction(btn.dataset.pmAct, btn.dataset));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">Failed to load payments.</td></tr>`;
  }
  loadPaymentAnalytics();
}
['pmStatusFilter', 'pmDateFrom', 'pmDateTo', 'pmSort'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => loadPaymentManagement(1));
});
document.getElementById('pmSearch').addEventListener('input', () => {
  clearTimeout(pmSearchTimer);
  pmSearchTimer = setTimeout(() => loadPaymentManagement(1), 350);
});

async function handlePaymentAction(action, dataset) {
  try {
    if (action === 'view-booking') return openBookingDetail(dataset.booking);
    if (action === 'view-customer') return openCustomerProfile(dataset.customer);
    if (action === 'invoice') {
      const { data } = await axios.get(`${API_BASE}/api/admin/booking-management/bookings/${dataset.booking}/invoice`, { headers: authHeaders(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `invoice-booking-${dataset.booking}.csv`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (action === 'refund') {
      if (!confirm('Refund this payment? This cancels the booking and restores inventory.')) return;
      await axios.post(`${API_BASE}/api/admin/payment-management/payments/${dataset.id}/refund`, {}, { headers: authHeaders() });
      loadPaymentManagement(pmPage);
      if (loadedSections.has('refunds')) loadRefunds(rfPage);
    }
  } catch (err) {
    alert(err.response?.data?.detail || 'Action failed.');
  }
}

/* ---------- Refunds (focused view over Payment Management's existing data + refund action) ---------- */
let rfPage = 1;
let rfSearchTimer;
async function loadRefunds(page = rfPage) {
  rfPage = page;
  const tbody = document.querySelector('#rfTable tbody');
  const params = {
    search: document.getElementById('rfSearch').value || undefined,
    payment_status: document.getElementById('rfViewFilter').value,
    sort: 'newest',
    page, page_size: PAGE_SIZE,
  };
  tbody.innerHTML = `<tr><td colspan="9">${rowsSkeleton(4)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/payment-management/payments`, { headers: authHeaders(), params });
    renderPagination('rfPagination', data.page, data.total_pages, data.total, loadRefunds);
    tbody.innerHTML = data.items.map(p => `
      <tr>
        <td>${escapeHtml(p.transaction_ref)}</td>
        <td>${escapeHtml(p.customer_name)}<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.customer_email)}</div></td>
        <td>#${p.booking_id} <span style="color:var(--text-muted);font-size:12px;">${escapeHtml(p.destination)}</span></td>
        <td>${money(p.amount)}</td>
        <td style="text-transform:capitalize">${escapeHtml(p.method)}</td>
        <td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td>
        <td>${p.refund_reference ? escapeHtml(p.refund_reference) : '—'}</td>
        <td>${p.refunded_at ? fmtDateTime(p.refunded_at) : '—'}</td>
        <td class="cust-actions">
          ${p.status === 'success' ? `<button class="btn btn-danger btn-sm" data-pm-act="refund" data-id="${p.id}">Refund</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-pm-act="view-booking" data-booking="${p.booking_id}">View Booking</button>
          <button class="btn btn-ghost btn-sm" data-pm-act="view-customer" data-customer="${p.customer_id}">View Customer</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="9" class="empty-state">${params.payment_status === 'refunded' ? 'No refunds issued yet.' : 'Nothing currently refundable.'}</td></tr>`;
    tbody.querySelectorAll('[data-pm-act]').forEach(btn => {
      btn.addEventListener('click', () => handlePaymentAction(btn.dataset.pmAct, btn.dataset));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load refunds.</td></tr>`;
  }
  loadPaymentAnalytics('rfStatGrid');
}
document.getElementById('rfViewFilter').addEventListener('change', () => loadRefunds(1));
document.getElementById('rfSearch').addEventListener('input', () => {
  clearTimeout(rfSearchTimer);
  rfSearchTimer = setTimeout(() => loadRefunds(1), 350);
});

/* ---------- Partner Requests (Back Office approval queue) ----------
   Closes the gap flagged throughout the Partner Portal build: the database
   and API (sp_approve_request/sp_reject_request from Phase 2, plus the new
   sp_admin_list_partner_bookings/sp_resolve_service_request) already
   supported this — there was just no screen to drive them. */
let prActiveTab = 'bookings';
let prTabsWired = false;
let prSearchTimer;
let prSrListCache = [];

function prStatusBadgeClass(s) {
  if (s === 'approved' || s === 'completed') return 'confirmed';
  if (s === 'rejected' || s === 'cancelled') return 'cancelled';
  return 'pending'; // pending_approval, submitted, in_review, draft
}

function initPartnerRequests() {
  if (!prTabsWired) {
    prTabsWired = true;
    document.querySelectorAll('#prTabs .profile-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#prTabs .profile-tab').forEach(t => t.classList.toggle('active', t === tab));
        prActiveTab = tab.dataset.prTab;
        renderPrFilterBar();
        loadPartnerRequestsTab();
      });
    });
  }
  renderPrFilterBar();
  loadPartnerRequestsTab();
}

function renderPrFilterBar() {
  const bar = document.getElementById('prFilterBar');
  if (prActiveTab === 'bookings') {
    bar.innerHTML = `
      <select id="prStatusFilter" class="status-select">
        <option value="pending_approval">Pending Approval</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
        <option value="completed">Completed</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <input type="text" id="prSearch" placeholder="Search reference or company…">
    `;
    document.getElementById('prStatusFilter').addEventListener('change', () => loadPartnerRequestsTab());
    document.getElementById('prSearch').addEventListener('input', () => {
      clearTimeout(prSearchTimer);
      prSearchTimer = setTimeout(() => loadPartnerRequestsTab(), 350);
    });
  } else {
    bar.innerHTML = `
      <select id="prSrStatusFilter" class="status-select">
        <option value="submitted">Submitted</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
        <option value="completed">Completed</option>
      </select>
      <select id="prSrTypeFilter" class="status-select">
        <option value="">All types</option>
        <option value="cancellation">Cancellation</option>
        <option value="date_change">Date Change</option>
        <option value="refund">Refund</option>
        <option value="passenger_modification">Passenger Modification</option>
      </select>
    `;
    document.getElementById('prSrStatusFilter').addEventListener('change', () => loadPartnerRequestsTab());
    document.getElementById('prSrTypeFilter').addEventListener('change', () => loadPartnerRequestsTab());
  }
}

function loadPartnerRequestsTab() {
  return prActiveTab === 'bookings' ? loadPrBookings() : loadPrServiceRequests();
}

async function loadPrBookings() {
  const thead = document.getElementById('prTableHead');
  const tbody = document.getElementById('prTableBody');
  thead.innerHTML = `<th>Reference</th><th>Company</th><th>Requester</th><th>Travel</th><th>Route</th><th>Travel Date</th><th>Passengers</th><th>Amount</th><th>Status</th><th>Actions</th>`;
  tbody.innerHTML = `<tr><td colspan="10">${rowsSkeleton(4)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/partner-requests/bookings`, {
      headers: authHeaders(),
      params: {
        status: document.getElementById('prStatusFilter').value,
        search: document.getElementById('prSearch').value || undefined,
      },
    });
    tbody.innerHTML = data.length ? data.map(b => `
      <tr>
        <td>${escapeHtml(b.reference_number)}</td>
        <td>${escapeHtml(b.company_name)}</td>
        <td>${escapeHtml(b.requester_name)}</td>
        <td style="text-transform:capitalize">${escapeHtml(b.travel_type)}</td>
        <td>${escapeHtml(b.departure)} → ${escapeHtml(b.arrival)}</td>
        <td>${fmtDate(b.departure_date)}</td>
        <td>${b.passenger_count}</td>
        <td>${b.total_amount != null ? money(b.total_amount) : '—'}</td>
        <td><span class="badge ${prStatusBadgeClass(b.status)}">${b.status.replace(/_/g, ' ')}</span></td>
        <td><button class="btn btn-ghost btn-sm" data-pr-view-booking="${b.booking_id}">Review</button></td>
      </tr>
    `).join('') : `<tr><td colspan="10" class="empty-state">No bookings match this filter.</td></tr>`;
    tbody.querySelectorAll('[data-pr-view-booking]').forEach(btn => {
      btn.addEventListener('click', () => openPrBookingModal(btn.dataset.prViewBooking));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">Failed to load partner bookings.</td></tr>`;
  }
}

const PR_SEAT_LABELS = { window: 'Window', aisle: 'Aisle', middle: 'Middle', front_row: 'Front Row', exit_row: 'Exit Row' };
function prAncillaryValue(label, charge) {
  return charge > 0 ? `${escapeHtml(label)} <span style="color:var(--coral-dark);font-weight:700;">(+${money(charge)})</span>` : escapeHtml(label);
}
/* Booking staff need to see each passenger's ancillary selections before
   issuing the ticket — same data Request Ticket collected, no separate
   review step exists elsewhere for this. */
function prPassengerAncillaryBlock(p) {
  const hasAny = p.baggage_selection || p.meal_selection || p.meal_preference || p.seat_preference || p.special_services?.length || p.special_assistance;
  if (!hasAny) return '';
  const services = p.special_services?.length
    ? p.special_services.map(s => `<span class="badge" style="background:rgba(11,60,109,0.08);color:var(--navy);margin:0 4px 4px 0;">${prAncillaryValue(s.label, s.additional_charge)}</span>`).join('')
    : '—';
  return `
    <div style="border:1px solid var(--border-color);border-radius:12px;padding:14px 16px;margin-bottom:10px;">
      <div style="font-size:12.5px;font-weight:700;color:var(--text-muted);margin-bottom:8px;">${escapeHtml(p.full_name)} — Travel Preferences &amp; Additional Services</div>
      <div class="info-grid">
        <div class="info-item"><label>Baggage</label><div>${p.baggage_selection ? prAncillaryValue(p.baggage_selection.label, p.baggage_selection.additional_charge) : 'Not selected'}</div></div>
        <div class="info-item"><label>Meal</label><div>${p.meal_selection ? prAncillaryValue(p.meal_selection.label, p.meal_selection.additional_charge) : (p.meal_preference ? escapeHtml(p.meal_preference) : 'Not specified')}</div></div>
        <div class="info-item"><label>Seat Preference</label><div>${p.seat_preference ? escapeHtml(PR_SEAT_LABELS[p.seat_preference] || p.seat_preference) : 'Not selected'}</div></div>
        <div class="info-item"><label>Special Services</label><div>${services}</div></div>
      </div>
      ${p.special_assistance ? `<div style="margin-top:10px;"><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:3px;">Special Request</label><div style="font-size:13.5px;">${escapeHtml(p.special_assistance)}</div></div>` : ''}
    </div>`;
}

async function openPrBookingModal(bookingId) {
  const overlay = document.getElementById('prBookingModalOverlay');
  const body = document.getElementById('prBookingModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const { data: b } = await axios.get(`${API_BASE}/api/admin/partner-requests/bookings/${bookingId}`, { headers: authHeaders() });
    const canAct = b.status === 'pending_approval';
    body.innerHTML = `
      <h2>Booking ${escapeHtml(b.reference_number)}</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:18px;">${escapeHtml(b.company_name)} · ${escapeHtml(b.requester_name)} (${escapeHtml(b.requester_email)})</p>
      <div class="info-grid">
        <div class="info-item"><label>Status</label><div><span class="badge ${prStatusBadgeClass(b.status)}">${b.status.replace(/_/g, ' ')}</span></div></div>
        <div class="info-item"><label>Travel Type</label><div style="text-transform:capitalize;">${escapeHtml(b.travel_type)}</div></div>
        <div class="info-item"><label>Departure</label><div>${escapeHtml(b.departure)}</div></div>
        <div class="info-item"><label>Arrival</label><div>${escapeHtml(b.arrival)}</div></div>
        <div class="info-item"><label>Travel Date</label><div>${fmtDate(b.departure_date)}</div></div>
        <div class="info-item"><label>Return Date</label><div>${b.return_date ? fmtDate(b.return_date) : '—'}</div></div>
        ${b.airline_name ? `<div class="info-item"><label>Airline</label><div>${escapeHtml(b.airline_name)}${b.flight_number ? ' · ' + escapeHtml(b.flight_number) : ''}</div></div>` : ''}
        ${b.cabin_class ? `<div class="info-item"><label>Cabin</label><div style="text-transform:capitalize;">${escapeHtml(b.cabin_class.replace(/_/g, ' '))}</div></div>` : ''}
        <div class="info-item"><label>Total Amount</label><div>${b.total_amount != null ? money(b.total_amount) : '—'}</div></div>
      </div>
      ${b.rejection_reason ? `<div class="msg error" style="margin-bottom:14px;">Rejected: ${escapeHtml(b.rejection_reason)}</div>` : ''}
      <h2 style="font-size:14px;margin-bottom:10px;">Passengers</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Passport #</th><th>DOB</th></tr></thead><tbody>
        ${b.passengers.map(p => `<tr><td>${escapeHtml(p.full_name)}</td><td style="text-transform:capitalize">${escapeHtml(p.passenger_type)}</td><td>${escapeHtml(p.passport_number)}</td><td>${fmtDate(p.date_of_birth)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">No passengers.</td></tr>'}
      </tbody></table></div>
      ${b.passengers.map(p => prPassengerAncillaryBlock(p)).join('')}
      ${canAct ? `
      <div class="form-grid" style="margin-top:20px;">
        <div class="form-field"><label>Approved Amount (₹, optional)</label><input type="number" id="prApproveAmount" min="1" step="0.01"></div>
      </div>
      <div class="modal-actions" style="margin-top:8px;">
        <button type="button" class="btn btn-coral" id="prApproveBtn">Approve</button>
        <button type="button" class="btn btn-danger" id="prRejectBtn">Reject</button>
        <button type="button" class="btn btn-ghost" id="prBookingCloseBtn">Close</button>
      </div>
      <div class="form-field" id="prRejectReasonField" style="display:none;max-width:none;margin-top:12px;">
        <label>Rejection Reason</label>
        <textarea id="prRejectReason" rows="2" style="width:100%;padding:10px 12px;border-radius:10px;border:1.5px solid var(--border-color);font-family:var(--ff);font-size:14px;"></textarea>
        <button type="button" class="btn btn-danger btn-sm" id="prConfirmRejectBtn" style="margin-top:10px;">Confirm Reject</button>
      </div>
      <div class="msg" id="prBookingMsg"></div>
      ` : `<div class="modal-actions" style="margin-top:20px;"><button type="button" class="btn btn-ghost" id="prBookingCloseBtn">Close</button></div>`}
    `;
    document.getElementById('prBookingCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
    if (canAct) {
      document.getElementById('prApproveBtn').addEventListener('click', async () => {
        const msg = document.getElementById('prBookingMsg');
        const amountInput = document.getElementById('prApproveAmount').value;
        try {
          await axios.post(`${API_BASE}/api/admin/partner-requests/bookings/${bookingId}/approve`, {
            total_amount: amountInput ? Number(amountInput) : null,
          }, { headers: authHeaders() });
          overlay.classList.remove('open');
          loadPrBookings();
        } catch (err) {
          msg.textContent = err.response?.data?.detail || 'Failed to approve.';
          msg.className = 'msg error';
        }
      });
      document.getElementById('prRejectBtn').addEventListener('click', () => {
        document.getElementById('prRejectReasonField').style.display = 'block';
      });
      document.getElementById('prConfirmRejectBtn').addEventListener('click', async () => {
        const reason = document.getElementById('prRejectReason').value.trim();
        const msg = document.getElementById('prBookingMsg');
        if (!reason) { msg.textContent = 'Enter a rejection reason.'; msg.className = 'msg error'; return; }
        try {
          await axios.post(`${API_BASE}/api/admin/partner-requests/bookings/${bookingId}/reject`, { reason }, { headers: authHeaders() });
          overlay.classList.remove('open');
          loadPrBookings();
        } catch (err) {
          msg.textContent = err.response?.data?.detail || 'Failed to reject.';
          msg.className = 'msg error';
        }
      });
    }
  } catch (err) {
    body.innerHTML = `<div class="empty-state">Failed to load booking.</div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="prBookingCloseBtn">Close</button></div>`;
    document.getElementById('prBookingCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
  }
}

async function loadPrServiceRequests() {
  const thead = document.getElementById('prTableHead');
  const tbody = document.getElementById('prTableBody');
  thead.innerHTML = `<th>SR Number</th><th>Type</th><th>Reference</th><th>Company</th><th>Requested By</th><th>Reason</th><th>Status</th><th>Created</th><th>Actions</th>`;
  tbody.innerHTML = `<tr><td colspan="9">${rowsSkeleton(4)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/partner-requests/service-requests`, {
      headers: authHeaders(),
      params: {
        status: document.getElementById('prSrStatusFilter').value,
        request_type: document.getElementById('prSrTypeFilter').value || undefined,
      },
    });
    prSrListCache = data;
    tbody.innerHTML = data.length ? data.map(sr => `
      <tr>
        <td>${escapeHtml(sr.service_request_number)}</td>
        <td style="text-transform:capitalize">${escapeHtml(sr.request_type.replace(/_/g, ' '))}</td>
        <td>${escapeHtml(sr.reference_number)}</td>
        <td>${escapeHtml(sr.company_name)}</td>
        <td>${escapeHtml(sr.requested_by)}</td>
        <td style="max-width:220px;">${escapeHtml(sr.reason || '—')}</td>
        <td><span class="badge ${prStatusBadgeClass(sr.status)}">${sr.status}</span></td>
        <td>${fmtDate(sr.created_at)}</td>
        <td>${['submitted', 'in_review'].includes(sr.status) ? `<button class="btn btn-ghost btn-sm" data-pr-resolve-sr="${sr.service_request_id}">Resolve</button>` : '—'}</td>
      </tr>
    `).join('') : `<tr><td colspan="9" class="empty-state">No service requests match this filter.</td></tr>`;
    tbody.querySelectorAll('[data-pr-resolve-sr]').forEach(btn => {
      btn.addEventListener('click', () => openPrServiceRequestModal(btn.dataset.prResolveSr));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load service requests.</td></tr>`;
  }
}

function openPrServiceRequestModal(srId) {
  const sr = prSrListCache.find(x => String(x.service_request_id) === String(srId));
  if (!sr) return;
  const overlay = document.getElementById('prServiceRequestModalOverlay');
  const body = document.getElementById('prServiceRequestModalBody');
  overlay.classList.add('open');
  body.innerHTML = `
    <h2>${escapeHtml(sr.service_request_number)}</h2>
    <div class="info-grid">
      <div class="info-item"><label>Type</label><div style="text-transform:capitalize;">${escapeHtml(sr.request_type.replace(/_/g, ' '))}</div></div>
      <div class="info-item"><label>Booking</label><div>${escapeHtml(sr.reference_number)}</div></div>
      <div class="info-item"><label>Company</label><div>${escapeHtml(sr.company_name)}</div></div>
      <div class="info-item"><label>Requested By</label><div>${escapeHtml(sr.requested_by)}</div></div>
    </div>
    <div class="form-field" style="max-width:none;"><label>Reason</label><div style="font-size:13.5px;color:var(--text-primary);">${escapeHtml(sr.reason || '—')}</div></div>
    <div class="form-field" style="max-width:none;margin-top:14px;">
      <label>Resolution</label>
      <select id="prResolveStatus" class="status-select" style="width:100%;">
        <option value="approved">Approve</option>
        <option value="rejected">Reject</option>
        <option value="completed">Mark Completed</option>
      </select>
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="btn btn-coral" id="prConfirmResolveBtn">Confirm</button>
      <button type="button" class="btn btn-ghost" id="prSrCloseBtn">Cancel</button>
    </div>
    <div class="msg" id="prSrMsg"></div>
  `;
  document.getElementById('prSrCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
  document.getElementById('prConfirmResolveBtn').addEventListener('click', async () => {
    const msg = document.getElementById('prSrMsg');
    const resolveStatus = document.getElementById('prResolveStatus').value;
    try {
      await axios.post(`${API_BASE}/api/admin/partner-requests/service-requests/${srId}/resolve`, { status: resolveStatus }, { headers: authHeaders() });
      overlay.classList.remove('open');
      loadPrServiceRequests();
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to resolve.';
      msg.className = 'msg error';
    }
  });
}

/* ---------- Coupons & Discounts (Seasonal Pricing / Campaigns / Coupons) ---------- */
let pricingTabsWired = false;
let pricingLoaded = false;
let editingSeasonalId = null, editingCampaignId = null, editingCouponId = null;

function switchPricingTab(name) {
  document.querySelectorAll('#pricingTabs .profile-tab').forEach(t => t.classList.toggle('active', t.dataset.ptab === name));
  document.querySelectorAll('[id^="pricingTab-"]').forEach(p => p.classList.toggle('active', p.id === `pricingTab-${name}`));
}
function loadPricingSection() {
  if (!pricingTabsWired) {
    pricingTabsWired = true;
    document.querySelectorAll('#pricingTabs .profile-tab').forEach(tab => {
      tab.addEventListener('click', () => switchPricingTab(tab.dataset.ptab));
    });
  }
  if (pricingLoaded) return;
  pricingLoaded = true;
  loadSeasonalPrices();
  loadCampaigns();
  loadCoupons();
}

/* ---- Seasonal Pricing ---- */
async function loadSeasonalPrices() {
  const tbody = document.querySelector('#seasonalTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/pricing/seasonal`, { headers: authHeaders() });
    tbody.innerHTML = data.map(s => `
      <tr>
        <td>${escapeHtml(s.item_name || `${s.item_type} #${s.item_id}`)}</td>
        <td style="text-transform:capitalize">${escapeHtml(s.item_type)}</td>
        <td>${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}</td>
        <td>${money(s.override_price)}</td>
        <td>${s.label ? escapeHtml(s.label) : '—'}</td>
        <td><span class="badge ${s.is_active ? 'active' : 'inactive'}">${s.is_active ? 'Active' : 'Inactive'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-edit-seasonal='${escapeHtml(JSON.stringify(s))}'>Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-seasonal="${s.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" class="empty-state">No seasonal prices yet.</td></tr>`;
    tbody.querySelectorAll('[data-edit-seasonal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = JSON.parse(btn.dataset.editSeasonal);
        editingSeasonalId = s.id;
        const f = document.getElementById('seasonalForm');
        f.elements.item_type.value = s.item_type; f.elements.item_id.value = s.item_id;
        f.elements.start_date.value = s.start_date; f.elements.end_date.value = s.end_date;
        f.elements.override_price.value = s.override_price; f.elements.label.value = s.label || '';
        f.scrollIntoView({ behavior: 'smooth' });
      });
    });
    tbody.querySelectorAll('[data-delete-seasonal]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this seasonal price?')) return;
        try {
          await axios.delete(`${API_BASE}/api/admin/pricing/seasonal/${btn.dataset.deleteSeasonal}`, { headers: authHeaders() });
          loadSeasonalPrices();
        } catch (err) { alert('Failed to delete.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Failed to load seasonal prices.</td></tr>`;
  }
}
document.getElementById('seasonalForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('seasonalMsg');
  const payload = {
    item_type: f.elements.item_type.value, item_id: Number(f.elements.item_id.value),
    start_date: f.elements.start_date.value, end_date: f.elements.end_date.value,
    override_price: Number(f.elements.override_price.value), label: f.elements.label.value || null,
    is_active: true,
  };
  try {
    if (editingSeasonalId) await axios.put(`${API_BASE}/api/admin/pricing/seasonal/${editingSeasonalId}`, payload, { headers: authHeaders() });
    else await axios.post(`${API_BASE}/api/admin/pricing/seasonal`, payload, { headers: authHeaders() });
    editingSeasonalId = null;
    f.reset();
    msg.textContent = 'Saved.'; msg.className = 'msg success';
    loadSeasonalPrices();
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to save.'; msg.className = 'msg error';
  }
});

/* ---- Discount Campaigns ---- */
async function loadCampaigns() {
  const tbody = document.querySelector('#campaignsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/pricing/campaigns`, { headers: authHeaders() });
    tbody.innerHTML = data.map(c => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td style="text-transform:capitalize">${c.applicable_type ? escapeHtml(c.applicable_type) : 'All'}</td>
        <td>${c.discount_type === 'percent' ? c.discount_value + '%' : money(c.discount_value)}</td>
        <td>${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}</td>
        <td><span class="badge ${c.is_active ? 'active' : 'inactive'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-edit-campaign='${escapeHtml(JSON.stringify(c))}'>Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-campaign="${c.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6" class="empty-state">No campaigns yet.</td></tr>`;
    tbody.querySelectorAll('[data-edit-campaign]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = JSON.parse(btn.dataset.editCampaign);
        editingCampaignId = c.id;
        const f = document.getElementById('campaignForm');
        f.elements.name.value = c.name; f.elements.applicable_type.value = c.applicable_type || '';
        f.elements.discount_type.value = c.discount_type; f.elements.discount_value.value = c.discount_value;
        f.elements.start_date.value = c.start_date; f.elements.end_date.value = c.end_date;
        f.elements.description.value = c.description || '';
        f.scrollIntoView({ behavior: 'smooth' });
      });
    });
    tbody.querySelectorAll('[data-delete-campaign]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this campaign?')) return;
        try {
          await axios.delete(`${API_BASE}/api/admin/pricing/campaigns/${btn.dataset.deleteCampaign}`, { headers: authHeaders() });
          loadCampaigns();
        } catch (err) { alert('Failed to delete.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load campaigns.</td></tr>`;
  }
}
document.getElementById('campaignForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('campaignMsg');
  const payload = {
    name: f.elements.name.value, description: f.elements.description.value || null,
    discount_type: f.elements.discount_type.value, discount_value: Number(f.elements.discount_value.value),
    applicable_type: f.elements.applicable_type.value || null,
    start_date: f.elements.start_date.value, end_date: f.elements.end_date.value, is_active: true,
  };
  try {
    if (editingCampaignId) await axios.put(`${API_BASE}/api/admin/pricing/campaigns/${editingCampaignId}`, payload, { headers: authHeaders() });
    else await axios.post(`${API_BASE}/api/admin/pricing/campaigns`, payload, { headers: authHeaders() });
    editingCampaignId = null;
    f.reset();
    msg.textContent = 'Saved.'; msg.className = 'msg success';
    loadCampaigns();
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to save.'; msg.className = 'msg error';
  }
});

/* ---- Coupons ---- */
async function loadCoupons() {
  const tbody = document.querySelector('#couponsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/pricing/coupons`, { headers: authHeaders() });
    tbody.innerHTML = data.map(c => `
      <tr>
        <td><strong>${escapeHtml(c.code)}</strong></td>
        <td style="text-transform:capitalize">${c.applicable_type ? escapeHtml(c.applicable_type) : 'All'}</td>
        <td>${c.discount_type === 'percent' ? c.discount_value + '%' : money(c.discount_value)}</td>
        <td>${c.min_booking_amount ? money(c.min_booking_amount) : '—'}</td>
        <td>${c.times_used}${c.usage_limit ? ' / ' + c.usage_limit : ''}</td>
        <td>${fmtDate(c.valid_until)}</td>
        <td><span class="badge ${c.is_active ? 'active' : 'inactive'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-edit-coupon='${escapeHtml(JSON.stringify(c))}'>Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-coupon="${c.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="8" class="empty-state">No coupons yet.</td></tr>`;
    tbody.querySelectorAll('[data-edit-coupon]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = JSON.parse(btn.dataset.editCoupon);
        editingCouponId = c.id;
        const f = document.getElementById('couponForm');
        f.elements.code.value = c.code; f.elements.applicable_type.value = c.applicable_type || '';
        f.elements.discount_type.value = c.discount_type; f.elements.discount_value.value = c.discount_value;
        f.elements.min_booking_amount.value = c.min_booking_amount || '';
        f.elements.usage_limit.value = c.usage_limit || '';
        f.elements.valid_from.value = c.valid_from; f.elements.valid_until.value = c.valid_until;
        f.elements.description.value = c.description || '';
        f.scrollIntoView({ behavior: 'smooth' });
      });
    });
    tbody.querySelectorAll('[data-delete-coupon]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this coupon?')) return;
        try {
          await axios.delete(`${API_BASE}/api/admin/pricing/coupons/${btn.dataset.deleteCoupon}`, { headers: authHeaders() });
          loadCoupons();
        } catch (err) { alert('Failed to delete.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load coupons.</td></tr>`;
  }
}
document.getElementById('couponForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('couponMsg');
  const payload = {
    code: f.elements.code.value, description: f.elements.description.value || null,
    discount_type: f.elements.discount_type.value, discount_value: Number(f.elements.discount_value.value),
    applicable_type: f.elements.applicable_type.value || null,
    min_booking_amount: f.elements.min_booking_amount.value ? Number(f.elements.min_booking_amount.value) : null,
    usage_limit: f.elements.usage_limit.value ? Number(f.elements.usage_limit.value) : null,
    valid_from: f.elements.valid_from.value, valid_until: f.elements.valid_until.value, is_active: true,
  };
  try {
    if (editingCouponId) await axios.put(`${API_BASE}/api/admin/pricing/coupons/${editingCouponId}`, payload, { headers: authHeaders() });
    else await axios.post(`${API_BASE}/api/admin/pricing/coupons`, payload, { headers: authHeaders() });
    editingCouponId = null;
    f.reset();
    msg.textContent = 'Saved.'; msg.className = 'msg success';
    loadCoupons();
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to save.'; msg.className = 'msg error';
  }
});

/* ---------- Customer Management ---------- */
let customersPage = 1;
let customerSearchTimer;
const ACCOUNT_BADGE = (c) => {
  if (c.is_deleted) return '<span class="badge cancelled">Deleted</span>';
  if (c.is_blocked) return '<span class="badge cancelled">Blocked</span>';
  if (!c.is_active) return '<span class="badge inactive">Inactive</span>';
  return '<span class="badge active">Active</span>';
};

async function loadCustomerStats(targetId = 'customerStatGrid') {
  const el = document.getElementById(targetId);
  if (!el) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/customers/stats`, { headers: authHeaders() });
    el.innerHTML = `
      <div class="stat-card"><div class="stat-icon"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><line x1="7" y1="9" x2="17" y2="9"/></svg></div><div class="stat-body"><div class="num">${data.total_customers}</div><div class="label">Total Customers</div></div></div>
      <div class="stat-card"><div class="stat-icon emerald"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg></div><div class="stat-body"><div class="num">${data.online_customers}</div><div class="label">Online Customers</div></div></div>
      <div class="stat-card"><div class="stat-icon coral"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg></div><div class="stat-body"><div class="num">${data.blocked_customers}</div><div class="label">Blocked Customers</div></div></div>
      <div class="stat-card"><div class="stat-icon sky"><svg class="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div><div class="stat-body"><div class="num">${data.new_customers_today}</div><div class="label">New Today</div></div></div>
      <div class="stat-card"><div class="stat-icon gold"><svg class="icon" viewBox="0 0 24 24"><path d="m12 2 3.1 6.6 7.2.8-5.4 4.9 1.5 7.1L12 17.8 5.6 21.4l1.5-7.1-5.4-4.9 7.2-.8Z"/></svg></div><div class="stat-body"><div class="num" style="font-size:15px;">${data.most_active_customer ? escapeHtml(data.most_active_customer) : '—'}</div><div class="label">Most Active</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(18,183,106,0.12); color:var(--emerald);"><svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="stat-body"><div class="num" style="font-size:15px;">${data.highest_spending_customer ? escapeHtml(data.highest_spending_customer) : '—'}</div><div class="label">Highest Spending</div></div></div>
    `;
  } catch (err) { el.innerHTML = `<div class="msg error">Failed to load customer stats.</div>`; }
}

async function loadCustomers(page = customersPage) {
  customersPage = page;
  const tbody = document.querySelector('#customersTable tbody');
  const search = document.getElementById('customerSearch').value;
  const status = document.getElementById('customerStatusFilter').value;
  const sort = document.getElementById('customerSort').value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/customers`, {
      headers: authHeaders(),
      params: { search: search || undefined, status: status || undefined, sort, page, page_size: PAGE_SIZE },
    });
    renderPagination('customersPagination', data.page, data.total_pages, data.total, loadCustomers);
    tbody.innerHTML = data.items.map(c => {
      const initials = c.full_name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'C';
      return `
      <tr>
        <td>${c.profile_photo ? `<img class="cust-avatar" src="${escapeHtml(c.profile_photo)}">` : `<div class="cust-avatar">${initials}</div>`}</td>
        <td>
          <div style="font-weight:700;">${escapeHtml(c.full_name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">#${c.id} · ${escapeHtml(c.email)}</div>
        </td>
        <td>${c.mobile ? escapeHtml(c.mobile) : '—'}</td>
        <td>${fmtDate(c.created_at)}</td>
        <td>${c.last_login_at ? fmtDateTime(c.last_login_at) : '—'} <div style="font-size:11px;color:var(--text-muted);">${c.login_count} login${c.login_count === 1 ? '' : 's'}</div></td>
        <td>${c.login_count}</td>
        <td>${c.total_bookings}</td>
        <td class="text-emerald" style="font-weight:800;">${money(c.total_spend)}</td>
        <td>${c.total_payments}</td>
        <td>${c.reward_points}</td>
        <td><span class="status-dot-inline ${c.is_online ? 'online' : ''}"></span>${c.is_online ? 'Online' : 'Offline'}</td>
        <td>${ACCOUNT_BADGE(c)}</td>
        <td><button class="btn btn-ghost btn-sm" data-view-customer="${c.id}">View</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="13" class="empty-state">No customers found.</td></tr>`;
    tbody.querySelectorAll('[data-view-customer]').forEach(btn => {
      btn.addEventListener('click', () => openCustomerProfile(btn.dataset.viewCustomer));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-state">Failed to load customers.</td></tr>`;
  }
  loadCustomerStats();
}
document.getElementById('customerSearch').addEventListener('input', () => {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => loadCustomers(1), 350);
});
document.getElementById('customerStatusFilter').addEventListener('change', () => loadCustomers(1));
document.getElementById('customerSort').addEventListener('change', () => loadCustomers(1));

/* ---------- Customer profile modal ---------- */
const customerModalOverlay = document.getElementById('customerModalOverlay');
let currentCustomerId = null;
let currentCustomerData = null;

async function openCustomerProfile(id) {
  currentCustomerId = id;
  customerModalOverlay.classList.add('open');
  document.getElementById('custProfileName').textContent = 'Loading…';
  document.getElementById('custProfileMeta').textContent = '';
  document.getElementById('custProfileActions').innerHTML = '';
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/customers/${id}`, { headers: authHeaders() });
    currentCustomerData = data;
    renderCustomerProfile(data);
  } catch (err) {
    document.getElementById('custProfileName').textContent = 'Failed to load customer';
  }
}
document.getElementById('customerModalCloseBtn').addEventListener('click', () => customerModalOverlay.classList.remove('open'));

function renderCustomerProfile(c) {
  const initials = c.full_name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'C';
  document.getElementById('custProfileAvatar').innerHTML = c.profile_photo ? `<img src="${escapeHtml(c.profile_photo)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : initials;
  document.getElementById('custProfileName').textContent = c.full_name;
  document.getElementById('custProfileOnlineDot').className = `status-dot-inline ${c.session.is_online ? 'online' : ''}`;
  document.getElementById('custProfileBadges').innerHTML = `${ACCOUNT_BADGE(c)} ${c.is_verified ? '<span class="badge active">Verified</span>' : '<span class="badge pending">Unverified</span>'}`;
  document.getElementById('custProfileMeta').textContent = `#${c.id} · ${c.email} · ${c.mobile || 'No mobile on file'} · Joined ${fmtDate(c.created_at)}`;

  document.getElementById('custProfileActions').innerHTML = `
    <button class="btn btn-navy btn-sm" data-act="edit">Edit Customer</button>
    ${c.is_active
      ? '<button class="btn btn-danger btn-sm" data-act="deactivate">Deactivate</button>'
      : '<button class="btn btn-navy btn-sm" data-act="activate">Activate</button>'}
    ${c.is_blocked
      ? '<button class="btn btn-navy btn-sm" data-act="unblock">Unblock</button>'
      : '<button class="btn btn-danger btn-sm" data-act="block">Block</button>'}
    <button class="btn btn-ghost btn-sm" data-act="reset-password">Reset Password</button>
    <button class="btn btn-ghost btn-sm" data-act="force-logout">Force Logout</button>
    <button class="btn btn-ghost btn-sm" data-act="notify">Send Notification</button>
    <button class="btn btn-ghost btn-sm" data-act="email">Send Email</button>
    ${c.is_deleted
      ? '<button class="btn btn-navy btn-sm" data-act="restore">Restore</button>'
      : '<button class="btn btn-danger btn-sm" data-act="delete">Delete (Soft)</button>'}
  `;
  document.getElementById('custProfileActions').querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleCustomerAction(btn.dataset.act));
  });

  document.getElementById('custTab-overview').innerHTML = `
    <div class="analytics-grid">
      <div class="analytics-tile"><div class="num">${c.analytics.total_bookings}</div><div class="label">Total Bookings</div></div>
      <div class="analytics-tile"><div class="num">${c.analytics.completed_trips}</div><div class="label">Completed Trips</div></div>
      <div class="analytics-tile"><div class="num">${c.analytics.cancelled_trips}</div><div class="label">Cancelled Trips</div></div>
      <div class="analytics-tile"><div class="num">${money(c.analytics.total_spending)}</div><div class="label">Total Spending</div></div>
      <div class="analytics-tile"><div class="num">${money(c.analytics.average_booking_value)}</div><div class="label">Avg Booking Value</div></div>
      <div class="analytics-tile"><div class="num" style="font-size:14px;">${c.analytics.last_activity ? fmtDateTime(c.analytics.last_activity) : '—'}</div><div class="label">Last Activity</div></div>
    </div>
    <div class="analytics-grid">
      <div class="analytics-tile"><div class="num" style="font-size:14px;">${c.analytics.favorite_destination ? escapeHtml(c.analytics.favorite_destination) : '—'}</div><div class="label">Favorite Destination</div></div>
      <div class="analytics-tile"><div class="num" style="font-size:14px;">${c.analytics.favorite_hotel ? escapeHtml(c.analytics.favorite_hotel) : '—'}</div><div class="label">Favorite Hotel</div></div>
      <div class="analytics-tile"><div class="num" style="font-size:14px;">${c.analytics.favorite_cruise ? escapeHtml(c.analytics.favorite_cruise) : '—'}</div><div class="label">Favorite Cruise</div></div>
      <div class="analytics-tile"><div class="num" style="font-size:14px;">${c.analytics.favorite_package ? escapeHtml(c.analytics.favorite_package) : '—'}</div><div class="label">Favorite Package</div></div>
    </div>
    <h2 style="font-size:14px;margin-bottom:12px;">Personal &amp; contact information</h2>
    <div class="info-grid">
      <div class="info-item"><label>Gender</label><div>${c.gender ? escapeHtml(c.gender) : '—'}</div></div>
      <div class="info-item"><label>Date of Birth</label><div>${c.dob ? fmtDate(c.dob) : '—'}</div></div>
      <div class="info-item"><label>Address</label><div>${c.address ? escapeHtml(c.address) : '—'}</div></div>
      <div class="info-item"><label>City / State / Country</label><div>${[c.city, c.state, c.country].filter(Boolean).map(escapeHtml).join(', ') || '—'}</div></div>
      <div class="info-item"><label>Browser</label><div>${c.session.browser ? escapeHtml(c.session.browser) : '—'}</div></div>
      <div class="info-item"><label>Device</label><div>${c.session.device ? escapeHtml(c.session.device) : '—'}</div></div>
      <div class="info-item"><label>Operating System</label><div>${c.session.os ? escapeHtml(c.session.os) : '—'}</div></div>
      <div class="info-item"><label>Current / Last Page</label><div>${c.session.current_page ? escapeHtml(c.session.current_page) : '—'}</div></div>
    </div>
  `;

  document.getElementById('custTab-bookings').innerHTML = c.bookings.length
    ? `<div class="table-wrap"><table><thead><tr><th>Booking ID</th><th>Type</th><th>Destination</th><th>Travel Date</th><th>Amount</th><th>Status</th><th>Payment</th></tr></thead><tbody>${
        c.bookings.map(b => `<tr><td>#${b.id}</td><td style="text-transform:capitalize">${escapeHtml(b.booking_type)}</td><td>${escapeHtml(b.destination)}</td><td>${fmtDate(b.travel_date)}</td><td>${money(b.total_price)}</td><td><span class="badge ${b.status}">${escapeHtml(b.status)}</span></td><td>${b.payment_status ? `<span class="badge ${b.payment_status}">${escapeHtml(b.payment_status)}</span>` : '—'}</td></tr>`).join('')
      }</tbody></table></div>`
    : `<div class="empty-state">No bookings yet.</div>`;

  document.getElementById('custTab-payments').innerHTML = c.payments.length
    ? `<div class="table-wrap"><table><thead><tr><th>Transaction ID</th><th>Amount</th><th>Method</th><th>Date</th><th>Status</th><th>Invoice</th></tr></thead><tbody>${
        c.payments.map(p => `<tr><td>${escapeHtml(p.transaction_ref)}</td><td>${money(p.amount)}</td><td style="text-transform:capitalize">${escapeHtml(p.method)}</td><td>${fmtDateTime(p.created_at)}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td><td>${escapeHtml(p.transaction_ref)}</td></tr>`).join('')
      }</tbody></table></div>`
    : `<div class="empty-state">No payments yet.</div>`;

  document.getElementById('custTab-timeline').innerHTML = c.timeline.length
    ? `<div class="timeline">${c.timeline.map(t => `
        <div class="timeline-item">
          <span class="timeline-dot"></span>
          <div class="timeline-body">
            <div class="timeline-text">${ACTIVITY_EMOJI[t.activity_type] || '📌'} ${escapeHtml(t.description || t.activity_type || 'Activity')}</div>
            <div class="timeline-time">${fmtDateTime(t.created_at)}${t.module ? ' · ' + escapeHtml(t.module) : ''}</div>
          </div>
        </div>`).join('')}</div>`
    : `<div class="empty-state">No activity recorded yet.</div>`;

  document.getElementById('custTab-support').innerHTML = c.support_tickets.length
    ? `<div class="table-wrap"><table><thead><tr><th>Ticket #</th><th>Priority</th><th>Status</th><th>Created</th><th>Resolved</th></tr></thead><tbody>${
        c.support_tickets.map(t => `<tr><td>#${t.id}</td><td style="text-transform:capitalize">${escapeHtml(t.priority)}</td><td><span class="badge ${t.status === 'resolved' || t.status === 'closed' ? 'confirmed' : 'pending'}">${escapeHtml(t.status)}</span></td><td>${fmtDate(t.created_at)}</td><td>${t.resolved_at ? fmtDate(t.resolved_at) : '—'}</td></tr>`).join('')
      }</tbody></table></div>`
    : `<div class="empty-state">No support tickets yet.</div>`;

  document.getElementById('custTab-reviews').innerHTML = c.reviews.length
    ? `<div class="table-wrap"><table><thead><tr><th>Destination</th><th>Rating</th><th>Review</th><th>Date</th></tr></thead><tbody>${
        c.reviews.map(r => `<tr><td>${escapeHtml(r.destination)}</td><td>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</td><td>${r.comment ? escapeHtml(r.comment) : '—'}</td><td>${fmtDate(r.created_at)}</td></tr>`).join('')
      }</tbody></table></div>`
    : `<div class="empty-state">No reviews yet.</div>`;

  document.getElementById('custTab-wishlist').innerHTML = c.wishlist.length
    ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Destination / Package</th><th>Date Added</th></tr></thead><tbody>${
        c.wishlist.map(w => `<tr><td style="text-transform:capitalize">${escapeHtml(w.item_type)}</td><td>${escapeHtml(w.destination)}</td><td>${fmtDate(w.created_at)}</td></tr>`).join('')
      }</tbody></table></div>`
    : `<div class="empty-state">No wishlist items yet.</div>`;
}

document.getElementById('custProfileTabs').querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#custProfileTabs .profile-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.profile-tab-panel').forEach(p => p.classList.toggle('active', p.id === `custTab-${tab.dataset.tab}`));
  });
});

async function handleCustomerAction(action) {
  const id = currentCustomerId;
  const base = `${API_BASE}/api/admin/customers/${id}`;
  try {
    if (action === 'edit') return openCustomerEditModal();
    if (action === 'notify') return openCustomerMsgModal('notify');
    if (action === 'email') return openCustomerMsgModal('email');
    if (action === 'activate') await axios.patch(`${base}/activate`, {}, { headers: authHeaders() });
    else if (action === 'deactivate') await axios.patch(`${base}/deactivate`, {}, { headers: authHeaders() });
    else if (action === 'block') { if (!confirm('Block this customer? They will be unable to log in.')) return; await axios.patch(`${base}/block`, {}, { headers: authHeaders() }); }
    else if (action === 'unblock') await axios.patch(`${base}/unblock`, {}, { headers: authHeaders() });
    else if (action === 'reset-password') {
      const { data } = await axios.post(`${base}/reset-password`, {}, { headers: authHeaders() });
      alert(data.reset_link ? `Reset link generated:\n${location.origin}/reset-password.html?token=${new URLSearchParams(data.reset_link.split('?')[1]).get('token')}` : data.message);
    }
    else if (action === 'force-logout') { if (!confirm('Force-logout this customer from all sessions?')) return; await axios.post(`${base}/force-logout`, {}, { headers: authHeaders() }); }
    else if (action === 'delete') { if (!confirm('Soft-delete this customer? Their bookings/payments/history are preserved and this can be undone via Restore.')) return; await axios.delete(base, { headers: authHeaders() }); }
    else if (action === 'restore') await axios.post(`${base}/restore`, {}, { headers: authHeaders() });
    openCustomerProfile(id);
    loadCustomers(customersPage);
  } catch (err) {
    alert(err.response?.data?.detail || 'Action failed.');
  }
}

/* ---------- Customer edit modal ---------- */
const customerEditModalOverlay = document.getElementById('customerEditModalOverlay');
const customerEditForm = document.getElementById('customerEditForm');
function openCustomerEditModal() {
  const c = currentCustomerData;
  customerEditForm.reset();
  customerEditForm.elements.full_name.value = c.full_name;
  customerEditForm.elements.email.value = c.email;
  customerEditForm.elements.mobile.value = c.mobile || '';
  customerEditForm.elements.gender.value = c.gender || '';
  customerEditForm.elements.dob.value = c.dob || '';
  customerEditForm.elements.country.value = c.country || '';
  customerEditForm.elements.state.value = c.state || '';
  customerEditForm.elements.city.value = c.city || '';
  customerEditForm.elements.address.value = c.address || '';
  customerEditForm.elements.is_verified.checked = c.is_verified;
  document.getElementById('customerEditMsg').textContent = '';
  customerEditModalOverlay.classList.add('open');
}
document.getElementById('customerEditCancelBtn').addEventListener('click', () => customerEditModalOverlay.classList.remove('open'));
customerEditForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('customerEditMsg');
  const f = customerEditForm.elements;
  const payload = {
    full_name: f.full_name.value, email: f.email.value, mobile: f.mobile.value || null,
    gender: f.gender.value || null, dob: f.dob.value || null, country: f.country.value || null,
    state: f.state.value || null, city: f.city.value || null, address: f.address.value || null,
    is_verified: f.is_verified.checked,
  };
  try {
    const { data } = await axios.put(`${API_BASE}/api/admin/customers/${currentCustomerId}`, payload, { headers: authHeaders() });
    customerEditModalOverlay.classList.remove('open');
    currentCustomerData = data;
    renderCustomerProfile(data);
    loadCustomers(customersPage);
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to save changes.';
    msg.className = 'msg error';
  }
});

/* ---------- Customer notify / email modal (shared) ---------- */
const customerMsgModalOverlay = document.getElementById('customerMsgModalOverlay');
const customerMsgForm = document.getElementById('customerMsgForm');
let customerMsgMode = 'notify';
function openCustomerMsgModal(mode) {
  customerMsgMode = mode;
  customerMsgForm.reset();
  document.getElementById('customerMsgFormMsg').textContent = '';
  document.getElementById('customerMsgModalTitle').textContent = mode === 'email' ? 'Send Email' : 'Send Notification';
  document.getElementById('customerMsgTitleLabel').textContent = mode === 'email' ? 'Subject' : 'Title';
  customerMsgModalOverlay.classList.add('open');
}
document.getElementById('customerMsgCancelBtn').addEventListener('click', () => customerMsgModalOverlay.classList.remove('open'));
customerMsgForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('customerMsgFormMsg');
  const f = customerMsgForm.elements;
  const endpoint = customerMsgMode === 'email' ? 'send-email' : 'notify';
  const payload = customerMsgMode === 'email'
    ? { subject: f.title.value, message: f.message.value }
    : { title: f.title.value, message: f.message.value };
  try {
    const { data } = await axios.post(`${API_BASE}/api/admin/customers/${currentCustomerId}/${endpoint}`, payload, { headers: authHeaders() });
    msg.textContent = data.message;
    msg.className = 'msg success';
    setTimeout(() => customerMsgModalOverlay.classList.remove('open'), 900);
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to send.';
    msg.className = 'msg error';
  }
});

/* ---------- User Analytics ---------- */
async function loadUserAnalytics() {
  const statGrid = document.getElementById('userAnalyticsStatGrid');
  const byRoleEl = document.getElementById('userAnalyticsByRole');
  const recentEl = document.getElementById('userAnalyticsRecent');
  try {
    const [{ data: reports }, { data: usersPage }] = await Promise.all([
      axios.get(`${API_BASE}/api/admin/reports`, { headers: authHeaders() }),
      axios.get(`${API_BASE}/api/admin/users`, { headers: authHeaders(), params: { page: 1, page_size: 1000 } }),
    ]);
    const inactive = reports.total_users - reports.active_users;
    statGrid.innerHTML = `
      <div class="stat-card"><div class="stat-icon"><svg class="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div><div class="stat-body"><div class="num">${reports.total_users}</div><div class="label">Total Users</div></div></div>
      <div class="stat-card"><div class="stat-icon emerald"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/></svg></div><div class="stat-body"><div class="num">${reports.active_users}</div><div class="label">Active</div></div></div>
      <div class="stat-card"><div class="stat-icon coral"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg></div><div class="stat-body"><div class="num">${inactive}</div><div class="label">Inactive</div></div></div>
    `;
    const roleCounts = {};
    usersPage.items.forEach(u => { roleCounts[u.role] = (roleCounts[u.role] || 0) + 1; });
    const roleRows = Object.entries(roleCounts);
    byRoleEl.outerHTML = roleRows.length
      ? `<div class="table-wrap"><table id="userAnalyticsByRole"><thead><tr><th>Role</th><th>Count</th></tr></thead><tbody>${
          roleRows.map(([role, count]) => `<tr><td style="text-transform:capitalize">${role}</td><td>${count}</td></tr>`).join('')
        }</tbody></table></div>`
      : '<div class="empty-state" id="userAnalyticsByRole">No users yet.</div>';
    recentEl.outerHTML = reports.recent_users.length
      ? `<div class="table-wrap"><table id="userAnalyticsRecent"><thead><tr><th>Name</th><th>Email</th><th>Joined</th></tr></thead><tbody>${
          reports.recent_users.map(u => `<tr><td>${escapeHtml(u.full_name)}</td><td>${escapeHtml(u.email)}</td><td>${fmtDate(u.created_at)}</td></tr>`).join('')
        }</tbody></table></div>`
      : '<div class="empty-state" id="userAnalyticsRecent">No users yet.</div>';
  } catch (err) {
    statGrid.innerHTML = `<div class="msg error">Failed to load user analytics.</div>`;
  }
}

/* ---------- Reports (CSV export hub) ---------- */
async function loadReportsExport() {
  const el = document.getElementById('reportsExportBookingsByType');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/reports`, { headers: authHeaders() });
    const types = Object.entries(data.bookings_by_type);
    el.outerHTML = types.length
      ? `<div class="table-wrap"><table id="reportsExportBookingsByType"><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>${
          types.map(([type, count]) => `<tr><td style="text-transform:capitalize">${type}</td><td>${count}</td></tr>`).join('')
        }</tbody></table></div>`
      : '<div class="empty-state" id="reportsExportBookingsByType">No bookings yet.</div>';
    renderTopList('reportsTopDestinations', data.top_destinations);
    renderTopList('reportsTopPackages', data.top_packages);
  } catch (err) {
    el.textContent = 'Failed to load report summary.';
  }
}
document.getElementById('reportsPrintBtn').addEventListener('click', () => {
  document.getElementById('section-reports-export').classList.add('print-target-section');
  document.body.classList.add('printing-section');
  window.print();
  setTimeout(() => {
    document.getElementById('section-reports-export').classList.remove('print-target-section');
    document.body.classList.remove('printing-section');
  }, 500);
});

/* ---------- Profile (admin's own account) ---------- */
async function loadAdminProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
    document.getElementById('adminProfileName').value = data.full_name;
    document.getElementById('adminProfileEmail').value = data.email;
  } catch (err) { /* fields stay blank */ }
}
document.getElementById('adminProfileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('adminProfileMsg');
  try {
    const { data } = await axios.put(`${API_BASE}/api/users/me`, { full_name: document.getElementById('adminProfileName').value }, { headers: authHeaders() });
    localStorage.setItem('jwt_user_name', data.full_name);
    document.getElementById('adminChipName').textContent = data.full_name;
    msg.textContent = 'Profile updated.';
    msg.className = 'msg success';
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to update profile.';
    msg.className = 'msg error';
  }
});
document.getElementById('adminPasswordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('adminPasswordMsg');
  try {
    await axios.post(`${API_BASE}/api/users/change-password`, {
      current_password: document.getElementById('adminCurrentPassword').value,
      new_password: document.getElementById('adminNewPassword').value,
    }, { headers: authHeaders() });
    msg.textContent = 'Password changed successfully.';
    msg.className = 'msg success';
    e.target.reset();
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Failed to change password.';
    msg.className = 'msg error';
  }
});

/* ---------- Bookings ---------- */
async function loadBookings(page = bookingsPage) {
  bookingsPage = page;
  const tbody = document.querySelector('#bookingsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings`, { headers: authHeaders(), params: { page, page_size: PAGE_SIZE } });
    renderPagination('bookingsPagination', data.page, data.total_pages, data.total, loadBookings);
    tbody.innerHTML = data.items.map(b => `
      <tr>
        <td>${escapeHtml(b.user_email)}</td>
        <td style="text-transform:capitalize">${escapeHtml(b.booking_type)}</td>
        <td>#${b.item_id}</td>
        <td>${money(b.total_price)}</td>
        <td>${fmtDate(b.travel_date)}</td>
        <td>
          <select class="status-select" data-booking-id="${b.id}">
            ${['pending', 'confirmed', 'cancelled'].map(s => `<option value="${s}" ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6" class="empty-state">No bookings yet.</td></tr>`;
    tbody.querySelectorAll('[data-booking-id]').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          await axios.patch(`${API_BASE}/api/admin/bookings/${sel.dataset.bookingId}`, { status: sel.value }, { headers: authHeaders() });
          loadPayments();
        } catch (err) { alert('Failed to update booking status.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load bookings.</td></tr>`;
  }
}

/* ---------- Payments ---------- */
async function loadPayments(page = paymentsPage) {
  paymentsPage = page;
  const tbody = document.querySelector('#paymentsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/payments`, { headers: authHeaders(), params: { page, page_size: PAGE_SIZE } });
    renderPagination('paymentsPagination', data.page, data.total_pages, data.total, loadPayments);
    tbody.innerHTML = data.items.map(p => `
      <tr>
        <td>${escapeHtml(p.user_email)}</td>
        <td>${money(p.amount)}</td>
        <td style="text-transform:capitalize">${escapeHtml(p.method)}</td>
        <td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td>
        <td>${escapeHtml(p.transaction_ref)}</td>
        <td>${fmtDate(p.created_at)}</td>
      </tr>
    `).join('') || `<tr><td colspan="6" class="empty-state">No payments yet.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load payments.</td></tr>`;
  }
}

/* ---------- Contact ---------- */
async function loadContact(page = contactPage) {
  contactPage = page;
  const tbody = document.querySelector('#contactTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/contact`, { headers: authHeaders(), params: { page, page_size: PAGE_SIZE } });
    renderPagination('contactPagination', data.page, data.total_pages, data.total, loadContact);
    tbody.innerHTML = data.items.map(c => `
      <tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.email)}</td><td>${c.subject ? escapeHtml(c.subject) : '—'}</td><td>${escapeHtml(c.message)}</td><td>${fmtDate(c.created_at)}</td><td><button class="btn btn-sm btn-danger" data-delete-contact="${c.id}">Delete</button></td></tr>
    `).join('') || `<tr><td colspan="6" class="empty-state">No messages yet.</td></tr>`;
    tbody.querySelectorAll('[data-delete-contact]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this message?')) return;
        try {
          await axios.delete(`${API_BASE}/api/admin/contact/${btn.dataset.deleteContact}`, { headers: authHeaders() });
          loadContact();
        } catch (err) { alert('Failed to delete message.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load messages.</td></tr>`;
  }
}

/* ---------- Newsletter ---------- */
async function loadNewsletter() {
  const tbody = document.querySelector('#newsletterTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/newsletter`, { headers: authHeaders() });
    tbody.innerHTML = data.map(n => `<tr><td>${n.email}</td><td>${fmtDate(n.subscribed_at)}</td></tr>`).join('')
      || `<tr><td colspan="2" class="empty-state">No subscribers yet.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="2" class="empty-state">Failed to load subscribers.</td></tr>`;
  }
}

/* ---------- Content CRUD (Flights / Hotels / Cruises / Packages) ---------- */
const contentConfig = {
  flights: {
    endpoint: 'flights', title: 'Flights',
    columns: [
      { key: 'airline', label: 'Airline' },
      { key: 'from_airport', label: 'From' },
      { key: 'to_airport', label: 'To' },
      { key: 'departure_time', label: 'Departs', fmt: v => new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) },
      { key: 'cabin_class', label: 'Cabin' },
      { key: 'price', label: 'Price', fmt: money },
      { key: 'seats_available', label: 'Seats' },
    ],
    fields: [
      { key: 'airline', label: 'Airline', type: 'text' },
      { key: 'from_airport', label: 'From Airport', type: 'text' },
      { key: 'to_airport', label: 'To Airport', type: 'text' },
      { key: 'departure_time', label: 'Departure', type: 'datetime-local' },
      { key: 'arrival_time', label: 'Arrival', type: 'datetime-local' },
      { key: 'cabin_class', label: 'Cabin Class', type: 'text', default: 'Economy' },
      { key: 'price', label: 'Price (₹)', type: 'number' },
      { key: 'seats_available', label: 'Seats Available', type: 'number', default: 0 },
    ],
  },
  hotels: {
    endpoint: 'hotels', title: 'Hotels',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'location', label: 'Location' },
      { key: 'price_per_night', label: 'Price/night', fmt: money }, { key: 'rating', label: 'Rating' },
      { key: 'rooms_available', label: 'Rooms' },
    ],
    fields: [
      { key: 'name', label: 'Hotel Name', type: 'text' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'price_per_night', label: 'Price/night (₹)', type: 'number' },
      { key: 'rating', label: 'Rating', type: 'number', step: '0.1', default: 4.5 },
      { key: 'amenities', label: 'Amenities', type: 'text' },
      { key: 'image_url', label: 'Image URL', type: 'text' },
      { key: 'rooms_available', label: 'Rooms Available', type: 'number', default: 0 },
    ],
  },
  cruises: {
    endpoint: 'cruises', title: 'Cruises',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'cruise_type', label: 'Type' }, { key: 'departure_port', label: 'Departs From' },
      { key: 'duration_days', label: 'Days' }, { key: 'price', label: 'Price', fmt: money }, { key: 'departure_month', label: 'Month' },
    ],
    fields: [
      { key: 'name', label: 'Cruise Name', type: 'text' },
      { key: 'cruise_type', label: 'Cruise Type', type: 'text' },
      { key: 'departure_port', label: 'Departure Port', type: 'text' },
      { key: 'duration_days', label: 'Duration (Days)', type: 'number' },
      { key: 'price', label: 'Price (₹)', type: 'number' },
      { key: 'departure_month', label: 'Departure Month', type: 'text' },
    ],
  },
  packages: {
    endpoint: 'packages', title: 'Tour Packages',
    columns: [
      { key: 'title', label: 'Title' }, { key: 'package_type', label: 'Type' }, { key: 'duration_days', label: 'Days' },
      { key: 'price', label: 'Price', fmt: money }, { key: 'rating', label: 'Rating' }, { key: 'available_month', label: 'Month' },
    ],
    fields: [
      { key: 'title', label: 'Package Title', type: 'text' },
      { key: 'package_type', label: 'Package Type', type: 'text' },
      { key: 'duration_days', label: 'Duration (Days)', type: 'number' },
      { key: 'price', label: 'Price (₹)', type: 'number' },
      { key: 'rating', label: 'Rating', type: 'number', step: '0.1', default: 4.5 },
      { key: 'available_month', label: 'Available Month', type: 'text' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'image_url', label: 'Image URL', type: 'text' },
    ],
  },
};

const contentEditState = {};

function renderContentSection(name) {
  const cfg = contentConfig[name];
  const singular = cfg.title.replace(/s$/, '');
  const section = document.getElementById(`section-${name}`);
  section.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2 id="formTitle-${name}">Add new ${singular}</h2>
        <button type="button" class="btn btn-ghost btn-sm" id="cancelEdit-${name}" style="display:none;">Cancel edit</button>
      </div>
      <form id="form-${name}">
        <div class="form-grid">
          ${cfg.fields.map(f => `
            <div class="form-field">
              <label>${f.label}</label>
              <input name="${f.key}" type="${f.type}" ${f.step ? `step="${f.step}"` : ''} value="${f.default ?? ''}" ${f.type !== 'text' ? 'required' : ''}>
            </div>
          `).join('')}
        </div>
        <button type="submit" class="btn btn-coral" id="submitBtn-${name}">Add ${singular}</button>
        <div class="msg" id="msg-${name}"></div>
      </form>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h2>${cfg.title}</h2>
        <button class="btn btn-ghost btn-sm" data-export="${cfg.endpoint}">Export CSV</button>
      </div>
      <div class="table-wrap">
        <table id="table-${name}">
          <thead><tr>${cfg.columns.map(c => `<th>${c.label}</th>`).join('')}<th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;

  contentEditState[name] = null;

  function resetToAddMode() {
    contentEditState[name] = null;
    document.getElementById(`formTitle-${name}`).textContent = `Add new ${singular}`;
    document.getElementById(`submitBtn-${name}`).textContent = `Add ${singular}`;
    document.getElementById(`cancelEdit-${name}`).style.display = 'none';
    document.getElementById(`form-${name}`).reset();
  }

  document.getElementById(`cancelEdit-${name}`).addEventListener('click', resetToAddMode);

  document.getElementById(`form-${name}`).addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const payload = {};
    cfg.fields.forEach(f => {
      const raw = form.elements[f.key].value;
      payload[f.key] = f.type === 'number' ? Number(raw) : raw;
    });
    const msg = document.getElementById(`msg-${name}`);
    const editId = contentEditState[name];
    try {
      if (editId) {
        await axios.put(`${API_BASE}/api/${cfg.endpoint}/${editId}`, payload, { headers: authHeaders() });
        msg.textContent = 'Updated successfully.';
      } else {
        await axios.post(`${API_BASE}/api/${cfg.endpoint}`, payload, { headers: authHeaders() });
        msg.textContent = 'Added successfully.';
      }
      msg.className = 'msg success';
      resetToAddMode();
      loadContentTable(name);
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to save.';
      msg.className = 'msg error';
    }
  });

  loadContentTable(name);
}

function editContentItem(name, item) {
  const cfg = contentConfig[name];
  const singular = cfg.title.replace(/s$/, '');
  contentEditState[name] = item.id;
  document.getElementById(`formTitle-${name}`).textContent = `Edit ${singular}`;
  document.getElementById(`submitBtn-${name}`).textContent = `Save ${singular}`;
  document.getElementById(`cancelEdit-${name}`).style.display = '';
  const form = document.getElementById(`form-${name}`);
  cfg.fields.forEach(f => {
    const value = item[f.key];
    if (f.type === 'datetime-local' && value) {
      form.elements[f.key].value = value.slice(0, 16);
    } else {
      form.elements[f.key].value = value ?? '';
    }
  });
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadContentTable(name) {
  const cfg = contentConfig[name];
  const tbody = document.querySelector(`#table-${name} tbody`);
  try {
    const { data } = await axios.get(`${API_BASE}/api/${cfg.endpoint}`, { headers: authHeaders() });
    tbody.innerHTML = data.map(item => `
      <tr>
        ${cfg.columns.map(c => `<td>${c.fmt ? c.fmt(item[c.key]) : (item[c.key] ?? '—')}</td>`).join('')}
        <td style="white-space:nowrap;">
          <button class="btn btn-sm btn-ghost" data-edit-id="${item.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-delete-id="${item.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="${cfg.columns.length + 1}" class="empty-state">Nothing here yet.</td></tr>`;
    tbody.querySelectorAll('[data-edit-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = data.find(d => String(d.id) === btn.dataset.editId);
        if (item) editContentItem(name, item);
      });
    });
    tbody.querySelectorAll('[data-delete-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this item?')) return;
        try {
          await axios.delete(`${API_BASE}/api/${cfg.endpoint}/${btn.dataset.deleteId}`, { headers: authHeaders() });
          loadContentTable(name);
        } catch (err) { alert('Failed to delete.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="${cfg.columns.length + 1}" class="empty-state">Failed to load.</td></tr>`;
  }
}

/* ---------- Reviews (admin) ---------- */
async function loadReviewsAdmin(page = reviewsPage) {
  reviewsPage = page;
  const tbody = document.querySelector('#reviewsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/reviews`, { headers: authHeaders(), params: { page, page_size: PAGE_SIZE } });
    renderPagination('reviewsPagination', data.page, data.total_pages, data.total, loadReviewsAdmin);
    tbody.innerHTML = data.items.map(r => `
      <tr>
        <td>${escapeHtml(r.user_email)}</td>
        <td style="text-transform:capitalize">${escapeHtml(r.item_type)} #${r.item_id}</td>
        <td>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</td>
        <td>${r.comment ? escapeHtml(r.comment) : '—'}</td>
        <td>${fmtDate(r.created_at)}</td>
        <td><button class="btn btn-sm btn-danger" data-delete-review="${r.id}">Delete</button></td>
      </tr>
    `).join('') || `<tr><td colspan="6" class="empty-state">No reviews yet.</td></tr>`;
    tbody.querySelectorAll('[data-delete-review]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this review?')) return;
        try {
          await axios.delete(`${API_BASE}/api/admin/reviews/${btn.dataset.deleteReview}`, { headers: authHeaders() });
          loadReviewsAdmin();
        } catch (err) { alert('Failed to delete review.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load reviews.</td></tr>`;
  }
}

/* ---------- Wishlist (admin) ---------- */
async function loadWishlistAdmin(page = wishlistPage) {
  wishlistPage = page;
  const tbody = document.querySelector('#wishlistTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/wishlist`, { headers: authHeaders(), params: { page, page_size: PAGE_SIZE } });
    renderPagination('wishlistPagination', data.page, data.total_pages, data.total, loadWishlistAdmin);
    tbody.innerHTML = data.items.map(w => `
      <tr>
        <td>${escapeHtml(w.user_email)}</td>
        <td style="text-transform:capitalize">${escapeHtml(w.item_type)} #${w.item_id}</td>
        <td>${fmtDate(w.created_at)}</td>
        <td><button class="btn btn-sm btn-danger" data-delete-wishlist="${w.id}">Delete</button></td>
      </tr>
    `).join('') || `<tr><td colspan="4" class="empty-state">No wishlist entries yet.</td></tr>`;
    tbody.querySelectorAll('[data-delete-wishlist]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this wishlist entry?')) return;
        try {
          await axios.delete(`${API_BASE}/api/admin/wishlist/${btn.dataset.deleteWishlist}`, { headers: authHeaders() });
          loadWishlistAdmin();
        } catch (err) { alert('Failed to delete entry.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Failed to load wishlist.</td></tr>`;
  }
}

/* ---------- Notifications (admin) ---------- */
async function initNotificationForm() {
  const select = document.getElementById('notificationRecipient');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/users`, { headers: authHeaders(), params: { page: 1, page_size: 1000 } });
    select.insertAdjacentHTML('beforeend', data.items.map(u => `<option value="${u.id}">${escapeHtml(u.full_name)} (${escapeHtml(u.email)})</option>`).join(''));
  } catch (err) { /* recipient list stays at "All Users" only */ }

  document.getElementById('notificationForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const msg = document.getElementById('notificationMsg');
    const payload = {
      user_id: form.elements.user_id.value ? Number(form.elements.user_id.value) : null,
      title: form.elements.title.value,
      message: form.elements.message.value,
    };
    try {
      const { data } = await axios.post(`${API_BASE}/api/admin/notifications`, payload, { headers: authHeaders() });
      msg.textContent = data.message;
      msg.className = 'msg success';
      form.reset();
      loadNotificationsAdmin(1);
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to send notification.';
      msg.className = 'msg error';
    }
  });

  await loadNotificationsAdmin();
}

async function loadNotificationsAdmin(page = notificationsPage) {
  notificationsPage = page;
  const tbody = document.querySelector('#notificationsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/notifications`, { headers: authHeaders(), params: { page, page_size: PAGE_SIZE } });
    renderPagination('notificationsPagination', data.page, data.total_pages, data.total, loadNotificationsAdmin);
    tbody.innerHTML = data.items.map(n => `
      <tr>
        <td>${escapeHtml(n.user_email)}</td>
        <td>${escapeHtml(n.title)}</td>
        <td>${escapeHtml(n.message)}</td>
        <td><span class="badge ${n.is_read ? 'read' : 'unread'}">${n.is_read ? 'Read' : 'Unread'}</span></td>
        <td>${fmtDate(n.created_at)}</td>
      </tr>
    `).join('') || `<tr><td colspan="5" class="empty-state">No notifications yet.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Failed to load notifications.</td></tr>`;
  }
}

/* ---------- User Activity Monitor (admin) ---------- */
let activityFilterPopulated = false;
async function loadActivityLog(page = activityPage) {
  activityPage = page;
  const tbody = document.querySelector('#activityTable tbody');
  const search = document.getElementById('activitySearch').value;
  const action = document.getElementById('activityFilter').value;
  const module = document.getElementById('activityModuleFilter').value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/activity-logs`, {
      params: { search: search || undefined, action: action || undefined, module: module || undefined, page, page_size: PAGE_SIZE },
      headers: authHeaders(),
    });
    renderPagination('activityPagination', data.page, data.total_pages, data.total, loadActivityLog);
    tbody.innerHTML = data.items.map(a => `
      <tr>
        <td>${fmtDateTime(a.created_at)}</td>
        <td>${a.user_name ? escapeHtml(a.user_name) : '—'}</td>
        <td>${a.user_email ? escapeHtml(a.user_email) : '—'}</td>
        <td>${a.user_id ?? '—'}</td>
        <td>${a.activity_type ? escapeHtml(a.activity_type) : '—'}</td>
        <td>${a.module ? escapeHtml(a.module) : '—'}</td>
        <td>${escapeHtml(a.description || a.action)}</td>
        <td>${a.ip_address ? escapeHtml(a.ip_address) : '—'}</td>
        <td>${a.browser ? escapeHtml(a.browser) : '—'}</td>
        <td>${a.device ? escapeHtml(a.device) : '—'}</td>
        <td><span class="badge ${a.status === 'failed' ? 'failed' : 'success'}">${escapeHtml(a.status)}</span></td>
      </tr>
    `).join('') || `<tr><td colspan="11" class="empty-state">No activity recorded yet.</td></tr>`;
    if (!activityFilterPopulated) {
      activityFilterPopulated = true;
      const [{ data: actions }, { data: modules }] = await Promise.all([
        axios.get(`${API_BASE}/api/admin/activity-logs/actions`, { headers: authHeaders() }),
        axios.get(`${API_BASE}/api/admin/activity-logs/modules`, { headers: authHeaders() }),
      ]);
      document.getElementById('activityFilter').insertAdjacentHTML(
        'beforeend', actions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')
      );
      document.getElementById('activityModuleFilter').insertAdjacentHTML(
        'beforeend', modules.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
      );
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state">Failed to load activity log.</td></tr>`;
  }
}
let activitySearchTimer;
document.getElementById('activitySearch').addEventListener('input', () => {
  clearTimeout(activitySearchTimer);
  activitySearchTimer = setTimeout(() => loadActivityLog(1), 350);
});
document.getElementById('activityFilter').addEventListener('change', () => loadActivityLog(1));
document.getElementById('activityModuleFilter').addEventListener('change', () => loadActivityLog(1));

/* Live-refresh the activity monitor table every 15s while it's the visible section */
setInterval(() => {
  if (document.getElementById('section-activity').classList.contains('active')) loadActivityLog(activityPage);
}, 15000);

/* ---------- UI-only additions: theme, sidebar collapse, mobile nav, header chip, clock ---------- */
/* Purely presentational — no API calls, no changes to any function above this point. */

(function initAdminChip() {
  const name = localStorage.getItem('jwt_user_name') || 'Admin';
  const roleVal = localStorage.getItem('jwt_user_role') || 'admin';
  document.getElementById('adminChipName').textContent = name;
  document.getElementById('adminChipRole').textContent = roleVal;
  const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'A';
  document.getElementById('adminAvatar').textContent = initials;
})();

(function initClock() {
  const el = document.getElementById('currentDate');
  const fmt = () => el.textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  fmt();
  setInterval(fmt, 60000);
})();

(function initTheme() {
  const THEME_KEY = 'admin_ui_theme';
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  function resolvedTheme(choice) {
    return choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice;
  }
  function apply(choice) {
    document.documentElement.setAttribute('data-theme', resolvedTheme(choice));
    document.querySelectorAll('.theme-selector-btn').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === choice));
    if (typeof revenueChartInstance !== 'undefined' && revenueChartInstance) loadMonthlyCharts();
    if (typeof lastReportsData !== 'undefined' && lastReportsData) {
      renderBookingSourcesChart(Object.entries(lastReportsData.bookings_by_type));
    }
  }
  const stored = localStorage.getItem(THEME_KEY) || 'light';
  apply(stored);
  document.querySelectorAll('.theme-selector-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.themeChoice;
      localStorage.setItem(THEME_KEY, choice);
      apply(choice);
    });
  });
  systemDark.addEventListener('change', () => {
    if (localStorage.getItem(THEME_KEY) === 'system') apply('system');
  });
})();

(function initSidebarCollapse() {
  const COLLAPSE_KEY = 'admin_sidebar_collapsed';
  const layout = document.getElementById('layoutRoot');
  if (localStorage.getItem(COLLAPSE_KEY) === '1') layout.classList.add('collapsed');
  document.getElementById('sidebarCollapseBtn').addEventListener('click', () => {
    const collapsed = layout.classList.toggle('collapsed');
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  });
})();

(function initMobileNav() {
  const layout = document.getElementById('layoutRoot');
  const open = () => layout.classList.add('mobile-open');
  const close = () => layout.classList.remove('mobile-open');
  document.getElementById('mobileMenuBtn').addEventListener('click', open);
  document.getElementById('sidebarBackdrop').addEventListener('click', close);
  document.querySelectorAll('.nav-item[data-section]').forEach(link => link.addEventListener('click', close));
})();

/* ---------- Notification bell (admin's own notifications) ---------- */
async function loadNotifBell() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/notifications`, { headers: authHeaders() });
    const unread = data.filter(n => !n.is_read).length;
    const dot = document.getElementById('notifDot');
    dot.style.display = unread ? 'flex' : 'none';
    dot.textContent = unread > 9 ? '9+' : String(unread);
    const list = document.getElementById('notifDropdownList');
    list.innerHTML = data.length
      ? data.slice(0, 15).map(n => `
          <div class="notif-dropdown-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.id}">
            <div class="n-title">${escapeHtml(n.title)}</div>
            <div class="n-msg">${escapeHtml(n.message)}</div>
            <div class="n-time">${fmtDateTime(n.created_at)}</div>
          </div>`).join('')
      : `<div class="empty-state">No notifications yet.</div>`;
    list.querySelectorAll('[data-notif-id]').forEach(item => {
      item.addEventListener('click', async () => {
        try {
          await axios.patch(`${API_BASE}/api/notifications/${item.dataset.notifId}/read`, {}, { headers: authHeaders() });
          loadNotifBell();
        } catch (err) { /* ignore */ }
      });
    });
  } catch (err) { /* bell just won't refresh this cycle */ }
}
document.getElementById('notifBellBtn').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('notifDropdown').classList.toggle('open');
});
document.addEventListener('click', e => {
  const dropdown = document.getElementById('notifDropdown');
  if (dropdown.classList.contains('open') && !e.target.closest('.icon-btn-wrap')) dropdown.classList.remove('open');
});
loadNotifBell();
setInterval(loadNotifBell, 15000);

/* ---------- Presence heartbeat: reports this admin as "online" for the online-users widget ---------- */
function sendHeartbeat() {
  const label = sectionTitles[document.querySelector('.nav-item[data-section].active')?.dataset.section] || 'Admin Dashboard';
  axios.post(`${API_BASE}/api/users/heartbeat`, { current_page: `Admin: ${label}` }, { headers: authHeaders() }).catch(() => {});
}
sendHeartbeat();
setInterval(sendHeartbeat, 30000);

loadReports();
