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

/* A 401 from any API call means the session is gone (expired, revoked, or never valid).
   Try one silent refresh first (see auth.js::handlePortalUnauthorized) — only bounce back to
   the auth shell once that's failed too. Checking the URL for "/api/partner" here would miss
   almost every v2 call (catalog/requests/service-requests/merchant-team all live under plain
   /api/*, not /api/partner/*), so this checks status alone. */
axios.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401) {
      const retried = await handlePortalUnauthorized('merchant', err);
      if (retried) return retried;
      clearPartnerSession();
      showPartnerAuthShell();
    }
    return Promise.reject(err);
  }
);

function showPartnerAuthShell() {
  document.getElementById('partnerAuthShell').style.display = 'flex';
  document.getElementById('partnerLayout').style.display = 'none';
  document.getElementById('mhHeader').style.display = 'none';
}
function showPartnerPortal() {
  document.getElementById('partnerAuthShell').style.display = 'none';
  document.getElementById('partnerLayout').style.display = 'flex';
  document.getElementById('mhHeader').style.display = 'block';

  const name = localStorage.getItem(PARTNER_KEYS.fullName) || 'Partner';
  const company = localStorage.getItem(PARTNER_KEYS.companyName) || '';
  document.getElementById('partnerChipName').textContent = name;
  document.getElementById('partnerChipCompany').textContent = company;
  document.getElementById('mhMenuName').textContent = name;
  document.getElementById('mhMenuCompany').textContent = company;
  const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('partnerChipAvatar').textContent = initials || 'P';

  /* Home, not Dashboard — a merchant lands on the booking surface. */
  navigateToSection('home');
  initNotifications();
}

const sectionTitles = {
  home: 'Home', dashboard: 'Dashboard', 'ticket-enquiry': 'Ticket Enquiry',
  'request-ticket': 'Request Ticket', 'request-history': 'My Requests',
  payments: 'Payments', 'service-request': 'Service Request', reports: 'Reports',
  'live-chat': 'Live Chat Support', profile: 'Profile',
};
const loadedSections = new Set();
function navigateToSection(name, onArrive) {
  /* Selector is [data-section], not .nav-item[data-section]: navigation now comes
     from the travel header's account menu as well as the (hidden) sidebar. */
  document.querySelectorAll('[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  document.getElementById('pageTitle').textContent = sectionTitles[name] || name;
  const bc = document.getElementById('breadcrumbCurrent');
  if (bc) bc.textContent = sectionTitles[name] || name;

  /* Home carries its own hero header, so the ERP topbar (page title, breadcrumb,
     date) would just stack a second heading on top of it. */
  document.querySelector('.topbar').style.display = name === 'home' ? 'none' : '';
  document.querySelector('.main').classList.toggle('mh-full', name === 'home');
  document.querySelectorAll('[data-mh-navlink]').forEach(l => {
    if (name !== 'home') l.classList.remove('active');
  });

  /* Bottom nav highlights its own entry, and clears when the merchant is on a
     section it doesn't cover (Request Ticket, Reports, Dashboard). */
  document.querySelectorAll('[data-mh-bnav]').forEach(b => {
    b.classList.toggle('active', b.dataset.mhBnav === name);
  });

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
    home: () => initHome(),
    dashboard: () => loadDashboard(),
    'ticket-enquiry': () => initTicketEnquiry(),
    'request-ticket': () => initRequestTicket(),
    'request-history': () => loadRequestHistory(),
    payments: () => loadPayments(),
    'service-request': () => initServiceRequest(),
    reports: () => initReports(),
    'live-chat': () => initLiveChat(),
    profile: () => loadProfile(),
  };
  return loaders[name]?.();
}
/* The account menu's own links are wired in partner-home.js (mhInitAccountMenu) so
   it can close the dropdown first; this covers the sidebar's items. */
document.querySelectorAll('.nav-item[data-section]').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); navigateToSection(link.dataset.section); });
});

/* ---------- Mobile nav ---------- */
document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
  document.querySelector('.layout').classList.add('mobile-open');
});
/* Phone-only bottom bar. It adds no destinations of its own — every entry is a
   section the account menu already reaches; this just puts the five a merchant
   needs mid-booking within thumb reach. */
document.querySelectorAll('[data-mh-bnav]').forEach(btn => {
  btn.addEventListener('click', () => {
    navigateToSection(btn.dataset.mhBnav);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
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
/* Same confirm modal from the travel header's account menu. */
document.getElementById('mhSignOutLink')?.addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('mhAcctMenu')?.classList.remove('open');
  signOutModalOverlay.classList.add('open');
});
document.getElementById('cancelSignOutBtn').addEventListener('click', () => signOutModalOverlay.classList.remove('open'));
document.getElementById('confirmSignOutBtn').addEventListener('click', async () => {
  await logoutPortalSession('merchant');
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
