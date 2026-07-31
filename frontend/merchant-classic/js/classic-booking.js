'use strict';
/* Classic — Booking Request.
   ===========================================================================
   This file used to hold two screens: Inventory Search and Raise Request. The
   search half is GONE — the whole catalog flow (search bar, results table,
   Select, /api/catalog/search and /api/catalog/{id}/quote) was removed with
   the Ticket Enquiry redesign. A merchant no longer picks a fare off a list;
   it enquires, we answer, and only an answered enquiry can be booked.

   What is left is the second half, reached only from Request Ticket:

     1. Enquiry     already done, and already answered
     2. Passengers  the only thing still to enter
     3. Submit      goes to the approvals desk

   THE ITINERARY IS NOT AN INPUT HERE. Everything above the passenger grid is
   read-only, because the backend copies those fields from the enquiry itself
   (enquiry_service.to_booking_request) — the booking that reaches the desk is
   always the journey that was actually answered, whatever this page displays.
   Showing it as a form would imply an edit that the API would silently drop.

   Submitting is still two calls in this order:
     POST /api/enquiries/{id}/booking-request   -> a draft, with passengers
     POST /api/requests/{id}/submit             -> in front of the desk
   Saving without submitting is a legitimate outcome, so Save as draft stops
   after the first.

   DOCUMENTS NEED A DRAFT TO EXIST FIRST (Phase 3)
   A file has to be attached *to* something, and the request row is only born
   on the first call above. So the page has two shapes:

     domestic       fill -> Submit                (one step, as before)
     international  fill -> Save as draft -> attach passports -> Submit

   The Documents panel is therefore inert until a draft id exists, and says so
   rather than showing controls that would 404. Resuming a saved draft comes
   back through Request Ticket, which loads it instead of refusing as a
   duplicate — see clRequestTicket in classic-enquiry.js.

   WHY THE UI DECIDES "INTERNATIONAL"
   The API stores an IATA code and a city name, no country. travel-locations.js
   is the only place countries exist, so the flag is computed here and sent
   with the draft; the backend then enforces passports at submit. When a code
   is missing from that dataset the answer is "not international", so an
   unknown airport can never invent a requirement the merchant cannot meet. */

/* The enquiry this screen is currently working from. Set by clStartBookingRequest,
   which Request Ticket calls just before navigating here. */
let clBookingEnquiry = null;
/* The saved draft, once one exists — null until Save as draft (or a resume).
   Its presence is what unlocks the Documents panel. */
let clBookingDraft = null;
let clBookingDocs = [];

function clStartBookingRequest(enquiry, draft = null) {
  clBookingEnquiry = enquiry;
  clBookingDraft = draft;
  clBookingDocs = [];
}

function clInitBookingRequest() {
  if (!clBookingEnquiry) return clRenderNoEnquiry();
  clRenderBookingForm(clBookingEnquiry);
}

/* True only when both endpoints resolve to known, different countries. */
function clIsInternational(e) {
  return typeof isInternationalRoute === 'function'
    && isInternationalRoute(e.origin, e.destination);
}

/* Landing here directly — from the sidebar, or from a #booking-request deep
   link — is a legitimate thing to do and needs an answer, not an empty page. */
function clRenderNoEnquiry() {
  $('cl-booking-request').innerHTML = `
    <div class="cl-page-head"><div>
      <h1>Booking Request</h1>
      <p>Every booking starts from a ticket enquiry our team has answered.</p>
    </div></div>
    <div class="cl-panel"><div class="cl-panel-body">
      <p style="margin:0 0 14px;font-size:13px;color:var(--cl-text-muted);">
        Nothing selected. Open <b>Ticket Enquiry</b>, find an enquiry marked
        <b>Available</b>, and press <b>Request Ticket</b> — its details are carried
        over here so you only have to add the travellers.</p>
      <button type="button" class="cl-btn cl-btn-primary" id="clBrToEnquiry">Go to Ticket Enquiry</button>
    </div></div>`;
  $('clBrToEnquiry').addEventListener('click', () => clGo('enquiry'));
}

function clRenderBookingForm(e) {
  const roundTrip = e.trip_type === 'round_trip';
  const intl = clIsInternational(e);
  const originCountry = typeof travelCountryForCode === 'function' ? travelCountryForCode(e.origin) : null;
  const destCountry = typeof travelCountryForCode === 'function' ? travelCountryForCode(e.destination) : null;
  const contact = (clBookingDraft?.details?.contact) || {};

  $('cl-booking-request').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Booking Request</h1>
        <p>From enquiry <b class="cl-ref">${escapeHtml(e.reference_number)}</b> — review the
          journey, then enter traveller details. Names must match the travel document exactly.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clBrCancel">Discard</button>
      </div>
    </div>

    <div class="cl-stepper">
      <div class="cl-step done"><b>1. Enquiry</b>${escapeHtml(e.reference_number)}</div>
      <div class="cl-step done"><b>2. Answered</b>Available to book</div>
      <div class="cl-step current"><b>3. Passengers</b>Enter details</div>
      <div class="cl-step"><b>4. Approval</b>Our team confirms the fare</div>
      <div class="cl-step"><b>5. Payment</b>Then ticketing</div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Journey</h2>
        <div class="cl-panel-tools">
          <button type="button" class="cl-btn cl-btn-sm" id="clBrViewEnquiry">View enquiry</button>
        </div>
      </div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Trip type</dt><dd>${roundTrip ? 'Round Trip' : 'One Way'}</dd></div>
          <div><dt>From</dt><dd>${escapeHtml([e.origin_city, e.origin].filter(Boolean).join(' · ') || '—')}</dd></div>
          <div><dt>To</dt><dd>${escapeHtml([e.destination_city, e.destination].filter(Boolean).join(' · ') || '—')}</dd></div>
          <div><dt>Airline</dt><dd>${escapeHtml(e.airline || '—')}</dd></div>
          <div><dt>Flight number</dt><dd class="cl-ref">${escapeHtml(e.flight_number || '—')}</dd></div>
          <div><dt>Departure date</dt><dd>${escapeHtml(fmtDate(e.travel_date))}</dd></div>
          <div><dt>Preferred time</dt><dd>${escapeHtml(clTimeLabel(e.preferred_time) || '—')}</dd></div>
          ${roundTrip ? `
            <div><dt>Return date</dt><dd>${escapeHtml(fmtDate(e.return_date))}</dd></div>
            <div><dt>Return time</dt><dd>${escapeHtml(clTimeLabel(e.return_preferred_time) || '—')}</dd></div>` : ''}
          <div><dt>Travel class</dt><dd>${escapeHtml(e.travel_class || '—')}</dd></div>
          <div><dt>Party</dt><dd>${e.passenger_count} — ${e.adults} adult${e.adults === 1 ? '' : 's'}${
            e.children ? `, ${e.children} child${e.children === 1 ? '' : 'ren'}` : ''}${
            e.infants ? `, ${e.infants} infant${e.infants === 1 ? '' : 's'}` : ''}</dd></div>
          <div><dt>Route type</dt><dd>${intl
            ? `<span class="cl-tag cl-tag-warn">International</span>`
            : `<span class="cl-tag">Domestic</span>`}${
              originCountry && destCountry
                ? ` <span class="cl-kpi-sub">${escapeHtml(originCountry)} → ${escapeHtml(destCountry)}</span>`
                : ' <span class="cl-kpi-sub">country not on file — passport optional</span>'}</dd></div>
        </dl>
      </div>
      ${e.admin_response ? `<div class="cl-panel-note">
        <b>Our response:</b> ${escapeHtml(e.admin_response)}</div>` : ''}
      <div class="cl-panel-note">
        These details come from the enquiry and cannot be changed here — they are what our team
        confirmed. Raise a new enquiry if the journey needs to change.
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Contact for this booking</h2></div>
      <div class="cl-panel-body">
        <div class="cl-form cl-form-2">
          <div class="cl-field">
            <label for="clBrContactName">Contact name</label>
            <input type="text" id="clBrContactName" maxlength="120"
              value="${escapeHtml(contact.name || '')}" placeholder="Who we should ask for">
          </div>
          <div class="cl-field">
            <label for="clBrContactEmail">Email<span class="cl-req">*</span></label>
            <input type="email" id="clBrContactEmail" maxlength="255"
              value="${escapeHtml(contact.email || '')}" placeholder="bookings@yourcompany.com">
          </div>
          <div class="cl-field">
            <label for="clBrContactPhone">Phone<span class="cl-req">*</span></label>
            <input type="tel" id="clBrContactPhone" maxlength="30"
              value="${escapeHtml(contact.phone || '')}" placeholder="+91 90000 00000">
          </div>
          <div class="cl-field">
            <label for="clBrContactAlt">Alternate phone</label>
            <input type="tel" id="clBrContactAlt" maxlength="30"
              value="${escapeHtml(contact.alternate_phone || '')}" placeholder="Optional">
          </div>
        </div>
      </div>
      <div class="cl-panel-note">
        One contact for the whole party — this is who our team and the airline reach
        about schedule changes, so it should be a monitored address and number.
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Passengers</h2>
        <div class="cl-panel-tools">
          <button type="button" class="cl-btn cl-btn-sm" id="clBrAddPax">Add passenger</button>
          <button type="button" class="cl-btn cl-btn-sm" id="clBrCopyFirst"
            title="Copy nationality and document country from the first passenger">Fill down</button>
        </div>
      </div>
      <div class="cl-panel-body" id="clBrPaxList"></div>
      <div class="cl-panel-note">
        ${intl
          ? 'This is an international sector, so every traveller needs a passport number, an '
            + 'expiry after the travel date, and a passport document attached below.'
          : 'First and last name are required for every passenger. Passport details are optional '
            + 'on a domestic sector and can be supplied later.'}
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Documents</h2>
        <div class="cl-panel-tools"><span class="cl-kpi-sub">PDF, JPEG, PNG or WebP · up to 10 MB</span></div>
      </div>
      <div class="cl-panel-body" id="clBrDocsBody"></div>
      <div class="cl-panel-note">
        Uploaded files are private to your company and are only visible to you and our
        ticketing team. ${intl
          ? 'A passport is required for each traveller on this booking.'
          : 'Nothing is required for a domestic sector — attach anything that helps.'}
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-body">
        <div class="cl-field">
          <label for="clBrSpecial">Special requests</label>
          <textarea id="clBrSpecial" maxlength="1000"
            placeholder="Wheelchair assistance, bassinet, dietary needs, seating together…">${
              escapeHtml(clBookingDraft?.details?.special_requests || '')}</textarea>
        </div>
        <div class="cl-field">
          <label for="clBrRemarks">Remarks for our team</label>
          <textarea id="clBrRemarks" maxlength="1000"
            placeholder="Anything specific to this booking — corporate ID, invoicing…">${
              escapeHtml(clBookingDraft?.remarks || '')}</textarea>
        </div>
        <div class="cl-form-actions">
          <button type="button" class="cl-btn cl-btn-primary" id="clBrSubmitBtn">Submit for approval</button>
          <button type="button" class="cl-btn" id="clBrDraftBtn">Save as draft</button>
          <span class="cl-kpi-sub">Draft stays in My Requests and can be submitted later.</span>
        </div>
        <div class="cl-msg" id="clBrMsg"></div>
      </div>
      <div class="cl-panel-note">
        The payable amount is confirmed by our team at approval — an enquiry-led booking carries
        no fare until then, so this request will show a zero amount until it is approved.
      </div>
    </div>`;

  /* One passenger row per traveller the enquiry asked about, pre-typed adult /
     child / infant from the breakdown — the merchant told us the party shape
     already and should not have to say it twice. */
  const list = $('clBrPaxList');
  list.innerHTML = '';
  if (clBookingDraft?.passengers?.length) {
    // Resuming: rebuild the rows from what was saved rather than from the
    // enquiry breakdown, or edits made before saving would be lost.
    clBookingDraft.passengers.forEach((p, i) => clAddPaxCard(list, i, p.passenger_type, p));
  } else {
    clSeedPassengerRows(list, e);
  }
  clRenderDocuments();

  $('clBrAddPax').addEventListener('click', () => {
    clAddPaxCard(list, list.querySelectorAll('[data-cl-pax]').length);
  });
  $('clBrCopyFirst').addEventListener('click', clFillDown);
  $('clBrViewEnquiry').addEventListener('click', () => clOpenEnquiryDetail(e.id));
  $('clBrCancel').addEventListener('click', async () => {
    if (!await clConfirm('Discard this booking request and return to Ticket Enquiry?', 'Discard')) return;
    clBookingEnquiry = null;
    clLoaded.delete('booking-request');
    clGo('enquiry');
  });
  $('clBrSubmitBtn').addEventListener('click', () => clSubmitBookingRequest(true));
  $('clBrDraftBtn').addEventListener('click', () => clSubmitBookingRequest(false));
}

/* ---------------------------------------------------------------- documents */

const CL_DOC_TYPES = [
  ['passport', 'Passport'], ['visa', 'Visa'], ['photo_id', 'Photo ID'],
  ['ticket', 'Ticket'], ['other', 'Other'],
];
const CL_DOC_TONE = { verified: 'ok', rejected: 'err', pending: '' };

/* Inert until a draft exists: there is nothing to attach a file to before the
   request row is created, and offering an upload control that could only 404
   would be worse than explaining why it is not there yet. */
function clRenderDocuments() {
  const body = $('clBrDocsBody');
  if (!body) return;

  if (!clBookingDraft) {
    body.innerHTML = `
      <div class="cl-msg cl-msg-muted" style="margin-top:0">
        Press <b>Save as draft</b> first — documents attach to the saved request.
        ${clIsInternational(clBookingEnquiry)
          ? 'This is an international booking, so passports are required before it can be submitted.'
          : ''}
      </div>`;
    return;
  }

  const cards = [...($('clBrPaxList')?.querySelectorAll('[data-cl-pax]') || [])];
  const paxOptions = clBookingDraft.passengers.map((p, i) => {
    const card = cards[i];
    const name = card
      ? [card.querySelector('[data-field="first_name"]')?.value,
         card.querySelector('[data-field="last_name"]')?.value].filter(Boolean).join(' ').trim()
      : '';
    return `<option value="${p.id}">${escapeHtml(name || `Passenger ${i + 1}`)}</option>`;
  }).join('');

  body.innerHTML = `
    <div class="cl-form cl-form-3" style="align-items:end;">
      <div class="cl-field">
        <label for="clBrDocPax">Belongs to</label>
        <select id="clBrDocPax">
          <option value="">The booking (not one traveller)</option>
          ${paxOptions}
        </select>
      </div>
      <div class="cl-field">
        <label for="clBrDocType">Document type</label>
        <select id="clBrDocType">
          ${CL_DOC_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
      <div class="cl-field">
        <label for="clBrDocFile">File</label>
        <input type="file" id="clBrDocFile" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp">
      </div>
    </div>
    <div class="cl-form-actions" style="margin-top:6px;">
      <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" id="clBrDocUpload">Upload</button>
      <span class="cl-msg" id="clBrDocMsg"></span>
    </div>
    <div class="cl-table-wrap" style="margin-top:12px;">
      <table class="cl-table">
        <thead><tr><th>File</th><th>Type</th><th>For</th><th>Status</th><th>Uploaded</th><th></th></tr></thead>
        <tbody id="clBrDocRows"></tbody>
      </table>
    </div>`;

  $('clBrDocUpload').addEventListener('click', clUploadDocument);
  clRenderDocumentRows();
}

function clRenderDocumentRows() {
  const tbody = $('clBrDocRows');
  if (!tbody) return;
  const nameFor = pid => {
    if (!pid) return 'Booking';
    const idx = clBookingDraft.passengers.findIndex(p => p.id === pid);
    const p = clBookingDraft.passengers[idx];
    return p ? `${p.first_name} ${p.last_name}`.trim() || `Passenger ${idx + 1}` : '—';
  };

  tbody.innerHTML = clBookingDocs.length ? clBookingDocs.map(d => `
    <tr>
      <td>${escapeHtml(d.original_filename)}<div class="cl-kpi-sub">${clFileSize(d.size_bytes)}</div></td>
      <td>${escapeHtml((CL_DOC_TYPES.find(t => t[0] === d.doc_type) || [, d.doc_type])[1])}</td>
      <td>${escapeHtml(nameFor(d.passenger_id))}</td>
      <td><span class="cl-tag${CL_DOC_TONE[d.verification_status] ? ` cl-tag-${CL_DOC_TONE[d.verification_status]}` : ''}">${
        escapeHtml(d.verification_label)}</span>${
        d.rejection_reason ? `<div class="cl-kpi-sub">${escapeHtml(d.rejection_reason)}</div>` : ''}</td>
      <td>${escapeHtml(fmtDateTime(d.created_at))}</td>
      <td style="white-space:nowrap;">
        <button type="button" class="cl-btn cl-btn-sm" data-cl-doc-view="${d.id}">View</button>
        <button type="button" class="cl-btn cl-btn-sm" data-cl-doc-del="${d.id}">Remove</button>
      </td>
    </tr>`).join('') : clEmptyRow(6, 'No documents attached yet.');

  tbody.querySelectorAll('[data-cl-doc-view]').forEach(b =>
    b.addEventListener('click', () => clViewDocument(b.dataset.clDocView)));
  tbody.querySelectorAll('[data-cl-doc-del]').forEach(b =>
    b.addEventListener('click', () => clDeleteDocument(b.dataset.clDocDel)));
}

async function clUploadDocument() {
  const msg = $('clBrDocMsg');
  const input = $('clBrDocFile');
  const file = input.files?.[0];
  if (!file) return clMsg(msg, 'Choose a file first.', 'err');

  const btn = $('clBrDocUpload');
  btn.disabled = true;
  clMsg(msg, 'Uploading…', 'muted');
  try {
    const doc = await MerchantApi.uploadDocument(clBookingDraft.id, file, {
      docType: $('clBrDocType').value,
      passengerId: $('clBrDocPax').value || null,
    });
    clBookingDocs.push(doc);
    input.value = '';
    clMsg(msg, `${doc.original_filename} attached.`, 'ok');
    clRenderDocumentRows();
  } catch (err) {
    clMsg(msg, clError(err, 'Could not upload that file.'), 'err');
  }
  btn.disabled = false;
}

/* The download endpoint needs an Authorization header, so this cannot be a
   plain link — the bytes are fetched as a blob and opened from an object URL,
   which is revoked once the tab has taken it. */
async function clViewDocument(id) {
  const msg = $('clBrDocMsg');
  try {
    const url = await MerchantApi.downloadDocument(id);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    clMsg(msg, clError(err, 'Could not open that document.'), 'err');
  }
}

async function clDeleteDocument(id) {
  const doc = clBookingDocs.find(d => String(d.id) === String(id));
  if (!await clConfirm(`Remove ${doc?.original_filename || 'this document'} from the booking?`, 'Remove')) return;
  try {
    await MerchantApi.deleteDocument(id);
    clBookingDocs = clBookingDocs.filter(d => String(d.id) !== String(id));
    clRenderDocumentRows();
    clMsg($('clBrDocMsg'), 'Document removed.', 'ok');
  } catch (err) {
    clMsg($('clBrDocMsg'), clError(err, 'Could not remove that document.'), 'err');
  }
}

/* Adults first, then children, then infants — the order every airline lists a
   party in, and the order the passenger numbers then read in. */
function clSeedPassengerRows(list, e) {
  const plan = [
    ...Array(Math.max(1, e.adults || 1)).fill('adult'),
    ...Array(e.children || 0).fill('child'),
    ...Array(e.infants || 0).fill('infant'),
  ];
  plan.forEach((type, i) => clAddPaxCard(list, i, type));
}

const CL_TITLES_OPTS = ['Mr', 'Ms', 'Mrs', 'Dr', 'Mstr'];
const CL_PAX_TYPES = ['adult', 'child', 'infant'];

/* One row per passenger, laid out as a compact grid. Not an accordion: a
   data-entry user wants every field on screen and reachable by Tab. */
function clAddPaxCard(list, index, passengerType, saved = null) {
  const n = index + 1;
  const el = document.createElement('div');
  el.dataset.clPax = String(index);
  // Carried so uploads can be tied to the passenger row that is already in the
  // database; absent on rows the merchant has only just added.
  if (saved?.id != null) el.dataset.clPaxId = String(saved.id);
  el.style.cssText = 'padding:10px 0;border-top:1px solid var(--cl-border-color);';
  if (index === 0) el.style.borderTop = 'none';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">
      <b style="font-size:12px;">Passenger ${n}</b>
      ${index >= 1 ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-link" data-cl-pax-remove>Remove</button>` : ''}
    </div>
    <div class="cl-form">
      <div class="cl-field" style="max-width:88px;">
        <label>Title</label>
        <select data-field="title">${['', ...CL_TITLES_OPTS].map(t =>
          `<option value="${t}">${t || '—'}</option>`).join('')}</select>
      </div>
      <div class="cl-field"><label>First name<span class="cl-req">*</span></label>
        <input type="text" data-field="first_name" autocomplete="off"></div>
      <div class="cl-field"><label>Last name<span class="cl-req">*</span></label>
        <input type="text" data-field="last_name" autocomplete="off"></div>
      <div class="cl-field"><label>Type</label>
        <select data-field="passenger_type">${CL_PAX_TYPES.map(t =>
          `<option value="${t}"${t === (passengerType || 'adult') ? ' selected' : ''}>${clLabel(t)}</option>`).join('')}</select></div>
      <div class="cl-field"><label>Gender</label>
        <select data-field="gender"><option value="">—</option>
          <option value="male">Male</option><option value="female">Female</option>
          <option value="other">Other</option></select></div>
      <div class="cl-field"><label>Date of birth</label><input type="date" data-field="dob"></div>
      <div class="cl-field"><label>Nationality</label>
        <input type="text" data-field="nationality" placeholder="e.g. Indian"></div>
      <div class="cl-field"><label>Passport no.</label>
        <input type="text" data-field="passport_number" autocomplete="off"></div>
      <div class="cl-field"><label>Issuing country</label>
        <input type="text" data-field="passport_issue_country"></div>
      <div class="cl-field"><label>Issue date</label>
        <input type="date" data-field="passport_issue_date"></div>
      <div class="cl-field"><label>Expiry</label>
        <input type="date" data-field="passport_expiry"></div>
      <div class="cl-field"><label>Seat preference</label>
        <select data-field="seat_preference"><option value="">—</option>
          <option value="window">Window</option><option value="aisle">Aisle</option>
          <option value="middle">Middle</option></select></div>
      <div class="cl-field"><label>Meal preference</label>
        <select data-field="meal_preference"><option value="">—</option>
          <option value="veg">Vegetarian</option><option value="non_veg">Non-vegetarian</option>
          <option value="vegan">Vegan</option><option value="jain">Jain</option>
          <option value="kosher">Kosher</option><option value="halal">Halal</option></select></div>
    </div>`;
  list.appendChild(el);

  /* Re-applied after insertion rather than baked into the template above:
     setting .value works uniformly for inputs and selects, where template
     interpolation would need a different dance for each. */
  if (saved) {
    Object.entries(saved).forEach(([field, value]) => {
      if (value === null || value === undefined) return;
      const input = el.querySelector(`[data-field="${field}"]`);
      if (input) input.value = value;
    });
  }

  el.querySelector('[data-cl-pax-remove]')?.addEventListener('click', () => {
    el.remove();
    clRenumberPax(list);
  });
}

function clRenumberPax(list) {
  list.querySelectorAll('[data-cl-pax]').forEach((el, i) => {
    el.dataset.clPax = String(i);
    el.querySelector('b').textContent = `Passenger ${i + 1}`;
    el.style.borderTop = i === 0 ? 'none' : '1px solid var(--cl-border-color)';
  });
}

/* Copies the repetitive document fields from passenger 1 down the list. On a
   family or a corporate group these are identical, and retyping them for six
   travellers is exactly the drudgery this interface exists to remove. */
function clFillDown() {
  const cards = [...$('clBrPaxList').querySelectorAll('[data-cl-pax]')];
  if (cards.length < 2) return;
  const src = cards[0];
  ['nationality', 'passport_issue_country'].forEach(f => {
    const v = src.querySelector(`[data-field="${f}"]`).value;
    if (!v) return;
    cards.slice(1).forEach(c => {
      const el = c.querySelector(`[data-field="${f}"]`);
      if (!el.value) el.value = v;
    });
  });
  clMsg($('clBrMsg'), 'Copied nationality and issuing country to the remaining passengers.', 'muted');
}

/* Exactly the 14 keys the API accepts. Optional values go as undefined so they
   are omitted from the JSON body — the backend distinguishes "absent" from
   "empty string", and an empty passport number is not the same as no passport. */
/* Stamp the ids the save just returned back onto the cards, in the order they
   were sent. A traveller the merchant added since the last save has no id on
   its card, so without this the next save would send it as new again — the
   server would create a second row and cascade away the passport that was
   uploaded against the first. */
function clSyncPassengerIds(saved) {
  if (!Array.isArray(saved)) return;
  const cards = [...($('clBrPaxList')?.querySelectorAll('[data-cl-pax]') || [])];
  cards.forEach((card, i) => {
    const id = saved[i]?.id;
    if (id != null) card.dataset.clPaxId = String(id);
  });
}

function clPassengerPayload(card) {
  const get = f => card.querySelector(`[data-field="${f}"]`)?.value || null;
  return {
    /* Sent so the server edits this traveller's existing row instead of
       deleting and recreating it. Without it the row's id changes on every
       save and the passport uploaded against the old id is cascaded away —
       which, since saving happens immediately before submitting, made an
       international booking impossible to complete. Absent on a row the
       merchant has only just added, which is exactly what tells the server
       it is new. */
    id: card.dataset.clPaxId ? Number(card.dataset.clPaxId) : undefined,
    title: get('title') || undefined,
    first_name: get('first_name'),
    last_name: get('last_name'),
    gender: get('gender') || undefined,
    dob: get('dob') || undefined,
    passenger_type: get('passenger_type') || 'adult',
    nationality: get('nationality') || undefined,
    passport_number: get('passport_number') || undefined,
    passport_issue_country: get('passport_issue_country') || undefined,
    passport_issue_date: get('passport_issue_date') || undefined,
    passport_expiry: get('passport_expiry') || undefined,
    seat_preference: get('seat_preference') || undefined,
    meal_preference: get('meal_preference') || undefined,
    special_services: [],
  };
}

/* First and last name on every passenger, plus passport details when the route
   is international. The offending field is focused and outlined rather than
   described in prose. Returns an error string, or null when clean. */
function clFlagMissingPassengerFields(intl, travelDate) {
  let firstBad = null;
  let problem = null;
  const mark = (el, bad) => {
    if (!el) return;
    el.style.borderColor = bad ? 'var(--cl-coral-dark)' : '';
    if (bad && !firstBad) firstBad = el;
  };

  $('clBrPaxList').querySelectorAll('[data-cl-pax]').forEach(card => {
    ['first_name', 'last_name'].forEach(f => {
      const el = card.querySelector(`[data-field="${f}"]`);
      const bad = !el.value.trim();
      mark(el, bad);
      if (bad) problem = problem || 'Enter a first and last name for every passenger.';
    });

    if (!intl) {
      // Clear any outline left over from a previous international attempt.
      ['passport_number', 'passport_expiry'].forEach(f =>
        mark(card.querySelector(`[data-field="${f}"]`), false));
      return;
    }

    const num = card.querySelector('[data-field="passport_number"]');
    mark(num, !num.value.trim());
    if (!num.value.trim()) {
      problem = problem || 'This is an international sector — every traveller needs a passport number.';
    }

    const exp = card.querySelector('[data-field="passport_expiry"]');
    const expired = exp.value && travelDate && exp.value <= travelDate;
    mark(exp, !!expired);
    if (expired) {
      problem = problem || 'A passport expires on or before the travel date.';
    }
  });

  firstBad?.focus();
  return problem;
}

/* Contact is required on every enquiry-led booking — it is who the airline and
   our desk reach about a schedule change. */
function clFlagMissingContact() {
  const email = $('clBrContactEmail');
  const phone = $('clBrContactPhone');
  let bad = null;
  [email, phone].forEach(el => {
    const empty = !el.value.trim();
    el.style.borderColor = empty ? 'var(--cl-coral-dark)' : '';
    if (empty && !bad) bad = el;
  });
  if (bad) { bad.focus(); return 'Enter a contact email and phone for this booking.'; }

  // Deliberately loose: the backend is the authority, and an over-strict
  // pattern here would reject valid addresses the desk can actually use.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    email.style.borderColor = 'var(--cl-coral-dark)';
    email.focus();
    return 'That contact email does not look right.';
  }
  return null;
}

function clContactPayload() {
  return {
    name: ($('clBrContactName').value || '').trim() || undefined,
    email: ($('clBrContactEmail').value || '').trim(),
    phone: ($('clBrContactPhone').value || '').trim(),
    alternate_phone: ($('clBrContactAlt').value || '').trim() || undefined,
  };
}

async function clSubmitBookingRequest(finalize) {
  const msg = $('clBrMsg');
  const submitBtn = $('clBrSubmitBtn');
  const draftBtn = $('clBrDraftBtn');
  const enquiry = clBookingEnquiry;
  if (!enquiry) return;

  const intl = clIsInternational(enquiry);

  const contactProblem = clFlagMissingContact();
  if (contactProblem) return clMsg(msg, contactProblem, 'err');

  /* Passport rules bite only on submit. Saving a draft with them incomplete is
     the whole point of the draft — it is how the merchant gets a request id to
     attach the passports to in the first place. */
  const paxProblem = clFlagMissingPassengerFields(finalize && intl, enquiry.travel_date);
  if (paxProblem) return clMsg(msg, paxProblem, 'err');

  const cards = [...$('clBrPaxList').querySelectorAll('[data-cl-pax]')];
  if (!cards.length) return clMsg(msg, 'Add at least one passenger.', 'err');

  const passengers = cards.map(clPassengerPayload);

  /* Checked here as well as server-side so the merchant is told which traveller
     is missing paperwork while the form is still in front of them, rather than
     bouncing off a 400 after pressing Submit. */
  if (finalize && intl) {
    const covered = new Set(
      clBookingDocs.filter(d => d.doc_type === 'passport' && d.passenger_id).map(d => d.passenger_id));
    const missing = (clBookingDraft?.passengers || [])
      .filter(p => !covered.has(p.id))
      .map((p, i) => `${p.first_name} ${p.last_name}`.trim() || `Passenger ${i + 1}`);
    if (!clBookingDraft) {
      return clMsg(msg,
        'Save this as a draft first, then attach a passport for each traveller — '
        + 'required on an international sector.', 'err');
    }
    if (missing.length) {
      return clMsg(msg, `Attach a passport document for: ${missing.join(', ')}.`, 'err');
    }
  }

  /* The party size the desk answered for is part of what was quoted, so a
     mismatch is worth confirming rather than silently sending. */
  if (passengers.length !== enquiry.passenger_count) {
    const ok = await clConfirm(
      `The enquiry was for ${enquiry.passenger_count} passenger(s) and you have entered `
      + `${passengers.length}. Our team will re-check availability for the new party size. Continue?`,
      'Continue');
    if (!ok) return;
  }

  submitBtn.disabled = true; draftBtn.disabled = true;
  clMsg(msg, finalize ? 'Submitting for approval…' : 'Saving draft…', 'muted');

  const remarks = ($('clBrRemarks').value || '').trim();
  const specialRequests = ($('clBrSpecial').value || '').trim();
  const contact = clContactPayload();

  try {
    let request;
    if (clBookingDraft) {
      /* Resuming a saved draft: push whatever changed, then submit. Passengers
         are replaced wholesale because that is the endpoint's contract, and
         because it is the only way a removed traveller actually disappears. */
      await MerchantApi.replacePassengers(clBookingDraft.id, passengers);
      request = await MerchantApi.updateDraft(clBookingDraft.id, {
        remarks, contact, specialRequests,
      });
      request = request.request || request;
    } else {
      /* First save: creates the draft against the enquiry. Only /submit puts
         it in front of the approvals team. */
      request = await MerchantApi.enquiryToBookingRequest(enquiry.id, {
        passengers, remarks, contact, international: intl, specialRequests,
      });
    }

    if (finalize) {
      await MerchantApi.submitRequest(request.id);
      clBookingSubmitted(request.request_number, enquiry.reference_number);
    } else {
      /* Hold onto the saved draft so Documents can attach to it and a second
         save updates rather than duplicating — the API 409s on a re-book. */
      clBookingDraft = request;
      clSyncPassengerIds(request.passengers);
      clBookingDocs = await MerchantApi.listDocuments(request.id).catch(() => []);
      clRenderDocuments();
      clMsg(msg,
        `Draft saved — ${request.request_number}.`
        + (intl ? ' Attach a passport for each traveller, then submit.'
                : ' Submit it here or from My Requests when ready.'), 'ok');
      draftBtn.textContent = 'Save changes';
    }

    /* Every counter and list that just changed, including the enquiry listing —
       its row now shows the booking instead of Request Ticket. */
    clInvalidate('dashboard', 'enquiry', 'requests', 'payments', 'service-request', 'reports');
    clSearchCache = null;
    clLoadUnreadCount();
  } catch (err) {
    clMsg(msg, clError(err, 'Could not raise the booking request.'), 'err');
    submitBtn.disabled = false; draftBtn.disabled = false;
    return;
  }

  /* Re-enabled after a draft save, unlike Phase 1 where saving ended the
     screen's usefulness. The merchant now has more to do here — attach
     passports, then submit — and clSubmitBookingRequest routes to update
     rather than create on the next press, so pressing again cannot duplicate. */
  if (!finalize) {
    submitBtn.disabled = false;
    draftBtn.disabled = false;
  }
}

/* An explicit confirmation screen, not a toast — the request number is the one
   thing the merchant needs to write down, so it must not disappear on a timer. */
function clBookingSubmitted(requestNumber, enquiryReference) {
  $('cl-booking-request').innerHTML = `
    <div class="cl-page-head"><div>
      <h1>Submitted for approval</h1>
      <p>Request <b class="cl-ref">${escapeHtml(requestNumber)}</b> is with our team.</p>
    </div></div>
    <div class="cl-panel">
      <div class="cl-panel-body">
        <div class="cl-msg cl-msg-ok" style="margin-top:0">
          Request <b>${escapeHtml(requestNumber)}</b>, raised from enquiry
          <b>${escapeHtml(enquiryReference)}</b>, has been submitted. You will see it move to
          Payment Pending in My Requests once it is approved and priced.
        </div>
        <div class="cl-form-actions">
          <button type="button" class="cl-btn cl-btn-primary" id="clBrDoneList">View My Requests</button>
          <button type="button" class="cl-btn" id="clBrDoneNew">New enquiry</button>
        </div>
      </div>
    </div>`;
  $('clBrDoneList').addEventListener('click', () => {
    clBookingEnquiry = null; clLoaded.delete('booking-request'); clGo('requests');
  });
  $('clBrDoneNew').addEventListener('click', () => {
    clBookingEnquiry = null; clLoaded.delete('booking-request');
    clGo('enquiry', () => clOpenEnquiryForm());
  });
}
