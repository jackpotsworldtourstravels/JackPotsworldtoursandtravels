/* Admin — B2C Service Management
   ============================================================================
   The customer-facing service registry: the one catalogue of travel services
   the public storefront offers. Per service, this desk controls:
     • enabled           master on/off (off ⇒ hidden from nav + search/booking rejected)
     • nav_visible        show in the customer service-directory navigation
     • home_visible       show in the homepage service tiles
     • nav_order          display order across nav + homepage
     • maintenance_mode   temporary "down for maintenance" with a message
     • integration_status live | preview | enquiry | coming_soon (honest readiness)
     • provider           supplier/provider label

   Disabling or maintaining a service does NOT touch existing bookings — only
   search and NEW-booking endpoints are gated server-side. This is separate from
   per-merchant B2B service access (merchant_service_access), which is untouched.

   ENDPOINTS (reads need b2c.services.view; writes need b2c.services.manage;
   a super admin holds both):
     GET   /api/admin/services            list
     PATCH /api/admin/services/{code}     update one service (partial)
     POST  /api/admin/services/reorder    set order from a code sequence

   Loaded after admin.js and admin-b2c-catalogue-common.js. */

const SVC_STATUSES = [['live', 'Live'], ['preview', 'Preview'], ['enquiry', 'Enquiry'], ['coming_soon', 'Coming soon']];
const SVC_STATUS_LABEL = { live: 'Live', preview: 'Preview', enquiry: 'Enquiry', coming_soon: 'Coming soon' };
const SVC_STATUS_TONE = { live: 'green', preview: 'amber', enquiry: 'blue', coming_soon: 'indigo' };

const svcState = { rows: [] };
let svcWired = false;
let svcCanManage = false;

async function svcApi(method, path, { data } = {}) {
  const res = await axios({ method, url: `${API_BASE}/api/admin${path}`, headers: authHeaders(), data });
  return res.data;
}

function svcKpi(tone, label, value) {
  return `<div class="b2cd-kpi"><span class="b2cd-kpi-label">${catE(label)}</span>
    <span class="b2cd-kpi-val" style="color:var(--t-${tone});">${value}</span></div>`;
}

async function initB2CServices() {
  if (!svcWired) {
    svcWired = true;
    svcCanManage = adminCan('b2c.services.manage');
    const body = document.getElementById('svcBody');
    if (body) body.addEventListener('click', svcClick);
  }
  loadB2CServices();
}

async function loadB2CServices() {
  const body = document.getElementById('svcBody');
  if (!body) return;
  body.innerHTML = '<p class="cell-sub" style="padding:12px 0;">Loading…</p>';
  try {
    svcState.rows = (await svcApi('get', '/services')) || [];
    body.innerHTML = svcRender();
  } catch (err) {
    body.innerHTML = `<p class="msg error" style="margin:12px 0;">${catE(catErr(err, 'Could not load services.'))}</p>`;
  }
}

function svcStatusBadge(status) {
  const tone = SVC_STATUS_TONE[status] || 'blue';
  return `<span class="badge" style="background:var(--t-${tone}-bg,#eef); color:var(--t-${tone});">${catE(SVC_STATUS_LABEL[status] || status)}</span>`;
}

function svcToggleBtn(row, field, onLabel, offLabel) {
  const on = !!row[field];
  if (!svcCanManage) return `<span class="cell-sub">${on ? onLabel : offLabel}</span>`;
  return `<button class="btn btn-ghost btn-sm" data-svc-toggle="${catE(row.code)}" data-field="${field}" data-next="${on ? '0' : '1'}">${on ? onLabel : offLabel}</button>`;
}

function svcRender() {
  const rows = svcState.rows;
  const enabled = rows.filter(r => r.enabled).length;
  const maint = rows.filter(r => r.maintenance_mode).length;
  const live = rows.filter(r => r.integration_status === 'live').length;

  const kpis = `<div class="b2cd-kpis">
    ${svcKpi('indigo', 'Services', rows.length)}
    ${svcKpi('teal', 'Enabled', enabled)}
    ${svcKpi('amber', 'In maintenance', maint)}
    ${svcKpi('green', 'Live integrations', live)}
  </div>`;

  const body = rows.length ? rows.map((r, i) => {
    const statusCell = `${catPill(r.enabled)}${r.maintenance_mode ? ' <span class="badge" style="background:#f3e2c6;color:#7a5a1f;">Maintenance</span>' : ''}`;
    const moveUp = (svcCanManage && i > 0) ? `<button class="btn btn-ghost btn-sm" data-svc-move="${catE(r.code)}" data-dir="up" title="Move up">↑</button>` : '';
    const moveDown = (svcCanManage && i < rows.length - 1) ? `<button class="btn btn-ghost btn-sm" data-svc-move="${catE(r.code)}" data-dir="down" title="Move down">↓</button>` : '';
    const edit = svcCanManage ? `<button class="btn btn-ghost btn-sm" data-svc-edit="${catE(r.code)}">Edit</button>` : '';
    return `<tr>
      <td><strong>${catE(r.name)}</strong><div class="cell-sub">${catE(r.code)} · <a href="${catE(r.href)}" target="_blank" rel="noopener">${catE(r.href)}</a></div></td>
      <td>${statusCell}</td>
      <td>${svcToggleBtn(r, 'enabled', 'Enabled', 'Disabled')}</td>
      <td>${svcToggleBtn(r, 'nav_visible', 'In nav', 'Hidden')}</td>
      <td>${svcToggleBtn(r, 'home_visible', 'On home', 'Off home')}</td>
      <td>${svcToggleBtn(r, 'maintenance_mode', 'Maintenance', 'Normal')}</td>
      <td>${svcStatusBadge(r.integration_status)}${r.provider ? `<div class="cell-sub">${catE(r.provider)}</div>` : ''}</td>
      <td style="white-space:nowrap;">${moveUp}${moveDown}</td>
      <td style="text-align:right; white-space:nowrap;">${edit}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="cell-sub" style="padding:14px 0; text-align:center;">No services found. Run migration 0102.</td></tr>`;

  const table = `<div class="b2cd-card" style="grid-column:1 / -1;">
    <div class="b2cd-card-head"><span class="b2cd-card-ic tone-indigo">≡</span><h3>Customer-facing services</h3></div>
    <p class="b2cd-note" style="margin:0 0 8px;">Changes take effect immediately. A disabled service disappears from customer navigation and its search / new-booking endpoints reject requests; bookings already made stay reachable.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Service</th><th>Status</th><th>Master</th><th>Navigation</th><th>Homepage</th><th>Maintenance</th><th>Integration</th><th>Order</th><th style="text-align:right;">Edit</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${svcCanManage ? '' : '<p class="b2cd-note" style="color:var(--text-muted);">You have view-only access. Editing requires the <code>b2c.services.manage</code> permission.</p>'}
  </div>`;

  return kpis + `<div class="b2cd-cards" style="margin-top:16px;">${table}</div>`;
}

/* --------------------------------------------------------------- actions */

function svcClick(e) {
  const toggle = e.target.closest('[data-svc-toggle]');
  const move = e.target.closest('[data-svc-move]');
  const edit = e.target.closest('[data-svc-edit]');
  if (toggle) return svcToggle(toggle.dataset.svcToggle, toggle.dataset.field, toggle.dataset.next === '1');
  if (move) return svcMove(move.dataset.svcMove, move.dataset.dir);
  if (edit) return svcEditModal(svcState.rows.find(r => r.code === edit.dataset.svcEdit));
}

async function svcToggle(code, field, value) {
  if (!svcCanManage) return;
  try {
    await svcApi('patch', `/services/${encodeURIComponent(code)}`, { data: { [field]: value } });
    if (typeof showToast === 'function') showToast('Service updated');
    loadB2CServices();
  } catch (err) {
    if (typeof showToast === 'function') showToast(catErr(err, 'Could not update the service.'), true);
  }
}

async function svcMove(code, dir) {
  if (!svcCanManage) return;
  const order = svcState.rows.map(r => r.code);
  const i = order.indexOf(code);
  if (i < 0) return;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  try {
    await svcApi('post', '/services/reorder', { data: { codes: order } });
    loadB2CServices();
  } catch (err) {
    if (typeof showToast === 'function') showToast(catErr(err, 'Could not reorder services.'), true);
  }
}

function svcEditModal(row) {
  if (!svcCanManage || !row) return;
  const body = `
    ${catField('Display name', catInput('svcName', row.name, { attrs: 'maxlength="80"' }))}
    ${catField('Description', catInput('svcDesc', row.description, { attrs: 'maxlength="300"' }))}
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Nav link (href)', catInput('svcHref', row.href, { attrs: 'maxlength="120"' }))}
      ${catField('Icon key', catInput('svcIcon', row.icon, { attrs: 'maxlength="40"' }))}
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Integration status', catSelect('svcStatus', SVC_STATUSES, row.integration_status || 'preview'))}
      ${catField('Provider', catInput('svcProvider', row.provider, { attrs: 'maxlength="80"' }))}
    </div>
    ${catField('Display order', catInput('svcOrder', row.nav_order, { type: 'number', attrs: 'min="0" max="100000"' }))}
    <div style="display:flex; flex-direction:column; gap:8px; margin:4px 0 12px;">
      ${catCheck('svcEnabled', row.enabled, 'Enabled (off removes it from the site and rejects its search/booking)')}
      ${catCheck('svcNav', row.nav_visible, 'Show in customer service navigation')}
      ${catCheck('svcHome', row.home_visible, 'Show in homepage service tiles')}
      ${catCheck('svcMaint', row.maintenance_mode, 'Maintenance mode (temporarily refuse search & new bookings)')}
    </div>
    ${catField('Maintenance message (shown to customers)', catInput('svcMaintMsg', row.maintenance_message, { attrs: 'maxlength="300" placeholder="Optional"' }))}
    <div id="catMsg" class="msg"></div>
    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:8px;">
      <button type="button" class="btn btn-ghost" data-cat-close>Cancel</button>
      <button type="button" class="btn btn-navy" id="svcSave">Save changes</button>
    </div>`;
  const root = catOpenModal(catModalShell(`Edit ${catE(row.name)}`, body));
  if (!root) return;
  document.getElementById('svcSave').addEventListener('click', e => svcEditSubmit(e.currentTarget, row));
}

async function svcEditSubmit(btn, row) {
  const payload = {
    name: catTrim('svcName'),
    description: catTrim('svcDesc') || null,
    href: catTrim('svcHref'),
    icon: catTrim('svcIcon') || null,
    integration_status: catVal('svcStatus'),
    provider: catTrim('svcProvider') || null,
    nav_order: Number(catTrim('svcOrder') || 0),
    enabled: catChecked('svcEnabled'),
    nav_visible: catChecked('svcNav'),
    home_visible: catChecked('svcHome'),
    maintenance_mode: catChecked('svcMaint'),
    maintenance_message: catTrim('svcMaintMsg') || null,
  };
  if (!payload.name) return catMsg('Enter a display name.', true);
  if (!payload.href) return catMsg('Enter a navigation link.', true);

  const result = await catSave(btn, () => svcApi('patch', `/services/${encodeURIComponent(row.code)}`, { data: payload }), 'Service saved');
  if (result) { catCloseModal(); loadB2CServices(); }
}
