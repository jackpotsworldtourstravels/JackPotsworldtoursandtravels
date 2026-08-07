/* Admin — Booking Enquiries (Phase 2)
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

   CR-5 — THE ANSWER IS A QUOTATION, NOT A FLAG
   "Mark Available" was a one-click yes that told the merchant nothing about
   what the sector would cost. It is now **Send Quotation**: a total fare and
   the remarks that explain it ("₹3,000 ticket fare, ₹12,000 baggage"), both
   required by the server. That fare is binding — the booking the merchant
   raises is created at exactly that amount, so it is what the credit limit is
   checked against and what the merchant's wallet is debited when the ticket is
   issued. There is no edit afterwards, which is why the confirmation names the
   figure.

   THE ADMIN PORTAL NOW SAYS **BOOKING ENQUIRY**, THE SAME AS THE MERCHANT.
   It used to say "Ticket Enquiry" on purpose — the merchant was starting a
   booking, the desk was working an enquiry queue, and the split was the
   internal operations vocabulary (CR-5). That split was dropped on request:
   two names for one row cost more in confusion than the distinction was worth.
   The Premium merchant portal (`merchant/`) still says "Ticket Enquiry"; it
   was not in scope. Nothing underneath moved — same rows, same `request_type`,
   and the section key is still `ticket-enquiries`.

   ENDPOINTS — all pre-existing or added in Phase 2, none duplicated here:
     GET  /api/enquiries                          list (platform staff see all)
     GET  /api/enquiries/{id}                     detail
     POST /api/admin/enquiries/{id}/review        claim: Pending -> Under Review
     POST /api/admin/enquiries/{id}/respond       answer: quotation / decline

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
  const arrow = tripTypeArrow(r.trip_type);
  /* fmtAirline never returns empty, so the sub-line always names the carrier
     position — "All Airlines" for an open enquiry — and the flight number joins
     it only when there is one. A queue row that showed neither used to look
     like a row with missing data. */
  const flight = [fmtAirline(r.airline), r.flight_number].filter(Boolean).join(' ');
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
/* 24-hour, matching the merchant form that produced it — see admTimeLabel in
   admin-bookings.js for why. Preferred times only; timestamps are unaffected. */
function enqTime(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return String(hhmm);
  return `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
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
          ${r.quoted_fare != null
            ? `<div class="cell-sub">Quoted ${escapeHtml(moneyStr(r.quoted_fare))}</div>` : ''}
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
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load booking enquiries.</td></tr>`;
  }
}

function enqDetailRow(label, value) {
  return `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span>
          <span class="detail-value">${value}</span></div>`;
}

/* The quotation, once one has been sent (CR-5). Absent on a pending enquiry, on
   a declined one, and on every enquiry answered before CR-5 — which is why this
   returns '' rather than rendering a zero. A quoted fare of 0 cannot occur:
   the server refuses it. */
function enqQuotationNote(r) {
  if (r.quoted_fare == null) return '';
  return `<div class="detail-note">
    <strong>Quotation sent</strong>
    <p><span class="mono" style="font-size:15px;font-weight:700;">${escapeHtml(moneyStr(r.quoted_fare))}</span></p>
    ${r.quotation_remarks
      ? `<p style="white-space:pre-wrap;">${escapeHtml(r.quotation_remarks)}</p>` : ''}
    <p class="cell-sub">Binding — the booking raised against this enquiry carries this amount.</p>
  </div>`;
}

/* A 422 from FastAPI carries `detail` as an array of per-field errors rather
   than a string, and rendering that directly gives the desk "[object Object]".
   Pydantic's own message is the useful part — the fare and remarks rules are
   both enforced there, so this is the path a server-side refusal takes. */
function enqErrorText(err) {
  const detail = err?.response?.data?.detail;
  if (Array.isArray(detail)) {
    return String(detail[0]?.msg || 'Please check the form.').replace(/^Value error,\s*/, '');
  }
  return detail || 'Could not record that answer.';
}

async function openEnquiryReview(enquiryId) {
  const overlay = document.getElementById('enqReviewModalOverlay');
  const body = document.getElementById('enqReviewModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<h2>Booking Enquiry</h2><div>${rowsSkeleton(4)}</div>`;

  let r;
  try {
    /* Always re-fetched rather than reused from the table: the row may have
       been answered or claimed by someone else since the list was rendered,
       and the modal should open on the truth. */
    r = (await axios.get(`${API_BASE}/api/enquiries/${enquiryId}`, { headers: authHeaders() })).data;
  } catch (err) {
    body.innerHTML = `<h2>Booking Enquiry</h2>
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
      ${enqDetailRow('Trip type', tripTypeLabel(r.trip_type))}
      ${enqDetailRow('From', escapeHtml([r.origin_city, r.origin].filter(Boolean).join(' · ')))}
      ${enqDetailRow('To', escapeHtml([r.destination_city, r.destination].filter(Boolean).join(' · ')))}
      <!-- "All Airlines" when the merchant left it open — this is the desk's
           signal that it may quote any carrier, so it must not read as "—". -->
      ${enqDetailRow('Airline', escapeHtml(fmtAirline(r.airline)))}
      ${enqDetailRow('Flight number', escapeHtml(fmtFlightNumber(r.flight_number)))}
      ${enqDetailRow('Flight number', escapeHtml(r.flight_number || '—'))}
      ${enqDetailRow('Departure', `${r.travel_date ? fmtDate(r.travel_date) : '—'} · ${enqTime(r.preferred_time)}`)}
      ${r.return_date ? enqDetailRow('Return', `${fmtDate(r.return_date)} · ${enqTime(r.return_preferred_time)}`) : ''}
      <!-- Two fields: Class is the cabin, Booking Class the airline's
           single-letter fare bucket within it. Both are absent on a group
           enquiry, where the desk settles them when it quotes the party. -->
      ${enqDetailRow('Class', escapeHtml(r.travel_class || '—'))}
      ${enqDetailRow('Booking Class', escapeHtml(r.booking_class || '—'))}
      ${enqDetailRow('Passengers', `${r.passenger_count} — ${escapeHtml(enqPaxSummary(r))}`)}
      ${r.booking_request_number ? enqDetailRow('Booking raised', `<span class="mono">${escapeHtml(r.booking_request_number)}</span>`) : ''}
      ${/* 0040 — what the merchant has already quoted its OWN customer. Shown
            to the desk BEFORE it prices this enquiry, which is the whole point:
            a quotation above the client fare wipes out the merchant's margin,
            and the desk could not previously see that it was about to.
            Rendered only when recorded — null means "not recorded", and a
            dash is honest where a zero would be a claim. */ ''}
      ${/* `moneyIntl`, not `moneyStr`: the client fare is grouped in threes
            (1,000,000) wherever it appears, in this portal and the merchant's
            alike, which is what the merchant typed into the box. Every figure
            WE bill — the quotation, the saving below — stays on the portal's
            Indian grouping. */ ''}
      ${r.client_fare != null
        ? enqDetailRow('Client fare', `<span class="mono">${escapeHtml(moneyIntl(r.client_fare))}</span>
             <span class="cell-sub">what the merchant sold at</span>`)
        : ''}
      ${r.saved_amount != null
        ? enqDetailRow('Merchant saves', `<span class="mono">${escapeHtml(moneyStr(r.saved_amount))}</span>
             <span class="cell-sub">client fare less our quotation</span>`)
        : ''}
    </div>

    ${r.notes ? `<div class="detail-note"><strong>Merchant's notes</strong><p>${escapeHtml(r.notes)}</p></div>` : ''}
    ${enqQuotationNote(r)}
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
        <label for="enqFareInput">Total fare <span class="cell-sub">(required to send a quotation)</span></label>
        <!-- inputmode="decimal" rather than type="number": a spinner on a money
             field invites a stray scroll-wheel repricing, and the value is sent
             as the string the desk typed so nothing floats it on the way out. -->
        <input type="text" id="enqFareInput" inputmode="decimal" autocomplete="off"
               placeholder="e.g. 15000.00">
        <span class="cell-sub">Typed by you, never calculated. This becomes the amount
          ${escapeHtml(r.merchant_name || 'the merchant')} is billed when the ticket is issued,
          and it is checked against their credit limit before the booking reaches this desk.</span>
      </div>
      <div class="form-field" style="max-width:none;">
        <label for="enqReasonText">Remarks / reason
          <span class="cell-sub">(required either way)</span></label>
        <textarea id="enqReasonText" rows="3"
          placeholder="On a quotation: what the total is made up of — e.g. ₹3,000 ticket fare, ₹12,000 baggage charges.&#10;On a decline: why — e.g. sold out in Business on this date."></textarea>
        <span class="cell-sub">The merchant reads this beside the amount. It is what explains a
          total that differs from the bare ticket price.</span>
      </div>
      <div class="form-field" style="max-width:none;">
        <label for="enqResponseText">Covering note <span class="cell-sub">(optional)</span></label>
        <textarea id="enqResponseText" rows="2"
          placeholder="Timings, alternatives, anything else the merchant needs to decide."></textarea>
      </div>
      <div class="msg" id="enqReviewMsg"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-enq-close type="button">Cancel</button>
        <button class="btn btn-danger" id="enqNotAvailableBtn" type="button">Decline Enquiry</button>
        <button class="btn btn-navy" id="enqAvailableBtn" type="button">Send Quotation</button>
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
    const fareRaw = (document.getElementById('enqFareInput')?.value || '').trim();

    if (!reason) {
      setMsg(available
        ? 'Add the remarks explaining this quotation — the merchant reads them beside the amount.'
        : 'A reason is required when declining an enquiry.', 'error');
      document.getElementById('enqReasonText')?.focus();
      return;
    }

    /* Validated here as a *string*, not by parsing it into a number: the value
       is sent exactly as typed against a Decimal schema, so the only checks
       that make sense are on its shape. Rejecting it client-side saves the desk
       a round trip; the server enforces the same rule regardless. */
    let fare;
    if (available) {
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(fareRaw)) {
        setMsg('Enter the total fare as a plain amount — digits, and at most two decimals.', 'error');
        document.getElementById('enqFareInput')?.focus();
        return;
      }
      if (!/[1-9]/.test(fareRaw)) {
        setMsg('The total fare must be more than zero — a quotation of 0 bills nobody.', 'error');
        document.getElementById('enqFareInput')?.focus();
        return;
      }
      fare = fareRaw;
    }

    /* Confirmed because the answer is final — there is no edit afterwards, and
       since CR-5 it is also a price the merchant will be billed, so the figure
       is named in the confirmation rather than left in a field behind it.
       confirmDialog, not window.confirm: native dialogs are suppressed in the
       automated browser and cannot be driven during verification. */
    const ok = await confirmDialog({
      title: available ? 'Send this quotation?' : 'Decline this enquiry?',
      message: available
        ? `${r.reference_number} will be quoted to ${r.merchant_name || 'the merchant'} at `
          + `${moneyStr(fare)}. That is the amount their booking is raised at, checked against `
          + `their credit limit, and debited from their wallet when the ticket is issued. `
          + `This answer is final and cannot be repriced.`
        : `${r.reference_number} will be closed as not available. This answer is final.`,
      confirmText: available ? 'Send Quotation' : 'Decline Enquiry',
      danger: !available,
    });
    if (!ok) return;

    const buttons = ['enqAvailableBtn', 'enqNotAvailableBtn'].map(id => document.getElementById(id));
    buttons.forEach(b => b && (b.disabled = true));
    try {
      await axios.post(`${API_BASE}/api/admin/enquiries/${r.id}/respond`,
        {
          available,
          reason,
          response: response || undefined,
          /* Sent only on a quotation — the server refuses a fare on a decline
             rather than dropping it, so an accidental one is not swallowed. */
          ...(available ? { total_fare: fare } : {}),
        },
        { headers: authHeaders() });
      showToast(available
        ? `${r.reference_number} quoted at ${moneyStr(fare)}.`
        : `${r.reference_number} declined.`);
      overlay.classList.remove('open');
      loadTicketEnquiries(enqPage);
      if (loadedSections.has('reports')) loadReports();   // keep the counters honest
    } catch (err) {
      buttons.forEach(b => b && (b.disabled = false));
      setMsg(enqErrorText(err), 'error');
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
