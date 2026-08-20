/* Admin — the cancellation & reschedule settle dialog (M3)
   ========================================================
   Where a merchant's request to cancel or move a confirmed booking is priced
   and applied. It is a DIALOG, not a screen: Service Request Management lists
   every service request whatever its type, and opens this one for the two that
   change the booking.

   WHY THESE TWO NEED THEIR OWN DIALOG
   The generic resolve endpoint settles a request by marking it Approved. These
   two do more than that: an approved cancellation really cancels the booking
   and states the refund; an approved reschedule really rewrites its travel
   dates and states what is payable. The backend refuses the generic endpoint
   for them outright — the same treatment enquiries got in Phase 2 — so the
   difference is in the API, not only in this UI.

   WHERE THE MONEY COMES FROM
   Here, and nowhere else. A merchant sends no amounts when it raises the
   request — the cancellation charge and the fare difference are the airline's,
   and are entered by the operator settling it. The refund is never typed: it is
   derived from the booking total minus the charge, server-side, and the server
   refuses a charge larger than the booking.

   THE MERCHANT'S MANAGER HAS ALREADY APPROVED
   Or this dialog is read-only. `can_settle` and `can_review` come back false
   until a manager at the merchant has signed the request off, and every staff
   endpoint below 409s for one that has not been.

   ENDPOINTS
     GET  /api/change-requests/{id}                 detail + booking + timeline
     POST /api/admin/change-requests/{id}/review    claim: Pending -> Under Review
     POST /api/admin/change-requests/{id}/approve   quote + settle + apply
     POST /api/admin/change-requests/{id}/reject    refuse, reason mandatory

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDate, fmtDateTime, rowsSkeleton, loadedSections) plus the
   shared toast/confirmDialog components. Nothing here restates them. */

const CR_BADGE = {
  pending_approval: 'pending',
  in_review: 'pending',
  approved: 'confirmed',
  rejected: 'cancelled',
  cancelled: 'cancelled',
};

/* No CR_LABELS map. `status_label` comes off the API already worded for the
   stage the request is at — "Under Manager Approval" and "Manager Approved"
   are derived server-side (services/manager_approval.py) and a local map would
   only be a second, staler opinion of the same thing. */

let crSelfId = null;

function crSelf() {
  if (crSelfId !== null) return crSelfId;
  // Stored as a string by storePortalTokens(); the API returns a number, and
  // "12" !== 12 would make every claim look like someone else's.
  const raw = localStorage.getItem('jwt_user_id');
  crSelfId = raw ? Number(raw) : null;
  return crSelfId;
}

function crMoney(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
    : '—';
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
      ${crDetailRow('Status', `<span class="badge ${CR_BADGE[r.status] || 'pending'}">${escapeHtml(r.status_label)}</span>`)}
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
    ${(r.manager_approval || {}).by_name ? `<div class="detail-note"><strong>Merchant's manager</strong>
      <p>${escapeHtml(r.manager_approval.by_name)} ${
        r.manager_approval.self_raised ? 'raised this themselves, as a manager'
        : r.manager_approval.state === 'approved' ? 'approved it'
        : `rejected it${r.manager_approval.reason ? `: ${escapeHtml(r.manager_approval.reason)}` : ''}`
      }.</p></div>` : ''}
    ${r.rejection_reason ? `<div class="detail-note"><strong>Refused because</strong><p>${escapeHtml(r.rejection_reason)}</p></div>` : ''}
    ${p.kind ? `<div class="detail-note"><strong>Settled</strong><p>${
      p.kind === 'cancellation'
        ? `Cancellation charge ${crMoney(p.cancellation_charge)} on a booking of ${crMoney(p.booking_amount)} — refund due <strong>${crMoney(p.refund_amount)}</strong>.`
        : `Fare difference ${crMoney(p.fare_difference)} plus a charge fee of ${crMoney(p.change_fee)} — payable <strong>${crMoney(p.total_payable)}</strong>.`
    }${p.quoted_by_name ? ` Quoted by ${escapeHtml(p.quoted_by_name)}.` : ''}</p></div>` : ''}

    ${heldByOther ? `<div class="msg warn">${escapeHtml(r.review_claimed_by_name)} is reviewing this request. Only they can settle it.</div>` : ''}
    ${!data.can_settle && !heldByOther ? `<div class="msg info">${
      /* Two very different reasons for the same read-only state, and telling
         them apart is the difference between "nothing to do" and "not yet". */
      r.manager_state === 'pending'
        ? 'This request is still with the merchant’s own manager. It cannot be settled here until '
          + 'they have approved it — the server refuses it too.'
        : r.manager_state === 'rejected'
        ? 'The merchant’s own manager rejected this request. It never reached us and there is '
          + 'nothing to settle.'
        : 'This request has been settled and is now read-only.'
    }</div>` : ''}

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
        </div>
        <!-- What approving will do to the merchant's wallet, before it is done.
             Rendered only when the server sent the balance — it is staff-only,
             so a payload without it means this operator may not see it and the
             block is simply absent rather than showing a wrong zero. -->
        ${b && b.merchant_wallet_balance != null ? `
          <div class="cr-settle" id="crSettlePreview"></div>` : ''}`
      : `
        <div class="form-field" style="max-width:none;">
          <label for="crFareInput">Fare difference (₹)</label>
          <input type="number" id="crFareInput" min="0" step="0.01" placeholder="0.00">
          <span class="cell-sub">The airline's difference on the new date. A date change never
            produces a refund — if the merchant is owed money, they cancel instead.</span>
        </div>
        <div class="form-field" style="max-width:none;">
          <label for="crFeeInput">Charge fee (₹)</label>
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
    const settle = document.getElementById('crSettlePreview');

    /* WHAT APPROVING WILL DO TO THE WALLET, MIRRORING `approve` EXACTLY.
       The cancellation is irreversible from this screen, so the resulting
       balance is shown before it is committed rather than discovered after.

       THE CAP IS THE WHOLE REASON THIS IS NOT `total - fee`. The server credits
       `min(refund_due, refundable)`, and `refundable_against` counts only
       SETTLED payments net of anything already refunded — so a part-paid
       booking gives back less than the quoted refund and an unpaid one gives
       back nothing. Previewing the quote instead of the capped figure would
       promise the merchant money that the settlement is not going to move, on
       the one screen where the operator is deciding whether to commit it. */
    const renderSettle = () => {
      if (!settle) return;
      const total = Number(b.total_amount || 0);
      const fee = Number(charge.value || 0);
      const balance = Number(b.merchant_wallet_balance || 0);
      const refundDue = Math.max(total - fee, 0);
      // `refundable` absent means the server did not send it; fall back to the
      // quote rather than inventing a cap of zero, which would understate.
      const refundable = b.refundable == null ? refundDue : Number(b.refundable);
      const credited = Math.min(refundDue, refundable);
      const after = balance + credited;
      const capped = credited < refundDue - 0.005;

      settle.innerHTML = `
        <div class="cr-settle-row"><span>Original ticket cost</span><b>${crMoney(total)}</b></div>
        <div class="cr-settle-row"><span>Cancellation fee</span><b>&minus;&nbsp;${crMoney(fee)}</b></div>
        <div class="cr-settle-row"><span>Refund to wallet</span><b>${crMoney(credited)}</b></div>
        <div class="cr-settle-row cr-settle-total">
          <span>Wallet after settlement</span>
          <b class="${after < 0 ? 'is-neg' : after > 0 ? 'is-pos' : ''}">${crMoney(after)}</b>
        </div>
        <div class="cr-settle-now">Wallet now: ${crMoney(balance)}</div>
        ${capped ? `<div class="cr-settle-note">Only ${crMoney(refundable)} of this booking has
          been paid, so the refund is capped at that. The remaining
          ${crMoney(refundDue - credited)} is recorded as unsettled.</div>` : ''}`;
    };

    const sync = () => {
      const value = Number(charge.value || 0);
      const total = Number(b.total_amount);
      if (value > total) {
        preview.textContent = `A charge of ${crMoney(value)} is more than the booking (${crMoney(total)}) — this will be refused.`;
      } else {
        preview.textContent = `Refund due: ${crMoney(total - value)} of ${crMoney(total)}.`;
      }
      renderSettle();
    };
    charge.addEventListener('input', sync);
    // Painted once on open, so the preview is right at a charge of zero rather
    // than blank until the operator touches the field.
    renderSettle();
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
        await loadServiceRequestManagement();
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
      loadServiceRequestManagement();
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
      loadServiceRequestManagement();
    } catch (err) {
      buttons().forEach(x => x && (x.disabled = false));
      setMsg(err.response?.data?.detail || 'Could not refuse this request.', 'error');
    }
  });
}
