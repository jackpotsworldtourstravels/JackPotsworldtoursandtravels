'use strict';
/* Merchant Portal — Reports (a BI dashboard) and the Notification Center.
   ===========================================================================
   Two screens live in this file because they are two views of "what has
   happened", and keeping them together is how their date handling stays in
   step.

   REPORTS
   Five headline figures, four charts and the filtered table the export is taken
   from. Everything is aggregated SERVER-side:

     GET /api/analytics/bookings        volume, value, status mix, top routes
     GET /api/analytics/change-requests cancellations, reschedules and the money
     GET /api/reports/summary           what the export will contain
     GET /api/reports/export            the file itself

   NOTHING ON THIS SCREEN SUMS A COLUMN. The figures and the export are built by
   the same row builders on the server, so "N bookings, worth X" describes
   exactly the file the buttons will produce — including when the row cap bites,
   which the screen says out loud rather than showing a page total and letting
   the reader infer it.

   ONE DATE FIELD, CHOSEN BY THE USER AND ECHOED BY THE SERVER. `date_field`
   decides which column the range filter AND the monthly series run on:
   `travel_date` (when they fly) or `created_at` (when it was raised). The two
   answer different questions and a report that silently picks one is a report
   that will eventually be quoted at the wrong meeting. The analytics response
   echoes back which was used, and the panel labels itself from the ANSWER
   rather than from what it asked for.

   `moneyStr` renders the API's decimal string without parsing it — `money()`
   floats the value and drops the paise (₹24,500.50 -> ₹24,501), which is why
   nothing that came from the server goes through it. */

let clRepAnalytics = null;

function clInitReports() {
  $('cl-reports').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Reports</h1>
      </div>
      <!-- Reading the report is report.view, which every merchant account
           holds; taking a FILE away is report.export, which not every role
           does. So the figures, the charts and the filters below are the same
           screen for everyone and only these three buttons change state. -->
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clRepCsv"
          ${clActionAttrs('report.export', CL_NO_EXPORT)}>${clIco('download', { size: 15 })} CSV</button>
        <button type="button" class="cl-btn" id="clRepXlsx"
          ${clActionAttrs('report.export', CL_NO_EXPORT)}>${clIco('download', { size: 15 })} XLSX</button>
        <button type="button" class="cl-btn cl-btn-secondary" id="clRepPdf"
          ${clActionAttrs('report.export', CL_NO_EXPORT)}>${clIco('download', { size: 15 })} PDF</button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clRepBasis">Measure by</label>
          <select id="clRepBasis">
            <option value="travel_date">Travel date — when they fly</option>
            <option value="created_at">Raised date — when it was booked</option>
          </select>
        </div>
        <!-- The range runs on whichever column "Measure by" names, because that
             is what the endpoint does. A control labelled only "From/To" over a
             field the user cannot see is the mislabelling this portal has been
             caught by before. Left EMPTY by default: a created-date-shaped
             default of "last 30 days" silently returns nothing, because every
             booking in the system travels in the future. -->
        <div class="cl-field">
          <label for="clRepFrom">From</label>
          <input type="date" id="clRepFrom">
        </div>
        <div class="cl-field">
          <label for="clRepTo">To</label>
          <input type="date" id="clRepTo">
        </div>
        <div class="cl-field">
          <label for="clRepStatus">Status</label>
          <select id="clRepStatus" data-cl-status-filter>
            <option value="">All statuses</option>
            ${MERCHANT_REQUEST_STATUSES.map(s =>
              `<option value="${s}" data-cl-chip-tone="${CL_STATUS_TONE[s] || ''}">${clLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-toolbar-actions">
          <button type="button" class="cl-btn" id="clRepReset">Reset</button>
          <button type="button" class="cl-btn cl-btn-secondary" id="clRepRun">
            ${clIco('filter', { size: 14 })} Apply filters
          </button>
        </div>
      </div>
    </div>

    <div class="cl-kpis" id="clRepKpis"></div>
    <div id="clRepCharts"></div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>${clIco('file')}Bookings in this report</h2>
        <div class="cl-panel-tools"><span class="cl-kpi-sub" id="clRepCount">—</span></div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Reference</th><th>Item</th><th>Route / location</th><th>Travel date</th>
              <th class="cl-num">Amount</th><th>Status</th><th>Raised</th>
            </tr></thead>
            <tbody id="clRepBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-panel-note" id="clRepNote"></div>
    </div>

    <div class="cl-msg" id="clRepMsg"></div>`;

  clChips('clRepStatus', 'Status');

  $('clRepRun').addEventListener('click', clRunReport);
  $('clRepReset').addEventListener('click', () => {
    $('clRepBasis').value = 'travel_date';
    ['clRepFrom', 'clRepTo', 'clRepStatus'].forEach(id => { $(id).value = ''; });
    clSyncChips('clRepStatus');
    clRunReport();
  });
  ['clRepStatus', 'clRepBasis'].forEach(id => $(id).addEventListener('change', clRunReport));
  $('clRepCsv').addEventListener('click', () => clExportReport('csv'));
  $('clRepXlsx').addEventListener('click', () => clExportReport('xlsx'));
  $('clRepPdf').addEventListener('click', () => clExportReport('pdf'));

  return clRunReport();
}

/* One source of truth for the filters, used by the table, the analytics, the
   summary and the export. They cannot describe different rows because they are
   all built from here. */
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
  $('clRepKpis').innerHTML = `${'<div class="cl-kpi"><span class="cl-skel cl-skel-line w40"></span>'
    + '<span class="cl-skel cl-skel-line w80" style="height:26px"></span></div>'.repeat(5)}`;
  clMsg($('clRepMsg'), '');

  const params = clReportParams();
  const basis = $('clRepBasis').value;

  try {
    /* Four calls, one filter set. The table is a page; the analytics and the
       summary describe the whole matching set and the export that would be
       taken of it. Every one but the table is optional — a failure there leaves
       the screen usable and says which band is missing. */
    const [data, summary, analytics, changes] = await Promise.all([
      MerchantApi.listRequests({ request_type: 'booking', page_size: 100, ...params }),
      MerchantApi.reportSummary({ type: 'bookings', ...params }).catch(() => null),
      MerchantApi.bookingAnalytics({
        dateField: basis, dateFrom: params.date_from, dateTo: params.date_to,
      }).catch(() => null),
      MerchantApi.changeRequestAnalytics({
        dateFrom: params.date_from, dateTo: params.date_to,
      }).catch(() => null),
    ]);
    clRepAnalytics = analytics;
    const rows = data.items || [];

    body.innerHTML = rows.length
      ? rows.map(clRepRow).join('')
      : clEmptyRow(7, 'No bookings match these filters.',
        ' Widen the date range, or clear the status.');
    $('clRepCount').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} listed`
      + (data.total && data.total > rows.length ? ` of ${data.total}` : '');

    clRenderRepKpis(summary, analytics, changes);
    clRenderRepCharts(analytics);
    clRenderRepNote(summary);
  } catch (err) {
    body.innerHTML = clEmptyRow(7, clError(err, 'Failed to generate the report.'));
    $('clRepKpis').innerHTML = '';
    $('clRepCharts').innerHTML = '';
    $('clRepCount').textContent = '—';
    $('clRepNote').textContent = '';
  }
}

function clRepRow(r) {
  const d = r.travel_details || r.details || {};
  const where = d.origin || d.origin_city
    ? `${escapeHtml(d.origin_city || d.origin || '—')} <span style="color:var(--cl-text-muted)">→</span> ${escapeHtml(d.destination_city || d.destination || '—')}`
    : escapeHtml(d.destination_city || d.destination || d.hotel_name || '—');
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
    <td>${escapeHtml(r.title || '—')}</td>
    <td>${where}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.travel_date))}</td>
    <td class="cl-num">${escapeHtml(moneyStr(r.total_amount))}</td>
    <td>${clTag(r.status, r.status_label)}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.created_at))}</td>
  </tr>`;
}

/* Five figures, each of them the server's own aggregate. Refunds come from the
   change-request analytics because a refund is not a state a booking reaches —
   it is the settlement of an approved cancellation, and the endpoint measures
   it over the APPROVED ones only. A rejected cancellation charged nothing, so
   counting it would report money that never moved. */
function clRenderRepKpis(summary, analytics, changes) {
  const byStatus = new Map((analytics?.by_status || []).map(r => [r.status, r.count]));
  const cancelled = (byStatus.get('cancelled') || 0) + (byStatus.get('rejected') || 0);

  const tiles = [
    { label: 'Bookings', icon: 'file', tone: '',
      value: summary ? summary.rows : (analytics ? analytics.totals.bookings : '—'),
      sub: 'matching these filters' },
    { label: 'Revenue', icon: 'trend', tone: 'accent',
      value: summary ? moneyStr(summary.total_value) : (analytics ? moneyStr(analytics.totals.value) : '—'),
      sub: analytics ? `average ${moneyStr(analytics.totals.average_value)} a booking` : 'value of those bookings' },
    { label: 'Refunds', icon: 'rupee', tone: 'info',
      value: changes ? moneyStr(changes.money.refunds_settled) : '—',
      sub: changes && moneyIsPositive(changes.money.refunds_outstanding)
        ? `${moneyStr(changes.money.refunds_outstanding)} still owed to you`
        : 'settled on approved cancellations' },
    { label: 'Cancelled', icon: 'x', tone: 'err',
      value: analytics ? cancelled : '—',
      sub: changes ? `${changes.totals.requests} change request${changes.totals.requests === 1 ? '' : 's'} raised` : 'bookings closed without travel' },
    { label: 'Completed', icon: 'checkCircle', tone: 'ok',
      value: analytics ? (byStatus.get('completed') || 0) : '—',
      sub: analytics ? `${byStatus.get('ticket_issued') || 0} ticketed and yet to travel` : 'travel finished' },
    /* 0040. The server's own SUM of GREATEST(client_fare - total_amount, 0),
       over the bookings that actually carry a client fare. `savings_bookings`
       is quoted beside it precisely because that is usually FEWER than
       `Bookings` above — without it, "You saved X" reads as if it covered
       every booking in the period. Nothing here subtracts two amounts; the
       aggregate arrives computed. */
    { label: 'Total savings', icon: 'rupee', tone: 'ok',
      value: analytics ? moneyStr(analytics.totals.saved) : '—',
      sub: analytics
        ? `across ${analytics.totals.savings_bookings || 0} booking${
            analytics.totals.savings_bookings === 1 ? '' : 's'} with a client fare`
        : 'client fare less what we billed' },
  ];

  $('clRepKpis').innerHTML = tiles.map(t => `
    <div class="cl-kpi">
      <div class="cl-kpi-head"><span class="cl-kpi-ico ${t.tone}">${clIco(t.icon)}</span></div>
      <div class="cl-kpi-label">${escapeHtml(t.label)}</div>
      <div class="cl-kpi-value">${escapeHtml(String(t.value))}</div>
      <div class="cl-kpi-sub">${escapeHtml(t.sub)}</div>
    </div>`).join('');
}

/* The charts reuse the dashboard's drawing functions rather than growing a
   second, subtly different set — two screens whose bar charts disagree about
   what a gridline means is a portal that looks assembled from parts. */
function clRenderRepCharts(analytics) {
  const host = $('clRepCharts');
  if (!analytics) {
    host.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
      <div class="cl-msg cl-msg-info" style="margin-top:0">
        The charts could not be loaded. The table and the export below are unaffected.
      </div></div></div>`;
    return;
  }
  if (!analytics.totals.bookings) { host.innerHTML = ''; return; }

  /* Labelled from the ANSWER (`analytics.date_field`), not from what was asked
     for — if the server ever falls back to a different column the chart title
     follows it instead of lying. */
  const basisText = analytics.date_field === 'created_at' ? 'by raised date' : 'by travel date';
  const buckets = clBucketAnalytics(analytics.by_month);
  const span = `${buckets[0].label} – ${buckets[buckets.length - 1].label}`;
  const routes = (analytics.top_routes || []).slice(0, 8)
    .map(r => ({ name: r.route, count: r.count }));

  host.innerHTML = `
    <div class="cl-charts">
      ${clChartPanel('Monthly bookings', `Last ${CL_CHART_MONTHS} months · ${span} · ${basisText}`,
        clBarChart(buckets, b => b.count, n => String(Math.round(n)),
          'var(--cl-orange)', 'Bookings per month'), { icon: 'chart' })}
      ${clChartPanel('Monthly revenue', `Last ${CL_CHART_MONTHS} months · ${span} · ${basisText}`,
        clAreaChart(buckets, b => b.value, clShortMoney,
          'var(--cl-info)', 'Booking value per month'), { icon: 'trend' })}
    </div>
    <div class="cl-charts">
      ${clChartPanel('Status mix', `All ${analytics.totals.bookings} matching booking${analytics.totals.bookings === 1 ? '' : 's'}`,
        clDonut(clStageMix(analytics.by_status), analytics.totals.bookings, 'bookings'), { icon: 'pie' })}
      ${clChartPanel('By destination', 'Your busiest routes in this range',
        routes.length
          ? clRankList(routes, { valueLabel: n => `${n} booking${n === 1 ? '' : 's'}` })
          : '<p class="cl-muted" style="font-size:13px;margin:0;">No routes recorded in this range.</p>',
        { icon: 'route' })}
    </div>`;
}

function clRenderRepNote(summary) {
  const note = $('clRepNote');
  if (!summary) {
    note.innerHTML = 'Export totals are unavailable just now. The table above is unaffected.';
    return;
  }
  note.innerHTML = `The export contains <b>${summary.rows}</b> row${summary.rows === 1 ? '' : 's'}
    worth <b>${escapeHtml(moneyStr(summary.total_value))}</b>, filtered by
    <b>${escapeHtml(summary.date_field.replace('_', ' '))}</b>.
    ${summary.truncated ? `These filters match at least ${summary.row_cap} bookings, which is the
      export's row limit — both the figures above and the downloaded file stop there. Narrow the
      date range for a complete picture. ` : ''}
    This is what the bookings were booked at; it is not your account balance —
    what you owe, have paid and have had refunded is on <b>Payments</b>.`;
}

async function clExportReport(format) {
  const msg = $('clRepMsg');
  clMsg(msg, `Preparing the ${format.toUpperCase()} export…`, 'muted');
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
       in some browsers before they have read the blob. */
    setTimeout(() => URL.revokeObjectURL(url), 0);
    clMsg(msg, `${format.toUpperCase()} export downloaded.`, 'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Failed to export the report.'), 'err');
  }
}

/* ======================================================= NOTIFICATION CENTER

   The drawer in the header is for glancing; this is the room, for someone
   working through a backlog. Same endpoints, same rows.

   CATEGORIES ARE DERIVED, AND THAT IS SAID ON THE SCREEN.
   `NotificationOut` carries id, title, message, is_read and created_at — there
   is no category column. Rather than ship five tabs that cannot work, the
   category is matched from the title the backend actually writes ("Booking
   request approved for ticketing", "Payment verified", "Wallet credited",
   "Booking enquiry: quotation received"), which is stable because those strings
   are constants in the service layer. Anything unmatched lands in Updates
   rather than being dropped — a filter that silently hides a notice is worse
   than a filter that is occasionally too broad. */

const CL_NOTE_CATEGORIES = [
  { key: '', label: 'All', icon: 'inbox', match: () => true },
  { key: 'booking', label: 'Bookings', icon: 'plane',
    match: t => /booking|enquiry|quotation|ticket|pnr|reschedul|cancel|passenger|approv|reject|correction/i.test(t) },
  { key: 'payment', label: 'Payments', icon: 'receipt',
    match: t => /payment|invoice|paid|verif|settle|billed|due/i.test(t) },
  { key: 'wallet', label: 'Wallet', icon: 'wallet',
    match: t => /wallet|top-?up|balance|credit note|refund|adjust/i.test(t) },
  { key: 'support', label: 'Support', icon: 'headset',
    match: t => /support|chat|message|conversation|ticket raised|reply/i.test(t) },
  { key: 'other', label: 'Announcements', icon: 'bell', match: () => true },
];

let clNoteRows = [];
let clNoteCat = '';
let clNoteUnreadOnly = false;
let clNoteQuery = '';

function clInitNotifications() {
  $('cl-notifications').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Notifications</h1>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clNotesRefresh">
          ${clIco('refresh', { size: 15 })} Refresh
        </button>
        <button type="button" class="cl-btn cl-btn-primary" id="clNotesReadAll">
          ${clIco('check', { size: 15 })} Mark all read
        </button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field" style="flex:1 1 260px;">
          <label for="clNotesSearch">Search</label>
          <input type="search" id="clNotesSearch" placeholder="Reference, subject or wording">
        </div>
        <div class="cl-field" style="flex:0 0 auto;">
          <label>Show</label>
          <label class="cl-check" style="height:40px;">
            <input type="checkbox" id="clNotesUnread"> Unread only
          </label>
        </div>
      </div>

      <div class="cl-panel-body" style="padding-bottom:10px;">
        <div class="cl-seg" id="clNotesCats" role="tablist">
          ${CL_NOTE_CATEGORIES.map((c, i) => `
            <button type="button" data-cl-note-cat="${c.key}" role="tab"
                    class="${i === 0 ? 'active' : ''}" aria-selected="${i === 0}">
              ${escapeHtml(c.label)} <span class="cl-tab-count" data-cl-note-count="${c.key}"></span>
            </button>`).join('')}
        </div>
      </div>

      <div class="cl-panel-body cl-flush" style="padding:0 16px 16px;">
        <div id="clNotesList"></div>
      </div>
      <div class="cl-pager"><span class="cl-pager-info" id="clNotesCount">—</span></div>
      <div class="cl-panel-note">
        Categories are worked out from each notice's subject — the notification record itself has
        no category field, so a notice we have not seen the wording of before lands in
        <b>Announcements</b> rather than being hidden.
      </div>
    </div>`;

  $('clNotesRefresh').addEventListener('click', clLoadNotesPage);
  $('clNotesReadAll').addEventListener('click', async () => {
    const btn = $('clNotesReadAll');
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      await MerchantApi.markAllNotificationsRead();
      await clLoadNotesPage();
      await clLoadUnreadCount();
    } catch { /* leave the list as it was */ } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });
  $('clNotesSearch').addEventListener('input', e => {
    clNoteQuery = e.target.value.trim().toLowerCase();
    clRenderNotes();
  });
  $('clNotesUnread').addEventListener('change', e => {
    clNoteUnreadOnly = e.target.checked;
    clRenderNotes();
  });
  $('clNotesCats').querySelectorAll('[data-cl-note-cat]').forEach(b =>
    b.addEventListener('click', () => {
      clNoteCat = b.dataset.clNoteCat;
      $('clNotesCats').querySelectorAll('button').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      clRenderNotes();
    }));

  return clLoadNotesPage();
}

/* First match wins, in declaration order, so a "Booking payment verified"
   notice lands under Bookings rather than being claimed by two tabs. */
function clNoteCategory(n) {
  const hay = `${n.title || ''} ${n.message || ''}`;
  for (const c of CL_NOTE_CATEGORIES.slice(1, -1)) {
    if (c.match(hay)) return c.key;
  }
  return 'other';
}

async function clLoadNotesPage() {
  const host = $('clNotesList');
  host.innerHTML = `<div class="cl-note" style="cursor:default">
    <span class="cl-skel cl-skel-line w40"></span>
    <span class="cl-skel cl-skel-line w80"></span></div>`.repeat(5);
  try {
    const data = await MerchantApi.listNotifications(100);
    clNoteRows = (data.items || []).map(n => ({ ...n, _cat: clNoteCategory(n) }));
    clRenderNotes();
  } catch (err) {
    host.innerHTML = `<div class="cl-msg cl-msg-err">${escapeHtml(clError(err, 'Failed to load notifications.'))}</div>`;
    $('clNotesCount').textContent = '—';
  }
}

const CL_NOTE_TONE = { booking: 'info', payment: 'accent', wallet: 'ok', support: 'warn', other: '' };

function clRenderNotes() {
  const host = $('clNotesList');

  /* Counts on the tabs describe the whole loaded set, not the search — a tab
     that reads 0 because of a search term you have forgotten about is how a
     filter stops being trustworthy. Unread-only DOES narrow them, because that
     switch is a mode rather than a query. */
  const base = clNoteUnreadOnly
    ? clNoteRows.filter(n => !(n.is_read ?? n.read ?? false))
    : clNoteRows;
  CL_NOTE_CATEGORIES.forEach(c => {
    const n = c.key ? base.filter(x => x._cat === c.key).length : base.length;
    const el = $('clNotesCats').querySelector(`[data-cl-note-count="${c.key}"]`);
    if (el) el.textContent = n ? String(n) : '';
  });

  const rows = base.filter(n => {
    if (clNoteCat && n._cat !== clNoteCat) return false;
    if (!clNoteQuery) return true;
    return `${n.title || ''} ${n.message || ''}`.toLowerCase().includes(clNoteQuery);
  });

  host.innerHTML = rows.length
    ? rows.map(clNoteCard).join('')
    : `<div class="cl-blank">
        <span class="cl-blank-ico">${clIco('bell', { size: 26 })}</span>
        <b>${clNoteQuery || clNoteCat || clNoteUnreadOnly ? 'Nothing matches those filters' : 'You are all caught up'}</b>
        <p>${clNoteQuery || clNoteCat || clNoteUnreadOnly
          ? 'Clear the search, the tab or the unread switch to see everything.'
          : 'Approvals, quotations, payment reminders and ticketing updates land here.'}</p>
      </div>`;

  const unread = clNoteRows.filter(n => !(n.is_read ?? n.read ?? false)).length;
  $('clNotesCount').textContent = `${rows.length} shown of ${clNoteRows.length}`
    + (unread ? ` · ${unread} unread` : '');

  host.querySelectorAll('[data-cl-note-row]').forEach(el =>
    el.addEventListener('click', async () => {
      if (!el.classList.contains('unread')) return;
      el.classList.remove('unread');
      const row = clNoteRows.find(n => String(n.id) === el.dataset.clNoteRow);
      if (row) row.is_read = true;
      try {
        await MerchantApi.markNotificationRead(el.dataset.clNoteRow);
        await clLoadUnreadCount();
        clRenderNotes();
      } catch { /* visual only */ }
    }));
}

function clNoteCard(n) {
  const unread = !(n.is_read ?? n.read ?? false);
  const cat = CL_NOTE_CATEGORIES.find(c => c.key === n._cat) || CL_NOTE_CATEGORIES[5];
  const tone = CL_NOTE_TONE[n._cat] || '';
  return `<div class="cl-note${unread ? ' unread' : ''}" data-cl-note-row="${escapeHtml(String(n.id))}"
               role="button" tabindex="0" style="display:flex;gap:14px;align-items:flex-start;">
    <span class="cl-kpi-ico ${tone}" style="width:38px;height:38px;flex-shrink:0;">${clIco(cat.icon)}</span>
    <span style="flex:1;min-width:0;">
      <b>${escapeHtml(n.title || 'Notification')}</b>
      ${escapeHtml(n.message || '')}
      <time>${escapeHtml(fmtDateTime(n.created_at))} · ${escapeHtml(cat.label)}</time>
    </span>
    ${unread ? '<span class="cl-tag cl-tag-accent" style="flex-shrink:0;">New</span>' : ''}
  </div>`;
}
