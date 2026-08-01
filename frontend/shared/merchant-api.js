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

   This is a transport layer.

   Requires (in this order): axios, API_BASE, auth.js (partnerAuthHeaders). */

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

  getEnquiry(id) {
    return this._req('get', `/api/enquiries/${id}`);
  },

  /* Request Ticket: turns an APPROVED enquiry into a DRAFT booking. Only the
     passengers are sent — every itinerary field is copied from the enquiry
     server-side, so the booking is always the journey that was answered.
     Returns the booking; it still needs submitRequest() to reach the desk.
     409 if this enquiry has already been booked. */
  enquiryToBookingRequest(id, { passengers, remarks, contact, international, specialRequests }) {
    return this._req('post', `/api/enquiries/${id}/booking-request`, {
      data: {
        passengers,
        remarks: remarks || undefined,
        contact: contact || undefined,
        /* Sent from the UI because the API has no country data — see
           isInternationalRoute() in travel-locations.js. It decides whether
           passports are enforced at submit. */
        international: !!international,
        special_requests: specialRequests || undefined,
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

  /* Draft-only, both of them. Used when resuming a saved draft: the passenger
     list is replaced wholesale (the endpoint's own semantics) and the
     booking-level fields are merged into travel_details server-side. */
  replacePassengers(id, passengers) {
    return this._req('put', `/api/requests/${id}/passengers`, { data: { passengers } });
  },

  updateDraft(id, { remarks, contact, specialRequests }) {
    return this._req('put', `/api/requests/${id}`, {
      data: {
        remarks: remarks ?? undefined,
        contact: contact ?? undefined,
        special_requests: specialRequests ?? undefined,
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

  /* Only while it is still Pending — once an operator has claimed it the
     server returns 409 naming them. */
  withdrawChangeRequest(id) {
    return this._req('post', `/api/change-requests/${id}/withdraw`);
  },

  bookingChangeRequests(bookingId) {
    return this._req('get', `/api/bookings/${bookingId}/change-requests`);
  },

  /* -------------------------------------------------------------- reports */

  /* Returns a Blob — the caller is responsible for the object URL and for
     revoking it. Premium requests CSV; the param set matches the list filters
     so the export and the on-screen table describe the same rows. */
  exportReport(params) {
    return this._req('get', '/api/reports/export', { params, responseType: 'blob' });
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
};

/* Status vocabulary, shared so Classic labels and filters match what the
   backend actually stores (request_status_enum). Kept next to the transport
   because a screen that invents its own status string silently filters to
   nothing. */
const MERCHANT_REQUEST_STATUSES = [
  'draft', 'pending_approval', 'approved', 'payment_pending',
  'paid', 'ticketed', 'completed', 'cancelled', 'rejected',
];

/* The stages where the merchant owes or has just paid money. `payment_pending`
   is the one that means "money is owed" — pending_payments_count on the
   dashboard counts submitted payments AWAITING VERIFICATION, which is the
   opposite thing and is easy to confuse. */
const MERCHANT_PAYMENT_STATUSES = ['payment_pending', 'paid', 'ticketed'];
