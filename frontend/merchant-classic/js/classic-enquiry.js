'use strict';
/* Classic — Booking Enquiry.
   ===========================================================================
   This screen replaces Inventory Search outright. The old flow searched a
   catalog and booked a row out of it; this one has the merchant describe the
   sector it wants, and our team quotes it. Nothing here talks to /api/catalog.

     New Booking Enquiry  the form, as a modal
     Listing              reference / status / created / actions
     View Details         everything the enquiry captured, plus our quotation
     Request Ticket       appears once the enquiry is Available — carries the
                          whole enquiry over to Booking Request, pre-filled

   NAMING (CR-5). This is **Booking Enquiry** here and **Ticket Enquiry** on
   every staff screen; the stored `request_type` is `ticket_enquiry` either way.
   Renaming the API to match the merchant's word would have meant a migration
   and a contract break for a label.

   THE ANSWER IS A QUOTATION (CR-5). Our team replies with a total fare and the
   remarks that explain it, and that fare is binding: the booking raised from
   this enquiry is created at exactly that amount. So the quotation is rendered
   as a figure, not buried in a paragraph — see clQuotationPanel.

   The form is modelled on how airlines and OTAs collect a journey, because
   that is the shape merchants already know: trip type first, then departure and
   arrival, then flight, then when, then who. The controls (searchable city
   fields, 24-hour time, +/- steppers) are built from this portal's own tokens
   in classic.css — no widget library, so they theme and focus like everything
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
        <h1>Booking Enquiry</h1>
        <p>Tell us the sector you need and our team will confirm availability and quote a fare.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn cl-btn-primary" id="clEnqNew">+ New Booking Enquiry</button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clEnqStatus">Status</label>
          <select id="clEnqStatus" data-cl-status-filter>
            <option value="">All statuses</option>
            <!-- A grouped option, not a status. "No fare yet" is the question a
                 merchant actually asks, and it spans Pending and Under Review —
                 the difference between them is which desk has it, which is our
                 problem and not theirs. Handled in clLoadEnquiries: the API
                 takes one status at a time, so this one is narrowed here. -->
            <option value="__awaiting">Awaiting quotation</option>
            ${CL_ENQUIRY_STATUSES.map(s =>
              `<option value="${s}">${clEnquiryStatusLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <!-- CR-5: labelled "Search", not "Find". The behaviour is unchanged —
               it still narrows the rows already loaded — but "Find" was the only
               place in the product using that word for it. -->
          <label for="clEnqSearch">Search</label>
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

/* The two statuses an enquiry sits in before it has a fare. Grouped because
   that is the distinction the merchant cares about; see the filter markup. */
const CL_ENQUIRY_AWAITING = ['pending_approval', 'in_review'];

/* How many enquiries the current filter matches in the DATABASE, as opposed to
   how many are on screen. Rendered by clRenderEnquiryRows so a capped page
   cannot read as a complete answer. */
let clEnquiryTotal = 0;

async function clLoadEnquiries() {
  const body = $('clEnqBody');
  body.innerHTML = clLoadingRow(5, 'Loading enquiries…');
  const status = $('clEnqStatus').value;

  try {
    let rows;
    let total;
    if (status === '__awaiting') {
      /* `__awaiting` is a UI grouping, not an enum member — sending it would be
         a 422. Fetching a page unfiltered and dropping the answered rows here
         was the first implementation and it UNDERCOUNTS: this account has 1,633
         enquiries, so "awaiting a fare" meant "awaiting, among the 100 most
         recent" and disagreed with the dashboard tile that linked to it. Two
         server-filtered calls instead, merged, with the totals added. */
      const [pending, review] = await Promise.all(
        CL_ENQUIRY_AWAITING.map(s => MerchantApi.listEnquiries({ page_size: 100, status: s })));
      rows = [...(pending.items || []), ...(review.items || [])]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      total = (pending.total ?? 0) + (review.total ?? 0);
    } else {
      const data = await MerchantApi.listEnquiries({
        page_size: 100, ...(status ? { status } : {}),
      });
      rows = data.items || [];
      total = data.total ?? rows.length;
    }
    clEnquiryRows = rows;
    clEnquiryTotal = total;
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
      : 'No enquiries yet. Press “+ New Booking Enquiry” to raise your first one.');

  /* What is on screen, then what matches. This screen fetches one page of 100
     per status and the search narrows it in the browser, so on an account with
     1,633 enquiries the row count is NOT the answer to "how many are awaiting a
     fare" — and the dashboard tile that links here quotes the database's own
     figure. Saying both is what keeps the two screens from appearing to
     disagree. */
  const shown = rows.length;
  const capped = clEnquiryTotal > clEnquiryRows.length;
  $('clEnqCount').textContent = `${shown} enquir${shown === 1 ? 'y' : 'ies'} shown`
    + (q && shown !== clEnquiryRows.length ? ` (searched within ${clEnquiryRows.length} loaded)` : '')
    + (capped
      ? ` · ${clEnquiryTotal} match this filter — narrow it by status to see older ones`
      : clEnquiryTotal ? ` of ${clEnquiryTotal}` : '');

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
        · ${escapeHtml(fmtDate(r.travel_date))} ${escapeHtml(clTimeLabel(r.preferred_time) || '')}
        · ${r.passenger_count} pax
      </small>
    </td>
    <td>
      ${clEnquiryTag(r.status)}
      ${r.quoted_fare != null
        ? `<small style="display:block;color:var(--cl-text-muted);">Quoted ${
            escapeHtml(moneyStr(r.quoted_fare))}</small>` : ''}
    </td>
    <td class="cl-nowrap">${escapeHtml(clDateTime24(r.created_at))}</td>
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
      ['Created', clDateTime24(r.created_at)],
      ['Answered', r.responded_at ? clDateTime24(r.responded_at) : null],
      ['Booking request', r.booking_request_number],
    ].filter(([k, v]) => k === 'Status' || (v != null && v !== ''));

    $('clModalTitle').textContent = `Enquiry ${r.reference_number || ''}`;
    $('clModalBody').innerHTML = `
      ${clQuotationPanel(r)}
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
          the moment it is quoted, and Request Ticket appears here once it is available.</div>` : ''}`;

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

/* The quotation, given its own block at the top of the detail card (CR-5).
   ===========================================================================
   Not a row in the definition list, because it is not one more attribute of the
   enquiry — it is the answer, it is binding, and it is the number the merchant
   is deciding on. `moneyStr`, never `money()`: the fare arrives as a decimal
   string and `money()` would round it through a float and drop the paise.

   Absent on a pending enquiry, on a declined one, and on anything answered
   before CR-5 — hence the null check rather than a zero. */
function clQuotationPanel(r) {
  if (r.quoted_fare == null) return '';
  return `<div class="cl-msg cl-msg-ok" style="margin-top:0;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Total fare quoted</div>
      <div style="font-size:22px;font-weight:800;margin:2px 0 6px;">${escapeHtml(moneyStr(r.quoted_fare))}</div>
      ${r.quotation_remarks
        ? `<div style="white-space:pre-wrap;font-size:13px;">${escapeHtml(r.quotation_remarks)}</div>` : ''}
      <div style="font-size:12px;margin-top:6px;">This is the amount your booking will be raised
        at, and what is settled from your wallet once the ticket is issued.</div>
    </div>`;
}

/* Fold a freshly-read enquiry back into the table's data so the row reflects
   an answer that arrived after the list loaded, without a full refetch. */
function clUpsertEnquiryRow(r) {
  const i = clEnquiryRows.findIndex(x => String(x.id) === String(r.id));
  if (i >= 0) clEnquiryRows[i] = r; else clEnquiryRows.unshift(r);
  if ($('cl-enquiry')?.classList.contains('active')) clRenderEnquiryRows();
}

/* CR-5 — the merchant portal is 24-hour throughout.
   ===========================================================================
   The API has always stored 24-hour ("14:30"); it was the UI that collected
   1-12 + AM/PM and rendered it back the same way. Both ends of that conversion
   are gone here: the form's selector is a 24-hour list, and this returns the
   stored value essentially as-is.

   Kept as a function rather than inlined because it still has work to do —
   normalising "9:00" to "09:00" so a column of times aligns, and surviving a
   value the API never wrote. */
function clTimeLabel(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  return `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}

/* Timestamps, 24-hour, without touching the shared fmtDateTime().
   `fmtDateTime` uses en-IN with timeStyle:'short', which is 12-hour, and it is
   loaded by the Admin, Manager and Super Admin portals too — CR-5 scopes the
   24-hour clock to the merchant portal, so this is a local override rather than
   a change to a formatter four portals share. */
function clDateTime24(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
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

/* Cabin classes offered on the form (CR-5).
   ===========================================================================
   Was a free-text box. The four below are what airlines actually sell as a
   cabin, and typing that into a box produced "Buisness", "eco", "Y" and blanks
   — none of which the desk can quote against without asking.

   The API field is still free text (schemas/enquiry.py), so this list is a
   subset of what the server accepts, never a superset: the UI offers less than
   the server allows, which is the safe direction. Historical enquiries carrying
   a fare-family name still render, because the detail view prints the stored
   string rather than looking it up here. */
const CL_TRAVEL_CLASSES = ['Economy', 'Premium Economy', 'Business', 'First Class'];

function clOpenEnquiryForm() {
  const today = clTodayIso();
  clEnqForm = {
    trip_type: 'one_way',
    from: null, to: null,                 // { code, city, label } once picked
    airline: '',
    /* CR-5 — 24-hour. Was `depHour` 1-12 plus a `depMer` AM/PM toggle. */
    depTime: '09:00',
    retTime: '18:00',
    adults: 1, children: 0, infants: 0,
  };

  clOpenModal('New Booking Enquiry', `
    <div class="cl-trip" id="clEnqTrip" role="radiogroup" aria-label="Trip type">
      <label class="cl-trip-opt checked" data-cl-trip="one_way">
        <input type="radio" name="clEnqTripType" value="one_way" checked>One Way
      </label>
      <label class="cl-trip-opt" data-cl-trip="round_trip">
        <input type="radio" name="clEnqTripType" value="round_trip">Round Trip
      </label>
    </div>

    <div class="cl-form-legend">Departure &amp; Arrival</div>
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
        <label for="clEnqTime">Preferred time (24h)<span class="cl-req">*</span></label>
        <select id="clEnqTime">${clTimeOptions('09:00')}</select>
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
          <label for="clEnqReturnTime">Return preferred time (24h)<span class="cl-req">*</span></label>
          <select id="clEnqReturnTime">${clTimeOptions('18:00')}</select>
        </div>
      </div>
    </div>

    <div class="cl-form-legend">Travellers &amp; class</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqPax">Number of passengers<span class="cl-req">*</span></label>
        <input type="number" id="clEnqPax" min="1" max="99" value="1" inputmode="numeric">
        <small id="clEnqPaxHint">Type a total, or use the breakdown below — the two stay in step.</small>
      </div>
      <div class="cl-field">
        <label for="clEnqClass">Class<span class="cl-req">*</span></label>
        <select id="clEnqClass">
          ${CL_TRAVEL_CLASSES.map((c, i) =>
            `<option value="${escapeHtml(c)}"${i === 0 ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
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
     <button type="button" class="cl-btn cl-btn-primary" id="clEnqSubmit">Send Enquiry</button>`);

  $('clModal').classList.add('cl-modal-form');
  clModalOnClose = () => { $('clModal').classList.remove('cl-modal-form'); clEnqForm = null; };

  clWireEnquiryForm();
  $('clEnqFrom').focus();
}

/* 00:00 … 23:30, in half hours (CR-5).
   The old control was an hour 1-12 beside an AM/PM toggle, which is three
   decisions for one value and where "12" meant midnight or noon depending on a
   button beside it. A single 24-hour list has no such ambiguity, sorts the way
   a day runs, and is already the format the API stores — so the value the
   <select> carries is submitted verbatim, with no conversion left to get wrong.
   Half hours because a preferred departure of "around 09:30" is a real answer
   and the hour-only list forced it to 09:00 or 10:00. */
function clTimeOptions(selected) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    for (const m of ['00', '30']) {
      const v = `${String(h).padStart(2, '0')}:${m}`;
      out.push(`<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`);
    }
  }
  return out.join('');
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

  /* ---- 24-hour time selects (CR-5) ---- */
  $('clEnqTime').addEventListener('change', e => { clEnqForm.depTime = e.target.value; });
  $('clEnqReturnTime').addEventListener('change', e => { clEnqForm.retTime = e.target.value; });

  /* ---- dates ---- */
  $('clEnqDate').addEventListener('change', clSyncReturnMin);

  /* ---- passenger steppers ---- */
  $('clModalBody').querySelectorAll('[data-cl-step]').forEach(card => {
    const key = card.dataset.clStep;
    const min = Number(card.dataset.clMin);
    card.querySelector('[data-cl-step-dec]').addEventListener('click', () => clStepPax(key, -1, min));
    card.querySelector('[data-cl-step-inc]').addEventListener('click', () => clStepPax(key, +1, min));
  });

  /* ---- passenger total, typed (CR-5) ----
     `input` would fight the merchant mid-keystroke: clearing the box to type
     "12" momentarily reads as empty, and reconciling on every character would
     rewrite the breakdown twice on the way to one answer. `change` fires when
     they are done — on blur, on Enter, and on the spinner. */
  $('clEnqPax').addEventListener('change', clApplyTypedPaxTotal);

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
  clRenderStepper(key);
  clSyncPaxTotal();
}

/* Push one stepper's value back onto its card. Split out of clStepPax because
   clApplyTypedPaxTotal also moves a stepper, and a value changed in state but
   not on screen is the exact bug this pair exists to avoid. */
function clRenderStepper(key) {
  const card = $('clModalBody')?.querySelector(`[data-cl-step="${key}"]`);
  if (!card) return;
  const min = Number(card.dataset.clMin);
  const value = clEnqForm[key];
  card.querySelector('[data-cl-step-val]').textContent = String(value);
  card.querySelector('[data-cl-step-dec]').disabled = value <= min;
}

/* CR-5 — the merchant typed a total. Make the breakdown agree with it.
   ===========================================================================
   The field used to be `readonly`, derived from the three steppers, and that
   was reported as "the passenger count does not work" — because for a merchant
   booking nine adults it does not: you cannot type 9, you press "+" eight
   times, and the box that looks like an input refuses the keyboard.

   It cannot simply become a free input either. The server requires
   `passenger_count == adults + children + infants` (schemas/enquiry.py) and
   422s otherwise, so an unreconciled total is a form that looks filled in and
   cannot be submitted.

   So the two are kept in step, and **adults absorb the difference** — children
   and infants are only ever set deliberately, and an infant added by arithmetic
   nobody asked for would travel on a lap nobody booked. Growing is trivial.
   Shrinking has a floor: adults cannot go below one, nor below the number of
   infants, so a total that cannot be met by moving adults alone is clamped back
   to the smallest party the breakdown allows and says so. */
function clApplyTypedPaxTotal() {
  if (!clEnqForm) return;
  const input = $('clEnqPax');
  const f = clEnqForm;
  const typed = Math.trunc(Number(input.value));

  /* An empty or nonsense box reverts rather than being interpreted — guessing
     what "" meant is how a party of one silently becomes a party of eleven.
     The clamp message is dropped on the way out: the box has just been put back
     to a total that *is* achievable, and leaving "a party of 2 is not possible"
     on screen beside a valid party of 6 accuses the merchant of an error they
     are no longer making. */
  if (!Number.isFinite(typed) || typed < 1) {
    clClearPaxClampMsg();
    clSyncPaxTotal();
    return;
  }

  const others = f.children + f.infants;
  /* One adult minimum, and never fewer adults than infants. */
  const minAdults = Math.max(1, f.infants);
  const adults = Math.min(99, Math.max(minAdults, typed - others));

  f.adults = adults;
  clRenderStepper('adults');

  const reached = f.adults + others;
  if (reached !== typed) {
    clMsg($('clEnqMsg'),
      `A party of ${typed} is not possible with ${f.children} child${f.children === 1 ? '' : 'ren'} `
      + `and ${f.infants} infant${f.infants === 1 ? '' : 's'} — adjusted to ${reached}. `
      + 'Change the breakdown below to go lower.', 'err');
  } else {
    clClearPaxClampMsg();
  }
  clSyncPaxTotal();
}

/* Retract the clamp message, and only that one. The message area is shared with
   the infants-per-adult warning and with submit errors, so it is cleared by
   prefix rather than blanked — the same guard clSyncPaxTotal uses for its own. */
function clClearPaxClampMsg() {
  const msg = $('clEnqMsg');
  if (msg && msg.textContent.startsWith('A party of')) clMsg(msg, '');
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

/* CR-5 removed `clMeridiemToggle` and `cl24h` from this file. The form no
   longer collects an hour and a meridiem, so there is nothing to toggle and
   nothing to convert — the <select> already holds "HH:MM". Both were used only
   by this screen. */

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
  if (!travelClass) return fail('Choose the cabin class.', 'clEnqClass');
  if (f.adults < 1) return fail('At least one adult must travel.', 'clEnqPax');
  if (f.infants > f.adults) return fail('There cannot be more infants than adults.', 'clEnqPax');

  let returnDate = null;
  let returnTime = null;
  if (f.trip_type === 'round_trip') {
    returnDate = $('clEnqReturnDate').value;
    if (!returnDate) return fail('Choose the return date.', 'clEnqReturnDate');
    if (returnDate <= date) return fail('The return date must be after the departure date.', 'clEnqReturnDate');
    returnTime = f.retTime;
  }

  const payload = {
    trip_type: f.trip_type,
    origin: from.code, origin_city: from.city,
    destination: to.code, destination_city: to.city,
    airline,
    flight_number: flight,
    travel_date: date,
    /* Already "HH:MM" — the <select> holds exactly what the API stores. */
    preferred_time: f.depTime,
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
      <p style="font-size:13px;">We will confirm availability and quote a total fare for
        <b>${escapeHtml(clEnquiryRoute(enquiry))}</b> on
        <b>${escapeHtml(fmtDate(enquiry.travel_date))}</b>. You will be notified when it is
        quoted — <b>Request Ticket</b> then appears on this row and carries everything you
        have just entered, and the quoted amount, straight into the booking.</p>`,
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
          only be raised once our team has quoted it.
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
