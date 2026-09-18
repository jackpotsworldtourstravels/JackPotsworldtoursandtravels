'use strict';
/* Admin Portal — Manual Booking.
   ===========================================================================
   Manual Enquiry mounts THE MERCHANT PORTAL'S OWN booking-enquiry form:
   merchant-classic/js/classic-enquiry.js, loaded unmodified. Every field,
   label, placeholder, dropdown, stepper, trip-type switch, validation rule and
   error sentence comes from that file, so One Way, Round Trip and Group
   Booking behave here exactly as they do for a merchant, and a change made
   there appears in both portals without anything being copied.

   This file is not the form. It is the three things the Admin context needs
   around it:

     1. A MERCHANT PICKER. An admin has no merchant of its own, so every
        enquiry raised here names the company it is for. Required before the
        form will open — see openForm().
     2. AN API REDIRECT. classic-enquiry.js submits through
        MerchantApi.createEnquiry, which authenticates as a MERCHANT. Here the
        same call has to go out under the admin's token and carry the chosen
        merchant. Done by wrapping MerchantApi._req, the single choke point
        every one of its calls passes through — so the form is untouched.
     3. A HOST. The ten shell helpers the form expects live in
        admin-enquiry-host.js; that file explains why classic-shell.js itself
        cannot be loaded into this portal.

   MANUAL REQUEST MOUNTS THE MERCHANT PORTAL'S BOOKING REQUEST SCREEN on the
   same terms: merchant-classic/js/classic-booking.js, unmodified. Every
   booking field, every passenger field and every validation rule on it is that
   file's, so a Manual Booking collects exactly what a merchant's Booking
   Request collects — including N passenger cards, the passport rules on an
   international sector, and a group booking's manifest upload.

   It is reached from Raise Booking on a Manual Enquiry row, never from a blank
   form: a Booking Request has no standalone existence, because its itinerary
   is copied server-side from the enquiry it was raised from.

   THAT ENQUIRY NO LONGER HAS TO HAVE BEEN QUOTED. Raise Booking used to answer
   "Not available yet" on anything short of Approved, which is the Merchant
   Portal's rule and is wrong in this portal for one reason: the desk reading
   that sentence is the desk that would send the quotation. See
   ambRaiseBooking. */

const AMB = {
  merchants: [],
  /* The merchant the next enquiry belongs to. Read by the MerchantApi wrapper
     at submit time rather than captured when the form opens, so changing the
     picker and re-opening cannot file against the previous choice. */
  merchantId: null,
  wired: false,
  /* Enquiries raised in this sitting, newest first. Ours, not the form's —
     see the note in ambInstallApiBridge for why the form's own array cannot
     be read from here. */
  raised: [],
  /* The enquiry Raise Booking is carrying into Manual Request. Cleared once
     that screen has rendered it, so returning to Manual Request later shows
     the empty state rather than silently re-opening an old booking. */
  pendingEnquiry: null,
  /* What the booking screen is working on, kept AFTER pendingEnquiry is
     cleared. The confirmation screen is rendered by the merchant's own file,
     which is handed a request number and an enquiry reference and nothing
     else — so the two facts its wording needs here, the company and whether a
     fare was ever quoted, have to be remembered on the way in. Null until a
     booking form has been rendered in this sitting. */
  converting: null,
  /* Carried across the navigation that Save performs, so the confirmation can
     be shown on the Manual Enquiry screen the operator lands on rather than on
     the form they are leaving. Cleared as soon as it is read. */
  savedNote: null,
  /* DOCUMENTS ON THE BOOKING BEING FILLED IN.
     `saved` is what the server already holds (read back on a resume); `queued`
     is what the operator has chosen on this screen and has not been uploaded
     yet. Two lists rather than one because they support different actions —
     a saved one can be downloaded and deleted, a queued one can only be taken
     back out of the queue — and because only `queued` is sent on Save. */
  docs: { saved: [], queued: [] },
};

const ambEsc = (s) => (typeof escapeHtml === 'function'
  ? escapeHtml(String(s == null ? '' : s))
  : String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

const ambMerchantName = (id) => {
  const m = AMB.merchants.find(x => String(x.merchant_id ?? x.id) === String(id));
  return m ? (m.company_name || m.name || `Merchant ${id}`) : '';
};

/* ------------------------------------------------------------- API bridge --
   ONE WRAPPER, INSTALLED ONCE. MerchantApi._req is the choke point every
   MerchantApi call goes through (see shared/merchant-api.js), so redirecting it
   here covers createEnquiry, groupBookingLimits and anything the form reaches
   for later — without classic-enquiry.js knowing it is not in the Merchant
   Portal.

   Two substitutions, and nothing else:
     headers   the admin's token instead of partnerAuthHeaders(), which reads a
               merchant session this portal does not have.
     merchant  on_behalf_of_merchant_id added to the enquiry POST only. The
               backend requires `ticket.manual` to accept it and refuses the
               call outright when it is missing, so an enquiry cannot be filed
               against the admin who typed it. */
function ambInstallApiBridge() {
  if (AMB.wired || typeof MerchantApi === 'undefined') return;
  const original = MerchantApi._req.bind(MerchantApi);

  MerchantApi._req = async function (method, path, opts = {}) {
    const isEnquiryCreate = method === 'post' && path === '/api/enquiries';
    const data = isEnquiryCreate
      ? { ...(opts.data || {}), on_behalf_of_merchant_id: Number(AMB.merchantId) }
      : opts.data;

    const res = await axios({
      method,
      url: `${API_BASE}${path}`,
      headers: authHeaders(),
      params: opts.params,
      data,
      responseType: opts.responseType,
    });

    /* THE SESSION LIST IS KEPT HERE, not read back off the form's own array.
       classic-enquiry.js declares `clEnquiryRows` with `let`, which creates a
       binding in the global LEXICAL scope and not a property on `window` — so
       `window.clEnquiryRows` is undefined from another script and a renderer
       reading it silently drew nothing. Capturing the record as it passes
       through the one call that creates it needs no access to the form's
       internals at all. */
    /* Shown immediately, then confirmed by the next relist. The table is read
       from the server now (ambLoadEnquiries), so this is no longer the only
       record of the row — it is what puts it on screen without waiting for a
       second round trip, which matters because the operator is usually still
       on the phone. */
    if (isEnquiryCreate && res.data && typeof res.data === 'object') {
      AMB.raised.unshift({ ...res.data, __merchantName: ambMerchantName(AMB.merchantId) });
      if (typeof clRenderEnquiryRows === 'function') clRenderEnquiryRows();
    }
    return res.data;
  };

  /* THE MULTIPART CALLS, WHICH THE `_req` WRAPPER ABOVE CANNOT REACH.
     MerchantApi.uploadDocument posts a FormData directly through axios — it has
     to, because the browser must set its own multipart boundary and `_req`
     sends JSON — so wrapping `_req` never covered it. It read
     `partnerAuthHeaders()`, a merchant session this portal does not have, and
     answered 401.

     `_headers` is the one function every MerchantApi call now takes its
     Authorization from (shared/merchant-api.js). Replacing it here points both
     shapes of call at the admin's token with one line, instead of duplicating
     the upload against a second client. */
  MerchantApi._headers = () => authHeaders();

  /* THE GROUP MANIFEST, WHICH NEEDS A MERCHANT AS WELL AS A TOKEN.
     ===========================================================================
     A group booking's travellers come from a spreadsheet rather than the form,
     so without this upload the desk could raise a group enquiry for a merchant,
     press Raise Booking, and then not be able to finish it — the screen offered
     an upload card that answered 403.

     The token alone is not enough here, unlike every other call. An import row
     is OWNED by a merchant: it is scoped on read by merchant_id, and
     `attach_to_request` refuses a manifest whose merchant differs from the
     booking's. The admin has no merchant, so the upload has to name one.

     WHICH MERCHANT, AND WHY IT IS NOT THE PICKER. It is the merchant of the
     ENQUIRY being converted — read from `clBookingEnquiry` at the moment of the
     call, not captured when the screen opened and not taken from the Manual
     Enquiry dropdown. The operator may well have changed that dropdown since;
     filing the sheet against whatever it now says would attach one company's
     travellers to another company's booking, which is exactly what the server's
     own check would then refuse, after the upload.

     Wrapped rather than parameterised, for the reason the `_req` wrapper gives:
     classic-booking.js calls this and must not learn it is in another portal. */
  const originalManifest = MerchantApi.uploadGroupManifest.bind(MerchantApi);
  MerchantApi.uploadGroupManifest = function (opts) {
    const merchantId = (typeof clBookingEnquiry !== 'undefined' && clBookingEnquiry)
      ? clBookingEnquiry.merchant_id : null;
    if (merchantId == null) return originalManifest(opts);
    /* The field rides on the FormData the original builds, so the file, the
       journey type, `replaces` and the progress callback are all still its
       own — this adds one entry and changes nothing else. */
    return originalManifest({ ...opts, onBehalfOfMerchantId: merchantId });
  };

  /* PASSPORT SCANNING (classic-passport-ocr.js), wrapped for exactly the reason
     the manifest above is, and reading the merchant the identical way.

     An extraction row is owned by a merchant — `passport_ocr_service` files it
     under one, scopes every read by it, and refuses to invent one for an admin.
     So this upload has to name the merchant too, and it must be the merchant of
     the ENQUIRY being converted, read from `clBookingEnquiry` at the moment of
     the call. Not the Manual Enquiry dropdown, which the operator may have
     changed since: filing a passport against whatever it now says would put one
     company's traveller under another company's booking.

     The other three OCR calls — availability, the poll and the edit audit — go
     through `MerchantApi._req`, so the `_headers` replacement above already
     carries the admin's token to them and they need nothing here. This one is
     multipart and posts through axios directly, which is why it is the only one
     wrapped. */
  const originalExtract = MerchantApi.extractPassport.bind(MerchantApi);
  MerchantApi.extractPassport = function (file, opts = {}) {
    const merchantId = (typeof clBookingEnquiry !== 'undefined' && clBookingEnquiry)
      ? clBookingEnquiry.merchant_id : null;
    if (merchantId == null) return originalExtract(file, opts);
    return originalExtract(file, { ...opts, onBehalfOfMerchantId: merchantId });
  };

  AMB.wired = true;
}

/* ------------------------------------------------------------ row renderer --
   REPLACED, NOT REDECLARED. classic-enquiry.js declares both `clEnquiryRows`
   and `clRenderEnquiryRows`; re-declaring either in a second script is a
   SyntaxError that aborts the form file entirely. This file loads AFTER the
   form, so assigning onto `window` here simply wins.

   The Merchant Portal's version paints its listing table and reads
   $('clEnqSearch'), which this portal has no markup for — it would throw on
   the first successful submit. This one lists what the desk raised in this
   sitting, which is what an operator taking calls actually wants to see. */
function ambInstallRowRenderer() {
  window.clRenderEnquiryRows = function () {
    const host = document.getElementById('ambRecent');
    if (!host) return;
    const rows = AMB.raised;
    if (!rows.length) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <div class="panel" style="margin-top:18px;">
        <div class="panel-head"><h2>Manual enquiries</h2></div>
        <!-- The sector column wraps to three lines on a narrow panel and pushed
             ACTION past the right edge, clipping the button to "Raise B…".
             Scrolling the TABLE rather than the page keeps the button reachable
             without the document itself growing a horizontal scrollbar. -->
        <div style="overflow-x:auto;">
        <table class="data-table" style="min-width:680px;"><thead><tr>
          <th>Reference</th><th>Merchant</th><th>Sector</th><th>Travel date</th>
          <th>Status</th><th>Action</th>
        </tr></thead><tbody>
        ${rows.map(r => {
          /* The API's own fields. EnquiryResponse is flat — origin/destination
             with their *_city companions — and already carries merchant_name,
             so the sector reads the way the merchant's own listing reads it and
             the company name comes from the record rather than from the picker
             that happened to be open. __merchantName is only the fallback. */
          const leg = (code, city) => city ? `${city} (${code})` : (code || '');
          const sector = [leg(r.origin, r.origin_city), leg(r.destination, r.destination_city)]
            .filter(Boolean).join(r.trip_type === 'round_trip' ? ' ⇄ ' : ' → ');
          /* THE ACTION IS DERIVED FROM THE BOOKING STATE, NOT FROM THE QUOTATION.
             ------------------------------------------------------------------
             It used to be `disabled` while the enquiry was un-quoted, which was
             wrong twice over in this portal: admin.css does not restyle a
             disabled .btn-coral, so it looked exactly like a live button — and
             a disabled button fires NO click event, so pressing it did nothing
             at all. It was then made clickable and answered with "Not available
             yet", which was honest but still a dead end, because the desk
             reading that sentence is the desk that would send the quotation.

             The quotation is no longer part of this decision at all. What the
             column now says is whether a booking EXISTS, which is the only
             thing that changes what the click does:

               no booking yet          Raise Booking   — opens the form
               booking already raised  View Booking    — opens the saved record
               refused or withdrawn    Raise Booking   — refused, and the title
                                                         says so before the click

             ONE ENQUIRY, ONE BOOKING. The two actions are mutually exclusive
             and driven by `booking_request_id`, which the SERVER writes onto
             the enquiry inside the same transaction that creates the booking —
             so the column is reading the database relationship, not a flag this
             screen maintains. There is no state in which both are offered, and
             that is what stops a second booking being raised from a row that
             already has one.

             The button is live in every one of those states. Both handlers
             re-read the enquiry and decide on CURRENT facts, so a row that was
             booked or answered since the table was drawn behaves correctly
             without a refresh; the styling is the only thing that differs. */
          const booked = !!r.booking_request_id;
          const closed = r.status === 'rejected' || r.status === 'cancelled';
          const label = booked ? 'View Booking' : 'Raise Booking';
          const attr = booked ? 'data-amb-view' : 'data-amb-raise';
          const why = ` title="${ambEsc(booked
            ? `Open ${r.booking_request_number || 'the booking'} saved against this enquiry`
            : closed
              ? `This enquiry is ${r.status_label || clLabel(r.status || '')} — `
                + 'a booking cannot be raised from one that was refused or withdrawn.'
              : 'Enter the booking and passenger details for this enquiry')}"`;
          /* THE ROW ITSELF SHOWS THAT A BOOKING IS SAVED, not only the button.
             A second line under the reference, because the requirement is that
             the SAME enquiry row reflects the saved booking — and because an
             operator scanning the table for "which of these did I already do"
             should not have to read the Action column's wording to find out.
             ONE fact only: the booking's reference, which the enquiry already
             carries (`booking_request_number`, stamped on it by the server when
             the booking was created). The PNR, the ticket number and the
             travellers are a click away in View Booking — deliberately, because
             reading them here would mean either a second request per row or
             copying them onto the enquiry, and neither is worth it to avoid one
             click. It is also what keeps the existing five columns from
             growing. */
          const stamp = booked
            ? `<div class="cl-kpi-sub" style="margin-top:2px; font-size:11.5px;">${
                ambEsc(r.booking_request_number || '')}</div>`
            : '';
          return `<tr>
            <td><strong>${ambEsc(r.reference_number || r.request_number || '')}</strong>${stamp}</td>
            <td>${ambEsc(r.merchant_name || r.__merchantName || '')}</td>
            <td>${ambEsc(sector)}</td>
            <td>${ambEsc(r.travel_date || '')}</td>
            <td>${typeof clTag === 'function'
                  ? clTag(r.status, r.status_label) : ambEsc(r.status_label || r.status || '')}</td>
            <td><button type="button" class="btn btn-sm ${booked || closed ? 'btn-ghost' : 'btn-coral'}"
                        ${attr}="${ambEsc(r.id)}"${why}>${label}</button></td>
          </tr>`;
        }).join('')}
        </tbody></table>
        </div>
      </div>`;
  };
}

/* ---------------------------------------------------------- admin wording --
   THE DESK SAVES; THE MERCHANT SENDS. To a merchant an enquiry is a question
   put to us, so "Send Enquiry" is right. The desk typing one up from a phone
   call is recording something it already has, so "Save" is. Same record, same
   endpoint, different act — and the word should match the act.

   BOTH OVERRIDES ARE ADMIN-ONLY BY CONSTRUCTION. This file is loaded by the
   Admin Portal and nothing else; classic-enquiry.js is untouched, so the
   Merchant Portal keeps "Send Enquiry" and its own confirmation without a
   branch anywhere inside the shared form. */
function ambInstallWording() {
  /* clDirectSubmitLabel is the ONE place the form derives that button's text —
     used when the modal is first rendered (line 1057) and again whenever the
     product switch re-labels it (line 1415). Overriding it covers both, which
     setting .textContent once after opening would not: switching Flight/Hotel
     would silently put "Send Enquiry" back. The `direct` modes are passed
     through untouched; this portal never opens them, and guessing at their
     wording would be inventing a label for a screen that does not exist here. */
  const originalLabel = window.clDirectSubmitLabel;
  window.clDirectSubmitLabel = function (direct, type) {
    if (!direct) return 'Save';
    return typeof originalLabel === 'function' ? originalLabel(direct, type) : 'Continue';
  };

  /* The success modal. The merchant's copy ends "Raise Booking then lights up
     on this row" — a row on a listing table this portal does not render, so
     leaving it would point the desk at something that is not there. The
     reference and the sector come from the record the API bridge just
     captured, so nothing is parsed back out of the merchant's markup. */
  const originalModal = window.clOpenModal;
  window.clOpenModal = function (title, bodyHtml, footHtml, opts) {
    if (title !== 'Enquiry sent') return originalModal(title, bodyHtml, footHtml, opts);

    const r = AMB.raised[0];
    const leg = (code, city) => (city ? `${city} (${code})` : (code || ''));
    const sector = r
      ? [leg(r.origin, r.origin_city), leg(r.destination, r.destination_city)]
          .filter(Boolean).join(r.trip_type === 'round_trip' ? ' ⇄ ' : ' → ')
      : '';
    /* NO SENTENCE ENDS ON A <b> HERE. classic.css gives bold runs inside
       .cl-msg their own spacing, so a full stop placed straight after one
       renders detached — "saved for skyview ." — which looks like a typo. The
       merchant name is followed by a word rather than punctuation. */
    const who = r ? (r.merchant_name || r.__merchantName || '') : '';
    return originalModal('Enquiry saved', `
      <div class="cl-msg cl-msg-ok" style="margin-top:0">
        Enquiry <b class="cl-ref">${ambEsc(r ? r.reference_number : '')}</b>
        saved${who ? ` for <b>${ambEsc(who)}</b>` : ''}
      </div>
      <p style="font-size:13px;">${ambEsc(sector)}${r && r.travel_date ? ` on <b>${ambEsc(r.travel_date)}</b>` : ''}
        — it is with the desk now, and appears in Booking Enquiries exactly as a
        merchant-raised one does.</p>`, footHtml, opts);
  };
}

/* ------------------------------------------------------------ raise booking --
   THE ROW CLICKED IS THE ENQUIRY CONVERTED. The id travels on the button
   (`data-amb-raise`), so nothing depends on a "currently selected" variable
   that a second click elsewhere could have moved.

   THERE IS NO QUOTATION GATE ON THIS PATH, AND THAT IS THE CHANGE.
   ===========================================================================
   This used to refuse an un-quoted enquiry with "Not available yet — a booking
   can only be raised once the desk has quoted this enquiry". That is the
   Merchant Portal's rule (clRequestTicket in classic-enquiry.js), it is still
   right there, and it is untouched: a merchant books the journey WE answered,
   at the fare we named, which is what the Classic track exists to guarantee.

   It was never right HERE. The desk is the party that would send that
   quotation, so on Manual Booking the sentence told the operator to wait for
   itself — and named no way to stop waiting. What the desk is doing at this
   screen is typing up a ticket it has ALREADY arranged, for a merchant that
   telephoned it in; there is no quotation step in that, because there was no
   question. The enquiry is the record of the call and the booking is the
   record of the ticket, so the second must not be gated on an answer to the
   first that nobody is waiting for.

   A Pending or Under Review enquiry therefore opens the form. The server
   allows exactly the same three statuses for this actor (`desk_manual` in
   enquiry_service.to_booking_request), and a Rejected or Cancelled one is
   still refused by both — an enquiry we said no to, or the merchant withdrew,
   does not become bookable because the desk is the one typing.

   ONE GUARD REMAINS, and it is the duplicate one. It is the Merchant Portal's
   own behaviour, case for case: an unsubmitted DRAFT is work in progress and
   reopens with its passengers, and anything past draft is genuinely already
   raised and is named rather than duplicated. The server enforces it again
   with a 409; this only saves a round trip and says it in a sentence. */
async function ambRaiseBooking(enquiryId) {
  ambNote('Opening the booking…', 'muted');
  let enquiry;
  try {
    enquiry = await MerchantApi.getEnquiry(enquiryId);
  } catch (err) {
    ambNote(clError(err, 'Could not open that enquiry.'), 'err');
    return;
  }

  /* THE ROW IS REFRESHED FROM WHAT WE JUST READ, before anything can return.
     The Action column's label is derived from the booking state, and an
     operator who raised one, walked away and came back must not be looking at
     a "Raise Booking" that is really a resume. */
  ambUpsertRow(enquiry);

  let draft = null;
  if (enquiry.booking_request_id) {
    const detail = await MerchantApi.getRequest(enquiry.booking_request_id).catch(() => null);
    const booking = detail?.request || detail;
    /* `.catch(() => null)` rather than a throw: a booking we cannot read must
       not strand the operator on the enquiry screen with an error about a
       booking. It falls through to the sentence below, which names the
       reference they need either way. */
    if (booking && booking.status === 'draft') {
      draft = booking;
    } else {
      ambNote('');
      return clOpenModal('Already raised', `
        <div class="cl-msg cl-msg-muted" style="margin-top:0">
          A booking has already been raised from
          <b>${ambEsc(enquiry.reference_number)}</b> — ${ambEsc(enquiry.booking_request_number || '')}
        </div>
        <!-- NOT "the Approval Queue", which is where this sentence used to send
             the operator and where the booking is not. An enquiry-led booking
             runs the CR-2 Classic track and is signed off by a MANAGER;
             approval_service.list_approval_queue skips is_classic_track rows on
             purpose. Verified against a live server, not assumed — see §8 of
             tests/verify_manual_booking_unquoted.py. The same correction is
             made on the submit confirmation (ambCorrectSubmitted), and the two
             must not drift apart: they answer the same question. -->
        <!-- NAMES NO QUEUE, because a manual booking is on none of them. It is
             saved against its enquiry and reachable from that row, and this
             branch is now only reachable for a booking that somehow left DRAFT
             — nothing in this portal submits one. -->
        <p style="font-size:13px;">Open it with <b>View Booking</b> on that enquiry's row.
          A second booking against one enquiry is refused by the server.</p>`,
        '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    }
  }

  /* THE ONE STATUS GATE LEFT, and it is not the quotation one. Rejected means
     we answered and said no; Cancelled means the merchant withdrew the
     question. Both are answers, and neither becomes bookable because the desk
     is the party typing — so this is the same refusal the server makes for
     this actor, said in a sentence rather than fetched as a 400 after a form
     has been filled in. Checked AFTER the duplicate branch above, because a
     booking that exists should still open whatever became of its enquiry. */
  if (enquiry.status === 'rejected' || enquiry.status === 'cancelled') {
    ambNote('');
    return clOpenModal('Cannot raise a booking', `
      <div class="cl-msg cl-msg-muted" style="margin-top:0">
        <b>${ambEsc(enquiry.status_label || clLabel(enquiry.status))}</b>
        — a booking cannot be raised from an enquiry that was refused or withdrawn.
      </div>
      <p style="font-size:13px;">Raise a new Manual Enquiry for this merchant and
        take the booking from that.</p>`,
      '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
  }
  ambNote('');

  /* Hand the enquiry to the Merchant Portal's screen exactly as its own
     listing does, then render it here. The second argument is the draft being
     resumed, or null on a first pass — it is what routes the next Save to
     update rather than create, which is the other half of not duplicating.
     clGo('booking-request') is the merchant portal's router and does not exist
     in this portal, so the NAVIGATION is this portal's own; the SCREEN is not. */
  clStartBookingRequest(enquiry, draft);
  AMB.pendingEnquiry = enquiry;
  ambGoToManualRequest();
}

/* MANUAL REQUEST IS NOT A CACHEABLE SECTION, AND admin.js CACHES EVERY SECTION.
   ===========================================================================
   `navigateToSection` runs a section's loader ONCE — `loadedSections.add(name)`
   on first arrival, and every later visit only switches the CSS class. That is
   right for a screen whose content is the same each time, and wrong for this
   one: what Manual Request renders is entirely decided by the enquiry carried
   into it, so it has to re-render on every arrival.

   THE BUG THAT MADE THIS NECESSARY, which is worth stating plainly because it
   looked like Raise Booking was broken: an operator who opened Manual Request
   from the SIDEBAR first got the "no enquiry carried in" panel, and that marked
   the section loaded. Pressing Raise Booking afterwards then navigated to a
   section admin.js believed was already built — `initManualRequest` never ran,
   so the screen still read "go to Manual Enquiry and press Raise Booking" on
   top of the enquiry they had just pressed it for. The enquiry was fine, the
   booking was fine, the screen simply never redrew.

   Deleting the name before navigating is the same move the Merchant Portal
   makes for the same reason — `clLoaded.delete('booking-request')` appears in
   clRequestTicket, clStartDirectBooking and clResumeBookingDraft, all of them
   immediately before a clGo. This is that convention, applied to this portal's
   own router.

   BELT AND BRACES, NOT THE FIX ITSELF. `initManualRequest` deletes the same key
   on every arrival, which is what actually guarantees the re-render. This stays
   because that delete only runs if the loader runs at all — a section whose
   host element is missing returns before reaching it, and the key would then be
   left behind for the next arrival to trip over.

   Guarded because `loadedSections` belongs to admin.js: if that file is ever
   reorganised the navigation still happens, and the worst case is the stale
   screen this exists to prevent rather than a ReferenceError that stops the
   navigation altogether. */
function ambGoToManualRequest() {
  try {
    if (typeof loadedSections !== 'undefined') loadedSections.delete('manual-request');
  } catch { /* admin.js's cache is not reachable; navigate anyway */ }
  navigateToSection('manual-request');
}

/* Put a freshly-read enquiry back into the session list, and repaint.
   ===========================================================================
   The list is built from what the API returned at SAVE time, and both facts
   the Action column reads — the status, and whether a booking exists — move
   afterwards. Every place that learns something newer about a row funnels
   through here rather than assigning into AMB.raised in line, so there is one
   definition of "newer" and the repaint cannot be forgotten.

   A row that is not on screen is ignored rather than appended. The table is a
   server-backed page of the desk's manual enquiries (see ambLoadEnquiries), and
   an enquiry outside that page belongs to the next relist, not to a silent
   insertion at whatever position this happened to run. */
/* ----------------------------------------------------------- view booking --
   THE SAVED RECORD, READ BACK FROM THE ENQUIRY THAT OWNS IT.
   ===========================================================================
   Opened from the Action column once a booking exists. It takes the ENQUIRY's
   id, not the booking's, which is the point: the enquiry is the parent record,
   and the booking is found through it (`booking_request_id`) rather than being
   addressed directly. That is the same relationship the table reads to decide
   which button to show, so the modal cannot disagree with the row that opened
   it.

   TWO READS, BOTH EXISTING ENDPOINTS:
     GET /api/enquiries/{id}    the journey, the merchant, the reference
     GET /api/requests/{id}     the travellers, the PNR, the ticket, the fare

   READ-ONLY, with one way out to the form. Correcting a mistyped PNR is a real
   need and reopening the same draft is how it is done — [Edit booking] hands
   the SAME booking back to the form, so the next Save updates it. It never
   creates a second one: ambRaiseBooking is not reachable for a row that has a
   booking, and the server refuses a second with a 409 regardless. */
async function ambViewBooking(enquiryId) {
  ambNote('Opening the booking…', 'muted');
  let enquiry;
  let booking;
  let docs = [];
  try {
    enquiry = await MerchantApi.getEnquiry(enquiryId);
    ambUpsertRow(enquiry);
    if (!enquiry.booking_request_id) {
      /* The row is stale — the booking it advertised is not there. Repainted
         above, so the operator's next click offers Raise Booking. */
      ambNote('');
      return clOpenModal('No booking yet', `
        <div class="cl-msg cl-msg-muted" style="margin-top:0">
          No booking is saved against <b>${ambEsc(enquiry.reference_number)}</b> any more.
        </div>
        <p style="font-size:13px;">The row has been refreshed — press Raise Booking to enter one.</p>`,
        '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    }
    const detail = await MerchantApi.getRequest(enquiry.booking_request_id);
    booking = detail.request || detail;
    /* A third read, and a forgiving one. Documents are worth showing but never
       worth failing the modal over — a booking whose files cannot be listed is
       still a booking the operator needs to see. */
    docs = await MerchantApi.listDocuments(booking.id).catch(() => []);
  } catch (err) {
    ambNote(clError(err, 'Could not open that booking.'), 'err');
    return;
  }
  ambNote('');

  const d = booking.details || {};
  const leg = (code, city) => (city ? `${city} (${code})` : (code || ''));
  const sector = [leg(enquiry.origin, enquiry.origin_city),
                  leg(enquiry.destination, enquiry.destination_city)]
    .filter(Boolean).join(enquiry.trip_type === 'round_trip' ? ' ⇄ ' : ' → ');

  /* An empty value prints an em dash rather than being dropped: "Ticket number
     —" tells the operator the field exists and is blank, which is a different
     fact from the row not being shown at all. */
  const row = (label, value) => `
    <div><dt>${ambEsc(label)}</dt><dd>${value ? ambEsc(value) : '—'}</dd></div>`;

  const pax = (booking.passengers || []);
  const paxRows = pax.length
    ? pax.map((x, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><strong>${ambEsc([x.title, x.first_name, x.last_name].filter(Boolean).join(' '))}</strong></td>
          <td>${ambEsc(x.passenger_type || '')}</td>
          <td>${ambEsc(x.gender || '')}</td>
          <td>${ambEsc(x.dob || '')}</td>
          <td>${ambEsc(x.nationality || '')}</td>
          <td>${ambEsc(x.passport_number || '—')}</td>
          <td>${ambEsc(x.passport_expiry || '—')}</td>
        </tr>`).join('')
    : '<tr><td colspan="8" class="empty-state">No passengers recorded.</td></tr>';

  const money = (v) => (v == null || v === '' ? '' : `INR ${v}`);

  /* Named against the traveller they belong to where one was given, because a
     passport scan with no name beside it is the one document an operator
     cannot act on. Download is a button rather than a link for the reason
     ambDocDownload explains: the endpoint needs the bearer token. */
  const paxName = (id) => {
    const x = pax.find(p => String(p.id) === String(id));
    return x ? [x.title, x.first_name, x.last_name].filter(Boolean).join(' ') : '';
  };
  const docRows = docs.length
    ? `<div style="overflow-x:auto;">
         <table class="data-table" style="min-width:560px;"><thead><tr>
           <th>File</th><th>Type</th><th>Belongs to</th><th>Size</th><th>Status</th><th></th>
         </tr></thead><tbody>${docs.map(d => `
           <tr>
             <td><strong>${ambEsc(d.original_filename)}</strong></td>
             <td>${ambEsc(ambDocTypeLabel(d.doc_type))}</td>
             <td>${ambEsc(d.passenger_id ? paxName(d.passenger_id) : 'The whole booking')}</td>
             <td>${ambEsc(ambDocSize(d.size_bytes))}</td>
             <td>${ambEsc(d.verification_label || d.verification_status || '')}</td>
             <td><button type="button" class="cl-btn cl-btn-sm"
                   data-amb-modal-doc="${ambEsc(d.id)}">Download</button></td>
           </tr>`).join('')}</tbody></table>
       </div>`
    : '<p class="cl-kpi-sub" style="margin:0;">No documents attached. '
      + 'Use <b>Edit booking</b> to add one.</p>';

  clOpenModal('Booking Information', `
    <dl class="cl-dl">
      ${row('Enquiry', enquiry.reference_number)}
      ${row('Booking', booking.request_number)}
      ${row('Merchant', enquiry.merchant_name || ambMerchantName(enquiry.merchant_id))}
      ${row('Journey', sector)}
      ${row('Travel date', enquiry.travel_date)}
      ${enquiry.return_date ? row('Return date', enquiry.return_date) : ''}
      ${row('Airline', d.airline)}
      ${row('Flight', d.flight_number)}
      ${row('PNR', booking.pnr)}
      ${row('Ticket number', booking.ticket_number)}
      ${row('Fare', money(booking.client_fare))}
      ${row('Booking reference', booking.booking_reference)}
      ${row('Raised by', booking.raised_by)}
    </dl>
    <h3 style="margin:18px 0 8px; font-size:14px;">Passengers</h3>
    <div style="overflow-x:auto;">
      <table class="data-table" style="min-width:640px;"><thead><tr>
        <th>#</th><th>Name</th><th>Type</th><th>Gender</th><th>Date of birth</th>
        <th>Nationality</th><th>Passport</th><th>Expiry</th>
      </tr></thead><tbody>${paxRows}</tbody></table>
    </div>
    <h3 style="margin:18px 0 8px; font-size:14px;">Documents</h3>
    ${docRows}`,
    `<button type="button" class="cl-btn cl-btn-primary" data-amb-edit="${ambEsc(enquiryId)}">Edit booking</button>
     <button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>`);

  /* Bound after the modal exists, and to the modal rather than the document, so
     it dies with the dialog it belongs to. */
  document.querySelector('[data-amb-edit]')?.addEventListener('click', () => {
    clCloseModal();
    ambRaiseBooking(enquiryId);
  });

  /* The modal has its own copy of the documents, so ambDocDownload's lookup
     into AMB.docs.saved would miss — it is seeded here for the length of the
     dialog rather than given a second download function to keep in step. */
  AMB.docs.saved = docs;
  document.getElementById('clModalBody')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-amb-modal-doc]');
    if (b) ambDocDownload(Number(b.dataset.ambModalDoc));
  });
}

function ambUpsertRow(enquiry) {
  const i = AMB.raised.findIndex(r => String(r.id) === String(enquiry.id));
  if (i < 0) return;
  AMB.raised[i] = { ...enquiry, __merchantName: AMB.raised[i].__merchantName };
  if (typeof clRenderEnquiryRows === 'function') clRenderEnquiryRows();
}

/* THE TABLE IS READ FROM THE SERVER, NOT REMEMBERED.
   ===========================================================================
   It used to hold only what THIS SITTING had raised — an in-memory array the
   API bridge appended to — and that made a page reload erase it. Fine while
   the screen was only a receipt for what you had just typed; wrong once the
   requirement became "Save, come back to this table, and see the booking
   against its enquiry", because a refresh is exactly when an operator looks
   for work they saved earlier.

   `source=b2b_manual_enquiry` is what makes this listable at all: it is the
   column migration 0073 added, and it distinguishes an enquiry THE DESK typed
   from one a merchant typed for itself. Without it there is no query for "the
   desk's own enquiries" — only "every enquiry on the platform", which is the
   Ticket Enquiries screen and a different screen's job.

   Newest first, one page. The desk works today's calls; an operator hunting a
   month-old reference has Ticket Enquiries, which searches. */
async function ambLoadEnquiries() {
  const data = await MerchantApi.listEnquiries({
    source: 'b2b_manual_enquiry', page: 1, page_size: 50,
  });
  AMB.raised = (data.items || data.results || data || []).filter(Boolean);
  if (typeof clRenderEnquiryRows === 'function') clRenderEnquiryRows();
  return AMB.raised;
}

/* Re-read the rows that are on screen.
   ===========================================================================
   Two things move underneath this table and both change what the Action column
   must say: the enquiry's STATUS (the desk answers it elsewhere) and whether a
   BOOKING now exists against it.

   RE-ENTERING THE SECTION IS NOT ENOUGH ON ITS OWN. admin.js caches sections in
   `loadedSections` and runs a loader once, so navigating away and back does NOT
   re-run initManualEnquiry. So this is wired three ways: an extra listener on
   the sidebar item (additive; admin.js's own handler still runs), the Refresh
   button on the panel, and the return from Save.

   A FULL RELIST, not N reads of the rows already held. It is one request
   instead of one per row, and it is the only version that picks up an enquiry
   raised in ANOTHER tab or by another operator — which the per-row refresh
   could never do, because a row it had never seen was not in the list to
   re-read. */
async function ambRefreshStatuses() {
  try {
    await ambLoadEnquiries();
  } catch {
    /* Leave the rows standing rather than blanking the table: a stale list is
       far more useful than an empty one, and every action re-reads its own
       enquiry before acting anyway. */
  }
}

/* --------------------------------------------------------------- merchants */
async function ambLoadMerchants() {
  /* PAGED — the endpoint caps page_size at 100 and 422s above it. A picker
     silently showing the first hundred would be worse than an error: the
     company you needed would just not be there. */
  const PAGE = 100;
  const all = [];
  let page = 1;
  let total = Infinity;
  while (all.length < total && page <= 50) {
    const { data } = await axios.get(`${API_BASE}/api/admin/merchants`, {
      headers: authHeaders(),
      params: { page, page_size: PAGE },
    });
    const rows = Array.isArray(data) ? data : (data.items || data.results || []);
    total = Array.isArray(data) ? rows.length : (Number(data.total) || rows.length);
    all.push(...rows);
    if (!rows.length || rows.length < PAGE) break;
    page += 1;
  }
  AMB.merchants = all.filter(m => m && (m.merchant_id ?? m.id));
  /* Alphabetical: the desk is looking for a company by name, and creation
     order means nothing to whoever is on the phone. */
  AMB.merchants.sort((a, b) =>
    String(a.company_name || a.name || '').localeCompare(String(b.company_name || b.name || '')));
  return AMB.merchants;
}

/* ------------------------------------------------------------------ screen */
function ambEnquiryScreenHtml() {
  const options = ['<option value="">Select a merchant…</option>'].concat(
    AMB.merchants.map(m => {
      const id = m.merchant_id ?? m.id;
      return `<option value="${ambEsc(id)}">${ambEsc(m.company_name || m.name || `Merchant ${id}`)}</option>`;
    })
  ).join('');

  return `
    <div class="panel">
      <div class="panel-head"><h2>Manual Enquiry</h2></div>
      <p style="margin:0 0 16px; font-size:13.5px; color:var(--text-muted);">
        Raise a Booking Enquiry on a merchant's behalf. This is the same form the
        merchant sees in its own portal; the enquiry is filed against the company
        chosen here and reaches the desk exactly as a merchant-raised one does.
      </p>
      <div class="form-grid">
        <div class="form-field"><label>Merchant *</label>
          <select id="ambMerchant" class="status-select">${options}</select>
        </div>
      </div>
      <div style="margin-top:16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <button type="button" class="btn btn-coral" id="ambNewEnquiry">New Booking Enquiry</button>
        <button type="button" class="btn btn-ghost btn-sm" id="ambRefresh">Refresh statuses</button>
        <span id="ambMsg" role="status" aria-live="polite" style="font-size:13.5px;"></span>
      </div>
    </div>
    <div id="ambRecent"></div>`;
}

function ambNote(text, kind) {
  const el = document.getElementById('ambMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = kind === 'err' ? 'var(--danger, #C0392B)'
    : kind === 'ok' ? 'var(--success, #1c7c4a)' : 'var(--text-muted)';
}

/* THE ONLY PLACE THE FORM IS OPENED, and the merchant gate sits in front of
   it. Opening first and refusing on submit would waste a filled-in form. */
function ambOpenEnquiryForm() {
  AMB.merchantId = document.getElementById('ambMerchant').value || null;
  if (!AMB.merchantId) {
    ambNote('Choose the merchant this enquiry is for.', 'err');
    document.getElementById('ambMerchant').focus();
    return;
  }
  ambNote('');
  if (typeof clOpenEnquiryForm !== 'function') {
    ambNote('The enquiry form did not load. Reload the page and try again.', 'err');
    return;
  }
  /* false = enquiry-led. The `direct` mode hands the itinerary to Booking
     Request, which this portal does not mount. */
  clOpenEnquiryForm(false);
}

/* --------------------------------------------------------------------- init */
async function initManualEnquiry() {
  const host = document.getElementById('section-manual-enquiry');
  if (!host) return;
  ambInstallApiBridge();
  ambInstallRowRenderer();
  ambInstallWording();

  host.innerHTML = '<div class="panel"><div class="panel-head"><h2>Loading…</h2></div></div>';
  try {
    await ambLoadMerchants();
  } catch {
    host.innerHTML = `<div class="panel"><div class="panel-head"><h2>Manual Enquiry</h2></div>
      <p style="padding:16px">Could not load the merchant list.
      <button type="button" class="btn btn-sm" id="ambRetry">Retry</button></p></div>`;
    document.getElementById('ambRetry')?.addEventListener('click', initManualEnquiry);
    return;
  }

  host.innerHTML = ambEnquiryScreenHtml();
  document.getElementById('ambNewEnquiry').addEventListener('click', ambOpenEnquiryForm);
  document.getElementById('ambRefresh').addEventListener('click', async () => {
    ambNote('Re-reading statuses…', 'muted');
    await ambRefreshStatuses();
    ambNote('');
  });
  /* Additive: admin.js's own nav handler still switches the section; this only
     re-reads the statuses, which its section cache would otherwise skip. Bound
     once, because initManualEnquiry itself runs once. */
  document.querySelector('.nav-item[data-section="manual-enquiry"]')
    ?.addEventListener('click', () => { ambRefreshStatuses(); });
  /* Delegated on the host, because the session table is re-rendered after every
     save and a handler bound to a button would not survive its own row. */
  host.addEventListener('click', (e) => {
    const raise = e.target.closest('[data-amb-raise]');
    if (raise) return ambRaiseBooking(raise.dataset.ambRaise);
    const view = e.target.closest('[data-amb-view]');
    if (view) return ambViewBooking(view.dataset.ambView);
  });
  /* Re-render the session list if the desk has already raised some and come
     back to the screen. */
  if (typeof clRenderEnquiryRows === 'function') clRenderEnquiryRows();
  /* Not awaited: the screen is usable immediately and the statuses settle a
     moment later. Awaiting would hold an empty panel on screen while N
     enquiries are re-read one round trip each. */
  ambRefreshStatuses();
}

function initManualRequest() {
  const host = document.getElementById('section-manual-request');
  if (!host) return;

  /* THIS SECTION UNCACHES ITSELF, ON EVERY ARRIVAL.
     -----------------------------------------------------------------------
     `navigateToSection` adds the name to `loadedSections` and THEN calls the
     loader, so deleting it here means the section is never considered built
     and re-renders every time it is shown — from Raise Booking, from the
     sidebar, from anywhere.

     WHY IT HAS TO BE HERE AND NOT ONLY AT THE CALL SITE. Deleting the key just
     before navigating fixes Raise Booking, and leaves the SIDEBAR broken in the
     other direction: after a booking was saved, clicking Manual Request showed
     the previous booking's form, frozen at the "Saving…" message it had when
     the operator left it — stale DOM from a render that was never repeated,
     presented as if it were live. Both directions are the same fault, so both
     are fixed in the one place every arrival passes through.

     Everything this screen renders depends on which enquiry was carried in, so
     there is nothing here worth caching; the cost is one re-render of a panel
     that is rebuilt from data already in hand. */
  try {
    if (typeof loadedSections !== 'undefined') loadedSections.delete('manual-request');
  } catch { /* admin.js's cache is not reachable; render anyway */ }

  /* NO ENQUIRY CARRIED IN. Arriving from the sidebar rather than from Raise
     Booking is a legitimate thing to do and needs an answer, not a blank
     panel. It says where bookings come from instead of offering a form that
     could not be submitted — the itinerary is copied from the enquiry
     server-side, so there is nothing to fill in without one. */
  if (!AMB.pendingEnquiry) {
    host.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Manual Booking</h2></div>
        <p style="padding:4px 0 8px; font-size:13.5px; color:var(--text-muted); max-width:72ch;">
          A booking is raised FROM an enquiry — its journey is copied from that
          enquiry server-side, so there is nothing to type here without one. The
          enquiry does not have to have been quoted.
        </p>
        <!-- A BUTTON, NOT ONLY AN INSTRUCTION. This panel is what an operator
             sees when they reach Manual Request from the sidebar, which is a
             reasonable thing to do and used to end in a sentence telling them
             to navigate somewhere else by hand. Offering the navigation is one
             click instead of three, and it is the only action this screen has
             in this state. -->
        <button type="button" class="btn btn-coral btn-sm" id="ambGoToEnquiries">
          Go to Manual Enquiry
        </button>
      </div>`;
    document.getElementById('ambGoToEnquiries')
      ?.addEventListener('click', () => navigateToSection('manual-enquiry'));
    return;
  }

  /* THE MERCHANT PORTAL'S SCREEN, rendered into this portal. `cl-embed` carries
     the generated merchant stylesheet; `cl-booking-request` is the element
     classic-booking.js writes into, named exactly as it is over there. */
  const enquiry = AMB.pendingEnquiry;
  AMB.pendingEnquiry = null;
  host.innerHTML = `
    <div style="margin-bottom:14px;">
      <button type="button" class="btn btn-ghost btn-sm" id="ambBackToEnquiry">← Back to Manual Enquiry</button>
    </div>
    <div class="cl-embed"><div id="cl-booking-request"></div></div>`;
  /* RETURNING RE-READS THE ROW, because the operator has almost certainly just
     changed it. Leaving this screen means a booking was saved, submitted or
     abandoned, and in the first two cases the enquiry now carries a
     `booking_request_id` that its Action column has to reflect — otherwise the
     row still offers "Raise Booking" for a booking that exists, and the next
     click has to discover that from the server.

     `clGo('enquiry'|'requests')` on the confirmation screen lands on this same
     section through admin-enquiry-host.js, and the nav item carries its own
     refresh listener, so every way OUT of Manual Request now repaints the list
     it returns to. Not awaited: the section switch is instant and the labels
     settle a moment later, which is the same bargain initManualEnquiry makes. */
  document.getElementById('ambBackToEnquiry')
    .addEventListener('click', () => {
      navigateToSection('manual-enquiry');
      ambRefreshStatuses();
    });

  if (typeof clRenderBookingForm !== 'function') {
    document.getElementById('cl-booking-request').innerHTML =
      '<div class="cl-msg cl-msg-err">The booking form did not load. Reload the page and try again.</div>';
    return;
  }
  /* Before the render, not after: clRenderBookingForm can submit and confirm
     without this function running again. */
  AMB.converting = {
    quoted: enquiry.quoted_fare != null,
    /* The API's own name first — it is the company the row was FILED against,
       which is the only one worth printing. The picker lookup is the fallback
       for a row read back before EnquiryResponse carried merchant_id. */
    merchantName: enquiry.merchant_name
      || enquiry.__merchantName
      || ambMerchantName(enquiry.merchant_id)
      || '',
  };
  clRenderBookingForm(enquiry);
  ambCorrectUnquotedStep(enquiry);
  ambInstallTicketPanel(enquiry);
  ambInstallHold();
  ambInstallDocumentsPanel();
}

/* --------------------------------------------------------------- hold --
   HAS THE MERCHANT SETTLED THIS BOOKING?
   ===========================================================================
   One checkbox, and the invoice's payment status follows from it:

       checked    ->  Invoice Status: Due
       unchecked  ->  Invoice Status: Paid

   WHY A FLAG AND NOT A STATUS DROPDOWN. A manual booking has no ledger to read
   — nothing is billed through this platform for a ticket the desk bought
   off-platform, so every payment query comes back empty and the invoice would
   say "Pending" however the money really moved. The desk knows the answer; the
   screen asks for it once, as the single fact it is.

   THE STATUS IS NEVER SENT FROM HERE. Only `hold` is saved;
   `invoice_layout._payment_facts` derives Due/Paid from it every time the
   invoice renders. That is what makes hold=true/status=paid unrepresentable
   rather than merely discouraged — there is no status field to disagree with
   the flag, and no endpoint that accepts one.

   Placed immediately above Documents, in the merchant screen's own panel
   markup so it inherits the page's spacing and controls rather than
   introducing a style of its own. */
function ambInstallHold() {
  const docPanelAnchor = document.querySelector('#cl-booking-request .cl-form-actions');
  if (!docPanelAnchor) return;

  /* The saved value, so reopening a booking shows what was stored rather than
     resetting to the default. `travel_details.hold` is where update_draft
     writes it; `details` is how RequestResponse exposes travel_details. */
  const saved = !!(clBookingDraft?.details || {}).hold;

  const panel = document.createElement('div');
  panel.className = 'cl-panel';
  panel.id = 'ambHoldPanel';
  panel.innerHTML = `
    <div class="cl-panel-body">
      <label style="display:flex; align-items:center; gap:10px; cursor:pointer; margin:0;">
        <input type="checkbox" id="ambHold"${saved ? ' checked' : ''}
               style="width:16px; height:16px; margin:0; cursor:pointer;">
        <span style="font-weight:600;">Hold</span>
      </label>
    </div>`;

  const target = docPanelAnchor.closest('.cl-panel') || docPanelAnchor;
  target.insertAdjacentElement('beforebegin', panel);

}

/* NO EXPLANATORY NOTE UNDER THE CHECKBOX. There was one, saying which way the
   invoice would read; it is gone at the operator's request. The label is the
   whole control now — the desk knows what Hold means, and a sentence repeating
   it under every booking is noise on a form that already runs long. */
function ambHoldValue() {
  return !!document.getElementById('ambHold')?.checked;
}

/* --------------------------------------------------- the ticket, and [Save] --
   WHAT THE MERCHANT'S FORM DOES NOT COLLECT, AND WHY IT IS ADDED HERE.
   ===========================================================================
   The Merchant Portal's Booking Request screen collects who is travelling and
   how to reach them, and nothing about a ticket — because on that track no
   ticket exists yet. The merchant is ASKING us to buy one; the PNR and the
   ticket number are allocated by `ticket_service.issue_ticket` at the far end
   of the workflow, after a Manager has approved and the desk has bought.

   Manual Booking runs that story backwards. The desk has already arranged the
   ticket over the phone and is recording it, so the PNR and the ticket number
   are facts in hand before the row exists. They are therefore the one thing
   this screen must collect that the merchant's never does.

   NOT NEW FIELDS. All five are existing storage:
     pnr             service_requests.pnr            (String(20))
     ticket_number   service_requests.ticket_number  (String(40), UNIQUE)
     airline         travel_details.airline          (the enquiry's own key)
     flight_number   travel_details.flight_number    (likewise)
     fare            service_requests.client_fare    (0040)
   Nothing was invented and no table was added — see UpdateDraftRequest.

   AIRLINE AND FLIGHT ARE PRE-FILLED FROM THE ENQUIRY AND STILL EDITABLE. Every
   other itinerary field is copied server-side and locked, deliberately. These
   two are the exception because an enquiry routinely says "All Airlines" and
   carries no flight number — finding one is what was asked of us — so what was
   actually booked is known only now.

   THE BUTTONS ARE REPLACED, NOT HIDDEN. "Submit for approval" and "Save as
   draft" are the merchant's two acts and neither is this one: there is no
   approval to submit to, and a record of a bought ticket is not a draft. One
   [Save] replaces both, in the merchant's own markup so it looks like the rest
   of the screen. */
function ambInstallTicketPanel(enquiry) {
  const actions = document.querySelector('#cl-booking-request .cl-form-actions');
  if (!actions) return;

  const d = clBookingDraft || {};
  const det = d.details || {};
  const val = (v) => ambEsc(v == null ? '' : v);
  /* The draft's own value wins when one is being resumed, then the enquiry's.
     Reading the draft first is what makes a correction stick: an operator who
     fixed the airline and came back must not see the enquiry's "All Airlines"
     again. */
  const airline = det.airline ?? enquiry.airline ?? '';
  const flight = det.flight_number ?? enquiry.flight_number ?? '';

  const panel = document.createElement('div');
  panel.className = 'cl-panel';
  panel.id = 'ambTicketPanel';
  panel.innerHTML = `
    <div class="cl-panel-head"><h2>Ticket details</h2></div>
    <div class="cl-panel-body">
      <p class="cl-kpi-sub" style="margin:0 0 12px;">
        The ticket as you arranged it. Nothing here contacts an airline or a
        supplier, and no amount is taken from the merchant's wallet — this
        records what was bought.
      </p>
      <div class="cl-form cl-form-2">
        <div class="cl-field">
          <label for="ambPnr">PNR</label>
          <input type="text" id="ambPnr" maxlength="20" autocomplete="off"
            value="${val(d.pnr)}" placeholder="e.g. ABC123">
        </div>
        <div class="cl-field">
          <label for="ambTicketNo">Ticket number</label>
          <input type="text" id="ambTicketNo" maxlength="40" autocomplete="off"
            value="${val(d.ticket_number)}" placeholder="e.g. 0987654321">
        </div>
        <div class="cl-field">
          <label for="ambAirline">Airline</label>
          <input type="text" id="ambAirline" maxlength="100" autocomplete="off"
            value="${val(airline)}">
        </div>
        <div class="cl-field">
          <label for="ambFlightNo">Flight number</label>
          <input type="text" id="ambFlightNo" maxlength="20" autocomplete="off"
            value="${val(flight)}" placeholder="e.g. AI283">
        </div>
        <div class="cl-field">
          <label for="ambFare">Fare</label>
          <input type="number" id="ambFare" min="0" step="0.01" inputmode="decimal"
            value="${val(d.client_fare)}" placeholder="0.00">
          <small>What the merchant is charged for this booking, in INR.</small>
        </div>
      </div>
    </div>`;
  /* Above the actions, below the passengers — the order the operator fills it
     in, and the order the confirmation reads it back. */
  actions.closest('.cl-panel')?.insertAdjacentElement('beforebegin', panel)
    || actions.insertAdjacentElement('beforebegin', panel);

  actions.innerHTML = `
    <button type="button" class="cl-btn cl-btn-primary" id="ambSaveBtn">Save</button>
    <span class="cl-kpi-sub">Saved against this enquiry. It does not go to the
      Approval Queue, to a Manager, or to Booking Operations.</span>`;
  document.getElementById('ambSaveBtn')
    .addEventListener('click', ambSaveManualBooking);
}

/* ------------------------------------------------------------- documents --
   ATTACHING PAPERWORK TO A MANUAL BOOKING.
   ===========================================================================
   The desk raising a booking over the phone usually has files to go with it —
   a passport scan, a visa, the airline's e-ticket, the signed group manifest.
   There was nowhere to put them: the upload UI was removed from the Merchant
   Portal's Booking Request screen when documents left the merchant flow, and
   Manual Request inherited that screen without one.

   NO BACKEND CHANGE WAS NEEDED, AND THAT IS NOT LUCK. The endpoint has always
   been there — POST /api/requests/{id}/documents — and its gate opens for
   exactly this case:

       if request.status is S.DRAFT:
           return                      # document_service._assert_may_modify

   A manual booking is saved at DRAFT and stays there, so every document type
   is attachable for as long as the booking exists. The Admin reaches the route
   on `ticket.issue`, which it already holds. Nothing was widened to make this
   work; the rules already said yes.

   ONE PANEL FOR ALL THREE TRIP TYPES. Nothing here reads the trip type, so One
   Way, Round Trip and Group Booking get the identical control — and a group
   booking additionally gets `group_manifest` in the type list, which is the
   value migration 0042 added so the desk can tell a manifest from a scan in a
   listing.

   WHY FILES ARE QUEUED RATHER THAN UPLOADED ON CHOOSE. A document is attached
   to a booking id, and on a first Raise Booking there is no booking yet — it is
   created by Save. Uploading on choose would therefore work when resuming and
   fail when raising, which is the kind of split that teaches an operator not to
   trust a control. So every file waits in `AMB.docs.queued` and goes up right
   after the booking exists, on both paths. Type and size are checked here, when
   the file is chosen, so a bad file is refused immediately rather than at Save.
*/
const AMB_DOC_TYPES = [
  ['passport', 'Passport'],
  ['visa', 'Visa'],
  ['photo_id', 'Photo ID'],
  ['ticket', 'Ticket / e-ticket'],
  ['group_manifest', 'Group manifest'],
  ['other', 'Other'],
];
/* The four the server will accept, mirrored from document_service._SIGNATURES.
   It sniffs the leading bytes too, so this list is a courtesy — it turns a
   wrong file into an immediate sentence instead of a 400 after Save. */
const AMB_DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const AMB_DOC_MAX_MB = 10;               // settings.max_upload_mb

const ambDocSize = (n) => (n >= 1024 * 1024
  ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.round(n / 1024))} KB`);

const ambDocTypeLabel = (v) =>
  (AMB_DOC_TYPES.find(t => t[0] === v) || [null, v])[1];

function ambInstallDocumentsPanel() {
  const actions = document.querySelector('#cl-booking-request .cl-form-actions');
  if (!actions) return;

  AMB.docs = { saved: [], queued: [] };

  const panel = document.createElement('div');
  panel.className = 'cl-panel';
  panel.id = 'ambDocPanel';
  panel.innerHTML = `
    <div class="cl-panel-head"><h2>Documents</h2></div>
    <div class="cl-panel-body">
      <p class="cl-kpi-sub" style="margin:0 0 12px;">
        Passport or visa scans, the airline's e-ticket, a signed manifest — anything
        that belongs with this booking. PDF, JPEG, PNG or WebP, up to
        ${AMB_DOC_MAX_MB} MB each. They are attached when you press Save.
      </p>
      <div class="cl-field" style="margin-top:4px;">
        <label for="ambDocFile">Upload Document</label>
        <input type="file" id="ambDocFile"
          accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp">
      </div>
      <div id="ambDocMsg" class="cl-msg" style="margin-top:8px;"></div>
      <div id="ambDocList" style="margin-top:12px;"></div>

      <!-- THE INVOICE, BESIDE THE UPLOAD BUT NOT PART OF IT. A file the desk
           attaches is evidence that travels with the booking; the invoice is a
           document this platform produces from the booking's own rows. They
           share a panel because that is where the operator looks for
           paperwork, and nothing else. -->
      <div class="cl-form-actions" style="margin-top:14px;">
        <button type="button" class="cl-btn cl-btn-primary" id="ambInvGenerate">Generate Invoice</button>
        <button type="button" class="cl-btn" id="ambInvDownload">Download Invoice</button>
        <span class="cl-kpi-sub" id="ambInvHint">Save the booking first — the invoice is built from its saved rows.</span>
      </div>
      <div id="ambInvMsg" class="cl-msg" style="margin-top:8px;"></div>
    </div>`;

  actions.closest('.cl-panel')?.insertAdjacentElement('beforebegin', panel)
    || actions.insertAdjacentElement('beforebegin', panel);

  document.getElementById('ambDocFile').addEventListener('change', ambDocChoose);
  /* Delegated: both lists are re-rendered after every add and removal, so a
     handler bound to a button would not survive its own row. */
  document.getElementById('ambDocList').addEventListener('click', ambDocListClick);
  document.getElementById('ambInvGenerate').addEventListener('click', () => ambInvoice(false));
  document.getElementById('ambInvDownload').addEventListener('click', () => ambInvoice(true));
  ambInvSyncButtons();

  ambDocRenderList();
  /* A resumed booking already has files on the server. Not awaited — the panel
     is usable immediately and the saved list appears a moment later. */
  ambDocLoadSaved();
}

async function ambDocLoadSaved() {
  if (!clBookingDraft?.id) return;
  try {
    AMB.docs.saved = await MerchantApi.listDocuments(clBookingDraft.id) || [];
  } catch {
    /* A booking whose documents cannot be listed is still a booking. The panel
       keeps working for new files rather than showing an error about old ones. */
    AMB.docs.saved = [];
  }
  ambDocRenderList();
}

function ambDocMsg(text, kind) {
  const el = document.getElementById('ambDocMsg');
  if (!el) return;
  el.className = `cl-msg${text ? ` cl-msg-${kind || 'muted'}` : ''}`;
  el.textContent = text || '';
}

function ambDocChoose(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;

  /* CHECKED NOW, NOT AT SAVE. The server sniffs the leading bytes and caps the
     size; both of those are the real guarantee. Repeating them here is only so
     the operator learns about a wrong file while they still have the dialog in
     mind, rather than after filling in a booking. */
  if (!AMB_DOC_MIME.includes(file.type)) {
    /* The file's own name, not its MIME type. A spreadsheet reports itself as
       `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, and
       echoing seventy characters of that at an operator explains nothing they
       can act on — what they need is which file, and what is accepted. */
    ambDocMsg(`${file.name} is not a PDF, JPEG, PNG or WebP.`, 'err');
    input.value = '';
    return;
  }
  if (file.size > AMB_DOC_MAX_MB * 1024 * 1024) {
    ambDocMsg(`${file.name} is ${ambDocSize(file.size)}. `
      + `Files must be ${AMB_DOC_MAX_MB} MB or smaller.`, 'err');
    input.value = '';
    return;
  }

  /* NO TYPE AND NO TRAVELLER ARE CHOSEN ON THIS SCREEN ANY MORE. Both controls
     were removed from Manual Request; the desk attaching paperwork to a phone
     booking was being asked to classify it first, which is a question it does
     not need to answer to get the file onto the booking.

     `docType` is left undefined, so `MerchantApi.uploadDocument`'s own default
     of 'other' applies — the same value `routers/documents.py` would have used
     anyway (`doc_type: DocumentType = Form(DocumentType.OTHER)`). This screen
     names no type of its own. `passengerId` is null, which is the endpoint's
     documented "booking-level paperwork" case. Nothing about the upload API
     changed, and both fields still exist everywhere else they were offered. */
  AMB.docs.queued.push({
    file,
    docType: undefined,
    passengerId: null,
    passengerLabel: '',
  });
  /* Cleared so the same file can be chosen twice — two scans of a two-page
     passport are a real thing, and `change` does not fire for an identical
     value. */
  input.value = '';
  ambDocMsg('');
  ambDocRenderList();
}

function ambDocListClick(e) {
  const drop = e.target.closest('[data-amb-doc-drop]');
  if (drop) {
    AMB.docs.queued.splice(Number(drop.dataset.ambDocDrop), 1);
    ambDocMsg('');
    return ambDocRenderList();
  }
  const get = e.target.closest('[data-amb-doc-get]');
  if (get) return ambDocDownload(Number(get.dataset.ambDocGet));
  const del = e.target.closest('[data-amb-doc-del]');
  if (del) return ambDocDelete(Number(del.dataset.ambDocDel));
}

function ambDocRenderList() {
  const host = document.getElementById('ambDocList');
  if (!host) return;
  const { saved, queued } = AMB.docs;
  if (!saved.length && !queued.length) { host.innerHTML = ''; return; }

  const row = (cells) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;

  const savedRows = saved.map(d => row([
    `<strong>${ambEsc(d.original_filename)}</strong>`,
    ambEsc(ambDocTypeLabel(d.doc_type)),
    ambEsc(ambDocSize(d.size_bytes)),
    ambEsc(d.verification_label || d.verification_status || ''),
    `<button type="button" class="cl-btn cl-btn-sm" data-amb-doc-get="${ambEsc(d.id)}">Download</button>
     <button type="button" class="cl-btn cl-btn-sm" data-amb-doc-del="${ambEsc(d.id)}">Remove</button>`,
  ])).join('');

  /* Queued rows say "On save" where a saved one shows its verification state,
     so the two are never mistaken for each other in the same table. */
  /* The Type cell stays in the table because SAVED rows still carry one — a
     file uploaded before this screen dropped the control, or from any other
     surface. A queued row leaves it blank rather than printing the default it
     will be given, which would look like a choice the operator made. */
  const queuedRows = queued.map((q, i) => row([
    `<strong>${ambEsc(q.file.name)}</strong>`,
    q.docType ? ambEsc(ambDocTypeLabel(q.docType)) : '',
    ambEsc(ambDocSize(q.file.size)),
    '<span class="cl-tag">On save</span>',
    `<button type="button" class="cl-btn cl-btn-sm" data-amb-doc-drop="${i}">Remove</button>`,
  ])).join('');

  host.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="data-table" style="min-width:560px;"><thead><tr>
        <th>File</th><th>Type</th><th>Size</th><th>Status</th><th>Action</th>
      </tr></thead><tbody>${savedRows}${queuedRows}</tbody></table>
    </div>`;
}

async function ambDocDownload(documentId) {
  const doc = AMB.docs.saved.find(d => String(d.id) === String(documentId));
  ambDocMsg('Opening…', 'muted');
  try {
    /* The endpoint is authenticated, so a plain href cannot fetch it. The
       client pulls the bytes with the bearer token and returns an OBJECT URL —
       not a blob — and its own comment says the caller must revoke it, which
       the timeout below does once the click has been dispatched.

       The download name comes from our own record rather than from the
       response: the server sends one in Content-Disposition, but axios does not
       surface it through a blob response, and `original_filename` is the same
       value the server stored. */
    const url = await MerchantApi.downloadDocument(documentId);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc?.original_filename || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ambDocMsg('');
  } catch (err) {
    ambDocMsg(clError(err, 'Could not download that file.'), 'err');
  }
}

async function ambDocDelete(documentId) {
  const doc = AMB.docs.saved.find(d => String(d.id) === String(documentId));
  const ok = await clConfirm(
    `Remove ${doc ? doc.original_filename : 'this document'} from the booking? `
    + 'The file is deleted and cannot be recovered.', 'Remove', { danger: true });
  if (!ok) return;
  ambDocMsg('Removing…', 'muted');
  try {
    await MerchantApi.deleteDocument(documentId);
    AMB.docs.saved = AMB.docs.saved.filter(d => String(d.id) !== String(documentId));
    ambDocRenderList();
    ambDocMsg('');
  } catch (err) {
    ambDocMsg(clError(err, 'Could not remove that file.'), 'err');
  }
}

/* Upload everything queued, against a booking that now exists.
   Sequential rather than parallel: the failures worth reporting are per-file
   ("that one is too big"), and N simultaneous multipart posts to say so is
   neither faster in any way that matters nor kinder to the box.

   RETURNS THE FAILURES, AND NEVER THROWS. The booking is already saved by the
   time this runs, so a document that would not attach must be reported
   alongside a successful save rather than turning it into a failure. */
async function ambDocUploadQueued(requestId) {
  const failed = [];
  for (const q of AMB.docs.queued) {
    try {
      await MerchantApi.uploadDocument(requestId, q.file, {
        docType: q.docType, passengerId: q.passengerId,
      });
    } catch (err) {
      failed.push(`${q.file.name} — ${clError(err, 'could not be attached')}`);
    }
  }
  AMB.docs.queued = [];
  return failed;
}

/* ------------------------------------------------------------- invoice --
   THE EXISTING INVOICE, FROM THIS BOOKING'S OWN ROWS.
   ===========================================================================
   Both buttons call ONE endpoint — `GET /api/requests/{id}/invoice` — which is
   the same one the Merchant Portal's Booking History and the Operations desk
   have always used, rendering through `invoice_service` and `invoice_layout`.
   No second template, no second generator, no invoice built in this file.

   GENERATE AND DOWNLOAD DIFFER ONLY IN WHAT IS DONE WITH THE BYTES. Generate
   opens them for reading; Download saves them. They cannot disagree about the
   document because they are the same request — which is also why pressing
   Download without pressing Generate first simply works, and needs no "please
   generate first" message.

   THE INVOICE NUMBER IS THE SERVER'S. `invoice_service._ensure_invoice_number`
   allocates it from the same PostgreSQL sequence `issue_ticket` uses, once,
   and re-reads it ever after. Nothing here generates or guesses one.

   WHY THE BOOKING MUST BE SAVED FIRST. The invoice is built from rows —
   passengers, the fare, the merchant — so there is nothing to render until
   Save has written them. `ambInvSyncButtons` keeps both buttons disabled until
   `clBookingDraft` exists, which is the same state the rest of this screen
   uses to decide create-versus-update. */
function ambInvSyncButtons() {
  const gen = document.getElementById('ambInvGenerate');
  const dl = document.getElementById('ambInvDownload');
  const hint = document.getElementById('ambInvHint');
  if (!gen || !dl) return;
  const saved = !!(clBookingDraft && clBookingDraft.id);
  gen.disabled = !saved;
  dl.disabled = !saved;
  if (hint) {
    hint.textContent = saved
      ? `Invoice for ${clBookingDraft.request_number || 'this booking'}.`
      : 'Save the booking first — the invoice is built from its saved rows.';
  }
}

function ambInvMsg(text, kind) {
  const el = document.getElementById('ambInvMsg');
  if (!el) return;
  el.className = `cl-msg${text ? ` cl-msg-${kind || 'muted'}` : ''}`;
  el.textContent = text || '';
}

/* `download` picks what happens to the bytes; everything before that is shared.
   Guarded against a second press while one is in flight — two clicks would be
   two renders of the same document, and on the FIRST ever press they would
   race for the invoice number. */
let ambInvBusy = false;

async function ambInvoice(download) {
  if (ambInvBusy) return;
  const booking = clBookingDraft;
  if (!booking || !booking.id) {
    return ambInvMsg('Save the booking before generating its invoice.', 'err');
  }

  const gen = document.getElementById('ambInvGenerate');
  const dl = document.getElementById('ambInvDownload');
  ambInvBusy = true;
  gen.disabled = true;
  dl.disabled = true;
  ambInvMsg(download ? 'Preparing the invoice…' : 'Generating the invoice…', 'muted');

  try {
    /* THE CHECKBOX ON SCREEN IS WHAT THE INVOICE MUST SAY, and until this line
       existed it was not.
       -----------------------------------------------------------------------
       `hold` reached the server only through Save. An operator who ticked Hold
       and pressed Generate Invoice — which is the obvious thing to do, and
       exactly what the two buttons invite — got an invoice built from whatever
       was last SAVED. On a booking that had never had the box touched that is
       no stored value at all, so the invoice read Paid while the box on screen
       was ticked. Reported from a real booking: REQ-2026-001489 had
       `travel_details.hold` NULL with Hold visibly checked.
       -----------------------------------------------------------------------
       So the flag is pushed first, every time, and the PDF is fetched second.
       One extra idempotent call buys the guarantee that what is rendered is
       what the operator is looking at — including when they tick the box,
       generate, untick it and generate again without saving in between.

       Only `hold` is sent. Passengers, fare and ticket details are the Save
       button's business; pressing Generate must not quietly commit a
       half-edited form. */
    await MerchantApi.updateDraft(booking.id, { hold: ambHoldValue() });
    /* Through MerchantApi so the request carries the admin's token, the same
       way every other call on this screen does — `_headers` is replaced once
       by ambInstallApiBridge. `responseType: 'blob'` because the endpoint
       answers with a PDF, not JSON. */
    const blob = await MerchantApi._req(
      'get', `/api/requests/${booking.id}/invoice`, { responseType: 'blob' });
    const url = URL.createObjectURL(blob);

    if (download) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${booking.request_number || booking.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      ambInvMsg(`Invoice downloaded for ${booking.request_number || 'this booking'}.`, 'ok');
    } else {
      /* Opened rather than saved. The application has no invoice modal of its
         own — the Merchant Portal and the Operations desk both download — so
         "preview" here is the browser's own PDF viewer on the very same bytes,
         which is the closest thing to an existing presentation and cannot
         drift from what Download produces. */
      const win = window.open(url, '_blank');
      ambInvMsg(win
        ? 'Invoice opened in a new tab.'
        : 'Your browser blocked the preview window — use Download Invoice instead.',
        win ? 'ok' : 'err');
    }
    /* Revoked on a timer rather than immediately: the tab or the download has
       to finish reading the object URL first. */
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    ambInvMsg(clError(err, 'Could not produce the invoice.'), 'err');
  } finally {
    ambInvBusy = false;
    ambInvSyncButtons();
  }
}

/* THE SAVE. Persists, links, and stops.
   ===========================================================================
   Deliberately NOT clSubmitBookingRequest. That function is the merchant's and
   ends in `MerchantApi.submitRequest(id)`, which is the single line that put a
   manual booking on the Manager's desk. Everything BEFORE that line is reused
   here — the same validators, the same payload builders, the same endpoints —
   so the reuse is real; it is the last step that differs, because the act
   differs.

   WHAT IT CALLS, IN ORDER:
     first save   POST /api/enquiries/{id}/booking-request   creates the DRAFT
     resuming     PUT  /api/requests/{id}/passengers         replaces travellers
     always       PUT  /api/requests/{id}                    remarks, contact,
                                                             fare and the ticket
   and then nothing. No /submit, no /approve, no /issue-ticket. The booking
   stays at DRAFT, which is the honest status for a row that has entered no
   workflow, and manager_service._classic_bookings_filter excludes it from the
   Manager's queue by `source` so DRAFT cannot surface there as "returned".

   THE BOOKING IS LINKED BY THE SERVER, not by this function.
   `enquiry_service.to_booking_request` sets `parent_request_id` to the enquiry
   and writes `booking_request_id` / `booking_request_number` back onto the
   enquiry's own `travel_details`, in one transaction. That is the relationship
   the Manual Enquiry table reads to decide Raise Booking vs View Booking. */
async function ambSaveManualBooking() {
  const msg = document.getElementById('clBrMsg');
  const btn = document.getElementById('ambSaveBtn');
  const enquiry = clBookingEnquiry;
  if (!enquiry) return;

  const intl = clIsInternational(enquiry);
  const isGroup = enquiry.trip_type === 'group_trip' || !!enquiry.group_journey_type;
  const groupImportId = clResolveGroupImportId(enquiry);

  /* The merchant's own contact review — it reports an incomplete panel without
     blocking, and leaves it off the payload. Not a gate there, not one here. */
  clReviewContact();

  let passengers = [];
  if (isGroup) {
    if (!groupImportId) {
      return clMsg(msg, 'Upload the passenger list before saving this booking. '
        + 'Use the Excel template in the Passengers panel above.', 'err');
    }
  } else {
    /* THE MERCHANT'S VALIDATOR, AT FULL STRENGTH. Its first argument gates the
       passport rules on "is this the final act" — true here, because Save is
       the only act this screen has. A ticket the desk has already bought on an
       international sector was bought against a passport, so the desk has it. */
    const problem = clFlagMissingPassengerFields(intl, enquiry.travel_date);
    if (problem) return clMsg(msg, problem, 'err');
    const cards = [...document.getElementById('clBrPaxList').querySelectorAll('[data-cl-pax]')];
    if (!cards.length) return clMsg(msg, 'Add at least one passenger.', 'err');
    passengers = cards.map(clPassengerPayload);
  }

  const v = (id) => (document.getElementById(id)?.value || '').trim();
  const ticket = {
    pnr: v('ambPnr'), ticketNumber: v('ambTicketNo'),
    airline: v('ambAirline'), flightNumber: v('ambFlightNo'),
  };
  const fareRaw = v('ambFare');
  /* `''` means the operator left it blank, which must leave the stored value
     alone rather than write zero — undefined is what update_draft reads as
     "not supplied". A typed 0 is a real fare and survives. */
  const clientFare = fareRaw === '' ? undefined : Number(fareRaw);

  const remarks = v('clBrRemarks');
  const contact = clContactPayload();

  btn.disabled = true;
  clMsg(msg, 'Saving…', 'muted');

  let request = clBookingDraft;
  try {
    if (!request) {
      request = await MerchantApi.enquiryToBookingRequest(enquiry.id, {
        passengers, remarks, contact, international: intl, groupImportId,
      });
      /* Recorded before anything else can throw. A later failure that left this
         null would send the next Save back down the create path and raise a
         SECOND booking against one enquiry — the server's 409 would catch it,
         but the operator would be reading a duplicate error for a save that
         had actually worked the first time. */
      clBookingDraft = request;
    } else if (!isGroup) {
      /* Wholesale, because that is the endpoint's contract and the only way a
         traveller the operator deleted actually disappears. Skipped for a group:
         its travellers came from the manifest and are not editable here. */
      await MerchantApi.replacePassengers(request.id, passengers);
    }

    const detail = await MerchantApi.updateDraft(request.id, {
      remarks,
      /* The FLAG, not a status. The server turns it into Due/Paid when the
         invoice renders — see ambInstallHold. */
      hold: ambHoldValue(),
      /* `?? {}` — the empty object is the point. It is how a contact entered
         earlier is CLEARED; `undefined` would mean "leave it alone". */
      contact: contact ?? {},
      clientFare,
      ticket,
    });
    request = detail.request || detail;
    clBookingDraft = request;
    // The invoice needs saved rows, so the buttons wake up the moment there
    // are some — without waiting for the operator to leave and come back.
    ambInvSyncButtons();
  } catch (err) {
    clMsg(msg, clError(err, 'Could not save the booking.'), 'err');
    btn.disabled = false;
    return;
  }

  /* THE DOCUMENTS, NOW THAT THERE IS A BOOKING TO ATTACH THEM TO.
     Deliberately AFTER the save and outside its error handling: the booking is
     already stored by this point, so a file that will not attach must be
     reported beside a successful save rather than turning one into a failure.
     ambDocUploadQueued never throws — it returns the ones that did not go. */
  let docFailures = [];
  if (AMB.docs.queued.length) {
    clMsg(msg, `Attaching ${AMB.docs.queued.length} document(s)…`, 'muted');
    docFailures = await ambDocUploadQueued(request.id);
  }

  /* BACK TO THE ENQUIRY IT BELONGS TO. The row is re-read rather than patched
     from the response, so what the table shows is what the server holds — the
     same read a browser refresh would make. */
  AMB.savedNote = {
    reference: request.request_number,
    enquiryReference: enquiry.reference_number,
    pnr: request.pnr || ticket.pnr || '',
    docFailures,
  };
  clBookingEnquiry = null;
  clBookingDraft = null;
  navigateToSection('manual-enquiry');
  await ambRefreshStatuses();
  const n = AMB.savedNote;
  AMB.savedNote = null;
  /* A part-success reads as a success with a caveat, never as an error: the
     booking IS saved, and the operator needs to know which file to retry rather
     than whether their typing survived. */
  const note = `Booking saved — ${n.reference} against ${n.enquiryReference}`
    + `${n.pnr ? `, PNR ${n.pnr}` : ''}.`;
  if (n.docFailures && n.docFailures.length) {
    ambNote(`${note} ${n.docFailures.length} document(s) could not be attached: `
      + `${n.docFailures.join('; ')}. Open View Booking to try again.`, 'err');
  } else {
    ambNote(note, 'ok');
  }
}

/* "2. Quoted — Available to book" is not true of a Pending enquiry.
   ===========================================================================
   classic-booking.js renders that step from `quoted_fare`: a figure when there
   is one, and the words "Available to book" when there is not. Those words
   were written for a merchant, who only ever reaches that screen from an
   APPROVED enquiry — so "no figure" could only mean a pre-CR-5 enquiry that
   was approved without one, and the sentence was right.

   The desk now reaches it from an enquiry that may not be answered at all, and
   there the same words assert an availability nobody has confirmed. That is
   the one sentence on this screen the change makes untrue, so it is the one
   sentence corrected — in the DOM, in this portal, after the shared render.

   NOT A BRANCH INSIDE THE SHARED FORM, deliberately. Every other field, label
   and rule on that screen is the merchant's own and stays that way; teaching
   classic-booking.js about an admin context to fix a two-word label would put
   a portal check inside the file whose whole value is not having one. It is
   skipped entirely when the enquiry IS quoted, where the shared render is
   already correct. */
function ambCorrectUnquotedStep(enquiry) {
  const steps = [...document.querySelectorAll('#cl-booking-request .cl-stepper .cl-step')];
  if (!steps.length) return;

  /* Step 2 — the fare. Only when there is genuinely no quotation: the shared
     render is already correct for a quoted enquiry and must be left alone. */
  if (enquiry.quoted_fare == null && steps[1]) {
    steps[1].classList.remove('done');
    steps[1].innerHTML = `<b>2. Fare</b>${ambEsc(
      enquiry.status === 'approved' ? 'Named at ticketing' : 'Not quoted')}`;
  }

  /* Steps 4 and 5 — "Approval: Sign-off on this booking" and "Ticketing:
     Settled from your wallet". Both describe the merchant's workflow, and
     NEITHER now happens to a manual booking: Save persists the record and
     stops, no Manager sees it, and no wallet is debited. Leaving them would
     promise the operator two stages that never arrive.

     The two are replaced by the one thing that does happen. Removed rather
     than re-worded because there is no fourth and fifth stage to describe —
     inventing wording for stages that do not exist is how the old "Not
     available yet" popup came to point nowhere. */
  if (steps[3]) {
    steps[3].className = 'cl-step current';
    steps[3].innerHTML = '<b>4. Saved</b>Against this enquiry';
  }
  if (steps[4]) steps[4].remove();

  /* Step 3 stops being the last thing to do, so it stops being `current`. */
  if (steps[2]) steps[2].className = 'cl-step';
}

/* NO SUBMIT CONFIRMATION, BECAUSE MANUAL BOOKING NO LONGER SUBMITS.
   ===========================================================================
   This file used to wrap `clBookingSubmitted` and re-word it for the desk. The
   wrapper has been removed with the workflow it belonged to: Save now persists
   the booking and STOPS. Nothing calls POST /api/requests/{id}/submit from this
   portal, so the merchant's confirmation screen is never reached and there is
   nothing left to re-word.

   WHY THE SUBMIT WENT. A Booking Request raised by a merchant is a request:
   it goes to a Manager for sign-off, then to Booking Operations to be bought.
   A Manual Booking is the opposite act — the desk has ALREADY bought the
   ticket and is recording it, PNR and ticket number in hand. Submitting one
   asked a Manager to approve a purchase that had happened, and put the desk's
   own record on a queue of work still to do. See ambSaveManualBooking. */
