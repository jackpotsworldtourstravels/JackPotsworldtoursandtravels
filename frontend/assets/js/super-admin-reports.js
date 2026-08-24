'use strict';
/* Super Admin Portal — Global Reports & Analytics.
   GET /api/super-admin/reports/summary — the cross-merchant rollup, which is
   role-gated (Super Admin or Admin) rather than permission-gated: report.view
   is also held by merchants, but only for their own scoped data.

   Row-level export reuses the existing GET /api/reports/export shared by every
   portal (app/routers/reports.py) — a Super Admin already holds report.export,
   so there is no separate super-admin export endpoint to build. */

const SA_REPORT_ICONS = {
  merchants: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/>',
  requests: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  completed: '<path d="M20 6 9 17l-5-5"/>',
  revenue: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
};

function saReportRow(m) {
  return `
    <tr>
      <td class="jp-truncate" title="${saEscapeHtml(m.company_name)}"><strong>${saEscapeHtml(m.company_name)}</strong></td>
      <td>${saEscapeHtml(m.merchant_code)}</td>
      <td>${saStatusBadge(m.status)}</td>
      <td class="jp-num">${m.total_requests}</td>
      <td class="jp-num">${m.completed_requests}</td>
      <td class="jp-num">${moneyStr(m.total_revenue)}</td>
      <td class="jp-num">${m.user_count}</td>
    </tr>`;
}

async function loadSaReports() {
  const grid = document.getElementById('saReportsStatGrid');
  const tbody = document.querySelector('#saReportsTable tbody');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  saTableError(tbody, 7, 'Loading…');
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/reports/summary`,
                                     { headers: saAuthHeaders() });
    const rows = data.merchants;

    /* M6: the totals arrive with the rows. They used to be summed here with
       `Number()` — the last client-side money sum left after M4 removed ten of
       them — which turns a Decimal into a float and drops the paise, so a
       platform revenue figure of ₹4,17,71,278.75 rendered as ...279. The server
       adds them in `Decimal` and sends the result as a string; `moneyStr`
       renders that string without parsing it. */
    const t = data.totals;
    grid.innerHTML = [
      saDashCard(SA_REPORT_ICONS.merchants, 'gold', t.merchants, 'Merchants Reporting'),
      saDashCard(SA_REPORT_ICONS.requests, 'sky', t.total_requests, 'Total Requests'),
      saDashCard(SA_REPORT_ICONS.completed, 'emerald', t.completed_requests, 'Completed'),
      saDashCard(SA_REPORT_ICONS.revenue, 'coral', moneyStr(t.total_revenue), 'Total Revenue'),
    ].join('');

    tbody.innerHTML = rows.length
      ? rows.map(saReportRow).join('')
      : '<tr><td colspan="7" class="empty-state">No merchants on the platform yet.</td></tr>';
  } catch (err) {
    grid.innerHTML = '';
    saTableError(tbody, 7, saErrorText(err, 'Failed to load the global report.'));
  }
}

/* ---------- Row-level export ---------- */
async function saDownloadReport(format) {
  const type = document.getElementById('saExportType').value;
  try {
    const response = await axios.get(`${API_BASE}/api/reports/export`, {
      headers: saAuthHeaders(),
      params: { type, format },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}-report-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${type.replace(/_/g, ' ')} as ${format.toUpperCase()}.`);
  } catch (err) {
    showToast('Failed to export the report.', true);
  }
}

document.getElementById('saExportPdfBtn')?.addEventListener('click', () => saDownloadReport('pdf'));
document.getElementById('saExportExcelBtn')?.addEventListener('click', () => saDownloadReport('xlsx'));
document.getElementById('saExportCsvBtn')?.addEventListener('click', () => saDownloadReport('csv'));
