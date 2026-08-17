'use strict';
/* merchant-api.js — the merchant portal's backend contract, in one place.
   ===========================================================================
   Every call the Merchant/Partner experience can make, as one function each.
   The Classic UI (merchant-classic/) talks to the backend exclusively through
   this file, so "what endpoints exist and what shape do they take" is answered
   here rather than being scattered across a dozen screen files.

   WHY THIS EXISTS
   The Premium portal (assets/js/partner-*.js) builds its axios calls inline.
   Those files are deliberately NOT being changed — Premium must keep working
   byte-for-byte — so this module was extracted by reading them and is a faithful
   copy of the same endpoints, params and payload shapes. If you change an
   endpoint here you are changing it for Classic only; check the matching
   partner-*.js so the two do not drift.

   Verified against the Premium screens on 2026-07-30:
     dashboard        GET  /api/merchant/dashboard      partner-dashboard.js:69
     create request   POST /api/requests                partner-request-ticket.js
     submit           POST /api/requests/{id}/submit    partner-request-ticket.js
     list requests    GET  /api/requests                partner-request-history.js:44
     request detail   GET  /api/requests/{id}           partner-request-history.js:85
     cancel           POST /api/requests/{id}/cancel    partner-request-history.js:76
     pay              POST /api/requests/{id}/pay       partner-request-history.js:173
     service request  POST /api/service-requests        partner-service-request.js:148
     reports export   GET  /api/reports/export          partner-reports.js:58
     profile          GET/PUT /api/profile              partner-profile.js:42,67
     change password  POST /api/auth/change-password    partner-profile.js:89
     notifications    GET/PATCH/POST /api/notifications partner-notifications.js:108

   Added 2026-07-30 with the Ticket Enquiry redesign (backend/app/routers/
   enquiries.py). These have no Premium counterpart — Premium's "Ticket
   Enquiry" was a catalog search, which this flow replaces:
     create enquiry   POST /api/enquiries
     list enquiries   GET  /api/enquiries
     enquiry detail   GET  /api/enquiries/{id}
     request ticket   POST /api/enquiries/{id}/booking-request

   The catalog wrappers (GET /api/catalog/search, /api/catalog/{id}/quote) were
   REMOVED here when Inventory Search was retired. The backend routes still
   exist and are untouched — nothing in this portal calls them any more.

   Added 2026-08-04 with Group Booking (backend/app/routers/group_bookings.py).
   The passenger list for a group arrives as a spreadsheet instead of a form:
     limits           GET    /api/group-bookings/limits
     template         GET    /api/group-bookings/template
     upload+validate  POST   /api/group-bookings/imports
     import detail    GET    /api/group-bookings/imports/{id}
     error report     GET    /api/group-bookings/imports/{id}/errors
     stored file      GET    /api/group-bookings/imports/{id}/file

   This is a transport layer.

   Requires (in this order): axios, API_BASE, auth.js (partnerAuthHeaders). */

/* A streamed download, handed to the browser.
   Three of the group booking endpoints return a file rather than JSON, and a
   blob URL that is never revoked keeps the whole file alive in memory for the
   life of the tab — so the object URL is released as soon as the click has
   been dispatched. */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const MerchantApi = {
  /* Single choke point so auth headers, base URL and error shape are uniform.
     Errors are re-thrown untouched — callers read err.response.data.detail,
     which is what the backend returns and what the Premium screens surface. */
  async _req(method, path, { params, data, responseType } = {}) {
    const res = await axios({
      method,
      url: `${API_BASE}${path}`,
      headers: partnerAuthHeaders(),
      params,
      data,
      responseType,
    });
    return res.data;
  },

  /* ------------------------------------------------------------ dashboard */

  /* Wallet balance, credit limit, company, support contact, and the
     requests_by_status / pending_payments_count counters. */
  dashboard() {
    return this._req('get', '/api/merchant/dashboard');
  },

  /* ------------------------------------------------------------ enquiries */

  /* Ticket Enquiry. An enquiry is created already submitted — there is no
     draft stage — so this one call is the whole "Enquire" action and the
     response carries the ENQ-YYYYMMDD-NNNNNN reference.

     The server repeats every rule the form enforces (From != To, no past
     travel date, return after departure, adults + children + infants ==
     passenger_count, infants <= adults) and returns them as a 422, so a
     failure here is worth surfacing verbatim rather than as a generic error. */
  createEnquiry(payload) {
    return this._req('post', '/api/enquiries', { data: payload });
  },

  /* `status` takes a request_status_enum value. The stages an enquiry can
     actually reach are pending_approval, in_review, approved, rejected and
     cancelled — it never becomes payable. */
  listEnquiries(params) {
    return this._req('get', '/api/enquiries', { params });
  },

  /* ------------------------------------------------- group booking manifest */

  /* The configured party-size and upload bounds. Fetched once per form open and
     cached by the caller — the enquiry form needs `max_passengers` to validate
     Number of Passengers before it sends, and hard-coding it here is exactly
     how the UI and the server come to disagree about the same setting. */
  groupBookingLimits() {
    return this._req('get', '/api/group-bookings/limits');
  },

  /* The passenger template. Downloads are a browser concern, not a data one:
     the response is a stream with a Content-Disposition, so it is fetched as a
     blob and handed to a temporary anchor rather than returned to the caller.
     `_req` is still used, so the auth header and base URL stay in one place. */
  async downloadGroupTemplate(journeyType) {
    const blob = await this._req('get', '/api/group-bookings/template', {
      params: { journey_type: journeyType },
      responseType: 'blob',
    });
    const kind = journeyType === 'round_trip_group' ? 'round-trip' : 'one-way';
    saveBlob(blob, `jackpots-group-booking-${kind}-template.xlsx`);
  },

  /* Upload and validate in one call. Multipart rather than JSON because the
     payload is a file; `onProgress` is wired to axios's upload event so the
     card can show real progress rather than an indeterminate spinner.

     A 4xx here is a real answer, not a transport failure — the server returns
     the row-level detail as `detail`, which clEnquiryError() unpacks. */
  uploadGroupManifest({ file, journey_type, replaces, onProgress }) {
    const form = new FormData();
    form.append('file', file);
    form.append('journey_type', journey_type);
    if (replaces) form.append('replaces', String(replaces));

    return axios({
      method: 'post',
      url: `${API_BASE}/api/group-bookings/imports`,
      headers: partnerAuthHeaders(),
      data: form,
      onUploadProgress: e => {
        if (!onProgress || !e.total) return;
        onProgress(Math.min(100, Math.round((e.loaded * 100) / e.total)));
      },
    }).then(res => res.data);
  },

  getGroupImport(importId) {
    return this._req('get', `/api/group-bookings/imports/${importId}`);
  },

  async downloadGroupErrors(importId) {
    const blob = await this._req('get', `/api/group-bookings/imports/${importId}/errors`,
      { responseType: 'blob' });
    saveBlob(blob, 'passenger-list-errors.xlsx');
  },

  async downloadGroupManifest(importId, filename) {
    const blob = await this._req('get', `/api/group-bookings/imports/${importId}/file`,
      { responseType: 'blob' });
    saveBlob(blob, filename || 'passenger-list.xlsx');
  },

  getEnquiry(id) {
    return this._req('get', `/api/enquiries/${id}`);
  },

  /* ------------------------------------------------------- hotel enquiry --
     Separate tables, separate endpoints (backend migration 0047) — not a
     travel_type on the flight enquiry above. The response shape still mirrors
     EnquiryResponse's field names (reference_number, travel_date/return_date
     for check-in/out, notes for special requirements, travel_type: 'hotel'),
     so the merchant/admin row renderers barely branch between the two. */
  createHotelEnquiry(payload) {
    return this._req('post', '/api/hotel/enquiries', { data: payload });
  },
  listHotelEnquiries(params) {
    return this._req('get', '/api/hotel/enquiries', { params });
  },
  getHotelEnquiry(id) {
    return this._req('get', `/api/hotel/enquiries/${id}`);
  },

  /* Raise Booking: turns an APPROVED (quoted) hotel enquiry into a DRAFT
     booking. Only the guests are sent — the stay itself (destination, hotel,
     dates, room/child composition) is copied from the enquiry server-side, so
     the booking is always the stay that was actually quoted. Returns the
     booking as a RequestResponse (same shape /api/requests/{id} returns); it
     still needs submitRequest() to reach the desk. 409 if this enquiry has
     already been booked. */
  createHotelBookingFromEnquiry(enquiryId, { guests, remarks, contact, specialRequests, clientFare }) {
    return this._req('post', `/api/hotel/enquiries/${enquiryId}/booking-request`, {
      data: {
        guests,
        remarks: remarks || undefined,
        contact: contact || undefined,
        special_requests: specialRequests || undefined,
        /* `??`, not `||`: 0 is a real client fare. */
        client_fare: clientFare ?? undefined,
      },
    });
  },

  /* Book Directly for Hotel — no enquiry, no quotation, in front first.
     Mirrors createDirectBooking: `stay` is the identical stay object
     clStartDirectHotelBooking built from the form, spread verbatim into the
     body alongside the guests. No price is named — the booking is created
     unquoted and our desk names the fare when it issues the voucher. */
  createDirectHotelBooking(stay, { guests, remarks, contact, specialRequests, clientFare }) {
    return this._req('post', '/api/hotel/bookings/direct', {
      data: {
        ...stay,
        guests,
        remarks: remarks || undefined,
        contact: contact || undefined,
        special_requests: specialRequests || undefined,
        client_fare: clientFare ?? undefined,
        submit: false,
      },
    });
  },

  /* Request Ticket: turns an APPROVED enquiry into a DRAFT booking. Only the
     passengers are sent — every itinerary field is copied from the enquiry
     server-side, so the booking is always the journey that was answered.
     Returns the booking; it still needs submitRequest() to reach the desk.
     409 if this enquiry has already been booked. */
  enquiryToBookingRequest(id, { passengers, remarks, contact, international, specialRequests,
                                groupImportId, clientFare }) {
    return this._req('post', `/api/enquiries/${id}/booking-request`, {
      data: {
        /* A group booking sends its manifest INSTEAD of a passenger array —
           the server refuses both together, because two sources for one list
           is how a manifest silently loses to a stale form field. */
        passengers: groupImportId ? [] : passengers,
        group_import_id: groupImportId || undefined,
        remarks: remarks || undefined,
        contact: contact || undefined,
        /* Sent from the UI because the API has no country data — see
           isInternationalRoute() in travel-locations.js. It decides whether
           passports are enforced at submit. */
        international: !!international,
        special_requests: specialRequests || undefined,
        /* 0040, collected on the Booking Request screen since 2026-08-05.
           `?? undefined` rather than `|| undefined`: 0 is a real client fare
           and `||` would drop it, leaving whatever the enquiry carried. */
        client_fare: clientFare ?? undefined,
      },
    });
  },

  /* Book Directly: the same DRAFT booking, with no enquiry in front of it.
     `itinerary` is the identical object createEnquiry() takes — the endpoint's
     schema subclasses the enquiry's, so From != To, the past-date rule and the
     party arithmetic are the same validator and fail the same way.

     Two things differ from enquiryToBookingRequest above, both deliberate:
     the journey is sent (there is no answered enquiry to copy it from), and
     nothing here names a price. The booking is created unquoted and our desk
     names the fare when it issues the ticket.

     `submit` is left false on purpose. The endpoint can submit in the same
     call, but this portal always goes create-then-submitRequest() so that a
     submit failure still leaves the merchant a saved draft — see the three
     try blocks in clSubmitBookingRequest. */
  createDirectBooking(itinerary, { passengers, remarks, contact, international, specialRequests,
                                   groupImportId }) {
    return this._req('post', '/api/bookings/direct', {
      data: {
        ...itinerary,
        /* See enquiryToBookingRequest: the manifest replaces the array, it does
           not accompany it. `itinerary` already carries group_import_id from
           the enquiry form, so this only has to win over a stale passengers. */
        passengers: groupImportId ? [] : passengers,
        group_import_id: groupImportId || itinerary.group_import_id || undefined,
        remarks: remarks || undefined,
        contact: contact || undefined,
        international: !!international,
        special_requests: specialRequests || undefined,
        submit: false,
      },
    });
  },

  /* ------------------------------------------------------------- requests */

  listRequests(params) {
    return this._req('get', '/api/requests', { params });
  },

  getRequest(id) {
    return this._req('get', `/api/requests/${id}`);
  },

  /* Creates a DRAFT against a CATALOG ITEM. Two-step by design: create, then
     submit.

     NOT USED BY THIS PORTAL any more. Booking here starts from an answered
     enquiry, so the draft comes from enquiryToBookingRequest() above — which
     is what keeps a merchant from booking a sector the desk never confirmed.
     Kept because /api/requests is still the canonical catalog-led booking
     endpoint and other surfaces call it; do not reach for it from Classic. */
  createRequest({ catalogItemId, passengers, travelDate }) {
    return this._req('post', '/api/requests', {
      data: {
        catalog_item_id: catalogItemId,
        passengers,
        travel_date: travelDate || undefined,
      },
    });
  },

  submitRequest(id) {
    return this._req('post', `/api/requests/${id}/submit`, { data: {} });
  },

  /* A traveller this merchant has sent before, by passport number.
     Always 200: an unknown passport answers `{ found: false }` rather than 404,
     so a first-time traveller is not an error in the console. Returns no row
     id — see PassengerLookupResponse — because the booking being filled in
     creates its own passenger rows, and nothing here writes anything. */
  lookupPassenger(passportNumber) {
    return this._req('get', '/api/passengers/lookup', {
      params: { passport_number: passportNumber },
    });
  },

  /* Draft-only, both of them. Used when resuming a saved draft: the passenger
     list is replaced wholesale (the endpoint's own semantics) and the
     booking-level fields are merged into travel_details server-side. */
  replacePassengers(id, passengers) {
    return this._req('put', `/api/requests/${id}/passengers`, { data: { passengers } });
  },

  updateDraft(id, { remarks, contact, specialRequests, clientFare }) {
    return this._req('put', `/api/requests/${id}`, {
      data: {
        remarks: remarks ?? undefined,
        contact: contact ?? undefined,
        special_requests: specialRequests ?? undefined,
        /* `??`, not `||`: 0 is a real client fare. undefined means "not
           supplied", which leaves the stored value untouched. */
        client_fare: clientFare ?? undefined,
      },
    });
  },

  /* ------------------------------------------------------------ documents */

  /* Multipart, so this one bypasses _req's JSON shape. The browser must set
     its own multipart boundary — passing a Content-Type here breaks it. */
  uploadDocument(requestId, file, { docType = 'other', passengerId = null } = {}) {
    const form = new FormData();
    form.append('file', file);
    form.append('doc_type', docType);
    if (passengerId != null) form.append('passenger_id', String(passengerId));
    return axios.post(`${API_BASE}/api/requests/${requestId}/documents`, form, {
      headers: partnerAuthHeaders(),
    }).then(r => r.data);
  },

  listDocuments(requestId) {
    return this._req('get', `/api/requests/${requestId}/documents`);
  },

  /* ---------------------------------------------------------- passport OCR */

  /* Whether to render a Scan control at all. A deployment with no OCR provider
     configured answers `{available: false}`, and the booking form then looks
     exactly as it did before this shipped. Asked once per screen load. */
  ocrAvailability() {
    return this._req('get', '/api/bookings/passport/availability');
  },

  /* Read a passport and get passenger fields back, each with a confidence.

     MULTIPART, so it bypasses _req for the same reason uploadDocument does.
     `validateStatus` is widened to accept 202: the server answers 202 when the
     provider is still working, and axios would otherwise throw on it — turning
     "your scan is taking a moment" into "your scan failed". The caller polls
     when `status` comes back `queued` or `processing`.

     `requestId` is optional and is only a label. Scanning works on a blank form
     with no draft saved, which is the whole point — see the router docstring. */
  extractPassport(file, { requestId = null } = {}) {
    const form = new FormData();
    form.append('file', file);
    if (requestId != null) form.append('request_id', String(requestId));
    return axios.post(`${API_BASE}/api/bookings/passport/extract`, form, {
      headers: partnerAuthHeaders(),
      validateStatus: s => (s >= 200 && s < 300),
    }).then(r => r.data);
  },

  getPassportExtraction(extractionId) {
    return this._req('get', `/api/bookings/passport/extract/${extractionId}`);
  },

  /* The scan itself. Authenticated, so a plain <img src> cannot fetch it — the
     blob is pulled with the bearer token and handed over as an object URL, the
     same dance downloadDocument does. Callers must revoke it. */
  async passportScanUrl(extractionId) {
    const blob = await this._req(
      'get', `/api/bookings/passport/extract/${extractionId}/scan`,
      { responseType: 'blob' },
    );
    return URL.createObjectURL(blob);
  },

  /* Tell the server what the merchant actually saved, so it can record which
     OCR values were overridden. Send the passenger as saved — the server works
     out the differences, because it is the only side that knows what was read. */
  recordPassportEdits(extractionId, values, { requestId = null, passengerId = null } = {}) {
    return this._req('post', `/api/bookings/passport/extract/${extractionId}/edits`, {
      data: { values, request_id: requestId, passenger_id: passengerId },
    });
  },

  /* The airline's own files, attached by the operations desk. A narrower list
     than listDocuments(): that one returns everything on the booking, and on
     the Classic Tours track the merchant should only ever be offered the
     paperwork it is meant to download (M2). */
  listTicketDocuments(requestId) {
    return this._req('get', `/api/requests/${requestId}/tickets`);
  },

  deleteDocument(documentId) {
    return this._req('delete', `/api/documents/${documentId}`);
  },

  /* Downloads are authenticated, so a plain href cannot fetch them — the blob
     is pulled with the bearer token and handed to the browser as an object
     URL. Callers must revoke it. */
  async downloadDocument(documentId) {
    const blob = await this._req('get', `/api/documents/${documentId}/download`, {
      responseType: 'blob',
    });
    return URL.createObjectURL(blob);
  },

  /* M7. The two PDFs M2 built and nothing ever called.

     Both are generated on demand from the booking, its passengers and its
     payments — nothing is stored, so a refund recorded a minute ago is already
     in the invoice and there is no stale file to disagree with the ledger.
     Both are gated server-side to ticketed/completed bookings (409 otherwise)
     and re-check merchant scope per request, so a link that leaks is still not
     a booking that leaks.

     Returned as a Blob, not an object URL: unlike downloadDocument these have
     no server-supplied filename for the caller to reuse, so the caller names
     the file and owns the URL's lifetime. */
  downloadInvoice(requestId) {
    return this._req('get', `/api/requests/${requestId}/invoice`, { responseType: 'blob' });
  },

  downloadConfirmation(requestId) {
    return this._req('get', `/api/requests/${requestId}/confirmation`, { responseType: 'blob' });
  },

  cancelRequest(id, reason) {
    return this._req('post', `/api/requests/${id}/cancel`, { data: { reason } });
  },

  /* ticket_service.record_payment rejects amount <= 0 with a 400, and gates on
     status == PAYMENT_PENDING only — it does NOT check request_type, so service
     requests (date change, passenger modification) are payable through here
     too. Do not filter the payables list by type. */
  payRequest(id, { amount, method, transactionId }) {
    return this._req('post', `/api/requests/${id}/pay`, {
      data: { amount, method, transaction_id: transactionId || undefined },
    });
  },

  /* ------------------------------------------------------------- finance */

  /* M4. Both of these are served by finance_service, which is the only place
     money is computed — do not re-derive any of these figures on the client.
     `credit_available` is null when no credit limit is configured, which is not
     the same as a limit of zero: render "No limit set", never "0". */
  financePosition() {
    return this._req('get', '/api/merchant/finance/position');
  },

  financeStatement({ dateFrom, dateTo } = {}) {
    return this._req('get', '/api/merchant/finance/statement', {
      params: { date_from: dateFrom || undefined, date_to: dateTo || undefined },
    });
  },

  /* -------------------------------------------------------------- wallet */

  /* CR-4c. The running account. Every route is scoped to the caller's merchant
     by the server — there is no merchant_id to pass, and none of these figures
     may be re-derived on the client: `balance` may legitimately be NEGATIVE
     (that is the outstanding position) and `pending_topups` is deliberately NOT
     part of it, because an unverified claim is not money. Render them as two
     separate numbers; adding them together is the bug this shape prevents. */
  wallet() {
    return this._req('get', '/api/merchant/wallet');
  },

  /* Oldest first, with `balance_after` computed by the server per row. Never
     accumulate a running balance here — see WALLET_ARCHITECTURE §6 for why the
     client's idea of the order can disagree with the ledger's. */
  walletTransactions({ dateFrom, dateTo, page = 1, pageSize = 25 } = {}) {
    return this._req('get', '/api/merchant/wallet/transactions', {
      params: {
        date_from: dateFrom || undefined, date_to: dateTo || undefined,
        page, page_size: pageSize,
      },
    });
  },

  /* Staff configure these (CR-4d); this side is read-only. An empty array is a
     valid answer and means none has been configured yet — say so, rather than
     rendering an empty box. */
  paymentAccounts() {
    return this._req('get', '/api/merchant/wallet/payment-accounts');
  },

  /* The QR is authenticated, so a plain <img src> cannot fetch it — pulled as a
     blob with the bearer token. Callers must revoke the object URL. */
  async paymentAccountQr(accountId) {
    const blob = await this._req(
      'get', `/api/merchant/wallet/payment-accounts/${accountId}/qr`,
      { responseType: 'blob' },
    );
    return URL.createObjectURL(blob);
  },

  /* Multipart, so this bypasses _req's JSON shape — the browser must set its
     own boundary. Submitting CREDITS NOTHING: it records a claim, and the
     wallet moves only when an admin verifies it. */
  submitTopup({ amount, method, paymentAccountId, utr, proof }) {
    const form = new FormData();
    form.append('amount', amount);
    form.append('method', method);
    if (paymentAccountId != null) form.append('payment_account_id', String(paymentAccountId));
    if (utr) form.append('utr', utr);
    if (proof) form.append('proof', proof);
    return axios.post(`${API_BASE}/api/merchant/wallet/topups`, form, {
      headers: partnerAuthHeaders(),
    }).then(r => r.data);
  },

  listTopups({ status, page = 1, pageSize = 20 } = {}) {
    return this._req('get', '/api/merchant/wallet/topups', {
      params: { status: status || undefined, page, page_size: pageSize },
    });
  },

  async downloadTopupProof(topupId) {
    const blob = await this._req(
      'get', `/api/merchant/wallet/topups/${topupId}/proof`, { responseType: 'blob' },
    );
    return URL.createObjectURL(blob);
  },

  /* ---------------------------------------------- payment requests (0041) */

  /* Requests the payments desk raised against this merchant. The opposite
     direction to submitTopup above: there, the merchant volunteers that it has
     paid; here, the desk asks and names the manager who must settle it.
     Buckets: requests (raised, unpaid), pending (paid, with the desk),
     approved, rejected, all. */
  paymentRequests({ bucket = 'all', page = 1, pageSize = 20 } = {}) {
    return this._req('get', '/api/merchant/payment-requests', {
      params: { bucket, page, page_size: pageSize },
    });
  },

  paymentRequestCounts() {
    return this._req('get', '/api/merchant/payment-requests/counts');
  },

  /* Multipart for the same reason submitTopup is, and with the same guarantee:
     **settling credits nothing.** It attaches the proof and hands the request
     to the desk; the wallet moves when an admin approves it. Resubmitting a
     rejected request is this same call. */
  settlePaymentRequest(topupId, { utr, proof } = {}) {
    const form = new FormData();
    if (utr) form.append('utr', utr);
    if (proof) form.append('proof', proof);
    return axios.post(
      `${API_BASE}/api/merchant/payment-requests/${topupId}/settle`,
      form, { headers: partnerAuthHeaders() },
    ).then(r => r.data);
  },

  /* ------------------------------------------------------------ approvals */

  /* CR-3. The merchant signs off the booking requests its own staff raised,
     replacing the platform Manager step. Every one of these is scoped to the
     caller's merchant by the server — there is no merchant_id parameter to
     pass, and passing one would not widen the result. */
  approvalQueue({ bucket, status, search, page = 1, pageSize = 20 } = {}) {
    return this._req('get', '/api/merchant/approvals', {
      params: {
        bucket: bucket || undefined, status: status || undefined,
        search: search || undefined, page, page_size: pageSize,
      },
    });
  },

  approvalCounts() {
    return this._req('get', '/api/merchant/approvals/counts');
  },

  approvalDetail(requestId) {
    return this._req('get', `/api/merchant/approvals/${requestId}`);
  },

  approvalStartReview(requestId) {
    return this._req('post', `/api/merchant/approvals/${requestId}/start-review`);
  },

  /* 403 when the caller raised this booking themselves — someone else at the
     merchant has to decide it. The screen hides the buttons in that case, but
     the server is the one that enforces it. */
  approvalApprove(requestId, note) {
    return this._req('post', `/api/merchant/approvals/${requestId}/approve`, {
      data: { note: note || null },
    });
  },

  approvalReturn(requestId, remarks) {
    return this._req('post', `/api/merchant/approvals/${requestId}/return`, {
      data: { remarks },
    });
  },

  /* ----------------------------------------------------- service requests */

  /* `details` shape depends on request_type:
       cancellation           { passenger_ids: [int] }
       date_change            { passenger_id: int, new_travel_date: 'YYYY-MM-DD' }
       refund                 { amount: number }
       passenger_modification { passenger_id: int, changes: {...} }  */
  createServiceRequest({ bookingId, requestType, remarks, details }) {
    return this._req('post', '/api/service-requests', {
      data: { booking_id: bookingId, request_type: requestType, remarks, details },
    });
  },

  /* ------------------------------------------ cancellation & reschedule (M3)

     Cancellation and date change do NOT go through createServiceRequest above.
     They have their own endpoints because they settle money and change the
     parent booking, and the generic hook does neither — approving a generic
     'cancellation' left the booking exactly as it was. Refund and passenger
     correction still use the generic hook; they have no settlement of their
     own yet.

     No amounts are sent when raising. The cancellation charge and the fare
     difference are quoted by staff at approval, so a pending request carries
     none. */

  requestCancellation(bookingId, reason) {
    return this._req('post', `/api/bookings/${bookingId}/cancellation`, { data: { reason } });
  },

  requestReschedule(bookingId, { newTravelDate, newReturnDate, reason }) {
    return this._req('post', `/api/bookings/${bookingId}/reschedule`, {
      data: {
        new_travel_date: newTravelDate,
        new_return_date: newReturnDate || null,
        reason,
      },
    });
  },

  listChangeRequests(params) {
    return this._req('get', '/api/change-requests', { params });
  },

  changeRequestCounts() {
    return this._req('get', '/api/change-requests/counts');
  },

  getChangeRequest(id) {
    return this._req('get', `/api/change-requests/${id}`);
  },

  /* There is no withdrawChangeRequest(). The endpoint was removed: whoever
     raises a request cannot take it back, because doing so pulled work out from
     under an operator already on the phone to the airline and left no record of
     who changed their mind. Their manager rejects it instead — see the manager
     approval block below. */

  bookingChangeRequests(bookingId) {
    return this._req('get', `/api/bookings/${bookingId}/change-requests`);
  },

  /* ------------------------------------------------ manager approval

     The merchant's OWN sign-off, in front of ours. Every service request a
     merchant raises — cancellation, date change, passenger correction, extra
     baggage, meal, seat — waits for a manager of that merchant before the
     JackPots desk can see or settle it.

     Held by MerchantRole.MANAGER and by the company's merchant_admin
     (permission `servicerequest.approve`), and by nobody else: a 403 from these
     three is the server saying the caller is not a manager. */

  managerQueue(params) {
    return this._req('get', '/api/manager/service-requests', { params });
  },

  managerQueueCounts() {
    return this._req('get', '/api/manager/service-requests/counts');
  },

  managerApprove(id) {
    return this._req('post', `/api/manager/service-requests/${id}/approve`);
  },

  /* A reason is mandatory — the person who raised the request reads it. */
  managerReject(id, reason) {
    return this._req('post', `/api/manager/service-requests/${id}/reject`, { data: { reason } });
  },

  /* -------------------------------------------------------------- reports */

  /* Returns a Blob — the caller is responsible for the object URL and for
     revoking it. Premium requests CSV; the param set matches the list filters
     so the export and the on-screen table describe the same rows. */
  exportReport(params) {
    return this._req('get', '/api/reports/export', { params, responseType: 'blob' });
  },

  /* M6. How many rows the current filters match and what they are worth, built
     from the same row builders the export uses — so a screen can state the size
     of the download it is offering without counting anything itself. Takes the
     identical param set as `exportReport` minus `format`. */
  reportSummary(params) {
    return this._req('get', '/api/reports/summary', { params });
  },

  /* ------------------------------------------------------------ analytics */

  /* M6. Aggregates, grouped in SQL over the merchant's whole history — not a
     page of rows to add up here. `dateField` picks the column the range filter
     AND the monthly series run on: 'travel_date' (when they fly) or
     'created_at' (when it was raised). The response echoes back which was used,
     so a chart can label itself from the answer rather than from its caller's
     memory of what it asked for. */
  bookingAnalytics({ dateField, dateFrom, dateTo } = {}) {
    return this._req('get', '/api/analytics/bookings', {
      params: {
        date_field: dateField || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      },
    });
  },

  changeRequestAnalytics({ dateFrom, dateTo } = {}) {
    return this._req('get', '/api/analytics/change-requests', {
      params: { date_from: dateFrom || undefined, date_to: dateTo || undefined },
    });
  },

  /* -------------------------------------------------------------- profile */

  getProfile() {
    return this._req('get', '/api/profile');
  },

  updateProfile(payload) {
    return this._req('put', '/api/profile', { data: payload });
  },

  changePassword(currentPassword, newPassword) {
    return this._req('post', '/api/auth/change-password', {
      data: { current_password: currentPassword, new_password: newPassword },
    });
  },

  /* --------------------------------------------------- support / live chat

     Backed by app/routers/support_tickets.py. "Support Management" (the admin
     queue) and "Live Chat" (this side) are ONE feature — chat threads — with
     two views, which is why there is no separate ticket model to create: a
     support ticket IS a thread, and its `status` is its lifecycle.

     A merchant holds `chat.create` and `chat.view` (rbac.py), so every call
     below is available to every merchant role. Each is scoped to the caller's
     merchant server-side; there is no merchant_id to pass, and a thread
     belonging to another merchant 404s. */

  /* Opens a thread WITH its first message — there is no empty thread state, so
     a conversation always has something in it to answer. Returns the thread
     and its messages, so the screen can render the conversation immediately
     rather than opening and then fetching.

     `category` is one of the eight the server accepts (booking, payment,
     wallet, refund, ticket_issue, account, technical, other) — anything else
     is a 400, so drive the picker from that list and not from free text.
     `priority` is the merchant's OPENING assessment only: the desk re-files it
     through /triage, which this client deliberately does not expose.

     `subject` is OPTIONAL — only `message` is required. Leave it out and the
     server titles the thread from the opening of the first message, so a
     merchant can say what is wrong without composing a headline for it first.
     Sent as undefined rather than "" when blank, so the field is absent from
     the payload instead of present and empty. */
  openSupportThread({ subject, message, category, priority, relatedRequestId } = {}) {
    return this._req('post', '/api/support/threads', {
      data: {
        subject: subject || undefined,
        message,
        category: category || undefined,
        priority: priority || undefined,
        related_request_id: relatedRequestId ?? undefined,
      },
    });
  },

  /* `status` takes a request_status_enum value. A thread only ever reaches
     submitted (labelled "Open"), in_review ("In Progress") and completed
     ("Resolved") — the response carries `status_label` with that chat-specific
     wording already applied, so never derive the text from the enum here.

     `q` searches the subject, the reference AND the text of every message in
     the thread, which is why searching is a server round trip rather than a
     filter over the page already in hand. */
  listSupportThreads({ status, category, priority, q, page = 1, pageSize = 20 } = {}) {
    return this._req('get', '/api/support/threads', {
      params: {
        status: status || undefined,
        category: category || undefined,
        priority: priority || undefined,
        q: q || undefined,
        page,
        page_size: pageSize,
      },
    });
  },

  /* Opening a thread marks the DESK's messages as read, which is what gives the
     operator a truthful receipt. Pass `markRead: false` for a fetch the
     merchant did not ask for — the stats tile samples recent conversations in
     the background, and letting that count as "seen" would tell the desk a
     merchant read something they never opened. */
  getSupportThread(threadId, { markRead = true } = {}) {
    return this._req('get', `/api/support/threads/${threadId}`, {
      params: markRead ? undefined : { mark_read: false },
    });
  },

  /* Shares a real file on the thread. Multipart, so like uploadDocument this
     bypasses _req's JSON shape and lets the browser set its own boundary.

     The server posts a line into the transcript for the file, and returns the
     WHOLE thread — same reasoning as sendSupportMessage. Accepted types are
     PDF, JPEG, PNG and WebP: the bytes are sniffed against the declared type
     server-side, so a renamed file is a 400 rather than a stored surprise.
     There is no delete counterpart by design — a file sent to the desk is part
     of the support record. */
  uploadSupportDocument(threadId, file) {
    const form = new FormData();
    form.append('file', file);
    return axios.post(`${API_BASE}/api/support/threads/${threadId}/documents`, form, {
      headers: partnerAuthHeaders(),
    }).then(r => r.data);
  },

  /* Returns a resolved thread to the desk's queue. Only inside the server's
     reopening window — read `can_reopen` off the thread payload rather than
     working the window out here, or the button and the endpoint will disagree
     and the merchant will meet a 409 they could not have predicted. */
  reopenSupportThread(threadId) {
    return this._req('post', `/api/support/threads/${threadId}/reopen`, { data: {} });
  },

  /* Returns the WHOLE thread, not just the new message. That is the endpoint's
     own shape and it is the right one: the desk may have replied between the
     merchant's last render and this send, and re-rendering from the response
     is what stops a message going missing from the log. */
  sendSupportMessage(threadId, message) {
    return this._req('post', `/api/support/threads/${threadId}/messages`, { data: { message } });
  },

  /* Open threads awaiting a response — drives the badge on the Support Center
     rail item. Claim and resolve are admin-only (`chat.manage`) and are
     deliberately absent here: a merchant cannot close its own ticket. */
  supportUnreadCount() {
    return this._req('get', '/api/support/unread-count');
  },

  /* -------------------------------------------------------- notifications */

  listNotifications(pageSize = 30) {
    return this._req('get', '/api/notifications', { params: { page_size: pageSize } });
  },

  unreadCount() {
    return this._req('get', '/api/notifications/unread-count');
  },

  markNotificationRead(id) {
    return this._req('patch', `/api/notifications/${id}/read`, { data: {} });
  },

  markAllNotificationsRead() {
    return this._req('post', '/api/notifications/read-all', { data: {} });
  },

  /* ---------------------------------------------------- partner assistant

     Backed by app/routers/assistant.py. NEITHER CALL RETURNS BUSINESS DATA:
     interpret takes a sentence and answers with an intent NAME, and the caller
     then uses the ordinary methods above to fetch whatever that intent needs.
     Keeping the two apart is what stops the assistant becoming a second, less
     audited way to read a merchant's money — so if a balance or a booking ever
     needs to appear in one of these responses, that is the signal to add a
     handler in classic-assistant.js instead.

     Both are merchant-only; a staff account gets a 400. */

  assistantConfig() {
    return this._req('get', '/api/assistant/config');
  },

  /* `history` is the merchant's OWN previous questions, oldest first — never
     anything the portal rendered back to them. */
  assistantInterpret({ message, page = null, history = [] } = {}) {
    return this._req('post', '/api/assistant/interpret', {
      data: { message, page: page || undefined, history },
    });
  },
};

/* Status vocabulary, shared so Classic labels and filters match what the
   backend actually stores (request_status_enum). Kept next to the transport
   because a screen that invents its own status string silently filters to
   nothing. */
/* These are sent to the API as `?status=`, so every one must be a real
   `RequestStatus` member.
   M7 FIX: this list said `ticketed`. The enum value is `ticket_issued`, so
   choosing "Ticketed" in any status filter — My Requests, Reports, Payments —
   sent a value FastAPI rejects, and the screen answered `[object Object]` from
   a 422 whose `detail` is a list rather than a string. The whole codebase had
   been hedging around it (`['ticket_issued', 'ticketed']` appears in the
   dashboard's stage groups, and the old reports summary added both keys
   together), which is what a value mismatch looks like from the inside.
   `in_review` was missing outright and is added: a merchant whose booking is
   Under Review could not filter for it. */
const MERCHANT_REQUEST_STATUSES = [
  'draft', 'pending_approval', 'in_review', 'approved', 'payment_pending',
  'paid', 'ticket_issued', 'completed', 'cancelled', 'rejected',
];

/* The stages where the merchant owes or has just paid money. `payment_pending`
   is the one that means "money is owed" — pending_payments_count on the
   dashboard counts submitted payments AWAITING VERIFICATION, which is the
   opposite thing and is easy to confuse. */
const MERCHANT_PAYMENT_STATUSES = ['payment_pending', 'paid', 'ticket_issued'];

/* Every request_type that is a SERVICE REQUEST — something raised against an
   existing booking rather than the booking itself. Mirrors
   ticket_service.SERVICE_REQUEST_TYPES, and lives here beside the status
   vocabulary because more than one screen needs it: Service Requests lists
   them, and My Requests must not offer its Cancel button on one.

   `refund` is in this list but is no longer offered as a new request — money
   comes back through an approved cancellation, which prices it properly. Old
   refund rows still have to render. */
const MERCHANT_SERVICE_REQUEST_TYPES = [
  'cancellation', 'date_change', 'refund', 'passenger_modification',
  'extra_baggage', 'meal', 'seat',
];
