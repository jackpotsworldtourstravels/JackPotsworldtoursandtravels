/* Admin — B2C Customers (Phase 1 of the B2C Admin Portal build-out)
   ===============================================================
   Direct customers — everyone who books through the website/app with no
   merchant in between (models_customer.py: Customer and friends). Read-only,
   the same footing as the Customer Payments screen beside it. The detail
   window also carries the account ACTIONS (block / unblock / send a password-
   reset email), shown only to an admin holding `b2c.customers.manage` - the
   backend (Stage 3 M1) enforces that scope and audits every action; hiding the
   buttons is a convenience, not the control.

   ENDPOINTS:
     GET /api/admin/customers                paged, filterable list
     GET /api/admin/customers/{id}           profile + booking history +
                                              payment history + reviews
     POST /api/admin/customers/{id}/block            b2c.customers.manage, reason required
     POST /api/admin/customers/{id}/unblock          b2c.customers.manage, reason optional
     POST /api/admin/customers/{id}/password-reset   b2c.customers.manage, emails a link

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, renderPagination, PAGE_SIZE) and
   moneyStr from shared/formatters.js. Nothing here restates them. */

const CUST_TABS = [
  ['', 'All'],
  ['active', 'Active'],
  ['blocked', 'Blocked'],
  ['new', 'New (30 days)'],
];

const CUST_STATUS_TONE = {
  active: 'confirmed', inactive: 'pending', blocked: 'cancelled', suspended: 'cancelled',
};

const custState = { filter: '', search: '', page: 1 };
let custWired = false;

function custStatusPill(status) {
  const tone = CUST_STATUS_TONE[status] || 'pending';
  return `<span class="badge ${tone}">${escapeHtml(status)}</span>`;
}

function custDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return escapeHtml(v); }
}

async function initB2CCustomers() {
  if (!custWired) {
    custWired = true;
    const tabs = document.getElementById('custTabs');
    if (tabs) {
      tabs.innerHTML = CUST_TABS.map(([value, label]) => `
        <button type="button" role="tab" class="ops-tab${value === custState.filter ? ' active' : ''}"
                data-cust-tab="${escapeHtml(value)}">${escapeHtml(label)}</button>`).join('');
      tabs.querySelectorAll('[data-cust-tab]').forEach(b => b.addEventListener('click', () => {
        custState.filter = b.dataset.custTab;
        custState.page = 1;
        tabs.querySelectorAll('.ops-tab').forEach(t => t.classList.toggle('active', t === b));
        loadB2CCustomers();
      }));
    }
    const search = document.getElementById('custSearch');
    if (search) {
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          custState.search = search.value.trim();
          custState.page = 1;
          loadB2CCustomers();
        }, 300);
      });
    }
    document.getElementById('custTable').addEventListener('click', e => {
      const btn = e.target.closest('[data-cust-open]');
      if (btn) openCustomerDetail(btn.dataset.custOpen);
    });
  }
  await loadB2CCustomers();
}

async function loadB2CCustomers(page = custState.page) {
  custState.page = page;
  const tbody = document.querySelector('#custTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(6)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/customers`, {
      headers: authHeaders(),
      params: {
        search: custState.search || undefined,
        filter: custState.filter || undefined,
        page, page_size: PAGE_SIZE,
      },
    });
    const summary = document.getElementById('custSummary');
    if (summary) summary.textContent = `${data.total} customer${data.total === 1 ? '' : 's'}`;
    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No customers match this filter.</td></tr>`;
    } else {
      tbody.innerHTML = data.items.map(c => `
        <tr>
          <td><strong>${escapeHtml(c.customer_code)}</strong></td>
          <td>${escapeHtml(c.full_name)}${c.is_guest ? ' <span class="cell-sub">(guest)</span>' : ''}</td>
          <td>${escapeHtml(c.email)}</td>
          <td>${escapeHtml(c.mobile)}</td>
          <td>${custDate(c.created_at)}</td>
          <td>${custStatusPill(c.status)}</td>
          <td class="num">${c.total_bookings}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-cust-open="${c.customer_id}">View</button></td>
        </tr>`).join('');
    }
    renderPagination('custPagination', data.page, data.total_pages, data.total, loadB2CCustomers);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load customers.</td></tr>`;
  }
}

function custInfoItem(label, value) {
  return `<div class="info-item"><label>${escapeHtml(label)}</label><div>${value}</div></div>`;
}

async function openCustomerDetail(customerId, notice) {
  const overlay = document.getElementById('custModalOverlay');
  const body = document.getElementById('custModalBody');
  if (!overlay || !body) return;
  overlay.classList.add('open');
  wireCustModalChrome(overlay);
  body.innerHTML = `<div class="modal-head"><h3>Customer</h3>
    <button type="button" class="modal-close" data-cust-close aria-label="Close">&times;</button></div>
    <div class="modal-body">${rowsSkeleton(4)}</div>`;

  let d;
  try {
    const res = await axios.get(`${API_BASE}/api/admin/customers/${encodeURIComponent(customerId)}`,
      { headers: authHeaders() });
    d = res.data;
  } catch (err) {
    body.innerHTML = `<div class="modal-head"><h3>Customer</h3>
      <button type="button" class="modal-close" data-cust-close aria-label="Close">&times;</button></div>
      <div class="modal-body"><p class="msg error">${escapeHtml(
        (err.response && err.response.data && err.response.data.detail) || 'Could not load this customer.')}</p></div>`;
    return;
  }

  const bookingRows = d.bookings.length ? d.bookings.map(b => `
    <tr>
      <td>${escapeHtml(b.product)}</td>
      <td><strong>${escapeHtml(b.booking_ref)}</strong></td>
      <td>${escapeHtml(b.title)}</td>
      <td>${custDate(b.travel_date)}</td>
      <td>${moneyStr(b.amount)}</td>
      <td>${escapeHtml(b.status)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No bookings yet.</td></tr>`;

  const paymentRows = d.payments.length ? d.payments.map(p => `
    <tr>
      <td>${escapeHtml(p.product)}</td>
      <td>${escapeHtml(p.booking_ref)}</td>
      <td>${moneyStr(p.amount)}</td>
      <td>${escapeHtml(p.status)}</td>
      <td>${escapeHtml(p.method || '—')}</td>
      <td>${fmtDateTime(p.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No payments recorded.</td></tr>`;

  const reviewRows = d.reviews.length ? d.reviews.map(r => `
    <tr>
      <td>${escapeHtml(r.item_type)}</td>
      <td>${escapeHtml(String(r.item_id))}</td>
      <td>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</td>
      <td>${r.comment ? escapeHtml(r.comment) : '<span class="cell-sub">No comment</span>'}</td>
      <td>${custDate(r.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty-state">No reviews yet.</td></tr>`;

  body.innerHTML = `
    <div class="modal-head"><h3>${escapeHtml(d.full_name)} <span class="cell-sub">(${escapeHtml(d.customer_code)})</span></h3>
      <button type="button" class="modal-close" data-cust-close aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <h4 class="cp-events-title">Profile Information</h4>
      <div class="detail-grid">
        ${custInfoItem('Name', escapeHtml(d.full_name))}
        ${custInfoItem('Email', `<a href="mailto:${escapeHtml(d.email)}">${escapeHtml(d.email)}</a>${d.email_verified ? ' ✓' : ''}`)}
        ${custInfoItem('Mobile', `<a href="tel:${escapeHtml(d.mobile)}">${escapeHtml(d.mobile)}</a>${d.mobile_verified ? ' ✓' : ''}`)}
        ${custInfoItem('Status', custStatusPill(d.status))}
        ${custInfoItem('Created', custDate(d.created_at))}
        ${custInfoItem('Total Bookings', String(d.total_bookings))}
        ${custInfoItem('Total Spend', moneyStr(d.total_spend))}
      </div>

      <div id="custActions"></div>

      <h4 class="cp-events-title">Booking History</h4>
      <div class="table-wrap"><table><thead><tr>
        <th>Product</th><th>Reference</th><th>Details</th><th>Travel Date</th><th>Amount</th><th>Status</th>
      </tr></thead><tbody>${bookingRows}</tbody></table></div>

      <h4 class="cp-events-title">Payment History</h4>
      <div class="table-wrap"><table><thead><tr>
        <th>Product</th><th>Booking</th><th>Amount</th><th>Status</th><th>Method</th><th>When</th>
      </tr></thead><tbody>${paymentRows}</tbody></table></div>

      <h4 class="cp-events-title">Reviews</h4>
      <div class="table-wrap"><table><thead><tr>
        <th>Item Type</th><th>Item ID</th><th>Rating</th><th>Comment</th><th>Date</th>
      </tr></thead><tbody>${reviewRows}</tbody></table></div>
    </div>`;

  await renderCustActions(customerId, d, notice);
}

/* ---------------------------------------------------------------------------
   Account actions. Permission is read once from /api/auth/me; an admin without
   b2c.customers.manage simply sees no controls. The server remains the
   authority - a hand-built request still gets a 403 that is itself written to
   the audit trail.

   A SUPER ADMIN IS TREATED AS ABLE even though its /api/auth/me permission list
   does not spell out b2c.customers.manage: the backend gate (User.has_permission
   -> customer_admin._manage_gate) short-circuits super_admin to allowed, so the
   buttons must show for it too. This mirrors admin.js's own adminCan(), which
   already honours the role. Without this the one role guaranteed to hold the
   power would never see the controls.                                         */
let custPermsPromise = null;
function custCanManage() {
  if (!custPermsPromise) {
    custPermsPromise = axios.get(`${API_BASE}/api/auth/me`, { headers: authHeaders() })
      .then(r => ({ role: r.data.role, perms: new Set(r.data.permissions || []) }))
      .catch(() => { custPermsPromise = null; return { role: '', perms: new Set() }; });
  }
  return custPermsPromise.then(me => me.role === 'super_admin' || me.perms.has('b2c.customers.manage'));
}

async function renderCustActions(customerId, d, notice) {
  const host = document.getElementById('custActions');
  if (!host) return;
  if (!(await custCanManage())) return;      // no scope -> no controls (backend enforces anyway)
  const canBlock = d.status === 'active';
  const canUnblock = d.status === 'blocked';
  const canReset = !!d.email_verified;
  host.innerHTML = `
    <h4 class="cp-events-title">Account actions</h4>
    <div class="cust-actions" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
      ${canBlock ? '<button type="button" class="btn btn-ghost btn-sm" data-cust-act="block">Block customer…</button>' : ''}
      ${canUnblock ? '<button type="button" class="btn btn-ghost btn-sm" data-cust-act="unblock">Unblock customer…</button>' : ''}
      <button type="button" class="btn btn-ghost btn-sm" data-cust-act="reset" ${canReset ? '' : 'disabled title="This customer has no verified email address."'}>Send password-reset email…</button>
    </div>
    ${(!canBlock && !canUnblock) ? `<p class="cell-sub">Status is <strong>${escapeHtml(d.status)}</strong>: block/unblock apply only to active or blocked customers.</p>` : ''}
    <div id="custActPanel"></div>
    <p class="msg" id="custActMsg" role="status"></p>`;

  const panel = host.querySelector('#custActPanel');
  const msg = host.querySelector('#custActMsg');
  const say = (text, kind) => { msg.textContent = text; msg.className = `msg ${kind || ''}`.trim(); };
  if (notice) say(notice, 'success');

  host.querySelectorAll('[data-cust-act]').forEach(btn => btn.addEventListener('click', () => {
    say('', '');
    const act = btn.dataset.custAct;
    const reasonField = act === 'block'
      ? '<label for="custActReason">Reason (required, recorded in the audit trail)</label><input id="custActReason" type="text" maxlength="500" required>'
      : act === 'unblock'
        ? '<label for="custActReason">Reason (optional)</label><input id="custActReason" type="text" maxlength="500">'
        : '<label><input id="custActForce" type="checkbox"> Also sign the customer out of every active session now</label>';
    const note = act === 'reset'
      ? `<p class="cell-sub">A secure reset link is emailed to the customer's verified address. You never see or set a password.</p>` : '';
    const label = act === 'block' ? 'Confirm block' : act === 'unblock' ? 'Confirm unblock' : 'Send reset email';
    panel.innerHTML = `<div class="form-field" style="max-width:none;margin:8px 0;">${reasonField}${note}
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button type="button" class="btn btn-navy btn-sm" id="custActGo">${label}</button>
        <button type="button" class="btn btn-ghost btn-sm" id="custActCancel">Cancel</button>
      </div></div>`;
    panel.querySelector('#custActCancel').addEventListener('click', () => { panel.innerHTML = ''; say('', ''); });
    panel.querySelector('#custActGo').addEventListener('click', async ev => {
      const go = ev.currentTarget;
      if (go.disabled) return;                               // no double-submit
      let url, body;
      if (act === 'reset') {
        url = 'password-reset';
        body = { force_logout: !!panel.querySelector('#custActForce')?.checked };
      } else {
        const reason = (panel.querySelector('#custActReason').value || '').trim();
        if (act === 'block' && !reason) { say('A reason is required to block a customer.', 'error'); return; }
        url = act;
        body = act === 'block' ? { reason } : { reason: reason || null };
      }
      go.disabled = true;
      say('Working…', '');
      try {
        await axios.post(`${API_BASE}/api/admin/customers/${encodeURIComponent(customerId)}/${url}`, body,
          { headers: authHeaders() });
        const done = act === 'block' ? 'Customer blocked.' : act === 'unblock' ? 'Customer unblocked.'
          : 'Password-reset email sent.';
        loadB2CCustomers();                                   // refresh the list's status pill
        if (act === 'reset') { panel.innerHTML = ''; say(done, 'success'); }
        else {
          await openCustomerDetail(customerId, done);       // re-reads the customer: shows the real new status
        }
      } catch (err) {
        const code = err.response?.status;
        const detail = err.response?.data?.detail;
        say(code === 403 ? 'You do not have permission to manage customers.'
          : (typeof detail === 'string' ? detail : String(detail || 'The action failed.')), 'error');
        go.disabled = false;
      }
    });
  }));
}

function wireCustModalChrome(overlay) {
  if (overlay.dataset.custWired === '1') return;
  overlay.dataset.custWired = '1';
  const close = () => overlay.classList.remove('open');
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('click', e => { if (e.target.closest('[data-cust-close]')) close(); });
}
