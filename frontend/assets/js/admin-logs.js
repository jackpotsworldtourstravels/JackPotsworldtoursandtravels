'use strict';
/* Admin Portal — Audit Logs and System Logs.
   =========================================================================
   AUDIT LOGS MOVED HERE FROM THE SUPER ADMIN PORTAL, AND NOTHING SERVER-SIDE
   HAD TO MOVE WITH THEM. Both endpoints live under /api/super-admin/* but are
   gated by PERMISSION, not by role:

     GET /api/super-admin/audit-logs         requires audit.view
     GET /api/super-admin/audit-logs/tables  requires audit.view
     GET /api/super-admin/activity           requires system.activity.view
     GET /api/super-admin/activity/filters   requires system.activity.view

   `_ADMIN` in backend/app/auth/rbac.py already holds both codes (lines 176-ish,
   alongside NOTIFICATION_*), and `router = APIRouter(prefix="/api/super-admin")`
   carries no role dependency of its own. So an Admin session can read these
   today. The URL prefix is now a misnomer rather than a restriction — renaming
   it would break the Super Admin portal's remaining callers for no functional
   gain, so it stays.

   THE TWO SCREENS ARE NOT THE SAME THING, WHICH IS WHY THEY ARE SEPARATE:
   · Audit Logs  — row-level before/after diffs written by the fn_write_audit_log
                   database trigger. Answers "what changed on this record".
   · System Logs — application-level actions written by activity_service.
                   Answers "who did what, from where".
   The audit trigger does not capture the acting user (see below), and the
   activity log does not capture field-level diffs. Each covers the other's
   blind spot, which is why the brief asks for them side by side. */

const ADMIN_LOG_PAGE_SIZE = 25;

/* ==========================================================================
   AUDIT LOGS
   ========================================================================== */

let adminAuditPage = 1;
/* Rows from the current page, by id, so the detail modal renders from what is
   already loaded rather than re-fetching a single entry. */
const adminAuditById = new Map();

function adminAuditFilters() {
  return {
    table_name: document.getElementById('adminAuditTableFilter').value || undefined,
    operation: document.getElementById('adminAuditOpFilter').value || undefined,
    date_from: document.getElementById('adminAuditDateFrom').value || undefined,
    date_to: document.getElementById('adminAuditDateTo').value || undefined,
  };
}

/* `changed_by` is always NULL today: fn_write_audit_log's INSERT never
   populates the column (migration 0023) and nothing sets a session variable
   for it to read. Rendering "System" here would ASSERT that the platform made
   the change when the truth is that attribution was not captured at all — so
   it says so, and points at System Logs, which does record the actor. */
function adminAuditRow(e) {
  const who = e.changed_by_name
    ? `${escapeHtml(e.changed_by_name)}<br><small style="color:var(--text-muted);">${escapeHtml(e.changed_by_email || '')}</small>`
    : '<span style="color:var(--text-muted);" title="The database audit trigger does not capture the acting user — see System Logs">Not recorded</span>';
  return `
    <tr>
      <td>${fmtDateTime(e.changed_at)}</td>
      <td>${escapeHtml(e.table_name)}</td>
      <td>${e.record_id ?? '—'}</td>
      <td><span class="badge ${escapeHtml(e.operation)}">${escapeHtml(e.operation)}</span></td>
      <td>${who}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-admin-audit="${e.id}">View</button></td>
    </tr>`;
}

function adminLogTableMsg(tbody, cols, msg) {
  tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-state">${escapeHtml(msg)}</td></tr>`;
}

async function loadAuditLogs(page = 1) {
  adminAuditPage = page;
  const tbody = document.querySelector('#adminAuditTable tbody');
  adminLogTableMsg(tbody, 6, 'Loading…');

  /* Populate the table filter once, from the tables that actually appear in
     the log rather than a hardcoded list that would drift from the triggers. */
  const tableFilter = document.getElementById('adminAuditTableFilter');
  if (tableFilter.options.length <= 1) {
    try {
      const { data } = await axios.get(`${API_BASE}/api/super-admin/audit-logs/tables`,
                                       { headers: authHeaders() });
      tableFilter.innerHTML = '<option value="">All</option>' +
        data.tables.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    } catch (err) { /* filter stays at "All tables" — not worth failing the screen */ }
  }

  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/audit-logs`, {
      params: { page, page_size: ADMIN_LOG_PAGE_SIZE, ...adminAuditFilters() },
      headers: authHeaders(),
    });
    adminAuditById.clear();
    data.items.forEach(e => adminAuditById.set(String(e.id), e));

    tbody.innerHTML = data.items.length
      ? data.items.map(adminAuditRow).join('')
      : '<tr><td colspan="6" class="empty-state">No audit entries match these filters.</td></tr>';
    renderPagination('adminAuditPagination', data.page, data.total_pages, data.total, loadAuditLogs);

    tbody.querySelectorAll('[data-admin-audit]').forEach(btn => {
      btn.addEventListener('click', () => adminShowAuditDetail(btn.dataset.adminAudit));
    });
  } catch (err) {
    adminLogTableMsg(tbody, 6, err.response?.data?.detail || 'Failed to load audit logs.');
  }
}

/* Render one side of the before/after pair, marking the keys that differ, so a
   30-column users row does not bury the one field that actually changed. */
function adminAuditJson(value, otherValue) {
  if (value == null) return '<pre>—</pre>';
  const other = otherValue || {};
  const lines = Object.keys(value).sort().map(key => {
    const shown = JSON.stringify(value[key]);
    const changed = JSON.stringify(other[key]) !== shown;
    const text = `${escapeHtml(key)}: ${escapeHtml(shown)}`;
    return changed ? `<span class="sa-audit-changed">${text}</span>` : text;
  });
  return `<pre>${lines.join('\n')}</pre>`;
}

function adminShowAuditDetail(id) {
  const e = adminAuditById.get(String(id));
  if (!e) return;
  document.getElementById('adminAuditDetailTitle').textContent =
    `${e.operation} on ${e.table_name}${e.record_id ? ` #${e.record_id}` : ''}`;
  document.getElementById('adminAuditDetailBody').innerHTML = `
    <dl class="jp-kv" style="margin-bottom:18px;">
      <div><dt>When</dt><dd>${fmtDateTime(e.changed_at)}</dd></div>
      <div><dt>Changed by</dt><dd>${e.changed_by_name
        ? `${escapeHtml(e.changed_by_name)} (${escapeHtml(e.changed_by_email || '')})`
        : 'Not recorded — see System Logs for the acting user'}</dd></div>
      <div><dt>Table</dt><dd>${escapeHtml(e.table_name)}</dd></div>
      <div><dt>Record ID</dt><dd>${e.record_id ?? '—'}</dd></div>
    </dl>
    <div class="sa-audit-diff">
      <div><h4>Before</h4>${adminAuditJson(e.old_value, e.new_value)}</div>
      <div><h4>After</h4>${adminAuditJson(e.new_value, e.old_value)}</div>
    </div>`;
  document.getElementById('adminAuditDetailModalOverlay').classList.add('open');
}


/* ==========================================================================
   SYSTEM LOGS
   ========================================================================== */

let adminSysLogPage = 1;

/* THE CONNECTION COLUMN — what replaced "Origin".
   ==========================================================================
   "Origin" was `ip · browser · device` crushed onto one grey line, and for most
   rows it was empty: only the four endpoints in routers/auth.py ever recorded a
   connection, because every other action is logged from a service function that
   has no Request in scope. An HTTP middleware now binds the connection for the
   whole request (app/main.py::request_metadata), so every row has one.

   FOUR FACTS, STACKED, IN THE ORDER SOMEONE READS THEM:
     line 1  the address the request came from (public where a proxy forwarded
             one), with the LAN address beside it when one was visible
     line 2  the operating system, with its version where the client told us
     line 3  the browser and its major version
     line 4  the device type

   NOTHING HERE IS A PLACEHOLDER. Windows froze its User-Agent at "NT 10.0", so
   Windows 10 and 11 are only distinguishable from the client hints the server
   asks for via `Accept-CH`; Firefox and Safari send none of them. When a fact
   was not reported, its line is omitted — an absent OS is honest, an invented
   one is not. A row with nothing at all says so once, in words. */
function adminSysLogConnection(l) {
  /* "Other" IS NOT A VALUE, IT IS A SENTINEL — the parser wrote it until
     2026-08-06 for anything it could not identify, and rows from before then
     still carry it. Printed, it reads as a browser called Other; dropped, the
     line is simply absent, which is what "we do not know" looks like. */
  const real = v => (v && v !== 'Other' ? v : null);
  const lines = [];
  if (l.ip_address) {
    lines.push(`<span class="sl-ip">${escapeHtml(l.ip_address)}</span>${l.local_ip
      ? ` <span class="sl-local" title="LAN address reported by a proxy">· local ${escapeHtml(l.local_ip)}</span>`
      : ''}`);
  }
  [real(l.os), real(l.browser), real(l.device)]
    .filter(Boolean).forEach(v => lines.push(escapeHtml(v)));
  if (!lines.length) return '<span class="sl-none">Not recorded</span>';
  return `<div class="sl-conn">${lines.map(x => `<span>${x}</span>`).join('')}</div>`;
}

function adminSysLogRow(l) {
  const ok = (l.status || '').toLowerCase();
  const badge = ok === 'success' ? 'active' : (ok === 'failed' || ok === 'failure' ? 'suspended' : 'inactive');
  return `
    <tr>
      <td>${fmtDateTime(l.created_at)}</td>
      <td>${escapeHtml(l.user_name || 'System')}${l.user_email
        ? `<br><small style="color:var(--text-muted);">${escapeHtml(l.user_email)}</small>` : ''}</td>
      <td>${escapeHtml(l.module || '—')}</td>
      <td>${escapeHtml(l.action || '—')}</td>
      <td class="jp-truncate" title="${escapeHtml(l.description || '—')}">${escapeHtml(l.description || '—')}</td>
      <td>${adminSysLogConnection(l)}</td>
      <td>${l.status ? `<span class="badge ${badge}">${escapeHtml(statusLabel(l.status))}</span>` : '—'}</td>
    </tr>`;
}

async function loadSystemLogs(page = 1) {
  adminSysLogPage = page;
  const tbody = document.querySelector('#adminSysLogTable tbody');
  adminLogTableMsg(tbody, 7, 'Loading…');

  /* Action and module choices come from the rows that exist, once. */
  const actionSel = document.getElementById('adminSysLogActionFilter');
  const moduleSel = document.getElementById('adminSysLogModuleFilter');
  if (actionSel.options.length <= 1) {
    try {
      const { data } = await axios.get(`${API_BASE}/api/super-admin/activity/filters`,
                                       { headers: authHeaders() });
      actionSel.innerHTML = '<option value="">All</option>' +
        (data.actions || []).map(a => `<option value="${escapeHtml(a)}">${escapeHtml(statusLabel(a))}</option>`).join('');
      moduleSel.innerHTML = '<option value="">All</option>' +
        (data.modules || []).map(m => `<option value="${escapeHtml(m)}">${escapeHtml(statusLabel(m))}</option>`).join('');
    } catch (err) { /* both stay at "All" */ }
  }

  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/activity`, {
      params: {
        page, page_size: ADMIN_LOG_PAGE_SIZE,
        search: document.getElementById('adminSysLogSearch').value.trim() || undefined,
        action: actionSel.value || undefined,
        module: moduleSel.value || undefined,
      },
      headers: authHeaders(),
    });
    tbody.innerHTML = data.items.length
      ? data.items.map(adminSysLogRow).join('')
      : '<tr><td colspan="7" class="empty-state">No system activity matches these filters.</td></tr>';
    renderPagination('adminSysLogPagination', data.page, data.total_pages, data.total, loadSystemLogs);
  } catch (err) {
    adminLogTableMsg(tbody, 7, err.response?.data?.detail || 'Failed to load system logs.');
  }
}


/* ==========================================================================
   WIRING
   ==========================================================================
   Every listener is optional-chained. These controls live in sections that
   only exist in the Admin Portal's markup, and this file is loaded by a page
   that may render a subset during a partial deploy. */

['adminAuditTableFilter', 'adminAuditOpFilter', 'adminAuditDateFrom', 'adminAuditDateTo']
  .forEach(id => document.getElementById(id)?.addEventListener('change', () => loadAuditLogs(1)));

document.getElementById('adminAuditDetailCloseBtn')?.addEventListener('click',
  () => document.getElementById('adminAuditDetailModalOverlay').classList.remove('open'));

['adminSysLogActionFilter', 'adminSysLogModuleFilter']
  .forEach(id => document.getElementById(id)?.addEventListener('change', () => loadSystemLogs(1)));

/* Debounced so a typed query is one request, not one per keystroke. */
let adminSysLogSearchTimer;
document.getElementById('adminSysLogSearch')?.addEventListener('input', () => {
  clearTimeout(adminSysLogSearchTimer);
  adminSysLogSearchTimer = setTimeout(() => loadSystemLogs(1), 300);
});
