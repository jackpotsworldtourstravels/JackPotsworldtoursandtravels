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
      /* An expired or revoked session is a sign-out nobody asked for, and ends
         where Sign Out ends — the public partner login. The Admin sign-in card
         below is still what a deliberate visit to /admin/ gets, and a rejected
         password must leave them on it (auth.js::isSessionEndingUnauthorized). */
      if (isSessionEndingUnauthorized(err)) {
        clearStoredAuth();
        redirectToPortalLogin();
      }
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
  /* Keep the header profile menu in step — this runs AFTER initAdminChip() on a
     fresh sign-in, so without it the menu would show the pre-login placeholder. */
  const menuName = document.getElementById('adminProfileMenuName');
  if (menuName) {
    menuName.textContent = name;
    document.getElementById('adminProfileMenuEmail').textContent = user.email || '';
  }
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
  // Clears the session and leaves for the public partner login; nothing to
  // draw afterwards, so the auth shell is no longer shown here.
  await logoutPortalSession('admin');
});

/* Back after signing out must not restore this portal. A deliberate visit to
   /admin/ with no session still gets the Admin sign-in card — see
   auth.js::guardPortalSession. */
guardPortalSession(isAdminLoggedIn);

/* ---------- Section navigation ---------- */
const sectionTitles = {
  reports: 'Dashboard', users: 'Merchant Management', 'active-users': 'Active Users',
  support: 'Support Management', 'reports-export': 'Reports', analytics: 'Analytics',
  payments: 'Payment Management',
  'partner-requests': 'Approval Queue', 'service-requests-mgmt': 'Service Request Management',
  'ticket-enquiries': 'Booking Enquiries',
  'booking-ops': 'Booking Operations',
  notifications: 'Communication', profile: 'Profile',
  /* Moved here from the Super Admin Portal; see assets/js/admin-logs.js. */
  audit: 'Audit Logs', 'system-logs': 'System Logs',
  /* THESE TWO WERE MISSING, AND THE TOPBAR WENT BLANK ON THEM. Every other
     section is keyed here, so `sectionTitles[name]` returned undefined for
     Provider Management and Wallet & Top-ups and `textContent = undefined`
     emptied the h1 — the page kept the date underneath it and lost its name.
     Found by walking all seventeen sections and reading the title each time,
     which is not something a screenshot of one screen shows. */
  providers: 'Provider Management', 'wallet-desk': 'Wallet & Top-ups',
};
const loadedSections = new Set();

/* Shared by the sidebar nav clicks and any programmatic jump (Quick Actions, global search results) —
   `onArrive` runs after the section is loaded (or immediately if it was already loaded), so callers can
   apply a filter/scroll without duplicating loadSection's logic. */
function navigateToSection(name, onArrive) {
  document.querySelectorAll('.nav-item[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  /* `|| ''` so a section added to the markup without a title here empties the
     heading rather than writing the string "undefined" into it. */
  document.getElementById('pageTitle').textContent = sectionTitles[name] || '';
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

/* ---------- Global search — REMOVED (2026-08-10) ----------
   The header search box was removed from the Admin Portal on request, so the
   ~75 lines that fed it went with it: `runGlobalSearch`, its debounce timer,
   its `#globalSearchInput` / `#globalSearchDropdown` handles and the
   document-level click that closed the dropdown.

   THIS BLOCK COULD NOT SIMPLY BE LEFT IN PLACE. `gsInput` and `gsDropdown` were
   resolved at parse time and `gsInput.addEventListener` ran unconditionally, so
   with the markup gone this file would have thrown a TypeError before it
   reached the dashboard — taking every screen after it down with it.

   NO ENDPOINT CHANGED. It only ever called list endpoints that already support
   `search` (`/api/admin/merchants`, `/api/requests`,
   `/api/admin/wallet/topups`), and each of those screens still has its own
   filter bar calling the same parameter. Nothing became unsearchable. */

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
        <td class="jp-truncate" title="${escapeHtml(m.merchant_name)}">${escapeHtml(m.merchant_name)}</td>
        <td>${escapeHtml(m.country_code || '—')}</td>
        <td class="num">${m.user_count}</td>
        <td class="num">${moneyStr(m.wallet_balance)}</td>
        <td class="num">${m.tickets_issued ?? 0}</td>
        <td class="num">${m.awaiting_verification
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
/* Service / Product Access — three rows, each a checkbox plus an icon
   borrowed verbatim from Merchant Classic's icon table (classic-icons.js)
   rather than inventing new glyphs. No dedicated Visa icon exists anywhere
   yet, so it reuses `shield`, same as the Merchant Portal's own Visa nav
   item will (see classic-shell.js). */
const ADMIN_SERVICE_ICONS = {
  flights: '<path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2a.5.5 0 0 0-.5.8l3.4 3.4-2 2H3.5l-.7 1.4 3 1.6 1.6 3 1.4-.7v-2.2l2-2 3.4 3.4a.5.5 0 0 0 .8-.5z"/>',
  hotels: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><line x1="8" y1="6" x2="8" y2="6.01"/><line x1="12" y1="6" x2="12" y2="6.01"/><line x1="16" y1="6" x2="16" y2="6.01"/><line x1="8" y1="10" x2="8" y2="10.01"/><line x1="12" y1="10" x2="12" y2="10.01"/><line x1="16" y1="10" x2="16" y2="10.01"/>',
  visa: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  holidays: '<circle cx="12" cy="9" r="4"/><path d="M12 13v9"/><path d="M8 22h8"/><path d="M5 13c2-1 4.5-1.5 7-1.5s5 .5 7 1.5"/>',
};
function adminServiceIcon(code) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"
    >${ADMIN_SERVICE_ICONS[code]}</svg>`;
}
const SERVICE_ACCESS_COPY = [
  { code: 'flights', label: 'Flights', desc: 'Search flights, create flight enquiries, manage bookings and issue tickets.' },
  { code: 'hotels', label: 'Hotels', desc: 'Search hotels, create hotel enquiries and manage hotel bookings.' },
  { code: 'visa', label: 'Visa', desc: 'Submit visa applications, upload documents and manage visa requests.' },
  { code: 'holidays', label: 'Holidays', desc: 'Coming soon — reserves the merchant’s access ahead of the Holidays product shipping.' },
];
/* Renders the checkbox list. `access` is a {flights,hotels,visa,holidays} map
   (or null for a brand-new merchant, which falls back to the same defaults
   migration 0045/0049 seed server-side: Flights on, the newer products
   opt-in). */
function serviceAccessRows(access) {
  const a = access || { flights: true, hotels: false, visa: false, holidays: false };
  return SERVICE_ACCESS_COPY.map(s => `
    <label class="svc-item">
      <input type="checkbox" name="svc_${s.code}" ${a[s.code] ? 'checked' : ''}>
      <span class="svc-icon">${adminServiceIcon(s.code)}</span>
      <span class="svc-copy">
        <strong class="svc-name">${s.label}</strong>
        <span class="svc-desc">${s.desc}</span>
      </span>
    </label>
  `).join('');
}

async function openOnboardMerchantModal(merchantId) {
  const overlay = document.getElementById('onboardMerchantModalOverlay');
  const body = document.getElementById('onboardMerchantModalBody');
  let m = null;
  if (merchantId) {
    try { m = (await axios.get(`${API_BASE}/api/admin/merchants/${merchantId}`, { headers: authHeaders() })).data; }
    catch (err) { alert('Failed to load merchant.'); return; }
  }
  const v = (field, fallback = '') => m ? (m[field] ?? fallback) : fallback;
  /* THREE FIELDS ARE ASKED FOR; THE EIGHT THAT WENT ARE NOT ALL SIMPLY GONE.
     Merchant Name, Company Type, Credit Limit, Address, City, Country, Contact
     Person and Contact Email were removed from this form on request. Five of
     them — company_type, credit_limit, address, city, country — are optional
     server-side and are now just omitted, which leaves the column at its
     default on create and untouched on edit.

     The other three are NOT optional. CreateMerchantRequest requires
     `merchant_name`, `contact_person` and `contact_email`, and this work is not
     allowed to change the API, so they are DERIVED from what is still asked
     for — see the submit handler below. Two consequences worth knowing:
     the merchant's trading name starts equal to its company name, and the first
     admin login is created against the company email rather than a separate
     contact address. Both are editable afterwards.

     `span-2` on Company Name is what makes three fields read as a balanced
     form rather than a two-column grid with a hole in it: the name gets its own
     full-width row, then Email and Phone pair off underneath.

     EMAIL IS EDITABLE ON EDIT TOO, as of 2026-08-10. It used to carry
     `disabled` whenever `m` was set, which meant a company that came in with a
     typo in its address could never be corrected from this portal — Name and
     Phone could be, the address could not. What made it possible is
     `UpdateMerchantRequest.email` plus the uniqueness check in
     `merchant_service.update_merchant`; no new endpoint was added and the PUT
     this form already used is the one that carries it.

     THE HELPER LINE UNDER IT SAYS SOMETHING DIFFERENT ON EDIT, AND THAT IS THE
     POINT. On create, this address really does seed the first admin login, so
     it says so. On edit it does NOT: that login is a `users` row of its own by
     then and has diverged from this field, so telling an admin they are
     changing a login when they are changing a contact address would be wrong in
     the one direction that costs somebody their sign-in. */
  body.innerHTML = `
    <h2>${m ? 'Edit Merchant' : 'Onboard Merchant'}</h2>
    <form id="onboardMerchantForm">
      <div class="onboard-columns">
        <div class="onboard-col-main">
          <div class="form-section-title">Merchant Information</div>
          <div class="form-grid">
            <div class="form-field span-2"><label>Company Name</label>
              <input name="company_name" required maxlength="150" autocomplete="off"
                     value="${escapeHtml(v('company_name'))}" placeholder="e.g. Skyline Travel Services">
            </div>
            <div class="form-field"><label>Email</label>
              <input name="email" type="email" required maxlength="255" autocomplete="off"
                     value="${escapeHtml(v('email'))}">
              <span class="cell-sub">${m
                ? 'The company’s contact address. Sign-in emails are managed under Users.'
                : 'Also becomes the first admin login for this merchant.'}</span>
            </div>
            <div class="form-field"><label>Phone</label><input name="phone" value="${escapeHtml(v('phone'))}"></div>
          </div>
        </div>
        <div class="onboard-col-side">
          <div class="form-section-title">Service / Product Access</div>
          <p class="cell-sub">Select which travel services this merchant is allowed to access.</p>
          <div class="svc-list">${serviceAccessRows(m ? m.service_access : null)}</div>
          ${m ? `
            <div class="msg" id="serviceAccessMsg"></div>
            <button type="button" class="btn btn-ghost svc-save-btn" id="saveServiceAccessBtn">Save Service Access</button>
          ` : ''}
        </div>
      </div>
      <div class="msg" id="onboardMerchantMsg"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="onboardMerchantCancelBtn">Cancel</button>
        <button type="submit" class="btn btn-coral">${m ? 'Save Changes' : 'Save Merchant'}</button>
      </div>
    </form>
  `;
  overlay.classList.add('open');
  document.getElementById('onboardMerchantCancelBtn').addEventListener('click', () => overlay.classList.remove('open'));
  /* EDIT ONLY. Independent of the merchant-fields form: its own PATCH, its
     own success message, and it never requires the merchant to be recreated
     or the rest of the form to validate. */
  document.getElementById('saveServiceAccessBtn')?.addEventListener('click', async () => {
    const f = document.getElementById('onboardMerchantForm').elements;
    const msg = document.getElementById('serviceAccessMsg');
    const btn = document.getElementById('saveServiceAccessBtn');
    const payload = {
      flights: f.svc_flights.checked,
      hotels: f.svc_hotels.checked,
      visa: f.svc_visa.checked,
      holidays: f.svc_holidays.checked,
    };
    btn.disabled = true;
    msg.textContent = '';
    msg.className = 'msg';
    try {
      await axios.patch(`${API_BASE}/api/admin/merchants/${merchantId}/service-access`, payload, { headers: authHeaders() });
      msg.textContent = 'Merchant service access updated successfully.';
      msg.className = 'msg success';
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Failed to update service access.';
      msg.className = 'msg error';
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('onboardMerchantForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const msg = document.getElementById('onboardMerchantMsg');
    const companyName = f.company_name.value.trim();
    const email = f.email.value.trim();

    /* VALIDATED HERE AS WELL AS SERVER-SIDE, because the two answer different
       questions. `required` + `type=email` in the markup is the browser's check
       and it never runs on a `disabled` field — which is exactly why this needed
       adding the moment the field became editable. The server's `EmailStr` is
       the authority and returns 422; that is a correct rejection but a poor
       message, so the obvious cases are named in the dialog instead.

       The pattern is the same one the platform's other email inputs use: one
       `@`, at least one dot in the domain, no whitespace. Deliberately loose —
       anything stricter starts rejecting addresses that genuinely deliver, and
       the server has the real parser. DUPLICATES ARE NOT CHECKED HERE: only the
       database knows, and `update_merchant` already answers with a 400 whose
       `detail` this handler surfaces verbatim. */
    if (!email) {
      msg.textContent = 'Email is required.';
      msg.className = 'msg error';
      f.email.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      msg.textContent = 'Enter a valid email address, e.g. accounts@company.com.';
      msg.className = 'msg error';
      f.email.focus();
      return;
    }

    /* EDIT SENDS ONLY WHAT THE FORM STILL ASKS FOR.
       UpdateMerchantRequest changes only the fields present in the body, so
       omitting company_type / credit_limit / address / city / country here
       LEAVES THE EXISTING VALUES ALONE. Sending them as null instead would wipe
       the address of every merchant onboarded before this change. `merchant_name`
       is omitted for the same reason: renaming the company should not silently
       overwrite a trading name somebody set deliberately.

       `email` IS now one of the fields it asks for, so it is sent on edit as
       well as on create — the same key, into the same PUT, handled by the same
       `UpdateMerchantRequest`. Sent unconditionally rather than only when it
       changed: the server compares against the stored value before it touches
       the uniqueness constraint, so an unchanged address is a no-op there and
       the client does not have to track dirtiness to stay correct. */
    const payload = {
      company_name: companyName,
      email,
      phone: f.phone.value.trim() || null,
    };
    if (!m) {
      /* Create needs the three the schema marks required. The form's 150-char
         cap on Company Name is not cosmetic — it is `merchant_name`'s and
         `contact_person`'s limit (company_name itself allows 200), so a name
         that fits the input always fits everything derived from it. */
      payload.merchant_name = companyName;
      payload.contact_person = companyName;
      payload.contact_email = email;   /* `email` itself is already on the payload */
      /* company_type and credit_limit are left off entirely: the schema
         defaults them to `business_partner` and 0, and both are editable
         afterwards through the API. */
      /* Service access is CREATE-ONLY here. On edit, the boxes still render
         (pre-checked from `m.service_access`) but changing them does nothing
         until "Save Service Access" is clicked — that button, not this form,
         owns updates after the merchant exists (see the independent PATCH
         handler above). */
      payload.service_access = {
        flights: f.svc_flights.checked,
        hotels: f.svc_hotels.checked,
        visa: f.svc_visa.checked,
        holidays: f.svc_holidays.checked,
      };
    }
    try {
      if (m) {
        await axios.put(`${API_BASE}/api/admin/merchants/${merchantId}`, payload, { headers: authHeaders() });
        overlay.classList.remove('open');
        /* SAVING FROM THE DETAIL PAGE RETURNS TO THE DETAIL PAGE. This used to
           call `loadMerchants()` unconditionally, which swaps the pane back to
           the list — so the one screen showing the field you just edited was the
           one you were sent away from, and the only way to see the new address
           was to find the row again. Edit is only reachable from the detail
           view, so `openMerchantDetail` re-fetches and re-renders it with the
           saved values; the list is still refreshed when Edit was opened from
           there (it cannot be today, but the branch is what makes that safe). */
        if (document.getElementById('merchantDetailPanel')?.style.display !== 'none') {
          openMerchantDetail(merchantId);
        } else {
          loadMerchants();
        }
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
            <button class="btn btn-danger btn-sm" id="deleteMerchantBtn">Delete</button>
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
    document.getElementById('deleteMerchantBtn')?.addEventListener('click', async e => {
      // Captured before the `await` below: the browser clears
      // Event#currentTarget once synchronous dispatch finishes, so reading
      // it after an await returns null.
      const btn = e.currentTarget;
      const ok = await confirmDialog({
        title: `Delete ${m.company_name}?`,
        message: 'This action will also remove all associated merchant users. This action cannot be undone.',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        await axios.delete(`${API_BASE}/api/admin/merchants/${merchantId}`, { headers: authHeaders() });
        showToast('Merchant deleted.');
        loadMerchants(merchantsPage);
      } catch (err) {
        alert(err.response?.data?.detail || 'Failed to delete merchant.');
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    });
    loadMerchantUsersTable(merchantId, m.company_name);
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
            <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>
          </tr></thead><tbody>
            ${entries.length ? entries.map(en => `
              <tr>
                <td>${escapeHtml(en.at ? fmtDate(en.at) : '—')}</td>
                <td>${escapeHtml(en.reference || '—')}</td>
                <td class="jp-truncate" title="${escapeHtml(en.description || en.kind)}">${escapeHtml(en.description || en.kind)}</td>
                <td class="num">${moneyIsPositive(en.debit) ? escapeHtml(moneyStr(en.debit)) : ''}</td>
                <td class="num">${moneyIsPositive(en.credit) ? escapeHtml(moneyStr(en.credit)) : ''}</td>
                <td class="num">${escapeHtml(moneyStr(en.balance))}</td>
              </tr>`).join('')
              : '<tr><td colspan="6" class="empty-state">No ledger entries.</td></tr>'}
          </tbody>
          ${entries.length ? `<tfoot><tr>
            <td colspan="3"><strong>Totals</strong></td>
            <td class="num"><strong>${escapeHtml(moneyStr(s.total_debits))}</strong></td>
            <td class="num"><strong>${escapeHtml(moneyStr(s.total_credits))}</strong></td>
            <td class="num"><strong>${escapeHtml(moneyStr(s.closing_balance))}</strong></td>
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
    <!-- The -10px this used to carry pulled the line up through the header's
         divider and under the sticky title; §15 owns the gap now. -->
    <p style="font-size:13px;color:var(--text-muted);font-weight:600;">
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

async function loadMerchantUsersTable(merchantId, merchantName) {
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
        <td class="jp-truncate" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</td>
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
      btn.addEventListener('click', () => openMerchantUserDetail(merchantId, byId.get(btn.dataset.viewMu), merchantName));
    });
    tbody.querySelectorAll('[data-status-mu]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.patch(
            `${API_BASE}/api/admin/merchants/${merchantId}/users/${btn.dataset.statusMu}/status`,
            { status: btn.dataset.next }, { headers: authHeaders() });
          loadMerchantUsersTable(merchantId, merchantName);
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
function openMerchantUserDetail(merchantId, u, merchantName) {
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
      <button type="button" class="btn btn-danger" id="muDetailDeleteBtn">Delete</button>
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
      loadMerchantUsersTable(merchantId, merchantName);
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
  document.getElementById('muDetailDeleteBtn').addEventListener('click', async e => {
    // Captured before the `await` below — see the matching note on the
    // merchant delete handler above.
    const btn = e.currentTarget;
    const ok = await confirmDialog({
      title: `Delete ${u.full_name}?`,
      message: `Role: ${merchantRoleType(u)} · Merchant: ${merchantName || '—'}. This action cannot be undone.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await axios.delete(`${API_BASE}/api/admin/merchants/${merchantId}/users/${u.id}`, { headers: authHeaders() });
      showToast('Merchant user deleted.');
      close();
      loadMerchantUsersTable(merchantId, merchantName);
    } catch (err) {
      alert(err.response?.data?.detail || 'Failed to delete this user.');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });
}

function showMerchantView(view) {
  document.getElementById('merchantBreadcrumb').innerHTML = 'Admin Portal / <span>Merchant Management</span>';
  document.getElementById('merchantListPanel').style.display = view === 'list' ? '' : 'none';
  document.getElementById('merchantDetailPanel').style.display = view === 'detail' ? '' : 'none';
}

/* ---------- Active Users ---------- GET /api/admin/users (API_CONTRACT.md §4.1).

   WHO IS ACTUALLY USING THE PLATFORM, AND FROM WHERE. Every row carries a
   presence badge and the connection its most recent session came from. All of
   it is served by the endpoint — see schemas/accounts.py::AccountResponse —
   so nothing here is computed from a clock the browser owns.

   FOUR STATES, AND WHY NEVER LOGGED IN IS ONE OF THEM. An account that exists
   but has never been signed into is a real and actionable thing: an invitation
   that never landed, a starter password never used. Rendering it as an empty
   Last Login cell made it indistinguishable from a column that failed to load,
   so it says so in words.

   EVERY UNKNOWN IS SHOWN AS "—" AND NEVER INVENTED. A browser that sends no
   client hints genuinely does not tell us its OS version, and a user on the
   public internet has no LAN address we can see. Those lines are omitted
   rather than filled with a plausible-looking guess. */
const AU_PRESENCE = {
  /* The badge classes are admin.css's existing status vocabulary — this screen
     does not introduce a parallel set of chips for four states. */
  online:          { cls: 'active',    dot: '#16a34a', label: 'Online' },
  recently_active: { cls: 'pending',   dot: '#d97706', label: 'Recently Active' },
  offline:         { cls: 'inactive',  dot: '#94a3b8', label: 'Offline' },
  never_logged_in: { cls: 'cancelled', dot: '#dc2626', label: 'Never Logged In' },
};

function auPresenceBadge(u) {
  const spec = AU_PRESENCE[u.presence] || AU_PRESENCE.offline;
  const seen = u.last_seen_at ? ` — last seen ${fmtDateTime(u.last_seen_at)}` : '';
  return `<span class="badge ${spec.cls} au-presence" title="${escapeHtml(spec.label + seen)}">
    <span class="au-dot" style="background:${spec.dot}"></span>${escapeHtml(u.presence_label || spec.label)}
  </span>`;
}

/* "Other" IS NOT A VALUE, IT IS A SENTINEL. The user-agent parser wrote it
   until 2026-08-06 for anything it did not recognise, and rows from before then
   still carry it. On screen it is indistinguishable from a browser genuinely
   called Other, so it is dropped exactly like a missing field — declining to
   print "unknown" is not the same as inventing something. The parser no longer
   produces it (services/activity_service.py::_browser_name). */
const auReal = v => (v && v !== 'Other' ? v : null);

/* Two lines: what they signed in on, and what they browsed with. Both are
   absent for an account that has never had a session, which is the one case
   where "Never Logged In" is the honest answer in every column. */
function auDeviceCell(u) {
  if (!u.presence || u.presence === 'never_logged_in') return '<span class="au-none">Never Logged In</span>';
  const parts = [auReal(u.last_login_device), auReal(u.last_login_os)].filter(Boolean);
  const browser = auReal(u.last_login_browser);
  if (!parts.length && !browser) return '<span class="au-none">Not recorded</span>';
  return `${parts.length ? escapeHtml(parts.join(' · ')) : 'Not recorded'}
    ${browser ? `<br><small class="au-sub">${escapeHtml(browser)}</small>` : ''}`;
}

function auIpCell(u) {
  if (!u.presence || u.presence === 'never_logged_in') return '<span class="au-none">Never Logged In</span>';
  if (!u.last_login_ip) return '<span class="au-none">Not recorded</span>';
  return `${escapeHtml(u.last_login_ip)}${u.last_login_local_ip
    ? `<br><small class="au-sub" title="LAN address reported by a proxy">Local ${escapeHtml(u.last_login_local_ip)}</small>`
    : ''}`;
}

/* `last_login_at` is the session row's own timestamp — the login the device and
   IP beside it belong to. `users.last_login` agrees with it, but a cell that
   describes one session must not date itself from another. */
function auLastLoginCell(u) {
  const when = u.last_login_at || u.last_login;
  return when ? fmtDateTime(when) : '<span class="au-none">Never Logged In</span>';
}

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
    ['auPresenceFilter', 'auStatusFilter', 'auRoleFilter'].forEach(id =>
      document.getElementById(id)?.addEventListener('change', () => loadActiveUsers(1)));
  }
  const tbody = document.querySelector('#activeUsersTable tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Loading…</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/users`, {
      headers: authHeaders(),
      params: {
        search: document.getElementById('auSearch').value || undefined,
        status: document.getElementById('auStatusFilter').value || undefined,
        role: document.getElementById('auRoleFilter').value || undefined,
        /* Presence is filtered SERVER-side. Dropping non-matching rows from the
           page here would return four users under a total that counted forty. */
        presence: document.getElementById('auPresenceFilter')?.value || undefined,
        page, page_size: PAGE_SIZE,
      },
    });
    renderPagination('activeUsersPagination', data.page, data.total_pages, data.total, loadActiveUsers);
    tbody.innerHTML = data.items.map(u => `
      <tr>
        <td>${escapeHtml(u.full_name)}</td>
        <td><span class="au-ellipsis" title="${escapeHtml(u.email)}">${escapeHtml(usernameOf(u.email))}</span></td>
        <td style="text-transform:capitalize">${escapeHtml((u.role || '').replace(/_/g, ' '))}</td>
        <td>${u.merchant_id ? `MRC-${u.merchant_id}` : '—'}</td>
        <td>${auPresenceBadge(u)}</td>
        <td>${auLastLoginCell(u)}</td>
        <td>${auDeviceCell(u)}</td>
        <td>${auIpCell(u)}</td>
      </tr>
    `).join('') || `<tr><td colspan="8" class="empty-state">No users found.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load users.</td></tr>`;
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
        <td class="jp-truncate" title="${escapeHtml(i.title)}">${escapeHtml(i.title)}</td>
        <td class="jp-truncate" title="${escapeHtml(i.merchant_name || '—')}">${escapeHtml(i.merchant_name || '—')}</td>
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

    /* THE PAGE CONTROLS WERE NEVER RENDERED. `#aqPagination` has been in the
       markup since this screen shipped and nothing ever wrote to it, so the
       Approval Queue showed the newest ten rows and offered no way to reach the
       eleventh — measured here at 10 rows shown out of 386. Every other list in
       the portal calls this; this one was simply missed.
       The endpoint has always paged (`page`/`page_size` above), so this is the
       one missing line rather than a new capability.
       CAVEAT, PRE-EXISTING: with the type filter on "Merchant Onboarding" the
       rows are narrowed in the browser (the server has no such request_type),
       so a page can show fewer rows than the count promises. That was already
       true of the table; it is now visible instead of hidden behind a dead
       control. */
    renderPagination('aqPagination', data.page, data.total_pages, data.total, loadApprovalQueue);

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
        /* A CANCELLATION OR DATE CHANGE IS SETTLED, NOT APPROVED — SO SEND THE
           OPERATOR TO THE SCREEN THAT SETTLES IT.
           Approving one through the generic path would mark the request
           Approved while leaving the booking untouched and no money moved, so
           `ticket_service.resolve_service_request` refuses it by type. That
           refusal is correct and stays; what was wrong is that this button
           called it anyway and then `alert()`-ed the raw 400 back — an API
           path and an endpoint name shown to a desk operator as if it were an
           instruction. The change-request modal is the settlement UI: it
           quotes the charge, previews the refund live and posts to
           /api/admin/change-requests/{id}/approve, which moves the money and
           applies the outcome to the parent booking. Opening it here means the
           operator finishes the job in one click instead of being told to go
           and find another screen. */
        if (btn.dataset.requestType === 'cancellation' || btn.dataset.requestType === 'date_change') {
          if (typeof openChangeRequest === 'function') return openChangeRequest(id);
        }
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
  return `<div>${headline}</div>${reason
    ? `<div class="cell-sub jp-truncate" title="${escapeHtml(reason)}">${escapeHtml(reason)}</div>` : ''}`;
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
      <td class="jp-truncate" title="${escapeHtml(r.merchant_name || '—')}">${escapeHtml(r.merchant_name || '—')}</td>
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
  thead.innerHTML = `<tr>${cols.map(c => `<th${c === 'Amount' ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`;
  tbody.innerHTML = `<tr><td colspan="${cols.length}">${rowsSkeleton(3)}</td></tr>`;
  renderAdminReportSummary(type);
  try {
    if (type === 'payments') {
      const { data } = await axios.get(`${API_BASE}/api/admin/payments`, { headers: authHeaders(), params: { ...repAdminFilterParams(), page_size: 100 } });
      tbody.innerHTML = data.items.map(p => `<tr><td>${escapeHtml(p.transaction_id || '—')}</td><td>—</td><td class="num">${moneyStr(p.amount)}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td><td>${p.paid_date ? fmtDate(p.paid_date) : '—'}</td></tr>`).join('')
        || `<tr><td colspan="5" class="empty-state">No results.</td></tr>`;
    } else if (type === 'bookings') {
      const { data } = await axios.get(`${API_BASE}/api/requests`, { headers: authHeaders(), params: { request_type: 'booking', ...repAdminFilterParams(), page_size: 100 } });
      tbody.innerHTML = data.items.map(r => {
        const pax = r.passengers?.map(p => `${p.first_name} ${p.last_name}`).join(', ') || '—';
        return `<tr><td>${escapeHtml(r.booking_reference || '—')}</td><td>${escapeHtml(r.request_number)}</td><td class="jp-truncate" title="${escapeHtml(pax)}">${escapeHtml(pax)}</td><td class="jp-truncate" title="${escapeHtml(r.merchant_name || '—')}">${escapeHtml(r.merchant_name || '—')}</td><td class="num">${moneyStr(r.total_amount)}</td><td><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></td></tr>`;
      }).join('')
        || `<tr><td colspan="6" class="empty-state">No results.</td></tr>`;
    } else {
      const results = await Promise.all(SERVICE_REQUEST_TYPES.map(t => axios.get(`${API_BASE}/api/requests`, {
        headers: authHeaders(), params: { request_type: t, ...repAdminFilterParams(), page_size: 100 },
      }).then(r => r.data.items).catch(() => [])));
      const items = results.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      tbody.innerHTML = items.map(r => `<tr><td>${escapeHtml(r.request_number)}</td><td style="text-transform:capitalize">${escapeHtml(r.request_type.replace(/_/g, ' '))}</td><td>${escapeHtml(r.booking_reference || '—')}</td><td class="jp-truncate" title="${escapeHtml(r.merchant_name || '—')}">${escapeHtml(r.merchant_name || '—')}</td><td><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></td></tr>`).join('')
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
        <td class="jp-truncate" title="${escapeHtml(t.merchant_name || '—')}">${escapeHtml(t.merchant_name || '—')}</td>
        <td class="jp-truncate" title="${escapeHtml(t.opened_by || '—')}">${escapeHtml(t.opened_by || '—')}</td>
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

/* ------------------------------------------------- the desk's transcript ---

   BUILT THE SAME WAY AS THE MERCHANT'S (merchant-classic/js/classic-support.js),
   because it is the same conversation and there is no reason the two sides
   should read differently. What changed: day separators, runs of messages from
   one sender grouped under a single avatar, bubbles the width of their own
   words, the timestamp moved under the message as a receipt line, and real file
   cards.

   NO API CHANGE. `documents` (each with `is_staff`) and `is_read` per message
   were already in the `GET /api/support/threads/{id}` payload and this drawer
   simply dropped them on the floor — the merchant side has consumed both since
   it was built. The desk could not open an attachment the merchant sent: it
   rendered as the sentence "Shared a file: ledger.pdf" and nothing else.

   `direction` is written from the PLATFORM's point of view, so on THIS side
   "mine" is `outbound` — the mirror of the merchant portal, where it is
   `inbound`. That was already right here and is left alone. */

const SUPPORT_FILE_MSG = /^Shared a file:\s*(.+)$/;
let supportChatDocs = [];
/* Attachment bytes come from an authenticated endpoint, so a thumbnail cannot
   be a plain `src` — each is fetched and held as an object URL. Cached because
   sending a reply re-renders the whole transcript, and without this every
   image was re-downloaded on every reply. */
const supportThumbs = new Map();

function supportInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts.length === 1 ? parts[0].slice(0, 2)
    : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function supportDayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function supportFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* Delivered vs read, on the desk's own messages only. `is_read` is the SERVER's
   receipt — set when the merchant actually opens the thread. There is no
   "sending" state here: a reply re-renders from the server's response, so a
   message only ever exists once it has landed. */
function supportReceipt(read) {
  return `<svg class="chat-seen${read ? ' read' : ''}" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"
       aria-label="${read ? 'Read by the merchant' : 'Delivered'}">
    ${read
      ? '<polyline points="1 13 5 17 13 8"/><polyline points="10 13 14 17 23 6"/>'
      : '<polyline points="4 13 9 18 20 6"/>'}
  </svg>`;
}

function supportFileCard(doc) {
  const image = (doc.content_type || '').startsWith('image/');
  const ext = (doc.filename.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
  return `<span class="chat-file">
    ${image
      ? `<span class="chat-file-thumb" data-chat-thumb="${doc.id}"></span>`
      : `<span class="chat-file-ico">${escapeHtml(ext)}</span>`}
    <span class="chat-file-meta">
      <b>${escapeHtml(doc.filename)}</b>
      <span>${escapeHtml(supportFileSize(doc.size_bytes))} · ${escapeHtml(image ? 'Image' : ext)}</span>
    </span>
    <button type="button" class="chat-file-get" data-chat-doc="${doc.id}"
            aria-label="Download ${escapeHtml(doc.filename)}">Download</button>
  </span>`;
}

function renderChatMessages(messages, documents) {
  const el = document.getElementById('supportChatMessages');
  if (Array.isArray(documents)) supportChatDocs = documents;

  if (!messages.length) {
    el.innerHTML = '<div class="empty-state">No messages yet.</div>';
    return;
  }

  /* Each upload posts its own "Shared a file: NAME" line and the documents
     arrive as a separate list. Pairing them by name and CONSUMING each match
     means two uploads of the same filename land on their own bubbles in order
     rather than both pointing at the first document. `is_staff` is the
     uploader's side, which stops the desk's own file binding to an identically
     named one the merchant sent. */
  const unclaimed = [...supportChatDocs];
  const claimDoc = (text, mine) => {
    const match = SUPPORT_FILE_MSG.exec(text || '');
    if (!match) return null;
    const name = match[1].trim();
    let i = unclaimed.findIndex(d => d.filename === name && d.is_staff === mine);
    if (i < 0) i = unclaimed.findIndex(d => d.filename === name);
    return i < 0 ? null : unclaimed.splice(i, 1)[0];
  };

  /* Where the receipt goes: on the last thing the desk said, and nowhere else. */
  let lastMine = -1;
  messages.forEach((m, i) => { if (m.direction === 'outbound') lastMine = i; });

  let lastDay = '';
  let lastSide = '';

  el.innerHTML = messages.map((m, i) => {
    const mine = m.direction === 'outbound';
    const who = m.sender_name || (mine ? 'Support' : 'Merchant');
    const day = new Date(m.created_at).toDateString();
    let block = '';

    if (day !== lastDay) {
      block += `<div class="chat-day">${escapeHtml(supportDayLabel(m.created_at))}</div>`;
      lastDay = day;
      lastSide = '';
    }
    const grouped = lastSide === (mine ? 'out' : 'in');
    lastSide = mine ? 'out' : 'in';
    const doc = claimDoc(m.message, mine);

    /* The message goes in its own element and the template's newlines stay
       OUTSIDE it. `.chat-msg-text` is `pre-wrap` so a merchant's line breaks
       survive; put pre-wrap on the bubble instead and it also preserves this
       literal's indentation, which is four phantom blank lines per bubble. */
    block += `<div class="chat-row ${mine ? 'out' : 'in'}${grouped ? ' grouped' : ''}">
      <span class="chat-av ${mine ? 'desk' : 'merch'}" aria-hidden="true">${
        grouped ? '' : escapeHtml(supportInitials(who))}</span>
      <div class="chat-stack">
        ${!grouped ? `<div class="chat-who">${escapeHtml(who)}</div>` : ''}
        <div class="chat-msg ${mine ? 'chat-msg-out' : 'chat-msg-in'}">
          ${doc ? supportFileCard(doc)
            : `<span class="chat-msg-text">${escapeHtml(m.message || '')}</span>`}
          <div class="chat-msg-meta">
            ${escapeHtml(fmtTime(m.created_at))}
            ${mine && i === lastMine ? supportReceipt(m.is_read) : ''}
          </div>
        </div>
      </div>
    </div>`;
    return block;
  }).join('');

  bindChatFiles(el);
  el.scrollTop = el.scrollHeight;
}

/* Downloads are authenticated, so an attachment can never be a plain href —
   the bytes are fetched with the bearer token and handed over as an object URL. */
async function fetchChatDoc(documentId) {
  const { data } = await axios.get(`${API_BASE}/api/documents/${documentId}/download`,
    { headers: authHeaders(), responseType: 'blob' });
  return URL.createObjectURL(data);
}

function bindChatFiles(root) {
  const find = id => supportChatDocs.find(d => String(d.id) === String(id));

  root.querySelectorAll('[data-chat-thumb]').forEach(async box => {
    const doc = find(box.dataset.chatThumb);
    if (!doc) return;
    const paint = url => {
      if (!box.isConnected) return;
      const img = document.createElement('img');
      img.alt = doc.filename;
      /* Bytes that arrive are not necessarily bytes that decode — a truncated
         upload, or a file that is not the image its type claimed. Fall back to
         the same typed icon a failed fetch leaves behind rather than a broken
         image glyph. */
      img.addEventListener('error', () => {
        box.classList.add('failed');
        box.replaceChildren();
      });
      box.replaceChildren(img);
      img.src = url;
    };
    if (supportThumbs.has(doc.id)) return paint(supportThumbs.get(doc.id));
    try {
      const url = await fetchChatDoc(doc.id);
      supportThumbs.set(doc.id, url);
      paint(url);
    } catch {
      /* A thumbnail that will not load is not worth an alert — the card still
         carries the filename, the size and a working Download. */
      box.classList.add('failed');
    }
  });

  root.querySelectorAll('[data-chat-doc]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const doc = find(btn.dataset.chatDoc);
      if (!doc) return;
      btn.disabled = true;
      try {
        const url = await fetchChatDoc(doc.id);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        /* Revoked on a delay — synchronously would cancel the download in some
           browsers before they have read the blob. */
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) {
        alert(err.response?.data?.detail || 'That file could not be downloaded.');
      } finally {
        btn.disabled = false;
      }
    }));
}

/* The desk's own view of a thread's filing. Merchants no longer state a
   category or a priority when they open a conversation — they type a message
   and nothing else — so these controls are where both values now come from.
   `category` may legitimately be null ("Not categorised"), which is why the
   select carries an empty option rather than defaulting to Other. */
function renderSupportTriage(thread) {
  const cat = document.getElementById('supportTriageCategory');
  const pri = document.getElementById('supportTriagePriority');
  if (cat) cat.value = thread.category || '';
  if (pri) pri.value = thread.priority || 'normal';
  setSupportTriageMsg('');
}

function setSupportTriageMsg(text, tone) {
  const el = document.getElementById('supportTriageMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = tone === 'error' ? 'var(--coral-dark)'
    : tone === 'ok' ? 'var(--emerald)' : 'var(--text-muted)';
}

/* Internal notes are desk-only: the endpoint is behind chat.manage and the
   merchant's own thread payload never carries them. Loaded separately from the
   thread so a notes failure cannot take the conversation down with it. */
async function loadSupportNotes(threadId) {
  const host = document.getElementById('supportNotesList');
  if (!host) return;
  host.innerHTML = '<span class="sc-notes-empty">Loading…</span>';
  try {
    /* The endpoint returns a bare ARRAY of ChatNoteResponse
       {id, body, author, created_at, edited_at} — not a Page envelope like the
       list endpoints, so there is no `items` to unwrap. */
    const { data } = await axios.get(`${API_BASE}/api/support/threads/${threadId}/notes`, { headers: authHeaders() });
    const rows = Array.isArray(data) ? data : [];
    host.innerHTML = rows.length ? rows.map(n => `
      <div class="sc-note">
        <div class="sc-note-meta">${escapeHtml(n.author || 'Desk')} · ${fmtDateTime(n.created_at)}${
          n.edited_at ? ' · edited' : ''}</div>
        <div>${escapeHtml(n.body || '')}</div>
      </div>`).join('') : '<span class="sc-notes-empty">No internal notes yet.</span>';
  } catch (err) {
    host.innerHTML = '<span class="sc-notes-empty">Notes could not be loaded.</span>';
  }
}

async function openSupportChat(threadId) {
  currentChatThreadId = threadId;
  document.getElementById('supportChatDrawerOverlay').classList.add('open');
  document.getElementById('supportChatTitle').textContent = 'Loading…';
  /* Blanked, not left showing the last thread's: the drawer is reused, and an
     address from the previous conversation sitting under a spinner is worse
     than no address — an operator could copy it while the real one loads. */
  document.getElementById('supportChatSubtitle').textContent = '';
  document.getElementById('supportChatOpenedByEmail').textContent = '';
  document.getElementById('supportChatMessages').innerHTML = rowsSkeleton(4);
  try {
    const { data } = await axios.get(`${API_BASE}/api/support/threads/${threadId}`, { headers: authHeaders() });
    document.getElementById('supportChatTitle').textContent = `${data.thread.request_number} — ${data.thread.merchant_name || 'Merchant'}`;
    applySupportChatHeader(data.thread);
    renderChatMessages(data.messages, data.documents);
    applySupportChatState(data.thread);
    renderSupportTriage(data.thread);
    loadSupportNotes(threadId);
  } catch (err) {
    document.getElementById('supportChatTitle').textContent = 'Failed to load chat';
  }
}

/* The two lines under the drawer title, in one place for the same reason
   applySupportChatState is: the opener and the reply handler both rewrite this
   header, and a field added to one and not the other silently vanishes the
   moment an operator sends a message. */
function applySupportChatHeader(thread) {
  document.getElementById('supportChatSubtitle').textContent =
    `${thread.status_label} · opened by ${thread.opened_by || '—'}`;
  /* The opener's own login address, not the merchant company's — two people at
     the same merchant open different threads, and this line has to follow the
     name on the line above it. */
  document.getElementById('supportChatOpenedByEmail').textContent =
    thread.opened_by_email || 'Email not available';
}

/* Which of claim / resolve / reopen apply, in one place. This was duplicated
   between the open and the reply handlers and the two had already drifted —
   only the opener disabled the reply box on a resolved thread, so replying to
   a thread and then resolving it left the box live on a closed ticket. */
function applySupportChatState(thread) {
  const resolved = thread.status_label === 'Resolved';
  document.getElementById('supportChatClaimBtn').style.display = thread.status_label === 'Open' ? '' : 'none';
  document.getElementById('supportChatResolveBtn').style.display = resolved ? 'none' : '';
  const reopen = document.getElementById('supportChatReopenBtn');
  if (reopen) reopen.style.display = resolved ? '' : 'none';
  document.getElementById('supportChatReplyInput').disabled = resolved;
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
    /* The reply response may or may not carry `documents`; renderChatMessages
       keeps the list it already has when it is absent, so a reply never blanks
       the file cards already on screen. */
    renderChatMessages(data.messages, data.documents);
    applySupportChatHeader(data.thread);
    applySupportChatState(data.thread);
  } catch (err) {
    alert(err.response?.data?.detail || 'Failed to send message.');
  }
});

/* PATCH, not POST — TriageRequest treats both fields as optional so that
   changing one cannot silently clear the other. Both are sent together here
   because the form shows both, and the current value of each is what the
   selects were populated with. */
document.getElementById('supportTriageSaveBtn')?.addEventListener('click', async () => {
  if (!currentChatThreadId) return;
  const category = document.getElementById('supportTriageCategory').value || null;
  const priority = document.getElementById('supportTriagePriority').value || null;
  setSupportTriageMsg('Saving…');
  try {
    await axios.patch(`${API_BASE}/api/support/threads/${currentChatThreadId}/triage`,
      { category, priority }, { headers: authHeaders() });
    setSupportTriageMsg('Filing updated.', 'ok');
    if (loadedSections.has('support')) loadSupportQueue();
  } catch (err) {
    setSupportTriageMsg(err.response?.data?.detail || 'Could not update the filing.', 'error');
  }
});

document.getElementById('supportNoteAddBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('supportNoteInput');
  const body = input.value.trim();
  if (!body || !currentChatThreadId) return;
  setSupportTriageMsg('Adding note…');
  try {
    await axios.post(`${API_BASE}/api/support/threads/${currentChatThreadId}/notes`,
      { body }, { headers: authHeaders() });
    input.value = '';
    setSupportTriageMsg('Note added — the merchant cannot see it.', 'ok');
    loadSupportNotes(currentChatThreadId);
  } catch (err) {
    setSupportTriageMsg(err.response?.data?.detail || 'Could not add the note.', 'error');
  }
});

document.getElementById('supportChatReopenBtn')?.addEventListener('click', async () => {
  if (!currentChatThreadId) return;
  try {
    await axios.post(`${API_BASE}/api/support/threads/${currentChatThreadId}/reopen`, {}, { headers: authHeaders() });
    openSupportChat(currentChatThreadId);
    if (loadedSections.has('support')) loadSupportQueue();
  } catch (err) { alert(err.response?.data?.detail || 'Failed to reopen.'); }
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
  tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Loading…</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/notifications`, { headers: authHeaders(), params: { page_size: 20 } });
    tbody.innerHTML = data.items.map(n => `
      <tr>
        <td class="jp-truncate" title="${escapeHtml(n.title || '—')}">${escapeHtml(n.title || '—')}</td>
        <td class="jp-truncate" title="${escapeHtml(n.message || '—')}">${escapeHtml(n.message || '—')}</td>
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
  /* The profile menu repeats the name and adds the email, which the chip has no
     room for. Read from the stored portal user — no extra request. */
  const menuName = document.getElementById('adminProfileMenuName');
  if (menuName) {
    menuName.textContent = name;
    document.getElementById('adminProfileMenuEmail').textContent =
      (getPortalUser('admin') || {}).email || '';
  }
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

/* THE COLLAPSED RAIL IS GONE, AND THE SAVED PREFERENCE HAS TO GO WITH IT.
   `initSidebarCollapse` read `admin_sidebar_collapsed` on every load and applied
   `.collapsed` before binding the button. Deleting only the button would have
   left anyone who had ever collapsed the rail stuck in an 80px icon strip with
   no control to escape it and no rules left in admin.css to style it — a worse
   bug than the button. So the key is cleared once, here, and the state is never
   applied again. Nothing else reads it. */
localStorage.removeItem('admin_sidebar_collapsed');

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
  closeProfileMenu();                    /* only one menu in this row at a time */
  document.getElementById('notifDropdown').classList.toggle('open');
});
document.addEventListener('click', e => {
  const dropdown = document.getElementById('notifDropdown');
  if (dropdown.classList.contains('open') && !e.target.closest('.icon-btn-wrap')) dropdown.classList.remove('open');
});

/* ---------- Header profile menu ----------
   The identity chip used to be inert. It opens the menu now, and BOTH of its
   items delegate to code that already existed rather than reimplementing it:
   Profile routes through navigateToSection('profile') — the same call the
   sidebar's Profile item makes — and Sign Out clicks the sidebar's own
   `#logoutBtn`, so the confirmation prompt, the token revocation and the
   redirect all stay in the single handler that owns them (admin.js:71). No new
   endpoint, no duplicated sign-out path. */
function closeProfileMenu() {
  const menu = document.getElementById('adminProfileMenu');
  if (!menu) return;
  menu.classList.remove('open');
  document.getElementById('adminProfileBtn').setAttribute('aria-expanded', 'false');
}
(function initProfileMenu() {
  const btn = document.getElementById('adminProfileBtn');
  const menu = document.getElementById('adminProfileMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('notifDropdown').classList.remove('open');
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', e => {
    if (menu.classList.contains('open') && !e.target.closest('.admin-chip-wrap')) closeProfileMenu();
  });
  /* A menu you can open with the keyboard has to be closable with it too. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu.classList.contains('open')) { closeProfileMenu(); btn.focus(); }
  });

  document.getElementById('adminProfileMenuProfile').addEventListener('click', () => {
    closeProfileMenu();
    navigateToSection('profile');
  });
  document.getElementById('adminProfileMenuLogout').addEventListener('click', () => {
    closeProfileMenu();
    document.getElementById('logoutBtn').click();
  });
})();

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
