'use strict';
/* Merchant Portal — Service Request (4 tabs). POST /api/service-requests (API_CONTRACT.md —
   existing, live). One shared endpoint for every type, discriminated by `request_type`, with a
   free-form `details` object per type — there's no per-type endpoint to call. A service
   request can only be raised against a booking that's already confirmed (Approved or later;
   see ticket_service.create_service_request), so this searches Request History's own list
   rather than a dedicated lookup-by-reference endpoint (none exists, and none is needed). */

let srActiveTab = 'cancellation';
let srBooking = null; // RequestResponse (the booking) once found

function initServiceRequest() {
  document.querySelectorAll('[data-sr-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-sr-tab]').forEach(t => t.classList.toggle('active', t === tab));
      srActiveTab = tab.dataset.srTab;
      srBooking = null;
      renderSrPanel();
    });
  });
  renderSrPanel();
}

function renderSrPanel() {
  document.getElementById('srPanel').innerHTML = `
    <div class="form-field" style="max-width:420px;"><label>Request Number, PNR, or Booking Reference</label>
      <div style="display:flex; gap:10px;">
        <input id="srRefInput" placeholder="e.g. REQ-2026-000123" style="flex:1; padding:11px 13px; border-radius:10px; border:1.5px solid var(--border-color);">
        <button type="button" class="btn btn-navy btn-sm" id="srSearchBtn">Search</button>
      </div>
    </div>
    <div class="msg" id="srSearchMsg"></div>
    <div id="srResultArea"></div>
  `;
  document.getElementById('srSearchBtn').addEventListener('click', searchSrReference);
  document.getElementById('srRefInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchSrReference(); });
}

async function searchSrReference() {
  const ref = document.getElementById('srRefInput').value.trim();
  const msg = document.getElementById('srSearchMsg');
  document.getElementById('srResultArea').innerHTML = '';
  if (!ref) return;
  msg.textContent = 'Searching…'; msg.className = 'msg';
  try {
    const { data } = await axios.get(`${API_BASE}/api/requests`, {
      headers: partnerAuthHeaders(), params: { request_type: 'booking', search: ref, page_size: 5 },
    });
    if (!data.items.length) { msg.textContent = 'No booking found for that reference.'; msg.className = 'msg error'; return; }
    srBooking = data.items[0];
    const eligible = ['approved', 'payment_pending', 'paid', 'ticket_issued', 'completed'];
    if (!eligible.includes(srBooking.status)) {
      msg.textContent = `${srBooking.request_number} is ${srBooking.status_label} — service requests can only be raised once a booking is approved.`;
      msg.className = 'msg error';
      srBooking = null;
      return;
    }
    msg.textContent = '';
    renderSrResult();
  } catch (err) {
    msg.textContent = err.response?.data?.detail || 'Search failed.'; msg.className = 'msg error';
  }
}

function renderSrResult() {
  const area = document.getElementById('srResultArea');
  const renderers = { cancellation: cancellationFormHtml, date_change: dateChangeFormHtml, refund: refundFormHtml, passenger_modification: passengerModificationFormHtml };
  area.innerHTML = renderers[srActiveTab]();
  wireSrResultActions();
}

const passengerCheckboxRow = p => `
  <label style="display:flex; align-items:center; gap:9px; padding:9px 0; border-bottom:1px solid var(--border-color); font-size:13.5px;">
    <input type="checkbox" value="${p.id}" data-cancel-passenger style="width:16px;height:16px;">
    ${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}
  </label>`;

function srCard(innerHtml) {
  return `<div style="border:1.5px solid var(--border-color); border-radius:12px; padding:18px; margin-top:16px;">${innerHtml}</div>`;
}
function srReasonField(id, label) {
  return `<div class="form-field" style="max-width:none;"><label>${label || 'Reason'}</label>
    <textarea id="${id}" rows="2" style="width:100%; padding:10px 12px; border-radius:10px; border:1.5px solid var(--border-color); font-family:var(--ff); font-size:14px;"></textarea></div>`;
}
function passengerSelectOptions() {
  return srBooking.passengers.map(p => `<option value="${p.id}">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</option>`).join('');
}

function cancellationFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:8px;">${escapeHtml(srBooking.request_number)} — select passenger(s) to cancel</h3>
    ${srBooking.passengers.map(passengerCheckboxRow).join('') || '<div class="empty-state">No passengers on this booking.</div>'}
    ${srReasonField('srCancelRemarks')}
    <button type="button" class="btn btn-coral" id="srCancelSubmitBtn" style="margin-top:6px;">Submit Cancellation Request</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}
function dateChangeFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:12px;">${escapeHtml(srBooking.request_number)} — change travel date</h3>
    <div class="form-grid">
      <div class="form-field"><label>Passenger</label><select id="srDcPassenger">${passengerSelectOptions()}</select></div>
      <div class="form-field"><label>Old Travel Date</label><input value="${fmtDate(srBooking.travel_date)}" disabled></div>
      <div class="form-field"><label>New Travel Date</label><input type="date" id="srDcNewDate"></div>
    </div>
    ${srReasonField('srDcRemarks')}
    <button type="button" class="btn btn-coral" id="srDcSubmitBtn" style="margin-top:6px;">Submit Date Change</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}
function refundFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:12px;">${escapeHtml(srBooking.request_number)} — request a refund</h3>
    <div class="form-grid">
      <div class="form-field"><label>Amount</label><input type="number" id="srRefundAmount" min="1" step="0.01" value="${srBooking.total_amount ?? ''}"></div>
    </div>
    ${srReasonField('srRefundRemarks')}
    <button type="button" class="btn btn-coral" id="srRefundSubmitBtn" style="margin-top:6px;">Submit Refund Request</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}
function passengerModificationFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:12px;">${escapeHtml(srBooking.request_number)} — passenger modification</h3>
    <div class="form-grid">
      <div class="form-field"><label>Passenger</label><select id="srPmPassenger">${passengerSelectOptions()}</select></div>
      <div class="form-field"><label>Field to Change</label>
        <select id="srPmField"><option value="meal_preference">Meal Preference</option><option value="seat_preference">Seat Preference</option><option value="passport_number">Passport Number</option></select>
      </div>
      <div class="form-field"><label>New Value</label><input id="srPmNewValue"></div>
    </div>
    ${srReasonField('srPmRemarks')}
    <button type="button" class="btn btn-coral" id="srPmSubmitBtn" style="margin-top:6px;">Submit Modification Request</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}

function wireSrResultActions() {
  if (srActiveTab === 'cancellation') document.getElementById('srCancelSubmitBtn').addEventListener('click', submitCancellation);
  else if (srActiveTab === 'date_change') document.getElementById('srDcSubmitBtn').addEventListener('click', submitDateChange);
  else if (srActiveTab === 'refund') document.getElementById('srRefundSubmitBtn').addEventListener('click', submitRefund);
  else document.getElementById('srPmSubmitBtn').addEventListener('click', submitPassengerModification);
}

async function submitServiceRequest(requestType, remarks, details, msgEl) {
  if (!remarks) return setSrMsg(msgEl, 'Enter a reason.', true);
  try {
    const { data } = await axios.post(`${API_BASE}/api/service-requests`, {
      booking_id: srBooking.id, request_type: requestType, remarks, details,
    }, { headers: partnerAuthHeaders() });
    setSrMsg(msgEl, `Submitted — ${data.request.request_number}.`, false);
    loadedSections.delete('request-history');
    loadedSections.delete('dashboard');
  } catch (err) {
    setSrMsg(msgEl, err.response?.data?.detail || 'Failed to submit.', true);
  }
}

async function submitCancellation() {
  const passengerIds = Array.from(document.querySelectorAll('[data-cancel-passenger]:checked')).map(cb => Number(cb.value));
  const msg = document.getElementById('srResultMsg');
  if (!passengerIds.length) return setSrMsg(msg, 'Select at least one passenger.', true);
  if (!confirm(`Cancel ${passengerIds.length} passenger(s) on ${srBooking.request_number}? This cannot be undone.`)) return;
  await submitServiceRequest('cancellation', document.getElementById('srCancelRemarks').value.trim(), { passenger_ids: passengerIds }, msg);
}
async function submitDateChange() {
  const passengerId = Number(document.getElementById('srDcPassenger').value);
  const newDate = document.getElementById('srDcNewDate').value;
  const msg = document.getElementById('srResultMsg');
  if (!newDate) return setSrMsg(msg, 'Choose a new travel date.', true);
  await submitServiceRequest('date_change', document.getElementById('srDcRemarks').value.trim(),
    { passenger_id: passengerId, new_travel_date: newDate }, msg);
}
async function submitRefund() {
  const amount = Number(document.getElementById('srRefundAmount').value);
  const msg = document.getElementById('srResultMsg');
  if (!amount || amount <= 0) return setSrMsg(msg, 'Enter a valid amount.', true);
  await submitServiceRequest('refund', document.getElementById('srRefundRemarks').value.trim(), { amount }, msg);
}
async function submitPassengerModification() {
  const passengerId = Number(document.getElementById('srPmPassenger').value);
  const field = document.getElementById('srPmField').value;
  const newValue = document.getElementById('srPmNewValue').value.trim();
  const msg = document.getElementById('srResultMsg');
  if (!newValue) return setSrMsg(msg, 'Enter the new value.', true);
  await submitServiceRequest('passenger_modification', document.getElementById('srPmRemarks').value.trim(),
    { passenger_id: passengerId, field, new_value: newValue }, msg);
}
function setSrMsg(el, text, isError) { el.textContent = text; el.className = 'msg ' + (isError ? 'error' : 'success'); }
