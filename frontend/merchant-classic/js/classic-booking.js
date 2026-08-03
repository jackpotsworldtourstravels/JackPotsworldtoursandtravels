'use strict';
/* Classic — Booking Request.
   ===========================================================================
   This file used to hold two screens: Inventory Search and Raise Request. The
   search half is GONE — the whole catalog flow (search bar, results table,
   Select, /api/catalog/search and /api/catalog/{id}/quote) was removed with
   the Booking Enquiry redesign. A merchant no longer picks a fare off a list;
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

   NO DOCUMENTS ON THIS SCREEN
   There was once a Documents panel here, and on an international sector it was
   a gate: the merchant had to Save as draft, attach a passport per traveller,
   and only then could submit. That is gone. The flow is now the same shape on
   every route —

     fill in the travellers -> (optionally) Save as draft -> Submit

   — and Save as draft is a convenience, never a required step. Nothing about a
   file may stand between a filled-in form and the approvals desk. The upload
   API, the request_documents table and the Admin's verification screen all
   still exist and still work, so documents can come back later without a
   migration; they are simply not part of this workflow. Resuming a saved draft
   still comes back through Request Ticket, which loads it instead of refusing
   as a duplicate — see clRequestTicket in classic-enquiry.js.

   WHY THE UI STILL DECIDES "INTERNATIONAL"
   The API stores an IATA code and a city name, no country. travel-locations.js
   is the only place countries exist, so the flag is computed here and sent with
   the draft. It now drives passport *details* only — a number the merchant
   types, and an expiry that must outlast the travel date — which the backend
   still enforces at submit. When a code is missing from that dataset the answer
   is "not international", so an unknown airport can never invent a requirement
   the merchant cannot meet. */

/* The enquiry this screen is currently working from. Set by clStartBookingRequest,
   which Request Ticket calls just before navigating here. */
let clBookingEnquiry = null;
/* The saved draft, once one exists — null until Save as draft (or a resume).
   Its presence is what routes the next save to update rather than create. */
let clBookingDraft = null;
/* THE DIRECT-BOOKING ITINERARY, or null on the enquiry-led path.
   ===========================================================================
   Set by clStartDirectBooking from the form the merchant just filled in, and
   read only at the moment the booking is created — it is the body of
   POST /api/bookings/direct, minus the travellers this screen adds.

   It is a THIRD variable rather than a flag on clBookingEnquiry because the two
   answer different questions: `clBookingEnquiry` is what the screen RENDERS
   (and on this path it is a stand-in built from the same fields, so every
   read-only row above the passenger grid works untouched), while this is what
   the screen SENDS. Once a draft exists both paths save through the same
   update endpoints and this is no longer consulted. */
let clBookingDirect = null;

function clStartBookingRequest(enquiry, draft = null) {
  clBookingEnquiry = enquiry;
  clBookingDraft = draft;
  clBookingDirect = null;
}

/* Book Directly: no enquiry, no quotation, no server round trip yet.
   `itinerary` is exactly the payload the enquiry form built — the same keys
   POST /api/bookings/direct takes — so nothing is re-derived here. The
   stand-in below carries the same field names an EnquiryResponse does, which
   is what lets clRenderBookingForm render it without a single branch. */
function clStartDirectBooking(itinerary) {
  clBookingDirect = itinerary;
  clBookingDraft = null;
  clBookingEnquiry = {
    id: null,
    /* What clRenderBookingForm branches on. Read from the stand-in rather than
       from `clBookingDirect` so a RESUMED direct draft — which has no pending
       itinerary, because the server already holds it — renders identically. */
    direct_booking: true,
    reference_number: null,          // there is no enquiry to reference
    quoted_fare: null,               // and therefore no quotation
    quotation_remarks: null,
    admin_response: null,
    trip_type: itinerary.trip_type,
    origin: itinerary.origin, origin_city: itinerary.origin_city,
    destination: itinerary.destination, destination_city: itinerary.destination_city,
    airline: itinerary.airline,
    flight_number: itinerary.flight_number,
    travel_date: itinerary.travel_date,
    preferred_time: itinerary.preferred_time,
    return_date: itinerary.return_date,
    return_preferred_time: itinerary.return_preferred_time,
    travel_class: itinerary.travel_class,
    passenger_count: itinerary.passenger_count,
    adults: itinerary.adults, children: itinerary.children, infants: itinerary.infants,
  };
  /* DELETE, not add — clGo only runs a section's loader when the section is
     absent from clLoaded, and a stale "loaded" here lands on the previous
     booking's form. Same reason as clRequestTicket. */
  clLoaded.delete('booking-request');
  clGo('booking-request');
}

/* Reopen a saved DRAFT booking on this screen, from the booking alone.
   ===========================================================================
   The enquiry-led path resumes through Raise Booking on the enquiry row, which
   has an enquiry to re-read. A direct booking has none — so without this,
   "Save as draft" on the direct path would be a dead end: the merchant could
   submit the draft from My Requests but never open it again to fix a passport.

   The itinerary is rebuilt from the booking's own `travel_details`, which is
   where `_itinerary_details` wrote it, so this needs no enquiry for either
   path. `total_amount` stands in for the quotation on an enquiry-led draft —
   CR-5 creates that booking AT the quoted fare, so the row already holds it. */
function clResumeBookingDraft(booking) {
  const d = booking.details || {};
  clBookingDirect = null;               // the server holds it now; nothing to send
  clBookingDraft = booking;
  clBookingEnquiry = {
    id: null,
    direct_booking: !!d.direct_booking,
    reference_number: d.enquiry_reference || null,
    quoted_fare: Number(booking.total_amount) > 0 ? booking.total_amount : null,
    quotation_remarks: null,
    admin_response: null,
    trip_type: d.trip_type,
    origin: d.origin, origin_city: d.origin_city,
    destination: d.destination, destination_city: d.destination_city,
    airline: d.airline,
    flight_number: d.flight_number,
    travel_date: booking.travel_date,
    preferred_time: d.preferred_time,
    return_date: booking.return_date,
    return_preferred_time: d.return_preferred_time,
    travel_class: d.travel_class,
    passenger_count: d.passenger_count || (booking.passengers || []).length,
    adults: d.adults, children: d.children, infants: d.infants,
  };
  clLoaded.delete('booking-request');
  clGo('booking-request');
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
      <p>A booking starts either from an enquiry we have quoted, or straight from the journey.</p>
    </div></div>
    <div class="cl-panel"><div class="cl-panel-body">
      <p style="margin:0 0 6px;font-size:13px;color:var(--cl-text-muted);">
        Nothing selected. There are two ways in:</p>
      <ul style="margin:0 0 14px 18px;padding:0;font-size:13px;color:var(--cl-text-muted);">
        <li style="margin-bottom:5px;">Open <b>Booking Enquiry</b>, find an enquiry marked
          <b>Available</b>, and press <b>Raise Booking</b> — its details are carried over here so
          you only have to add the travellers, and the fare is the one we quoted.</li>
        <li>Or press <b>Book Directly</b> to skip the quotation — you enter the journey yourself
          and our team confirms the fare when the ticket is issued.</li>
      </ul>
      <div class="cl-form-actions" style="margin:0;">
        <button type="button" class="cl-btn cl-btn-primary" id="clBrToEnquiry">Go to Booking Enquiry</button>
        <button type="button" class="cl-btn" id="clBrToDirect">Book Directly</button>
      </div>
    </div></div>`;
  $('clBrToEnquiry').addEventListener('click', () => clGo('enquiry'));
  $('clBrToDirect').addEventListener('click', () => clGo('enquiry', () => clOpenEnquiryForm(true)));
}

function clRenderBookingForm(e) {
  const roundTrip = e.trip_type === 'round_trip';
  /* No enquiry in front of this booking. Changes what the page SAYS — where the
     journey came from, what step 1 and 2 were, and when the fare gets named —
     and nothing about what it COLLECTS. The travellers, the contact and the
     passport rules are identical, which is the point of reusing this screen. */
  const direct = !!e.direct_booking;
  const intl = clIsInternational(e);
  const originCountry = typeof travelCountryForCode === 'function' ? travelCountryForCode(e.origin) : null;
  const destCountry = typeof travelCountryForCode === 'function' ? travelCountryForCode(e.destination) : null;
  const contact = (clBookingDraft?.details?.contact) || {};

  $('cl-booking-request').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Booking Request</h1>
        <p>${direct
          ? 'Direct booking — review the journey you entered, then add traveller details. '
            + 'Names must match the travel document exactly.'
          : `From enquiry <b class="cl-ref">${escapeHtml(e.reference_number)}</b> — review the
             journey, then enter traveller details. Names must match the travel document exactly.`}</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clBrCancel">Discard</button>
      </div>
    </div>

    <!-- CR-5: step 2 and step 4 used to say the fare was settled at approval.
         It is settled at the quotation now, so step 2 names the figure and step
         4 is what it actually is — a sign-off on a booking already priced.

         The direct track has the same five steps and skips none of them; only
         the first two read differently, because there was no enquiry and
         therefore no quotation. Step 2 says where the fare WILL come from
         rather than leaving a step that looks unfinished. -->
    <div class="cl-stepper">
      <div class="cl-step done"><b>1. Journey</b>${direct
        ? 'Entered by you' : escapeHtml(e.reference_number)}</div>
      <div class="cl-step done"><b>2. ${direct ? 'Fare' : 'Quoted'}</b>${direct
        ? 'Named at ticketing'
        : (e.quoted_fare != null ? escapeHtml(moneyStr(e.quoted_fare)) : 'Available to book')}</div>
      <div class="cl-step current"><b>3. Passengers</b>Enter details</div>
      <div class="cl-step"><b>4. Approval</b>Sign-off on this booking</div>
      <div class="cl-step"><b>5. Ticketing</b>Settled from your wallet</div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Journey</h2>
        <div class="cl-panel-tools">
          <!-- Only when there is an enquiry to open. Null on the direct path,
               and also on a draft resumed from My Requests, which is rebuilt
               from the booking rather than from the enquiry. -->
          ${e.id != null
            ? '<button type="button" class="cl-btn cl-btn-sm" id="clBrViewEnquiry">View enquiry</button>'
            : ''}
        </div>
      </div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Trip type</dt><dd>${tripTypeLabel(e.trip_type)}</dd></div>
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
      ${e.quoted_fare != null ? `<div class="cl-panel-note">
        <b>Quoted fare:</b> <b style="font-size:15px;">${escapeHtml(moneyStr(e.quoted_fare))}</b>
        ${e.quotation_remarks
          ? `<div style="white-space:pre-wrap;margin-top:4px;">${escapeHtml(e.quotation_remarks)}</div>` : ''}
        <div style="margin-top:4px;">This booking is raised at that amount, and it is settled
          from your wallet once the ticket is issued.</div>
      </div>` : ''}
      ${e.admin_response ? `<div class="cl-panel-note">
        <b>Our response:</b> ${escapeHtml(e.admin_response)}</div>` : ''}
      <div class="cl-panel-note">
        ${direct
          ? `This is the journey you entered and it cannot be changed here. Discard this booking
             and start again if it needs to change — nothing has been raised yet.`
          : `These details come from the enquiry and cannot be changed here — they are what our team
             quoted. Raise a new enquiry if the journey needs to change.`}
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
          ? 'This is an international sector, so every traveller needs a passport number and an '
            + 'expiry after the travel date. No documents need to be uploaded.'
          : 'First and last name are required for every passenger. Passport details are optional '
            + 'on a domestic sector and can be supplied later.'}
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
          <button type="button" class="cl-btn cl-btn-primary" id="clBrSubmitBtn"
            ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Submit for approval</button>
          <button type="button" class="cl-btn" id="clBrDraftBtn"
            ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Save as draft</button>
          <span class="cl-kpi-sub">Saving a draft is optional — you can submit straight away.
            A draft stays in My Requests and can be submitted later.</span>
        </div>
        <div class="cl-msg" id="clBrMsg"></div>
      </div>
      <!-- CR-5 rewrote this note. It said the amount was confirmed at approval
           and that the request would "show a zero amount until it is approved",
           which was true only while the enquiry answer carried no price. The
           quotation is binding now, so the figure is known here and is the one
           the merchant is committing to — a note still promising a zero would
           contradict the amount printed directly above it. -->
      <div class="cl-panel-note">
        ${direct
          /* Said here as well as on the enquiry-form banner, and deliberately:
             this is the last screen before the merchant commits, and it is the
             one difference that costs money if it is a surprise. */
          ? `You are booking this without a quotation, so it carries no amount yet — our team
             confirms the payable fare when the ticket is issued, and that amount is settled from
             your wallet then.`
          : (e.quoted_fare != null
            ? `Submitting commits you to the quoted <b>${escapeHtml(moneyStr(e.quoted_fare))}</b>.
               It is checked against your credit limit when you submit and again when it is
               approved, and settled from your wallet once the ticket is issued.`
            : `This enquiry was answered before fares were quoted on the enquiry, so it carries no
               amount yet — our team confirms the payable amount when the ticket is issued.`)}
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

  $('clBrAddPax').addEventListener('click', () => {
    clAddPaxCard(list, list.querySelectorAll('[data-cl-pax]').length);
  });
  $('clBrCopyFirst').addEventListener('click', clFillDown);
  $('clBrViewEnquiry')?.addEventListener('click', () => clOpenEnquiryDetail(e.id));
  $('clBrCancel').addEventListener('click', async () => {
    /* Worth naming what survives. On the direct path nothing has been created
       yet, so discarding really does throw the typing away; once a draft
       exists — either path — it stays in My Requests and only this screen is
       being left. Two different answers to "am I losing this?". */
    const question = clBookingDraft
      ? `Leave this booking request? ${clBookingDraft.request_number} stays as a draft in My Requests.`
      : (direct
        ? 'Discard this booking? The journey and travellers you entered will be lost — nothing has been raised yet.'
        : 'Discard this booking request and return to Booking Enquiry?');
    if (!await clConfirm(question, clBookingDraft ? 'Leave' : 'Discard')) return;
    clBookingEnquiry = null;
    clBookingDirect = null;
    clLoaded.delete('booking-request');
    clGo(clBookingDraft ? 'requests' : 'enquiry');
  });
  $('clBrSubmitBtn').addEventListener('click', () => clSubmitBookingRequest(true));
  $('clBrDraftBtn').addEventListener('click', () => clSubmitBookingRequest(false));
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

  clBindPassportLookup(el);
}

/* ============================================ passenger auto-fill by passport */

/* The fields a lookup may fill, and what to call them when asking about one.
   Spelled out rather than run through clLabel(), which turns `dob` into "Dob"
   — this map is read out loud in a confirmation the merchant has to answer.

   `passport_number` is NOT among them: it is the key that was just typed, and
   writing it back would fight the merchant's cursor. */
const CL_LOOKUP_FIELDS = {
  title: 'Title',
  first_name: 'First name',
  last_name: 'Last name',
  gender: 'Gender',
  dob: 'Date of birth',
  nationality: 'Nationality',
  passport_issue_country: 'Issuing country',
  passport_issue_date: 'Passport issue date',
  passport_expiry: 'Passport expiry',
  seat_preference: 'Seat preference',
  meal_preference: 'Meal preference',
};

/* ON `change`, NOT ON `input`.
   A passport number is typed or pasted as a whole; firing per keystroke would
   send a dozen requests for one value and, far worse, would fill the form from
   a PREFIX match halfway through typing — then have to unfill it. `change`
   fires once, when the field is left or the paste is committed.

   `passenger_type` is also deliberately not filled: it is seeded from the party
   breakdown the merchant already gave (2 adults, 1 child), and a child who has
   since become an adult would otherwise silently re-type the row. */
function clBindPassportLookup(card) {
  const field = f => card.querySelector(`[data-field="${f}"]`);
  const input = field('passport_number');
  if (!input) return;

  let lastQueried = null;
  input.addEventListener('change', async () => {
    const number = (input.value || '').trim().toUpperCase();
    if (number.length < 4 || number === lastQueried) return;
    lastQueried = number;

    let found;
    try {
      found = await MerchantApi.lookupPassenger(number);
    } catch (err) {
      /* Silent by design. This is a convenience over a form that already works
         — a merchant who is about to type the details anyway must not be shown
         an error about a shortcut it never asked for. */
      console.debug('passenger lookup failed', err);
      return;
    }
    if (!found?.found) return clPaxHint(card, '');

    /* THE TWO PILES. Empty fields are filled outright; fields that already hold
       something DIFFERENT are never touched without an answer, because they are
       the ones the merchant may have deliberately corrected — a renewed
       passport expiry, a married name. Same-value fields are neither. */
    const blanks = [];
    const clashes = [];
    Object.entries(CL_LOOKUP_FIELDS).forEach(([f, label]) => {
      const el = field(f);
      const value = found[f];
      if (!el || value === null || value === undefined || value === '') return;
      const current = (el.value || '').trim();
      if (!current) blanks.push([el, value]);
      else if (current !== String(value)) clashes.push([el, value, label]);
    });

    blanks.forEach(([el, value]) => { el.value = value; });

    if (!blanks.length && !clashes.length) {
      return clPaxHint(card, `Matches a traveller you booked before${
        found.last_used ? ` (${fmtDate(found.last_used)})` : ''} — nothing to fill.`);
    }
    if (blanks.length) {
      clPaxHint(card, `Filled ${blanks.length} field${blanks.length === 1 ? '' : 's'} from a `
        + `previous booking${found.last_used ? ` (${fmtDate(found.last_used)})` : ''}. `
        + 'Check them before submitting.');
    }

    if (!clashes.length) return;
    /* Named one by one rather than counted. "Overwrite 3 fields?" is not a
       question anybody can answer; "Date of birth, Nationality" is. */
    const names = clashes.map(([, , label]) => label).join(', ');
    const ok = await clConfirm(
      `This passport is on file with different details for: ${names}. `
      + 'Replace what you have typed with the details from that booking?',
      'Replace');
    if (!ok) {
      return clPaxHint(card, `Kept what you typed. ${names} differ${
        clashes.length === 1 ? 's' : ''} from the previous booking.`);
    }
    clashes.forEach(([el, value]) => { el.value = value; });
    clPaxHint(card, `Replaced ${names} from the previous booking.`);
  });
}

/* One line under a passenger card, replaced rather than appended — a card that
   is edited three times must not accumulate three notes. */
function clPaxHint(card, text) {
  let hint = card.querySelector('[data-cl-pax-hint]');
  if (!text) return hint?.remove();
  if (!hint) {
    hint = document.createElement('div');
    hint.dataset.clPaxHint = '';
    hint.style.cssText = 'margin-top:6px;font-size:11.5px;color:var(--cl-text-muted);';
    card.appendChild(hint);
  }
  hint.textContent = text;
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

/* First and last name on every passenger, plus passport *details* — a number
   and a usable expiry — when the route is international. No attachment is
   involved: a merchant can complete this screen entirely by typing. The
   offending field is focused and outlined rather than described in prose.
   Returns an error string, or null when clean. */
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

  /* Passport rules bite only on submit — a half-filled draft is a legitimate
     thing to save. There is nothing else to satisfy: an international sector
     asks for passport numbers typed into the form, never for an upload, so a
     merchant who has filled the grid in can always go straight to Submit. */
  const paxProblem = clFlagMissingPassengerFields(finalize && intl, enquiry.travel_date);
  if (paxProblem) return clMsg(msg, paxProblem, 'err');

  const cards = [...$('clBrPaxList').querySelectorAll('[data-cl-pax]')];
  if (!cards.length) return clMsg(msg, 'Add at least one passenger.', 'err');

  const passengers = cards.map(clPassengerPayload);

  /* The party size the desk answered for is part of what was quoted, so a
     mismatch is worth confirming rather than silently sending. Still worth
     confirming on the direct path, where nothing was quoted: the merchant
     stated a party size on the form a moment ago and a different number of
     traveller rows is more likely a slip than a change of mind. */
  if (passengers.length !== enquiry.passenger_count) {
    const ok = await clConfirm(
      (enquiry.direct_booking
        ? `You asked for ${enquiry.passenger_count} passenger(s) and have entered `
        : `The enquiry was for ${enquiry.passenger_count} passenger(s) and you have entered `)
      + `${passengers.length}. Our team will re-check availability for the new party size. Continue?`,
      'Continue');
    if (!ok) return;
  }

  submitBtn.disabled = true; draftBtn.disabled = true;
  clMsg(msg, finalize ? 'Submitting for approval…' : 'Saving draft…', 'muted');

  const remarks = ($('clBrRemarks').value || '').trim();
  const specialRequests = ($('clBrSpecial').value || '').trim();
  const contact = clContactPayload();

  /* THREE try BLOCKS, NOT ONE.
     These steps fail in different ways and must be reported differently. When
     they shared a handler, a throw from any of the bookkeeping below was
     rendered as "Could not raise the booking request." over a draft the server
     had already created — so the merchant pressed Save again and got a second
     one. A save that succeeded is never reported as a failure now. */
  let request;
  try {
    if (clBookingDraft) {
      /* Resuming a saved draft: push whatever changed, then submit. Passengers
         are replaced wholesale because that is the endpoint's contract, and
         because it is the only way a removed traveller actually disappears. */
      await MerchantApi.replacePassengers(clBookingDraft.id, passengers);
      request = await MerchantApi.updateDraft(clBookingDraft.id, {
        remarks, contact, specialRequests,
      });
      request = request.request || request;
    } else if (clBookingDirect) {
      /* First save, direct path: the journey goes up with the travellers,
         because there is no enquiry holding it. Same two-step shape as below —
         this creates the draft, /submit is still what reaches the desk. */
      request = await MerchantApi.createDirectBooking(clBookingDirect, {
        passengers, remarks, contact, international: intl, specialRequests,
      });
    } else {
      /* First save: creates the draft against the enquiry. Only /submit puts
         it in front of the approvals team. */
      request = await MerchantApi.enquiryToBookingRequest(enquiry.id, {
        passengers, remarks, contact, international: intl, specialRequests,
      });
    }
  } catch (err) {
    clMsg(msg, clError(err, 'Could not raise the booking request.'), 'err');
    submitBtn.disabled = false; draftBtn.disabled = false;
    return;
  }

  /* The row exists from here on. Recorded before anything else can throw: a
     later failure that left this null would send the next press back down the
     create path and raise a second booking against the same enquiry. */
  clBookingDraft = request;

  if (finalize) {
    try {
      await MerchantApi.submitRequest(request.id);
    } catch (err) {
      /* The draft survived even though the submit did not, so say so — the
         merchant has lost no typing and can press Submit again. */
      clMsg(msg, clError(err,
        `${request.request_number} was saved as a draft, but could not be submitted.`), 'err');
      draftBtn.textContent = 'Save changes';
      submitBtn.disabled = false; draftBtn.disabled = false;
      return;
    }
  }

  /* Cosmetic from here: the screen, the cached section lists and the unread
     badge. None of it can undo what the server has already accepted, so a
     throw is logged and the outcome still reported as the success it was. */
  try {
    if (finalize) {
      clBookingSubmitted(request.request_number, enquiry.reference_number);
    } else {
      clSyncPassengerIds(request.passengers);
      clMsg(msg,
        `Draft saved — ${request.request_number}. `
        + 'Submit it here or from My Requests when ready.', 'ok');
      draftBtn.textContent = 'Save changes';
    }

    /* Every counter and list that just changed, including the enquiry listing —
       its row now shows the booking instead of Request Ticket. */
    /* `booking-history` is in the list because a booking raised today can be
       cancelled today, and the archive would otherwise still be showing the
       page it rendered before that happened. The old `clSearchCache = null`
       that used to sit here went with the topbar's search box — there is no
       client-side row cache left to invalidate. */
    clInvalidate('dashboard', 'enquiry', 'requests', 'booking-history',
      'payments', 'service-request', 'reports');
    clLoadUnreadCount();
  } catch (err) {
    console.error('Booking request went through, but this screen could not be updated', err);
    if (!finalize) {
      clMsg(msg,
        `Draft saved — ${request.request_number}. `
        + 'Reload the page if this screen looks out of date.', 'ok');
      draftBtn.textContent = 'Save changes';
    }
  }

  /* Re-enabled after a draft save, unlike Phase 1 where saving ended the
     screen's usefulness. Saving is now purely a checkpoint — the merchant can
     carry on editing and then submit from here — and clSubmitBookingRequest
     routes to update rather than create on the next press, so pressing again
     cannot duplicate. */
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
          <!-- CR-5 corrected this line. It promised a move to "Payment Pending
               once it is approved and priced", and neither half has been true
               on this track since CR-2 removed the payment stage from it and
               CR-5 priced the booking at the quotation.

               A direct booking has no enquiry to name and no quoted amount to
               promise, so it gets its own sentence rather than an empty <b>
               and a figure that does not exist yet. -->
          Request <b>${escapeHtml(requestNumber)}</b>${enquiryReference
            ? `, raised from enquiry <b>${escapeHtml(enquiryReference)}</b>,` : ''}
          has been submitted for approval. Track it in My Requests; ${enquiryReference
            ? 'the quoted amount is settled from your wallet when the ticket is issued.'
            : 'our team confirms the fare when the ticket is issued, and that amount is settled '
              + 'from your wallet then.'}
        </div>
        <div class="cl-form-actions">
          <button type="button" class="cl-btn cl-btn-primary" id="clBrDoneList">View My Requests</button>
          <!-- Offers back the route just taken. Someone who booked directly is
               more likely to book directly again than to switch to enquiring. -->
          <button type="button" class="cl-btn" id="clBrDoneNew">${enquiryReference
            ? 'New booking enquiry' : 'Book another directly'}</button>
        </div>
      </div>
    </div>`;
  const again = !enquiryReference;
  $('clBrDoneList').addEventListener('click', () => {
    clBookingEnquiry = null; clBookingDirect = null;
    clLoaded.delete('booking-request'); clGo('requests');
  });
  $('clBrDoneNew').addEventListener('click', () => {
    clBookingEnquiry = null; clBookingDirect = null;
    clLoaded.delete('booking-request');
    clGo('enquiry', () => clOpenEnquiryForm(again));
  });
}
