'use strict';
/* Partner Portal — Request Ticket.
   "Submit Request" saves a draft (create booking + attach passengers, stays
   in draft status — the partner can come back to it). "Send for Approval"
   finalizes: creates the draft first if one doesn't exist yet this session,
   then transitions it to pending_approval. Both are real, distinct backend
   states (not two buttons doing the same thing) — see sp_create_ticket_request
   vs sp_submit_request_for_approval. */

let rtActiveTab = 'flight';
let rtCountries = [];
let rtCountryOptionsHtml = '';
let rtDraftBookingId = null;
let rtPassengerSeq = 0;

async function initRequestTicket() {
  document.querySelectorAll('[data-rt-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-rt-tab]').forEach(t => t.classList.toggle('active', t === tab));
      rtActiveTab = tab.dataset.rtTab;
      resetRequestTicketForm();
    });
  });
  try {
    const { data } = await axios.get(`${API_BASE}/api/partner/countries`, { headers: partnerAuthHeaders() });
    rtCountries = data;
    rtCountryOptionsHtml = '<option value="">Select…</option>' + data.map(c => `<option value="${c.country_id}">${escapeHtml(c.name)}</option>`).join('');
  } catch (err) { /* country dropdowns just show empty if this fails */ }
  resetRequestTicketForm();
}

function tripFieldsForTab(tab) {
  if (tab === 'flight') return `
    <div class="form-grid">
      <div class="form-field"><label>Airline</label>
        <select id="rtAirline"><option value="">Select…</option>
          <option>IndiGo</option><option>Air India</option><option>Akasa Air</option><option>SpiceJet</option><option>Vistara</option>
        </select>
      </div>
      <div class="form-field"><label>Flight Number</label><input id="rtFlightNumber" placeholder="e.g. F435"></div>
      <div class="form-field"><label>Trip Type</label>
        <select id="rtTripType"><option value="one_way">One Way</option><option value="round_trip">Round Trip</option></select>
      </div>
      <div class="form-field"><label>Cabin</label>
        <select id="rtCabinClass">
          <option value="economy">Economy</option><option value="premium_economy">Premium Economy</option>
          <option value="business">Business</option><option value="first_class">First Class</option>
        </select>
      </div>
      <div class="form-field"><label>Departure</label><input id="rtDeparture" placeholder="City / Airport"></div>
      <div class="form-field"><label>Arrival</label><input id="rtArrival" placeholder="City / Airport"></div>
      <div class="form-field"><label>Departure Date</label><input id="rtDepartureDate" type="date"></div>
      <div class="form-field" id="rtReturnDateField" style="display:none;"><label>Return Date</label><input id="rtReturnDate" type="date"></div>
    </div>`;
  if (tab === 'hotel') return `
    <div class="form-grid">
      <div class="form-field"><label>Hotel / City</label><input id="rtHotelLocation" placeholder="e.g. Goa"></div>
      <div class="form-field"><label>Check-in Date</label><input id="rtDepartureDate" type="date"></div>
      <div class="form-field"><label>Check-out Date</label><input id="rtReturnDate" type="date"></div>
    </div>`;
  return `
    <div class="form-grid">
      <div class="form-field"><label>Departure Port</label><input id="rtDeparture" placeholder="e.g. Mumbai"></div>
      <div class="form-field"><label>Return Port</label><input id="rtArrival" placeholder="e.g. Mumbai"></div>
      <div class="form-field"><label>Departure Date</label><input id="rtDepartureDate" type="date"></div>
      <div class="form-field"><label>Return Date</label><input id="rtReturnDate" type="date"></div>
    </div>`;
}

function resetRequestTicketForm() {
  rtDraftBookingId = null;
  rtPassengerSeq = 0;
  document.getElementById('rtPanel').innerHTML = `
    <h2 style="font-size:15px;margin-bottom:14px;text-transform:capitalize;">${rtActiveTab} details</h2>
    <div id="rtTripFields">${tripFieldsForTab(rtActiveTab)}</div>
    <h2 style="font-size:15px;margin:22px 0 14px;">Passenger details</h2>
    <div id="rtPassengerList"></div>
    <button type="button" class="btn btn-ghost btn-sm" id="rtAddPassengerBtn" style="margin-bottom:18px;">+ Add Passenger</button>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button type="button" class="btn btn-ghost" id="rtSubmitDraftBtn">Submit Request</button>
      <button type="button" class="btn btn-coral" id="rtSendForApprovalBtn">Send for Approval</button>
    </div>
    <div class="msg" id="rtMsg"></div>
  `;
  if (rtActiveTab === 'flight') {
    document.getElementById('rtTripType').addEventListener('change', e => {
      document.getElementById('rtReturnDateField').style.display = e.target.value === 'round_trip' ? 'block' : 'none';
    });
  }
  document.getElementById('rtAddPassengerBtn').addEventListener('click', () => addPassengerCard());
  document.getElementById('rtSubmitDraftBtn').addEventListener('click', () => handleRequestTicketSubmit(false));
  document.getElementById('rtSendForApprovalBtn').addEventListener('click', () => handleRequestTicketSubmit(true));
  addPassengerCard();
}

function addPassengerCard() {
  const n = ++rtPassengerSeq;
  const div = document.createElement('div');
  div.className = 'passenger-card';
  div.dataset.passengerCard = n;
  div.innerHTML = `
    <div class="passenger-card-head">
      <h3>Passenger ${n}</h3>
      <button type="button" class="remove-passenger-btn" data-remove-passenger>Remove</button>
    </div>
    <div class="form-grid">
      <div class="form-field"><label>Full Name</label><input data-field="full_name"></div>
      <div class="form-field"><label>ID Type</label><input value="Passport" disabled></div>
      <div class="form-field"><label>Gender</label><select data-field="gender"><option value="male">Male</option><option value="female">Female</option></select></div>
      <div class="form-field"><label>Passenger Type</label><select data-field="passenger_type"><option value="adult">Adult</option><option value="child">Child</option><option value="infant">Infant</option></select></div>
      <div class="form-field"><label>Passport Issuing Country</label><select data-field="passport_issuing_country_id">${rtCountryOptionsHtml}</select></div>
      <div class="form-field"><label>Passport Number</label><input data-field="passport_number"></div>
      <div class="form-field"><label>Passport Issue Date</label><input type="date" data-field="passport_issue_date"></div>
      <div class="form-field"><label>Passport Expiry Date</label><input type="date" data-field="passport_expiry_date"></div>
      <div class="form-field"><label>Date of Birth</label><input type="date" data-field="date_of_birth"></div>
      <div class="form-field"><label>Nationality</label><select data-field="nationality_country_id">${rtCountryOptionsHtml}</select></div>
      <div class="form-field"><label>Meal Preference</label><input data-field="meal_preference" placeholder="e.g. Vegetarian"></div>
      <div class="form-field"><label>Special Assistance</label><input data-field="special_assistance" placeholder="Optional"></div>
    </div>
  `;
  div.querySelector('[data-remove-passenger]').addEventListener('click', () => {
    if (document.querySelectorAll('.passenger-card').length <= 1) return;
    div.remove();
  });
  document.getElementById('rtPassengerList').appendChild(div);
}

function collectTripPayload() {
  const departureDate = document.getElementById('rtDepartureDate')?.value;
  const returnDate = document.getElementById('rtReturnDate')?.value || null;
  if (rtActiveTab === 'flight') {
    return {
      travel_type: 'flight',
      airline_name: document.getElementById('rtAirline').value || null,
      flight_number: document.getElementById('rtFlightNumber').value || null,
      trip_type: document.getElementById('rtTripType').value,
      cabin_class: document.getElementById('rtCabinClass').value,
      departure: document.getElementById('rtDeparture').value,
      arrival: document.getElementById('rtArrival').value,
      departure_date: departureDate,
      return_date: document.getElementById('rtTripType').value === 'round_trip' ? returnDate : null,
    };
  }
  if (rtActiveTab === 'hotel') {
    const location = document.getElementById('rtHotelLocation').value;
    return { travel_type: 'hotel', departure: location, arrival: location, departure_date: departureDate, return_date: returnDate };
  }
  return {
    travel_type: 'cruise',
    departure: document.getElementById('rtDeparture').value,
    arrival: document.getElementById('rtArrival').value,
    departure_date: departureDate,
    return_date: returnDate,
  };
}

function collectPassengerPayloads() {
  return Array.from(document.querySelectorAll('.passenger-card')).map(card => {
    const get = f => card.querySelector(`[data-field="${f}"]`).value;
    return {
      full_name: get('full_name'), gender: get('gender'), passenger_type: get('passenger_type'),
      passport_issuing_country_id: Number(get('passport_issuing_country_id')),
      passport_number: get('passport_number'), passport_issue_date: get('passport_issue_date'),
      passport_expiry_date: get('passport_expiry_date'), date_of_birth: get('date_of_birth'),
      nationality_country_id: Number(get('nationality_country_id')),
      meal_preference: get('meal_preference') || null, special_assistance: get('special_assistance') || null,
    };
  });
}

async function ensureDraftBooking() {
  if (rtDraftBookingId) return rtDraftBookingId;
  const trip = collectTripPayload();
  if (!trip.departure_date) throw new Error('Enter the travel date.');
  const { data } = await axios.post(`${API_BASE}/api/partner/bookings`, trip, { headers: partnerAuthHeaders() });
  rtDraftBookingId = data.booking_id;
  const passengers = collectPassengerPayloads();
  for (const p of passengers) {
    await axios.post(`${API_BASE}/api/partner/bookings/${rtDraftBookingId}/passengers`, p, { headers: partnerAuthHeaders() });
  }
  return { booking_id: data.booking_id, reference_number: data.reference_number };
}

async function handleRequestTicketSubmit(finalize) {
  const msg = document.getElementById('rtMsg');
  const draftBtn = document.getElementById('rtSubmitDraftBtn');
  const approveBtn = document.getElementById('rtSendForApprovalBtn');
  draftBtn.disabled = true; approveBtn.disabled = true;
  msg.className = 'msg'; msg.textContent = '';
  try {
    const created = await ensureDraftBooking();
    const ref = created?.reference_number;
    if (finalize) {
      await axios.post(`${API_BASE}/api/partner/bookings/${rtDraftBookingId}/submit`, {}, { headers: partnerAuthHeaders() });
      msg.className = 'msg success';
      msg.textContent = `Submitted for approval — reference ${ref || ''}.`.trim();
      loadedSections.delete('request-history');
      setTimeout(() => resetRequestTicketForm(), 1500);
    } else {
      msg.className = 'msg success';
      msg.textContent = `Draft saved — reference ${ref || ''}. Add or edit passengers and click "Send for Approval" when ready.`.trim();
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.response?.data?.detail || err.message || 'Something went wrong.';
  } finally {
    draftBtn.disabled = false; approveBtn.disabled = false;
  }
}
