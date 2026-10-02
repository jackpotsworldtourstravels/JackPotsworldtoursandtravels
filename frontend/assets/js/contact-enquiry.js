'use strict';
/* ===========================================================================
   contact-enquiry.js — the Contact Us page's "Enquire About This Tour
   Package" form.
   ===========================================================================
   WHERE THE PACKAGE CONTEXT COMES FROM. A package with no scheduled
   departures sends "Enquire about dates" here with `?package=<name>
   &package_id=<id>` in the query string (package.js / booking-flows.js).
   Opening Contact Us directly carries neither — the Tour Package field is
   then blank and the customer types it themselves, which is why that field
   is a free-text input rather than a read-only one bound to the link.

   THE TEMPLATE AUTO-FILLS THE MESSAGE BUT NEVER FIGHTS THE CUSTOMER FOR IT.
   It is rebuilt from the Package / Date / Travellers fields on every change,
   right up until the customer edits the message box by hand — tracked by
   `messageTouched`, set by a real keystroke and never by this script's own
   `.value =` writes (guarded by `programmatic`). After that point the
   template stops overwriting what they wrote.

   ONE ENDPOINT, ONE RESPONSE: POST /api/customer/tour-package-enquiries
   (schemas/tour_package_enquiry.py). No session required — the same public
   shape as the landing page's other forms (group-enquiry.js).
   =========================================================================== */
(function () {
  const form = document.getElementById('tpeForm');
  if (!form) return; /* this page was not built from the Contact Us template */

  const els = {
    name: document.getElementById('tpeName'),
    email: document.getElementById('tpeEmail'),
    mobile: document.getElementById('tpeMobile'),
    pkg: document.getElementById('tpePackage'),
    date: document.getElementById('tpeDate'),
    travellers: document.getElementById('tpeTravellers'),
    message: document.getElementById('tpeMessage'),
    submit: document.getElementById('tpeSubmit'),
    alert: document.getElementById('tpeAlert'),
  };

  /* Same rule as app.js/admin.js/partner-shared.js: same-origin everywhere
     except the standalone static file-server ports used in local dev, which
     have no backend of their own and are redirected to the one on 8000.
     Contact Us does not load app.js, so this is restated here rather than
     taking on that whole script just for one constant. */
  const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname)
                  && ['5500', '5501', '8420'].includes(location.port))
    ? 'http://127.0.0.1:8000' : '';
  const ENDPOINT = '/api/customer/tour-package-enquiries';

  /* Same 8-to-15-digit, optional leading "+" rule the backend enforces
     (app.schemas.customer._clean_mobile) — mirrored here only so a bad
     number is caught before a round trip, never relied on in place of it. */
  const MOBILE_RE = /^\+?\d{8,15}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const params = new URLSearchParams(location.search);
  const contextPackageName = (params.get('package') || '').trim();
  const contextPackageId = params.get('package_id');

  let programmatic = false;
  let messageTouched = false;
  let submitting = false;
  let justSucceeded = false;

  function longDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function buildMessage() {
    const pkg = els.pkg.value.trim();
    if (!pkg) return '';
    const dateText = els.date.value ? longDate(els.date.value) : 'not decided yet';
    const travellersText = els.travellers.value ? els.travellers.value.trim() : 'not specified';
    return `Hello JackPots World Tours & Travels,\n\n`
      + `I am interested in the ${pkg} and would like to know the available dates, pricing, `
      + `inclusions, and booking details.\n\n`
      + `My preferred travel date is ${dateText} and I am travelling with ${travellersText} `
      + `travellers.\n\n`
      + `Please contact me with the available options and further details.\n\n`
      + `Thank you.`;
  }

  function refreshMessage() {
    if (messageTouched) return;
    programmatic = true;
    els.message.value = buildMessage();
    programmatic = false;
  }

  /* Prefill from the package the customer came from. */
  if (contextPackageName) {
    els.pkg.value = contextPackageName;
    refreshMessage();
  }

  els.message.addEventListener('input', () => { if (!programmatic) messageTouched = true; });
  ['input', 'change'].forEach(evt => {
    els.pkg.addEventListener(evt, refreshMessage);
    els.date.addEventListener(evt, refreshMessage);
    els.travellers.addEventListener(evt, refreshMessage);
  });

  /* Editing anything after a successful send un-sticks the button, so the
     "temporarily" in "disable the submit button temporarily" has a real exit
     — the customer is not locked out of sending a second, different enquiry
     without reloading the page. */
  form.addEventListener('input', () => {
    if (justSucceeded) {
      justSucceeded = false;
      els.submit.disabled = false;
      hideAlert();
    }
  });

  function fieldWrap(input) { return input.closest('.ds-field'); }

  function setInvalid(input, message) {
    const wrap = fieldWrap(input);
    if (!wrap) return;
    wrap.classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');
    let err = wrap.querySelector('.ds-error');
    if (!err) {
      err = document.createElement('p');
      err.className = 'ds-error';
      wrap.appendChild(err);
    }
    err.textContent = message;
  }

  function clearInvalid(input) {
    const wrap = fieldWrap(input);
    if (!wrap) return;
    wrap.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    const err = wrap.querySelector('.ds-error');
    if (err) err.textContent = '';
  }

  function clearAllInvalid() {
    [els.name, els.email, els.mobile, els.pkg, els.message].forEach(clearInvalid);
  }

  /* `.ds-alert { display: grid }` outranks the UA `[hidden]{display:none}`
     rule (same specificity, later in source order), so the `hidden`
     attribute alone leaves an empty box visible — `style.display` is set
     explicitly rather than relying on it. */
  function showAlert(kind, title, body) {
    els.alert.hidden = false;
    els.alert.style.display = '';
    els.alert.className = `ds-alert ds-alert--${kind}`;
    els.alert.innerHTML = `<div><span class="ds-alert__title">${title}</span>${body}</div>`;
  }

  function hideAlert() {
    els.alert.hidden = true;
    els.alert.style.display = 'none';
    els.alert.innerHTML = '';
  }

  /** Mirrors group-enquiry.js — FastAPI's `detail` is a string for a raised
   *  HTTPException and an array of {loc,msg} for a 422; both become one
   *  sentence here rather than "[object Object]". */
  function messageFrom(data, fallback) {
    const detail = data && data.detail;
    if (Array.isArray(detail)) {
      const text = detail.map(d => d && d.msg).filter(Boolean).join(' ');
      return text || fallback;
    }
    if (typeof detail === 'string' && detail) return detail;
    return fallback;
  }

  function validate() {
    clearAllInvalid();
    let firstInvalid = null;
    const mark = (input, ok, msg) => {
      if (!ok) { setInvalid(input, msg); if (!firstInvalid) firstInvalid = input; }
    };

    mark(els.name, els.name.value.trim().length > 0, 'Enter your name.');
    mark(els.email, EMAIL_RE.test(els.email.value.trim()), 'Enter a valid email address.');
    const mobileClean = els.mobile.value.trim().replace(/[\s-]/g, '');
    mark(els.mobile, MOBILE_RE.test(mobileClean),
      'Enter a valid mobile number — 8 to 15 digits, optionally starting with +.');
    mark(els.pkg, els.pkg.value.trim().length > 0, 'Enter the tour package you are asking about.');
    mark(els.message, els.message.value.trim().length > 0, 'Enter your enquiry message.');

    if (firstInvalid) { firstInvalid.focus(); return null; }
    return { mobileClean };
  }

  function payloadOf(mobileClean) {
    const body = {
      name: els.name.value.trim(),
      email: els.email.value.trim(),
      mobile: mobileClean,
      package_name: els.pkg.value.trim(),
      message: els.message.value.trim(),
    };
    if (contextPackageId && els.pkg.value.trim() === contextPackageName) {
      const idNum = Number(contextPackageId);
      if (Number.isFinite(idNum) && idNum > 0) body.package_id = idNum;
    }
    if (els.date.value) body.preferred_travel_date = els.date.value;
    if (els.travellers.value) body.number_of_travellers = Number(els.travellers.value);
    return body;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submitting) return; /* duplicate-click guard */

    const valid = validate();
    if (!valid) return;

    submitting = true;
    els.submit.disabled = true;
    els.submit.classList.add('is-busy');
    hideAlert();

    let res;
    try {
      res = await fetch(API_BASE + ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadOf(valid.mobileClean)),
      });
    } catch {
      submitting = false;
      els.submit.disabled = false;
      els.submit.classList.remove('is-busy');
      showAlert('danger', 'Could not send your enquiry. ',
        'Check your connection and try again, or call us directly.');
      return;
    }

    els.submit.classList.remove('is-busy');

    if (res.ok) {
      const data = await res.json().catch(() => null);
      submitting = false;
      justSucceeded = true;
      els.submit.disabled = true; /* stays disabled until the form is touched again */
      showAlert('success', 'Enquiry sent — thank you. ',
        'Please wait, our team will contact you soon.'
        + (data && data.enquiry_reference ? ` Your reference: <strong>${data.enquiry_reference}</strong>.` : ''));
      return;
    }

    submitting = false;
    els.submit.disabled = false;

    const GENERIC = 'We could not send your enquiry just now — please try again, or call us.';
    if (res.status === 429) {
      showAlert('danger', 'Too many attempts. ',
        'That is a few enquiries in quick succession — give it a minute, then try again.');
      return;
    }
    if (res.status === 422 || res.status === 503) {
      let data = null;
      try { data = await res.json(); } catch { /* no JSON body */ }
      showAlert('danger', 'Please check the form. ', messageFrom(data, GENERIC));
      return;
    }
    showAlert('danger', 'Something went wrong. ', GENERIC);
  });
})();
