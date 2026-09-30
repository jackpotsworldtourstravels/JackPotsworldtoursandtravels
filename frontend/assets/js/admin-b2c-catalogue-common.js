/* Admin — B2C Catalogue Management, shared pieces (Phase 5 of the B2C Admin
   Portal build-out)
   ==================================================================
   What the four catalogue screens (Flights, Hotels, Tour Packages,
   Destinations) all need, written once so none of them restates it: one
   shared modal, an API wrapper that turns FastAPI's error shapes into a
   sentence, the small form-field builders, and the image picker.

   IMAGES ARE A PICKER OVER SHIPPED ARTWORK, NOT AN UPLOAD. A catalogue row
   holds an image KEY that names a photograph which ships with the site
   (assets/destinations, assets/locations, assets/hotels); the customer pages
   turn a key into a path and never accept a URL. So the field below chooses
   among the keys the server says exist — see services/catalogue_images.py.

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, rowsSkeleton) and showToast from components/toast.js. Each
   screen's own file is loaded after this one. */

/* ---------- API ---------- */

/* FastAPI answers a business-rule refusal with {detail: "sentence"} and a
   validation failure with {detail: [{loc, msg}, ...]}. Both become one line. */
function catErr(err, fallback = 'Could not save this change.') {
  const d = err && err.response && err.response.data && err.response.data.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d.length) {
    return d.map(x => {
      const field = Array.isArray(x.loc) ? x.loc.filter(p => p !== 'body').join(' › ').replace(/_/g, ' ') : '';
      /* Pydantic's own wording is written for developers. The two a desk user
         actually hits — a required field left empty, and a number field with
         no number in it — get plain versions; anything else keeps its message. */
      let msg = x.msg;
      if (x.type === 'string_too_short' && x.ctx && x.ctx.min_length === 1) msg = 'is required';
      else if (/decimal|int_parsing|float_parsing/.test(x.type || '')) msg = 'must be a number';
      return field ? `${field}: ${msg}` : msg;
    }).join(' · ');
  }
  return fallback;
}

async function catApi(method, path, { params, data } = {}) {
  const res = await axios({
    method, url: `${API_BASE}/api/admin/catalogue${path}`,
    headers: authHeaders(), params, data,
  });
  return res.data;
}

/* ---------- The one shared modal ---------- */

function catOpenModal(html) {
  const overlay = document.getElementById('catModalOverlay');
  const body = document.getElementById('catModalBody');
  if (!overlay || !body) return null;
  if (overlay.dataset.catWired !== '1') {
    overlay.dataset.catWired = '1';
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-cat-close]')) overlay.classList.remove('open');
    });
  }
  body.innerHTML = html;
  overlay.classList.add('open');
  return body;
}
function catCloseModal() {
  const overlay = document.getElementById('catModalOverlay');
  if (overlay) overlay.classList.remove('open');
}
function catModalShell(title, bodyHtml) {
  return `<div class="ops-modal-head"><h2>${title}</h2>
      <button type="button" class="ops-modal-close" data-cat-close aria-label="Close">&times;</button></div>
    <div class="ops-modal-body">${bodyHtml}</div>`;
}

/* ---------- Form-field builders (every value is escaped here) ---------- */

const catE = v => escapeHtml(v == null ? '' : String(v));

function catField(label, controlHtml, hint) {
  return `<div class="form-field" style="max-width:none;"><label>${escapeHtml(label)}</label>${controlHtml}${
    hint ? `<div class="cell-sub" style="margin-top:4px;">${escapeHtml(hint)}</div>` : ''}</div>`;
}
function catInput(id, value, { type = 'text', attrs = '' } = {}) {
  return `<input type="${type}" id="${id}" value="${catE(value)}" ${attrs}>`;
}
function catTextarea(id, value, rows = 3) {
  return `<textarea id="${id}" rows="${rows}">${catE(value)}</textarea>`;
}
function catSelect(id, options, value, attrs = '') {
  return `<select id="${id}" ${attrs}>${options.map(([v, l]) =>
    `<option value="${catE(v)}"${String(v) === String(value == null ? '' : value) ? ' selected' : ''}>${catE(l)}</option>`).join('')}</select>`;
}
function catCheck(id, checked, label) {
  return `<label style="display:flex; gap:8px; align-items:center; font-weight:600; text-transform:none; letter-spacing:0; font-size:13px;">
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} style="width:auto;"> ${escapeHtml(label)}</label>`;
}
const catVal = id => document.getElementById(id).value;
const catTrim = id => document.getElementById(id).value.trim();
const catChecked = id => document.getElementById(id).checked;

/* One item per line in a textarea <-> a list in the API. */
const catLinesOf = list => (list || []).join('\n');
const catListFrom = id => catTrim(id).split('\n').map(s => s.trim()).filter(Boolean);

/* '' -> null, so an emptied optional field CLEARS the column. */
const catNullable = id => catTrim(id) || null;

function catPill(active, on = 'Active', off = 'Disabled') {
  return `<span class="badge ${active ? 'confirmed' : 'inactive'}">${escapeHtml(active ? on : off)}</span>`;
}

function catMsg(text, isError) {
  const el = document.getElementById('catMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (isError ? ' error' : text ? ' success' : '');
}

/* Run a save, show its outcome in #catMsg + a toast, and disable the button
   for the duration so a double-click cannot save twice. */
async function catSave(btn, fn, doneText) {
  if (btn) btn.disabled = true;
  catMsg('');
  try {
    const result = await fn();
    if (typeof showToast === 'function') showToast(doneText);
    return result;
  } catch (err) {
    catMsg(catErr(err), true);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- Image picker ---------- */

const catImageCache = {};   // row type -> [{key, library, thumbnail}]

async function catImages(rowType) {
  if (!catImageCache[rowType]) {
    try { catImageCache[rowType] = await catApi('get', '/images', { params: { row: rowType } }); }
    catch { catImageCache[rowType] = []; }
  }
  return catImageCache[rowType];
}

const catThumbSrc = (choices, key) => {
  const hit = choices.find(c => c.key === key);
  return hit ? `../${hit.thumbnail}` : '';
};

/* <select> of shipped keys, grouped by library, with a live thumbnail. A
   current key that is no longer on disk is still listed (marked missing) so
   opening and saving a row never silently drops it. */
async function catImageField(id, rowType, current, label = 'Image') {
  const choices = await catImages(rowType);
  const groups = {};
  choices.forEach(c => { (groups[c.library] = groups[c.library] || []).push(c); });
  const missing = current && !choices.some(c => c.key === current);
  const opts = `<option value="">— none (site fallback) —</option>` +
    (missing ? `<option value="${catE(current)}" selected>${catE(current)} (not in library)</option>` : '') +
    Object.entries(groups).map(([lib, items]) =>
      `<optgroup label="${catE(lib)}">${items.map(c =>
        `<option value="${catE(c.key)}"${c.key === current ? ' selected' : ''}>${catE(c.key)}</option>`).join('')}</optgroup>`).join('');
  const src = catThumbSrc(choices, current);
  return catField(label, `
    <div style="display:flex; gap:12px; align-items:center;">
      <select id="${id}" data-cat-image="${rowType}" style="flex:1;">${opts}</select>
      <img id="${id}Thumb" alt="" width="96" height="64"
           style="object-fit:cover; border-radius:8px; background:rgba(10,37,64,.06); ${src ? '' : 'visibility:hidden;'}"
           ${src ? `src="${catE(src)}"` : ''}>
    </div>`, 'Chosen from the photographs shipped with the site. Adding a new photograph is a deploy, not an upload.');
}

/* Call once after the modal HTML is in the DOM. */
function catWireImageFields(root) {
  root.querySelectorAll('select[data-cat-image]').forEach(sel => {
    sel.addEventListener('change', () => {
      const img = document.getElementById(`${sel.id}Thumb`);
      const src = catThumbSrc(catImageCache[sel.dataset.catImage] || [], sel.value);
      if (img) { if (src) { img.src = src; img.style.visibility = 'visible'; } else { img.removeAttribute('src'); img.style.visibility = 'hidden'; } }
    });
  });
}

/* ---------- Pieces every list screen repeats ---------- */

function catDebounce(fn, ms = 300) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* Tabs inside a modal. `tabs` is [[key, label], ...]. */
function catTabsHtml(tabs, active) {
  return `<div class="ops-tabs" role="tablist">${tabs.map(([k, l]) =>
    `<button type="button" role="tab" class="ops-tab${k === active ? ' active' : ''}" data-cat-tab="${k}">${escapeHtml(l)}</button>`).join('')}</div>`;
}
