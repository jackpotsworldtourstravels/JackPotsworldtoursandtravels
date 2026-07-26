'use strict';
/* Partner Portal — Request History */

function initRequestHistoryFilters() {
  ['rhStatusFilter', 'rhFromDate', 'rhToDate'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => loadRequestHistory());
  });
}
let rhFiltersWired = false;

async function loadRequestHistory() {
  if (!rhFiltersWired) { initRequestHistoryFilters(); rhFiltersWired = true; }
  const tbody = document.querySelector('#rhTable tbody');
  tbody.innerHTML = rowsSkeleton();
  const params = {
    status: document.getElementById('rhStatusFilter').value || undefined,
    from_date: document.getElementById('rhFromDate').value || undefined,
    to_date: document.getElementById('rhToDate').value || undefined,
  };
  try {
    const { data } = await axios.get(`${API_BASE}/api/partner/request-history`, { headers: partnerAuthHeaders(), params });
    window.__rhLastData = data;
    tbody.innerHTML = data.length ? data.map(r => `
      <tr>
        <td>${escapeHtml(r.reference_number)}</td>
        <td>${r.service_request_number ? escapeHtml(r.service_request_number) : '—'}</td>
        <td>${escapeHtml(r.passenger_name)}</td>
        <td style="text-transform:capitalize">${escapeHtml(r.travel_type)}</td>
        <td>${escapeHtml(r.destination)}</td>
        <td>${r.travel_date ? fmtDate(r.travel_date) : '—'}</td>
        <td><span class="badge ${r.status}">${statusLabel(r.status)}</span></td>
        <td>${fmtDate(r.created_at)}</td>
        <td>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost btn-sm" data-rh-view="${r.booking_id}">View</button>
            <button type="button" class="btn btn-ghost btn-sm" data-rh-pdf="${r.booking_id}">Download PDF</button>
            <button type="button" class="btn btn-ghost btn-sm" data-rh-print="${r.booking_id}">Print</button>
          </div>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="9" class="empty-state">No requests found.</td></tr>';
    tbody.querySelectorAll('[data-rh-view]').forEach(b => b.addEventListener('click', () => openBookingDetailModal(b.dataset.rhView)));
    tbody.querySelectorAll('[data-rh-pdf]').forEach(b => b.addEventListener('click', () => openBookingDetailModal(b.dataset.rhPdf, true)));
    tbody.querySelectorAll('[data-rh-print]').forEach(b => b.addEventListener('click', () => openBookingDetailModal(b.dataset.rhPrint, true)));
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Failed to load request history.</td></tr>';
  }
}

const PAX_SEAT_LABELS = { window: 'Window', aisle: 'Aisle', middle: 'Middle', front_row: 'Front Row', exit_row: 'Exit Row' };

function paxAncillaryValue(label, charge) {
  return charge > 0 ? `${escapeHtml(label)} <span class="pax-charge">(+${money(charge)})</span>` : escapeHtml(label);
}

/* Meal Preference / Special Request (special_assistance) are real columns.
   Baggage/Meal selections, Seat Preference, and Special Services come from
   the passenger_ancillary_catalog-backed fields added for Request Ticket's
   "Travel Preferences & Additional Services" section — passengers created
   before that feature simply have no selection, shown as "Not selected". */
function passengerAccordionCard(p, index) {
  const specialServicesHtml = p.special_services?.length
    ? `<div class="pax-service-badges">${p.special_services.map(s => `<span class="pax-service-badge">${paxAncillaryValue(s.label, s.additional_charge)}</span>`).join('')}</div>`
    : 'None selected';
  return `
    <div class="pax-card" data-pax-index="${index}">
      <button type="button" class="pax-card-header">
        <span class="pax-avatar">${escapeHtml((p.full_name || '?')[0])}</span>
        <span class="pax-header-body">
          <strong>${escapeHtml(p.full_name)}</strong>
          <small style="text-transform:capitalize;">${escapeHtml(p.passenger_type)} · Passport ${escapeHtml(p.passport_number)} · DOB ${fmtDate(p.date_of_birth)}</small>
        </span>
        <svg class="icon pax-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="pax-card-body">
        <div class="pax-option-grid">
          <div class="pax-option">
            <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>
            <div><label>Baggage</label><div>${p.baggage_selection ? paxAncillaryValue(p.baggage_selection.label, p.baggage_selection.additional_charge) : 'Not selected'}</div></div>
          </div>
          <div class="pax-option">
            <svg class="icon" viewBox="0 0 24 24"><path d="M3 2v20M3 7h4M3 12h18M3 2h4a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H3"/></svg>
            <div><label>Meal</label><div>${p.meal_selection ? paxAncillaryValue(p.meal_selection.label, p.meal_selection.additional_charge) : (p.meal_preference ? escapeHtml(p.meal_preference) : 'Not specified')}</div></div>
          </div>
          <div class="pax-option">
            <svg class="icon" viewBox="0 0 24 24"><path d="M4 4v14a2 2 0 0 0 2 2h12M8 12h12M8 8h8"/></svg>
            <div><label>Seat Preference</label><div>${p.seat_preference ? escapeHtml(PAX_SEAT_LABELS[p.seat_preference] || p.seat_preference) : 'Not selected'}</div></div>
          </div>
          <div class="pax-option">
            <svg class="icon" viewBox="0 0 24 24"><path d="M12 2 3.5 7v6c0 5 4 8.5 8.5 9 4.5-.5 8.5-4 8.5-9V7Z"/></svg>
            <div><label>Special Services</label><div>${specialServicesHtml}</div></div>
          </div>
          <div class="pax-option" style="grid-column:1/-1;">
            <svg class="icon" viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 1 4 4v2H8V6a4 4 0 0 1 4-4Z"/><path d="M4 10h16l-1.5 10a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2Z"/></svg>
            <div><label>Special Request</label><div>${p.special_assistance ? escapeHtml(p.special_assistance) : 'None requested'}</div></div>
          </div>
        </div>
      </div>
    </div>`;
}
function wirePassengerAccordion(container) {
  container.querySelectorAll('.pax-card-header').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.pax-card').classList.toggle('open'));
  });
}

/* Reused by Request History's View/Download PDF/Print. "Download PDF" and
   "Print" both use the browser's print dialog (Save as PDF is a print
   destination in every modern browser) — there's no server-side PDF
   generator for the Partner Portal, so this doesn't pretend to have one. */
async function openBookingDetailModal(bookingId, autoPrint) {
  const overlay = document.getElementById('bookingDetailModalOverlay');
  const body = document.getElementById('bookingDetailBody');
  overlay.classList.add('open');
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data: b } = await axios.get(`${API_BASE}/api/partner/bookings/${bookingId}`, { headers: partnerAuthHeaders() });
    body.innerHTML = `
      <h2>Booking ${escapeHtml(b.reference_number)}</h2>
      <div class="info-grid">
        <div class="info-item"><label>Status</label><div><span class="badge ${b.status}">${statusLabel(b.status)}</span></div></div>
        <div class="info-item"><label>Travel Type</label><div style="text-transform:capitalize;">${escapeHtml(b.travel_type)}</div></div>
        <div class="info-item"><label>Departure</label><div>${escapeHtml(b.departure)}</div></div>
        <div class="info-item"><label>Arrival</label><div>${escapeHtml(b.arrival)}</div></div>
        <div class="info-item"><label>Travel Date</label><div>${fmtDate(b.departure_date)}</div></div>
        <div class="info-item"><label>Return Date</label><div>${b.return_date ? fmtDate(b.return_date) : '—'}</div></div>
        <div class="info-item"><label>Total Amount</label><div>${money(b.total_amount)}</div></div>
        <div class="info-item"><label>Booked On</label><div>${fmtDateTime(b.created_at)}</div></div>
      </div>
      <h2 style="font-size:14px;margin-bottom:10px;">Passengers</h2>
      <div class="pax-accordion">
        ${b.passengers.map((p, i) => passengerAccordionCard(p, i)).join('') || '<div class="empty-state">No passengers.</div>'}
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button type="button" class="btn btn-navy" id="bookingDetailPrintBtn">Print / Save as PDF</button>
        <button type="button" class="btn btn-ghost" id="bookingDetailCloseBtn">Close</button>
      </div>
    `;
    document.getElementById('bookingDetailCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
    document.getElementById('bookingDetailPrintBtn').addEventListener('click', () => printBookingDetail());
    wirePassengerAccordion(body);
    if (autoPrint) printBookingDetail();
  } catch (err) {
    body.innerHTML = `<div class="empty-state">Failed to load booking.</div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="bookingDetailCloseBtn">Close</button></div>`;
    document.getElementById('bookingDetailCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
  }
}
function printBookingDetail() {
  const overlay = document.getElementById('bookingDetailModalOverlay');
  overlay.classList.add('print-target');
  window.print();
  setTimeout(() => overlay.classList.remove('print-target'), 500);
}
