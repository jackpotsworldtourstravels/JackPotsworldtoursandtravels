/* Admin — Cancellations & Reschedules (M3)
   ========================================
   Where a merchant's request to cancel or move a confirmed booking is settled.

   WHY THIS IS NOT SERVICE REQUEST MANAGEMENT
   That screen resolves a request by marking it Approved. These two do more than
   that: an approved cancellation really cancels the booking and states the
   refund; an approved reschedule really rewrites its travel dates and states
   what is payable. The generic resolve endpoint does neither, so the backend
   now refuses it for these two types outright — the same treatment enquiries
   got in Phase 2. Two screens because they are two workflows, not one workflow
   with a filter.

   WHERE THE MONEY COMES FROM
   Here, and nowhere else. A merchant sends no amounts when it raises the
   request — the cancellation charge and the fare difference are the airline's,
   and are entered by the operator settling it. The refund is never typed: it is
   derived from the booking total minus the charge, server-side, and the server
   refuses a charge larger than the booking.

   ENDPOINTS
     GET  /api/change-requests                      list (staff see every merchant)
     GET  /api/change-requests/counts               tab badges
     GET  /api/change-requests/{id}                 detail + booking + timeline
     POST /api/admin/change-requests/{id}/review    claim: Pending -> Under Review
     POST /api/admin/change-requests/{id}/approve   quote + settle + apply
     POST /api/admin/change-requests/{id}/reject    refuse, reason mandatory

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDate, fmtDateTime, rowsSkeleton, loadedSections) plus the
   shared toast/confirmDialog components. Nothing here restates them. */

const CR_LABELS = {
  pending_approval: 'Pending',
  in_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
};
const CR_BADGE = {
  pending_approval: 'pending',
  in_review: 'pending',
  approved: 'confirmed',
  rejected: 'cancelled',
  cancelled: 'cancelled',
};
/* Still needs someone. One list so the filter, the summary line and the nav
   badge cannot drift apart. */
const CR_OPEN = ['pending_approval', 'in_review'];

const crLabel = s => CR_LABELS[s] || s;

let crRows = [];
let crFiltersWired = false;
let crSearchTimer = null;
let crSelfId = null;

function crSelf() {
  if (crSelfId !== null) return crSelfId;
  // Stored as a string by storePortalTokens(); the API returns a number, and
  // "12" !== 12 would make every claim look like someone else's.
  const raw = localStorage.getItem('jwt_user_id');
  crSelfId = raw ? Number(raw) : null;
  return crSelfId;
}

function updateChangeRequestNavBadge(count) {
  const badge = document.getElementById('crNavBadge');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = !count;
}

function crMoney(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
    : '—';
}

/* What the merchant actually asked for, in one cell. A reschedule is only
   meaningful as "from → to", so both dates travel on the list row rather than
   costing a detail fetch per row. */
function crAsk(r) {
  if (r.change_type === 'date_change') {
    return `<div>${r.current_travel_date ? fmtDate(r.current_travel_date) : '—'} →
            <strong>${r.new_travel_date ? fmtDate(r.new_travel_date) : '—'}</strong></div>
            <div class="cell-sub">${escapeHtml(r.reason || '')}</div>`;
  }
  return `<div>Cancel the whole booking</div>
          <div class="cell-sub">${escapeHtml(r.reason || '')}</div>`;
}

/* The settled figure, or nothing. A pending request shows a dash rather than
   0.00 — "not priced yet" and "nothing to refund" are different statements. */
function crSettlement(r) {
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

async function loadChangeRequests() {
  if (!crFiltersWired) {
    crFiltersWired = true;
    ['crStatusFilter', 'crTypeFilter'].forEach(id =>
      document.getElementById(id).addEventListener('change', () => loadChangeRequests()));
    document.getElementById('crSearch').addEventListener('input', () => {
      clearTimeout(crSearchTimer);
      crSearchTimer = setTimeout(() => loadChangeRequests(), 300);
    });
    document.getElementById('crRefreshBtn').addEventListener('click', () => loadChangeRequests());
  }

  const tbody = document.querySelector('#crTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(4)}</td></tr>`;

  const statusValue = document.getElementById('crStatusFilter').value;
  const typeValue = document.getElementById('crTypeFilter').value;
  const search = document.getElementById('crSearch').value.trim();

  try {
    /* "Awaiting settlement" spans two statuses and the endpoint takes one, so
       it is fetched as two calls and merged — the same shape the Ticket
       Enquiries screen uses. */
    const statuses = statusValue === 'open' ? CR_OPEN : [statusValue || undefined];
    const pages = await Promise.all(statuses.map(st =>
      axios.get(`${API_BASE}/api/change-requests`, {
        headers: authHeaders(),
        params: {
          request_status: st, type: typeValue || undefined,
          search: search || undefined, page: 1, page_size: 100,
        },
      }).then(res => res.data.items).catch(() => [])));

    const items = pages.flat().sort((a, b) => b.id - a.id);
    crRows = items;

    const openCount = items.filter(r => CR_OPEN.includes(r.status)).length;
    document.getElementById('crQueueSummary').textContent =
      `${items.length} request${items.length === 1 ? '' : 's'}` +
      (openCount ? ` · ${openCount} awaiting settlement` : '');

    tbody.innerHTML = items.length ? items.map(r => {
      const mine = r.review_claimed_by && r.review_claimed_by === crSelf();
      const heldByOther = r.status === 'in_review' && r.review_claimed_by && !mine;
      return `
      <tr>
        <td><span class="mono">${escapeHtml(r.request_number)}</span></td>
        <td>${escapeHtml(r.change_type_label)}</td>
        <td>${escapeHtml(r.merchant_name || '—')}</td>
        <td><span class="mono">${escapeHtml(r.booking_request_number || '—')}</span>
            <div class="cell-sub">${escapeHtml(r.pnr || '')}</div></td>
        <td>${crAsk(r)}</td>
        <td>
          <span class="badge ${CR_BADGE[r.status] || 'pending'}">${escapeHtml(crLabel(r.status))}</span>
          ${heldByOther ? `<div class="cell-sub">with ${escapeHtml(r.review_claimed_by_name)}</div>` : ''}
          ${mine && CR_OPEN.includes(r.status) ? '<div class="cell-sub">with you</div>' : ''}
          ${crSettlement(r)}
        </td>
        <td>${fmtDateTime(r.created_at)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-navy btn-sm" data-cr-open="${r.id}">
            ${CR_OPEN.includes(r.status) ? 'Settle' : 'View'}
          </button>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" class="empty-state">No cancellation or reschedule requests match this filter.</td></tr>`;

    tbody.querySelectorAll('[data-cr-open]').forEach(btn =>
      btn.addEventListener('click', () => openChangeRequest(btn.dataset.crOpen)));

    // Only meaningful when the view is unfiltered or already showing the open
    // ones — a badge computed from a "Rejected only" page would be a lie.
    updateChangeRequestNavBadge(
      statusValue === 'open' || !statusValue ? openCount : undefined);
    document.getElementById('crPagination').innerHTML = '';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load change requests.</td></tr>`;
  }
}

function crDetailRow(label, value) {
  return `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span>
          <span class="detail-value">${value}</span></div>`;
}

async function openChangeRequest(requestId) {
  const overlay = document.getElementById('crModalOverlay');
  const body = document.getElementById('crModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<h2>Change request</h2><div>${rowsSkeleton(4)}</div>`;

  let data;
  try {
    /* Always re-fetched rather than reused from the table: the row may have
       been claimed or settled by someone else since the list rendered, and the
       modal should open on the truth. */
    data = (await axios.get(`${API_BASE}/api/change-requests/${requestId}`,
      { headers: authHeaders() })).data;
  } catch (err) {
    body.innerHTML = `<h2>Change request</h2>
      <div class="msg error">${escapeHtml(err.response?.data?.detail || 'Failed to load this request.')}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-cr-close>Close</button></div>`;
    wireChangeRequestModal(overlay, body, null);
    return;
  }

  const r = data.request;
  const b = data.booking;
  const p = r.pricing || {};
  const isCancellation = r.change_type === 'cancellation';
  const heldByOther = r.status === 'in_review' && r.review_claimed_by
    && r.review_claimed_by !== crSelf();

  body.innerHTML = `
    <h2>${escapeHtml(r.change_type_label)} ${escapeHtml(r.request_number)}</h2>
    <p class="modal-sub">
      ${escapeHtml(r.merchant_name || '')} · raised ${fmtDateTime(r.created_at)}
    </p>

    <div class="detail-grid">
      ${crDetailRow('Status', `<span class="badge ${CR_BADGE[r.status] || 'pending'}">${escapeHtml(crLabel(r.status))}</span>`)}
      ${crDetailRow('Booking', b ? `<span class="mono">${escapeHtml(b.request_number)}</span>` : '—')}
      ${crDetailRow('Booking status', b ? escapeHtml(b.status_label) : '—')}
      ${crDetailRow('Booking total', b ? crMoney(b.total_amount) : '—')}
      ${crDetailRow('PNR', escapeHtml(r.pnr || '—'))}
      ${crDetailRow('Passengers', b ? String(b.passengers) : '—')}
      ${crDetailRow('Departing', b && b.travel_date ? fmtDate(b.travel_date) : '—')}
      ${!isCancellation ? crDetailRow('Requested date',
        `<strong>${r.new_travel_date ? fmtDate(r.new_travel_date) : '—'}</strong>`) : ''}
      ${!isCancellation && r.new_return_date ? crDetailRow('Requested return', fmtDate(r.new_return_date)) : ''}
    </div>

    ${r.reason ? `<div class="detail-note"><strong>Merchant's reason</strong><p>${escapeHtml(r.reason)}</p></div>` : ''}
    ${r.rejection_reason ? `<div class="detail-note"><strong>Refused because</strong><p>${escapeHtml(r.rejection_reason)}</p></div>` : ''}
    ${p.kind ? `<div class="detail-note"><strong>Settled</strong><p>${
      p.kind === 'cancellation'
        ? `Cancellation charge ${crMoney(p.cancellation_charge)} on a booking of ${crMoney(p.booking_amount)} — refund due <strong>${crMoney(p.refund_amount)}</strong>.`
        : `Fare difference ${crMoney(p.fare_difference)} plus a change fee of ${crMoney(p.change_fee)} — payable <strong>${crMoney(p.total_payable)}</strong>.`
    }${p.quoted_by_name ? ` Quoted by ${escapeHtml(p.quoted_by_name)}.` : ''}</p></div>` : ''}

    ${heldByOther ? `<div class="msg warn">${escapeHtml(r.review_claimed_by_name)} is reviewing this request. Only they can settle it.</div>` : ''}
    ${!data.can_settle && !heldByOther ? `<div class="msg info">This request has been settled and is now read-only.</div>` : ''}

    ${data.can_settle ? `
      ${data.can_review ? `
        <div class="enq-claim">
          <button class="btn btn-ghost" id="crStartReviewBtn" type="button">Start review</button>
          <span class="cell-sub">Claims this request so another admin cannot settle it at the same time.</span>
        </div>` : ''}

      ${isCancellation ? `
        <div class="form-field" style="max-width:none;">
          <label for="crChargeInput">Cancellation charge (₹)</label>
          <input type="number" id="crChargeInput" min="0" step="0.01" placeholder="0.00"
                 max="${escapeHtml(String(b ? b.total_amount : ''))}">
          <span class="cell-sub" id="crRefundPreview">
            Leave blank for a free cancellation. The refund is calculated from the booking total.
          </span>
        </div>`
      : `
        <div class="form-field" style="max-width:none;">
          <label for="crFareInput">Fare difference (₹)</label>
          <input type="number" id="crFareInput" min="0" step="0.01" placeholder="0.00">
          <span class="cell-sub">The airline's difference on the new date. A date change never
            produces a refund — if the merchant is owed money, they cancel instead.</span>
        </div>
        <div class="form-field" style="max-width:none;">
          <label for="crFeeInput">Change fee (₹)</label>
          <input type="number" id="crFeeInput" min="0" step="0.01" placeholder="0.00">
          <span class="cell-sub" id="crPayablePreview">Our handling charge on top.</span>
        </div>`}

      <div class="form-field" style="max-width:none;">
        <label for="crNoteInput">Note <span class="cell-sub">(shown on the timeline)</span></label>
        <input type="text" id="crNoteInput" placeholder="e.g. Airline fare rule CX-3, confirmed with the desk">
      </div>
      <div class="form-field" style="max-width:none;">
        <label for="crReasonInput">Reason <span class="cell-sub">(required when refusing)</span></label>
        <input type="text" id="crReasonInput" placeholder="e.g. No seats available on that date">
      </div>

      <div class="msg" id="crModalMsg"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-cr-close type="button">Cancel</button>
        <button class="btn btn-danger" id="crRejectBtn" type="button">Refuse request</button>
        <button class="btn btn-navy" id="crApproveBtn" type="button">
          ${isCancellation ? 'Approve &amp; cancel booking' : 'Approve &amp; move booking'}
        </button>
      </div>`
    : `<div class="modal-actions"><button class="btn btn-ghost" data-cr-close type="button">Close</button></div>`}
  `;

  wireChangeRequestModal(overlay, body, data);
}

function wireChangeRequestModal(overlay, body, data) {
  const close = () => overlay.classList.remove('open');
  body.querySelectorAll('[data-cr-close]').forEach(b => b.addEventListener('click', close));
  if (!data) return;

  const r = data.request;
  const b = data.booking;
  const isCancellation = r.change_type === 'cancellation';
  const msg = document.getElementById('crModalMsg');
  const setMsg = (text, kind) => { if (msg) { msg.textContent = text; msg.className = `msg ${kind || ''}`; } };

  /* Live preview of what the merchant will be told. The server computes the
     real figure; this only mirrors the same arithmetic so the operator is not
     typing blind into a number they cannot see the effect of. */
  const charge = document.getElementById('crChargeInput');
  if (charge && b) {
    const preview = document.getElementById('crRefundPreview');
    charge.addEventListener('input', () => {
      const value = Number(charge.value || 0);
      const total = Number(b.total_amount);
      if (value > total) {
        preview.textContent = `A charge of ${crMoney(value)} is more than the booking (${crMoney(total)}) — this will be refused.`;
      } else {
        preview.textContent = `Refund due: ${crMoney(total - value)} of ${crMoney(total)}.`;
      }
    });
  }
  const fare = document.getElementById('crFareInput');
  const fee = document.getElementById('crFeeInput');
  if (fare && fee) {
    const preview = document.getElementById('crPayablePreview');
    const sync = () => {
      preview.textContent =
        `Payable by the merchant: ${crMoney(Number(fare.value || 0) + Number(fee.value || 0))}.`;
    };
    fare.addEventListener('input', sync);
    fee.addEventListener('input', sync);
  }

  const startBtn = document.getElementById('crStartReviewBtn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await axios.post(`${API_BASE}/api/admin/change-requests/${r.id}/review`, {},
          { headers: authHeaders() });
        showToast(`${r.request_number} is now under your review.`);
        await loadChangeRequests();
        openChangeRequest(r.id);          // reopen on the fresh state
      } catch (err) {
        startBtn.disabled = false;
        setMsg(err.response?.data?.detail || 'Could not start the review.', 'error');
      }
    });
  }

  const buttons = () => ['crApproveBtn', 'crRejectBtn'].map(id => document.getElementById(id));

  document.getElementById('crApproveBtn')?.addEventListener('click', async () => {
    const payload = { note: (document.getElementById('crNoteInput')?.value || '').trim() || undefined };
    let summary;

    if (isCancellation) {
      const value = (charge?.value || '').trim();
      const amount = Number(value || 0);
      const total = Number(b ? b.total_amount : 0);
      if (value && (!Number.isFinite(amount) || amount < 0)) {
        return setMsg('The cancellation charge cannot be negative.', 'error');
      }
      if (amount > total) {
        return setMsg(`The charge cannot be more than the booking total (${crMoney(total)}).`, 'error');
      }
      // Amounts go as strings: a JSON number is a float in transit, and this
      // one lands in the ledger.
      payload.cancellation_charge = value || '0';
      summary = `${b ? b.request_number : 'The booking'} will be cancelled. `
        + `Charge ${crMoney(amount)}, refund due ${crMoney(total - amount)}.`;
    } else {
      const d = (fare?.value || '').trim();
      const f = (fee?.value || '').trim();
      if (Number(d || 0) < 0 || Number(f || 0) < 0) {
        return setMsg('Neither amount can be negative — a date change does not produce a refund.', 'error');
      }
      payload.fare_difference = d || '0';
      payload.change_fee = f || '0';
      summary = `${b ? b.request_number : 'The booking'} will move to `
        + `${r.new_travel_date ? fmtDate(r.new_travel_date) : 'the requested date'}. `
        + `Payable ${crMoney(Number(d || 0) + Number(f || 0))}.`;
    }

    /* confirmDialog, not window.confirm: native dialogs are suppressed in the
       automated browser and cannot be driven during verification. */
    const ok = await confirmDialog({
      title: isCancellation ? 'Approve this cancellation?' : 'Approve this reschedule?',
      message: `${summary} This is applied immediately and cannot be undone here.`,
      confirmText: 'Approve',
      danger: isCancellation,
    });
    if (!ok) return;

    buttons().forEach(x => x && (x.disabled = true));
    try {
      await axios.post(`${API_BASE}/api/admin/change-requests/${r.id}/approve`, payload,
        { headers: authHeaders() });
      showToast(`${r.request_number} approved.`);
      overlay.classList.remove('open');
      loadChangeRequests();
      // Both counters move when a booking is cancelled or repriced.
      if (loadedSections.has('reports')) loadReports();
      if (loadedSections.has('partner-requests')) loadApprovalQueue();
    } catch (err) {
      buttons().forEach(x => x && (x.disabled = false));
      setMsg(err.response?.data?.detail || 'Could not settle this request.', 'error');
    }
  });

  document.getElementById('crRejectBtn')?.addEventListener('click', async () => {
    const reason = (document.getElementById('crReasonInput')?.value || '').trim();
    if (!reason) {
      setMsg('A reason is required when refusing a request.', 'error');
      document.getElementById('crReasonInput')?.focus();
      return;
    }
    const ok = await confirmDialog({
      title: 'Refuse this request?',
      message: `${r.request_number} will be refused and the booking left exactly as it is. `
        + 'The merchant is told the reason.',
      confirmText: 'Refuse request',
      danger: true,
    });
    if (!ok) return;

    buttons().forEach(x => x && (x.disabled = true));
    try {
      await axios.post(`${API_BASE}/api/admin/change-requests/${r.id}/reject`, { reason },
        { headers: authHeaders() });
      showToast(`${r.request_number} refused.`);
      overlay.classList.remove('open');
      loadChangeRequests();
    } catch (err) {
      buttons().forEach(x => x && (x.disabled = false));
      setMsg(err.response?.data?.detail || 'Could not refuse this request.', 'error');
    }
  });
}
