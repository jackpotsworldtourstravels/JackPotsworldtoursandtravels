'use strict';
/* Classic — Approvals: the merchant signs off the booking requests its own
   staff raised (CR-3).
   ===========================================================================
   CR-2 put this sign-off with a platform Manager at /manager/. CR-3 moves it
   here, so the screen is deliberately a close cousin of manager-portal.js:
   same buckets, same read-only review, same two decisions. What differs is
   scope — the server only ever returns this merchant's bookings — and the
   self-approval rule, which is why a row can be readable but not decidable.

   WHY THE BUTTONS CAN BE ABSENT ON A ROW YOU CAN OPEN
   An approver who raised the booking may read it in full but not decide it.
   `can_decide` comes from the server and already accounts for that, plus for a
   colleague holding the review claim. The screen never computes it locally —
   if it did, the two would drift and the user would meet a 403 they were
   invited to trigger. */

const CL_APPROVAL_TABS = [
  { id: 'awaiting', label: 'Awaiting approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'returned', label: 'Returned for correction' },
  { id: 'ticketed', label: 'Ticketed' },
];

let clApprovalTab = 'awaiting';
let clApprovalSearch = '';
let clApprovalPage = 1;

/** True when this account may approve at all — drives the sidebar entry.
 *
 *  Approvals is the ONE destination in this portal that is permission-shaped
 *  rather than universal: it is not one of the eleven screens every merchant
 *  user shares, it is the approver's own queue, and a Data Operator has nothing
 *  to see in it. Every *other* screen renders identically for every role and
 *  gates its buttons with clCan() — see the note above clCan in classic-shell.js. */
function clCanApprove() {
  return clCan('booking.merchant_approve');
}

function clInitApprovals() {
  $('cl-approvals').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Approvals</h1>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clApprRefresh">Refresh</button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <div class="cl-tabs" id="clApprTabs" role="tablist"></div>
      </div>
      <div class="cl-panel-body">
        <div class="cl-field">
          <label for="clApprSearch">Search</label>
          <input type="search" id="clApprSearch"
                 placeholder="Request number, booking reference or route">
        </div>
        <div class="cl-table-wrap"><table class="cl-table" id="clApprTable"></table></div>
        <div id="clApprPager" class="cl-msg cl-msg-muted" style="display:none;"></div>
      </div>
    </div>`;

  $('clApprRefresh').addEventListener('click', () => clLoadApprovals());
  let timer;
  $('clApprSearch').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      clApprovalSearch = e.target.value.trim();
      clApprovalPage = 1;
      clLoadApprovals();
    }, 300);
  });

  clRenderApprovalTabs();
  return clLoadApprovals();
}

function clRenderApprovalTabs(counts) {
  $('clApprTabs').innerHTML = CL_APPROVAL_TABS.map(t => {
    const n = counts ? counts[t.id] : undefined;
    return `<button type="button" role="tab" class="cl-tab${t.id === clApprovalTab ? ' active' : ''}"
              data-cl-appr-tab="${t.id}">${t.label}${n ? ` (${n})` : ''}</button>`;
  }).join('');
  $('clApprTabs').querySelectorAll('[data-cl-appr-tab]').forEach(b => {
    b.addEventListener('click', () => {
      clApprovalTab = b.dataset.clApprTab;
      clApprovalPage = 1;
      clRenderApprovalTabs();
      clLoadApprovals();
    });
  });
}

async function clLoadApprovals() {
  const table = $('clApprTable');
  table.innerHTML = clLoadingRow(7, 'Loading approvals…');
  try {
    const [page, counts] = await Promise.all([
      MerchantApi.approvalQueue({
        bucket: clApprovalTab, search: clApprovalSearch, page: clApprovalPage,
      }),
      MerchantApi.approvalCounts().catch(() => null),
    ]);
    if (counts) clRenderApprovalTabs(counts);
    clRenderApprovalRows(page);
  } catch (err) {
    table.innerHTML = clEmptyRow(7, clError(err, 'Could not load the approval queue.'));
    $('clApprPager').style.display = 'none';
  }
}

function clRenderApprovalRows(page) {
  const rows = page.items || [];
  if (!rows.length) {
    $('clApprTable').innerHTML = clEmptyRow(7, clApprovalTab === 'awaiting'
      ? 'Nothing is waiting for your approval.'
      : 'Nothing here yet.');
    $('clApprPager').style.display = 'none';
    return;
  }

  $('clApprTable').innerHTML = `
    <thead><tr>
      <th>Request</th><th>Raised by</th><th>Route</th><th>Travel date</th>
      <th>Pax</th><th>Status</th><th class="cl-actions"></th>
    </tr></thead>
    <tbody>
      ${rows.map(r => `
        <tr>
          <td>
            <span class="cl-ref">${escapeHtml(r.request_number || '—')}</span>
            ${r.booking_reference
              ? `<div class="cl-muted">${escapeHtml(r.booking_reference)}</div>` : ''}
          </td>
          <td>${escapeHtml(r.raised_by || '—')}</td>
          <td class="cl-nowrap">${escapeHtml(
            [r.origin, r.destination].filter(Boolean).join(' → ') || '—')}</td>
          <td class="cl-nowrap">${escapeHtml(r.travel_date ? fmtDate(r.travel_date) : '—')}</td>
          <td>${r.passenger_count ?? '—'}</td>
          <td>${clTag(r.status, r.status_label)}</td>
          <td class="cl-actions"><button type="button" class="cl-btn"
                      data-cl-appr-open="${r.id}">Review</button></td>
        </tr>`).join('')}
    </tbody>`;

  $('clApprTable').querySelectorAll('[data-cl-appr-open]').forEach(b => {
    b.addEventListener('click', () => clOpenApproval(Number(b.dataset.clApprOpen)));
  });

  const pages = Math.max(1, Math.ceil((page.total || 0) / (page.page_size || 20)));
  const pager = $('clApprPager');
  if (pages > 1) {
    pager.style.display = '';
    pager.innerHTML = `
      <button type="button" class="cl-btn" ${clApprovalPage <= 1 ? 'disabled' : ''}
        id="clApprPrev">Previous</button>
      <span style="margin:0 10px;">Page ${page.page} of ${pages}</span>
      <button type="button" class="cl-btn" ${clApprovalPage >= pages ? 'disabled' : ''}
        id="clApprNext">Next</button>`;
    $('clApprPrev')?.addEventListener('click', () => { clApprovalPage--; clLoadApprovals(); });
    $('clApprNext')?.addEventListener('click', () => { clApprovalPage++; clLoadApprovals(); });
  } else {
    pager.style.display = 'none';
  }
}

async function clOpenApproval(requestId) {
  let data;
  try {
    data = await MerchantApi.approvalDetail(requestId);
  } catch (err) {
    /* Classic does not load components/toast.js — every other screen here
       reports failure in a modal, so this does too. */
    clOpenModal('Could not open that request',
      `<div class="cl-msg cl-msg-err">${escapeHtml(
        clError(err, 'Could not open that booking request.'))}</div>`,
      '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    return;
  }

  const r = data.request || {};
  const d = r.details || {};
  const roundTrip = !!r.return_date;
  const decidable = !!data.can_decide;
  const isHotel = r.travel_type === 'hotel';

  const body = `
    <h3>Booking</h3>
    <dl class="cl-dl">
      <div><dt>Raised by</dt><dd>${escapeHtml(r.raised_by || '—')}</dd></div>
      <div><dt>Booking reference</dt><dd class="cl-ref">${escapeHtml(r.booking_reference || '—')}</dd></div>
      <div><dt>From enquiry</dt><dd class="cl-ref">${
        isHotel ? (d.hotel_enquiry_reference
          ? escapeHtml(d.hotel_enquiry_reference)
          : (d.direct_booking ? 'Direct booking' : '—'))
        : (d.enquiry_reference
          ? escapeHtml(d.enquiry_reference)
          : (d.direct_booking ? 'Direct booking' : '—'))}</dd></div>
      <div><dt>Submitted</dt><dd>${escapeHtml(r.created_at ? fmtDateTime(r.created_at) : '—')}</dd></div>
      <div><dt>${isHotel ? 'Guests' : 'Travellers'}</dt><dd>${
        isHotel ? (r.hotel_guests || []).length : (r.passengers || []).length}</dd></div>
      <div><dt>Status</dt><dd>${clTag(r.status, r.status_label)}</dd></div>
    </dl>

    ${isHotel ? `
    <h3>Hotel Stay <span class="cl-muted">— agreed when the enquiry was answered</span></h3>
    <dl class="cl-dl">
      <div><dt>Destination</dt><dd>${escapeHtml(d.destination_city || '—')}</dd></div>
      <div><dt>Hotel</dt><dd>${escapeHtml(d.hotel_name || '—')}</dd></div>
      <div><dt>Star category</dt><dd>${d.star_category ? `${escapeHtml(d.star_category)} Star` : '—'}</dd></div>
      <div><dt>Room type</dt><dd>${escapeHtml(d.room_type || '—')}</dd></div>
      <div><dt>Check-in</dt><dd>${escapeHtml(r.travel_date ? fmtDate(r.travel_date) : '—')}</dd></div>
      <div><dt>Check-out</dt><dd>${escapeHtml(r.return_date ? fmtDate(r.return_date) : '—')}</dd></div>
    </dl>

    <h3>Guests</h3>
    <div class="cl-table-wrap"><table class="cl-table">
      <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Room</th><th>ID proof</th></tr></thead>
      <tbody>
        ${(r.hotel_guests || []).map((g, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml([g.title, g.first_name, g.last_name].filter(Boolean).join(' '))}${
              g.is_lead_guest ? ' <span class="cl-tag">Lead</span>' : ''}</td>
            <td>${escapeHtml(g.guest_type || 'adult')}</td>
            <td>Room ${g.room_number}</td>
            <td class="cl-ref">${escapeHtml(g.id_proof_number || '—')}</td>
          </tr>`).join('')}
      </tbody>
    </table></div>` : `
    <h3>Itinerary <span class="cl-muted">— agreed when the enquiry was answered</span></h3>
    <dl class="cl-dl">
      <div><dt>Trip type</dt><dd>${roundTrip ? 'Round trip' : 'One way'}</dd></div>
      <div><dt>From</dt><dd>${escapeHtml([d.origin_city, d.origin].filter(Boolean).join(' · ') || '—')}</dd></div>
      <div><dt>To</dt><dd>${escapeHtml([d.destination_city, d.destination].filter(Boolean).join(' · ') || '—')}</dd></div>
      <div><dt>Airline</dt><dd>${escapeHtml(fmtAirline(d.airline))}</dd></div>
      <div><dt>Flight</dt><dd class="cl-ref">${escapeHtml(d.flight_number || '—')}</dd></div>
      <div><dt>Departure</dt><dd>${escapeHtml(r.travel_date ? fmtDate(r.travel_date) : '—')}</dd></div>
      ${roundTrip ? `<div><dt>Return</dt><dd>${escapeHtml(fmtDate(r.return_date))}</dd></div>` : ''}
      <div><dt>Class</dt><dd>${escapeHtml(d.travel_class || '—')}</dd></div>
      <div><dt>Route</dt><dd>${d.international ? 'International' : 'Domestic'}</dd></div>
    </dl>

    <h3>Passengers</h3>
    <div class="cl-table-wrap"><table class="cl-table">
      <thead><tr>
        <th>#</th><th>Name</th><th>Type</th><th>Date of birth</th>
        <th>Nationality</th><th>Passport</th><th>Expiry</th>
      </tr></thead>
      <tbody>
        ${(r.passengers || []).map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' '))}</td>
            <td>${escapeHtml(p.passenger_type || 'adult')}</td>
            <td class="cl-nowrap">${escapeHtml(p.dob ? fmtDate(p.dob) : '—')}</td>
            <td>${escapeHtml(p.nationality || '—')}</td>
            <td class="cl-ref">${escapeHtml(p.passport_number || '—')}</td>
            <td class="cl-nowrap">${escapeHtml(p.passport_expiry ? fmtDate(p.passport_expiry) : '—')}</td>
          </tr>`).join('')}
      </tbody>
    </table></div>`}

    ${d.special_requests
      ? `<h3>Special requests</h3><p>${escapeHtml(d.special_requests)}</p>` : ''}

    <h3>Timeline</h3>
    <dl class="cl-dl">
      ${(data.timeline || []).map(s => `
        <div>
          <dt>${escapeHtml(s.label || s.status || '')}</dt>
          <dd>${s.at ? escapeHtml(fmtDateTime(s.at)) : 'Not yet'}${
            s.by ? ` · ${escapeHtml(s.by)}` : ''}${
            s.reason ? `<div class="cl-muted">${escapeHtml(s.reason)}</div>` : ''}</dd>
        </div>`).join('')}
    </dl>

    ${decidable ? `
      <h3>Decision</h3>
      <div class="cl-field">
        <label for="clApprRemarks">Remarks</label>
        <textarea id="clApprRemarks" rows="3"
          placeholder="Required when returning — tell your colleague exactly what to fix."></textarea>
      </div>
      <div class="cl-msg" id="clApprMsg" aria-live="polite"></div>`
      : `<div class="cl-msg cl-msg-muted">${escapeHtml(clWhyNotDecidable(data, r))}</div>`}`;

  const foot = decidable
    ? `<button type="button" class="cl-btn" id="clApprReturnBtn">Return for correction</button>
       <button type="button" class="cl-btn cl-btn-primary" id="clApprApproveBtn">Approve for ticketing</button>`
    : `<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>`;

  clOpenModal(`Booking request ${r.request_number || ''}`, body, foot);

  if (!decidable) return;
  $('clApprApproveBtn').addEventListener('click', () => clDecideApproval(requestId, 'approve'));
  $('clApprReturnBtn').addEventListener('click', () => clDecideApproval(requestId, 'return'));
}

/* The server decides `can_decide`; this only explains it, so the two can never
   disagree about *whether* — at worst this shows the less specific reason. */
function clWhyNotDecidable(data, request) {
  if (data.reviewer_name) {
    return `${data.reviewer_name} is reviewing this request. Only they can decide it.`;
  }
  if (!['pending_approval', 'in_review'].includes(request.status)) {
    return 'This request has already been decided.';
  }
  return 'You raised this booking request, so a colleague has to approve it.';
}

async function clDecideApproval(requestId, action) {
  const msg = $('clApprMsg');
  const remarks = ($('clApprRemarks')?.value || '').trim();
  if (action === 'return' && !remarks) {
    clMsg(msg, 'Tell your colleague what needs correcting.', 'err');
    return;
  }

  const buttons = ['clApprApproveBtn', 'clApprReturnBtn'].map(id => $(id)).filter(Boolean);
  buttons.forEach(b => { b.disabled = true; });
  clMsg(msg, '');

  try {
    if (action === 'approve') {
      await MerchantApi.approvalApprove(requestId, remarks || null);
    } else {
      await MerchantApi.approvalReturn(requestId, remarks);
    }
    clCloseModal();
    /* The decision changes My Requests and the dashboard counters too, not
       just this queue. */
    clInvalidate('requests', 'dashboard');
    clRefreshIfVisible('dashboard');
    clLoadApprovals();
  } catch (err) {
    clMsg(msg, clError(err, 'That did not go through.'), 'err');
    buttons.forEach(b => { b.disabled = false; });
  }
}
