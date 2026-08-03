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
   Manager Portal (CR-2) — its own namespace (manager_jwt_*), like every
   other portal. Sharing the Admin's `jwt_*` keys would have let a signed-in
   Manager and a signed-in Admin overwrite each other on the same browser,
   which is exactly the pair of roles most likely to be open side by side
   while a booking is being chased.
   --------------------------------------------------------------------- */
const MGR_KEYS = { access: 'manager_jwt_access', refresh: 'manager_jwt_refresh', fullName: 'manager_full_name' };
function managerAuthHeaders() { return { Authorization: `Bearer ${localStorage.getItem(MGR_KEYS.access)}` }; }
function isManagerLoggedIn() { return !!localStorage.getItem(MGR_KEYS.access); }
function storeManagerSession(data) {
  localStorage.setItem(MGR_KEYS.access, data.access_token);
  localStorage.setItem(MGR_KEYS.refresh, data.refresh_token);
  if (data.full_name) localStorage.setItem(MGR_KEYS.fullName, data.full_name);
}
function clearManagerSession() { Object.values(MGR_KEYS).forEach(k => localStorage.removeItem(k)); }

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
  if (portal === 'admin') return 'jwt_access';
  if (portal === 'merchant') return PARTNER_KEYS.access;
  if (portal === 'manager') return MGR_KEYS.access;
  return SA_KEYS.access;
}
function portalRefreshKey(portal) {
  if (portal === 'admin') return 'jwt_refresh';
  if (portal === 'merchant') return PARTNER_KEYS.refresh;
  if (portal === 'manager') return MGR_KEYS.refresh;
  return SA_KEYS.refresh;
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
  } else if (portal === 'manager') {
    storeManagerSession({ access_token: data.access_token, refresh_token: data.refresh_token, full_name: u.full_name });
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

/* ---------------------------------------------------------------------
   SIGNING OUT — one destination for every portal.
   ---------------------------------------------------------------------
   Merchant, Data Operator, Manager, Admin and Super Admin all land on the
   public partner login. Each portal used to drop the user on its OWN
   in-page sign-in card, which meant five different answers to "where am I
   now?" and left staff sitting on an internal screen after asking to leave
   it.

   ABSOLUTE, AND NOT DERIVED FROM location.origin. The internal portals are
   served from the same host in production but from :8000, :5500 and file://
   during development, and a relative path would send a signed-out user to
   whichever of those they happened to be on. There is one live front door.
   --------------------------------------------------------------------- */
const PORTAL_LOGIN_URL = 'https://jackpotsworldtours.com/partner-login.html';

/** Leave for the public login, without leaving this page behind in history.
 *
 *  `replace`, never `assign`: the portal page is overwritten in the history
 *  stack rather than pushed past, so Back from the login does not return to a
 *  screen the user has just signed out of. */
function redirectToPortalLogin() {
  location.replace(PORTAL_LOGIN_URL);
}

/** Was this page reached by Back/Forward rather than by a fresh navigation?
 *
 *  This is the whole distinction the auth guard rests on. A member of staff who
 *  deliberately opens /admin/ with no session should get the Admin sign-in card
 *  — bouncing them to the merchant login would leave them no way in at all.
 *  Someone pressing Back after signing out is a different event entirely, and
 *  is the one this guard exists to catch. */
function isBackForwardNavigation() {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    return !!nav && nav.type === 'back_forward';
  } catch {
    return false;
  }
}

/** Send the user to the public login if they arrive back on a protected page
 *  with no session. Call once per portal, passing that portal's own
 *  "am I signed in?" predicate.
 *
 *  `pageshow` rather than `load`, because a page restored from the back/forward
 *  cache does not run its scripts again — it is handed back exactly as it was,
 *  signed-in-looking chrome and all, and `persisted` is the only signal that it
 *  happened. The navigation-type check covers the browsers that reload instead. */
function guardPortalSession(isLoggedIn) {
  window.addEventListener('pageshow', event => {
    if (isLoggedIn()) return;
    if (event.persisted || isBackForwardNavigation()) redirectToPortalLogin();
  });
}

/* Endpoints where a 401 means "those credentials are wrong", NOT "your session
   has ended". Someone mistyping a password is *on the sign-in screen already*
   and must stay there.

   THIS LIST IS WHAT STOPS A BAD PASSWORD FROM EJECTING STAFF FROM THEIR OWN
   PORTAL. `/api/auth/login` answers 401 for a wrong password exactly as an
   expired token does elsewhere, so without it the interceptor below would read
   a typo as a dead session and bounce an Admin off /admin/ to the merchant
   login — leaving them no way in, which is the one outcome this whole change
   was designed to avoid.

   `/api/auth/me` and `/api/auth/refresh` are deliberately ABSENT: a 401 from
   either really does mean the session is gone, and should end it. */
const CREDENTIAL_ENDPOINTS = [
  '/api/auth/login', '/api/auth/verify-otp', '/api/auth/resend-otp',
  '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/change-password',
];

/** Does this 401 mean the session is over (rather than a rejected credential)? */
function isSessionEndingUnauthorized(err) {
  const url = (err && err.config && err.config.url) || '';
  return !CREDENTIAL_ENDPOINTS.some(path => url.includes(path));
}

/** Everything held about the person who was signed in, beyond their tokens.
 *
 *  Theme and sidebar preferences are deliberately NOT cleared: those describe
 *  the device, not the account, and wiping them would make signing out silently
 *  reset an unrelated setting. */
function clearCachedUserData(portal) {
  localStorage.removeItem(`${portal}_user_json`);
  localStorage.removeItem('mh_recent_searches');
}

/** Server-side logout (revokes the session), clearing whichever portal's local
 *  keys, then out to the public login.
 *
 *  Pass `{ redirect: false }` only where the caller genuinely owns what happens
 *  next. Everything that is a user pressing Sign Out wants the default. */
async function logoutPortalSession(portal, { redirect = true } = {}) {
  const token = localStorage.getItem(portalAccessKey(portal));
  try {
    await axios.post(`${authApiBase()}/api/auth/logout`, {}, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) { /* best-effort — clear locally regardless */ }
  if (portal === 'admin') clearStoredAuth();
  else if (portal === 'merchant') clearPartnerSession();
  else if (portal === 'manager') clearManagerSession();
  else if (portal === 'super_admin') clearSuperAdminSession();
  clearCachedUserData(portal);
  // AFTER the keys are gone, never before: a redirect that raced the clearing
  // would leave a live token in a browser the user believes they have left.
  if (redirect) redirectToPortalLogin();
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
