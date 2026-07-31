/* Admin — Ticket Enquiries (Phase 2)
   ==================================
   The Admin half of the merchant's Enquire Ticket flow. A merchant describes a
   sector; this screen is where our team answers it.

   WHY THIS IS NOT THE APPROVAL QUEUE
   An enquiry is not a booking awaiting approval. It has different actions (a
   written answer, not a one-click approve), a different lifecycle (it never
   becomes payable — nothing is owed on an enquiry), and a different outcome
   (approving *unlocks* a booking rather than being one). `approval_service`
   deliberately leaves `ticket_enquiry` out of its type list, and the backend
   now refuses the generic approve/reject endpoints for enquiries outright.

   ENDPOINTS — all pre-existing or added in Phase 2, none duplicated here:
     GET  /api/enquiries                          list (platform staff see all)
     GET  /api/enquiries/{id}                     detail
     POST /api/admin/enquiries/{id}/review        claim: Pending -> Under Review
     POST /api/admin/enquiries/{id}/respond       answer: Available / Not available

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, navigateToSection, PAGE_SIZE) plus the
   shared toast/confirmDialog components. Nothing here restates them. */

/* Enquiry wording for the shared statuses, matching `ENQUIRY_LABELS` in
   enquiry_service.py and the merchant's Classic portal — "Approved" on a
   booking means priced and payable, but on an enquiry it means "we have this,
   go ahead and book", so all three surfaces say Available. */
const ENQ_LABELS = {
  pending_approval: 'Pending',
  in_review: 'Under Review',
  approved: 'Available',
  rejected: 'Not Available',
  cancelled: 'Cancelled',
};
const ENQ_BADGE = {
  pending_approval: 'pending',
  in_review: 'pending',
  approved: 'confirmed',
  rejected: 'cancelled',
  cancelled: 'cancelled',
};
/* Still owed an answer. Kept as one list so the filter, the summary line and
   the nav badge cannot drift apart. */
const ENQ_OPEN = ['pending_approval', 'in_review'];

const enqLabel = s => ENQ_LABELS[s] || s;

let enqPage = 1;
let enqRows = [];
let enqFiltersWired = false;
let enqSearchTimer = null;
/* Who we are, so the screen can tell "you are reviewing this" from "someone
   else is" before the server has to say so with a 409. */
let enqSelfId = null;

function enqSelf() {
  if (enqSelfId !== null) return enqSelfId;
  // Stored by storePortalTokens() in auth.js as a string; the API returns a
  // number, so compare as numbers or "12" !== 12 makes every claim look
  // like someone else's.
  const raw = localStorage.getItem('jwt_user_id');
  enqSelfId = raw ? Number(raw) : null;
  return enqSelfId;
}

function updateEnquiryNavBadge(count) {
  const badge = document.getElementById('enqNavBadge');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = !count;
}

function enqRoute(r) {
  const from = r.origin_city || r.origin || '—';
  const to = r.destination_city || r.destination || '—';
  const arrow = r.trip_type === 'round_trip' ? '⇄' : '→';
  const flight = [r.airline, r.flight_number].filter(Boolean).join(' ');
  return `<div>${escapeHtml(from)} ${arrow} ${escapeHtml(to)}</div>
          <div class="cell-sub">${escapeHtml(flight)}${r.travel_class ? ` · ${escapeHtml(r.travel_class)}` : ''}</div>`;
}

function enqPaxSummary(r) {
  const parts = [];
  if (r.adults) parts.push(`${r.adults} adult${r.adults > 1 ? 's' : ''}`);
  if (r.children) parts.push(`${r.children} child${r.children > 1 ? 'ren' : ''}`);
  if (r.infants) parts.push(`${r.infants} infant${r.infants > 1 ? 's' : ''}`);
  return parts.join(', ') || '—';
}

/* 24h "19:00" -> "7:00 PM". The merchant form collects 1-12 + AM/PM and stores
   24h; this reverses it for display so both portals show the same clock. */
function enqTime(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  const mer = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${mer}`;
}

async function loadTicketEnquiries(page = enqPage) {
  enqPage = page;
  if (!enqFiltersWired) {
    enqFiltersWired = true;
    ['enqStatusFilter', 'enqDateFrom', 'enqDateTo'].forEach(id =>
      document.getElementById(id).addEventListener('change', () => loadTicketEnquiries(1)));
    document.getElementById('enqSearch').addEventListener('input', () => {
      clearTimeout(enqSearchTimer);
      enqSearchTimer = setTimeout(() => loadTicketEnquiries(1), 300);
    });
    document.getElementById('enqRefreshBtn').addEventListener('click', () => loadTicketEnquiries(enqPage));
  }

  const tbody = document.querySelector('#enqTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(4)}</td></tr>`;

  const statusValue = document.getElementById('enqStatusFilter').value;
  const search = document.getElementById('enqSearch').value.trim();
  const dateFrom = document.getElementById('enqDateFrom').value;
  const dateTo = document.getElementById('enqDateTo').value;

  try {
    /* "Awaiting response" spans two statuses and the endpoint takes one, so it
       is fetched as two calls and merged — the same shape the Service Request
       screen already uses for its multi-type filter. */
    const statuses = statusValue === 'awaiting' ? ENQ_OPEN : [statusValue || undefined];
    const pages = await Promise.all(statuses.map(st =>
      axios.get(`${API_BASE}/api/enquiries`, {
        headers: authHeaders(),
        params: { status: st, search: search || undefined, page: 1, page_size: 100 },
      }).then(r => r.data.items).catch(() => [])));

    let items = pages.flat();
    /* Travel-date range is filtered client-side: the enquiry endpoint has no
       date params, and adding them to a merchant-facing API purely for this
       screen would widen a contract Phase 1 already froze. */
    if (dateFrom) items = items.filter(r => r.travel_date && r.travel_date >= dateFrom);
    if (dateTo) items = items.filter(r => r.travel_date && r.travel_date <= dateTo);
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    enqRows = items;

    const openCount = items.filter(r => ENQ_OPEN.includes(r.status)).length;
    document.getElementById('enqQueueSummary').textContent =
      `${items.length} enquir${items.length === 1 ? 'y' : 'ies'}${openCount ? ` · ${openCount} awaiting a response` : ''}`;

    tbody.innerHTML = items.length ? items.map(r => {
      const holder = r.review_claimed_by_name;
      const mine = r.review_claimed_by && r.review_claimed_by === enqSelf();
      const heldByOther = r.status === 'in_review' && r.review_claimed_by && !mine;
      return `
      <tr>
        <td><span class="mono">${escapeHtml(r.reference_number)}</span></td>
        <td>${escapeHtml(r.merchant_name || '—')}<div class="cell-sub">${escapeHtml(r.raised_by || '')}</div></td>
        <td>${enqRoute(r)}</td>
        <td>${r.travel_date ? fmtDate(r.travel_date) : '—'}<div class="cell-sub">${enqTime(r.preferred_time)}</div></td>
        <td>${r.passenger_count}</td>
        <td>
          <span class="badge ${ENQ_BADGE[r.status] || 'pending'}">${escapeHtml(enqLabel(r.status))}</span>
          ${heldByOther ? `<div class="cell-sub">with ${escapeHtml(holder)}</div>` : ''}
          ${mine ? '<div class="cell-sub">with you</div>' : ''}
        </td>
        <td>${fmtDateTime(r.created_at)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-navy btn-sm" data-enq-open="${r.id}">
            ${ENQ_OPEN.includes(r.status) ? 'Review' : 'View'}
          </button>
          ${r.booking_request_number
            ? `<div class="cell-sub">Booked ${escapeHtml(r.booking_request_number)}</div>` : ''}
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" class="empty-state">No enquiries match this filter.</td></tr>`;

    tbody.querySelectorAll('[data-enq-open]').forEach(btn =>
      btn.addEventListener('click', () => openEnquiryReview(btn.dataset.enqOpen)));

    updateEnquiryNavBadge(
      statusValue === 'awaiting' || !statusValue ? openCount : undefined);
    document.getElementById('enqPagination').innerHTML = '';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load ticket enquiries.</td></tr>`;
  }
}

function enqDetailRow(label, value) {
  return `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span>
          <span class="detail-value">${value}</span></div>`;
}

async function openEnquiryReview(enquiryId) {
  const overlay = document.getElementById('enqReviewModalOverlay');
  const body = document.getElementById('enqReviewModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<h2>Ticket Enquiry</h2><div>${rowsSkeleton(4)}</div>`;

  let r;
  try {
    /* Always re-fetched rather than reused from the table: the row may have
       been answered or claimed by someone else since the list was rendered,
       and the modal should open on the truth. */
    r = (await axios.get(`${API_BASE}/api/enquiries/${enquiryId}`, { headers: authHeaders() })).data;
  } catch (err) {
    body.innerHTML = `<h2>Ticket Enquiry</h2>
      <div class="msg error">${escapeHtml(err.response?.data?.detail || 'Failed to load this enquiry.')}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-enq-close>Close</button></div>`;
    wireEnquiryModal(overlay, body, null);
    return;
  }

  const open = ENQ_OPEN.includes(r.status);
  const mine = r.review_claimed_by && r.review_claimed_by === enqSelf();
  const heldByOther = r.status === 'in_review' && r.review_claimed_by && !mine;
  const canAnswer = open && !heldByOther;

  body.innerHTML = `
    <h2>Enquiry ${escapeHtml(r.reference_number)}</h2>
    <p class="modal-sub">
      ${escapeHtml(r.merchant_name || '')}${r.raised_by ? ` · raised by ${escapeHtml(r.raised_by)}` : ''}
      · ${fmtDateTime(r.created_at)}
    </p>

    <div class="detail-grid">
      ${enqDetailRow('Status', `<span class="badge ${ENQ_BADGE[r.status] || 'pending'}">${escapeHtml(enqLabel(r.status))}</span>`)}
      ${enqDetailRow('Trip type', r.trip_type === 'round_trip' ? 'Round Trip' : 'One Way')}
      ${enqDetailRow('From', escapeHtml([r.origin_city, r.origin].filter(Boolean).join(' · ')))}
      ${enqDetailRow('To', escapeHtml([r.destination_city, r.destination].filter(Boolean).join(' · ')))}
      ${enqDetailRow('Airline', escapeHtml(r.airline || '—'))}
      ${enqDetailRow('Flight number', escapeHtml(r.flight_number || '—'))}
      ${enqDetailRow('Departure', `${r.travel_date ? fmtDate(r.travel_date) : '—'} · ${enqTime(r.preferred_time)}`)}
      ${r.return_date ? enqDetailRow('Return', `${fmtDate(r.return_date)} · ${enqTime(r.return_preferred_time)}`) : ''}
      ${enqDetailRow('Travel class', escapeHtml(r.travel_class || '—'))}
      ${enqDetailRow('Passengers', `${r.passenger_count} — ${escapeHtml(enqPaxSummary(r))}`)}
      ${r.booking_request_number ? enqDetailRow('Booking raised', `<span class="mono">${escapeHtml(r.booking_request_number)}</span>`) : ''}
    </div>

    ${r.notes ? `<div class="detail-note"><strong>Merchant's notes</strong><p>${escapeHtml(r.notes)}</p></div>` : ''}
    ${r.admin_response ? `<div class="detail-note"><strong>Our response</strong><p>${escapeHtml(r.admin_response)}</p></div>` : ''}
    ${r.rejection_reason ? `<div class="detail-note"><strong>Reason</strong><p>${escapeHtml(r.rejection_reason)}</p></div>` : ''}

    ${heldByOther ? `<div class="msg warn">${escapeHtml(r.review_claimed_by_name)} is reviewing this enquiry. Only they can answer it.</div>` : ''}
    ${!open ? `<div class="msg info">This enquiry has been answered and is now read-only. If the merchant needs a different answer, they raise a new enquiry.</div>` : ''}

    ${canAnswer ? `
      ${r.status === 'pending_approval' ? `
        <div class="enq-claim">
          <button class="btn btn-ghost" id="enqStartReviewBtn" type="button">Start review</button>
          <span class="cell-sub">Claims this enquiry so another admin cannot answer it at the same time.</span>
        </div>` : ''}
      <div class="form-field" style="max-width:none;">
        <label for="enqResponseText">Response to merchant</label>
        <textarea id="enqResponseText" rows="3"
          placeholder="Fare, timings, alternatives — whatever the merchant needs to decide."></textarea>
      </div>
      <div class="form-field" style="max-width:none;">
        <label for="enqReasonText">Reason <span class="cell-sub">(required when marking not available)</span></label>
        <input type="text" id="enqReasonText" placeholder="e.g. Sold out in Business on this date">
      </div>
      <div class="msg" id="enqReviewMsg"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-enq-close type="button">Cancel</button>
        <button class="btn btn-danger" id="enqNotAvailableBtn" type="button">Mark Not Available</button>
        <button class="btn btn-navy" id="enqAvailableBtn" type="button">Mark Available</button>
      </div>`
    : `<div class="modal-actions"><button class="btn btn-ghost" data-enq-close type="button">Close</button></div>`}
  `;

  wireEnquiryModal(overlay, body, r);
}

function wireEnquiryModal(overlay, body, r) {
  const close = () => overlay.classList.remove('open');
  body.querySelectorAll('[data-enq-close]').forEach(b => b.addEventListener('click', close));
  if (!r) return;

  const msg = document.getElementById('enqReviewMsg');
  const setMsg = (text, kind) => { if (msg) { msg.textContent = text; msg.className = `msg ${kind || ''}`; } };

  const startBtn = document.getElementById('enqStartReviewBtn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await axios.post(`${API_BASE}/api/admin/enquiries/${r.id}/review`, {}, { headers: authHeaders() });
        showToast(`${r.reference_number} is now under your review.`);
        await loadTicketEnquiries(enqPage);
        openEnquiryReview(r.id);          // reopen on the fresh state
      } catch (err) {
        startBtn.disabled = false;
        setMsg(err.response?.data?.detail || 'Could not start the review.', 'error');
      }
    });
  }

  const answer = async (available) => {
    const response = (document.getElementById('enqResponseText')?.value || '').trim();
    const reason = (document.getElementById('enqReasonText')?.value || '').trim();

    if (!available && !reason) {
      setMsg('A reason is required when marking an enquiry not available.', 'error');
      document.getElementById('enqReasonText')?.focus();
      return;
    }

    /* Confirmed because the answer is final — there is no edit afterwards.
       confirmDialog, not window.confirm: native dialogs are suppressed in the
       automated browser and cannot be driven during verification. */
    const ok = await confirmDialog({
      title: available ? 'Mark this enquiry available?' : 'Mark this enquiry not available?',
      message: available
        ? `${r.reference_number} will be released to ${r.merchant_name || 'the merchant'}, who can then raise a booking against it. This answer is final.`
        : `${r.reference_number} will be closed as not available. This answer is final.`,
      confirmText: available ? 'Mark Available' : 'Mark Not Available',
      danger: !available,
    });
    if (!ok) return;

    const buttons = ['enqAvailableBtn', 'enqNotAvailableBtn'].map(id => document.getElementById(id));
    buttons.forEach(b => b && (b.disabled = true));
    try {
      await axios.post(`${API_BASE}/api/admin/enquiries/${r.id}/respond`,
        { available, reason: reason || undefined, response: response || undefined },
        { headers: authHeaders() });
      showToast(`${r.reference_number} marked ${available ? 'available' : 'not available'}.`);
      overlay.classList.remove('open');
      loadTicketEnquiries(enqPage);
      if (loadedSections.has('reports')) loadReports();   // keep the counters honest
    } catch (err) {
      buttons.forEach(b => b && (b.disabled = false));
      setMsg(err.response?.data?.detail || 'Could not record that answer.', 'error');
    }
  };

  document.getElementById('enqAvailableBtn')?.addEventListener('click', () => answer(true));
  document.getElementById('enqNotAvailableBtn')?.addEventListener('click', () => answer(false));
}

/* Dashboard stat cards that carry data-goto-section jump to that screen. */
document.addEventListener('click', e => {
  const card = e.target.closest('[data-goto-section]');
  if (card) navigateToSection(card.dataset.gotoSection);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest?.('[data-goto-section]');
  if (card) { e.preventDefault(); navigateToSection(card.dataset.gotoSection); }
});
