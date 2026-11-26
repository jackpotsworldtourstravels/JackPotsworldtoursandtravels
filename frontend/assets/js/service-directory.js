'use strict';
/* JackPots World service directory — one customer-facing service catalogue,
   driven by the backend service registry (GET /api/services).

   The registry (Admin ▸ Service Management) is the source of truth for which
   services the storefront shows, their order, and whether any is in
   maintenance. Disabling a service there removes it from this nav with no
   frontend deploy.

   RESILIENCE: the nav renders immediately from a built-in fallback list so it
   never blinks empty on a slow or failed request, then re-renders from the live
   registry once it arrives. A fetch failure simply leaves the fallback in
   place. Service discovery is navigation only; supplier readiness and the global
   on/off switch remain backend/admin concerns. */
(function () {
  // Fallback mirrors the seeded registry (migration 0102). Used only until the
  // live feed arrives, or if it cannot be reached.
  const FALLBACK = [
    { code: 'flights', name: 'Flights', href: '/flights', icon: 'flights' },
    { code: 'hotels', name: 'Hotels', href: '/hotels', icon: 'hotels' },
    { code: 'villas', name: 'Villas & Homestays', href: '/villas', icon: 'home' },
    { code: 'packages', name: 'Holiday Packages', href: '/packages', icon: 'packages' },
    { code: 'trains', name: 'Trains', href: '/trains', icon: 'trains' },
    { code: 'buses', name: 'Buses', href: '/buses', icon: 'buses' },
    { code: 'cabs', name: 'Cabs', href: '/cabs', icon: 'cabs' },
    { code: 'activities', name: 'Tours & Attractions', href: '/activities', icon: 'activities' },
    { code: 'visa', name: 'Visa', href: '/visa', icon: 'visa' },
    { code: 'forex', name: 'Forex Card & Currency', href: '/forex', icon: 'forex' },
    { code: 'insurance', name: 'Travel Insurance', href: '/insurance', icon: 'insurance' }
  ];

  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(host, services) {
    if (!host || !Array.isArray(services) || !services.length) return;
    const current = (location.pathname.replace(/\/$/, '') || '/').toLowerCase();
    host.innerHTML = '<div class="jw-service-directory__inner" role="list">' + services.map(svc => {
      const href = svc.href || ('/' + svc.code);
      const active = current === href.toLowerCase() || (href === '/packages' && current === '/gaming-packages');
      const glyph = window.JPIcon ? JPIcon.html(svc.icon || svc.code, { className: 'jw-service-directory__icon' }) : '';
      const maint = svc.maintenance_mode
        ? '<span class="jw-service-directory__badge" title="' + esc(svc.maintenance_message || 'Temporarily unavailable') + '">Maintenance</span>'
        : '';
      return '<a role="listitem" class="jw-service-directory__item' + (active ? ' is-active' : '') +
        (svc.maintenance_mode ? ' is-maintenance' : '') + '" href="' + esc(href) + '"' +
        (active ? ' aria-current="page"' : '') + '>' + glyph + '<span>' + esc(svc.name) + '</span>' + maint + '</a>';
    }).join('') + '</div>';
    if (window.JPIcon) JPIcon.mount(host);
  }

  function mount() {
    const host = document.getElementById('jwServiceDirectory');
    if (!host) return;
    // 1) Instant paint from the fallback so the nav is never empty.
    render(host, FALLBACK);
    // 2) Upgrade to the live registry. A failure keeps the fallback silently.
    fetch('/api/services', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(list => { if (Array.isArray(list) && list.length) render(host, list); })
      .catch(() => { /* keep fallback */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
