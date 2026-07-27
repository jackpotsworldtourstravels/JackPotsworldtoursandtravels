'use strict';
/* Partner Portal — Reports.
   The API always returns JSON regardless of export_format (that param is
   just metadata logged server-side) — there's no server-side PDF/Excel
   generator, so "Export Excel" builds a CSV client-side (opens directly in
   Excel, same pattern already used elsewhere in this project) and
   "Export PDF" uses the browser's print-to-PDF, same as Request History. */

let repFiltersWired = false;
let repLastRows = [];

function initReports() {
  if (!repFiltersWired) {
    document.getElementById('repGenerateBtn').addEventListener('click', () => generateReport('pdf'));
    document.getElementById('repExportPdfBtn').addEventListener('click', () => generateReport('pdf').then(printReportTable));
    document.getElementById('repExportExcelBtn').addEventListener('click', () => generateReport('excel').then(exportReportCsv));
    repFiltersWired = true;
  }
}

function reportFilterParams(exportFormat) {
  return {
    request_date_from: document.getElementById('repRequestFrom').value || undefined,
    request_date_to: document.getElementById('repRequestTo').value || undefined,
    travel_date_from: document.getElementById('repTravelFrom').value || undefined,
    travel_date_to: document.getElementById('repTravelTo').value || undefined,
    passenger_name: document.getElementById('repPassenger').value || undefined,
    service_request_number: document.getElementById('repSrNumber').value || undefined,
    sector_departure: document.getElementById('repDeparture').value || undefined,
    sector_arrival: document.getElementById('repArrival').value || undefined,
    export_format: exportFormat,
  };
}

async function generateReport(exportFormat) {
  const tbody = document.querySelector('#repTable tbody');
  tbody.innerHTML = rowsSkeleton();
  try {
    const { data } = await axios.get(`${API_BASE}/api/partner/reports`, { headers: partnerAuthHeaders(), params: reportFilterParams(exportFormat) });
    repLastRows = data;
    tbody.innerHTML = data.length ? data.map(r => `
      <tr>
        <td>${escapeHtml(r.reference_number)}</td>
        <td>${escapeHtml(r.passenger_name)}</td>
        <td>${r.service_request_number ? escapeHtml(r.service_request_number) : '—'}</td>
        <td>${escapeHtml(r.sector_departure)} → ${escapeHtml(r.sector_arrival)}</td>
        <td>${fmtDate(r.request_date)}</td>
        <td>${r.travel_date ? fmtDate(r.travel_date) : '—'}</td>
        <td>${money(r.total_amount)}</td>
        <td>${r.amount_reimbursement != null ? money(r.amount_reimbursement) : '—'}</td>
        <td><span class="badge ${r.status}">${statusLabel(r.status)}</span></td>
      </tr>
    `).join('') : '<tr><td colspan="9" class="empty-state">No results for these filters.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Failed to generate report.</td></tr>';
  }
  return repLastRows;
}

function printReportTable() {
  document.body.classList.add('printing-report');
  window.print();
  setTimeout(() => document.body.classList.remove('printing-report'), 500);
}

function exportReportCsv() {
  if (!repLastRows.length) return;
  const headers = ['Reference', 'Passenger', 'Request #', 'Departure', 'Arrival', 'Request Date', 'Travel Date', 'Amount', 'Reimbursement', 'Status'];
  const rows = repLastRows.map(r => [
    r.reference_number, r.passenger_name, r.service_request_number || '', r.sector_departure, r.sector_arrival,
    r.request_date, r.travel_date || '', r.total_amount ?? '', r.amount_reimbursement ?? '', r.status,
  ]);
  const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `partner-report-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}
