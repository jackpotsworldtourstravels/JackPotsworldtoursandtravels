'use strict';
/* ===========================================================================
   profile-menu.js — the signed-in profile chip and its dropdown. One copy.
   ===========================================================================
   WHY THIS EXISTS. There were three:

     index.html      chip + the full dropdown, markup inline in the page and
                     wired in account-center.js
     hero-shell.js   chip, and the comment "One chip, no dropdown" — clicking
                     it jumped straight into the Account Center
     service-shell.js  `sp-chip`, same jump, no menu at all

   So the eight account destinations existed on the landing page and nowhere
   else: after a search the profile was still there, and the menu behind it was
   not. Three renderers, two of them missing the feature, and any change to the
   menu had to be made in all three or it drifted.

   This is the one component. The shells ask for markup and know nothing about
   what is in it; adding an item here adds it everywhere.

   DELEGATED, NOT CAPTURED — and that is load-bearing, not a style preference.
   The header is injected by a shell AFTER these scripts parse, so anything
   that did `getElementById('profileChipBtn')` at parse time bound to null and
   silently did nothing. That is precisely how the landing page's own dropdown
   wiring behaved on every other page. Every listener here is on `document` and
   matches by attribute, so it works no matter when the markup arrives, and
   keeps working when a shell re-renders its header.

   The Login/Sign Up state is rendered here too, so a page never has to decide
   for itself what "signed out" looks like.
   =========================================================================== */

const ProfileMenu = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? ''))
    : String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));

  /* The menu. Every entry is an Account Center tab, so the list is also the
     answer to "what can this account do" — one place to add the next one. */
  const ITEMS = [
    { tab: 'profile',       label: 'My Profile',      icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>' },
    { tab: 'bookings',      label: 'My Bookings',     icon: '<path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2Z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/>' },
    { tab: 'wishlist',      label: 'Wishlist',        icon: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>' },
    { tab: 'payments',      label: 'Payment History', icon: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><line x1="2" y1="10" x2="22" y2="10"/>' },
    { tab: 'notifications', label: 'Notifications',   icon: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>' },
    { tab: 'support',       label: 'Support Tickets', icon: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.4V14"/><line x1="12" y1="17" x2="12" y2="17"/>' },
    { tab: 'reviews',       label: 'Reviews',         icon: '<path d="m12 2 3.1 6.6 7.2.8-5.4 4.9 1.5 7.1L12 17.8 5.6 21.4l1.5-7.1-5.4-4.9 7.2-.8Z"/>' },
    { tab: 'settings',      label: 'Settings',        icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
  ];

  /** The signed-in traveller, whichever namespace holds them.
   *
   *  auth.js keeps the customer session under `jpc_*` (getCustomerAuth) and the
   *  older shared customer/admin session under `jwt_*` (getStoredAuth). The
   *  landing page reads one and the shells read the other, which is its own
   *  small inconsistency; asking both here means the chip cannot disagree with
   *  itself from one page to the next. An ADMIN session is deliberately not a
   *  match — this menu is the customer Account Center, and an admin has their
   *  own portal. */
  function session() {
    if (typeof getCustomerSession === 'function') {
      const s = getCustomerSession();
      return s && s.access ? s : null;
    }
    /* auth.js not loaded, or an older copy of it. */
    const c = (typeof getCustomerAuth === 'function') ? getCustomerAuth() : null;
    if (c && c.access) return c;
    const s = (typeof getStoredAuth === 'function') ? getStoredAuth() : null;
    return (s && s.access && s.role !== 'admin') ? s : null;
  }

  const initialsOf = name => (String(name || '').trim().split(/\s+/)
    .map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'U');

  const svg = body =>
    `<svg class="pm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  /** The whole component, signed in or out. A page drops this in a slot and is
   *  finished; it never decides what the menu contains. */
  function html() {
    const s = session();
    if (!s) {
      return `<a class="pm-login" href="index.html?signin=1">Login</a>
        <a class="pm-signup" href="index.html?signin=1">Sign Up</a>`;
    }
    const name = s.name || 'Traveller';
    return `<div class="pm-wrap" data-pm>
      <button type="button" class="pm-chip" data-pm-toggle
              aria-expanded="false" aria-haspopup="true" aria-controls="pmMenu">
        <span class="pm-avatar" aria-hidden="true">${esc(initialsOf(name))}</span>
        <span class="pm-name">${esc(name)}</span>
        <svg class="pm-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="pm-menu" id="pmMenu" role="menu" data-pm-menu aria-label="Account menu">
        ${ITEMS.map(i => `<button type="button" role="menuitem" class="pm-item"
            data-pm-tab="${esc(i.tab)}">${svg(i.icon)}<span>${esc(i.label)}</span></button>`).join('')}
        <hr class="pm-sep">
        <button type="button" role="menuitem" class="pm-item pm-logout" data-pm-logout>
          ${svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>')}
          <span>Logout</span>
        </button>
      </div>
    </div>`;
  }

  /** Fill every slot on the page. Called by the shells after they inject a
   *  header, and again whenever the session changes. */
  function render(scope) {
    (scope || document).querySelectorAll('[data-profile-menu]').forEach(slot => {
      slot.innerHTML = html();
    });
  }

  /* ------------------------------------------------------------------ open */
  const menusOpen = () => [...document.querySelectorAll('[data-pm].is-open')];

  function close(wrap, returnFocus) {
    (wrap ? [wrap] : menusOpen()).forEach(w => {
      w.classList.remove('is-open');
      const btn = w.querySelector('[data-pm-toggle]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      if (returnFocus && btn) btn.focus();
    });
  }

  function open(wrap) {
    /* Only ever one. Two headers on a page is not a case worth supporting, but
       two OPEN menus is a bug worth making impossible. */
    menusOpen().forEach(w => { if (w !== wrap) close(w); });
    wrap.classList.add('is-open');
    const btn = wrap.querySelector('[data-pm-toggle]');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  const items = wrap => [...wrap.querySelectorAll('[data-pm-tab], [data-pm-logout]')];

  /** Where a menu item goes.
   *
   *  In place when account-center.js is on the page, which is every page that
   *  loads this one — that is the whole reason the chip stopped navigating:
   *  opening your profile mid-booking used to throw the booking away. The
   *  navigation is kept only as the answer for a page that has not adopted it,
   *  so the item is never a control that does nothing. */
  function go(tab) {
    close();
    if (typeof AccountCenter !== 'undefined' && AccountCenter.open) {
      AccountCenter.open(tab);
      return;
    }
    window.location.href = `index.html?account=${encodeURIComponent(tab)}`;
  }

  function logout() {
    close();
    /* account-center.js owns what signing out MEANS — the API call, clearing
       the session, resetting the wishlist and the Account Center's own state.
       Calling it beats a second version of that here which would drift. */
    if (typeof AccountCenter !== 'undefined' && AccountCenter.logout) {
      AccountCenter.logout();
    } else {
      if (typeof clearCustomerAuth === 'function') clearCustomerAuth();
      if (typeof clearStoredAuth === 'function') clearStoredAuth();
    }
    render();
  }

  /* ---------------------------------------------------------------- events */
  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;

    document.addEventListener('click', e => {
      const toggle = e.target.closest('[data-pm-toggle]');
      if (toggle) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = toggle.closest('[data-pm]');
        wrap.classList.contains('is-open') ? close(wrap) : open(wrap);
        return;
      }
      const tab = e.target.closest('[data-pm-tab]');
      if (tab) { e.preventDefault(); go(tab.dataset.pmTab); return; }
      if (e.target.closest('[data-pm-logout]')) { e.preventDefault(); logout(); return; }

      /* Anywhere else — including inside another header — closes it. */
      if (!e.target.closest('[data-pm-menu]')) close();
    });

    document.addEventListener('keydown', e => {
      const wrap = menusOpen()[0];
      if (!wrap) return;

      if (e.key === 'Escape') { e.preventDefault(); close(wrap, true); return; }

      /* Arrow keys walk the menu, which is what role="menu" promises. Tab is
         left alone deliberately: it should move on out of the menu and into
         the page, and trapping it in a dropdown is a menu you cannot leave. */
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const list = items(wrap);
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement);
      let next;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = list.length - 1;
      else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length;
      else next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
      list[next].focus();
    });

    /* Signing in or out in ANOTHER tab changes what this header should show. */
    window.addEventListener('storage', e => {
      if (!e.key || /^(jpc_|jwt_)/.test(e.key)) render();
    });
  }

  return {
    ITEMS,
    html,
    session,
    /** Render every slot and make sure the listeners exist. Idempotent, so a
     *  shell may call it on every header re-render. */
    mount(scope) { wire(); render(scope); },
    render(scope) { wire(); render(scope); },
    close: () => close(),
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProfileMenu;
