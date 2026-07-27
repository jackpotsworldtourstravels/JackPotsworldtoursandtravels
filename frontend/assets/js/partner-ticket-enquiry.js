'use strict';
/* Partner Portal — Ticket Enquiry.
   "Passengers" and "Preferred Airline" are filtered client-side — the
   underlying stored procedure (sp_get_ticket_enquiry, already approved and
   applied) only filters by departure/arrival/date/cabin, so filtering here
   keeps the same UX without touching that already-approved SQL.
   Trip Type (Round Trip / Multi City) is a pure search-UX layer: it calls
   the same single-leg search endpoint once per leg and renders one result
   table per leg — no new API, no change to booking creation. */

let teTripType = 'one_way';

function flightDuration(dep, arr) {
  const mins = Math.round((new Date(arr) - new Date(dep)) / 60000);
  if (mins <= 0) return '—';
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function teLegRowHtml(index) {
  return `
    <div class="te-leg-row" data-leg="${index}">
      <input type="text" class="te-leg-departure" placeholder="Departure">
      <input type="text" class="te-leg-arrival" placeholder="Arrival">
      <input type="date" class="te-leg-date" title="Departure date">
      <input type="date" class="te-leg-return-date" title="Return date" style="display:none;">
      ${index > 0 ? '<button type="button" class="te-leg-remove" title="Remove city">✕</button>' : ''}
    </div>`;
}

function setTripType(type) {
  teTripType = type;
  document.querySelectorAll('.te-trip-btn').forEach(b => b.classList.toggle('active', b.dataset.trip === type));
  const container = document.getElementById('teLegsContainer');
  const addRow = document.getElementById('teAddLegBtn').closest('#teAddLegRow');

  if (type === 'multi_city') {
    addRow.style.display = 'block';
    container.querySelectorAll('.te-leg-return-date').forEach(el => el.style.display = 'none');
    if (container.children.length < 2) container.insertAdjacentHTML('beforeend', teLegRowHtml(1));
  } else {
    addRow.style.display = 'none';
    [...container.children].slice(1).forEach(el => el.remove());
    container.querySelector('.te-leg-return-date').style.display = type === 'round_trip' ? 'block' : 'none';
  }
  wireLegRemoveButtons();
}

function wireLegRemoveButtons() {
  document.querySelectorAll('.te-leg-remove').forEach(btn => {
    btn.onclick = () => btn.closest('.te-leg-row').remove();
  });
}

function initTicketEnquiry() {
  document.querySelectorAll('.te-trip-btn').forEach(btn => {
    btn.addEventListener('click', () => setTripType(btn.dataset.trip));
  });
  document.getElementById('teAddLegBtn').addEventListener('click', () => {
    const container = document.getElementById('teLegsContainer');
    if (container.children.length >= 4) return;
    container.insertAdjacentHTML('beforeend', teLegRowHtml(container.children.length));
    wireLegRemoveButtons();
  });
  document.getElementById('teSearchBtn').addEventListener('click', searchTicketEnquiry);
  document.getElementById('teRequestTicketBtn').addEventListener('click', () => navigateToSection('request-ticket'));
  searchTicketEnquiry();
}

async function fetchLeg(departure, arrival, date, cabinClass) {
  const params = { departure: departure || undefined, arrival: arrival || undefined, date: date || undefined, cabin_class: cabinClass || undefined };
  const { data } = await axios.get(`${API_BASE}/api/partner/ticket-enquiry`, { headers: partnerAuthHeaders(), params });
  return data;
}

function renderLegTable(title, flights) {
  const rows = flights.length ? flights.map(f => `
      <tr>
        <td>${escapeHtml(f.airline)}</td>
        <td>${escapeHtml(f.from_airport)}</td>
        <td>${escapeHtml(f.to_airport)}</td>
        <td>${fmtTime(f.departure_time)}</td>
        <td>${fmtTime(f.arrival_time)}</td>
        <td>${flightDuration(f.departure_time, f.arrival_time)}</td>
        <td>${f.seats_available}</td>
        <td>${money(f.price)}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty-state">No flights match this search.</td></tr>';
  return `
    <div class="te-leg-result">
      <h3 class="te-leg-result-title">${escapeHtml(title)}</h3>
      <div class="table-wrap"><table><thead><tr>
        <th>Airline</th><th>Departure</th><th>Arrival</th><th>Dep. Time</th><th>Arr. Time</th><th>Duration</th><th>Seats</th><th>Price</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
}

async function searchTicketEnquiry() {
  const container = document.getElementById('teResultsContainer');
  container.innerHTML = '<div class="skeleton-row"><div class="skeleton-block"></div></div>';

  const minPassengers = Number(document.getElementById('tePassengers').value || 1);
  const cabinClass = document.getElementById('teCabin').value;
  const airlineFilter = document.getElementById('teAirline').value.trim().toLowerCase();
  const applyFilters = flights => flights.filter(f =>
    f.seats_available >= minPassengers && (!airlineFilter || f.airline.toLowerCase().includes(airlineFilter)));

  try {
    const legRows = [...document.querySelectorAll('.te-leg-row')];
    const sections = [];

    for (let i = 0; i < legRows.length; i++) {
      const row = legRows[i];
      const dep = row.querySelector('.te-leg-departure').value;
      const arr = row.querySelector('.te-leg-arrival').value;
      const date = row.querySelector('.te-leg-date').value;
      const label = legRows.length > 1 ? `City ${i + 1}: ${dep || 'Anywhere'} → ${arr || 'Anywhere'}` : 'Outbound Flights';
      const flights = applyFilters(await fetchLeg(dep, arr, date, cabinClass));
      sections.push(renderLegTable(teTripType === 'one_way' ? 'Available Flights' : label, flights));

      if (teTripType === 'round_trip' && i === 0) {
        const returnDate = row.querySelector('.te-leg-return-date').value;
        const returnFlights = applyFilters(await fetchLeg(arr, dep, returnDate, cabinClass));
        sections.push(renderLegTable('Return Flights', returnFlights));
      }
    }
    container.innerHTML = sections.join('');
  } catch (err) {
    container.innerHTML = '<div class="empty-state">Failed to load flights.</div>';
  }
}
