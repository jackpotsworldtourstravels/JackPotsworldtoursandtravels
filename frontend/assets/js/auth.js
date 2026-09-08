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
   Customer Portal (V1) — separate namespace (jpc_*, not jwt_*).
   ---------------------------------------------------------------------
   WHY THE CUSTOMER IS NOT IN jwt_* WITH THE ADMIN.

   The jwt_* block above is documented as "Customer/Admin (shared login)",
   and that was true while both authenticated against /api/auth/login and
   were told apart by `role`. They no longer share a backend: the customer
   signs in against the Customer database (/api/customer/auth/*), the admin
   against the platform `users` table.

   Sharing the keys now would break the Admin Portal, not merely blur it.
   admin.js decides a session exists with

       function isAdminLoggedIn() { return !!localStorage.getItem('jwt_access'); }

   — the key's PRESENCE, with no look at role or scope. A traveller signing
   in on the landing page would write jwt_access and the Admin Portal would
   consider itself logged in, then 401 on every call (the platform refuses
   customer-scoped tokens by design). Hence a namespace of its own, which is
   the same rule the Partner and Super Admin blocks already follow.

   These deliberately mirror the jwt_* signatures one-for-one, so the landing
   page's existing V1 code paths work unchanged when they are rebound in
   app.js — see "THE LANDING PAGE'S STORED SESSION IS THE CUSTOMER'S" there.
   --------------------------------------------------------------------- */
const CUSTOMER_KEYS = {
  access: 'jpc_access', refresh: 'jpc_refresh', name: 'jpc_user_name',
  role: 'jpc_user_role', userId: 'jpc_user_id', remember: 'jpc_remember_identifier',
};
function getCustomerAuth() {
  return {
    access: localStorage.getItem(CUSTOMER_KEYS.access),
    refresh: localStorage.getItem(CUSTOMER_KEYS.refresh),
    name: localStorage.getItem(CUSTOMER_KEYS.name),
    role: localStorage.getItem(CUSTOMER_KEYS.role),
    userId: localStorage.getItem(CUSTOMER_KEYS.userId),
  };
}
/** THE SIGNED-IN TRAVELLER, on any page.
 *
 *  There are two namespaces and which one holds the customer depended on
 *  whether the page loaded app.js: that file does
 *
 *      getStoredAuth = getCustomerAuth;
 *
 *  at line ~775, rebinding the global so everything downstream reads `jpc_*`.
 *  The landing page loads app.js; the service pages and Flights do not. So the
 *  same customer was visible to `getCustomerAuth()` everywhere and to
 *  `getStoredAuth()` only on the landing page — which is why the Account
 *  Center, which asks getStoredAuth, decided nobody was signed in the moment
 *  it was opened from a results page, and quietly offered a login instead.
 *
 *  This asks both, in the order that is true on every page. It does NOT rebind
 *  anything: `getStoredAuth` still means the shared customer/admin `jwt_*`
 *  session that the Admin, Manager and Super Admin portals rely on, and
 *  rebinding it site-wide would sign those portals out.
 *
 *  An ADMIN is deliberately not a customer here: they have their own portal,
 *  and the Account Center is a B2C surface. */
function getCustomerSession() {
  const c = (typeof getCustomerAuth === 'function') ? getCustomerAuth() : null;
  if (c && c.access) return c;
  const s = getStoredAuth();
  if (s && s.access && s.role !== 'admin') return s;
  return { access: null, refresh: null, name: null, role: null, userId: null };
}

function setCustomerAuth(access, refresh, name, role, userId) {
  localStorage.setItem(CUSTOMER_KEYS.access, access);
  localStorage.setItem(CUSTOMER_KEYS.refresh, refresh);
  localStorage.setItem(CUSTOMER_KEYS.name, name);
  localStorage.setItem(CUSTOMER_KEYS.role, role || 'customer');
  if (userId != null) localStorage.setItem(CUSTOMER_KEYS.userId, userId);
}
function clearCustomerAuth() {
  /* `remember` is deliberately NOT cleared — it survives sign-out so the next
     visit can prefill the address, which is the whole point of Remember Me. */
  [CUSTOMER_KEYS.access, CUSTOMER_KEYS.refresh, CUSTOMER_KEYS.name,
   CUSTOMER_KEYS.role, CUSTOMER_KEYS.userId].forEach(k => localStorage.removeItem(k));
}
function customerAuthHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem(CUSTOMER_KEYS.access)}` };
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
/* SAME ORIGIN UNLESS THE PAGE IS NOT ON THE API'S PORT.
   `localhost:8000` and `127.0.0.1:8000` are one machine and TWO ORIGINS to a
   browser. This used to return an absolute 127.0.0.1 base for BOTH hostnames,
   so every call made from http://localhost:8000 was cross-origin and died in
   preflight -- which admin-auth.js reports as "Invalid email or password.",
   showing a wrong password and a request that never arrived identically.

   THIS IS THE COPY THAT MATTERS MOST: every portal's login goes through
   startPortalLogin() below, which calls this rather than the portal's own
   API_BASE. Fixing those four constants made a raw fetch work while the
   login form kept failing, because the form was never using them.

   uvicorn on 8000 mounts frontend/ at / (see .claude/launch.json), so a local
   page served from 8000 is already same-origin. A local page on any OTHER port
   came off a plain file server -- Live Server on 5500/5501, or the `static`
   entry on 8420 -- which has no /api, so that case needs the absolute base.
   Asking "is this the API's port" rather than listing known dev ports means
   there is no list to fall out of date the next time someone serves the
   frontend from somewhere new. */
function authApiBase() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  /* The FRONTEND-ONLY dev servers, listed rather than inferred — see any
     portal's API_BASE for why "not port 8000" was the wrong question. */
  return (local && ['5500', '5501', '8420'].includes(location.port))
    ? 'http://127.0.0.1:8000' : '';
}

/* ---------------------------------------------------------------------------
   Turning a failure into a sentence that names the RIGHT thing
   ---------------------------------------------------------------------------
   Every portal used to write `err.response?.data?.detail || 'Invalid email or
   password.'`, which tells the truth in exactly one of the three ways a login
   fails and lies in the other two:

     1. The request never arrived -- the server is down, or the page is on an
        origin the API does not answer. There is no `err.response` at all, so
        the `||` fires and the reader is told their password is wrong. The
        origin bug fixed in 3bcd3f6 presented precisely like this, and the
        message pointed at the one thing that was not the problem.
     2. slowapi's 429 answers `{"error": "Rate limit exceeded: ..."}` with NO
        `detail` key, so the `||` fires again. Someone who mistypes ten times
        and then types it CORRECTLY is told their correct password is wrong,
        which is the worst version of this: it makes people change a password
        that was fine.
     3. The credentials really were rejected. Only here was the sentence true.

   `detail` is also an ARRAY for a 422, which renders as "[object Object]" when
   assigned to textContent -- handled here so no caller has to remember. */
function authErrorText(err, fallback) {
  if (!err) return fallback;

  /* No response object means the request did not complete: DNS, a refused
     connection, a CORS preflight the browser blocked, or the tab going
     offline. The browser deliberately does not tell a page WHICH of those it
     was -- so this says what is knowable and points at what to check, rather
     than guessing. */
  if (!err.response) {
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
      return 'The server took too long to respond. Try again in a moment.';
    }
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    return local
      ? `Could not reach the API at ${authApiBase() || location.origin}. `
        + 'Check that the backend is running on port 8000.'
      : 'Could not reach the server. Check your connection and try again.';
  }

  const status = err.response.status;
  const data = err.response.data || {};

  /* slowapi puts its message in `error`, not `detail`. Checked before the
     `detail` lookup rather than after, so this cannot fall through again. */
  if (status === 429) {
    return typeof data.error === 'string' && data.error
      ? `${data.error}. Wait a minute and try again.`
      : 'Too many attempts. Wait a minute and try again.';
  }

  if (Array.isArray(data.detail)) {
    const text = data.detail.map(d => d && d.msg).filter(Boolean).join(' ');
    return text || fallback;
  }
  if (typeof data.detail === 'string' && data.detail) return data.detail;
  if (typeof data.error === 'string' && data.error) return data.error;

  /* A 5xx is ours, not the reader's. Saying "invalid password" for one sends
     them to change a password that was never the problem. */
  if (status >= 500) return 'The server had a problem handling that. Try again in a moment.';

  return fallback;
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
