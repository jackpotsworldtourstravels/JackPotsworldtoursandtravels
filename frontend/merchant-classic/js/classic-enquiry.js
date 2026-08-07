'use strict';
/* Classic — Booking Enquiry.
   ===========================================================================
   This screen replaces Inventory Search outright. The old flow searched a
   catalog and booked a row out of it; this one has the merchant describe the
   sector it wants, and our team quotes it. Nothing here talks to /api/catalog.

     New Booking Enquiry  the form, as a modal
     Listing              reference / status / created / actions
     View Details         everything the enquiry captured, plus our quotation
     Raise Booking        enabled once the enquiry is Available — carries the
                          whole enquiry over to Booking Request, pre-filled.
                          Was labelled "Request Ticket"; the row's own function
                          is still called clRequestTicket.
     View Booking         replaces it once a booking exists, and only opens it

   NAMING (CR-5, revised). This is **Booking Enquiry** here and in the Admin
   Portal — the old split that said "Ticket Enquiry" on staff screens was
   dropped on request, and only the Premium portal still carries it. The stored
   `request_type` is `ticket_enquiry` throughout regardless: renaming the API to
   match the label would have meant a migration and a contract break for a word.

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

/* The rows currently on screen, so View Details and Raise Booking can work
   from what was already fetched rather than re-querying per click. */
let clEnquiryRows = [];

/* Live state of the open form. Held here rather than read back off the DOM at
   submit time because the steppers, the time controls and the two combos each
   have a value that is not simply an input's .value. */
let clEnqForm = null;

/* =============================================================== screen === */

function clInitEnquiry() {
  $('cl-enquiry').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Booking Enquiry</h1>
      </div>
      <!-- TWO WAYS TO START, AND THE ORDER IS THE RECOMMENDATION.
           Enquiry first is the primary button because a quoted booking is
           settled at a price the merchant agreed before it committed. Book
           Directly skips the quotation, so the fare is named by our desk at
           ticket issuance — stated on the button's own title and again on the
           form, rather than being a surprise on the wallet. -->
      <!-- Both CTAs are always PRESENT; a role that may not raise work gets them
           disabled with the reason on hover. The screen behind them is the same
           for everyone — see the clCan note in classic-shell.js. -->
      <div class="cl-page-actions">
        <button type="button" class="cl-btn cl-btn-primary" id="clEnqNew"
          ${clCan('ticket.enquiry') ? '' : `disabled aria-disabled="true"
          title="${escapeHtml(CL_NO_ENQUIRY)}"`}>+ New Booking Enquiry</button>
        <button type="button" class="cl-btn cl-btn-cta" id="clEnqDirect"
          ${clCan('ticket.request')
            ? 'title="Raise the booking straight away, without asking us to quote it first"'
            : `disabled aria-disabled="true" title="${escapeHtml(CL_NO_BOOKING)}"`}>
          ${clIco('plane', { size: 15 })} Book Directly
        </button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clEnqStatus">Status</label>
          <select id="clEnqStatus" data-cl-status-filter>
            <option value="">All</option>
            <!-- A grouped option, not a status. "No fare yet" is the question a
                 merchant actually asks, and it spans Pending and Under Review —
                 the difference between them is which desk has it, which is our
                 problem and not theirs. Handled in clLoadEnquiries: the API
                 takes one status at a time, so this one is narrowed here. -->
            <option value="__awaiting" data-cl-chip-tone="warn">Awaiting Quotation</option>
            ${CL_ENQUIRY_STATUSES.map(s =>
              `<option value="${s}" data-cl-chip-tone="${CL_STATUS_TONE[s] || ''}">${clEnquiryStatusLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <!-- CR-5: labelled "Search", not "Find". The behaviour is unchanged —
               it still narrows the rows already loaded — but "Find" was the only
               place in the product using that word for it.
               The copy-to-clipboard button that used to sit beside this box was
               removed on request: it copied what had been TYPED rather than any
               result, which is a thing the merchant already has. The search
               itself is untouched. -->
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

  clChips('clEnqStatus', 'Status');

  $('clEnqNew').addEventListener('click', () => clOpenEnquiryForm());
  $('clEnqDirect').addEventListener('click', () => clOpenEnquiryForm(true));
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
    b.addEventListener('click', () => clRequestTicket(b.dataset.clEnqBook, b)));
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
  return `${from} ${tripTypeArrow(r.trip_type)} ${to}`;
}

function clEnquiryRow(r) {
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.reference_number || '—')}</td>
    <td>
      ${escapeHtml(clEnquiryRoute(r))}
      <small style="display:block;color:var(--cl-text-muted);">
        ${escapeHtml([fmtAirline(r.airline), r.flight_number].filter(Boolean).join(' '))}
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

/* CREATING a booking and VIEWING one are two different jobs, so they are two
   different controls and never share a label.
   ===========================================================================
   Raise Booking is the call to action: the one orange thing in the row, with
   the plane the rest of the portal uses for a booking. It is offered ONLY on an
   Approved enquiry that has not already been booked — the backend enforces both
   (400 and 409), so an enabled button anywhere else would be a call that can
   only fail.

   On an enquiry we have not quoted yet it is still rendered, DISABLED, rather
   than left out: a merchant who cannot see the action cannot tell whether it is
   missing or not-yet-earned, and the `title` says which. It carries no
   `data-cl-enq-book`, so it is inert even if something re-enables it.

   Once a booking exists the CTA is gone and a quiet View Booking takes its
   place — same behaviour as before, opening that booking, but it no longer
   dresses a past-tense fact ("Booking raised") as though it were an action. */
function clEnquiryActions(r) {
  const out = [
    `<button type="button" class="cl-btn cl-btn-sm" data-cl-enq-view="${r.id}">View Details</button>`,
  ];
  if (r.booking_request_id) {
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-quiet"
      data-cl-enq-booking="${r.booking_request_id}"
      title="Open ${escapeHtml(r.booking_request_number || 'the booking')}"
      >${clIco('external', { size: 13 })}View Booking</button>`);
  } else if (r.status === 'approved') {
    /* Quoted and not yet booked — the one state where this is a real action.
       A role without ticket.request still SEES it, disabled: the enquiry is
       ready and someone at the company needs to know that. */
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-primary cl-btn-cta"
      data-cl-enq-book="${r.id}"${clCan('ticket.request')
        ? ''
        : ` disabled aria-disabled="true" title="${escapeHtml(CL_NO_BOOKING)}"`}
      >${clIco('plane', { size: 14 })}Raise Booking</button>`);
  } else {
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-cta" disabled
      title="A booking can be raised once our team has quoted this enquiry"
      >${clIco('plane', { size: 14 })}Raise Booking</button>`);
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
      ['Trip type', tripTypeLabel(r.trip_type)],
      ['From', [r.origin_city, r.origin].filter(Boolean).join(' · ')],
      ['To', [r.destination_city, r.destination].filter(Boolean).join(' · ')],
      /* fmtAirline never returns empty, so this row always renders — "All
         Airlines" is what the merchant chose and is worth showing back. The
         flight number is genuinely absent when unstated and the filter below
         drops it. */
      ['Airline', fmtAirline(r.airline)],
      ['Flight number', r.flight_number],
      ['Departure date', fmtDate(r.travel_date)],
      ['Preferred time', clTimeLabel(r.preferred_time)],
      ['Return date', r.trip_type === 'round_trip' ? fmtDate(r.return_date) : null],
      ['Return time', r.trip_type === 'round_trip' ? clTimeLabel(r.return_preferred_time) : null],
      /* "Class" and "Booking Class", matching the form's own labels — the
         merchant should recognise what they typed. Both are absent on a group
         booking, and the `.filter` below drops a null row rather than printing
         an empty one. */
      ['Class', r.travel_class],
      ['Booking Class', r.booking_class],
      ['Passengers', r.passenger_count],
      /* The breakdown is only meaningful where the form collected one. A group
         states a total and nothing else, and rendering "Adults 300 · Children 0
         · Infants 0" would assert a composition nobody supplied. */
      ['Adults', r.trip_type === 'group_trip' ? null : r.adults],
      ['Children', r.trip_type === 'group_trip' ? null : r.children],
      ['Infants', r.trip_type === 'group_trip' ? null : r.infants],
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
          the moment it is quoted, and Raise Booking becomes available here.</div>` : ''}`;

    /* Same two controls as the row, same words. A merchant who opens Details to
       decide should meet the action they saw in the table, not a synonym. */
    const foot = [];
    if (r.status === 'approved' && !r.booking_request_id) {
      foot.push(`<button type="button" class="cl-btn cl-btn-primary cl-btn-cta" data-cl-modal-book="${r.id}"
        ${clActionAttrs('ticket.request', CL_NO_BOOKING)}
        >${clIco('plane', { size: 15 })}Raise Booking</button>`);
    }
    if (r.booking_request_id) {
      foot.push(`<button type="button" class="cl-btn" data-cl-modal-booking="${r.booking_request_id}"
        >${clIco('external', { size: 14 })}View Booking ${
        escapeHtml(r.booking_request_number || '')}</button>`);
    }
    foot.push('<button type="button" class="cl-btn" data-cl-modal-close>Close</button>');
    $('clModalFoot').innerHTML = foot.join('');

    $('clModalFoot').querySelector('[data-cl-modal-close]')?.addEventListener('click', clCloseModal);
    /* No button handed over: clCloseModal empties the footer, so a spinner set
       on this control would be spinning on a node that is already detached. The
       row's own Raise Booking is where the loading state is worth having. */
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
      ${/* 0040. The server derives saved_amount from the client fare typed on
            this enquiry and the fare we then quoted; nothing is subtracted
            here. Absent when no client fare was recorded — null means "not
            recorded", and "You saved 0" would be a claim the merchant never
            made. */ ''}
      ${/* The client fare — and only it — is printed with `moneyIntl`, the
            three-digit international grouping the spec asks for on this one
            figure. The saving beside it is OUR arithmetic on OUR quotation and
            stays on `moneyStr` with every other billed amount in the portal. */ ''}
      ${r.saved_amount != null ? `
        <div style="font-size:13px;margin-top:8px;font-weight:700;">
          You saved ${escapeHtml(moneyStr(r.saved_amount))}
          <span style="font-weight:600;opacity:.85;">against your client fare of
            ${escapeHtml(moneyIntl(r.client_fare))}</span>
        </div>` : ''}
    </div>`;
}

/* Fold a freshly-read enquiry back into the table's data so the row reflects
   an answer that arrived after the list loaded, without a full refetch. */
function clUpsertEnquiryRow(r) {
  const i = clEnquiryRows.findIndex(x => String(x.id) === String(r.id));
  if (i >= 0) clEnquiryRows[i] = r; else clEnquiryRows.unshift(r);
  if ($('cl-enquiry')?.classList.contains('active')) clRenderEnquiryRows();
}

/* ONE CLOCK, 24-HOUR, ENTRY AND DISPLAY ALIKE.
   ===========================================================================
   `schemas/enquiry.py` pins `preferred_time` to `^([01]\d|2[0-3]):[0-5]\d$`, so
   "14:30" is what is stored and what every other portal reads. It always was —
   what changed is that the merchant now *types* that, and reads it back
   unaltered on every screen it appears on.

   The 12-hour presentation layer that used to sit here is gone: `cl24To12`,
   `cl12To24` and the AM/PM select. A merchant who entered 14:30 was shown
   "02:30 PM" by the enquiry detail, the booking detail and three Admin screens,
   and had to re-do the conversion in their head to check their own entry
   against the sheet they typed it from. There is now nothing to convert, which
   is also two fewer places a meridiem can be wrong.

   Record timestamps (Created, Updated, audit and notification times) are NOT
   affected and stay on `clDateTime24`'s 12-hour clock — they are a different
   kind of value, written by the system rather than chosen by the merchant. */

/* "14:30". Survives a value the API never wrote — an unparseable string is
   returned as-is rather than rendered as "NaN:NaN", because a time nobody
   recognises is still more useful to the desk than a placeholder. */
function clTimeLabel(hhmm) {
  const t = clNormaliseTime(hhmm);
  if (!hhmm) return null;
  return t || hhmm;
}

/* "9:5" -> "09:05"; anything out of range -> null. The one parser, used by the
   label above and by the control's own blur handler, so a typed time and a
   stored one are held to identical bounds. */
function clNormaliseTime(hhmm) {
  const [rawH, rawM] = String(hhmm ?? '').split(':');
  const h = Number(rawH);
  const m = Number(rawM);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(m) || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* Timestamps, in the same 12-hour clock as the times above.
   CR-5 wrote this as a 24-hour override because the portal was 24-hour
   throughout; it no longer is, and an enquiry detail card reading
   "Preferred time 02:30 PM" directly above "Created 14:05" states two clocks
   in one list. The name is kept — every call site says `clDateTime24` and
   renaming it across four modules would be churn for nothing — but what it
   formats is now the portal's one clock.

   Still local rather than a change to the shared `fmtDateTime`, which four
   portals load: this one also pins the date part to `d Mon YYYY`, which
   `timeStyle:'short'` alone does not give. */
function clDateTime24(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
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

/* The resting text under the return-date box, and the one place it is written.
   clValidateReturnDate puts it back after clearing an error, so a literal in
   two places would let the box end up describing a rule it is not enforcing. */
const CL_RETURN_DATE_HINT = 'On or after the departure date — a same-day return is fine.';

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

/* ONE FORM, TWO DESTINATIONS.
   ===========================================================================
   `direct` is the whole difference between "ask us to quote this" and "book
   this now". The fields, the validation and the state object are identical —
   a journey is a journey — so this is a mode on the existing form rather than a
   second form that would then have to be kept in step with it.

     direct === false   POST /api/enquiries, and the desk quotes it.
     direct === true    no POST here at all. The itinerary is carried straight
                        into Booking Request, where the travellers are added and
                        POST /api/bookings/direct creates the booking.

   The button label and the banner are the only markup that branches. */
function clOpenEnquiryForm(direct = false) {
  const today = clTodayIso();
  clEnqForm = {
    direct: !!direct,
    trip_type: 'one_way',
    /* Only sent when trip_type is group_trip — the server refuses the pairing
       any other way round. `group_import` holds the validated upload. */
    group_journey_type: 'one_way_group',
    /* Only ever set on the Book Directly form. A group ENQUIRY carries no
       manifest at all now — it states a passenger count and the sheet is
       uploaded at Booking Request, once we have answered. */
    group_import: null,
    /* The party size a group enquiry is asking about. Null until typed, which
       is what makes "required" enforceable — 0 would be a real answer and 1 a
       plausible default nobody chose. */
    group_pax: null,
    from: null, to: null,                 // { code, city, label } once picked
    airline: '',
    /* 24-hour "HH:MM", which is now also what the control shows. */
    depTime: '09:00',
    retTime: '18:00',
    adults: 1, children: 0, infants: 0,
  };

  clOpenModal(direct ? 'Direct Booking Request' : 'New Booking Enquiry', `
    ${direct ? `<div class="cl-msg cl-msg-info" style="margin:0 0 16px;">
      <b>You are booking without a quotation.</b> We will not price this before you
      commit to it — our team confirms the fare when the ticket is issued, and your
      wallet is charged that amount then. If you would rather see the fare first,
      close this and use <b>+ New Booking Enquiry</b> instead.
    </div>` : ''}
    <!-- GROUP BOOKING IS OFFERED ON BOTH FORMS.
         It used to be direct-only, on the reasoning that a group fare is
         negotiated once the party is known rather than at the quotation stage.
         That held while a group booking was only a marker; now that the party
         arrives as an uploaded manifest, a merchant asking us to quote for
         eighty people has the same reason to attach the eighty as one booking
         them outright. Journey Type below decides the shape.
         (No backticks in this comment — it is inside a template literal.) -->
    <div class="cl-trip" id="clEnqTrip" role="radiogroup" aria-label="Trip type">
      <label class="cl-trip-opt checked" data-cl-trip="one_way">
        <input type="radio" name="clEnqTripType" value="one_way" checked>One Way
      </label>
      <label class="cl-trip-opt" data-cl-trip="round_trip">
        <input type="radio" name="clEnqTripType" value="round_trip">Round Trip
      </label>
      <label class="cl-trip-opt" data-cl-trip="group_trip">
        <input type="radio" name="clEnqTripType" value="group_trip">Group Booking
      </label>
    </div>

    <!-- Shown only for a group booking. The two options differ in exactly one
         way — whether the itinerary carries a return leg — which is why this
         reuses the same return-journey panel the Round Trip option does rather
         than introducing a second one. -->
    <div class="cl-groupjt cl-hidden" id="clEnqGroupJt">
      <div class="cl-form-legend" style="margin-top:0;">Journey Type<span class="cl-req">*</span></div>
      <div class="cl-trip" id="clEnqGroupJtOpts" role="radiogroup" aria-label="Group journey type">
        <label class="cl-trip-opt checked" data-cl-gjt="one_way_group">
          <input type="radio" name="clEnqGroupJt" value="one_way_group" checked>One Way Group
        </label>
        <label class="cl-trip-opt" data-cl-gjt="round_trip_group">
          <input type="radio" name="clEnqGroupJt" value="round_trip_group">Round Trip Group
        </label>
      </div>
    </div>

    <div class="cl-form-legend">Departure &amp; Arrival</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqFrom">Origin City<span class="cl-req">*</span></label>
        <div class="cl-combo">
          <input type="text" id="clEnqFrom" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list"
                 placeholder="Hyderabad, Delhi, Mumbai…">
          <div class="cl-combo-list" id="clEnqFromList" role="listbox"></div>
        </div>
      </div>
      <div class="cl-field">
        <label for="clEnqTo">Destination City<span class="cl-req">*</span></label>
        <div class="cl-combo">
          <input type="text" id="clEnqTo" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list"
                 placeholder="Cannot be the same as From">
          <div class="cl-combo-list" id="clEnqToList" role="listbox"></div>
        </div>
      </div>
    </div>

    <!-- BOTH FIELDS ARE OPTIONAL NOW, and neither carries the required marker.
         An enquiry is a question about a route on a date; which carrier and
         which service answer it best is part of what the desk is being asked.
         Requiring them made the merchant guess, and a guessed airline silently
         narrowed the quotation to it. -->
    <div class="cl-form-legend">Airline Details</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqAirline">Airline</label>
        <div class="cl-combo cl-combo-drop">
          <!-- Pre-filled with the open-enquiry text rather than left blank: an
               empty box invites the merchant to fill it, which is the opposite
               of the default being "we do not mind". clEnqForm.airline stays ''
               until a real carrier is picked, so what is SENT is nothing. -->
          <input type="text" id="clEnqAirline" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list"
                 value="${escapeHtml(CL_ANY_AIRLINE)}"
                 placeholder="${escapeHtml(CL_ANY_AIRLINE)}">
          <div class="cl-combo-list" id="clEnqAirlineList" role="listbox"></div>
        </div>
        <small id="clEnqAirlineHint">Leave as <b>${escapeHtml(CL_ANY_AIRLINE)}</b> and we will
          quote the best fare we can find on any carrier.</small>
      </div>
      <div class="cl-field">
        <label for="clEnqFlight">Airline Number</label>
        <input type="text" id="clEnqFlight" autocomplete="off" placeholder="Optional — e.g. AI217"
               maxlength="20" style="text-transform:uppercase;">
        <small>Leave blank if you do not have a specific flight number in mind.</small>
      </div>
    </div>

    <!-- THE TWO LEGS NOW READ THE SAME WAY. The outbound used to be a bare
         "Departure" legend over two fields while the return got a headed panel
         naming its route, so the one journey the merchant had actually chosen
         was the one never shown back to them. Both are cl-journey panels now,
         same head, same route pill — and neither is tinted any more (the return
         panel's shaded, dashed treatment is gone) so they sit in the form as
         plainly as every other section.
         (No backticks in this comment — it is inside a template literal.) -->
    <div class="cl-journey" id="clEnqDepart">
      <div class="cl-journey-head">
        Departure journey
        <span class="cl-route cl-route-empty" id="clEnqDepartRoute">Pick From and To first</span>
      </div>
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clEnqDate">Travel date<span class="cl-req">*</span></label>
          <input type="date" id="clEnqDate" min="${today}" value="${today}">
        </div>
        <div class="cl-field">
          <label for="clEnqTimeHour">Preferred time<span class="cl-req">*</span></label>
          ${clTimeField('clEnqTime', '09:00', 'Preferred departure time')}
        </div>
      </div>
    </div>

    <div class="cl-journey cl-hidden" id="clEnqReturn">
      <div class="cl-journey-head">
        Return journey
        <span class="cl-route cl-route-empty" id="clEnqReturnRoute">Pick From and To first</span>
      </div>
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="clEnqReturnDate">Return date<span class="cl-req">*</span></label>
          <!-- The floor is the departure date, not the day after it: a
               same-day return is allowed. clSyncReturnMin moves it as the
               outbound date changes. -->
          <input type="date" id="clEnqReturnDate" min="${today}">
          <!-- Answered the moment the field is left, not at submit — see
               clValidateReturnDate. -->
          <small id="clEnqReturnDateHint">${CL_RETURN_DATE_HINT}</small>
        </div>
        <div class="cl-field">
          <label for="clEnqReturnTimeHour">Return preferred time<span class="cl-req">*</span></label>
          ${clTimeField('clEnqReturnTime', '18:00', 'Return preferred time')}
        </div>
      </div>
    </div>

    <div class="cl-form-legend">Travellers &amp; class</div>
    <!-- THREE COLUMNS so Booking Class sits beside Class rather than wrapping
         to a row of its own — they are a pair (cabin, then the fare bucket
         within it) and reading one without the other is what the rename was
         meant to stop. cl-form-3 collapses to 2 columns and then to 1 on the
         existing breakpoints, so the pair stacks in order on a phone. -->
    <div class="cl-form cl-form-3">
      <div class="cl-field">
        <label for="clEnqPax" class="cl-label-sm">No. of Passengers<span class="cl-req">*</span></label>
        <input type="number" id="clEnqPax" min="1" max="99" value="1" inputmode="numeric">
        <small id="clEnqPaxHint">Type a total, or use the breakdown below — the two stay in step.</small>
      </div>
      <!-- TWO FIELDS, TWO DIFFERENT THINGS, and the names are genuinely
           confusing so they are worth stating: Class is the CABIN (Economy,
           Business…), Booking Class is the airline's single-letter FARE BUCKET
           within that cabin (Y, M and K are all Economy on different fare
           rules). The desk needs the letter to quote the right bucket. Until
           this pass the cabin dropdown was itself labelled "Booking Class",
           which is why the rename is a rename and not just a new field.
           (No backticks in this comment — it is inside a template literal.) -->
      <div class="cl-field" id="clEnqClassField">
        <label for="clEnqClass">Class<span class="cl-req">*</span></label>
        <select id="clEnqClass">
          ${CL_TRAVEL_CLASSES.map((c, i) =>
            `<option value="${escapeHtml(c)}"${i === 0 ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <div class="cl-field" id="clEnqBookingClassField">
        <label for="clEnqBookingClass">Booking Class</label>
        <input type="text" id="clEnqBookingClass" maxlength="1" autocomplete="off"
               inputmode="latin" placeholder="Y" class="cl-bkclass">
        <small>One letter — the airline&rsquo;s fare class. Optional.</small>
      </div>
    </div>

    <!-- GROUP BOOKINGS ONLY. A group enquiry asks whether a party of this size
         can fly and what it would cost; the travellers themselves are listed on
         the spreadsheet later, at Booking Request. So this is the only number
         the merchant can give at this stage, and the adults/children/infants
         breakdown below is not shown for a group at all. -->
    <div class="cl-form cl-form-2 cl-hidden" id="clEnqGroupPaxRow">
      <div class="cl-field">
        <label for="clEnqGroupPax">Number of Passengers<span class="cl-req">*</span></label>
        <input type="number" id="clEnqGroupPax" min="1" step="1" value="" inputmode="numeric"
               placeholder="e.g. 45">
        <small id="clEnqGroupPaxHint">Roughly how many seats you need. You will upload the
          passenger list once we have answered.</small>
      </div>
    </div>

    <div class="cl-pax-grid" id="clEnqPaxGrid" style="margin-top:14px;">
      ${clStepperCard('adults', 'Adults', '12 years and over', 1, 1)}
      ${clStepperCard('children', 'Children', '2 – 11 years', 0, 0)}
      ${clStepperCard('infants', 'Infants', 'Under 2, on lap', 0, 0)}
    </div>

    ${clUploadCard()}

    <div class="cl-form cl-form-2" style="margin-top:16px;">
      <div class="cl-field cl-field-full">
        <label for="clEnqNotes">Notes for our team</label>
        <textarea id="clEnqNotes" maxlength="1000"
          placeholder="Anything else we should know — flexible dates, baggage, corporate fare…"></textarea>
      </div>
    </div>

    <!-- CLIENT FARE — OPTIONAL, AND NOW ASKED FOR EXACTLY ONCE (migration 0040).
         What the merchant has quoted its OWN end customer. Never used for
         settlement; it only produces the "You Saved" figure on the enquiry, on
         the booking, in Reports and on the Dashboard's Total Savings tile.

         THIS IS THE ONLY PLACE IT IS COLLECTED. The Booking Request screen used
         to offer it a second time, after our quotation was on the page; that
         panel was removed on request, so what a merchant charges its customer
         is stated here, with the journey, and carried forward. The server side
         is untouched — to_booking_request still prefers a client fare in its
         payload and falls back to the enquiry's — which is precisely why
         omitting it there leaves this value standing.

         Grouped as it is typed: 1000 becomes 1,000. See clBindMoneyField.

         NO SECTION HEADING. The legend above this used to read "Your
         customer's fare", which said the same thing as the label a line below
         it and made a one-field section look like a new part of the form. The
         currency moved into the label instead, so the field states what it
         wants on its own: Client Fare (INR).
         (No backticks in this comment — it is inside a template literal.) -->
    <div class="cl-form cl-form-2" style="margin-top:26px;">
      <div class="cl-field">
        <label for="clEnqClientFare">Client Fare (INR)</label>
        <!-- TEXT, NOT number, and only because of the grouping. A number input
             cannot hold "20,000" — the browser reads a comma as invalid and
             hands back "" — so the separators the spec asks for are impossible
             while it stays type=number. Digits (and one decimal point) are the
             only characters clBindMoneyField lets through, and clParseMoney
             strips the commas again on the way out, so what is SENT is the same
             plain number it always was. -->
        <input type="text" id="clEnqClientFare" inputmode="decimal" autocomplete="off"
               placeholder="e.g. 20,000">
        <small>What you have quoted your customer. Optional — leave it blank and you
               can add it when you raise the booking, once we have quoted you.</small>
      </div>
    </div>

    <div class="cl-msg" id="clEnqMsg"></div>`,
    `<button type="button" class="cl-btn" id="clEnqCancel">Cancel</button>
     <button type="button" class="cl-btn cl-btn-primary" id="clEnqSubmit">${
       direct ? 'Continue to travellers' : 'Send Enquiry'}</button>`);

  $('clModal').classList.add('cl-modal-form');
  /* The upload card in this modal writes to clEnqForm. Cleared on close so a
     handler left over from a dismissed modal cannot write into the next screen
     that renders the card. */
  clGbSetHost(clGbEnquiryHost());
  clModalOnClose = () => {
    $('clModal').classList.remove('cl-modal-form');
    clEnqForm = null;
    clGbSetHost(null);
  };

  clWireEnquiryForm();
  $('clEnqFrom').focus();

  /* Not awaited: the merchant is looking at the form now, and the ceiling is
     only needed by the time they have typed a group count. When it lands it
     refreshes the hint in place, so the limit is stated before it is enforced
     rather than only in the error that follows breaking it. */
  clLoadGroupLimits().then(limits => {
    if (!limits || !clEnqForm) return;
    const el = $('clEnqGroupPax');
    if (el) el.max = limits.max_passengers;
    /* Re-render the hint only while it is still the untouched default —
       overwriting a validation message the merchant is currently reading with
       generic help would hide the reason their entry was rejected. */
    if (!$('clEnqGroupPaxHint')?.classList.contains('cl-hint-err')) {
      const hint = $('clEnqGroupPaxHint');
      if (hint) {
        hint.textContent = `Roughly how many seats you need, up to ${limits.max_passengers}. `
          + 'You will upload the passenger list once we have answered.';
      }
    }
  });
}

/* THE PASSENGER LIST UPLOAD — group bookings only.
   ===========================================================================
   Replaces the traveller entry section rather than sitting beside it. A group
   booking's passengers come from the sheet and from nowhere else, so leaving
   the manual cards visible would offer two sources for one list — which is the
   ambiguity `_check_passenger_source` refuses on the server anyway.

   Four states live in this one card, swapped by `clUploadState`: idle (drop
   zone), busy (progress), done (summary + actions) and error. They share a
   container so the card does not change height as it moves between them, which
   is what makes the modal jump under the merchant's cursor mid-upload. */
function clUploadCard() {
  return `
  <div class="cl-gb cl-hidden" id="clEnqUpload">
    <div class="cl-form-legend">Passenger List<span class="cl-req">*</span></div>
    <p class="cl-gb-lede">Upload all passenger details using our Excel template.
      One row per traveller — the journey columns repeat on every row.</p>

    <button type="button" class="cl-btn cl-gb-tmpl" id="clGbTemplate">
      <span aria-hidden="true">↓</span> Download Excel Template
    </button>

    <div class="cl-gb-body" id="clGbBody">
      <div class="cl-gb-drop" id="clGbDrop" tabindex="0" role="button"
           aria-label="Drag and drop your Excel file here, or activate to browse">
        <div class="cl-gb-drop-icon" aria-hidden="true">⊕</div>
        <div class="cl-gb-drop-title">Drag &amp; Drop Excel Here</div>
        <div class="cl-gb-drop-or">or</div>
        <span class="cl-btn cl-btn-primary cl-gb-browse">Upload Excel</span>
        <div class="cl-gb-meta">
          <span>Supported: <b>.xlsx</b> &middot; <b>.xls</b></span>
          <span>Maximum: <b>10 MB</b></span>
        </div>
      </div>
      <input type="file" id="clGbFile" accept=".xlsx,.xls" class="cl-gb-input"
             aria-hidden="true" tabindex="-1">
    </div>

    <div class="cl-msg" id="clGbMsg"></div>
  </div>

  <!-- THE ENQUIRY STAGE'S HALF OF THE SAME CARD: the template, and nothing to
       upload it into. Shown for a group booking on the enquiry form only, where
       the card above is hidden. Separate markup rather than the same card with
       its body hidden, because the two say genuinely different things — this
       one has to explain *why* there is no upload here, or its absence reads as
       a missing feature. Its button carries its own id: two elements sharing
       the id clGbTemplate would make document.getElementById a coin toss.
       (No backticks in this comment — it is inside a template literal.) -->
  <div class="cl-gb cl-hidden" id="clEnqTemplateOnly">
    <div class="cl-form-legend">Passenger List</div>
    <p class="cl-gb-lede">You do not need the passenger details yet. Tell us how many
      seats you need above, and we will confirm availability and a fare.
      <b>You will upload the passenger list when you raise the booking</b>, once we
      have answered — <b>Raise Booking</b> on this enquiry takes you there.</p>

    <button type="button" class="cl-btn cl-gb-tmpl" id="clGbTemplateOnlyBtn">
      <span aria-hidden="true">↓</span> Download Excel Template
    </button>
    <p class="cl-gb-lede" style="margin-top:10px;">Download it now if it helps you start
      collecting names and passport details while you wait.</p>
  </div>`;
}

/* THE 24-HOUR TIME CONTROL — hour and minute, both typed.
   ===========================================================================
   Still not an <input type="time">, for the two reasons that ruled it out when
   this control was 12-hour and are unchanged: the native picker renders in the
   *browser's* locale, so the very thing being specified here — that everyone
   sees 24-hour — would be up to the merchant's machine, and on Firefox/desktop
   it is a text field the platform then has to police anyway.

   What did change is that both parts are now typed rather than picked. The old
   control offered minutes in five-minute steps, which cannot express "09:37";
   the spec asks for any minute 00-59, and 60 options in a <select> is a worse
   way to enter two digits than typing them.

   `id` is the base — the parts are `<id>Hour` and `<id>Min`, which is what
   clReadTimeField and clBindTimeField below look for. There is no `<id>Mer`
   any more; anything still reaching for one is reading a stale copy of this
   file. `value` is 24-hour "HH:MM", which is both what the caller has and now
   what the merchant sees. */
function clTimeField(id, value, label) {
  const t = clNormaliseTime(value) || '09:00';
  const [hh, mm] = t.split(':');

  /* TYPED, NOT PICKED. Both parts are typed rather than selects: the merchant
     reads a departure time off an airline schedule and types it, and a 24-hour
     <select> would be 24 options beside 60 more. `inputmode="numeric"` brings
     up the digit keypad on a phone.

     TWO DIGITS, AND EXACTLY TWO. These were `type=number`, on which `maxlength`
     does nothing at all — so "123" and "2A" both went in, and the only thing
     standing between them and a stored time was the blur clamp. They are text
     inputs now, which makes `maxlength="2"` real; `clBindTimeField` strips any
     non-digit as it is typed, and still pads and clamps on the way out, so "9"
     leaves the field as "09" and "27" as "23".

     The arrow keys no longer step the value — that was `type=number`'s doing —
     which is the one thing given up for a field that cannot hold "123". */
  return `<div class="cl-timesel cl-timesel-24" id="${id}">
    <input type="text" id="${id}Hour" class="cl-timesel-h" value="${hh}"
           maxlength="2" inputmode="numeric" pattern="[0-9]{2}" autocomplete="off"
           aria-label="${escapeHtml(label)} — hour, 00 to 23">
    <span class="cl-timesel-sep" aria-hidden="true">:</span>
    <input type="text" id="${id}Min" class="cl-timesel-m" value="${mm}"
           maxlength="2" inputmode="numeric" pattern="[0-9]{2}" autocomplete="off"
           aria-label="${escapeHtml(label)} — minute, 00 to 59">
    <span class="cl-timesel-hint" aria-hidden="true">24h</span>
  </div>`;
}

/* The two parts, back as the "HH:MM" the API stores. Returns null when either
   is empty or out of range, so submit falls back to the last good value in the
   form state rather than sending "NaN:NaN" — the same contract the 12-hour
   version had. */
function clReadTimeField(id) {
  const h = $(`${id}Hour`), m = $(`${id}Min`);
  if (!h || !m) return null;
  return clNormaliseTime(`${h.value}:${m.value}`);
}

/* Keeps the form's state object in step with whichever part was just changed,
   and normalises what the merchant sees on the way out of the field.

   TWO PASSES, AND THEY DO DIFFERENT JOBS.
   `input` filters: anything that is not a digit never appears, and a third
   digit is refused — so "AA", "2A" and "123" cannot be typed at all. It does
   NOT pad or clamp, because rewriting "1" to "01" mid-entry leaves a merchant
   heading for 18:00 typing the "8" into a full field.
   `change` settles: it fires on blur and on Enter, which is when the value is
   actually meant, and that is where "9" becomes "09" and "27" becomes "23". */
function clBindTimeField(id, onChange) {
  ['Hour', 'Min'].forEach(part => {
    const el = $(`${id}${part}`);
    if (!el) return;

    /* maxlength stops a third *typed* character; this also stops a pasted one,
       and is what keeps letters out of a field that is no longer type=number. */
    clDigitsOnly(el, 2);

    el.addEventListener('change', () => {
      const max = part === 'Hour' ? 23 : 59;
      const raw = String(el.value ?? '').trim();
      /* An emptied box reverts to 00 rather than being left blank: the time is
         required, and clReadTimeField would return null for "" — which submit
         reads as "use the last good value", silently ignoring the clearing. */
      let n = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(n)) n = 0;
      n = Math.min(max, Math.max(0, Math.trunc(n)));
      el.value = String(n).padStart(2, '0');
      const read = clReadTimeField(id);
      if (read) onChange(read);
    });
  });
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
  /* openOnFocus: clicking the box shows all 18 carriers; typing filters them.
     Without it the pre-filled "All Airlines" made this read as a text input. */
  clCombo($('clEnqAirline'), $('clEnqAirlineList'), clAirlineOptions, picked => {
    /* `picked.value` is '' for the All Airlines option — see clAirlineOptions —
       so an open enquiry and a cleared box reach the same state by design. */
    clEnqForm.airline = picked ? picked.value : '';
    clSyncAirlineHint();
  }, { openOnFocus: true });
  /* Typing does not go through onPick, so the hint is refreshed on input too:
     a merchant who types over "All Airlines" should see the note stop claiming
     the enquiry is open the moment it stops being open. */
  $('clEnqAirline').addEventListener('input', clSyncAirlineHint);

  /* ---- 24-hour time controls. `depTime` / `retTime` hold "HH:MM", which is
     now also what the control shows — there is no conversion left anywhere, so
     entry, state and wire format are one value. Clamping to 00-23 / 00-59
     happens in the control on blur, not at submit. ---- */
  clBindTimeField('clEnqTime', v => { clEnqForm.depTime = v; });
  clBindTimeField('clEnqReturnTime', v => { clEnqForm.retTime = v; });

  /* ---- dates ----
     Picked, never typed (clPickerOnly in classic-shell.js), on both legs. The
     return leg is then judged the moment it is left rather than at submit: a
     merchant who picks a return before the departure should be told there and
     then, while the picker they used is still the thing they are thinking
     about. `change` covers the pick itself, `blur` covers a field left in a
     state the pick never produced. */
  clPickerOnly($('clEnqDate'));
  clPickerOnly($('clEnqReturnDate'));

  $('clEnqDate').addEventListener('change', () => {
    clSyncReturnMin();
    clValidateReturnDate();
  });
  $('clEnqReturnDate').addEventListener('change', clValidateReturnDate);
  $('clEnqReturnDate').addEventListener('blur', clValidateReturnDate);

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

  /* ---- client fare: grouped as it is typed (1000 -> 1,000) ---- */
  clBindMoneyField($('clEnqClientFare'));

  /* ---- booking class: exactly one A-Z letter ----
     Filtered on the way in rather than validated on the way out, because there
     is only ever one keystroke to get right and a merchant who typed "y1"
     should see "Y", not an error after they have moved on. `maxlength="1"` in
     the markup stops a second *accepted* character; this strips anything that
     is not a letter, which maxlength cannot do — "1" fills the field otherwise
     and the box then silently refuses the "Y" that follows it. */
  $('clEnqBookingClass').addEventListener('input', e => {
    e.target.value = (e.target.value.toUpperCase().match(/[A-Z]/) || [''])[0];
  });

  /* ---- group passenger count ----
     `change`, not `input`: the bound check below reports a number the merchant
     has finished typing, and running it per keystroke tells someone entering
     "150" that "1" is fine, then "15" is fine, then complains. */
  $('clEnqGroupPax').addEventListener('change', clValidateGroupPax);

  /* ---- group journey type + manifest upload ---- */
  $('clEnqGroupJtOpts').querySelectorAll('[data-cl-gjt]').forEach(opt => {
    opt.addEventListener('click', () => clSetGroupJourneyType(opt.dataset.clGjt));
    opt.querySelector('input').addEventListener('change',
      () => clSetGroupJourneyType(opt.dataset.clGjt));
  });
  clWireUpload();

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
  clSyncTripSections();
}

function clSetGroupJourneyType(gjt) {
  if (!clEnqForm || clEnqForm.group_journey_type === gjt) return;
  /* Changing the shape changes which template is correct, so an already
     uploaded sheet is dropped rather than silently re-used against the other
     journey type — a one-way manifest has no return columns at all. */
  if (clEnqForm.group_import) clClearImport('Journey Type changed — upload the matching template.');
  clEnqForm.group_journey_type = gjt;
  $('clEnqGroupJtOpts').querySelectorAll('[data-cl-gjt]').forEach(opt => {
    const on = opt.dataset.clGjt === gjt;
    opt.classList.toggle('checked', on);
    opt.querySelector('input').checked = on;
  });
  clSyncTripSections();
}

/* WHICH SECTIONS A TRIP TYPE SHOWS, DECIDED IN ONE PLACE.
   ===========================================================================
   Four inputs decide this now — trip type, the group journey type, and whether
   this is the enquiry form or the Book Directly form — and working it out at
   each call site is how one of them ends up disagreeing with the others.

   THE UPLOAD CARD IS THE INTERESTING ONE. It is shown for a group booking on
   the BOOKING REQUEST side only, never on an enquiry:

     enquiry  (direct === false)   count + template. No upload.
     directly (direct === true)    the full upload workflow.

   An enquiry asks whether a party of N can fly and what it costs; nobody has
   committed to anything, and the merchant frequently does not yet know who is
   going. Requiring eighty passport-bearing rows to ask a question was the wrong
   order, so the sheet now arrives once we have answered — at Booking Request,
   which is what `direct === true` already is. The enquiry-led path uploads on
   the Booking Request screen instead (classic-booking.js).

   ONE WAY AND ROUND TRIP ARE UNTOUCHED by all of this: every branch below is
   gated on `isGroup`, so both keep the passenger total, the breakdown, the
   cabin and the fare bucket exactly as they were. */
function clSyncTripSections() {
  const f = clEnqForm;
  if (!f) return;
  const isGroup = f.trip_type === 'group_trip';
  const hasReturn = f.trip_type === 'round_trip'
    || (isGroup && f.group_journey_type === 'round_trip_group');

  $('clEnqGroupJt').classList.toggle('cl-hidden', !isGroup);
  $('clEnqReturn').classList.toggle('cl-hidden', !hasReturn);

  /* Upload on the Booking Request form only — see the block comment above. */
  $('clEnqUpload').classList.toggle('cl-hidden', !(isGroup && f.direct));
  /* The template is offered at BOTH stages. A merchant asking us to quote a
     group has every reason to start collecting passport details while they
     wait, and the template is how they do that. It is the *upload* that has to
     wait for an answer, not the download. */
  $('clEnqTemplateOnly')?.classList.toggle('cl-hidden', !(isGroup && !f.direct));

  /* The manual traveller breakdown and its typed total are what the group
     passenger count replaces — a group has no per-traveller entry at this
     stage, so showing steppers that add up to something else would offer two
     answers to one question. */
  $('clEnqPaxGrid').classList.toggle('cl-hidden', isGroup);
  const paxField = $('clEnqPax')?.closest('.cl-field');
  if (paxField) paxField.classList.toggle('cl-hidden', isGroup);
  $('clEnqGroupPaxRow').classList.toggle('cl-hidden', !isGroup);

  /* Cabin and fare bucket are hidden for a group: which cabin a party of 300
     ends up in is part of what the desk negotiates, not something the merchant
     states up front. Both remain for one way and round trip. */
  $('clEnqClassField').classList.toggle('cl-hidden', isGroup);
  $('clEnqBookingClassField').classList.toggle('cl-hidden', isGroup);

  if (hasReturn) {
    clSyncReturnRoute();
    clSyncReturnMin();
  }
}

/* THE CONFIGURED GROUP CEILING, FETCHED NOT ASSUMED.
   ===========================================================================
   `group_booking_max_passengers` is a server setting and bounds two things: the
   count a group enquiry may state, and the rows its manifest may carry. The
   form has to enforce the same number, so it asks for it.

   Cached for the page's lifetime — it is configuration, it does not change
   between two opens of a modal, and re-fetching on every open would put a
   request in front of a form the merchant is already looking at.

   `null` until the first answer arrives, and the validation below treats that
   as "no client-side bound": a merchant whose network hiccupped can still send
   the enquiry and let the server judge it, rather than being blocked by a limit
   we could not read. The server is the authority either way. */
let clGroupLimits = null;

async function clLoadGroupLimits() {
  if (clGroupLimits) return clGroupLimits;
  try {
    clGroupLimits = await MerchantApi.groupBookingLimits();
  } catch {
    clGroupLimits = null;                       // stay silent; the server still checks
  }
  return clGroupLimits;
}

/* The bound, applied to the group count field. Returns the number when it is
   usable and null when it is not, so submit can reuse it as its own check
   rather than restating the rules. */
function clValidateGroupPax() {
  const el = $('clEnqGroupPax');
  const hint = $('clEnqGroupPaxHint');
  if (!el) return null;

  const raw = String(el.value ?? '').trim();
  const n = Number(raw);
  const max = clGroupLimits?.max_passengers ?? null;

  let problem = null;
  if (!raw) problem = 'Enter how many passengers are travelling.';
  else if (!Number.isInteger(n)) problem = 'Enter a whole number of passengers.';
  else if (n < 1) problem = 'A group booking needs at least one passenger.';
  else if (max && n > max) {
    problem = `The maximum number of passengers allowed for a Group Booking is ${max}.`;
  }

  el.classList.toggle('cl-input-err', !!problem);
  if (hint) {
    hint.textContent = problem
      || (max
        ? `Roughly how many seats you need, up to ${max}. You will upload the passenger list once we have answered.`
        : 'Roughly how many seats you need. You will upload the passenger list once we have answered.');
    hint.classList.toggle('cl-hint-err', !!problem);
  }
  if (problem) return null;
  clEnqForm.group_pax = n;
  return n;
}

/* ===========================================================================
   THE PASSENGER MANIFEST — upload, validate, review.
   =========================================================================== */
const CL_GB_MAX_BYTES = 10 * 1024 * 1024;

/* ONE UPLOAD IMPLEMENTATION, TWO HOSTS.
   ===========================================================================
   The card now appears on two different screens: the Book Directly form (a
   modal, in this file) and the Booking Request page (classic-booking.js), which
   is where an enquiry-led group booking uploads its sheet now that the enquiry
   stage does not. The workflow is identical on both — same template, same drop
   zone, same progress bar, same validation summary, same Replace File — so it
   is one implementation with the two host-specific bits injected, rather than a
   copy on each screen that would drift the first time one is fixed.

   What actually differs is only this:
     journeyType()  where the one_way/round_trip choice lives
     get() / set()  where the accepted import is remembered
     onDone(d)      anything the host wants after a successful import

   The element ids (clGbBody, clGbMsg, clGbDrop, clGbFile) are shared rather
   than parameterised because the two hosts are never on screen together — one
   is a modal over the enquiry screen, the other is the booking page — so a
   getElementById can only ever find the live one. `clGbSetHost` is called by
   whichever screen is rendering the card, and the null default is what makes a
   stale handler from a closed modal a no-op instead of a crash. */
let clGbHost = null;

function clGbSetHost(host) {
  clGbHost = host;
}

/* The enquiry/Book Directly modal's own host. Kept here beside the workflow it
   configures rather than at the call site, so the two stay legible together. */
function clGbEnquiryHost() {
  return {
    journeyType: () => clEnqForm?.group_journey_type || 'one_way_group',
    get: () => clEnqForm?.group_import || null,
    set: imp => { if (clEnqForm) clEnqForm.group_import = imp; },
    /* Keep the passenger total in step with what was actually imported, so the
       server's adults+children+infants reconciliation cannot fail on a number
       the merchant never typed. Only the modal has those fields. */
    onDone: d => {
      if (!clEnqForm) return;
      clEnqForm.adults = d.passengers_imported;
      clEnqForm.children = 0;
      clEnqForm.infants = 0;
      const pax = $('clEnqPax');
      if (pax) pax.value = d.passengers_imported;
    },
  };
}

function clWireUpload() {
  /* Bound before the early return below: on the enquiry form the drop zone is
     hidden and this button is the only part of the group card that exists to
     the merchant, so wiring it must not depend on the upload half being live. */
  $('clGbTemplateOnlyBtn')?.addEventListener('click', clDownloadTemplate);

  const drop = $('clGbDrop');
  const input = $('clGbFile');
  if (!drop || !input) return;

  $('clGbTemplate').addEventListener('click', clDownloadTemplate);

  /* The hidden <input type="file"> is the only thing that can actually open a
     picker — a click on the styled card is forwarded to it. */
  const browse = () => input.click();
  drop.addEventListener('click', browse);
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); browse(); }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) clUploadManifest(input.files[0]);
    /* Cleared so re-picking the SAME file fires `change` again — otherwise a
       merchant who corrects the sheet and reselects it sees nothing happen. */
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt =>
    drop.addEventListener(evt, e => {
      e.preventDefault();
      drop.classList.add('cl-gb-over');
    }));
  ['dragleave', 'drop'].forEach(evt =>
    drop.addEventListener(evt, e => {
      e.preventDefault();
      drop.classList.remove('cl-gb-over');
    }));
  drop.addEventListener('drop', e => {
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    /* SPEC: only one file. Taking files[0] silently would import one of three
       dropped sheets and say nothing about the other two. */
    if (files.length > 1) {
      clMsg($('clGbMsg'), 'Drop one file at a time.', 'err');
      return;
    }
    clUploadManifest(files[0]);
  });
}

/* `ev` is passed by the click listeners so the button that was actually pressed
   is the one disabled — there are three of them across the two screens
   (clGbTemplate, clGbTemplateOnlyBtn, clBrGbTemplate) and hard-coding one meant
   the other two threw on a null `disabled`. */
async function clDownloadTemplate(ev) {
  const btn = ev?.currentTarget || $('clGbTemplate');
  const jt = clGbHost?.journeyType() || 'one_way_group';
  if (btn) btn.disabled = true;
  try {
    await MerchantApi.downloadGroupTemplate(jt);
  } catch (err) {
    clMsg($('clGbMsg'), clError(err, 'Could not download the template.'), 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* Local checks first, then the server's. Both are needed and neither is
   redundant: this one gives an instant answer on the two things a browser can
   actually know (size and extension), and the server re-decides both from the
   bytes because a filename is a claim, not a fact. */
function clUploadManifest(file) {
  const msg = $('clGbMsg');
  const name = (file.name || '').toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    clMsg(msg, 'That is not an Excel file. Upload a .xlsx or .xls.', 'err');
    return;
  }
  if (file.size > CL_GB_MAX_BYTES) {
    clMsg(msg, `That file is ${fmtBytes(file.size)} — the limit is 10 MB.`, 'err');
    return;
  }
  if (file.size === 0) {
    clMsg(msg, 'That file is empty.', 'err');
    return;
  }

  clUploadBusy(file.name);
  const previous = clGbHost?.get()?.import_id || null;

  MerchantApi.uploadGroupManifest({
    file,
    journey_type: clGbHost?.journeyType() || 'one_way_group',
    replaces: previous,
    onProgress: pct => {
      const bar = $('clGbBar');
      if (bar) bar.style.width = `${pct}%`;
      const label = $('clGbPct');
      if (label) label.textContent = `${pct}%`;
    },
  }).then(result => {
    clGbHost?.set(result.imported);
    clUploadDone(result);
  }).catch(err => {
    clGbHost?.set(null);
    clUploadFailed(clEnquiryError(err));
  });
}

function clUploadBusy(filename) {
  $('clGbBody').innerHTML = `
    <div class="cl-gb-busy">
      <div class="cl-gb-file"><span aria-hidden="true">▤</span> ${escapeHtml(filename)}</div>
      <div class="cl-gb-progress" role="progressbar" aria-label="Upload progress"
           aria-valuemin="0" aria-valuemax="100">
        <div class="cl-gb-bar" id="clGbBar" style="width:0%"></div>
      </div>
      <div class="cl-gb-pct" id="clGbPct">0%</div>
      <div class="cl-gb-hint">Checking every row…</div>
    </div>`;
  clMsg($('clGbMsg'), '', '');
}

function clUploadDone(result) {
  const d = result.imported;
  const ok = d.validation_status === 'valid';
  const partial = d.validation_status === 'partial';

  $('clGbBody').innerHTML = `
    <div class="cl-gb-done ${ok ? 'cl-gb-ok' : partial ? 'cl-gb-warn' : 'cl-gb-bad'}">
      <div class="cl-gb-done-head">
        <span class="cl-gb-tick" aria-hidden="true">${ok ? '✓' : '!'}</span>
        <div>
          <div class="cl-gb-done-title">${ok ? 'Excel Successfully Imported' : 'Imported with problems'}</div>
          <div class="cl-gb-done-file">${escapeHtml(d.original_filename)} · ${fmtBytes(d.size_bytes)}</div>
        </div>
      </div>

      <div class="cl-gb-stats">
        <div class="cl-gb-stat"><b>${d.total_rows}</b><span>Total Rows</span></div>
        <div class="cl-gb-stat cl-gb-stat-ok"><b>${d.valid_rows}</b><span>Valid Rows</span></div>
        <div class="cl-gb-stat ${d.invalid_rows ? 'cl-gb-stat-bad' : ''}"><b>${d.invalid_rows}</b><span>Invalid Rows</span></div>
        <div class="cl-gb-stat"><b>${d.passengers_imported}</b><span>Passengers</span></div>
      </div>

      <div class="cl-gb-actions">
        <button type="button" class="cl-btn" id="clGbView">View Imported Data</button>
        <button type="button" class="cl-btn" id="clGbReplace">Replace File</button>
        ${d.errors && d.errors.length
          ? '<button type="button" class="cl-btn cl-btn-warn" id="clGbErrors">Download Error Report</button>'
          : ''}
      </div>

      ${d.errors && d.errors.length ? clErrorList(d.errors) : ''}
    </div>`;

  clMsg($('clGbMsg'), result.message, ok ? 'ok' : partial ? 'warn' : 'err');

  $('clGbView').addEventListener('click', () => clShowImported(d));
  $('clGbReplace').addEventListener('click', () => clClearImport(''));
  $('clGbErrors')?.addEventListener('click', async () => {
    try {
      await MerchantApi.downloadGroupErrors(d.import_id);
    } catch (err) {
      clMsg($('clGbMsg'), clError(err, 'Could not download the error report.'), 'err');
    }
  });

  /* Whatever the host wants to do with a successful import — the modal keeps
     its passenger total in step, the Booking Request page swaps the card for
     the read-only traveller table. */
  clGbHost?.onDone?.(d);
}

/* Row-level errors, exactly as the spec renders them: the merchant's own Excel
   row number, then what is wrong with it. Capped in the DOM because a sheet
   with 900 bad rows would otherwise build 900 nodes into a modal — the full
   set is always in the downloadable report. */
function clErrorList(errors) {
  const SHOWN = 25;
  const head = errors.slice(0, SHOWN).map(e => `
    <div class="cl-gb-err">
      <div class="cl-gb-err-row">Row ${Number(e.row)}</div>
      <div class="cl-gb-err-msg">${escapeHtml(e.message)}</div>
    </div>`).join('');
  const rest = errors.length > SHOWN
    ? `<div class="cl-gb-err-more">…and ${errors.length - SHOWN} more.
         Download the error report for the full list.</div>`
    : '';
  return `<div class="cl-gb-errs">${head}${rest}</div>`;
}

function clShowImported(d) {
  const rows = (d.passengers || []).map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(`${p.first_name} ${p.last_name}`)}</td>
      <td>${escapeHtml(p.passenger_type || '—')}</td>
      <td>${escapeHtml(p.gender || '—')}</td>
      <td>${escapeHtml(p.dob || '—')}</td>
      <td>${escapeHtml(p.nationality || '—')}</td>
      <td>${escapeHtml(p.passport_number || '—')}</td>
    </tr>`).join('');

  clOpenModal(`Imported passengers — ${escapeHtml(d.original_filename)}`, `
    <div class="cl-gb-viewwrap">
      <table class="cl-table cl-gb-view">
        <thead><tr>
          <th>#</th><th>Name</th><th>Type</th><th>Gender</th>
          <th>Date of Birth</th><th>Nationality</th><th>Passport</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7">No passengers imported.</td></tr>'}</tbody>
      </table>
    </div>`,
    '<button type="button" class="cl-btn cl-btn-primary" onclick="clCloseModal()">Close</button>');
}

function clUploadFailed(text) {
  $('clGbBody').innerHTML = `
    <div class="cl-gb-drop cl-gb-drop-err" id="clGbDrop" tabindex="0" role="button"
         aria-label="Upload failed. Activate to choose another file">
      <div class="cl-gb-drop-icon" aria-hidden="true">⚠</div>
      <div class="cl-gb-drop-title">Upload failed</div>
      <div class="cl-gb-drop-or">Drop a corrected file, or</div>
      <span class="cl-btn cl-btn-primary cl-gb-browse">Choose another file</span>
    </div>
    <input type="file" id="clGbFile" accept=".xlsx,.xls" class="cl-gb-input"
           aria-hidden="true" tabindex="-1">`;
  clMsg($('clGbMsg'), text, 'err');
  clWireUpload();
}

/* Back to the empty drop zone. Also forgets the import on the host, which is
   what stops a replaced sheet from being the one that gets submitted. */
function clClearImport(note) {
  clGbHost?.set(null);
  const body = $('clGbBody');
  if (!body) return;
  body.innerHTML = `
    <div class="cl-gb-drop" id="clGbDrop" tabindex="0" role="button"
         aria-label="Drag and drop your Excel file here, or activate to browse">
      <div class="cl-gb-drop-icon" aria-hidden="true">⊕</div>
      <div class="cl-gb-drop-title">Drag &amp; Drop Excel Here</div>
      <div class="cl-gb-drop-or">or</div>
      <span class="cl-btn cl-btn-primary cl-gb-browse">Upload Excel</span>
      <div class="cl-gb-meta">
        <span>Supported: <b>.xlsx</b> &middot; <b>.xls</b></span>
        <span>Maximum: <b>10 MB</b></span>
      </div>
    </div>
    <input type="file" id="clGbFile" accept=".xlsx,.xls" class="cl-gb-input"
           aria-hidden="true" tabindex="-1">`;
  clMsg($('clGbMsg'), note || '', note ? 'muted' : '');
  clWireUpload();
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* One route pill, painted from whichever pair of cities the caller names.
   Both legs use it, so "Hyderabad → Colombo" is built once and the outbound and
   the return cannot end up formatted differently. */
function clPaintRoute(elId, from, to) {
  const el = $(elId);
  if (!el) return;
  if (!from || !to) {
    el.className = 'cl-route cl-route-empty';
    el.textContent = 'Pick From and To first';
    return;
  }
  el.className = 'cl-route';
  el.innerHTML = `${escapeHtml(from.city)} <span>→</span> ${escapeHtml(to.city)}`;
}

/* The outbound leg, shown back exactly as the return one is. It is the journey
   the merchant just chose, so unlike the return there is nothing to derive —
   this only echoes it, which is the point: a route stated once in two combo
   boxes is easy to mis-read, and easy to check against a pill. */
function clSyncDepartRoute() {
  if (!clEnqForm) return;
  clPaintRoute('clEnqDepartRoute', clEnqForm.from, clEnqForm.to);
}

/* The return leg is the outbound reversed, shown rather than asked for — the
   spec's "automatically display To City -> From City". */
function clSyncReturnRoute() {
  if (!clEnqForm) return;
  clSyncDepartRoute();
  clPaintRoute('clEnqReturnRoute', clEnqForm.to, clEnqForm.from);
}

/* A return cannot be BEFORE the departure, so the picker's floor moves with the
   outbound date and an already-chosen invalid date is cleared rather than left
   sitting there looking accepted.

   THE FLOOR IS THE DEPARTURE DATE ITSELF, not the day after. A same-day return
   is a real journey — the morning flight out and the evening flight back is one
   of the commonest corporate itineraries there is — and refusing it made the
   merchant raise two one-way enquiries for one trip. */
function clSyncReturnMin() {
  const dep = $('clEnqDate').value;
  const ret = $('clEnqReturnDate');
  if (!dep || !ret) return;
  ret.min = dep;
  if (ret.value && ret.value < dep) ret.value = '';
}

/* THE RETURN DATE IS JUDGED WHEN IT IS LEFT, NOT AT SUBMIT.
   ===========================================================================
   `min` on the input is a suggestion the picker honours and a typed or
   programmatically set value ignores, and clSyncReturnMin only runs when the
   DEPARTURE moves — so a return date earlier than the departure survived on
   screen, looking accepted, until submit refused it several sections later.

   Says the same thing submit says, in the same words, beside the field. Returns
   true when the leg is usable, so the message and the outline can never
   disagree with what the form will actually accept.

   Silent when there is no return leg to judge, and when the field is simply
   empty: "required" is submit's job, and accusing a merchant of an omission
   they are two seconds into making is the reason validation gets ignored. */
function clValidateReturnDate() {
  const ret = $('clEnqReturnDate');
  const hint = $('clEnqReturnDateHint');
  if (!ret || !clEnqForm) return true;

  const hasReturn = !$('clEnqReturn')?.classList.contains('cl-hidden');
  const dep = $('clEnqDate')?.value || '';
  const value = ret.value || '';

  /* ONE RULE, AND SAME-DAY PASSES IT. The return may not be EARLIER than the
     departure; equal is fine. The separate "not the same day" branch that used
     to sit here is gone with the day-after floor in clSyncReturnMin. */
  let problem = null;
  if (hasReturn && value && dep && value < dep) {
    problem = 'The return date cannot be before the departure date.';
  }

  ret.classList.toggle('cl-input-err', !!problem);
  if (hint) {
    hint.textContent = problem || CL_RETURN_DATE_HINT;
    hint.classList.toggle('cl-hint-err', !!problem);
  }
  return !problem;
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

/* THE OPEN-ENQUIRY OPTION, and the exact text the input carries for it.
   Compared against on submit, so it must be one constant rather than a string
   literal repeated at the three places that read it. */
const CL_ANY_AIRLINE = 'All Airlines';

/* Carrier code (2-3 alphanumerics), then 1-4 digits, then an optional
   operational suffix: AI217, 6E456, UK 955, AI101A. Mirrors `_FLIGHT_RE` in
   group_booking_service.py, which validates the same thing on the spreadsheet
   rows — one shape for a flight number, wherever it is typed. */
const CL_FLIGHT_RE = /^[A-Z0-9]{2,3}\s*\d{1,4}[A-Z]?$/i;

/* "All Airlines" always heads the list and is never filtered out by the query,
   so a merchant who has typed a carrier's name and changed their mind can get
   back to an open enquiry without clearing the box by hand. */
function clAirlineOptions(query) {
  /* THE LABEL IS NOT A SEARCH TERM. The box ships pre-filled with "All
     Airlines", so without this the query on first focus is that literal string
     — which matches no carrier, and the merchant is shown a one-row list and
     concludes the field is free text. Treating it as empty is what makes
     clicking the box show the airlines. */
  const raw = query.trim();
  const q = raw.toLowerCase() === CL_ANY_AIRLINE.toLowerCase() ? '' : raw.toLowerCase();

  const any = {
    value: CL_ANY_AIRLINE,
    label: CL_ANY_AIRLINE,
    sub: 'Open enquiry — we quote the best fare on any carrier',
    data: { value: '' },                 // '' is what "no airline" sends
  };
  /* Uncapped: there are 18 carriers in CL_AIRLINES and the list scrolls, so a
     slice only ever hid options the merchant was looking for. The cities combo
     keeps its cap — that dataset is thousands of rows, not eighteen. */
  const matches = CL_AIRLINES
    .filter(a => !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().startsWith(q))
    .map(a => ({ value: a.name, label: a.name, sub: `Carrier code ${a.code}`, data: { value: a.name } }));

  /* THE LIST IS NOT THE LIMIT, AND THE MERCHANT HAS TO BE ABLE TO SEE THAT.
     CL_AIRLINES is eighteen carriers we happen to name; the field has always
     accepted anything, and the desk can quote a carrier we never listed. Once
     the box became a dropdown that stopped being obvious — type "Lufthansa" and
     the only row offered is "All Airlines", which reads as a refusal. This adds
     the typed text back as an explicit choice, so free entry is a visible
     option rather than a thing you have to guess still works. */
  if (raw && !matches.length) {
    return [
      { value: raw, label: `Use “${raw}” as typed`,
        sub: 'Not one of our listed carriers — we will quote it as written',
        data: { value: raw } },
      any,
    ];
  }
  return [any, ...matches];
}

/* WHAT THE AIRLINE BOX ACTUALLY MEANS, in one place.
   Returns '' for an open enquiry and the carrier's name otherwise. Reads the
   live input rather than `clEnqForm.airline` so free text the merchant typed
   without picking from the list is honoured — the same fallback the city
   fields use. "All Airlines" is a LABEL: matched case-insensitively and
   translated to '', so it can never be stored as a carrier by that name. */
function clReadAirline() {
  const typed = ($('clEnqAirline')?.value || '').trim();
  if (!typed || typed.toLowerCase() === CL_ANY_AIRLINE.toLowerCase()) return '';
  return typed;
}

/* Says which of the two things the enquiry currently is. Worth stating rather
   than leaving implicit: "All Airlines" in a box that also accepts a carrier
   name reads as a placeholder, and a merchant who assumed it was one would be
   surprised to get quotes on four carriers. */
function clSyncAirlineHint() {
  const hint = $('clEnqAirlineHint');
  if (!hint) return;
  const airline = clReadAirline();
  hint.innerHTML = airline
    ? `We will quote <b>${escapeHtml(airline)}</b> for this sector.`
    : `Leave as <b>${escapeHtml(CL_ANY_AIRLINE)}</b> and we will quote the best fare we can `
      + 'find on any carrier.';
}

/* A searchable dropdown over an input.
   - Typing filters; ↑/↓ move, Enter picks, Escape closes.
   - Picking calls onPick with the option's `data`.
   - Typing again CLEARS the pick, so an input edited down from "Hyderabad
     (HYD)" to "Hyd" can never still be secretly carrying HYD. The same trap
     mh-autocomplete.js documents on the Premium side. */
/* `openOnFocus` makes the control behave like a dropdown as well as a search
   box: clicking it shows every option, and typing narrows them. Opt-in rather
   than the default because the two datasets are nothing alike — 18 airlines are
   worth showing unprompted, while `clCityOptions('')` over thousands of
   airports would drop a meaningless list under the cursor the moment the field
   is tabbed into. */
function clCombo(input, list, optionsFor, onPick, { openOnFocus = false } = {}) {
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
  input.addEventListener('focus', () => { if (openOnFocus || input.value.trim()) render(); });
  /* A second click on an already-focused input re-opens a list the merchant
     just dismissed with Escape — without this, `focus` has already fired and
     the box looks inert until they type. */
  input.addEventListener('mousedown', () => {
    if (openOnFocus && document.activeElement === input && !list.classList.contains('open')) {
      setTimeout(render, 0);
    }
  });
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

/* NOTHING IN THIS FILE CONVERTS BETWEEN CLOCKS ANY MORE.
   CR-5 removed `clMeridiemToggle` and `cl24h`; the 12-hour layer that briefly
   replaced them — `cl24To12`, `cl12To24` and the AM/PM select — went on
   2026-08-05. The control collects "HH:MM" on a 24-hour clock, the state holds
   it, the API stores it and every screen prints it back unchanged. A helper
   here that converted anything would be reintroducing the gap it closed. */

/* ================================================================ submit == */

/* AN AMOUNT THAT READS THE WAY IT IS WRITTEN DOWN: 1,000 · 10,000 · 1,000,000.
   ===========================================================================
   Grouped in threes — the international convention the spec names — rather than
   `moneyStr`'s Indian grouping, which is what every *billed* figure in this
   portal uses. The two live side by side deliberately: this is the merchant's
   own selling price to its own customer, and it is the one number the spec asks
   to be shown that way in both portals. `moneyIntl` in shared/formatters.js
   renders it back on every screen that displays it.

   Formatting happens on `input`, so the separators appear as the digits do.
   Only the INTEGER part is grouped while typing — regrouping the fraction would
   fight a merchant halfway through "1234.5" — and at most two decimals are
   accepted, which is what the Decimal column stores.

   The caret is restored by counting digits rather than characters: inserting a
   comma shifts every position after it, and `.value = ...` alone drops the
   cursor at the end mid-edit. */
function clFormatMoneyInput(raw) {
  const t = String(raw ?? '');
  /* One decimal point survives; everything that is not a digit goes. */
  const cleaned = t.replace(/[^\d.]/g, '').replace(/\.(?=.*\.)/g, '');
  if (!cleaned) return '';
  const [whole, fraction] = cleaned.split('.');
  const grouped = groupThousands(whole.replace(/^0+(?=\d)/, ''));
  if (fraction === undefined) return grouped;
  return `${grouped || '0'}.${fraction.slice(0, 2)}`;
}

function clBindMoneyField(input) {
  if (!input) return;
  input.addEventListener('input', () => {
    const before = input.value;
    const caret = input.selectionStart ?? before.length;
    const after = clFormatMoneyInput(before);
    if (after === before) return;
    /* Digits (and the point) before the caret are the fixed point across a
       reformat; the caret goes back after the same count of them. */
    const kept = before.slice(0, caret).replace(/[^\d.]/g, '').length;
    input.value = after;
    let seen = 0;
    let at = after.length;
    for (let i = 0; i < after.length; i += 1) {
      if (after[i] !== ',') seen += 1;
      if (seen === kept) { at = i + 1; break; }
    }
    input.setSelectionRange(kept === 0 ? 0 : at, kept === 0 ? 0 : at);
  });
}

/* An optional money input. Returns null for blank/garbage so the field is
   omitted rather than sent as 0, and never returns a negative — the column has
   a CHECK constraint and a 422 on a typo is a worse experience than clamping.

   COMMAS ARE STRIPPED HERE, which is what keeps the grouping above a display
   concern only: `Number("20,000")` is NaN, so without this every fare the
   merchant could now see would have been sent as null. What reaches the API is
   the same plain number it always was. */
function clParseMoney(raw) {
  const t = String(raw ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

async function clSubmitEnquiry() {
  const msg = $('clEnqMsg');
  const btn = $('clEnqSubmit');
  const f = clEnqForm;
  if (!f) return;

  /* Every required field, checked in the order they appear on the form so the
     first thing the merchant is sent back to is the first thing that is wrong. */
  const from = f.from || clFreeTextPlace($('clEnqFrom').value);
  const to = f.to || clFreeTextPlace($('clEnqTo').value);
  /* AN OPEN ENQUIRY SENDS NO AIRLINE AT ALL. The box reads "All Airlines" by
     default, and that text is a label rather than a value — sending it would
     store a carrier by that name and the desk would read it as one. Anything
     the merchant actually typed or picked is sent as-is. */
  const airline = clReadAirline();
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
  /* NEITHER AIRLINE NOR FLIGHT NUMBER IS REQUIRED. Blank is a real answer on
     both — "any carrier", "no particular service" — and the desk chooses when
     it quotes. A flight number that IS typed is still checked below, because a
     half-remembered one is worse than none: the desk would quote the wrong
     service rather than pick a right one. */
  if (flight && !CL_FLIGHT_RE.test(flight)) {
    return fail('That does not look like a flight number. Use a form like AI217 or 6E456, '
      + 'or leave it blank and we will choose the flight.', 'clEnqFlight');
  }
  if (!date) return fail('Choose the travel date.', 'clEnqDate');
  if (date < clTodayIso()) return fail('The travel date cannot be in the past.', 'clEnqDate');

  const isGroup = f.trip_type === 'group_trip';

  /* Cabin and fare bucket are not on screen for a group — see clSyncTripSections
     — so they are neither read nor required there. Both stay exactly as they
     were for one way and round trip. */
  if (!isGroup && !travelClass) return fail('Choose the cabin class.', 'clEnqClass');

  let groupPax = null;
  if (isGroup) {
    /* A GROUP ENQUIRY IS A QUESTION ABOUT SEATS, so what it must carry is a
       count, not a manifest. The adults/infants rules below are about a
       breakdown that is not on screen for a group at all. */
    groupPax = clValidateGroupPax();
    if (groupPax === null) return fail(
      $('clEnqGroupPaxHint')?.textContent || 'Enter how many passengers are travelling.',
      'clEnqGroupPax');

    /* THE MANIFEST IS ONLY EVER PART OF THE BOOKING-REQUEST FORM. On the
       enquiry there is no upload card to have filled in, so this whole branch
       is skipped and `group_import` stays null. */
    if (f.direct) {
      if (!f.group_import) {
        clMsg($('clGbMsg'), 'Upload the passenger list before continuing.', 'err');
        $('clGbDrop')?.focus();
        return null;
      }
      if (!f.group_import.can_submit) {
        clMsg($('clGbMsg'),
          `${f.group_import.invalid_rows} row(s) still need fixing. Correct them and upload again.`,
          'err');
        return null;
      }
      /* BOTH ANSWERS ARE ON THIS ONE FORM, so they can disagree in a way the
         enquiry-led path cannot: there, the count is stated on one screen and
         the sheet uploaded on another, days apart. Here the merchant typed 45
         and attached three rows in the same sitting, which is a slip far more
         often than a decision. The sheet still wins — it is the list of people
         who fly — but not silently. */
      const imported = f.group_import.passengers_imported;
      if (groupPax !== imported) {
        const ok = await clConfirm(
          `You entered ${groupPax} passenger(s) but the uploaded list has ${imported}. `
          + 'The booking will be raised for the travellers in the list. Continue?',
          'Continue');
        if (!ok) return null;
      }
    }
  } else {
    if (f.adults < 1) return fail('At least one adult must travel.', 'clEnqPax');
    if (f.infants > f.adults) return fail('There cannot be more infants than adults.', 'clEnqPax');
  }

  const hasReturn = f.trip_type === 'round_trip'
    || (isGroup && f.group_journey_type === 'round_trip_group');

  let returnDate = null;
  let returnTime = null;
  if (hasReturn) {
    returnDate = $('clEnqReturnDate').value;
    if (!returnDate) return fail('Choose the return date.', 'clEnqReturnDate');
    /* The same check the field already ran when it was left, so the sentence
       under the box and the sentence at the bottom of the form are one rule
       stated once rather than two that can drift. */
    if (!clValidateReturnDate()) {
      return fail($('clEnqReturnDateHint')?.textContent
        || 'The return date cannot be before the departure date.', 'clEnqReturnDate');
    }
    returnTime = clReadTimeField('clEnqReturnTime') || f.retTime;
  }

  const payload = {
    trip_type: f.trip_type,
    /* null unless this is a group booking — the server refuses the pairing the
       other way round, so sending it unconditionally would 422 a one-way. */
    group_journey_type: isGroup ? f.group_journey_type : null,
    origin: from.code, origin_city: from.city,
    destination: to.code, destination_city: to.city,
    /* null, not '', for both — the schema normalises either, but null is what
       "not stated" means and what every reader already tests for. */
    airline: airline || null,
    flight_number: flight || null,
    travel_date: date,
    /* Read from the control, with the form state as the fallback. Both are
       24-hour "HH:MM" and cannot disagree — the control's own change handler is
       what writes the state — but reading the live DOM means an autofilled or
       programmatically set value cannot be missed. */
    preferred_time: clReadTimeField('clEnqTime') || f.depTime,
    return_date: returnDate,
    return_preferred_time: returnTime,
    /* Omitted on a group booking, whose form shows neither field. The server
       makes both optional and requires the cabin only where it is asked for. */
    travel_class: isGroup ? null : travelClass,
    booking_class: isGroup ? null : (($('clEnqBookingClass').value || '').trim() || null),
    /* WHERE A GROUP'S PARTY SIZE COMES FROM, and it is two different places:
         enquiry  — the number the merchant typed. Nobody has listed the
                    travellers yet, and that is the whole point of the stage.
         directly — the imported rows, because a Book Directly group DOES carry
                    its manifest and the sheet is then the authority. Sending
                    the typed count instead would let a party of 45 be claimed
                    against a sheet of 44 and fail the server's arithmetic.
       The breakdown cards are hidden either way, so the stepper state is not
       sent for a group at all. */
    passenger_count: isGroup
      ? (f.direct ? f.group_import.passengers_imported : groupPax)
      : f.adults + f.children + f.infants,
    adults: isGroup
      ? (f.direct ? f.group_import.passengers_imported : groupPax)
      : f.adults,
    children: isGroup ? 0 : f.children,
    infants: isGroup ? 0 : f.infants,
    group_import_id: isGroup && f.direct ? f.group_import.import_id : null,
    notes: ($('clEnqNotes').value || '').trim() || null,
    /* 0040. SENT AS null WHEN BLANK, NOT 0 — the column distinguishes "not
       recorded" from "quoted at zero", and a 0 here would drop a zero-saving
       booking into the merchant's savings average. Parsed rather than passed
       through so an empty string never reaches a Decimal field.

       Optional at this stage: a merchant who leaves it blank is offered the
       same field again on Booking Request, where our quotation is visible. */
    client_fare: clParseMoney($('clEnqClientFare').value),
  };

  /* DIRECT MODE STOPS HERE. Nothing is sent: the itinerary is handed to Booking
     Request, which collects the travellers and then creates the booking in one
     call. Deliberately not "create a draft now and add passengers later" —
     abandoning the form halfway would otherwise leave an empty booking in My
     Requests that the merchant never meant to raise. */
  if (f.direct) {
    clCloseModal();
    clStartDirectBooking(payload);
    return;
  }

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
        quoted — <b>Raise Booking</b> then lights up on this row and carries everything you
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
/* `btn`, when given, is the Raise Booking control that started this. It spins
   for the whole round trip — two GETs and, on the Classic track, a form that is
   then built and navigated to — because on a table of twenty-five rows a
   page-level "working…" tells you nothing about which one you pressed. The
   restore is in a `finally` and is deliberately unconditional: on the happy
   path the row has usually been re-rendered underneath us by
   clUpsertEnquiryRow, so this touches a detached node and no longer matters. */
async function clRequestTicket(enquiryId, btn) {
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
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
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}
