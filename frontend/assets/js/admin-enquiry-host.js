'use strict';
/* Admin Portal — the host the Merchant Portal's booking-enquiry form runs in.
   ===========================================================================
   THE FORM ITSELF IS NOT IN THIS FILE, AND THAT IS THE POINT. Manual Enquiry
   mounts merchant-classic/js/classic-enquiry.js — the same file, unmodified,
   that merchants use — so there is exactly one implementation of the Booking
   Enquiry form. Its markup, fields, labels, placeholders, combos, steppers,
   trip-type switching, validation, error text and submit path all come from
   there, and a change made to it shows up in both portals at once.

   What this file provides is the ENVIRONMENT that file expects. classic-
   enquiry.js was written to run inside the Merchant Portal shell and calls ten
   helpers it does not define — clOpenModal, clMsg, clConfirm and so on. In the
   Merchant Portal those come from classic-shell.js.

   WHY classic-shell.js IS NOT LOADED HERE
   ---------------------------------------------------------------------------
   It cannot be. On load it calls `guardPortalSession(isPartnerLoggedIn)`, which
   redirects to the MERCHANT login when there is no partner session — and an
   admin never has one, so the Admin Portal would bounce to the merchant sign-in
   page the moment this section was opened. It also binds `hashchange` to the
   merchant portal's own router, installs an axios interceptor that clears the
   partner session on any 401, and calls clShowApp()/clShowAuth(), which take
   over the document. None of that can be allowed near the Admin Portal.

   So the ten helpers are re-provided here, against the Admin Portal's own
   session. They are small UI primitives — open a modal, print a message,
   confirm an action — not business logic, and none of them is part of the
   enquiry form. The form is shared; its host is not, because the two portals
   genuinely are different hosts.

   THE STYLING IS SHARED TOO, mechanically. classic-embed.css is generated from
   the Merchant Portal's own classic.css by scripts/build_classic_embed_css.py,
   with every selector scoped under `.cl-embed`. The form therefore renders
   pixel-for-pixel as it does for a merchant, while classic.css's reset — which
   restyles body, headings, buttons, links and tables — cannot reach the Admin
   Portal around it. */

/* The `$` classic-enquiry.js uses throughout. Same contract as the Merchant
   Portal's: by id, no error when absent. */
if (typeof window.$ !== 'function') {
  window.$ = (id) => document.getElementById(id);
}

/* --------------------------------------------------------------- session --
   clEnquiryAccess() reads clSessionUser()?.service_access to decide which
   products the form offers. The desk raises FLIGHT enquiries here — Manual
   Request covers the rest — so Flights is on and Hotels is off, which makes
   the form render its flight-only variant exactly as it does for a merchant
   whose account has only Flights. */
function clSessionUser() {
  return { service_access: { flights: true, hotels: false, visa: false, holidays: false } };
}

/* ---------------------------------------------------------------- modal --
   Same ids and classes classic-shell.js drives, because the markup in
   index.html is the Merchant Portal's own modal skeleton and the scoped CSS
   styles it identically. */
let ambModalReturnFocus = null;

/* THE ONE SHELL GLOBAL THE FORM WRITES TO, and it must be declared before the
   form loads. classic-enquiry.js does `clModalOnClose = () => {…}` to clean up
   when its modal is dismissed; the file is strict-mode, so assigning to an
   undeclared name throws a ReferenceError — which aborted clOpenEnquiryForm
   half-way and left the combos unbound while the modal still looked fine.
   Declared here with the same `let` classic-shell.js uses, so the form's
   assignment resolves to this binding. */
let clModalOnClose = null;

function clOpenModal(title, bodyHtml, footHtml, { wide = false } = {}) {
  ambModalReturnFocus = document.activeElement;
  $('clModalTitle').textContent = title;
  $('clModalBody').innerHTML = bodyHtml;
  $('clModalFoot').innerHTML = footHtml || '';
  $('clModal').classList.toggle('cl-modal-wide', !!wide);
  $('clModalBack').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function clCloseModal() {
  $('clModalBack').classList.remove('open');
  $('clModalBody').innerHTML = '';
  $('clModalFoot').innerHTML = '';
  document.body.style.overflow = '';
  /* Fired and cleared in that order, exactly as classic-shell.js does: the
     callback is how the form learns it was dismissed rather than submitted. */
  clModalOnClose?.();
  clModalOnClose = null;
  /* Focus goes back where it came from, so closing the form does not dump the
     operator at the top of the document. */
  try { ambModalReturnFocus?.focus(); } catch { /* element gone — nothing to do */ }
  ambModalReturnFocus = null;
}

/* Same contract as classic-shell.js's: resolves true only on the confirm
   button, and false when the dialog is dismissed any other way — the X, the
   backdrop or Escape — which is what `clModalOnClose` is for. Without that
   branch a dismissed confirm would leave the caller awaiting a promise that
   never settles. */
function clConfirm(message, confirmLabel, { danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clModalOnClose = null;
      clCloseModal();
      resolve(v);
    };
    clOpenModal('Please confirm',
      `<p style="margin:0;font-size:14px;line-height:1.65;color:var(--cl-text-2);">${escapeHtml(message)}</p>`,
      `<button type="button" class="cl-btn" data-cl-confirm="0">Cancel</button>
       <button type="button" class="cl-btn ${danger ? 'cl-btn-danger' : 'cl-btn-primary'}"
               data-cl-confirm="1">${escapeHtml(confirmLabel || 'Confirm')}</button>`);
    clModalOnClose = () => { done = true; resolve(false); };
    $('clModalFoot').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cl-confirm]');
      if (btn) finish(btn.dataset.clConfirm === '1');
    });
  });
}

/* ------------------------------------------------------------- messages -- */
/* SENTENCES THAT NAME A SCREEN THIS PORTAL DOES NOT HAVE.
   ===========================================================================
   The merchant's files pass their own wording into clMsg, and one line of it
   is wrong here: saving a draft on the Booking Request screen reports "Submit
   it here or from My Requests when ready", and there is no My Requests in the
   Admin portal — the desk's equivalent list for an enquiry-led booking is the
   MANAGER's, in a different portal, which the operator cannot open.

   AN EXACT-PHRASE TABLE, NOT A PATTERN. Every entry is a full sentence
   fragment copied from the file that emits it, so a message this portal has
   not been shown is passed through untouched rather than half-rewritten by a
   regex that happened to match. If the merchant's wording changes, the entry
   simply stops matching and the original shows — which is the safe failure.

   This is the same correction ambCorrectUnquotedStep and ambCorrectSubmitted
   make on the two screens, done at the one place this portal renders the
   merchant's strings rather than by editing the merchant's file. */
const CL_ADMIN_REWORDING = [
  ['Submit it here or from My Requests when ready.', 'Submit it here when ready.'],
];

function clMsg(el, text, kind) {
  if (!el) return;
  let out = text || '';
  for (const [from, to] of CL_ADMIN_REWORDING) {
    if (out.includes(from)) out = out.replace(from, to);
  }
  el.className = `cl-msg${out ? ` cl-msg-${kind || 'info'}` : ''}`;
  el.textContent = out;
}

/* The backend's own sentence when it sent one — it knows why better than this
   screen does. Same precedence classic-shell.js applies. */
function clError(err, fallback) {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  return fallback || 'Something went wrong. Please try again.';
}

/* ---------------------------------------------------------------- inputs -- */
function clDigitsOnly(input, max) {
  if (!input) return;
  input.addEventListener('input', () => {
    const cap = typeof max === 'function' ? max() : max;
    const before = input.value;
    const caret = input.selectionStart ?? before.length;
    const cleaned = before.replace(/\D+/g, '').slice(0, cap);
    if (cleaned === before) return;
    input.value = cleaned;
    const delta = before.length - cleaned.length;
    try { input.setSelectionRange(Math.max(0, caret - delta), Math.max(0, caret - delta)); }
    catch { /* not a text-selectable input */ }
  });
}

/* A date/time field that opens its picker on click rather than letting the
   operator type into the segments. */
function clPickerOnly(input) {
  if (!input) return;
  const open = () => {
    try { if (typeof input.showPicker === 'function') input.showPicker(); }
    catch { /* not a user gesture, or already open */ }
  };
  input.addEventListener('click', open);
  input.addEventListener('focus', open);
}

/* ------------------------------------------------------- portal no-ops --
   The Merchant Portal caches sections and carries an unread badge; the Admin
   Portal has neither, so these exist to satisfy the form's calls and do
   nothing. Kept as named functions rather than deleted from the form, because
   editing the form to remove them is exactly what "one implementation" forbids. */
function clInvalidate() { /* no section cache in this portal */ }
function clLoadUnreadCount() { /* no merchant unread badge in this portal */ }

/* THE SET classic-shell.js DECLARES, WHICH THIS PORTAL DOES NOT LOAD.
   ===========================================================================
   It is the Merchant Portal's "which sections have already rendered" cache
   (classic-shell.js), and five places in the two files mounted here delete
   from it immediately before navigating — `clLoaded.delete('booking-request')`
   in clStartBookingRequest, clResumeBookingDraft, clRequestTicket and both
   handlers on the submit confirmation.

   IT HAS TO EXIST, AND A NO-OP OBJECT WOULD NOT BE HONEST. Without it those
   lines threw `ReferenceError: clLoaded is not defined`, which killed the
   handler BEFORE its clGo() — so "Back to Manual Enquiry" and "New Manual
   Enquiry" on the Submitted screen did nothing at all, and the operator who
   had just saved a booking was stranded there with only the sidebar to leave
   by. Found by clicking it, not by reading it.

   A REAL Set, not a stub with a no-op `delete`: this portal has no section
   cache, so nothing here ever adds to it or reads it, and a Set that only ever
   has `delete` called on it behaves correctly by doing nothing — without
   pretending to be an API it is not. If a section cache is ever added to this
   portal, this is already the right shape for it. */
const clLoaded = new Set();
/* NOT A NO-OP. It was one, and that left two visible buttons dead: the Booking
   Request success screen offers "View My Requests" and "New booking enquiry",
   and both go through clGo — so in this portal they did nothing at all when
   clicked, which is worse than not offering them.

   The merchant's section names are mapped onto this portal's. Anything not
   listed is a screen the Admin Portal genuinely does not have, and returning
   without navigating is then the honest answer rather than a wrong jump. */
const CL_SECTION_TO_ADMIN = {
  /* NOT THE APPROVAL QUEUE, although that is the desk's list of other people's
     pending work and the obvious guess. It pointed there, and the booking the
     operator had just submitted was not on it.

     An enquiry-led booking runs the CR-2 Classic track, and
     `approval_service.list_approval_queue` skips `is_classic_track` rows on
     purpose: that queue must not offer an Approve button the service layer
     refuses by track. A submitted one goes to the MANAGER's desk
     (`GET /api/manager/bookings`), which this portal cannot show — the Admin
     role holds no `booking.manager_approve`, and CR-2 keeps the two desks
     apart deliberately. Verified against a live server rather than reasoned
     from the code: tests/verify_manual_booking_unquoted.py section 8.

     So the honest landing is the desk's own record of what it raised. The
     Manual Enquiry session list shows the enquiry with its booking reference
     against it, which is the one screen in this portal that knows this booking
     exists. `ambCorrectSubmitted` in admin-manual-booking.js relabels the
     button to say so, because "View My Requests" describes the merchant's
     screen and not this one. */
  requests: 'manual-enquiry',
  enquiry: 'manual-enquiry',
  'booking-request': 'manual-request',
};

function clGo(section, onArrive) {
  const target = CL_SECTION_TO_ADMIN[section];
  if (!target || typeof navigateToSection !== 'function') return;
  /* THE CALLBACK IS DELIBERATELY DROPPED for the enquiry screen. The merchant's
     version passes one that opens the enquiry form immediately; here the form
     cannot open until a merchant has been chosen, so running it would either
     file against whichever company was last selected or refuse with an error
     the operator did not ask for. They land on the screen and press the
     button, which is one click and no ambiguity. */
  /* `requests` now lands on the same screen as `enquiry` but is NOT the same
     case: its caller passes no callback at all, so there is nothing to drop
     and nothing to run. Keyed on the section the merchant asked for rather
     than on the screen it resolves to, which is what keeps the two
     distinguishable if the mapping moves again. */
  navigateToSection(target, section === 'enquiry' ? undefined : onArrive);
}

/* The rooms/guests popover belongs to the HOTEL enquiry form, which this
   portal does not mount — but the form's own close callback calls this
   unconditionally, so it must exist.

   IT IS NOT DECORATION. Left undefined it threw a ReferenceError from inside
   clModalOnClose(), which runs inside clCloseModal(), which runs on the
   SUCCESS path of clSubmitEnquiry — so the enquiry was created, the form
   closed, and the "Enquiry sent" confirmation never appeared. The operator saw
   a form vanish with no word of what happened to it. */
function clCloseRoomsGuestsPopover() { /* no hotel popover in this portal */ }

/* ---------------------------------------------------------------- rows --
   classic-enquiry.js OWNS `clEnquiryRows` and `clRenderEnquiryRows`, and this
   file must not redeclare either. `let clEnquiryRows` here was a hard
   SyntaxError — "Identifier 'clEnquiryRows' has already been declared" — which
   aborted the whole form script, so clOpenEnquiryForm never existed.

   The Merchant Portal's clRenderEnquiryRows paints its listing table and reads
   $('clEnqSearch'), which this portal has no markup for. It is therefore
   REPLACED, not redeclared, in admin-manual-booking.js — which loads after the
   form and so wins the assignment. See ambInstallRowRenderer() there. */

/* --------------------------------------------------------------- bindings --
   classic-shell.js wires the modal's close button and the Escape key; since it
   is not loaded here, the two bindings are re-made against the same markup.

   BOTH ARE SCOPED TO THIS MODAL. The Escape handler returns immediately unless
   the embedded modal is actually open, so it cannot swallow the key from the
   Admin Portal's own dialogs, and the click handler is bound to one element
   rather than delegated from the document. */
document.addEventListener('DOMContentLoaded', () => {
  const back = document.getElementById('clModalBack');
  if (!back) return;                     // not the Admin Portal, or markup absent

  document.getElementById('clModalClose')?.addEventListener('click', clCloseModal);

  /* Click the backdrop to dismiss — the Merchant Portal's behaviour. Guarded on
     the target being the backdrop itself so a click inside the dialog does not
     close it. */
  back.addEventListener('click', (e) => {
    if (e.target === back) clCloseModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!back.classList.contains('open')) return;
    clCloseModal();
  });
});

/* ===========================================================================
   BOOKING REQUEST — the six further helpers classic-booking.js expects.
   ===========================================================================
   Manual Request mounts merchant-classic/js/classic-booking.js, the Merchant
   Portal's own Booking Request screen, on the same terms Manual Enquiry mounts
   its enquiry form: the file is loaded unmodified and this supplies the shell
   it was written against. Copied in behaviour from classic-shell.js, which
   still cannot be loaded here for the reasons at the top of this file. */

/* Status vocabulary. One place, so a status never renders as one colour on one
   screen and another elsewhere — the same table classic-shell.js carries. */
const CL_STATUS_TONE = {
  draft: '', pending_approval: 'warn', in_review: 'warn', approved: 'info',
  payment_pending: 'warn', paid: 'ok', ticket_issued: 'ok', ticketed: 'ok',
  completed: 'ok', cancelled: 'err', rejected: 'err',
};

function clLabel(s) {
  return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function clTag(status, label) {
  const tone = CL_STATUS_TONE[status];
  return `<span class="cl-tag${tone ? ` cl-tag-${tone}` : ''}">${escapeHtml(label || clLabel(status))}</span>`;
}

function clEmptyRow(cols, text, hint) {
  return `<tr><td colspan="${cols}" class="cl-empty">
    <b>${escapeHtml(text)}</b>${hint ? escapeHtml(hint) : ''}</td></tr>`;
}

function clLoadingRow(cols, text, rows = 4) {
  const widths = ['w80', 'w60', 'w40', 'w60', 'w80'];
  const skeleton = Array.from({ length: rows }, (_, r) =>
    `<tr class="cl-skel-row" aria-hidden="true">${Array.from({ length: cols }, (_, c) =>
      `<td><span class="cl-skel cl-skel-line ${widths[(r + c) % widths.length]}"></span></td>`).join('')}</tr>`).join('');
  return `<tr aria-hidden="true"><td colspan="${cols}" class="cl-empty" style="padding:16px 12px !important;">
      <span class="cl-spin"></span> ${escapeHtml(text || 'Loading…')}</td></tr>${skeleton}`;
}

/* PERMISSION IS THE SERVER'S TO REFUSE IN THIS PORTAL. The Merchant Portal
   greys a control its session lacks the code for; the Admin Portal has no
   client-side permission list to consult (see admin.js), and inventing one
   here would be a second, quietly divergent answer to "may I". Returning true
   leaves every control enabled and lets the API say no — which is how every
   other Admin screen already behaves. */
function clCan() { return true; }

/* The refusal sentences classic-shell.js pairs with clActionAttrs. Verbatim
   from there — they are interpolated into titles and modals by the shared
   screens, so they have to exist even though clCan() above never triggers
   them in this portal. CL_MEAL_PLANS is deliberately absent: it belongs to the
   hotel enquiry form, which this portal does not mount. */
const CL_NO_BOOKING = 'Your role cannot raise or change bookings. Ask a Manager or Supervisor.';
const CL_NO_ENQUIRY = 'Your role cannot raise booking enquiries. Ask a Manager or Supervisor.';
const CL_NO_PAY = 'Your role cannot make payments. Ask a Manager or your Finance team.';

function clActionAttrs() { return ''; }

/* The Merchant Portal re-runs a section's loader when it is on screen. This
   portal renders Manual Request on arrival and nowhere else, so there is
   nothing to refresh behind the user's back. */
function clRefreshIfVisible() { /* no section loaders in this portal */ }
