'use strict';
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

/* Escape user-supplied text before inserting into innerHTML templates */
/* escapeHtml/money/fmtDate/fmtDateTime/fmtTime now live in shared/formatters.js. */
function statusLabel(s) { return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

/* THE USERS TABLE HAS NO `username` COLUMN — this platform signs in by email
   (models_v2.User has email + password_hash and nothing else identity-wise), so
   the username IS the local part of the address. Callers keep the full address
   on the cell's `title`, because two accounts on different domains can share a
   local part and the short form alone would not tell them apart. */
function usernameOf(email) { return (email || '').split('@')[0] || '—'; }

/* authHeaders(), getStoredAuth(), clearStoredAuth() now live in assets/js/auth.js. */

/* A 401 from any API call means the session is gone (expired, revoked, or never valid).
   Try one silent refresh first (see auth.js::handlePortalUnauthorized) — only bounce back to
   the auth shell once that's failed too. */
axios.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401) {
      const retried = await handlePortalUnauthorized('admin', err);
      if (retried) return retried;
      clearStoredAuth();
      showAdminAuthShell();
    }
    return Promise.reject(err);
  }
);

function showAdminAuthShell() {
  document.getElementById('adminAuthShell').style.display = 'flex';
  document.getElementById('layoutRoot').style.display = 'none';
}
function showAdminPortal() {
  document.getElementById('adminAuthShell').style.display = 'none';
  document.getElementById('layoutRoot').style.display = '';
  const user = getPortalUser('admin') || {};
  const name = user.full_name || getStoredAuth().name || 'Admin';
  document.getElementById('adminChipName').textContent = name;
  document.getElementById('adminChipRole').textContent = 'Administrator';
  document.getElementById('adminAvatar').textContent = (name.trim()[0] || 'A').toUpperCase();
  document.getElementById('adminName').textContent = name;
  startAdminPolling();
}
function isAdminLoggedIn() { return !!localStorage.getItem('jwt_access'); }

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

document.getElementById('logoutBtn').addEventListener('click', async e => {
  e.preventDefault();
  await logoutPortalSession('admin');
  showAdminAuthShell();
});

/* ---------- Section navigation ---------- */
const sectionTitles = {
  reports: 'Dashboard', users: 'Merchant Management', 'active-users': 'Active Users',
  support: 'Support Management', 'reports-export': 'Reports', analytics: 'Analytics',
  payments: 'Payment Management',
  'partner-requests': 'Approval Queue', 'service-requests-mgmt': 'Service Request Management',
  'ticket-enquiries': 'Ticket Enquiries',
  'booking-ops': 'Booking Operations',
  notifications: 'Communication', profile: 'Profile',
  /* Moved here from the Super Admin Portal; see assets/js/admin-logs.js. */
  audit: 'Audit Logs', 'system-logs': 'System Logs',
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
  if (name === 'support') return loadSupportQueue();
  if (name === 'reports-export') return initReportsExport();
  /* M6. Defined in admin-analytics.js, loaded after this file. */
  if (name === 'analytics') return loadAnalytics();
  /* 0041. Defined in admin-payment-requests.js, loaded after this file. The old
     per-booking loadPayments() is retired — see the note above it. */
  if (name === 'payments') return initPaymentRequests();
  if (name === 'notifications') return initNotificationForm();
  if (name === 'partner-requests') return loadApprovalQueue();
  if (name === 'service-requests-mgmt') return loadServiceRequestManagement();
  if (name === 'ticket-enquiries') return loadTicketEnquiries();
  if (name === 'booking-ops') return loadBookingOps();
  /* 0039. Defined in admin-providers.js, loaded after this file. */
  if (name === 'providers') return loadProviders();
  /* Both defined in admin-logs.js, loaded after this file. */
  if (name === 'audit') return loadAuditLogs();
  if (name === 'system-logs') return loadSystemLogs();
  /* No 'change-requests' case: cancellations and reschedules are rows on
     Service Request Management, which opens the settle dialog by row type. */
  if (name === 'profile') return loadAdminProfile();
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
/* Federates the list endpoints that already support server-side `search` —
   merchants, requests (bookings + service requests), payment requests — no new
   backend endpoint.

   The third group used to search /api/admin/payments and jump to the
   per-booking payment table. That table no longer exists (0041), so the group
   now searches the payment requests that replaced it and lands on the screen
   that can actually show the row. A result that navigates somewhere it cannot
   be displayed is worse than no result. */
let globalSearchTimer;
const gsInput = document.getElementById('globalSearchInput');
const gsDropdown = document.getElementById('globalSearchDropdown');
async function runGlobalSearch(q) {
  gsDropdown.innerHTML = rowsSkeleton(3);
  gsDropdown.classList.add('open');
  try {
    const [merchants, requests, payments] = await Promise.all([
      axios.get(`${API_BASE}/api/admin/merchants`, { headers: authHeaders(), params: { search: q, page: 1, page_size: 4 } }).catch(() => null),
      axios.get(`${API_BASE}/api/requests`, { headers: authHeaders(), params: { search: q, page: 1, page_size: 4 } }).catch(() => null),
      axios.get(`${API_BASE}/api/admin/wallet/topups`, { headers: authHeaders(), params: { search: q, bucket: 'all', page: 1, page_size: 4 } }).catch(() => null),
    ]);
    const groups = [];
    if (merchants?.data?.items?.length) {
      groups.push({ label: 'Merchants', rows: merchants.data.items.map(m => ({
        title: m.company_name, meta: `${m.merchant_code} · ${m.email}`,
        action: () => navigateToSection('users', () => {
          document.getElementById('merchantSearch').value = m.company_name; loadMerchants(1);
        }),
      })) });
    }
    if (requests?.data?.items?.length) {
      groups.push({ label: 'Requests', rows: requests.data.items.map(r => ({
        title: `${r.request_number} — ${(r.request_type || '').replace(/_/g, ' ')}`,
        meta: `${r.merchant_name || ''} · ${r.status_label || r.status}`,
        action: () => navigateToSection('service-requests-mgmt'),
      })) });
    }
    if (payments?.data?.items?.length) {
      groups.push({ label: 'Payments', rows: payments.data.items.map(p => ({
        title: `${p.topup_number} — ${p.merchant_name || ''}`,
        meta: `${moneyStr(p.amount)} · ${String(p.status).replace(/_/g, ' ')}`,
        action: () => navigateToSection('payments', () => {
          const box = document.getElementById('prSearch');
          if (box) { box.value = p.topup_number; box.dispatchEvent(new Event('input')); }
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

/* ---------- Admin Dashboard ---------- GET /api/admin/dashboard (API_CONTRACT.md §6.1). */
async function loadReports() {
  const grid = document.getElementById('statGridRow1');
  const statIcon = (variant, path) => `<div class="stat-icon ${variant}"><svg class="icon" viewBox="0 0 24 24">${path}</svg></div>`;
  const ICONS = {
    merchant: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    verify: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/>',
    issued: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    support: '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m3 6 9 7 9-7"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
    enquiry: '<path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2a.5.5 0 0 0-.5.8l3.5 4-2 2-2.4-.6a.5.5 0 0 0-.5.8L5 16l1.8 2.6a.5.5 0 0 0 .8-.5l-.6-2.4 2-2 4 3.5a.5.5 0 0 0 .8-.5Z"/>',
  };
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/dashboard`, { headers: authHeaders() });
    const s = data.requests_by_status;
    /* Defaulted rather than assumed: an older backend that predates the split
       returns no `enquiries` block, and the dashboard should still render. */
    const enq = data.enquiries || { pending: 0, in_review: 0, awaiting_response: 0, answered_today: 0 };
    updateEnquiryNavBadge(enq.awaiting_response);
    /* FOUR CARDS, HEADING AND VALUE ONLY.
       Payment Verification, Payments Verified Today, Ticket Issued, Open
       Support Tickets, Open Chat Threads and the Recent Activity feed were all
       removed on request, along with every `.stat-sub` breakdown. What is left
       answers "how big is the platform and what is moving right now".

       "Active Support Chats" is `open_chat_threads` — the same figure the old
       "Open Chat Threads" card showed, relabelled to the wording asked for
       rather than recomputed. `/api/admin/dashboard` is unchanged and still
       returns every field above; Payments Awaiting Verification now lives as a
       per-merchant column on Merchant Management, and the queue itself is
       Payment Management. */
    grid.innerHTML = `
      <div class="stat-card">${statIcon('coral', ICONS.merchant)}<div class="stat-body"><div class="num">${data.merchants.total}</div><div class="label">Total Merchants</div></div></div>
      <div class="stat-card">${statIcon('sky', ICONS.users)}<div class="stat-body"><div class="num">${data.total_users ?? 0}</div><div class="label">Total Users</div></div></div>
      <div class="stat-card">${statIcon('gold', ICONS.clock)}<div class="stat-body"><div class="num gold">${data.active_service_requests ?? 0}</div><div class="label">Active Service Requests</div></div></div>
      <div class="stat-card">${statIcon('emerald', ICONS.chat)}<div class="stat-body"><div class="num">${data.open_chat_threads}</div><div class="label">Active Support Chats</div></div></div>
    `;
  } catch (err) {
    grid.innerHTML = `<div class="msg error">Failed to load dashboard.</div>`;
  }
}

/* ---------- Merchant Management ---------- GET/POST/PUT /api/admin/merchants (existing,
   live v2 endpoints — API_CONTRACT.md §2/§3). Admin's remit here is view/edit/approve/suspend
   the company, plus the full staff-login lifecycle for it: list users, ADD a user
   (POST /api/admin/merchants/{id}/users) and reset an existing user's password. All three are
   gated on `merchant_user.manage`, which Admin holds.

   The merchant's own MERCHANT_USER_CREATE is a different thing and still merchant-only: it is
   what lets a merchant add staff to its own company from the Merchant Portal. An admin never
   holds it — they create through the merchant-scoped admin path above, where the company comes
   from the URL rather than from the caller's account. */
const COMPANY_TYPE_LABELS = { gaming_company: 'Gaming Company', corporate_company: 'Corporate Company', travel_agency: 'Travel Agency', business_partner: 'Business Partner', direct_customer: 'Direct Customer' };
const MERCHANT_STATUS_BADGE = { active: 'active', pending_approval: 'pending', suspended: 'cancelled', inactive: 'inactive' };

let merchantsPage = 1;
let merchantSearchTimer = null;

async function loadMerchants(page = merchantsPage) {
  merchantsPage = page;
  showMerchantView('list');
  document.getElementById('merchantDetailPanel').innerHTML = '';
  const tbody = document.querySelector('#merchantsTable tbody');
  tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Loading…</td></tr>`;
  const search = document.getElementById('merchantSearch').value;
  const status = document.getElementById('merchantStatusFilter').value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/merchants`, {
      headers: authHeaders(),
      params: { search: search || undefined, status: status || undefined, page, page_size: PAGE_SIZE },
    });
    renderPagination('merchantsPagination', data.page, data.total_pages, data.total, loadMerchants);
    /* NINE COLUMNS, AND VIEW IS THE ONLY ACTION.
       Merchant Code, Company Type, Email, Phone, Created Date and the row
       checkbox were removed on request; Country Code, Wallet Balance, Tickets
       Issued and Awaiting Verification took their place. Every removed field is
       still on the record and still shown inside View — this narrowed the
       TABLE, not the data.

       Edit / Approve / Suspend / Reactivate moved into the detail view rather
       than being deleted: those four are still the only way to change a
       merchant, and they are one click further from a list where the wrong row
       is easy to hit. `money()` is not used for the balance — it takes a float
       and drops paise; `moneyStr()` reads the API's decimal string. */
    tbody.innerHTML = data.items.map(m => `
      <tr>
        <td><strong>${escapeHtml(m.merchant_code)}</strong></td>
        <td>${escapeHtml(m.merchant_name)}</td>
        <td>${escapeHtml(m.country_code || '—')}</td>
        <td>${m.user_count}</td>
        <td>${moneyStr(m.wallet_balance)}</td>
        <td>${m.tickets_issued ?? 0}</td>
        <td>${m.awaiting_verification
              ? `<span class="badge pending">${m.awaiting_verification}</span>`
              : '0'}</td>
        <td><span class="badge ${MERCHANT_STATUS_BADGE[m.status] || m.status}">${escapeHtml(statusLabel(m.status))}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-view-merchant="${m.id}">View</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="9" class="empty-state">No merchants found.</td></tr>`;
    tbody.querySelectorAll('[data-view-merchant]').forEach(btn => btn.addEventListener('click', () => openMerchantDetail(btn.dataset.viewMerchant)));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load merchants.</td></tr>`;
  }
}
document.getElementById('onboardMerchantBtn').addEventListener('click', () => openOnboardMerchantModal(null));
document.getElementById('merchantsRefreshBtn').addEventListener('click', () => loadMerchants(merchantsPage));
document.getElementById('merchantSearch').addEventListener('input', () => {
  clearTimeout(merchantSearchTimer);
  merchantSearchTimer = setTimeout(() => loadMerchants(1), 350);
});
document.getElementById('merchantStatusFilter').addEventListener('change', () => loadMerchants(1));
document.getElementById('merchantDateFrom')?.addEventListener('change', () => loadMerchants(1));
document.getElementById('merchantDateTo')?.addEventListener('change', () => loadMerchants(1));
document.getElementById('merchantSort')?.addEventListener('change', () => loadMerchants(1));
/* The bulk select-all / Activate / Deactivate handlers were removed with the
   checkbox column and the bulk bar they drove. They were NOT optional-chained
   and would have thrown on `null.addEventListener` at script load, which in a
   plain <script> takes every later listener in this file down with it —
   Merchant Search, the status filter and Onboard included. Deleted rather than
   guarded: there is no control left to bind to. PATCH /status is unchanged and
   is still what the per-merchant Suspend/Reactivate in the detail view calls. */

/* ---------- Onboard / Edit Merchant modal ---------- POST/PUT /api/admin/merchants (existing). */
async function openOnboardMerchantModal(merchantId) {
  const overlay = document.getElementById('onboardMerchantModalOverlay');
  const body = document.getElementById('onboardMerchantModalBody');
  let m = null;
  if (merchantId) {
    try { m = (await axios.get(`${API_BASE}/api/admin/merchants/${merchantId}`, { headers: authHeaders() })).data; }
    catch (err) { alert('Failed to load merchant.'); return; }
  }
  const v = (field, fallback = '') => m ? (m[field] ?? fallback) : fallback;
  body.innerHTML = `
    <h2>${m ? 'Edit Merchant' : 'Onboard Merchant'}</h2>
    <form id="onboardMerchantForm">
      <div class="form-grid">
        <div class="form-field"><label>Company Name</label><input name="company_name" required value="${escapeHtml(v('company_name'))}"></div>
        <div class="form-field"><label>Merchant Name</label><input name="merchant_name" required value="${escapeHtml(v('merchant_name'))}"></div>
        <div class="form-field"><label>Company Type</label>
          <select name="company_type" required>
            ${Object.entries(COMPANY_TYPE_LABELS).map(([val, label]) => `<option value="${val}" ${v('company_type') === val ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <div class="form-field"><label>Email</label><input name="email" type="email" required value="${escapeHtml(v('email'))}" ${m ? 'disabled' : ''}></div>
        <div class="form-field"><label>Phone</label><input name="phone" value="${escapeHtml(v('phone'))}"></div>
        <div class="form-field"><label>Credit Limit</label><input name="credit_limit" type="number" min="0" step="0.01" value="${v('credit_limit', 0)}"></div>
        <div class="form-field"><label>Address</label><input name="address" value="${escapeHtml(v('address'))}"></div>
        <div class="form-field"><label>City</label><input name="city" value="${escapeHtml(v('city'))}"></div>
        <div class="form-field"><label>Country</label><input name="country" value="${escapeHtml(v('country'))}"></div>
        ${m ? '' : `<div class="form-field"><label>Contact Person</label><input name="contact_person" required></div>
        <div class="form-field"><label>Contact Email</label><input name="contact_email" type="email" required></div>`}
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
      company_name: f.company_name.value, merchant_name: f.merchant_name.value,
      company_type: f.company_type.value, phone: f.phone.value || null,
      credit_limit: f.credit_limit.value || 0, address: f.address.value || null,
      city: f.city.value || null, country: f.country.value || null,
    };
    if (!m) {
      payload.email = f.email.value;
      payload.contact_person = f.contact_person.value;
      payload.contact_email = f.contact_email.value;
    }
    try {
      if (m) {
        await axios.put(`${API_BASE}/api/admin/merchants/${merchantId}`, payload, { headers: authHeaders() });
        overlay.classList.remove('open');
        loadMerchants();
      } else {
        const { data } = await axios.post(`${API_BASE}/api/admin/merchants`, payload, { headers: authHeaders() });
        overlay.classList.remove('open');
        alert(`Merchant created — awaiting approval.\n\nFirst login: ${data.first_user.email}\nTemporary password: ${data.temporary_password}\n\nShare these credentials securely — this password cannot be retrieved again.`);
        loadMerchants();
      }
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to save merchant.';
      msg.className = 'msg error';
    }
  });
}

/* ---------- Merchant Details ---------- GET /api/admin/merchants/{id}(/users) (existing). */
async function openMerchantDetail(merchantId) {
  const detailPanel = document.getElementById('merchantDetailPanel');
  showMerchantView('detail');
  detailPanel.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  try {
    const { data: m } = await axios.get(`${API_BASE}/api/admin/merchants/${merchantId}`, { headers: authHeaders() });
    /* EDIT AND SUSPEND LIVE HERE NOW, not on the list row. The list carries a
       single View action, so a state change is always made from the screen
       that shows which merchant it is. Approve appears only while the account
       is pending, and Suspend/Reactivate swap on the current status — the same
       three endpoints the row buttons used.

       The "Financial position" panel was removed on request. loadMerchantFinance
       and loadMerchantStatement are still defined and still work; they simply
       have no caller from this screen, and GET /finance and /statement are
       untouched. The wallet balance the desk actually needs is now a column on
       the list, and the full ledger lives on Wallet & Top-ups. */
    const st = m.status;
    detailPanel.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h2>${escapeHtml(m.company_name)}</h2>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-ghost btn-sm" id="editMerchantBtn">Edit</button>
            ${st === 'pending_approval' ? `<button class="btn btn-coral btn-sm" id="approveMerchantBtn">Approve</button>` : ''}
            ${st === 'active' ? `<button class="btn btn-danger btn-sm" id="suspendMerchantBtn" data-next="suspended">Suspend</button>` : ''}
            ${st === 'suspended' ? `<button class="btn btn-coral btn-sm" id="suspendMerchantBtn" data-next="active">Reactivate</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="backToMerchantsBtn">← Back to Merchants</button>
          </div>
        </div>
        <div class="info-grid">
          <div class="info-item"><label>Merchant ID</label><div>${escapeHtml(m.merchant_code)}</div></div>
          <div class="info-item"><label>Merchant Name</label><div>${escapeHtml(m.merchant_name)}</div></div>
          <div class="info-item"><label>Company Type</label><div>${escapeHtml(COMPANY_TYPE_LABELS[m.company_type] || '—')}</div></div>
          <div class="info-item"><label>Email</label><div>${escapeHtml(m.email)}</div></div>
          <div class="info-item"><label>Phone</label><div>${escapeHtml(m.phone || '—')}</div></div>
          <div class="info-item"><label>Country</label><div>${escapeHtml(m.country || '—')}${m.country_code ? ` (${escapeHtml(m.country_code)})` : ''}</div></div>
          <div class="info-item"><label>City</label><div>${escapeHtml(m.city || '—')}</div></div>
          <div class="info-item"><label>Address</label><div>${escapeHtml(m.address || '—')}</div></div>
          <div class="info-item"><label>Wallet Balance</label><div>${moneyStr(m.wallet_balance)}</div></div>
          <div class="info-item"><label>Status</label><div><span class="badge ${MERCHANT_STATUS_BADGE[m.status] || m.status}">${escapeHtml(statusLabel(m.status))}</span></div></div>
          <div class="info-item"><label>Created Date</label><div>${fmtDate(m.created_at)}</div></div>
          <div class="info-item"><label>Number of Users</label><div>${m.user_count}</div></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2 style="font-size:14px;">Users</h2>
          <button class="btn btn-coral btn-sm" id="addMerchantUserBtn">+ Add User</button>
        </div>
        <div class="table-wrap"><table id="merchantUsersTable"><thead><tr>
          <th>Full Name</th><th>Email</th><th>Phone</th><th>Role Type</th><th>Status</th><th>Last Login</th><th>Actions</th>
        </tr></thead><tbody></tbody></table></div>
      </div>
    `;
    document.getElementById('backToMerchantsBtn').addEventListener('click', () => loadMerchants(merchantsPage));
    document.getElementById('addMerchantUserBtn').addEventListener('click', () => openMerchantUserModal(merchantId, m.company_name));
    document.getElementById('editMerchantBtn').addEventListener('click', () => openOnboardMerchantModal(merchantId));
    document.getElementById('approveMerchantBtn')?.addEventListener('click', async () => {
      try {
        await axios.post(`${API_BASE}/api/admin/merchants/${merchantId}/approve`, {}, { headers: authHeaders() });
        openMerchantDetail(merchantId);
      } catch (err) { alert(err.response?.data?.detail || 'Failed to approve merchant.'); }
    });
    document.getElementById('suspendMerchantBtn')?.addEventListener('click', async e => {
      try {
        await axios.patch(`${API_BASE}/api/admin/merchants/${merchantId}/status`,
                          { status: e.currentTarget.dataset.next }, { headers: authHeaders() });
        openMerchantDetail(merchantId);
      } catch (err) { alert(err.response?.data?.detail || 'Failed to update merchant.'); }
    });
    loadMerchantUsersTable(merchantId);
  } catch (err) {
    detailPanel.innerHTML = `<div class="panel"><div class="empty-state">Failed to load merchant.</div></div>`;
  }
}

/* ---------- Merchant financial position (M4) ----------
   GET /api/admin/merchants/{id}/finance and /statement. Both are served by
   finance_service, which is also what the merchant's own Payments screen reads,
   so "what does this merchant owe" has exactly one answer on this platform.

   Every value is a Decimal serialised as a string and is rendered with
   moneyStr() — never money(), which rounds through a float and would show the
   desk a different number from the one the merchant is looking at. */
async function loadMerchantFinance(merchantId) {
  const box = document.getElementById('merchantFinance');
  if (!box) return;
  try {
    const { data: p } = await axios.get(
      `${API_BASE}/api/admin/merchants/${merchantId}/finance`, { headers: authHeaders() });

    const tile = (label, value, sub) => `
      <div class="analytics-tile">
        <div class="num">${escapeHtml(value)}</div>
        <div class="label">${escapeHtml(label)}</div>
        ${sub ? `<div class="label" style="text-transform:none;letter-spacing:0;font-weight:600;">${escapeHtml(sub)}</div>` : ''}
      </div>`;

    box.innerHTML = `
      <div class="analytics-grid" style="margin:0 0 8px;">
        ${tile('Outstanding', moneyStr(p.outstanding), `${p.bookings_billable} billable booking${p.bookings_billable === 1 ? '' : 's'}`)}
        ${tile('Billed', moneyStr(p.billed), 'raised to date')}
        ${tile('Net paid', moneyStr(p.net_paid), moneyIsPositive(p.refunded) ? `after ${moneyStr(p.refunded)} refunded` : 'verified')}
        ${tile('Awaiting verification', moneyStr(p.awaiting_verification), 'submitted, unconfirmed')}
        ${tile('Wallet', moneyStr(p.wallet_balance), 'on account')}
        ${p.has_credit_limit
          ? tile('Credit available', moneyStr(p.credit_available), `${moneyStr(p.credit_used)} of ${moneyStr(p.credit_limit)} used`)
          : tile('Credit limit', 'Not set', 'no standing credit')}
        ${tile('Spending power', moneyStr(p.spending_power), 'wallet + available credit')}
        ${moneyIsPositive(p.overpaid) ? tile('Overpaid', moneyStr(p.overpaid), 'refund or allocate') : ''}
      </div>`;

    document.getElementById('merchantStmtToggle')?.addEventListener('click', async e => {
      const panel = document.getElementById('merchantStatement');
      if (!panel.hidden) {
        panel.hidden = true;
        e.target.textContent = 'Show statement';
        return;
      }
      e.target.textContent = 'Hide statement';
      panel.hidden = false;
      panel.innerHTML = `<div class="empty-state">Loading statement…</div>`;
      try {
        const { data: s } = await axios.get(
          `${API_BASE}/api/admin/merchants/${merchantId}/statement`, { headers: authHeaders() });
        const entries = s.entries || [];
        panel.innerHTML = `
          <div class="table-wrap"><table><thead><tr>
            <th>Date</th><th>Reference</th><th>Description</th>
            <th>Debit</th><th>Credit</th><th>Balance</th>
          </tr></thead><tbody>
            ${entries.length ? entries.map(en => `
              <tr>
                <td>${escapeHtml(en.at ? fmtDate(en.at) : '—')}</td>
                <td>${escapeHtml(en.reference || '—')}</td>
                <td>${escapeHtml(en.description || en.kind)}</td>
                <td>${moneyIsPositive(en.debit) ? escapeHtml(moneyStr(en.debit)) : ''}</td>
                <td>${moneyIsPositive(en.credit) ? escapeHtml(moneyStr(en.credit)) : ''}</td>
                <td>${escapeHtml(moneyStr(en.balance))}</td>
              </tr>`).join('')
              : '<tr><td colspan="6" class="empty-state">No ledger entries.</td></tr>'}
          </tbody>
          ${entries.length ? `<tfoot><tr>
            <td colspan="3"><strong>Totals</strong></td>
            <td><strong>${escapeHtml(moneyStr(s.total_debits))}</strong></td>
            <td><strong>${escapeHtml(moneyStr(s.total_credits))}</strong></td>
            <td><strong>${escapeHtml(moneyStr(s.closing_balance))}</strong></td>
          </tr></tfoot>` : ''}
          </table></div>`;
      } catch (err) {
        panel.innerHTML = `<div class="empty-state">${escapeHtml(
          err.response?.data?.detail || 'Could not load the statement.')}</div>`;
      }
    });
  } catch (err) {
    box.innerHTML = `<div class="empty-state">${escapeHtml(
      err.response?.data?.detail || 'Could not load this merchant’s financial position.')}</div>`;
  }
}

/* ---------- Add a user to a merchant ---------- POST /api/admin/merchants/{id}/users.

   The company comes from the URL, never from the form, so an admin cannot land a
   user in the wrong company by editing a field. `merchant_role` is the internal
   role the backend uses to widen a merchant_user's permissions (rbac
   MERCHANT_ROLE_PERMISSIONS); it does not apply to a merchant_admin, who already
   holds the full merchant set, so the field is disabled for that choice. */
/* ROLE TYPE — WHAT CAN BE CREATED VS WHAT CAN BE DISPLAYED, AND WHY THEY DIFFER.

   Creation narrowed on request: Merchant Admin is gone, Operator is merged into
   Data Operator, and Finance is gone. So a NEW merchant user is always a
   `merchant_user` at the portal level, and its Role Type is one of three.

   The database enums did NOT change. `UserRole.MERCHANT_ADMIN`,
   `MerchantRole.OPERATOR` and `MerchantRole.FINANCE` still exist in models_v2.py
   and existing accounts still hold them — the seeded demo merchant admin is one.
   Dropping them from the DISPLAY map as well would render those live accounts
   with a blank Role Type, so the two maps are deliberately separate:
   `MERCHANT_ROLE_LABELS` names everything that can exist, and
   `MERCHANT_ROLE_CREATABLE` is the subset a new user may be given. */
const MERCHANT_ROLE_LABELS = {
  manager: 'Manager',
  supervisor: 'Supervisor',
  data_operator: 'Data Operator',
  /* Legacy — not creatable, still held by existing accounts. */
  operator: 'Data Operator',
  finance: 'Finance',
};
const MERCHANT_ROLE_CREATABLE = {
  data_operator: 'Data Operator',
  manager: 'Manager',
  supervisor: 'Supervisor',
};

/* A merchant user's Role Type is its internal role; the portal-level `role`
   only distinguishes staff from the company owner. Falls back to the portal
   role so a `merchant_admin` with no internal role still reads as something. */
function merchantRoleType(u) {
  return MERCHANT_ROLE_LABELS[u.merchant_role]
      || statusLabel(u.role || '')
      || '—';
}

function openMerchantUserModal(merchantId, companyName) {
  const overlay = document.getElementById('merchantUserModalOverlay');
  const body = document.getElementById('merchantUserModalBody');
  body.innerHTML = `
    <h2>Add User</h2>
    <p style="font-size:13px;color:var(--text-muted);font-weight:600;margin:-10px 0 16px;">
      New login for ${escapeHtml(companyName)}.
    </p>
    <form id="merchantUserForm">
      <div class="form-grid">
        <div class="form-field"><label>Full Name</label><input name="full_name" required maxlength="150"></div>
        <div class="form-field"><label>Email</label><input name="email" type="email" required></div>
        <div class="form-field"><label>Phone</label><input name="phone" required maxlength="30"></div>
        <!-- The Account Role picker is gone: Merchant Admin was removed, which
             leaves merchant_user as the only value. Hidden input so the
             payload shape is unchanged. (No backticks in this comment: it sits
             inside a template literal, and one would close the string.) -->
        <input type="hidden" name="role" value="merchant_user">
        <div class="form-field"><label>Role Type</label>
          <select name="merchant_role" required>
            ${Object.entries(MERCHANT_ROLE_CREATABLE).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
        </div>
        <div class="form-field"><label>Password</label>
          <input name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">
        </div>
        <div class="form-field"><label>Confirm Password</label>
          <input name="confirm_password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">
        </div>
      </div>
      <div class="msg" id="merchantUserMsg"></div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-coral">Create User</button>
        <button type="button" class="btn btn-ghost" id="merchantUserCancelBtn">Cancel</button>
      </div>
    </form>`;
  overlay.classList.add('open');

  const form = document.getElementById('merchantUserForm');
  document.getElementById('merchantUserCancelBtn').addEventListener('click', () => overlay.classList.remove('open'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const msg = document.getElementById('merchantUserMsg');
    const submit = form.querySelector('button[type=submit]');

    /* EVERY FIELD IS REQUIRED NOW, INCLUDING THE PASSWORD. The auto-generate
       path is gone with the blank-password placeholder, so `password` is always
       sent and the "temporary password" the response echoes is simply the one
       that was typed. Confirm is checked here rather than left to the server:
       the API takes a single `password` and has no second value to compare. */
    if (f.password.value !== f.confirm_password.value) {
      msg.className = 'msg error';
      msg.textContent = 'The two passwords do not match.';
      f.confirm_password.focus();
      return;
    }

    const payload = {
      full_name: f.full_name.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim(),
      role: f.role.value,
      merchant_role: f.merchant_role.value,
      password: f.password.value,
    };

    submit.disabled = true;
    msg.textContent = 'Creating…';
    msg.className = 'msg';
    try {
      const { data } = await axios.post(
        `${API_BASE}/api/admin/merchants/${merchantId}/users`, payload, { headers: authHeaders() });
      overlay.classList.remove('open');
      alert(`User created.\n\nLogin: ${data.account.email}\n\nThe password you set is now active. Share it securely — it cannot be retrieved again.`);
      /* Re-open the whole detail rather than just the table, so the "Number of
         Users" figure in the info grid moves with it. */
      openMerchantDetail(merchantId);
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to create user.';
      msg.className = 'msg error';
    } finally {
      submit.disabled = false;
    }
  });
}

async function loadMerchantUsersTable(merchantId) {
  const tbody = document.querySelector('#merchantUsersTable tbody');
  tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Loading…</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/merchants/${merchantId}/users`, { headers: authHeaders(), params: { page_size: 100 } });
    /* Role Type replaces the generic portal Role, and the row gains View plus
       an Activate/Deactivate that swaps on the user's current status. Reset
       Password moved inside View — it is the destructive one, and it was
       sitting a single click away in a table of look-alike rows. */
    tbody.innerHTML = data.items.map(u => {
      const isActive = u.status === 'active';
      return `
      <tr>
        <td>${escapeHtml(u.full_name)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.phone || '—')}</td>
        <td>${escapeHtml(merchantRoleType(u))}</td>
        <td><span class="badge ${isActive ? 'active' : 'inactive'}">${escapeHtml(statusLabel(u.status))}</span></td>
        <td>${u.last_login ? fmtDateTime(u.last_login) : '—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-view-mu="${u.id}">View</button>
          <button class="btn ${isActive ? 'btn-danger' : 'btn-coral'} btn-sm"
                  data-status-mu="${u.id}" data-next="${isActive ? 'inactive' : 'active'}">
            ${isActive ? 'Deactivate' : 'Activate'}
          </button>
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="7" class="empty-state">No users yet for this merchant.</td></tr>`;

    const byId = new Map(data.items.map(u => [String(u.id), u]));
    tbody.querySelectorAll('[data-view-mu]').forEach(btn => {
      btn.addEventListener('click', () => openMerchantUserDetail(merchantId, byId.get(btn.dataset.viewMu)));
    });
    tbody.querySelectorAll('[data-status-mu]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.patch(
            `${API_BASE}/api/admin/merchants/${merchantId}/users/${btn.dataset.statusMu}/status`,
            { status: btn.dataset.next }, { headers: authHeaders() });
          loadMerchantUsersTable(merchantId);
        } catch (err) { alert(err.response?.data?.detail || 'Failed to update this user.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Failed to load users.</td></tr>`;
  }
}

/* One merchant user, read-only, plus the two actions that do not belong on a
   row: Reset Password (destructive, and the new password is shown once) and
   the status flip. Rendered into the same overlay the Add User form uses. */
function openMerchantUserDetail(merchantId, u) {
  if (!u) return;
  const overlay = document.getElementById('merchantUserModalOverlay');
  const isActive = u.status === 'active';
  document.getElementById('merchantUserModalBody').innerHTML = `
    <h2>${escapeHtml(u.full_name)}</h2>
    <dl class="jp-kv" style="margin:14px 0 20px;">
      <div><dt>Email</dt><dd>${escapeHtml(u.email)}</dd></div>
      <div><dt>Phone</dt><dd>${escapeHtml(u.phone || '—')}</dd></div>
      <div><dt>Role Type</dt><dd>${escapeHtml(merchantRoleType(u))}</dd></div>
      <div><dt>Status</dt><dd><span class="badge ${isActive ? 'active' : 'inactive'}">${escapeHtml(statusLabel(u.status))}</span></dd></div>
      <div><dt>Last Login</dt><dd>${u.last_login ? fmtDateTime(u.last_login) : 'Never'}</dd></div>
      <div><dt>Created</dt><dd>${u.created_at ? fmtDate(u.created_at) : '—'}</dd></div>
    </dl>
    <div class="modal-actions">
      <button type="button" class="btn ${isActive ? 'btn-danger' : 'btn-coral'}" id="muDetailStatusBtn"
              data-next="${isActive ? 'inactive' : 'active'}">${isActive ? 'Deactivate' : 'Activate'}</button>
      <button type="button" class="btn btn-ghost" id="muDetailResetBtn">Reset Password</button>
      <button type="button" class="btn btn-ghost" id="muDetailCloseBtn">Close</button>
    </div>`;
  overlay.classList.add('open');

  const close = () => overlay.classList.remove('open');
  document.getElementById('muDetailCloseBtn').addEventListener('click', close);
  document.getElementById('muDetailStatusBtn').addEventListener('click', async e => {
    try {
      await axios.patch(
        `${API_BASE}/api/admin/merchants/${merchantId}/users/${u.id}/status`,
        { status: e.currentTarget.dataset.next }, { headers: authHeaders() });
      close();
      loadMerchantUsersTable(merchantId);
    } catch (err) { alert(err.response?.data?.detail || 'Failed to update this user.'); }
  });
  document.getElementById('muDetailResetBtn').addEventListener('click', async () => {
    if (!confirm(`Reset the password for ${u.email}?`)) return;
    try {
      const { data: r } = await axios.post(
        `${API_BASE}/api/admin/merchants/${merchantId}/users/${u.id}/reset-password`,
        {}, { headers: authHeaders() });
      alert(`New password: ${r.temporary_password}\n\nShare this with the merchant user securely — it cannot be retrieved again.`);
    } catch (err) { alert('Failed to reset password.'); }
  });
}

function showMerchantView(view) {
  document.getElementById('merchantBreadcrumb').innerHTML = 'Admin Portal / <span>Merchant Management</span>';
  document.getElementById('merchantListPanel').style.display = view === 'list' ? '' : 'none';
  document.getElementById('merchantDetailPanel').style.display = view === 'detail' ? '' : 'none';
}

/* ---------- Active Users ---------- GET /api/admin/users (API_CONTRACT.md §4.1). */
let activeUsersPage = 1;
let auSearchTimer;
function activeUsersFiltersWired() { return document.getElementById('auSearch').dataset.wired === '1'; }
async function loadActiveUsers(page = activeUsersPage) {
  activeUsersPage = page;
  if (!activeUsersFiltersWired()) {
    document.getElementById('auSearch').dataset.wired = '1';
    document.getElementById('auSearch').addEventListener('input', () => {
      clearTimeout(auSearchTimer);
      auSearchTimer = setTimeout(() => loadActiveUsers(1), 350);
    });
    document.getElementById('auStatusFilter').addEventListener('change', () => loadActiveUsers(1));
    document.getElementById('auRoleFilter').addEventListener('change', () => loadActiveUsers(1));
  }
  const tbody = document.querySelector('#activeUsersTable tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading…</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/users`, {
      headers: authHeaders(),
      params: {
        search: document.getElementById('auSearch').value || undefined,
        status: document.getElementById('auStatusFilter').value || undefined,
        role: document.getElementById('auRoleFilter').value || undefined,
        page, page_size: PAGE_SIZE,
      },
    });
    renderPagination('activeUsersPagination', data.page, data.total_pages, data.total, loadActiveUsers);
    tbody.innerHTML = data.items.map(u => `
      <tr>
        <td>${escapeHtml(u.full_name)} ${u.is_online ? '<span class="status-dot-inline online" title="Online now"></span>' : ''}</td>
        <td title="${escapeHtml(u.email)}">${escapeHtml(usernameOf(u.email))}</td>
        <td style="text-transform:capitalize">${escapeHtml((u.role || '').replace(/_/g, ' '))}</td>
        <td>${u.merchant_id ? `MRC-${u.merchant_id}` : '—'}</td>
        <td>${u.last_login ? fmtDateTime(u.last_login) : 'Never'}</td>
      </tr>
    `).join('') || `<tr><td colspan="5" class="empty-state">No users found.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Failed to load users.</td></tr>`;
  }
}

/* ---------- Booking Management Center ---------- */
/* ---------- Partner Requests (Back Office approval queue) ----------
   Closes the gap flagged throughout the Partner Portal build: the database
   and API (sp_approve_request/sp_reject_request from Phase 2, plus the new
   sp_admin_list_partner_bookings/sp_resolve_service_request) already
   supported this — there was just no screen to drive them. */
/* ---------- Approval Queue ---------- GET /api/admin/approval-queue (new, unified —
   API_CONTRACT.md §4.2 sign-off). Actions route to the existing per-kind endpoints:
   merchant approvals to POST /api/admin/merchants/{id}/approve, ticket/service requests to
   POST /api/admin/requests/{id}/approve|reject. */
let aqPage = 1;
let aqFiltersWired = false;
function aqStatusBadgeClass(s) {
  if (['approved', 'completed', 'active'].includes(s)) return 'confirmed';
  if (['rejected', 'cancelled'].includes(s)) return 'cancelled';
  return 'pending';
}
async function loadApprovalQueue(page = aqPage) {
  aqPage = page;
  if (!aqFiltersWired) {
    aqFiltersWired = true;
    ['aqStatusFilter', 'aqTypeFilter', 'aqDateFrom', 'aqDateTo'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => loadApprovalQueue(1));
    });
  }
  const tbody = document.querySelector('#aqTable tbody');
  tbody.innerHTML = `<tr><td colspan="6">${rowsSkeleton(4)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/approval-queue`, {
      headers: authHeaders(),
      params: {
        status: document.getElementById('aqStatusFilter').value || undefined,
        request_type: document.getElementById('aqTypeFilter').value === 'merchant' ? undefined : (document.getElementById('aqTypeFilter').value || undefined),
        date_from: document.getElementById('aqDateFrom').value || undefined,
        date_to: document.getElementById('aqDateTo').value || undefined,
        page, page_size: PAGE_SIZE,
      },
    });
    let items = data.items;
    if (document.getElementById('aqTypeFilter').value === 'merchant') items = items.filter(i => i.kind === 'merchant');
    tbody.innerHTML = items.length ? items.map(i => {
      /* A booking already at Payment Pending is past approval — approve and
         reject both 400 on it, so it gets the one action it can still take: its
         amount. Under the default "Awaiting action" filter only *unpriced* ones
         appear (approval_service._awaits_admin); selecting Payment Pending
         explicitly also lists priced ones, where the same endpoint serves the
         ordinary "we quoted the wrong number" correction. */
      const pastApproval = i.status === 'payment_pending';
      const unpriced = pastApproval && !(Number(i.total_amount) > 0);
      return `
      <tr>
        <td style="text-transform:capitalize">${i.kind === 'merchant' ? 'Merchant Onboarding' : escapeHtml((i.request_type || '').replace(/_/g, ' '))}</td>
        <td>${escapeHtml(i.title)}</td>
        <td>${escapeHtml(i.merchant_name || '—')}</td>
        <td><span class="badge ${aqStatusBadgeClass(i.status)}">${escapeHtml(i.status_label)}</span>
          ${unpriced ? `<div class="cell-sub">No amount set — the merchant cannot pay</div>` : ''}</td>
        <td>${fmtDateTime(i.submitted_at)}</td>
        <td style="white-space:nowrap;">
          ${i.request_type === 'booking'
            ? `<button class="btn btn-ghost btn-sm" data-aq-review="${i.id}">Review</button>` : ''}
          ${pastApproval
            ? `<button class="btn ${unpriced ? 'btn-coral' : 'btn-ghost'} btn-sm" data-aq-reprice="${i.id}"
                 data-title="${escapeHtml(i.title)}" data-unpriced="${unpriced ? '1' : ''}"
                 data-amount="${escapeHtml(String(i.total_amount ?? ''))}"
               >${unpriced ? 'Set amount' : 'Correct amount'}</button>`
            : `<button class="btn btn-navy btn-sm" data-aq-approve="${i.id}" data-kind="${i.kind}" data-request-type="${i.request_type || ''}" data-title="${escapeHtml(i.title)}">Approve</button>
               ${i.kind === 'request' ? `<button class="btn btn-danger btn-sm" data-aq-reject="${i.id}" data-request-type="${i.request_type || ''}">Reject</button>` : ''}`}
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" class="empty-state">Nothing awaiting approval.</td></tr>`;
    /* Three different backends share this one queue: a merchant approval, a booking's own
       approve/reject (walks Pending -> Under Review -> Approved -> Payment Pending), and a
       service request's resolve (walks Pending -> Under Review -> Approved, no payment step —
       calling the booking endpoint on one of these would wrongly push it through the booking
       lifecycle instead, landing it at "Payment Pending"). */
    /* Booking rows get a Review step before the one-click Approve, because a
       booking now carries traveller documents that ought to be looked at
       first. Implemented in admin-bookings.js; the queue itself is unchanged. */
    tbody.querySelectorAll('[data-aq-review]').forEach(btn => {
      btn.addEventListener('click', () => openBookingReview(btn.dataset.aqReview));
    });
    tbody.querySelectorAll('[data-aq-approve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.aqApprove;
        /* A booking's approval carries the fare. This used to post an empty
           body, so every enquiry-led booking — which reaches approval at ₹0 by
           design — was approved at zero and landed in Payment Pending unpayable.
           The server refuses that now; asking here is what makes the refusal
           unnecessary. Merchant onboarding and service-request resolution have
           no amount and are unchanged. */
        if (btn.dataset.requestType === 'booking') {
          const result = await admAmountDialog({
            title: 'Approve this booking',
            message: `${btn.dataset.title || ''} — the merchant pays this amount, so it cannot be zero.`,
            amountLabel: 'Final amount (₹)',
            reasonLabel: 'Note to the merchant (optional)',
            reasonPlaceholder: 'e.g. Fare confirmed with the airline',
            confirmText: 'Approve at this amount',
          });
          if (!result) return;
          try {
            await axios.post(`${API_BASE}/api/admin/requests/${id}/approve`,
              { final_amount: result.amount, note: result.reason || undefined },
              { headers: authHeaders() });
            showToast('Booking approved. The merchant can now pay.');
            loadApprovalQueue(aqPage);
          } catch (err) { alert(err.response?.data?.detail || 'Failed to approve.'); }
          return;
        }
        try {
          if (btn.dataset.kind === 'merchant') {
            await axios.post(`${API_BASE}/api/admin/merchants/${id}/approve`, {}, { headers: authHeaders() });
          } else {
            await axios.post(`${API_BASE}/api/admin/service-requests/${id}/resolve`, { approve: true }, { headers: authHeaders() });
          }
          loadApprovalQueue(aqPage);
        } catch (err) { alert(err.response?.data?.detail || 'Failed to approve.'); }
      });
    });
    /* Correcting a booking that is already Payment Pending. Its own endpoint,
       not approve: Payment Pending has no edge back to Approved, so calling
       approve here returns "Cannot move a request from Payment Pending to
       Approved". */
    tbody.querySelectorAll('[data-aq-reprice]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.aqReprice;
        const unpriced = !!btn.dataset.unpriced;
        const result = await admAmountDialog({
          title: unpriced ? 'Set the amount' : 'Correct the amount',
          message: unpriced
            ? `${btn.dataset.title || ''} — this booking was approved without a fare, so the merchant is shown "Awaiting amount" and cannot pay.`
            : `${btn.dataset.title || ''} — the merchant is told the new amount and why it changed.`,
          amountLabel: 'Amount to charge (₹)',
          reasonLabel: 'Reason',
          reasonPlaceholder: 'e.g. Fare confirmed with the airline',
          value: unpriced ? '' : (btn.dataset.amount || ''),
          confirmText: unpriced ? 'Set amount' : 'Update amount',
          requireReason: true,
        });
        if (!result) return;
        try {
          await axios.post(`${API_BASE}/api/admin/requests/${id}/reprice`,
            { amount: result.amount, reason: result.reason }, { headers: authHeaders() });
          showToast('Amount set. The merchant has been notified and can now pay.');
          loadApprovalQueue(aqPage);
        } catch (err) { alert(err.response?.data?.detail || 'Failed to set the amount.'); }
      });
    });
    tbody.querySelectorAll('[data-aq-reject]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reason = prompt('Reason for rejecting this request:');
        if (!reason) return;
        const id = btn.dataset.aqReject;
        try {
          if (btn.dataset.requestType === 'booking') {
            await axios.post(`${API_BASE}/api/admin/requests/${id}/reject`, { reason }, { headers: authHeaders() });
          } else {
            await axios.post(`${API_BASE}/api/admin/service-requests/${id}/resolve`, { approve: false, reason }, { headers: authHeaders() });
          }
          loadApprovalQueue(aqPage);
        } catch (err) { alert(err.response?.data?.detail || 'Failed to reject.'); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load the approval queue.</td></tr>`;
  }
}

/* ---------- Service Request Management ----------
   Every service request a merchant has raised, of every type, in one queue.

   THE TWO SCREENS THAT USED TO BE HERE ARE ONE
   Cancellations and date changes had a screen of their own, because settling
   one does more than mark it Approved — it cancels the booking and states the
   refund, or rewrites the travel dates and states what is payable. That is
   still true, and the dialog that does it is still admin-change-requests.js.
   What was wrong was making it a separate *queue*: an admin looking for
   SRQ-000123 had to already know which of the two workflows it belonged to
   before they could find it. The row now picks the dialog from its own type.

   THE MERCHANT'S MANAGER GOES FIRST
   A request arrives here only after a manager at the merchant has signed it
   off. Until then it is listed as "Under Manager Approval" with no action —
   it is not ours to touch yet, and the backend refuses every staff endpoint
   for one (services/manager_approval.py). "Manager Approved" is the stage
   that is actually ours, and it is what this screen opens on.

   ENDPOINTS — all pre-existing
     GET  /api/requests?request_type=...              the rows, per type
     POST /api/admin/service-requests/{id}/resolve    approve/reject the generic types
     GET/POST /api/change-requests/...                the settle dialog, for the two
                                                      types that change the booking */

const SERVICE_REQUEST_TYPES = ['cancellation', 'date_change', 'refund', 'passenger_modification', 'extra_baggage', 'meal', 'seat'];

/* The two types whose Settle opens the pricing dialog rather than the plain
   approve/reject one. The backend refuses the generic resolve endpoint for
   them, so this list is the UI half of a rule the server also enforces. */
const SRM_SETTLED_TYPES = ['cancellation', 'date_change'];

/* Statuses at which the request is still somebody's to action. */
const SRM_OPEN = ['pending_approval', 'in_review'];

const SRM_TYPE_LABELS = {
  cancellation: 'Cancellation', date_change: 'Date Change', refund: 'Refund',
  passenger_modification: 'Passenger Modification', extra_baggage: 'Extra Baggage',
  meal: 'Meal', seat: 'Seat',
};

let srmPage = 1;
let srmRows = [];
let srmFiltersWired = false;
let srmSearchTimer = null;

/* Whose approval a row is waiting on. `manager_state` comes straight from the
   API; a row without one predates manager sign-off and is ours by default. */
function srmStage(r) {
  if (r.status === 'pending_approval') {
    return r.manager_state === 'pending' ? 'awaiting_manager' : 'actionable';
  }
  return r.status;
}

function srmBadge(r) {
  const stage = srmStage(r);
  if (stage === 'awaiting_manager') return 'pending';
  if (stage === 'actionable') return 'confirmed';
  return aqStatusBadgeClass(r.status);
}

/* What the merchant actually asked for, in one cell, whatever the type. A
   reschedule is only meaningful as "from → to"; an ancillary is meaningful as
   the thing requested. Both come off `details`, which the API returns whole. */
function srmAsk(r) {
  const d = r.details || {};
  let headline;
  if (r.request_type === 'date_change') {
    headline = `${d.current_travel_date ? fmtDate(d.current_travel_date) : '—'} →
                <strong>${d.new_travel_date ? fmtDate(d.new_travel_date) : '—'}</strong>`;
  } else if (r.request_type === 'cancellation') {
    headline = 'Cancel the whole booking';
  } else if (r.request_type === 'extra_baggage') {
    headline = d.weight_kg ? `${escapeHtml(String(d.weight_kg))} kg extra` : 'Extra baggage';
  } else if (r.request_type === 'meal') {
    headline = d.meal ? escapeHtml(admLabel(d.meal)) : 'Meal';
  } else if (r.request_type === 'seat') {
    headline = d.seat_preference ? `${escapeHtml(admLabel(d.seat_preference))} seat` : 'Seat';
  } else if (r.request_type === 'passenger_modification') {
    headline = d.field
      ? `${escapeHtml(admLabel(d.field))} → <strong>${escapeHtml(String(d.new_value ?? ''))}</strong>`
      : 'Passenger correction';
  } else {
    headline = escapeHtml(SRM_TYPE_LABELS[r.request_type] || r.request_type);
  }
  const reason = d.reason || r.remarks || '';
  return `<div>${headline}</div>${reason ? `<div class="cell-sub">${escapeHtml(reason)}</div>` : ''}`;
}

/* The settled figure, or nothing. A request nobody has priced shows a dash
   rather than 0.00 — "not priced yet" and "nothing to refund" are different
   statements, and only one of them is good news. */
function srmSettlement(r) {
  const p = r.pricing || {};
  if (p.kind === 'cancellation') {
    return `<div class="cell-sub">Charge ${crMoney(p.cancellation_charge)} ·
            refund <strong>${crMoney(p.refund_amount)}</strong></div>`;
  }
  if (p.kind === 'reschedule') {
    return `<div class="cell-sub">Payable <strong>${crMoney(p.total_payable)}</strong></div>`;
  }
  return '';
}

function srmStatusCell(r) {
  const m = r.manager_approval || {};
  const stage = srmStage(r);
  let sub = '';
  if (stage === 'awaiting_manager') {
    sub = `<div class="cell-sub">with ${escapeHtml(m.by_name || 'the merchant’s manager')}</div>`;
  } else if (stage === 'actionable' && m.by_name && !m.self_raised) {
    sub = `<div class="cell-sub">signed off by ${escapeHtml(m.by_name)}</div>`;
  } else if (r.status === 'in_review' && r.details?.review_claimed_by_name) {
    sub = `<div class="cell-sub">with ${escapeHtml(r.details.review_claimed_by_name)}</div>`;
  }
  return `<span class="badge ${srmBadge(r)}">${escapeHtml(r.status_label)}</span>${sub}${srmSettlement(r)}`;
}

/* Settle only what the merchant's manager has released, and only what is still
   open. Everything else gets View, so a row is never a dead end — an admin can
   always read what was asked and what was decided. */
function srmActions(r) {
  const actionable = srmStage(r) === 'actionable' || r.status === 'in_review';
  const label = actionable && SRM_OPEN.includes(r.status) ? 'Settle' : 'View';
  return `<button class="btn ${label === 'Settle' ? 'btn-navy' : 'btn-ghost'} btn-sm"
                  data-srm-open="${r.id}">${label}</button>`;
}

async function loadServiceRequestManagement(page = srmPage) {
  srmPage = page;
  if (!srmFiltersWired) {
    srmFiltersWired = true;
    ['srmTypeFilter', 'srmStageFilter'].forEach(id =>
      document.getElementById(id).addEventListener('change', () => loadServiceRequestManagement(1)));
    document.getElementById('srmRefreshBtn').addEventListener('click',
      () => loadServiceRequestManagement(1));
    document.getElementById('srmSearch').addEventListener('input', () => {
      clearTimeout(srmSearchTimer);
      srmSearchTimer = setTimeout(() => srmRender(), 250);
    });
  }

  const tbody = document.querySelector('#srmTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(4)}</td></tr>`;
  const typeFilter = document.getElementById('srmTypeFilter').value;

  try {
    /* /api/requests filters on a single request_type, so "all types" is seven
       calls merged rather than one. Failures are per-type and swallowed: one
       type erroring should cost that type's rows, not the whole screen. */
    const types = typeFilter ? [typeFilter] : SERVICE_REQUEST_TYPES;
    const results = await Promise.all(types.map(t =>
      axios.get(`${API_BASE}/api/requests`, {
        headers: authHeaders(), params: { request_type: t, page: 1, page_size: 100 },
      }).then(r => r.data.items).catch(() => [])));
    srmRows = results.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    srmRender();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load service requests.</td></tr>`;
  }
}

/* Stage and search are applied here rather than server-side: neither is a
   parameter /api/requests takes — the stage is a JSONB sub-field and the
   endpoint has no free-text filter for requests — and re-fetching seven types
   per keystroke would be both slower and no more correct. */
function srmRender() {
  const tbody = document.querySelector('#srmTable tbody');
  const stage = document.getElementById('srmStageFilter').value;
  const q = document.getElementById('srmSearch').value.trim().toLowerCase();

  let rows = srmRows;
  if (stage) rows = rows.filter(r => srmStage(r) === stage);
  if (q) {
    rows = rows.filter(r => [
      r.request_number, r.booking_reference, r.pnr, r.merchant_name,
      (r.details || {}).booking_request_number,
    ].filter(Boolean).join(' ').toLowerCase().includes(q));
  }

  const actionable = srmRows.filter(r => srmStage(r) === 'actionable').length;
  const waiting = srmRows.filter(r => srmStage(r) === 'awaiting_manager').length;
  document.getElementById('srmQueueSummary').textContent =
    `${srmRows.length} request${srmRows.length === 1 ? '' : 's'}`
    + (actionable ? ` · ${actionable} ready to action` : '')
    + (waiting ? ` · ${waiting} with the merchant's manager` : '');
  updateServiceRequestNavBadge(actionable);

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td><span class="mono">${escapeHtml(r.request_number)}</span></td>
      <td>${escapeHtml(SRM_TYPE_LABELS[r.request_type] || admLabel(r.request_type))}</td>
      <td>${escapeHtml(r.merchant_name || '—')}</td>
      <td><span class="mono">${escapeHtml((r.details || {}).booking_request_number || r.booking_reference || '—')}</span>
          <div class="cell-sub">${escapeHtml(r.pnr || '')}</div></td>
      <td>${srmAsk(r)}</td>
      <td>${srmStatusCell(r)}</td>
      <td>${fmtDateTime(r.created_at)}</td>
      <td style="white-space:nowrap;">${srmActions(r)}</td>
    </tr>`).join('')
    : `<tr><td colspan="8" class="empty-state">No service requests match this filter.</td></tr>`;

  tbody.querySelectorAll('[data-srm-open]').forEach(btn =>
    btn.addEventListener('click', () => openServiceRequest(btn.dataset.srmOpen)));
  document.getElementById('srmPagination').innerHTML = '';
}

function updateServiceRequestNavBadge(count) {
  const badge = document.getElementById('srmNavBadge');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = !count;
}

/* One entry point, two dialogs. A cancellation or a date change opens the
   pricing dialog in admin-change-requests.js — it quotes the charge, derives
   the refund and applies the result to the booking. Everything else opens the
   plain approve/reject dialog below, which is all the generic resolve endpoint
   can do. Choosing here rather than at the button means a new service request
   type lands in the right dialog by default. */
function openServiceRequest(requestId) {
  const row = srmRows.find(r => String(r.id) === String(requestId));
  if (row && SRM_SETTLED_TYPES.includes(row.request_type)) {
    return openChangeRequest(requestId);
  }
  openServiceRequestResolveModal(requestId, row);
}

function openServiceRequestResolveModal(requestId, row) {
  const overlay = document.getElementById('prServiceRequestModalOverlay');
  const body = document.getElementById('prServiceRequestModalBody');
  overlay.classList.add('open');

  const readOnly = row && !SRM_OPEN.includes(row.status);
  const awaitingManager = row && srmStage(row) === 'awaiting_manager';

  body.innerHTML = `
    <h2>${escapeHtml(row ? SRM_TYPE_LABELS[row.request_type] || admLabel(row.request_type) : 'Service request')}
        ${escapeHtml(row ? row.request_number : '')}</h2>
    ${row ? `<p class="modal-sub">${escapeHtml(row.merchant_name || '')} · raised ${fmtDateTime(row.created_at)}</p>
      <div class="detail-grid">
        ${crDetailRow('Status', `<span class="badge ${srmBadge(row)}">${escapeHtml(row.status_label)}</span>`)}
        ${crDetailRow('Booking', `<span class="mono">${escapeHtml((row.details || {}).booking_request_number || '—')}</span>`)}
        ${crDetailRow('PNR', escapeHtml(row.pnr || '—'))}
        ${crDetailRow('Asked for', srmAsk(row))}
      </div>
      ${(row.manager_approval || {}).by_name ? `<div class="detail-note"><strong>Merchant's manager</strong>
        <p>${escapeHtml(row.manager_approval.by_name)} —
        ${escapeHtml(row.manager_approval.state === 'approved' ? 'approved' : 'rejected')}${
          row.manager_approval.reason ? `: ${escapeHtml(row.manager_approval.reason)}` : ''}</p></div>` : ''}
      ${row.rejection_reason ? `<div class="detail-note"><strong>Refused because</strong><p>${escapeHtml(row.rejection_reason)}</p></div>` : ''}`
    : ''}

    ${awaitingManager ? `<div class="msg info">
      This request is still with the merchant's own manager. It cannot be actioned here until they
      have approved it — the server refuses it too.</div>` : ''}
    ${readOnly && !awaitingManager ? '<div class="msg info">This request has been settled and is now read-only.</div>' : ''}

    ${!readOnly && !awaitingManager ? `
      <div class="form-field" style="max-width:none;">
        <label for="srmResolveDecision">Decision</label>
        <select id="srmResolveDecision" class="status-select" style="width:100%;">
          <option value="approve">Approve</option>
          <option value="reject">Reject</option>
        </select>
      </div>
      <div class="form-field" id="srmReasonField" style="max-width:none;display:none;">
        <label for="srmReason">Reason</label>
        <textarea id="srmReason" rows="2" style="width:100%;padding:10px 12px;border-radius:10px;border:1.5px solid var(--border-color);font-family:var(--ff);font-size:14px;"></textarea>
      </div>
      <div class="msg" id="srmModalMsg"></div>
      <div class="modal-actions" style="margin-top:16px;">
        <button type="button" class="btn btn-coral" id="srmConfirmBtn">Confirm</button>
        <button type="button" class="btn btn-ghost" id="srmCloseBtn">Cancel</button>
      </div>`
    : '<div class="modal-actions"><button type="button" class="btn btn-ghost" id="srmCloseBtn">Close</button></div>'}
  `;

  document.getElementById('srmCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
  if (readOnly || awaitingManager) return;

  document.getElementById('srmResolveDecision').addEventListener('change', e => {
    document.getElementById('srmReasonField').style.display = e.target.value === 'reject' ? 'block' : 'none';
  });
  document.getElementById('srmConfirmBtn').addEventListener('click', async () => {
    const msg = document.getElementById('srmModalMsg');
    const approve = document.getElementById('srmResolveDecision').value === 'approve';
    const reason = document.getElementById('srmReason').value.trim();
    if (!approve && !reason) { msg.textContent = 'Enter a reason for rejecting.'; msg.className = 'msg error'; return; }
    const btn = document.getElementById('srmConfirmBtn');
    btn.disabled = true;
    try {
      await axios.post(`${API_BASE}/api/admin/service-requests/${requestId}/resolve`,
        { approve, reason: reason || undefined }, { headers: authHeaders() });
      showToast(`${row ? row.request_number : 'Request'} ${approve ? 'approved' : 'rejected'}.`);
      overlay.classList.remove('open');
      loadServiceRequestManagement(srmPage);
    } catch (err) {
      btn.disabled = false;
      msg.textContent = err.response?.data?.detail || 'Failed to resolve.';
      msg.className = 'msg error';
    }
  });
}

/* ---------- Reports & Export (admin scope) ---------- GET /api/requests + GET
   /api/reports/export (both existing, live from Phase 2 — already platform-wide for an admin
   actor, no new backend needed). See API_CONTRACT.md §6.2. */
let repAdminWired = false;
const REP_ADMIN_COLUMNS = {
  bookings: ['Reference', 'Request #', 'Passenger(s)', 'Merchant', 'Amount', 'Status'],
  service_requests: ['Request #', 'Type', 'Booking Ref', 'Merchant', 'Status'],
  payments: ['Transaction ID', 'Merchant', 'Amount', 'Status', 'Paid Date'],
};
function initReportsExport() {
  if (repAdminWired) return;
  repAdminWired = true;
  document.getElementById('repAdminGenerateBtn').addEventListener('click', () => generateAdminReport());
  document.getElementById('repAdminExportPdfBtn').addEventListener('click', () => downloadAdminReport('pdf'));
  document.getElementById('repAdminExportExcelBtn').addEventListener('click', () => downloadAdminReport('xlsx'));
  document.getElementById('repAdminExportCsvBtn').addEventListener('click', () => downloadAdminReport('csv'));
  document.getElementById('repAdminType').addEventListener('change', () => generateAdminReport());
  axios.get(`${API_BASE}/api/admin/merchants`, { headers: authHeaders(), params: { page_size: 200 } })
    .then(({ data }) => {
      document.getElementById('repAdminMerchant').insertAdjacentHTML('beforeend',
        data.items.map(m => `<option value="${m.id}">${escapeHtml(m.merchant_name)}</option>`).join(''));
    }).catch(() => {});
  generateAdminReport();
}
function repAdminFilterParams() {
  return {
    merchant_id: document.getElementById('repAdminMerchant').value || undefined,
    date_from: document.getElementById('repAdminFrom').value || undefined,
    date_to: document.getElementById('repAdminTo').value || undefined,
  };
}
/* M6. The table below shows one page; the export sends every matching row. That
   difference used to be invisible — a desk saw 100 rows and downloaded 2,600 —
   so the screen now states the size of the file it is offering, from
   /api/reports/summary, which is built from the export's own row builders. */
async function renderAdminReportSummary(type) {
  const host = document.getElementById('repAdminSummary');
  host.innerHTML = '';
  try {
    const { data } = await axios.get(`${API_BASE}/api/reports/summary`, {
      headers: authHeaders(), params: { type, ...repAdminFilterParams() },
    });
    const value = data.total_value === null ? '' :
      ` · worth <b>${escapeHtml(moneyStr(data.total_value))}</b>`;
    host.innerHTML = `<div class="rep-summary">
      These filters match <b>${data.rows}</b> row${data.rows === 1 ? '' : 's'}${value}.
      The table shows the first page; an export contains all ${data.rows}.
      Dates filter on <b>${escapeHtml(data.date_field.replace('_', ' '))}</b>.
      ${data.truncated ? `<em>At least ${data.row_cap} rows match — the export stops at that
        limit, so narrow the range for a complete file.</em>` : ''}
    </div>`;
  } catch {
    /* The table is the point of the screen; a missing header must not stop it. */
    host.innerHTML = '<div class="rep-summary">Row totals are unavailable just now.</div>';
  }
}

async function generateAdminReport() {
  const type = document.getElementById('repAdminType').value;
  const thead = document.querySelector('#repAdminTable thead');
  const tbody = document.querySelector('#repAdminTable tbody');
  const cols = REP_ADMIN_COLUMNS[type];
  thead.innerHTML = `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
  tbody.innerHTML = `<tr><td colspan="${cols.length}">${rowsSkeleton(3)}</td></tr>`;
  renderAdminReportSummary(type);
  try {
    if (type === 'payments') {
      const { data } = await axios.get(`${API_BASE}/api/admin/payments`, { headers: authHeaders(), params: { ...repAdminFilterParams(), page_size: 100 } });
      tbody.innerHTML = data.items.map(p => `<tr><td>${escapeHtml(p.transaction_id || '—')}</td><td>—</td><td>${moneyStr(p.amount)}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td><td>${p.paid_date ? fmtDate(p.paid_date) : '—'}</td></tr>`).join('')
        || `<tr><td colspan="5" class="empty-state">No results.</td></tr>`;
    } else if (type === 'bookings') {
      const { data } = await axios.get(`${API_BASE}/api/requests`, { headers: authHeaders(), params: { request_type: 'booking', ...repAdminFilterParams(), page_size: 100 } });
      tbody.innerHTML = data.items.map(r => `<tr><td>${escapeHtml(r.booking_reference || '—')}</td><td>${escapeHtml(r.request_number)}</td><td>${r.passengers?.map(p => `${p.first_name} ${p.last_name}`).join(', ') || '—'}</td><td>${escapeHtml(r.merchant_name || '—')}</td><td>${moneyStr(r.total_amount)}</td><td><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></td></tr>`).join('')
        || `<tr><td colspan="6" class="empty-state">No results.</td></tr>`;
    } else {
      const results = await Promise.all(SERVICE_REQUEST_TYPES.map(t => axios.get(`${API_BASE}/api/requests`, {
        headers: authHeaders(), params: { request_type: t, ...repAdminFilterParams(), page_size: 100 },
      }).then(r => r.data.items).catch(() => [])));
      const items = results.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      tbody.innerHTML = items.map(r => `<tr><td>${escapeHtml(r.request_number)}</td><td style="text-transform:capitalize">${escapeHtml(r.request_type.replace(/_/g, ' '))}</td><td>${escapeHtml(r.booking_reference || '—')}</td><td>${escapeHtml(r.merchant_name || '—')}</td><td><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></td></tr>`).join('')
        || `<tr><td colspan="5" class="empty-state">No results.</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty-state">Failed to generate report.</td></tr>`;
  }
}
async function downloadAdminReport(format) {
  const type = document.getElementById('repAdminType').value;
  try {
    const response = await axios.get(`${API_BASE}/api/reports/export`, {
      headers: authHeaders(), params: { type, format, ...repAdminFilterParams() }, responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url; a.download = `${type}-report-${new Date().toISOString().slice(0, 10)}.${format}`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { alert('Failed to export report.'); }
}

/* ---------- Profile (admin's own account) ---------- GET/PUT /api/profile (existing, shared
   across all 3 portals — API_CONTRACT.md §6.6), change-password via existing
   /api/auth/change-password. */
async function loadAdminProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/profile`, { headers: authHeaders() });
    document.getElementById('adminProfileName').value = data.full_name;
    document.getElementById('adminProfileEmail').value = data.email;
  } catch (err) { /* fields stay blank */ }
}
document.getElementById('adminProfileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('adminProfileMsg');
  try {
    const { data } = await axios.put(`${API_BASE}/api/profile`, { full_name: document.getElementById('adminProfileName').value }, { headers: authHeaders() });
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
    await axios.post(`${API_BASE}/api/auth/change-password`, {
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

/* ---------- Payment Verification — RETIRED (0041) ----------
   The per-booking payment table, its Verify/Reject buttons and the refund
   prompt used to live here. Payment Management now hosts the admin-initiated
   request workflow instead (assets/js/admin-payment-requests.js), so this
   screen's markup no longer exists and every function that reached into it
   would throw on a null element.

   ONLY THE UI IS GONE. `GET /api/admin/payments`, `POST .../verify` and
   `POST .../refund` are untouched and still serve Reports, Analytics and the
   per-booking payment records — nothing was removed from the API, and a
   payment already taken still settles exactly as before. */

/* ---------- Support Management / Live Chat ---------- GET/POST /api/support/threads,
   /api/support/threads/{id}/messages|claim|resolve, GET /api/support/unread-count
   (app/routers/support_tickets.py). "Support Management" is the queue over every merchant's
   chat threads; opening a row shows the same conversation the merchant sees under its own
   "Live Chat" — one feature, not two, per app/services/chat_service.py. */
let supportStatusFiltersWired = false;
let currentChatThreadId = null;
function supportStatusBadgeClass(label) {
  if (label === 'Resolved') return 'confirmed';
  if (label === 'In Progress') return 'pending';
  return 'cancelled';
}
async function loadSupportQueue() {
  if (!supportStatusFiltersWired) {
    supportStatusFiltersWired = true;
    document.getElementById('supportStatusFilter').addEventListener('change', () => loadSupportQueue());
  }
  const tbody = document.querySelector('#supportTable tbody');
  tbody.innerHTML = `<tr><td colspan="7">${rowsSkeleton(4)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/support/threads`, {
      headers: authHeaders(),
      params: { status: document.getElementById('supportStatusFilter').value || undefined, page_size: 50 },
    });
    tbody.innerHTML = data.items.length ? data.items.map(t => `
      <tr>
        <td>${escapeHtml(t.request_number)}${t.title ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(t.title)}</div>` : ''}</td>
        <td>${escapeHtml(t.merchant_name || '—')}</td>
        <td>${escapeHtml(t.opened_by || '—')}</td>
        <td><span class="badge ${supportStatusBadgeClass(t.status_label)}">${escapeHtml(t.status_label)}</span></td>
        <td>${t.message_count}</td>
        <td>${t.last_message_at ? fmtDateTime(t.last_message_at) : fmtDateTime(t.created_at)}</td>
        <td><button class="btn btn-navy btn-sm" data-open-chat="${t.id}">Open</button></td>
      </tr>
    `).join('') : `<tr><td colspan="7" class="empty-state">No support chats right now.</td></tr>`;
    tbody.querySelectorAll('[data-open-chat]').forEach(btn => {
      btn.addEventListener('click', () => openSupportChat(btn.dataset.openChat));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Failed to load support threads.</td></tr>`;
  }
  refreshSupportBadge();
}

function renderChatMessages(messages) {
  const el = document.getElementById('supportChatMessages');
  el.innerHTML = messages.length ? messages.map(m => `
    <div class="chat-msg ${m.direction === 'outbound' ? 'chat-msg-out' : 'chat-msg-in'}">
      <div class="chat-msg-meta">${escapeHtml(m.sender_name || (m.direction === 'outbound' ? 'Support' : 'Merchant'))} · ${fmtDateTime(m.created_at)}</div>
      <div class="chat-msg-body">${escapeHtml(m.message || '')}</div>
    </div>
  `).join('') : '<div class="empty-state">No messages yet.</div>';
  el.scrollTop = el.scrollHeight;
}

async function openSupportChat(threadId) {
  currentChatThreadId = threadId;
  document.getElementById('supportChatDrawerOverlay').classList.add('open');
  document.getElementById('supportChatTitle').textContent = 'Loading…';
  document.getElementById('supportChatMessages').innerHTML = rowsSkeleton(4);
  try {
    const { data } = await axios.get(`${API_BASE}/api/support/threads/${threadId}`, { headers: authHeaders() });
    document.getElementById('supportChatTitle').textContent = `${data.thread.request_number} — ${data.thread.merchant_name || 'Merchant'}`;
    document.getElementById('supportChatSubtitle').textContent = `${data.thread.status_label} · opened by ${data.thread.opened_by || '—'}`;
    renderChatMessages(data.messages);
    document.getElementById('supportChatClaimBtn').style.display = data.thread.status_label === 'Open' ? '' : 'none';
    document.getElementById('supportChatResolveBtn').style.display = data.thread.status_label !== 'Resolved' ? '' : 'none';
    document.getElementById('supportChatReplyInput').disabled = data.thread.status_label === 'Resolved';
  } catch (err) {
    document.getElementById('supportChatTitle').textContent = 'Failed to load chat';
  }
}
document.getElementById('supportChatCloseBtn').addEventListener('click', () => {
  document.getElementById('supportChatDrawerOverlay').classList.remove('open');
});
document.getElementById('supportChatReplyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('supportChatReplyInput');
  const message = input.value.trim();
  if (!message || !currentChatThreadId) return;
  try {
    const { data } = await axios.post(`${API_BASE}/api/support/threads/${currentChatThreadId}/messages`, { message }, { headers: authHeaders() });
    input.value = '';
    renderChatMessages(data.messages);
    document.getElementById('supportChatSubtitle').textContent = `${data.thread.status_label} · opened by ${data.thread.opened_by || '—'}`;
    document.getElementById('supportChatClaimBtn').style.display = data.thread.status_label === 'Open' ? '' : 'none';
    document.getElementById('supportChatResolveBtn').style.display = data.thread.status_label !== 'Resolved' ? '' : 'none';
  } catch (err) {
    alert(err.response?.data?.detail || 'Failed to send message.');
  }
});
document.getElementById('supportChatClaimBtn').addEventListener('click', async () => {
  try {
    await axios.post(`${API_BASE}/api/support/threads/${currentChatThreadId}/claim`, {}, { headers: authHeaders() });
    openSupportChat(currentChatThreadId);
    if (loadedSections.has('support')) loadSupportQueue();
  } catch (err) { alert(err.response?.data?.detail || 'Failed to claim.'); }
});
document.getElementById('supportChatResolveBtn').addEventListener('click', async () => {
  if (!confirm('Mark this chat resolved and close it?')) return;
  try {
    await axios.post(`${API_BASE}/api/support/threads/${currentChatThreadId}/resolve`, {}, { headers: authHeaders() });
    openSupportChat(currentChatThreadId);
    if (loadedSections.has('support')) loadSupportQueue();
  } catch (err) { alert(err.response?.data?.detail || 'Failed to resolve.'); }
});
async function refreshSupportBadge() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/support/unread-count`, { headers: authHeaders() });
    const badge = document.getElementById('supportNavBadge');
    badge.textContent = data.count;
    badge.style.display = data.count > 0 ? '' : 'none';
  } catch (err) { /* badge just won't update this cycle */ }
}

/* ---------- Communication / Broadcast (admin) ---------- POST /api/admin/notifications/
   broadcast (new), GET /api/notifications (existing, admin's own inbox — API_CONTRACT.md
   §4.4/§6.4). There's no "list every broadcast ever sent platform-wide" endpoint — that would
   be a new audit capability nothing in the approved contract asked for — so this table shows
   the admin's own notifications, same as every other portal's bell. */
async function initNotificationForm() {
  const allCheckbox = document.getElementById('bcAllMerchants');
  const pickerField = document.getElementById('bcMerchantPickerField');
  const picker = document.getElementById('bcMerchantPicker');
  allCheckbox.addEventListener('change', () => { pickerField.style.display = allCheckbox.checked ? 'none' : ''; });
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/merchants`, { headers: authHeaders(), params: { status: 'active', page_size: 200 } });
    picker.innerHTML = data.items.map(m => `<option value="${m.id}">${escapeHtml(m.merchant_name)}</option>`).join('');
  } catch (err) { /* picker stays empty; "all merchants" still works */ }

  document.getElementById('broadcastForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const msg = document.getElementById('broadcastMsg');
    const merchantIds = allCheckbox.checked ? null : Array.from(picker.selectedOptions).map(o => Number(o.value));
    try {
      const { data } = await axios.post(`${API_BASE}/api/admin/notifications/broadcast`, {
        merchant_ids: merchantIds, title: form.elements.title.value, message: form.elements.message.value,
      }, { headers: authHeaders() });
      msg.textContent = `Sent to ${data.sent} user(s)${data.skipped ? `, skipped ${data.skipped} (notifications disabled)` : ''}.`;
      msg.className = 'msg success';
      form.reset();
      allCheckbox.checked = true;
      pickerField.style.display = 'none';
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to send broadcast.';
      msg.className = 'msg error';
    }
  });

  await loadNotificationsAdmin();
}

async function loadNotificationsAdmin() {
  const tbody = document.querySelector('#notificationsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/notifications`, { headers: authHeaders(), params: { page_size: 20 } });
    tbody.innerHTML = data.items.map(n => `
      <tr>
        <td>${escapeHtml(n.title || '—')}</td>
        <td>${escapeHtml(n.message || '—')}</td>
        <td><span class="badge ${n.is_read ? 'read' : 'unread'}">${n.is_read ? 'Read' : 'Unread'}</span></td>
        <td>${fmtDate(n.created_at)}</td>
      </tr>
    `).join('') || `<tr><td colspan="4" class="empty-state">No notifications yet.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Failed to load notifications.</td></tr>`;
  }
}

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

/* ---------- Presence heartbeat: reports this admin as "online" for the Active Users list ----------
   POST /api/profile/heartbeat (app/routers/profile.py) — extends this session's online window in
   session_service; GET /api/admin/users returns is_online per row computed from the same table. */
function sendHeartbeat() {
  const label = sectionTitles[document.querySelector('.nav-item[data-section].active')?.dataset.section] || 'Admin Dashboard';
  axios.post(`${API_BASE}/api/profile/heartbeat`, { current_page: `Admin: ${label}` }, { headers: authHeaders() }).catch(() => {});
}

/* These all need a valid session, so they start once showAdminPortal() runs — right after
   login, or immediately at boot if the session was already valid — rather than unconditionally
   on script load, which would fire (and poll) against the auth shell before anyone signs in. */
function startAdminPolling() {
  loadReports();
  loadNotifBell();
  setInterval(loadNotifBell, 15000);
  refreshSupportBadge();
  setInterval(refreshSupportBadge, 20000);
  sendHeartbeat();
  setInterval(sendHeartbeat, 30000);
}

/* Boot check — deliberately the last statement in this file, not the first. showAdminPortal()
   -> startAdminPolling() -> sendHeartbeat() reads `sectionTitles` (declared near the top of
   this file as a `const`), so calling it before the whole script has finished its top-level
   execution would hit the temporal dead zone and throw, silently aborting every statement
   after that point in the file — including the sidebar nav click-handler wiring further down.
   Running this last guarantees every const/function above is already initialized. */
if (isAdminLoggedIn()) { showAdminPortal(); } else { showAdminAuthShell(); }
