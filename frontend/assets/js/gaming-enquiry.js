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
    if (err) err.textContent = message || '';
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
      form.classList.add('is-hidden');
      successEl.classList.add('is-on');
      successEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      msgEl.textContent = 'We could not reach the server. Please check your connection and try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.label;
    }
  });
})();
