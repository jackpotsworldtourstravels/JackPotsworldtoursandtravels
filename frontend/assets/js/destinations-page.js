'use strict';
/* ===========================================================================
   destinations-page.js — the Destinations discovery page.
   ===========================================================================
   TWO PUBLIC ENDPOINTS, AND NOTHING NAMED IN THIS FILE:

     GET /api/customer/destinations                       the collection
     GET /api/customer/destinations/{id}/attractions      each one's famous
                                                          places, for the
                                                          spotlight list and
                                                          the card teasers

   The destinations API carries no description, and one is not invented: a
   card's line of copy is the names of that destination's real famous
   places, fetched after the cards are on screen. The spotlight is the
   first destination in the API's own order — the business decides it by
   ordering the catalogue, this file does not choose.

   THE FILTER CHIPS ARE THE DATA'S COUNTRIES, counted. A new country in the
   catalogue gets a chip with no change here.

   Motion is the design system's: DS.reveal / DS.develop for arrival and
   the photograph develop, DS.gsap() (loaded on demand) for the route draw,
   the spotlight parallax and each card's scroll drift.
   =========================================================================== */
(function () {
  const spot = document.getElementById('edSpot');
  const grid = document.getElementById('edGrid');
  const chips = document.getElementById('edChips');
  const count = document.getElementById('edCount');
  const countLine = document.getElementById('edCountLine');
  if (!spot || !grid || typeof DS === 'undefined') return;

  const esc = DS.esc;
  const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';

  let all = [];
  let filter = '';
  const places = new Map();          // destination id -> attractions[] (or null on failure)

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* --- artwork, from the two generated manifests ------------------------ */
  function destArt(key) {
    if (!key || typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES[key]) return null;
    const stamp = DESTINATION_IMAGE_FILES[key];
    const v = typeof stamp === 'string' ? '?v=' + stamp : '';
    const dir = typeof DESTINATION_IMAGE_DIR === 'string' ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    return { s: dir + key + '-480.webp' + v, m: dir + key + '.webp' + v, l: dir + key + '-1600.webp' + v };
  }
  function placeArt(key) {
    if (!key || typeof LOCATION_IMAGE_FILES !== 'object' || !LOCATION_IMAGE_FILES[key]) return null;
    const stamp = LOCATION_IMAGE_FILES[key];
    const v = typeof stamp === 'string' ? '?v=' + stamp : '';
    const dir = typeof LOCATION_IMAGE_DIR === 'string' ? LOCATION_IMAGE_DIR : 'assets/locations/';
    return { s: dir + key + '-480.webp' + v, m: dir + key + '.webp' + v };
  }
  const img = (a, sizes, alt, cls) => a
    ? '<img class="' + (cls || '') + ' ds-dev" src="' + esc(a.m) + '" srcset="' + esc(a.s) + ' 480w, ' + esc(a.m) + ' 960w'
      + (a.l ? ', ' + esc(a.l) + ' 1600w' : '') + '" sizes="' + sizes + '" alt="' + esc(alt) + '" loading="lazy" decoding="async" onerror="this.remove()">'
    : '';

  /* --- the spotlight --------------------------------------------------- */
  function spotHtml(d, list) {
    const items = (list || []).slice(0, 5).map(p => {
      const a = placeArt(p.image);
      const href = 'destination/' + encodeURIComponent(d.id) + '/' + encodeURIComponent(p.slug || p.id);
      return '<li><a href="' + esc(href) + '" style="display:contents">'
        + (a ? '<img src="' + esc(a.s) + '" alt="" loading="lazy" decoding="async">' : '<span class="ed-thumb-none" aria-hidden="true">' + PIN + '</span>')
        + '<span class="ed-p"><b>' + esc(p.name) + '</b>' + (p.description ? '<span class="ed-desc">' + esc(p.description) + '</span>' : '') + '</span></a></li>';
    }).join('');
    const total = (list || []).length;
    return '<div class="ed-spot">'
      + '<div class="ed-spot__media" data-ds-reveal="scale">'
      +   img(destArt(d.image), '(max-width: 1024px) 100vw, 58vw', d.name, 'ed-spot__img')
      +   '<span class="ds-badge ds-badge--dark ds-badge--plain ed-spot__badge">Featured destination</span>'
      + '</div>'
      + '<div data-ds-stagger>'
      +   '<p class="ds-eyebrow" data-ds-reveal>Spotlight &middot; 01</p>'
      +   (d.country ? '<p class="ed-spot__country" data-ds-reveal>' + esc(d.country) + '</p>' : '')
      +   '<h2 class="ds-display ed-spot__name" id="edSpotName" data-ds-reveal>' + esc(d.name) + '</h2>'
      +   (total ? '<ul class="ed-spot__places" data-ds-reveal aria-label="Famous places in ' + esc(d.name) + '">' + items + '</ul>' : '')
      +   '<div class="ed-spot__actions" data-ds-reveal>'
      +     '<a class="ds-btn ds-btn--primary" href="destination/' + encodeURIComponent(d.id) + '">Explore ' + esc(d.name) + ARROW + '</a>'
      +     (total > 5 ? '<a class="ds-btn ds-btn--outline" href="destination/' + encodeURIComponent(d.id) + '">All ' + total + ' famous places</a>' : '')
      +   '</div>'
      + '</div></div>';
  }

  /* --- one card -------------------------------------------------------- */
  function cardHtml(d, n) {
    const a = destArt(d.image);
    return '<a class="ds-media-card' + (a ? '' : ' ds-media-card--noimg') + '" role="listitem" href="destination/' + encodeURIComponent(d.id) + '"'
      + ' data-dest="' + esc(d.id) + '" data-ds-reveal="scale" aria-label="Explore ' + esc(d.name) + '">'
      + img(a, '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 58vw', d.name, 'ds-media-card__img')
      + '<span class="ds-media-card__num" aria-hidden="true">' + String(n).padStart(2, '0') + '</span>'
      + '<span class="ds-media-card__body">'
      +   '<span class="ds-media-card__title">' + esc(d.name) + '</span>'
      +   (d.country ? '<span class="ds-media-card__meta">' + esc(d.country) + '</span>' : '')
      +   '<span class="ds-media-card__teaser" data-teaser></span>'
      +   '<span class="ds-media-card__go">Explore' + ARROW + '</span>'
      + '</span></a>';
  }

  function teaser(list) {
    if (!list || !list.length) return '';
    const names = list.slice(0, 3).map(p => p.name).join(' · ');
    return list.length > 3 ? names + ' and ' + (list.length - 3) + ' more' : names;
  }
  function paintTeasers() {
    grid.querySelectorAll('[data-dest]').forEach(card => {
      const t = card.querySelector('[data-teaser]');
      const list = places.get(card.dataset.dest);
      if (t && list) t.textContent = teaser(list);
    });
  }

  /* --- the collection -------------------------------------------------- */
  function paintGrid() {
    const rest = all.slice(1);
    const shown = filter ? rest.filter(d => (d.country || '') === filter) : rest;
    const total = filter ? all.filter(d => (d.country || '') === filter).length : all.length;
    count.textContent = total + (total === 1 ? ' destination' : ' destinations');
    if (!shown.length) {
      DS.state(grid, { kind: 'empty', title: 'Only the spotlight, for now', body: 'The featured destination above is the only one in this country so far.' });
      grid.removeAttribute('aria-busy');
      return;
    }
    grid.setAttribute('data-ds-stagger', '.07');
    grid.innerHTML = shown.map(d => cardHtml(d, all.indexOf(d) + 1)).join('');
    grid.removeAttribute('aria-busy');
    paintTeasers();
    DS.reveal(grid); DS.develop(grid);
    drift();
  }

  function paintChips() {
    const tally = new Map();
    all.forEach(d => { const c = d.country || ''; if (c) tally.set(c, (tally.get(c) || 0) + 1); });
    if (tally.size < 2) { chips.hidden = true; return; }
    const opts = [['', 'All', all.length]].concat(Array.from(tally.entries()).sort((a, b) => b[1] - a[1]).map(([c, n]) => [c, c, n]));
    chips.innerHTML = opts.map(([v, label, n]) =>
      '<button type="button" class="ds-chip" aria-pressed="' + (v === filter) + '" data-v="' + esc(v) + '">' + esc(label)
      + ' <span class="ds-chip__count">' + n + '</span></button>').join('');
    chips.addEventListener('click', e => {
      const b = e.target.closest('.ds-chip');
      if (!b || b.dataset.v === filter) return;
      filter = b.dataset.v;
      chips.querySelectorAll('.ds-chip').forEach(x => x.setAttribute('aria-pressed', x === b));
      paintGrid();
    });
  }

  /* --- scroll motion: the route, the spotlight, the cards --------------- */
  let driftTriggers = [];
  function drift() {
    DS.gsap().then(g => {
      if (!g) return;
      driftTriggers.forEach(t => t.kill()); driftTriggers = [];
      const k = DS.small ? 0.5 : 1;
      grid.querySelectorAll('.ds-media-card').forEach((c, i) => {
        const big = c.matches(':nth-child(3n+1)');
        const rate = ((big ? 4 : 8) + (i % 3) * 2) * k;
        /* The CARD's transform belongs to its CSS arrival (data-ds-reveal);
           the drift moves what is inside it — the photograph against the
           frame, the words against both. */
        const im = c.querySelector('.ds-media-card__img'), body = c.querySelector('.ds-media-card__body');
        const tl = g.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: c, start: 'top bottom', end: 'bottom top', scrub: 0.8 } });
        if (im) tl.fromTo(im, { yPercent: -6, scale: 1.14 }, { yPercent: 6, scale: 1.14 }, 0);
        if (body) tl.fromTo(body, { y: rate * 2 }, { y: -rate * 2 }, 0);
        driftTriggers.push(tl.scrollTrigger);
      });
      g.delayedCall(0.05, () => window.ScrollTrigger && window.ScrollTrigger.refresh());
    });
  }
  function motionOnce() {
    DS.gsap().then(g => {
      if (!g) return;
      const line = document.getElementById('edRouteLine');
      if (line && line.getTotalLength) {
        const L = line.getTotalLength();
        g.fromTo(line, { strokeDasharray: L, strokeDashoffset: L }, { strokeDashoffset: 0, ease: 'none',
          scrollTrigger: { trigger: line, start: 'top 95%', end: 'bottom 40%', scrub: 0.6 } });
      }
      const sm = spot.querySelector('.ed-spot__img');
      if (sm) g.fromTo(sm, { yPercent: -6 }, { yPercent: 6, ease: 'none', scrollTrigger: { trigger: sm.parentElement, start: 'top bottom', end: 'bottom top', scrub: 0.8 } });
    });
  }

  /* --- load ------------------------------------------------------------ */
  async function load() {
    DS.skeleton(spot, 'text', 1);
    DS.skeleton(grid, 'media', 6);
    try {
      const rows = await getJson('/api/customer/destinations');
      all = (Array.isArray(rows) ? rows : []).filter(d => d && d.id && d.name);
    } catch (e) {
      console.warn('[destinations] list failed:', e && e.message);
      spot.innerHTML = '';
      DS.state(grid, { kind: 'error', title: 'We couldn’t load the destinations', body: 'Please check your connection and try again.',
        actions: [{ label: 'Try again', onClick: load }, { label: 'Back home', href: 'index.html' }] });
      return;
    }
    if (!all.length) {
      spot.innerHTML = '';
      DS.state(grid, { kind: 'empty', title: 'No destinations yet', body: 'New destinations are added here as soon as we can plan journeys to them.',
        actions: [{ label: 'Talk to a travel expert', href: 'contact-us.html' }] });
      return;
    }
    if (countLine) countLine.textContent = all.length + ' destinations · ' + new Set(all.map(d => d.country).filter(Boolean)).size + ' countries';

    /* The spotlight waits for its famous places (one request); the grid does
       not wait for anybody's. */
    const first = all[0];
    try { places.set(first.id, await getJson('/api/customer/destinations/' + encodeURIComponent(first.id) + '/attractions')); }
    catch (e) { places.set(first.id, null); }
    spot.innerHTML = spotHtml(first, places.get(first.id));
    spot.removeAttribute('aria-busy');
    DS.reveal(spot); DS.develop(spot);

    paintChips();
    paintGrid();
    motionOnce();

    /* The teasers: every other destination's famous places, in parallel,
       painted as they land. A failure leaves that card without a line. */
    all.slice(1).forEach(d => {
      getJson('/api/customer/destinations/' + encodeURIComponent(d.id) + '/attractions')
        .then(list => { places.set(d.id, Array.isArray(list) ? list : []); paintTeasers(); })
        .catch(() => {});
    });
  }

  load();
})();
