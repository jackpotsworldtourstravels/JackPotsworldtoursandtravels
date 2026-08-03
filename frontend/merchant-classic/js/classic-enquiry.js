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
   submit time because the steppers, the AM/PM toggles and the two combos each
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
            <option value="">All statuses</option>
            <!-- A grouped option, not a status. "No fare yet" is the question a
                 merchant actually asks, and it spans Pending and Under Review —
                 the difference between them is which desk has it, which is our
                 problem and not theirs. Handled in clLoadEnquiries: the API
                 takes one status at a time, so this one is narrowed here. -->
            <option value="__awaiting" data-cl-chip-tone="warn">Awaiting quotation</option>
            ${CL_ENQUIRY_STATUSES.map(s =>
              `<option value="${s}" data-cl-chip-tone="${CL_STATUS_TONE[s] || ''}">${clEnquiryStatusLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <!-- CR-5: labelled "Search", not "Find". The behaviour is unchanged —
               it still narrows the rows already loaded — but "Find" was the only
               place in the product using that word for it. -->
          <label for="clEnqSearch">Search</label>
          <div style="display:flex; gap:6px; align-items:stretch;">
            <input type="search" id="clEnqSearch" placeholder="Reference, route or flight no."
                   style="flex:1 1 auto; min-width:0;">
            <!-- Copies what is in the box, not the results. A merchant looking a
                 reference up here is usually about to paste it into an email or
                 a chat with our desk, and selecting text inside a search input
                 on a phone is the fiddliest part of that. -->
            <button type="button" class="cl-btn cl-btn-sm" id="clEnqCopy"
                    title="Copy the search text" aria-label="Copy the search text"
                    style="flex:0 0 auto;">${clIco('copy', { size: 15 })}</button>
          </div>
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

  /* Feedback is the button itself, not a toast: Classic deliberately does not
     load components/toast.js (see classic-approvals.js), and a copy that gives
     no sign it worked is a copy the merchant does twice. */
  $('clEnqCopy').addEventListener('click', async () => {
    const btn = $('clEnqCopy');
    const box = $('clEnqSearch');
    const value = box.value.trim();

    const flash = (icon, label) => {
      btn.innerHTML = clIco(icon, { size: 15 });
      btn.title = label;
      btn.setAttribute('aria-label', label);
      setTimeout(() => {
        btn.innerHTML = clIco('copy', { size: 15 });
        btn.title = 'Copy the search text';
        btn.setAttribute('aria-label', 'Copy the search text');
      }, 1400);
    };

    if (!value) { box.focus(); return flash('alert', 'Type something to copy first'); }

    /* Two paths, and the fallback runs when the modern one REJECTS as well as
       when it is missing. navigator.clipboard needs a secure context, so it is
       absent over plain http on a LAN address — which is exactly how this
       portal is reached in testing — and even where it exists it rejects with
       NotAllowedError whenever the document is not focused. Treating a
       rejection as failure meant the button reported "could not copy" in the
       ordinary case. execCommand is deprecated but works in both. */
    const viaSelection = () => {
      box.select();
      const ok = document.execCommand('copy');
      box.setSelectionRange(value.length, value.length);
      return ok;
    };

    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          if (!viaSelection()) throw new Error('copy refused');
        }
      } else if (!viaSelection()) {
        throw new Error('copy refused');
      }
      flash('check', 'Copied');
    } catch {
      flash('alert', 'Could not copy — select the text and copy it manually');
    }
  });

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
      ${r.saved_amount != null ? `
        <div style="font-size:13px;margin-top:8px;font-weight:700;">
          You saved ${escapeHtml(moneyStr(r.saved_amount))}
          <span style="font-weight:600;opacity:.85;">against your client fare of
            ${escapeHtml(moneyStr(r.client_fare))}</span>
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

/* THE WIRE IS 24-HOUR; THE MERCHANT PORTAL IS 12-HOUR.
   ===========================================================================
   `schemas/enquiry.py` pins `preferred_time` to `^([01]\d|2[0-3]):[0-5]\d$`, so
   "14:30" is what is stored and what every other portal reads. That is not
   changing — this is a presentation layer over it, and the pair below is the
   only place the two clocks meet:

     cl24To12('14:30')       -> { hour: 2, minute: '30', meridiem: 'PM' }
     cl12To24(2, '30', 'PM') -> '14:30'
     clTimeLabel('14:30')    -> '02:30 PM'

   CR-5 had removed a 12-hour control and its comment argued the case: an hour
   1-12 beside an AM/PM toggle is "three decisions for one value" and "12" is
   ambiguous. The ambiguity was in the *old* control, which offered no minutes
   and put the meridiem on a toggle button. It is answered here by making all
   three parts explicit, labelled selects — and midnight/noon are the two cases
   the conversion below is written around, because they are the only ones where
   12-hour and 24-hour disagree about the leading digit. */

/* Minute granularity. Five minutes, not thirty: the business asked for a time
   the merchant chooses manually, and "09:35" is a real preferred departure. */
const CL_TIME_MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

function cl24To12(hhmm) {
  const [rawH, rawM] = String(hhmm || '').split(':');
  let h = Number(rawH);
  const m = Number(rawM);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  const meridiem = h < 12 ? 'AM' : 'PM';
  // 0 -> 12 AM, 12 -> 12 PM, 13 -> 1 PM. The modulo alone gives 0 for both
  // midnight and noon, which is not an hour anybody writes on a clock face.
  h = h % 12 || 12;
  return {
    hour: h,
    minute: String(Number.isFinite(m) ? m : 0).padStart(2, '0'),
    meridiem,
  };
}

function cl12To24(hour, minute, meridiem) {
  let h = Number(hour) % 12;           // 12 -> 0, which is right for both halves
  if (String(meridiem).toUpperCase() === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/* "02:30 PM". Survives a value the API never wrote — an unparseable string is
   returned as-is rather than rendered as "NaN:NaN AM", because a time nobody
   recognises is still more useful to the desk than a placeholder. */
function clTimeLabel(hhmm) {
  if (!hhmm) return null;
  const t = cl24To12(hhmm);
  if (!t) return hhmm;
  return `${String(t.hour).padStart(2, '0')}:${t.minute} ${t.meridiem}`;
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
    from: null, to: null,                 // { code, city, label } once picked
    airline: '',
    /* 24-hour "HH:MM" on the wire; the control that collects it is 12-hour. */
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
    <!-- GROUP TRIP IS DIRECT-ONLY, AND THAT IS A PRODUCT DECISION.
         A group fare is negotiated once the party is known, not at the
         quotation stage — so the enquiry form keeps the two options it has
         always had and only "Direct Booking Request" offers the third. The
         server accepts group_trip on both schemas (they share one TripType);
         the UI offering less than the API allows is the direction this form
         already takes with cabin class.
         (No backticks in this comment — it is inside a template literal.) -->
    <div class="cl-trip" id="clEnqTrip" role="radiogroup" aria-label="Trip type">
      <label class="cl-trip-opt checked" data-cl-trip="one_way">
        <input type="radio" name="clEnqTripType" value="one_way" checked>One Way
      </label>
      <label class="cl-trip-opt" data-cl-trip="round_trip">
        <input type="radio" name="clEnqTripType" value="round_trip">Round Trip
      </label>
      ${direct ? `<label class="cl-trip-opt" data-cl-trip="group_trip">
        <input type="radio" name="clEnqTripType" value="group_trip">Group Trip
      </label>` : ''}
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

    <div class="cl-form-legend">Airline Details</div>
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
        <label for="clEnqFlight">Airline Number<span class="cl-req">*</span></label>
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
        <label for="clEnqTimeHour">Preferred time<span class="cl-req">*</span></label>
        ${clTimeField('clEnqTime', '09:00', 'Preferred departure time')}
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
          <label for="clEnqReturnTimeHour">Return preferred time<span class="cl-req">*</span></label>
          ${clTimeField('clEnqReturnTime', '18:00', 'Return preferred time')}
        </div>
      </div>
    </div>

    <div class="cl-form-legend">Travellers &amp; class</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqPax" class="cl-label-sm">No. of Passengers<span class="cl-req">*</span></label>
        <input type="number" id="clEnqPax" min="1" max="99" value="1" inputmode="numeric">
        <small id="clEnqPaxHint">Type a total, or use the breakdown below — the two stay in step.</small>
      </div>
      <div class="cl-field">
        <label for="clEnqClass">Booking Class<span class="cl-req">*</span></label>
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

    <!-- CLIENT FARE (migration 0040). What the Data Operator has quoted their
         OWN customer. Optional, never used for settlement, and visible to the
         Admin answering the enquiry. Once we send a quotation the difference
         becomes the "You Saved" figure on this enquiry, on the booking, in
         Reports and on the Dashboard's Total Savings tile. -->
    <div class="cl-form-legend">Your customer&rsquo;s fare</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clEnqClientFare">Client Fare</label>
        <input type="number" id="clEnqClientFare" min="0" step="0.01"
               inputmode="decimal" placeholder="e.g. 20000">
        <small>What you have quoted your customer. We compare our fare against
               this and show you the saving. Leave blank if not applicable.</small>
      </div>
    </div>

    <div class="cl-msg" id="clEnqMsg"></div>`,
    `<button type="button" class="cl-btn" id="clEnqCancel">Cancel</button>
     <button type="button" class="cl-btn cl-btn-primary" id="clEnqSubmit">${
       direct ? 'Continue to travellers' : 'Send Enquiry'}</button>`);

  $('clModal').classList.add('cl-modal-form');
  clModalOnClose = () => { $('clModal').classList.remove('cl-modal-form'); clEnqForm = null; };

  clWireEnquiryForm();
  $('clEnqFrom').focus();
}

/* THE 12-HOUR TIME CONTROL — hour, minute, AM/PM.
   ===========================================================================
   Three real <select>s rather than an <input type="time">, for two reasons that
   both showed up in this portal before: the native picker renders in the
   *browser's* locale, so the same form reads 24-hour for a merchant whose
   machine is set that way, and on Firefox/desktop it is a text field that
   accepts typing the platform then has to police. Three selects cannot be
   typed wrong, read the same everywhere, and are reachable by Tab.

   `id` is the base — the parts are `<id>Hour`, `<id>Min`, `<id>Mer`, which is
   what clReadTimeField and clSetTimeField below look for. `value` is 24-hour,
   because that is what the caller has: a default, or a saved enquiry.

   A minute the stored value does not land on (a legacy "09:07", or a row some
   other portal wrote) is added to the list for that field only, so opening an
   old enquiry never silently rounds its time to something nobody chose. */
function clTimeField(id, value, label) {
  const t = cl24To12(value) || { hour: 9, minute: '00', meridiem: 'AM' };
  const minutes = CL_TIME_MINUTES.includes(t.minute)
    ? CL_TIME_MINUTES
    : [...CL_TIME_MINUTES, t.minute].sort();

  const hours = Array.from({ length: 12 }, (_, i) => i + 1).map(h =>
    `<option value="${h}"${h === t.hour ? ' selected' : ''}>${String(h).padStart(2, '0')}</option>`).join('');
  const mins = minutes.map(m =>
    `<option value="${m}"${m === t.minute ? ' selected' : ''}>${m}</option>`).join('');
  const mers = ['AM', 'PM'].map(x =>
    `<option value="${x}"${x === t.meridiem ? ' selected' : ''}>${x}</option>`).join('');

  return `<div class="cl-timesel" id="${id}">
    <select id="${id}Hour" class="cl-timesel-h" aria-label="${escapeHtml(label)} — hour">${hours}</select>
    <span class="cl-timesel-sep" aria-hidden="true">:</span>
    <select id="${id}Min" class="cl-timesel-m" aria-label="${escapeHtml(label)} — minute">${mins}</select>
    <select id="${id}Mer" class="cl-timesel-p" aria-label="${escapeHtml(label)} — AM or PM">${mers}</select>
  </div>`;
}

/* The three parts, back as the "HH:MM" the API stores. */
function clReadTimeField(id) {
  const h = $(`${id}Hour`), m = $(`${id}Min`), p = $(`${id}Mer`);
  if (!h || !m || !p) return null;
  return cl12To24(h.value, m.value, p.value);
}

/* Keeps the form's state object in step with whichever part was just changed,
   in one handler per field rather than three. */
function clBindTimeField(id, onChange) {
  ['Hour', 'Min', 'Mer'].forEach(part => {
    $(`${id}${part}`)?.addEventListener('change', () => onChange(clReadTimeField(id)));
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
  clCombo($('clEnqAirline'), $('clEnqAirlineList'), clAirlineOptions, picked => {
    clEnqForm.airline = picked ? picked.value : '';
  });

  /* ---- 12-hour time controls. `depTime` / `retTime` stay 24-hour "HH:MM" —
     the conversion happens in the control, not at submit, so there is exactly
     one place a wrong meridiem could come from. ---- */
  clBindTimeField('clEnqTime', v => { clEnqForm.depTime = v; });
  clBindTimeField('clEnqReturnTime', v => { clEnqForm.retTime = v; });

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

/* An optional money input. Returns null for blank/garbage so the field is
   omitted rather than sent as 0, and never returns a negative — the column has
   a CHECK constraint and a 422 on a typo is a worse experience than clamping. */
function clParseMoney(raw) {
  const t = String(raw ?? '').trim();
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
    returnTime = clReadTimeField('clEnqReturnTime') || f.retTime;
  }

  const payload = {
    trip_type: f.trip_type,
    origin: from.code, origin_city: from.city,
    destination: to.code, destination_city: to.city,
    airline,
    flight_number: flight,
    travel_date: date,
    /* Read from the control, with the form state as the fallback. Both are
       24-hour "HH:MM" and cannot disagree — the control's own change handler is
       what writes the state — but reading the live DOM means an autofilled or
       programmatically set value cannot be missed. */
    preferred_time: clReadTimeField('clEnqTime') || f.depTime,
    return_date: returnDate,
    return_preferred_time: returnTime,
    travel_class: travelClass,
    passenger_count: f.adults + f.children + f.infants,
    adults: f.adults, children: f.children, infants: f.infants,
    notes: ($('clEnqNotes').value || '').trim() || null,
    /* 0040. SENT AS null WHEN BLANK, NOT 0 — the column distinguishes "not
       recorded" from "quoted at zero", and a 0 here would put a zero-saving
       booking into the merchant's savings average. Parsed rather than passed
       through so an empty string never reaches a Decimal field. */
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
