'use strict';
/* ===========================================================================
   gaming-enquiry.js — the Gaming Tour Enquiry form.
   ===========================================================================
   ONE REQUEST DECIDES THE WHOLE PAGE:

       POST /api/customer/gaming-tour-enquiries

   No session, no destination search, no live price — a casino trip is quoted
   by hand, so this collects what the desk needs to call back and nothing
   more. See gaming_tour_enquiry_service.py for the reference format and the
   admin queue this lands on.

   VALIDATION MIRRORS THE SERVER'S, IT DOES NOT REPLACE IT. Every check here
   (required, a plausible email/mobile shape, nights > 0) is the same rule
   `GamingTourEnquiryCreate` enforces; failing fast in the browser is a
   courtesy, and the 422 the server would return on a gap in this file is
   still shown verbatim if one ever opens up.
   =========================================================================== */
(function () {
  const form = document.getElementById('geForm');
  const successEl = document.getElementById('geSuccess');
  const refEl = document.getElementById('geRef');
  const msgEl = document.getElementById('geFormMsg');
  const submitBtn = document.getElementById('geSubmitBtn');
  if (!form) return;

  /* ---------------------------------------------------------------------
     Airport fields — the same autocomplete flights.html's search card uses
     (search-widgets.js + JPAirports), pointed at plain absolute-positioned
     lists rather than the card's viewport portal: this page has no
     overflow:hidden ancestor for a portal to work around.

     THE BOX IS NEVER LOCKED TO THE TABLE. A pick fills it, but the value
     actually submitted is whatever text is in the box — free typing (a
     destination the domestic-leaning airport table does not carry, "Macau"
     or "Genting Highlands") works exactly as well as a pick. codeOf() is not
     used here for that reason: this field is a place name, not a code.
     --------------------------------------------------------------------- */
  function mountAirportField(inputId) {
    if (typeof SearchWidgets === 'undefined' || typeof JPAirports === 'undefined') return;
    const input = document.getElementById(inputId);
    const list = document.getElementById(inputId + 'List');
    if (!input || !list) return;
    input.addEventListener('focus', () => input.select());
    SearchWidgets.mountAutocomplete(inputId, {
      source: q => JPAirports.match(q, ''),
      emptyText: 'Type a city, airport or 3-letter code — or just keep typing the name.',
      format: r => JPAirports.label(r.code),
      onPick: r => { JPAirports.remember(r.code); clearFieldError(inputId); },
    });
  }
  mountAirportField('geFrom');
  mountAirportField('geTo');

  /* ---------------------------------------------------------------------
     Validation
     --------------------------------------------------------------------- */
  const REQUIRED = ['geName', 'geEmail', 'geMobile', 'geFrom', 'geTo', 'geDatetime', 'geNights', 'geCasino'];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function fieldError(id, message) {
    const input = document.getElementById(id);
    const field = input && input.closest('.ge-field');
    const err = field && field.querySelector('.ge-err');
    if (field) field.classList.toggle('is-invalid', !!message);
    if (err) {
      err.textContent = message || '';
      /* A stable id so the input can point at this message, and a live region
         so a change announces even when focus is already on the field. */
      if (!err.id) err.id = id + '-err';
      if (!err.getAttribute('role')) err.setAttribute('role', 'alert');
    }
    /* Tell assistive tech the field is invalid and WHERE its reason is. Without
       this the `.is-invalid` outline is a purely visual signal — a screen
       reader on the focused field heard nothing. Focus already moves to the
       first bad field, so the described-by error is read on arrival. */
    if (input) {
      if (message) {
        input.setAttribute('aria-invalid', 'true');
        if (err && err.id) input.setAttribute('aria-describedby', err.id);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    }
    return !message;
  }
  const clearFieldError = id => fieldError(id, '');

  function validate() {
    let firstBad = null;
    const mark = (id, message) => { if (!fieldError(id, message) && !firstBad) firstBad = id; };

    const name = document.getElementById('geName').value.trim();
    mark('geName', name ? '' : 'Please enter your full name.');

    const email = document.getElementById('geEmail').value.trim();
    mark('geEmail', !email ? 'Please enter your email address.'
      : !EMAIL_RE.test(email) ? 'Please enter a valid email address.' : '');

    const mobile = document.getElementById('geMobile').value.trim();
    const mobileDigits = mobile.replace(/[^\d]/g, '');
    mark('geMobile', !mobile ? 'Please enter your mobile number.'
      : (mobileDigits.length < 7 || mobileDigits.length > 15) ? 'Please enter a valid mobile number.' : '');

    mark('geFrom', document.getElementById('geFrom').value.trim() ? '' : 'Please enter a departure airport.');
    mark('geTo', document.getElementById('geTo').value.trim() ? '' : 'Please enter an arrival airport.');

    const dt = document.getElementById('geDatetime').value;
    mark('geDatetime', dt ? '' : 'Please choose a travel date and time.');

    const nights = Number(document.getElementById('geNights').value);
    mark('geNights', (nights > 0 && nights <= 90) ? '' : 'Please enter the number of nights (1 or more).');

    mark('geCasino', document.getElementById('geCasino').value.trim() ? '' : 'Please tell us your casino preference.');

    if (firstBad) document.getElementById(firstBad).focus();
    return !firstBad;
  }

  REQUIRED.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => clearFieldError(id));
  });

  /* ---------------------------------------------------------------------
     Submit
     --------------------------------------------------------------------- */
  form.addEventListener('submit', async e => {
    e.preventDefault();
    msgEl.textContent = '';
    if (!validate()) return;

    /* The datetime-local input has no timezone; this site is built for IST
       (the same assumption airports.js's own table makes), so the offset is
       appended explicitly rather than left for the browser to guess at
       serialisation. */
    const dtLocal = document.getElementById('geDatetime').value; // 'YYYY-MM-DDTHH:MM'
    const payload = {
      name: document.getElementById('geName').value.trim(),
      email: document.getElementById('geEmail').value.trim(),
      mobile: document.getElementById('geMobile').value.trim(),
      from_airport: document.getElementById('geFrom').value.trim(),
      to_airport: document.getElementById('geTo').value.trim(),
      travel_datetime: dtLocal + ':00+05:30',
      number_of_nights: Number(document.getElementById('geNights').value),
      casino_type: document.getElementById('geCasino').value.trim(),
    };

    submitBtn.disabled = true;
    submitBtn.dataset.label = submitBtn.textContent;
    submitBtn.textContent = 'Submitting…';

    try {
      const res = await fetch('/api/customer/gaming-tour-enquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = data && data.detail;
        const text = Array.isArray(detail)
          ? detail.map(d => d.msg).join(' ')
          : (typeof detail === 'string' ? detail : 'We could not submit your enquiry. Please try again.');
        msgEl.textContent = text;
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.label;
        return;
      }
      refEl.textContent = data.enquiry_reference || '';
      /* The enquiry is in: the saved draft has served its purpose and is
         cleared, so a return to this page starts fresh rather than re-offering a
         request that was already sent. */
      if (typeof JPSearchStore !== 'undefined') JPSearchStore.clear('gaming');
      form.classList.add('is-hidden');
      successEl.classList.add('is-on');
      successEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      msgEl.textContent = 'We could not reach the server. Please check your connection and try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.label;
    }
  });

  /* ---------------------------------------------------------------------
     Draft persistence — the TRAVEL fields only.

     Gaming Tour Packages is an enquiry, not a live search, but a traveller who
     came back to the page should not have to retype where and when they want to
     go. Only the travel fields are kept; the CONTACT fields (name, email,
     mobile) are never persisted — they are personal data that does not belong in
     storage, and the store strips them defensively even if asked. The draft is
     cleared the moment the enquiry is submitted (see the success path above).
     --------------------------------------------------------------------- */
  const DRAFT_FIELDS = {
    from: 'geFrom', to: 'geTo', datetime: 'geDatetime',
    nights: 'geNights', casino: 'geCasino',
  };

  function saveDraft() {
    if (typeof JPSearchStore === 'undefined') return;
    const data = {};
    Object.keys(DRAFT_FIELDS).forEach(key => {
      const el = document.getElementById(DRAFT_FIELDS[key]);
      if (el && el.value.trim()) data[key] = el.value;
    });
    if (Object.keys(data).length) JPSearchStore.save('gaming', data);
    else JPSearchStore.clear('gaming');
  }

  function restoreDraft() {
    if (typeof JPSearchStore === 'undefined') return;
    const saved = JPSearchStore.load('gaming');
    if (!saved) return;                       // first visit: the form stays empty
    Object.keys(DRAFT_FIELDS).forEach(key => {
      const el = document.getElementById(DRAFT_FIELDS[key]);
      if (el && typeof saved[key] === 'string') el.value = saved[key];
    });
  }

  Object.keys(DRAFT_FIELDS).forEach(key => {
    const el = document.getElementById(DRAFT_FIELDS[key]);
    if (el) {
      el.addEventListener('input', saveDraft);
      el.addEventListener('change', saveDraft);
    }
  });

  restoreDraft();
})();
