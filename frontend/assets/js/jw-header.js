'use strict';
/* ===========================================================================
   jw-header.js — THE site header. One definition, every page.
   ===========================================================================
   There used to be three: index.html's static nav, hero-shell.js's built
   nav for the product pages, and service-shell.js's different, text-only
   nav for the content pages. Three looks and three code paths for one
   brand. Now:

     JWHeader.html(active)   the markup. hero-shell.js and service-shell.js
                             both render it; index.html carries a static copy
                             of the same output so a crawler reads its links
                             (CHANGE THIS, CHANGE index.html).
     JWHeader.bind(el)       the behaviour: its three states, the sliding
                             indicator and the mobile drawer.

   THREE STATES, chosen by the page, animated between by CSS (jw-system.css,
   "chrome"):
     over     transparent over a photograph hero (the page has .cine-hero,
              .ds-hero or the product film #heroBg at its top)
     solid    dark navy, on every other page
     compact  smaller dark glass, once the page has scrolled past 40px

   WHAT THE OLDER CODE STILL DOES, UNCHANGED, because the markup keeps its
   hooks: hero-shell's product links switch the homepage search card's tab
   (`.navlinks a` hrefs), mark aria-current on the product the card shows,
   and open the Account Center from `[data-nav-acct]`; profile-menu.js mounts
   the account chip into `.pm-slot[data-profile-menu]` (#shellAuth).

   NOT HERE, deliberately:
     * a currency switcher — there is no conversion behind one, and a control
       that changes nothing is worse than no control;
     * the content pages' light/dark toggle — the brand has one look.
   =========================================================================== */
const JWHeader = (function () {
  /* THE FOUR PRODUCTS THE BOOKING CARD SEARCHES, THEN CONTACT. Cruises and
     Destinations left the bar; their pages, routes and data are untouched and
     the footer still links both. On the landing page hero-shell.js turns the
     four product links into tab switches on the search card and Contact into
     a scroll to the "Get in touch" form (#contact); everywhere else they are
     plain links, so each one still works with no script at all. */
  const PRIMARY = [
    { href: 'flights.html',         label: 'Flights' },
    { href: 'hotels.html',          label: 'Hotels' },
    { href: 'packages.html',        label: 'Tour Packages' },
    { href: 'gaming-packages.html', label: 'Gaming Tour Packages' },
    { href: 'index.html#contact',   label: 'Contact' },
  ];
  /* The drawer's second list: account doors that are not in the bar. The
     partner link carries .jw-hdr__partner-link so it hides with the bar's
     Partners button once anybody is signed in (jw-system.css). */
  const SECONDARY = [
    { href: 'my-bookings.html',     label: 'My trips' },
    { href: 'partner-login.html',   label: 'Partner sign in', cls: 'jw-hdr__partner-link' },
  ];

  const I = {
    heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
    trips: '<path d="M4 7h16v12H4z"/><path d="M9 7V5h6v2M4 12h16"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    partner: '<path d="M11 17l2 2a1 1 0 1 0 3-3"/><path d="M14 14l2.5 2.5a1 1 0 1 0 3-3l-3.9-3.9a3 3 0 0 0-4.2 0l-.9.9a1 1 0 1 1-3-3l2.8-2.8a5.8 5.8 0 0 1 7.1-.8l.5.3a2 2 0 0 0 1.4.3L21 4"/><path d="M21 3l1 11h-2M3 3L2 14l6.5 6.5a1 1 0 1 0 3-3M3 4h8"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  };
  const svg = (name, cls) => '<svg class="' + (cls || 'jw-hdr__svg') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + I[name] + '</svg>';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** The header's inner markup. `active` is the href of the current page. */
  function html(active) {
    const cur = h => h === active ? ' aria-current="page"' : '';
    const bar = PRIMARY.map(l => '<a href="' + l.href + '"' + cur(l.href) + '><span>' + esc(l.label) + '</span></a>').join('');
    const big = PRIMARY.map((l, i) => '<a class="jw-drawer__big" href="' + l.href + '"' + cur(l.href) + '>'
      + '<i>' + String(i + 1).padStart(2, '0') + '</i><span>' + esc(l.label) + '</span>' + svg('arrow', 'jw-drawer__arrow') + '</a>').join('');
    const small = SECONDARY.map(l => '<a' + (l.cls ? ' class="' + l.cls + '"' : '') + ' href="' + l.href + '"' + cur(l.href) + '>' + esc(l.label) + '</a>').join('');
    return ''
      + '<div class="jw-hdr__bar">'
      +   '<a class="jw-hdr__logo" href="index.html" aria-label="JackPots World Tours &amp; Travels, home">'
      +     '<img class="jw-hdr__mark" src="assets/images/jackpots-logo-full.png" alt="JackPots World Tours &amp; Travels" width="152" height="150">'
      +   '</a>'
      +   '<nav class="jw-hdr__nav navlinks" aria-label="Primary">' + bar + '<span class="jw-hdr__ind" aria-hidden="true"></span></nav>'
      +   '<div class="jw-hdr__actions">'
      +     '<button type="button" class="jw-hdr__icon" data-nav-acct="wishlist" aria-label="Wishlist" data-ds-tip="Wishlist">' + svg('heart') + '</button>'
      +     '<button type="button" class="jw-hdr__icon jw-hdr__acct" data-nav-acct="bookings" aria-label="My trips" data-ds-tip="My trips">' + svg('trips') + '</button>'
      +     '<button type="button" class="jw-hdr__icon jw-hdr__acct" data-nav-acct="notifications" aria-label="Notifications" data-ds-tip="Notifications">' + svg('bell') + '</button>'
      +     '<a class="jw-hdr__partner" href="partner-login.html">' + svg('partner') + '<span>Partners</span></a>'
      +     '<div class="pm-slot" id="shellAuth" data-profile-menu></div>'
      +     '<button type="button" class="jw-hdr__burger" aria-label="Open menu" aria-expanded="false" aria-controls="jwDrawer"><span></span><span></span></button>'
      +   '</div>'
      + '</div>'
      + '<div class="jw-drawer" id="jwDrawer" role="dialog" aria-modal="true" aria-label="Menu" hidden>'
      +   '<div class="jw-drawer__top">'
      +     '<a class="jw-hdr__logo" href="index.html" aria-label="JackPots World Tours &amp; Travels, home"><img class="jw-hdr__mark" src="assets/images/jackpots-logo-full.png" alt="" width="152" height="150"></a>'
      +     '<button type="button" class="jw-drawer__close" aria-label="Close menu">' + svg('close') + '</button>'
      +   '</div>'
      +   '<nav class="jw-drawer__nav" aria-label="Menu">' + big + '</nav>'
      +   '<div class="jw-drawer__more">' + small + '</div>'
      +   '<div class="jw-drawer__foot"><a href="tel:+919177847799">+91 91778 47799</a><a href="mailto:support@jackpotsworldtours.com">support@jackpotsworldtours.com</a></div>'
      + '</div>';
  }

  /** Mount into `el` (a <header>), then bind. */
  function mount(el, active) {
    if (!el) return null;
    el.innerHTML = html(active);
    return bind(el);
  }

  /** Behaviour for a header whose markup is html()'s output. Idempotent. */
  function bind(el) {
    if (!el || el.dataset.jwHdr) return el;
    el.dataset.jwHdr = '1';
    el.classList.add('jw-hdr');
    const root = document.documentElement;
    root.classList.add('has-jw-hdr');

    /* --- which state the top of this page asks for --------------------- */
    const heroAtTop = () => {
      const h = document.querySelector('.cine-hero, .ds-hero, #heroBg, .jw-hero-over');
      return !!h && h.getBoundingClientRect().top < 140;
    };
    const over = heroAtTop();
    el.classList.toggle('is-over', over);
    el.classList.toggle('is-solid', false);
    el.classList.toggle('jw-hdr--solid', !over);
    root.classList.toggle('jw-hdr-solid-page', !over);

    /* --- compact on scroll: one passive listener, painted per frame ------ */
    let ticking = false;
    const paint = () => {
      ticking = false;
      el.classList.toggle('is-compact', window.scrollY > 40);
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(paint); } }, { passive: true });
    paint();

    /* --- the indicator: rests under the current page (or the product the
           search card is showing), glides to the pointer ------------------ */
    const nav = el.querySelector('.jw-hdr__nav'), ind = el.querySelector('.jw-hdr__ind');
    if (nav && ind) {
      let hovering = false;
      const to = a => {
        const w = Math.max(18, Math.min(34, a.offsetWidth * 0.42));
        ind.style.width = w + 'px';
        ind.style.transform = 'translateX(' + (a.offsetLeft + a.offsetWidth / 2 - w / 2) + 'px)';
        ind.classList.add('is-on');
      };
      const rest = () => {
        const c = nav.querySelector('a[aria-current="page"]');
        if (c) to(c); else ind.classList.remove('is-on');
      };
      nav.querySelectorAll('a').forEach(a => {
        a.addEventListener('mouseenter', () => { hovering = true; to(a); });
        a.addEventListener('focus', () => to(a));
      });
      nav.addEventListener('mouseleave', () => { hovering = false; rest(); });
      nav.addEventListener('focusout', e => { if (!nav.contains(e.relatedTarget)) rest(); });
      new MutationObserver(() => { if (!hovering) rest(); }).observe(nav, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
      window.addEventListener('resize', rest);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(rest);
      rest();
    }

    /* --- the drawer ------------------------------------------------------ */
    const drawer = el.querySelector('.jw-drawer'), burger = el.querySelector('.jw-hdr__burger');
    if (drawer && burger) {
      /* OUT OF THE HEADER, into <body>. The compact header wears a
         backdrop-filter, and that makes it the containing block for any
         position:fixed descendant — a full-screen drawer inside it would be
         clipped to a 64px strip. */
      document.body.appendChild(drawer);
      const closeBtn = drawer.querySelector('.jw-drawer__close');
      let release = null;
      const open = () => {
        drawer.hidden = false;
        requestAnimationFrame(() => requestAnimationFrame(() => drawer.classList.add('is-open')));
        burger.setAttribute('aria-expanded', 'true');
        root.classList.add('ds-locked');
        release = typeof window.trapFocus === 'function' ? window.trapFocus(drawer) : null;
        if (!release) setTimeout(() => closeBtn && closeBtn.focus(), 80);
      };
      const close = () => {
        if (drawer.hidden) return;
        drawer.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
        root.classList.remove('ds-locked');
        if (release) release(); else burger.focus();
        release = null;
        setTimeout(() => { if (!drawer.classList.contains('is-open')) drawer.hidden = true; }, 520);
      };
      burger.addEventListener('click', open);
      if (closeBtn) closeBtn.addEventListener('click', close);
      drawer.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
      /* A link in the drawer navigates — or, on the homepage, switches the
         search card (hero-shell) — either way the drawer is done. */
      drawer.addEventListener('click', e => { if (e.target.closest('a')) close(); });
      window.addEventListener('resize', () => { if (window.innerWidth > 1024) close(); });
    }
    return el;
  }

  return { html, mount, bind, PRIMARY, SECONDARY };
})();
