'use strict';
/* Merchant Portal — Request Ticket.
   Books exactly one catalog item (real fare + inventory), priced server-side — there is no
   free-form "type in your own flight" request. The flow is:
     Home hero search -> "Request" -> Passenger Details (here) -> Save Draft / Submit
   "Save Draft" calls POST /api/requests (creates the request at Created/draft, holds nothing).
   "Submit for Approval" does the same, then immediately POST /api/requests/{id}/submit
   (Created -> Pending, reserves seats). Both are the existing, live ticket lifecycle
   endpoints — see docs/API_CONTRACT.md §2.

   ---------------------------------------------------------------------------
   This screen was redesigned into a travel-booking surface (itinerary card,
   stepper, collapsible passenger groups, sticky summary) in the UI-only pass.
   The parts that talk to the API were deliberately left alone:
   collectPassengerPayloads() still emits the identical passenger object, the
   same two endpoints are called in the same order, and validation is still
   "first and last name for every passenger" — nothing stricter, nothing looser.
   The rendering is `mh-` scoped so it inherits Home's tokens without touching
   partner-portal.css, which the other merchant screens still depend on. */

let rtQuote = null;        // QuoteResponse for the selected catalog item
let rtPassengerCount = 1;
let rtPassengerSeq = 0;

const RT_SEAT_PREFS = [
  { value: '', label: 'No preference' },
  { value: 'window', label: 'Window' }, { value: 'aisle', label: 'Aisle' }, { value: 'middle', label: 'Middle' },
  { value: 'front_row', label: 'Front Row' }, { value: 'exit_row', label: 'Exit Row' },
];

const RT_STEPS = ['Search', 'Select', 'Passenger Details', 'Review', 'Approval'];

function initRequestTicket() {
  renderRequestTicketPanel();
}

/* Called from partner-home.js when the merchant picks a search result. Marks the
   section pre-loaded so navigateToSection's lazy loader doesn't call initRequestTicket()
   again and overwrite this with the empty-state prompt. */
function startRequestTicket(quote, passengers) {
  rtQuote = quote;
  rtPassengerCount = passengers;
  rtPassengerSeq = 0;
  loadedSections.add('request-ticket');
  renderRequestTicketPanel();
}

/* ------------------------------------------------------------------ stepper */

/* `current` is the 0-based index of the active step; everything before it renders
   as done. Passenger Details is where this screen lives, so Search and Select are
   already behind us by definition. */
function rtStepperHtml(current) {
  return `
    <ol class="mh-steps" aria-label="Booking progress">
      ${RT_STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo';
        return `<li class="mh-step mh-step-${state}"${state === 'active' ? ' aria-current="step"' : ''}>
          <span class="mh-step-dot">${state === 'done' ? '✓' : i + 1}</span>
          <span class="mh-step-label">${escapeHtml(label)}</span>
        </li>`;
      }).join('')}
    </ol>`;
}

/* ------------------------------------------------------- itinerary summary */

function rtTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function rtDuration(mins) {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/* The carrier's real mark, from the logos vendored under
   assets/images/airlines/. Resolved by the IATA prefix of the flight number
   ("6E-1423" -> 6E) with the airline name as a fallback — see mhAirlineLogo in
   mh-visuals.js. Same tile the merchant clicked on Home, so the fare they picked
   is recognisably the fare they're now filling in. */
function rtAirlineBadge(name, travelType, flightNumber) {
  return mhAirlineLogo({ name, flightNumber, travelType, size: 'md' });
}

function rtRouteHtml(d) {
  const dep = rtTime(d.departure_time);
  const arr = rtTime(d.arrival_time);
  const dur = rtDuration(d.duration_minutes);
  return `
    <div class="mh-itin-route">
      <div class="mh-itin-end">
        <div class="mh-itin-code">${escapeHtml(d.origin || '—')}</div>
        <div class="mh-itin-city">${escapeHtml(d.origin_city || '')}</div>
        ${dep ? `<div class="mh-itin-time">${escapeHtml(dep)}</div>` : ''}
      </div>
      <div class="mh-itin-mid">
        <span class="mh-itin-line"><span class="mh-itin-plane" aria-hidden="true">✈</span></span>
        ${dur ? `<span class="mh-itin-dur">${escapeHtml(dur)}</span>` : ''}
        <span class="mh-itin-stops">${d.stops === 0 ? 'Non-stop' : `${d.stops} stop${d.stops > 1 ? 's' : ''}`}</span>
      </div>
      <div class="mh-itin-end mh-itin-end-r">
        <div class="mh-itin-code">${escapeHtml(d.destination || '—')}</div>
        <div class="mh-itin-city">${escapeHtml(d.destination_city || '')}</div>
        ${arr ? `<div class="mh-itin-time">${escapeHtml(arr)}</div>` : ''}
      </div>
    </div>`;
}

/* Airport names come from the same static reference table the search fields use,
   matched on the IATA code the inventory carries. Absent code -> line omitted
   rather than guessed. */
function rtAirportLine(code) {
  if (!code || typeof TRAVEL_LOCATIONS === 'undefined') return '';
  const hit = TRAVEL_LOCATIONS.find(l => l.code.toLowerCase() === String(code).toLowerCase());
  return hit ? escapeHtml(hit.airport) : '';
}

function rtItinerarySummaryHtml() {
  const item = rtQuote.item;
  const d = item.details || {};
  const isFlight = item.travel_type === 'flight';
  const cabin = d.cabin_class ? String(d.cabin_class).replace(/_/g, ' ') : null;
  const place = d.destination_city || d.destination || d.hotel_name || item.title || '';
  const fromAirport = rtAirportLine(d.origin);
  const toAirport = rtAirportLine(d.destination);

  const fees = Number(rtQuote.service_fee || rtQuote.fees || 0);

  return `
    <aside class="mh-bcard mh-itin" id="rtSummaryCard">
      <div class="mh-itin-top">
        ${rtAirlineBadge(d.airline, item.travel_type, d.flight_number)}
        <div>
          <div class="mh-itin-airline">${escapeHtml(d.airline || item.title || 'Selected fare')}</div>
          <div class="mh-itin-flightno">
            ${isFlight && d.flight_number ? escapeHtml(d.flight_number) : escapeHtml(item.travel_type)}
            ${cabin ? `<span class="mh-chip mh-chip-sky">${escapeHtml(cabin)}</span>` : ''}
          </div>
        </div>
      </div>

      ${isFlight ? rtRouteHtml(d) : `
        ${item.travel_type === 'hotel'
          /* Hotels have a real photograph; cruises and packages still have none,
             so they keep the drawn scene. Eager, not lazy: the summary is the
             thing the merchant is looking at when this renders. */
          ? hotelImageHtml({
              name: d.hotel_name || item.title || 'Hotel',
              city: d.destination_city || d.destination || '',
              sizes: '(max-width: 900px) 100vw, 320px',
              eager: true,
            })
          : mhThumb(item.travel_type, place, place)}
        <div class="mh-itin-title">${escapeHtml(item.title || '')}</div>`}

      ${(fromAirport || toAirport) ? `
        <div class="mh-itin-airports">
          ${fromAirport ? `<div><span aria-hidden="true">🛫</span> ${fromAirport}</div>` : ''}
          ${toAirport ? `<div><span aria-hidden="true">🛬</span> ${toAirport}</div>` : ''}
        </div>` : ''}

      <div class="mh-itin-meta">
        <div><span>Travel date</span><b>${item.travel_date ? escapeHtml(fmtDate(item.travel_date)) : '—'}</b></div>
        <div><span>Passengers</span><b>${rtQuote.passengers}</b></div>
      </div>

      <div class="mh-fare">
        <div class="mh-fare-row"><span>Base fare <small>× ${rtQuote.passengers}</small></span><b>${money(rtQuote.base_fare)}</b></div>
        <div class="mh-fare-row"><span>Taxes &amp; surcharges <small>× ${rtQuote.passengers}</small></span><b>${money(rtQuote.taxes)}</b></div>
        ${fees ? `<div class="mh-fare-row"><span>Service fee</span><b>${money(fees)}</b></div>` : ''}
        <div class="mh-fare-row mh-fare-sub"><span>Per passenger</span><b>${money(rtQuote.per_passenger)}</b></div>
        <div class="mh-fare-total"><span>Grand total</span><b>${money(rtQuote.total)}</b></div>
      </div>

      <p class="mh-itin-note">
        Fare and seats are confirmed by our team at approval. Nothing is charged now.
      </p>

      ${mhTrustBadgesHtml()}
    </aside>`;
}

/* ------------------------------------------------------- sticky bottom bar

   Mirrors the summary's headline numbers and carries the primary CTA, so on a
   long passenger form the total and "Submit" are never scrolled away from.
   Desktop: hidden until the merchant scrolls past the summary card, so it
   doesn't duplicate what's already on screen. Mobile: always visible, and the
   bar itself expands into a fare sheet, since there is no room for a side
   column. The button inside is a *proxy* — it clicks the real
   #rtSendForApprovalBtn so there is exactly one submit path. */
function rtBottomBarHtml() {
  const item = rtQuote.item;
  const d = item.details || {};
  const route = [d.origin || d.origin_city, d.destination || d.destination_city].filter(Boolean).join(' → ');
  return `
    <div class="mh-bbar" id="rtBottomBar" aria-hidden="true">
      <button type="button" class="mh-bbar-grip" id="rtBarGrip" aria-expanded="false"
              aria-controls="rtBarSheet" aria-label="Show fare breakdown">
        <span class="mh-bbar-line">
          <span class="mh-bbar-title">${escapeHtml(d.airline || item.title || 'Selected fare')}</span>
          <span class="mh-bbar-sub">${escapeHtml(route || fmtDate(item.travel_date))} · ${
            rtQuote.passengers} ${rtQuote.passengers === 1 ? 'passenger' : 'passengers'}</span>
        </span>
        <span class="mh-bbar-total">
          <span class="mh-bbar-amt">${money(rtQuote.total)}</span>
          <span class="mh-bbar-cap">total</span>
        </span>
        <span class="mh-bbar-caret" aria-hidden="true">▴</span>
      </button>
      <div class="mh-bbar-sheet" id="rtBarSheet" hidden>
        <div class="mh-fare-row"><span>Base fare <small>× ${rtQuote.passengers}</small></span><b>${money(rtQuote.base_fare)}</b></div>
        <div class="mh-fare-row"><span>Taxes &amp; surcharges <small>× ${rtQuote.passengers}</small></span><b>${money(rtQuote.taxes)}</b></div>
        <div class="mh-fare-row mh-fare-sub"><span>Per passenger</span><b>${money(rtQuote.per_passenger)}</b></div>
      </div>
      <button type="button" class="mh-btn mh-btn-coral mh-bbar-cta" id="rtBarSubmit">Submit for Approval</button>
    </div>`;
}

function rtInitBottomBar() {
  const bar = document.getElementById('rtBottomBar');
  if (!bar) return;

  document.getElementById('rtBarSubmit').addEventListener('click', () => {
    document.getElementById('rtSendForApprovalBtn')?.click();
  });

  const grip = document.getElementById('rtBarGrip');
  const sheet = document.getElementById('rtBarSheet');
  grip.addEventListener('click', () => {
    const open = sheet.hasAttribute('hidden');
    if (open) sheet.removeAttribute('hidden'); else sheet.setAttribute('hidden', '');
    grip.setAttribute('aria-expanded', String(open));
    bar.classList.toggle('mh-bbar-expanded', open);
  });

  const show = on => {
    bar.classList.toggle('mh-bbar-on', on);
    bar.setAttribute('aria-hidden', String(!on));
  };

  /* At and below the 1080px breakpoint the side column stops being sticky and
     moves above the form, so the bar is the only persistent summary and stays up
     permanently. Keep this number in step with merchant-booking.css. */
  const isNarrow = () => window.matchMedia('(max-width:1080px)').matches;

  /* Watches the REAL submit button, not the summary card. The summary is
     position:sticky on desktop, so it never leaves the viewport — keying off it
     meant the bar could never appear there at all (caught in the browser). The
     bar exists to keep the total and the CTA reachable, so the honest trigger is
     "the actual Submit button is off-screen". */
  const anchor = document.querySelector('.mh-bactions');
  if (!anchor || !('IntersectionObserver' in window)) { show(true); return; }
  const io = new IntersectionObserver(([entry]) => {
    show(isNarrow() || !entry.isIntersecting);
  }, { threshold: 0.5 });
  io.observe(anchor);
  window.addEventListener('resize', () => { if (isNarrow()) show(true); });
}

/* ------------------------------------------------------------- passengers */

function rtFieldsGroup(n, group) {
  const f = (label, html, wide) =>
    `<div class="mh-bfield${wide ? ' mh-bfield-wide' : ''}"><label for="${html.id}">${label}</label>${html.el}</div>`;

  const sel = (field, opts, id) => ({
    id,
    el: `<select id="${id}" data-field="${field}" class="mh-binput">${opts}</select>`,
  });
  const txt = (field, id, ph) => ({
    id,
    el: `<input id="${id}" data-field="${field}" class="mh-binput" type="text"${ph ? ` placeholder="${ph}"` : ''} autocomplete="off">`,
  });
  const dat = (field, id) => ({
    id,
    el: `<input id="${id}" data-field="${field}" type="date" data-mh-date>`,
  });

  if (group === 'identity') {
    return `
      ${f('Title', sel('title', `<option value="">—</option>${['Mr', 'Mrs', 'Ms', 'Master'].map(t => `<option>${t}</option>`).join('')}`, `rtTitle${n}`))}
      ${f('First Name', txt('first_name', `rtFirst${n}`, 'As in passport'))}
      ${f('Last Name', txt('last_name', `rtLast${n}`, 'As in passport'))}
      ${f('Gender', sel('gender', `<option value="">—</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>`, `rtGender${n}`))}
      ${f('Date of Birth', dat('dob', `rtDob${n}`))}`;
  }
  if (group === 'passport') {
    return `
      ${f('Passport Number', txt('passport_number', `rtPno${n}`, 'e.g. Z1234567'))}
      ${f('Nationality', txt('nationality', `rtNat${n}`, 'e.g. Indian'))}
      ${f('Passport Issuing Country', txt('passport_issue_country', `rtPic${n}`, 'e.g. India'))}
      ${f('Passport Issue Date', dat('passport_issue_date', `rtPid${n}`))}
      ${f('Passport Expiry Date', dat('passport_expiry', `rtPex${n}`))}`;
  }
  return `
    ${f('Passenger Type', sel('passenger_type', `<option value="adult">Adult</option><option value="child">Child</option><option value="infant">Infant</option>`, `rtPtype${n}`))}
    ${f('Seat Preference', sel('seat_preference', RT_SEAT_PREFS.map(s => `<option value="${s.value}">${s.label}</option>`).join(''), `rtSeat${n}`))}
    ${f('Meal Preference', txt('meal_preference', `rtMeal${n}`, 'e.g. Vegetarian'))}
    ${f('Special Requests', txt('special_requests', `rtSpecial${n}`, 'Wheelchair, bassinet…'), true)}
    <p class="mh-bhint">Special requests aren't sent with the request yet — the passenger
    schema has no field for them. Add them on the booking's chat thread after approval so
    they reach our team.</p>`;
}

/* --------------------------------------------------------- accordion control

   One card open at a time. With nine passengers the previous behaviour (each
   card toggling independently) let every card sit expanded, which is the wall of
   inputs the collapsing was meant to avoid. */
function rtCardTouched(card) { return card.dataset.touched === '1'; }

function rtSetCardOpen(card, open) {
  if (open) {
    document.querySelectorAll('#rtPassengerList .mh-pax').forEach(other => {
      if (other === card) return;
      other.querySelector('.mh-pax-body').setAttribute('hidden', '');
      other.querySelector('.mh-pax-head').setAttribute('aria-expanded', 'false');
      other.classList.remove('mh-pax-open');
    });
    card.querySelector('.mh-pax-body').removeAttribute('hidden');
  } else {
    card.querySelector('.mh-pax-body').setAttribute('hidden', '');
  }
  card.querySelector('.mh-pax-head').setAttribute('aria-expanded', String(open));
  card.classList.toggle('mh-pax-open', open);
}

/* Opens the next card that still needs a name; if they're all named, collapses
   the current one rather than leaving a filled form open. */
function rtAdvanceFrom(card) {
  const cards = [...document.querySelectorAll('#rtPassengerList .mh-pax')];
  const after = cards.slice(cards.indexOf(card) + 1);
  const next = [...after, ...cards].find(c => {
    if (c === card) return false;
    const f = c.querySelector('[data-field="first_name"]').value.trim();
    const l = c.querySelector('[data-field="last_name"]').value.trim();
    return !(f && l);
  });
  if (!next) { rtSetCardOpen(card, false); return; }
  rtSetCardOpen(next, true);
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  next.querySelector('[data-field="first_name"]').focus({ preventScroll: true });
}

function addPassengerCard() {
  const n = ++rtPassengerSeq;
  const div = document.createElement('div');
  div.className = 'mh-bcard mh-pax';
  div.dataset.passengerCard = n;
  /* First passenger starts expanded; the rest collapse so a 9-pax booking is a
     short list of headers rather than a wall of inputs. */
  const open = n === 1;

  div.innerHTML = `
    <button type="button" class="mh-pax-head" aria-expanded="${open}" aria-controls="rtPaxBody${n}">
      <span class="mh-pax-avatar" aria-hidden="true">${n}</span>
      <span class="mh-pax-headtext">
        <span class="mh-pax-title">Passenger ${n}</span>
        <span class="mh-pax-name" data-pax-name>Not filled in yet</span>
      </span>
      <span class="mh-pax-state" data-pax-state></span>
      <span class="mh-pax-caret" aria-hidden="true">▾</span>
    </button>
    <div class="mh-pax-body" id="rtPaxBody${n}"${open ? '' : ' hidden'}>
      <section class="mh-bgroup">
        <h4 class="mh-bgroup-h"><span aria-hidden="true">👤</span> Passenger Information</h4>
        <div class="mh-bgrid">${rtFieldsGroup(n, 'identity')}</div>
      </section>
      <section class="mh-bgroup">
        <h4 class="mh-bgroup-h"><span aria-hidden="true">🛂</span> Passport Information</h4>
        <div class="mh-bgrid">${rtFieldsGroup(n, 'passport')}</div>
      </section>
      <section class="mh-bgroup">
        <h4 class="mh-bgroup-h"><span aria-hidden="true">🍽</span> Travel Preferences</h4>
        <div class="mh-bgrid">${rtFieldsGroup(n, 'prefs')}</div>
      </section>
    </div>`;

  const body = div.querySelector('.mh-pax-body');
  const head = div.querySelector('.mh-pax-head');
  div.classList.toggle('mh-pax-open', open);

  head.addEventListener('click', () => rtSetCardOpen(div, body.hasAttribute('hidden')));

  /* Header mirrors the name as it's typed, so collapsed cards stay identifiable.
     Three states, not two: Not started / In progress / Ready, which is what the
     collapsed list has to communicate on a nine-passenger booking. */
  const nameEl = div.querySelector('[data-pax-name]');
  const stateEl = div.querySelector('[data-pax-state]');
  const sync = () => {
    const first = div.querySelector('[data-field="first_name"]').value.trim();
    const last = div.querySelector('[data-field="last_name"]').value.trim();
    const full = [first, last].filter(Boolean).join(' ');
    nameEl.textContent = full || 'Not filled in yet';
    const ok = !!(first && last);
    const started = !!(first || last) || rtCardTouched(div);
    stateEl.className = `mh-pax-state mh-chip ${ok ? 'mh-chip-ok' : started ? 'mh-chip-sky' : 'mh-chip-warn'}`;
    stateEl.textContent = ok ? 'Ready' : started ? 'In progress' : 'Not started';
    div.classList.toggle('mh-pax-done', ok);
  };
  div.querySelectorAll('[data-field="first_name"], [data-field="last_name"]')
    .forEach(el => el.addEventListener('input', () => { sync(); rtClearFieldError(el); }));

  /* Any edit anywhere in the card counts as "started", so a merchant who filled
     passport details before the name doesn't see "Not started". */
  body.addEventListener('input', () => { div.dataset.touched = '1'; sync(); });
  body.addEventListener('change', () => { div.dataset.touched = '1'; sync(); });

  /* Completing a name and leaving the field advances to the next unfinished
     passenger — the accordion behaviour the brief asks for. Only on blur, never
     mid-keystroke, or the card would collapse under the cursor. */
  div.querySelector('[data-field="last_name"]').addEventListener('blur', () => {
    const first = div.querySelector('[data-field="first_name"]').value.trim();
    const last = div.querySelector('[data-field="last_name"]').value.trim();
    if (first && last) rtAdvanceFrom(div);
  });

  document.getElementById('rtPassengerList').appendChild(div);

  div.querySelectorAll('[data-mh-date]').forEach(el => {
    const dob = el.dataset.field === 'dob';
    mhAttachDatePicker(el, {
      placeholder: 'Select date',
      yearFrom: dob ? new Date().getFullYear() - 100 : new Date().getFullYear() - 20,
      yearTo: dob ? new Date().getFullYear() : new Date().getFullYear() + 20,
    });
  });

  sync();
}

/* --------------------------------------------------------------- rendering */

function rtEmptyStateHtml() {
  return `
    <div class="mh-bcard mh-bempty">
      <div class="mh-bempty-emoji" aria-hidden="true">🎫</div>
      <b>No fare selected yet</b>
      <span>Search on <strong>Home</strong> and choose <strong>Request</strong> on an option
      to start a booking request.</span>
      <button type="button" class="mh-btn mh-btn-coral" id="rtGoToEnquiryBtn">Back to search</button>
    </div>`;
}

function renderRequestTicketPanel() {
  const wrap = document.getElementById('rtPanelWrap');
  if (!rtQuote) {
    wrap.innerHTML = rtEmptyStateHtml();
    document.getElementById('rtGoToEnquiryBtn').addEventListener('click', () => navigateToSection('home'));
    return;
  }

  wrap.innerHTML = `
    <div class="mh-bhead">
      <div>
        <h1 class="mh-btitle">Complete your booking request</h1>
        <p class="mh-bsub">Passenger names must match travel documents. Your request goes to
        our team for approval before any payment is taken.</p>
      </div>
      ${rtStepperHtml(2)}
    </div>

    <div class="mh-blayout">
      <div class="mh-bmain">
        <div class="mh-bsection-h">
          <h2>Passenger Details</h2>
          <span class="mh-bcount">${rtPassengerCount} ${rtPassengerCount === 1 ? 'passenger' : 'passengers'}</span>
        </div>
        <div id="rtPassengerList"></div>

        <div class="mh-bactions">
          <button type="button" class="mh-btn mh-btn-coral mh-btn-lg" id="rtSendForApprovalBtn">
            Submit for Approval
          </button>
          <button type="button" class="mh-btn mh-btn-outline" id="rtSubmitDraftBtn">Save Draft</button>
          <button type="button" class="mh-btn mh-btn-ghost" id="rtCancelSelectionBtn">Cancel</button>
        </div>
        <div class="mh-bmsg" id="rtMsg" role="status" aria-live="polite"></div>
      </div>

      <div class="mh-bside">${rtItinerarySummaryHtml()}</div>
    </div>

    ${rtBottomBarHtml()}`;

  rtPassengerSeq = 0;
  document.getElementById('rtPassengerList').innerHTML = '';
  for (let i = 0; i < rtPassengerCount; i++) addPassengerCard();
  rtInitBottomBar();
  /* This screen is reachable without Home ever having rendered (deep link, or a
     Request pressed straight off the dashboard), so the hotel-image listeners
     are installed here too — both calls are idempotent. */
  hotelImageInit();
  hotelImageSettle(document.getElementById('rtSummaryCard'));

  document.getElementById('rtSubmitDraftBtn').addEventListener('click', () => handleRequestTicketSubmit(false));
  document.getElementById('rtSendForApprovalBtn').addEventListener('click', () => handleRequestTicketSubmit(true));
  document.getElementById('rtCancelSelectionBtn').addEventListener('click', () => {
    rtQuote = null;
    renderRequestTicketPanel();
  });
}

/* ------------------------------------------------------------- validation */

/* Same rule as before the redesign — first and last name for every passenger.
   The only change is that the offending field is now pointed at instead of the
   merchant having to hunt for it in a collapsed card. */
function rtClearFieldError(el) {
  el.classList.remove('mh-binvalid');
  el.closest('.mh-bfield')?.classList.remove('mh-bfield-bad');
}

function rtFlagMissingNames() {
  let first = null;
  document.querySelectorAll('#rtPassengerList .mh-pax').forEach(card => {
    ['first_name', 'last_name'].forEach(f => {
      const el = card.querySelector(`[data-field="${f}"]`);
      if (el.value.trim()) { rtClearFieldError(el); return; }
      el.classList.add('mh-binvalid');
      el.closest('.mh-bfield')?.classList.add('mh-bfield-bad');
      if (!first) first = { card, el };
    });
  });
  if (first) {
    const body = first.card.querySelector('.mh-pax-body');
    if (body.hasAttribute('hidden')) first.card.querySelector('.mh-pax-head').click();
    first.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    first.el.focus({ preventScroll: true });
  }
  return first;
}

function collectPassengerPayloads() {
  return Array.from(document.querySelectorAll('#rtPassengerList [data-passenger-card]')).map(card => {
    const get = f => card.querySelector(`[data-field="${f}"]`)?.value || null;
    return {
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
  });
}

function rtSetMsg(text, tone) {
  const msg = document.getElementById('rtMsg');
  msg.className = `mh-bmsg${tone ? ` mh-bmsg-${tone}` : ''}${text ? ' show' : ''}`;
  msg.textContent = text;
}

async function handleRequestTicketSubmit(finalize) {
  const draftBtn = document.getElementById('rtSubmitDraftBtn');
  const approveBtn = document.getElementById('rtSendForApprovalBtn');

  if (rtFlagMissingNames()) {
    rtSetMsg('Enter first and last name for every passenger.', 'error');
    return;
  }
  const passengers = collectPassengerPayloads();

  draftBtn.disabled = true; approveBtn.disabled = true;
  approveBtn.classList.add('mh-btn-busy');
  rtSetMsg(finalize ? 'Submitting for approval…' : 'Saving draft…', 'muted');
  try {
    const { data: created } = await axios.post(`${API_BASE}/api/requests`, {
      catalog_item_id: rtQuote.item.id,
      passengers,
      travel_date: rtQuote.item.travel_date || undefined,
    }, { headers: partnerAuthHeaders() });

    if (finalize) {
      await axios.post(`${API_BASE}/api/requests/${created.request.id}/submit`, {}, { headers: partnerAuthHeaders() });
      rtShowSubmitted(created.request.request_number);
      loadedSections.delete('request-history');
      loadedSections.delete('dashboard');
      loadedSections.delete('payments');
      /* Home stays loaded (re-running initHome would throw away the merchant's
         search), so just re-pull the counts its B2B strip shows. */
      if (typeof mhLoadQuickRow === 'function') mhLoadQuickRow();
    } else {
      rtSetMsg(`Draft saved — ${created.request.request_number}. Open My Requests to submit it later.`, 'success');
    }
  } catch (err) {
    rtSetMsg(err.response?.data?.detail || 'Something went wrong.', 'error');
  } finally {
    draftBtn.disabled = false; approveBtn.disabled = false;
    approveBtn.classList.remove('mh-btn-busy');
  }
}

/* Replaces the old behaviour of flashing a message for 1.5s and wiping the form —
   too fast to read a request number off. Now the screen becomes an explicit
   confirmation with the number and the next step, and clearing is the
   merchant's choice. Step index 4 = Approval. */
function rtShowSubmitted(requestNumber) {
  const wrap = document.getElementById('rtPanelWrap');
  wrap.innerHTML = `
    <div class="mh-bhead">${rtStepperHtml(4)}</div>
    <div class="mh-bcard mh-bdone">
      <div class="mh-bdone-tick" aria-hidden="true">✓</div>
      <h2>Submitted for approval</h2>
      <p>Request <b>${escapeHtml(requestNumber)}</b> is with our team. You'll see it move to
      payment in <strong>My Requests</strong> once it's approved.</p>
      <div class="mh-bdone-actions">
        <button type="button" class="mh-btn mh-btn-coral" id="rtDoneRequestsBtn">View My Requests</button>
        <button type="button" class="mh-btn mh-btn-outline" id="rtDoneSearchBtn">Book another</button>
      </div>
    </div>`;
  document.getElementById('rtDoneRequestsBtn').addEventListener('click', () => {
    rtQuote = null;
    navigateToSection('request-history');
  });
  document.getElementById('rtDoneSearchBtn').addEventListener('click', () => {
    rtQuote = null;
    navigateToSection('home');
  });
}
