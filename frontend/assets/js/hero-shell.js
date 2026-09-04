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
  /* Cruises, Visa and Activities are no longer advertised in the header. The
     PAGES still exist and still work — this is the nav list only, so a link
     held elsewhere, a bookmark or the footer still reaches them. */
  const LINKS = [
    { href: 'index.html',      label: 'Home' },
    { href: 'flights.html',    label: 'Flights' },
    { href: 'hotels.html',     label: 'Hotels' },
    { href: 'packages.html',   label: 'Tour Packages' },
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
      /* My Bookings and Notifications. Not a second copy of the profile menu's
         entries — the same two destinations, reached as icons for the two
         things a traveller checks mid-journey without wanting the whole
         account panel. Both open the Account Center on that tab. */
      + '<button type="button" class="nav-icon-btn" data-nav-acct="bookings" title="My Bookings" aria-label="My Bookings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2Z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/></svg></button>'
      + '<button type="button" class="nav-icon-btn" data-nav-acct="notifications" title="Notifications" aria-label="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></button>'
      /* THE SAME ELEMENT index.html USES, not a wrapper around it.
         This was a <span id="shellAuth"> that booking-card.css then had to
         flatten with display:contents so the two Login/Sign Up controls would
         pick up .nav-actions' 14px gap. They did — and the flattened row came
         out 9px wider than the landing page's .pm-slot div, which pushed the
         whole nav 5px sideways between Home and every other page. One element,
         one width, no bridge. */
      + '<div class="pm-slot" id="shellAuth" data-profile-menu></div>'
      + '<button class="hamburger" id="hamburgerBtn" aria-label="Toggle menu" aria-expanded="false">'
      + '<span></span><span></span><span></span></button>'
      + '</div></nav>'
      /* NO AUTH CONTROLS IN THE DRAWER. It used to carry its own Login/Sign Up
         and, signed in, its own account list — a second set of the controls
         .nav-actions already shows at every width, kept in step by hand. The
         header's chip is avatar-only under 560px and reachable on a phone, so
         the drawer is the page LINKS and the account is the header. */
      + '<div class="mobile-nav" id="mobileNav">' + navLinks(active)
      + '<a href="partner-login.html" class="mobile-partner-mark">' + PARTNER_MARK + 'My Partner</a>'
      + '</div>';
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
      /* Cruises, Visa and Activities are gone from here too. The header list
         above dropped them first; leaving them in the footer meant they still
         appeared on every page, which is not what "removed from the
         navigation" means. The pages are still served at their own URLs. */
      + footCol('Travel', [['Flights', 'flights.html'], ['Hotels', 'hotels.html'],
                           ['Tour Packages', 'packages.html']])
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

  /* =====================================================================
     THE HERO — one implementation, consumed by every page under the nav.
     =====================================================================
     Flights, Hotels and Tour Packages are not pages that resemble the landing
     page; they ARE the landing page with a different band under the hero. So
     they get this markup, not a navy banner carrying the same words: same
     film, same overlay, same spacing, same place for the search card. The
     only thing a page chooses is which product's card sits in the dock.

     THE SAME TWO-COPY RULE THE HEADER HAS, for the same reason:

         index.html      <section class="hero" id="home"> ... </section>
         hero-shell.js   heroHtml()

     index.html keeps its copy in static HTML because it is the marketing
     front door and its <h1> should be in the document a crawler is served.
     CHANGE ONE, CHANGE THE OTHER — and nothing else has a copy.

     WHICH CLIP PLAYS IS THE CARD'S DECISION, NOT THIS FILE'S. All four are
     declared here in the order the landing page lists them, but BookingCard
     already pairs a film with a product — `switchHeroVideo()` runs on every
     render and on every tab change, which is how the landing page's tab strip
     cross-fades them. So the page's own card decides, and this only makes the
     markup agree with it: the clip that will end up active is the one marked
     active here, so it is the one clip fetched rather than two.

     Pass `video` to override that; nothing does, and a page that did would be
     fighting a shared component the whole product already agrees on.
     ===================================================================== */
  const HERO_VIDEOS = [
    { key: 'flights',  src: 'assets/videos/flight.mp4' },
    { key: 'hotels',   src: 'assets/videos/hotel.mp4' },
    { key: 'cruises',  src: 'assets/videos/cruise.mp4' },
    { key: 'packages', src: 'https://assets.mixkit.co/videos/14834/14834-720.mp4' },
  ];

  const HERO_EYEBROW = 'Flights &middot; Hotels &middot; Cruises &middot; Tour Packages — one search';
  const HERO_TITLE = 'Your next adventure<span class="accent"> starts here.</span>';
  const HERO_SUB = 'Book flights, hotels, cruises, and holiday packages, and unforgettable'
    + ' experiences — all in one place, at prices that don’t need a coupon hunt.';

  function heroVideosHtml(active) {
    return HERO_VIDEOS.map(v => {
      /* Only the ACTIVE clip is fetched. The other three carry `data-src` and
         are loaded by whoever swaps them — the landing page's tab strip — so a
         service page costs one video, not four. */
      const on = v.key === active;
      return '<video' + (on ? ' class="active"' : '') + ' data-video="' + v.key + '"'
        + (on ? ' src="' + v.src + '" autoplay preload="auto"'
              : ' data-src="' + v.src + '" preload="none"')
        + ' muted loop playsinline aria-hidden="true"></video>';
    }).join('');
  }

  /** @param {{video?:string, cue?:boolean, compact?:boolean}} [opts]
   *
   *  `compact` is the RESULTS-PAGE form: the same film and the same card, with
   *  the marketing block and the scroll cue dropped and the height collapsed to
   *  whatever the card needs. See mountHero for why that distinction exists. */
  function heroHtml(opts) {
    const o = opts || {};
    /* NO FILM ON A RESULTS PAGE, AND THIS IS THE POINT OF `compact`.
       The band kept the landing page's video, overlay and transparent header,
       which made flights.html look exactly like index.html with results
       appended underneath the search card — reported four times as "the
       landing page is showing booking results". It never was: the redirect
       worked and the URL said /flights.html. The two pages were simply
       indistinguishable at a glance, which is a worse bug than the one being
       reported, because it made a working flow look broken.

       Dropping the film also drops the transparent header: bindScrollFade
       finds no #heroBg and paints the solid navy-on-white bar instead, so the
       whole top of the page reads as a different screen. Nothing else moves —
       same card, same cards, same filters, same steps. */
    if (o.compact) {
      return '<div class="wrap search-dock" id="heroSearchDock"></div>';
    }
    return '<div class="hero-bg" id="heroBg"></div>'
      + '<div class="hero-video-layer" id="heroVideoLayer">'
      + heroVideosHtml(o.video || 'flights') + '</div>'
      + '<div class="hero-overlay"></div>'
      /* The headline, the eyebrow and the sub-line are the LANDING PAGE's
         pitch. A results page is answering a question that has already been
         asked — "Your next adventure starts here" over a list of fares is the
         page still selling to someone who has already bought in. */
      + (o.compact ? '' : '<div class="wrap hero-inner">'
        + '<div class="eyebrow">' + HERO_EYEBROW + '</div>'
        + '<h1>' + HERO_TITLE + '</h1>'
        + '<p class="sub">' + HERO_SUB + '</p>'
        + '</div>')
      /* The card is BookingCard's, mounted by mountHero below — never markup
         here, so every page shares one control instead of four copies of a
         form that would drift apart. */
      + '<div class="wrap search-dock" id="heroSearchDock"></div>'
      /* Nothing to scroll TO on a results page — the results are already the
         next thing on screen. */
      + (o.cue === false || o.compact ? ''
        : '<div class="hero-scroll-cue">Scroll<svg width="16" height="16" viewBox="0 0 24 24"'
          + ' fill="none" stroke="currentColor" stroke-width="2">'
          + '<path d="M12 5v14M5 12l7 7 7-7"/></svg></div>');
  }

  /** Build the hero into `#siteHero` and mount that page's search card in it.
   *
   *  @param {{card?:string, video?:string, cue?:boolean, compact?:boolean}} [opts]
   *         `card` is the BookingCard tab to open — 'flights', 'hotels' or
   *         'packages'. Omit it on a page that has no search card.
   *         `compact` makes this a RESULTS-PAGE header instead of a hero.
   *
   *  TWO SHAPES, ONE COMPONENT, AND THE DIFFERENCE IS THE JOB OF THE PAGE.
   *  The landing page SELLS: a full-height film, the headline, the pitch, and
   *  the card as the invitation. A results page ANSWERS: the traveller has
   *  already searched, and everything above the first fare is in their way.
   *  Compact keeps the card — it is the search summary and the Modify Search
   *  on those pages, which is why it must not be dropped — and throws away the
   *  877px of marketing above it, so the results start near the top of the
   *  page instead of a screen and a half down it.
   *
   *  THE SCROLL FADE AND THE PARALLAX ARE ARMED HERE, not in mountHeader.
   *  Both look for `#heroBg`; the header mounts at the top of the document
   *  while the hero arrives further down, so at mountHeader time there was no
   *  hero to find and every service page fell back to the flat solid bar with
   *  no parallax while the landing page got the fade. That was the largest
   *  visible difference between them and it was invisible in the markup. */
  /** Keep the hero's film running.
   *
   *  NOT a difference between the pages — every page's hero is started the
   *  same way, by BookingCard's switchHeroVideo(), and index.html's static
   *  markup behaves identically to a mounted one. This is about the case they
   *  all share: a browser may refuse or undo autoplay, most commonly when the
   *  page is opened into a BACKGROUND tab. play() is then rejected, the
   *  rejection is swallowed where it is issued, and without this nothing ever
   *  tries again — the hero stays frozen on its first frame for the rest of
   *  the visit, which reads as "the video is broken on this page".
   *
   *  So the attempt is repeated when the media says it could start, and again
   *  when the tab is actually looked at. Called from BOTH entry points —
   *  initBehaviour() for the landing page's static hero and mountHero() for a
   *  built one — because a fix that covered only one of them would put back
   *  exactly the kind of difference between pages this file exists to remove. */
  let videoBound = false;

  function playHeroVideo() {
    const layer = document.getElementById('heroVideoLayer');
    if (!layer) return;

    const attempt = () => {
      const v = layer.querySelector('video.active');
      if (!v || !v.isConnected || !v.paused) return;
      /* The PROPERTIES, not only the attributes: a muted inline video is the
         one thing every autoplay policy allows. */
      v.muted = true;
      v.playsInline = true;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    };

    attempt();
    if (videoBound) return;
    videoBound = true;
    /* Capturing listeners on the layer — media events do not bubble, and the
       clip that needs them may not be in the DOM yet when this runs. */
    ['loadeddata', 'canplay', 'canplaythrough'].forEach(name =>
      layer.addEventListener(name, attempt, true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') attempt();
    });
  }

  function mountHero(opts) {
    const o = opts || {};
    const host = document.getElementById('siteHero');
    if (!host) return;
    host.classList.add('hero');
    host.classList.toggle('is-compact', !!o.compact);
    /* The card's product IS the clip, unless the page names one. Without this
       the markup opened on the flights film and BookingCard immediately
       switched it — a second video fetched on every page load, and a visible
       swap on the slow ones. */
    host.innerHTML = heroHtml(Object.assign({ video: o.card || 'flights' }, o));
    /* THE LANDING PAGE'S CARD IS NOT BUILT ON A RESULTS PAGE.
       `compact` leaves #heroSearchDock empty for search-strip.js to fill —
       a different component with its own markup, not this one made smaller.
       Only the full hero mounts BookingCard. */
    if (o.card && !o.compact && typeof BookingCard !== 'undefined') {
      BookingCard.render('heroSearchDock', { tab: o.card });
    }
    /* AFTER the card, because rendering it is what picks the clip. */
    playHeroVideo();
    bindScrollFade();
    bindParallax();
  }

  /* ---------------------------------------------------------------------
     Account state — reflected, never changed here.
     --------------------------------------------------------------------- */
  function paintAuth() {
    const slot = document.getElementById('shellAuth');
    if (!slot) return;

    /* THE CHIP AND ITS MENU ARE profile-menu.js's.
       This used to render "one chip, no dropdown" — the comment said so — so
       arriving on Flights from a search left the profile visible and every
       account destination behind it unreachable. The component renders the
       same chip and the same eight-item menu the landing page has, because it
       IS the landing page's. */
    if (typeof ProfileMenu !== 'undefined') {
      /* data-profile-menu is already on the slot, in the markup above, exactly
         as index.html writes it. */
      ProfileMenu.mount(slot.parentNode || document);
    } else {
      slot.innerHTML = '<a href="index.html?signin=1" class="nav-login">Login</a>'
        + '<a href="index.html?signin=1" class="btn btn-coral nav-signup">Sign Up</a>';
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

  /* Called twice on a service page — once by mountHeader, before the hero
     exists, and again by mountHero once it does. The flag stops the second
     call stacking a duplicate scroll listener; the `is-solid` class is
     removed rather than left, because the first call is what put it there. */
  let fadeBound = false;

  function bindScrollFade() {
    const header = document.getElementById('siteHeader');
    if (!header) return;

    /* THE FADE ONLY MAKES SENSE OVER THE VIDEO HERO.
       It starts the bar fully transparent so the film shows through, which is
       right on index.html and flights.html and wrong everywhere else: a
       service page has a light background, so a transparent bar with the
       hero's white lettering is white-on-white. Those pages get the solid bar
       instead — the same nav, painted, which is what the header looks like on
       the landing page once you have scrolled past the film anyway. */
    if (!document.getElementById('heroBg')) {
      header.classList.add('is-solid');
      return;
    }
    header.classList.remove('is-solid');
    if (fadeBound) return;
    fadeBound = true;

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

    /* THE PRODUCT LINKS SWITCH THE CARD'S TAB INSTEAD OF NAVIGATING —
       but only where switching it is a real answer.

       On the landing page the search card IS the page's content, so choosing
       Flights or Hotels there is choosing what to search for, not where to go:
       the click activates that tab and the page stays put. Navigation happens
       when the traveller presses Search.

       ON A RESULTS PAGE THE LINKS STILL NAVIGATE, and that is deliberate
       rather than an oversight. Its card is the compact bar (`.is-bar`), which
       exists to edit the search that produced the list underneath it; silently
       switching it to Hotels would leave a hotel form above a page of flights,
       and — worse — the header would no longer be able to leave the page at
       all. So the test is the card's own mode, not the URL: a full card takes
       the click, a bar lets it through.

       Delegated on the header so it serves both the built nav and
       index.html's static copy without either page wiring it up. */
    const PRODUCT_TABS = {
      'flights.html': 'flights',
      'hotels.html': 'hotels',
      'packages.html': 'packages',
    };
    /* Declared here because BOTH delegated handlers below hang off it. */
    const header = document.getElementById('siteHeader');
    if (header && !header.dataset.tabNavBound) {
      header.dataset.tabNavBound = '1';
      header.addEventListener('click', e => {
        const a = e.target.closest('a[href]');
        if (!a || !header.contains(a)) return;
        const tab = PRODUCT_TABS[a.getAttribute('href')];
        if (!tab) return;
        /* The landing page's card only. A results page has `.is-bar`. */
        const card = document.querySelector('.search-card:not(.is-bar)');
        if (!card || typeof BookingCard === 'undefined') return;
        if (!BookingCard.activateTab(tab)) return;   // card cannot serve it — let the link work
        e.preventDefault();
        /* Mark it current, so the nav agrees with the card it just changed. */
        header.querySelectorAll('.navlinks a, .mobile-nav a').forEach(link => {
          const on = PRODUCT_TABS[link.getAttribute('href')] === tab;
          if (on) link.setAttribute('aria-current', 'page');
          else if (PRODUCT_TABS[link.getAttribute('href')]) link.removeAttribute('aria-current');
        });
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    /* My Bookings / Notifications. Delegated on the header, so it serves both
       the built nav and index.html's static copy without either page wiring it
       up itself. Signed out there is nothing to show, so it asks for a sign-in
       the same way every other account destination does. */
    if (header && !header.dataset.acctBound) {
      header.dataset.acctBound = '1';
      header.addEventListener('click', e => {
        const btn = e.target.closest('[data-nav-acct]');
        if (!btn) return;
        e.preventDefault();
        const tab = btn.dataset.navAcct;
        if (typeof AccountCenter !== 'undefined' && AccountCenter.open) {
          AccountCenter.open(tab);
          return;
        }
        window.location.href = tab === 'bookings'
          ? 'my-bookings.html' : 'index.html?account=notifications';
      });
    }

    /* A sign-out in another tab must not leave a stale chip here. */
    window.addEventListener('storage', e => {
      if (e.key && e.key.indexOf('jpc_') === 0) paintAuth();
    });
  }

  /* The hero's parallax, matching the landing page's. Skipped for reduced
     motion, which is the same condition main.css uses to stop its animations. */
  let parallaxBound = false;

  function bindParallax() {
    const bg = document.getElementById('heroBg');
    const layer = document.getElementById('heroVideoLayer');
    if (!bg || parallaxBound || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    parallaxBound = true;
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
    /* index.html's hero is static, so this is where it gets the same
       autoplay retry a mounted hero gets in mountHero(). */
    playHeroVideo();
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

  /* ---------------------------------------------------------------------
     The booking footer

     The landing page's footer is a company directory — five columns, the
     contact block, the newsletter. It belongs at the end of a page somebody is
     reading. A results or booking page is a page somebody is WORKING in, and
     that footer both buries the thing they are doing and offers a dozen ways
     to abandon it. So those pages get this instead: the way back, and the two
     documents anyone is entitled to find from any page.
     --------------------------------------------------------------------- */
  function bookingFooterHtml() {
    return '<div class="wrap bf-row">'
      + '<button type="button" class="bf-back" data-bf-back>'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>Back</button>'
      + '<span class="bf-copy">&copy; ' + new Date().getFullYear()
      + ' JackPots World Tours &amp; Travels Pvt. Ltd.</span>'
      + '<span class="bf-links">'
      + '<a href="index.html#contact">Privacy Policy</a>'
      + '<a href="index.html#contact">Terms &amp; Conditions</a>'
      + '</span></div>';
  }

  function mountBookingFooter() {
    const foot = document.getElementById('bookingFooter');
    if (!foot || foot.dataset.bfInit) return;
    foot.dataset.bfInit = '1';
    foot.innerHTML = bookingFooterHtml();
    /* Delegated, so the button survives any later repaint of this footer. */
    foot.addEventListener('click', e => {
      if (!e.target.closest('[data-bf-back]')) return;
      /* The browser's own history, which is what every screen in these flows
         is built on — each hotel booking step is its own history entry, and
         the results pages write their criteria into the URL. Nothing to
         reimplement, and nothing that can disagree with the Back links the
         screens already carry. */
      if (history.length > 1) history.back();
      else window.location.href = 'index.html';
    });
  }

  return { mountHeader, mountHero, mountFooter, mountBookingFooter,
           initBehaviour, paintAuth, headerHtml, heroHtml, footerHtml };
})();
