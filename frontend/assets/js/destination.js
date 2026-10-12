'use strict';
/* The destination page — /destination/{slug}.
   ---------------------------------------------------------------------------
   STEP TWO OF THREE: Destination -> its famous places -> hotels near one.

   LANDMARKS, NOT AREAS. The places listed are the attractions a traveller
   visits and photographs; each names its nearest listed AREA, and that area
   is whose hotels "hotels near X" opens (/hotels/{destination}/{attraction}).

   NO PLACE NAME IN THIS FILE. Everything shown comes from three public reads,
   run in parallel:

       GET /api/customer/destinations                        name, country, art
       GET /api/customer/destinations/{slug}/attractions     the famous places
       GET /api/customer/packages                            tours whose
                                                             destination is this

   There is no single-destination route; the list is the same one the
   homepage fetched. A package belongs here when its `destination` equals
   this destination's name — two values from the API compared to each other,
   not a name written into the browser.

   THE PAGE (editorial, design system: jw-system.css + jw-editorial.css):
     hero       the destination's photograph, full bleed; name, country, and
                three real counts — famous places, hotels near them, tours
     overview   the facts, and a gallery rail of the places that have photos
     places     the editorial grid of every famous place -> its own page
     hotels     "N hotels near X" for each place that has any, or says none
     tours      this destination's packages with their real from-prices
     flights    a band that opens the flight search

   NOTHING IS INVENTED. No description is written for the destination (the
   API has none); no rating, no price that the package rows do not carry. */
(function () {
  const heroMedia = document.getElementById('dlHeroMedia');
  const body = document.getElementById('dlBody');
  const titleEl = document.getElementById('dlTitle');
  const countryEl = document.getElementById('dlCountry');
  const leadEl = document.getElementById('dlLead');
  const crumbEl = document.getElementById('dlCrumb');
  const statsEl = document.getElementById('dlStats');
  const subnav = document.getElementById('dlSubnav');
  if (!body || !titleEl) return;

  const slug = decodeURIComponent((location.pathname.replace(/\/+$/, '').split('/').pop() || '')).trim();
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const inr = n => '₹' + Math.round(Number(n)).toLocaleString('en-IN');

  /* Two manifests, two directories, a key from the API for each. A key not
     listed means no picture — never a borrowed one. `?v=` is the manifest's
     content stamp, so replacing a photograph reaches cached browsers. */
  const stampQ = s => (typeof s === 'string') ? '?v=' + s : '';
  function destArt(key) {
    if (!key || typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES || !DESTINATION_IMAGE_FILES[key]) return null;
    const dir = (typeof DESTINATION_IMAGE_DIR === 'string') ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    const v = stampQ(DESTINATION_IMAGE_FILES[key]);
    return { s: dir + key + '-480.webp' + v, m: dir + key + '.webp' + v, l: dir + key + '-1600.webp' + v };
  }
  function placeArt(key) {
    if (!key) return null;
    if (typeof LOCATION_IMAGE_FILES === 'object' && LOCATION_IMAGE_FILES && LOCATION_IMAGE_FILES[key]) {
      const dir = (typeof LOCATION_IMAGE_DIR === 'string') ? LOCATION_IMAGE_DIR : 'assets/locations/';
      const v = stampQ(LOCATION_IMAGE_FILES[key]);
      return { s: dir + key + '-480.webp' + v, m: dir + key + '.webp' + v };
    }
    return destArt(key);
  }
  const imgTag = (a, sizes, alt, cls, eager) => a
    ? '<img class="' + (cls || '') + ' ds-dev" src="' + esc(a.m) + '" srcset="' + esc(a.s) + ' 480w, ' + esc(a.m) + ' 960w'
      + (a.l ? ', ' + esc(a.l) + ' 1600w' : '') + '" sizes="' + sizes + '" alt="' + esc(alt) + '"'
      + (eager ? ' fetchpriority="high"' : ' loading="lazy"') + ' decoding="async" onerror="this.remove()">'
    : '';

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
    return res.json();
  }

  /* --------------------------------------------------------------- sections */
  function head(kicker, title, lede, id) {
    return '<div class="ed-head">'
      + '<p class="ds-eyebrow" data-ds-reveal>' + kicker + '</p>'
      + '<h2 class="ds-h1"' + (id ? ' id="' + id + '"' : '') + ' data-ds-reveal>' + title + '</h2>'
      + (lede ? '<p class="ds-lede" data-ds-reveal>' + lede + '</p>' : '')
      + '</div>';
  }

  /* THE AT-A-GLANCE BOX: four panels (country, famous places, hotels near them, tour packages) on one
     ivory plate with a thin gold border. The values are the page's own data, passed in; this only dresses
     them. Icons and line-art are inline SVG (no request, no animation) and are decorative: aria-hidden.
     A long country name ("United Arab Emirates") gets the smaller value size so it never overflows. */
  const GL_ICON = {
    pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.3"/>',
    camera: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8 7l1.5-2.5h5L16 7"/><circle cx="12" cy="13.5" r="3.3"/>',
    hotel: '<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M9.5 7h1M13.5 7h1M9.5 11h1M13.5 11h1M9.5 15h1M13.5 15h1M10.5 21v-3h3v3"/>',
    bag: '<rect x="5" y="8" width="14" height="12" rx="2"/><path d="M9 8V6.2A1.7 1.7 0 0 1 10.7 4.5h2.6A1.7 1.7 0 0 1 15 6.2V8M9.5 8v12M14.5 8v12"/>',
  };
  const GL_ART = {
    /* a domed landmark with minarets, over a low hill */
    country: '<svg class="dl-gl-art" viewBox="0 0 300 170" aria-hidden="true" focusable="false"><g fill="currentColor" stroke="none">'
      + '<path d="M118 150V104c0-16 12-28 32-52 20 24 32 36 32 52v46z"/><path d="M148 40h4v14h-4z"/>'
      + '<path d="M84 150v-48c0-9 7-17 16-26 9 9 16 17 16 26v48z" opacity=".8"/><path d="M184 150v-48c0-9 7-17 16-26 9 9 16 17 16 26v48z" opacity=".8"/>'
      + '<rect x="58" y="70" width="9" height="80" rx="3"/><rect x="233" y="70" width="9" height="80" rx="3"/>'
      + '<path d="M56 70c0-6 3-9 6-14 3 5 6 8 6 14z"/><path d="M231 70c0-6 3-9 6-14 3 5 6 8 6 14z"/></g>'
      + '<path d="M0 158c60-22 120-6 170-10s90-18 130-6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    /* a dotted route ending in a map pin, over a hill line */
    places: '<svg class="dl-gl-art" viewBox="0 0 300 170" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.4">'
      + '<path d="M20 150c50-10 70-46 120-50s70 30 110-8" stroke-dasharray="3 6"/>'
      + '<path d="M0 160c70-30 120-14 180-24s90-34 120-60" stroke-width="1.1"/></g>'
      + '<g fill="none" stroke="currentColor" stroke-width="1.8"><path d="M250 92s-17-14-17-28a17 17 0 0 1 34 0c0 14-17 28-17 28z"/><circle cx="250" cy="64" r="6"/></g></svg>',
    /* a hotel block between two palms, over a hill line */
    hotels: '<svg class="dl-gl-art" viewBox="0 0 300 170" aria-hidden="true" focusable="false"><g fill="currentColor" stroke="none">'
      + '<rect x="130" y="30" width="86" height="120" rx="2"/></g><g fill="#fbf6ec" stroke="none">'
      + '<rect x="142" y="46" width="10" height="10"/><rect x="162" y="46" width="10" height="10"/><rect x="182" y="46" width="10" height="10"/><rect x="202" y="46" width="6" height="10"/>'
      + '<rect x="142" y="68" width="10" height="10"/><rect x="162" y="68" width="10" height="10"/><rect x="182" y="68" width="10" height="10"/><rect x="202" y="68" width="6" height="10"/>'
      + '<rect x="142" y="90" width="10" height="10"/><rect x="162" y="90" width="10" height="10"/><rect x="182" y="90" width="10" height="10"/><rect x="202" y="90" width="6" height="10"/></g>'
      + '<g fill="none" stroke="currentColor" stroke-width="2"><path d="M66 150c2-30 2-52 0-80M66 70c-14-2-24 4-30 14M66 70c12-6 24-2 30 8M66 70c-6-12-18-16-28-14M66 70c8-12 20-14 28-10"/>'
      + '<path d="M262 150c2-26 2-44 0-66M262 84c-12-2-20 3-26 12M262 84c10-5 20-2 26 6M262 84c-5-10-15-13-23-11"/>'
      + '<path d="M0 160c70-26 120-10 180-18s90-26 120-50" stroke-width="1.1"/></g></svg>',
    /* hills, a dotted route and an aeroplane */
    packages: '<svg class="dl-gl-art dl-gl-art--wide" viewBox="0 0 520 170" aria-hidden="true" focusable="false"><g fill="currentColor" stroke="none">'
      + '<path d="M330 160l70-92 38 46 30-34 52 80z" opacity=".7"/><path d="M270 160l54-60 40 60z" opacity=".5"/>'
      + '<path d="M455 38l26-9 4-12 7 2-2 11 22-7 4 6-22 9 4 12-7 3-8-11-24 8z" transform="rotate(-18 480 40)"/></g>'
      + '<g fill="none" stroke="currentColor" stroke-width="1.4"><path d="M120 150c60-40 160-10 230-50s90-52 110-70" stroke-dasharray="3 6"/>'
      + '<path d="M0 150c80-30 150 6 240-8s160-30 280-10" stroke-width="1.1"/></g></svg>',
  };

  function glanceBox(facts, toursFrom) {
    const mk = (cls, icon, label, value, extra) => {
      const long = String(value).replace(/<[^>]*>|&[a-z#0-9]+;/g, 'x').length > 9;
      return '<div class="dl-gl dl-gl--' + cls + (long ? ' is-long' : '') + '">'
        + '<span class="dl-gl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">' + GL_ICON[icon] + '</svg></span>'
        + '<div class="dl-gl-text"><dt>' + label + '</dt><dd>' + value + '</dd>' + (extra || '') + '</div>'
        + GL_ART[cls] + '</div>';
    };
    return '<dl class="dl-glance" data-ds-reveal>'
      + mk('country', 'pin', facts[0][0], facts[0][1])
      + mk('places', 'camera', facts[1][0], facts[1][1])
      + mk('hotels', 'hotel', facts[2][0], facts[2][1])
      + mk('packages', 'bag', facts[3][0], facts[3][1],
        toursFrom ? '<p class="dl-gl-from"><span>Tours from</span> ' + toursFrom + '</p>' : '')
      + '</dl>';
  }

  function overview(dest, places, hotels, tours) {
    const shots = places.filter(p => placeArt(p.image)).slice(0, 8);
    const facts = [
      ['Country', esc(dest.country || '—')],
      ['Famous places', places.length],
      ['Hotels near them', hotels],
      ['Tour packages', tours.length],
    ];
    const from = tours.map(t => Number(t.priceFrom)).filter(n => n > 0);
    return '<section class="ds-section" id="overview" aria-labelledby="dlOvHead"><div class="ds-container">'
      + '<div class="dl-overview">'
      +   '<div>' + '<p class="ds-eyebrow" data-ds-reveal>Overview</p>'
      +     '<h2 class="ds-h1" id="dlOvHead" data-ds-reveal>' + esc(dest.name) + ', <em>at a glance.</em></h2></div>'
      +   glanceBox(facts, from.length ? inr(Math.min.apply(null, from)) : '')
      + '</div>'
      + (shots.length ? '<div class="ed-rail dl-gallery" data-ds-stagger aria-label="Photographs of ' + esc(dest.name) + '">'
        + shots.map(p => '<figure class="dl-shot" data-ds-reveal="scale">'
          + imgTag(placeArt(p.image), '(max-width: 640px) 78vw, 32vw', p.name)
          + '<figcaption>' + esc(p.name) + '</figcaption>'
          + '<a href="' + esc(placeHref(dest, p)) + '" aria-label="' + esc(p.name) + '"></a></figure>').join('') + '</div>' : '')
      + '</div></section>';
  }

  const placeHref = (dest, p) => 'destination/' + encodeURIComponent(p.destination_id || dest.id) + '/' + encodeURIComponent(p.slug);
  const hotelsHref = (dest, p) => 'hotels/' + encodeURIComponent(p.destination_id || dest.id) + '/' + encodeURIComponent(p.slug);

  function placesSection(dest, places) {
    const cards = places.map((p, i) => {
      const a = placeArt(p.image);
      const n = Number(p.hotel_count) || 0;
      return '<a class="ds-media-card' + (a ? '' : ' ds-media-card--noimg') + '" role="listitem" href="' + esc(placeHref(dest, p)) + '" data-ds-reveal="scale" aria-label="Explore ' + esc(p.name) + '">'
        + imgTag(a, '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 58vw', p.name, 'ds-media-card__img')
        + '<span class="ds-media-card__num" aria-hidden="true">' + String(i + 1).padStart(2, '0') + '</span>'
        + '<span class="ds-media-card__body">'
        +   '<span class="ds-media-card__title">' + esc(p.name) + '</span>'
        +   '<span class="ds-media-card__meta">' + (n ? n + (n === 1 ? ' hotel nearby' : ' hotels nearby') : 'Famous place') + '</span>'
        +   (p.description ? '<span class="ds-media-card__teaser">' + esc(p.description) + '</span>' : '')
        +   '<span class="ds-media-card__go">Explore' + ARROW + '</span>'
        + '</span></a>';
    }).join('');
    return '<section class="ds-section" id="places" aria-labelledby="dlPlHead" style="padding-top:0"><div class="ds-container">'
      + head('Famous places', 'The places <em>worth the journey.</em>', 'The landmarks travellers come to ' + esc(dest.name) + ' to see &mdash; each with its own page and the hotels closest to it.', 'dlPlHead')
      + '<div class="ds-edgrid" role="list" data-ds-stagger=".07">' + cards + '</div>'
      + '</div></section>';
  }

  function staySection(dest, places) {
    const withHotels = places.filter(p => Number(p.hotel_count) > 0);
    const list = withHotels.map(p => {
      const n = Number(p.hotel_count);
      return '<li data-ds-reveal><a href="' + esc(hotelsHref(dest, p)) + '"><b>' + esc(p.name) + '</b>'
        + '<span>' + n + (n === 1 ? ' hotel' : ' hotels') + ' nearby' + (p.area_name ? ' &middot; ' + esc(p.area_name) : '') + '</span>'
        + ARROW + '</a></li>';
    }).join('');
    return '<section class="ds-section dl-stay ds-on-dark" id="hotels" aria-labelledby="dlStHead"><div class="ds-container">'
      + head('Hotels', 'Stay close to <em>the sights.</em>', 'Every hotel is filed under the area it stands in; these are the areas nearest each famous place.', 'dlStHead')
      + (list ? '<ul class="dl-staylist" data-ds-stagger>' + list + '</ul>'
        : '<div id="dlStayEmpty"></div>')
      + '</div></section>';
  }

  function toursSection(dest, tours) {
    const cards = tours.map(t => {
      const a = placeArt(t.image);
      const hl = Array.isArray(t.highlights) ? t.highlights.slice(0, 3).join(' · ') : (t.blurb || '');
      const nights = Number(t.nights) || 0, days = Number(t.days) || 0;
      return '<a class="dl-tour" href="package/' + encodeURIComponent(t.id) + '" data-ds-reveal="scale">'
        + '<span class="dl-tour__media">' + imgTag(a, '(max-width: 640px) 100vw, 33vw', t.name)
        +   (days ? '<span class="ds-badge ds-badge--dark ds-badge--plain">' + days + 'D / ' + nights + 'N</span>' : '') + '</span>'
        + '<span class="dl-tour__body">'
        +   '<span class="dl-tour__name">' + esc(t.name) + '</span>'
        +   (hl ? '<span class="dl-tour__hl">' + esc(hl) + '</span>' : '')
        +   '<span class="dl-tour__foot">'
        +     (Number(t.priceFrom) > 0 ? '<span class="ds-price"><span class="ds-price__from">From</span><span class="ds-price__amt">' + inr(t.priceFrom) + '</span><span class="ds-price__per">per person</span></span>' : '<span></span>')
        +     '<span class="dl-tour__go">View' + ARROW + '</span>'
        +   '</span>'
        + '</span></a>';
    }).join('');
    return '<section class="ds-section" id="tours" aria-labelledby="dlToHead"><div class="ds-container">'
      + head('Tour packages', 'Journeys to ' + esc(dest.name) + ', <em>already planned.</em>', tours.length ? 'Hotels, transfers and sightseeing arranged as one price.' : '', 'dlToHead')
      + (cards ? '<div class="dl-tours" data-ds-stagger>' + cards + '</div>' : '<div id="dlToursEmpty"></div>')
      + '</div></section>';
  }

  function flySection(dest) {
    const a = destArt(dest.image);
    return '<section class="ds-section dl-fly" id="flights" aria-labelledby="dlFlHead">'
      + (a ? '<div class="dl-fly__media" data-ds-parallax="0.12">' + imgTag(a, '100vw', '', '') + '</div>' : '')
      + '<div class="ds-container dl-fly__row">'
      +   '<div><p class="ds-eyebrow is-light" data-ds-reveal>Flights</p>'
      +   '<h2 class="ds-display" id="dlFlHead" data-ds-reveal>Fly to <em>' + esc(dest.name) + '.</em></h2></div>'
      +   '<div class="dl-fly__cta" data-ds-reveal>'
      +     '<a class="ds-btn ds-btn--primary ds-btn--lg" href="flights.html">Search flights' + ARROW + '</a>'
      +     '<a class="ds-btn ds-btn--ghost ds-btn--lg" href="hotels.html">Search hotels</a>'
      +   '</div>'
      + '</div></section>';
  }

  /* --------------------------------------------------------- the sub-nav */
  function bindSubnav() {
    if (!subnav) return;
    subnav.hidden = false;
    const links = Array.from(subnav.querySelectorAll('a'));
    const ind = subnav.querySelector('.dl-subnav__ind');
    const place = a => { if (!ind || !a) return; ind.style.width = a.offsetWidth + 'px'; ind.style.transform = 'translateX(' + a.offsetLeft + 'px)'; };
    const mark = id => links.forEach(a => { const on = a.getAttribute('href') === '#' + id; a.classList.toggle('is-on', on); if (on) { a.setAttribute('aria-current', 'true'); place(a); } else a.removeAttribute('aria-current'); });
    links.forEach(a => { const sec = document.getElementById(a.getAttribute('href').slice(1)); if (!sec) a.remove(); });
    let ticking = false;
    const spy = () => {
      ticking = false;
      let cur = null;
      links.forEach(a => { const s = document.getElementById(a.getAttribute('href').slice(1)); if (s && s.getBoundingClientRect().top < 200) cur = s.id; });
      if (cur) mark(cur);
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
    window.addEventListener('resize', spy);
    mark('overview'); spy();
  }

  /* ----------------------------------------------------------------- load */
  function notFound() {
    titleEl.textContent = 'Not found';
    if (crumbEl) crumbEl.textContent = 'Not found';
    countryEl.textContent = '';
    leadEl.textContent = '';
    document.title = 'Destination not found — JackPots World Tours & Travels';
    body.removeAttribute('aria-busy');
    DS.state(body, { kind: 'notfound', title: 'We couldn’t find that destination', body: 'It may have moved, or the link may be mistyped.',
      actions: [{ label: 'All destinations', href: 'destinations.html' }, { label: 'Back home', href: 'index.html' }] });
  }

  async function load() {
    DS.skeleton(body, 'text', 2);
    let all, places, packs;
    try {
      [all, places, packs] = await Promise.all([
        getJson('/api/customer/destinations'),
        getJson('/api/customer/destinations/' + encodeURIComponent(slug) + '/attractions'),
        getJson('/api/customer/packages').catch(() => []),
      ]);
    } catch (err) {
      console.warn('[destination] failed:', err && err.message);
      if (err && err.status === 404) { notFound(); return; }
      body.removeAttribute('aria-busy');
      DS.state(body, { kind: navigator.onLine === false ? 'offline' : 'error', title: 'We couldn’t load this destination',
        actions: [{ label: 'Try again', onClick: load }, { label: 'All destinations', href: 'destinations.html' }] });
      return;
    }
    const list = Array.isArray(all) ? all : [];
    /* The attractions route folds case ("Goa" == "goa"); match the same way
       so a hand-typed URL is not a not-found on a technicality. */
    const dest = list.find(d => d && d.id === slug) || list.find(d => d && String(d.id).toLowerCase() === slug.toLowerCase());
    if (!dest) { notFound(); return; }
    if (typeof JWInterest !== 'undefined') JWInterest.record(dest);

    const rows = (Array.isArray(places) ? places : []).filter(p => p && p.slug && p.name);
    const pkgRows = Array.isArray(packs) ? packs : (packs && Array.isArray(packs.items) ? packs.items : []);
    const tours = pkgRows.filter(t => t && t.destination && String(t.destination).toLowerCase() === String(dest.name).toLowerCase());
    const hotels = rows.reduce((n, p) => n + (Number(p.hotel_count) || 0), 0);

    /* The hero. */
    document.title = dest.name + ' — Famous Places, Hotels & Tours | JackPots World Tours & Travels';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', 'Explore ' + dest.name + (dest.country ? ', ' + dest.country : '') + ': ' + rows.length + ' famous places, the hotels closest to them and tour packages, with JackPots World Tours & Travels.');
    titleEl.textContent = dest.name;
    if (crumbEl) crumbEl.textContent = dest.name;
    countryEl.textContent = dest.country || '';
    leadEl.textContent = 'Explore the extraordinary — the famous places that make ' + dest.name + ' worth the journey, and the hotels closest to each.';
    const stats = [[rows.length, rows.length === 1 ? 'Famous place' : 'Famous places'], [hotels, 'Hotels nearby'], [tours.length, tours.length === 1 ? 'Tour package' : 'Tour packages']];
    statsEl.innerHTML = stats.map(s => '<span class="dl-stat"><b>' + s[0] + '</b><span>' + s[1] + '</span></span>').join('');
    const a = destArt(dest.image);
    if (a && heroMedia) heroMedia.innerHTML = imgTag(a, '100vw', '', '', true);
    const heroEl = document.getElementById('dlHero');
    heroEl.classList.add('ds-hero--dest');
    /* No photographer-credit line is drawn on the photograph. The credit and licence for each file
       stay in DESTINATION_IMAGE_CREDITS / assets/destinations/CREDITS.md as the licence record. */

    /* The body. */
    body.innerHTML = overview(dest, rows, hotels, tours)
      + (rows.length ? placesSection(dest, rows) : '')
      + staySection(dest, rows)
      + toursSection(dest, tours)
      + flySection(dest);
    body.removeAttribute('aria-busy');

    const stayEmpty = document.getElementById('dlStayEmpty');
    if (stayEmpty) DS.state(stayEmpty, { kind: 'empty', title: 'No hotels listed here yet', body: 'We are adding hotels near ' + dest.name + '’s famous places. Our team can still arrange a stay.',
      actions: [{ label: 'Search hotels', href: 'hotels.html', variant: 'gold' }, { label: 'Ask our team', href: 'contact-us.html', variant: 'ghost' }] });
    const toursEmpty = document.getElementById('dlToursEmpty');
    if (toursEmpty) DS.state(toursEmpty, { kind: 'empty', title: 'No packages for ' + dest.name + ' yet', body: 'Tell us your dates and who is travelling, and a travel expert will plan the trip.',
      actions: [{ label: 'Plan a tailored trip', href: 'contact-us.html' }, { label: 'All tour packages', href: 'packages.html' }] });

    DS.reveal(document); DS.develop(document);
    motion();
    bindSubnav();
  }

  /* Scroll depth, from the system's one engine (loaded on demand). */
  function motion() {
    DS.gsap().then(g => {
      if (!g) return;
      const k = DS.small ? 0.5 : 1;
      document.querySelectorAll('#places .ds-media-card').forEach((c, i) => {
        const im = c.querySelector('.ds-media-card__img'), b = c.querySelector('.ds-media-card__body');
        const r = ((i % 3) * 2 + 5) * k;
        const tl = g.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: c, start: 'top bottom', end: 'bottom top', scrub: 0.8 } });
        if (im) tl.fromTo(im, { yPercent: -6, scale: 1.14 }, { yPercent: 6, scale: 1.14 }, 0);
        if (b) tl.fromTo(b, { y: r * 2 }, { y: -r * 2 }, 0);
      });
      const fly = document.querySelector('.dl-fly__media');
      if (fly) g.fromTo(fly, { yPercent: -8 }, { yPercent: 8, ease: 'none', scrollTrigger: { trigger: fly.parentElement, start: 'top bottom', end: 'bottom top', scrub: true } });
      /* The hero's own parallax and route are jw-system.js's (bound to the
         media container, which exists before the photograph arrives). */
      g.delayedCall(0.1, () => window.ScrollTrigger && window.ScrollTrigger.refresh());
    });
  }

  if (!slug) { notFound(); return; }
  load();
})();
