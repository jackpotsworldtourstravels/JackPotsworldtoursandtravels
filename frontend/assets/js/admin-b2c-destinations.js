/* Admin — B2C Catalogue: Destinations (Phase 5 of the B2C Admin Portal
   build-out)
   ==================================================================
   Edits the SAME destination and location rows behind the customer site's
   homepage shelf, destination pages and hotel filters — no second catalogue.
   Nothing is deleted; "Disabled" withdraws a destination or location.

   "POPULAR" IS THE HOMEPAGE ORDER. There is no popular flag: the customer
   site shows the first few active destinations (by this order) on the
   homepage and the rest behind "show more". So a destination is popular when
   it sits inside that window, and making one popular means moving it up —
   which is what the arrows do. The server says which rows are inside the
   window (`popular`), so this file holds no copy of that number.

   DESCRIPTIONS live on LOCATIONS (the line printed on each place's card). A
   destination itself has no description in the schema and the site renders
   none, so none is offered.

   A DESTINATION'S ADDRESS (slug) IS FIXED once created — it is in public
   URLs and in image keys — so renaming changes the display name only.

   ENDPOINTS (all under /api/admin/catalogue/destinations):
     GET "" list (homepage order)     POST "" create      PUT /order  reorder
     GET /{id}  detail + locations    PATCH /{id}  edit
     POST /{id}/locations             PATCH /{id}/locations/{location_id}

   Uses admin-b2c-catalogue-common.js and admin.js's helpers. */

let dstWired = false;
let dstList = [];         // every destination, in homepage order
let dstCurrent = null;    // the destination detail open in the modal
let dstTab = 'details';

const DST_TABS = [['details', 'Details'], ['locations', 'Locations & descriptions']];

async function initB2CDestinations() {
  if (!dstWired) {
    dstWired = true;
    document.getElementById('dstNewBtn').addEventListener('click', () => openNewDestination());
    document.getElementById('dstTable').addEventListener('click', e => {
      const open = e.target.closest('[data-dst-open]');
      if (open) return openDestination(open.dataset.dstOpen);
      const mv = e.target.closest('[data-dst-move]');
      if (mv) moveDestination(Number(mv.dataset.dstId), mv.dataset.dstMove === 'up' ? -1 : 1, mv);
    });
  }
  await loadB2CDestinations();
}

async function loadB2CDestinations() {
  const tbody = document.querySelector('#dstTable tbody');
  tbody.innerHTML = `<tr><td colspan="7">${rowsSkeleton(6)}</td></tr>`;
  try {
    const [list, images] = await Promise.all([catApi('get', '/destinations'), catImages('destination')]);
    dstList = list;
    const popular = list.filter(d => d.popular).length;
    const summary = document.getElementById('dstSummary');
    if (summary) summary.textContent = `${list.length} destinations · ${popular} on the homepage shelf`;
    tbody.innerHTML = list.map((d, i) => {
      const thumb = catThumbSrc(images, d.image_key);
      return `<tr>
        <td class="num">${d.position != null ? d.position : '—'}</td>
        <td><div style="display:flex; gap:10px; align-items:center;">
          ${thumb ? `<img src="${catE(thumb)}" alt="" width="48" height="32" style="object-fit:cover; border-radius:6px;">`
                  : '<span style="width:48px; height:32px; border-radius:6px; background:rgba(10,37,64,.06); display:inline-block;"></span>'}
          <div><strong>${escapeHtml(d.name)}</strong><div class="cell-sub">${escapeHtml(d.country || '—')} · /${escapeHtml(d.slug)}</div></div></div></td>
        <td>${d.popular ? '<span class="badge confirmed">Popular</span>' : d.is_active ? '<span class="cell-sub">Behind “show more”</span>' : '—'}</td>
        <td class="num">${d.locations_total}</td>
        <td class="num">${d.hotels_active}</td>
        <td>${catPill(d.is_active)}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="btn btn-ghost btn-sm" data-dst-move="up" data-dst-id="${d.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(d.name)} up">↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-dst-move="down" data-dst-id="${d.id}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(d.name)} down">↓</button>
          <button type="button" class="btn btn-ghost btn-sm" data-dst-open="${d.id}">Manage</button>
        </td></tr>`;
    }).join('') || `<tr><td colspan="7" class="empty-state">No destinations yet.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(catErr(err, 'Failed to load destinations.'))}</td></tr>`;
  }
}

/* Swap with the neighbour and send the whole new order — the server refuses a
   partial or stale list, so two admins cannot silently overwrite each other. */
async function moveDestination(id, delta, btn) {
  const ids = dstList.map(d => d.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  btn.disabled = true;
  try {
    await catApi('put', '/destinations/order', { data: { ids } });
    if (typeof showToast === 'function') showToast('Homepage order updated.');
  } catch (err) {
    if (typeof showToast === 'function') showToast(catErr(err, 'Could not reorder.'), true);
  }
  await loadB2CDestinations();
}

/* ---------- create ---------- */

async function openNewDestination() {
  const image = await catImageField('dstImage', 'destination', '', 'Image');
  const body = catOpenModal(catModalShell('New destination', `
    <p class="cp-readonly-note">It is added at the end of the homepage order (behind “show more”) — move it up to make it popular. Its public address is made from the name and cannot change later.</p>
    <div class="msg" id="catMsg"></div>
    <div class="form-grid">
      ${catField('Name', catInput('dstName', '', { attrs: 'maxlength="120"' }))}
      ${catField('Country', catInput('dstCountry', '', { attrs: 'maxlength="80"' }))}
    </div>
    ${image}
    <div class="cat-actions"><button type="button" class="btn btn-navy" id="dstCreate">Create destination</button></div>`));
  catWireImageFields(body);
  document.getElementById('dstCreate').addEventListener('click', async e => {
    const data = { name: catTrim('dstName'), country: catNullable('dstCountry'), image_key: catNullable('dstImage') };
    const created = await catSave(e.currentTarget, () => catApi('post', '/destinations', { data }), 'Destination created.');
    if (created) { loadB2CDestinations(); dstCurrent = created; dstTab = 'locations'; await renderDestination(); }
  });
}

/* ---------- manage ---------- */

async function openDestination(id, tab = 'details') {
  dstTab = tab;
  catOpenModal(catModalShell('Destination', rowsSkeleton(4)));
  try {
    dstCurrent = await catApi('get', `/destinations/${encodeURIComponent(id)}`);
  } catch (err) {
    catOpenModal(catModalShell('Destination', `<p class="msg error">${escapeHtml(catErr(err, 'Could not load this destination.'))}</p>`));
    return;
  }
  await renderDestination();
}

async function renderDestination() {
  const d = dstCurrent;
  const panel = await (dstTab === 'details' ? dstDetailsPanel : dstLocationsPanel)(d);
  const body = catOpenModal(`
    <div class="ops-modal-head"><h2>${escapeHtml(d.name)} ${catPill(d.is_active)}</h2>
      <button type="button" class="ops-modal-close" data-cat-close aria-label="Close">&times;</button></div>
    <div class="ops-modal-body">
      ${catTabsHtml(DST_TABS, dstTab)}
      <div class="msg" id="catMsg"></div>
      ${panel}
    </div>`);
  body.querySelectorAll('[data-cat-tab]').forEach(b => b.addEventListener('click', () => { dstTab = b.dataset.catTab; renderDestination(); }));
  catWireImageFields(body);
  dstWirePanel(body);
}

async function dstDetailsPanel(d) {
  return `
    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">Public address</span><span class="detail-value">/${escapeHtml(d.slug)}</span>
        <span class="cell-sub">Fixed — used in links and image keys.</span></div>
      <div class="detail-item"><span class="detail-label">Homepage position</span>
        <span class="detail-value">${d.position != null ? d.position : 'Not shown (disabled)'} ${d.popular ? '<span class="badge confirmed">Popular</span>' : ''}</span>
        <span class="cell-sub">Change it with the arrows on the list.</span></div>
      <div class="detail-item"><span class="detail-label">Active hotels here</span><span class="detail-value">${d.hotels_active}</span></div>
    </div>
    <div class="form-grid" style="margin-top:14px;">
      ${catField('Name', catInput('dstName', d.name, { attrs: 'maxlength="120"' }))}
      ${catField('Country', catInput('dstCountry', d.country, { attrs: 'maxlength="80"' }))}
    </div>
    ${await catImageField('dstImage', 'destination', d.image_key, 'Image')}
    ${catCheck('dstActive', d.is_active, 'Shown on the customer site')}
    <div class="cat-actions"><button type="button" class="btn btn-navy" id="dstSave">Save destination</button></div>`;
}

async function dstLocationsPanel(d) {
  const rows = d.locations.map(l => `
    <tr>
      <td><strong>${escapeHtml(l.name)}</strong><div class="cell-sub">${escapeHtml(l.slug)}</div></td>
      <td class="jp-truncate" title="${catE(l.description)}">${l.description ? escapeHtml(l.description) : '<span class="cell-sub">No description</span>'}</td>
      <td class="num">${l.hotels_active}</td>
      <td>${catPill(l.is_active)}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-loc="${l.id}">Edit</button></td>
    </tr>`).join('');
  return `
    <div class="table-wrap"><table><thead><tr>
      <th>Location</th><th>Description</th><th class="num">Hotels</th><th>Status</th><th></th>
    </tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-state">No locations yet.</td></tr>'}</tbody></table></div>
    <div class="cat-actions"><button type="button" class="btn btn-navy" data-loc="new">Add location</button></div>
    <div id="locForm"></div>`;
}

async function dstWirePanel(root) {
  const d = dstCurrent;
  if (dstTab === 'details') {
    document.getElementById('dstSave').addEventListener('click', async e => {
      const data = { name: catTrim('dstName'), country: catNullable('dstCountry'), image_key: catNullable('dstImage'), is_active: catChecked('dstActive') };
      if (d.is_active && !data.is_active &&
          !confirm(`Disable ${d.name}? It disappears from the homepage and destination pages${d.hotels_active ? `, and ${d.hotels_active} active hotel${d.hotels_active === 1 ? '' : 's'} filed under it lose their destination page` : ''}.`)) return;
      const updated = await catSave(e.currentTarget, () => catApi('patch', `/destinations/${d.id}`, { data }), 'Destination saved.');
      if (updated) { dstCurrent = updated; loadB2CDestinations(); await renderDestination(); }
    });
  } else {
    root.querySelectorAll('[data-loc]').forEach(b => b.addEventListener('click', () =>
      dstLocationForm(b.dataset.loc === 'new' ? null : d.locations.find(l => String(l.id) === b.dataset.loc))));
  }
}

async function dstLocationForm(loc) {
  const isNew = !loc;
  const l = loc || { name: '', description: '', image_key: '', sort_order: '', is_active: true };
  const host = document.getElementById('locForm');
  host.innerHTML = `
    <h3 style="margin:18px 0 8px; font-size:14px;">${isNew ? 'New location' : `Edit ${escapeHtml(l.name)}`}</h3>
    <div class="form-grid">
      ${catField('Name', catInput('locName', l.name, { attrs: 'maxlength="120"' }))}
      ${catField('Order', catInput('locOrder', isNew ? '' : l.sort_order, { type: 'number', attrs: 'min="0" max="32000" placeholder="last"' }), 'Lower first.')}
    </div>
    ${catField('Description', catTextarea('locDesc', l.description, 3), 'The line printed on this place\'s card on the destination page. Leave empty to show the name alone.')}
    ${await catImageField('locImage', 'location', l.image_key, 'Image')}
    ${catCheck('locActive', l.is_active, 'Shown on the customer site')}
    <div class="cat-actions"><button type="button" class="btn btn-navy" id="locSave">${isNew ? 'Add location' : 'Save location'}</button></div>`;
  catWireImageFields(host);
  document.getElementById('locSave').addEventListener('click', async e => {
    const order = catTrim('locOrder');
    const data = { name: catTrim('locName'), description: catNullable('locDesc'), image_key: catNullable('locImage'), is_active: catChecked('locActive') };
    if (order !== '') data.sort_order = Number(order);
    const updated = await catSave(e.currentTarget, () => isNew
      ? catApi('post', `/destinations/${dstCurrent.id}/locations`, { data })
      : catApi('patch', `/destinations/${dstCurrent.id}/locations/${l.id}`, { data }), isNew ? 'Location added.' : 'Location saved.');
    if (updated) { dstCurrent = updated; loadB2CDestinations(); await renderDestination(); }
  });
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
