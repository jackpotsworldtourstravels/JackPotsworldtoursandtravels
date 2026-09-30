/* Admin — B2C Catalogue: Tour Packages (Phase 5 of the B2C Admin Portal
   build-out)
   ==================================================================
   Creates and edits the SAME package, itinerary and departure rows the
   customer site's Tour Packages pages already read — no second catalogue.
   Nothing is ever deleted (a booking references its package and departure);
   "Disabled" is how a package or a date is withdrawn.

   TWO PRICES, BOTH EDITABLE, NEITHER DERIVED FROM THE OTHER:
     Headline "from" price  the package's shelf price.
     Departure price        per person, per date — what a booking is priced
                            from. The listing card shows the next departure's
                            price and says "from X on other dates" when the
                            shelf price differs.

   GAMING PACKAGES ARE NOT HERE. They are an enquiry queue (Gaming Tour
   Packages in the sidebar); every package created on this screen is a
   holiday package.

   RATINGS ARE NOT EDITABLE: a score is a claim about where it came from, and
   is not the desk's to type.

   ENDPOINTS (all under /api/admin/catalogue/packages):
     GET "" paged list       POST ""  create        GET /{id}  detail
     PATCH /{id}  edit       PUT /{id}/itinerary     (whole itinerary)
     POST /{id}/departures   PATCH /{id}/departures/{dep_id}

   Uses admin-b2c-catalogue-common.js and admin.js's helpers. */

const pkgState = { search: '', status: '', trip: '', page: 1 };
let pkgWired = false;
let pkgCurrent = null;
let pkgTab = 'details';

const PKG_TABS = [['details', 'Details'], ['pricing', 'Pricing & Departures'], ['itinerary', 'Itinerary'], ['image', 'Image']];
const PKG_TRIPS = [['domestic', 'Domestic'], ['pilgrimage', 'Pilgrimage'], ['international', 'International']];

async function initB2CPackages() {
  if (!pkgWired) {
    pkgWired = true;
    const search = document.getElementById('pkgSearch');
    search.addEventListener('input', catDebounce(() => { pkgState.search = search.value.trim(); pkgState.page = 1; loadB2CPackages(); }));
    document.getElementById('pkgStatusFilter').addEventListener('change', e => { pkgState.status = e.target.value; pkgState.page = 1; loadB2CPackages(); });
    document.getElementById('pkgTripFilter').addEventListener('change', e => { pkgState.trip = e.target.value; pkgState.page = 1; loadB2CPackages(); });
    document.getElementById('pkgNewBtn').addEventListener('click', () => openNewPackage());
    document.getElementById('pkgTable').addEventListener('click', e => {
      const btn = e.target.closest('[data-pkg-open]');
      if (btn) openPackage(btn.dataset.pkgOpen);
    });
  }
  await loadB2CPackages();
}

async function loadB2CPackages(page = pkgState.page) {
  pkgState.page = page;
  const tbody = document.querySelector('#pkgTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(5)}</td></tr>`;
  try {
    const data = await catApi('get', '/packages', { params: {
      search: pkgState.search || undefined, trip_type: pkgState.trip || undefined,
      is_active: pkgState.status === '' ? undefined : pkgState.status === 'active',
      page, page_size: PAGE_SIZE,
    } });
    const summary = document.getElementById('pkgSummary');
    if (summary) summary.textContent = `${data.total} package${data.total === 1 ? '' : 's'}`;
    tbody.innerHTML = data.items.length ? data.items.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong>${p.destination ? `<div class="cell-sub">${escapeHtml(p.destination)}</div>` : ''}</td>
        <td>${p.trip_type ? escapeHtml(p.trip_type) : '—'}${p.category !== 'holiday' ? `<div class="cell-sub">${escapeHtml(p.category)}</div>` : ''}</td>
        <td class="num">${p.days}</td>
        <td class="num">${moneyStr(p.price_from)}</td>
        <td>${p.departures_upcoming
          ? `${p.departures_upcoming} upcoming<div class="cell-sub">next ${escapeHtml(p.next_departure)}</div>`
          : '<span class="badge pending">No departures</span>'}</td>
        <td>${catPill(p.is_active)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-pkg-open="${p.id}">Manage</button></td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No packages match this filter.</td></tr>`;
    renderPagination('pkgPagination', data.page, data.total_pages, data.total, loadB2CPackages);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(catErr(err, 'Failed to load packages.'))}</td></tr>`;
  }
}

/* ---------- create ---------- */

async function openNewPackage() {
  const image = await catImageField('pkgImage', 'package', '', 'Image');
  const body = catOpenModal(catModalShell('New tour package', `
    <p class="cp-readonly-note">A new package starts <strong>disabled</strong>. Add its departures and itinerary, then enable it.</p>
    <div class="msg" id="catMsg"></div>
    ${pkgCoreFields({ name: '', blurb: '', destination: '', trip_type: 'domestic', days: 4, nights: '', hotel_category: null,
      description: '', highlights: [], inclusions: [], exclusions: [], cancellation_policy: '' })}
    ${catField('Headline "from" price per person (₹)', catInput('pkgPrice', '', { type: 'number', attrs: 'min="1" step="0.01"' }))}
    ${image}
    <div class="cat-actions"><button type="button" class="btn btn-navy" id="pkgCreate">Create package</button></div>`));
  catWireImageFields(body);
  document.getElementById('pkgCreate').addEventListener('click', async e => {
    const data = { ...pkgReadCore(), price_from: catVal('pkgPrice'), image_key: catNullable('pkgImage') };
    if (data.nights === null) delete data.nights;
    const created = await catSave(e.currentTarget, () => catApi('post', '/packages', { data }), 'Package created (disabled).');
    if (created) { loadB2CPackages(1); pkgCurrent = created; pkgTab = 'pricing'; await renderPackage(); }
  });
}

/* ---------- manage ---------- */

async function openPackage(id, tab = 'details') {
  pkgTab = tab;
  catOpenModal(catModalShell('Tour package', rowsSkeleton(4)));
  try {
    pkgCurrent = await catApi('get', `/packages/${encodeURIComponent(id)}`);
  } catch (err) {
    catOpenModal(catModalShell('Tour package', `<p class="msg error">${escapeHtml(catErr(err, 'Could not load this package.'))}</p>`));
    return;
  }
  await renderPackage();
}

async function renderPackage() {
  const p = pkgCurrent;
  const panel = await ({ details: pkgDetailsPanel, pricing: pkgPricingPanel, itinerary: pkgItineraryPanel, image: pkgImagePanel }[pkgTab])(p);
  const warn = p.warnings.length
    ? `<div class="cp-readonly-note"><strong>Before customers can book this:</strong><ul style="margin:6px 0 0 18px; padding:0;">${
        p.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : '';
  const body = catOpenModal(`
    <div class="ops-modal-head"><h2>${escapeHtml(p.name)} ${catPill(p.is_active)}</h2>
      <button type="button" class="ops-modal-close" data-cat-close aria-label="Close">&times;</button></div>
    <div class="ops-modal-body">
      ${warn}
      ${catTabsHtml(PKG_TABS, pkgTab)}
      <div class="msg" id="catMsg"></div>
      ${panel}
    </div>`);
  body.querySelectorAll('[data-cat-tab]').forEach(b => b.addEventListener('click', () => { pkgTab = b.dataset.catTab; renderPackage(); }));
  catWireImageFields(body);
  pkgWirePanel(body);
}

/* The fields create and the Details tab share. */
function pkgCoreFields(p) {
  return `
    <div class="form-grid">
      ${catField('Name', catInput('pkgName', p.name, { attrs: 'maxlength="150"' }))}
      ${catField('Destination', catInput('pkgDestination', p.destination, { attrs: 'maxlength="120"' }), 'Where the trip goes; the listing filters on it.')}
      ${catField('Trip type', catSelect('pkgTrip', PKG_TRIPS, p.trip_type))}
      ${catField('Days', catInput('pkgDays', p.days, { type: 'number', attrs: 'min="1" max="60"' }))}
      ${catField('Nights', catInput('pkgNights', p.nights, { type: 'number', attrs: 'min="0" max="60" placeholder="days − 1"' }))}
      ${catField('Hotel standard', catSelect('pkgHotelCat', [['', 'Not stated'], [3, '3 star'], [4, '4 star'], [5, '5 star']], p.hotel_category))}
    </div>
    ${catField('Short blurb (card text)', catInput('pkgBlurb', p.blurb, { attrs: 'maxlength="300"' }))}
    ${catField('Description', catTextarea('pkgDescription', p.description, 4))}
    <div class="form-grid">
      ${catField('Highlights', catTextarea('pkgHighlights', catLinesOf(p.highlights), 4), 'One per line. The card shows the first few.')}
      ${catField('Inclusions', catTextarea('pkgInclusions', catLinesOf(p.inclusions), 4), 'One per line.')}
      ${catField('Exclusions', catTextarea('pkgExclusions', catLinesOf(p.exclusions), 4), 'One per line.')}
    </div>
    ${catField('Cancellation policy', catInput('pkgPolicy', p.cancellation_policy, { attrs: 'maxlength="255"' }))}`;
}

function pkgReadCore() {
  const nights = catTrim('pkgNights');
  return {
    name: catTrim('pkgName'), blurb: catTrim('pkgBlurb'), destination: catNullable('pkgDestination'),
    trip_type: catVal('pkgTrip'), days: Number(catVal('pkgDays')), nights: nights === '' ? null : Number(nights),
    hotel_category: catVal('pkgHotelCat') ? Number(catVal('pkgHotelCat')) : null,
    description: catNullable('pkgDescription'), highlights: catListFrom('pkgHighlights'),
    inclusions: catListFrom('pkgInclusions'), exclusions: catListFrom('pkgExclusions'),
    cancellation_policy: catNullable('pkgPolicy'),
  };
}

function pkgDetailsPanel(p) {
  return `${pkgCoreFields(p)}
    ${catCheck('pkgActive', p.is_active, 'Listed on the customer site')}
    <div class="cat-actions"><button type="button" class="btn btn-navy" id="pkgSaveDetails">Save details</button></div>`;
}

function pkgPricingPanel(p) {
  const rows = p.departures.map(d => `
    <tr data-pkg-dep="${d.id}">
      <td>${escapeHtml(d.departure_date)}${d.past ? ' <span class="cell-sub">past</span>' : ''}</td>
      <td class="num"><input type="number" min="1" step="0.01" value="${catE(d.price_per_person)}" data-dep-price ${d.past ? 'disabled' : ''} style="width:120px;"></td>
      <td class="num"><input type="number" min="0" max="500" value="${d.seats_left}" data-dep-seats ${d.past ? 'disabled' : ''} style="width:80px;"></td>
      <td><input type="checkbox" data-dep-active ${d.is_active ? 'checked' : ''} ${d.past ? 'disabled' : ''} aria-label="Bookable"></td>
      <td>${d.past ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-dep-save>Save</button>`}</td>
    </tr>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="form-grid">
      ${catField('Headline "from" price per person (₹)', catInput('pkgPrice', p.price_from, { type: 'number', attrs: 'min="1" step="0.01"' }),
        'The shelf price. Each departure below has its own price, which is what a booking is charged.')}
    </div>
    <div class="cat-actions" style="margin-top:0;"><button type="button" class="btn btn-navy" id="pkgSavePrice">Save headline price</button></div>

    <h3 style="margin:22px 0 8px; font-size:14px;">Departures</h3>
    <div class="table-wrap"><table><thead><tr>
      <th>Date</th><th class="num">Price / person (₹)</th><th class="num">Seats left</th><th>Bookable</th><th></th>
    </tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-state">No departures yet.</td></tr>'}</tbody></table></div>

    <h3 style="margin:18px 0 8px; font-size:14px;">Add a departure</h3>
    <div class="form-grid">
      ${catField('Date', catInput('depDate', '', { type: 'date', attrs: `min="${today}"` }))}
      ${catField('Price / person (₹)', catInput('depPrice', p.price_from, { type: 'number', attrs: 'min="1" step="0.01"' }))}
      ${catField('Seats', catInput('depSeats', 12, { type: 'number', attrs: 'min="0" max="500"' }))}
    </div>
    <div class="cat-actions"><button type="button" class="btn btn-navy" id="depAdd">Add departure</button></div>
    <p class="cp-readonly-note">A departure's date cannot be changed once created — bookings are made against it. To move one, disable it and add the new date.</p>`;
}

function pkgItineraryPanel(p) {
  return `
    <p class="cp-readonly-note">Days are numbered in the order shown. Saving replaces the whole itinerary; a package of ${p.days} day${p.days === 1 ? '' : 's'} can have at most ${p.days}.</p>
    <div id="itinDays"></div>
    <div class="cat-actions">
      <button type="button" class="btn btn-ghost" id="itinAdd">Add a day</button>
      <button type="button" class="btn btn-navy" id="itinSave">Save itinerary</button>
    </div>`;
}

async function pkgImagePanel(p) {
  return `${await catImageField('pkgImage', 'package', p.image_key, 'Package image')}
    <div class="cat-actions"><button type="button" class="btn btn-navy" id="pkgSaveImage">Save image</button></div>`;
}

/* ---------- itinerary editor ---------- */

function itinDayHtml(d, i) {
  const meal = m => `<label style="display:inline-flex; gap:5px; align-items:center; font-size:12.5px; font-weight:600; text-transform:none; letter-spacing:0; margin-right:12px;">
      <input type="checkbox" data-itin-meal="${m}" ${(d.meals || []).includes(m) ? 'checked' : ''} style="width:auto;"> ${m[0].toUpperCase() + m.slice(1)}</label>`;
  return `
    <div class="panel" data-itin-day style="padding:14px; margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <strong data-itin-label>Day ${i + 1}</strong>
        <button type="button" class="btn btn-ghost btn-sm" data-itin-remove>Remove</button>
      </div>
      <div class="form-grid">
        <div class="form-field" style="max-width:none;"><label>Title</label><input type="text" data-itin-title maxlength="160" value="${catE(d.title)}"></div>
        <div class="form-field" style="max-width:none;"><label>Place</label><input type="text" data-itin-location maxlength="120" value="${catE(d.location)}"></div>
      </div>
      <div class="form-field" style="max-width:none;"><label>What happens</label><textarea data-itin-desc rows="2">${catE(d.description)}</textarea></div>
      <div>${['breakfast', 'lunch', 'dinner'].map(meal).join('')}</div>
    </div>`;
}

function itinRenumber() {
  document.querySelectorAll('#itinDays [data-itin-day]').forEach((el, i) => {
    el.querySelector('[data-itin-label]').textContent = `Day ${i + 1}`;
  });
}

function itinCollect() {
  return [...document.querySelectorAll('#itinDays [data-itin-day]')].map((el, i) => ({
    day_number: i + 1,
    title: el.querySelector('[data-itin-title]').value.trim(),
    location: el.querySelector('[data-itin-location]').value.trim() || null,
    description: el.querySelector('[data-itin-desc]').value.trim() || null,
    meals: [...el.querySelectorAll('[data-itin-meal]:checked')].map(c => c.dataset.itinMeal),
  }));
}

/* ---------- wiring + saves ---------- */

async function pkgPatch(btn, changes, done) {
  const updated = await catSave(btn, () => catApi('patch', `/packages/${pkgCurrent.id}`, { data: changes }), done);
  if (updated) { pkgCurrent = updated; loadB2CPackages(pkgState.page); await renderPackage(); }
}

function pkgWirePanel(root) {
  const p = pkgCurrent;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', () => fn(el)); };

  if (pkgTab === 'details') {
    on('pkgSaveDetails', btn => {
      const changes = { ...pkgReadCore(), is_active: catChecked('pkgActive') };
      if (p.is_active && !changes.is_active &&
          !confirm(`Disable ${p.name}? It will stop appearing on the customer site. Existing bookings are not affected.`)) return;
      pkgPatch(btn, changes, 'Package saved.');
    });
  }

  if (pkgTab === 'image') {
    on('pkgSaveImage', btn => pkgPatch(btn, { image_key: catNullable('pkgImage') }, 'Image saved.'));
  }

  if (pkgTab === 'pricing') {
    on('pkgSavePrice', btn => pkgPatch(btn, { price_from: catVal('pkgPrice') }, 'Headline price saved.'));
    on('depAdd', async btn => {
      const data = { departure_date: catVal('depDate'), price_per_person: catVal('depPrice'), seats_left: Number(catVal('depSeats')) };
      if (!data.departure_date) return catMsg('Choose a departure date.', true);
      const updated = await catSave(btn, () => catApi('post', `/packages/${p.id}/departures`, { data }), 'Departure added.');
      if (updated) { pkgCurrent = updated; loadB2CPackages(pkgState.page); await renderPackage(); }
    });
    root.querySelectorAll('[data-dep-save]').forEach(btn => btn.addEventListener('click', async () => {
      const row = btn.closest('[data-pkg-dep]');
      const data = {
        price_per_person: row.querySelector('[data-dep-price]').value,
        seats_left: Number(row.querySelector('[data-dep-seats]').value),
        is_active: row.querySelector('[data-dep-active]').checked,
      };
      const updated = await catSave(btn, () => catApi('patch', `/packages/${p.id}/departures/${row.dataset.pkgDep}`, { data }), 'Departure saved.');
      if (updated) { pkgCurrent = updated; loadB2CPackages(pkgState.page); await renderPackage(); }
    }));
  }

  if (pkgTab === 'itinerary') {
    const host = document.getElementById('itinDays');
    host.innerHTML = p.itinerary.map(itinDayHtml).join('');
    host.addEventListener('click', e => {
      const rm = e.target.closest('[data-itin-remove]');
      if (rm) { rm.closest('[data-itin-day]').remove(); itinRenumber(); }
    });
    on('itinAdd', () => {
      host.insertAdjacentHTML('beforeend', itinDayHtml({}, host.children.length));
      itinRenumber();
    });
    on('itinSave', async btn => {
      const days = itinCollect();
      if (days.some(d => !d.title)) return catMsg('Every day needs a title.', true);
      const updated = await catSave(btn, () => catApi('put', `/packages/${p.id}/itinerary`, { data: { days } }), 'Itinerary saved.');
      if (updated) { pkgCurrent = updated; loadB2CPackages(pkgState.page); await renderPackage(); }
    });
  }
}
