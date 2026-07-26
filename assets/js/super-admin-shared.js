'use strict';
/* Super Admin Portal — shared helpers. Separate localStorage namespace
   (super_admin_jwt_*) so a Super Admin session can never collide with a
   customer/admin session or a partner session open in the same browser —
   same reasoning as partner-shared.js's PARTNER_KEYS. */

const SA_API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

const SA_KEYS = { access: 'super_admin_jwt_access', refresh: 'super_admin_jwt_refresh', fullName: 'super_admin_full_name' };

function saAuthHeaders() { return { Authorization: `Bearer ${localStorage.getItem(SA_KEYS.access)}` }; }
function isSuperAdminLoggedIn() { return !!localStorage.getItem(SA_KEYS.access); }
function storeSuperAdminSession(data) {
  localStorage.setItem(SA_KEYS.access, data.access_token);
  localStorage.setItem(SA_KEYS.refresh, data.refresh_token);
  if (data.full_name) localStorage.setItem(SA_KEYS.fullName, data.full_name);
}
function clearSuperAdminSession() { Object.values(SA_KEYS).forEach(k => localStorage.removeItem(k)); }

function saEscapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function saFmtDate(s) { return s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }

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
  try { await axios.post(`${SA_API_BASE}/api/super-admin/auth/logout`, {}, { headers: saAuthHeaders() }); } catch (err) { /* ignore */ }
  clearSuperAdminSession();
  saLoadedSections.clear();
  saSignOutModalOverlay.classList.remove('open');
  showSuperAdminAuthShell();
});
