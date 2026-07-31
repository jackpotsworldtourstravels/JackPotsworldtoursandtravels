'use strict';
/* Super Admin Portal — Audit Logs.
   GET /api/super-admin/audit-logs (+ /tables for the filter).

   This is a reader over rows the database writes itself: the fn_write_audit_log
   trigger has captured every INSERT/UPDATE/DELETE on users, merchants,
   service_requests and payments since migration 0023. Nothing here writes to
   audit_logs, which is the point — an audit trail the application could edit
   would not be one. */

let saAuditPage = 1;
/* Rows the current page returned, by id, so the detail modal renders from
   what's already loaded instead of re-fetching a single entry. */
const saAuditById = new Map();

function saAuditFilters() {
  return {
    table_name: document.getElementById('saAuditTableFilter').value || undefined,
    operation: document.getElementById('saAuditOpFilter').value || undefined,
    date_from: document.getElementById('saAuditDateFrom').value || undefined,
    date_to: document.getElementById('saAuditDateTo').value || undefined,
  };
}

/* changed_by is currently always NULL: fn_write_audit_log's INSERT doesn't
   populate the column (migration 0023), and nothing sets a session variable
   for it to read. So this renders "Not recorded" rather than "System" —
   "System" would assert the platform made the change, when the truth is that
   attribution simply wasn't captured. Who-did-what lives in the System
   Activity feed instead; see the note on the panel. */
function saAuditRow(e) {
  const who = e.changed_by_name
    ? `${saEscapeHtml(e.changed_by_name)}<br><small style="color:var(--text-muted);">${saEscapeHtml(e.changed_by_email || '')}</small>`
    : '<span style="color:var(--text-muted);" title="The audit trigger does not capture the acting user">Not recorded</span>';
  return `
    <tr>
      <td>${fmtDateTime(e.changed_at)}</td>
      <td>${saEscapeHtml(e.table_name)}</td>
      <td>${e.record_id ?? '—'}</td>
      <td><span class="badge ${saEscapeHtml(e.operation)}">${saEscapeHtml(e.operation)}</span></td>
      <td>${who}</td>
      <td><button class="btn btn-ghost btn-sm" data-sa-audit="${e.id}">View</button></td>
    </tr>`;
}

async function loadSaAuditLogs(page = 1) {
  saAuditPage = page;
  const tbody = document.querySelector('#saAuditTable tbody');
  saTableError(tbody, 6, 'Loading…');

  /* Populate the table filter once, from the tables that actually appear in
     the log rather than a hardcoded list. */
  const tableFilter = document.getElementById('saAuditTableFilter');
  if (tableFilter.options.length <= 1) {
    try {
      const { data } = await axios.get(`${API_BASE}/api/super-admin/audit-logs/tables`,
                                       { headers: saAuthHeaders() });
      tableFilter.innerHTML = '<option value="">All tables</option>' +
        data.tables.map(t => `<option value="${saEscapeHtml(t)}">${saEscapeHtml(t)}</option>`).join('');
    } catch (err) { /* filter just stays at "All tables" */ }
  }

  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/audit-logs`, {
      params: { page, page_size: SA_PAGE_SIZE, ...saAuditFilters() },
      headers: saAuthHeaders(),
    });
    saAuditById.clear();
    data.items.forEach(e => saAuditById.set(String(e.id), e));

    tbody.innerHTML = data.items.length
      ? data.items.map(saAuditRow).join('')
      : '<tr><td colspan="6" class="empty-state">No audit entries match these filters.</td></tr>';
    saRenderPagination('saAuditPagination', data.page, data.total_pages, data.total, loadSaAuditLogs);

    tbody.querySelectorAll('[data-sa-audit]').forEach(btn => {
      btn.addEventListener('click', () => saShowAuditDetail(btn.dataset.saAudit));
    });
  } catch (err) {
    saTableError(tbody, 6, saErrorText(err, 'Failed to load audit logs.'));
  }
}

/* ---------- Detail modal ---------- */
const saAuditDetailModalOverlay = document.getElementById('saAuditDetailModalOverlay');

/* Render one side of the before/after pair, marking the keys that differ so
   a 30-column users row doesn't bury the one field that actually changed. */
function saAuditJson(value, otherValue) {
  if (value == null) return '<pre>—</pre>';
  const other = otherValue || {};
  const lines = Object.keys(value).sort().map(key => {
    const shown = JSON.stringify(value[key]);
    const changed = JSON.stringify(other[key]) !== shown;
    const text = `${saEscapeHtml(key)}: ${saEscapeHtml(shown)}`;
    return changed ? `<span class="sa-audit-changed">${text}</span>` : text;
  });
  return `<pre>${lines.join('\n')}</pre>`;
}

function saShowAuditDetail(id) {
  const e = saAuditById.get(String(id));
  if (!e) return;
  document.getElementById('saAuditDetailTitle').textContent =
    `${e.operation} on ${e.table_name}${e.record_id ? ` #${e.record_id}` : ''}`;
  document.getElementById('saAuditDetailBody').innerHTML = `
    <dl class="sa-kv" style="margin-bottom:18px;">
      <dt>When</dt><dd>${fmtDateTime(e.changed_at)}</dd>
      <dt>Changed by</dt><dd>${e.changed_by_name
        ? `${saEscapeHtml(e.changed_by_name)} (${saEscapeHtml(e.changed_by_email || '')})`
        : 'Not recorded — see Dashboard → Recent System Activity for the acting user'}</dd>
      <dt>Table</dt><dd>${saEscapeHtml(e.table_name)}</dd>
      <dt>Record ID</dt><dd>${e.record_id ?? '—'}</dd>
    </dl>
    <div class="sa-audit-diff">
      <div><h4>Before</h4>${saAuditJson(e.old_value, e.new_value)}</div>
      <div><h4>After</h4>${saAuditJson(e.new_value, e.old_value)}</div>
    </div>`;
  saAuditDetailModalOverlay.classList.add('open');
}

document.getElementById('saAuditDetailCloseBtn')?.addEventListener('click',
  () => saAuditDetailModalOverlay.classList.remove('open'));

/* ---------- Filters ---------- */
['saAuditTableFilter', 'saAuditOpFilter', 'saAuditDateFrom', 'saAuditDateTo'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => loadSaAuditLogs(1));
});
