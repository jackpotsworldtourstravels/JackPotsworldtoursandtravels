'use strict';
/* Classic — Hotel Booking Request.
   ===========================================================================
   Hotel's equivalent of classic-booking.js. Reached two ways, same as
   Flight's screen: Raise Booking on a quoted (Approved) hotel enquiry, or
   Book Directly with no enquiry at all (classic-enquiry.js/
   classic-enquiry-hotel.js -> clStartDirectHotelBooking below). Same shape
   either way —

     1. Stay        already quoted (or entered by you, if direct), read-only here
     2. Guests       the only thing still to enter
     3. Submit       goes to the approvals desk

   — but genuinely simpler than the flight screen, because a hotel booking has
   none of what makes that one long: no international/passport branching, no
   group-manifest upload, no OCR. What is entered here is who is staying and
   which room they are in, and that is it.

   THE GUEST SLOTS ARE FIXED, NOT ADDED. Flight's passenger grid lets the
   merchant add or remove a card; this one cannot, because the room/child
   composition was already fixed before this screen — either quoted by the
   desk, or entered by the merchant on the Book Directly form a moment ago —
   and a booking with a different count would not be the stay that was
   priced. So this screen renders one card per adult and per child that
   composition calls for (backend: hotel_booking_service's guest-composition
   check enforces the same count server-side, against the enquiry's rooms or
   the direct payload's rooms as appropriate) and only takes a name, a title,
   an ID proof and — once, across the whole booking — which guest is the
   lead.

   Submitting is still two calls, same order as Flight's:
     POST /api/hotel/enquiries/{id}/booking-request  -> enquiry-led draft, with guests
     POST /api/hotel/bookings/direct                 -> direct draft, with guests
     POST /api/requests/{id}/submit                  -> in front of the desk
   Saving without submitting is a legitimate outcome, so Save as draft stops
   after the first — identical contract to Flight's screen. */

/* The hotel enquiry (or direct-booking stand-in — see
   clStartDirectHotelBooking) this screen is currently working from. Set by
   clStartHotelBookingRequest, which clRequestHotelBooking (classic-enquiry.js)
   calls just before navigating here. */
let clHotelBookingEnquiry = null;
/* The saved draft, once one exists — null until Save as draft (or a resume).
   Its presence is what routes the next save to update rather than create. */
let clHotelBookingDraft = null;
/* The direct-booking stay payload, set only on the direct path — mirrors
   clBookingDirect (classic-booking.js). Null on the enquiry-led path and
   once a draft exists (the server holds it from then on). */
let clHotelBookingDirect = null;

function clStartHotelBookingRequest(enquiry, draft = null) {
  clHotelBookingEnquiry = enquiry;
  clHotelBookingDraft = draft;
  clHotelBookingDirect = null;
}

/* Book Directly's entry point — mirrors clStartDirectBooking
   (classic-booking.js:100-136) exactly. No server call: the stay payload is
   held here and Booking Request collects the guests, then creates the
   booking in one call — abandoning the form halfway leaves nothing behind,
   same reasoning as Flight's own direct path.

   Computes rooms_count/adults_total/children_total/nights up front because
   clHotelRoomsGuestsLabel and the Stay panel read those, not the raw rooms
   array — without them the Stay panel would silently show "0 Rooms ·
   0 Adults" instead of the real composition. */
function clStartDirectHotelBooking(payload) {
  clHotelBookingDirect = payload;
  clHotelBookingDraft = null;
  const roomsCount = payload.rooms.length;
  const adultsTotal = payload.rooms.reduce((s, r) => s + r.adults, 0);
  const childrenTotal = payload.rooms.reduce((s, r) => s + r.children, 0);
  const nights = Math.round(
    (new Date(`${payload.check_out}T00:00:00`) - new Date(`${payload.check_in}T00:00:00`)) / 86400000
  );
  clHotelBookingEnquiry = {
    id: null,
    direct_booking: true,
    reference_number: null,
    quoted_fare: null,
    quotation_remarks: null,
    admin_response: null,
    destination_city: payload.destination_city,
    hotel_name: payload.hotel_name,
    star_category: payload.star_category,
    room_type: payload.room_type,
    meal_plan: payload.meal_plan,
    preferred_location: payload.preferred_location,
    travel_date: payload.check_in,
    return_date: payload.check_out,
    nights,
    rooms: payload.rooms,
    rooms_count: roomsCount,
    adults_total: adultsTotal,
    children_total: childrenTotal,
  };
  clLoaded.delete('hotel-booking-request');
  clGo('hotel-booking-request');
}

/* Reopen a saved draft on this screen — mirrors clResumeBookingDraft
   (classic-booking.js:152-188) exactly, including how it derives
   quoted_fare: from booking.total_amount, never from a `quoted_fare` key in
   travel_details, because a direct booking's travel_details never carries
   one (only an enquiry-led booking's does, and even then only until this
   function ignores it in favour of the authoritative total_amount). Called
   from classic-requests.js's clContinueBookingDraft once it knows the draft
   is a hotel booking, not a flight one. */
function clResumeHotelBookingDraft(booking, detail = null) {
  const d = booking.details || {};
  clHotelBookingDirect = null;          // the server holds it now; nothing to send
  clHotelBookingDraft = booking;
  const rooms = d.rooms || [];
  clHotelBookingEnquiry = {
    id: null,
    direct_booking: !!d.direct_booking,
    reference_number: d.hotel_enquiry_reference || null,
    quoted_fare: Number(booking.total_amount) > 0 ? booking.total_amount : null,
    quotation_remarks: null,
    admin_response: null,
    destination_city: d.destination_city,
    hotel_name: d.hotel_name,
    star_category: d.star_category,
    room_type: d.room_type,
    meal_plan: d.meal_plan,
    preferred_location: d.preferred_location,
    travel_date: booking.travel_date,
    return_date: booking.return_date,
    nights: d.nights ?? null,
    rooms,
    rooms_count: rooms.length,
    adults_total: rooms.reduce((s, r) => s + (r.adults || 0), 0),
    children_total: rooms.reduce((s, r) => s + (r.children || 0), 0),
  };
  clLoaded.delete('hotel-booking-request');
  clGo('hotel-booking-request');
}

function clInitHotelBookingRequest() {
  if (!clHotelBookingEnquiry) return clRenderNoHotelEnquiry();
  clRenderHotelBookingForm(clHotelBookingEnquiry);
}

/* No enquiry AND no direct payload in hand — a cold #hotel-booking-request
   deep link, or a page reload mid-flow. There is nothing to resume from: a
   hotel booking only ever starts from Raise Booking on an enquiry row or
   from Book Directly, so the one useful thing this screen can do is send
   the merchant back to where either of those lives. */
function clRenderNoHotelEnquiry() {
  $('cl-hotel-booking-request').innerHTML = `
    <div class="cl-page-head"><div><h1>Hotel Booking Request</h1></div></div>
    <div class="cl-panel">
      <div class="cl-panel-body">
        <div class="cl-msg cl-msg-muted" style="margin-top:0">
          Open this from <b>Raise Booking</b> on a quoted hotel enquiry.
        </div>
        <button type="button" class="cl-btn cl-btn-primary" id="clHbToEnquiry">Go to Booking Enquiry</button>
      </div>
    </div>`;
  $('clHbToEnquiry').addEventListener('click', () => clGo('enquiry'));
}

/* One row per guest the enquiry's room/child composition requires, in room
   order, adults before children within a room — the same order the enquiry's
   own Rooms & Guests popover collects them in. `savedGuests` (from a resumed
   draft) are matched by (room_number, kind), in the order they were saved,
   so editing a draft does not reshuffle who was already typed in. */
function clHotelSeedGuestSlots(e, savedGuests) {
  const pool = [...(savedGuests || [])];
  const takeSaved = (room, kind) => {
    const i = pool.findIndex(g => g.room_number === room && g.guest_type === kind);
    return i >= 0 ? pool.splice(i, 1)[0] : null;
  };
  const slots = [];
  (e.rooms || []).forEach((room, ri) => {
    const roomNumber = ri + 1;
    for (let i = 0; i < room.adults; i++) {
      slots.push({ room: roomNumber, kind: 'adult', age: null, saved: takeSaved(roomNumber, 'adult') });
    }
    (room.child_ages || []).forEach(age => {
      slots.push({ room: roomNumber, kind: 'child', age, saved: takeSaved(roomNumber, 'child') });
    });
  });
  return slots;
}

function clRenderHotelBookingForm(e) {
  /* No enquiry in front of this booking. Changes what the page SAYS — where
     the stay came from, what step 1 and 2 were, and when the fare gets
     named — and nothing about what it COLLECTS. Guests, contact and the
     room composition are identical either way, same reasoning Flight's own
     clRenderBookingForm already documents for its `direct` branch. */
  const direct = !!e.direct_booking;
  const contact = (clHotelBookingDraft?.details?.contact) || {};
  const phoneCode = splitDialCode(contact.phone).code;
  const altCode = splitDialCode(contact.alternate_phone).code;
  const slots = clHotelSeedGuestSlots(e, clHotelBookingDraft?.hotel_guests);

  $('cl-hotel-booking-request').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Hotel Booking Request</h1>
        <p>${direct
          ? 'Direct booking — review the stay you entered, then add guest details. '
            + 'Names must match the ID presented at check-in.'
          : `From enquiry <b class="cl-ref">${escapeHtml(e.reference_number)}</b> — review the stay,
             then enter guest details. Names must match the ID presented at check-in.`}</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clHbCancel">Discard</button>
      </div>
    </div>

    <div class="cl-stepper">
      <div class="cl-step done"><b>1. Stay</b>${direct
        ? 'Entered by you' : escapeHtml(e.reference_number)}</div>
      <div class="cl-step done"><b>2. ${direct ? 'Fare' : 'Quoted'}</b>${direct
        ? 'Named at voucher issuance'
        : (e.quoted_fare != null ? escapeHtml(moneyStr(e.quoted_fare)) : 'Available to book')}</div>
      <div class="cl-step current"><b>3. Guests</b>Enter details</div>
      <div class="cl-step"><b>4. Approval</b>Sign-off on this booking</div>
      <div class="cl-step"><b>5. Voucher</b>Settled from your wallet</div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Hotel Stay</h2>
        <div class="cl-panel-tools">
          <!-- Only when there is an enquiry to open. Null on the direct
               path, and also on a draft resumed from My Requests, which is
               rebuilt from the booking rather than from the enquiry. -->
          ${e.id != null
            ? '<button type="button" class="cl-btn cl-btn-sm" id="clHbViewEnquiry">View enquiry</button>'
            : ''}
        </div>
      </div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Destination</dt><dd>${escapeHtml(e.destination_city || '—')}</dd></div>
          <div><dt>Hotel</dt><dd>${escapeHtml(e.hotel_name || '—')}</dd></div>
          <div><dt>Star category</dt><dd>${e.star_category ? `${escapeHtml(e.star_category)} Star` : '—'}</dd></div>
          <div><dt>Room type</dt><dd>${escapeHtml(e.room_type || '—')}</dd></div>
          <div><dt>Meal plan</dt><dd>${escapeHtml(
            CL_MEAL_PLANS.find(m => m.value === e.meal_plan)?.label || e.meal_plan || '—')}</dd></div>
          <div><dt>Check-in</dt><dd>${escapeHtml(fmtDate(e.travel_date))}</dd></div>
          <div><dt>Check-out</dt><dd>${escapeHtml(fmtDate(e.return_date))}</dd></div>
          <div><dt>Nights</dt><dd>${e.nights ?? '—'}</dd></div>
          <div><dt>Rooms</dt><dd>${escapeHtml(clHotelRoomsGuestsLabel(e))}</dd></div>
          ${e.preferred_location ? `<div><dt>Preferred location</dt><dd>${escapeHtml(e.preferred_location)}</dd></div>` : ''}
        </dl>
      </div>
      ${e.quoted_fare != null ? `<div class="cl-panel-note">
        <b>Quoted fare:</b> <b style="font-size:15px;">${escapeHtml(moneyStr(e.quoted_fare))}</b>
        ${e.quotation_remarks
          ? `<div style="white-space:pre-wrap;margin-top:4px;">${escapeHtml(e.quotation_remarks)}</div>` : ''}
        <div style="margin-top:4px;">This booking is raised at that amount, and it is settled
          from your wallet once the voucher is issued.</div>
      </div>` : ''}
      <div class="cl-panel-note">
        ${direct
          ? `This is the stay you entered and it cannot be changed here. Discard this booking
             and start again if it needs to change — nothing has been raised yet.`
          : `These details come from the enquiry and cannot be changed here — they are what our team
             quoted. Raise a new enquiry if the stay needs to change.`}
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Contact for this booking</h2></div>
      <div class="cl-panel-body">
        <div class="cl-form cl-form-2">
          <div class="cl-field">
            <label for="clHbContactName">Contact name</label>
            <input type="text" id="clHbContactName" maxlength="120"
              value="${escapeHtml(contact.name || '')}" placeholder="Who we should ask for">
          </div>
          <div class="cl-field">
            <label for="clHbContactEmail">Email</label>
            <input type="email" id="clHbContactEmail" maxlength="255"
              value="${escapeHtml(contact.email || '')}" placeholder="bookings@yourcompany.com">
          </div>
          <div class="cl-field">
            <label for="clHbContactPhone">Phone</label>
            <div class="cl-phone">
              <select id="clHbContactPhoneCC" class="cl-phone-cc"
                aria-label="Country code for the phone number">${clDialOptions(contact.phone)}</select>
              <input type="tel" id="clHbContactPhone" class="cl-phone-num"
                maxlength="${dialLengths(phoneCode).max}" inputmode="numeric" autocomplete="tel-national"
                value="${escapeHtml(splitDialCode(contact.phone).number)}">
            </div>
            <small id="clHbContactPhoneHint">${clPhoneHint(phoneCode)}</small>
          </div>
          <div class="cl-field">
            <label for="clHbContactAlt">Alternate phone</label>
            <div class="cl-phone">
              <select id="clHbContactAltCC" class="cl-phone-cc"
                aria-label="Country code for the alternate phone number">${clDialOptions(contact.alternate_phone)}</select>
              <input type="tel" id="clHbContactAlt" class="cl-phone-num"
                maxlength="${dialLengths(altCode).max}" inputmode="numeric" autocomplete="tel-national"
                value="${escapeHtml(splitDialCode(contact.alternate_phone).number)}" placeholder="Optional">
            </div>
            <small id="clHbContactAltHint">${clPhoneHint(altCode)}</small>
          </div>
        </div>
        <div class="cl-msg" id="clHbContactMsg"></div>
      </div>
      <div class="cl-panel-note">
        One contact for the whole party — this is who our team and the hotel reach about the
        stay, so it should be a monitored address and number. Optional: leave it blank and we
        will use the details we hold for your account.
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Guests</h2></div>
      <div class="cl-panel-body" id="clHbGuestList"></div>
      <div class="cl-panel-note">
        First and last name are required for every guest, and exactly one guest across the whole
        booking must be marked as the lead guest — that is who the hotel checks the reservation
        in against. Room and age are fixed to what was quoted and cannot be changed here.
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-body">
        <div class="cl-field">
          <label for="clHbRemarks">Remarks for our team</label>
          <textarea id="clHbRemarks" maxlength="1000"
            placeholder="Anything specific to this booking — early arrival, adjoining rooms…">${
              escapeHtml(clHotelBookingDraft?.remarks || '')}</textarea>
        </div>
        <div class="cl-field">
          <label for="clHbClientFare">Client Fare (INR)</label>
          <input type="text" id="clHbClientFare" inputmode="decimal" autocomplete="off"
            placeholder="e.g. 20,000"
            value="${escapeHtml(clFormatMoneyInput(clHotelBookingDraft?.client_fare ?? ''))}">
          <small>What you have quoted your customer. Optional — leave it blank to keep the enquiry's
            value, if one was entered there.</small>
        </div>
        <div class="cl-form-actions">
          <button type="button" class="cl-btn cl-btn-primary" id="clHbSubmitBtn"
            ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Submit for approval</button>
          <button type="button" class="cl-btn" id="clHbDraftBtn"
            ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Save as draft</button>
          <span class="cl-kpi-sub">Saving a draft is optional — you can submit straight away.
            A draft stays in My Requests and can be submitted later.</span>
        </div>
        <div class="cl-msg" id="clHbMsg"></div>
      </div>
      <div class="cl-panel-note">
        ${e.quoted_fare != null
          ? `Submitting commits you to the quoted <b>${escapeHtml(moneyStr(e.quoted_fare))}</b>.
             It is checked against your credit limit when you submit and again when it is
             approved, and settled from your wallet once the voucher is issued.`
          : `This enquiry was answered before fares were quoted, so it carries no amount yet —
             our team confirms the payable amount when the voucher is issued.`}
      </div>
    </div>`;

  const list = $('clHbGuestList');
  list.innerHTML = '';
  slots.forEach((slot, i) => list.appendChild(clHotelGuestCard(slot, i)));

  clBindPhoneField('clHbContactPhone', 'clHbContactPhoneHint', 'clHbContactPhoneCC');
  clBindPhoneField('clHbContactAlt', 'clHbContactAltHint', 'clHbContactAltCC');
  ['clHbContactEmail', 'clHbContactPhone', 'clHbContactAlt'].forEach(id => {
    $(id)?.addEventListener('blur', clHbReviewContact);
  });
  ['clHbContactPhoneCC', 'clHbContactAltCC'].forEach(id => {
    $(id)?.addEventListener('change', clHbReviewContact);
  });

  clBindMoneyField($('clHbClientFare'));

  $('clHbViewEnquiry')?.addEventListener('click', () => clOpenEnquiryDetail(`hotel:${e.id}`));
  $('clHbCancel').addEventListener('click', async () => {
    /* Worth naming what survives — mirrors clBrCancel (classic-booking.js).
       On the direct path nothing has been created yet, so discarding really
       does throw the typing away; once a draft exists — either path — it
       stays in My Requests and only this screen is being left. */
    const question = clHotelBookingDraft
      ? `Leave this booking request? ${clHotelBookingDraft.request_number} stays as a draft in My Requests.`
      : (direct
        ? 'Discard this booking? The stay and guests you entered will be lost — nothing has been raised yet.'
        : 'Discard this booking request and return to Booking Enquiry?');
    if (!await clConfirm(question, clHotelBookingDraft ? 'Leave' : 'Discard')) return;
    const hadDraft = !!clHotelBookingDraft;
    clHotelBookingEnquiry = null; clHotelBookingDraft = null; clHotelBookingDirect = null;
    clLoaded.delete('hotel-booking-request');
    clGo(hadDraft ? 'requests' : 'enquiry');
  });
  $('clHbSubmitBtn').addEventListener('click', () => clSubmitHotelBookingRequest(true));
  $('clHbDraftBtn').addEventListener('click', () => clSubmitHotelBookingRequest(false));
}

/* One guest card: title/first/last name, a fixed room+age line, ID proof, and
   the one lead-guest radio shared across every card on the screen (`name`
   makes the browser enforce "exactly one" for free, before any server round
   trip). Room and age are text, not inputs — see the module docstring for why
   they cannot be edited on this screen. */
function clHotelGuestCard(slot, index) {
  const el = document.createElement('div');
  el.dataset.clGuest = String(index);
  el.dataset.room = String(slot.room);
  el.dataset.kind = slot.kind;
  if (slot.age != null) el.dataset.age = String(slot.age);
  el.style.cssText = 'padding:10px 0;border-top:1px solid var(--cl-border-color);';
  if (index === 0) el.style.borderTop = 'none';
  const saved = slot.saved || {};
  // Resuming a draft: whichever guest was actually marked lead when it was
  // saved. A fresh form has no lead yet, so the first card defaults to it —
  // the radio still lets the merchant move it before submitting.
  const isLead = slot.saved ? !!saved.is_lead_guest : index === 0;
  /* READ-ONLY WHEN RESUMING A SAVED DRAFT. There is no endpoint yet that
     replaces a booking's guests the way replacePassengers does for Flight
     (Phase 1 scope) — clSubmitHotelBookingRequest's update path only sends
     remarks/contact/client fare. Rendering these editable on a resumed draft
     would let a merchant retype a name, watch it "save", and never have it
     actually sent — silent data loss. Disabled with a reason instead, same
     posture as Flight's read-only group-passenger cards. */
  const locked = !!slot.saved;
  const dis = locked ? 'disabled' : '';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;flex-wrap:wrap;">
      <b style="font-size:12px;">Room ${slot.room} — ${slot.kind === 'adult' ? 'Adult' : `Child, age ${slot.age}`}</b>
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;font-weight:600;margin-left:auto;">
        <input type="radio" name="clHbLead" data-field="is_lead_guest" ${isLead ? 'checked' : ''} ${dis}
          ${locked && isLead ? 'data-cl-lead-locked="1"' : ''}>Lead guest
      </label>
    </div>
    <div class="cl-form">
      <div class="cl-field" style="max-width:88px;">
        <label>Title</label>
        <select data-field="title" ${dis}>${['', ...CL_TITLES_OPTS].map(t =>
          `<option value="${t}"${t === (saved.title || '') ? ' selected' : ''}>${t || '—'}</option>`).join('')}</select>
      </div>
      <div class="cl-field"><label>First name<span class="cl-req">*</span></label>
        <input type="text" data-field="first_name" autocomplete="off" ${dis}
          value="${escapeHtml(saved.first_name || '')}"></div>
      <div class="cl-field"><label>Last name<span class="cl-req">*</span></label>
        <input type="text" data-field="last_name" autocomplete="off" ${dis}
          value="${escapeHtml(saved.last_name || '')}"></div>
      <div class="cl-field"><label>ID proof type</label>
        <select data-field="id_proof_type" ${dis}>
          <option value="">—</option>
          ${['Aadhaar', 'Passport', 'Driving Licence', 'Voter ID', 'PAN', 'Other'].map(t =>
            `<option value="${t}"${t === (saved.id_proof_type || '') ? ' selected' : ''}>${t}</option>`).join('')}
        </select></div>
      <div class="cl-field"><label>ID proof number</label>
        <input type="text" data-field="id_proof_number" autocomplete="off" maxlength="60" ${dis}
          value="${escapeHtml(saved.id_proof_number || '')}"></div>
    </div>
    ${locked ? '<div class="cl-kpi-sub" style="margin-top:4px;">Saved with this draft — guest details cannot be edited here yet.</div>' : ''}`;
  return el;
}

/* Mirrors clReviewContact (classic-booking.js) against this screen's own
   `clHb*` field ids — not shared with it directly, because the two forms are
   two separate DOM subtrees and a shared function hardcoded to one set of ids
   would silently do nothing on the other. Every helper it calls
   (clDigits, clFlagPhoneLength, clPhoneCode, dialLengthOk…) already takes its
   target by id/element, so only the id-specific outer shell is duplicated. */
function clHbReviewContact() {
  const email = $('clHbContactEmail');
  const phone = $('clHbContactPhone');
  const alt = $('clHbContactAlt');
  const out = $('clHbContactMsg');
  if (!email || !phone || !alt) return;
  [email, phone, alt].forEach(el => { el.style.borderColor = ''; el.classList.remove('cl-input-err'); });
  if (out) { out.textContent = ''; out.className = 'cl-msg'; }

  const address = email.value.trim();
  const hasEmail = !!address;
  const hasPhone = !!clDigits(phone.value);
  if (!hasEmail && !hasPhone && !clDigits(alt.value)) return;

  const problems = [];
  if (!hasEmail || !hasPhone) {
    (hasEmail ? phone : email).classList.add('cl-input-err');
    problems.push('a contact needs both an email and a phone');
  }
  if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    email.classList.add('cl-input-err');
    problems.push('that email address does not look right');
  }
  const lengthProblem = clFlagPhoneLength(phone, 'phone number', 'clHbContactPhoneCC')
    || clFlagPhoneLength(alt, 'alternate phone number', 'clHbContactAltCC');
  if (lengthProblem) problems.push(lengthProblem);

  if (!problems.length || !out) return;
  out.className = 'cl-msg cl-msg-warn';
  out.textContent = `This contact will not be attached to the booking — ${
    problems.join(', and ')}. You can still submit: we will use the details we hold `
    + 'for your account.';
}

function clHbContactPayload() {
  const name = ($('clHbContactName').value || '').trim();
  const email = ($('clHbContactEmail').value || '').trim();
  const phone = clPhoneValue('clHbContactPhoneCC', 'clHbContactPhone');
  const alt = clPhoneValue('clHbContactAltCC', 'clHbContactAlt');
  if (!name && !email && !phone && !alt) return undefined;
  if (!email || !phone) return undefined;   // BookingContact needs both — see clHbReviewContact
  return { name: name || undefined, email, phone, alternate_phone: alt || undefined };
}

/* Reads every guest card into the shape HotelGuestInput takes. */
function clHotelGuestPayload() {
  return [...$('clHbGuestList').querySelectorAll('[data-cl-guest]')].map(card => {
    const field = f => card.querySelector(`[data-field="${f}"]`)?.value?.trim() || null;
    return {
      room_number: Number(card.dataset.room),
      guest_type: card.dataset.kind,
      age: card.dataset.age != null ? Number(card.dataset.age) : null,
      is_lead_guest: !!card.querySelector('[data-field="is_lead_guest"]')?.checked,
      title: field('title') || null,
      first_name: field('first_name') || '',
      last_name: field('last_name') || '',
      id_proof_type: field('id_proof_type'),
      id_proof_number: field('id_proof_number'),
    };
  });
}

async function clSubmitHotelBookingRequest(finalize) {
  const msg = $('clHbMsg');
  const submitBtn = $('clHbSubmitBtn');
  const draftBtn = $('clHbDraftBtn');
  const enquiry = clHotelBookingEnquiry;
  if (!enquiry) return;

  clHbReviewContact();

  const guests = clHotelGuestPayload();
  const missingName = guests.find(g => !g.first_name || !g.last_name);
  if (missingName) return clMsg(msg, 'Every guest needs a first and last name.', 'err');
  if (guests.filter(g => g.is_lead_guest).length !== 1) {
    return clMsg(msg, 'Mark exactly one guest as the lead guest.', 'err');
  }

  submitBtn.disabled = true; draftBtn.disabled = true;
  clMsg(msg, finalize ? 'Submitting for approval…' : 'Saving draft…', 'muted');

  const remarks = ($('clHbRemarks').value || '').trim();
  const contact = clHbContactPayload();
  const clientFare = clParseMoney($('clHbClientFare').value);

  /* THREE try BLOCKS — see clSubmitBookingRequest (classic-booking.js) for
     why: create, submit and the cosmetic refresh fail in different ways and
     must be reported differently, so a throw from any bookkeeping after a
     successful save is never mistaken for the save itself failing. */
  let request;
  try {
    if (clHotelBookingDraft) {
      request = await MerchantApi.updateDraft(clHotelBookingDraft.id, { remarks, contact: contact ?? {}, clientFare });
    } else if (clHotelBookingDirect) {
      request = await MerchantApi.createDirectHotelBooking(clHotelBookingDirect, {
        guests, remarks, contact, clientFare,
      });
    } else {
      request = await MerchantApi.createHotelBookingFromEnquiry(enquiry.id, {
        guests, remarks, contact, clientFare,
      });
    }
    request = request.request || request;
  } catch (err) {
    clMsg(msg, clError(err, 'Could not raise the booking request.'), 'err');
    submitBtn.disabled = false; draftBtn.disabled = false;
    return;
  }

  clHotelBookingDraft = request;

  if (finalize) {
    try {
      await MerchantApi.submitRequest(request.id);
    } catch (err) {
      clMsg(msg, clError(err,
        `${request.request_number} was saved as a draft, but could not be submitted.`), 'err');
      draftBtn.textContent = 'Save changes';
      submitBtn.disabled = false; draftBtn.disabled = false;
      return;
    }
  }

  try {
    if (finalize) {
      clHotelBookingSubmitted(request.request_number, enquiry.reference_number);
    } else {
      clMsg(msg, `Draft saved — ${request.request_number}. `
        + 'Submit it here or from My Requests when ready.', 'ok');
      draftBtn.textContent = 'Save changes';
    }
    clInvalidate('dashboard', 'enquiry', 'requests', 'booking-history',
      'payments', 'service-request', 'reports');
    clLoadUnreadCount();
  } catch (err) {
    console.error('Hotel booking request went through, but this screen could not be updated', err);
    if (!finalize) {
      clMsg(msg, `Draft saved — ${request.request_number}. `
        + 'Reload the page if this screen looks out of date.', 'ok');
      draftBtn.textContent = 'Save changes';
    }
  }

  if (!finalize) {
    submitBtn.disabled = false;
    draftBtn.disabled = false;
  }
}

/* An explicit confirmation screen, not a toast — the request number is the
   one thing the merchant needs to write down, so it must not disappear on a
   timer. Mirrors clBookingSubmitted (classic-booking.js). */
function clHotelBookingSubmitted(requestNumber, enquiryReference) {
  $('cl-hotel-booking-request').innerHTML = `
    <div class="cl-page-head"><div>
      <h1>Submitted for approval</h1>
      <p>Request <b class="cl-ref">${escapeHtml(requestNumber)}</b> is with our team.</p>
    </div></div>
    <div class="cl-panel">
      <div class="cl-panel-body">
        <div class="cl-msg cl-msg-ok" style="margin-top:0">
          <!-- A direct booking has no enquiry to name and no quoted amount to
               promise, so it gets its own sentence rather than an empty <b>
               and a figure that does not exist yet. -->
          Request <b>${escapeHtml(requestNumber)}</b>${enquiryReference
            ? `, raised from hotel enquiry <b>${escapeHtml(enquiryReference)}</b>,` : ''}
          has been submitted for approval. Track it in My Requests; ${enquiryReference
            ? 'the quoted amount is settled from your wallet when the voucher is issued.'
            : 'our team confirms the fare when the voucher is issued, and that amount is settled '
              + 'from your wallet then.'}
        </div>
        <div class="cl-form-actions">
          <button type="button" class="cl-btn cl-btn-primary" id="clHbDoneList">View My Requests</button>
          <!-- Offers back the route just taken. Someone who booked directly is
               more likely to book directly again than to switch to enquiring. -->
          <button type="button" class="cl-btn" id="clHbDoneNew">${enquiryReference
            ? 'New booking enquiry' : 'Book another directly'}</button>
        </div>
      </div>
    </div>`;
  const again = !enquiryReference;
  $('clHbDoneList').addEventListener('click', () => {
    clHotelBookingEnquiry = null; clHotelBookingDraft = null; clHotelBookingDirect = null;
    clLoaded.delete('hotel-booking-request'); clGo('requests');
  });
  $('clHbDoneNew').addEventListener('click', () => {
    clHotelBookingEnquiry = null; clHotelBookingDraft = null; clHotelBookingDirect = null;
    clLoaded.delete('hotel-booking-request');
    clGo('enquiry', () => clOpenEnquiryForm(again));
  });
}
