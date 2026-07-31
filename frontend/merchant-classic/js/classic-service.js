'use strict';
/* Classic — Service Requests: post-booking changes against an existing booking.
   ===========================================================================
   TWO DIFFERENT BACKENDS BEHIND FOUR TABS, on purpose.

   Cancellation and Date change go through the M3 cancellation/reschedule
   endpoints:

     POST /api/bookings/{id}/cancellation   { reason }
     POST /api/bookings/{id}/reschedule     { new_travel_date, new_return_date, reason }

   Those two settle money and change the booking itself — an approved
   cancellation really cancels it, an approved reschedule really moves its
   dates. The generic POST /api/service-requests hook does neither: approving a
   generic 'cancellation' recorded an intention and left the booking exactly as
   it was, which is why these two moved off it.

   Refund and Passenger correction still use the generic hook, unchanged:

     refund                 { amount }
     passenger_modification { passenger_id, field, new_value }

   WHAT CHANGED FOR THE MERCHANT
   Cancellation is now whole-booking. The old screen offered per-passenger
   tick-boxes, but nothing downstream ever read them — no passenger was
   cancelled and no refund was computed. Partial cancellation is a real feature
   and is not pretended at here; a merchant who needs one passenger removed
   raises a passenger correction and our desk handles it.

   NO AMOUNTS ARE ENTERED HERE. The cancellation charge and the fare difference
   are the airline's, quoted by our team when they settle the request. A
   pending request deliberately shows no figures rather than a guess. */

const CL_SR_ELIGIBLE = ['approved', 'payment_pending', 'paid', 'ticket_issued', 'ticketed', 'completed'];

/* The M3 endpoints refuse a completed booking — the trip has happened. The
   generic hook still accepts one (a refund claim after travel is legitimate),
   so the narrower list applies only to the two settling tabs. */
const CL_CHANGE_ELIGIBLE = ['approved', 'payment_pending', 'paid', 'ticket_issued', 'ticketed'];

const CL_SR_TABS = [
  { id: 'cancellation', label: 'Cancellation' },
  { id: 'date_change', label: 'Date change' },
  { id: 'refund', label: 'Refund' },
  { id: 'passenger_modification', label: 'Passenger correction' },
];

let clSrBooking = null;
let clSrTab = 'cancellation';
let clSrBookings = [];

function clInitServiceRequest() {
  $('cl-service-request').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Service Requests</h1>
        <p>Amend a booking after it has been approved. Each request is tracked against the booking.</p>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Cancellation &amp; reschedule requests</h2>
        <span class="cl-kpi-sub" id="clCrCounts"></span>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Request no.</th><th>Type</th><th>Booking</th><th>Status</th>
              <th class="cl-num">Amount</th><th>Raised</th><th class="cl-actions">Action</th>
            </tr></thead>
            <tbody id="clCrList"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-panel-note">
        <b>Amount</b> is the refund due on an approved cancellation, or the amount payable on an
        approved reschedule. It is blank until our team settles the request — the charge is the
        airline's and is confirmed by us, never estimated here. A request can be withdrawn only
        while it is still <b>Pending</b>; once an operator has started work, ask them to reject it.
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>1. Choose the booking</h2></div>
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
        Only bookings that are approved or beyond can be amended. Drafts and
        requests still awaiting approval are not listed.
      </div>
    </div>

    <div id="clSrFormArea"></div>`;

  return Promise.all([clLoadSrBookings(), clLoadChangeRequests()]);
}

/* ------------------------------------------- cancellation & reschedule list */

async function clLoadChangeRequests() {
  const body = $('clCrList');
  if (!body) return;
  body.innerHTML = clLoadingRow(7, 'Loading your change requests…');
  try {
    const [page, counts] = await Promise.all([
      MerchantApi.listChangeRequests({ page_size: 50 }),
      MerchantApi.changeRequestCounts(),
    ]);
    const rows = page.items || [];

    const badge = $('clCrCounts');
    if (badge) {
      badge.textContent = counts.total
        ? `${counts.open} awaiting our team · ${counts.total} in total`
        : '';
    }

    body.innerHTML = rows.length
      ? rows.map(r => `<tr>
          <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
          <td>${escapeHtml(r.change_type_label || '—')}</td>
          <td class="cl-ref">${escapeHtml(r.booking_request_number || '—')}</td>
          <td>${clCrTag(r.status)}</td>
          <td class="cl-num">${clCrAmount(r)}</td>
          <td class="cl-nowrap">${escapeHtml(fmtDate(r.created_at))}</td>
          <td class="cl-actions">${
            r.status === 'pending_approval'
              ? `<button type="button" class="cl-btn cl-btn-sm" data-cl-cr-withdraw="${r.id}"
                         data-cl-cr-ref="${escapeHtml(r.request_number || '')}">Withdraw</button>`
              : '<span class="cl-muted">—</span>'
          }</td>
        </tr>${clCrDetailRow(r)}`).join('')
      : clEmptyRow(7, 'No cancellation or reschedule requests yet.');

    body.querySelectorAll('[data-cl-cr-withdraw]').forEach(b =>
      b.addEventListener('click', () => clWithdrawChangeRequest(b.dataset.clCrWithdraw, b.dataset.clCrRef)));
  } catch (err) {
    body.innerHTML = clEmptyRow(7, clError(err, 'Failed to load change requests.'));
  }
}

/* `cancelled` on a change request means the merchant took it back, not that
   anything was cancelled — on this screen, where half the rows *are*
   cancellation requests, "Cancelled" is actively confusing. Matches the wording
   the Admin portal uses for the same status. */
function clCrTag(status) {
  if (status !== 'cancelled') return clTag(status);
  // Bare .cl-tag — the neutral tone. A withdrawal is neither a success nor a
  // failure, so it takes no colour.
  return '<span class="cl-tag">Withdrawn</span>';
}

/* Blank rather than 0.00 while pending: a zero here would read as "nothing to
   refund", which is a different statement from "not priced yet". */
function clCrAmount(r) {
  const priced = r.pricing && Object.keys(r.pricing).length;
  if (!priced) return '<span class="cl-muted">—</span>';
  return money(r.amount);
}

/* A second row carrying the detail that does not fit the columns: what the
   merchant asked for, and what the desk decided. */
function clCrDetailRow(r) {
  const p = r.pricing || {};
  const bits = [];

  if (r.change_type === 'date_change' && r.new_travel_date) {
    bits.push(`${escapeHtml(fmtDate(r.current_travel_date))} → <b>${escapeHtml(fmtDate(r.new_travel_date))}</b>`);
  }
  if (p.kind === 'cancellation') {
    bits.push(`Cancellation charge ${money(p.cancellation_charge)}`);
    bits.push(`Refund due <b>${money(p.refund_amount)}</b>`);
  } else if (p.kind === 'reschedule') {
    bits.push(`Fare difference ${money(p.fare_difference)}`);
    bits.push(`Change fee ${money(p.change_fee)}`);
    bits.push(`Payable <b>${money(p.total_payable)}</b>`);
  }
  if (r.status === 'rejected' && r.rejection_reason) {
    bits.push(`Not approved: ${escapeHtml(r.rejection_reason)}`);
  } else if (r.reason) {
    bits.push(`Reason: ${escapeHtml(r.reason)}`);
  }

  if (!bits.length) return '';
  return `<tr class="cl-subrow"><td colspan="7" class="cl-kpi-sub">${bits.join(' &nbsp;·&nbsp; ')}</td></tr>`;
}

async function clWithdrawChangeRequest(id, ref) {
  if (!await clConfirm(`Withdraw ${ref}? The booking is left exactly as it is.`, 'Withdraw request')) return;
  try {
    await MerchantApi.withdrawChangeRequest(id);
    await clLoadChangeRequests();
    clInvalidate('dashboard', 'requests');
  } catch (err) {
    const body = $('clCrList');
    if (body) body.insertAdjacentHTML('afterbegin',
      `<tr><td colspan="7"><div class="cl-msg cl-msg-err" style="margin:0">${escapeHtml(clError(err, 'Could not withdraw the request.'))}</div></td></tr>`);
  }
}

async function clLoadSrBookings() {
  const body = $('clSrBookings');
  body.innerHTML = clLoadingRow(6, 'Loading eligible bookings…');
  try {
    const data = await MerchantApi.listRequests({ request_type: 'booking', page_size: 100 });
    clSrBookings = (data.items || []).filter(r => CL_SR_ELIGIBLE.includes(r.status));

    body.innerHTML = clSrBookings.length
      ? clSrBookings.map(r => `<tr data-cl-sr-row="${r.id}">
          <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
          <td>${escapeHtml(r.title || '—')}</td>
          <td>${clTag(r.status)}</td>
          <td class="cl-num">${money(r.total_amount)}</td>
          <td class="cl-nowrap">${escapeHtml(fmtDate(r.travel_date))}</td>
          <td class="cl-actions">
            <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-sr-pick="${r.id}">Select</button>
          </td>
        </tr>`).join('')
      : clEmptyRow(6, 'No approved bookings yet — a booking can only be amended once our team has approved it.');

    body.querySelectorAll('[data-cl-sr-pick]').forEach(b =>
      b.addEventListener('click', () => clPickSrBooking(b.dataset.clSrPick)));
  } catch (err) {
    body.innerHTML = clEmptyRow(6, clError(err, 'Failed to load bookings.'));
  }
}

/* The list row carries a summary; the passenger list needed by three of the
   four forms only comes back on the detail endpoint, so fetch it on select. */
async function clPickSrBooking(id) {
  const area = $('clSrFormArea');
  area.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
    <span class="cl-spin"></span> Loading booking…</div></div>`;

  $('clSrBookings').querySelectorAll('[data-cl-sr-row]').forEach(tr =>
    tr.classList.toggle('cl-selected', tr.dataset.clSrRow === String(id)));

  try {
    const data = await MerchantApi.getRequest(id);
    const r = data.request || data;
    clSrBooking = { ...r, passengers: r.passengers || data.passengers || [] };
    clRenderSrForm();
  } catch (err) {
    area.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
      <div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Could not load the booking.'))}</div>
    </div></div>`;
  }
}

function clRenderSrForm() {
  const b = clSrBooking;
  const pax = b.passengers || [];

  $('clSrFormArea').innerHTML = `
    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>2. Raise a service request — ${escapeHtml(b.request_number || '')}</h2>
      </div>
      <div class="cl-panel-body">
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
        <div class="cl-msg" id="clSrMsg"></div>
      </div>
    </div>`;

  $('clSrTabs').querySelectorAll('[data-cl-sr-tab]').forEach(t =>
    t.addEventListener('click', () => { clSrTab = t.dataset.clSrTab; clRenderSrForm(); }));

  clRenderSrTabBody(pax);
}

function clPaxName(p, i) {
  return `${i + 1}. ${[p.title, p.first_name, p.last_name].filter(Boolean).join(' ') || 'Passenger'}`;
}
function clPaxOptions(pax) {
  return pax.map((p, i) => `<option value="${p.id}">${escapeHtml(clPaxName(p, i))}</option>`).join('');
}

function clRenderSrTabBody(pax) {
  const body = $('clSrTabBody');

  // Only the two per-passenger forms need passenger records. Cancellation is
  // whole-booking and reschedule moves the itinerary, so neither does.
  if (!pax.length && clSrTab === 'passenger_modification') {
    body.innerHTML = `<div class="cl-msg cl-msg-info" style="margin-top:0">
      This booking has no passenger records, so there is nothing to correct.</div>`;
    return;
  }

  if (clSrTab === 'cancellation') {
    if (!clChangeEligible()) { body.innerHTML = clChangeIneligibleNote('cancelled'); return; }
    body.innerHTML = `
      <div class="cl-msg cl-msg-info" style="margin-top:0">
        This cancels <b>the whole booking</b> — all ${pax.length || 0} passenger(s) and both legs.
        Nothing is cancelled until our team approves it, and they will confirm the airline's
        cancellation charge and the refund due at that point.
      </div>
      <div class="cl-field cl-field-full">
        <label for="clSrCancelRemarks">Reason<span class="cl-req">*</span></label>
        <textarea id="clSrCancelRemarks" placeholder="Why is this being cancelled?"></textarea>
      </div>
      <div class="cl-form-actions">
        <button type="button" class="cl-btn cl-btn-danger" id="clSrSubmit">Request cancellation</button>
        <span class="cl-kpi-sub">To remove one passenger only, raise a passenger correction instead.</span>
      </div>`;
    $('clSrSubmit').addEventListener('click', clSubmitSrCancellation);

  } else if (clSrTab === 'date_change') {
    if (!clChangeEligible()) { body.innerHTML = clChangeIneligibleNote('rescheduled'); return; }
    // min = tomorrow: the server refuses today or earlier, so the picker should
    // not offer what would come back as a 400.
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
      <div class="cl-form-actions">
        <button type="button" class="cl-btn cl-btn-primary" id="clSrSubmit">Request reschedule</button>
        <span class="cl-kpi-sub">
          Currently departing ${escapeHtml(fmtDate(clSrBooking.travel_date))}. The booking is not
          moved until our team approves; fare difference and change fee are confirmed by them.
        </span>
      </div>`;
    $('clSrSubmit').addEventListener('click', clSubmitSrDateChange);

  } else if (clSrTab === 'refund') {
    body.innerHTML = `
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clSrRefundAmount">Refund amount (₹)<span class="cl-req">*</span></label>
          <input type="number" id="clSrRefundAmount" min="1" step="0.01"
                 placeholder="Up to ${escapeHtml(String(Math.round(Number(clSrBooking.total_amount) || 0)))}">
        </div>
        <div class="cl-field cl-field-full">
          <label for="clSrRefundRemarks">Reason<span class="cl-req">*</span></label>
          <textarea id="clSrRefundRemarks" placeholder="Why is a refund being claimed?"></textarea>
        </div>
      </div>
      <div class="cl-form-actions">
        <button type="button" class="cl-btn cl-btn-primary" id="clSrSubmit">Request refund</button>
        <span class="cl-kpi-sub">The amount claimed is reviewed — it is not credited automatically.</span>
      </div>`;
    $('clSrSubmit').addEventListener('click', clSubmitSrRefund);

  } else {
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
            <option value="seat_preference">Seat preference</option>
            <option value="meal_preference">Meal preference</option>
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
      <div class="cl-form-actions">
        <button type="button" class="cl-btn cl-btn-primary" id="clSrSubmit">Request correction</button>
        <span class="cl-kpi-sub">Name corrections may attract an airline fee.</span>
      </div>`;
    $('clSrSubmit').addEventListener('click', clSubmitSrModification);
  }
}

/* ---------------------------------------------------------------- submits */

async function clSubmitSr(requestType, remarks, details) {
  const msg = $('clSrMsg');
  if (!remarks) return clMsg(msg, 'Enter a reason.', 'err');

  const btn = $('clSrSubmit');
  btn.disabled = true;
  clMsg(msg, 'Submitting…', 'muted');
  try {
    const data = await MerchantApi.createServiceRequest({
      bookingId: clSrBooking.id, requestType, remarks, details,
    });
    clMsg(msg, `Submitted — ${data.request.request_number}. Track it in My Requests.`, 'ok');
    clInvalidate('dashboard', 'requests', 'payments', 'reports');
    clSearchCache = null;
  } catch (err) {
    clMsg(msg, clError(err, 'Could not submit the service request.'), 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------- cancellation & reschedule (M3 endpoints) */

function clChangeEligible() {
  return clSrBooking && CL_CHANGE_ELIGIBLE.includes(clSrBooking.status);
}

function clChangeIneligibleNote(verb) {
  return `<div class="cl-msg cl-msg-info" style="margin-top:0">
    ${escapeHtml(clSrBooking.request_number || 'This booking')} is
    ${clTag(clSrBooking.status)} and cannot be ${escapeHtml(verb)}.
    A booking that has already been completed has travelled; raise a refund claim instead.
  </div>`;
}

/* Shared tail for the two settling tabs: same success/failure handling as
   clSubmitSr, but a different endpoint and no `details` envelope. */
async function clSubmitChange(run, successVerb) {
  const msg = $('clSrMsg');
  const btn = $('clSrSubmit');
  btn.disabled = true;
  clMsg(msg, 'Submitting…', 'muted');
  try {
    const data = await run();
    const r = data.request || data;
    clMsg(msg, `${successVerb} — ${r.request_number}. Our team will confirm the amounts.`, 'ok');
    await clLoadChangeRequests();
    clInvalidate('dashboard', 'requests', 'payments', 'reports');
    clSearchCache = null;
  } catch (err) {
    clMsg(msg, clError(err, 'Could not submit the request.'), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function clSubmitSrCancellation() {
  const reason = $('clSrCancelRemarks').value.trim();
  if (!reason) return clMsg($('clSrMsg'), 'Enter a reason.', 'err');
  if (!await clConfirm(
    `Request cancellation of the whole of ${clSrBooking.request_number}?`, 'Request cancellation')) return;
  await clSubmitChange(
    () => MerchantApi.requestCancellation(clSrBooking.id, reason), 'Cancellation requested');
}

async function clSubmitSrDateChange() {
  const newDate = $('clSrDcDate').value;
  const reason = $('clSrDcRemarks').value.trim();
  if (!newDate) return clMsg($('clSrMsg'), 'Choose a new travel date.', 'err');
  if (!reason) return clMsg($('clSrMsg'), 'Enter a reason.', 'err');
  const ret = $('clSrDcReturn').value;
  if (ret && ret < newDate) return clMsg($('clSrMsg'), 'The return date cannot be before the new travel date.', 'err');
  await clSubmitChange(
    () => MerchantApi.requestReschedule(clSrBooking.id, {
      newTravelDate: newDate, newReturnDate: ret || null, reason,
    }), 'Reschedule requested');
}

async function clSubmitSrRefund() {
  const amount = Number($('clSrRefundAmount').value);
  if (!(amount > 0)) return clMsg($('clSrMsg'), 'Enter a valid amount.', 'err');
  await clSubmitSr('refund', $('clSrRefundRemarks').value.trim(), { amount });
}

async function clSubmitSrModification() {
  const newValue = $('clSrPmValue').value.trim();
  if (!newValue) return clMsg($('clSrMsg'), 'Enter the new value.', 'err');
  await clSubmitSr('passenger_modification', $('clSrPmRemarks').value.trim(), {
    passenger_id: Number($('clSrPmPax').value),
    field: $('clSrPmField').value,
    new_value: newValue,
  });
}
