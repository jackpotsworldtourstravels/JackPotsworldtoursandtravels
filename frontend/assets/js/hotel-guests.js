'use strict';
/* ===========================================================================
   hotel-guests.js — the Guest Details screen.
   ===========================================================================
   Step 5. Collects who is staying, grouped BY ROOM, plus any special requests,
   and hands the whole party to Review.

   GUESTS BELONG TO A ROOM, NOT TO THE BOOKING.
   The party is not one flat list of names: a two-room booking has the people
   in Room 1 and the people in Room 2, and the property needs to know which is
   which. So the forms are grouped per room, each room asks for exactly the
   adults and children that room was searched with, and the room a guest
   belongs to travels with them (`room_index`, migration 0059). Before that
   column existed the grouping was collected and then thrown away at the point
   of writing the booking.

   CHILD AGES ARE NOT ASKED FOR AGAIN.
   The search panel already collected an age for every child, per room. This
   screen SHOWS that age against the child's form and sends it on; asking a
   second time would be asking a question the product already has the answer
   to. Ages ride `StayInput.child_ages`, which the server has always accepted.

   ONE CONTACT, AND IT IS THE LEAD GUEST.
   `_validate_guests` on the server requires exactly one guest carrying the
   contact details. That is the first adult in Room 1, which is the only guest
   whose form asks for an email and a mobile number.

   NOTHING HERE IS HARD-CODED. When somebody is signed in the lead guest is
   prefilled from their own saved traveller and profile; when they are not,
   the fields are simply empty. No sample names.
   =========================================================================== */

const HotelGuests = (function () {

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rupees = n => (typeof money === 'function' ? money(n)
    : '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'));
  const icon = (name, cls) => (typeof HotelResults !== 'undefined' && HotelResults.icon)
    ? HotelResults.icon(name, cls) : '';

  const TITLES = ['Mr', 'Mrs', 'Ms', 'Dr'];
  const GENDERS = ['Male', 'Female', 'Other'];
  /* Dial codes for the markets this portal actually sells to. India first
     because that is where the inventory is. */
  const DIAL_CODES = ['+91', '+971', '+44', '+1', '+65', '+61'];

  let detail = null;
  let shell = null;
  let picks = [];          // rooms chosen in Phase 3
  let party = [];          // [{ roomIndex, kind, age }] — one per guest, in order
  let values = [];         // parallel to party: the form values
  let requests = '';
  let quote = null;
  let errors = {};         // key -> message
  let bound = false;
  let onBack = null;
  let onReview = null;

  /* ---------------------------------------------------------------------
     Stay maths
     --------------------------------------------------------------------- */
  function nights() {
    const a = shell && shell.checkIn ? new Date(shell.checkIn) : null;
    const b = shell && shell.checkOut ? new Date(shell.checkOut) : null;
    if (!a || !b || isNaN(a) || isNaN(b)) return 1;
    return Math.max(1, Math.round((b - a) / 86400000));
  }
  function roomCount() { return Math.max(1, picks.length || Number(shell && shell.rooms) || 1); }
  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function isInclusion(meal) { return !/^\s*room only\s*$/i.test(String(meal || '')); }

  /** The per-room party the search collected. Falls back to spreading the
   *  guest count evenly when the panel's own list is not in hand. */
  function roomsList() {
    const list = shell && Array.isArray(shell.roomsList) ? shell.roomsList : null;
    if (list && list.length >= roomCount()) return list;
    const total = Math.max(roomCount(), Number(shell && shell.guests) || roomCount());
    const per = Math.max(1, Math.round(total / roomCount()));
    return Array.from({ length: roomCount() }, () => ({ adults: per, children: 0, childAges: [] }));
  }

  /** Expand the per-room party into one entry per person, in room order.
   *  This is the list the forms and the payload are both built from, so the
   *  number of forms cannot drift from the number of guests booked. */
  function buildParty() {
    const list = roomsList();
    const out = [];
    for (let r = 0; r < roomCount(); r++) {
      const room = list[r] || { adults: 1, children: 0, childAges: [] };
      for (let a = 0; a < (Number(room.adults) || 1); a++) {
        out.push({ roomIndex: r, kind: 'adult', age: null });
      }
      for (let c = 0; c < (Number(room.children) || 0); c++) {
        out.push({ roomIndex: r, kind: 'child', age: Number((room.childAges || [])[c] ?? 8) });
      }
    }
    return out;
  }

  const leadIndex = () => 0;   // first adult of Room 1

  /* ---------------------------------------------------------------------
     Prefill — from the signed-in customer only. Never invented.
     --------------------------------------------------------------------- */
  async function prefillLead() {
    if (typeof BookingApi === 'undefined' || !BookingApi.isSignedIn()) return;
    const lead = values[leadIndex()];
    if (!lead || lead.first || lead.last) return;

    try {
      const saved = await BookingApi.travellers();
      const t = Array.isArray(saved) ? saved[0] : null;
      if (t) {
        lead.title = lead.title || t.title || '';
        lead.first = lead.first || t.first_name || '';
        lead.last = lead.last || t.last_name || '';
        lead.gender = lead.gender || t.gender || '';
        lead.dob = lead.dob || t.date_of_birth || '';
        lead.nationality = lead.nationality || t.nationality || '';
      }
    } catch { /* no saved travellers is normal, not an error to surface */ }

    try {
      const auth = (typeof getCustomerAuth === 'function') ? getCustomerAuth() : null;
      if (auth && auth.name && !lead.first) {
        const parts = String(auth.name).trim().split(/\s+/);
        lead.first = parts[0] || '';
        lead.last = parts.slice(1).join(' ') || '';
      }
    } catch { /* ignore */ }
  }

  /* ---------------------------------------------------------------------
     Validation — field by field, with the message beside the field.
     --------------------------------------------------------------------- */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  /* Digits only, 7–15, which is the E.164 range. The dial code is separate. */
  const MOBILE_RE = /^\d{7,15}$/;

  function validate(markAll) {
    errors = {};
    party.forEach((p, i) => {
      const v = values[i] || {};
      if (!String(v.first || '').trim()) errors[`first-${i}`] = "Enter the guest's first name.";
      if (!String(v.last || '').trim()) errors[`last-${i}`] = "Enter the guest's last name.";
      if (i === leadIndex()) {
        const email = String(v.email || '').trim();
        if (!email) errors[`email-${i}`] = 'Enter an email address for the booking.';
        else if (!EMAIL_RE.test(email)) errors[`email-${i}`] = 'Enter a valid email address.';

        const mobile = String(v.mobile || '').replace(/[\s-]/g, '');
        if (!mobile) errors[`mobile-${i}`] = 'Enter a mobile number for the booking.';
        else if (!MOBILE_RE.test(mobile)) errors[`mobile-${i}`] = 'Enter a valid mobile number, digits only.';
      }
    });
    if (!markAll) {
      /* Before the traveller has tried to continue, only show errors on
         fields they have actually touched — a form that turns red before it
         is filled in is nagging, not helping. */
      Object.keys(errors).forEach(k => {
        const idx = k.split('-')[1];
        const field = k.split('-')[0];
        if (!(values[idx] && values[idx][`_touched_${field}`])) delete errors[k];
      });
    }
    return Object.keys(errors).length === 0;
  }

  const isComplete = () => {
    const saved = errors;
    const ok = validate(true);
    errors = saved;
    return ok;
  };

  /* ---------------------------------------------------------------------
     Render — one guest form
     --------------------------------------------------------------------- */
  function field({ id, label, value, type, options, placeholder, required, error, wide, hint, readonly }) {
    const err = error ? `<span class="hr-err" id="${id}-err">${esc(error)}</span>` : '';
    const described = error ? ` aria-describedby="${id}-err"` : (hint ? ` aria-describedby="${id}-hint"` : '');
    const invalid = error ? ' aria-invalid="true"' : '';
    let control;
    if (type === 'select') {
      control = `<select id="${id}" class="hr-input"${described}${invalid}>
        ${options.map(o => `<option value="${esc(o)}"${String(o) === String(value) ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
    } else if (type === 'textarea') {
      control = `<textarea id="${id}" class="hr-input hr-textarea" rows="3"
        placeholder="${esc(placeholder || '')}"${described}>${esc(value || '')}</textarea>`;
    } else {
      control = `<input id="${id}" class="hr-input" type="${type || 'text'}"
        value="${esc(value || '')}" placeholder="${esc(placeholder || '')}"
        ${readonly ? 'readonly' : ''}${described}${invalid}>`;
    }
    return `
      <div class="hr-field ${wide ? 'is-wide' : ''} ${error ? 'has-error' : ''}">
        <label class="hr-label" for="${id}">${esc(label)}${required ? '<i aria-hidden="true">*</i>' : ''}</label>
        ${control}
        ${hint ? `<span class="hr-hint" id="${id}-hint">${esc(hint)}</span>` : ''}
        ${err}
      </div>`;
  }

  function guestFormHtml(p, i) {
    const v = values[i] || {};
    const lead = i === leadIndex();
    const isChild = p.kind === 'child';

    return `
      <div class="hr-guest" data-guest="${i}">
        <div class="hr-guest-head">
          <b>${isChild ? 'Child' : 'Adult'} guest</b>
          ${lead ? '<span class="hr-chip-lead">Lead guest</span>' : ''}
          ${isChild && p.age != null
            /* The age the search already captured — shown, not asked for. */
            ? `<span class="hr-chip-age">Age ${esc(p.age)}</span>` : ''}
        </div>
        <div class="hr-fieldgrid">
          ${field({ id: `g${i}-title`, label: 'Title', type: 'select',
                    options: [''].concat(isChild ? ['Mstr', 'Miss'] : TITLES), value: v.title })}
          ${field({ id: `g${i}-first`, label: 'First name', value: v.first, required: true,
                    error: errors[`first-${i}`] })}
          ${field({ id: `g${i}-last`, label: 'Last name', value: v.last, required: true,
                    error: errors[`last-${i}`] })}
          ${lead ? `
            ${field({ id: `g${i}-email`, label: 'Email', type: 'email', value: v.email, required: true,
                      placeholder: 'name@example.com', error: errors[`email-${i}`],
                      hint: 'Your confirmation is sent here.' })}
            <div class="hr-field hr-field-phone ${errors[`mobile-${i}`] ? 'has-error' : ''}">
              <label class="hr-label" for="g${i}-mobile">Mobile number<i aria-hidden="true">*</i></label>
              <div class="hr-phone">
                <label class="hr-sr" for="g${i}-dial">Country code</label>
                <select id="g${i}-dial" class="hr-input hr-dial">
                  ${DIAL_CODES.map(c => `<option value="${esc(c)}"${c === (v.dial || '+91') ? ' selected' : ''}>${esc(c)}</option>`).join('')}
                </select>
                <input id="g${i}-mobile" class="hr-input" type="tel" inputmode="numeric"
                  value="${esc(v.mobile || '')}" placeholder="98765 43210"
                  ${errors[`mobile-${i}`] ? `aria-invalid="true" aria-describedby="g${i}-mobile-err"` : ''}>
              </div>
              ${errors[`mobile-${i}`] ? `<span class="hr-err" id="g${i}-mobile-err">${esc(errors[`mobile-${i}`])}</span>` : ''}
            </div>` : ''}
          ${!isChild ? field({ id: `g${i}-gender`, label: 'Gender', type: 'select',
                               options: [''].concat(GENDERS), value: v.gender }) : ''}
          ${lead ? field({ id: `g${i}-nat`, label: 'Nationality', value: v.nationality,
                           placeholder: 'India' }) : ''}
        </div>
      </div>`;
  }

  function roomGroupHtml(roomIndex) {
    const room = picks[roomIndex];
    const members = party.map((p, i) => ({ p, i })).filter(x => x.p.roomIndex === roomIndex);
    const adults = members.filter(x => x.p.kind === 'adult').length;
    const kids = members.filter(x => x.p.kind === 'child').length;

    return `
      <section class="hr-roomgroup" aria-labelledby="hrRG-${roomIndex}">
        <div class="hr-roomgroup-head">
          <h2 id="hrRG-${roomIndex}">Room ${roomIndex + 1}</h2>
          <div class="hr-roomgroup-meta">
            ${room ? `<b>${esc(room.name)}</b>` : ''}
            <span>${adults} adult${adults > 1 ? 's' : ''}${kids ? `, ${kids} child${kids > 1 ? 'ren' : ''}` : ''}</span>
            ${room && room.mealPlan
              ? `<span class="${isInclusion(room.mealPlan) ? 'hr-note-ok' : 'hr-note-plain'}">${esc(room.mealPlan)}</span>`
              : ''}
          </div>
        </div>
        ${members.map(x => guestFormHtml(x.p, x.i)).join('')}
      </section>`;
  }

  /* ---------------------------------------------------------------------
     Render — summary (same system as every other hotel screen)
     --------------------------------------------------------------------- */
  function summaryHtml() {
    const n = nights();
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
    const slug = (detail.image && known[detail.image]) ? detail.image
      : (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');
    const guests = party.length;

    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <img class="hr-sum-thumb" src="${esc(dir + slug + '-480.webp')}" alt="" loading="lazy">
            <div>
              <p class="hr-sum-hotel-name">${esc(detail.name)}</p>
              ${detail.stars ? `<span class="hr-stars" role="img"
                aria-label="${esc(detail.stars)} star hotel">${'★'.repeat(detail.stars)}</span>` : ''}
              <p class="hr-sum-hotel-loc">${esc(detail.location)}</p>
            </div>
          </div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-line"><span>Check-in</span><b>${esc(fmtDay(shell.checkIn))}</b></div>
          <div class="hr-sum-line"><span>Check-out</span><b>${esc(fmtDay(shell.checkOut))}</b></div>
          <div class="hr-sum-meta">${roomCount()} Room${roomCount() > 1 ? 's' : ''} · ${guests} Guest${guests > 1 ? 's' : ''}</div>
          <div class="hr-sum-meta">${n} Night${n > 1 ? 's' : ''}</div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Room selection</div>
          ${picks.map((p, i) => `
            <div class="hr-sum-line">
              <span>Room ${i + 1}${p ? ` · ${esc(p.name)}` : ''}</span>
              <b>${p ? esc(rupees(Number(p.price) * n)) : '—'}</b>
            </div>
            ${p && p.mealPlan ? `<div class="hr-sum-sub">${esc(p.mealPlan)}</div>` : ''}`).join('')}
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Price Details</div>
          ${quote ? `
            ${(quote.lines || []).map(l => `
              <div class="hr-sum-line"><span>${esc(l.label)}</span><b>${esc(rupees(l.amount))}</b></div>`).join('')}
            <div class="hr-sum-total">
              <span class="hr-sum-total-label">Total Amount</span>
              <span class="hr-sum-total-value">${esc(rupees(quote.total_amount))}</span>
            </div>
            <span class="hr-sum-note">Inclusive of all taxes. Confirmed by our booking system.</span>`
          : `<div class="hr-sum-line"><span>Pricing your stay…</span><b>—</b></div>`}
        </div>
        <div class="hr-trust">
          <div class="hr-trust-row">${icon('shield')}
            <div><b>Secure booking</b><span>Your data is protected</span></div></div>
          <div class="hr-trust-row">${icon('headset')}
            <div><b>24/7 customer support</b><span>We're here to help you anytime</span></div></div>
        </div>
      </div>`;
  }

  function actionbarHtml() {
    const ready = isComplete() && !!quote;
    const n = nights();
    const missing = Object.keys(errors).length;
    return `
      <div class="hr-actionbar-inner">
        <div class="hr-ab-item hr-ab-hide-sm">${icon('shield')}
          <div><b>Secure booking</b><span>Your data is protected</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item">${icon('calendar')}
          <div><b>${esc(fmtDay(shell.checkIn))} → ${esc(fmtDay(shell.checkOut))}</b>
          <span>${n} night${n > 1 ? 's' : ''}</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item hr-ab-hide-sm">${icon('person')}
          <div><b>${party.length} Guest${party.length > 1 ? 's' : ''}</b>
          <span>${roomCount()} Room${roomCount() > 1 ? 's' : ''}</span></div></div>
        <div class="hr-ab-total">
          <b>${quote ? esc(rupees(quote.total_amount)) : '—'}</b>
          <span>${quote ? 'Inclusive of all taxes' : 'Total pending'}</span>
        </div>
        <div class="hr-ab-cta">
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg" id="hrToReview">
            Continue to Review
          </button>
          <span>${missing ? 'Complete the guest details above' : 'You can review your booking next'}</span>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Paint
     --------------------------------------------------------------------- */
  function paintChrome() {
    const HR = typeof HotelResults !== 'undefined' ? HotelResults : null;
    const sb = $('hgSearchbar');
    if (sb && HR && HR.searchbarHtml) sb.innerHTML = HR.searchbarHtml();
    const st = $('hgStepper');
    if (st && HR && HR.stepperHtml) st.innerHTML = HR.stepperHtml(4);
  }

  function paintMain() {
    const main = $('hgMain');
    if (!main) return;
    main.innerHTML = `
      <button type="button" class="hr-backlink" data-guests-back>
        ${icon('chevron', 'hr-back-ico')} Back to Room Selection
      </button>
      <div class="hr-hd-head">
        <div class="hr-name-row"><h1 class="hr-hd-name">Guest Details</h1></div>
        <p class="hr-panel-note">
          Please enter guest details for a smooth check-in experience. Names should
          match the ID each guest presents at the property.
        </p>
      </div>
      ${Array.from({ length: roomCount() }, (_, r) => roomGroupHtml(r)).join('')}
      <section class="hr-roomgroup">
        <div class="hr-roomgroup-head">
          <h2 id="hrReqHead">Special requests <span class="hr-optional">(optional)</span></h2>
        </div>
        <div class="hr-fieldgrid">
          ${field({ id: 'hgRequests', label: 'Anything the property should know', type: 'textarea',
                    value: requests, wide: true,
                    placeholder: 'Late check-in around 10 PM',
                    hint: 'Requests are passed to the property and are not guaranteed.' })}
        </div>
      </section>`;
  }

  function paintSummary() {
    const el = $('hgSummary');
    if (el && detail) el.innerHTML = summaryHtml();
  }
  function paintActionbar() {
    const el = $('hrActionbar');
    if (el && detail) { el.innerHTML = actionbarHtml(); el.hidden = false; }
  }
  function paint() { paintChrome(); paintMain(); paintSummary(); paintActionbar(); }

  /* ---------------------------------------------------------------------
     Events
     --------------------------------------------------------------------- */
  /** Read one control back into `values`, remembering that the field has been
   *  touched so its error may now be shown. */
  function capture(el) {
    const m = /^g(\d+)-(title|first|last|email|mobile|dial|gender|nat)$/.exec(el.id || '');
    if (m) {
      const i = Number(m[1]);
      const key = { nat: 'nationality' }[m[2]] || m[2];
      values[i] = values[i] || {};
      values[i][key] = el.value;
      values[i][`_touched_${m[2]}`] = true;
      return true;
    }
    if (el.id === 'hgRequests') { requests = el.value; return false; }
    return false;
  }

  function bind() {
    if (bound) return;
    const root = $('hgRoot');
    if (!root) return;
    bound = true;

    root.addEventListener('click', e => {
      if (e.target.closest('[data-guests-back]')) { if (onBack) onBack(); return; }
      if (e.target.closest('#hrModify')) {
        if (typeof HotelResults !== 'undefined' && HotelResults.modifySearch) HotelResults.modifySearch();
      }
    });

    /* Values are captured on input so nothing is lost, but the form is only
       REPAINTED on blur — repainting mid-keystroke would move the caret. */
    root.addEventListener('input', e => { capture(e.target); });
    root.addEventListener('change', e => { if (capture(e.target)) repaintErrors(); });
    root.addEventListener('focusout', e => {
      if (!capture(e.target)) return;
      validate(false);
      repaintErrors();
      paintActionbar();
    });

    const bar = $('hrActionbar');
    if (bar) bar.addEventListener('click', e => {
      if (!e.target.closest('#hrToReview')) return;
      if (!validate(true)) {
        /* Mark every field touched so the messages appear, then take the
           traveller to the first thing that needs fixing. */
        values.forEach(v => Object.keys(v || {}).forEach(() => {}));
        party.forEach((p, i) => {
          values[i] = values[i] || {};
          ['first', 'last', 'email', 'mobile'].forEach(f => { values[i][`_touched_${f}`] = true; });
        });
        validate(false);
        paintMain();
        paintActionbar();
        const firstErr = document.querySelector('#hgMain .has-error .hr-input');
        if (firstErr) { firstErr.focus(); firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        return;
      }
      if (onReview) onReview(payload());
    });
  }

  /** Repaint only the error text and invalid flags, so typing is never
   *  interrupted by a full re-render. */
  function repaintErrors() {
    party.forEach((p, i) => {
      ['first', 'last', 'email', 'mobile'].forEach(f => {
        const el = document.getElementById(`g${i}-${f}`);
        if (!el) return;
        const wrap = el.closest('.hr-field');
        const msg = errors[`${f}-${i}`];
        if (wrap) wrap.classList.toggle('has-error', !!msg);
        if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
        let err = wrap && wrap.querySelector('.hr-err');
        if (msg && !err && wrap) {
          err = document.createElement('span');
          err.className = 'hr-err';
          err.id = `g${i}-${f}-err`;
          wrap.appendChild(err);
          el.setAttribute('aria-describedby', err.id);
        }
        if (err) err.textContent = msg || '';
        if (!msg && err) err.remove();
      });
    });
  }

  /* ---------------------------------------------------------------------
     Payload
     --------------------------------------------------------------------- */
  function payload() {
    const guests = party.map((p, i) => {
      const v = values[i] || {};
      const g = {
        guest_type: p.kind,
        room_index: p.roomIndex,
        title: (v.title || '').trim() || null,
        first_name: (v.first || '').trim(),
        last_name: (v.last || '').trim(),
        gender: (v.gender || '').trim() || null,
        nationality: (v.nationality || '').trim() || null,
        is_contact: i === leadIndex(),
      };
      if (i === leadIndex()) {
        g.email = (v.email || '').trim() || null;
        g.mobile = `${v.dial || '+91'} ${(v.mobile || '').trim()}`.trim();
      }
      return g;
    });
    /* The same party in the shape the booking engine's own steps read
       (`ctx.passengers`), so Review renders it and the create payload maps it
       without either needing to know a separate screen collected it. */
    const passengers = party.map((p, i) => {
      const v = values[i] || {};
      return {
        kind: p.kind === 'child' ? 'child' : 'adult',
        roomIndex: p.roomIndex,
        childAge: p.kind === 'child' ? p.age : null,
        title: (v.title || '').trim(),
        first: (v.first || '').trim(),
        last: (v.last || '').trim(),
        gender: (v.gender || '').trim(),
        dob: (v.dob || '').trim(),
        nationality: (v.nationality || '').trim(),
        email: i === leadIndex() ? (v.email || '').trim() : '',
        mobile: i === leadIndex() ? (v.mobile || '').trim() : '',
        countryCode: i === leadIndex() ? (v.dial || '+91') : '',
      };
    });

    const list = requests.trim() ? [requests.trim()] : [];
    return {
      guests, passengers,
      special_requests: list,
      notes: requests.trim() || null,
      party: party.slice(),
    };
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  async function show(hotelRow, sharedState, handlers, roomPicks, keep) {
    listenForSearchChange();
    shell = sharedState || {};
    picks = (roomPicks || []).filter(Boolean);
    onBack = handlers && handlers.back;
    onReview = handlers && handlers.review;

    const root = $('hgRoot');
    if (root) root.hidden = false;
    bind();

    party = buildParty();
    /* Preserve anything already typed when returning to this screen. */
    const prior = (keep && keep.values) || values;
    values = party.map((p, i) => Object.assign({ dial: '+91' }, prior[i] || {}));
    if (keep && typeof keep.requests === 'string') requests = keep.requests;

    if (!detail || String(detail.id) !== String(hotelRow.id)) {
      try {
        detail = await BookingApi.getHotelDetail(hotelRow.id);
      } catch {
        detail = { id: hotelRow.id, name: hotelRow.name, location: hotelRow.location,
                   stars: hotelRow.stars, image: hotelRow.imageKey };
      }
    }

    await prefillLead();
    validate(false);
    paint();
    refreshQuote();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /** The price does not depend on the guests, but the summary must show the
   *  real one rather than carry a number across screens — so it is asked for
   *  again here, from the same server endpoint. */
  async function refreshQuote() {
    if (!picks.length || typeof BookingApi === 'undefined' || !BookingApi.isLive('hotel')) return;
    const list = roomsList();
    try {
      quote = await BookingApi.quoteHotel({
        hotel_id: Number(detail.id),
        room_id: Number(picks[0].id),
        room_ids: picks.map(p => Number(p.id)),
        check_in: shell.checkIn,
        check_out: shell.checkOut,
        rooms_count: picks.length,
        adults: party.filter(p => p.kind === 'adult').length || 1,
        children: party.filter(p => p.kind === 'child').length,
        child_ages: party.filter(p => p.kind === 'child').map(p => p.age),
      }, [], null);
    } catch { quote = null; }
    paintSummary();
    paintActionbar();
  }

  function hide() {
    const root = $('hgRoot');
    if (root) root.hidden = true;
  }

  /** What has been typed so far, so returning to this screen restores it. */
  function state() { return { values: values.slice(), requests }; }

  /* `payload` is exported so the router can hand the collected party to
     Review without Review having to re-read the form. */

  /* THE SEARCH BAR IS EDITABLE, so the stay can change while this screen is
     open. One listener, bound once: re-price and repaint, but only when this
     screen is the one showing — the others read the new state when they next
     paint. paintChrome() is deliberately NOT called, because it would replace
     the very input being edited. */
  let sbListening = false;
  function listenForSearchChange() {
    if (sbListening) return;
    sbListening = true;
    document.addEventListener('hr:searchchange', () => {
      const el = document.getElementById('hgRoot');
      if (!el || el.hidden) return;
      refreshQuote();
      paintMain();
      paintSummary();
      paintActionbar();
    });
  }

  return { show, hide, state, payload };
})();
