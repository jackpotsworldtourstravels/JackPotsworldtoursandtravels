'use strict';
/* ==========================================================================
   auth.js — single source of truth for JWT/session management across every
   portal. Three DELIBERATELY SEPARATE localStorage namespaces are kept
   below, exactly as they were before this file existed: Customer/Admin
   (jwt_*), Partner (partner_jwt_*), and Super Admin (super_admin_jwt_*).
   They must never be merged — this project relies on that isolation so a
   login in one portal can never silently overwrite a session open in
   another portal in the same browser. This file only consolidates what
   used to be copy-pasted into app.js, admin.js, partner-shared.js, and
   super-admin-shared.js into one place; it changes no key names, no
   function names, and no behavior.
   ========================================================================== */

/* ---------------------------------------------------------------------
   Customer / Admin (shared login — index.html and admin.html both
   authenticate against /api/auth/login and store under the jwt_* keys;
   role is what distinguishes an admin session from a customer session).
   --------------------------------------------------------------------- */
function getStoredAuth() {
  return {
    access: localStorage.getItem('jwt_access'),
    refresh: localStorage.getItem('jwt_refresh'),
    name: localStorage.getItem('jwt_user_name'),
    role: localStorage.getItem('jwt_user_role'),
    userId: localStorage.getItem('jwt_user_id'),
  };
}
function setStoredAuth(access, refresh, name, role, userId) {
  localStorage.setItem('jwt_access', access);
  localStorage.setItem('jwt_refresh', refresh);
  localStorage.setItem('jwt_user_name', name);
  localStorage.setItem('jwt_user_role', role);
  if (userId != null) localStorage.setItem('jwt_user_id', userId);
}
function clearStoredAuth() {
  localStorage.removeItem('jwt_access');
  localStorage.removeItem('jwt_refresh');
  localStorage.removeItem('jwt_user_name');
  localStorage.removeItem('jwt_user_role');
  localStorage.removeItem('jwt_user_id');
}
function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('jwt_access')}` };
}
function isSessionExpired(err) {
  return err?.response?.status === 401;
}

/* ---------------------------------------------------------------------
   Partner Portal — separate namespace (partner_jwt_*, not jwt_*).
   --------------------------------------------------------------------- */
const PARTNER_KEYS = {
  access: 'partner_jwt_access', refresh: 'partner_jwt_refresh',
  fullName: 'partner_user_name', companyName: 'partner_company_name',
};
function partnerAuthHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem(PARTNER_KEYS.access)}` };
}
function isPartnerLoggedIn() {
  return !!localStorage.getItem(PARTNER_KEYS.access);
}
function storePartnerSession(data) {
  localStorage.setItem(PARTNER_KEYS.access, data.access_token);
  localStorage.setItem(PARTNER_KEYS.refresh, data.refresh_token);
  if (data.full_name) localStorage.setItem(PARTNER_KEYS.fullName, data.full_name);
  if (data.company_name) localStorage.setItem(PARTNER_KEYS.companyName, data.company_name);
}
function clearPartnerSession() {
  Object.values(PARTNER_KEYS).forEach(k => localStorage.removeItem(k));
}

/* ---------------------------------------------------------------------
   Super Admin Portal — separate namespace (super_admin_jwt_*).
   --------------------------------------------------------------------- */
const SA_KEYS = { access: 'super_admin_jwt_access', refresh: 'super_admin_jwt_refresh', fullName: 'super_admin_full_name' };
function saAuthHeaders() { return { Authorization: `Bearer ${localStorage.getItem(SA_KEYS.access)}` }; }
function isSuperAdminLoggedIn() { return !!localStorage.getItem(SA_KEYS.access); }
function storeSuperAdminSession(data) {
  localStorage.setItem(SA_KEYS.access, data.access_token);
  localStorage.setItem(SA_KEYS.refresh, data.refresh_token);
  if (data.full_name) localStorage.setItem(SA_KEYS.fullName, data.full_name);
}
function clearSuperAdminSession() { Object.values(SA_KEYS).forEach(k => localStorage.removeItem(k)); }

/* ---------------------------------------------------------------------
   2026-07-29 additions — the unified Login -> Password -> OTP -> Dashboard
   flow used by all three B2B portals (docs/API_CONTRACT.md §1), against
   the live /api/auth/* endpoints. Purely additive: every namespace/
   function above is untouched and still what every portal's storage goes
   through — these just add the OTP round trip and a refresh helper that
   didn't exist before (the old Partner/Super Admin flows had no refresh
   wiring at all, and Partner's OTP step called a different, now-dead,
   endpoint in the wrong order — see docs/API_CONTRACT.md §1 and §8).
   --------------------------------------------------------------------- */
function authApiBase() {
  return ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';
}

/** Step 1: email + password + portal -> OTP challenge (LoginChallengeResponse). */
async function startPortalLogin(portal, email, password) {
  const { data } = await axios.post(`${authApiBase()}/api/auth/login`, { email, password, portal });
  return data;
}
/** Step 2: challenge token + code -> tokens + user (TokenResponse). */
async function verifyPortalOtp(challengeToken, code) {
  const { data } = await axios.post(`${authApiBase()}/api/auth/verify-otp`, { challenge_token: challengeToken, code });
  return data;
}
async function resendPortalOtp(challengeToken) {
  const { data } = await axios.post(`${authApiBase()}/api/auth/resend-otp`, { challenge_token: challengeToken });
  return data;
}

function portalAccessKey(portal) {
  return portal === 'admin' ? 'jwt_access' : portal === 'merchant' ? PARTNER_KEYS.access : SA_KEYS.access;
}
function portalRefreshKey(portal) {
  return portal === 'admin' ? 'jwt_refresh' : portal === 'merchant' ? PARTNER_KEYS.refresh : SA_KEYS.refresh;
}

/** Persist a TokenResponse under the calling portal's existing namespace — populating both
 *  the legacy individual keys that portal's own JS already reads (full name, company name,
 *  role) and one JSON snapshot of the full `user` object (permissions[], merchant_role, etc.)
 *  for anything new that needs more than a name/role string. */
function storePortalTokens(portal, data) {
  const u = data.user || {};
  if (portal === 'admin') {
    setStoredAuth(data.access_token, data.refresh_token, u.full_name, u.role, u.id);
  } else if (portal === 'merchant') {
    storePartnerSession({
      access_token: data.access_token, refresh_token: data.refresh_token,
      full_name: u.full_name, company_name: u.merchant_name,
    });
  } else if (portal === 'super_admin') {
    storeSuperAdminSession({ access_token: data.access_token, refresh_token: data.refresh_token, full_name: u.full_name });
  }
  localStorage.setItem(`${portal}_user_json`, JSON.stringify(u));
}
function getPortalUser(portal) {
  const raw = localStorage.getItem(`${portal}_user_json`);
  return raw ? JSON.parse(raw) : null;
}

/** One-shot silent refresh. Returns the new access token, or null if there's no refresh
 *  token or it's been revoked — callers fall back to clearing the session and re-prompting.
 *
 *  Several API calls can 401 in the same instant (e.g. the dashboard KPIs and the notification
 *  bell both loading on page arrival) — without dedup, each would fire its own
 *  /api/auth/refresh concurrently. The backend tolerates that today (refresh tokens aren't
 *  single-use), but it's still 2-3x the necessary calls, so in-flight requests share one
 *  promise per portal instead. */
const _refreshInFlight = {};
async function tryRefreshPortalSession(portal) {
  if (_refreshInFlight[portal]) return _refreshInFlight[portal];
  const refresh_token = localStorage.getItem(portalRefreshKey(portal));
  if (!refresh_token) return null;
  _refreshInFlight[portal] = (async () => {
    try {
      const { data } = await axios.post(`${authApiBase()}/api/auth/refresh`, { refresh_token });
      localStorage.setItem(portalAccessKey(portal), data.access_token);
      localStorage.setItem(portalRefreshKey(portal), data.refresh_token);
      return data.access_token;
    } catch {
      return null;
    } finally {
      delete _refreshInFlight[portal];
    }
  })();
  return _refreshInFlight[portal];
}

/** Server-side logout (revokes the session) plus clearing whichever portal's local keys. */
async function logoutPortalSession(portal) {
  const token = localStorage.getItem(portalAccessKey(portal));
  try {
    await axios.post(`${authApiBase()}/api/auth/logout`, {}, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) { /* best-effort — clear locally regardless */ }
  if (portal === 'admin') clearStoredAuth();
  else if (portal === 'merchant') clearPartnerSession();
  else if (portal === 'super_admin') clearSuperAdminSession();
  localStorage.removeItem(`${portal}_user_json`);
}

/** Shared axios 401 handler: try one silent refresh before giving up. Each portal page wires
 *  this into its own interceptor (which then clears its own session + shows its own auth
 *  shell on final failure) since only that page knows how to redraw itself. */
async function handlePortalUnauthorized(portal, err) {
  const cfg = err.config || {};
  const url = cfg.url || '';
  if (cfg._retriedAfterRefresh || url.includes('/api/auth/')) return null;
  cfg._retriedAfterRefresh = true;
  const newToken = await tryRefreshPortalSession(portal);
  if (!newToken) return null;
  cfg.headers = { ...cfg.headers, Authorization: `Bearer ${newToken}` };
  return axios(cfg);
}
