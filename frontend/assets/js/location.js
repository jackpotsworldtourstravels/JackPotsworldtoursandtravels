'use strict';
/* ===========================================================================
   location.js — one famous place: its photograph, its price, its story.
   ===========================================================================
   THE THIRD STEP of Destination -> famous places -> this -> hotels, and the
   only one that had no page. "View Hotels" jumped straight from a card to a
   hotel list, so everything the traveller might want to know about the place
   itself — what it looks like, what it is, what going there costs — had
   nowhere to be.

   ONE REQUEST, AND IT DECIDES EVERYTHING ON THE PAGE:

       GET /api/customer/destinations/{destination}/attractions/{slug}

   name, city, country, description, photograph keys, fares, hotels nearby,
   the other places in the same city and the guidebook fields added by
   migration 0080 all come from that one answer. NOTHING about a particular
   landmark is written here: no name, no price, no history, no image path that
   is not derived from a key the API sent. A place added through the catalogue
   has this page working the same day.

   WHAT IT REFUSES TO INVENT, which is most of what a page like this usually
   makes up:

     a rating      Only a recorded one, and only with its source printed
                   beside it (0082) - "4.6 Google Maps" is a citation, "4.6"
                   alone is this site claiming travellers said so. No source,
                   no chip; nothing is averaged out of the nothing in
                   customer_reviews.
     a distance    "Top attractions nearby" names each place's nearest listed
                   area instead of "2.4 km away": this catalogue holds no
                   coordinates, and a kilometre figure would be a guess
                   wearing a decimal point.
     a fare        A card with no figure says "Currently unavailable". Flights
                   and packages both do today, and the API's own field
                   descriptions say why.
     a guidebook   best time, duration, history, how to reach, tips and the
                   gallery are editorial columns that ship EMPTY. Each section
                   is hidden until its column is filled — the page is shorter,
                   never padded.

   None of those states is an error, and none of them is filled in with
   something plausible.
   =========================================================================== */
(function () {
  const statusEl = document.getElementById('lpStatus');
  const body = document.getElementById('lpBody');
  if (!statusEl || !body) return;

  /* /destination/hyderabad/charminar -> ['hyderabad', 'charminar'] */
  const parts = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const slug = decodeURIComponent(parts.pop() || '').trim();
  const dest = decodeURIComponent(parts.pop() || '').trim();

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const icon = (name, size) => (typeof JPIcon !== 'undefined' && JPIcon.html)
    ? JPIcon.html(name, { size: size || 16 }) : '';

  const show = (el, on) => { if (el) el.hidden = !on; };

  /* The same resolver rule the cards use: a KEY from the API, present in the
     shipped manifest, or no picture at all. */
  const artFor = key => {
    if (!key || typeof LOCATION_IMAGE_FILES !== 'object' || !LOCATION_IMAGE_FILES) return null;
    const stamp = LOCATION_IMAGE_FILES[key];
    if (!stamp) return null;
    const dir = (typeof LOCATION_IMAGE_DIR === 'string') ? LOCATION_IMAGE_DIR : 'assets/locations/';
    /* ?v=<stamp> WHEN THE MANIFEST CARRIES ONE. The path is derived from the
       key, so replacing a photograph changes the bytes behind a URL that does
       not change - and a browser that has been here keeps the old picture.
       The manifest's value is a content stamp of that file, so the URL moves
       when the picture does. An older manifest whose values are `true` yields
       no query and behaves exactly as before. */
    const v = (typeof stamp === 'string') ? '?v=' + stamp : '';
    return { src: dir + key + '.webp' + v, small: dir + key + '-480.webp' + v };
  };

  /* The site's own money formatter where it is loaded, and a plain rupee
     figure where it is not. Never a hand-rolled thousands separator. */
  const money = n => {
    if (n == null) return null;
    if (typeof formatMoney === 'function') return formatMoney(n);
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR', maximumFractionDigits: 0,
      }).format(n);
    } catch { return '₹' + Math.round(n); }
  };

  /* The HOTEL shelf's artwork, for the three cards under "Hotels near". Its
     own manifest and directory, written by scripts/fetch_hotel_images.py; the
     same contract as the other two - a key the API sent, present here, or no
     picture. */
  const hotelArtFor = key => {
    if (!key || typeof HOTEL_IMAGE_FILES !== 'object' || !HOTEL_IMAGE_FILES) return null;
    const stamp = HOTEL_IMAGE_FILES[key];
    if (!stamp) return null;
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    const v = (typeof stamp === 'string') ? '?v=' + stamp : '';
    return { src: dir + key + '.webp' + v, small: dir + key + '-480.webp' + v };
  };

  /* The CITY's artwork, for the packages card: a picture of the destination is
     the honest illustration for "a tour of this place". Third manifest, same
     contract - a key the API sent, present in the shipped list, or nothing. */
  const destArtFor = key => {
    if (!key || typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES) return null;
    const stamp = DESTINATION_IMAGE_FILES[key];
    if (!stamp) return null;
    const dir = (typeof DESTINATION_IMAGE_DIR === 'string') ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    const v = (typeof stamp === 'string') ? '?v=' + stamp : '';
    return { src: dir + key + '.webp' + v, small: dir + key + '-480.webp' + v };
  };

  /* THE ONE PICTURE ON THIS PAGE THAT IS NOT OF ANYWHERE. The flights card
     needs an aeroplane and this database holds no photograph of one, so it
     borrows the site's own landing image - the same file index.html opens
     with. It sits behind the words "flights from" and illustrates nothing
     more than that; no route, no aircraft, no carrier is being claimed.
     Both entries are that single asset, which is why `small` is not a
     narrower file: there is only one. */
  const FLIGHT_ART = { src: 'assets/images/hero-sunset.webp', small: 'assets/images/hero-sunset.webp' };

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  /* Paragraphs, from text somebody typed into a database column. A blank line
     starts a new one and a single newline is a line break; nothing else in the
     string is interpreted, and every character is escaped on the way in. */
  const paras = text => String(text || '')
    .split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');

  /* ======================================================================
     THE HERO
     ====================================================================== */
  function renderHero(a, shots, art) {
    document.getElementById('lpTitle').textContent = a.name;

    /* The trail the traveller came down, so a page entered from a search
       result still says where it sits. */
    const crumbs = document.getElementById('lpCrumbs');
    crumbs.innerHTML = [
      '<a href="index.html">Home</a>',
      '<a href="index.html#destinations">Destinations</a>',
      `<a href="destination/${esc(a.destination_id)}">${esc(a.destination_name)}</a>`,
      `<span aria-current="page">${esc(a.name)}</span>`,
    ].join('<span class="lp-crumb-sep" aria-hidden="true">/</span>');
    show(crumbs, true);

    const where = [a.destination_name, a.country].filter(Boolean).join(', ');
    if (where) {
      const badge = document.getElementById('lpBadge');
      badge.innerHTML = icon('mapPin', 15) + `<span>${esc(where)}</span>`;
      show(badge, true);
    }

    /* The one-liner goes in the hero only when there is a longer read below
       it. With nothing else written about the place, that one line IS the
       About section, and printing it twice would make the page look padded. */
    if (a.long_description && a.description) {
      const lead = document.getElementById('lpLead');
      lead.textContent = a.description;
      show(lead, true);
    }

    /* THE PHOTOGRAPH IS THE HERO, full width, with the name over it. It is the
       one image on the page loaded eagerly - it is the first thing on screen,
       and lazily loading what somebody is already looking at is a blank box
       for no saving. The name and city live in the markup, so the hero reads
       correctly before the picture arrives and if it never does.

       THE CITY'S PHOTOGRAPH COMES FIRST, NOT THE LANDMARK'S. The attraction
       photographs are documentary shots of one building, usually taken close
       enough to fill the frame with masonry - cropped to a wide hero they
       become a wall. The destinations shelf's picture is the wide view of the
       same place, which is what a hero wants; the landmark's own photograph
       is then the one standing beside About, where its detail is the point. */
    const hero = document.getElementById('lpHero');
    if (art) {
      const img = document.createElement('img');
      img.className = 'lp-hero-img';
      img.src = art.src;
      img.srcset = art.small + ' 480w, ' + art.src + ' 960w';
      img.sizes = '100vw';
      img.alt = '';                /* decorative: the name is on top of it */
      img.decoding = 'async';
      img.fetchPriority = 'high';
      img.addEventListener('error', () => img.remove());
      hero.insertBefore(img, hero.firstChild);
      /* The hero gets the slower beat - it is the subject of the page. */
      if (typeof JWMotion !== 'undefined') JWMotion.develop(img, { hero: true });
    } else {
      hero.insertAdjacentHTML('afterbegin', `<span class="lp-hero-pin">${icon('mapPin', 40)}</span>`);
    }

    /* The strip under the name: how many photographs there are, a map link
       and a jump to the gallery - each present only when there is something
       behind it. The map link exists only when somebody checked one into the
       row, because this table holds no coordinates to build one from. */
    let any = false;
    /* THE RATING, WHEN THERE IS ONE AND IT SAYS WHOSE IT IS. The API sends a
       score only together with its source (0082) and the chip prints both, so
       "4.6 Google Maps" is a citation rather than this site quietly claiming
       travellers rated the place. No source, no score, no chip. */
    if (a.rating != null && a.rating_source) {
      const el = document.getElementById('lpRating');
      const count = a.rating_count
        ? ` <span class="lp-rating-count">(${a.rating_count.toLocaleString('en-IN')})</span>` : '';
      el.innerHTML = icon('star', 14)
        + `<span><strong>${esc(a.rating.toFixed(1))}</strong>${count}</span>`
        + `<span class="lp-rating-src">${esc(a.rating_source)}</span>`;
      show(el, true);
      any = true;
    }
    if (shots.length > 1) {
      const el = document.getElementById('lpShots');
      el.innerHTML = icon('camera', 14) + `<span>${shots.length} photographs</span>`;
      show(el, true);

      const gb = document.getElementById('lpGalleryBtn');
      gb.innerHTML = icon('eye', 14) + '<span>View gallery</span>';
      gb.addEventListener('click', () => {
        const sec = document.getElementById('lpGallerySec');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      show(gb, true);
      any = true;
    }
    if (a.map_url) {
      const ml = document.getElementById('lpMapLink');
      ml.href = a.map_url;
      ml.innerHTML = icon('mapPin', 14) + '<span>View on map</span>';
      show(ml, true);
      any = true;
    }
    show(document.getElementById('lpHeroMeta'), any);
  }

  /* ======================================================================
     FARES — three photographs you can book from
     ======================================================================
     EACH CARD IS A PICTURE OF WHAT IT SELLS, and each picture is one this
     site already ships:

       flights   the aeroplane the landing page opens with - a site asset,
                 decoration, and not a claim about any route.
       hotels    THE HOTEL THE PRICE BELONGS TO. The API sends the cheapest
                 listed room's own image key beside its figure, so ₹11,200 is
                 shown over the building it is charged by rather than over a
                 stock room from a photo library.
       packages  the destination's own photograph, the same key the
                 destinations shelf resolves.

     A card with no photograph keeps the layout and loses the picture; it
     never falls back to something taken somewhere else. */
  function fareCard(o) {
    const has = o.value != null;
    const figure = has
      ? esc(money(o.value)) + (o.suffix ? `<span>${esc(o.suffix)}</span>` : '')
      : 'Currently unavailable';
    /* With no photograph the card keeps its shape and shows the mark for what
       it sells - an aeroplane, a bed, a case. A drawn icon is honestly a
       drawing; a photograph of somebody else's hotel would not be. */
    return `<article class="lp-fare${has ? '' : ' is-empty'}${o.art ? '' : ' is-artless'}">
      <div class="lp-fare-art" aria-hidden="true">${o.art
        ? `<img src="${esc(o.art.small)}" srcset="${esc(o.art.small)} 480w, ${esc(o.art.src)} 960w"
               sizes="(max-width: 700px) 92vw, 420px" alt="" loading="lazy" decoding="async"
               onerror="this.remove()">`
        : `<span class="lp-fare-mark">${icon(o.mark, 64)}</span>`}</div>
      <div class="lp-fare-body">
        <p class="lp-fare-label">${esc(o.label)}</p>
        <p class="lp-fare-value">${figure}</p>
        ${o.credit ? `<p class="lp-fare-credit">${esc(o.credit)}</p>` : ''}
        ${o.href ? `<a class="disc-btn" href="${esc(o.href)}">${esc(o.cta)} ${icon('arrowRight', 15)}</a>` : ''}
      </div>
    </article>`;
  }

  function renderFares(a, shots, heroArt) {
    const f = a.fare_details || {};
    /* The hotels button is the only one that can lead somewhere empty, so it
       is the only one that disappears when there is nothing behind it.
       Flights and packages open a live search, which is a real destination
       whatever this landmark's figures say. */
    const hotelsHref = (Number(a.hotel_count) || 0) > 0
      ? 'hotels/' + encodeURIComponent(a.destination_id) + '/' + encodeURIComponent(a.slug)
      : null;
    const here = shots.length ? shots[0].art : null;
    /* THE PACKAGES CARD TAKES WHICHEVER PICTURE THE HERO DID NOT. Both the
       city's photograph and the landmark's are true illustrations of "a tour
       of this place"; showing the hero's again, a screen further down, just
       looks like the page ran out of pictures. */
    const city = destArtFor(a.destination_image);
    /* BY `src`, NOT BY IDENTITY: each resolver builds a fresh object, so two
       calls for the same key are never the same reference. */
    const notHero = [city, here].find(x => x && (!heroArt || x.src !== heroArt.src))
      || city || here;

    document.getElementById('lpFares').innerHTML = [
      fareCard({
        art: FLIGHT_ART, mark: 'planeTakeoff', label: 'Flights from', value: f.flight_from,
        href: 'flights.html', cta: 'Search flights',
      }),
      fareCard({
        art: hotelArtFor(f.hotel_image) || here, mark: 'bedDouble', label: 'Hotels from',
        value: f.hotel_from, suffix: ' / night', href: hotelsHref, cta: 'View hotels',
        /* Named, because the photograph is of a particular hotel and the
           price is that hotel's - the card should say whose. */
        credit: f.hotel_from != null && f.hotel_name ? 'at ' + f.hotel_name : '',
      }),
      fareCard({
        art: notHero, mark: 'luggage', label: 'Tour packages from',
        value: f.package_from, href: 'packages.html', cta: 'Explore packages',
      }),
    ].join('');

    /* Where the hotel figure came from, said out loud: a price from the area
       next door is a different promise from a price "at the monument". */
    document.getElementById('lpFareNote').textContent =
      f.hotel_from != null && f.hotel_scope_name
        ? `Hotel rate is the lowest nightly price we list in ${f.hotel_scope_name}. Flight and package fares are searched live and are not quoted here.`
        : 'Fares for this location are searched live and are not quoted here.';
  }

  /* ======================================================================
     THE INFORMATION STRIP — editorial columns, empty until somebody edits
     ====================================================================== */
  function tile(iconName, label, value, note) {
    return `<div class="lp-quick-tile">
      <span class="lp-quick-icon">${icon(iconName, 18)}</span>
      <div class="lp-quick-text">
        <p class="lp-quick-label">${esc(label)}</p>
        <p class="lp-quick-value">${esc(value)}</p>
        ${note ? `<p class="lp-quick-note">${esc(note)}</p>` : ''}
      </div>
    </div>`;
  }

  function chipTile(iconName, label, items) {
    return `<div class="lp-quick-tile">
      <span class="lp-quick-icon">${icon(iconName, 18)}</span>
      <div class="lp-quick-text">
        <p class="lp-quick-label">${esc(label)}</p>
        <p class="lp-chips">${items.map(v => `<span>${esc(v)}</span>`).join('')}</p>
      </div>
    </div>`;
  }

  function renderQuick(a) {
    const tiles = [];
    if (a.best_time) tiles.push(tile('calendarDays', 'Best time to visit', a.best_time, a.best_time_note));
    if (a.ideal_duration) tiles.push(tile('clock3', 'Ideal duration', a.ideal_duration, a.ideal_duration_note));
    if ((a.famous_for || []).length) tiles.push(chipTile('star', 'Famous for', a.famous_for));
    if ((a.recommended_for || []).length) tiles.push(chipTile('usersRound', 'Recommended for', a.recommended_for));
    if (!tiles.length) return;            /* no strip rather than an empty one */
    document.getElementById('lpQuick').innerHTML = tiles.join('');
    show(document.getElementById('lpQuickSec'), true);
  }

  /* ======================================================================
     ABOUT — the long read, with the facts beside it
     ====================================================================== */
  function renderAbout(a, shots) {
    const text = a.long_description || a.description;
    const facts = [];
    const where = [a.destination_name, a.country].filter(Boolean).join(', ');
    if (where) facts.push(['Where', where]);
    if (a.area_name) facts.push(['Nearest listed area', a.area_name]);
    if ((Number(a.hotel_count) || 0) > 0) facts.push(['Hotels listed nearby', String(a.hotel_count)]);
    if (!text && !facts.length) return;

    document.getElementById('lpAboutH').textContent = 'About ' + a.name;
    const box = document.getElementById('lpAbout');
    box.innerHTML = text ? paras(text) : '';

    /* READ MORE APPEARS ONLY WHEN THERE IS MORE. The clamp goes on first and
       the button is offered only if the text is genuinely taller than it - a
       "read more" that reveals one more line is furniture. */
    if (text) {
      box.classList.add('is-clamped');
      const btn = document.getElementById('lpReadMore');
      requestAnimationFrame(() => {
        if (box.scrollHeight - box.clientHeight < 24) { box.classList.remove('is-clamped'); return; }
        show(btn, true);
        btn.addEventListener('click', () => {
          const clamped = box.classList.toggle('is-clamped');
          btn.textContent = clamped ? 'Read more' : 'Read less';
          btn.setAttribute('aria-expanded', String(!clamped));
        });
      });
    }

    if (facts.length) {
      document.getElementById('lpFactsList').innerHTML = facts
        .map(pair => `<div><dt>${esc(pair[0])}</dt><dd>${esc(pair[1])}</dd></div>`).join('');
      show(document.getElementById('lpFacts'), true);
    }

    /* THE LANDMARK'S OWN PHOTOGRAPH GOES HERE. The hero is the wide view of
       the city, so this column is where the thing the article is about
       actually appears - close, tall, beside the paragraphs describing it. It
       falls back to the city's picture only when no photograph of the
       landmark shipped, and to nothing at all when neither did: the grid is
       one column then and the article simply fills it. */
    const aside = (shots.length ? shots[0].art : null)
      || destArtFor(a.destination_image);
    if (aside) {
      document.getElementById('lpAboutArt').innerHTML =
        `<img src="${esc(aside.small)}" srcset="${esc(aside.small)} 480w, ${esc(aside.src)} 960w"
              sizes="(max-width: 900px) 92vw, 430px" alt="${esc(a.name)}"
              loading="lazy" decoding="async" onerror="this.closest('figure').remove()">`;
      show(document.getElementById('lpAboutArt'), true);
      if (typeof JWMotion !== 'undefined') JWMotion.developAll(document.getElementById('lpAboutArt'));
    }
    show(document.getElementById('lpAboutSec'), true);
  }

  /* ======================================================================
     THE OTHER PLACES — located by their area, never by an invented distance
     ====================================================================== */
  function renderNearby(a) {
    const more = a.nearby || [];
    if (!more.length) return;
    document.getElementById('lpMoreLine').textContent =
      'More famous places in ' + a.destination_name + '.';
    document.getElementById('lpMoreAll').href =
      'destination/' + encodeURIComponent(a.destination_id);

    document.getElementById('lpMore').innerHTML = more.map(o => {
      const oart = artFor(o.image);
      /* NO KILOMETRES. customer_attractions holds no coordinates, so the only
         true "where" available is the area each place is filed under. */
      const near = o.area_name
        ? `<span class="lp-near-where">${icon('mapPin', 13)}<span>${esc(o.area_name)}</span></span>` : '';
      const line = o.description ? `<span class="lp-near-text">${esc(o.description)}</span>` : '';
      return `<a class="lp-near" role="listitem"
         href="destination/${esc(o.destination_id)}/${esc(o.slug)}">
        <span class="lp-near-art">${oart
          ? `<img src="${esc(oart.small)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
          : icon('mapPin', 22)}</span>
        <span class="lp-near-body">
          <span class="lp-near-name">${esc(o.name)}</span>
          ${near}${line}
        </span>
      </a>`;
    }).join('');
    /* The photographs develop; a card whose landmark has no approved
       picture keeps its drawn pin and is left alone - developAll only ever
       touches <img>. */
    if (typeof JWMotion !== 'undefined') JWMotion.developAll(document.getElementById('lpMore'));
    show(document.getElementById('lpMoreSec'), true);
  }

  /* ======================================================================
     PLAN YOUR VISIT — three editorial columns, each hidden when empty
     ====================================================================== */
  function renderPlan(a) {
    const blocks = [];
    if (a.history) {
      blocks.push(`<div class="lp-card lp-plan-block"><h3>${icon('info', 17)} History</h3>${paras(a.history)}</div>`);
    }
    if (a.how_to_reach) {
      blocks.push(`<div class="lp-card lp-plan-block"><h3>${icon('mapPin', 17)} How to reach</h3>${paras(a.how_to_reach)}</div>`);
    }
    if ((a.travel_tips || []).length) {
      blocks.push(`<div class="lp-card lp-plan-block"><h3>${icon('star', 17)} Travel tips</h3>
        <ul class="lp-tips">${a.travel_tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`);
    }
    if (!blocks.length) return;
    document.getElementById('lpPlan').innerHTML = blocks.join('');
    show(document.getElementById('lpPlanSec'), true);
  }

  /* ======================================================================
     THE GALLERY — every photograph we hold of this place, in a row
     ====================================================================== */
  function renderGallery(a, shots) {
    if (shots.length < 2) return;        /* the hero alone is not a gallery */
    document.getElementById('lpGalleryH').textContent = a.name + ' in pictures';
    document.getElementById('lpGalleryLine').textContent =
      'Photographs of ' + a.name + ', licensed for reuse and served from this site.';
    document.getElementById('lpGallery').innerHTML = shots.map((s, i) => `
      <figure class="lp-shot" role="listitem">
        <img src="${esc(s.art.small)}" srcset="${esc(s.art.small)} 480w, ${esc(s.art.src)} 960w"
             sizes="(max-width: 640px) 78vw, 340px" alt="${esc(a.name)}"
             loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async"
             onerror="this.closest('figure').remove()">
      </figure>`).join('');
    if (typeof JWMotion !== 'undefined') JWMotion.developAll(document.getElementById('lpGallery'));
    show(document.getElementById('lpGallerySec'), true);
  }

  /* ====================================================================== */
  function render(a) {
    const back = document.getElementById('lpBack');
    back.href = 'destination/' + encodeURIComponent(a.destination_id);
    document.getElementById('lpBackText').textContent = 'Back to ' + a.destination_name;
    document.title = a.name + ' — JackPots World Tours & Travels';

    /* The photographs, resolved once: the API sends KEYS, the manifest says
       which of them shipped, and everything on the page - hero, fare cards,
       gallery - draws from this one list. A key with no file is simply not in
       it, so no section renders a broken image. */
    /* `gallery` already begins with the hero key, but it is an editorial column
       and a row that has never been edited can send it empty - so the hero
       photograph falls back to `image`, the key every card on the site has
       used since the artwork shipped. A page must not lose its photograph
       because nobody has added a second one. */
    const keys = (a.gallery && a.gallery.length) ? a.gallery : (a.image ? [a.image] : []);
    const shots = keys.map(k => ({ key: k, art: artFor(k) })).filter(s => s.art);
    /* One decision, made here and passed down: the hero is the WIDE view -
       the city's photograph where one shipped, the landmark's where it did
       not - and the panels below it are told what it took so that no two of
       them show the same picture. */
    const heroArt = destArtFor(a.destination_image) || (shots.length ? shots[0].art : null);

    renderHero(a, shots, heroArt);
    renderFares(a, shots, heroArt);
    renderQuick(a);
    renderAbout(a, shots);

    /* --- hotels nearby ----------------------------------------------- */
    const n = Number(a.hotel_count) || 0;
    document.getElementById('lpHotelsH').textContent = 'Hotels near ' + a.name;
    const line = document.getElementById('lpHotelsLine');
    const btn = document.getElementById('lpHotelsBtn');
    if (n > 0) {
      line.textContent = `Find comfortable stays${a.area_name ? ' in ' + a.area_name : ''}, the nearest area to ${a.name}.`;
      btn.href = 'hotels/' + encodeURIComponent(a.destination_id) + '/' + encodeURIComponent(a.slug);
      btn.hidden = false;
      /* SHOWN, NOT PROMISED. Three of the hotels the button opens, from the
         endpoint that page itself uses - no second hotel source, no copy of
         its query. It is deliberately not awaited: the page is complete
         without it, and a slow hotel query should not hold up the
         description somebody is already reading. */
      loadHotels(a);
    } else {
      /* Said plainly, with no button to a page that would be empty. */
      line.textContent = 'No hotels currently available around this location.';
      btn.hidden = true;
    }

    renderNearby(a);
    renderPlan(a);
    renderGallery(a, shots);

    statusEl.textContent = '';
    statusEl.hidden = true;
    body.hidden = false;
    body.classList.add('disc-in');
    if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount(body);
  }

  /* Three hotels from the attraction's own hotels endpoint - the same one
     "View Hotels" opens - rendered as cards. Failure is silent by design:
     this is an enrichment under a section that already says what it is and
     already has its button. */
  async function loadHotels(a) {
    const box = document.getElementById('lpHotels');
    if (!box) return;
    try {
      const page = await getJson('/api/customer/attractions/' + encodeURIComponent(a.id)
        + '/hotels?page=1&page_size=3');
      const rows = (page && page.hotels) || [];
      if (!rows.length) { box.innerHTML = ''; return; }
      box.innerHTML = rows.map(h => {
        const hart = hotelArtFor(h.image);
        const price = h.price_per_night != null
          ? `<p class="lp-hotel-price">${esc(money(h.price_per_night))} <span>/ night</span></p>` : '';
        return `<article class="lp-hotel">
          <div class="lp-hotel-art">${hart
            ? `<img src="${esc(hart.small)}" srcset="${esc(hart.small)} 480w, ${esc(hart.src)} 960w"
                   sizes="(max-width: 640px) 100vw, 260px" alt="${esc(h.name || '')}"
                   loading="lazy" decoding="async" onerror="this.remove()">`
            : `<span class="lp-hero-pin">${icon('hotels', 22)}</span>`}</div>
          <div class="lp-hotel-body">
            <h3 class="lp-hotel-name">${esc(h.name || '')}</h3>
            <p class="lp-hotel-where">${esc(h.location || h.location_name || '')}</p>
            ${price}
          </div>
        </article>`;
      }).join('');
      if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount(box);
      if (typeof JWMotion !== 'undefined') JWMotion.developAll(box);
    } catch {
      box.innerHTML = '';
    }
  }

  function failed(text, retry) {
    body.hidden = true;
    statusEl.hidden = false;
    statusEl.textContent = text;
    const old = document.getElementById('lpRetry');
    if (old) old.remove();
    if (!retry) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'lpRetry';
    btn.className = 'dh-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => { btn.remove(); load(); });
    statusEl.insertAdjacentElement('afterend', btn);
  }

  async function load() {
    if (!dest || !slug) { failed('We could not find that place.', false); return; }
    statusEl.hidden = false;
    statusEl.textContent = 'Loading this place…';
    try {
      render(await getJson('/api/customer/destinations/'
        + encodeURIComponent(dest) + '/attractions/' + encodeURIComponent(slug)));
    } catch (err) {
      if (err.status === 404) { failed('We could not find that place.', false); return; }
      failed('We could not load this place just now.', true);
    }
  }

  load();
})();
