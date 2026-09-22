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

   name, city, country, description, photograph key, fares, hotels nearby and
   the other places in the same city all come from that one answer. NOTHING
   about a particular landmark is written here: no name, no price, no
   description, no image path that is not derived from a key the API sent. A
   place added through the catalogue has this page working the same day.

   WHAT IT REFUSES TO INVENT. A fare row with no figure says "Currently
   unavailable" — flights and packages both do today, and the API's own field
   descriptions say why. An empty description removes its heading rather than
   leaving one hanging. No photograph leaves the hero on its tint. None of
   those states is an error and none of them is filled in with something
   plausible.
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

  /* The same resolver rule the cards use: a KEY from the API, present in the
     shipped manifest, or no picture at all. */
  const artFor = key => {
    if (!key || typeof LOCATION_IMAGE_FILES !== 'object' || !LOCATION_IMAGE_FILES) return null;
    if (!LOCATION_IMAGE_FILES[key]) return null;
    const dir = (typeof LOCATION_IMAGE_DIR === 'string') ? LOCATION_IMAGE_DIR : 'assets/locations/';
    return { src: dir + key + '.webp', small: dir + key + '-480.webp' };
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
    if (!HOTEL_IMAGE_FILES[key]) return null;
    const dir = (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';
    return { src: dir + key + '.webp', small: dir + key + '-480.webp' };
  };

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  function fareRow(label, value, suffix) {
    const has = value != null;
    return `<div class="lp-fare${has ? '' : ' is-empty'}">
      <dt>${esc(label)}</dt>
      <dd>${has ? esc(money(value)) + (suffix ? `<span>${esc(suffix)}</span>` : '')
                : '<em>Currently unavailable</em>'}</dd>
    </div>`;
  }

  function render(a) {
    const back = document.getElementById('lpBack');
    back.href = 'destination/' + encodeURIComponent(a.destination_id);
    document.getElementById('lpBackText').textContent = 'Back to ' + a.destination_name;

    document.title = a.name + ' — JackPots World Tours & Travels';
    document.getElementById('lpTitle').textContent = a.name;
    document.getElementById('lpWhere').textContent =
      [a.destination_name, a.country].filter(Boolean).join(', ');

    /* THE PHOTOGRAPH IS THE HERO, full width, with the name over it. It is the
       one image on the page loaded eagerly - it is the first thing on screen,
       and lazily loading what somebody is already looking at is a blank box
       for no saving. The name and city live in the markup, so the hero reads
       correctly before the picture arrives and if it never does. */
    const hero = document.getElementById('lpHero');
    const art = artFor(a.image);
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
    } else {
      hero.insertAdjacentHTML('afterbegin', `<span class="lp-hero-pin">${icon('mapPin', 40)}</span>`);
    }

    /* --- fares ------------------------------------------------------- */
    const f = a.fare_details || {};
    document.getElementById('lpFares').innerHTML = [
      fareRow('Flights from', f.flight_from, ''),
      fareRow('Hotels from', f.hotel_from, ' / night'),
      fareRow('Tour packages from', f.package_from, ''),
    ].join('');
    /* Where the hotel figure came from, said out loud: a price from the area
       next door is a different promise from a price "at the monument". */
    const note = document.getElementById('lpFareNote');
    note.textContent = f.hotel_from != null && f.hotel_scope_name
      ? `Hotel rate is the lowest nightly price we list in ${f.hotel_scope_name}.`
      : 'Fare information is currently unavailable for this location.';

    /* View options goes where the only real figure comes from: the hotels of
       the area this landmark sits in. With no figure there is nothing to
       open, and the button goes rather than leading somewhere empty. */
    const fareBtn = document.getElementById('lpFareBtn');
    if (f.hotel_from != null) {
      fareBtn.href = 'hotels/' + encodeURIComponent(a.destination_id) + '/' + encodeURIComponent(a.slug);
      fareBtn.hidden = false;
    } else {
      fareBtn.hidden = true;
    }

    /* --- about ------------------------------------------------------- */
    if (a.description) {
      document.getElementById('lpAboutH').textContent = 'About ' + a.name;
      document.getElementById('lpAbout').textContent = a.description;
      document.getElementById('lpAboutSec').hidden = false;
    }

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

    /* --- the others -------------------------------------------------- */
    const more = a.nearby || [];
    if (more.length) {
      document.getElementById('lpMore').innerHTML = more.map(o => {
        const oart = artFor(o.image);
        return `<a class="lp-more-card" role="listitem"
           href="destination/${esc(o.destination_id)}/${esc(o.slug)}">
          <span class="lp-more-art">${oart
            ? `<img src="${esc(oart.small)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
            : icon('mapPin', 20)}</span>
          <span class="lp-more-name">${esc(o.name)}</span>
        </a>`;
      }).join('');
      document.getElementById('lpMoreSec').hidden = false;
    }

    statusEl.textContent = '';
    statusEl.hidden = true;
    body.hidden = false;
    body.classList.add('disc-in');
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
