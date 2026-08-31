'use strict';
/* ===========================================================================
   service-shell.js — one header, one footer, shared by every service page.
   ===========================================================================
   The markup is built here rather than copy-pasted into four HTML files so a
   nav change is one edit. Each page only declares which service it is:

     <body data-sp-service="flights">

   AUTHENTICATION IS THE LANDING PAGE'S, NOT A SECOND ONE. The session lives in
   the shared `jpc_*` namespace (auth.js), so a customer who signed in on
   index.html is already signed in here — this file only reflects that state.
   Signing IN still happens in the one modal on index.html; duplicating a
   password -> OTP flow onto four more pages would be four more things to keep
   correct.

   WHY NOT index.html#login: app.js's handleOperationsSignInHandoff() claims the
   `#login` hash and forwards it to partner-login.html — a traveller sent there
   lands on the MERCHANT sign-in. `?signin=1` is used instead, which app.js
   reads on load.
   =========================================================================== */

const ServiceShell = (function () {

  /* `icon` is a name in the jp-icons family, not a glyph. It used to hold an
     emoji, which rendered as a different picture on every OS and read as a chat
     message rather than a travel brand. */
  const SERVICES = [
    { id: 'flights',    label: 'Flights',       href: 'flights.html',    icon: 'flights' },
    { id: 'hotels',     label: 'Hotels',        href: 'hotels.html',     icon: 'hotels' },
    { id: 'cruises',    label: 'Cruises',       href: 'cruises.html',    icon: 'cruises' },
    { id: 'packages',   label: 'Tour Packages', href: 'packages.html',   icon: 'packages' },
    { id: 'visa',       label: 'Visa',          href: 'visa.html',       icon: 'visa' },
    { id: 'activities', label: 'Activities',    href: 'activities.html', icon: 'activities' },
  ];

  const THEME_KEY = 'jpc_theme';

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

  /* ---------------------------------------------------------------------
     Theme. Stored choice wins over the OS; no choice means follow the OS,
     which the CSS already does on its own.
     --------------------------------------------------------------------- */
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  }
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
  }
  function effectiveTheme() {
    const s = storedTheme();
    if (s) return s;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    applyTheme(next);
    paintThemeButton();
  }
  function paintThemeButton() {
    const btn = document.getElementById('spTheme');
    if (!btn) return;
    const dark = effectiveTheme() === 'dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.innerHTML = dark
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
  }
  /* Applied before first paint by an inline snippet in each page; this repeats
     it for safety if the snippet is ever dropped. */
  applyTheme(storedTheme());

  /* ---------------------------------------------------------------------
     Markup
     --------------------------------------------------------------------- */
  /** An icon for a service. Falls back to nothing if jp-icons.js is absent —
   *  the label carries the meaning, so a missing library must not leave a
   *  broken glyph in the nav. */
  function icon(name) {
    return (typeof JPIcon !== 'undefined') ? JPIcon.html(name, { size: 'sm' }) : '';
  }

  function headerHtml(active) {
    /* data-jpi-hover puts the animation on the whole link, so pointing at the
       word plays the icon — hovering a 14px glyph exactly is not a target
       anyone should have to hit. */
    const links = SERVICES.map(s =>
      `<a href="${s.href}" data-jpi-hover${s.id === active ? ' aria-current="page"' : ''}>`
      + `${icon(s.icon)}<span>${esc(s.label)}</span></a>`).join('');
    return `
    <div class="sp-wrap sp-nav">
      <a class="sp-logo" href="index.html" aria-label="JackPots World Tours &amp; Travels — home">
        <img src="assets/images/jackpots-logo-full.png" alt="JackPots World Tours &amp; Travels">
      </a>
      <nav class="sp-links" id="spLinks" aria-label="Services">
        <a href="index.html">Home</a>${links}
      </nav>
      <div class="sp-actions">
        <!-- Not a service, so it sits with the account controls rather than in
             the services nav. Always visible: a demo booking made signed-out
             still needs somewhere to be found. -->
        <a class="sp-bookings" href="my-bookings.html"${active === 'bookings' ? ' aria-current="page"' : ''}>
          ${icon('activities')}<span>My Bookings</span>
        </a>
        <button type="button" class="sp-icon-btn" id="spTheme"></button>
        <a class="sp-partner" href="partner-login.html">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 17l2 2a1 1 0 1 0 3-3"/><path d="M14 14l2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="M21 3l1 11h-2"/><path d="M3 3L2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg>
          <span>My Partner</span>
        </a>
        <span id="spAuth"></span>
        <button type="button" class="sp-icon-btn sp-burger" id="spBurger" aria-label="Menu" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </button>
      </div>
    </div>`;
  }

  function footerHtml() {
    return `<div class="sp-wrap sp-footer-row">
      <span>&copy; ${new Date().getFullYear()} JackPots World Tours &amp; Travels</span>
      <span class="sp-footer-links">
        ${SERVICES.map(s => `<a href="${s.href}">${esc(s.label)}</a>`).join('')}
        <a href="index.html#contact">Contact</a>
      </span>
    </div>`;
  }

  /* ---------------------------------------------------------------------
     Auth display
     --------------------------------------------------------------------- */
  /** The header's auth corner.
   *
   *  It used to render an `sp-chip` here that opened the Account Center
   *  straight on the profile tab — no menu, so the seven other destinations the
   *  landing page offered simply did not exist after a search. profile-menu.js
   *  renders the chip AND the dropdown now, identically on every page, and this
   *  shell only says where it goes. */
  function renderAuth() {
    const slot = document.getElementById('spAuth');
    if (!slot) return;
    if (typeof ProfileMenu === 'undefined') {
      /* A page that has not adopted the component still gets a way in. */
      slot.innerHTML = `<a class="sp-login" href="index.html?signin=1">Login</a>`;
      return;
    }
    slot.setAttribute('data-profile-menu', '');
    ProfileMenu.mount(slot.parentNode || document);
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  function init() {
    const active = document.body.dataset.spService || '';
    const header = document.getElementById('spHeader');
    const footer = document.getElementById('spFooter');
    if (header) header.innerHTML = headerHtml(active);
    if (footer) footer.innerHTML = footerHtml();

    /* jp-icons.js mounts on DOMContentLoaded, and it loads BEFORE this file —
       so the header did not exist yet when it ran. Anything rendered here has
       to be armed explicitly or its icons never animate. */
    if (typeof JPIcon !== 'undefined') JPIcon.mount(document);

    paintThemeButton();
    renderAuth();

    const themeBtn = document.getElementById('spTheme');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    const burger = document.getElementById('spBurger');
    if (burger) {
      burger.addEventListener('click', () => {
        const open = document.getElementById('spLinks').classList.toggle('sp-open');
        burger.setAttribute('aria-expanded', String(open));
      });
    }

    /* Follow the OS while no explicit choice is stored. */
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!storedTheme()) paintThemeButton();
    });

    /* A sign-out in another tab must not leave a stale chip here. */
    window.addEventListener('storage', e => {
      if (e.key && e.key.startsWith('jpc_')) renderAuth();
    });
  }

  return { init, SERVICES, toggleTheme, effectiveTheme };
})();

document.addEventListener('DOMContentLoaded', ServiceShell.init);
if (document.readyState !== 'loading') ServiceShell.init();
