'use strict';
/* Classic — Reports.
   ===========================================================================
   A filtered booking table plus the same CSV/XLSX export Premium offers
   (GET /api/reports/export with type=bookings). The filter params fed to the
   table and to the export are built by one function, so the file the merchant
   downloads always describes the rows they are looking at — the two drifting
   apart is the classic reporting bug.

   Totals are computed from the rows on screen and labelled as such. They are
   NOT an authoritative account statement; the backend does not expose a
   totals endpoint, and presenting a client-side sum as a ledger figure would
   be misleading. */

function clInitReports() {
  $('cl-reports').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Reports</h1>
        <p>Booking activity for your account, by travel date. Export matches the filters below.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clRepCsv">Export CSV</button>
        <button type="button" class="cl-btn" id="clRepXlsx">Export XLSX</button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <!-- date_from/date_to filter on ServiceRequest.travel_date, NOT on when
             the request was raised (ticket_service.py:145). Labelled as travel
             dates, and left EMPTY by default: a created-date-shaped default of
             "last 30 days" silently returned nothing, because every booking in
             the system travels in the future. A report that hides rows on first
             load is worse than one that shows all of them. -->
        <div class="cl-field">
          <label for="clRepFrom">Travel date from</label>
          <input type="date" id="clRepFrom">
        </div>
        <div class="cl-field">
          <label for="clRepTo">Travel date to</label>
          <input type="date" id="clRepTo">
        </div>
        <div class="cl-field">
          <label for="clRepStatus">Status</label>
          <select id="clRepStatus" data-cl-status-filter>
            <option value="">All statuses</option>
            ${MERCHANT_REQUEST_STATUSES.map(s => `<option value="${s}">${clLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field" style="min-width:0;">
          <label>&nbsp;</label>
          <button type="button" class="cl-btn cl-btn-primary" id="clRepRun">Generate</button>
        </div>
      </div>

      <div id="clRepSummary"></div>

      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Request no.</th><th>Item</th><th>Route / location</th><th>Travel date</th>
              <th class="cl-num">Amount</th><th>Status</th><th>Created</th>
            </tr></thead>
            <tbody id="clRepBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager"><span class="cl-pager-info" id="clRepCount">—</span></div>
    </div>
    <div class="cl-msg" id="clRepMsg"></div>`;

  $('clRepRun').addEventListener('click', clRunReport);
  $('clRepStatus').addEventListener('change', clRunReport);
  $('clRepCsv').addEventListener('click', () => clExportReport('csv'));
  $('clRepXlsx').addEventListener('click', () => clExportReport('xlsx'));

  return clRunReport();
}

/* One source of truth for the filters, used by both the table and the export. */
function clReportParams() {
  const p = {};
  if ($('clRepFrom').value) p.date_from = $('clRepFrom').value;
  if ($('clRepTo').value) p.date_to = $('clRepTo').value;
  if ($('clRepStatus').value) p.status = $('clRepStatus').value;
  return p;
}

async function clRunReport() {
  const body = $('clRepBody');
  body.innerHTML = clLoadingRow(7, 'Generating…');
  clMsg($('clRepMsg'), '');

  try {
    const data = await MerchantApi.listRequests({
      request_type: 'booking', page_size: 100, ...clReportParams(),
    });
    const rows = data.items || [];

    body.innerHTML = rows.length
      ? rows.map(clRepRow).join('')
      : clEmptyRow(7, 'No bookings match these filters.');
    $('clRepCount').textContent = `${rows.length} booking${rows.length === 1 ? '' : 's'}`
      + (data.total && data.total > rows.length ? ` (showing the first ${rows.length} of ${data.total})` : '');

    clRenderRepSummary(rows, data.total);
  } catch (err) {
    body.innerHTML = clEmptyRow(7, clError(err, 'Failed to generate the report.'));
    $('clRepSummary').innerHTML = '';
    $('clRepCount').textContent = '—';
  }
}

function clRepRow(r) {
  const d = r.travel_details || r.details || {};
  const where = d.origin || d.origin_city
    ? `${escapeHtml(d.origin_city || d.origin || '—')} → ${escapeHtml(d.destination_city || d.destination || '—')}`
    : escapeHtml(d.destination_city || d.destination || d.hotel_name || '—');
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
    <td>${escapeHtml(r.title || '—')}</td>
    <td>${where}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.travel_date))}</td>
    <td class="cl-num">${money(r.total_amount)}</td>
    <td>${clTag(r.status)}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.created_at))}</td>
  </tr>`;
}

/* Sums over the rows returned. Explicitly labelled as being over the listed
   rows so nobody reads it as a statement of account — and if the API capped the
   page, that is said out loud rather than quietly under-reporting. */
function clRenderRepSummary(rows, total) {
  const value = rows.reduce((n, r) => n + (Number(r.total_amount) || 0), 0);
  const byStatus = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const capped = total && total > rows.length;

  $('clRepSummary').innerHTML = `
    <div class="cl-kpis" style="margin:0;border-left:none;border-right:none;border-radius:0;">
      ${clKpi('Bookings listed', rows.length, capped ? `of ${total} total` : 'all matching rows')}
      ${clKpi('Value listed', money(value), 'sum of the rows below')}
      ${clKpi('Ticketed', (byStatus.ticketed || 0) + (byStatus.ticket_issued || 0), 'documents issued')}
      ${clKpi('Cancelled', byStatus.cancelled || 0, 'in this period')}
    </div>
    ${capped ? `<div class="cl-panel-note">
      The API returns at most 100 rows per page, so these totals cover the ${rows.length} listed —
      not all ${total}. Narrow the date range for a complete figure, or use the export.
    </div>` : ''}`;
}

async function clExportReport(format) {
  const msg = $('clRepMsg');
  clMsg(msg, `Preparing ${format.toUpperCase()} export…`, 'muted');
  try {
    const blob = await MerchantApi.exportReport({
      type: 'bookings', format, ...clReportParams(),
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bookings-report-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* Revoked on the next tick — revoking synchronously can cancel the download
       in some browsers before it has read the blob. */
    setTimeout(() => URL.revokeObjectURL(url), 0);
    clMsg(msg, `${format.toUpperCase()} export downloaded.`, 'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Failed to export the report.'), 'err');
  }
}

/* ------------------------------------------------------- notifications page */

/* The drawer is for glancing; this is the full list with the same data, for
   someone working through them. Same endpoints. */
function clInitNotifications() {
  $('cl-notifications').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Notifications</h1>
        <p>Approvals, payment reminders and ticketing updates for your account.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clNotesRefresh">Refresh</button>
        <button type="button" class="cl-btn cl-btn-primary" id="clNotesReadAll">Mark all read</button>
      </div>
    </div>
    <div class="cl-panel">
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr><th style="width:34px;"></th><th>Subject</th><th>Message</th><th>Received</th></tr></thead>
            <tbody id="clNotesBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager"><span class="cl-pager-info" id="clNotesCount">—</span></div>
    </div>`;

  $('clNotesRefresh').addEventListener('click', clLoadNotesPage);
  $('clNotesReadAll').addEventListener('click', async () => {
    try {
      await MerchantApi.markAllNotificationsRead();
      await clLoadNotesPage();
      await clLoadUnreadCount();
    } catch { /* leave the list as it was */ }
  });

  return clLoadNotesPage();
}

async function clLoadNotesPage() {
  const body = $('clNotesBody');
  body.innerHTML = clLoadingRow(4, 'Loading notifications…');
  try {
    const data = await MerchantApi.listNotifications(100);
    const items = data.items || [];
    body.innerHTML = items.length ? items.map(n => {
      const unread = !(n.is_read ?? n.read ?? false);
      return `<tr data-cl-note-row="${escapeHtml(String(n.id))}">
        <td>${unread ? '<span class="cl-tag cl-tag-info">New</span>' : ''}</td>
        <td><b>${escapeHtml(n.title || n.subject || 'Notification')}</b></td>
        <td>${escapeHtml(n.message || n.body || '—')}</td>
        <td class="cl-nowrap">${escapeHtml(fmtDateTime(n.created_at))}</td>
      </tr>`;
    }).join('') : clEmptyRow(4, 'No notifications.');

    const unreadCount = items.filter(n => !(n.is_read ?? n.read ?? false)).length;
    $('clNotesCount').textContent = `${items.length} notification${items.length === 1 ? '' : 's'}`
      + (unreadCount ? ` · ${unreadCount} unread` : '');

    /* Clicking a row marks it read, matching the drawer's behaviour. */
    body.querySelectorAll('[data-cl-note-row]').forEach(tr => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', async () => {
        const cell = tr.querySelector('td');
        if (!cell.textContent.trim()) return;
        cell.innerHTML = '';
        try { await MerchantApi.markNotificationRead(tr.dataset.clNoteRow); await clLoadUnreadCount(); } catch { /* visual only */ }
      });
    });
  } catch (err) {
    body.innerHTML = clEmptyRow(4, clError(err, 'Failed to load notifications.'));
  }
}
