/* Admin — B2C Catalogue: Hotels (Phase 5 of the B2C Admin Portal build-out)
   ==================================================================
   Edits the SAME hotel and room rows the customer site's Hotel Results and
   Details already read — no second catalogue. A disabled hotel or room is
   simply not offered any more; nothing is ever deleted (a sold room is
   referenced by bookings).

   WHAT CANNOT BE EDITED, AND WHY (the modal says so where it applies):
     - The hotel's "from" price. It follows the cheapest active room, so the
       card can never quote a price no room sells at.
     - A supplier-synced hotel's name/description/amenities/location/active
       flag: the sync rewrites them every run, so an edit would not last.

   HOTEL PHOTOS: the customer site currently picks a hotel's photograph by
   matching the property NAME (hotel-image-map.js), not from the row's image
   key. The keys chosen here are stored on the row, but the site does not read
   them yet — the modal states this rather than promising a visible change.

   ENDPOINTS (all under /api/admin/catalogue/hotels):
     GET  ""  paged list      GET /{id}  detail + rooms     PATCH /{id}  edit
     POST /{id}/rooms         PATCH /{id}/rooms/{room_id}

   Uses admin-b2c-catalogue-common.js and admin.js's helpers. */

const htlState = { search: '', status: '', page: 1 };
let htlWired = false;
let htlCurrent = null;     // the hotel detail open in the modal
let htlTab = 'details';
let htlDestinations = [];  // for the destination <select>

const HTL_TABS = [['details', 'Details'], ['rooms', 'Rooms'], ['amenities', 'Amenities'], ['images', 'Images']];
const HTL_MEAL_PLANS = ['Room only', 'Breakfast included', 'Half board', 'Full board'];

async function initB2CHotels() {
  if (!htlWired) {
    htlWired = true;
    const search = document.getElementById('htlSearch');
    search.addEventListener('input', catDebounce(() => {
      htlState.search = search.value.trim(); htlState.page = 1; loadB2CHotels();
    }));
    document.getElementById('htlStatusFilter').addEventListener('change', e => {
      htlState.status = e.target.value; htlState.page = 1; loadB2CHotels();
    });
    document.getElementById('htlTable').addEventListener('click', e => {
      const btn = e.target.closest('[data-htl-open]');
      if (btn) openHotel(btn.dataset.htlOpen);
    });
  }
  await loadB2CHotels();
}

async function loadB2CHotels(page = htlState.page) {
  htlState.page = page;
  const tbody = document.querySelector('#htlTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(5)}</td></tr>`;
  try {
    const data = await catApi('get', '/hotels', { params: {
      search: htlState.search || undefined,
      is_active: htlState.status === '' ? undefined : htlState.status === 'active',
      page, page_size: PAGE_SIZE,
    } });
    const summary = document.getElementById('htlSummary');
    if (summary) summary.textContent = `${data.total} hotel${data.total === 1 ? '' : 's'}`;
    tbody.innerHTML = data.items.length ? data.items.map(h => `
      <tr>
        <td><strong>${escapeHtml(h.name)}</strong>${h.source !== 'seed' ? '<div class="cell-sub">Supplier-synced</div>' : ''}</td>
        <td>${escapeHtml(h.location)}${h.destination ? `<div class="cell-sub">${escapeHtml(h.destination)}</div>` : ''}</td>
        <td>${'★'.repeat(h.star_rating)}</td>
        <td class="num">${Number(h.price_per_night) > 0 ? moneyStr(h.price_per_night) : '—'}</td>
        <td class="num">${h.rooms_active} / ${h.rooms_total}</td>
        <td>${catPill(h.is_active)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-htl-open="${h.id}">Manage</button></td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No hotels match this filter.</td></tr>`;
    renderPagination('htlPagination', data.page, data.total_pages, data.total, loadB2CHotels);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(catErr(err, 'Failed to load hotels.'))}</td></tr>`;
  }
}

async function openHotel(id, tab = 'details') {
  htlTab = tab;
  catOpenModal(catModalShell('Hotel', rowsSkeleton(4)));
  try {
    if (!htlDestinations.length) htlDestinations = await catApi('get', '/destinations');
    htlCurrent = await catApi('get', `/hotels/${encodeURIComponent(id)}`);
  } catch (err) {
    catOpenModal(catModalShell('Hotel', `<p class="msg error">${escapeHtml(catErr(err, 'Could not load this hotel.'))}</p>`));
    return;
  }
  await renderHotel();
}

async function renderHotel() {
  const h = htlCurrent;
  const syncNote = h.sync_owned
    ? `<p class="cp-readonly-note">This hotel is synced from its supplier. Its name, description, amenities, location and active flag are rewritten on every sync, so they are locked here.</p>` : '';
  const panel = await ({
    details: htlDetailsPanel, rooms: htlRoomsPanel, amenities: htlAmenitiesPanel, images: htlImagesPanel,
  }[htlTab])(h);
  const body = catOpenModal(`
    <div class="ops-modal-head"><h2>${escapeHtml(h.name)} ${catPill(h.is_active)}</h2>
      <button type="button" class="ops-modal-close" data-cat-close aria-label="Close">&times;</button></div>
    <div class="ops-modal-body">
      ${syncNote}
      ${catTabsHtml(HTL_TABS, htlTab)}
      <div class="msg" id="catMsg"></div>
      ${panel}
    </div>`);
  body.querySelectorAll('[data-cat-tab]').forEach(b => b.addEventListener('click', () => {
    htlTab = b.dataset.catTab; renderHotel();
  }));
  catWireImageFields(body);
  htlWirePanel(body);
}

/* -------- panels -------- */

function htlDetailsPanel(h) {
  const lock = h.sync_owned ? 'disabled' : '';
  const dests = [['', '— none —'], ...htlDestinations.map(d => [d.id, d.name])];
  return `
    <div class="form-grid">
      ${catField('Name', catInput('htlName', h.name, { attrs: `maxlength="150" ${lock}` }))}
      ${catField('Star rating', catSelect('htlStars', [1, 2, 3, 4, 5].map(n => [n, `${n} star`]), h.star_rating, lock))}
      ${catField('Display location', catInput('htlLocation', h.location, { attrs: `maxlength="200" ${lock}` }), 'The line shown on the results card, e.g. "Banjara Hills, Hyderabad".')}
      ${catField('City', catInput('htlCity', h.city, { attrs: `maxlength="120" ${lock}` }))}
    </div>
    ${catField('Address', catInput('htlAddress', h.address, { attrs: `maxlength="255" ${lock}` }))}
    <div class="form-grid">
      ${catField('Destination', catSelect('htlDestination', dests, h.destination_id, lock))}
      ${catField('Location within destination', `<select id="htlLocationId" ${lock}></select>`)}
    </div>
    ${catField('Description', catTextarea('htlDescription', h.description, 4).replace('<textarea', `<textarea ${lock}`))}
    ${catField('Cancellation policy', catInput('htlPolicy', h.cancellation_policy, { attrs: 'maxlength="255"' }),
      'Starting with "Free cancellation" makes the site show the free-cancellation badge.')}
    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">From price / night</span>
        <span class="detail-value">${Number(h.price_per_night) > 0 ? moneyStr(h.price_per_night) : '—'}</span>
        <span class="cell-sub">Follows the cheapest active room — change it on the Rooms tab.</span></div>
      <div class="detail-item"><span class="detail-label">Guest rating</span>
        <span class="detail-value">${h.guest_rating != null ? escapeHtml(h.guest_rating) : '—'}</span></div>
    </div>
    ${catCheck('htlActive', h.is_active, 'Listed on the customer site').replace('<input', h.sync_owned ? '<input disabled' : '<input')}
    <div class="cat-actions">
      <button type="button" class="btn btn-navy" id="htlSaveDetails">Save details</button>
    </div>`;
}

function htlRoomsPanel(h) {
  const rows = h.rooms.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong><div class="cell-sub">${escapeHtml(r.code)}</div></td>
      <td>${escapeHtml(r.meal_plan)}</td>
      <td class="num">${r.max_guests}</td>
      <td class="num">${moneyStr(r.base_price_per_night)}</td>
      <td class="num">${r.total_inventory}</td>
      <td>${catPill(r.is_active)}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-htl-room="${r.id}">Edit</button></td>
    </tr>`).join('');
  return `
    <div class="table-wrap"><table><thead><tr>
      <th>Room</th><th>Meal plan</th><th class="num">Guests</th><th class="num">Price / night</th>
      <th class="num">Units</th><th>Status</th><th></th>
    </tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty-state">No rooms yet.</td></tr>'}</tbody></table></div>
    <div class="cat-actions"><button type="button" class="btn btn-navy" data-htl-room="new">Add room</button></div>
    <div id="htlRoomForm"></div>`;
}

function htlAmenitiesPanel(h) {
  return `
    ${catField('Amenities', catTextarea('htlAmenities', catLinesOf(h.amenities), 10),
      'One per line, e.g. "Free Wi-Fi". Shown as the hotel\'s amenity list. Duplicates and blanks are dropped.')}
    <div class="cat-actions">
      <button type="button" class="btn btn-navy" id="htlSaveAmenities" ${h.sync_owned ? 'disabled' : ''}>Save amenities</button>
    </div>`;
}

async function htlImagesPanel(h) {
  const primary = await catImageField('htlImageKey', 'hotel', h.image_key, 'Primary image');
  const extra = await catImageField('htlImageExtra', 'hotel', '', 'Add to gallery');
  return `
    <p class="cp-readonly-note">The customer site currently picks a hotel's photograph by matching its
      <em>name</em>, not from these keys — they are stored on the hotel for when it reads them, so saving here will not change what customers see today.</p>
    ${primary}
    ${catField('Gallery', `<div id="htlGallery" style="display:flex; gap:8px; flex-wrap:wrap;">${
      h.images.length ? h.images.map(k => `<span class="badge refunded" style="display:inline-flex; gap:6px; align-items:center;">${escapeHtml(k)}
        <button type="button" data-htl-rm-image="${escapeHtml(k)}" aria-label="Remove ${escapeHtml(k)}" style="border:0; background:none; cursor:pointer; font-size:14px; line-height:1;" ${h.sync_owned ? 'disabled' : ''}>&times;</button></span>`).join('')
        : '<span class="cell-sub">No gallery images.</span>'}</div>`)}
    ${extra}
    <div class="cat-actions">
      <button type="button" class="btn btn-ghost" id="htlAddGallery" ${h.sync_owned ? 'disabled' : ''}>Add to gallery</button>
      <button type="button" class="btn btn-navy" id="htlSaveImages">Save primary image</button>
    </div>`;
}

/* -------- wiring + saves -------- */

async function htlPatch(btn, changes, done) {
  const updated = await catSave(btn, () => catApi('patch', `/hotels/${htlCurrent.id}`, { data: changes }), done);
  if (updated) { htlCurrent = updated; loadB2CHotels(htlState.page); await renderHotel(); }
}

function htlWirePanel(root) {
  const h = htlCurrent;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', () => fn(el)); };

  if (htlTab === 'details') {
    const destSel = document.getElementById('htlDestination');
    const locSel = document.getElementById('htlLocationId');
    const fillLocations = async (destId, chosen) => {
      if (!destId) { locSel.innerHTML = '<option value="">— none —</option>'; return; }
      try {
        const d = await catApi('get', `/destinations/${encodeURIComponent(destId)}`);
        locSel.innerHTML = '<option value="">— none —</option>' + d.locations.map(l =>
          `<option value="${l.id}"${String(l.id) === String(chosen) ? ' selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
      } catch { locSel.innerHTML = '<option value="">— could not load —</option>'; }
    };
    fillLocations(destSel.value, h.location_id);
    destSel.addEventListener('change', () => fillLocations(destSel.value, ''));
    on('htlSaveDetails', btn => {
      const changes = {
        cancellation_policy: catNullable('htlPolicy'),
      };
      if (!h.sync_owned) {
        Object.assign(changes, {
          name: catTrim('htlName'), star_rating: Number(catVal('htlStars')), location: catTrim('htlLocation'),
          city: catNullable('htlCity'), address: catNullable('htlAddress'), description: catNullable('htlDescription'),
          destination_id: destSel.value ? Number(destSel.value) : null,
          location_id: locSel.value ? Number(locSel.value) : null,
          is_active: catChecked('htlActive'),
        });
      }
      /* Turning a hotel off is the one edit that removes it from sale, so it
         asks first — the same confirm() the other admin destructive-ish
         toggles use. */
      if (!h.sync_owned && h.is_active && !changes.is_active &&
          !confirm(`Disable ${h.name}? It will stop appearing on the customer site. Existing bookings are not affected.`)) return;
      htlPatch(btn, changes, 'Hotel saved.');
    });
  }

  if (htlTab === 'amenities') {
    on('htlSaveAmenities', btn => htlPatch(btn, { amenities: catListFrom('htlAmenities') }, 'Amenities saved.'));
  }

  if (htlTab === 'images') {
    on('htlSaveImages', btn => htlPatch(btn, { image_key: catNullable('htlImageKey') }, 'Image saved.'));
    on('htlAddGallery', btn => {
      const key = catVal('htlImageExtra');
      if (!key) return catMsg('Choose an image to add.', true);
      htlPatch(btn, { images: [...h.images, key] }, 'Gallery updated.');
    });
    root.querySelectorAll('[data-htl-rm-image]').forEach(b => b.addEventListener('click', () =>
      htlPatch(b, { images: h.images.filter(k => k !== b.dataset.htlRmImage) }, 'Gallery updated.')));
  }

  if (htlTab === 'rooms') {
    root.querySelectorAll('[data-htl-room]').forEach(b => b.addEventListener('click', () =>
      htlRoomForm(b.dataset.htlRoom === 'new' ? null : h.rooms.find(r => String(r.id) === b.dataset.htlRoom))));
  }
}

function htlRoomForm(room) {
  const isNew = !room;
  const r = room || { code: '', name: '', description: '', bed_type: '', size_label: '', max_guests: 2,
    base_price_per_night: '', meal_plan: 'Room only', cancellation_policy: '', perks: [], total_inventory: 5, is_active: true };
  const plans = HTL_MEAL_PLANS.includes(r.meal_plan) ? HTL_MEAL_PLANS : [...HTL_MEAL_PLANS, r.meal_plan];
  const host = document.getElementById('htlRoomForm');
  host.innerHTML = `
    <h3 style="margin:18px 0 8px; font-size:14px;">${isNew ? 'New room' : `Edit ${escapeHtml(r.name)}`}</h3>
    <div class="form-grid">
      ${catField('Name', catInput('rmName', r.name, { attrs: 'maxlength="120"' }))}
      ${catField('Code', catInput('rmCode', r.code, { attrs: `maxlength="20" ${isNew ? '' : 'disabled'}` }),
        isNew ? 'Short and unique within this hotel, e.g. "deluxe". Cannot change later.' : 'Fixed — bookings were made against it.')}
      ${catField('Price per night (₹)', catInput('rmPrice', r.base_price_per_night, { type: 'number', attrs: 'min="1" step="0.01"' }))}
      ${catField('Meal plan', catSelect('rmMeal', plans.map(p => [p, p]), r.meal_plan))}
      ${catField('Max guests', catInput('rmGuests', r.max_guests, { type: 'number', attrs: 'min="1" max="20"' }))}
      ${catField('Units available', catInput('rmInventory', r.total_inventory, { type: 'number', attrs: 'min="0" max="1000"' }))}
      ${catField('Bed type', catInput('rmBed', r.bed_type, { attrs: 'maxlength="60"' }))}
      ${catField('Size', catInput('rmSize', r.size_label, { attrs: 'maxlength="30" placeholder="e.g. 32 m²"' }))}
    </div>
    ${catField('Description', catInput('rmDesc', r.description, { attrs: 'maxlength="400"' }))}
    ${catField('Room cancellation policy', catInput('rmPolicy', r.cancellation_policy, { attrs: 'maxlength="255"' }))}
    ${catField('Perks', catTextarea('rmPerks', catLinesOf(r.perks), 3), 'One per line.')}
    ${catCheck('rmActive', r.is_active, 'Offered to customers')}
    <div class="cat-actions">
      <button type="button" class="btn btn-navy" id="rmSave">${isNew ? 'Add room' : 'Save room'}</button>
    </div>`;
  document.getElementById('rmSave').addEventListener('click', async e => {
    const data = {
      name: catTrim('rmName'), base_price_per_night: catVal('rmPrice'), meal_plan: catVal('rmMeal'),
      max_guests: Number(catVal('rmGuests')), total_inventory: Number(catVal('rmInventory')),
      bed_type: catNullable('rmBed'), size_label: catNullable('rmSize'), description: catNullable('rmDesc'),
      cancellation_policy: catNullable('rmPolicy'), perks: catListFrom('rmPerks'), is_active: catChecked('rmActive'),
    };
    if (isNew) data.code = catTrim('rmCode');
    if (!isNew && r.is_active && !data.is_active &&
        !confirm(`Disable ${r.name}? Customers will no longer be able to book it.`)) return;
    const saved = await catSave(e.currentTarget, () => isNew
      ? catApi('post', `/hotels/${htlCurrent.id}/rooms`, { data })
      : catApi('patch', `/hotels/${htlCurrent.id}/rooms/${r.id}`, { data }), isNew ? 'Room added.' : 'Room saved.');
    if (saved) {
      htlCurrent = await catApi('get', `/hotels/${htlCurrent.id}`);
      loadB2CHotels(htlState.page);
      await renderHotel();
    }
  });
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
