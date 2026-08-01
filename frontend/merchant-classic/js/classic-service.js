'use strict';
/* Classic — Service Requests: post-booking changes against an existing booking.
   ===========================================================================
   SIX TYPES, TWO BACKENDS, ONE SCREEN.

   Cancellation and Date change go through the M3 cancellation/reschedule
   endpoints:

     POST /api/bookings/{id}/cancellation   { reason }
     POST /api/bookings/{id}/reschedule     { new_travel_date, new_return_date, reason }

   Those two settle money and change the booking itself — an approved
   cancellation really cancels it, an approved reschedule really moves its
   dates. The generic POST /api/service-requests hook does neither, which is
   why they moved off it.

   Passenger correction and the three ancillaries (extra baggage, meal, seat)
   use the generic hook, unchanged:

     passenger_modification { passenger_id, field, new_value }
     extra_baggage          { passenger_id, weight_kg }
     meal                   { passenger_id, meal }
     seat                   { passenger_id, seat_preference }

   The split is invisible here on purpose: a merchant asking us to do something
   about a booking should not have to know which of our two code paths handles
   it. Every type is raised the same way, appears in the same list, and is
   approved by the same two people.

   EVERY REQUEST IS APPROVED TWICE, IN THIS ORDER
   The merchant's own manager first, then our desk. A request is raised into
   "Under Manager Approval" and our team cannot see or settle it until that
   manager signs it off; if they reject it, it is closed and never reaches us.
   There is no withdraw — see services/manager_approval.py for why it went.
   Whoever raised the request can do nothing further to it, which is the point:
   the decision belongs to their manager, and it leaves a record.

   REFUND IS NOT OFFERED. It was a tab here, and it asked the merchant to type
   an amount that our desk then had to ignore and recompute. Money comes back
   through an approved cancellation, which quotes the airline's charge and
   derives the refund from the booking — one path to a refund, priced by the
   people who can price it. The `refund` request type still exists in the API
   and old rows still render in the list below.

   NO AMOUNTS ARE ENTERED HERE, for the same reason. The cancellation charge
   and the fare difference are the airline's, quoted by our team when they
   settle the request. A pending request deliberately shows no figures rather
   than a guess. */

/* Bookings a service request may be raised against at all. */
const CL_SR_ELIGIBLE = ['approved', 'payment_pending', 'paid', 'ticket_issued', 'ticketed', 'completed'];

/* A COMPLETED booking can still be cancelled: after travel what is being
   settled is the money — a no-show, a duplicate, a dispute — not the journey.
   It cannot be rescheduled, because the journey has already happened. The
   server enforces exactly this split (change_request_service), so these two
   lists are the UI half of one rule rather than a second opinion. */
const CL_CANCEL_ELIGIBLE = CL_SR_ELIGIBLE;
const CL_RESCHEDULE_ELIGIBLE = ['approved', 'payment_pending', 'paid', 'ticket_issued', 'ticketed'];

const CL_SR_TABS = [
  { id: 'cancellation', label: 'Cancellation' },
  { id: 'date_change', label: 'Date change' },
  { id: 'passenger_modification', label: 'Passenger correction' },
  { id: 'extra_baggage', label: 'Extra baggage' },
  { id: 'meal', label: 'Meal' },
  { id: 'seat', label: 'Seat' },
];

/* Which types this screen LISTS is MERCHANT_SERVICE_REQUEST_TYPES, from
   shared/merchant-api.js — My Requests needs the same list, so it lives beside
   the rest of the vocabulary rather than here. `refund` is in it but is
   deliberately not one of the tabs above: old refund rows still render, no new
   one can be raised. */

let clSrBooking = null;
let clSrTab = 'cancellation';
let clSrBookings = [];
let clSrRequests = [];
/* Modal mode: the form, or the read-only look at what was booked. */
let clSrViewing = false;

function clInitServiceRequest() {
  $('cl-service-request').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Service Requests</h1>
        <p>Amend a booking after it has been approved. Each request is tracked against the booking,
           and goes to a manager at your own company before it reaches our desk.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clSrRefresh">
          ${clIco('refresh', { size: 15 })} Refresh
        </button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Requests you have raised</h2>
        <span class="cl-kpi-sub" id="clSrCounts"></span>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Request no.</th><th>Type</th><th>Booking</th><th>Status</th>
              <th class="cl-num">Amount</th><th>Raised</th><th class="cl-actions">Action</th>
            </tr></thead>
            <tbody id="clSrList"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-panel-note" id="clSrListNote"></div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Choose a booking</h2></div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Request no.</th><th>Item</th><th>Status</th>
              <th class="cl-num">Amount</th><th>Travel date</th><th class="cl-actions">Action</th>
            </tr></thead>
            <tbody id="clSrBookings"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-panel-note">
        Only bookings that are approved or beyond can be amended. Drafts and requests still
        awaiting approval are not listed — those are withdrawn from
        <a href="#" data-cl-nav-requests>My Requests</a> instead, free of charge.
      </div>
    </div>`;

  $('cl-service-request').querySelector('[data-cl-nav-requests]')?.addEventListener('click', e => {
    e.preventDefault();
    clGo('requests');
  });
  $('clSrRefresh').addEventListener('click', () => clLoadServiceRequests().then(clLoadSrBookings));

  /* Both lists before either renders: the booking table marks the rows that
     already have a cancellation against them, which it can only know from the
     request list. */
  return clLoadServiceRequests().then(clLoadSrBookings);
}

/* ============================================================ the list */

/* One call for all seven types rather than one per type: /api/requests returns
   every kind the merchant has raised, and each row already carries the derived
   status_label ("Under Manager Approval" / "Manager Approved"), the pricing our
   desk quoted, and the manager_approval block. Narrowing here rather than
   server-side because the API filters on a single request_type at a time. */
async function clLoadServiceRequests() {
  const body = $('clSrList');
  if (!body) return;
  body.innerHTML = clLoadingRow(7, 'Loading your service requests…');
  try {
    const data = await MerchantApi.listRequests({ page_size: 100 });
    clSrRequests = (data.items || []).filter(
      r => MERCHANT_SERVICE_REQUEST_TYPES.includes(r.request_type));
    clRenderServiceRequests();
  } catch (err) {
    clSrRequests = [];
    body.innerHTML = clEmptyRow(7, clError(err, 'Failed to load your service requests.'));
  }
}

function clRenderServiceRequests() {
  const body = $('clSrList');
  const rows = clSrRequests;

  body.innerHTML = rows.length
    ? rows.map(r => `<tr>
        <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
        <td class="cl-nowrap">${escapeHtml(clLabel(r.request_type))}</td>
        <td class="cl-ref">${escapeHtml((r.details || {}).booking_request_number || '—')}</td>
        <td>${clSrStatusTag(r)}</td>
        <td class="cl-num">${clSrAmount(r)}</td>
        <td class="cl-nowrap">${escapeHtml(fmtDate(r.created_at))}</td>
        <td class="cl-actions">${clSrRowActions(r)}</td>
      </tr>${clSrDetailRow(r)}`).join('')
    : clEmptyRow(7, 'No service requests raised yet.');

  const awaiting = rows.filter(r => r.manager_state === 'pending').length;
  $('clSrCounts').textContent = rows.length
    ? `${rows.length} in total${awaiting ? ` · ${awaiting} awaiting a manager` : ''}`
    : '';

  $('clSrListNote').innerHTML = clIsManager()
    ? `Every request raised in your company comes to you first. Approving one sends it to the
       JackPots desk; rejecting one closes it and it never reaches them. <b>Amount</b> is filled in
       by our team when they settle it — the charge is the airline's and is never estimated here.`
    : `A request goes to your manager first. Once they approve it, our team takes it from there —
       there is nothing further for you to do, and a request cannot be taken back. <b>Amount</b>
       is filled in by our team when they settle it.`;

  body.querySelectorAll('[data-cl-sr-open]').forEach(b =>
    b.addEventListener('click', () => clOpenRequestDetail(b.dataset.clSrOpen)));
  body.querySelectorAll('[data-cl-sr-approve]').forEach(b =>
    b.addEventListener('click', () => clManagerDecide(b.dataset.clSrApprove, true)));
  body.querySelectorAll('[data-cl-sr-reject]').forEach(b =>
    b.addEventListener('click', () => clManagerDecide(b.dataset.clSrReject, false)));
  body.querySelectorAll('[data-cl-sr-chat]').forEach(b =>
    b.addEventListener('click', () => clGo('support', () => {
      clOpenNewChat();
      const subject = $('clNewChatSubject');
      if (subject) {
        subject.value = `Question about ${b.dataset.clSrChat}`;
        $('clNewChatMessage')?.focus();
      }
    })));
}

/* The manager stage is not a status — it is a fact about a request that is
   still Pending — so it renders as its own tone rather than being folded into
   clTag(), which maps request_status_enum and nothing else. */
function clSrStatusTag(r) {
  if (r.manager_state === 'pending') {
    return '<span class="cl-tag cl-tag-warn">Under Manager Approval</span>';
  }
  if (r.manager_state === 'approved' && r.status === 'pending_approval') {
    return '<span class="cl-tag cl-tag-info">Manager Approved</span>';
  }
  /* A manager's refusal closes the request as `cancelled`. Left bare that reads
     as "the booking was cancelled", which is the opposite of what happened. */
  if (r.manager_state === 'rejected') {
    return '<span class="cl-tag cl-tag-err">Rejected by manager</span>';
  }
  return clTag(r.status);
}

/* Blank rather than 0.00 while unpriced: a zero here reads as "nothing to
   refund", which is a different statement from "not priced yet". */
function clSrAmount(r) {
  const priced = r.pricing && Object.keys(r.pricing).length;
  if (!priced) return '<span class="cl-muted">—</span>';
  return money(r.total_amount);
}

/* A second row carrying what does not fit the columns: what was asked for, and
   what was decided. */
function clSrDetailRow(r) {
  const p = r.pricing || {};
  const d = r.details || {};
  const m = r.manager_approval || {};
  const bits = [];

  if (r.request_type === 'date_change' && d.new_travel_date) {
    bits.push(`${escapeHtml(fmtDate(d.current_travel_date))} → <b>${escapeHtml(fmtDate(d.new_travel_date))}</b>`);
  }
  if (p.kind === 'cancellation') {
    bits.push(`Cancellation charge ${money(p.cancellation_charge)}`);
    bits.push(`Refund due <b>${money(p.refund_amount)}</b>`);
  } else if (p.kind === 'reschedule') {
    bits.push(`Fare difference ${money(p.fare_difference)}`);
    bits.push(`Change fee ${money(p.change_fee)}`);
    bits.push(`Payable <b>${money(p.total_payable)}</b>`);
  }
  if (m.requested_by_name && m.state === 'pending') {
    bits.push(`Raised by ${escapeHtml(m.requested_by_name)}`);
  }
  if (m.state === 'approved' && m.by_name && !m.self_raised) {
    bits.push(`Approved by ${escapeHtml(m.by_name)}`);
  }
  if (m.state === 'rejected') {
    bits.push(`${escapeHtml(m.by_name || 'Your manager')} rejected this: ${escapeHtml(m.reason || 'no reason given')}`);
  } else if (r.status === 'rejected' && r.rejection_reason) {
    bits.push(`Not approved: ${escapeHtml(r.rejection_reason)}`);
  } else if (d.reason) {
    bits.push(`Reason: ${escapeHtml(d.reason)}`);
  }

  if (!bits.length) return '';
  return `<tr class="cl-subrow"><td colspan="7" class="cl-kpi-sub">${bits.join(' &nbsp;·&nbsp; ')}</td></tr>`;
}

/* View is always offered. Approve and Reject only to a manager, and only on a
   request that is actually waiting for one — the server refuses anything else,
   so offering it would be offering a 403. */
function clSrRowActions(r) {
  const out = [`<button type="button" class="cl-btn cl-btn-sm" data-cl-sr-open="${r.id}">View</button>`];
  if (clIsManager() && r.manager_state === 'pending') {
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-sr-approve="${r.id}">Approve</button>`);
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-danger" data-cl-sr-reject="${r.id}">Reject</button>`);
  }
  /* Discuss opens a real support conversation with the reference already in the
     subject, so a question about a service request does not become an email
     nobody can find later. It does NOT act on the request itself: only
     `lifecycle.transition` may move a service_requests row, and a chat thread
     must never look like a fourth way to change one. */
  out.push(`<button type="button" class="cl-btn cl-btn-sm" data-cl-sr-chat="${escapeHtml(r.request_number || '')}"
              title="Ask the desk about this request">Discuss</button>`);
  return out.join('');
}

async function clManagerDecide(id, approve) {
  const row = clSrRequests.find(r => String(r.id) === String(id));
  const ref = row?.request_number || '';

  if (approve) {
    if (!await clConfirm(
      `Approve ${ref}? It goes to the JackPots desk and can no longer be stopped here.`,
      'Approve request')) return;
    try {
      await MerchantApi.managerApprove(id);
      await clLoadServiceRequests();
      clInvalidate('dashboard', 'requests');
      clLoadUnreadCount();
    } catch (err) {
      clOpenModal('Could not approve',
        `<div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Approval failed.'))}</div>`,
        '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    }
    return;
  }

  clOpenModal(`Reject ${ref}`, `
    <p style="margin:0 0 11px;font-size:12.5px;">
      This closes the request. It is never sent to JackPots, and the booking is left exactly as it is.
    </p>
    <div class="cl-field">
      <label for="clSrRejectReason">Reason<span class="cl-req">*</span></label>
      <textarea id="clSrRejectReason" placeholder="The person who raised it will read this."></textarea>
    </div>
    <div class="cl-msg" id="clSrRejectMsg"></div>`,
    `<button type="button" class="cl-btn" data-cl-rj-abort>Keep it</button>
     <button type="button" class="cl-btn cl-btn-danger" data-cl-rj-go>Reject request</button>`);

  $('clModalFoot').querySelector('[data-cl-rj-abort]').addEventListener('click', clCloseModal);
  const go = $('clModalFoot').querySelector('[data-cl-rj-go]');
  go.addEventListener('click', async () => {
    const reason = $('clSrRejectReason').value.trim();
    const msg = $('clSrRejectMsg');
    if (!reason) return clMsg(msg, 'Enter a reason.', 'err');
    go.disabled = true;
    try {
      await MerchantApi.managerReject(id, reason);
      clCloseModal();
      await clLoadServiceRequests();
      clInvalidate('dashboard', 'requests');
      clLoadUnreadCount();
    } catch (err) {
      clMsg(msg, clError(err, 'Could not reject the request.'), 'err');
      go.disabled = false;
    }
  });
}

/* ======================================================= choose a booking */

/* Bookings that already have a live cancellation against them. One cancellation
   per booking is a server rule; knowing it here is what lets the row say so
   instead of the merchant finding out from a 409. */
function clBookingsWithCancellation() {
  return new Set(
    clSrRequests
      .filter(r => r.request_type === 'cancellation'
        && !['rejected', 'cancelled'].includes(r.status))
      .map(r => String(r.parent_request_id))
  );
}

async function clLoadSrBookings() {
  const body = $('clSrBookings');
  body.innerHTML = clLoadingRow(6, 'Loading eligible bookings…');
  try {
    const data = await MerchantApi.listRequests({ request_type: 'booking', page_size: 100 });
    clSrBookings = (data.items || []).filter(r => CL_SR_ELIGIBLE.includes(r.status));
    const cancelled = clBookingsWithCancellation();

    body.innerHTML = clSrBookings.length
      ? clSrBookings.map(r => `<tr data-cl-sr-row="${r.id}">
          <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
          <td>${escapeHtml(r.title || '—')}</td>
          <td>${clTag(r.status)}</td>
          <td class="cl-num">${money(r.total_amount)}</td>
          <td class="cl-nowrap">${escapeHtml(fmtDate(r.travel_date))}</td>
          <td class="cl-actions">
            <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-sr-pick="${r.id}">Select</button>
            ${cancelled.has(String(r.id)) ? '<span class="cl-tag">Cancellation raised</span>' : ''}
          </td>
        </tr>`).join('')
      : clEmptyRow(6, 'No approved bookings yet — a booking can only be amended once our team has approved it.');

    body.querySelectorAll('[data-cl-sr-pick]').forEach(b =>
      b.addEventListener('click', () => clPickSrBooking(b.dataset.clSrPick)));
  } catch (err) {
    body.innerHTML = clEmptyRow(6, clError(err, 'Failed to load bookings.'));
  }
}

/* ============================================================== the modal */

/* The form opens in a dialog over the page, not as a panel appended below the
   table. Appending it meant the merchant clicked Select and nothing visibly
   happened — the form was rendered off-screen, below the fold, and they had to
   scroll to find out that anything had. */
async function clPickSrBooking(id) {
  clSrTab = 'cancellation';
  clSrViewing = false;

  clOpenModal('Raise a service request',
    '<p style="margin:0"><span class="cl-spin"></span> Loading booking…</p>',
    '<button type="button" class="cl-btn" data-cl-sr-close>Close</button>');
  $('clModalFoot').querySelector('[data-cl-sr-close]').addEventListener('click', clCloseModal);

  try {
    /* The list row carries a summary; the passenger list three of the six forms
       need only comes back on the detail endpoint, so it is fetched on select. */
    const data = await MerchantApi.getRequest(id);
    const r = data.request || data;
    clSrBooking = { ...r, passengers: r.passengers || data.passengers || [] };
    clRenderSrModal();
  } catch (err) {
    $('clModalBody').innerHTML = `<div class="cl-msg cl-msg-err" style="margin-top:0">${
      escapeHtml(clError(err, 'Could not load the booking.'))}</div>`;
  }
}

function clRenderSrModal() {
  const b = clSrBooking;
  $('clModalTitle').textContent = `Service request — ${b.request_number || ''}`;

  if (clSrViewing) return clRenderSrView();

  const pax = b.passengers || [];
  $('clModalBody').innerHTML = `
    <dl class="cl-dl" style="margin-bottom:13px;">
      <div><dt>Item</dt><dd>${escapeHtml(b.title || '—')}</dd></div>
      <div><dt>Status</dt><dd>${clTag(b.status)}</dd></div>
      <div><dt>Travel date</dt><dd>${escapeHtml(fmtDate(b.travel_date))}</dd></div>
      <div><dt>Passengers</dt><dd>${pax.length}</dd></div>
      <div><dt>Amount</dt><dd>${money(b.total_amount)}</dd></div>
    </dl>

    <div class="cl-tabs" id="clSrTabs">
      ${CL_SR_TABS.map(t => `<button type="button" class="cl-tab${t.id === clSrTab ? ' active' : ''}"
        data-cl-sr-tab="${t.id}">${t.label}</button>`).join('')}
    </div>

    <div id="clSrTabBody"></div>
    <div class="cl-msg" id="clSrMsg"></div>`;

  $('clModalFoot').innerHTML = `
    <button type="button" class="cl-btn" data-cl-sr-view>View booking details</button>
    <button type="button" class="cl-btn" data-cl-sr-close>Cancel</button>
    <button type="button" class="cl-btn cl-btn-primary" id="clSrSubmit">Submit request</button>`;

  $('clModalFoot').querySelector('[data-cl-sr-view]').addEventListener('click', () => {
    clSrViewing = true;
    clRenderSrModal();
  });
  $('clModalFoot').querySelector('[data-cl-sr-close]').addEventListener('click', clCloseModal);

  $('clSrTabs').querySelectorAll('[data-cl-sr-tab]').forEach(t =>
    t.addEventListener('click', () => { clSrTab = t.dataset.clSrTab; clRenderSrModal(); }));

  clRenderSrTabBody(pax);
}

/* Everything the merchant entered when they booked, read-only: the itinerary
   and every passenger in full. It is the same dialog with a different body —
   opening a second one over the first would leave the half-filled form behind
   a modal the merchant then has to find their way out of. */
function clRenderSrView() {
  const b = clSrBooking;
  const pax = b.passengers || [];
  const d = b.details || b.travel_details || {};
  const contact = d.contact || {};

  $('clModalBody').innerHTML = `
    <h3 style="font-size:12px;margin:0 0 6px;">Booking</h3>
    <dl class="cl-dl" style="margin-bottom:13px;">
      <div><dt>Request no.</dt><dd class="cl-ref">${escapeHtml(b.request_number || '—')}</dd></div>
      <div><dt>Booking ref</dt><dd class="cl-ref">${escapeHtml(b.booking_reference || '—')}</dd></div>
      <div><dt>Status</dt><dd>${clTag(b.status)}</dd></div>
      <div><dt>Travel date</dt><dd>${escapeHtml(fmtDate(b.travel_date))}</dd></div>
      <div><dt>Return date</dt><dd>${escapeHtml(b.return_date ? fmtDate(b.return_date) : 'One way')}</dd></div>
      <div><dt>Amount</dt><dd>${money(b.total_amount)}</dd></div>
      ${b.pnr ? `<div><dt>PNR</dt><dd class="cl-ref">${escapeHtml(b.pnr)}</dd></div>` : ''}
      ${b.ticket_number ? `<div><dt>Ticket no.</dt><dd class="cl-ref">${escapeHtml(b.ticket_number)}</dd></div>` : ''}
    </dl>

    ${clDetailFacts(d)}

    ${contact.name || contact.email || contact.phone ? `
      <h3 style="font-size:12px;margin:14px 0 6px;">Contact</h3>
      <dl class="cl-dl" style="margin-bottom:13px;">
        ${contact.name ? `<div><dt>Name</dt><dd>${escapeHtml(contact.name)}</dd></div>` : ''}
        ${contact.email ? `<div><dt>Email</dt><dd>${escapeHtml(contact.email)}</dd></div>` : ''}
        ${contact.phone ? `<div><dt>Phone</dt><dd>${escapeHtml(contact.phone)}</dd></div>` : ''}
      </dl>` : ''}

    <h3 style="font-size:12px;margin:14px 0 6px;">Passengers (${pax.length})</h3>
    <div class="cl-table-wrap"><table class="cl-table">
      <thead><tr>
        <th>#</th><th>Name</th><th>Type</th><th>Gender</th><th>Date of birth</th>
        <th>Nationality</th><th>Passport</th><th>Expiry</th><th>Seat</th><th>Meal</th>
      </tr></thead>
      <tbody>${pax.length ? pax.map((p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' ') || '—')}</td>
        <td>${escapeHtml(clLabel(p.passenger_type || 'adult'))}</td>
        <td>${escapeHtml(clLabel(p.gender) || '—')}</td>
        <td class="cl-nowrap">${escapeHtml(p.dob ? fmtDate(p.dob) : '—')}</td>
        <td>${escapeHtml(p.nationality || '—')}</td>
        <td class="cl-ref">${escapeHtml(p.passport_number || '—')}</td>
        <td class="cl-nowrap">${escapeHtml(p.passport_expiry ? fmtDate(p.passport_expiry) : '—')}</td>
        <td>${escapeHtml(clLabel(p.seat_preference) || '—')}</td>
        <td>${escapeHtml(clLabel(p.meal_preference) || '—')}</td>
      </tr>`).join('') : clEmptyRow(10, 'No passengers recorded.')}</tbody>
    </table></div>

    ${d.special_requests ? `<h3 style="font-size:12px;margin:14px 0 6px;">Special requests</h3>
      <p style="margin:0;font-size:12.5px;">${escapeHtml(d.special_requests)}</p>` : ''}`;

  $('clModalFoot').innerHTML = `
    <button type="button" class="cl-btn cl-btn-primary" data-cl-sr-back>← Back to the request</button>
    <button type="button" class="cl-btn" data-cl-sr-close>Close</button>`;
  $('clModalFoot').querySelector('[data-cl-sr-back]').addEventListener('click', () => {
    clSrViewing = false;
    clRenderSrModal();
  });
  $('clModalFoot').querySelector('[data-cl-sr-close]').addEventListener('click', clCloseModal);
}

/* ================================================================ the forms */

function clPaxName(p, i) {
  return `${i + 1}. ${[p.title, p.first_name, p.last_name].filter(Boolean).join(' ') || 'Passenger'}`;
}
function clPaxOptions(pax) {
  return pax.map((p, i) => `<option value="${p.id}">${escapeHtml(clPaxName(p, i))}</option>`).join('');
}

/* A tab whose form cannot be submitted hides the Submit button rather than
   letting it 400. */
function clSrLockSubmit(reason) {
  $('clSrTabBody').innerHTML = reason;
  $('clSrSubmit').style.display = 'none';
}

function clSrIneligibleNote(verb) {
  return `<div class="cl-msg cl-msg-info" style="margin-top:0">
    ${escapeHtml(clSrBooking.request_number || 'This booking')} is
    ${clTag(clSrBooking.status)} and cannot be ${escapeHtml(verb)}.
  </div>`;
}

function clRenderSrTabBody(pax) {
  const body = $('clSrTabBody');
  const submit = $('clSrSubmit');
  submit.style.display = '';
  submit.disabled = false;

  /* Four of the six forms name a passenger, and none of them can be filled in
     against a booking with no passenger records. */
  const needsPax = ['passenger_modification', 'extra_baggage', 'meal', 'seat'];
  if (!pax.length && needsPax.includes(clSrTab)) {
    return clSrLockSubmit(`<div class="cl-msg cl-msg-info" style="margin-top:0">
      This booking has no passenger records, so there is nothing to change.</div>`);
  }

  if (clSrTab === 'cancellation') {
    if (!CL_CANCEL_ELIGIBLE.includes(clSrBooking.status)) {
      return clSrLockSubmit(clSrIneligibleNote('cancelled'));
    }
    if (clBookingsWithCancellation().has(String(clSrBooking.id))) {
      return clSrLockSubmit(`<div class="cl-msg cl-msg-info" style="margin-top:0">
        A cancellation has already been raised against ${escapeHtml(clSrBooking.request_number || 'this booking')}.
        A booking is only cancelled once — track that request in the list above.</div>`);
    }
    body.innerHTML = `
      <div class="cl-msg cl-msg-info" style="margin-top:0">
        This cancels <b>the whole booking</b> — all ${pax.length || 0} passenger(s) and both legs.
        It goes to your manager first, and nothing is cancelled until our team then approves it and
        confirms the airline's cancellation charge and the refund due.
      </div>
      <div class="cl-field cl-field-full">
        <label for="clSrCancelRemarks">Reason<span class="cl-req">*</span></label>
        <textarea id="clSrCancelRemarks" placeholder="Why is this being cancelled?"></textarea>
      </div>`;
    submit.textContent = 'Request cancellation';
    submit.onclick = clSubmitSrCancellation;

  } else if (clSrTab === 'date_change') {
    if (!CL_RESCHEDULE_ELIGIBLE.includes(clSrBooking.status)) {
      return clSrLockSubmit(clSrIneligibleNote('rescheduled'));
    }
    /* min = tomorrow: the server refuses today or earlier, so the picker should
       not offer what would come back as a 400. */
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    body.innerHTML = `
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clSrDcDate">New travel date<span class="cl-req">*</span></label>
          <input type="date" id="clSrDcDate" min="${tomorrow}">
        </div>
        <div class="cl-field">
          <label for="clSrDcReturn">New return date</label>
          <input type="date" id="clSrDcReturn" min="${tomorrow}">
        </div>
        <div class="cl-field cl-field-full">
          <label for="clSrDcRemarks">Reason<span class="cl-req">*</span></label>
          <textarea id="clSrDcRemarks" placeholder="Why is the date changing?"></textarea>
        </div>
      </div>
      <p class="cl-kpi-sub" style="margin:8px 0 0;">
        Currently departing ${escapeHtml(fmtDate(clSrBooking.travel_date))}. The booking is not moved
        until your manager and then our team approve; the fare difference and change fee are
        confirmed by us.
      </p>`;
    submit.textContent = 'Request reschedule';
    submit.onclick = clSubmitSrDateChange;

  } else if (clSrTab === 'passenger_modification') {
    body.innerHTML = `
      <div class="cl-form cl-form-3">
        <div class="cl-field">
          <label for="clSrPmPax">Passenger<span class="cl-req">*</span></label>
          <select id="clSrPmPax">${clPaxOptions(pax)}</select>
        </div>
        <div class="cl-field">
          <label for="clSrPmField">Field<span class="cl-req">*</span></label>
          <select id="clSrPmField">
            <option value="first_name">First name</option>
            <option value="last_name">Last name</option>
            <option value="dob">Date of birth</option>
            <option value="passport_number">Passport number</option>
            <option value="passport_expiry">Passport expiry</option>
            <option value="nationality">Nationality</option>
          </select>
        </div>
        <div class="cl-field">
          <label for="clSrPmValue">New value<span class="cl-req">*</span></label>
          <input type="text" id="clSrPmValue">
        </div>
        <div class="cl-field cl-field-full">
          <label for="clSrPmRemarks">Reason<span class="cl-req">*</span></label>
          <textarea id="clSrPmRemarks" placeholder="Why is this correction needed?"></textarea>
        </div>
      </div>
      <p class="cl-kpi-sub" style="margin:8px 0 0;">Name corrections may attract an airline fee.</p>`;
    submit.textContent = 'Request correction';
    submit.onclick = clSubmitSrModification;

  } else if (clSrTab === 'extra_baggage') {
    body.innerHTML = `
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clSrBagPax">Passenger<span class="cl-req">*</span></label>
          <select id="clSrBagPax">${clPaxOptions(pax)}</select>
        </div>
        <div class="cl-field">
          <label for="clSrBagKg">Extra baggage (kg)<span class="cl-req">*</span></label>
          <input type="number" id="clSrBagKg" min="1" max="100" step="1" placeholder="e.g. 20">
        </div>
        <div class="cl-field cl-field-full">
          <label for="clSrBagRemarks">Notes<span class="cl-req">*</span></label>
          <textarea id="clSrBagRemarks" placeholder="Anything the desk should know."></textarea>
        </div>
      </div>
      <p class="cl-kpi-sub" style="margin:8px 0 0;">
        The airline prices excess baggage; our team confirms the amount when they settle this.
      </p>`;
    submit.textContent = 'Request extra baggage';
    submit.onclick = clSubmitSrBaggage;

  } else if (clSrTab === 'meal') {
    body.innerHTML = `
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clSrMealPax">Passenger<span class="cl-req">*</span></label>
          <select id="clSrMealPax">${clPaxOptions(pax)}</select>
        </div>
        <div class="cl-field">
          <label for="clSrMealChoice">Meal<span class="cl-req">*</span></label>
          <select id="clSrMealChoice">
            <option value="vegetarian">Vegetarian</option>
            <option value="vegan">Vegan</option>
            <option value="jain">Jain</option>
            <option value="halal">Halal</option>
            <option value="kosher">Kosher</option>
            <option value="gluten_free">Gluten free</option>
            <option value="diabetic">Diabetic</option>
            <option value="child">Child meal</option>
            <option value="non_vegetarian">Non-vegetarian</option>
          </select>
        </div>
        <div class="cl-field cl-field-full">
          <label for="clSrMealRemarks">Notes<span class="cl-req">*</span></label>
          <textarea id="clSrMealRemarks" placeholder="Allergies or anything else the airline should know."></textarea>
        </div>
      </div>`;
    submit.textContent = 'Request meal';
    submit.onclick = clSubmitSrMeal;

  } else {
    body.innerHTML = `
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clSrSeatPax">Passenger<span class="cl-req">*</span></label>
          <select id="clSrSeatPax">${clPaxOptions(pax)}</select>
        </div>
        <div class="cl-field">
          <label for="clSrSeatChoice">Seat<span class="cl-req">*</span></label>
          <select id="clSrSeatChoice">
            <option value="window">Window</option>
            <option value="aisle">Aisle</option>
            <option value="middle">Middle</option>
            <option value="front_row">Front row</option>
            <option value="exit_row">Exit row</option>
          </select>
        </div>
        <div class="cl-field cl-field-full">
          <label for="clSrSeatRemarks">Notes<span class="cl-req">*</span></label>
          <textarea id="clSrSeatRemarks" placeholder="Seats together, extra legroom, and so on."></textarea>
        </div>
      </div>
      <p class="cl-kpi-sub" style="margin:8px 0 0;">
        A seat request is subject to availability and may carry an airline charge.
      </p>`;
    submit.textContent = 'Request seat';
    submit.onclick = clSubmitSrSeat;
  }
}

/* ================================================================ submits */

/* One tail for every type. It disables the button before the call and leaves it
   disabled on success — the modal closes and the list reloads, so a second
   click has nothing to submit against. That is what stops the same request
   being raised three times by an impatient double-click; the server's
   one-cancellation-per-booking rule is the backstop, not the mechanism. */
async function clSubmitSrRequest(run, successVerb) {
  const msg = $('clSrMsg');
  const btn = $('clSrSubmit');
  btn.disabled = true;
  clMsg(msg, 'Submitting…', 'muted');
  try {
    const data = await run();
    const r = data.request || data;
    clCloseModal();
    await clLoadServiceRequests();
    await clLoadSrBookings();
    /* The `clSearchCache = null` that used to sit here went with the topbar's
       search box — there is no client-side row cache left to invalidate. */
    clInvalidate('dashboard', 'requests', 'booking-history', 'payments', 'reports');
    clLoadUnreadCount();

    clOpenModal(`${successVerb} — ${r.request_number || ''}`,
      `<p style="margin:0;font-size:12.5px;">
         It has gone to your manager for approval. Once they approve it, the JackPots desk takes it
         from there — there is nothing further for you to do.
       </p>`,
      '<button type="button" class="cl-btn cl-btn-primary" onclick="clCloseModal()">Done</button>');
  } catch (err) {
    clMsg(msg, clError(err, 'Could not submit the request.'), 'err');
    btn.disabled = false;
  }
}

async function clSubmitSrCancellation() {
  const reason = $('clSrCancelRemarks').value.trim();
  if (!reason) return clMsg($('clSrMsg'), 'Enter a reason.', 'err');
  await clSubmitSrRequest(
    () => MerchantApi.requestCancellation(clSrBooking.id, reason), 'Cancellation requested');
}

async function clSubmitSrDateChange() {
  const newDate = $('clSrDcDate').value;
  const reason = $('clSrDcRemarks').value.trim();
  if (!newDate) return clMsg($('clSrMsg'), 'Choose a new travel date.', 'err');
  if (!reason) return clMsg($('clSrMsg'), 'Enter a reason.', 'err');
  const ret = $('clSrDcReturn').value;
  if (ret && ret < newDate) {
    return clMsg($('clSrMsg'), 'The return date cannot be before the new travel date.', 'err');
  }
  await clSubmitSrRequest(
    () => MerchantApi.requestReschedule(clSrBooking.id, {
      newTravelDate: newDate, newReturnDate: ret || null, reason,
    }), 'Reschedule requested');
}

/* The generic hook. `details` is type-specific and passed through untouched —
   the backend stores it on travel_details and the Admin screen renders it. */
function clSubmitGeneric(requestType, remarks, details, successVerb) {
  if (!remarks) return clMsg($('clSrMsg'), 'Enter a reason.', 'err');
  return clSubmitSrRequest(
    () => MerchantApi.createServiceRequest({
      bookingId: clSrBooking.id, requestType, remarks, details,
    }), successVerb);
}

async function clSubmitSrModification() {
  const newValue = $('clSrPmValue').value.trim();
  if (!newValue) return clMsg($('clSrMsg'), 'Enter the new value.', 'err');
  await clSubmitGeneric('passenger_modification', $('clSrPmRemarks').value.trim(), {
    passenger_id: Number($('clSrPmPax').value),
    field: $('clSrPmField').value,
    new_value: newValue,
  }, 'Correction requested');
}

async function clSubmitSrBaggage() {
  const kg = Number($('clSrBagKg').value);
  if (!(kg > 0)) return clMsg($('clSrMsg'), 'Enter how many extra kilograms are needed.', 'err');
  await clSubmitGeneric('extra_baggage', $('clSrBagRemarks').value.trim(), {
    passenger_id: Number($('clSrBagPax').value),
    weight_kg: kg,
  }, 'Extra baggage requested');
}

async function clSubmitSrMeal() {
  await clSubmitGeneric('meal', $('clSrMealRemarks').value.trim(), {
    passenger_id: Number($('clSrMealPax').value),
    meal: $('clSrMealChoice').value,
  }, 'Meal requested');
}

async function clSubmitSrSeat() {
  await clSubmitGeneric('seat', $('clSrSeatRemarks').value.trim(), {
    passenger_id: Number($('clSrSeatPax').value),
    seat_preference: $('clSrSeatChoice').value,
  }, 'Seat requested');
}
