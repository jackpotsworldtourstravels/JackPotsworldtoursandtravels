'use strict';
/* Operations Portal — Reports and System Logs.
   ===========================================================================
   REPORTS
   There is no aggregation endpoint for bookings. `GET /api/reports/export`
   produces a file (csv via the stdlib, xlsx via openpyxl, pdf via reportlab)
   over up to 5000 rows, and `GET /api/requests` produces the on-screen list.
   That is the whole reporting surface, plus one genuine rollup:
   `GET /api/super-admin/reports/summary`, which is per-merchant totals computed
   server-side and is role-gated to admin/super admin.

   So on-screen totals here are summed IN THE BROWSER over the rows on screen,
   and every total says so. That distinction is not pedantry: a client-side sum
   over one page of a nine-page result set is not a statement of account, and
   labelling it "Total revenue" would make this screen lie. Where the whole
   figure matters, the export button is the honest answer, because the server
   computes it over the entire filtered set.

   SYSTEM LOGS
   Two different logs, and the difference matters:
     Activity  — what people DID (system_logs). Searchable, filterable by
                 action and module. Requires system.activity.view.
     Audit     — what CHANGED, row by row, with before/after JSONB
                 (audit_logs). Requires audit.view. No search parameter.
   Both codes belong to ADMIN as well as super admin, so this is not a
   super-admin-only screen.
   =========================================================================== */

function opsInitReports() {
  const host = $('ops-reports');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Reports</h1>
        <p>Filter on screen, export the whole filtered set as CSV, Excel or PDF.</p>
      </div>
    </div>
    <div id="opsReportsTabs"></div>`;

  OpsTabs($('opsReportsTabs'), [
    /* Gated on ticket.view, not report.view — report.view holds no actual
       endpoint in this API (reports.export requires only report.export), and
       the on-screen list these tabs render is GET /api/requests, which needs
       ticket.view. Super Admin holds report.view but NOT ticket.view, so
       gating on report.view alone showed a tab that 403'd the moment it
       loaded — caught by driving this screen as super_admin. */
    { id: 'bookings', label: 'Bookings', when: opsCan('ticket.view'),
      render: body => opsBookingReport(body) },
    { id: 'service', label: 'Service requests', when: opsCan('ticket.view'),
      render: body => opsServiceReport(body) },
    { id: 'payments', label: 'Payments', when: opsCan('report.export'),
      render: body => opsPaymentReport(body) },
    { id: 'merchants', label: 'Per-merchant summary', when: opsIsStaff(),
      render: body => opsGlobalSummary(body) },
  ], { hash: 'reports' });
}

/* A strip under a grid describing the rows in hand.

   M4: the "Value shown" tile is gone. It summed `total_amount` across one page
   in JavaScript floats, which is neither the period's value nor anyone's
   position — and money on this platform comes from finance_service alone. Row
   counts are not money and stay. */
function opsTotalsStrip(rows, total, extras) {
  const partial = total > rows.length;
  return `
    <div class="ops-panel">
      <div class="ops-panel-head"><h2>Totals for the rows on screen</h2></div>
      <div class="ops-panel-body">
        <div class="ops-kpis">
          ${opsKpi({ label: 'Rows shown', value: rows.length, sub: partial ? `of ${total} matching` : 'all matches' })}
          ${opsKpi({ label: 'Average', value: rows.length ? money(sum / rows.length) : '—', sub: 'per row shown' })}
          ${extras || ''}
        </div>
      </div>
      ${partial ? `<div class="ops-panel-note">
        <b>These are page totals, not report totals.</b> ${total} rows match the current filters and
        ${rows.length} are on screen, so the value above covers only what is displayed. There is no
        totals endpoint — for a figure over the whole filtered set, use <b>CSV</b>, <b>Excel</b> or
        <b>PDF</b>, which the server builds over every matching row.
      </div>` : `<div class="ops-panel-note">
        Every matching row is on screen, so these totals cover the full filtered set.
      </div>`}
    </div>`;
}

function opsBookingReport(host) {
  host.innerHTML = '<div id="opsRepBkGrid"></div><div id="opsRepBkTotals"></div>';
  const grid = opsBuildRequestGrid($('opsRepBkGrid'), {
    id: 'rep-bookings',
    title: 'Booking report',
    exportName: 'bookings-report',
    fixed: { request_type: 'booking' },
    showTypeColumn: false,
    bulk: false,
    note: `<b>Travel from / to filter the travel date</b>, not the date a booking was raised —
      the same parameters reach <code>service_requests.travel_date</code> in both the list and the
      export, so the file and the table always describe the same rows. Exports cover the whole
      filtered set (up to 5000 rows), not just this page.`,
  });
  /* Hook the totals strip onto the grid's own load cycle. */
  const g = grid.state;
  const paint = () => { $('opsRepBkTotals').innerHTML = opsTotalsStrip(g.rows, g.total); };
  const origOnLoad = g.onLoad;
  g.onLoad = (...a) => { origOnLoad?.(...a); paint(); };
  paint();
  return grid;
}

function opsServiceReport(host) {
  host.innerHTML = '<div id="opsRepSrGrid"></div><div id="opsRepSrTotals"></div>';
  const grid = opsBuildRequestGrid($('opsRepSrGrid'), {
    id: 'rep-service',
    title: 'Service request report',
    exportName: 'service-requests-report',
    filterDefaults: { request_type: 'cancellation' },
    serverExportType: 'service_requests',
    bulk: false,
    note: `The list endpoint filters one <code>request_type</code> at a time, so pick a type above.
      The <b>export</b> is different and better: the server's service-request report walks every
      change-request type in one file, regardless of the type selected here.`,
  });
  const g = grid.state;
  const paint = () => { $('opsRepSrTotals').innerHTML = opsTotalsStrip(g.rows, g.total); };
  const orig = g.onLoad;
  g.onLoad = (...a) => { orig?.(...a); paint(); };
  paint();
  return grid;
}

/* The payments report is export-only: reports._payment_rows honours date and
   merchant, ignores status and search, and there is no merchant-scoped payment
   list endpoint to render on screen. So this is a form that builds a file,
   which is what the endpoint actually is — not a table pretending to be one. */
function opsPaymentReport(host) {
  host.innerHTML = `
    <div class="ops-panel">
      <div class="ops-panel-head"><h2>Payment report</h2></div>
      <div class="ops-panel-body">
        <div class="ops-form ops-form-2">
          <div class="ops-field"><label for="opsPrFrom">Created from</label>
            <input type="date" id="opsPrFrom"></div>
          <div class="ops-field"><label for="opsPrTo">Created to</label>
            <input type="date" id="opsPrTo"></div>
          ${opsIsStaff() ? `<div class="ops-field"><label for="opsPrMerchant">Merchant ID</label>
            <input type="number" id="opsPrMerchant" placeholder="all merchants"></div>` : ''}
          <div class="ops-field"><label for="opsPrFormat">Format</label>
            <select id="opsPrFormat">
              <option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option><option value="pdf">PDF</option>
            </select></div>
        </div>
        <div class="ops-form-actions">
          <button type="button" class="ops-btn ops-btn-primary" id="opsPrGo">Download report</button>
          ${opsCan('payment.view') && opsIsStaff() ? '<button type="button" class="ops-btn" id="opsPrLedger">Open the payment ledger</button>' : ''}
        </div>
        <div class="ops-msg" id="opsPrMsg"></div>
      </div>
      <div class="ops-panel-note">
        Columns: transaction id, method, amount, currency, status, paid date — for
        ${escapeHtml(opsIsStaff() ? 'every merchant, or one merchant if an ID is given' : 'your company only')}.
        The dates filter the payment's <b>created</b> date. This report deliberately offers no
        status filter because the endpoint ignores one.
      </div>
    </div>`;

  $('opsPrLedger')?.addEventListener('click', () => opsGo('payments'));
  $('opsPrGo').addEventListener('click', async () => {
    const msg = $('opsPrMsg');
    const format = $('opsPrFormat').value;
    const params = { type: 'payments', format };
    if ($('opsPrFrom').value) params.date_from = $('opsPrFrom').value;
    if ($('opsPrTo').value) params.date_to = $('opsPrTo').value;
    const mid = $('opsPrMerchant')?.value;
    if (mid) params.merchant_id = Number(mid);
    if (params.date_from && params.date_to && params.date_to < params.date_from) {
      return opsMsg(msg, 'The "to" date is before the "from" date.', 'err');
    }
    $('opsPrGo').disabled = true;
    opsMsg(msg, 'Building the report…', 'muted');
    try {
      const blob = await OpsApi.exportReport(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payments-report-${opsToday()}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      opsMsg(msg, 'Downloaded.', 'ok');
    } catch (err) {
      opsMsg(msg, opsError(err, 'The report could not be built.'), 'err');
    } finally {
      $('opsPrGo').disabled = false;
    }
  });
}

/* The one real server-side rollup in the API. */
function opsGlobalSummary(host) {
  host.innerHTML = '<div id="opsGsGrid"></div>';
  return OpsGrid({
    id: 'rep-merchants',
    mount: $('opsGsGrid'),
    title: 'Per-merchant summary',
    exportName: 'merchant-summary',
    mode: 'client',
    searchable: true,
    searchPlaceholder: 'Company or code…',
    filters: [
      { key: 'status', label: 'Status', type: 'select', anyLabel: 'Any status',
        options: OPS_MERCHANT_STATUSES.map(s => ({ value: s, label: opsLabel(s) })),
        match: (r, v) => r.status === v },
    ],
    columns: [
      OpsCol.ref('merchant_code', 'Code'),
      { key: 'company_name', label: 'Company' },
      OpsCol.status(),
      { key: 'total_requests', label: 'Requests', align: 'right' },
      { key: 'completed_requests', label: 'Completed', align: 'right' },
      { key: 'completion', label: 'Completion', align: 'right', nowrap: true,
        render: r => (r.total_requests
          ? `${Math.round((r.completed_requests / r.total_requests) * 100)}%`
          : '<span class="ops-muted">—</span>'),
        sortValue: r => (r.total_requests ? r.completed_requests / r.total_requests : -1),
        text: r => (r.total_requests ? String(Math.round((r.completed_requests / r.total_requests) * 100)) : '') },
      OpsCol.money('total_revenue', 'Revenue'),
      { key: 'user_count', label: 'Users', align: 'right' },
      OpsCol.actions([{ act: 'open', label: 'Open', when: () => opsCan('merchant.view') }]),
    ],
    note: `<b>Computed server-side over every merchant</b> — this is the one genuine rollup in the
      API, so unlike the other report tabs these figures are complete rather than page totals.
      Revenue is the merchant's completed-request value as the backend calculates it.`,
    emptyText: 'No merchants to summarise.',
    fetch: async () => {
      const d = await OpsApi.globalSummary();
      const rows = (d.merchants || []).map(m => ({ ...m, id: m.merchant_id }));
      return { rows, total: rows.length };
    },
    actions: { open: row => opsOpenMerchant(row.merchant_id) },
    onLoad: (res, api) => {
      const rows = res.rows || [];
      const head = opsEl('.ops-panel-tools', host);
      if (head) {
        /* Request count is a count and is summed here. Revenue is money and is
           not: a float total of one page of merchants is not a revenue figure.
           Per-merchant revenue is on each row, from the server. */
        const req = rows.reduce((s, r) => s + Number(r.total_requests || 0), 0);
        head.innerHTML = `<span class="ops-grid-count">${rows.length} merchants · ${req} requests</span>`;
      }
    },
  });
}

/* ===========================================================================
   SYSTEM LOGS
   =========================================================================== */

function opsInitLogs() {
  const host = $('ops-logs');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>System Logs</h1>
        <p>What people did, and what changed.</p>
      </div>
    </div>
    <div id="opsLogsTabs"></div>`;

  OpsTabs($('opsLogsTabs'), [
    { id: 'activity', label: 'Activity', when: opsCan('system.activity.view'),
      render: body => opsActivityGrid(body) },
    { id: 'audit', label: 'Audit trail', when: opsCan('audit.view'),
      render: body => opsAuditGrid(body) },
    { id: 'system', label: 'System configuration', when: opsCan('system.activity.view'),
      render: body => opsSystemInfo(body) },
  ], { hash: 'logs' });
}

async function opsActivityGrid(host) {
  /* Fetch the distinct actions and modules first so the filters are real
     options rather than a free-text guess at what the log contains. */
  let opts = { actions: [], modules: [] };
  try { opts = await OpsApi.activityFilters(); } catch { /* filters degrade to text */ }

  return OpsGrid({
    id: 'log-activity',
    mount: host,
    title: 'Activity log',
    exportName: 'activity-log',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'User, description, IP…',
    filters: [
      { key: 'action', label: 'Action', type: 'select', anyLabel: 'Any action',
        options: (opts.actions || []).map(a => ({ value: a, label: a })) },
      { key: 'module', label: 'Module', type: 'select', anyLabel: 'Any module',
        options: (opts.modules || []).map(m => ({ value: m, label: m })) },
    ],
    columns: [
      OpsCol.dateTime('created_at', 'When'),
      { key: 'user_name', label: 'User' },
      { key: 'user_email', label: 'Email', hidden: true },
      { key: 'module', label: 'Module' },
      { key: 'action', label: 'Action' },
      { key: 'description', label: 'Detail' },
      { key: 'status', label: 'Result', nowrap: true,
        render: r => (r.status === 'failed'
          ? '<span class="ops-tag ops-tag-err">Failed</span>'
          : `<span class="ops-tag ops-tag-ok">${escapeHtml(opsLabel(r.status) || 'OK')}</span>`),
        text: r => r.status || '' },
      { key: 'ip_address', label: 'IP', nowrap: true, hidden: true },
      { key: 'browser', label: 'Browser', hidden: true },
      { key: 'device', label: 'Device', hidden: true },
    ],
    note: `Every recorded action, newest first — including <b>failed sign-in attempts</b>, which
      are logged with no user attached and a <code>failed</code> result. Turn on the IP, Browser
      and Device columns from the Columns menu when investigating one.`,
    emptyText: 'No activity matches these filters.',
    fetch: async ({ page, pageSize, search, filters: f }) => {
      const params = { page, page_size: pageSize };
      if (search) params.search = search;
      if (f.action) params.action = f.action;
      if (f.module) params.module = f.module;
      const d = await OpsApi.activityLog(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
  });
}

async function opsAuditGrid(host) {
  let tables = [];
  try { tables = (await OpsApi.auditTables()).tables || []; } catch { /* degrade */ }

  return OpsGrid({
    id: 'log-audit',
    mount: host,
    title: 'Audit trail',
    exportName: 'audit-trail',
    mode: 'server',
    searchable: false,   /* the endpoint has no search parameter */
    filters: [
      { key: 'table_name', label: 'Table', type: 'select', anyLabel: 'Any table',
        options: tables.map(t => ({ value: t, label: t })) },
      { key: 'operation', label: 'Operation', type: 'select', anyLabel: 'Any',
        options: ['INSERT', 'UPDATE', 'DELETE'].map(o => ({ value: o, label: o })) },
      { key: 'changed_by', label: 'User ID', type: 'number', placeholder: 'any' },
      { key: 'date_from', label: 'From', type: 'date' },
      { key: 'date_to', label: 'To', type: 'date' },
    ],
    columns: [
      OpsCol.dateTime('changed_at', 'When'),
      { key: 'table_name', label: 'Table', nowrap: true },
      { key: 'record_id', label: 'Row ID', align: 'right' },
      { key: 'operation', label: 'Operation', nowrap: true,
        render: r => {
          const tone = r.operation === 'DELETE' ? 'err' : r.operation === 'INSERT' ? 'ok' : 'info';
          return `<span class="ops-tag ops-tag-${tone} ops-tag-sq">${escapeHtml(r.operation)}</span>`;
        },
        text: r => r.operation },
      { key: 'changed_by_name', label: 'Changed by', value: r => r.changed_by_name || (r.changed_by ? `user ${r.changed_by}` : 'system') },
      { key: 'changed_by_email', label: 'Email', hidden: true },
      { key: 'summary', label: 'Fields changed', value: r => opsAuditSummary(r) },
      OpsCol.actions([{ act: 'diff', label: 'Before / after', primary: true }]),
    ],
    note: `Row-level history from the database triggers, so it records what changed even when the
      change did not come through the API. <b>Filter by user ID rather than by name</b> — the
      endpoint takes <code>changed_by</code> as an integer, and a row written by a trigger with no
      session behind it shows as <b>system</b>.`,
    emptyText: 'No audit entries match these filters.',
    fetch: async ({ page, pageSize, filters: f }) => {
      const params = { page, page_size: pageSize };
      if (f.table_name) params.table_name = f.table_name;
      if (f.operation) params.operation = f.operation;
      if (f.changed_by) params.changed_by = Number(f.changed_by);
      if (f.date_from) params.date_from = f.date_from;
      if (f.date_to) params.date_to = f.date_to;
      const d = await OpsApi.auditLogs(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: { diff: row => opsAuditDiff(row) },
    onRow: row => opsAuditDiff(row),
  });
}

/* Which keys actually differ between old and new — the single most useful thing
   about an audit row, and it is not a field the API returns. */
function opsAuditChangedKeys(r) {
  const a = r.old_value || {};
  const b = r.new_value || {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function opsAuditSummary(r) {
  if (r.operation === 'INSERT') return `created (${Object.keys(r.new_value || {}).length} fields)`;
  if (r.operation === 'DELETE') return 'row removed';
  const keys = opsAuditChangedKeys(r);
  return keys.length ? keys.slice(0, 6).join(', ') + (keys.length > 6 ? ` +${keys.length - 6} more` : '') : 'no field differences';
}

function opsAuditDiff(r) {
  const keys = opsAuditChangedKeys(r);
  const a = r.old_value || {};
  const b = r.new_value || {};
  const fmt = v => (v === undefined ? '—' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

  opsOpenModal(`${r.table_name} #${r.record_id ?? '—'} — ${r.operation}`, `
    <dl class="ops-dl ops-dl-rows" style="margin-bottom:10px">
      <div><dt>When</dt><dd>${escapeHtml(fmtDateTime(r.changed_at))}</dd></div>
      <div><dt>Changed by</dt><dd>${escapeHtml(r.changed_by_name || (r.changed_by ? `user ${r.changed_by}` : 'system / trigger'))}
        ${r.changed_by_email ? `<span class="ops-muted">· ${escapeHtml(r.changed_by_email)}</span>` : ''}</dd></div>
    </dl>
    ${keys.length ? `
      <div class="ops-table-wrap"><table class="ops-table">
        <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
        <tbody>${keys.map(k => `<tr>
          <td><b>${escapeHtml(k)}</b></td>
          <td class="ops-mono">${escapeHtml(fmt(a[k]))}</td>
          <td class="ops-mono">${escapeHtml(fmt(b[k]))}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div class="ops-empty">No field-level differences were recorded.</div>'}
    <details style="margin-top:10px">
      <summary style="cursor:pointer;font-size:11.5px">Raw before / after</summary>
      <div class="ops-cols-2" style="margin-top:6px">
        <div><div class="ops-kpi-label">Before</div><pre class="ops-json">${escapeHtml(JSON.stringify(a, null, 2))}</pre></div>
        <div><div class="ops-kpi-label">After</div><pre class="ops-json">${escapeHtml(JSON.stringify(b, null, 2))}</pre></div>
      </div>
    </details>`,
    '<span class="ops-spacer"></span><button type="button" class="ops-btn ops-btn-primary" id="opsAudClose">Close</button>',
    { wide: true });
  $('opsAudClose').addEventListener('click', opsCloseModal);
}

async function opsSystemInfo(host) {
  host.innerHTML = opsSpinner('Reading configuration…');
  try {
    const s = await OpsApi.systemInfo();
    const a = s.auth || {};
    const c = s.communication || {};
    host.innerHTML = `
      <div class="ops-cols-2">
        <div class="ops-panel">
          <div class="ops-panel-head"><h2>Platform</h2></div>
          <div class="ops-panel-body"><dl class="ops-dl ops-dl-rows">
            <div><dt>Schema version</dt><dd class="ops-mono">${escapeHtml(s.schema_version || '—')}</dd></div>
            <div><dt>Debug mode</dt><dd>${s.debug_mode
              ? '<span class="ops-tag ops-tag-warn">On</span>' : '<span class="ops-tag ops-tag-ok">Off</span>'}</dd></div>
            <div><dt>Allowed origins</dt><dd class="ops-mono">${escapeHtml((s.cors_origins || []).join(', ') || '—')}</dd></div>
            <div><dt>Frontend base URL</dt><dd class="ops-mono">${escapeHtml(c.frontend_base_url || '—')}</dd></div>
          </dl></div>
        </div>
        <div class="ops-panel">
          <div class="ops-panel-head"><h2>Sessions &amp; codes</h2></div>
          <div class="ops-panel-body"><dl class="ops-dl ops-dl-rows">
            <div><dt>Token algorithm</dt><dd class="ops-mono">${escapeHtml(a.jwt_algorithm || '—')}</dd></div>
            <div><dt>Access token life</dt><dd>${escapeHtml(String(a.access_token_expire_minutes))} minutes</dd></div>
            <div><dt>Refresh token life</dt><dd>${escapeHtml(String(a.refresh_token_expire_days))} days</dd></div>
            <div><dt>Reset link life</dt><dd>${escapeHtml(String(a.reset_token_expire_minutes))} minutes</dd></div>
            <div><dt>OTP life</dt><dd>${escapeHtml(String(a.otp_ttl_minutes))} minutes</dd></div>
            <div><dt>OTP attempts allowed</dt><dd>${escapeHtml(String(a.otp_max_verify_attempts))}</dd></div>
            <div><dt>OTP requests per hour</dt><dd>${escapeHtml(String(a.otp_max_requests_per_hour))}</dd></div>
          </dl></div>
        </div>
      </div>
      <div class="ops-panel">
        <div class="ops-panel-head"><h2>Email delivery</h2></div>
        <div class="ops-panel-body"><dl class="ops-dl">
          <div><dt>OTP delivery</dt><dd>${escapeHtml(c.otp_delivery_mode || '—')}</dd></div>
          <div><dt>SMTP configured</dt><dd>${c.smtp_configured
            ? '<span class="ops-tag ops-tag-ok">Yes</span>' : '<span class="ops-tag ops-tag-warn">No</span>'}</dd></div>
          <div><dt>SMTP host</dt><dd class="ops-mono">${escapeHtml(c.smtp_host || '—')}</dd></div>
          <div><dt>From name</dt><dd>${escapeHtml(c.smtp_from_name || '—')}</dd></div>
        </dl></div>
        ${!c.smtp_configured ? `<div class="ops-panel-note">
          SMTP is not configured, so one-time codes are <b>returned in the sign-in response and
          shown on screen</b> instead of being emailed. That is a deployment setting, not a portal
          setting — it cannot be changed from here.
        </div>` : ''}
      </div>
      <div class="ops-panel">
        <div class="ops-panel-head"><h2>Read-only</h2></div>
        <div class="ops-panel-note" style="border-top:none">
          This is <code>GET /api/super-admin/system-info</code>, which has no write counterpart.
          These values come from the server's environment; changing them means changing the
          deployment.
        </div>
      </div>`;
  } catch (err) {
    host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not read the configuration.'))}</div>
    </div></div>`;
  }
}
