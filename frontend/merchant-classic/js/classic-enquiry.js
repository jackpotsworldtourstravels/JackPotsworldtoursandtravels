'use strict';
/* Classic — Ticket Enquiry.
   ===========================================================================
   This screen replaces Inventory Search outright. The old flow searched a
   catalog and booked a row out of it; this one has the merchant describe the
   sector it wants, and our team answers. Nothing here talks to /api/catalog.

     Enquire Ticket   the form, as a modal
     Listing          reference / status / created / actions
     View Details     everything the enquiry captured, plus our answer
     Request Ticket   appears once the enquiry is Approved — carries the whole
                      enquiry over to Booking Request, pre-filled

   The form is modelled on how airlines and OTAs collect a journey, because
   that is the shape merchants already know: trip type first, then route, then
   flight, then when, then who. The controls (searchable city fields, hour +
   AM/PM, +/- steppers) are built from this portal's own tokens in
   classic.css — no widget library, so they theme and focus like everything
   else here. */

/* Airlines the desk deals with most. A free-text fallback stays available
   through the same combo, because a merchant can legitimately ask about a
   carrier that is not on this list — the field is a suggestion box, not an
   enum, and the backend stores whatever string arrives. */
const CL_AIRLINES = [
  { name: 'Air India', code: 'AI' },
  { name: 'IndiGo', code: '6E' },
  { name: 'Akasa Air', code: 'QP' },
  { name: 'SpiceJet', code: 'SG' },
  { name: 'Vistara', code: 'UK' },
  { name: 'Air India Express', code: 'IX' },
  { name: 'Emirates', code: 'EK' },
  { name: 'Qatar Airways', code: 'QR' },
  { name: 'Etihad Airways', code: 'EY' },
  { name: 'Singapore Airlines', code: 'SQ' },
  { name: 'Lufthansa', code: 'LH' },
  { name: 'British Airways', code: 'BA' },
  { name: 'Thai Airways', code: 'TG' },
  { name: 'Malaysia Airlines', code: 'MH' },
  { name: 'Oman Air', code: 'WY' },
  { name: 'Air Arabia', code: 'G9' },
  { name: 'Sri Lankan Airlines', code: 'UL' },
  { name: 'Turkish Airlines', code: 'TK' },
];

/* The rows currently on screen, so View Details and Request Ticket can work
   from what was already fetched rather than re-querying per click. */
let clEnquiryRows = [];

/* Live state of the open form. Held here rather than read back off the DOM at
   submit time because the steppers, the AM/PM toggles and the two combos each
   have a value that is not simply an input's .value. */
let clEnqForm = null;

/* =============================================================== screen === */

function clInitEnquiry() {
  $('cl-enquiry').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Ticket Enquiry</h1>
        <p>Tell us the sector you need and our team will confirm availability and fare.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn cl-btn-primary" id="clEnqNew">+ Enquire Ticket</button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clEnqStatus">Status</label>
          <select id="clEnqStatus" data-cl-status-filter>
            <option value="">All statuses</option>
            ${CL_ENQUIRY_STATUSES.map(s =>
              `<option value="${s}">${clEnquiryStatusLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <label for="clEnqSearch">Find</label>
          <input type="search" id="clEnqSearch" placeholder="Reference, route or flight no.">
        </div>
        <div class="cl-field" style="min-width:0;">
          <label>&nbsp;</label>
          <button type="button" class="cl-btn" id="clEnqRefresh">Refresh</button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Reference no.</th><th>Journey</th><th>Status</th>
              <th>Time created</th><th class="cl-actions">Actions</th>
            </tr></thead>
            <tbody id="clEnqBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager">
        <span class="cl-pager-info" id="clEnqCount">—</span>
      </div>
    </div>`;

  $('clEnqNew').addEventListener('click', () => clOpenEnquiryForm());
  $('clEnqRefresh').addEventListener('click', () => clLoadEnquiries());
  $('clEnqStatus').addEventListener('change', () => clLoadEnquiries());
  $('clEnqSearch').addEventListener('input', () => clRenderEnquiryRows());

  return clLoadEnquiries();
}

/* An enquiry never becomes payable, so it only ever reaches these five. Kept
   as its own list rather than reusing MERCHANT_REQUEST_STATUSES: offering
   "Paid" in the filter would be offering a state that cannot occur. */
const CL_ENQUIRY_STATUSES = [
  'pending_approval', 'in_review', 'approved', 'rejected', 'cancelled',
];

/* The lifecycle's own wording reads oddly for an enquiry — "Approved" means
   "we have this, go ahead and book" and "Rejected" means "not available". The
   underlying status value is untouched; only the label differs. */
const CL_ENQUIRY_LABELS = {
  pending_approval: 'Pending',
  in_review: 'Under Review',
  approved: 'Available',
  rejected: 'Not Available',
  cancelled: 'Cancelled',
};
function clEnquiryStatusLabel(status) {
  return CL_ENQUIRY_LABELS[status] || clLabel(status);
}
function clEnquiryTag(status) {
  const tone = CL_STATUS_TONE[status];
  return `<span class="cl-tag${tone ? ` cl-tag-${tone}` : ''}">${
    escapeHtml(clEnquiryStatusLabel(status))}</span>`;
}

async function clLoadEnquiries() {
  const body = $('clEnqBody');
  body.innerHTML = clLoadingRow(5, 'Loading enquiries…');
  const status = $('clEnqStatus').value;
  const params = { page_size: 100 };
  if (status) params.status = status;

  try {
    const data = await MerchantApi.listEnquiries(params);
    clEnquiryRows = data.items || [];
    clRenderEnquiryRows();
  } catch (err) {
    body.innerHTML = clEmptyRow(5, clError(err, 'Failed to load enquiries.'));
    $('clEnqCount').textContent = '—';
  }
}

/* Narrows what is already loaded, the same way My Requests does — the list
   endpoint has a `search` param but re-querying per keystroke would be slower
   and would fight the status filter. */
function clRenderEnquiryRows() {
  const body = $('clEnqBody');
  const q = $('clEnqSearch').value.trim().toLowerCase();
  const rows = q
    ? clEnquiryRows.filter(r => clEnquiryHaystack(r).includes(q))
    : clEnquiryRows;

  body.innerHTML = rows.length
    ? rows.map(clEnquiryRow).join('')
    : clEmptyRow(5, q
      ? 'No enquiries match that search.'
      : 'No enquiries yet. Press “+ Enquire Ticket” to raise your first one.');

  $('clEnqCount').textContent = `${rows.length} enquir${rows.length === 1 ? 'y' : 'ies'}`
    + (q && rows.length !== clEnquiryRows.length ? ` (filtered from ${clEnquiryRows.length})` : '');

  body.querySelectorAll('[data-cl-enq-view]').forEach(b =>
    b.addEventListener('click', () => clOpenEnquiryDetail(b.dataset.clEnqView)));
  body.querySelectorAll('[data-cl-enq-book]').forEach(b =>
    b.addEventListener('click', () => clRequestTicket(b.dataset.clEnqBook)));
  body.querySelectorAll('[data-cl-enq-booking]').forEach(b =>
    b.addEventListener('click', () => clGo('requests', () => clOpenRequestDetail(b.dataset.clEnqBooking))));
}

function clEnquiryHaystack(r) {
  return [
    r.reference_number, r.airline, r.flight_number, r.origin, r.destination,
    r.origin_city, r.destination_city, r.travel_class, r.booking_request_number,
  ].filter(Boolean).join(' ').toLowerCase();
}

function clEnquiryRoute(r) {
  const from = r.origin_city || r.origin || '—';
  const to = r.destination_city || r.destination || '—';
  return r.trip_type === 'round_trip' ? `${from} ⇄ ${to}` : `${from} → ${to}`;
}

function clEnquiryRow(r) {
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.reference_number || '—')}</td>
    <td>
      ${escapeHtml(clEnquiryRoute(r))}
      <small style="display:block;color:var(--cl-text-muted);">
        ${escapeHtml([r.airline, r.flight_number].filter(Boolean).join(' '))}
        · ${escapeHtml(fmtDate(r.travel_date))}
        · ${r.passenger_count} pax
      </small>
    </td>
    <td>${clEnquiryTag(r.status)}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDateTime(r.created_at))}</td>
    <td class="cl-actions">${clEnquiryActions(r)}</td>
  </tr>`;
}

/* Request Ticket appears only on an Approved enquiry that has not already been
   booked — the backend enforces both (400 and 409), so offering the button
   anywhere else would be offering a call that can only fail. Once it has been
   booked the button is replaced by a link to the booking itself. */
function clEnquiryActions(r) {
  const out = [
    `<button type="button" class="cl-btn cl-btn-sm" data-cl-enq-view="${r.id}">View Details</button>`,
  ];
  if (r.booking_request_id) {
    out.push(`<button type="button" class="cl-btn cl-btn-sm" data-cl-enq-booking="${r.booking_request_id}"
      title="Open ${escapeHtml(r.booking_request_number || 'the booking')}">Booking raised</button>`);
  } else if (r.status === 'approved') {
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-enq-book="${r.id}">Request Ticket</button>`);
  }
  return out.join('');
}

/* =============================================================== detail === */

async function clOpenEnquiryDetail(id) {
  clOpenModal('Enquiry details', '<p><span class="cl-spin"></span> Loading…</p>', '');
  try {
    /* Read fresh rather than from clEnquiryRows: the status is the whole point
       of this card, and it may have been answered since the table loaded. */
    const r = await MerchantApi.getEnquiry(id);
    clUpsertEnquiryRow(r);

    const rows = [
      ['Reference number', r.reference_number],
      ['Status', null],                                  // rendered as a tag below
      ['Trip type', r.trip_type === 'round_trip' ? 'Round Trip' : 'One Way'],
      ['From', [r.origin_city, r.origin].filter(Boolean).join(' · ')],
      ['To', [r.destination_city, r.destination].filter(Boolean).join(' · ')],
      ['Airline', r.airline],
      ['Flight number', r.flight_number],
      ['Departure date', fmtDate(r.travel_date)],
      ['Preferred time', clTimeLabel(r.preferred_time)],
      ['Return date', r.trip_type === 'round_trip' ? fmtDate(r.return_date) : null],
      ['Return time', r.trip_type === 'round_trip' ? clTimeLabel(r.return_preferred_time) : null],
      ['Travel class', r.travel_class],
      ['Passengers', r.passenger_count],
      ['Adults', r.adults],
      ['Children', r.children],
      ['Infants', r.infants],
      ['Created', fmtDateTime(r.created_at)],
      ['Answered', r.responded_at ? fmtDateTime(r.responded_at) : null],
      ['Booking request', r.booking_request_number],
    ].filter(([k, v]) => k === 'Status' || (v != null && v !== ''));

    $('clModalTitle').textContent = `Enquiry ${r.reference_number || ''}`;
    $('clModalBody').innerHTML = `
      <dl class="cl-dl">
        ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${
          k === 'Status' ? clEnquiryTag(r.status) : escapeHtml(String(v))
        }</dd></div>`).join('')}
      </dl>
      ${r.notes ? `<h3 style="font-size:12px;margin:16px 0 6px;">Your notes</h3>
        <p style="margin:0;font-size:13px;">${escapeHtml(r.notes)}</p>` : ''}
      ${r.admin_response ? `<h3 style="font-size:12px;margin:16px 0 6px;">Our response</h3>
        <div class="cl-msg cl-msg-info" style="margin-top:0">${escapeHtml(r.admin_response)}</div>` : ''}
      ${r.rejection_reason ? `<h3 style="font-size:12px;margin:16px 0 6px;">Why it was declined</h3>
        <div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(r.rejection_reason)}</div>` : ''}
      ${r.status === 'pending_approval' || r.status === 'in_review' ? `
        <div class="cl-msg cl-msg-muted">Our team is checking this sector. You will be notified
          the moment it is answered, and Request Ticket appears here once it is available.</div>` : ''}`;

    const foot = [];
    if (r.status === 'approved' && !r.booking_request_id) {
      foot.push(`<button type="button" class="cl-btn cl-btn-primary" data-cl-modal-book="${r.id}">Request Ticket</button>`);
    }
    if (r.booking_request_id) {
      foot.push(`<button type="button" class="cl-btn" data-cl-modal-booking="${r.booking_request_id}">Open ${
        escapeHtml(r.booking_request_number || 'booking')}</button>`);
    }
    foot.push('<button type="button" class="cl-btn" data-cl-modal-close>Close</button>');
    $('clModalFoot').innerHTML = foot.join('');

    $('clModalFoot').querySelector('[data-cl-modal-close]')?.addEventListener('click', clCloseModal);
    $('clModalFoot').querySelector('[data-cl-modal-book]')?.addEventListener('click', () => {
      clCloseModal(); clRequestTicket(r.id);
    });
    $('clModalFoot').querySelector('[data-cl-modal-booking]')?.addEventListener('click', () => {
      clCloseModal(); clGo('requests', () => clOpenRequestDetail(r.booking_request_id));
    });
  } catch (err) {
    $('clModalBody').innerHTML = `<div class="cl-msg cl-msg-err" style="margin-top:0">${
      escapeHtml(clError(err, 'Could not load this enquiry.'))}</div>`;
    $('clModalFoot').innerHTML = '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>';
  }
}

/* Fold a freshly-read enquiry back into the table's data so the row reflects
   an answer that arrived after the list loaded, without a full refetch. */
function clUpsertEnquiryRow(r) {
  const i = clEnquiryRows.findIndex(x => String(x.id) === String(r.id));
  if (i >= 0) clEnquiryRows[i] = r; else clEnquiryRows.unshift(r);
  if ($('cl-enquiry')?.classList.contains('active')) clRenderEnquiryRows();
}

/* "14:30" -> "2:30 PM". The API stores 24-hour; every screen shows 12-hour,
   which is what the form collects. */
function clTimeLabel(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const mer = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m || 0).padStart(2, '0')} ${mer}`;
}

/* ============================================================ the form ==== */

function clTodayIso() {
  /* Local date, not toISOString() — that converts to UTC and hands back
     "yesterday" for anyone east of Greenwich after 05:30 IST. */
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clAddDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clOpenEnquiryForm() {
  const today = clTodayIso();
  clEnqForm = {
    trip_type: 'one_way',
    from: null, to: null,                 // { code, city, label } once picked
    airline: '',
    depHour: 9, depMer: 'AM',
    retHour: 6, retMer: 'PM',
    adults: 1, children: 0, infants: 0,
  };

  clOpenModal('Enquire Ticket', `
    <div class="cl-trip" id="clEnqTrip" role="radiogroup" aria-label="Trip type">
      <label class="cl-trip-opt checked" data-cl-trip="one_way">
        <input type="radio" name="clEnqTripType" value="one_way" checked>One Way
      </label>
      <label class="cl-trip-opt" data-cl-trip="round_trip">
        <input type="radio" name="clEnqTripType" value="round_trip">Round Trip
      </label>
    </div>

    <div class="cl-form-legend">Route</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqFrom">From city<span class="cl-req">*</span></label>
        <div class="cl-combo">
          <input type="text" id="clEnqFrom" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list"
                 placeholder="Hyderabad, Delhi, Mumbai…">
          <div class="cl-combo-list" id="clEnqFromList" role="listbox"></div>
        </div>
      </div>
      <div class="cl-field">
        <label for="clEnqTo">To city<span class="cl-req">*</span></label>
        <div class="cl-combo">
          <input type="text" id="clEnqTo" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list"
                 placeholder="Cannot be the same as From">
          <div class="cl-combo-list" id="clEnqToList" role="listbox"></div>
        </div>
      </div>
    </div>

    <div class="cl-form-legend">Flight</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqAirline">Airline<span class="cl-req">*</span></label>
        <div class="cl-combo">
          <input type="text" id="clEnqAirline" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list"
                 placeholder="Air India, IndiGo, Emirates…">
          <div class="cl-combo-list" id="clEnqAirlineList" role="listbox"></div>
        </div>
      </div>
      <div class="cl-field">
        <label for="clEnqFlight">Flight number<span class="cl-req">*</span></label>
        <input type="text" id="clEnqFlight" autocomplete="off" placeholder="e.g. AI217, 6E456"
               maxlength="20" style="text-transform:uppercase;">
      </div>
    </div>

    <div class="cl-form-legend">Departure</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqDate">Travel date<span class="cl-req">*</span></label>
        <input type="date" id="clEnqDate" min="${today}" value="${today}">
      </div>
      <div class="cl-field">
        <label for="clEnqHour">Preferred time<span class="cl-req">*</span></label>
        <div class="cl-time">
          <select id="clEnqHour">${clHourOptions(9)}</select>
          <div class="cl-mer" id="clEnqMer" role="group" aria-label="AM or PM">
            <button type="button" class="cl-mer-btn active" data-cl-mer="AM" aria-pressed="true">AM</button>
            <button type="button" class="cl-mer-btn" data-cl-mer="PM" aria-pressed="false">PM</button>
          </div>
        </div>
      </div>
    </div>

    <div class="cl-return cl-hidden" id="clEnqReturn">
      <div class="cl-return-head">
        Return journey
        <span class="cl-route cl-route-empty" id="clEnqReturnRoute">Pick From and To first</span>
      </div>
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clEnqReturnDate">Return date<span class="cl-req">*</span></label>
          <input type="date" id="clEnqReturnDate" min="${clAddDays(today, 1)}">
        </div>
        <div class="cl-field">
          <label for="clEnqReturnHour">Return preferred time<span class="cl-req">*</span></label>
          <div class="cl-time">
            <select id="clEnqReturnHour">${clHourOptions(6)}</select>
            <div class="cl-mer" id="clEnqReturnMer" role="group" aria-label="AM or PM">
              <button type="button" class="cl-mer-btn" data-cl-mer="AM" aria-pressed="false">AM</button>
              <button type="button" class="cl-mer-btn active" data-cl-mer="PM" aria-pressed="true">PM</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="cl-form-legend">Travellers &amp; class</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqPax">Number of passengers<span class="cl-req">*</span></label>
        <input type="number" id="clEnqPax" min="1" max="99" value="1" readonly>
        <small>Set by the breakdown below.</small>
      </div>
      <div class="cl-field">
        <label for="clEnqClass">Class<span class="cl-req">*</span></label>
        <input type="text" id="clEnqClass" autocomplete="off"
               placeholder="Economy, Business, Premium Economy, First Class" maxlength="80">
      </div>
    </div>

    <div class="cl-pax-grid" style="margin-top:14px;">
      ${clStepperCard('adults', 'Adults', '12 years and over', 1, 1)}
      ${clStepperCard('children', 'Children', '2 – 11 years', 0, 0)}
      ${clStepperCard('infants', 'Infants', 'Under 2, on lap', 0, 0)}
    </div>

    <div class="cl-form cl-form-2" style="margin-top:16px;">
      <div class="cl-field cl-field-full">
        <label for="clEnqNotes">Notes for our team</label>
        <textarea id="clEnqNotes" maxlength="1000"
          placeholder="Anything else we should know — flexible dates, baggage, corporate fare…"></textarea>
      </div>
    </div>

    <div class="cl-msg" id="clEnqMsg"></div>`,
    `<button type="button" class="cl-btn" id="clEnqCancel">Cancel</button>
     <button type="button" class="cl-btn cl-btn-primary" id="clEnqSubmit">Enquire</button>`);

  $('clModal').classList.add('cl-modal-form');
  clModalOnClose = () => { $('clModal').classList.remove('cl-modal-form'); clEnqForm = null; };

  clWireEnquiryForm();
  $('clEnqFrom').focus();
}

function clHourOptions(selected) {
  /* 12 first: on a 12-hour clock 12 AM precedes 1 AM, and listing 1–12 puts
     midnight and noon at the wrong end. */
  return [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    .map(h => `<option value="${h}"${h === selected ? ' selected' : ''}>${h}</option>`).join('');
}

function clStepperCard(key, title, sub, value, min) {
  return `<div class="cl-pax-card" data-cl-step="${key}" data-cl-min="${min}">
    <div><b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small></div>
    <div class="cl-step-ctl">
      <button type="button" class="cl-step-btn" data-cl-step-dec
        aria-label="Fewer ${escapeHtml(title.toLowerCase())}"${value <= min ? ' disabled' : ''}>−</button>
      <span class="cl-step-val" data-cl-step-val aria-live="polite">${value}</span>
      <button type="button" class="cl-step-btn" data-cl-step-inc
        aria-label="More ${escapeHtml(title.toLowerCase())}">+</button>
    </div>
  </div>`;
}

function clWireEnquiryForm() {
  /* ---- trip type ---- */
  $('clEnqTrip').querySelectorAll('[data-cl-trip]').forEach(opt => {
    opt.addEventListener('click', () => clSetTripType(opt.dataset.clTrip));
    opt.querySelector('input').addEventListener('change', () => clSetTripType(opt.dataset.clTrip));
  });

  /* ---- searchable city fields ----
     onPick receives null when the merchant edits a previously-picked value,
     which is exactly the state these handlers need to see: the stored code is
     dropped and submit falls back to whatever text is actually in the box. */
  clCombo($('clEnqFrom'), $('clEnqFromList'), clCityOptions, picked => {
    clEnqForm.from = picked;
    /* Re-check the other field: picking the same city on both sides is the one
       route error the merchant cannot see for themselves. */
    clValidateRoute();
    clSyncReturnRoute();
  });
  clCombo($('clEnqTo'), $('clEnqToList'), clCityOptions, picked => {
    clEnqForm.to = picked;
    clValidateRoute();
    clSyncReturnRoute();
  });

  /* ---- airline ---- */
  clCombo($('clEnqAirline'), $('clEnqAirlineList'), clAirlineOptions, picked => {
    clEnqForm.airline = picked ? picked.value : '';
  });

  /* ---- AM / PM toggles ---- */
  clMeridiemToggle($('clEnqMer'), v => { clEnqForm.depMer = v; });
  clMeridiemToggle($('clEnqReturnMer'), v => { clEnqForm.retMer = v; });
  $('clEnqHour').addEventListener('change', e => { clEnqForm.depHour = Number(e.target.value); });
  $('clEnqReturnHour').addEventListener('change', e => { clEnqForm.retHour = Number(e.target.value); });

  /* ---- dates ---- */
  $('clEnqDate').addEventListener('change', clSyncReturnMin);

  /* ---- passenger steppers ---- */
  $('clModalBody').querySelectorAll('[data-cl-step]').forEach(card => {
    const key = card.dataset.clStep;
    const min = Number(card.dataset.clMin);
    card.querySelector('[data-cl-step-dec]').addEventListener('click', () => clStepPax(key, -1, min));
    card.querySelector('[data-cl-step-inc]').addEventListener('click', () => clStepPax(key, +1, min));
  });

  /* ---- flight number: uppercase as typed, so AI217 and ai217 are one thing ---- */
  $('clEnqFlight').addEventListener('input', e => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });

  $('clEnqCancel').addEventListener('click', clCloseModal);
  $('clEnqSubmit').addEventListener('click', clSubmitEnquiry);

  clSyncPaxTotal();
}

function clSetTripType(type) {
  if (!clEnqForm || clEnqForm.trip_type === type) return;
  clEnqForm.trip_type = type;
  $('clEnqTrip').querySelectorAll('[data-cl-trip]').forEach(opt => {
    const on = opt.dataset.clTrip === type;
    opt.classList.toggle('checked', on);
    opt.querySelector('input').checked = on;
  });
  $('clEnqReturn').classList.toggle('cl-hidden', type !== 'round_trip');
  if (type === 'round_trip') {
    clSyncReturnRoute();
    clSyncReturnMin();
  }
}

/* The return leg is the outbound reversed, shown rather than asked for — the
   spec's "automatically display To City -> From City". */
function clSyncReturnRoute() {
  const el = $('clEnqReturnRoute');
  if (!el || !clEnqForm) return;
  const from = clEnqForm.to, to = clEnqForm.from;
  if (!from || !to) {
    el.className = 'cl-route cl-route-empty';
    el.textContent = 'Pick From and To first';
    return;
  }
  el.className = 'cl-route';
  el.innerHTML = `${escapeHtml(from.city)} <span>→</span> ${escapeHtml(to.city)}`;
}

/* A return cannot be on or before the departure, so the picker's floor moves
   with the outbound date and an already-chosen invalid date is cleared rather
   than left sitting there looking accepted. */
function clSyncReturnMin() {
  const dep = $('clEnqDate').value;
  const ret = $('clEnqReturnDate');
  if (!dep || !ret) return;
  const floor = clAddDays(dep, 1);
  ret.min = floor;
  if (ret.value && ret.value < floor) ret.value = '';
}

function clStepPax(key, delta, min) {
  const next = Math.max(min, Math.min(99, clEnqForm[key] + delta));
  clEnqForm[key] = next;

  const card = $('clModalBody').querySelector(`[data-cl-step="${key}"]`);
  card.querySelector('[data-cl-step-val]').textContent = String(next);
  card.querySelector('[data-cl-step-dec]').disabled = next <= min;
  clSyncPaxTotal();
}

function clSyncPaxTotal() {
  if (!clEnqForm) return;
  const total = clEnqForm.adults + clEnqForm.children + clEnqForm.infants;
  $('clEnqPax').value = String(total);
  /* An infant travels on an adult's lap — more infants than adults is not a
     bookable party, and every airline rejects it at ticketing. Say so here
     rather than letting the server return a 422 after the fact. */
  const msg = $('clEnqMsg');
  if (clEnqForm.infants > clEnqForm.adults) {
    clMsg(msg, 'There cannot be more infants than adults — each infant travels on an adult’s lap.', 'err');
  } else if (msg.textContent.startsWith('There cannot be more infants')) {
    clMsg(msg, '');
  }
}

function clValidateRoute() {
  const from = clEnqForm.from, to = clEnqForm.to;
  const clash = from && to && from.code === to.code;
  $('clEnqTo').style.borderColor = clash ? 'var(--cl-coral-dark)' : '';
  if (clash) clMsg($('clEnqMsg'), 'From and To cannot be the same city.', 'err');
  else if ($('clEnqMsg').textContent.startsWith('From and To')) clMsg($('clEnqMsg'), '');
  return !clash;
}

/* ----------------------------------------------------- combo primitives -- */

/* Option sets. Each returns [{ value, label, sub, data }] for the given query;
   `data` is what the picker hands back to the caller's onPick. */
function clCityOptions(query) {
  return searchTravelLocations(query, 7).map(loc => ({
    value: travelLocationInputValue(loc),           // "Hyderabad (HYD)"
    label: travelLocationLabel(loc),                // "Hyderabad, India"
    sub: `${loc.code} · ${loc.airport}`,
    data: { code: loc.code, city: loc.city, label: travelLocationLabel(loc) },
  }));
}

function clAirlineOptions(query) {
  const q = query.trim().toLowerCase();
  return CL_AIRLINES
    .filter(a => !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().startsWith(q))
    .slice(0, 8)
    .map(a => ({ value: a.name, label: a.name, sub: `Carrier code ${a.code}`, data: { value: a.name } }));
}

/* A searchable dropdown over an input.
   - Typing filters; ↑/↓ move, Enter picks, Escape closes.
   - Picking calls onPick with the option's `data`.
   - Typing again CLEARS the pick, so an input edited down from "Hyderabad
     (HYD)" to "Hyd" can never still be secretly carrying HYD. The same trap
     mh-autocomplete.js documents on the Premium side. */
function clCombo(input, list, optionsFor, onPick) {
  let options = [];
  let active = -1;

  const close = () => {
    list.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const render = () => {
    const q = input.value.trim();
    options = optionsFor(q);
    if (!options.length) {
      list.innerHTML = q
        ? `<div class="cl-combo-empty">No match for “${escapeHtml(q)}”. You can type it in full instead.</div>`
        : '';
      if (!q) return close();
    } else {
      list.innerHTML = options.map((o, i) => `
        <button type="button" class="cl-combo-opt${i === active ? ' cl-active' : ''}"
                role="option" data-cl-opt="${i}">
          ${clHighlight(o.label, q)}
          ${o.sub ? `<small>${escapeHtml(o.sub)}</small>` : ''}
        </button>`).join('');
      list.querySelectorAll('[data-cl-opt]').forEach(b => {
        /* mousedown, not click: the input's blur would close the list first. */
        b.addEventListener('mousedown', e => { e.preventDefault(); pick(Number(b.dataset.clOpt)); });
      });
    }
    list.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
  };

  const pick = i => {
    const o = options[i];
    if (!o) return;
    input.value = o.value;
    input.dataset.clPicked = '1';
    close();
    onPick(o.data);
  };

  input.addEventListener('input', () => {
    /* Editing invalidates a previous selection — see the comment above. */
    if (input.dataset.clPicked) { delete input.dataset.clPicked; onPick(null); }
    render();
  });
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.classList.contains('open')) return render();
      active = e.key === 'ArrowDown'
        ? Math.min(options.length - 1, active + 1)
        : Math.max(0, active - 1);
      list.querySelectorAll('[data-cl-opt]').forEach((b, i) => b.classList.toggle('cl-active', i === active));
      list.querySelector('.cl-active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (list.classList.contains('open') && active >= 0) { e.preventDefault(); pick(active); }
    } else if (e.key === 'Escape') {
      close();
    }
  });
}

function clHighlight(text, query) {
  const q = (query || '').trim();
  const safe = escapeHtml(text);
  if (!q) return safe;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return safe;
  return escapeHtml(text.slice(0, at))
    + `<mark>${escapeHtml(text.slice(at, at + q.length))}</mark>`
    + escapeHtml(text.slice(at + q.length));
}

function clMeridiemToggle(group, onChange) {
  if (!group) return;
  group.querySelectorAll('[data-cl-mer]').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('[data-cl-mer]').forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        /* The `active` class is styling only — without aria-pressed a screen
           reader announces two identical buttons and never says which is set. */
        b.setAttribute('aria-pressed', String(on));
      });
      onChange(btn.dataset.clMer);
    });
  });
}

/* 9 + "PM" -> "21:00". 12 AM is midnight and 12 PM is noon, which is the one
   case a naive `hour + 12` gets wrong in both directions. */
function cl24h(hour12, meridiem) {
  const h = Number(hour12) % 12;
  return `${String(meridiem === 'PM' ? h + 12 : h).padStart(2, '0')}:00`;
}

/* ================================================================ submit == */

async function clSubmitEnquiry() {
  const msg = $('clEnqMsg');
  const btn = $('clEnqSubmit');
  const f = clEnqForm;
  if (!f) return;

  /* Every required field, checked in the order they appear on the form so the
     first thing the merchant is sent back to is the first thing that is wrong. */
  const from = f.from || clFreeTextPlace($('clEnqFrom').value);
  const to = f.to || clFreeTextPlace($('clEnqTo').value);
  const airline = ($('clEnqAirline').value || '').trim();
  const flight = ($('clEnqFlight').value || '').trim();
  const date = $('clEnqDate').value;
  const travelClass = ($('clEnqClass').value || '').trim();

  const fail = (text, focusId) => {
    clMsg(msg, text, 'err');
    $(focusId)?.focus();
    return null;
  };

  if (!from) return fail('Choose the city you are flying from.', 'clEnqFrom');
  if (!to) return fail('Choose the city you are flying to.', 'clEnqTo');
  if (from.code === to.code) return fail('From and To cannot be the same city.', 'clEnqTo');
  if (!airline) return fail('Choose or type the airline.', 'clEnqAirline');
  if (!flight) return fail('Enter the flight number.', 'clEnqFlight');
  if (!date) return fail('Choose the travel date.', 'clEnqDate');
  if (date < clTodayIso()) return fail('The travel date cannot be in the past.', 'clEnqDate');
  if (!travelClass) return fail('Enter the class you want — Economy, Business, and so on.', 'clEnqClass');
  if (f.adults < 1) return fail('At least one adult must travel.', 'clEnqClass');
  if (f.infants > f.adults) return fail('There cannot be more infants than adults.', 'clEnqClass');

  let returnDate = null;
  let returnTime = null;
  if (f.trip_type === 'round_trip') {
    returnDate = $('clEnqReturnDate').value;
    if (!returnDate) return fail('Choose the return date.', 'clEnqReturnDate');
    if (returnDate <= date) return fail('The return date must be after the departure date.', 'clEnqReturnDate');
    returnTime = cl24h(f.retHour, f.retMer);
  }

  const payload = {
    trip_type: f.trip_type,
    origin: from.code, origin_city: from.city,
    destination: to.code, destination_city: to.city,
    airline,
    flight_number: flight,
    travel_date: date,
    preferred_time: cl24h(f.depHour, f.depMer),
    return_date: returnDate,
    return_preferred_time: returnTime,
    travel_class: travelClass,
    passenger_count: f.adults + f.children + f.infants,
    adults: f.adults, children: f.children, infants: f.infants,
    notes: ($('clEnqNotes').value || '').trim() || null,
  };

  btn.disabled = true;
  clMsg(msg, 'Sending your enquiry…', 'muted');
  try {
    const enquiry = await MerchantApi.createEnquiry(payload);
    clCloseModal();
    clEnquiryRows.unshift(enquiry);
    clRenderEnquiryRows();
    clInvalidate('dashboard');
    clLoadUnreadCount();
    clOpenModal('Enquiry sent', `
      <div class="cl-msg cl-msg-ok" style="margin-top:0">
        Enquiry <b class="cl-ref">${escapeHtml(enquiry.reference_number)}</b> is with our team.
      </div>
      <p style="font-size:13px;">We will confirm availability and fare for
        <b>${escapeHtml(clEnquiryRoute(enquiry))}</b> on
        <b>${escapeHtml(fmtDate(enquiry.travel_date))}</b>. You will be notified when it is
        answered — <b>Request Ticket</b> then appears on this row and carries everything you
        have just entered straight into the booking.</p>`,
      '<button type="button" class="cl-btn cl-btn-primary" onclick="clCloseModal()">Done</button>');
  } catch (err) {
    clMsg(msg, clEnquiryError(err), 'err');
  } finally {
    btn.disabled = false;
  }
}

/* A 422 from FastAPI carries `detail` as an array of per-field errors, not a
   string — clError() would render "[object Object]". Pydantic's message is the
   useful part, so it is pulled out and shown as written. */
function clEnquiryError(err) {
  const detail = err?.response?.data?.detail;
  if (Array.isArray(detail)) {
    const first = detail[0];
    return String(first?.msg || 'Please check the form.').replace(/^Value error,\s*/, '');
  }
  return clError(err, 'Could not send the enquiry.');
}

/* A merchant may enquire about a city the static table does not carry. The
   typed text is then the code and the city both — the desk reads it, and no
   silent code is invented on their behalf. */
function clFreeTextPlace(text) {
  const v = (text || '').trim();
  if (!v) return null;
  return { code: v, city: v, label: v };
}

/* ======================================================= request ticket === */

/* The spec's Request Ticket: navigate to Booking Request and open it already
   filled in. The enquiry is re-read first so a merchant who left the tab open
   cannot carry a stale "available" into a booking the desk has since pulled. */
async function clRequestTicket(enquiryId) {
  try {
    const enquiry = await MerchantApi.getEnquiry(enquiryId);
    clUpsertEnquiryRow(enquiry);

    if (enquiry.booking_request_id) {
      /* An unsubmitted draft is work in progress, not a duplicate. A merchant
         who saved one and came back is resuming, so it is reopened with its
         passengers rather than refused. Anything past draft is genuinely
         already raised and stays read-only. */
      const detail = await MerchantApi.getRequest(enquiry.booking_request_id).catch(() => null);
      const booking = detail?.request || detail;
      if (booking && booking.status === 'draft') {
        clStartBookingRequest(enquiry, booking);
        clLoaded.delete('booking-request');
        return clGo('booking-request');
      }
      return clOpenModal('Already booked', `
        <div class="cl-msg cl-msg-info" style="margin-top:0">
          This enquiry has already been raised as
          <b class="cl-ref">${escapeHtml(enquiry.booking_request_number || '')}</b>.
        </div>`,
        '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    }
    if (enquiry.status !== 'approved') {
      return clOpenModal('Not available yet', `
        <div class="cl-msg cl-msg-muted" style="margin-top:0">
          This enquiry is <b>${escapeHtml(clEnquiryStatusLabel(enquiry.status))}</b>. A booking can
          only be raised once our team has marked it available.
        </div>`,
        '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    }

    clStartBookingRequest(enquiry);
    /* DELETE, not add. clGo only runs a section's loader when it is ABSENT
       from clLoaded, so marking it loaded here would navigate to a Booking
       Request screen that never rendered this enquiry — an empty form. */
    clLoaded.delete('booking-request');
    clGo('booking-request');
  } catch (err) {
    clOpenModal('Could not open the booking',
      `<div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Please try again.'))}</div>`,
      '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
  }
}
