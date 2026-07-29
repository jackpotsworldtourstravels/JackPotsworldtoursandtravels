'use strict';
/* Merchant Portal — Reports. The on-screen table reuses GET /api/requests directly (a plain
   filtered list isn't a new capability). "Export PDF/Excel/CSV" call the new
   GET /api/reports/export, which streams a real file — see API_CONTRACT.md §6.2. */

let repFiltersWired = false;

function initReports() {
  if (!repFiltersWired) {
    document.getElementById('repGenerateBtn').addEventListener('click', () => generateReport());
    document.getElementById('repExportPdfBtn').addEventListener('click', () => downloadReport('pdf'));
    document.getElementById('repExportExcelBtn').addEventListener('click', () => downloadReport('xlsx'));
    document.getElementById('repExportCsvBtn').addEventListener('click', () => downloadReport('csv'));
    repFiltersWired = true;
    generateReport();
  }
}

function reportFilterParams() {
  return {
    date_from: document.getElementById('repTravelFrom').value || undefined,
    date_to: document.getElementById('repTravelTo').value || undefined,
    search: document.getElementById('repSearch').value.trim() || undefined,
    status: document.getElementById('repStatus').value || undefined,
  };
}

function repRow(r) {
  const d = r.details || {};
  return `
    <tr>
      <td>${escapeHtml(r.booking_reference || '—')}</td>
      <td>${escapeHtml(r.request_number)}</td>
      <td>${r.passengers?.length ? escapeHtml(r.passengers.map(p => `${p.first_name} ${p.last_name}`).join(', ')) : '—'}</td>
      <td>${escapeHtml(d.origin_city || d.origin || '—')} → ${escapeHtml(d.destination_city || d.destination || '—')}</td>
      <td>${r.travel_date ? fmtDate(r.travel_date) : '—'}</td>
      <td>${money(r.total_amount)}</td>
      <td><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></td>
    </tr>`;
}

async function generateReport() {
  const tbody = document.querySelector('#repTable tbody');
  tbody.innerHTML = rowsSkeleton();
  try {
    const { data } = await axios.get(`${API_BASE}/api/requests`, {
      headers: partnerAuthHeaders(),
      params: { request_type: 'booking', page_size: 100, ...reportFilterParams() },
    });
    tbody.innerHTML = data.items.length ? data.items.map(repRow).join('') : '<tr><td colspan="7" class="empty-state">No results for these filters.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to generate report.</td></tr>';
  }
}

async function downloadReport(format) {
  try {
    const response = await axios.get(`${API_BASE}/api/reports/export`, {
      headers: partnerAuthHeaders(),
      params: { type: 'bookings', format, ...reportFilterParams() },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bookings-report-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast('Failed to export report.', true);
  }
}
