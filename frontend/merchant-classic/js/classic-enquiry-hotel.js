'use strict';
/* Classic — Hotel Enquiry.
   ===========================================================================
   The Hotel branch of the New Booking Enquiry form. Loaded alongside
   classic-enquiry.js and sharing its state and primitives — `clEnqForm`,
   `clOpenModal`/`clCloseModal`, `clCombo`, `clCityOptions`, `clPickerOnly`,
   `clMsg`, `clFreeTextPlace`, `clTodayIso`/`clAddDays`, `clEnquiryError` —
   rather than duplicating any of them. Flight logic in classic-enquiry.js is
   untouched; this file only adds the second option under Enquiry Type.

   Backed by its own tables (`hotel_enquiries`/`hotel_enquiry_rooms`/
   `hotel_room_children`, backend migration 0047), not the flight side's
   `service_requests` row — see `backend/app/services/hotel_enquiry_service.py`.
   Rooms & guests are a structured, validated array — never free text. */

const CL_STAR_CATEGORIES = [
  { value: '3', label: '3 Star' },
  { value: '4', label: '4 Star' },
  { value: '5', label: '5 Star' },
];
const CL_MEAL_PLANS = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'half_board', label: 'Half Board' },
  { value: 'full_board', label: 'Full Board' },
];
const CL_CHILD_MAX_AGE = 17;
/* No ceiling is stated in the spec. A soft cap keeps the popover — and the
   request body — sane rather than expressing a business rule; raise it here
   if a legitimate booking ever needs more. */
const CL_MAX_ROOMS = 9;
const CL_MAX_ROOM_GUESTS = 20;

const CL_PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/* ============================================================ the form ==== */

function clHotelFormFields() {
  return `
    <div class="cl-form-legend">Stay Details</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field cl-field-full">
        <label for="clHtlDest">Destination City<span class="cl-req">*</span></label>
        <div class="cl-combo">
          <input type="text" id="clHtlDest" autocomplete="off" role="combobox"
                 aria-expanded="false" aria-autocomplete="list"
                 placeholder="Dubai, Singapore, Colombo, Bangkok, Maldives…">
          <div class="cl-combo-list" id="clHtlDestList" role="listbox"></div>
        </div>
      </div>
      <div class="cl-field">
        <label for="clHtlCheckIn">Check-in<span class="cl-req">*</span></label>
        <input type="date" id="clHtlCheckIn">
      </div>
      <div class="cl-field">
        <label for="clHtlCheckOut">Check-out<span class="cl-req">*</span></label>
        <input type="date" id="clHtlCheckOut">
        <small id="clHtlDateHint">On or after check-in, at least one night.</small>
      </div>
      <div class="cl-field">
        <label>Nights</label>
        <!-- Read-only and derived — the dates are the source of truth, never
             something the merchant works out by hand. -->
        <input type="text" id="clHtlNights" value="—" readonly>
      </div>
    </div>

    <div class="cl-form-legend">Rooms &amp; Guests</div>
    <div class="cl-form">
      <div class="cl-field cl-field-full">
        <label for="clRgTrigger">Rooms &amp; Guests<span class="cl-req">*</span></label>
        <div class="cl-rg">
          <button type="button" class="cl-rg-trigger" id="clRgTrigger"
                  aria-haspopup="true" aria-expanded="false">
            <span id="clRgSummaryText">1 Room · 1 Adult</span>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="cl-rg-pop" id="clRgPopover" role="dialog" aria-label="Rooms and guests"></div>
        </div>
      </div>
    </div>

    <div class="cl-form-legend">Hotel Preferences</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clHtlName">Hotel Name</label>
        <input type="text" id="clHtlName" maxlength="200" placeholder="Enter hotel name if preferred">
      </div>
      <div class="cl-field">
        <label for="clHtlStar">Star Category<span class="cl-req">*</span></label>
        <select id="clHtlStar">
          <option value="">Select…</option>
          ${CL_STAR_CATEGORIES.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="cl-field">
        <label for="clHtlRoomType">Room Type</label>
        <input type="text" id="clHtlRoomType" maxlength="120"
               placeholder="e.g. Deluxe King, Twin Room, Suite">
      </div>
      <div class="cl-field">
        <label for="clHtlMeal">Meal Plan<span class="cl-req">*</span></label>
        <select id="clHtlMeal">
          <option value="">Select…</option>
          ${CL_MEAL_PLANS.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="cl-field cl-field-full">
        <label for="clHtlLocation">Preferred Location</label>
        <input type="text" id="clHtlLocation" maxlength="200"
               placeholder="e.g. Near Dubai Mall, City Centre, Airport">
      </div>
    </div>

    <div class="cl-form-legend">Guest / Business Information</div>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clHtlPan">PAN</label>
        <input type="text" id="clHtlPan" maxlength="10" autocomplete="off"
               placeholder="Optional" style="text-transform:uppercase;">
      </div>
      <div class="cl-field cl-field-full">
        <label for="clHtlNotes">Special Requirements</label>
        <textarea id="clHtlNotes" maxlength="1000" placeholder="Enter any additional hotel requirements — early check-in, late check-out, connecting rooms, high floor, non-smoking room, airport transfer…"></textarea>
      </div>
    </div>`;
}

function clWireHotelEnquiryForm() {
  const f = clEnqForm;
  const today = clTodayIso();

  $('clHtlCheckIn').min = today;
  $('clHtlCheckIn').value = f.hotel.checkIn;
  $('clHtlCheckOut').min = clAddDays(f.hotel.checkIn, 1);
  $('clHtlCheckOut').value = f.hotel.checkOut;
  clPickerOnly($('clHtlCheckIn'));
  clPickerOnly($('clHtlCheckOut'));

  $('clHtlCheckIn').addEventListener('change', () => {
    const v = $('clHtlCheckIn').value;
    f.hotel.checkIn = v;
    /* The floor moves with the outbound date, exactly as the flight form's
       return-date floor does — a same-day stay is not offered in this phase
       (spec: at least one night), so the earliest legal check-out is +1. */
    $('clHtlCheckOut').min = clAddDays(v, 1);
    if ($('clHtlCheckOut').value && $('clHtlCheckOut').value <= v) {
      $('clHtlCheckOut').value = clAddDays(v, 1);
      f.hotel.checkOut = $('clHtlCheckOut').value;
    }
    clValidateHotelDates();
    clSyncHotelNights();
  });
  $('clHtlCheckOut').addEventListener('change', () => {
    f.hotel.checkOut = $('clHtlCheckOut').value;
    clValidateHotelDates();
    clSyncHotelNights();
  });
  $('clHtlCheckOut').addEventListener('blur', clValidateHotelDates);

  clCombo($('clHtlDest'), $('clHtlDestList'), clCityOptions, picked => {
    f.hotel.destination = picked;
  });

  $('clHtlName').addEventListener('input', () => { f.hotel.hotelName = $('clHtlName').value; });
  $('clHtlStar').addEventListener('change', () => { f.hotel.starCategory = $('clHtlStar').value; });
  $('clHtlRoomType').addEventListener('input', () => { f.hotel.roomType = $('clHtlRoomType').value; });
  $('clHtlMeal').addEventListener('change', () => { f.hotel.mealPlan = $('clHtlMeal').value; });
  $('clHtlLocation').addEventListener('input', () => { f.hotel.preferredLocation = $('clHtlLocation').value; });

  /* Uppercased as typed, same treatment classic-enquiry.js gives Booking
     Class — a merchant should see the value the server will store. */
  $('clHtlPan').addEventListener('input', e => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
    f.hotel.pan = e.target.value;
  });
  $('clHtlNotes').addEventListener('input', () => { f.hotel.specialRequirements = $('clHtlNotes').value; });

  clWireRoomsGuests();
  clSyncHotelNights();
  clRenderRoomsGuestsSummary();
}

/* ---- nights, derived, never typed ---- */
function clSyncHotelNights() {
  const el = $('clHtlNights');
  if (!el) return;
  const ci = $('clHtlCheckIn')?.value, co = $('clHtlCheckOut')?.value;
  if (!ci || !co) { el.value = '—'; return; }
  const nights = Math.round((new Date(`${co}T00:00:00`) - new Date(`${ci}T00:00:00`)) / 86400000);
  el.value = nights > 0 ? `${nights} Night${nights === 1 ? '' : 's'}` : '—';
}

/* ---- inline date validation, on blur — not held for submit ---- */
function clValidateHotelDates() {
  const hint = $('clHtlDateHint');
  if (!hint) return true;
  const ci = $('clHtlCheckIn')?.value, co = $('clHtlCheckOut')?.value;
  if (ci && co && co <= ci) {
    hint.textContent = 'Check-out must be after the check-in date.';
    hint.classList.add('cl-hint-err');
    return false;
  }
  hint.textContent = 'On or after check-in, at least one night.';
  hint.classList.remove('cl-hint-err');
  return true;
}

/* ==================================================== rooms & guests ==== */

/* The popover operates on a DRAFT copy, never on `clEnqForm.hotel.rooms`
   directly — Cancel (or clicking away) discards it; only Done commits. Same
   "mutate off to the side, commit deliberately" shape `clEnqForm` itself
   already uses for the rest of the form, one level deeper. */
let clRgDraft = null;

function clRoomSummary(rooms) {
  const roomsCount = rooms.length;
  const adults = rooms.reduce((s, r) => s + r.adults, 0);
  const children = rooms.reduce((s, r) => s + r.children, 0);
  const parts = [
    `${roomsCount} Room${roomsCount === 1 ? '' : 's'}`,
    `${adults} Adult${adults === 1 ? '' : 's'}`,
  ];
  if (children > 0) parts.push(`${children} Child${children === 1 ? '' : 'ren'}`);
  return parts.join(' · ');
}

function clRenderRoomsGuestsSummary() {
  const el = $('clRgSummaryText');
  if (el && clEnqForm?.hotel) el.textContent = clRoomSummary(clEnqForm.hotel.rooms);
}

function clWireRoomsGuests() {
  $('clRgTrigger')?.addEventListener('click', clToggleRoomsGuestsPopover);
}

function clToggleRoomsGuestsPopover() {
  const pop = $('clRgPopover');
  if (!pop) return;
  if (pop.classList.contains('open')) { clCloseRoomsGuestsPopover(); return; }
  clRgDraft = clEnqForm.hotel.rooms.map(r => ({
    adults: r.adults, children: r.children, childAges: [...r.childAges],
  }));
  clRenderRoomsGuestsPopover();
  pop.classList.add('open');
  $('clRgTrigger').setAttribute('aria-expanded', 'true');
  /* `true` (capture) so this runs before the click that opened it would
     otherwise bubble back up and immediately close what it just opened. */
  setTimeout(() => document.addEventListener('click', clRoomsGuestsOutsideClick, true), 0);
}

/* Clicking away is the same as Cancel — discard, not commit. A popover that
   silently saved on outside-click would make "click elsewhere to look at the
   dates" an accidental confirm. */
function clRoomsGuestsOutsideClick(e) {
  const wrap = $('clRgTrigger')?.closest('.cl-rg');
  if (wrap && !wrap.contains(e.target)) clCloseRoomsGuestsPopover();
}

function clCloseRoomsGuestsPopover({ commit = false } = {}) {
  const pop = $('clRgPopover');
  if (!pop) return;
  if (commit && clRgDraft && clEnqForm?.hotel) {
    clEnqForm.hotel.rooms = clRgDraft;
    clRenderRoomsGuestsSummary();
  }
  clRgDraft = null;
  pop.classList.remove('open');
  $('clRgTrigger')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', clRoomsGuestsOutsideClick, true);
}

function clRenderRoomsGuestsPopover() {
  const pop = $('clRgPopover');
  if (!pop || !clRgDraft) return;
  pop.innerHTML = `
    <div class="cl-rg-rooms">${clRgDraft.map((r, i) => clRoomBlock(r, i)).join('')}</div>
    <button type="button" class="cl-btn cl-btn-sm" id="clRgAddRoom"
      ${clRgDraft.length >= CL_MAX_ROOMS ? 'disabled' : ''}>+ Add Room</button>
    <div class="cl-rg-actions">
      <button type="button" class="cl-btn cl-btn-sm" id="clRgCancel">Cancel</button>
      <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" id="clRgDone">Done</button>
    </div>`;
  clWireRoomsGuestsPopoverControls();
}

function clRoomBlock(r, i) {
  return `
    <div class="cl-rg-room">
      <div class="cl-rg-room-head">
        <b>Room ${i + 1}</b>
        ${clRgDraft.length > 1
          ? `<button type="button" class="cl-rg-remove" data-cl-rg-remove="${i}"
               aria-label="Remove Room ${i + 1}">${clIco('x', { size: 14 })}</button>`
          : ''}
      </div>
      <div class="cl-pax-grid cl-rg-pax-grid">
        ${clRgStepper(i, 'adults', 'Adults', r.adults, 1)}
        ${clRgStepper(i, 'children', 'Children', r.children, 0)}
      </div>
      ${r.children > 0 ? `
        <div class="cl-rg-ages">
          ${r.childAges.map((age, ci) => `
            <div class="cl-field">
              <label for="clRgAge${i}_${ci}">Child ${ci + 1} age</label>
              <select id="clRgAge${i}_${ci}" data-cl-rg-age="${i}:${ci}">
                ${Array.from({ length: CL_CHILD_MAX_AGE + 1 }, (_, a) =>
                  `<option value="${a}"${age === a ? ' selected' : ''}>${a}</option>`).join('')}
              </select>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
}

function clRgStepper(roomIndex, key, title, value, min) {
  return `<div class="cl-pax-card" data-cl-rg-step="${roomIndex}:${key}" data-cl-min="${min}">
    <div><b>${escapeHtml(title)}</b></div>
    <div class="cl-step-ctl">
      <button type="button" class="cl-step-btn" data-cl-rg-step-dec
        aria-label="Fewer ${escapeHtml(title.toLowerCase())}"${value <= min ? ' disabled' : ''}>−</button>
      <span class="cl-step-val" data-cl-rg-step-val aria-live="polite">${value}</span>
      <button type="button" class="cl-step-btn" data-cl-rg-step-inc
        aria-label="More ${escapeHtml(title.toLowerCase())}">+</button>
    </div>
  </div>`;
}

function clWireRoomsGuestsPopoverControls() {
  const pop = $('clRgPopover');
  pop.querySelectorAll('[data-cl-rg-step]').forEach(card => {
    const [roomIndex, key] = card.dataset.clRgStep.split(':');
    const min = Number(card.dataset.clMin);
    card.querySelector('[data-cl-rg-step-dec]').addEventListener('click',
      () => clStepRoom(Number(roomIndex), key, -1, min));
    card.querySelector('[data-cl-rg-step-inc]').addEventListener('click',
      () => clStepRoom(Number(roomIndex), key, 1, min));
  });
  pop.querySelectorAll('[data-cl-rg-age]').forEach(sel => {
    sel.addEventListener('change', () => {
      const [ri, ci] = sel.dataset.clRgAge.split(':').map(Number);
      clRgDraft[ri].childAges[ci] = Number(sel.value);
    });
  });
  pop.querySelectorAll('[data-cl-rg-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      clRgDraft.splice(Number(btn.dataset.clRgRemove), 1);
      clRenderRoomsGuestsPopover();
    });
  });
  $('clRgAddRoom')?.addEventListener('click', () => {
    if (clRgDraft.length >= CL_MAX_ROOMS) return;
    clRgDraft.push({ adults: 1, children: 0, childAges: [] });
    clRenderRoomsGuestsPopover();
  });
  $('clRgCancel')?.addEventListener('click', () => clCloseRoomsGuestsPopover());
  $('clRgDone')?.addEventListener('click', () => clCloseRoomsGuestsPopover({ commit: true }));
}

/* Re-renders the whole popover on every step — simpler and safer than patching
   the DOM in place, and cheap: at most CL_MAX_ROOMS small cards. A partial
   update would also have to separately keep the age-select block's presence
   in sync with the children count; a full render cannot get the two out of
   step. */
function clStepRoom(roomIndex, key, delta, min) {
  const room = clRgDraft[roomIndex];
  const next = Math.max(min, Math.min(CL_MAX_ROOM_GUESTS, room[key] + delta));
  if (next === room[key]) return;
  room[key] = next;
  if (key === 'children') {
    while (room.childAges.length < room.children) room.childAges.push(0);
    while (room.childAges.length > room.children) room.childAges.pop();
  }
  clRenderRoomsGuestsPopover();
}

/* ============================================================ submit ==== */

function clHotelDestinationPlace() {
  return clEnqForm.hotel.destination || clFreeTextPlace($('clHtlDest')?.value);
}

/* Validation + payload shared by the enquiry-led and direct hotel submit
   paths — both ask the same questions about the same stay, so this is the
   one place they are answered. Returns the payload object, or null after
   already reporting the failure via `fail` (destination/check-in focus,
   same `clMsg` target both callers share: `clEnqMsg`). */
function clValidateAndBuildHotelStay(fail) {
  const f = clEnqForm;
  const dest = clHotelDestinationPlace();
  if (!dest) return fail('Choose the destination city.', 'clHtlDest');

  const checkIn = $('clHtlCheckIn').value;
  if (!checkIn) return fail('Choose the check-in date.', 'clHtlCheckIn');
  if (checkIn < clTodayIso()) return fail('Check-in date cannot be in the past.', 'clHtlCheckIn');

  const checkOut = $('clHtlCheckOut').value;
  if (!checkOut) return fail('Choose the check-out date.', 'clHtlCheckOut');
  if (!clValidateHotelDates()) {
    return fail($('clHtlDateHint')?.textContent
      || 'Check-out date must be after the check-in date.', 'clHtlCheckOut');
  }

  const rooms = f.hotel.rooms;
  if (!rooms.length || rooms.some(r => r.adults < 1)) {
    return fail('Each room needs at least one adult.', 'clRgTrigger');
  }

  const star = $('clHtlStar').value;
  if (!star) return fail('Choose a star category.', 'clHtlStar');
  const meal = $('clHtlMeal').value;
  if (!meal) return fail('Choose a meal plan.', 'clHtlMeal');

  const pan = ($('clHtlPan').value || '').trim().toUpperCase();
  if (pan && !CL_PAN_RE.test(pan)) {
    return fail('PAN should look like ABCDE1234F, or leave it blank.', 'clHtlPan');
  }

  return {
    destination_city: dest.city || dest.label || dest.code,
    check_in: checkIn,
    check_out: checkOut,
    rooms: rooms.map(r => ({ adults: r.adults, children: r.children, child_ages: r.childAges })),
    hotel_name: ($('clHtlName').value || '').trim() || null,
    star_category: star,
    room_type: ($('clHtlRoomType').value || '').trim() || null,
    meal_plan: meal,
    preferred_location: ($('clHtlLocation').value || '').trim() || null,
    pan: pan || null,
    special_requirements: ($('clHtlNotes').value || '').trim() || null,
  };
}

async function clSubmitHotelEnquiry() {
  const msg = $('clEnqMsg');
  const btn = $('clEnqSubmit');
  const f = clEnqForm;
  if (!f) return;

  const fail = (text, focusId) => {
    clMsg(msg, text, 'err');
    $(focusId)?.focus();
    return null;
  };

  const payload = clValidateAndBuildHotelStay(fail);
  if (!payload) return;

  btn.disabled = true;
  clMsg(msg, 'Sending your hotel enquiry…', 'muted');
  try {
    const enquiry = await MerchantApi.createHotelEnquiry(payload);
    clCloseModal();
    clEnquiryRows.unshift(enquiry);
    clRenderEnquiryRows();
    clInvalidate('dashboard');
    clLoadUnreadCount();
    /* The reference number is read straight off the response — never
       fabricated client-side, same rule the flight path follows. */
    clOpenModal('Hotel enquiry sent', `
      <div class="cl-msg cl-msg-ok" style="margin-top:0">
        Hotel enquiry <b class="cl-ref">${escapeHtml(enquiry.reference_number)}</b> is with our team.
      </div>
      <p style="font-size:13px;">We will confirm availability and quote a total fare for
        <b>${escapeHtml(enquiry.destination_city || '')}</b>${
          enquiry.travel_date && enquiry.return_date
            ? ` from <b>${escapeHtml(fmtDate(enquiry.travel_date))}</b> to
                <b>${escapeHtml(fmtDate(enquiry.return_date))}</b>`
            : ''
        }. You will be notified when it is quoted.</p>`,
      '<button type="button" class="cl-btn cl-btn-primary" onclick="clCloseModal()">Done</button>');
  } catch (err) {
    clMsg(msg, clEnquiryError(err), 'err');
  } finally {
    btn.disabled = false;
  }
}

/* Direct hotel booking's first step — same validation and stay payload as
   the enquiry, but nothing is POSTed here at all: no enquiry row is ever
   created for a direct booking. The payload is handed to Booking Request
   (classic-booking-hotel.js), where guest details are the only thing left
   to enter — the exact same split Flight's own direct path already makes
   between this modal and clStartDirectBooking. */
function clSubmitDirectHotelBooking() {
  const msg = $('clEnqMsg');
  const f = clEnqForm;
  if (!f) return;

  const fail = (text, focusId) => {
    clMsg(msg, text, 'err');
    $(focusId)?.focus();
    return null;
  };

  const payload = clValidateAndBuildHotelStay(fail);
  if (!payload) return;

  clCloseModal();
  clStartDirectHotelBooking(payload);
}
