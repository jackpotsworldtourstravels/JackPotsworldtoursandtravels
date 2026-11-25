/* Admin — B2C Offers & Coupons
   ============================================================================
   Single-page dashboard (matches the approved mockup): KPI row, an inline
   Create/Edit coupon form on the left, Share & promote + Show-on-website +
   Validated-at-checkout cards on the right, and the Active coupons table below.

   Every row is a `customer_coupons` record; the public booking flow is what
   applies and prices them (this desk never prices anything). Create generates a
   unique code, sets the discount, targets it (product, airline, domestic/
   international), caps its usage, and decides whether the public Offers page
   advertises it.

   ENDPOINTS (all require b2c.coupons.manage; a super admin holds it):
     GET    /api/admin/coupons                 paged list + per-status counts
     POST   /api/admin/coupons/generate-code   a fresh unique code
     POST   /api/admin/coupons                  create
     PATCH  /api/admin/coupons/{id}             edit (code is immutable)
     DELETE /api/admin/coupons/{id}             soft-deactivate

   Loaded after admin.js and admin-b2c-catalogue-common.js, whose field builders,
   formatters and error formatter it reuses. */

const CPN_APPLIES = [['', 'All'], ['flight', 'Flights'], ['hotel', 'Hotels'], ['package', 'Tour Packages']];
const CPN_PRODUCT_LABEL = { flight: 'Flights', hotel: 'Hotels', package: 'Tour Packages' };

let cpnWired = false;
let cpnCanManage = false;
let cpnList = [];
let cpnCache = {};
let cpnQuery = '';       // the Active-coupons search box text
let cpnEditing = null;   // the coupon being edited, or null for a new one

async function cpnApi(method, path = '', { params, data } = {}) {
  const res = await axios({ method, url: `${API_BASE}/api/admin/coupons${path}`, headers: authHeaders(), params, data });
  return res.data;
}

const cpnRupee = v => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const cpnNum = v => Number(v || 0).toLocaleString('en-IN');

const CPN_IC = {
  ticket: '<path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z"/><path d="M13 7v10"/>',
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
  coins: '<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v6c0 1.7 2.7 3 6 3s6-1.3 6-3V6"/><path d="M21 10v4c0 1.7-2.7 3-6 3-1 0-2-.1-2.8-.3"/><path d="M15 10c2.9 0 6-1 6-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M15 9h0M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
};
const cpnIcon = n => `<svg class="icon" viewBox="0 0 24 24">${CPN_IC[n] || ''}</svg>`;

function cpnDiscountText(c) {
  if (c.discount_type === 'percent') {
    const pct = `${Number(c.discount_value)}%`;
    return c.max_discount ? `${pct} (up to ${cpnRupee(c.max_discount)})` : pct;
  }
  return `${cpnRupee(c.discount_value)} off`;
}
function cpnScopeHtml(c) {
  const bits = [`<span class="badge">${catE(CPN_PRODUCT_LABEL[c.product_type] || 'All products')}</span>`];
  if (c.product_type === 'flight' || c.product_type == null) {
    if (c.airline) bits.push(`<span class="badge">✈ ${catE(c.airline)}</span>`);
    if (c.international_only === true) bits.push('<span class="badge">International</span>');
    else if (c.international_only === false) bits.push('<span class="badge">Domestic</span>');
  }
  return bits.join(' ');
}
function cpnValidity(c) {
  if (!c.valid_from && !c.valid_to) return 'No expiry';
  return `${c.valid_from ? catDate(c.valid_from) : 'now'} – ${c.valid_to ? catDate(c.valid_to) : 'no end'}`;
}
const cpnUsage = c => c.usage_limit ? `${cpnNum(c.times_used)} / ${cpnNum(c.usage_limit)}` : `${cpnNum(c.times_used)} / ∞`;

function cpnKpi(icon, tone, label, value) {
  return `<div class="b2cd-kpi"><span class="b2cd-kpi-ic tone-${tone}">${cpnIcon(icon)}</span>
    <span class="b2cd-kpi-label">${catE(label)}</span><span class="b2cd-kpi-val">${value}</span></div>`;
}

/* Pill-toggle group: an on/off row of buttons (reuses .btn-navy / .btn-ghost). */
function cpnPills(group, options, active) {
  return `<div style="display:flex; gap:6px; flex-wrap:wrap;">${options.map(([v, l]) =>
    `<button type="button" class="btn btn-sm ${String(v) === String(active) ? 'btn-navy' : 'btn-ghost'}" data-pill-group="${group}" data-pill="${catE(v)}">${catE(l)}</button>`).join('')}</div>`;
}
function cpnActivePill(group) {
  const el = document.querySelector(`[data-pill-group="${group}"].btn-navy`);
  return el ? el.dataset.pill : '';
}

/* ---------------------------------------------------------- render pieces */

function cpnKpisHtml() {
  const redemptions = cpnList.reduce((n, c) => n + Number(c.times_used || 0), 0);
  const active = cpnList.filter(c => c.is_active).length;
  const today = new Date(); const in7 = new Date(); in7.setDate(today.getDate() + 7);
  const expiring = cpnList.filter(c => c.is_active && c.valid_to && new Date(c.valid_to) >= today && new Date(c.valid_to) <= in7).length;
  const given = cpnList.reduce((s, c) => s + (c.discount_type === 'flat' ? Number(c.discount_value || 0) * Number(c.times_used || 0) : 0), 0);
  return `<div class="b2cd-kpis">
    ${cpnKpi('ticket', 'blue', 'Active coupons', cpnNum(active))}
    ${cpnKpi('coins', 'green', 'Redemptions', cpnNum(redemptions))}
    ${cpnKpi('coins', 'teal', 'Discount given', `<span style="font-size:17px;">${cpnRupee(given)}</span>`)}
    ${cpnKpi('clock', 'amber', 'Expiring 7 days', cpnNum(expiring))}
  </div>`;
}

function cpnFormCard() {
  const c = cpnEditing || {};
  const editing = !!cpnEditing;
  const flightType = c.international_only === true ? 'international' : c.international_only === false ? 'domestic' : '';
  const isFlight = (c.product_type || '') === '' || c.product_type === 'flight';
  const codeCtl = editing
    ? `<input id="cpnCode" value="${catE(c.code)}" readonly style="background:var(--hover-bg);">`
    : `<div style="display:flex; gap:8px;"><input id="cpnCode" value="" placeholder="e.g. FLYHIGH25" style="flex:1; text-transform:uppercase;">
        <button type="button" class="btn btn-ghost btn-sm" data-cpn="gen" style="white-space:nowrap;">↻ Generate</button></div>`;
  return `<div class="b2cd-card">
    <div class="b2cd-card-head"><span class="b2cd-card-ic tone-amber">${cpnIcon('wand')}</span>
      <h3>${editing ? `Edit ${catE(c.code)}` : 'Create coupon'}</h3>
      ${editing ? `<button type="button" class="b2cd-card-link" data-cpn="new" style="margin-left:auto;">+ New coupon</button>` : ''}</div>
    ${catField('Coupon code', codeCtl, editing ? 'A code cannot be changed once created.' : 'Letters and digits only.')}
    ${catField('Title', catInput('cpnTitle', c.title, { attrs: 'maxlength="160" placeholder="25% off IndiGo flights"' }))}
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div class="form-field" style="max-width:none;"><label>Discount type</label>${cpnPills('type', [['percent', 'Percent'], ['flat', 'Flat ₹']], c.discount_type || 'percent')}</div>
      ${catField('Value', catInput('cpnValue', c.discount_value, { type: 'number', attrs: 'min="0" step="0.01" placeholder="25"' }))}
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Valid from', catInput('cpnFrom', c.valid_from, { type: 'date' }))}
      ${catField('Valid till', catInput('cpnTo', c.valid_to, { type: 'date' }))}
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Usage limit', catInput('cpnLimit', c.usage_limit, { type: 'number', attrs: 'min="1" step="1" placeholder="blank = unlimited"' }))}
      ${catField('Min booking ₹', catInput('cpnMin', c.min_amount != null ? c.min_amount : '', { type: 'number', attrs: 'min="0" step="0.01" placeholder="0"' }))}
    </div>
    <div class="form-field" style="max-width:none;"><label>Applies to</label>${cpnPills('applies', CPN_APPLIES, c.product_type || '')}</div>
    <div id="cpnFlightRow" style="border-left:2px solid var(--border-color); margin:0 0 12px 7px; padding:2px 0 2px 12px; ${isFlight ? '' : 'display:none;'}">
      <div class="form-field" style="max-width:none; margin-bottom:10px;"><label style="color:var(--navy-3);">Flight type</label>${cpnPills('flight', [['', 'Both'], ['domestic', 'Domestic'], ['international', 'International']], flightType)}</div>
      ${catField('Airline (IATA)', catInput('cpnAirline', c.airline, { attrs: 'maxlength="8" placeholder="e.g. 6E" style="text-transform:uppercase;"' }), 'Shown only for this carrier. Leave empty for all airlines.')}
    </div>
    <div id="cpnMsg" class="msg"></div>
    ${cpnCanManage ? `<button type="button" class="btn btn-navy" data-cpn="save" style="width:100%; justify-content:center;">${editing ? 'Save changes' : 'Create coupon'}</button>` : '<p class="cell-sub">You do not have permission to create coupons.</p>'}
  </div>`;
}

function cpnShareCard() {
  const c = cpnEditing || {};
  const code = c.code || 'YOURCODE';
  const sub = c.title || 'Your offer description';
  return `<div class="b2cd-card">
    <div class="b2cd-card-head"><span class="b2cd-card-ic tone-teal">${cpnIcon('share')}</span><h3>Share &amp; promote</h3></div>
    <div style="border:1px dashed var(--coral); border-radius:11px; padding:11px; text-align:center; margin-bottom:11px; background:var(--coral-hover);">
      <div id="cpnShareCode" style="font-size:20px; font-weight:800; letter-spacing:.08em; color:var(--coral-dark);">${catE(code)}</div>
      <div id="cpnShareSub" class="cell-sub">${catE(sub)}</div>
    </div>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;" data-cpn-share-row>
      <a class="btn" data-cpn-soc="wa" href="#" target="_blank" rel="noopener" style="background:#25D366; color:#fff; border:0;">WhatsApp</a>
      <a class="btn" data-cpn-soc="fb" href="#" target="_blank" rel="noopener" style="background:#1877F2; color:#fff; border:0;">Facebook</a>
      <a class="btn" data-cpn-soc="x" href="#" target="_blank" rel="noopener" style="background:#111; color:#fff; border:0;">X</a>
      <button type="button" class="btn btn-ghost" data-cpn="copy" style="margin-left:auto;">Copy link</button>
    </div>
  </div>`;
}

function cpnWebsiteCard() {
  const c = cpnEditing || {};
  const on = c.show_on_website !== false;
  return `<div class="b2cd-card" style="display:flex; align-items:center; gap:11px;">
    <span class="b2cd-card-ic tone-indigo" style="margin:0;">${cpnIcon('world')}</span>
    <div style="min-width:0;"><div style="font-size:13px; font-weight:700;">Show on B2C website</div>
      <div class="cell-sub">Listed on the public Offers page &amp; checkout panel.</div></div>
    <label style="margin-left:auto; display:inline-flex; align-items:center; cursor:pointer;">
      <input type="checkbox" id="cpnWeb" ${on ? 'checked' : ''} style="width:18px; height:18px;"></label>
  </div>`;
}

function cpnValidatedCard() {
  const checks = ['Domestic / international + airline match', 'Booking type and minimum value', 'Within the validity window', 'Usage limit not exceeded'];
  return `<div class="b2cd-card">
    <div class="b2cd-card-head"><span class="b2cd-card-ic tone-green">${cpnIcon('shield')}</span><h3>Validated at checkout</h3></div>
    <div style="display:flex; flex-direction:column; gap:7px; font-size:12.5px; color:var(--text-primary);">
      ${checks.map(t => `<span style="display:flex; gap:8px; align-items:center;"><span style="color:#16A34A; display:flex;">${cpnIcon('check')}</span>${catE(t)}</span>`).join('')}
    </div>
  </div>`;
}

/* A coupon matches the search box on its code, title, airline or product. */
function cpnMatch(c, q) {
  return `${c.code || ''} ${c.title || ''} ${c.airline || ''} ${CPN_PRODUCT_LABEL[c.product_type] || ''}`
    .toLowerCase().includes(q);
}

function cpnRowHtml(c) {
  const manage = cpnCanManage ? `
    <button class="btn btn-ghost btn-sm" data-cpn-edit="${c.customer_coupon_id}">Edit</button>
    <button class="btn btn-ghost btn-sm" data-cpn-toggle="${c.customer_coupon_id}" data-active="${c.is_active ? '1' : '0'}">${c.is_active ? 'Disable' : 'Enable'}</button>` : '';
  return `<tr>
    <td><strong>${catE(c.code)}</strong><div class="cell-sub">${catE(c.title)}</div></td>
    <td>${catE(cpnDiscountText(c))}</td>
    <td>${cpnScopeHtml(c)}</td>
    <td>${catE(cpnValidity(c))}</td>
    <td class="num">${catE(cpnUsage(c))}</td>
    <td>${catPill(c.is_active)}${c.show_on_website ? '' : ' <span class="badge inactive">Hidden</span>'}</td>
    <td style="white-space:nowrap; text-align:right;"><button class="btn btn-ghost btn-sm" data-cpn-share="${c.customer_coupon_id}">Share</button>${manage}</td>
  </tr>`;
}

function cpnTableCard() {
  if (!cpnList.length) {
    return `<div class="b2cd-card" style="margin-top:16px;"><p class="empty-state" style="padding:12px 0;">No coupons yet — use the form to create one.</p></div>`;
  }
  const q = cpnQuery.trim().toLowerCase();
  const shown = q ? cpnList.filter(c => cpnMatch(c, q)) : cpnList;
  const rows = shown.map(cpnRowHtml).join('')
    || `<tr><td colspan="7" class="empty-state" style="padding:14px 0;">No coupons match your search.</td></tr>`;
  const count = q ? `${shown.length} of ${cpnList.length}` : `${cpnList.length} total`;
  return `<div class="b2cd-card" style="margin-top:16px; padding:0; overflow:hidden;">
    <div style="padding:12px 14px; display:flex; align-items:center; gap:9px; flex-wrap:wrap; border-bottom:1px solid var(--border-color);">
      <span style="font-size:14px; font-weight:800;">Active coupons</span>
      <input type="text" id="cpnSearch" value="${catE(cpnQuery)}" placeholder="Search code, title or airline…" aria-label="Search coupons"
             style="margin-left:auto; height:34px; padding:6px 10px; border:1px solid var(--border-color); border-radius:8px; background:var(--input-bg,var(--card-bg)); color:var(--text-primary); font-size:13px; max-width:240px;">
      <span id="cpnCount" class="cell-sub">${count}</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Discount</th><th>Applies to</th><th>Validity</th><th class="num">Used</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody id="cpnRows">${rows}</tbody>
    </table></div>
  </div>`;
}

/* Re-render just the rows + count on each keystroke, so the search box keeps focus. */
function cpnRenderRows() {
  const tb = document.getElementById('cpnRows');
  if (!tb) return;
  const q = cpnQuery.trim().toLowerCase();
  const shown = q ? cpnList.filter(c => cpnMatch(c, q)) : cpnList;
  tb.innerHTML = shown.map(cpnRowHtml).join('')
    || `<tr><td colspan="7" class="empty-state" style="padding:14px 0;">No coupons match your search.</td></tr>`;
  const cnt = document.getElementById('cpnCount');
  if (cnt) cnt.textContent = q ? `${shown.length} of ${cpnList.length}` : `${cpnList.length} total`;
}

function cpnRenderBody() {
  const body = document.getElementById('cpnBody');
  if (!body) return;
  body.innerHTML = cpnKpisHtml()
    + `<div style="display:grid; grid-template-columns:1fr; gap:16px; margin-top:16px;" class="cpn-main">
         <div>${cpnFormCard()}</div>
         <div style="display:flex; flex-direction:column; gap:16px;">${cpnShareCard()}${cpnWebsiteCard()}${cpnValidatedCard()}</div>
       </div>`
    + cpnTableCard();
  // Two columns from 900px up (form wider than the side cards).
  const main = body.querySelector('.cpn-main');
  if (main && window.matchMedia('(min-width:900px)').matches) main.style.gridTemplateColumns = 'minmax(0,1.4fr) minmax(0,1fr)';
  cpnUpdateShare();
}

/* ---------------------------------------------------------- interactions */

async function initB2CCoupons() {
  if (!cpnWired) {
    cpnWired = true;
    cpnCanManage = await adminCan('b2c.coupons.manage');
    const body = document.getElementById('cpnBody');
    body.addEventListener('click', cpnClick);
    body.addEventListener('input', cpnInput);
  }
  loadB2CCoupons();
}

async function loadB2CCoupons() {
  const body = document.getElementById('cpnBody');
  if (!body) return;
  body.innerHTML = '<p class="cell-sub" style="padding:12px 0;">Loading…</p>';
  try {
    const data = await cpnApi('get', '', { params: { page_size: 200 } });
    cpnList = data.items || [];
    cpnCache = {};
    cpnList.forEach(c => { cpnCache[c.customer_coupon_id] = c; });
    cpnRenderBody();
  } catch (err) {
    body.innerHTML = `<p class="msg error" style="margin:12px 0;">${catE(catErr(err, 'Could not load coupons.'))}</p>`;
  }
}

function cpnShareMessage() {
  const code = (document.getElementById('cpnShareCode')?.textContent || '').trim() || 'YOURCODE';
  const title = (document.getElementById('cpnShareSub')?.textContent || '').trim();
  const site = `${location.origin}/offers.html`;
  return { msg: `Use code ${code} on JackpotsWorld Tours & Travels — ${title}. ${site}`, site, code };
}
function cpnUpdateShare() {
  const row = document.querySelector('[data-cpn-share-row]');
  if (!row) return;
  const { msg, site } = cpnShareMessage();
  const enc = encodeURIComponent(msg), encUrl = encodeURIComponent(site);
  const set = (k, href) => { const a = row.querySelector(`[data-cpn-soc="${k}"]`); if (a) a.href = href; };
  set('wa', `https://wa.me/?text=${enc}`);
  set('fb', `https://www.facebook.com/sharer/sharer.php?u=${encUrl}&quote=${enc}`);
  set('x', `https://twitter.com/intent/tweet?text=${enc}`);
}

function cpnSyncFlightFields() {
  const applies = cpnActivePill('applies');
  const isFlight = applies === '' || applies === 'flight';
  const row = document.getElementById('cpnFlightRow');
  if (row) row.style.display = isFlight ? '' : 'none';
}

function cpnInput(e) {
  if (e.target.id === 'cpnSearch') {
    cpnQuery = e.target.value;
    cpnRenderRows();
    return;
  }
  if (e.target.id === 'cpnCode') {
    const el = document.getElementById('cpnShareCode');
    if (el) { el.textContent = (e.target.value || 'YOURCODE').toUpperCase(); cpnUpdateShare(); }
  } else if (e.target.id === 'cpnTitle') {
    const el = document.getElementById('cpnShareSub');
    if (el) { el.textContent = e.target.value || 'Your offer description'; cpnUpdateShare(); }
  }
}

function cpnClick(e) {
  const pill = e.target.closest('[data-pill-group]');
  if (pill) {
    const group = pill.dataset.pillGroup;
    document.querySelectorAll(`[data-pill-group="${group}"]`).forEach(b => {
      const on = b === pill;
      b.classList.toggle('btn-navy', on);
      b.classList.toggle('btn-ghost', !on);
    });
    if (group === 'applies') cpnSyncFlightFields();
    return;
  }
  const act = e.target.closest('[data-cpn]');
  if (act) {
    const kind = act.dataset.cpn;
    if (kind === 'gen') return cpnGenerate(act);
    if (kind === 'save') return cpnSave(act);
    if (kind === 'new') { cpnEditing = null; return cpnRenderBody(); }
    if (kind === 'copy') return cpnCopy();
  }
  const edit = e.target.closest('[data-cpn-edit]');
  const toggle = e.target.closest('[data-cpn-toggle]');
  const share = e.target.closest('[data-cpn-share]');
  if (edit) { cpnEditing = cpnCache[edit.dataset.cpnEdit] || null; cpnRenderBody(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (share) { cpnEditing = cpnCache[share.dataset.cpnShare] || null; cpnRenderBody(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (toggle) return cpnToggle(Number(toggle.dataset.cpnToggle), toggle.dataset.active !== '1');
}

async function cpnGenerate(btn) {
  btn.disabled = true;
  try {
    const { code } = await cpnApi('post', '/generate-code');
    const input = document.getElementById('cpnCode');
    input.value = code;
    cpnInput({ target: input });
  } catch (err) { cpnMsgLocal(catErr(err, 'Could not generate a code.'), true); }
  finally { btn.disabled = false; }
}

async function cpnCopy() {
  const { code } = cpnShareMessage();
  try { await navigator.clipboard.writeText(code); if (typeof showToast === 'function') showToast('Code copied'); }
  catch { /* clipboard blocked */ }
}

function cpnMsgLocal(text, isError) {
  const el = document.getElementById('cpnMsg');
  if (el) { el.textContent = text || ''; el.className = 'msg' + (isError ? ' error' : text ? ' success' : ''); }
}
const cpnNumOrNull = id => { const v = (document.getElementById(id).value || '').trim(); return v === '' ? null : Number(v); };

async function cpnSave(btn) {
  if (!cpnCanManage) return;
  const applies = cpnActivePill('applies') || null;
  const isFlight = applies === null || applies === 'flight';
  const flightType = cpnActivePill('flight');
  const payload = {
    title: (document.getElementById('cpnTitle').value || '').trim(),
    discount_type: cpnActivePill('type') || 'percent',
    discount_value: cpnNumOrNull('cpnValue'),
    min_amount: cpnNumOrNull('cpnMin') ?? 0,
    product_type: applies,
    international_only: isFlight ? (flightType === '' ? null : flightType === 'international') : null,
    airline: isFlight ? ((document.getElementById('cpnAirline').value || '').trim().toUpperCase() || null) : null,
    usage_limit: cpnNumOrNull('cpnLimit'),
    show_on_website: document.getElementById('cpnWeb').checked,
    valid_from: document.getElementById('cpnFrom').value || null,
    valid_to: document.getElementById('cpnTo').value || null,
  };
  if (!payload.title) return cpnMsgLocal('Enter a title.', true);
  if (!payload.discount_value || payload.discount_value <= 0) return cpnMsgLocal('Enter a discount value above zero.', true);

  btn.disabled = true;
  cpnMsgLocal('');
  try {
    if (cpnEditing) {
      payload.is_active = cpnEditing.is_active;
      await cpnApi('patch', `/${cpnEditing.customer_coupon_id}`, { data: payload });
    } else {
      payload.is_active = true;
      await cpnApi('post', '', { data: { ...payload, code: (document.getElementById('cpnCode').value || '').trim().toUpperCase() } });
    }
    if (typeof showToast === 'function') showToast(cpnEditing ? 'Coupon saved' : 'Coupon created');
    cpnEditing = null;
    loadB2CCoupons();
  } catch (err) {
    cpnMsgLocal(catErr(err, 'Could not save the coupon.'), true);
  } finally { btn.disabled = false; }
}

async function cpnToggle(id, activate) {
  try {
    if (activate) await cpnApi('patch', `/${id}`, { data: { is_active: true } });
    else await cpnApi('delete', `/${id}`);
    if (typeof showToast === 'function') showToast(activate ? 'Coupon enabled' : 'Coupon disabled');
    loadB2CCoupons();
  } catch (err) {
    if (typeof showToast === 'function') showToast(catErr(err, 'Could not update the coupon.'), true);
  }
}
