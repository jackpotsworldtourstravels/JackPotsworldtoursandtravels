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

/* THE MANIFEST UPLOADED ON THIS SCREEN, for an enquiry-led group booking.
   ===========================================================================
   A group ENQUIRY no longer carries a passenger list — it asks whether a party
   of N can fly and what it costs, and the sheet listing that party arrives
   here, once we have answered. This holds the accepted import between the
   upload finishing and the booking being submitted.

   A FOURTH variable rather than a field on clBookingDraft because it exists
   before a draft does: the merchant can upload, review the imported rows and
   submit in one pass without ever saving a draft, and hanging it on an object
   that is still null at that point would lose it. Once a draft has been saved
   the server knows the import anyway, and `clResolveGroupImportId` below reads
   whichever of the three sources actually has it. */
let clBrGroupImport = null;

function clStartBookingRequest(enquiry, draft = null) {
  clBookingEnquiry = enquiry;
  clBookingDraft = draft;
  clBookingDirect = null;
  clBrGroupImport = null;
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
    /* Carried through so the traveller step knows to skip itself: a group
       booking's passengers were already supplied as a spreadsheet, and asking
       for them again is the one thing this feature exists to avoid. */
    group_journey_type: itinerary.group_journey_type,
    group_import_id: itinerary.group_import_id,
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
/* `detail` is the whole GET /api/requests/{id} envelope, not just its
   `request`: the manifest id lives on the envelope, because putting it on
   RequestResponse would make every listing lazy-load a backref per row. */
function clResumeBookingDraft(booking, detail = null) {
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
    /* WITHOUT THESE TWO A RESUMED GROUP DRAFT LOOKS LIKE A FRESH ONE.
       `group_journey_type` is what the return-leg panel and the group branches
       key off, and `group_import_id` is how the screen knows the sheet is
       already in — omitting it would show the upload card over a booking that
       has a manifest, and invite a second one. The id rides on the detail
       response (RequestDetailResponse.group_import_id); the journey type is in
       travel_details, where _itinerary_details wrote it. */
    group_journey_type: d.group_journey_type,
    group_import_id: detail?.group_import_id || booking.group_import_id || null,
    origin: d.origin, origin_city: d.origin_city,
    destination: d.destination, destination_city: d.destination_city,
    airline: d.airline,
    flight_number: d.flight_number,
    travel_date: booking.travel_date,
    preferred_time: d.preferred_time,
    return_date: booking.return_date,
    return_preferred_time: d.return_preferred_time,
    travel_class: d.travel_class,
    booking_class: d.booking_class,
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

/* THE HUB — what this screen is when there is no booking in progress.
   ===========================================================================
   Landing here directly — from the sidebar, or from a #booking-request deep
   link — is a legitimate thing to do and needs an answer, not an empty page.
   It used to answer with two bare buttons on an otherwise blank panel, which
   left the screen looking half-built and said nothing about which route a
   merchant should take or what they had already raised.

   It is now two things: the CHOICE (the two ways a booking can start, as
   cards) and the CONTEXT (what this merchant raised most recently). Both were
   already reachable — Booking Enquiry and My Requests — so nothing new is
   being offered here; the page simply stops being the one screen in the portal
   that shows the merchant nothing.

   NOTHING BELOW TOUCHES THE WORKFLOW. The two actions call exactly what the
   two buttons called, and the table is a read of /api/requests filtered to
   bookings. Every row action is the same function My Requests binds. */
function clRenderNoEnquiry() {
  $('cl-booking-request').innerHTML = `
    <div class="cl-page-head"><div>
      <h1>Booking Request</h1>
    </div></div>

    <section class="cl-qa" aria-labelledby="clQaTitle">
      <div class="cl-qa-head">
        <span class="cl-qa-head-ico">${clIco('activity', { size: 17 })}</span>
        <div>
          <h2 id="clQaTitle">Quick Actions</h2>
          <p>Choose how you want to create a booking.</p>
        </div>
      </div>

      <!-- THE CARD IS THE TARGET, THE BUTTON IS THE CONTROL.
           One click handler per card, bound below on the card itself — the
           button inside deliberately has none, so a press on it bubbles up to
           exactly the same handler. That is what makes the whole surface
           clickable without the action firing twice, and it keeps the keyboard
           path honest: the <button> is still the focusable, Enter/Space
           control, and the card is only a bigger hit area for a pointer. -->
      <div class="cl-qa-grid">
        <div class="cl-qa-card cl-qa-card-rec" data-cl-qa="enquiry">
          <span class="cl-qa-ico">${clIco('file', { size: 24 })}</span>
          <div class="cl-qa-body">
            <div class="cl-qa-title">
              <h3>From Booking Enquiry</h3>
              <span class="cl-tag cl-tag-accent">Recommended</span>
            </div>
            <p>Create a booking using an approved quotation from your booking enquiry.</p>
          </div>
          <button type="button" class="cl-btn cl-btn-primary cl-btn-cta cl-btn-block"
            id="clBrToEnquiry">Go to Booking Enquiry ${clIco('arrowRight', { size: 15 })}</button>
        </div>

        <div class="cl-qa-card" data-cl-qa="direct">
          <span class="cl-qa-ico">${clIco('plane', { size: 24 })}</span>
          <div class="cl-qa-body">
            <div class="cl-qa-title"><h3>Direct Booking</h3></div>
            <p>Create a booking directly without requesting a quotation.</p>
          </div>
          <button type="button" class="cl-btn cl-btn-cta cl-btn-block"
            id="clBrToDirect">Book Directly ${clIco('arrowRight', { size: 15 })}</button>
        </div>
      </div>
    </section>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>${clIco('history')} Recent Booking Requests</h2>
        <div class="cl-panel-tools">
          <button type="button" class="cl-btn cl-btn-sm" id="clBrRecentRefresh">
            ${clIco('refresh', { size: 14 })} Refresh
          </button>
          <button type="button" class="cl-btn cl-btn-sm" id="clBrRecentAll">View all</button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Booking reference</th><th>Journey</th><th>Booking type</th>
              <th>Status</th><th>Created</th>
              <th class="cl-actions">Action</th>
            </tr></thead>
            <tbody id="clBrRecentBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-panel-note" id="clBrRecentNote"></div>
    </div>`;

  /* The action is bound ONCE, on the card. See the comment in the markup. */
  $('cl-booking-request').querySelectorAll('[data-cl-qa]').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.clQa === 'enquiry') clGo('enquiry');
      else clGo('enquiry', () => clOpenEnquiryForm(true));
    });
  });

  $('clBrRecentRefresh').addEventListener('click', () => clLoadRecentBookings());
  $('clBrRecentAll').addEventListener('click', () => clGo('requests'));
  return clLoadRecentBookings();
}

/* ------------------------------------------------- recent booking requests */

/* Six is a strip, not a table to work from. My Requests is the worklist and
   Booking History is the archive; this is only "what did I raise lately", so
   it deliberately has no filters and no pager — the footer says how many there
   are in total and View all goes to the screen that can page through them. */
const CL_BR_RECENT = 6;

let clBrRecentRows = [];

/* Reload the strip if it is on screen, and do nothing at all otherwise.
   `#clBrRecentBody` exists only while the HUB is rendered — never while the
   booking FORM is, even though both are the same section — so this can be
   called from anywhere that changes a booking without any risk of throwing
   away a half-filled passenger form, which `clRefreshIfVisible('booking-
   request')` would do. */
function clRefreshRecentBookings() {
  if ($('clBrRecentBody')) clLoadRecentBookings();
}

async function clLoadRecentBookings() {
  const body = $('clBrRecentBody');
  if (!body) return;
  body.innerHTML = clLoadingRow(6, 'Loading your recent booking requests…', 3);

  try {
    /* ONE call, and no status filter: `list_requests` orders by `created_at`
       DESC over whatever the filter matches, so the newest six bookings at any
       stage come back in one page. My Requests has to fan out per status
       because it is showing a whole POPULATION ("everything still active") and
       the API takes one status at a time — this is showing a PREFIX, which
       needs no merge and cannot be undercounted by one. */
    const data = await MerchantApi.listRequests({
      request_type: 'booking', page_size: CL_BR_RECENT,
    });
    clBrRecentRows = data.items || [];
    const total = data.total ?? clBrRecentRows.length;

    body.innerHTML = clBrRecentRows.length
      ? clBrRecentRows.map(clBrRecentRow).join('')
      : clEmptyRow(6, 'No booking requests yet',
        ' Start with a booking enquiry above, or book directly — anything you raise appears here.');

    /* `total` is the server's own COUNT over the same filter, not a count of
       what came back, so this is the real number of bookings rather than the
       size of a page. */
    $('clBrRecentNote').textContent = !total
      ? ''
      : total > clBrRecentRows.length
        ? `Showing your ${clBrRecentRows.length} most recent of ${total} booking requests. `
          + 'View all opens My Requests, where everything still in motion can be filtered and paged.'
        : `All ${total} of your booking request${total === 1 ? '' : 's'}.`;

    clBindRecentActions(body);
  } catch (err) {
    clBrRecentRows = [];
    body.innerHTML = clEmptyRow(6, clError(err, 'Could not load your recent booking requests.'));
    $('clBrRecentNote').textContent = '';
  }
}

function clBrRecentRow(r) {
  /* `details` is `travel_details` on the wire; the fallback matches the shape
     the rest of the portal reads (clJourneyCell takes either). */
  const d = r.details || r.travel_details || {};
  /* The same two markers the backend decides the Classic track from —
     lifecycle.CLASSIC_MARKER_KEYS. Read rather than re-derived, so this column
     can never disagree with the workflow the booking is actually running. */
  const direct = !!d.direct_booking;
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.request_number || '—')}
      ${r.pnr ? `<div class="cl-kpi-sub">PNR ${escapeHtml(r.pnr)}</div>` : ''}</td>
    <td>${clJourneyCell(r)}</td>
    <td class="cl-nowrap">
      <span class="cl-tag cl-tag-plain">${direct ? 'Direct booking' : 'From enquiry'}</span>
      ${!direct && d.enquiry_reference
        ? `<div class="cl-kpi-sub cl-ref">${escapeHtml(d.enquiry_reference)}</div>` : ''}</td>
    <td>${clTag(r.status, r.status_label)}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDateTime(r.created_at))}</td>
    <td class="cl-actions">${clBrRecentActions(r)}</td>
  </tr>`;
}

/* The same status-driven rules as My Requests, minus Cancel.
   ===========================================================================
   Cancel is deliberately not here. It is irreversible, it needs a reason, and
   this strip is six rows of context on a page whose job is starting a booking
   — not the screen anyone should be taking a booking back from. It is
   untouched on My Requests and on the booking's own detail page, which is
   where the merchant has the whole row in front of them. */
function clBrRecentActions(r) {
  const out = [`<button type="button" class="cl-btn cl-btn-sm" data-cl-recent-view="${r.id}">View</button>`];
  if (r.status === 'draft') {
    out.push(`<button type="button" class="cl-btn cl-btn-sm" data-cl-recent-continue="${r.id}"
      ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Continue</button>`);
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-recent-submit="${r.id}"
      ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Submit</button>`);
  }
  if (r.status === 'payment_pending') {
    /* record_payment rejects amount <= 0 with a 400, so an unpriced row can
       only fail. Say so rather than offering a button that cannot work — the
       same rule clRequestActions applies. */
    out.push(moneyIsPositive(r.total_amount)
      ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-recent-pay="${r.id}"
         ${clActionAttrs('payment.pay', CL_NO_PAY)}>Pay</button>`
      : '<span class="cl-tag">Awaiting amount</span>');
  }
  return out.join('');
}

/* Every one of these is My Requests' own handler, called unchanged. The strip
   reloads afterwards because those functions refresh the screen THEY belong to
   and know nothing about this one. */
function clBindRecentActions(body) {
  body.querySelectorAll('[data-cl-recent-view]').forEach(b =>
    b.addEventListener('click', () => clOpenRequestDetail(b.dataset.clRecentView)));
  body.querySelectorAll('[data-cl-recent-continue]').forEach(b =>
    b.addEventListener('click', () => clContinueBookingDraft(b.dataset.clRecentContinue, b)));
  body.querySelectorAll('[data-cl-recent-submit]').forEach(b =>
    b.addEventListener('click', async () => {
      await clSubmitDraft(b.dataset.clRecentSubmit);
      clRefreshRecentBookings();
    }));
  body.querySelectorAll('[data-cl-recent-pay]').forEach(b =>
    b.addEventListener('click', () => {
      const r = clBrRecentRows.find(x => String(x.id) === b.dataset.clRecentPay);
      if (r) clOpenPayModal(r);
    }));
}

function clRenderBookingForm(e) {
  /* A Round Trip Group has a return leg too, so the journey panel keys off
     whether one EXISTS rather than off the trip type alone. */
  const roundTrip = e.trip_type === 'round_trip'
    || e.group_journey_type === 'round_trip_group';
  /* Whether the travellers came from an uploaded sheet. On a resumed draft the
     itinerary is rebuilt from travel_details, which is why the trip type is
     checked as well as the import id — one or the other is always present. */
  const isGroup = e.trip_type === 'group_trip' || !!e.group_journey_type;
  /* No enquiry in front of this booking. Changes what the page SAYS — where the
     journey came from, what step 1 and 2 were, and when the fare gets named —
     and nothing about what it COLLECTS. The travellers, the contact and the
     passport rules are identical, which is the point of reusing this screen. */
  const direct = !!e.direct_booking;
  const intl = clIsInternational(e);
  const originCountry = typeof travelCountryForCode === 'function' ? travelCountryForCode(e.origin) : null;
  const destCountry = typeof travelCountryForCode === 'function' ? travelCountryForCode(e.destination) : null;
  const contact = (clBookingDraft?.details?.contact) || {};
  /* Which country each stored number belongs to, resolved once. Both phone
     fields need it three times over — the picker's selection, the cap on the
     box and the sentence under it — and splitDialCode is already doing the work
     for the value, so doing it here keeps the markup from calling it six times
     and from being the place that decides what a length is. */
  const phoneCode = splitDialCode(contact.phone).code;
  const altCode = splitDialCode(contact.alternate_phone).code;

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
          <div><dt>Airline</dt><dd>${escapeHtml(fmtAirline(e.airline))}</dd></div>
          <div><dt>Flight number</dt><dd class="cl-ref">${escapeHtml(e.flight_number || '—')}</dd></div>
          <div><dt>Departure date</dt><dd>${escapeHtml(fmtDate(e.travel_date))}</dd></div>
          <div><dt>Preferred time</dt><dd>${escapeHtml(clTimeLabel(e.preferred_time) || '—')}</dd></div>
          ${roundTrip ? `
            <div><dt>Return date</dt><dd>${escapeHtml(fmtDate(e.return_date))}</dd></div>
            <div><dt>Return time</dt><dd>${escapeHtml(clTimeLabel(e.return_preferred_time) || '—')}</dd></div>` : ''}
          ${isGroup ? '' : `
            <div><dt>Class</dt><dd>${escapeHtml(e.travel_class || '—')}</dd></div>
            <div><dt>Booking Class</dt><dd>${escapeHtml(e.booking_class || '—')}</dd></div>`}
          <!-- A group states a total and no breakdown, so printing "0 children,
               0 infants" beside it would assert a composition nobody gave. -->
          <div><dt>Party</dt><dd>${isGroup
            ? `${e.passenger_count} passenger${e.passenger_count === 1 ? '' : 's'}`
            : `${e.passenger_count} — ${e.adults} adult${e.adults === 1 ? '' : 's'}${
              e.children ? `, ${e.children} child${e.children === 1 ? '' : 'ren'}` : ''}${
              e.infants ? `, ${e.infants} infant${e.infants === 1 ? '' : 's'}` : ''}`}</dd></div>
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

    <!-- CONTACT IS OPTIONAL IN FULL, and nothing in this panel can refuse a
         submission. None of the four carries the required marker; none of them
         is checked in a way that stops the booking. It was once the only thing
         on this screen a merchant could not skip, and it is information we
         usually already hold against the account.

         WHAT THE SERVER STILL REQUIRES, AND WHAT WE DO ABOUT IT: BookingContact
         (schemas/enquiry.py) requires an email AND a phone whenever a contact is
         sent at all, so a half-filled panel is not something the API can take.
         It is therefore left OFF the payload rather than blocked — see
         clContactPayload — and clReviewContact says so in the panel, so the
         merchant knows before and after submitting.
         (No backticks in this comment — it is inside a template literal.) -->
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
            <label for="clBrContactEmail">Email</label>
            <input type="email" id="clBrContactEmail" maxlength="255"
              value="${escapeHtml(contact.email || '')}" placeholder="bookings@yourcompany.com">
          </div>
          <!-- THE COUNTRY CODE IS PICKED, THE NUMBER IS TYPED.
               The field used to be one box asking for the code and the number
               run together — "919000000000" — which is not how anyone holds a
               phone number, and left the merchant to work out that the plus was
               unwelcome. The picker states the code; the box beside it takes as
               many digits as that country's numbers have and nothing else,
               filtered as they are typed (clBindPhoneField), so a pasted
               "+91 90000 00000" becomes "9000000000" under a "+91" the merchant
               can see.

               THE LENGTH FOLLOWS THE PICKER. It was ten for every country,
               which refused a nine-digit Emirati number and an eight-digit
               Qatari one under the very codes this dropdown offers. The cap,
               the hint and the counter all come from the selected code now — see
               dialLengths in shared/countries.js — and they are re-read when the
               code changes, not frozen at render. There is no example number in
               the box because there is no one shape to show: the sentence below
               it states the country's own length instead.

               WHAT IS SENT IS UNCHANGED: clContactPayload joins the two back
               into the same digits string the API has always stored, so a
               contact saved before this picker existed still round-trips —
               splitDialCode puts the stored digits back into the two controls.
               (No backticks in this comment — it is inside a template literal.) -->
          <div class="cl-field">
            <label for="clBrContactPhone">Phone</label>
            <div class="cl-phone">
              <select id="clBrContactPhoneCC" class="cl-phone-cc"
                aria-label="Country code for the phone number">${clDialOptions(contact.phone)}</select>
              <input type="tel" id="clBrContactPhone" class="cl-phone-num"
                maxlength="${dialLengths(phoneCode).max}" inputmode="numeric"
                autocomplete="tel-national"
                value="${escapeHtml(splitDialCode(contact.phone).number)}">
            </div>
            <small id="clBrContactPhoneHint">${clPhoneHint(phoneCode)}</small>
          </div>
          <div class="cl-field">
            <label for="clBrContactAlt">Alternate phone</label>
            <div class="cl-phone">
              <select id="clBrContactAltCC" class="cl-phone-cc"
                aria-label="Country code for the alternate phone number">${
                  clDialOptions(contact.alternate_phone)}</select>
              <input type="tel" id="clBrContactAlt" class="cl-phone-num"
                maxlength="${dialLengths(altCode).max}" inputmode="numeric"
                autocomplete="tel-national"
                value="${escapeHtml(splitDialCode(contact.alternate_phone).number)}"
                placeholder="Optional">
            </div>
            <small id="clBrContactAltHint">${clPhoneHint(altCode)}</small>
          </div>
        </div>
        <!-- Says what a half-filled panel will do, rather than refusing it.
             Written by clReviewContact and empty the rest of the time. -->
        <div class="cl-msg" id="clBrContactMsg"></div>
      </div>
      <div class="cl-panel-note">
        One contact for the whole party — this is who our team and the airline reach
        about schedule changes, so it should be a monitored address and number.
        Optional: leave it blank and we will use the details we hold for your account.
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Passengers</h2>
        <div class="cl-panel-tools"${isGroup ? ' hidden' : ''}>
          <button type="button" class="cl-btn cl-btn-sm" id="clBrAddPax">Add passenger</button>
          <button type="button" class="cl-btn cl-btn-sm" id="clBrCopyFirst"
            title="Copy nationality and document country from the first passenger">Fill down</button>
        </div>
      </div>
      <!-- A GROUP BOOKING'S TRAVELLERS ARE ALREADY IN. They came from the
           uploaded sheet, so this panel reports them rather than collecting
           them — re-entering eighty passports is the drudgery the upload
           exists to remove. The list is still rendered, read-only. -->
      <div class="cl-panel-body" id="clBrPaxList"${isGroup ? ' data-cl-readonly="1"' : ''}></div>
      <div class="cl-panel-note">
        ${intl
          ? 'This is an international sector, so every traveller needs a passport number and a '
            + 'passport valid for at least 6 months from the travel date. No documents need to '
            + 'be uploaded.'
          : 'First and last name are required for every passenger. Passport details are optional '
            + 'on a domestic sector and can be supplied later.'}
      </div>
    </div>

    <!-- THE CLIENT FARE PANEL THAT USED TO SIT HERE IS GONE, on request.
         ===================================================================
         It was the second of two boxes asking the same question — the Booking
         Enquiry form and the Book Directly form both collect Client Fare, and
         this one restated it after the fact. What the merchant charges its own
         customer is now stated once, at the point the journey is described.

         NOTHING ABOUT THE DATA CHANGED. to_booking_request prefers a client
         fare in its payload and falls back to the one the enquiry carried
         (an "is not None" test, because 0 is a real fare), so omitting the
         field here means the enquiry's value stands — which is why "You Saved"
         on the Dashboard, in Reports and on the booking detail keeps working.
         The direct path carries its own value through the itinerary payload;
         see clSubmitBookingRequest, which no longer overwrites it.

         The API is untouched: client_fare remains accepted by both
         EnquiryToBooking and UpdateDraftRequest, and merchant-api.js still
         forwards it when a caller supplies one.
         (No backticks in this comment — it is inside a template literal.) -->

    <div class="cl-panel">
      <div class="cl-panel-body">
        <!-- Special requests moved to the passenger cards above: a bassinet, a
             wheelchair and a Jain meal each belong to ONE traveller, and a
             single party-wide box made the desk guess which. See the Special
             request field on each card, which rides that passenger's
             special_services array to the Booking Operations desk. -->
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
  if (isGroup) {
    clRenderImportedPassengers(list, e);
  } else if (clBookingDraft?.passengers?.length) {
    // Resuming: rebuild the rows from what was saved rather than from the
    // enquiry breakdown, or edits made before saving would be lost.
    clBookingDraft.passengers.forEach((p, i) => clAddPaxCard(list, i, p.passenger_type, p));
  } else {
    clSeedPassengerRows(list, e);
  }

  /* Both contact numbers take digits and nothing else, filtered as they are
     typed — a merchant who pastes "+91 90000 00000" sees it become
     "9000000000" beside the "+91" they picked. The length is judged on every
     keystroke too now that the country code is not sharing the box: "9 of 10
     digits" is a useful thing to say while someone is typing, where the old
     7-to-15 rule had nothing to offer until submit. */
  clBindPhoneField('clBrContactPhone', 'clBrContactPhoneHint', 'clBrContactPhoneCC');
  clBindPhoneField('clBrContactAlt', 'clBrContactAltHint', 'clBrContactAltCC');

  /* The panel's own verdict, kept current as the merchant fills it in. Without
     this the "will not be attached" note would only appear on submit — which is
     the one moment it is least useful, because the booking has already gone. */
  ['clBrContactEmail', 'clBrContactPhone', 'clBrContactAlt'].forEach(id => {
    $(id)?.addEventListener('blur', clReviewContact);
  });
  ['clBrContactPhoneCC', 'clBrContactAltCC'].forEach(id => {
    $(id)?.addEventListener('change', clReviewContact);
  });

  $('clBrAddPax')?.addEventListener('click', () => {
    clAddPaxCard(list, list.querySelectorAll('[data-cl-pax]').length);
  });
  $('clBrCopyFirst')?.addEventListener('click', clFillDown);
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
    /* Drop the upload host with the screen that installed it, so a handler
       closed over this booking cannot write into whatever renders the card
       next. clOpenEnquiryForm reinstalls its own, but only once it opens. */
    clBrGroupImport = null;
    clGbSetHost(null);
    clLoaded.delete('booking-request');
    clGo(clBookingDraft ? 'requests' : 'enquiry');
  });
  $('clBrSubmitBtn').addEventListener('click', () => clSubmitBookingRequest(true));
  $('clBrDraftBtn').addEventListener('click', () => clSubmitBookingRequest(false));
}

/* WHERE A GROUP BOOKING'S MANIFEST ID CAN COME FROM — three places, in the
   order they take precedence:

     1. the enquiry itself, for a group enquiry raised BEFORE the upload moved
        to this screen. That sheet is what the desk quoted against, so it wins.
     2. an upload just completed on this screen, held in clBrGroupImport.
     3. a saved draft, which is how a resumed booking finds the sheet it was
        saved with.

   One function so the render path and the submit path cannot disagree about
   whether a booking has a manifest — they did, briefly, and the result was a
   screen showing an imported party that submit then refused for having none. */
function clResolveGroupImportId(e) {
  return e?.group_import_id
    || clBrGroupImport?.import_id
    || clBookingDraft?.group_import?.import_id
    || null;
}

/* THE UPLOAD CARD, ON THE BOOKING REQUEST SCREEN.
   ===========================================================================
   Reuses `clUploadCard()` from classic-enquiry.js verbatim — same markup, same
   ids, same drop zone, progress bar, validation summary and Replace File — so
   there is one upload workflow in this portal rather than a second copy that
   drifts. classic-enquiry.js is loaded before this file, which is what makes
   the function available; see the script order in index.html.

   The card ships hidden (the enquiry modal shows it conditionally); here it is
   always the point of the panel, so the `cl-hidden` comes straight back off. */
function clRenderGroupUploadCard(list, e) {
  list.innerHTML = clUploadCard();

  const card = list.querySelector('#clEnqUpload');
  if (!card) {
    list.innerHTML = `<div class="cl-msg cl-msg-err" style="margin:14px;">
      The passenger list upload could not be loaded. Reload the page and try again.</div>`;
    return;
  }
  card.classList.remove('cl-hidden');

  /* The lede is written for the enquiry modal ("upload all passenger details
     using our Excel template"). At this stage the merchant has a quotation and
     is committing to it, which is worth saying — it is the difference between
     the two screens the sheet can be uploaded on. */
  const lede = card.querySelector('.cl-gb-lede');
  if (lede) {
    lede.innerHTML = 'Your enquiry has been answered — now tell us who is travelling. '
      + 'Download the template, fill in one row per traveller, and upload it. '
      + 'Every row is checked before the booking can be submitted.';
  }

  /* The upload writes here rather than into the enquiry modal's form object. */
  clGbSetHost({
    journeyType: () => e?.group_journey_type || 'one_way_group',
    get: () => clBrGroupImport,
    set: imp => { clBrGroupImport = imp; },
    /* DELIBERATELY LEAVES THE IMPORT SUMMARY ON SCREEN rather than swapping in
       the read-only passenger table. The summary is what carries "View Imported
       Data" and "Replace File", and replacing a sheet is something a merchant
       does most often in the seconds after uploading the wrong one — trading
       that away to show a table they can open from the same card would be a
       poor bargain. The table is still what a resumed draft renders, where
       there is nothing to replace. */
    onDone: () => {},
  });

  clWireUpload();
}

/* THE IMPORTED PARTY, REPORTED RATHER THAN COLLECTED.
   ===========================================================================
   Rendered from the manifest the merchant already uploaded. Read-only on
   purpose: the sheet is the source, and an editable copy here would be a
   second one that silently wins or silently loses. Correcting a traveller
   means correcting the sheet and uploading it again, which is also the only
   way the row-level validation gets re-run over the change.

   Passengers are fetched rather than passed in, because a resumed draft has an
   import id and nothing else — the rows live on the server. */
async function clRenderImportedPassengers(list, e) {
  const importId = clResolveGroupImportId(e);

  /* NO MANIFEST YET IS THE NORMAL STATE HERE, not an error. The enquiry stage
     deliberately does not collect one — it asks whether the seats exist — so an
     enquiry-led group booking arrives at this screen with a passenger count and
     nothing else, and THIS is where the sheet is uploaded. It used to say "go
     back and upload one", which now points at a card that no longer exists on
     the enquiry form. */
  if (!importId) {
    clRenderGroupUploadCard(list, e);
    return;
  }

  list.innerHTML = '<div class="cl-empty">Loading the imported passenger list…</div>';

  let d;
  try {
    d = await MerchantApi.getGroupImport(importId);
  } catch (err) {
    list.innerHTML = `<div class="cl-msg cl-msg-err" style="margin:14px;">
      ${escapeHtml(clError(err, 'Could not load the imported passenger list.'))}</div>`;
    return;
  }

  const rows = (d.passengers || []).map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><b>${escapeHtml(`${p.first_name} ${p.last_name}`)}</b></td>
      <td>${escapeHtml(p.passenger_type || '—')}</td>
      <td>${escapeHtml(p.gender || '—')}</td>
      <td>${escapeHtml(p.dob || '—')}</td>
      <td>${escapeHtml(p.nationality || '—')}</td>
      <td>${escapeHtml(p.passport_number || '—')}</td>
      <td>${escapeHtml(p.passport_expiry || '—')}</td>
    </tr>`).join('');

  list.innerHTML = `
    <div class="cl-gb-imported">
      <div class="cl-gb-imported-head">
        <div>
          <b>${d.passengers_imported} passenger(s)</b> imported from
          <span class="cl-ref">${escapeHtml(d.original_filename)}</span>
        </div>
        <button type="button" class="cl-btn cl-btn-sm" id="clBrDownloadManifest">
          Download the uploaded file
        </button>
      </div>
      <div class="cl-gb-viewwrap">
        <table class="cl-table cl-gb-view">
          <thead><tr>
            <th>#</th><th>Name</th><th>Type</th><th>Gender</th>
            <th>Date of Birth</th><th>Nationality</th><th>Passport</th><th>Expiry</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="8">No passengers imported.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('clBrDownloadManifest').addEventListener('click', async () => {
    try {
      await MerchantApi.downloadGroupManifest(d.import_id, d.original_filename);
    } catch (err) {
      clMsg($('clBrMsg'), clError(err, 'Could not download the file.'), 'err');
    }
  });
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
      <div class="cl-field"><label>Passenger Type</label>
        <select data-field="passenger_type">${CL_PAX_TYPES.map(t =>
          `<option value="${t}"${t === (passengerType || 'adult') ? ' selected' : ''}>${clLabel(t)}</option>`).join('')}</select></div>
      <div class="cl-field"><label>Gender</label>
        <select data-field="gender"><option value="">—</option>
          <option value="male">Male</option><option value="female">Female</option>
          <option value="other">Other</option></select></div>
      <div class="cl-field"><label>Date of birth</label><input type="date" data-field="dob"></div>
      <!-- SEARCHABLE, NOT FREE TEXT — and the two boxes ask for different words
           for the same fact: nationality is the demonym ("Indian"), the
           passport's issuing country is the country ("India"). Typed as free
           text they arrived as "IND", "indian", "Bharat" and blanks, none of
           which the desk can check a passport against. Both combos still accept
           anything typed (the list offers it back explicitly), so a passport
           from a country not in countries.js is still enterable. -->
      <div class="cl-field"><label>Nationality</label>
        <div class="cl-combo cl-combo-drop">
          <input type="text" data-field="nationality" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list" placeholder="e.g. Indian">
          <div class="cl-combo-list" data-cl-list="nationality" role="listbox"></div>
        </div></div>
      <div class="cl-field"><label>Passport no.</label>
        <input type="text" data-field="passport_number" autocomplete="off"></div>
      <div class="cl-field"><label>Issuing country</label>
        <div class="cl-combo cl-combo-drop">
          <input type="text" data-field="passport_issue_country" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list" placeholder="e.g. India">
          <div class="cl-combo-list" data-cl-list="passport_issue_country" role="listbox"></div>
        </div></div>
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
      <!-- ONE PER TRAVELLER, replacing the single party-wide box that used to
           sit at the bottom of this screen. A special request is about a
           person — this passenger needs the wheelchair, that one the bassinet —
           and the desk previously had to work out which from a paragraph. Full
           width so it does not sit as a one-line box among the short fields.

           A TEXTAREA, AND ONE FIELD ONLY. Free text, deliberately: a traveller
           asks for a wheelchair AND fifteen kilos of baggage AND a window seat,
           and a fixed set of tick boxes can only ever cover the requests we
           thought of first. One box takes every combination, in the merchant's
           own words, and it reaches the Booking Operations desk as this
           passenger's special_services entry either way. Multi-line, so the
           four separate things a merchant wants to say can be four lines.
           (No backticks in this comment — it is inside a template literal.) -->
      <div class="cl-field cl-field-full"><label>Special request</label>
        <textarea data-field="special_request" maxlength="300" rows="3"
          placeholder="Anything this traveller needs, one per line — e.g. wheelchair assistance, extra 15 kg baggage, vegetarian meal, window seat."></textarea></div>
    </div>`;
  list.appendChild(el);

  /* Re-applied after insertion rather than baked into the template above:
     setting .value works uniformly for inputs and selects, where template
     interpolation would need a different dance for each. */
  if (saved) {
    Object.entries(saved).forEach(([field, value]) => {
      if (value === null || value === undefined) return;
      const input = el.querySelector(`[data-field="${field}"]`);
      /* Skip anything that is not a plain scalar — `special_services` is an
         array and would stringify to "[object Object]" in the box that reads
         it. It is restored by name just below. */
      if (input && typeof value !== 'object') input.value = value;
    });
    /* The traveller's own special request, back out of the array it travels
       in. Written by clPassengerPayload; see clPassengerSpecialRequest. */
    const special = el.querySelector('[data-field="special_request"]');
    if (special) special.value = clReadSpecialRequest(saved.special_services);
  }

  el.querySelector('[data-cl-pax-remove]')?.addEventListener('click', () => {
    el.remove();
    clRenumberPax(list);
  });

  clBindPassengerCombos(el);
  clBindPassportLookup(el);
  /* Passport scanning (classic-passport-ocr.js). Renders nothing at all unless
     the deployment has an OCR provider configured, so a card looks exactly as
     it did before this shipped when it does not. Guarded so the booking screen
     still works if that file fails to load. */
  if (typeof clOcrAttach === 'function') clOcrAttach(el);
}

/* ================================ nationality and issuing country, searchable */

/* Both combos are the enquiry form's `clCombo` (classic-enquiry.js), which
   loads before this file and is the portal's one dropdown implementation —
   same keyboard handling, same "typing clears the pick" rule, same markup.
   Nothing is stored beyond the input's own value: unlike the city fields there
   is no code to remember, so `onPick` is a no-op and free text and a picked row
   reach clPassengerPayload by the identical route.

   `openOnFocus` on both, for the reason the airline combo has it: an empty box
   that shows nothing until you type reads as free text, and the whole point of
   the change is that these two fields have a list. */
function clBindPassengerCombos(card) {
  const wire = (field, optionsFor) => {
    const input = card.querySelector(`[data-field="${field}"]`);
    const list = card.querySelector(`[data-cl-list="${field}"]`);
    if (input && list) clCombo(input, list, optionsFor, () => {}, { openOnFocus: true });
  };
  wire('nationality', clNationalityOptions);
  wire('passport_issue_country', clCountryOptions);
}

/* The typed text, offered back as an explicit row when it matches nothing.
   Same shape as clAirlineOptions' free-text fallback and for the same reason:
   the list is what we happen to name, not what the field accepts, and a combo
   that answers "no match" reads as a refusal.

   ONLY when nothing matched, exactly as the airline combo does it. Offering it
   alongside real matches put "Use “indi” as typed" under "Indian" on the way to
   typing "Indian" — a row nobody wants, on every keystroke. A merchant whose
   answer is genuinely off-list can still simply leave it in the box: this combo
   never forces a pick, and blur keeps whatever is typed. */
function clFreeTextOption(raw) {
  return {
    value: raw,
    label: `Use “${raw}” as typed`,
    sub: 'Not on our list — we will record it as written',
    data: null,
  };
}

function clCountryOptions(query) {
  const raw = String(query || '').trim();
  const rows = (typeof searchCountries === 'function' ? searchCountries(raw, 8) : [])
    .map(r => ({ value: r.country, label: r.country, sub: r.nationality, data: null }));
  return raw && !rows.length ? [clFreeTextOption(raw)] : rows;
}

function clNationalityOptions(query) {
  const raw = String(query || '').trim();
  const rows = (typeof searchNationalities === 'function' ? searchNationalities(raw, 8) : [])
    .map(r => ({ value: r.nationality, label: r.nationality, sub: `Passport of ${r.country}`, data: null }));
  return raw && !rows.length ? [clFreeTextOption(raw)] : rows;
}

/* ================================= the traveller's own special request ====== */

/* WHERE A PER-PASSENGER REQUEST LIVES, AND WHY IT IS NOT A NEW COLUMN.
   ===========================================================================
   `PassengerInput.special_services` is a `list[dict]` that every portal has
   been posting as `[]` since it was added — it is the schema's own per-traveller
   slot, it is already returned by `PassengerResponse`, and the Booking
   Operations desk already renders it (opsPassengerCard reads `label` and
   `category`). So the field the spec asks for fits an existing shape exactly:
   no migration, no API change, and the desk sees it the day it ships.

   One entry, one shape, so a reader never has to guess which key holds the
   text. `category` is deliberately omitted — the desk's renderer joins it onto
   the label with a middot, and "Wheelchair · Special request" says nothing the
   heading above it did not. */
const CL_SPECIAL_REQUEST_CODE = 'special_request';

function clWriteSpecialRequest(text) {
  const t = String(text || '').trim();
  return t ? [{ code: CL_SPECIAL_REQUEST_CODE, label: t }] : [];
}

/* The inverse, tolerant of anything else the array may carry: a row written by
   another surface (or by a future ancillary) is read for its label rather than
   dropped, so resuming a draft never silently empties a field it cannot parse.
   Only OUR entry is editable here, and it is the one written back. */
function clReadSpecialRequest(services) {
  if (!Array.isArray(services)) return '';
  const own = services.find(s => s && s.code === CL_SPECIAL_REQUEST_CODE);
  return String(own?.label || '').trim();
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
    /* This traveller's own special request. `[]` when there is none, which is
       what every portal has always sent and what the column's array CHECK
       requires — it is never omitted. */
    special_services: clWriteSpecialRequest(get('special_request')),
  };
}

/* THE SIX-MONTH PASSPORT RULE, and the one sentence that states it.
   ===========================================================================
   Written once and used by every surface that judges an expiry — the booking
   form here, and the scan panel's own warning in classic-passport-ocr.js — so
   the merchant is never told the rule in two different forms of words.
   `CL_PASSPORT_VALIDITY_MONTHS` matches `settings.passport_validity_months`
   server-side; the server is the authority and refuses the submission, this
   only saves the round trip. */
const CL_PASSPORT_VALIDITY_MONTHS = 6;
const CL_PASSPORT_SIX_MONTH_MSG =
  'Passport must be valid for at least 6 months from the travel date.';

/* The earliest expiry that clears the rule for a given travel date, as a plain
   "YYYY-MM-DD" so it compares directly against a date input's value.

   CALENDAR MONTHS, CLAMPED — deliberately not "+183 days". 31 August plus six
   months is 28 (or 29) February, not "31 February", and JavaScript's Date would
   quietly roll that forward into March and demand a day more validity than the
   rule does. Mirrors `_add_months` in passport_ocr_service.py so the two cannot
   disagree about a month end. */
function clPassportValidUntil(travelDate, months = CL_PASSPORT_VALIDITY_MONTHS) {
  if (!travelDate) return null;
  const base = new Date(`${String(travelDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  const index = base.getMonth() + months;
  const year = base.getFullYear() + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(base.getDate(), lastDay);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* First and last name on every passenger, plus passport *details* — a number
   and an expiry with six clear months on it — when the route is international.
   No attachment is involved: a merchant can complete this screen entirely by
   typing. The offending field is focused and outlined rather than described in
   prose. Returns an error string, or null when clean. */
function clFlagMissingPassengerFields(intl, travelDate) {
  let firstBad = null;
  let problem = null;
  /* Every passport number on the form, for the cross-card duplicate pass below.
     Collected during the per-card walk because the check cannot be made inside
     it: a duplicate is a relationship between two cards, not a property of one. */
  const passports = [];
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
    } else {
      passports.push({ el: num, key: num.value.replace(/\s/g, '').toUpperCase() });
    }

    /* SIX MONTHS BEYOND THE TRAVEL DATE, not merely "after it".
       Airlines and immigration authorities almost universally refuse to carry
       on a passport with less than six months left at the point of travel, so
       a document that satisfied the old "expires after the travel date" rule
       could still be turned away at the counter — after the money had moved.
       The server enforces the same figure (ticket_service, from
       settings.passport_validity_months), and this is the copy that saves the
       merchant a round trip to find out. */
    const exp = card.querySelector('[data-field="passport_expiry"]');
    const required = clPassportValidUntil(travelDate);
    const short = exp.value && required && exp.value < required;
    mark(exp, !!short);
    if (short) {
      problem = problem || CL_PASSPORT_SIX_MONTH_MSG;
    }
  });

  /* TWO TRAVELLERS CANNOT SHARE A PASSPORT, and scanning is what made that easy
     to do by accident: one file dropped onto three passenger cards fills all
     three identically. The server refuses this too — the rule lives in
     ticket_service._validate_classic_submission and that is the one that counts
     — but a merchant should not have to press Submit to be told, so the second
     card carrying a number is outlined here the same way a missing one is.

     Normalised exactly as the server normalises it (spaces out, uppercased), so
     the two cannot disagree about whether "z1234567" and "Z123 4567" are the
     same document. */
  const seen = new Map();
  passports.forEach(({ el, key }) => {
    if (seen.has(key)) {
      mark(el, true);
      problem = problem
        || `Passport ${key} is entered for more than one traveller. Each traveller needs their own passport.`;
    } else {
      seen.set(key, el);
    }
  });

  firstBad?.focus();
  return problem;
}

/* THE CONTACT PANEL CANNOT REFUSE A BOOKING. (2026-08-07)
   ===========================================================================
   It was the one thing on this screen a merchant could not skip; then it became
   optional-but-all-or-nothing, which is not the same as optional. A merchant
   who typed a contact name and no email was still stopped — by a panel whose
   own note said it could be left blank.

   The server's rule is unchanged and cannot be worked around from here:
   `BookingContact` requires both an email and a phone whenever a contact object
   is sent at all, so a half-filled panel is not something the API can accept.
   What changed is what we DO about that. Rather than block, an incomplete or
   unusable contact is simply not attached — clContactPayload already returns
   undefined for exactly that case — and this function says so on screen, in the
   panel, so nothing is dropped silently. The booking goes through; our desk
   uses the details it holds against the account, which is what the note under
   the panel has promised all along.

   Returns nothing. It exists for the message it paints, and every caller is a
   side-effect caller — there is no failure to hand back any more. */
function clReviewContact() {
  const email = $('clBrContactEmail');
  const phone = $('clBrContactPhone');
  const alt = $('clBrContactAlt');
  const out = $('clBrContactMsg');
  if (!email || !phone || !alt) return;
  [email, phone, alt].forEach(el => {
    el.style.borderColor = '';
    el.classList.remove('cl-input-err');
  });
  if (out) { out.textContent = ''; out.className = 'cl-msg'; }

  const address = email.value.trim();
  const hasEmail = !!address;
  const hasPhone = !!clDigits(phone.value);

  // Nothing typed at all — a complete answer, and nothing to report.
  if (!hasEmail && !hasPhone && !clDigits(alt.value)) return;

  /* Everything that would make the contact unusable, gathered rather than
     returned one at a time: the merchant is being told what will happen, not
     walked through a queue of refusals. */
  const problems = [];
  if (!hasEmail || !hasPhone) {
    (hasEmail ? phone : email).classList.add('cl-input-err');
    problems.push('a contact needs both an email and a phone');
  }
  // Deliberately loose: the backend is the authority, and an over-strict
  // pattern here would reject valid addresses the desk can actually use.
  if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    email.classList.add('cl-input-err');
    problems.push('that email address does not look right');
  }
  const lengthProblem = clFlagPhoneLength(phone, 'phone number', 'clBrContactPhoneCC')
    || clFlagPhoneLength(alt, 'alternate phone number', 'clBrContactAltCC');
  if (lengthProblem) problems.push(lengthProblem);

  if (!problems.length || !out) return;
  out.className = 'cl-msg cl-msg-warn';
  out.textContent = `This contact will not be attached to the booking — ${
    problems.join(', and ')}. You can still submit: we will use the details we hold `
    + 'for your account.';
}

/* ============================================================ phone numbers */

/* THE LENGTH BELONGS TO THE COUNTRY, NOT TO THE FORM.
   ==========================================================================
   This was one constant, 10, applied to every code in the picker. That is
   right for India and wrong for most of the list beside it: a UAE mobile is 9
   digits, a Qatari or Singaporean number 8, a Maldivian one 7, a Chinese one
   11. The form refused all of them — and it refused them *after* the picker
   had been offered, which is the worst version of the mistake, because the
   merchant had just been invited to choose that country.

   The figure now comes from the selected dialling code, and there is exactly
   one source for it: `dialLengths` / `dialLengthText` / `dialLengthOk` in
   shared/countries.js, beside the codes themselves. Everything that quotes a
   length asks those — the hint, the live counter, the cap on the box, the
   read-back in clPhoneValue and the note in clReviewContact — so the field
   cannot disagree with itself the way it would if any of them kept a copy.

   Ranges exist because some countries genuinely have them (a UK landline is 9
   digits and a UK mobile 10), so "the length" is a min and a max that are
   usually equal. */

/* The sentence under the box, for whichever code is selected. */
function clPhoneHint(code) {
  return `Numbers only — ${dialLengthText(code)} digits, without the country code.`;
}

/* The dialling code a phone field's picker is holding right now.
   Falls back to the default rather than returning empty: every caller is about
   to measure a number against it, and measuring against nothing would silently
   accept anything. */
function clPhoneCode(ccId) {
  return clDigits($(ccId)?.value) || defaultDialCode();
}

/* The picker's options, with `stored` (a digits string that may already carry a
   code) deciding which is selected. */
function clDialOptions(stored) {
  const picked = splitDialCode(stored).code;
  return DIAL_CODES.map(d =>
    `<option value="${escapeHtml(d.code)}"${d.code === picked ? ' selected' : ''}>+${
      escapeHtml(d.code)} ${escapeHtml(d.country)}</option>`).join('');
}

/* Digits only, capped at the selected country's length, judged on every
   keystroke and again whenever that country changes.
   The message appears as soon as the box holds something that cannot become a
   phone number and clears itself the moment it can, so submit never says
   anything the field has not already said. Blank is silent: "you have not
   filled this in yet" is not a complaint worth making while someone is typing,
   and the whole panel is optional anyway. */
function clBindPhoneField(numId, hintId, ccId) {
  const el = $(numId);
  if (!el) return;
  /* A GETTER, NOT A NUMBER. The cap is the current country's maximum, and the
     merchant can change country after this runs — see the note on `max` in
     clDigitsOnly. Passing `dialLengths(...).max` here would freeze whichever
     country happened to be selected when the form was drawn. */
  clDigitsOnly(el, () => dialLengths(clPhoneCode(ccId)).max);

  /* A PASTED NUMBER MAY BRING ITS COUNTRY CODE WITH IT, and dropping it would
     be worse than useless — it would leave a plausible-looking wrong number.
     "+91 98765 43210" is twelve digits: the box caps at ten, so without this
     the last two would simply be cut off and the merchant would be none the
     wiser. Split instead, and move the code into the picker beside it.

     A PASTE EVENT, NOT the input handler, deliberately. The same arithmetic run
     on every keystroke would see the eleventh digit typed into a full box, find
     a leading "1", and silently reassign the number to the United States. A
     paste is the only moment a whole number arrives at once, and it is the only
     moment this should fire. Anything the split does not recognise falls
     through to the ordinary digits-only path, unchanged. */
  el.addEventListener('paste', e => {
    const pasted = clDigits(e.clipboardData?.getData('text') || '');
    if (!pasted) return;
    const split = splitDialCode(pasted);
    /* Take over only when a code was really stripped AND what is left is a
       length that country actually has. The length test is what keeps a plain
       local number safe: "9198765432" is ten digits of Indian number that
       happens to begin "91", and splitting it would leave eight — not a length
       India has — so it falls through to the ordinary digits-only path and is
       entered whole. Under the old single length this was a blunter test
       against ten, which could only ever be right for one country. */
    if (split.number === pasted) return;
    if (!dialLengthOk(split.code, split.number)) return;
    e.preventDefault();
    el.value = split.number;
    const cc = ccId && $(ccId);
    if (cc && [...cc.options].some(o => o.value === split.code)) cc.value = split.code;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const judge = () => {
    const code = clPhoneCode(ccId);
    const { min, max } = dialLengths(code);
    const digits = clDigits(el.value);
    /* Kept in step with the country, so the browser stops the merchant in the
       right place after a picker change rather than at whatever the box was
       built with. */
    el.maxLength = max;
    /* TOO LONG IS REACHABLE NOW, WHICH IT WAS NOT UNDER ONE FIXED LENGTH:
       switching from India to Qatar leaves ten digits in a box that takes
       eight. The number is deliberately NOT truncated — quietly dropping two
       digits of a number someone typed is worse than saying so — so both ends
       are checked and the counter reports whichever way it is wrong. */
    const wrong = digits.length > 0 && (digits.length < min || digits.length > max);
    el.classList.toggle('cl-input-err', wrong);
    const hint = $(hintId);
    if (!hint) return;
    hint.textContent = wrong
      ? `${digits.length} of ${dialLengthText(code)} digits.`
      : clPhoneHint(code);
    hint.classList.toggle('cl-hint-err', wrong);
  };
  el.addEventListener('input', judge);
  el.addEventListener('blur', judge);
  /* THE PICKER IS PART OF THE FIELD. Changing the country changes what counts
     as valid, so the number beside it is re-judged there and then. Without
     this, a merchant who corrects a mismatch the obvious way — by choosing the
     country the number actually belongs to — would be left staring at a red box
     and a counter quoting the old country's length.
     Not called once at bind: the field opens unmarked, as it always has, and
     the markup renders the right hint and cap for the stored code. */
  const cc = ccId && $(ccId);
  if (cc) cc.addEventListener('change', judge);
}

/* The two controls, back as the one digits string the API stores. Empty when
   the number box is empty — a country code on its own is not a phone number,
   and sending "91" would be a contact nobody can call.

   AND EMPTY WHEN THE NUMBER IS THE WRONG LENGTH FOR ITS COUNTRY, which is the
   half that keeps clReviewContact honest. That panel tells the merchant a
   mis-sized number means "this contact will not be attached"; if a seven-digit
   Indian number were sent anyway the note would be describing something that
   did not happen, and the desk would hold a number it cannot dial. The rule is
   stated in one place and obeyed in the same place — and the length it obeys
   is the selected country's, so this no longer throws away a perfectly good
   nine-digit Emirati number. */
function clPhoneValue(ccId, numId) {
  const code = clPhoneCode(ccId);
  const digits = clDigits($(numId)?.value);
  if (!digits || !dialLengthOk(code, digits)) return '';
  return `${code}${digits}`;
}

/* A length the selected country has, or nothing. Blank is always fine — both
   numbers are optional — so this only judges a value that is actually there.
   Marks the box and returns the sentence, or null.

   TAKES THE PICKER'S ID, because the answer depends on it: the same ten digits
   are a valid Indian number and an impossible Qatari one, and a version of this
   that looked only at the number box could not tell them apart.

   It does NOT move the focus. It used to, back when it was part of a refusal
   that sent the merchant to the offending box; it is now called to describe a
   contact that will not be attached, and stealing the caret out from under
   someone mid-sentence to make a remark is not the same thing at all. */
function clFlagPhoneLength(el, what, ccId) {
  if (!el) return null;
  const digits = clDigits(el.value);
  if (!digits) return null;
  const code = clPhoneCode(ccId);
  if (dialLengthOk(code, digits)) return null;
  el.classList.add('cl-input-err');
  /* A clause, not a sentence — clReviewContact joins these with "and", so a
     fragment that reads on its own inside a list is what is wanted here. */
  return `the ${what} is ${digits.length} digit${digits.length === 1 ? '' : 's'}, `
    + `not ${dialLengthText(code)}`;
}

/* Every non-digit stripped. Used both when a stored contact is rendered back
   into the boxes and when one is read out of them, so a number saved before
   these fields were digits-only ("+91 90000 00000") is shown, and re-sent, in
   the one shape the form now accepts. */
function clDigits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

/* THE WHOLE CONTACT, OR NOTHING AT ALL.
   `undefined` when the panel is blank, which merchant-api.js turns into an
   omitted `contact` key — the server then leaves whatever it holds alone. The
   alternative, sending an object of empty strings, is exactly what
   BookingContact's min_length rejects. */
function clContactPayload() {
  const name = ($('clBrContactName').value || '').trim();
  const email = ($('clBrContactEmail').value || '').trim();
  /* Country code and number rejoined — the same digits string this field has
     always sent, so nothing downstream had to change for the picker. */
  const phone = clPhoneValue('clBrContactPhoneCC', 'clBrContactPhone');
  const alt = clPhoneValue('clBrContactAltCC', 'clBrContactAlt');
  if (!email || !phone) return undefined;
  return {
    name: name || undefined,
    email,
    phone,
    alternate_phone: alt || undefined,
  };
}

async function clSubmitBookingRequest(finalize) {
  const msg = $('clBrMsg');
  const submitBtn = $('clBrSubmitBtn');
  const draftBtn = $('clBrDraftBtn');
  const enquiry = clBookingEnquiry;
  if (!enquiry) return;

  const intl = clIsInternational(enquiry);

  /* Not a gate. The contact panel is optional in full — an incomplete one is
     left off the payload and reported in the panel, and the booking proceeds.
     See clReviewContact. */
  clReviewContact();

  /* A GROUP BOOKING SENDS ITS MANIFEST ID, NOT A PASSENGER ARRAY.
     Every check below reads the traveller cards, and a group booking has none
     — its party was validated row by row when the sheet was uploaded, which is
     a stricter pass than this screen performs. Running the card checks over an
     empty list would refuse the booking for having no passengers.

     WHAT MAKES IT A GROUP IS THE TRIP TYPE, NOT THE PRESENCE OF A MANIFEST.
     It was the manifest until the upload moved to this screen — and a group
     booking that has not uploaded yet then fell through to the passenger-card
     branch and was refused with "Add at least one passenger", which is neither
     true nor actionable. The two facts are now separate: the trip type decides
     which branch runs, and a missing manifest is reported as the missing
     manifest it is. */
  const isGroup = enquiry.trip_type === 'group_trip' || !!enquiry.group_journey_type;
  const groupImportId = clResolveGroupImportId(enquiry);

  if (isGroup && !groupImportId) {
    return clMsg(msg,
      'Upload the passenger list before saving this booking. Use the Excel template '
      + 'in the Passengers panel above.', 'err');
  }

  /* A SHEET WITH BAD ROWS IS NOT A PARTY. `attach_to_request` refuses a
     less-than-valid import on the server, so this is not the guarantee — it is
     the difference between a 400 the merchant has to interpret and a sentence
     naming how many rows to fix. Checked only for an import uploaded on this
     screen: that is the only one whose validation summary is in hand, and an
     inherited or drafted manifest already passed this same gate. */
  if (isGroup && clBrGroupImport && !clBrGroupImport.can_submit) {
    return clMsg(msg,
      `${clBrGroupImport.invalid_rows} row(s) in the passenger list still need fixing. `
      + 'Correct them in the spreadsheet and upload it again.', 'err');
  }

  /* THE SHEET AND THE QUOTED PARTY SIZE ARE NOW TWO SEPARATE STATEMENTS, so
     they can disagree. Splitting the count (stated at enquiry) from the list
     (uploaded here) is the whole point of the change, and the cost of it is
     exactly this: a merchant can ask us to quote 120 seats and then upload
     three. That is a legitimate thing to do — parties shrink — but at 450,000
     quoted against 120 it is far more often a wrong file, and it is worth one
     question before the booking is raised at the quoted amount.

     The same confirmation the typed-passenger path below has asked for years,
     applied to the source a group actually uses. Skipped when the count is
     unknown (0/absent on a pre-change enquiry), because there is nothing to
     disagree with. */
  if (isGroup && clBrGroupImport && enquiry.passenger_count
      && clBrGroupImport.passengers_imported !== enquiry.passenger_count) {
    const ok = await clConfirm(
      `The enquiry was for ${enquiry.passenger_count} passenger(s) and the uploaded list `
      + `has ${clBrGroupImport.passengers_imported}. Our team will re-check availability `
      + 'for the new party size. Continue?',
      'Continue');
    if (!ok) return;
  }

  let passengers = [];
  if (!isGroup) {
    /* Passport rules bite only on submit — a half-filled draft is a legitimate
       thing to save. There is nothing else to satisfy: an international sector
       asks for passport numbers typed into the form, never for an upload, so a
       merchant who has filled the grid in can always go straight to Submit. */
    const paxProblem = clFlagMissingPassengerFields(finalize && intl, enquiry.travel_date);
    if (paxProblem) return clMsg(msg, paxProblem, 'err');

    const cards = [...$('clBrPaxList').querySelectorAll('[data-cl-pax]')];
    if (!cards.length) return clMsg(msg, 'Add at least one passenger.', 'err');

    passengers = cards.map(clPassengerPayload);

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
  }

  submitBtn.disabled = true; draftBtn.disabled = true;
  clMsg(msg, finalize ? 'Submitting for approval…' : 'Saving draft…', 'muted');

  const remarks = ($('clBrRemarks').value || '').trim();
  const contact = clContactPayload();

  /* NEITHER A BOOKING-LEVEL SPECIAL REQUEST NOR A CLIENT FARE IS READ HERE ANY
     MORE, and both absences are deliberate:

       special_requests  moved to the passenger cards, where each traveller's
                         request rides its own `special_services`. Not sent at
                         all now, so the API's optional field simply goes
                         unused by this screen.
       client_fare       stated once, on the form that describes the journey.
                         Omitting it is what makes the server keep the value the
                         enquiry carried; the direct path carries its own
                         through the itinerary payload below.

     Both fields remain on the API and on merchant-api.js's signatures — this
     screen has stopped supplying them, which is not the same as removing
     them. */

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
         because it is the only way a removed traveller actually disappears.
         A group draft skips that call entirely — its travellers came from the
         manifest and are not editable here, so there is nothing to replace. */
      if (!isGroup) await MerchantApi.replacePassengers(clBookingDraft.id, passengers);
      /* `contact ?? {}` — and the empty object is the point. Now that the panel
         may be left blank, a merchant editing a draft has to be able to REMOVE
         a contact they entered earlier, and `undefined` means "leave it alone"
         to updateDraft. An empty object is what clears it: UpdateDraftRequest
         takes a plain dict here (not BookingContact), so `{}` is accepted and
         every reader already resolves it to "no contact recorded".

         The two CREATE paths below must NOT do this — their schemas type
         `contact` as BookingContact, which requires an email and a phone, so an
         empty object would be a 422 where `undefined` is simply omitted. */
      request = await MerchantApi.updateDraft(clBookingDraft.id, { remarks, contact: contact ?? {} });
      request = request.request || request;
    } else if (clBookingDirect) {
      /* First save, direct path: the journey goes up with the travellers,
         because there is no enquiry holding it. Same two-step shape as below —
         this creates the draft, /submit is still what reaches the desk.

         `clBookingDirect` is spread untouched: it already carries the client
         fare the Book Directly form collected, and the line that used to
         overwrite it from this screen went with that screen's fare panel. */
      request = await MerchantApi.createDirectBooking(clBookingDirect, {
        passengers, remarks, contact, international: intl,
        groupImportId: groupImportId,
      });
    } else {
      /* First save: creates the draft against the enquiry. Only /submit puts
         it in front of the approvals team. No client fare is sent, so the
         server keeps the one the enquiry recorded. */
      request = await MerchantApi.enquiryToBookingRequest(enquiry.id, {
        passengers, remarks, contact, international: intl,
        groupImportId: groupImportId,
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

  /* The passenger rows exist now, so any passport scan that filled this form
     can be told which booking and traveller it became — and which of its values
     the merchant changed on the way. Deliberately after the save and outside
     its error handling: the audit is about the scan, and a booking the server
     has already accepted must never be reported as a failure because an audit
     write did not land. `clOcrRecordEdits` swallows its own errors too. */
  if (typeof clOcrRecordEdits === 'function') {
    clSyncPassengerIds(request.passengers);
    clOcrRecordEdits(
      [...$('clBrPaxList').querySelectorAll('[data-cl-pax]')],
      request.id,
    );
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
