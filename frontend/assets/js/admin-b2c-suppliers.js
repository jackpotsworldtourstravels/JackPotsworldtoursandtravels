/* Admin — B2C Suppliers & Pricing
   ============================================================================
   Two controls over what the B2C site charges:
     1. Supplier markup — a percentage added to a supplier's base price per
        service (TBO is the primary supplier). Saved as supplier_markups rows.
     2. Festival/seasonal discounts — a time-boxed discount on the resulting
        selling price, shown on the site as original vs discounted price.

   This desk only stores the rules; the arithmetic lives server-side in
   customer_markup_service, and the live preview below calls the server so what
   the owner previews is exactly what a customer will pay.

   ENDPOINTS (all require b2c.pricing.manage; a super admin holds it):
     GET  /api/admin/suppliers                       current markups
     PUT  /api/admin/suppliers                        save markups
     GET  /api/admin/festival-discounts               list
     POST /api/admin/festival-discounts               create
     PATCH/DELETE /api/admin/festival-discounts/{id}  edit / deactivate
     GET  /api/admin/pricing/preview?service=&base=   live breakdown

   Loaded after admin.js and admin-b2c-catalogue-common.js. */

const SUP_SERVICES = [['flight', 'Flights'], ['hotel', 'Hotels'], ['package', 'Tour Packages'], ['other', 'Other']];
const SUP_APPLICABLE = [['', 'All products'], ['flight', 'Flights'], ['hotel', 'Hotels'], ['package', 'Tour Packages']];
const SUP_APPLICABLE_LABEL = { flight: 'Flights', hotel: 'Hotels', package: 'Tour Packages' };

const supState = { markups: {}, festivals: [] };
let supWired = false;
let supCanManage = false;

async function supApi(method, path, { params, data } = {}) {
  const res = await axios({ method, url: `${API_BASE}/api/admin${path}`, headers: authHeaders(), params, data });
  return res.data;
}

const supRupee = v => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const supPct = v => `${Number(v || 0)}%`;

function supKpi(tone, label, value) {
  return `<div class="b2cd-kpi"><span class="b2cd-kpi-label">${catE(label)}</span>
    <span class="b2cd-kpi-val" style="color:var(--t-${tone});">${value}</span></div>`;
}

async function initB2CSuppliers() {
  if (!supWired) {
    supWired = true;
    supCanManage = adminCan('b2c.pricing.manage');
    const body = document.getElementById('supBody');
    body.addEventListener('click', supClick);
  }
  loadB2CSuppliers();
}

async function loadB2CSuppliers() {
  const body = document.getElementById('supBody');
  if (!body) return;
  body.innerHTML = '<p class="cell-sub" style="padding:12px 0;">Loading…</p>';
  try {
    const [markups, fests] = await Promise.all([
      supApi('get', '/suppliers'),
      supApi('get', '/festival-discounts'),
    ]);
    supState.markups = {};
    (markups || []).forEach(m => { if (m.supplier === 'TBO') supState.markups[m.service] = m; });
    supState.festivals = fests || [];
    body.innerHTML = supRender();
    supWirePreview();
  } catch (err) {
    body.innerHTML = `<p class="msg error" style="margin:12px 0;">${catE(catErr(err, 'Could not load pricing settings.'))}</p>`;
  }
}

function supRender() {
  const vals = SUP_SERVICES.map(([s]) => Number(supState.markups[s]?.markup_percent || 0));
  const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  const activeFest = supState.festivals.filter(f => f.is_active).length;

  const kpis = `<div class="b2cd-kpis">
    ${supKpi('indigo', 'Primary supplier', 'TBO')}
    ${supKpi('teal', 'Avg markup', avg + '%')}
    ${supKpi('amber', 'Festival offers', activeFest)}
    ${supKpi('blue', 'Services', SUP_SERVICES.length)}
  </div>`;

  const markupRows = SUP_SERVICES.map(([s, label]) => {
    const m = supState.markups[s];
    const pct = m ? Number(m.markup_percent) : 0;
    return `<div class="sup-mk-row" style="display:flex; align-items:center; gap:12px; padding:10px 0; border-top:1px solid var(--border-color);">
      <span style="flex:1; font-weight:600; font-size:13.5px;">${catE(label)}</span>
      <div style="display:flex; align-items:center; gap:6px;">
        <input type="number" id="supMk_${s}" value="${catE(pct)}" min="0" max="999" step="0.01"
          ${supCanManage ? '' : 'disabled'} style="width:90px; text-align:right;">
        <span class="cell-sub">%</span>
      </div>
    </div>`;
  }).join('');

  const markupCard = `<div class="b2cd-card">
    <div class="b2cd-card-head"><span class="b2cd-card-ic tone-indigo">TBO</span><h3>Markup by service</h3></div>
    <p class="b2cd-note" style="margin:0 0 6px;">Added to the TBO base price before the customer sees it. 0% leaves the base price unchanged.</p>
    ${markupRows}
    ${supCanManage ? `<button class="btn btn-navy" id="supSaveMarkup" style="margin-top:12px;">Save markup</button>` : ''}
    <div id="supMkMsg" class="msg" style="margin-top:8px;"></div>
  </div>`;

  const previewCard = `<div class="b2cd-card">
    <div class="b2cd-card-head"><span class="b2cd-card-ic tone-green">₹</span><h3>Live price preview</h3></div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-bottom:10px;">
      <label style="font-size:12px; color:var(--text-muted);">Service<br>
        <select id="supPrevService" class="status-select">${SUP_SERVICES.map(([s, l]) => `<option value="${s}">${catE(l)}</option>`).join('')}</select></label>
      <label style="font-size:12px; color:var(--text-muted);">Base price ₹<br>
        <input type="number" id="supPrevBase" value="5000" min="0" step="1" style="width:120px;"></label>
    </div>
    <div id="supPrevOut"></div>
  </div>`;

  const festRows = supState.festivals.length ? supState.festivals.map(f => {
    const val = f.discount_type === 'percent' ? `${Number(f.discount_value)}%` : supRupee(f.discount_value);
    const manage = supCanManage ? `
      <button class="btn btn-ghost btn-sm" data-sup-fest-edit="${f.festival_discount_id}">Edit</button>
      <button class="btn btn-ghost btn-sm" data-sup-fest-toggle="${f.festival_discount_id}" data-active="${f.is_active ? '1' : '0'}">${f.is_active ? 'Disable' : 'Enable'}</button>` : '';
    return `<tr>
      <td><strong>${catE(f.name)}</strong></td>
      <td>${catE(val)} off</td>
      <td>${catE(SUP_APPLICABLE_LABEL[f.applicable_type] || 'All products')}</td>
      <td>${catE(catDate(f.start_date))} – ${catE(catDate(f.end_date))}</td>
      <td>${catPill(f.is_active)}${f.show_on_website ? '' : ' <span class="badge inactive">Hidden</span>'}</td>
      <td style="white-space:nowrap; text-align:right;">${manage}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="cell-sub" style="padding:14px 0; text-align:center;">No festival discounts yet.</td></tr>`;

  const festCard = `<div class="b2cd-card" style="grid-column:1 / -1;">
    <div class="b2cd-card-head"><span class="b2cd-card-ic tone-amber">%</span><h3>Festival &amp; seasonal discounts</h3>
      ${supCanManage ? `<button class="btn btn-navy btn-sm" id="supFestCreate" style="margin-left:auto;">+ New discount</button>` : ''}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Discount</th><th>Applies to</th><th>Period</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${festRows}</tbody>
    </table></div>
    <p class="b2cd-note">Applied to the final selling price (after markup). The site shows the original price, the discounted price and the saving.</p>
  </div>`;

  return kpis + `<div class="b2cd-cards" style="margin-top:16px;">${markupCard}${previewCard}${festCard}</div>`;
}

/* --------------------------------------------------------------- preview */

function supWirePreview() {
  const svc = document.getElementById('supPrevService');
  const base = document.getElementById('supPrevBase');
  if (!svc || !base) return;
  const run = catDebounce(supRunPreview, 300);
  svc.addEventListener('change', supRunPreview);
  base.addEventListener('input', run);
  supRunPreview();
}

async function supRunPreview() {
  const out = document.getElementById('supPrevOut');
  if (!out) return;
  const service = document.getElementById('supPrevService').value;
  const base = document.getElementById('supPrevBase').value || '0';
  try {
    const p = await supApi('get', '/pricing/preview', { params: { service, base } });
    const row = (label, value, color) =>
      `<div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--border-color); font-size:13px;">
        <span style="color:var(--text-muted);">${catE(label)}</span><span style="font-weight:700;${color ? `color:${color};` : ''}">${value}</span></div>`;
    out.innerHTML =
      row('Supplier base', supRupee(p.base)) +
      row(`Markup (${supPct(p.markup_percent)})`, '+ ' + supRupee(Number(p.selling) - Number(p.base)), 'var(--t-teal)') +
      row('Selling price', supRupee(p.selling)) +
      (Number(p.festival_amount) > 0
        ? row(`${p.festival_name || 'Festival'} (${p.festival_percent}%)`, '− ' + supRupee(p.festival_amount), 'var(--t-red)') : '') +
      `<div style="display:flex; justify-content:space-between; padding:9px 0 0; font-size:14px;">
        <span style="font-weight:800;">Final customer price</span><span style="font-weight:800; color:var(--navy-3);">${supRupee(p.final)}</span></div>`;
  } catch (err) {
    out.innerHTML = `<p class="msg error">${catE(catErr(err, 'Could not preview.'))}</p>`;
  }
}

/* --------------------------------------------------------------- actions */

function supClick(e) {
  if (e.target.closest('#supSaveMarkup')) return supSaveMarkup(e.target.closest('#supSaveMarkup'));
  if (e.target.closest('#supFestCreate')) return supFestModal(null);
  const edit = e.target.closest('[data-sup-fest-edit]');
  const toggle = e.target.closest('[data-sup-fest-toggle]');
  if (edit) return supFestModal(supState.festivals.find(f => String(f.festival_discount_id) === edit.dataset.supFestEdit));
  if (toggle) return supFestToggle(Number(toggle.dataset.supFestToggle), toggle.dataset.active !== '1');
}

async function supSaveMarkup(btn) {
  if (!supCanManage) return;
  const items = SUP_SERVICES.map(([s]) => ({
    service: s,
    markup_percent: Number(document.getElementById(`supMk_${s}`).value || 0),
    is_active: true,
  }));
  btn.disabled = true;
  try {
    await supApi('put', '/suppliers', { data: { items } });
    if (typeof showToast === 'function') showToast('Markup saved');
    document.getElementById('supMkMsg').textContent = '';
    loadB2CSuppliers();
  } catch (err) {
    const el = document.getElementById('supMkMsg');
    el.textContent = catErr(err, 'Could not save markup.');
    el.className = 'msg error';
  } finally { btn.disabled = false; }
}

async function supFestToggle(id, activate) {
  try {
    if (activate) await supApi('patch', `/festival-discounts/${id}`, { data: { is_active: true } });
    else await supApi('delete', `/festival-discounts/${id}`);
    if (typeof showToast === 'function') showToast(activate ? 'Discount enabled' : 'Discount disabled');
    loadB2CSuppliers();
  } catch (err) {
    if (typeof showToast === 'function') showToast(catErr(err, 'Could not update the discount.'), true);
  }
}

function supFestModal(fest) {
  if (!supCanManage) return;
  const f = fest || {};
  const editing = !!fest;
  const body = `
    ${catField('Offer name', catInput('supFName', f.name, { attrs: 'maxlength="160" placeholder="Diwali Dhamaka"' }))}
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Discount type', catSelect('supFType', [['percent', 'Percentage'], ['flat', 'Flat amount (₹)']], f.discount_type || 'percent'))}
      ${catField('Value', catInput('supFValue', f.discount_value, { type: 'number', attrs: 'min="0" step="0.01"' }))}
    </div>
    ${catField('Applies to', catSelect('supFApplicable', SUP_APPLICABLE, f.applicable_type || ''))}
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Start date', catInput('supFStart', f.start_date, { type: 'date' }))}
      ${catField('End date', catInput('supFEnd', f.end_date, { type: 'date' }))}
    </div>
    <div style="display:flex; flex-direction:column; gap:8px; margin:4px 0 12px;">
      ${catCheck('supFWeb', f.show_on_website !== false, 'Show original vs discounted price on the website')}
      ${editing ? catCheck('supFActive', f.is_active !== false, 'Active') : ''}
    </div>
    <div id="catMsg" class="msg"></div>
    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:8px;">
      <button type="button" class="btn btn-ghost" data-cat-close>Cancel</button>
      <button type="button" class="btn btn-navy" id="supFSave">${editing ? 'Save changes' : 'Create discount'}</button>
    </div>`;
  const root = catOpenModal(catModalShell(editing ? `Edit ${catE(f.name)}` : 'New festival discount', body));
  if (!root) return;
  document.getElementById('supFSave').addEventListener('click', e => supFestSubmit(e.currentTarget, f, editing));
}

async function supFestSubmit(btn, current, editing) {
  const payload = {
    name: catTrim('supFName'),
    discount_type: catVal('supFType'),
    discount_value: Number(catTrim('supFValue') || 0),
    applicable_type: catVal('supFApplicable') || null,
    start_date: catVal('supFStart') || null,
    end_date: catVal('supFEnd') || null,
    show_on_website: catChecked('supFWeb'),
  };
  if (editing) payload.is_active = catChecked('supFActive');
  if (!payload.name) return catMsg('Enter an offer name.', true);
  if (!payload.discount_value || payload.discount_value <= 0) return catMsg('Enter a discount value above zero.', true);
  if (!payload.start_date || !payload.end_date) return catMsg('Enter the start and end dates.', true);

  const result = await catSave(btn, async () => {
    if (editing) return supApi('patch', `/festival-discounts/${current.festival_discount_id}`, { data: payload });
    return supApi('post', '/festival-discounts', { data: payload });
  }, editing ? 'Discount saved' : 'Discount created');

  if (result) { catCloseModal(); loadB2CSuppliers(); }
}
