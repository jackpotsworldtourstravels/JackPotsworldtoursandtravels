/* Admin — B2C Offers & Coupons
   ============================================================================
   Manages the discount codes the B2C site offers. Every row here is a
   `customer_coupons` record; the public booking flow is what applies and prices
   them (this desk never prices anything). Create generates a unique code, sets
   the discount, targets it (product, airline, domestic/international), caps its
   usage, and decides whether the public Offers page advertises it.

   ENDPOINTS (all require b2c.coupons.manage; a super admin holds it):
     GET    /api/admin/coupons                 paged list + per-status counts
     POST   /api/admin/coupons/generate-code   a fresh unique code
     POST   /api/admin/coupons                  create
     PATCH  /api/admin/coupons/{id}             edit (code is immutable)
     DELETE /api/admin/coupons/{id}             soft-deactivate

   Loaded after admin.js and admin-b2c-catalogue-common.js, whose modal, field
   builders, formatters and error formatter it reuses. */

const CPN_TABS = [['', 'All'], ['active', 'Active'], ['inactive', 'Inactive']];
const CPN_PRODUCTS = [['', 'All products'], ['flight', 'Flights'], ['hotel', 'Hotels'], ['package', 'Tour Packages']];
const CPN_PRODUCT_LABEL = { flight: 'Flights', hotel: 'Hotels', package: 'Tour Packages' };
/* The flight-type <select> maps to the tri-state `international_only` column:
   null = both, false = domestic only, true = international only. */
const CPN_FLIGHT_TYPES = [['', 'Domestic & international'], ['domestic', 'Domestic only'], ['international', 'International only']];

const cpnState = { status: '', product: '', search: '', page: 1 };
let cpnWired = false;
let cpnCanManage = false;

async function cpnApi(method, path = '', { params, data } = {}) {
  const res = await axios({ method, url: `${API_BASE}/api/admin/coupons${path}`, headers: authHeaders(), params, data });
  return res.data;
}

const cpnRupee = v => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const cpnNum = v => Number(v || 0).toLocaleString('en-IN');

function cpnIcon(path) { return `<svg class="icon" viewBox="0 0 24 24">${path}</svg>`; }
const CPN_IC = {
  ticket: '<path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z"/><path d="M13 7v10"/>',
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
  coins: '<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v6c0 1.7 2.7 3 6 3s6-1.3 6-3V6"/><path d="M21 10v4c0 1.7-2.7 3-6 3-1 0-2-.1-2.8-.3"/><path d="M15 10c2.9 0 6-1 6-3"/>',
  world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
};

/* "25% (up to ₹1,000)" or "₹1,500 off". */
function cpnDiscountText(c) {
  if (c.discount_type === 'percent') {
    const pct = `${Number(c.discount_value)}%`;
    return c.max_discount ? `${pct} (up to ${cpnRupee(c.max_discount)})` : pct;
  }
  return `${cpnRupee(c.discount_value)} off`;
}

/* Product + airline + domestic/international, as small badges. */
function cpnScopeHtml(c) {
  const bits = [];
  bits.push(`<span class="badge">${catE(CPN_PRODUCT_LABEL[c.product_type] || 'All products')}</span>`);
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

function cpnUsage(c) {
  const used = cpnNum(c.times_used);
  return c.usage_limit ? `${used} / ${cpnNum(c.usage_limit)}` : `${used} / ∞`;
}

function cpnKpi(icon, tone, label, value) {
  return `<div class="b2cd-kpi"><span class="b2cd-kpi-ic tone-${tone}">${cpnIcon(CPN_IC[icon])}</span>
    <span class="b2cd-kpi-label">${catE(label)}</span><span class="b2cd-kpi-val">${value}</span></div>`;
}

function cpnRender(data) {
  const items = data.items || [];
  const counts = data.counts || {};
  const redemptions = items.reduce((n, c) => n + Number(c.times_used || 0), 0);
  const onSite = items.filter(c => c.show_on_website && c.is_active).length;

  const kpis = `<div class="b2cd-kpis">
    ${cpnKpi('ticket', 'blue', 'Coupons', cpnNum(counts.total ?? items.length))}
    ${cpnKpi('check', 'green', 'Active', cpnNum(counts.active ?? 0))}
    ${cpnKpi('coins', 'teal', 'Redemptions', cpnNum(redemptions))}
    ${cpnKpi('world', 'indigo', 'On website', cpnNum(onSite))}
  </div>`;

  if (!items.length) {
    return kpis + `<p class="empty-state" style="padding:18px 0;">No coupons yet${
      cpnCanManage ? ' — use <strong>Create coupon</strong> to add one.' : '.'}</p>`;
  }

  const rows = items.map(c => {
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
      <td style="white-space:nowrap; text-align:right;">
        <button class="btn btn-ghost btn-sm" data-cpn-share="${c.customer_coupon_id}">Share</button>${manage}
      </td>
    </tr>`;
  }).join('');

  return kpis + `<div class="b2cd-card" style="margin-top:16px; padding:0; overflow:hidden;">
    <div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Discount</th><th>Applies to</th><th>Validity</th>
        <th class="num">Used</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

/* ------------------------------------------------------------------ list */

async function initB2CCoupons() {
  if (!cpnWired) {
    cpnWired = true;
    cpnCanManage = adminCan('b2c.coupons.manage');

    const tabs = document.getElementById('cpnTabs');
    tabs.innerHTML = CPN_TABS.map(([k, l]) =>
      `<button type="button" class="btn btn-ghost btn-sm${k === cpnState.status ? ' btn-navy' : ''}" data-cpn-tab="${k}">${catE(l)}</button>`).join('');
    tabs.addEventListener('click', e => {
      const b = e.target.closest('[data-cpn-tab]');
      if (!b) return;
      cpnState.status = b.dataset.cpnTab;
      tabs.querySelectorAll('[data-cpn-tab]').forEach(x =>
        x.classList.toggle('btn-navy', x.dataset.cpnTab === cpnState.status));
      loadB2CCoupons();
    });

    const prod = document.getElementById('cpnProductFilter');
    prod.innerHTML = CPN_PRODUCTS.map(([v, l]) => `<option value="${v}">${catE(l)}</option>`).join('');
    prod.addEventListener('change', e => { cpnState.product = e.target.value; loadB2CCoupons(); });

    const search = document.getElementById('cpnSearch');
    search.addEventListener('input', catDebounce(() => { cpnState.search = search.value.trim(); loadB2CCoupons(); }));

    const create = document.getElementById('cpnCreateBtn');
    if (!cpnCanManage) create.style.display = 'none';
    create.addEventListener('click', () => cpnOpenModal(null));

    document.getElementById('cpnBody').addEventListener('click', cpnBodyClick);
  }
  loadB2CCoupons();
}

async function loadB2CCoupons() {
  const body = document.getElementById('cpnBody');
  if (!body) return;
  body.innerHTML = '<p class="cell-sub" style="padding:12px 0;">Loading…</p>';
  try {
    const data = await cpnApi('get', '', {
      params: {
        status: cpnState.status || undefined,
        product: cpnState.product || undefined,
        search: cpnState.search || undefined,
        page_size: 200,
      },
    });
    cpnCache = {};
    (data.items || []).forEach(c => { cpnCache[c.customer_coupon_id] = c; });
    body.innerHTML = cpnRender(data);
  } catch (err) {
    body.innerHTML = `<p class="msg error" style="margin:12px 0;">${catE(catErr(err, 'Could not load coupons.'))}</p>`;
  }
}

let cpnCache = {};

function cpnBodyClick(e) {
  const edit = e.target.closest('[data-cpn-edit]');
  const toggle = e.target.closest('[data-cpn-toggle]');
  const share = e.target.closest('[data-cpn-share]');
  if (edit) return cpnOpenModal(cpnCache[edit.dataset.cpnEdit]);
  if (share) return cpnShareModal(cpnCache[share.dataset.cpnShare]);
  if (toggle) return cpnToggle(Number(toggle.dataset.cpnToggle), toggle.dataset.active !== '1');
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

/* ------------------------------------------------------------------ editor */

function cpnOpenModal(coupon) {
  if (!cpnCanManage) return;
  const c = coupon || {};
  const editing = !!coupon;
  const flightType = c.international_only === true ? 'international' : c.international_only === false ? 'domestic' : '';

  const codeField = editing
    ? catField('Code', `<input id="cpnCode" value="${catE(c.code)}" readonly style="background:var(--hover-bg);">`, 'A code cannot be changed once created.')
    : catField('Code', `<div style="display:flex; gap:8px;">
        <input id="cpnCode" value="" placeholder="e.g. FLYHIGH25" style="flex:1; text-transform:uppercase;">
        <button type="button" class="btn btn-ghost btn-sm" id="cpnGen" style="white-space:nowrap;">↻ Generate</button>
      </div>`, 'Letters and digits only.');

  const body = `
    ${codeField}
    ${catField('Title', catInput('cpnTitle', c.title, { attrs: 'maxlength="160" placeholder="25% off IndiGo flights"' }))}
    ${catField('Description (optional)', catTextarea('cpnDesc', c.description, 2))}
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Discount type', catSelect('cpnType', [['percent', 'Percentage'], ['flat', 'Flat amount (₹)']], c.discount_type || 'percent'))}
      ${catField('Value', catInput('cpnValue', c.discount_value, { type: 'number', attrs: 'min="0" step="0.01"' }))}
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Max discount ₹ (percentage only)', catInput('cpnMax', c.max_discount, { type: 'number', attrs: 'min="0" step="0.01" placeholder="no cap"' }))}
      ${catField('Minimum booking ₹', catInput('cpnMin', c.min_amount != null ? c.min_amount : 0, { type: 'number', attrs: 'min="0" step="0.01"' }))}
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      ${catField('Valid from', catInput('cpnFrom', c.valid_from, { type: 'date' }))}
      ${catField('Valid to', catInput('cpnTo', c.valid_to, { type: 'date' }))}
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px;">
      ${catField('Applies to', catSelect('cpnProduct', CPN_PRODUCTS.map(([v, l]) => [v, v ? l : 'All products']), c.product_type || ''))}
      ${catField('Flight type', catSelect('cpnFlightType', CPN_FLIGHT_TYPES, flightType))}
      ${catField('Airline (IATA)', catInput('cpnAirline', c.airline, { attrs: 'maxlength="8" placeholder="e.g. 6E" style="text-transform:uppercase;"' }))}
    </div>
    ${catField('Usage limit', catInput('cpnLimit', c.usage_limit, { type: 'number', attrs: 'min="1" step="1" placeholder="blank = unlimited"' }))}
    <div style="display:flex; flex-direction:column; gap:8px; margin:4px 0 12px;">
      ${catCheck('cpnWeb', c.show_on_website !== false, 'Show on the B2C website (Offers page + checkout panel)')}
      ${editing ? catCheck('cpnActive', c.is_active !== false, 'Active') : ''}
    </div>
    <div id="catMsg" class="msg"></div>
    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:8px;">
      <button type="button" class="btn btn-ghost" data-cat-close>Cancel</button>
      <button type="button" class="btn btn-navy" id="cpnSave">${editing ? 'Save changes' : 'Create coupon'}</button>
    </div>`;

  const root = catOpenModal(catModalShell(editing ? `Edit ${catE(c.code)}` : 'Create coupon', body));
  if (!root) return;

  const product = document.getElementById('cpnProduct');
  const syncFlightFields = () => {
    const isFlight = product.value === 'flight' || product.value === '';
    document.getElementById('cpnFlightType').disabled = !isFlight;
    document.getElementById('cpnAirline').disabled = !isFlight;
  };
  product.addEventListener('change', syncFlightFields);
  syncFlightFields();

  const gen = document.getElementById('cpnGen');
  if (gen) gen.addEventListener('click', async () => {
    gen.disabled = true;
    try {
      const { code } = await cpnApi('post', '/generate-code');
      document.getElementById('cpnCode').value = code;
    } catch (err) { catMsg(catErr(err, 'Could not generate a code.'), true); }
    finally { gen.disabled = false; }
  });

  document.getElementById('cpnSave').addEventListener('click', e => cpnSubmit(e.currentTarget, c, editing));
}

function cpnNumOrNull(id) {
  const v = catTrim(id);
  return v === '' ? null : Number(v);
}

async function cpnSubmit(btn, current, editing) {
  const product = catVal('cpnProduct') || null;
  const isFlight = product === 'flight' || product === null;
  const flightType = catVal('cpnFlightType');
  const payload = {
    title: catTrim('cpnTitle'),
    description: catNullable('cpnDesc'),
    discount_type: catVal('cpnType'),
    discount_value: cpnNumOrNull('cpnValue'),
    max_discount: cpnNumOrNull('cpnMax'),
    min_amount: cpnNumOrNull('cpnMin') ?? 0,
    product_type: product,
    international_only: isFlight ? (flightType === '' ? null : flightType === 'international') : null,
    airline: isFlight ? (catTrim('cpnAirline').toUpperCase() || null) : null,
    usage_limit: cpnNumOrNull('cpnLimit'),
    show_on_website: catChecked('cpnWeb'),
  };
  if (editing) payload.is_active = catChecked('cpnActive');
  else payload.is_active = true;

  // Minimal client guards; the server is the authority.
  if (!payload.title) return catMsg('Enter a title.', true);
  if (!payload.discount_value || payload.discount_value <= 0) return catMsg('Enter a discount value above zero.', true);

  const result = await catSave(btn, async () => {
    if (editing) return cpnApi('patch', `/${current.customer_coupon_id}`, { data: payload });
    return cpnApi('post', '', { data: { ...payload, code: catTrim('cpnCode').toUpperCase() } });
  }, editing ? 'Coupon saved' : 'Coupon created');

  if (result) { catCloseModal(); loadB2CCoupons(); }
}

/* ------------------------------------------------------------------ share */

function cpnShareModal(c) {
  if (!c) return;
  const site = `${location.origin}/offers.html`;
  const msg = `Use code ${c.code} on JackpotsWorld Tours & Travels — ${c.title}. ${site}`;
  const enc = encodeURIComponent(msg);
  const encUrl = encodeURIComponent(site);
  const links = [
    ['WhatsApp', `https://wa.me/?text=${enc}`, '#25D366'],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${encUrl}&quote=${enc}`, '#1877F2'],
    ['X', `https://twitter.com/intent/tweet?text=${enc}`, '#111111'],
  ];
  const body = `
    <div style="text-align:center; border:1px dashed var(--coral); border-radius:12px; padding:14px; margin-bottom:14px; background:var(--coral-hover);">
      <div style="font-size:22px; font-weight:800; letter-spacing:.08em; color:var(--coral-dark);">${catE(c.code)}</div>
      <div class="cell-sub">${catE(c.title)}</div>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center;">
      ${links.map(([l, href, bg]) =>
        `<a class="btn" href="${catE(href)}" target="_blank" rel="noopener" style="background:${bg}; color:#fff; border:0;">${catE(l)}</a>`).join('')}
      <button type="button" class="btn btn-ghost" id="cpnCopy">Copy message</button>
    </div>
    <div id="catMsg" class="msg" style="text-align:center;"></div>`;
  catOpenModal(catModalShell('Share coupon', body));
  const copy = document.getElementById('cpnCopy');
  if (copy) copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(msg); catMsg('Copied to clipboard.', false); }
    catch { catMsg('Could not copy — select and copy manually.', true); }
  });
}
