/* Admin — B2C Cancellations & Refunds (Phase 3 of the B2C Admin Portal
   build-out)
   ==================================================================
   Completes the lifecycle the plan drew: Customer -> Booking -> Payment ->
   Cancellation -> Refund. A request moves through five states:

     requested -> approved -> refund_processing -> refunded
              \-> rejected

   Approving a request CANCELS THE UNDERLYING BOOKING (done server-side, not
   here) — the two states after that track the money coming back, not
   whether the trip still stands. Nothing in this file moves money: marking
   a request "refund completed" records that the desk already paid the
   customer back by whatever means it used, the same boundary the router's
   own docstring draws.

   ENDPOINTS:
     GET   /api/admin/cancellations              paged, filterable list
     GET   /api/admin/cancellations/{id}          one request
     PATCH /api/admin/cancellations/{id}          {action, refund_amount?,
                                                    admin_notes?}

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, renderPagination, PAGE_SIZE) and
   moneyStr from shared/formatters.js. Nothing here restates them. */

const CXL_TABS = [
  ['', 'All'],
  ['requested', 'Requested'],
  ['approved', 'Approved'],
  ['refund_processing', 'Refund Processing'],
  ['refunded', 'Refunded'],
  ['rejected', 'Rejected'],
];

const CXL_STATUS_TONE = {
  requested: 'pending', approved: 'refunded', refund_processing: 'refunded',
  refunded: 'confirmed', rejected: 'cancelled',
};
const CXL_STATUS_LABEL = {
  requested: 'Requested', approved: 'Approved', refund_processing: 'Refund Processing',
  refunded: 'Refunded', rejected: 'Rejected',
};

const cxlState = { status: '', search: '', page: 1 };
let cxlWired = false;

function cxlPill(status) {
  return `<span class="badge ${CXL_STATUS_TONE[status] || 'pending'}">${
    escapeHtml(CXL_STATUS_LABEL[status] || status)}</span>`;
}

function cxlDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return escapeHtml(v); }
}

async function initB2CRefunds() {
  if (!cxlWired) {
    cxlWired = true;
    const tabs = document.getElementById('cxlTabs');
    tabs.innerHTML = CXL_TABS.map(([value, label]) => `
      <button type="button" role="tab" class="ops-tab${value === cxlState.status ? ' active' : ''}"
              data-cxl-tab="${escapeHtml(value)}">${escapeHtml(label)}</button>`).join('');
    tabs.querySelectorAll('[data-cxl-tab]').forEach(b => b.addEventListener('click', () => {
      cxlState.status = b.dataset.cxlTab;
      cxlState.page = 1;
      tabs.querySelectorAll('.ops-tab').forEach(t => t.classList.toggle('active', t === b));
      loadB2CRefunds();
    }));

    const search = document.getElementById('cxlSearch');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cxlState.search = search.value.trim();
        cxlState.page = 1;
        loadB2CRefunds();
      }, 300);
    });

    document.getElementById('cxlTable').addEventListener('click', e => {
      const btn = e.target.closest('[data-cxl-open]');
      if (btn) openCancellationDetail(btn.dataset.cxlOpen);
    });
  }
  await loadB2CRefunds();
}

async function loadB2CRefunds(page = cxlState.page) {
  cxlState.page = page;
  const tbody = document.querySelector('#cxlTable tbody');
  tbody.innerHTML = `<tr><td colspan="9">${rowsSkeleton(6)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/cancellations`, {
      headers: authHeaders(),
      params: { search: cxlState.search || undefined, status: cxlState.status || undefined, page, page_size: PAGE_SIZE },
    });
    const summary = document.getElementById('cxlSummary');
    if (summary) summary.textContent = `${data.total} request${data.total === 1 ? '' : 's'}`;
    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No cancellation requests match this filter.</td></tr>`;
    } else {
      tbody.innerHTML = data.items.map(r => `
        <tr>
          <td><strong>${escapeHtml(r.cancellation_id)}</strong></td>
          <td>${escapeHtml(r.booking_id)}</td>
          <td>${escapeHtml(r.customer.name)}<div class="cell-sub">${escapeHtml(r.customer.email)}</div></td>
          <td>${escapeHtml(r.service_type)}</td>
          <td class="jp-truncate" title="${escapeHtml(r.reason || '')}">${r.reason ? escapeHtml(r.reason) : '<span class="cell-sub">No reason given</span>'}</td>
          <td>${cxlDate(r.requested_date)}</td>
          <td>${cxlPill(r.status)}</td>
          <td class="num">${r.refund_amount != null ? moneyStr(r.refund_amount) : '—'}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-cxl-open="${escapeHtml(r.cancellation_id)}">View</button></td>
        </tr>`).join('');
    }
    renderPagination('cxlPagination', data.page, data.total_pages, data.total, loadB2CRefunds);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load cancellation requests.</td></tr>`;
  }
}

function cxlInfoItem(label, value) {
  return `<div class="info-item"><label>${escapeHtml(label)}</label><div>${value}</div></div>`;
}

async function openCancellationDetail(cancellationId) {
  const overlay = document.getElementById('cxlModalOverlay');
  const body = document.getElementById('cxlModalBody');
  if (!overlay || !body) return;
  overlay.classList.add('open');
  wireCxlModalChrome(overlay);
  body.innerHTML = `<div class="modal-head"><h3>Cancellation Request</h3>
    <button type="button" class="modal-close" data-cxl-close aria-label="Close">&times;</button></div>
    <div class="modal-body">${rowsSkeleton(4)}</div>`;

  let d;
  try {
    const res = await axios.get(`${API_BASE}/api/admin/cancellations/${encodeURIComponent(cancellationId)}`,
      { headers: authHeaders() });
    d = res.data;
  } catch (err) {
    body.innerHTML = `<div class="modal-head"><h3>Cancellation Request</h3>
      <button type="button" class="modal-close" data-cxl-close aria-label="Close">&times;</button></div>
      <div class="modal-body"><p class="msg error">${escapeHtml(
        (err.response && err.response.data && err.response.data.detail) || 'Could not load this request.')}</p></div>`;
    return;
  }
  renderCancellationDetail(d);
}

function renderCancellationDetail(d) {
  const body = document.getElementById('cxlModalBody');

  /* Only the action(s) legal from the request's CURRENT status are shown —
     mirrors the server's own state machine (customer_cancellation_admin_
     service._TRANSITIONS) so a click here can never be rejected by it. */
  let actionsHtml = '';
  if (d.status === 'requested') {
    actionsHtml = `
      <div class="form-field" style="max-width:none;">
        <label for="cxlNotes">Admin Notes</label>
        <textarea id="cxlNotes" rows="2" placeholder="What was decided, and why."></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cxlRejectBtn">Reject</button>
        <button type="button" class="btn btn-navy" id="cxlApproveBtn">Approve Cancellation</button>
      </div>
      <p class="cp-readonly-note">Approving cancels the booking immediately. The refund amount is set on the next step.</p>`;
  } else if (d.status === 'approved') {
    actionsHtml = `
      <div class="form-field" style="max-width:none;">
        <label for="cxlRefundAmount">Refund Amount</label>
        <input type="number" id="cxlRefundAmount" step="0.01" min="0" value="${
          d.refund_amount != null ? Number(d.refund_amount).toFixed(2) : Number(d.booking_amount).toFixed(2)}">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-navy" id="cxlStartRefundBtn">Start Refund</button>
      </div>`;
  } else if (d.status === 'refund_processing') {
    actionsHtml = `
      <div class="modal-actions">
        <button type="button" class="btn btn-navy" id="cxlCompleteRefundBtn">Mark Refund Completed</button>
      </div>
      <p class="cp-readonly-note">This records that the desk already paid the customer back — it does not itself move money.</p>`;
  } else {
    actionsHtml = `<p class="empty-state">This request is ${escapeHtml((CXL_STATUS_LABEL[d.status] || d.status).toLowerCase())} — no further action.</p>`;
  }

  body.innerHTML = `
    <div class="modal-head"><h3>${escapeHtml(d.cancellation_id)} ${cxlPill(d.status)}</h3>
      <button type="button" class="modal-close" data-cxl-close aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <div class="detail-grid">
        ${cxlInfoItem('Booking', escapeHtml(d.booking_id))}
        ${cxlInfoItem('Service', escapeHtml(d.service_type))}
        ${cxlInfoItem('Destination', escapeHtml(d.destination))}
        ${cxlInfoItem('Customer', `${escapeHtml(d.customer.name)}<br><span class="cell-sub">${escapeHtml(d.customer.email)}</span>`)}
        ${cxlInfoItem('Requested', fmtDateTime(d.requested_date))}
        ${cxlInfoItem('Booking Amount', moneyStr(d.booking_amount))}
        ${cxlInfoItem('Refund Amount', d.refund_amount != null ? moneyStr(d.refund_amount) : '—')}
        ${cxlInfoItem('Reason', d.reason ? escapeHtml(d.reason) : '<span class="cell-sub">No reason given</span>')}
        ${d.admin_notes ? cxlInfoItem('Admin Notes', escapeHtml(d.admin_notes)) : ''}
      </div>
      <div class="msg" id="cxlActionMsg"></div>
      ${actionsHtml}
    </div>`;

  const approveBtn = document.getElementById('cxlApproveBtn');
  if (approveBtn) approveBtn.addEventListener('click', () => cxlDecide(d.cancellation_id, 'approve'));
  const rejectBtn = document.getElementById('cxlRejectBtn');
  if (rejectBtn) rejectBtn.addEventListener('click', () => cxlDecide(d.cancellation_id, 'reject'));
  const startRefundBtn = document.getElementById('cxlStartRefundBtn');
  if (startRefundBtn) startRefundBtn.addEventListener('click', () => cxlDecide(d.cancellation_id, 'start_refund'));
  const completeBtn = document.getElementById('cxlCompleteRefundBtn');
  if (completeBtn) completeBtn.addEventListener('click', () => cxlDecide(d.cancellation_id, 'complete_refund'));
}

async function cxlDecide(cancellationId, action) {
  const msg = document.getElementById('cxlActionMsg');
  const notesEl = document.getElementById('cxlNotes');
  const amountEl = document.getElementById('cxlRefundAmount');
  const payload = { action };
  if (notesEl && notesEl.value.trim()) payload.admin_notes = notesEl.value.trim();
  if (amountEl && amountEl.value !== '') payload.refund_amount = Number(amountEl.value);

  msg.textContent = ''; msg.className = 'msg';
  /* One request at a time: a double-click must not send the action twice. The
     server's state machine would refuse the second, but the refusal would then
     be shown over the first one's success. A success re-renders the modal (fresh
     buttons); a failure re-enables these so the desk can retry. */
  const buttons = document.querySelectorAll('#cxlModalBody .modal-actions button');
  buttons.forEach(b => { b.disabled = true; });
  try {
    const { data } = await axios.patch(
      `${API_BASE}/api/admin/cancellations/${encodeURIComponent(cancellationId)}`,
      payload, { headers: authHeaders() },
    );
    renderCancellationDetail(data);
    if (typeof showToast === 'function') showToast('Cancellation request updated.');
    loadB2CRefunds(cxlState.page);
  } catch (err) {
    msg.textContent = (err.response && err.response.data && err.response.data.detail) || 'Could not save this change.';
    msg.className = 'msg error';
    buttons.forEach(b => { b.disabled = false; });
  }
}

function wireCxlModalChrome(overlay) {
  if (overlay.dataset.cxlWired === '1') return;
  overlay.dataset.cxlWired = '1';
  const close = () => overlay.classList.remove('open');
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('click', e => { if (e.target.closest('[data-cxl-close]')) close(); });
}
