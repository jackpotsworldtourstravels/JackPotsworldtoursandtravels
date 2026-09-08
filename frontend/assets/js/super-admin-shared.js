'use strict';
/* Super Admin Portal — shared helpers. Separate localStorage namespace
   (super_admin_jwt_*) so a Super Admin session can never collide with a
   customer/admin session or a partner session open in the same browser —
   same reasoning as partner-shared.js's PARTNER_KEYS. */

/* SAME ORIGIN UNLESS THE PAGE CAME OFF A FILE SERVER.
   `localhost:8000` and `127.0.0.1:8000` are one machine and TWO ORIGINS to a
   browser, which is why an absolute base for both hostnames broke every login
   from http://localhost:8000 (3bcd3f6).

   The list is the FRONTEND-ONLY dev servers: Live Server on 5500/5501 and the
   `static` entry on 8420. Those serve files and no /api, so they need the
   absolute base. Everything else — uvicorn on any port, which mounts frontend/
   at /, and production behind Caddy — already serves its own API and must stay
   same-origin.

   An earlier version asked "is this port 8000?" instead of listing the file
   servers. That reads as more general and is in fact narrower: a second backend
   on any other port (verifying a change while 8000 is busy, say) was sent to
   8000 and failed. The set of file-server ports is small and known; the set of
   ports a backend might use is not. */
const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname)
                && ['5500', '5501', '8420'].includes(location.port))
  ? 'http://127.0.0.1:8000' : '';

/* SA_KEYS, saAuthHeaders(), isSuperAdminLoggedIn(), storeSuperAdminSession(),
   clearSuperAdminSession() now live in assets/js/auth.js, loaded before this file. */

/* Thin aliases onto shared/formatters.js's canonical escapeHtml/fmtDate,
   kept under their sa-prefixed names since every super-admin-*.js file
   already calls them that way. */
function saEscapeHtml(str) { return escapeHtml(str); }
function saFmtDate(s) { return fmtDate(s); }

/* ---------- Small shared render helpers ----------
   Prev/Next pager, mirroring admin.js::renderPagination so both staff portals
   page through their tables the same way. */
const SA_PAGE_SIZE = 10;
function saRenderPagination(containerId, page, totalPages, total, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!total) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <span>Page ${page} of ${totalPages} (${total} total)</span>
    <button type="button" class="btn btn-ghost btn-sm" data-page-prev ${page <= 1 ? 'disabled' : ''}>&larr; Prev</button>
    <button type="button" class="btn btn-ghost btn-sm" data-page-next ${page >= totalPages ? 'disabled' : ''}>Next &rarr;</button>
  `;
  container.querySelector('[data-page-prev]').addEventListener('click', () => onChange(page - 1));
  container.querySelector('[data-page-next]').addEventListener('click', () => onChange(page + 1));
}

/* UserStatus is active|inactive|blocked|suspended (models_v2.py). The badge
   modifier classes live in super-admin.css. */
function saStatusBadge(status) {
  const label = String(status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<span class="badge ${saEscapeHtml(status)}">${saEscapeHtml(label)}</span>`;
}

/* One place to turn an axios failure into a human sentence. The 401 case is
   already handled by the interceptor below (refresh, then sign-out), so this
   only ever describes the errors a Super Admin can actually act on. */
function saErrorText(err, fallback) {
  const detail = err?.response?.data?.detail;
  if (Array.isArray(detail)) return detail[0]?.msg || fallback;
  return detail || fallback;
}
function saTableError(tbody, colspan, message) {
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-state">${saEscapeHtml(message)}</td></tr>`;
}

axios.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401) {
      const retried = await handlePortalUnauthorized('super_admin', err);
      if (retried) return retried;
      /* An expired or revoked session ends where Sign Out ends. A deliberate
         visit to /super-admin/ with no session still gets the card — and so
         does a rejected password (auth.js::isSessionEndingUnauthorized). */
      if (isSessionEndingUnauthorized(err)) {
        clearSuperAdminSession();
        redirectToPortalLogin();
      }
    }
    return Promise.reject(err);
  }
);

function showSuperAdminAuthShell() {
  document.getElementById('saAuthShell').style.display = 'flex';
  document.getElementById('saLayout').style.display = 'none';
}
function showSuperAdminPortal() {
  document.getElementById('saAuthShell').style.display = 'none';
  document.getElementById('saLayout').style.display = 'flex';
  const name = localStorage.getItem(SA_KEYS.fullName) || 'Super Admin';
  document.getElementById('saChipName').textContent = name;
  document.getElementById('saChipAvatar').textContent = (name.trim()[0] || 'S').toUpperCase();
  saNavigateToSection('dashboard');
}

const saSectionTitles = {
  dashboard: 'Dashboard',
  admin: 'Admin Management',
  roles: 'Role & Permission Management',
  reports: 'Global Reports & Analytics',
  audit: 'Audit Logs',
  settings: 'System Configuration',
  profile: 'Profile & Security',
};
const saLoadedSections = new Set();
function saNavigateToSection(name) {
  document.querySelectorAll('.nav-item[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  document.getElementById('saPageTitle').textContent = saSectionTitles[name] || name;
  document.querySelector('.layout').classList.remove('mobile-open');
  if (!saLoadedSections.has(name)) {
    saLoadedSections.add(name);
    saLoadSection(name);
  }
}
function saLoadSection(name) {
  const loaders = {
    dashboard: () => loadSaDashboard(),
    admin: () => loadSaAdmins(),
    roles: () => loadSaPermissions(),
    reports: () => loadSaReports(),
    audit: () => loadSaAuditLogs(),
    settings: () => loadSaSettings(),
    profile: () => loadSaProfile(),
  };
  return loaders[name]?.();
}
document.querySelectorAll('.nav-item[data-section]').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); saNavigateToSection(link.dataset.section); });
});

/* ---------- Mobile nav ---------- */
document.getElementById('saMobileMenuBtn')?.addEventListener('click', () => {
  document.querySelector('.layout').classList.add('mobile-open');
});
document.getElementById('saSidebarBackdrop')?.addEventListener('click', () => {
  document.querySelector('.layout').classList.remove('mobile-open');
});

/* ---------- Sign out ---------- */
const saSignOutModalOverlay = document.getElementById('saSignOutModalOverlay');
document.getElementById('saSignOutBtn').addEventListener('click', e => {
  e.preventDefault();
  saSignOutModalOverlay.classList.add('open');
});
document.getElementById('saCancelSignOutBtn').addEventListener('click', () => saSignOutModalOverlay.classList.remove('open'));
document.getElementById('saConfirmSignOutBtn').addEventListener('click', async () => {
  await logoutPortalSession('super_admin', { redirect: false });
  saLoadedSections.clear();
  saSignOutModalOverlay.classList.remove('open');
  redirectToPortalLogin();
});

/* Back after signing out must not restore this portal — auth.js. */
guardPortalSession(isSuperAdminLoggedIn);
