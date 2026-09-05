'use strict';
/* ===========================================================================
   site-footer.js — the company footer, rendered from one definition
   ===========================================================================
   THE PROBLEM THIS SOLVES. The footer used to exist three times: as static
   markup in index.html, as footerHtml() in hero-shell.js, and as a cut-down
   row in service-shell.js. Three copies meant three chances to disagree, and
   they did — two of them still advertised Cruises after the nav dropped it,
   and every "Company" and "Support" link in all three pointed at `#`.

   Now there is one list of links (LINKS below) and one renderer. hero-shell.js
   and service-shell.js both delegate here; index.html keeps a hand-written
   copy of the SAME markup because it is the marketing front door and its
   internal links should be in the document a crawler is served, not injected
   afterwards. That copy is the only duplicate, and it is marked as one.

   NO DROPDOWNS, NO ARROWS, NO JAVASCRIPT BEHAVIOUR. This file builds markup
   and stops. There is nothing here to click that is not an <a href> to a real
   page, which is also why the footer keeps working with scripts disabled on
   every page that renders it statically.
   =========================================================================== */

const SiteFooter = (function () {

  /* -------------------------------------------------------------------------
     The one place the footer's contents are defined
     -------------------------------------------------------------------------
     WHY .html AND NOT /about. Both work in production — the FastAPI mount is
     CleanUrlStaticFiles, which does nginx's `try_files $uri $uri.html`, so
     /about serves about.html. Relative .html links are used because that is
     what every other link in this codebase already is, and because they also
     resolve when the frontend is served from a sub-path or opened from disk.

     TOUR PACKAGES POINTS AT packages.html, THE REAL PRODUCT PAGE. It is the
     page with the search card and the live catalogue; a second /tour-packages
     landing page would fork the booking entry point for no gain. */
  const LINKS = {
    company: [
      ['About Us',          'about.html'],
      ['Contact Us',        'contact-us.html'],
      ['Customer Support',  'customer-support.html'],
      ['FAQs',              'faqs.html'],
    ],
    travel: [
      ['Flights',           'flights.html'],
      ['Hotels',            'hotels.html'],
      ['Tour Packages',     'packages.html'],
    ],
    legal: [
      ['Privacy Policy',                'privacy-policy.html'],
      ['Website Terms & Conditions',    'terms-and-conditions.html'],
      ['Cancellation & Refund Policy',  'cancellation-refund-policy.html'],
      ['Cookie Policy',                 'cookie-policy.html'],
      ['Payment Security',              'payment-security.html'],
      ['Disclaimer',                    'disclaimer.html'],
    ],
  };

  /* NO SOCIAL LINKS. A "Follow us" heading and four network icons used to sit
     under the tagline in the brand column; both are gone, along with the
     `.jw-f-social*` rules in site-footer.css and the trailing margin on
     `.jw-f-about` that separated the tagline from them — otherwise the column
     would keep 26px of empty space where the icons were.

     Nothing else in this file referred to them, so this is a deletion rather
     than a hidden feature. If the accounts are ever published, this is where
     the list goes back, and the stylesheet is the other half. */

  /* Stroke icons for the contact column and the trust badges. Kept as path
     data rather than <img> so they inherit the gold via `stroke:currentColor`
     rules in the stylesheet and cost no extra request. */
  const ICONS = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.81.35 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.74-1.25a2 2 0 0 1 2.11-.45c.74.33 1.53.56 2.34.68A2 2 0 0 1 22 16.92z"/>',
    mail:  '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    pin:   '<path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    lock:  '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    shield:'<path d="M12 2.5 4.5 5.6v5.7c0 4.6 3.2 8.9 7.5 10.2 4.3-1.3 7.5-5.6 7.5-10.2V5.6L12 2.5z"/>',
    card:  '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  };

  /* This file is loaded on pages that have escapeHtml() (formatters.js) and on
     pages that do not, so it cannot assume it. Every string below is authored
     in this file rather than coming from a user or an API, but the helper stays
     because the day someone feeds a link label in from elsewhere it should not
     be the day the escaping is invented. */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const svg = (paths, extra) =>
    '<svg viewBox="0 0 24 24" aria-hidden="true"' + (extra || '') + '>' + paths + '</svg>';

  const linkList = items => items
    .map(([label, href]) =>
      '<li><a class="jw-f-link" href="' + esc(href) + '">' + esc(label) + '</a></li>')
    .join('');

  /* `aria-labelledby` on the <nav>, not `aria-label`, so the visible gold
     heading IS the accessible name of the group. A screen reader announcing
     "Company, navigation, 4 items" is reading the same word a sighted visitor
     sees, and there is no second copy of the label to keep in step. */
  function column(id, heading, items) {
    return '<nav class="jw-f-col" aria-labelledby="' + id + '">'
      + '<h3 id="' + id + '">' + esc(heading) + '</h3>'
      + '<ul>' + linkList(items) + '</ul>'
      + '</nav>';
  }

  function brandColumn() {
    return '<div class="jw-f-brand">'
      + '<a class="jw-f-logo" href="index.html">'
      + '<img src="assets/images/jackpots-logo-full.png" width="320" height="96"'
      + ' alt="JackpotsWorld Tours &amp; Travels" loading="lazy" decoding="async">'
      + '</a>'
      + '<p class="jw-f-about">Book flights, hotels and tour packages with confidence.'
      + ' Your trusted travel partner for memorable journeys.</p>'
      + '</div>';
  }

  function contactColumn() {
    return '<div class="jw-f-col">'
      + '<h3 id="jwFContact">Contact</h3>'
      + '<ul class="jw-f-contact" aria-labelledby="jwFContact">'
      + '<li>' + svg(ICONS.phone) + '<span><span class="jw-f-ct-label">Phone</span>'
      + '<a class="jw-f-link jw-f-ct-value" href="tel:+919177847799">+91 9177847799</a></span></li>'
      + '<li>' + svg(ICONS.mail) + '<span><span class="jw-f-ct-label">Email</span>'
      + '<a class="jw-f-link jw-f-ct-value" href="mailto:support@jackpotsworldtours.com">'
      + 'support@jackpotsworldtours.com</a></span></li>'
      + '<li>' + svg(ICONS.pin) + '<span><span class="jw-f-ct-label">Address</span>'
      + '<address class="jw-f-ct-value">Hyderabad,<br>Telangana,<br>India</address></span></li>'
      /* Same clock icon, same label, same two classes — one line of value text
         instead of two. Note that the rest of the site still publishes staffed
         hours (Mon–Sat, 9:00 AM – 8:00 PM IST) on Contact Us, Customer Support,
         the FAQs and the policy pages; those say when a person answers, and this
         says the desk never closes. If they are meant to agree, the pages are
         the copies to change. */
      + '<li>' + svg(ICONS.clock) + '<span><span class="jw-f-ct-label">Business hours</span>'
      + '<span class="jw-f-ct-value">24/7 Support</span></span></li>'
      + '</ul></div>';
  }

  /* The year is written out rather than computed. The brief fixes it at 2026,
     and a static legal footer that changes under the visitor is a worse answer
     than one line to bump each January. index.html's hand-written copy carries
     the same literal — the two are checked against each other by
     tests/verify_footer.py. */
  function bottomBar() {
    return '<div class="jw-f-bottom"><div class="jw-f-wrap jw-f-bottom-row">'
      + '<span>&copy; 2026 JackpotsWorld Tours &amp; Travels. All Rights Reserved.</span>'
      + '<span class="jw-f-tagline">Designed for every journey.</span>'
      + '<span class="jw-f-badges">'
      + '<span class="jw-f-badge">' + svg(ICONS.lock) + 'SSL Secured</span>'
      + '<span class="jw-f-badge">' + svg(ICONS.shield) + 'Privacy Protected</span>'
      + '<span class="jw-f-badge">' + svg(ICONS.card) + 'Secure Payments</span>'
      + '</span></div></div>';
  }

  /** The footer's inner markup. The caller owns the <footer> element itself. */
  function html() {
    return '<div class="jw-f-wrap"><div class="jw-f-grid">'
      + brandColumn()
      + column('jwFCompany', 'Company', LINKS.company)
      + column('jwFTravel',  'Travel',  LINKS.travel)
      + column('jwFLegal',   'Legal',   LINKS.legal)
      + contactColumn()
      + '</div></div>'
      + bottomBar();
  }

  /** Render into `el`, taking over its classes.
   *
   *  The class is REPLACED, not added: service-shell.js hands over an element
   *  carrying `sp-footer`, whose own background and 34px padding would fight
   *  this layout. Anything that wants both can add its class back after. */
  function mount(el) {
    const foot = (typeof el === 'string') ? document.querySelector(el) : el;
    if (!foot) return null;
    foot.className = 'jw-footer';
    if (!foot.hasAttribute('role')) foot.setAttribute('role', 'contentinfo');
    foot.innerHTML = html();
    return foot;
  }

  /* Pages that want the footer and nothing else — the static content pages —
     declare `<footer data-site-footer></footer>` and load this file. No init
     call, no shell, no dependency on formatters.js or auth.js. */
  function autoMount() {
    document.querySelectorAll('[data-site-footer]').forEach(mount);
  }

  /* -------------------------------------------------------------------------
     The Travel column, on the landing page only
     -------------------------------------------------------------------------
     THE HREFS DO NOT CHANGE, AND THAT IS THE WHOLE DESIGN. The footer renders
     on eighteen pages and only one of them has a booking card in it; on the
     other seventeen "Flights" must still go to flights.html, because there is
     nothing on those pages to scroll to. So the links stay ordinary links and
     this listener takes them over only where the card exists:

       index.html         intercepted — scroll to the card, open the tab
       every other page    untouched — the browser follows the href

     It degrades to the same thing with JavaScript off, which is why the href is
     the real destination rather than a `#` with the behaviour bolted on.

     The page opts in with `<body data-jw-home-search>` rather than this file
     sniffing for a booking card. flights.html, hotels.html and packages.html
     all mount a #heroSearchDock too (the compact hero), so a check for the
     element would have trapped someone on the Flights page when they clicked
     "Hotels" — the one thing the footer is there to prevent. */
  const TRAVEL_TABS = {
    'flights.html':  'flights',
    'hotels.html':   'hotels',
    'packages.html': 'packages',
  };

  function onFooterClick(e) {
    /* Let the browser do its job for anything that is not a plain left-click:
       ctrl/cmd-click, middle-click and shift-click all mean "open this
       somewhere else", and a preventDefault here would silently break them. */
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest && e.target.closest('.jw-footer a[href]');
    if (!link) return;

    const tab = TRAVEL_TABS[link.getAttribute('href')];
    if (!tab) return;
    if (!document.body || !('jwHomeSearch' in document.body.dataset)) return;
    if (typeof BookingCard === 'undefined') return;
    const dock = document.getElementById('heroSearchDock');
    if (!dock) return;

    /* activateTab BEFORE preventDefault. It returns false without touching
       anything if the card has no such panel, and in that case the link has to
       be allowed to navigate — swallowing the click and then failing to open
       the tab would leave the visitor on the footer with nothing having
       happened. */
    if (!BookingCard.activateTab(tab)) return;
    e.preventDefault();

    /* No `behavior: 'smooth'` here on purpose. main.css already sets
       `html { scroll-behavior: smooth }` and turns it off again under
       `prefers-reduced-motion: reduce`; passing the option explicitly would
       override that and force motion on someone who asked for none. Letting
       the stylesheet decide keeps one answer to "does this site animate". */
    dock.scrollIntoView();

    /* Someone who reached the footer link by keyboard has their focus down in
       the footer; without this the page scrolls to the card and the next Tab
       continues from the Legal column. preventScroll because the smooth scroll
       above is already on its way and focus() would otherwise jump it there
       instantly. */
    const btn = document.getElementById('bcTab-' + tab);
    if (btn && btn.focus) btn.focus({ preventScroll: true });
  }

  document.addEventListener('click', onFooterClick);
  document.addEventListener('DOMContentLoaded', autoMount);
  if (document.readyState !== 'loading') autoMount();

  return { html, mount, LINKS, TRAVEL_TABS };
})();
