'use strict';
/* Merchant Portal — Request Ticket.
   Books exactly one catalog item (real fare + inventory), priced server-side — there is no
   free-form "type in your own flight" request. The flow is:
     Ticket Enquiry -> "Request This" -> Passenger Details (here) -> Save Draft / Submit
   "Save Draft" calls POST /api/requests (creates the request at Created/draft, holds nothing).
   "Submit for Approval" does the same, then immediately POST /api/requests/{id}/submit
   (Created -> Pending, reserves seats). Both are the existing, live ticket lifecycle
   endpoints — see docs/API_CONTRACT.md §2. */

let rtQuote = null;        // QuoteResponse for the selected catalog item
let rtPassengerCount = 1;
let rtPassengerSeq = 0;

const RT_SEAT_PREFS = [
  { value: '', label: 'No preference' },
  { value: 'window', label: 'Window' }, { value: 'aisle', label: 'Aisle' }, { value: 'middle', label: 'Middle' },
  { value: 'front_row', label: 'Front Row' }, { value: 'exit_row', label: 'Exit Row' },
];

function initRequestTicket() {
  renderRequestTicketPanel();
}

/* Called from partner-ticket-enquiry.js when the merchant picks a search result. Marks the
   section pre-loaded so navigateToSection's lazy loader doesn't call initRequestTicket() again
   and overwrite this with the empty-state prompt. */
function startRequestTicket(quote, passengers) {
  rtQuote = quote;
  rtPassengerCount = passengers;
  rtPassengerSeq = 0;
  loadedSections.add('request-ticket');
  renderRequestTicketPanel();
}

function rtItemSummaryHtml() {
  const item = rtQuote.item;
  const d = item.details || {};
  const line = item.travel_type === 'flight'
    ? `${escapeHtml(d.airline || '')} ${escapeHtml(d.flight_number || '')} · ${escapeHtml(d.origin_city || '')} → ${escapeHtml(d.destination_city || '')}`
    : escapeHtml(item.title || '');
  return `
    <div class="panel" style="margin-bottom:18px;">
      <div class="panel-head"><h2>${line}</h2></div>
      <div class="info-grid">
        <div class="info-item"><label>Travel Date</label><div>${item.travel_date ? fmtDate(item.travel_date) : '—'}</div></div>
        <div class="info-item"><label>Passengers</label><div>${rtQuote.passengers}</div></div>
        <div class="info-item"><label>Base Fare (per pax)</label><div>${money(rtQuote.base_fare)}</div></div>
        <div class="info-item"><label>Taxes (per pax)</label><div>${money(rtQuote.taxes)}</div></div>
        <div class="info-item"><label>Per Passenger</label><div>${money(rtQuote.per_passenger)}</div></div>
        <div class="info-item"><label>Total</label><div style="font-weight:800;">${money(rtQuote.total)}</div></div>
      </div>
    </div>`;
}

function renderRequestTicketPanel() {
  const wrap = document.getElementById('rtPanelWrap');
  if (!rtQuote) {
    wrap.innerHTML = `
      <div class="empty-state">
        No fare selected yet. Go to <strong>Ticket Enquiry</strong>, search, and click
        <strong>"Request This"</strong> on an option to start a request.
      </div>
      <div style="text-align:center; margin-top:14px;">
        <button type="button" class="btn btn-navy" id="rtGoToEnquiryBtn">Go to Ticket Enquiry</button>
      </div>`;
    document.getElementById('rtGoToEnquiryBtn').addEventListener('click', () => navigateToSection('ticket-enquiry'));
    return;
  }

  wrap.innerHTML = `
    ${rtItemSummaryHtml()}
    <div class="panel">
      <div class="panel-head"><h2>Passenger Details</h2></div>
      <div id="rtPassengerList"></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;">
        <button type="button" class="btn btn-ghost" id="rtSubmitDraftBtn">Save Draft</button>
        <button type="button" class="btn btn-coral" id="rtSendForApprovalBtn">Submit for Approval</button>
        <button type="button" class="btn btn-ghost" id="rtCancelSelectionBtn">Cancel</button>
      </div>
      <div class="msg" id="rtMsg"></div>
    </div>`;

  rtPassengerSeq = 0;
  document.getElementById('rtPassengerList').innerHTML = '';
  for (let i = 0; i < rtPassengerCount; i++) addPassengerCard();

  document.getElementById('rtSubmitDraftBtn').addEventListener('click', () => handleRequestTicketSubmit(false));
  document.getElementById('rtSendForApprovalBtn').addEventListener('click', () => handleRequestTicketSubmit(true));
  document.getElementById('rtCancelSelectionBtn').addEventListener('click', () => {
    rtQuote = null;
    renderRequestTicketPanel();
  });
}

function addPassengerCard() {
  const n = ++rtPassengerSeq;
  const div = document.createElement('div');
  div.className = 'passenger-card';
  div.dataset.passengerCard = n;
  div.innerHTML = `
    <div class="passenger-card-head"><h3>Passenger ${n}</h3></div>
    <div class="form-grid">
      <div class="form-field"><label>Title</label>
        <select data-field="title"><option value="">—</option><option>Mr</option><option>Mrs</option><option>Ms</option><option>Master</option></select>
      </div>
      <div class="form-field"><label>First Name</label><input data-field="first_name" required></div>
      <div class="form-field"><label>Last Name</label><input data-field="last_name" required></div>
      <div class="form-field"><label>Gender</label><select data-field="gender"><option value="">—</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></div>
      <div class="form-field"><label>Date of Birth</label><input type="date" data-field="dob"></div>
      <div class="form-field"><label>Passenger Type</label><select data-field="passenger_type"><option value="adult">Adult</option><option value="child">Child</option><option value="infant">Infant</option></select></div>
      <div class="form-field"><label>Nationality</label><input data-field="nationality" placeholder="e.g. Indian"></div>
      <div class="form-field"><label>Passport Number</label><input data-field="passport_number"></div>
      <div class="form-field"><label>Passport Issuing Country</label><input data-field="passport_issue_country"></div>
      <div class="form-field"><label>Passport Issue Date</label><input type="date" data-field="passport_issue_date"></div>
      <div class="form-field"><label>Passport Expiry Date</label><input type="date" data-field="passport_expiry"></div>
      <div class="form-field"><label>Seat Preference</label>
        <select data-field="seat_preference">${RT_SEAT_PREFS.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}</select>
      </div>
      <div class="form-field"><label>Meal Preference</label><input data-field="meal_preference" placeholder="e.g. Vegetarian"></div>
    </div>
  `;
  document.getElementById('rtPassengerList').appendChild(div);
}

function collectPassengerPayloads() {
  return Array.from(document.querySelectorAll('#rtPassengerList .passenger-card')).map(card => {
    const get = f => card.querySelector(`[data-field="${f}"]`)?.value || null;
    return {
      title: get('title') || undefined,
      first_name: get('first_name'),
      last_name: get('last_name'),
      gender: get('gender') || undefined,
      dob: get('dob') || undefined,
      passenger_type: get('passenger_type') || 'adult',
      nationality: get('nationality') || undefined,
      passport_number: get('passport_number') || undefined,
      passport_issue_country: get('passport_issue_country') || undefined,
      passport_issue_date: get('passport_issue_date') || undefined,
      passport_expiry: get('passport_expiry') || undefined,
      seat_preference: get('seat_preference') || undefined,
      meal_preference: get('meal_preference') || undefined,
      special_services: [],
    };
  });
}

async function handleRequestTicketSubmit(finalize) {
  const msg = document.getElementById('rtMsg');
  const draftBtn = document.getElementById('rtSubmitDraftBtn');
  const approveBtn = document.getElementById('rtSendForApprovalBtn');
  const passengers = collectPassengerPayloads();

  if (passengers.some(p => !p.first_name || !p.last_name)) {
    msg.className = 'msg error';
    msg.textContent = 'Enter first and last name for every passenger.';
    return;
  }

  draftBtn.disabled = true; approveBtn.disabled = true;
  msg.className = 'msg'; msg.textContent = '';
  try {
    const { data: created } = await axios.post(`${API_BASE}/api/requests`, {
      catalog_item_id: rtQuote.item.id,
      passengers,
      travel_date: rtQuote.item.travel_date || undefined,
    }, { headers: partnerAuthHeaders() });

    if (finalize) {
      await axios.post(`${API_BASE}/api/requests/${created.request.id}/submit`, {}, { headers: partnerAuthHeaders() });
      msg.className = 'msg success';
      msg.textContent = `Submitted for approval — ${created.request.request_number}.`;
      loadedSections.delete('request-history');
      loadedSections.delete('dashboard');
      setTimeout(() => { rtQuote = null; renderRequestTicketPanel(); }, 1500);
    } else {
      msg.className = 'msg success';
      msg.textContent = `Draft saved — ${created.request.request_number}. Go to Request History to submit it later.`;
      loadedSections.delete('request-history');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || 'Something went wrong.';
  } finally {
    draftBtn.disabled = false; approveBtn.disabled = false;
  }
}
