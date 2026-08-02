/* Admin — Booking Operations (CR-2, over the M1/M2 backend)
   =========================================================
   The desk that works a booking *after* it is approved: who the merchant is
   sending where, with whom, the tickets that came back, and the two lifecycle
   moves that end the job.

   WHY THIS EXISTS NOW
   M1 and M2 shipped this entire backend — the queue, assignment, references,
   internal notes, ticket upload, merchant delivery — and no portal ever
   rendered any of it. CR-2 made that unavoidable: on the Classic Tours track
   there is no payment step, so "Manager Approved -> upload the tickets -> Ticket
   Issued" is the whole remaining workflow and it had no screen at all.

   TWO WORKFLOWS, ONE QUEUE
   A `classic_tours` booking never passes Payment Pending or Paid — the desk
   books it externally, attaches the files and marks it issued. A `standard`
   booking still waits for money. The row's own `workflow` field decides which
   next action is offered, rather than this file re-deriving the rule.

   WHAT THE WORK MODAL SHOWS
   The booking and passenger data exactly as the merchant submitted it and the
   Manager approved it, read from the same `GET /api/requests/{id}` payload this
   modal already loads — so there is one copy of a traveller's details and the
   Manager and the desk cannot disagree about them. It is deliberately the same
   set the Manager portal reviews, plus the fields only this desk needs.

   THE SIX SECTIONS, IN THIS ORDER
     1. Booking information   what the merchant asked for
     2. Passenger information as the merchant submitted it
     3. Quotation             the fare and remarks the merchant agreed to
     4. Airline references    EDITABLE — what the desk got back from the airline
     5. Issued ticket documents
     6. Internal notes        staff-only

   ONLY THE ASSIGNMENT FORM IS GONE (CR-2): the queue's own assignment filter
   and column already covered who is working what, and a second control for it
   inside the modal bought nothing. `POST .../assign` is still live and still
   covered by `tests/verify_m1.py`, so restoring it is a UI change and nothing
   else.

   THE AIRLINE-REFERENCES FORM IS THE POINT OF THIS SCREEN AND STAYS EDITABLE.
   The desk books the trip on the airline's own site and comes back here to key
   in the PNR, the ticket number and the airline's own reference. **These inputs
   are the only editable copy of those three values anywhere in the product** —
   every other surface that shows a PNR or a ticket number (merchant portal,
   Operations, partner history) renders it read-only. Without this form a booking
   would carry only the PNR `issue_ticket` generates for it, and the airline's
   real reference would never reach the merchant's paperwork. It was briefly
   removed and put back by request; the values are deliberately *not* also
   repeated read-only in section 1, because one dialog showing a field twice is
   a field someone edits in one place and reads from the other.

   ENDPOINTS THIS FILE CALLS (all pre-existing)
     GET    /api/admin/bookings/queue                  the list
     GET    /api/admin/bookings/queue/counts           tab badges
     GET    /api/requests/{id}                         the booking, for the modal
     PUT    /api/admin/bookings/{id}/references        PNR / ticket no / airline ref
     GET/POST /api/admin/bookings/{id}/notes           internal notes (staff-only)
     POST   /api/requests/{id}/documents               attach a ticket file
     GET    /api/requests/{id}/documents               what is attached
     POST   /api/admin/requests/{id}/issue-ticket      mark Ticket Issued
     POST   /api/admin/requests/{id}/complete          mark Completed

   LIVE, BUT NO LONGER CALLED FROM HERE — its form was removed, not its
   endpoint (see above):
     POST   /api/admin/bookings/{id}/assign            operator assignment

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDate, fmtDateTime, rowsSkeleton, loadedSections) plus the
   shared toast/confirmDialog components. Nothing here restates them. */

const OPS_TABS = [
  { stage: 'approved', label: 'To book' },
  { stage: 'payment_pending', label: 'Awaiting payment' },
  { stage: 'paid', label: 'Paid' },
  { stage: 'ticket_issued', label: 'Ticket issued' },
];

const OPS_BADGE = {
  approved: 'pending', payment_pending: 'pending',
  paid: 'confirmed', ticket_issued: 'confirmed', completed: 'confirmed',
};

let opsStage = 'approved';
let opsPage = 1;
let opsSearch = '';
let opsAssign = '';
let opsSearchTimer = null;
let opsFiltersWired = false;
let opsCurrent = null;
/* Returned by trapFocus() while the work modal is open. */
let opsReleaseFocus = null;

function opsSelf() {
  const raw = localStorage.getItem('jwt_user_id');
  return raw ? Number(raw) : null;
}

function opsErr(err, fallback) {
  return err.response?.data?.detail || fallback || 'Something went wrong.';
}

function opsAge(hours) {
  if (hours == null) return '—';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/* 'non_veg' -> 'Non Veg'. The API sends raw enum values for the small passenger
   fields — gender, passenger type, seat and meal preference — and a ready-made
   label only for status, so these are title-cased here rather than printed at a
   desk in their database spelling. */
function opsLabel(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const opsDash = v => (v === null || v === undefined || v === '' ? '—' : v);

/* The merchant's preferred departure / return time, as it was entered.
   The API stores "HH:MM" on a 24-hour clock and the merchant portal now both
   collects and displays it that way, so it is printed unconverted: this field
   is a request the merchant made, and the desk reading a different clock from
   the person who filled the form in is how "09:30" becomes an evening flight.
   Normalised to two digits so a column of times lines up. */
/* 12-hour, matching admTimeLabel (Bookings) and enqTime (Ticket Enquiries) —
   this desk was the only one of the three still printing "19:45" for a merchant
   who chose 7:45 PM. The wire format is unchanged 24-hour "HH:MM"; this reads
   it, it does not write it. */
function opsTime(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return String(hhmm);
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${
    String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/* ------------------------------------------------------------------ list */

function opsRenderTabs(counts) {
  document.getElementById('opsTabs').innerHTML = OPS_TABS.map(t => {
    const n = counts ? Number(counts[t.stage] || 0) : null;
    return `<button type="button" class="ops-tab${t.stage === opsStage ? ' active' : ''}"
              role="tab" aria-selected="${t.stage === opsStage}" data-ops-tab="${t.stage}">
              ${escapeHtml(t.label)}${n ? `<span class="ops-tab-count">${n}</span>` : ''}
            </button>`;
  }).join('');
  document.querySelectorAll('[data-ops-tab]').forEach(b => {
    b.addEventListener('click', () => {
      opsStage = b.dataset.opsTab;
      opsPage = 1;
      loadBookingOps();
    });
  });
}

async function opsLoadCounts() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings/queue/counts`, { headers: authHeaders() });
    opsRenderTabs(data);
    const badge = document.getElementById('opsNavBadge');
    if (badge) {
      /* The badge counts what nobody is working — the number a desk lead acts
         on. "Total in the queue" would be permanently large and permanently
         ignored. */
      const n = Number(data.unassigned || 0);
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = !n;
    }
  } catch { /* a failed badge must never block the queue */ }
}

function opsWireFilters() {
  if (opsFiltersWired) return;
  opsFiltersWired = true;
  document.getElementById('opsRefreshBtn').addEventListener('click', () => loadBookingOps());
  document.getElementById('opsSearch').addEventListener('input', e => {
    clearTimeout(opsSearchTimer);
    const v = e.target.value;
    opsSearchTimer = setTimeout(() => { opsSearch = v.trim(); opsPage = 1; loadBookingOps(); }, 250);
  });
  document.getElementById('opsAssignFilter').addEventListener('change', e => {
    opsAssign = e.target.value;
    opsPage = 1;
    loadBookingOps();
  });
}

async function loadBookingOps() {
  opsWireFilters();
  opsRenderTabs();
  opsLoadCounts();

  const body = document.querySelector('#opsTable tbody');
  body.innerHTML = `<tr><td colspan="8">${rowsSkeleton(4)}</td></tr>`;

  const params = new URLSearchParams({ stage: opsStage, page: opsPage, page_size: '20' });
  if (opsSearch) params.set('search', opsSearch);
  if (opsAssign === 'unassigned') params.set('unassigned', 'true');
  if (opsAssign === 'mine' && opsSelf()) params.set('assigned_to', String(opsSelf()));

  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings/queue?${params}`, { headers: authHeaders() });
    const rows = data.items || [];
    body.innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td>
          <div><strong>${escapeHtml(r.request_number)}</strong></div>
          <div style="font-size:11.5px;color:var(--text-muted);">
            ${escapeHtml(r.booking_reference || '')}${r.pnr ? ` · PNR ${escapeHtml(r.pnr)}` : ''}
          </div>
          ${r.workflow === 'classic_tours'
            ? '<span class="badge read" style="margin-top:4px;">Classic Tours · no payment</span>' : ''}
        </td>
        <td>${escapeHtml(r.merchant_name || '—')}</td>
        <td>${r.passengers}${r.lead_passenger ? `<div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(r.lead_passenger)}</div>` : ''}</td>
        <td>${escapeHtml(fmtDate(r.travel_date))}</td>
        <td><span class="badge ${OPS_BADGE[r.status] || ''}">${escapeHtml(r.status_label)}</span>
          ${r.has_ticket_documents ? '<div style="font-size:11.5px;color:var(--text-muted);">tickets attached</div>' : ''}</td>
        <td>${r.assigned_to ? escapeHtml(r.assigned_to) : '<span style="color:var(--text-muted);">Unassigned</span>'}</td>
        <td>${escapeHtml(opsAge(r.age_hours))}</td>
        <td><button type="button" class="btn btn-navy btn-sm" data-ops-open="${r.id}">Work</button></td>
      </tr>`).join('')
      : `<tr><td colspan="8" class="empty-state">Nothing at this stage.</td></tr>`;

    body.querySelectorAll('[data-ops-open]').forEach(b => {
      b.addEventListener('click', () => opsOpenWork(Number(b.dataset.opsOpen)));
    });
    opsRenderPagination(data.page || opsPage, data.total_pages || 1, data.total || rows.length);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state">${escapeHtml(opsErr(err, 'Could not load the queue.'))}</td></tr>`;
  }
}

function opsRenderPagination(page, totalPages, total) {
  const el = document.getElementById('opsPagination');
  if (totalPages <= 1) { el.innerHTML = `<span>${total} booking${total === 1 ? '' : 's'}</span>`; return; }
  el.innerHTML = `
    <span>${total} bookings · page ${page} of ${totalPages}</span>
    <button type="button" class="btn btn-ghost btn-sm" id="opsPrev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
    <button type="button" class="btn btn-ghost btn-sm" id="opsNext" ${page >= totalPages ? 'disabled' : ''}>Next</button>`;
  document.getElementById('opsPrev')?.addEventListener('click', () => { opsPage = page - 1; loadBookingOps(); });
  document.getElementById('opsNext')?.addEventListener('click', () => { opsPage = page + 1; loadBookingOps(); });
}

/* ------------------------------------------------------------ work modal */

function opsCloseWork() {
  document.getElementById('opsWorkOverlay').classList.remove('open');
  document.getElementById('opsWorkBody').innerHTML = '';
  opsCurrent = null;
  /* Back to the Work button that opened it. */
  opsReleaseFocus?.();
  opsReleaseFocus = null;
}

async function opsOpenWork(id) {
  const overlay = document.getElementById('opsWorkOverlay');
  document.getElementById('opsWorkBody').innerHTML = `<div class="empty-state" style="padding:40px;">Loading booking…</div>`;
  overlay.classList.add('open');
  /* Trapped from the moment it opens, and only once: opsOpenWork is called
     again after every save to re-render, and re-trapping would overwrite the
     stored "return focus here" with a control inside the dialog. */
  if (!opsReleaseFocus) opsReleaseFocus = trapFocus(document.getElementById('opsWorkBody'));

  try {
    /* Three reads, in parallel — the detail, the paperwork and the desk's
       notes. They are independent, so serialising them would just be three
       round trips of latency on every open. The detail carries the booking and
       its passengers, which is why the read-only information below needs no
       call of its own. */
    /* 0039 adds a fourth: the providers this ticket may be booked through, with
       their people already attached, so choosing a provider needs no second
       round trip. `.catch` for the same reason the other two have one — a desk
       that cannot reach the provider list must still be able to read the
       booking, and the field below degrades to a note rather than a broken
       control. */
    const [detail, docs, notes, providers] = await Promise.all([
      axios.get(`${API_BASE}/api/requests/${id}`, { headers: authHeaders() }).then(r => r.data),
      axios.get(`${API_BASE}/api/requests/${id}/documents`, { headers: authHeaders() }).then(r => r.data).catch(() => []),
      axios.get(`${API_BASE}/api/admin/bookings/${id}/notes`, { headers: authHeaders() }).then(r => r.data).catch(() => []),
      axios.get(`${API_BASE}/api/admin/providers/options`, { headers: authHeaders() })
        .then(r => r.data.items).catch(() => null),
    ]);
    opsCurrent = { id, detail, docs, notes, providers };
    opsRenderWork();
  } catch (err) {
    document.getElementById('opsWorkBody').innerHTML = `
      <div class="ops-modal-head"><h2 id="opsWorkTitle">Booking</h2>
        <button type="button" class="ops-modal-close" id="opsWorkClose" aria-label="Close" data-focus-trap-skip>&times;</button></div>
      <div class="msg error" style="padding:0 30px 30px;">${escapeHtml(opsErr(err, 'Could not load this booking.'))}</div>`;
    document.getElementById('opsWorkClose').addEventListener('click', opsCloseWork);
  }
}

/* One traveller, exactly as the merchant typed them — the same row the Manager
   approved, off the same payload, so there is no second copy to drift.
   A card rather than a table column: thirteen fields across a table would need
   a horizontal scrollbar at every width, and the desk reads one passenger at a
   time when it books them. */
function opsPassengerCard(p, i) {
  const item = (label, value) => `
    <div class="ops-pax-item"><span class="ops-pax-label">${label}</span>
      <span class="ops-pax-value">${value}</span></div>`;

  /* Every portal that creates a traveller posts `special_services: []`, so
     today this renders on nobody. It is here because that array is the only
     per-passenger request the schema carries, and a screen promising complete
     passenger information must not be the reason one goes unseen. Party-wide
     special requests are a booking field and are shown below the list. */
  const services = (p.special_services || [])
    .map(s => [s.label || s.code, s.category].filter(Boolean).join(' · '))
    .filter(Boolean);

  return `
    <article class="ops-pax">
      <header class="ops-pax-head">
        <span class="ops-pax-num">${i + 1}</span>
        <span class="ops-pax-name">${escapeHtml(
          [p.title, p.first_name, p.last_name].filter(Boolean).join(' ') || `Passenger ${i + 1}`)}</span>
        <span class="badge read">${escapeHtml(opsLabel(p.passenger_type || 'adult'))}</span>
        ${p.is_cancelled ? '<span class="badge cancelled">Cancelled</span>' : ''}
      </header>
      <div class="ops-pax-grid">
        ${item('Passenger type', escapeHtml(opsLabel(p.passenger_type || 'adult')))}
        ${item('Title', escapeHtml(opsDash(p.title)))}
        ${item('First name', escapeHtml(opsDash(p.first_name)))}
        ${item('Last name', escapeHtml(opsDash(p.last_name)))}
        ${item('Gender', escapeHtml(p.gender ? opsLabel(p.gender) : '—'))}
        ${item('Date of birth', escapeHtml(fmtDate(p.dob)))}
        ${item('Nationality', escapeHtml(opsDash(p.nationality)))}
        ${item('Passport number', escapeHtml(opsDash(p.passport_number)))}
        ${item('Passport expiry', escapeHtml(fmtDate(p.passport_expiry)))}
        ${item('Passport issue country', escapeHtml(opsDash(p.passport_issue_country)))}
        ${item('Passport issue date', escapeHtml(fmtDate(p.passport_issue_date)))}
        ${item('Meal preference', escapeHtml(p.meal_preference ? opsLabel(p.meal_preference) : '—'))}
        ${item('Seat preference', escapeHtml(p.seat_preference ? opsLabel(p.seat_preference) : '—'))}
      </div>
      ${services.length
        ? `<div class="ops-pax-note"><strong>Special requests</strong>${escapeHtml(services.join(', '))}</div>`
        : ''}
    </article>`;
}

function opsRenderWork() {
  const { id, detail, docs, notes, providers } = opsCurrent;
  const r = detail.request;
  const d = r.details || {};
  const contact = d.contact || {};
  const passengers = r.passengers || [];
  const roundTrip = d.trip_type === 'round_trip';
  const classic = r.workflow === 'classic_tours';
  const tickets = (docs || []).filter(x => x.doc_type === 'ticket' || x.doc_type === 'other');
  const canIssue = r.status === (classic ? 'approved' : 'paid');
  /* CR-4b. An enquiry-led booking is created at 0 and no step before this one
     sets a fare — the desk issuing the ticket is the first actor who knows what
     was paid. The server requires it in exactly this case and 400s without it,
     so the field appears in exactly this case too: the UI must not offer an
     action the server will refuse. A booking that already carries an amount
     (every catalog-led one) never sees this. */
  const needsFare = classic && Number(r.total_amount || 0) <= 0;
  const canComplete = r.status === 'ticket_issued';

  const cell = (label, value) => `
    <div class="detail-item"><span class="detail-label">${label}</span>
      <span class="detail-value">${value}</span></div>`;

  /* An enquiry-led booking carries the cabin the merchant asked for as
     `travel_class`; a catalog-led one inherits the inventory row's
     `cabin_class`. This queue holds both tracks, so reading only the first
     would print "—" over a class the booking plainly has. */
  const travelClass = opsLabel(d.travel_class || d.cabin_class) || '—';

  document.getElementById('opsWorkBody').innerHTML = `
    <div class="ops-modal-head">
      <h2 id="opsWorkTitle">${escapeHtml(r.request_number)}
        <span class="badge ${OPS_BADGE[r.status] || ''}">${escapeHtml(r.status_label)}</span>
        ${classic ? '<span class="badge read">Classic Tours</span>' : ''}
      </h2>
      <button type="button" class="ops-modal-close" id="opsWorkClose" aria-label="Close" data-focus-trap-skip>&times;</button>
    </div>

    <div class="ops-modal-body">
      ${classic ? `<div class="ops-hint">
        Approved by a manager. Book this on the trusted booking site, attach the issued
        ticket documents below, then mark it <strong>Ticket Issued</strong> — the merchant
        downloads them from that status. There is no payment step on this workflow.
      </div>` : ''}

      <div class="ops-section ops-section-first">
        <h3>Booking information
          <span class="ops-staff-note">as submitted by the merchant</span></h3>
        <div class="detail-grid">
          ${cell('Booking reference', escapeHtml(opsDash(r.booking_reference)))}
          <!-- Load-bearing for this desk: a direct booking carries no
               quotation, so it is this desk that names the fare at issuance. -->
          ${cell('Enquiry reference', escapeHtml(
            d.enquiry_reference || (d.direct_booking ? 'Direct booking — not quoted' : '—')))}
          ${cell('Merchant', escapeHtml(opsDash(r.merchant_name)))}
          ${cell('Merchant user', escapeHtml(opsDash(r.raised_by)))}
          ${cell('Submitted', escapeHtml(fmtDateTime(r.created_at)))}
          ${cell('Journey type', roundTrip ? 'Round trip' : 'One way')}
          ${cell('Route', d.international ? 'International' : 'Domestic')}
          ${cell('From', escapeHtml([d.origin_city, d.origin].filter(Boolean).join(' · ') || '—'))}
          ${cell('To', escapeHtml([d.destination_city, d.destination].filter(Boolean).join(' · ') || '—'))}
          ${cell('Airline', escapeHtml(opsDash(d.airline)))}
          ${cell('Flight number', escapeHtml(opsDash(d.flight_number)))}
          ${cell('Departure', escapeHtml(fmtDate(r.travel_date)))}
          ${cell('Preferred departure time', escapeHtml(opsTime(d.preferred_time)))}
          ${roundTrip ? cell('Return', escapeHtml(fmtDate(r.return_date))) : ''}
          ${roundTrip ? cell('Preferred return time', escapeHtml(opsTime(d.return_preferred_time))) : ''}
          ${cell('Class', escapeHtml(travelClass))}
          ${cell('Total passengers', String(passengers.length))}
          ${/* The desk is about to spend the platform's money against this
                figure, so it belongs on the screen where that happens. It was
                absent entirely: the only money this modal ever showed was the
                fare input, which a quoted booking no longer renders. */''}
          ${cell('Booking amount', moneyIsPositive(r.total_amount)
            ? `<strong>${escapeHtml(moneyStr(r.total_amount))}</strong>${
                classic ? ' <span class="ops-sub">settled from the wallet at ticketing</span>' : ''}`
            : '<span class="ops-sub">Not priced yet</span>')}
          ${/* PNR, ticket number and airline reference are NOT repeated here.
                They are editable in Airline references below, and a value shown
                twice in one dialog is a value someone will eventually edit in
                one place and read from the other. */''}
          ${cell('Contact name', escapeHtml(opsDash(contact.name)))}
          ${cell('Contact email', escapeHtml(opsDash(contact.email)))}
          ${cell('Contact phone', escapeHtml(opsDash(contact.phone)))}
          ${cell('Alternate phone', escapeHtml(opsDash(contact.alternate_phone)))}
        </div>
      </div>

      <div class="ops-section">
        ${/* Not "…and approved by the Manager": this queue also holds catalog-led
             bookings, which an Admin approves. True of both tracks or not said. */''}
        <h3>Passenger information
          <span class="ops-staff-note">as submitted by the merchant</span></h3>
        ${passengers.length
          ? passengers.map(opsPassengerCard).join('')
          : '<p class="ops-sub">No passengers recorded on this booking.</p>'}
        ${d.special_requests
          ? `<div class="detail-note"><strong>Special requests — whole party</strong>
               <p>${escapeHtml(d.special_requests)}</p></div>` : ''}
        ${r.remarks
          ? `<div class="detail-note"><strong>Merchant remarks</strong>
               <p>${escapeHtml(r.remarks)}</p></div>` : ''}
      </div>

      ${/* 3. QUOTATION — its own section rather than a footnote under Booking
            information. It is what the merchant agreed to, in the merchant's own
            words, and the desk about to buy the ticket is the last person who
            can notice that the quote and the itinerary disagree. Absent on a
            catalog-led booking and on anything raised before quotations existed,
            which is stated rather than left as an empty panel. */''}
      <div class="ops-section">
        <h3>Quotation
          <span class="ops-staff-note">what the merchant was quoted</span></h3>
        ${d.quoted_fare != null ? `
          <div class="detail-grid">
            ${cell('Total fare', `<strong>${escapeHtml(moneyStr(d.quoted_fare))}</strong>`)}
            ${cell('Booking raised at', moneyIsPositive(r.total_amount)
              ? escapeHtml(moneyStr(r.total_amount)) : '<span class="ops-sub">—</span>')}
          </div>
          ${d.quotation_remarks
            ? `<div class="detail-note"><strong>Remarks sent to the merchant</strong>
                 <p style="white-space:pre-wrap;">${escapeHtml(d.quotation_remarks)}</p></div>`
            : '<p class="ops-sub">No remarks were recorded with this quotation.</p>'}`
        : `<p class="ops-sub">${classic
            ? 'This booking was raised before enquiries carried a quotation, so no fare was quoted to the merchant.'
            : 'Catalog-led booking — priced from the inventory row, not from a quotation.'}</p>`}
      </div>

      ${/* 4. AIRLINE REFERENCES. The desk books the trip on the airline's own
            site and comes back here to key in what it got. These are the only
            editable copy of these three values anywhere in the product — every
            other surface that shows a PNR or ticket number renders it read-only
            — so this form is what puts the airline's own reference on the
            merchant's paperwork. Every stage this queue shows is inside the
            server's REFERENCE_STAGES, so the form is never offered where it
            would be refused. */''}
      <div class="ops-section">
        <h3>Airline references
          <span class="ops-staff-note">after booking with the airline</span></h3>
        <p class="ops-sub">Blank fields are left as they are — the server writes only what you send,
          so correcting the PNR cannot wipe the ticket number.</p>
        <div class="ops-grid-3">
          <div class="form-field"><label for="opsPnr">Airline PNR</label>
            <input id="opsPnr" value="${escapeHtml(r.pnr || '')}" placeholder="H4X9PQ"></div>
          <div class="form-field"><label for="opsTicketNo">Ticket number</label>
            <input id="opsTicketNo" value="${escapeHtml(r.ticket_number || '')}"></div>
          <div class="form-field"><label for="opsAirlineRef">Airline reference <span class="ops-sub">(if applicable)</span></label>
            <input id="opsAirlineRef" value="${escapeHtml(d.airline_reference || '')}"></div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="opsRefsBtn">Save references</button>
        ${r.provider_name ? `<p class="ops-sub" style="margin-top:10px;">
          Bought from <b>${escapeHtml(r.provider_name)}</b>${
            r.provider_user_name ? ` via ${escapeHtml(r.provider_user_name)}` : ''}.
          Recorded when the ticket was issued and not editable here.</p>` : ''}
      </div>

      <div class="ops-section">
        <h3>Issued ticket documents</h3>
        <p class="ops-sub">PDF, JPEG, PNG or WebP. Attach as many as the airline sent — the
          merchant downloads all of them.</p>
        <div class="ops-row">
          <input type="file" id="opsTicketFiles" multiple accept="application/pdf,image/jpeg,image/png,image/webp">
          <button type="button" class="btn btn-navy btn-sm" id="opsUploadBtn">Upload</button>
        </div>
        <div class="msg" id="opsUploadMsg" aria-live="polite"></div>
        <div class="table-wrap" style="margin-top:12px;"><table><thead><tr>
          <th>File</th><th>Type</th><th>Size</th><th>Uploaded</th><th></th>
        </tr></thead><tbody>
          ${tickets.length ? tickets.map(t => `
            <tr>
              <td>${escapeHtml(t.original_filename)}</td>
              <td>${escapeHtml(t.doc_type)}</td>
              <td>${Math.max(1, Math.round((t.size_bytes || 0) / 1024))} KB</td>
              <td>${escapeHtml(fmtDateTime(t.created_at))}</td>
              <td><button type="button" class="btn btn-ghost btn-sm" data-ops-deldoc="${t.id}">Remove</button></td>
            </tr>`).join('')
            : '<tr><td colspan="5" class="empty-state">No tickets attached yet.</td></tr>'}
        </tbody></table></div>
      </div>

      <div class="ops-section">
        <h3>Internal notes <span class="ops-staff-only">staff only — never shown to the merchant</span></h3>
        <div class="ops-row">
          <input type="text" id="opsNoteBody" placeholder="What happened on this booking?">
          <button type="button" class="btn btn-ghost btn-sm" id="opsNoteBtn">Add note</button>
        </div>
        <div id="opsNotesList" style="margin-top:12px;">
          ${(notes || []).length ? notes.map(n => `
            <div class="ops-note">
              <div class="ops-note-body">${escapeHtml(n.body)}</div>
              <div class="ops-note-meta">${escapeHtml(n.author_name || 'Staff')} · ${escapeHtml(fmtDateTime(n.created_at))}</div>
            </div>`).join('')
            : '<p class="ops-sub">No notes yet.</p>'}
        </div>
      </div>

      <div class="ops-actions">
        ${canIssue && needsFare ? `
          <div class="ops-fare">
            <label for="opsFareInput">Fare paid to the airline (₹)</label>
            <input type="number" id="opsFareInput" min="0.01" step="0.01" inputmode="decimal"
                   placeholder="0.00" aria-describedby="opsFareHelp">
            <p class="ops-sub" id="opsFareHelp">
              This becomes the booking amount and is debited from the merchant's wallet
              when the ticket is issued.
            </p>
          </div>` : ''}
        ${canIssue ? opsProviderFields(providers) : ''}
        ${canIssue ? `<button type="button" class="btn btn-coral" id="opsIssueBtn">Mark Ticket Issued</button>` : ''}
        ${canComplete ? `<button type="button" class="btn btn-coral" id="opsCompleteBtn">Mark Completed</button>` : ''}
        ${!canIssue && !canComplete
          ? `<span class="ops-sub">${classic
              ? 'Nothing to do here until a manager approves this booking.'
              : 'This booking is waiting on payment before a ticket can be issued.'}</span>`
          : ''}
        <div class="msg" id="opsActionMsg" aria-live="polite"></div>
      </div>
    </div>`;

  document.getElementById('opsWorkClose').addEventListener('click', opsCloseWork);

  /* The body was just replaced, so focus has fallen to <body>. Put it back on
     the dialog itself rather than on its first control: that control is the PNR
     box, and landing there would step a keyboard or screen-reader user straight
     past the booking, passenger and quotation details this modal opens to show —
     the very details they need before they can fill it in. The trap is still in
     place on the container, which does not change. */
  const dialog = document.getElementById('opsWorkBody');
  dialog.setAttribute('tabindex', '-1');
  dialog.focus();

  document.getElementById('opsRefsBtn').addEventListener('click', () => opsSaveReferences(id));
  document.getElementById('opsUploadBtn').addEventListener('click', () => opsUploadTickets(id));
  document.getElementById('opsNoteBtn').addEventListener('click', () => opsAddNote(id));
  opsWireProviderFields();
  document.getElementById('opsIssueBtn')?.addEventListener('click', () => opsLifecycle(id, 'issue-ticket'));
  document.getElementById('opsCompleteBtn')?.addEventListener('click', () => opsLifecycle(id, 'complete'));
  document.querySelectorAll('[data-ops-deldoc]').forEach(b => {
    b.addEventListener('click', () => opsDeleteDoc(id, Number(b.dataset.opsDeldoc)));
  });
}

/* A field left blank is sent as null, not as "", because the server treats null
   as "leave this one alone" and "" on the airline reference as "clear it". A
   desk correcting one box must not silently blank the other two. */
async function opsSaveReferences(id) {
  const payload = {
    pnr: document.getElementById('opsPnr').value.trim() || null,
    ticket_number: document.getElementById('opsTicketNo').value.trim() || null,
    airline_reference: document.getElementById('opsAirlineRef').value.trim() || null,
  };
  if (!payload.pnr && !payload.ticket_number && !payload.airline_reference) {
    showToast('Enter a PNR, ticket number or airline reference first.', true);
    return;
  }
  try {
    await axios.put(`${API_BASE}/api/admin/bookings/${id}/references`, payload, { headers: authHeaders() });
    showToast('References saved.');
    opsOpenWork(id);
    loadBookingOps();
  } catch (err) {
    showToast(opsErr(err, 'Could not save the references.'), true);
  }
}

async function opsUploadTickets(id) {
  const input = document.getElementById('opsTicketFiles');
  const msg = document.getElementById('opsUploadMsg');
  const files = [...(input.files || [])];
  if (!files.length) {
    msg.className = 'msg error';
    msg.textContent = 'Choose at least one file.';
    return;
  }

  const btn = document.getElementById('opsUploadBtn');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;

  /* One request per file, sequentially. The endpoint takes a single file, and
     firing them in parallel would race the same booking's document list — a
     desk uploading four e-tickets wants all four, not whichever three won. */
  const failed = [];
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    form.append('doc_type', 'ticket');
    try {
      await axios.post(`${API_BASE}/api/requests/${id}/documents`, form, { headers: authHeaders() });
    } catch (err) {
      failed.push(`${file.name}: ${opsErr(err, 'upload failed')}`);
    }
  }

  btn.disabled = false;
  input.value = '';
  if (failed.length) {
    msg.className = 'msg error';
    msg.textContent = failed.join(' · ');
  } else {
    showToast(`${files.length} ticket document${files.length === 1 ? '' : 's'} attached.`);
  }
  opsOpenWork(id);
  loadBookingOps();
}

async function opsDeleteDoc(id, documentId) {
  if (!await confirmDialog({
    title: 'Remove this ticket?',
    message: 'The merchant will no longer be able to download it.',
    confirmText: 'Remove', danger: true,
  })) return;
  try {
    await axios.delete(`${API_BASE}/api/documents/${documentId}`, { headers: authHeaders() });
    showToast('Ticket removed.');
    opsOpenWork(id);
    loadBookingOps();
  } catch (err) {
    showToast(opsErr(err, 'Could not remove that file.'), true);
  }
}

async function opsAddNote(id) {
  const input = document.getElementById('opsNoteBody');
  const body = input.value.trim();
  if (!body) return;
  try {
    await axios.post(`${API_BASE}/api/admin/bookings/${id}/notes`, { body }, { headers: authHeaders() });
    input.value = '';
    opsOpenWork(id);
  } catch (err) {
    showToast(opsErr(err, 'Could not add that note.'), true);
  }
}

/* 0039 — WHO THE TICKET IS BEING BOUGHT FROM.
   ---------------------------------------------------------------------------
   Two dependent dropdowns, and both are REQUIRED before this screen will issue.
   The API accepts them as optional so every pre-0039 caller keeps working (see
   IssueTicketRequest); the desk is where the business rule "always record the
   provider" is actually enforced, because the desk is who knows the answer.

   `providers === null` means the lookup failed rather than "there are none" —
   the two need different wording, because one is a broken request and the other
   is an empty Provider Management screen. Neither offers a control that cannot
   be filled in. */
function opsProviderFields(providers) {
  if (providers === null) {
    return `<div class="ops-fare">
      <div class="msg error" style="margin:0;">Could not load the provider list, so this ticket
      cannot be attributed yet. Reopen this booking to try again.</div>
    </div>`;
  }
  if (!providers.length) {
    return `<div class="ops-fare">
      <div class="msg info" style="margin:0;">No active providers are set up yet. Add the supplier
      you booked through in <b>Provider Management</b>, then issue this ticket.</div>
    </div>`;
  }

  return `<div class="ops-fare">
    <label for="opsProviderSelect">Provider</label>
    <select id="opsProviderSelect" aria-describedby="opsProviderHelp">
      <option value="">— Select the supplier —</option>
      ${providers.map(p => `<option value="${p.id}">${escapeHtml(p.provider_name)} (${escapeHtml(p.provider_code)})</option>`).join('')}
    </select>
    <p class="ops-sub" id="opsProviderHelp">Who this ticket was bought from.</p>

    <label for="opsProviderUserSelect" style="margin-top:10px;display:block;">Provider User</label>
    <select id="opsProviderUserSelect" disabled aria-describedby="opsProviderUserHelp">
      <option value="">— Choose a provider first —</option>
    </select>
    <p class="ops-sub" id="opsProviderUserHelp">The person there who made the booking.</p>
  </div>`;
}

/* The dependent half. Repopulated from the provider's own `users`, which came
   down with the options call — so switching provider cannot leave a person from
   the previous one selected, which is exactly what the server would refuse. */
function opsWireProviderFields() {
  const provider = document.getElementById('opsProviderSelect');
  const person = document.getElementById('opsProviderUserSelect');
  if (!provider || !person) return;

  provider.addEventListener('change', () => {
    const chosen = (opsCurrent?.providers || []).find(p => String(p.id) === provider.value);
    if (!chosen) {
      person.innerHTML = '<option value="">— Choose a provider first —</option>';
      person.disabled = true;
      return;
    }
    person.disabled = !chosen.users.length;
    person.innerHTML = chosen.users.length
      ? '<option value="">— Select the person —</option>'
        + chosen.users.map(u => `<option value="${u.id}">${escapeHtml(u.user_name)}</option>`).join('')
      : '<option value="">No active people listed for this provider</option>';
  });
}

async function opsLifecycle(id, action) {
  const msg = document.getElementById('opsActionMsg');
  const fareInput = document.getElementById('opsFareInput');
  const body = {};

  if (action === 'issue-ticket' && fareInput) {
    const fare = Number(fareInput.value);
    if (!(fare > 0)) {
      msg.className = 'msg error';
      msg.textContent = 'Enter the fare paid to the airline — it is what the merchant is billed.';
      fareInput.focus();
      return;
    }
    /* Sent as typed, not as a Number: the schema is Decimal and M4's rule is
       that money never becomes a float on its way to the server. */
    body.fare_amount = fareInput.value.trim();
  }

  /* 0039 — both required here, whatever the API will tolerate. Checked before
     the confirmation rather than after it, so an operator is not asked to
     confirm an action that is about to be refused. */
  if (action === 'issue-ticket') {
    const providerSelect = document.getElementById('opsProviderSelect');
    const personSelect = document.getElementById('opsProviderUserSelect');
    if (!providerSelect) {
      msg.className = 'msg error';
      msg.textContent = 'A provider must be recorded before a ticket can be issued. '
        + 'Add one in Provider Management, then reopen this booking.';
      return;
    }
    if (!providerSelect.value) {
      msg.className = 'msg error';
      msg.textContent = 'Choose the provider this ticket was bought from.';
      providerSelect.focus();
      return;
    }
    if (!personSelect?.value) {
      msg.className = 'msg error';
      msg.textContent = 'Choose the person at that provider who made the booking.';
      personSelect?.focus();
      return;
    }
    body.provider_id = Number(providerSelect.value);
    body.provider_user_id = Number(personSelect.value);
  }

  /* CR-5. The fare used to be typed here on every Classic booking, so naming it
     in this confirmation only needed `body.fare_amount`. A quoted booking
     already carries its amount, the field does not render, and the operator was
     then told nothing about the debit they were about to trigger — on the one
     screen where the platform's money actually moves. The amount comes off the
     booking in that case; `moneyStr`, because it is a decimal string. */
  const req = opsCurrent?.detail?.request || {};
  const walletBilled = req.workflow === 'classic_tours';
  const debit = body.fare_amount
    ? `₹${body.fare_amount}`
    : (walletBilled && moneyIsPositive(req.total_amount) ? moneyStr(req.total_amount) : null);

  const label = action === 'issue-ticket' ? 'Mark this booking as Ticket Issued?' : 'Mark this booking Completed?';
  const detail = action === 'issue-ticket'
    ? (debit
        ? `The merchant is notified, can download the attached ticket documents, and its wallet is debited ${debit}.`
        : 'The merchant is notified and can download the attached ticket documents.')
    : 'This closes the booking.';
  if (!await confirmDialog({ title: label, message: detail, confirmText: 'Confirm' })) return;

  msg.className = 'msg';
  msg.textContent = 'Working…';
  try {
    await axios.post(`${API_BASE}/api/admin/requests/${id}/${action}`, body, { headers: authHeaders() });
    showToast(action === 'issue-ticket' ? 'Ticket issued.' : 'Booking completed.');
    opsCloseWork();
    loadBookingOps();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = opsErr(err, 'Could not complete that action.');
  }
}

document.getElementById('opsWorkOverlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('opsWorkOverlay')) opsCloseWork();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('opsWorkOverlay')?.classList.contains('open')) opsCloseWork();
});
