'use strict';
/* ==========================================================================
   api.js — reusable API layer. Every method here wraps axios + API_BASE +
   the right auth headers for exactly one real backend endpoint (see
   backend/app/routers/ for each route's source of truth) — no page should
   need to build its own axios.get/post call for these operations anymore.

   API_BASE itself is defined per-page (index.html/login.html/etc. and
   admin.html each already declare it; partner-shared.js and
   super-admin-shared.js declare their own copies too) since it's a single
   constant, not worth centralizing further. This file just needs it to
   already be in scope, so load api.js AFTER whichever script defines
   API_BASE, same as auth.js.
   ========================================================================== */

const Api = {
  /** Low-level helper every named method below is built on. */
  async request(method, path, { data, params, headers, responseType } = {}) {
    const res = await axios({ method, url: `${API_BASE}${path}`, data, params, headers, responseType });
    return res.data;
  },

  /* ---------------- Auth (Customer/Admin — shared /api/auth/*) ---------------- */
  login(email, password) {
    return this.request('post', '/api/auth/login', { data: { email, password } });
  },
  register(payload) {
    return this.request('post', '/api/auth/signup', { data: payload });
  },
  me(headers) {
    return this.request('get', '/api/auth/me', { headers });
  },
  logout(headers) {
    return this.request('post', '/api/auth/logout', { headers }).catch(() => {});
  },

  /* ---------------- Customer ---------------- */
  getBookings(headers, params) {
    return this.request('get', '/api/bookings', { headers, params });
  },
  getNotifications(headers) {
    return this.request('get', '/api/notifications', { headers });
  },

  /* ---------------- Admin ---------------- */
  getPartners(headers, params) {
    // "Partners" = the Merchant Management list (GET /api/admin/merchants).
    return this.request('get', '/api/admin/merchants', { headers, params });
  },

  /* ---------------- Partner (Merchant) Portal ---------------- */
  getReports(headers, params) {
    return this.request('get', '/api/partner/reports', { headers, params });
  },
  requestTicket(headers, payload) {
    // Creates a draft ticket request; the caller then adds passengers and
    // calls submitTicketRequest() to send it for approval (unchanged
    // two-step flow already used by partner-request-ticket.js).
    return this.request('post', '/api/partner/bookings', { headers, data: payload });
  },
  submitTicketRequest(headers, bookingId) {
    return this.request('post', `/api/partner/bookings/${bookingId}/submit`, { headers });
  },
  cancelTicket(headers, payload) {
    return this.request('post', '/api/partner/service-requests/cancellation', { headers, data: payload });
  },
  changeJourneyDate(headers, payload) {
    return this.request('post', '/api/partner/service-requests/date-change', { headers, data: payload });
  },
};
