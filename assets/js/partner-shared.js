'use strict';
/* Partner Portal — shared helpers.
   Deliberately separate localStorage namespace (partner_jwt_*, not jwt_*) —
   index.html, admin.html, and this page all share one browser origin, so
   reusing the core site's keys would let a partner login silently overwrite
   an admin or customer session open in the same browser, or vice versa. */

const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

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

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function money(n) { return n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'); }
function fmtDate(s) { return s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function fmtDateTime(s) { return s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
function fmtTime(s) { return s ? new Date(s).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—'; }
function rowsSkeleton() { return '<tr><td colspan="12" class="empty-state">Loading…</td></tr>'; }
function statusLabel(s) { return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

/* Any 401 from a partner-scoped call means the session is gone (expired,
   revoked, or never valid) — bounce back to the auth flow rather than
   showing a broken portal. */
axios.interceptors.response.use(
  res => res,
  err => {
    const url = err.config?.url || '';
    if (err.response?.status === 401 && url.includes('/api/partner')) {
      clearPartnerSession();
      showPartnerAuthShell();
    }
    return Promise.reject(err);
  }
);

function showPartnerAuthShell() {
  document.getElementById('partnerAuthShell').style.display = 'flex';
  document.getElementById('partnerLayout').style.display = 'none';
}
function showPartnerPortal() {
  document.getElementById('partnerAuthShell').style.display = 'none';
  document.getElementById('partnerLayout').style.display = 'flex';
  document.getElementById('partnerChipName').textContent = localStorage.getItem(PARTNER_KEYS.fullName) || 'Partner';
  document.getElementById('partnerChipCompany').textContent = localStorage.getItem(PARTNER_KEYS.companyName) || '';
  const initials = (localStorage.getItem(PARTNER_KEYS.fullName) || 'P').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('partnerChipAvatar').textContent = initials || 'P';
  navigateToSection('dashboard');
}

const sectionTitles = {
  dashboard: 'Dashboard', 'ticket-enquiry': 'Ticket Enquiry', 'request-ticket': 'Request Ticket',
  'request-history': 'Request History', 'service-request': 'Service Request', reports: 'Reports', profile: 'Profile',
};
const loadedSections = new Set();
function navigateToSection(name, onArrive) {
  document.querySelectorAll('.nav-item[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  document.getElementById('pageTitle').textContent = sectionTitles[name] || name;
  document.querySelector('.layout').classList.remove('mobile-open');
  if (!loadedSections.has(name)) {
    loadedSections.add(name);
    Promise.resolve(loadPartnerSection(name)).then(() => onArrive?.());
  } else {
    onArrive?.();
  }
}
function loadPartnerSection(name) {
  const loaders = {
    dashboard: () => loadDashboard(),
    'ticket-enquiry': () => initTicketEnquiry(),
    'request-ticket': () => initRequestTicket(),
    'request-history': () => loadRequestHistory(),
    'service-request': () => initServiceRequest(),
    reports: () => initReports(),
    profile: () => loadProfile(),
  };
  return loaders[name]?.();
}
document.querySelectorAll('.nav-item[data-section]').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); navigateToSection(link.dataset.section); });
});

/* ---------- Mobile nav ---------- */
document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
  document.querySelector('.layout').classList.add('mobile-open');
});
document.getElementById('sidebarBackdrop')?.addEventListener('click', () => {
  document.querySelector('.layout').classList.remove('mobile-open');
});

/* ---------- Sign out ---------- */
const signOutModalOverlay = document.getElementById('signOutModalOverlay');
document.getElementById('partnerSignOutBtn').addEventListener('click', e => {
  e.preventDefault();
  signOutModalOverlay.classList.add('open');
});
document.getElementById('cancelSignOutBtn').addEventListener('click', () => signOutModalOverlay.classList.remove('open'));
document.getElementById('confirmSignOutBtn').addEventListener('click', async () => {
  try { await axios.post(`${API_BASE}/api/partner-auth/logout`, {}, { headers: partnerAuthHeaders() }); } catch (err) { /* ignore */ }
  clearPartnerSession();
  loadedSections.clear();
  signOutModalOverlay.classList.remove('open');
  showPartnerAuthShell();
  resetAuthFlow();
});
