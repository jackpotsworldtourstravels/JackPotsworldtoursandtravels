'use strict';
/* Merchant Portal — Ticket Enquiry. GET /api/catalog/search (API_CONTRACT.md — existing, live).
   Inventory is real catalog items (flights/hotels/cruises), each with a fixed fare and seat
   count — there is no free-form "type in any flight" search, and no multi-city/round-trip
   itinerary concept server-side (a request books exactly one catalog item), so this is a
   single search against one travel type at a time, not the old per-leg flight search UI. */

let teTravelType = 'flight';

function setTeTravelType(type) {
  teTravelType = type;
  document.querySelectorAll('#teTravelType .te-trip-btn').forEach(b => b.classList.toggle('active', b.dataset.travelType === type));
  const flightOnly = type === 'flight';
  document.getElementById('teCabin').style.display = flightOnly ? '' : 'none';
  document.getElementById('teAirline').style.display = flightOnly ? '' : 'none';
  document.getElementById('teResultsContainer').innerHTML = '';
}

function initTicketEnquiry() {
  document.querySelectorAll('#teTravelType .te-trip-btn').forEach(btn => {
    btn.addEventListener('click', () => setTeTravelType(btn.dataset.travelType));
  });
  document.getElementById('teSearchBtn').addEventListener('click', searchTicketEnquiry);
  setTeTravelType('flight');
  searchTicketEnquiry();
}

function teDetailLine(item) {
  const d = item.details || {};
  if (item.travel_type === 'flight') {
    return `${escapeHtml(d.airline || '')} ${escapeHtml(d.flight_number || '')} · ${escapeHtml(d.origin_city || d.origin || '')} → ${escapeHtml(d.destination_city || d.destination || '')}`;
  }
  if (item.travel_type === 'hotel') {
    return `${escapeHtml(d.hotel_name || item.title || '')} · ${escapeHtml(d.room_type || '')} · ${escapeHtml(d.destination_city || d.destination || '')}`;
  }
  return `${escapeHtml(d.cruise_line || '')} ${escapeHtml(d.cruise_name || '')} · ${escapeHtml(d.origin_city || d.origin || '')} → ${escapeHtml(d.destination_city || d.destination || '')}`;
}

function teMetaChips(item) {
  const d = item.details || {};
  const chips = [];
  if (item.travel_type === 'flight') {
    if (d.departure_time) chips.push(fmtTime(d.departure_time));
    if (d.arrival_time) chips.push('→ ' + fmtTime(d.arrival_time));
    if (d.cabin_class) chips.push(escapeHtml(d.cabin_class.replace(/_/g, ' ')));
    if (d.stops != null) chips.push(d.stops === 0 ? 'Non-stop' : `${d.stops} stop(s)`);
  } else if (item.travel_type === 'hotel') {
    if (d.nights) chips.push(`${d.nights} night(s)`);
    if (d.star_rating) chips.push('★'.repeat(d.star_rating));
  } else {
    if (d.nights) chips.push(`${d.nights} night(s)`);
    if (d.cabin_class) chips.push(escapeHtml(d.cabin_class));
  }
  if (item.available_units != null) chips.push(`${item.available_units} seats left`);
  return chips.join(' &middot; ');
}

function teResultCard(item, passengers) {
  return `
    <div class="panel" style="display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:12px;">
      <div>
        <div style="font-weight:700; font-size:14.5px;">${teDetailLine(item)}</div>
        <div style="font-size:12.5px; color:var(--text-muted); margin-top:4px;">${teMetaChips(item)}</div>
        ${item.travel_date ? `<div style="font-size:12px; color:var(--text-muted); margin-top:2px;">Travel date: ${fmtDate(item.travel_date)}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:18px; font-weight:800;">${money(item.total_amount)}<span style="font-size:11px; font-weight:600; color:var(--text-muted);"> /seat</span></div>
        <button type="button" class="btn btn-coral btn-sm" data-request-item="${item.id}" style="margin-top:8px;">Request This</button>
      </div>
    </div>`;
}

async function searchTicketEnquiry() {
  const container = document.getElementById('teResultsContainer');
  container.innerHTML = '<div class="skeleton-row"><div class="skeleton-block"></div></div>';

  const passengers = Number(document.getElementById('tePassengers').value || 1);
  const params = {
    travel_type: teTravelType,
    origin: document.getElementById('teOrigin').value.trim() || undefined,
    destination: document.getElementById('teDestination').value.trim() || undefined,
    travel_date: document.getElementById('teDate').value || undefined,
    passengers,
    max_price: document.getElementById('teMaxPrice').value || undefined,
    page_size: 20,
  };
  if (teTravelType === 'flight') {
    params.cabin_class = document.getElementById('teCabin').value || undefined;
    params.airline = document.getElementById('teAirline').value.trim() || undefined;
  }

  try {
    const { data } = await axios.get(`${API_BASE}/api/catalog/search`, { headers: partnerAuthHeaders(), params });
    container.innerHTML = data.items.length
      ? data.items.map(item => teResultCard(item, passengers)).join('')
      : '<div class="empty-state">No results match this search.</div>';
    container.querySelectorAll('[data-request-item]').forEach(btn => {
      btn.addEventListener('click', () => requestCatalogItem(Number(btn.dataset.requestItem), passengers));
    });
  } catch (err) {
    container.innerHTML = '<div class="empty-state">Failed to load results.</div>';
  }
}

/* Hands off to Request Ticket (partner-request-ticket.js): fetch the quote for this party
   size, then switch sections so the passenger-details step opens against a priced, real
   catalog item rather than free-form input. */
async function requestCatalogItem(itemId, passengers) {
  try {
    const { data: quote } = await axios.get(`${API_BASE}/api/catalog/${itemId}/quote`, {
      headers: partnerAuthHeaders(), params: { passengers },
    });
    startRequestTicket(quote, passengers);
    navigateToSection('request-ticket');
  } catch (err) {
    showToast(err.response?.data?.detail || 'Could not price this option.', true);
  }
}
