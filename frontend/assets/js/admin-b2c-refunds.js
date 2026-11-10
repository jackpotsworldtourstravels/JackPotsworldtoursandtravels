/* Admin — B2C Cancellations & Refunds
   ==================================================================
   Customer -> Booking -> Payment -> Cancellation -> Refund. A request moves
   through five states:

     requested -> approved -> refund_processing -> refunded
              \-> rejected

   Approving a request CANCELS THE UNDERLYING BOOKING (server-side). The two
   states after that track the MONEY coming back, and this screen can no longer
   move them by itself:

     * "Refunded" is shown only when the SERVER says refunded, which it does only
       after the payment provider confirmed the refund, or an audited manual
       record exists (TrustBrick has no refund API). There is no "mark refund
       completed" button any more.
     * A refund is started against the ORIGINAL captured payment. The panel shows
       what was captured, what has already gone back (across every cancellation
       on that payment), what is in flight, and what is still refundable.
     * A refund that needs a second approver sits as "Awaiting approval" until a
       DIFFERENT person with refund authorization approves it.
     * An outcome the provider never confirmed ("Outcome unknown") is never
       retried from here - reconcile it, or an operator closes it after checking
       the provider.

   Permissions are enforced by the server (refund.view / .execute / .authorize /
   .reconcile); this file only shows the buttons and reports a refusal.

   ENDPOINTS:
     GET   /api/admin/cancellations                         paged list
     GET   /api/admin/cancellations/{id}                    one request
     PATCH /api/admin/cancellations/{id}                    {action: approve|reject}
     GET   /api/admin/cancellations/{id}/refund             refund position + attempts
     POST  /api/admin/cancellations/{id}/refund             start (maker)
     POST  .../refund/attempts/{a}/authorize                approve + send (checker)
     POST  .../refund/manual                                record a manual refund
     POST  .../refund/attempts/{a}/resolve-failed           close an uncertain attempt
     POST  /api/admin/cancellations/refunds/reconcile       ask providers

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, renderPagination, PAGE_SIZE) and
   moneyStr from shared/formatters.js. Nothing here restates them. */

const CXL_TABS = [
  ['', 'All'],
  ['requested', 'Requested'],
  ['approved', 'Approved'],
  ['refund_processing', 'Refund In Progress'],
  ['refunded', 'Refunded'],
  ['rejected', 'Rejected'],
];

const CXL_STATUS_TONE = {
  requested: 'pending', approved: 'refunded', refund_processing: 'pending',
  refunded: 'refunded', rejected: 'cancelled',
};
const CXL_STATUS_LABEL = {
  requested: 'Requested', approved: 'Approved', refund_processing: 'Refund In Progress',
  refunded: 'Refunded', rejected: 'Rejected',
};

/* An attempt's label says what is TRUE, not what is hoped. "Refunded" only for
   succeeded; an unconfirmed submission is "Processing", and one whose outcome we
   do not know says so. */
const CXL_ATTEMPT_TONE = {
  pending: 'pending', processing: 'pending', succeeded: 'refunded',
  failed: 'cancelled', manual_required: 'pending',
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

/* ---------------------------------------------------------------- pure renderers
   Pure functions of the API's JSON, so they can be tested without a DOM. */

function cxlAttemptLabel(a) {
  if (a.status === 'succeeded') {
    return a.is_manual ? 'Refunded — manual record' : 'Refunded — confirmed by provider';
  }
  if (a.status === 'processing') {
    return a.uncertain ? 'Outcome unknown — do not retry' : 'Processing — awaiting provider confirmation';
  }
  if (a.status === 'pending') return 'Awaiting approval';
  if (a.status === 'manual_required') return 'Manual refund required';
  if (a.status === 'failed') return 'Failed';
  return a.status_label || a.status;
}

function cxlWho(ref) {
  return ref ? escapeHtml(ref.name) : '<span class="cell-sub">—</span>';
}

function cxlAttemptRowHtml(a) {
  const provRef = a.is_manual
    ? (a.manual_reference ? `Manual ref ${escapeHtml(a.manual_reference)}` : '—')
    : (a.provider_refund_id ? `<code>${escapeHtml(a.provider_refund_id)}</code>` : '<span class="cell-sub">none yet</span>');
  const detail = [
    a.provider_status ? `Provider status: ${escapeHtml(a.provider_status)}` : '',
    a.failure_reason ? `<span class="msg error" style="display:block;margin:2px 0 0;">${escapeHtml(a.failure_reason)}</span>` : '',
    a.manual_reason ? `Reason: ${escapeHtml(a.manual_reason)}` : '',
    a.admin_override ? '<span class="cell-sub">Recorded with admin override</span>' : '',
  ].filter(Boolean).join('<br>');
  return `<tr data-cxl-attempt="${escapeHtml(String(a.attempt_id))}">
      <td>#${escapeHtml(String(a.attempt_number))}</td>
      <td><span class="badge ${CXL_ATTEMPT_TONE[a.status] || 'pending'}">${escapeHtml(cxlAttemptLabel(a))}</span></td>
      <td class="num">${moneyStr(a.amount)}</td>
      <td>${escapeHtml(a.provider)}<div class="cell-sub">${provRef}</div></td>
      <td>${detail || '<span class="cell-sub">—</span>'}</td>
      <td>${cxlWho(a.initiated_by)}<div class="cell-sub">${a.approved_by ? 'Approved: ' + escapeHtml(a.approved_by.name) : (a.status === 'pending' ? 'Not yet approved' : '')}</div></td>
      <td>${fmtDateTime(a.created_at)}</td>
    </tr>`;
}

function cxlOpenAttempt(o) {
  return (o.attempts || []).find(a => ['pending', 'processing', 'manual_required'].includes(a.status)) || null;
}

/* The money panel + attempt history + the one action that is legal now. */
function cxlRefundPanelHtml(o, cxlStatus) {
  if (!o) {
    return `<div class="cp-readonly-note">You do not have access to refund details (needs refund.view).</div>`;
  }
  const num = v => (v == null ? '—' : moneyStr(v));
  const figures = `
    <div class="detail-grid">
      <div class="info-item"><label>Requested refund</label><div>${num(o.requested_amount)}</div></div>
      <div class="info-item"><label>Original captured amount</label><div>${num(o.captured_amount)}</div></div>
      <div class="info-item"><label>Previously refunded</label><div>${num(o.previously_refunded)}</div></div>
      <div class="info-item"><label>In progress (counted)</label><div>${num(o.in_progress)}</div></div>
      <div class="info-item"><label>Remaining refundable</label><div><strong>${num(o.remaining_refundable)}</strong></div></div>
      <div class="info-item"><label>Provider</label><div>${o.provider ? escapeHtml(o.provider) : '—'}${o.manual_only ? ' <span class="cell-sub">(no refund API — manual)</span>' : ''}</div></div>
    </div>`;
  const blocker = o.blocker
    ? `<p class="cp-readonly-note">${escapeHtml(o.blocker.message)}</p>` : '';

  const rows = (o.attempts || []).map(cxlAttemptRowHtml).join('');
  const history = rows
    ? `<div class="table-wrap"><table class="cxl-attempts"><thead><tr>
         <th>Attempt</th><th>Status</th><th class="num">Amount</th><th>Provider reference</th>
         <th>Detail</th><th>Initiated by</th><th>When</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="cell-sub">No refund has been attempted for this request.</p>';

  return `<h4 style="margin:16px 0 6px;">Refund</h4>${figures}${blocker}
    <h4 style="margin:16px 0 6px;">Refund attempts</h4>${history}
    <div class="msg" id="cxlRefundMsg"></div>
    ${cxlRefundActionsHtml(o, cxlStatus)}`;
}

function cxlRefundActionsHtml(o, cxlStatus) {
  if (!['approved', 'refund_processing'].includes(cxlStatus)) return '';
  const open = cxlOpenAttempt(o);

  if (open && open.status === 'pending') {
    return `<div class="modal-actions">
        <button type="button" class="btn btn-navy" id="cxlAuthorizeBtn" data-attempt="${escapeHtml(String(open.attempt_id))}">Approve &amp; send refund</button>
      </div>
      <p class="cp-readonly-note">A refund of ${moneyStr(open.amount)} is waiting for approval. Nothing has been sent. A different
        person with refund authorization must approve it${open.initiated_by ? ` (started by ${escapeHtml(open.initiated_by.name)})` : ''}.</p>`;
  }
  if (open && open.status === 'manual_required') {
    return `<div class="form-field" style="max-width:none;">
        <label for="cxlManualAmount">Amount returned</label>
        <input type="number" id="cxlManualAmount" step="0.01" min="0.01" value="${Number(open.amount).toFixed(2)}">
        <label for="cxlManualRef">Transfer reference (UTR / bank ref)</label>
        <input type="text" id="cxlManualRef" maxlength="120" autocomplete="off">
        <label for="cxlManualReason">Reason / how it was returned</label>
        <textarea id="cxlManualReason" rows="2"></textarea>
        <label style="display:flex;gap:8px;align-items:flex-start;">
          <input type="checkbox" id="cxlManualOverride">
          <span>I confirm this money was already returned to the customer outside any payment gateway, and I am recording it with an admin override.</span>
        </label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-navy" id="cxlManualBtn">Record manual refund</button>
      </div>
      <p class="cp-readonly-note">${escapeHtml(o.provider || 'This provider')} has no refund API. Nothing is sent to a gateway; this only records the refund you made.</p>`;
  }
  if (open && open.status === 'processing') {
    const resolve = open.uncertain
      ? `<button type="button" class="btn btn-ghost" id="cxlResolveBtn" data-attempt="${escapeHtml(String(open.attempt_id))}">Confirm it was not executed…</button>` : '';
    return `<div class="modal-actions">
        <button type="button" class="btn btn-navy" id="cxlReconcileBtn">Check with provider now</button>${resolve}
      </div>
      <p class="cp-readonly-note">${open.uncertain
        ? 'The provider did not give a clear answer, so this refund may already have happened. It is counted against the payment and will NOT be retried. Check with the provider, or close it only after confirming at the provider that no refund exists.'
        : 'Submitted to the provider and awaiting its confirmation. This request becomes Refunded only when the provider confirms.'}</p>`;
  }

  // Nothing open: a refund may be started if there is something left to refund.
  if (o.blocker || !(Number(o.remaining_refundable) > 0) || !(Number(o.cancellation_remaining) > 0)) {
    return '';
  }
  const noMoneyYet = !(o.attempts || []).some(a => ['succeeded', 'processing'].includes(a.status));
  const amountField = noMoneyYet
    ? `<div class="form-field" style="max-width:none;">
         <label for="cxlRefundAmount">Refund amount for this cancellation</label>
         <input type="number" id="cxlRefundAmount" step="0.01" min="0.01" max="${Number(o.remaining_refundable).toFixed(2)}"
                value="${Number(o.cancellation_remaining).toFixed(2)}">
       </div>` : '';
  const label = o.manual_only ? 'Prepare manual refund'
    : (o.approval_required ? 'Request refund (needs approver)' : 'Start refund');
  const retry = (o.attempts || []).some(a => a.status === 'failed')
    ? '<p class="cp-readonly-note">The previous attempt failed and no money moved, so it is safe to try again.</p>' : '';
  return `${retry}${amountField}
    <div class="modal-actions">
      <button type="button" class="btn btn-navy" id="cxlStartRefundBtn">${escapeHtml(label)}</button>
    </div>`;
}

/* ---------------------------------------------------------------- list */

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

function cxlErrorText(err, fallback) {
  const d = err && err.response && err.response.data && err.response.data.detail;
  if (d && typeof d === 'object') return d.message || fallback;
  return d || fallback;
}

/* ---------------------------------------------------------------- detail */

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
      <div class="modal-body"><p class="msg error">${escapeHtml(cxlErrorText(err, 'Could not load this request.'))}</p></div>`;
    return;
  }
  const overview = await cxlLoadOverview(d.cancellation_id);
  renderCancellationDetail(d, overview);
}

/* null when the admin lacks refund.view (403) - the panel then says so. */
async function cxlLoadOverview(cancellationId) {
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/admin/cancellations/${encodeURIComponent(cancellationId)}/refund`, { headers: authHeaders() });
    return data;
  } catch (err) {
    return null;
  }
}

function renderCancellationDetail(d, overview) {
  const body = document.getElementById('cxlModalBody');

  let actionsHtml = '';
  let refundHtml = '';
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
      <p class="cp-readonly-note">Approving cancels the booking immediately. The refund is started on the next step, against the original payment.</p>`;
  } else if (d.status === 'rejected') {
    actionsHtml = `<p class="empty-state">This request is rejected — no further action.</p>`;
  } else {
    refundHtml = cxlRefundPanelHtml(overview, d.status);
    if (d.status === 'refunded') {
      actionsHtml = `<p class="empty-state">The refund is complete — the provider confirmed it, or a manual record exists.</p>`;
    }
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
        ${cxlInfoItem('Reason', d.reason ? escapeHtml(d.reason) : '<span class="cell-sub">No reason given</span>')}
        ${d.admin_notes ? cxlInfoItem('Admin Notes', escapeHtml(d.admin_notes)) : ''}
      </div>
      <div class="msg" id="cxlActionMsg"></div>
      ${actionsHtml}
      ${refundHtml}
    </div>`;

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('cxlApproveBtn', () => cxlDecide(d.cancellation_id, 'approve'));
  on('cxlRejectBtn', () => cxlDecide(d.cancellation_id, 'reject'));
  on('cxlStartRefundBtn', () => cxlStartRefund(d));
  on('cxlAuthorizeBtn', e => cxlAuthorize(d, e.currentTarget.dataset.attempt));
  on('cxlManualBtn', () => cxlRecordManual(d));
  on('cxlReconcileBtn', () => cxlReconcile(d));
  on('cxlResolveBtn', e => cxlResolve(d, e.currentTarget.dataset.attempt));
}

/* One request at a time: a double-click must not send a money action twice. A
   success re-renders the modal (fresh buttons); a failure re-enables them. */
async function cxlRun(d, buttonsSel, call, okText) {
  const msg = document.getElementById('cxlRefundMsg') || document.getElementById('cxlActionMsg');
  if (msg) { msg.textContent = ''; msg.className = 'msg'; }
  const buttons = document.querySelectorAll(buttonsSel);
  buttons.forEach(b => { b.disabled = true; });
  try {
    const { data } = await call();
    const fresh = await axios.get(`${API_BASE}/api/admin/cancellations/${encodeURIComponent(d.cancellation_id)}`,
      { headers: authHeaders() });
    const overview = (data && data.overview) || await cxlLoadOverview(d.cancellation_id);
    renderCancellationDetail(fresh.data, overview);
    const note = document.getElementById('cxlRefundMsg');
    if (note && data && data.message) { note.textContent = data.message; note.className = 'msg'; }
    if (typeof showToast === 'function') showToast(okText);
    loadB2CRefunds(cxlState.page);
  } catch (err) {
    if (msg) {
      msg.textContent = cxlErrorText(err, 'Could not complete this action.');
      msg.className = 'msg error';
    }
    buttons.forEach(b => { b.disabled = false; });
  }
}

const cxlUrl = (d, tail) =>
  `${API_BASE}/api/admin/cancellations/${encodeURIComponent(d.cancellation_id)}${tail}`;

function cxlDecide(cancellationId, action) {
  const notesEl = document.getElementById('cxlNotes');
  const payload = { action };
  if (notesEl && notesEl.value.trim()) payload.admin_notes = notesEl.value.trim();
  return cxlRun({ cancellation_id: cancellationId }, '#cxlModalBody .modal-actions button',
    () => axios.patch(`${API_BASE}/api/admin/cancellations/${encodeURIComponent(cancellationId)}`,
      payload, { headers: authHeaders() }),
    'Cancellation request updated.');
}

function cxlStartRefund(d) {
  const amountEl = document.getElementById('cxlRefundAmount');
  const payload = {};
  if (amountEl && amountEl.value !== '') payload.refund_amount = Number(amountEl.value);
  return cxlRun(d, '#cxlModalBody .modal-actions button',
    () => axios.post(cxlUrl(d, '/refund'), payload, { headers: authHeaders() }),
    'Refund request recorded.');
}

function cxlAuthorize(d, attemptId) {
  return cxlRun(d, '#cxlModalBody .modal-actions button',
    () => axios.post(cxlUrl(d, `/refund/attempts/${encodeURIComponent(attemptId)}/authorize`), {}, { headers: authHeaders() }),
    'Refund approved.');
}

function cxlRecordManual(d) {
  const get = id => (document.getElementById(id) || {});
  const payload = {
    amount: get('cxlManualAmount').value !== '' ? Number(get('cxlManualAmount').value) : null,
    reference: (get('cxlManualRef').value || '').trim(),
    reason: (get('cxlManualReason').value || '').trim(),
    admin_override: !!get('cxlManualOverride').checked,
  };
  if (!payload.admin_override) {
    const msg = document.getElementById('cxlRefundMsg');
    msg.textContent = 'Tick the confirmation: this records money already returned outside a gateway.';
    msg.className = 'msg error';
    return Promise.resolve();
  }
  return cxlRun(d, '#cxlModalBody .modal-actions button',
    () => axios.post(cxlUrl(d, '/refund/manual'), payload, { headers: authHeaders() }),
    'Manual refund recorded.');
}

function cxlReconcile(d) {
  return cxlRun(d, '#cxlModalBody .modal-actions button',
    () => axios.post(`${API_BASE}/api/admin/cancellations/refunds/reconcile`, {}, { headers: authHeaders() })
      .then(r => ({ data: { overview: null, message: `Checked ${r.data.seen} refund(s) with the provider.` } })),
    'Provider checked.');
}

function cxlResolve(d, attemptId) {
  const reason = window.prompt('What did you check at the provider? (This is recorded.) The refund will be treated as NOT executed.');
  if (!reason || !reason.trim()) return Promise.resolve();
  return cxlRun(d, '#cxlModalBody .modal-actions button',
    () => axios.post(cxlUrl(d, `/refund/attempts/${encodeURIComponent(attemptId)}/resolve-failed`),
      { reason: reason.trim() }, { headers: authHeaders() }),
    'Attempt closed.');
}

function wireCxlModalChrome(overlay) {
  if (overlay.dataset.cxlWired === '1') return;
  overlay.dataset.cxlWired = '1';
  const close = () => overlay.classList.remove('open');
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('click', e => { if (e.target.closest('[data-cxl-close]')) close(); });
}
