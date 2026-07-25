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
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Passport #</th><th>DOB</th></tr></thead><tbody>
        ${b.passengers.map(p => `<tr><td>${escapeHtml(p.full_name)}</td><td style="text-transform:capitalize">${escapeHtml(p.passenger_type)}</td><td>${escapeHtml(p.passport_number)}</td><td>${fmtDate(p.date_of_birth)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">No passengers.</td></tr>'}
      </tbody></table></div>
      <div class="modal-actions" style="margin-top:20px;">
        <button type="button" class="btn btn-navy" id="bookingDetailPrintBtn">Print / Save as PDF</button>
        <button type="button" class="btn btn-ghost" id="bookingDetailCloseBtn">Close</button>
      </div>
    `;
    document.getElementById('bookingDetailCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
    document.getElementById('bookingDetailPrintBtn').addEventListener('click', () => printBookingDetail());
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
