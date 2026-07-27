'use strict';
/* Super Admin Portal — shared helpers. Separate localStorage namespace
   (super_admin_jwt_*) so a Super Admin session can never collide with a
   customer/admin session or a partner session open in the same browser —
   same reasoning as partner-shared.js's PARTNER_KEYS. */

const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

/* SA_KEYS, saAuthHeaders(), isSuperAdminLoggedIn(), storeSuperAdminSession(),
   clearSuperAdminSession() now live in assets/js/auth.js, loaded before this file. */

/* Thin aliases onto shared/formatters.js's canonical escapeHtml/fmtDate,
   kept under their sa-prefixed names since every super-admin-*.js file
   already calls them that way. */
function saEscapeHtml(str) { return escapeHtml(str); }
function saFmtDate(s) { return fmtDate(s); }

axios.interceptors.response.use(
  res => res,
  err => {
    const url = err.config?.url || '';
    if (err.response?.status === 401 && url.includes('/api/super-admin')) {
      clearSuperAdminSession();
      showSuperAdminAuthShell();
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

const saSectionTitles = { dashboard: 'Dashboard', admin: 'Admin Management', profile: 'Profile' };
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
  const loaders = { dashboard: () => loadSaDashboard(), admin: () => loadSaAdmins(), profile: () => loadSaProfile() };
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
  try { await axios.post(`${API_BASE}/api/super-admin/auth/logout`, {}, { headers: saAuthHeaders() }); } catch (err) { /* ignore */ }
  clearSuperAdminSession();
  saLoadedSections.clear();
  saSignOutModalOverlay.classList.remove('open');
  showSuperAdminAuthShell();
});
