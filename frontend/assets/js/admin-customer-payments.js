/* Admin — Customer Payments (B2C)
   ===============================
   What a member of the public paid for their own trip, through the gateway.

   THIS IS NOT THE MERCHANT WALLET DESK, AND THE DISTINCTION IS THE POINT
   "Payment Management" and "Wallet & Top-ups" are B2B: a travel agent's money,
   held in `payments` / `wallet_transactions`, moved by a human on this desk
   after checking a bank transfer. This screen reads the three
   `customer_*_booking_payments` tables, where money arrives from a payment
   gateway and no member of staff moves anything. Mixing them into one list
   would give "verify" two incompatible meanings on the same screen, so they
   are separate sections and separate endpoints.

   READ-ONLY, DELIBERATELY
   There is no approve, capture or refund control here and there must not be
   one. A customer payment becomes `captured` because Razorpay says so and the
   server's verification agrees — a button that could do it from a list would
   be a second path to the money-state that skips every one of those checks.

   THE STATUS WORDS ARE THE DATABASE'S
   pending / processing / authorized / captured / failed / cancelled / expired
   / refunded. `captured` is the terminal success state and is NOT renamed in
   the API or the database; STATUS_LABEL below is the one place it is shown to
   a reader as "Paid", because that is the word a human uses.

   ENDPOINTS
     GET /api/admin/customer-payments/counts               tab counts
     GET /api/admin/customer-payments                      the list
     GET /api/admin/customer-payments/{product}/{id}       one payment + events
*/

/* The database's vocabulary on the left; what a reader is shown on the right.
   The mapping exists so nothing below has to guess, and so a status the API
   grows that this file has not been taught renders as itself rather than as
   "undefined". */
const CP_STATUS_LABEL = {
  pending: 'Pending',
  processing: 'Processing',
  authorized: 'Authorized',
  captured: 'Paid',          // the customer-friendly label; the value stays `captured`
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
};

/* Which pill colour each status gets. Only `captured` is a success; `pending`,
   `processing` and `authorized` are all "not yet", and showing them in green
   would tell a desk money had arrived when it has not. */
const CP_STATUS_TONE = {
  captured: 'ok',
  refunded: 'info',
  failed: 'bad', cancelled: 'bad', expired: 'bad',
  pending: 'wait', processing: 'wait', authorized: 'wait',
};

const CP_TABS = [
  ['', 'All'],
  ['captured', 'Paid'],
  ['pending', 'Pending'],
  ['processing', 'Processing'],
  ['authorized', 'Authorized'],
  ['failed', 'Failed'],
  ['refunded', 'Refunded'],
];

const cpMoney = v => (typeof moneyStr === 'function' ? moneyStr(v) : `₹${v}`);

const cpState = { status: '', product: '', search: '', page: 1, pageSize: 25 };

function cpEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** A value that may legitimately be absent — an order id before checkout, a
 *  paid_at before capture. Rendered as an em dash rather than as "null". */
function cpOr(v) { return (v === null || v === undefined || v === '') ? '—' : cpEsc(v); }

function cpDateTime(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return cpEsc(v); }
}

function cpStatusPill(status) {
  const label = CP_STATUS_LABEL[status] || status;
  const tone = CP_STATUS_TONE[status] || 'wait';
  return `<span class="cp-pill cp-${cpEsc(tone)}" title="${cpEsc(status)}">${cpEsc(label)}</span>`;
}

async function initCustomerPayments() {
  const tabs = document.getElementById('cpTabs');
  if (tabs) {
    tabs.innerHTML = CP_TABS.map(([value, label]) => `
      <button type="button" role="tab" class="ops-tab${value === cpState.status ? ' active' : ''}"
              data-cp-tab="${cpEsc(value)}">${cpEsc(label)}<span class="ops-tab-count"
              data-cp-count="${cpEsc(value)}"></span></button>`).join('');
    tabs.querySelectorAll('[data-cp-tab]').forEach(b => b.addEventListener('click', () => {
      cpState.status = b.dataset.cpTab;
      cpState.page = 1;
      tabs.querySelectorAll('.ops-tab').forEach(t => t.classList.toggle('active', t === b));
      loadCustomerPayments();
    }));
  }

  const search = document.getElementById('cpSearch');
  if (search) {
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cpState.search = search.value.trim();
        cpState.page = 1;
        loadCustomerPayments();
      }, 300);
    });
  }

  const product = document.getElementById('cpProductFilter');
  if (product) product.addEventListener('change', () => {
    cpState.product = product.value; cpState.page = 1; loadCustomerPayments();
  });

  await Promise.all([loadCustomerPaymentCounts(), loadCustomerPayments()]);
}

async function loadCustomerPaymentCounts() {
  try {
    const c = await Api.request('get', '/api/admin/customer-payments/counts',
                                { headers: authHeaders() });
    document.querySelectorAll('[data-cp-count]').forEach(el => {
      const key = el.dataset.cpCount;
      const n = key === '' ? c.total : (c.by_status && c.by_status[key]) || 0;
      el.textContent = n ? ` ${n}` : '';
    });
    /* The deferred backlog is an EVENT state, not a payment status, so it gets
       its own line rather than a tab: a non-zero value means a provider told us
       something we have not finished verifying, which is worth a desk knowing
       even though no payment is "in" it. */
    const note = document.getElementById('cpDeferredNote');
    if (note) {
      const n = c.deferred_events || 0;
      note.hidden = !n;
      note.textContent = n
        ? `${n} provider event${n === 1 ? '' : 's'} awaiting verification — the sweep will retry.`
        : '';
    }
  } catch { /* counts are decoration; the list is the screen */ }
}

async function loadCustomerPayments() {
  const body = document.getElementById('cpTableBody');
  if (!body) return;
  body.innerHTML = `<tr><td colspan="8" class="muted">Loading…</td></tr>`;

  const params = { page: cpState.page, page_size: cpState.pageSize };
  if (cpState.status) params.status = cpState.status;
  if (cpState.product) params.product = cpState.product;
  if (cpState.search) params.search = cpState.search;

  let data;
  try {
    data = await Api.request('get', '/api/admin/customer-payments',
                             { params, headers: authHeaders() });
  } catch (err) {
    const code = err && err.response && err.response.status;
    body.innerHTML = `<tr><td colspan="8" class="muted">${
      code === 403 ? 'You do not have permission to view customer payments.'
                   : 'Could not load customer payments.'}</td></tr>`;
    return;
  }

  const rows = data.items || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">No customer payments match this filter.</td></tr>`;
  } else {
    body.innerHTML = rows.map(r => `
      <tr>
        <td>
          <strong>${cpEsc(r.booking_ref)}</strong>
          <div class="cp-sub">${cpEsc(r.product)}${r.package_name ? ' · ' + cpEsc(r.package_name) : ''}</div>
        </td>
        <td>
          ${cpEsc(r.customer_name)}
          <div class="cp-sub">${cpEsc(r.customer_email)}</div>
        </td>
        <td class="num">${cpMoney(r.amount)}
          <div class="cp-sub">${cpEsc(r.currency)}</div></td>
        <td>${cpStatusPill(r.status)}
          ${r.provider_status ? `<div class="cp-sub">${cpEsc(r.provider_status)}</div>` : ''}</td>
        <td>${cpOr(r.method)}</td>
        <td>${cpOr(r.provider)}
          <div class="cp-sub mono">${cpOr(r.provider_payment_id)}</div></td>
        <td>${cpEsc(r.booking_status)}</td>
        <td>${cpDateTime(r.paid_at || r.created_at)}
          <button type="button" class="btn btn-sm btn-ghost"
                  data-cp-open="${cpEsc(r.product)}/${cpEsc(r.payment_id)}">View</button></td>
      </tr>`).join('');
    body.querySelectorAll('[data-cp-open]').forEach(b => b.addEventListener('click', () => {
      const [product, id] = b.dataset.cpOpen.split('/');
      openCustomerPayment(product, id);
    }));
  }

  const pager = document.getElementById('cpPager');
  if (pager) {
    const pages = Math.max(1, Math.ceil((data.total || 0) / (data.page_size || 25)));
    pager.innerHTML = `
      <button type="button" class="btn btn-sm btn-ghost" ${data.page <= 1 ? 'disabled' : ''}
              data-cp-page="${data.page - 1}">Previous</button>
      <span class="muted">Page ${data.page} of ${pages} · ${data.total || 0} payment${data.total === 1 ? '' : 's'}</span>
      <button type="button" class="btn btn-sm btn-ghost" ${data.page >= pages ? 'disabled' : ''}
              data-cp-page="${data.page + 1}">Next</button>`;
    pager.querySelectorAll('[data-cp-page]').forEach(b => b.addEventListener('click', () => {
      cpState.page = Number(b.dataset.cpPage); loadCustomerPayments();
    }));
  }
}

async function openCustomerPayment(product, paymentId) {
  const modal = document.getElementById('cpModal');
  const body = document.getElementById('cpModalBody');
  if (!modal || !body) return;
  body.innerHTML = '<p class="muted">Loading…</p>';
  modal.classList.add('active');

  let d;
  try {
    d = await Api.request('get',
      `/api/admin/customer-payments/${encodeURIComponent(product)}/${encodeURIComponent(paymentId)}`,
      { headers: authHeaders() });
  } catch {
    body.innerHTML = '<p class="muted">Could not load this payment.</p>';
    return;
  }

  /* The two amounts are shown side by side ON PURPOSE. They agree in every
     normal case; a disagreement is precisely what a desk is looking at this
     screen to find, and burying one of them would hide it. */
  const mismatch = String(d.amount) !== String(d.booking_amount);

  const events = (d.events || []).map(e => `
    <tr>
      <td>${cpEsc(e.event_type)}</td>
      <td>${cpEsc(e.processing_status)}</td>
      <td class="cp-sub">${cpOr(e.processing_note)}</td>
      <td>${cpDateTime(e.received_at)}</td>
    </tr>`).join('');

  body.innerHTML = `
    <div class="cp-detail-grid">
      <div class="info-item"><label>Booking reference</label><div>${cpEsc(d.booking_ref)}</div></div>
      <div class="info-item"><label>Booking status</label><div>${cpEsc(d.booking_status)}</div></div>
      <div class="info-item"><label>Customer</label><div>${cpEsc(d.customer_name)}<br>
        <span class="cp-sub">${cpEsc(d.customer_email)}</span></div></div>
      <div class="info-item"><label>Product</label><div>${cpEsc(d.product)}${
        d.package_name ? ' · ' + cpEsc(d.package_name) : ''}</div></div>
      <div class="info-item"><label>Booking amount</label><div>${cpMoney(d.booking_amount)} ${cpEsc(d.currency)}</div></div>
      <div class="info-item"><label>Payment amount</label><div${mismatch ? ' class="cp-mismatch"' : ''}>${
        cpMoney(d.amount)} ${cpEsc(d.currency)}${mismatch ? ' — does not match the booking' : ''}</div></div>
      <div class="info-item"><label>Payment status</label><div>${cpStatusPill(d.status)}</div></div>
      <div class="info-item"><label>Provider status</label><div>${cpOr(d.provider_status)}</div></div>
      <div class="info-item"><label>Method</label><div>${cpOr(d.method)}</div></div>
      <div class="info-item"><label>Provider</label><div>${cpOr(d.provider)}</div></div>
      <div class="info-item"><label>Provider order ID</label><div class="mono">${cpOr(d.provider_order_id)}</div></div>
      <div class="info-item"><label>Provider payment ID</label><div class="mono">${cpOr(d.provider_payment_id)}</div></div>
      <div class="info-item"><label>Paid at</label><div>${cpDateTime(d.paid_at)}</div></div>
      <div class="info-item"><label>Created</label><div>${cpDateTime(d.created_at)}</div></div>
      ${d.failure_reason ? `<div class="info-item cp-span2"><label>Failure reason</label>
        <div>${cpEsc(d.failure_reason)}</div></div>` : ''}
    </div>
    <h4 class="cp-events-title">Provider events</h4>
    ${events
      ? `<div class="table-wrap"><table class="cp-events"><thead><tr>
           <th>Event</th><th>Processing</th><th>Note</th><th>Received</th>
         </tr></thead><tbody>${events}</tbody></table></div>`
      : '<p class="muted">No provider events recorded against this payment.</p>'}
    <p class="cp-readonly-note">This screen is read-only. A customer payment is
       captured by the provider and verified server-side; it is never approved
       from here.</p>`;
}

function closeCustomerPaymentModal() {
  const modal = document.getElementById('cpModal');
  if (modal) modal.classList.remove('active');
}
