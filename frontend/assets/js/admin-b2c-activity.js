/* Admin — B2C User Activity (Phase 7 of the B2C Admin Portal build-out)
   ==================================================================
   READ-ONLY view of what B2C customers have done: the audit log (sign-ins,
   failed sign-ins, OTPs, signups, profile changes, bookings, payment attempts)
   and their sign-in sessions.

   NOT SHOWN: the browsing signal behind recommendations (which destinations or
   hotels each person viewed). It was collected to personalise that customer's
   own suggestions, not to be read by the desk — see the service docstring.

   "ACTIVE" MEANS SEEN RECENTLY. A session is active only if it has not signed
   out and was seen in the last few minutes (the server says how many); one that
   never signed out but has gone quiet is Idle. The stored is_active flag alone
   would call every abandoned tab active forever.

   ENDPOINTS (all GET, under /api/admin/user-activity):
     /summary   /logs   /sessions

   Loaded after admin.js and admin-b2c-catalogue-common.js (catErr, catDebounce). */

const ACT_TABS = [['logs', 'Activity Log'], ['sessions', 'Sessions']];
const ACT_STATE_TONE = { active: 'confirmed', idle: 'pending', ended: 'inactive' };

const actState = { tab: 'logs', lPage: 1, lModule: '', lStatus: '', lSearch: '', lFrom: '', lTo: '', sPage: 1, sState: '', sSearch: '' };
let actWired = false;

async function actApi(path, params) {
  const res = await axios.get(`${API_BASE}/api/admin/user-activity${path}`, { headers: authHeaders(), params });
  return res.data;
}
const actWhen = v => v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const actCap = s => String(s).replace(/^./, c => c.toUpperCase());
const actDevice = r => [r.browser, r.device].filter(Boolean).map(escapeHtml).join(' · ') || '—';

async function initB2CActivity() {
  if (!actWired) {
    actWired = true;
    document.getElementById('actTabs').innerHTML = ACT_TABS.map(([k, l]) =>
      `<button type="button" role="tab" class="ops-tab" data-act-tab="${k}">${escapeHtml(l)}</button>`).join('');
    document.getElementById('actTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-act-tab]');
      if (b) actShow(b.dataset.actTab);
    });
    const bind = (id, key, page) => document.getElementById(id).addEventListener('change', e => {
      actState[key] = e.target.value; actState[page] = 1; actLoad();
    });
    bind('actModule', 'lModule', 'lPage'); bind('actStatus', 'lStatus', 'lPage');
    bind('actFrom', 'lFrom', 'lPage'); bind('actTo', 'lTo', 'lPage'); bind('actState', 'sState', 'sPage');
    const searchBind = (id, key, page) => {
      const el = document.getElementById(id);
      el.addEventListener('input', catDebounce(() => { actState[key] = el.value.trim(); actState[page] = 1; actLoad(); }));
    };
    searchBind('actSearch', 'lSearch', 'lPage'); searchBind('actSSearch', 'sSearch', 'sPage');
  }
  loadActivitySummary();
  actShow(actState.tab);
}

function actShow(tab) {
  actState.tab = tab;
  document.querySelectorAll('#actTabs .ops-tab').forEach(b => b.classList.toggle('active', b.dataset.actTab === tab));
  ['logs', 'sessions'].forEach(k => { document.getElementById(`actPane-${k}`).hidden = k !== tab; });
  actLoad();
}
function actLoad() { return (actState.tab === 'logs' ? actLoadLogs : actLoadSessions)(); }

async function loadActivitySummary() {
  const host = document.getElementById('actSummary');
  try {
    const s = await actApi('/summary');
    const modSel = document.getElementById('actModule');
    if (modSel.options.length <= 1) {
      modSel.innerHTML = '<option value="">All modules</option>' +
        s.modules.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    }
    const col = (label, w) => `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span>
      <span class="detail-value">${w.logins} sign-ins · ${w.failed_logins} failed · ${w.signups} signups · ${w.bookings_created} bookings</span></div>`;
    host.innerHTML = `<div class="detail-grid" style="margin-top:0;">
      <div class="detail-item"><span class="detail-label">Active now</span><span class="detail-value" style="font-size:22px;">${s.active_now}</span>
        <span class="cell-sub">customers seen in the last ${s.active_window_minutes} minutes</span></div>
      ${col('Last 24 hours', s.last_24h)}${col('Last 7 days', s.last_7d)}</div>`;
  } catch (err) {
    host.innerHTML = `<p class="empty-state">${escapeHtml(catErr(err, 'Could not load the activity summary.'))}</p>`;
  }
}

async function actLoadLogs(page = actState.lPage) {
  actState.lPage = page;
  const tbody = document.querySelector('#actLogTable tbody');
  tbody.innerHTML = `<tr><td colspan="7">${rowsSkeleton(6)}</td></tr>`;
  try {
    const d = await actApi('/logs', {
      page, page_size: PAGE_SIZE, module: actState.lModule || undefined, status: actState.lStatus || undefined,
      search: actState.lSearch || undefined, date_from: actState.lFrom || undefined, date_to: actState.lTo || undefined,
    });
    document.getElementById('actLogCount').textContent = `${d.total} event${d.total === 1 ? '' : 's'}`;
    tbody.innerHTML = d.items.length ? d.items.map(r => `
      <tr>
        <td>${actWhen(r.at)}</td>
        <td>${r.customer.id
          ? `${escapeHtml(r.customer.name)}<div class="cell-sub">${escapeHtml(r.customer.email)}${r.customer.code ? ` · ${escapeHtml(r.customer.code)}` : ''}</div>`
          : `<span class="cell-sub">No matching account</span>${r.customer.code ? `<div class="cell-sub">${escapeHtml(r.customer.code)}</div>` : ''}`}</td>
        <td>${escapeHtml(r.module || '—')}</td>
        <td><strong>${escapeHtml(r.action)}</strong>${r.description ? `<div class="cell-sub">${escapeHtml(r.description)}</div>` : ''}</td>
        <td><span class="badge ${r.status === 'success' ? 'confirmed' : 'cancelled'}">${escapeHtml(actCap(r.status))}</span></td>
        <td class="mono">${escapeHtml(r.ip_address || '—')}</td>
        <td>${actDevice(r)}</td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No activity matches this filter.</td></tr>`;
    renderPagination('actLogPagination', d.page, d.total_pages, d.total, actLoadLogs);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(catErr(err, 'Failed to load activity.'))}</td></tr>`;
  }
}

async function actLoadSessions(page = actState.sPage) {
  actState.sPage = page;
  const tbody = document.querySelector('#actSessionTable tbody');
  tbody.innerHTML = `<tr><td colspan="7">${rowsSkeleton(6)}</td></tr>`;
  try {
    const d = await actApi('/sessions', {
      page, page_size: PAGE_SIZE, state: actState.sState || undefined, search: actState.sSearch || undefined,
    });
    document.getElementById('actLogCount').textContent = `${d.total} session${d.total === 1 ? '' : 's'}`;
    tbody.innerHTML = d.items.length ? d.items.map(s => `
      <tr>
        <td>${escapeHtml(s.customer_name)}<div class="cell-sub">${escapeHtml(s.customer_email)}</div></td>
        <td>${actWhen(s.login_at)}</td>
        <td>${actWhen(s.last_seen_at)}</td>
        <td>${s.logout_at ? actWhen(s.logout_at) : '<span class="cell-sub">Not signed out</span>'}</td>
        <td><span class="badge ${ACT_STATE_TONE[s.state] || 'pending'}">${escapeHtml(actCap(s.state))}</span></td>
        <td class="mono">${escapeHtml(s.ip_address || '—')}</td>
        <td>${actDevice(s)}</td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No sessions match this filter.</td></tr>`;
    renderPagination('actSessionPagination', d.page, d.total_pages, d.total, actLoadSessions);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(catErr(err, 'Failed to load sessions.'))}</td></tr>`;
  }
}
