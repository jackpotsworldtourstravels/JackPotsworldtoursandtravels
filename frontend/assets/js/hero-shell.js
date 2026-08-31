'use strict';
/* ===========================================================================
   hero-shell.js — the landing page's header and footer, on a service page.
   ===========================================================================
   The Flights page is not a different site with a similar palette; it is the
   landing page with the results band swapped in under the hero. That means the
   SAME navigation bar, not a navy strip that happens to carry the same links —
   a traveller who clicks Search should not feel a page change at all.

   WHY THE MARKUP IS HERE AND NOT COPIED INTO flights.html
   Two hand-kept copies of a nav bar drift, and the whole illusion depends on
   them being identical. index.html still carries its own copy in static HTML
   on purpose: it is the marketing front door, and its nav links and hero
   heading should be in the document a crawler is served rather than assembled
   afterwards. So there are two, and only two, and this comment is in both:

       index.html            <header id="siteHeader"> ... </header>
       hero-shell.js         headerHtml()

   CHANGE ONE, CHANGE THE OTHER. The classes are main.css's, which both pages
   load, so a style change needs no edit here at all — only the link list, the
   logo and the account controls live in both places.

   AUTHENTICATION IS THE LANDING PAGE'S. The session is shared (auth.js, the
   `jpc_*` namespace), so somebody signed in on index.html is signed in here
   and this only reflects that. Signing IN still happens in the one modal on
   index.html; a second password -> OTP flow on every service page is four more
   things to keep correct.
   =========================================================================== */

const HeroShell = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

  /* The service words, in the order the landing page lists them. */
  const LINKS = [
    { href: 'index.html',      label: 'Home' },
    { href: 'flights.html',    label: 'Flights' },
    { href: 'hotels.html',     label: 'Hotels' },
    { href: 'cruises.html',    label: 'Cruises' },
    { href: 'packages.html',   label: 'Tour Packages' },
    { href: 'visa.html',       label: 'Visa' },
    { href: 'activities.html', label: 'Activities' },
    { href: 'index.html#contact', label: 'Contact' },
  ];

  const PARTNER_MARK = '<svg class="npm-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M11 17l2 2a1 1 0 1 0 3-3"/>'
    + '<path d="M14 14l2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81'
    + 'a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/>'
    + '<path d="M21 3l1 11h-2"/><path d="M3 3L2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg>';

  function navLinks(active) {
    return LINKS.map(l =>
      '<a href="' + l.href + '"'
      + (l.href === active ? ' aria-current="page"' : '')
      + '>' + esc(l.label) + '</a>').join('');
  }

  function headerHtml(active) {
    return '<nav class="wrap">'
      + '<a href="index.html" class="logo">'
      + '<img class="logo-mark-img" src="assets/images/jackpots-logo-full.png"'
      + ' alt="JackPots World Tours &amp; Travels"></a>'
      + '<div class="navlinks">' + navLinks(active) + '</div>'
      + '<div class="nav-actions">'
      + '<a href="partner-login.html" class="nav-partner-mark" id="navPartnerLink">'
      + PARTNER_MARK + '<span>My Partner</span></a>'
      + '<span id="shellAuth"></span>'
      + '<button class="hamburger" id="hamburgerBtn" aria-label="Toggle menu" aria-expanded="false">'
      + '<span></span><span></span><span></span></button>'
      + '</div></nav>'
      + '<div class="mobile-nav" id="mobileNav">' + navLinks(active)
      + '<div class="mobile-auth-links">'
      + '<a href="partner-login.html" class="mobile-partner-mark">' + PARTNER_MARK + 'My Partner</a>'
      + '<span id="shellAuthMobile"></span>'
      + '</div></div>';
  }

  /* ---------------------------------------------------------------------
     Footer — the landing page's, same caveat as the header above.
     --------------------------------------------------------------------- */
  const FOOT_ICONS = {
    phone: '<path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.12.81.35 1.6.68 2.34a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.74-1.25a2 2 0 012.11-.45c.74.33 1.53.56 2.34.68A2 2 0 0122 16.92z"/>',
    mail:  '<path d="M22 6l-10 7L2 6"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
    pin:   '<path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  };

  const footIcon = name =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
    + FOOT_ICONS[name] + '</svg>';

  const footCol = (head, links) =>
    '<div class="foot-col"><h5>' + esc(head) + '</h5>'
    + links.map(l => '<a href="' + l[1] + '">' + esc(l[0]) + '</a>').join('')
    + '</div>';

  function footerHtml() {
    return '<div class="wrap"><div class="foot-grid">'
      + '<div><div class="foot-logo">'
      + '<img class="foot-logo-img" src="assets/images/jackpots-logo-full.png"'
      + ' alt="JackPots World Tours &amp; Travels"></div>'
      + '<p>Flights, hotels, cruises and holiday packages — booked in one clean sweep,'
      + ' backed by support that actually picks up.</p></div>'
      + footCol('Company', [['About', '#'], ['Careers', '#'], ['Press', '#']])
      + footCol('Travel', [['Flights', 'flights.html'], ['Hotels', 'hotels.html'],
                           ['Cruises', 'cruises.html'], ['Tour Packages', 'packages.html'],
                           ['Visa', 'visa.html'], ['Activities', 'activities.html']])
      + footCol('Support', [['Help Center', '#'], ['Cancellation', '#'],
                            ['Refund', '#'], ['FAQs', '#']])
      + '<div class="foot-col"><h5>Contact</h5><ul class="foot-contact">'
      + '<li>' + footIcon('phone') + '<a href="tel:+911234567890">+91 12345 67890</a></li>'
      + '<li>' + footIcon('mail')
      + '<a href="mailto:info@jackpotsworldtours.com">info@jackpotsworldtours.com</a></li>'
      + '<li>' + footIcon('pin')
      + '<span>3rd Floor, Prestige Towers, Banjara Hills, Hyderabad, India 500034</span></li>'
      + '<li>' + footIcon('clock') + '<span>Mon-Sat, 9:00 AM - 8:00 PM IST</span></li>'
      + '</ul></div></div>'
      + '<div class="foot-bottom">'
      + '<span>&copy; ' + new Date().getFullYear()
      + ' JackPots World Tours &amp; Travels Pvt. Ltd.</span>'
      + '<span>Made for every route, every ticket type, every traveller.</span>'
      + '</div></div>';
  }

  /* ---------------------------------------------------------------------
     Account state — reflected, never changed here.
     --------------------------------------------------------------------- */
  function paintAuth() {
    const slot = document.getElementById('shellAuth');
    const mobile = document.getElementById('shellAuthMobile');
    if (!slot) return;

    /* THE CHIP AND ITS MENU ARE profile-menu.js's.
       This used to render "one chip, no dropdown" — the comment said so — so
       arriving on Flights from a search left the profile visible and every
       account destination behind it unreachable. The component renders the
       same chip and the same eight-item menu the landing page has, because it
       IS the landing page's. */
    if (typeof ProfileMenu !== 'undefined') {
      slot.setAttribute('data-profile-menu', '');
      ProfileMenu.mount(slot.parentNode || document);
    } else {
      slot.innerHTML = '<a href="index.html?signin=1" class="nav-login">Login</a>'
        + '<a href="index.html?signin=1" class="btn btn-coral nav-signup">Sign Up</a>';
    }

    /* The mobile drawer is this shell's own list, not a dropdown, so it stays
       here — but it is filled from the SAME item list, so the two cannot offer
       different destinations. */
    if (mobile) {
      const session = (typeof ProfileMenu !== 'undefined') ? ProfileMenu.session() : null;
      mobile.innerHTML = session && typeof ProfileMenu !== 'undefined'
        ? ProfileMenu.ITEMS.map(i =>
            `<a href="#" data-pm-tab="${esc(i.tab)}">${esc(i.label)}</a>`).join('')
        : '<a href="index.html?signin=1">Login</a><a href="index.html?signin=1">Sign Up</a>';
    }
  }

  /* wireAccountOpeners() bound the old chip and the old mobile links. Both
     are profile-menu.js's delegated handlers now. */

  /* ---------------------------------------------------------------------
     Scroll fade — THE ONE IMPLEMENTATION.

     main.css leaves the header at `background:rgba(0,0,0,0)` and expects a
     script to darken it; this is that script, and it is the only copy. It used
     to live at the top of app.js, which the Flights page does not load — which
     is exactly why that page's navbar stayed glass-clear over the results while
     the landing page's went black. Both pages call initBehaviour() now, so
     there is nothing left to keep in step.

     A LONG RANGE, NOT A THRESHOLD. 600px of scroll rather than a class toggled
     at 50px: the header sits over a video, and a hard switch to black reads as
     a flicker when a scroll stops near the trigger point. The alpha, the blur
     and the hairline all track the same 0..1 progress, so they cannot disagree
     about how far down the page is.
     --------------------------------------------------------------------- */
  const HEADER_FADE_RANGE = 600;

  function bindScrollFade() {
    const header = document.getElementById('siteHeader');
    if (!header) return;
    const paint = () => {
      const progress = Math.min(1, Math.max(0, window.scrollY / HEADER_FADE_RANGE));
      header.style.backgroundColor = 'rgba(0,0,0,' + progress.toFixed(3) + ')';
      header.style.backdropFilter = 'blur(' + (progress * 16).toFixed(1) + 'px)';
      header.style.boxShadow = progress > 0.05
        ? '0 1px 0 rgba(255,255,255,' + (progress * 0.08).toFixed(3) + ')'
        : 'none';
    };
    window.addEventListener('scroll', paint, { passive: true });
    /* Painted once immediately: a reload part-way down the page must not start
       transparent and then jump. */
    paint();
  }

  /* ---------------------------------------------------------------------
     Header behaviour that main.css expects a script to provide
     --------------------------------------------------------------------- */
  function bindHeader() {
    const burger = document.getElementById('hamburgerBtn');
    const nav = document.getElementById('mobileNav');
    if (burger && nav) {
      burger.addEventListener('click', () => {
        const open = nav.classList.toggle('open');
        burger.setAttribute('aria-expanded', String(open));
      });
      nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
        nav.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
      }));
    }

    /* A sign-out in another tab must not leave a stale chip here. */
    window.addEventListener('storage', e => {
      if (e.key && e.key.indexOf('jpc_') === 0) paintAuth();
    });
  }

  /* The hero's parallax, matching the landing page's. Skipped for reduced
     motion, which is the same condition main.css uses to stop its animations. */
  function bindParallax() {
    const bg = document.getElementById('heroBg');
    const layer = document.getElementById('heroVideoLayer');
    if (!bg || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    window.addEventListener('scroll', () => {
      const y = Math.min(window.scrollY, 800);
      const t = 'translateY(' + (y * 0.25) + 'px) scale(' + (1 + y * 0.0002) + ')';
      bg.style.transform = t;
      if (layer) layer.style.transform = t;
    }, { passive: true });
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  /** Everything the header DOES, for a page whose header markup already
   *  exists. index.html calls this on its static nav; mountHeader() calls it
   *  after building one. Neither page owns a second copy of any of it. */
  function initBehaviour() {
    bindScrollFade();
    bindHeader();
    bindParallax();
  }

  /** @param {string} [active] href of the page in the nav to mark current. */
  function mountHeader(active) {
    const header = document.getElementById('siteHeader');
    if (!header) return;
    header.innerHTML = headerHtml(active);
    paintAuth();
    initBehaviour();
    if (typeof JPIcon !== 'undefined') JPIcon.mount(header);
  }

  function mountFooter() {
    const foot = document.getElementById('siteFooter');
    if (foot) foot.innerHTML = footerHtml();
  }

  return { mountHeader, mountFooter, initBehaviour, paintAuth, headerHtml, footerHtml };
})();
