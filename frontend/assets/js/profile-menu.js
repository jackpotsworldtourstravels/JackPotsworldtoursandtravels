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
  /* `icon` is a jp-icons NAME. These were eight blocks of raw path data drawn
     at stroke 1.8 -- a fourth icon system, for the same eight destinations the
     Account Center's own tab strip already draws. Both read from a library
     now, so the menu entry and the tab it opens cannot show different marks. */
  const ITEMS = [
    { tab: 'profile',       label: 'My Profile',      icon: 'userRound' },
    { tab: 'bookings',      label: 'My Bookings',     icon: 'receipt' },
    { tab: 'wishlist',      label: 'Wishlist',        icon: 'heart' },
    { tab: 'payments',      label: 'Payment History', icon: 'creditCard' },
    { tab: 'notifications', label: 'Notifications',   icon: 'bell' },
    { tab: 'support',       label: 'Support Tickets', icon: 'circleHelp' },
    { tab: 'reviews',       label: 'Reviews',         icon: 'star' },
    { tab: 'settings',      label: 'Settings',        icon: 'settings' },
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

  const svg = name =>
    (typeof JPIcon !== 'undefined') ? JPIcon.html(name, { className: 'pm-icon' }) : '';

  /** The whole component, signed in or out. A page drops this in a slot and is
   *  finished; it never decides what the menu contains. */
  /** An ADMIN signed in on the shared `jwt_*` session. Not a customer — this
   *  menu is the B2C Account Center — but they should not be shown a Login
   *  button either. index.html used to relabel its static links to
   *  "Dashboard"/"Logout" for exactly this case; that markup is gone, so the
   *  one link that was actually useful is rendered here instead. */
  function adminSession() {
    const s = (typeof getStoredAuth === 'function') ? getStoredAuth() : null;
    return (s && s.access && s.role === 'admin') ? s : null;
  }

  function html() {
    const s = session();
    if (!s) {
      if (adminSession()) {
        return `<a class="pm-signup" href="admin/index.html">Dashboard</a>`;
      }
      /* IN PLACE WHERE THE MODAL EXISTS. The landing page carries the sign-in
         dialog, and its static Login/Sign Up links used to open it directly —
         `data-auth` in app.js. Those links are gone (they were the duplicate),
         so the behaviour moves here rather than being lost: on a page with the
         modal these open it, and only a page without one navigates. */
      const inPlace = typeof openAuth === 'function';
      const href = inPlace ? '#' : 'index.html?signin=1';
      const attr = inPlace ? ' data-pm-auth' : '';
      /* ONE DOOR, NOT TWO. Login and Sign Up both opened the same dialog,
         which has "Create an account" inside it — so the pair was one
         control drawn twice. It is a single link now, named for both. */
      return `<a class="pm-login" href="${href}"${attr}>
        <svg class="pm-login-user" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.8 4.2-5.7 7.5-5.7s6.3 1.9 7.5 5.7"/></svg>
        <span>Login / Create</span>
        <svg class="pm-login-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>`;
    }
    const name = s.name || 'Traveller';
    return `<div class="pm-wrap" data-pm>
      <button type="button" class="pm-chip" data-pm-toggle
              aria-expanded="false" aria-haspopup="true" aria-controls="pmMenu">
        <span class="pm-avatar" aria-hidden="true">${esc(initialsOf(name))}</span>
        <span class="pm-name">${esc(name)}</span>
        ${(typeof JPIcon !== 'undefined') ? JPIcon.html('chevronDown', { className: 'pm-caret' }) : ''}
      </button>
      <div class="pm-menu" id="pmMenu" role="menu" data-pm-menu aria-label="Account menu">
        ${ITEMS.map(i => `<button type="button" role="menuitem" class="pm-item"
            data-pm-tab="${esc(i.tab)}">${svg(i.icon)}<span>${esc(i.label)}</span></button>`).join('')}
        <hr class="pm-sep">
        <button type="button" role="menuitem" class="pm-item pm-logout" data-pm-logout>
          ${svg('logOut')}
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
    markSession();
  }

  /** Stamp the session on <html> so CSS can reach it.
   *
   *  THIS IS THE ONE PLACE THAT KNOWS. Every shell calls render() after it
   *  injects a header, and app.js calls it again on every session change
   *  (sign-in, sign-out, a token the server rejected), so a class set here
   *  cannot fall out of step with the chip beside it. The alternative — each
   *  page reading getCustomerSession() for itself — is the same question
   *  answered in five places.
   *
   *  What it is for: the landing page's My Bookings and Notifications icons.
   *  Both open the Account Center, which needs a signed-in traveller, so
   *  showing them to a visitor who has never logged in is two controls that
   *  can only answer "sign in first". home-ref.css hides them by DEFAULT and
   *  reveals them on `.jp-signed-in`, which is the way round that cannot
   *  flash them on screen before this runs. */
  function markSession() {
    const on = !!(session() || adminSession());
    const root = document.documentElement;
    root.classList.toggle('jp-signed-in', on);
    root.classList.toggle('jp-signed-out', !on);
    /* A CUSTOMER specifically — not an admin on the shared session. The B2C
       header drops "My Partner" on this (main.css): the partner portal is a
       B2B door, and a signed-in traveller has no use for it. Signed out, it
       stays exactly as it was. */
    root.classList.toggle('jp-customer', !!session());
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
      /* Login / Sign Up on a page that has the modal. */
      if (e.target.closest('[data-pm-auth]')) {
        e.preventDefault();
        if (typeof openAuth === 'function') openAuth();
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
