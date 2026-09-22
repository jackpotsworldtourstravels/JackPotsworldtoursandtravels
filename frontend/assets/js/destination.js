'use strict';
/* The destination page — /destination/{slug}.
   ---------------------------------------------------------------------------
   STEP TWO OF THREE: Destination -> its famous places -> hotels near one.
   The homepage card lands here, on the LANDMARKS a traveller visits and
   photographs — Charminar, Birla Mandir — and each one's "View Hotels" opens
   /hotels/{destination}/{attraction}.

   LANDMARKS, NOT AREAS. This page used to list customer_locations (Banjara
   Hills, HITEC City). Those are how hotels are filed and they still drive the
   hotels themselves, but nobody visits an area; the owner asked for the places
   people go to see. Each landmark names its nearest listed area, and that is
   the area whose hotels "View Hotels" shows — the hotels page says so.

   NO PLACE NAME IN THIS FILE. Everything shown comes from two public reads:

       GET /api/customer/destinations                        name, country, art
       GET /api/customer/destinations/{slug}/attractions     the famous places

   The first is the same list the homepage shelf already fetched; there is no
   single-destination route and adding one to save a few hundred bytes would be
   a second way to answer one question. The two run in parallel.

   THE LINK IS BUILT FROM THE API'S OWN KEYS: /hotels/{destination_id}/{slug},
   both fields the API sent. Nothing maps a display name to a URL. */
(function () {
  const grid = document.getElementById('dlGrid');
  const hero = document.getElementById('dlHero');
  const countEl = document.getElementById('dlCount');
  const statusEl = document.getElementById('dlStatus');
  const titleEl = document.getElementById('dlTitle');
  const countryEl = document.getElementById('dlCountry');
  const leadEl = document.getElementById('dlLead');
  if (!grid || !statusEl || !titleEl) return;

  const slug = decodeURIComponent(
    (location.pathname.replace(/\/+$/, '').split('/').pop() || '')
  ).trim();

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const icon = (name, size) => (typeof JPIcon !== 'undefined' && JPIcon.html)
    ? JPIcon.html(name, { size: size || 16 }) : '';

  /* Same resolver rule as home-destinations.js: a KEY from the API, listed in
     the shipped manifest, or no picture at all.

     THE MANIFEST IS THE LANDMARKS' OWN. assets/locations/ holds a photograph
     per famous place, keyed by the attraction id the API sends
     ('hyderabad__charminar'), written by scripts/fetch_attraction_images.py
     from that landmark's Wikimedia Commons category. The destination manifest
     is kept as a fallback for a key that predates it. */
  /* The DESTINATION shelf's artwork, for the header. Separate from artFor
     below, which resolves a LANDMARK's photograph: two manifests, two
     directories, and a key from the API for each. */
  const destArtFor = key => {
    if (!key || typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES) return null;
    if (!DESTINATION_IMAGE_FILES[key]) return null;
    const dir = (typeof DESTINATION_IMAGE_DIR === 'string') ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    return { src: dir + key + '.webp', small: dir + key + '-480.webp' };
  };

  const artFor = key => {
    if (!key) return null;
    if (typeof LOCATION_IMAGE_FILES === 'object' && LOCATION_IMAGE_FILES && LOCATION_IMAGE_FILES[key]) {
      const dir = (typeof LOCATION_IMAGE_DIR === 'string') ? LOCATION_IMAGE_DIR : 'assets/locations/';
      return { src: dir + key + '.webp', small: dir + key + '-480.webp' };
    }
    if (typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES) return null;
    if (!DESTINATION_IMAGE_FILES[key]) return null;
    const dir = (typeof DESTINATION_IMAGE_DIR === 'string') ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    return { src: dir + key + '.webp', small: dir + key + '-480.webp' };
  };

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function cardHtml(loc, dest) {
    const art = artFor(loc.image);
    /* ALT TEXT IS THE PLACE, not empty. These photographs carry the meaning of
       the card - a decorative alt would leave a screen reader with a name and
       no idea it is looking at a photograph of it. */
    const picture = art
      ? `<img class="dl-img" src="${esc(art.src)}" srcset="${esc(art.small)} 480w, ${esc(art.src)} 960w"
           sizes="(max-width: 640px) 100vw, (max-width: 1100px) 45vw, 320px"
           alt="${esc(loc.name)}" loading="lazy" decoding="async"
           onerror="this.remove()">`
      : '';

    /* The count is the nearest AREA's, counted by foreign key — the hotels
       "View Hotels" will actually show — and it names that area, so "1 hotel"
       is never read as "1 hotel at the monument". Zero is said plainly. */
    const n = Number(loc.hotel_count) || 0;
    const count = n > 0
      ? `${n} ${n === 1 ? 'hotel' : 'hotels'} nearby${loc.area_name ? ' in ' + loc.area_name : ''}`
      : 'No hotels listed nearby yet';

    const dest_id = loc.destination_id || dest.id;
    const href = 'hotels/' + encodeURIComponent(dest_id) + '/' + encodeURIComponent(loc.slug);
    /* The place's own page: its photograph, what going there costs, what it
       is, and the way on to these same hotels. */
    const explore = 'destination/' + encodeURIComponent(dest_id) + '/' + encodeURIComponent(loc.slug);

    /* EXPLORE IS THE PRIMARY ACTION NOW. This page is where somebody decides
       whether they want to go at all; hotels are the step after that, and the
       pair is ordered to match. Both were already here - only their weight
       changed. */
    return `<article class="dl-card" role="listitem">
      <div class="dl-art">${picture}<span class="dl-pin">${icon('mapPin', 20)}</span></div>
      <div class="dl-body">
        <h2 class="dl-name">${esc(loc.name)}</h2>
        ${loc.description ? `<p class="dl-desc">${esc(loc.description)}</p>` : ''}
        <p class="dl-count-line">${icon('hotels', 15)} ${esc(count)}</p>
        <div class="dl-actions">
          <a class="disc-btn" href="${esc(explore)}"
             aria-label="Explore ${esc(loc.name)}">Explore Location ${icon('arrowRight', 16)}</a>
          <a class="disc-btn disc-btn-ghost" href="${esc(href)}"
             aria-label="View hotels near ${esc(loc.name)}">View Hotels</a>
        </div>
      </div>
    </article>`;
  }

  function message(text, retry) {
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'false');
    statusEl.textContent = text;
    const old = document.getElementById('dlRetry');
    if (old) old.remove();
    if (!retry) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'dlRetry';
    btn.className = 'dh-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => { btn.remove(); load(); });
    statusEl.insertAdjacentElement('afterend', btn);
  }

  function notFound() {
    if (countEl) countEl.textContent = '';
    titleEl.textContent = 'Destination not found';
    leadEl.textContent = '';
    countryEl.textContent = '';
    message('We could not find that destination.', false);
  }

  async function load() {
    grid.setAttribute('aria-busy', 'true');
    statusEl.textContent = 'Loading places to visit…';
    try {
      const [all, locations] = await Promise.all([
        getJson('/api/customer/destinations'),
        getJson('/api/customer/destinations/' + encodeURIComponent(slug) + '/attractions'),
      ]);
      const dest = (Array.isArray(all) ? all : []).find(d => d && d.id === slug)
        /* The locations route folds case ("Goa" == "goa"); match the same way
           so a hand-typed URL is not a not-found on a technicality. */
        || (Array.isArray(all) ? all : []).find(d => d && String(d.id).toLowerCase() === slug.toLowerCase());
      if (!dest) { notFound(); return; }

      titleEl.textContent = 'Explore ' + dest.name;
      countryEl.textContent = dest.country || '';
      leadEl.textContent = 'Discover the most iconic and photographic places in '
        + dest.name + ' - and the hotels closest to each one.';
      document.title = dest.name + ' — JackPots World Tours & Travels';

      /* THE CITY'S OWN PHOTOGRAPH, behind its name. It comes from the
         destination shelf's manifest - the one the homepage already ships -
         so nothing new is downloaded and no stock image is invented. The
         header is designed to work without it: the gradient is the design and
         the picture is a layer on top of it. */
      const heroArt = destArtFor(dest.image);
      if (heroArt) {
        const img = document.createElement('img');
        img.className = 'dl-hero-img';
        img.src = heroArt.src;
        img.srcset = heroArt.small + ' 480w, ' + heroArt.src + ' 960w';
        img.sizes = '100vw';
        img.alt = '';                 /* decorative: the name is right beside it */
        img.decoding = 'async';
        /* Eager, and only this one: it is the first thing on the page. */
        img.fetchPriority = 'high';
        img.addEventListener('error', () => img.remove());
        hero.insertBefore(img, hero.firstChild);
      }
      hero.classList.add('disc-in');

      const rows = Array.isArray(locations) ? locations.filter(l => l && l.slug && l.name) : [];
      if (!rows.length) {
        message('No places to visit are listed for ' + dest.name + ' yet.', false);
        return;
      }
      grid.innerHTML = rows.map(l => cardHtml(l, dest)).join('');
      grid.setAttribute('aria-busy', 'false');
      grid.classList.add('disc-in');
      /* The count is a label above the grid, not a status message: it is a
         fact about the page rather than a report on the request, and a live
         region that keeps announcing "7 places to visit" is noise. */
      countEl.textContent = rows.length + (rows.length === 1 ? ' place to visit' : ' places to visit');
      statusEl.textContent = '';
      if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount(grid);
    } catch (err) {
      console.warn('[destination] failed:', err && err.message);
      if (err && err.status === 404) notFound();
      else message('Unable to load this destination right now.', true);
    }
  }

  /* -------------------------------------------------------------------------
     THE SPOTLIGHT — one card is picked out and the rest step back.

     WHY THIS IS SCRIPT AND NOT `:hover`. A phone has no hover and a keyboard
     has no pointer, and the brief asks for the same effect from all three. So
     one delegated listener per input method sets the same two classes -
     `is-engaged` on the grid, `is-active` on the card - and the stylesheet
     describes what those mean. Nothing here decides how anything looks.

     DELEGATED, so it costs one listener rather than one per card and keeps
     working after the grid is re-rendered.

     A TAP MUST NOT SWALLOW THE TAP. `pointerdown` marks the card and the
     click continues to the link underneath, so the first tap both highlights
     and navigates - a card that needs two taps to open is a card that feels
     broken. */
  let active = null;

  function setActive(card) {
    if (active === card) return;
    if (active) active.classList.remove('is-active');
    active = card;
    if (card) card.classList.add('is-active');
    grid.classList.toggle('is-engaged', !!card);
  }

  function cardOf(node) {
    return node && node.closest ? node.closest('.dl-card') : null;
  }

  /* Pointer: `pointerover`/`pointerout` rather than enter/leave so one
     delegated pair covers every card, and moving between two cards swaps the
     highlight instead of clearing it. */
  grid.addEventListener('pointerover', e => {
    const card = cardOf(e.target);
    if (card) setActive(card);
  });
  grid.addEventListener('pointerout', e => {
    /* Only when the pointer has actually left the grid, not on the way from
       one card to the next. */
    if (!e.relatedTarget || !grid.contains(e.relatedTarget)) setActive(null);
  });

  /* Touch: the card under the finger becomes active and stays active while
     the browser follows the link. */
  grid.addEventListener('pointerdown', e => {
    const card = cardOf(e.target);
    if (card) setActive(card);
  });

  /* Keyboard: tabbing to a card's link is the same state. focusin/out bubble,
     which focus/blur do not. */
  grid.addEventListener('focusin', e => setActive(cardOf(e.target)));
  grid.addEventListener('focusout', e => {
    if (!e.relatedTarget || !grid.contains(e.relatedTarget)) setActive(null);
  });

  if (!slug) { notFound(); return; }
  load();
})();
