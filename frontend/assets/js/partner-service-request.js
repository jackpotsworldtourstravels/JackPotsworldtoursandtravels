'use strict';
/* Partner Portal — Service Request (4 tabs, all share "search by reference
   number" first). There's no lookup-by-reference-number endpoint, so this
   reuses the Request History data (which already carries booking_id per
   reference) to resolve one, then fetches the full booking + passenger list —
   no new backend endpoint needed for this. */

let srActiveTab = 'cancellation';
let srBooking = null;

const SR_MODIFIABLE_FIELDS = [
  { value: 'full_name', label: 'Full Name' },
  { value: 'passport_number', label: 'Passport Number' },
  { value: 'meal_preference', label: 'Meal Preference' },
  { value: 'special_assistance', label: 'Special Assistance' },
];

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
    <div class="form-field" style="max-width:420px;"><label>Reference Number</label>
      <div style="display:flex; gap:10px;">
        <input id="srRefInput" placeholder="e.g. JP250001" style="flex:1; padding:11px 13px; border-radius:10px; border:1.5px solid var(--border-color);">
        <button type="button" class="btn btn-navy btn-sm" id="srSearchBtn">Search</button>
      </div>
    </div>
    <div class="msg" id="srSearchMsg"></div>
    <div id="srResultArea"></div>
  `;
  document.getElementById('srSearchBtn').addEventListener('click', searchSrReference);
}

async function searchSrReference() {
  const ref = document.getElementById('srRefInput').value.trim();
  const msg = document.getElementById('srSearchMsg');
  document.getElementById('srResultArea').innerHTML = '';
  if (!ref) return;
  msg.textContent = 'Searching…'; msg.className = 'msg';
  try {
    const { data: history } = await axios.get(`${API_BASE}/api/partner/request-history`, { headers: partnerAuthHeaders() });
    const match = history.find(r => r.reference_number.toUpperCase() === ref.toUpperCase());
    if (!match) { msg.textContent = 'No booking found for that reference number.'; msg.className = 'msg error'; return; }
    const { data: booking } = await axios.get(`${API_BASE}/api/partner/bookings/${match.booking_id}`, { headers: partnerAuthHeaders() });
    srBooking = booking;
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
    <input type="checkbox" value="${p.passenger_id}" data-cancel-passenger style="width:16px;height:16px;">
    ${escapeHtml(p.full_name)}
  </label>`;

function srCard(innerHtml) {
  return `<div style="border:1.5px solid var(--border-color); border-radius:12px; padding:18px; margin-top:16px;">${innerHtml}</div>`;
}
function srReasonField(id) {
  return `<div class="form-field" style="max-width:none;"><label>Reason</label>
    <textarea id="${id}" rows="2" style="width:100%; padding:10px 12px; border-radius:10px; border:1.5px solid var(--border-color); font-family:var(--ff); font-size:14px;"></textarea></div>`;
}
function passengerSelectOptions() {
  return srBooking.passengers.map(p => `<option value="${p.passenger_id}">${escapeHtml(p.full_name)}</option>`).join('');
}

function cancellationFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:8px;">Reference ${escapeHtml(srBooking.reference_number)} — select passenger(s) to cancel</h3>
    ${srBooking.passengers.map(passengerCheckboxRow).join('') || '<div class="empty-state">No passengers on this booking.</div>'}
    ${srReasonField('srCancelReason')}
    <button type="button" class="btn btn-coral" id="srCancelSubmitBtn" style="margin-top:6px;">Cancel Selected Passenger(s)</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}
function dateChangeFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:12px;">Reference ${escapeHtml(srBooking.reference_number)} — change travel date</h3>
    <div class="form-grid">
      <div class="form-field"><label>Passenger</label><select id="srDcPassenger">${passengerSelectOptions()}</select></div>
      <div class="form-field"><label>Old Travel Date</label><input value="${fmtDate(srBooking.departure_date)}" disabled></div>
      <div class="form-field"><label>New Travel Date</label><input type="date" id="srDcNewDate"></div>
    </div>
    ${srReasonField('srDcReason')}
    <button type="button" class="btn btn-coral" id="srDcSubmitBtn" style="margin-top:6px;">Submit Date Change</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}
function refundFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:12px;">Reference ${escapeHtml(srBooking.reference_number)} — request a refund</h3>
    <div class="form-grid">
      <div class="form-field"><label>Amount (₹)</label><input type="number" id="srRefundAmount" min="1" step="0.01" value="${srBooking.total_amount ?? ''}"></div>
    </div>
    ${srReasonField('srRefundReason')}
    <button type="button" class="btn btn-coral" id="srRefundSubmitBtn" style="margin-top:6px;">Submit Refund Request</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}
function passengerModificationFormHtml() {
  return srCard(`
    <h3 style="font-size:13.5px; margin-bottom:12px;">Reference ${escapeHtml(srBooking.reference_number)} — passenger modification</h3>
    <div class="form-grid">
      <div class="form-field"><label>Passenger</label><select id="srPmPassenger">${passengerSelectOptions()}</select></div>
      <div class="form-field"><label>Field to Change</label><select id="srPmField">${SR_MODIFIABLE_FIELDS.map(f => `<option value="${f.value}">${f.label}</option>`).join('')}</select></div>
      <div class="form-field"><label>Old Value</label><input id="srPmOldValue" disabled></div>
      <div class="form-field"><label>New Value</label><input id="srPmNewValue"></div>
    </div>
    ${srReasonField('srPmReason')}
    <button type="button" class="btn btn-coral" id="srPmSubmitBtn" style="margin-top:6px;">Submit Modification Request</button>
    <div class="msg" id="srResultMsg"></div>
  `);
}

function wireSrResultActions() {
  if (srActiveTab === 'cancellation') {
    document.getElementById('srCancelSubmitBtn').addEventListener('click', submitCancellation);
  } else if (srActiveTab === 'date_change') {
    document.getElementById('srDcSubmitBtn').addEventListener('click', submitDateChange);
  } else if (srActiveTab === 'refund') {
    document.getElementById('srRefundSubmitBtn').addEventListener('click', submitRefund);
  } else {
    const updateOldValue = () => {
      const passengerId = Number(document.getElementById('srPmPassenger').value);
      const field = document.getElementById('srPmField').value;
      const passenger = srBooking.passengers.find(p => p.passenger_id === passengerId);
      document.getElementById('srPmOldValue').value = passenger?.[field] || '';
    };
    document.getElementById('srPmPassenger').addEventListener('change', updateOldValue);
    document.getElementById('srPmField').addEventListener('change', updateOldValue);
    updateOldValue();
    document.getElementById('srPmSubmitBtn').addEventListener('click', submitPassengerModification);
  }
}

async function submitCancellation() {
  const passengerIds = Array.from(document.querySelectorAll('[data-cancel-passenger]:checked')).map(cb => Number(cb.value));
  const reason = document.getElementById('srCancelReason').value.trim();
  const msg = document.getElementById('srResultMsg');
  if (!passengerIds.length) return setSrMsg(msg, 'Select at least one passenger.', true);
  if (!reason) return setSrMsg(msg, 'Enter a reason.', true);
  if (!confirm(`Cancel ${passengerIds.length} passenger(s) on ${srBooking.reference_number}? This cannot be undone.`)) return;
  try {
    const { data } = await axios.post(`${API_BASE}/api/partner/service-requests/cancellation`,
      { reference_number: srBooking.reference_number, passenger_ids: passengerIds, reason }, { headers: partnerAuthHeaders() });
    setSrMsg(msg, `Cancellation submitted — ${data.service_request_number}.`, false);
    loadedSections.delete('request-history');
  } catch (err) { setSrMsg(msg, err.response?.data?.detail || 'Failed to submit.', true); }
}
async function submitDateChange() {
  const passengerId = Number(document.getElementById('srDcPassenger').value);
  const newDate = document.getElementById('srDcNewDate').value;
  const reason = document.getElementById('srDcReason').value.trim();
  const msg = document.getElementById('srResultMsg');
  if (!newDate) return setSrMsg(msg, 'Choose a new travel date.', true);
  if (!reason) return setSrMsg(msg, 'Enter a reason.', true);
  try {
    const { data } = await axios.post(`${API_BASE}/api/partner/service-requests/date-change`,
      { reference_number: srBooking.reference_number, passenger_id: passengerId, new_travel_date: newDate, reason }, { headers: partnerAuthHeaders() });
    setSrMsg(msg, `Date change submitted — ${data.service_request_number}.`, false);
    loadedSections.delete('request-history');
  } catch (err) { setSrMsg(msg, err.response?.data?.detail || 'Failed to submit.', true); }
}
async function submitRefund() {
  const amount = Number(document.getElementById('srRefundAmount').value);
  const reason = document.getElementById('srRefundReason').value.trim();
  const msg = document.getElementById('srResultMsg');
  if (!amount || amount <= 0) return setSrMsg(msg, 'Enter a valid amount.', true);
  if (!reason) return setSrMsg(msg, 'Enter a reason.', true);
  try {
    const { data } = await axios.post(`${API_BASE}/api/partner/service-requests/refund`,
      { reference_number: srBooking.reference_number, amount, reason }, { headers: partnerAuthHeaders() });
    setSrMsg(msg, `Refund request submitted — ${data.service_request_number}.`, false);
    loadedSections.delete('request-history');
  } catch (err) { setSrMsg(msg, err.response?.data?.detail || 'Failed to submit.', true); }
}
async function submitPassengerModification() {
  const passengerId = Number(document.getElementById('srPmPassenger').value);
  const field = document.getElementById('srPmField').value;
  const oldValue = document.getElementById('srPmOldValue').value;
  const newValue = document.getElementById('srPmNewValue').value.trim();
  const reason = document.getElementById('srPmReason').value.trim();
  const msg = document.getElementById('srResultMsg');
  if (!newValue) return setSrMsg(msg, 'Enter the new value.', true);
  if (!reason) return setSrMsg(msg, 'Enter a reason.', true);
  try {
    const { data } = await axios.post(`${API_BASE}/api/partner/service-requests/passenger-modification`, {
      reference_number: srBooking.reference_number, passenger_id: passengerId,
      field_changed: field, old_value: oldValue || null, new_value: newValue, reason,
    }, { headers: partnerAuthHeaders() });
    setSrMsg(msg, `Modification request submitted — ${data.service_request_number}.`, false);
    loadedSections.delete('request-history');
  } catch (err) { setSrMsg(msg, err.response?.data?.detail || 'Failed to submit.', true); }
}
function setSrMsg(el, text, isError) { el.textContent = text; el.className = 'msg ' + (isError ? 'error' : 'success'); }
