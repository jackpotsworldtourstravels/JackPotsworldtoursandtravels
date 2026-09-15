'use strict';
/* The destination hotels page — /destination/{slug}.
   ---------------------------------------------------------------------------
   ONE FILE, EVERY DESTINATION, AND NO PLACE NAME IN IT. Grep this file for
   'goa', 'hyderabad' or any hotel name and you will find none. The only thing
   it knows is the slug sitting in its own URL; everything else — the
   destination's name, its country, its locations, its hotels and how many
   there are — comes from
   `GET /api/customer/destinations/{slug}/hotels`.

   That is what makes a destination added through the destinations API work
   here immediately, with no frontend change.

   WHAT IT DELIBERATELY DOES NOT DO
   --------------------------------
   It does not print the URL slug as a heading. Title-casing 'vasco-da-gama'
   produces 'Vasco Da Gama', and showing a name for a destination that may not
   exist is worse than showing nothing for a moment. The heading stays "Loading…"
   until a record arrives, and becomes a not-found message if none does.

   It does not show a price unless the API sent one. A catalogue row has no
   nightly rate — the API sends null, not 0 — and the card omits the line
   entirely rather than printing "₹0". Catalogue is not availability: nothing
   on this page claims a room is free on any date.

   It does not invent an image. Photographs come from the project's existing
   resolver (hotel-image-map.js), which falls back to default-hotel.webp and
   reports whether the match was the property itself or merely its brand. */
(function () {
  const grid = document.getElementById('dhGrid');
  const statusEl = document.getElementById('dhStatus');
  const titleEl = document.getElementById('dhTitle');
  const countryEl = document.getElementById('dhCountry');
  const leadEl = document.getElementById('dhLead');
  const locsEl = document.getElementById('dhLocations');
  const moreBtn = document.getElementById('dhMore');
  if (!grid || !statusEl || !titleEl) return;     // not this page

  const PAGE_SIZE = 24;

  /* The slug is the last path segment of /destination/{slug}. Taken from the
     path rather than a query string because that is the URL that was asked
     for, and decodeURIComponent so a slug with an escape survives. */
  const slug = decodeURIComponent(
    (location.pathname.replace(/\/+$/, '').split('/').pop() || '')
  ).trim();

  let destination = null;
  let locations = [];
  let activeLocation = new URLSearchParams(location.search).get('location') || '';
  let page = 1;
  let total = 0;
  let loaded = 0;
  let busy = false;

  const esc = (s) => (typeof escapeHtml === 'function'
    ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  const icon = (name) => (typeof JPIcon !== 'undefined' && JPIcon.html)
    ? JPIcon.html(name, { size: 16 }) : '';

  async function getJson(url) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /* ------------------------------------------------------------------ card */
  function cardHtml(h, index) {
    /* The existing hotel photograph system. `city` helps it disambiguate two
       properties of the same brand; both come from the API record. */
    const media = (typeof hotelImageHtml === 'function')
      ? hotelImageHtml({
          name: h.name,
          city: h.city || h.location_name || '',
          sizes: '(max-width: 720px) 100vw, 260px',
          eager: index < 2,
        })
      : '';

    /* Every block below is conditional on the field actually being present.
       A null becomes nothing, never a placeholder. */
    const stars = (h.stars && typeof JPIcon !== 'undefined' && JPIcon.stars)
      ? `<span class="hr-stars">${JPIcon.stars(h.stars, h.stars)}</span>` : '';

    const rating = (h.guest_rating != null)
      ? `<div class="hr-rating-row">
           <span class="hr-rating">${esc(Number(h.guest_rating).toFixed(1))}</span>
         </div>` : '';

    const where = h.location || h.address || h.city || '';
    const locLine = where ? `<p class="hr-loc">${icon('pin')} ${esc(where)}</p>` : '';

    const desc = h.description
      ? `<p class="dh-desc">${esc(h.description)}</p>` : '';

    const amenities = (h.amenities || []).length
      ? `<div class="hr-amenities">${h.amenities.slice(0, 4).map(a =>
          `<span class="hr-amenity">${icon('check')} ${esc(a)}</span>`).join('')}</div>` : '';

    const free = h.free_cancellation
      ? `<p class="dh-free">${icon('check')} Free cancellation</p>` : '';

    /* Price only when the catalogue holds one, and labelled as a starting
       point rather than a quote — this page has no dates, so it cannot price
       a stay and must not look as though it has. */
    const price = (h.price_per_night != null)
      ? `<div class="dh-price">
           <span class="dh-price-from">from</span>
           <span class="dh-price-amt">${esc(
             typeof money === 'function'
               ? money(h.price_per_night)
               : '₹' + Number(h.price_per_night).toLocaleString('en-IN'))}</span>
           <span class="dh-price-unit">/ night</span>
         </div>` : '';

    /* Onward link into the EXISTING hotels flow, carrying the destination the
       hotels page already reads. Not a new booking path — this page is a way
       in to the one that exists. */
    const href = 'hotels.html?dest=' + encodeURIComponent(
      destination && destination.name ? destination.name : slug);

    return `<article class="hr-card dh-card" data-hotel="${esc(h.id)}">
      <div class="hr-card-media">${media}</div>
      <div class="hr-card-body">
        <div class="hr-card-main">
          <div class="hr-name-row">
            <h3 class="hr-name">${esc(h.name)}</h3>
            ${stars}
          </div>
          ${locLine}
          ${rating}
          ${desc}
          ${amenities}
          ${free}
        </div>
        <div class="dh-card-foot">
          ${price}
          <a class="btn dh-view" href="${esc(href)}">View Hotel</a>
        </div>
      </div>
    </article>`;
  }

  /* ---------------------------------------------------------------- chips */
  function paintLocations() {
    if (!locations.length) { locsEl.hidden = true; return; }
    locsEl.hidden = false;
    const chip = (id, label) => {
      const on = activeLocation === id;
      return `<button type="button" class="dh-chip${on ? ' is-on' : ''}"
        data-loc="${esc(id)}" aria-pressed="${on ? 'true' : 'false'}">${esc(label)}</button>`;
    };
    locsEl.innerHTML = chip('', 'All Locations')
      + locations.map(l => chip(l.id, l.name)).join('');
  }

  /* ---------------------------------------------------------------- states */
  function showMessage(text, retry) {
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'false');
    moreBtn.hidden = true;
    statusEl.textContent = text;
    const old = document.getElementById('dhRetry');
    if (old) old.remove();
    if (!retry) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'dhRetry';
    btn.className = 'dh-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => { btn.remove(); load(true); });
    statusEl.insertAdjacentElement('afterend', btn);
  }

  function countLabel() {
    const where = destination ? destination.name : '';
    if (activeLocation) {
      const loc = locations.find(l => l.id === activeLocation);
      const label = loc ? loc.name : '';
      return `${total} ${total === 1 ? 'hotel' : 'hotels'}${label ? ' in ' + label : ''}`;
    }
    return `${total} ${total === 1 ? 'hotel' : 'hotels'}${where ? ' in ' + where : ''}`;
  }

  /* ------------------------------------------------------------------ load */
  async function load(reset) {
    if (busy) return;
    busy = true;

    if (reset) {
      page = 1;
      loaded = 0;
      grid.innerHTML = '';
      grid.setAttribute('aria-busy', 'true');
      statusEl.textContent = 'Loading hotels…';
      moreBtn.hidden = true;
    } else {
      moreBtn.disabled = true;
      moreBtn.textContent = 'Loading…';
    }

    const qs = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (activeLocation) qs.set('location_id', activeLocation);

    try {
      const data = await getJson(
        '/api/customer/destinations/' + encodeURIComponent(slug) + '/hotels?' + qs.toString());

      destination = data.destination || null;
      locations = Array.isArray(data.locations) ? data.locations : [];
      total = Number(data.total) || 0;

      if (destination) {
        titleEl.textContent = destination.name;
        document.title = destination.name + ' hotels — JackPots World Tours & Travels';
        countryEl.textContent = destination.country || '';
        leadEl.textContent = 'Explore hotels and stays in ' + destination.name + '.';
      }
      paintLocations();

      const rows = Array.isArray(data.hotels) ? data.hotels : [];
      if (reset && !rows.length) {
        /* A true answer about our catalogue, not a failure — so no retry
           button, which would ask the same question and get the same answer. */
        showMessage(
          'No hotels are currently available for '
          + (destination ? destination.name : 'this destination')
          + (activeLocation ? ' in this location' : '') + '.',
          false);
        paintLocations();
        return;
      }

      grid.insertAdjacentHTML('beforeend',
        rows.map((h, i) => cardHtml(h, loaded + i)).join(''));
      loaded += rows.length;
      grid.setAttribute('aria-busy', 'false');
      statusEl.textContent = countLabel();

      /* The photographs need their skeletons cleared after every render —
         a cached file can finish loading before the listener exists. */
      if (typeof hotelImageSettle === 'function') hotelImageSettle(grid);
      if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount(grid);

      const remaining = total - loaded;
      moreBtn.hidden = remaining <= 0;
      moreBtn.disabled = false;
      moreBtn.textContent = 'Show ' + Math.min(remaining, PAGE_SIZE) + ' more';
    } catch (err) {
      console.warn('[destination-hotels] failed:', err && err.message);
      if (err && err.status === 404) {
        titleEl.textContent = 'Destination not found';
        leadEl.textContent = '';
        countryEl.textContent = '';
        locsEl.hidden = true;
        showMessage('We could not find that destination.', false);
      } else if (reset) {
        showMessage('Unable to load hotels right now.', true);
      } else {
        moreBtn.disabled = false;
        moreBtn.textContent = 'Try again';
      }
    } finally {
      busy = false;
    }
  }

  /* ----------------------------------------------------------- interaction */
  locsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-loc]');
    if (!btn) return;
    const next = btn.dataset.loc || '';
    if (next === activeLocation) return;
    activeLocation = next;

    /* The filter lives in the URL, so a filtered view is linkable and the
       back button returns to the previous filter rather than leaving the
       page. replaceState would lose that. */
    const url = new URL(location.href);
    if (activeLocation) url.searchParams.set('location', activeLocation);
    else url.searchParams.delete('location');
    history.pushState({ location: activeLocation }, '', url);

    paintLocations();
    load(true);
  });

  moreBtn.addEventListener('click', () => { page += 1; load(false); });

  window.addEventListener('popstate', () => {
    activeLocation = new URLSearchParams(location.search).get('location') || '';
    paintLocations();
    load(true);
  });

  if (!slug) {
    showMessage('No destination was specified.', false);
    titleEl.textContent = 'Destination not found';
    return;
  }
  load(true);
})();
