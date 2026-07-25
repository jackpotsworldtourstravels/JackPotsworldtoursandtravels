'use strict';
/* Partner Portal — Ticket Enquiry.
   "Passengers" is filtered client-side against seats_available — the
   underlying stored procedure (sp_get_ticket_enquiry, already approved and
   applied in Phase 2/3) only filters by departure/arrival/date/cabin, so a
   passenger-count filter would need reopening that already-approved SQL;
   this keeps the same UX without touching it. */

function flightDuration(dep, arr) {
  const mins = Math.round((new Date(arr) - new Date(dep)) / 60000);
  if (mins <= 0) return '—';
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function initTicketEnquiry() {
  document.getElementById('teSearchBtn').addEventListener('click', searchTicketEnquiry);
  document.getElementById('teRequestTicketBtn').addEventListener('click', () => navigateToSection('request-ticket'));
  searchTicketEnquiry();
}

async function searchTicketEnquiry() {
  const tbody = document.querySelector('#teTable tbody');
  tbody.innerHTML = rowsSkeleton();
  const params = {
    departure: document.getElementById('teDeparture').value || undefined,
    arrival: document.getElementById('teArrival').value || undefined,
    date: document.getElementById('teDate').value || undefined,
    cabin_class: document.getElementById('teCabin').value || undefined,
  };
  const minPassengers = Number(document.getElementById('tePassengers').value || 1);
  try {
    const { data } = await axios.get(`${API_BASE}/api/partner/ticket-enquiry`, { headers: partnerAuthHeaders(), params });
    const flights = data.filter(f => f.seats_available >= minPassengers);
    tbody.innerHTML = flights.length ? flights.map(f => `
      <tr>
        <td>${escapeHtml(f.airline)}</td>
        <td>${escapeHtml(f.from_airport)}</td>
        <td>${escapeHtml(f.to_airport)}</td>
        <td>${fmtTime(f.departure_time)}</td>
        <td>${fmtTime(f.arrival_time)}</td>
        <td>${flightDuration(f.departure_time, f.arrival_time)}</td>
        <td>${f.seats_available}</td>
        <td>${money(f.price)}</td>
      </tr>
    `).join('') : '<tr><td colspan="8" class="empty-state">No flights match your search.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Failed to load flights.</td></tr>';
  }
}
