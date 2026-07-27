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
