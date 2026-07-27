'use strict';
/* Partner Portal — shared helpers.
   Deliberately separate localStorage namespace (partner_jwt_*, not jwt_*) —
   index.html, admin.html, and this page all share one browser origin, so
   reusing the core site's keys would let a partner login silently overwrite
   an admin or customer session open in the same browser, or vice versa. */

const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

/* PARTNER_KEYS, partnerAuthHeaders(), isPartnerLoggedIn(), storePartnerSession(),
   clearPartnerSession() now live in assets/js/auth.js, loaded before this file. */

/* escapeHtml/money/fmtDate/fmtDateTime/fmtTime now live in shared/formatters.js. */
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
  initNotifications();
}

const sectionTitles = {
  dashboard: 'Dashboard', 'ticket-enquiry': 'Ticket Enquiry', 'request-ticket': 'Request Ticket',
  'request-history': 'Request History', 'service-request': 'Service Request', reports: 'Reports',
  'live-chat': 'Live Chat Support', profile: 'Profile',
};
const loadedSections = new Set();
function navigateToSection(name, onArrive) {
  document.querySelectorAll('.nav-item[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  document.getElementById('pageTitle').textContent = sectionTitles[name] || name;
  const bc = document.getElementById('breadcrumbCurrent');
  if (bc) bc.textContent = sectionTitles[name] || name;
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
    'live-chat': () => initLiveChat(),
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
  if (typeof notifPollTimer !== 'undefined' && notifPollTimer) { clearInterval(notifPollTimer); notifPollTimer = null; }
  signOutModalOverlay.classList.remove('open');
  showPartnerAuthShell();
  resetAuthFlow();
});

/* ---------- Theme: light / dark / system, persisted ---------- */
const THEME_KEY = 'partner_theme_pref';
function resolvedTheme(pref) {
  if (pref === 'system' || !pref) return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return pref;
}
function applyThemePreference() {
  const pref = localStorage.getItem(THEME_KEY) || 'system';
  if (pref === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', pref);
  const isDark = resolvedTheme(pref) === 'dark';
  const sun = document.getElementById('themeIconSun'), moon = document.getElementById('themeIconMoon');
  if (sun && moon) { sun.style.display = isDark ? 'none' : 'block'; moon.style.display = isDark ? 'block' : 'none'; }
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.title = `Theme: ${pref[0].toUpperCase()}${pref.slice(1)} (click to change)`;
}
document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(localStorage.getItem(THEME_KEY) || 'system') + 1) % 3];
  localStorage.setItem(THEME_KEY, next);
  applyThemePreference();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyThemePreference();
});
applyThemePreference();

/* ---------- Sidebar collapse, persisted (desktop only) ---------- */
const SIDEBAR_KEY = 'partner_sidebar_collapsed';
function applySidebarCollapsePreference() {
  document.querySelector('.layout')?.classList.toggle('sidebar-collapsed', localStorage.getItem(SIDEBAR_KEY) === '1');
}
document.getElementById('sidebarCollapseBtn')?.addEventListener('click', () => {
  const collapsed = document.querySelector('.layout').classList.toggle('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
});
applySidebarCollapsePreference();

/* ---------- Topbar date ---------- */
const topbarDateEl = document.getElementById('topbarDate');
if (topbarDateEl) topbarDateEl.textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
