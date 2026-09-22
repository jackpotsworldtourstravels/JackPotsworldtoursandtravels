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

    const art = artFor(a.image);
    document.getElementById('lpHero').innerHTML = art
      ? `<img class="lp-hero-img" src="${esc(art.src)}"
             srcset="${esc(art.small)} 480w, ${esc(art.src)} 960w"
             sizes="(max-width: 900px) 100vw, 900px"
             alt="${esc(a.name)}" decoding="async">`
      : `<span class="lp-hero-pin">${icon('mapPin', 34)}</span>`;

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
      : '';
    note.hidden = !note.textContent;

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
      line.textContent = `${n} ${n === 1 ? 'hotel' : 'hotels'} we list${a.area_name ? ' in ' + a.area_name : ''}, the nearest area to ${a.name}.`;
      btn.href = 'hotels/' + encodeURIComponent(a.destination_id) + '/' + encodeURIComponent(a.slug);
      btn.hidden = false;
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
