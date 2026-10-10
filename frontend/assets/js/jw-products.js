'use strict';
/* ===========================================================================
   jw-products.js — motion for the product results pages, nothing else.
   ===========================================================================
   The renderers (travel-explore.js, hotel-results.js, package-listing.js)
   rewrite their result lists on every search, filter and sort. This watches
   those lists and gives each freshly written card the design system's
   arrival — rise and fade, staggered — through the system's ONE observer
   (DS.reveal). It adds classes only; it never reads or changes what a card
   says, what it links to, or what its buttons do.

   Lists opt in with [data-ds-results]; each direct child is a card.

   THE FLIGHT PASS (.jf). Each boarding-pass card carries its route as an
   SVG with a SMIL aeroplane. An inline <svg> is its own animation clock and
   starts the moment it is inserted — i.e. while the card is still below the
   fold, invisible, mid-reveal. So the clock is paused at render and released
   here, once, when the card is actually on screen and has risen into place;
   `.is-flown` is what draws the arc (CSS) in step with it. Reduced motion
   jumps the clock to the end: the plane sits at its apex, the arc is whole.
   =========================================================================== */
(function () {
  if (typeof DS === 'undefined') return;

  function fly(card, delay) {
    const svg = card.querySelector('svg.jf-svg');
    if (!svg || card.dataset.jfArmed || card.classList.contains('tx-sk-flight')) return;
    card.dataset.jfArmed = '1';
    const canClock = typeof svg.pauseAnimations === 'function';
    if (canClock) { svg.pauseAnimations(); svg.setCurrentTime(0); }
    if (DS.reduce) {
      if (canClock) svg.setCurrentTime(10);
      card.classList.add('is-flown');
      return;
    }
    DS.observe(card, (el, on) => {
      if (!on) return;
      setTimeout(() => {
        card.classList.add('is-flown');
        if (canClock) { svg.setCurrentTime(0); svg.unpauseAnimations(); }
      }, 260 + delay * 1000);
    });
  }

  function arm(list) {
    const cards = Array.from(list.children).filter(c => !c.hasAttribute('data-ds-reveal') && !c.matches('[aria-hidden="true"]'));
    cards.forEach((c, i) => {
      const d = Math.min(i, 6) * 0.07;
      c.setAttribute('data-ds-reveal', '');
      c.style.setProperty('--ds-delay', d + 's');
      if (c.classList.contains('jf')) fly(c, d);
    });
    if (cards.length) DS.reveal(list);
  }
  function watch(list) {
    if (list.dataset.dsWatched) return;
    list.dataset.dsWatched = '1';
    arm(list);
    new MutationObserver(() => arm(list)).observe(list, { childList: true });
  }
  /* =====================================================================
     THE JOURNEY HERO (flights.html)
     =====================================================================
     The compact hero is a navy band holding the search strip. On Flights it
     becomes the trip itself: the DESTINATION's curated photograph (the same
     assets/destinations files the destination pages use — never a stock
     guess; an airport with no curated city gets the night and the route
     alone), the route drawn across the band from the searched origin code to
     the destination code, and the page's own H1 moved up into it.

     Reads the route from the URL, which travel-explore.js rewrites on every
     search, and repaints when the renderer rewrites the H1. Moves the
     .tx-head node (ids intact) rather than copying it, so the renderer keeps
     writing into the one heading. Adds a trip-type control that DRIVES the
     strip's own #ssTrip select — it has no state of its own. NO PRODUCT TABS
     here: choosing Flights/Hotels/Tours is the header nav's job, and a second
     copy of it sitting over the search card only asked the same question
     twice. The band (route + headline) sits ABOVE the trip-type pill and the
     search card, in that order — the traveller reads the journey before being
     asked to edit it.
     ===================================================================== */
  const CITY_IMG = {
    HYD: 'hyderabad', BOM: 'mumbai', DEL: 'delhi', BLR: 'bengaluru', SXR: 'kashmir',
    JAI: 'jaipur', CCU: 'kolkata', VGA: 'vijayawada', TIR: 'tirupati', GOI: 'goa', GOX: 'goa',
    DXB: 'dubai', DPS: 'bali', BKK: 'thailand', DMK: 'thailand',
    /* NOT the destination set's own files for these two: `maldives` is a
       photograph of one resort (Anantara Kihavah) and `singapore` of one
       hotel (Marina Bay Sands). A city is shown by a landmark, never by a
       property. These landmark files ship at 480/960 only. */
    MLE: 'loc:maldives__artificial-beach', SIN: 'loc:singapore__merlion-park',
    /* HKT is Phuket, not Bangkok: the `thailand` file is Wat Arun. */
    HKT: 'loc:thailand__big-buddha-phuket',
  };
  /** srcset + src for a CITY_IMG value. */
  function cityArt(slug) {
    if (slug.indexOf('loc:') === 0) {
      const b = 'assets/locations/' + slug.slice(4);
      return { srcset: b + '-480.webp 480w, ' + b + '.webp 960w', src: b + '.webp' };
    }
    const b = 'assets/destinations/' + slug;
    return { srcset: b + '-480.webp 480w, ' + b + '-1600.webp 1600w', src: b + '-1600.webp' };
  }
  /* The in-hero product-tab strip (PRODUCTS / productTabs) was removed: the
     site header is the one product navigation, and neither the Flights nor the
     Hotels hero repeats it over the search card any more. */
  const JH_ARC = 'M60 150 Q300 -30 540 150';

  function journeyHero() {
    const hero = document.getElementById('siteHero');
    const head = document.querySelector('.tx-head');
    const dock = document.getElementById('heroSearchDock');
    if (!hero || !head || !dock || hero.dataset.jh) return;
    hero.dataset.jh = '1';
    hero.classList.add('jp-jh');

    const media = document.createElement('div');
    media.className = 'jp-jh__media';
    media.setAttribute('aria-hidden', 'true');
    hero.insertBefore(media, hero.firstChild);

    /* THE JOURNEY — the destination photo, the route and the headline — is
       all this hero holds. Inserted before `dock` so it lands ahead of the
       search card. Neither the trip type nor the product tabs is repeated
       here: the trip type (One Way / Round / Multi City) is the premium
       BookingCard's own control, and Flights / Hotels / Tours already live in
       the site header, so a bar over the card would be a second navigation. */
    const band = document.createElement('div');
    band.className = 'wrap jp-jh__band';
    band.innerHTML = '<svg class="jp-jh__route" viewBox="0 0 600 190" aria-hidden="true" focusable="false">'
      + '<path class="g" d="' + JH_ARC + '"/><path class="d" d="' + JH_ARC + '" pathLength="1"/>'
      + '<circle class="n" cx="60" cy="150" r="6"/><circle class="n n--to" cx="540" cy="150" r="6"/>'
      + '<circle class="h" cx="540" cy="150" r="16"/>'
      + '<text class="c" x="60" y="184" text-anchor="middle"></text><text class="c c--to" x="540" y="184" text-anchor="middle"></text>'
      + '<g class="p"><path d="M13 0 4.3 -1.9 -1.4 -10.8 -4.6 -10.8 -.9 -2 -7.2 -1.9 -10.1 -5.5 -12.4 -5.5 -10.5 0 -12.4 5.5 -10.1 5.5 -7.2 1.9 -.9 2 -4.6 10.8 -1.4 10.8 4.3 1.9Z"/>'
      + '<animateMotion dur="2.2s" begin="indefinite" fill="freeze" rotate="auto" calcMode="spline" keyPoints="0;0.5" keyTimes="0;1" keySplines=".22 1 .36 1" path="' + JH_ARC + '"/></g>'
      + '</svg>';
    /* A STATIC LINE, NOT A PER-DESTINATION ONE. The destinations API carries
       no description field (home-destinations.js dropped fabricated per-city
       copy for the same reason: there is no real copy behind it), so this
       reads the same for every route rather than inventing travel-guide
       sentences about cities the app has no facts about. */
    const tagline = document.createElement('p');
    tagline.className = 'jp-jh__tagline';
    tagline.textContent = 'Compare real-time fares across airlines and lock in your seat in minutes.';
    const sub = head.querySelector('#txFlightsSub');
    if (sub) sub.insertAdjacentElement('afterend', tagline); else head.appendChild(tagline);

    band.appendChild(head);
    hero.insertBefore(band, dock);

    /* NO TRIP BAR, NO FOLD, NO #ssTrip WIRING. The premium BookingCard carries
       its own trip-type control (One Way / Round / Multi City) and collapses
       itself to a one-line summary (setCollapsed) that its Edit handle re-opens,
       so the hero's old trip-pill bar, dock-fold and #ssTrip driving are gone
       with the search strip they served. */

    let current = '';
    function paint() {
      const q = new URLSearchParams(location.search);
      const from = (q.get('from') || 'HYD').toUpperCase().slice(0, 4);
      const to = (q.get('to') || '').toUpperCase().slice(0, 4);
      const svg = band.querySelector('.jp-jh__route');
      svg.querySelector('.c').textContent = from;
      svg.querySelector('.c--to').textContent = to || '···';
      hero.classList.toggle('has-dest', !!to);
      const slug = CITY_IMG[to] || (!to && CITY_IMG[from]) || '';
      if (slug === current) return;
      current = slug;
      const old = media.querySelector('img');
      if (old) { old.classList.add('is-leaving'); setTimeout(() => old.remove(), 900); }
      hero.classList.toggle('has-img', !!slug);
      if (!slug) return;
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.className = 'ds-dev';
      img.sizes = '100vw';
      const art = cityArt(slug);
      img.srcset = art.srcset;
      img.src = art.src;
      media.appendChild(img);
      DS.develop(img);
    }
    function fly() {
      const svg = band.querySelector('.jp-jh__route');
      requestAnimationFrame(() => band.classList.add('is-drawn'));
      const m = svg.querySelector('animateMotion');
      if (DS.reduce) { band.classList.add('is-drawn'); return; }
      if (m && m.beginElement) setTimeout(() => m.beginElement(), 250);
    }
    paint();
    fly();
    /* The renderer rewrites the H1 after every search; the URL is written in
       the same pass, so read it on the next tick. */
    const h1 = head.querySelector('h1');
    let last = h1 ? h1.textContent : '';
    if (h1) new MutationObserver(() => {
      if (h1.textContent === last) return;
      last = h1.textContent;
      setTimeout(() => {
        paint();
        band.classList.remove('is-drawn'); void band.offsetWidth; fly();
      }, 0);
    }).observe(h1, { childList: true, characterData: true, subtree: true });
  }

  /* =====================================================================
     THE STAY HERO (hotels.html)
     =====================================================================
     Flights' journey hero, for a stay. The band carries the searched city's
     photograph — THE hotel resolver's verified CITY photograph, captioned on
     the band as a destination photo, because no single hotel is the search —
     the product tabs, the Results H1 (moved, ids intact, the way Flights
     moves its heading) and, where Flights draws the route, the NIGHTS: an arc
     from check-in to check-out with one moon per night, drawn once when the
     stay changes. Reads the stay from the URL, which hotel-results.js keeps
     current, and repaints on `hr:searchchange` and on Back/Forward.
     On the booking screens (body.hr-booking) the band folds away and only
     the strip remains — CSS, not script.
     ===================================================================== */
  const SH_ARC = 'M60 150 Q300 10 540 150';

  function stayHero() {
    const hero = document.getElementById('siteHero');
    const head = document.querySelector('#hrRoot .hr-results-head');
    const dock = document.getElementById('heroSearchDock');
    if (!hero || !head || !dock || hero.dataset.jh) return;
    hero.dataset.jh = '1';
    hero.classList.add('jp-jh', 'jp-sh');

    const media = document.createElement('div');
    media.className = 'jp-jh__media';
    media.setAttribute('aria-hidden', 'true');
    hero.insertBefore(media, hero.firstChild);

    /* NO PRODUCT-TAB BAR HERE. The Flights hero carries no Flights/Hotels/Tours
       strip (the site header is the product nav), and for one unified results
       design the Hotels hero must not either — a second product navigation over
       the search card asked the same question the header already answers. */

    const band = document.createElement('div');
    band.className = 'wrap jp-jh__band jp-sh__band';
    band.innerHTML = '<svg class="jp-sh__nights" viewBox="0 0 600 200" aria-hidden="true" focusable="false">'
      + '<path class="g" d="' + SH_ARC + '"/><path class="d" d="' + SH_ARC + '" pathLength="1"/>'
      + '<g class="m"></g>'
      + '<circle class="n" cx="60" cy="150" r="6"/><circle class="n n--to" cx="540" cy="150" r="6"/>'
      + '<text class="c" x="60" y="184" text-anchor="middle"></text><text class="c c--to" x="540" y="184" text-anchor="middle"></text>'
      + '<text class="w" x="60" y="130" text-anchor="middle">CHECK-IN</text><text class="w" x="540" y="130" text-anchor="middle">CHECK-OUT</text>'
      + '<text class="k" x="300" y="112" text-anchor="middle"></text>'
      + '</svg>';
    band.appendChild(head);
    const stay = document.createElement('p');
    stay.className = 'jp-sh__stay';
    head.appendChild(stay);
    hero.insertBefore(band, dock);

    const cap = document.createElement('p');
    cap.className = 'wrap jp-sh__cap';
    hero.appendChild(cap);

    /* PHONES: the strip folds to one line, exactly as on Flights. */
    const sum = document.createElement('button');
    sum.type = 'button';
    sum.className = 'jp-jh__sum';
    sum.setAttribute('aria-controls', 'heroSearchDock');
    sum.setAttribute('aria-expanded', 'false');
    hero.insertBefore(sum, dock);
    hero.classList.add('jp-fold');
    sum.addEventListener('click', () => {
      const open = hero.classList.toggle('jp-unfold');
      sum.setAttribute('aria-expanded', String(open));
      if (open) { const f = dock.querySelector('input, select, button'); if (f) setTimeout(() => f.focus(), 80); }
    });

    const day = iso => {
      const d = iso ? new Date(iso + 'T00:00:00') : null;
      return d && !isNaN(d) ? d : null;
    };
    const fmt = (d, o) => d.toLocaleDateString('en-IN', o);

    let currentImg = '', lastKey = '';
    function paint() {
      const q = new URLSearchParams(location.search);
      const dest = (q.get('dest') || '').trim();
      const ci = day(q.get('checkIn')), co = day(q.get('checkOut'));
      const rooms = Math.max(1, Number(q.get('rooms')) || 1);
      const guests = Math.max(1, Number(q.get('guests')) || 2);
      const n = ci && co ? Math.max(1, Math.round((co - ci) / 86400000)) : 0;

      const svg = band.querySelector('.jp-sh__nights');
      svg.querySelector('.c').textContent = ci ? fmt(ci, { day: '2-digit', month: 'short' }).toUpperCase() : '···';
      svg.querySelector('.c--to').textContent = co ? fmt(co, { day: '2-digit', month: 'short' }).toUpperCase() : '···';
      svg.querySelector('.k').textContent = n ? n + (n === 1 ? ' NIGHT' : ' NIGHTS') : '';
      /* One moon per night along the arc; beyond ten the arc says the number
         and the moons stop, rather than crowding into a bead chain. */
      const moons = svg.querySelector('.m');
      const path = svg.querySelector('.g');
      moons.innerHTML = '';
      const shown = Math.min(n, 10);
      if (shown && path.getTotalLength) {
        const L = path.getTotalLength();
        for (let i = 0; i < shown; i++) {
          const p = path.getPointAtLength(L * (i + 0.5) / shown);
          /* Position on the outer group (an SVG attribute), motion on the
             inner one (CSS) — a CSS transform would replace the attribute. */
          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          g.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')');
          g.innerHTML = '<g class="mo" style="--i:' + i + '"><circle r="7"/><circle class="cut" r="6" cx="3.4" cy="-2.4"/></g>';
          moons.appendChild(g);
        }
      }

      const stayLine = [
        ci ? fmt(ci, { weekday: 'short', day: 'numeric', month: 'short' }) + ' – ' + (co ? fmt(co, { weekday: 'short', day: 'numeric', month: 'short' }) : '') : '',
        rooms + (rooms === 1 ? ' room' : ' rooms'),
        guests + (guests === 1 ? ' guest' : ' guests'),
      ].filter(Boolean).join('  ·  ');
      stay.textContent = stayLine;
      sum.innerHTML = '<span class="jp-jh__sum-route">' + DS.esc(dest || 'All destinations') + '</span>'
        + '<span class="jp-jh__sum-meta">' + DS.esc(stayLine) + '</span>'
        + '<span class="jp-jh__sum-edit">Edit</span>';

      /* The city's photograph — a destination photo, never a hotel. */
      const photo = (dest && typeof HotelPhoto !== 'undefined') ? HotelPhoto.resolve({ name: '', city: dest }) : null;
      const ok = photo && photo.kind === 'destination';
      cap.textContent = ok
        ? photo.subject + ' — destination photo, not a hotel'
        : '';
      hero.classList.toggle('has-img', !!ok);
      const key = ok ? photo.srcBig : '';
      if (key !== currentImg) {
        currentImg = key;
        const old = media.querySelector('img');
        if (old) { old.classList.add('is-leaving'); setTimeout(() => old.remove(), 900); }
        if (ok) {
          const img = new Image();
          img.alt = '';
          img.decoding = 'async';
          img.className = 'ds-dev';
          img.sizes = '100vw';
          img.srcset = photo.srcset;
          img.src = photo.srcBig;
          media.appendChild(img);
          DS.develop(img);
        }
      }

      const k = [q.get('checkIn'), q.get('checkOut'), dest].join('|');
      if (k !== lastKey) { lastKey = k; draw(); }
    }
    function draw() {
      band.classList.remove('is-drawn');
      void band.offsetWidth;
      requestAnimationFrame(() => band.classList.add('is-drawn'));
    }
    paint();
    document.addEventListener('hr:searchchange', () => setTimeout(paint, 0));
    window.addEventListener('popstate', () => setTimeout(paint, 0));
    /* The renderer rewrites the H1 after every search, in the same pass that
       rewrites the URL. */
    const h1 = head.querySelector('h1');
    if (h1) new MutationObserver(() => setTimeout(paint, 0))
      .observe(h1, { childList: true, characterData: true, subtree: true });
  }

  /* The journey band is inserted before #heroSearchDock, so wait for that
     anchor to exist. hero-shell.js builds the dock during its own mount; a few
     frames of grace for a slow one. (It used to wait on the strip's #ssTrip,
     but the flights dock now holds the premium BookingCard, which has none.) */
  function whenHeroDock(fn, tries) {
    if (document.getElementById('heroSearchDock') || (tries || 0) > 20) fn();
    else setTimeout(() => whenHeroDock(fn, (tries || 0) + 1), 50);
  }
  /* The hotel card's strip is built by the same boot; wait for its fields. */
  function whenDock(fn, tries) {
    if (document.getElementById('ssDest') || (tries || 0) > 20) fn();
    else setTimeout(() => whenDock(fn, (tries || 0) + 1), 50);
  }
  const init = () => {
    document.querySelectorAll('[data-ds-results]').forEach(watch);
    if (document.body.dataset.spService === 'flights') {
      const go = () => whenHeroDock(journeyHero);
      if (document.readyState === 'complete') go();
      else window.addEventListener('DOMContentLoaded', () => setTimeout(go, 0), { once: true });
    }
    if (document.body.dataset.spService === 'hotels') {
      const go = () => whenDock(stayHero);
      if (document.readyState === 'complete') go();
      else window.addEventListener('DOMContentLoaded', () => setTimeout(go, 0), { once: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  window.JWProducts = { watch };
})();
