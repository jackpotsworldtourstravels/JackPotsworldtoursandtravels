'use strict';
/* ===========================================================================
   package-listing.js — the Tour Packages shelf: three categories, a filter
   rail, and the trips that match.
   ===========================================================================
   STEPS TWO AND THREE of Tour Packages -> a shelf (domestic / pilgrimage /
   international) -> the list -> one package -> the booking flow. The page
   used to be seven tiles with a drawn scene on each and a client-side filter
   over whatever had already been downloaded.

   THE DATABASE DOES THE FILTERING NOW. Every control here is a query
   parameter on GET /api/customer/packages, and the rail itself is built from
   GET /api/customer/packages/facets - so a filter can only ever offer a
   choice that some package actually satisfies, and a control with nothing
   behind it (hotel standard, rating) is not drawn at all rather than being
   offered and emptying the page.

   THE URL IS THE STATE. Every choice is written to the query string, so a
   filtered shelf is a link somebody can send, a reload keeps what was chosen,
   and Back does what Back should.

   WHAT IT WILL NOT DO:

     invent a count   The three category tiles carry live counts, including
                      the zero on pilgrimage. A tile that hid itself would
                      suggest the company does not run those trips; one that
                      lied about a count would be worse.
     invent a rating  No package carries a score today, so no card shows
                      stars and the rail draws no rating filter.
     invent a photo   A card's picture is its destination's photograph, by
                      KEY, from the manifest that shipped. A package whose
                      destination has no artwork keeps a tinted card.
   =========================================================================== */
(function () {
  const grid = document.getElementById('pklGrid');
  if (!grid) return;

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const icon = (name, size) => (typeof JPIcon !== 'undefined' && JPIcon.html)
    ? JPIcon.html(name, { size: size || 16 }) : '';

  const money = n => {
    if (n == null) return null;
    if (typeof formatMoney === 'function') return formatMoney(n);
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR', maximumFractionDigits: 0,
      }).format(n);
    } catch { return '₹' + Math.round(n); }
  };

  const destArt = key => {
    if (!key || typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES) return null;
    if (!DESTINATION_IMAGE_FILES[key]) return null;
    const dir = (typeof DESTINATION_IMAGE_DIR === 'string') ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    return { src: dir + key + '.webp', small: dir + key + '-480.webp' };
  };

  const monthLabel = key => {
    const [y, m] = String(key).split('-').map(Number);
    if (!y || !m) return key;
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  };
  const shortDate = iso => {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const TRIPS = [
    { key: 'domestic', label: 'Domestic', icon: 'mapPin',
      line: 'Trips inside India — beaches, hills and cities.' },
    { key: 'pilgrimage', label: 'Pilgrimage', icon: 'landmark',
      line: 'Temple towns and holy circuits, planned end to end.' },
    { key: 'international', label: 'International', icon: 'globe',
      line: 'Visas, flights and hotels, arranged as one trip.' },
  ];

  const SORTS = {
    'price-asc': { label: 'Price: low to high', fn: (a, b) => cardPrice(a) - cardPrice(b) },
    'price-desc': { label: 'Price: high to low', fn: (a, b) => cardPrice(b) - cardPrice(a) },
    'days-asc': { label: 'Duration: shortest first', fn: (a, b) => a.days - b.days },
    'days-desc': { label: 'Duration: longest first', fn: (a, b) => b.days - a.days },
    'soonest': {
      label: 'Departing soonest',
      /* A package with no live departure sorts last rather than first: an
         absent date is not an early one. */
      fn: (a, b) => (a.next_departure || '9999').localeCompare(b.next_departure || '9999'),
    },
  };

  /* THE PRICE A CARD SHOWS is the next departure's where there is one, and
     the shelf price otherwise - and the sort uses the same number, so the
     order on screen matches the figures on screen. */
  const cardPrice = p => Number(p.price_next != null ? p.price_next : p.priceFrom) || 0;

  /* ======================================================================
     STATE — which is the URL
     ====================================================================== */
  const FILTER_KEYS = ['trip', 'destination', 'month', 'hotel', 'rating', 'minDays', 'maxDays', 'maxPrice'];
  const state = { sort: 'price-asc' };

  function readUrl() {
    const q = new URLSearchParams(location.search);
    FILTER_KEYS.forEach(k => { const v = q.get(k); if (v) state[k] = v; });
    if (q.get('sort') && SORTS[q.get('sort')]) state.sort = q.get('sort');
  }

  function writeUrl(replace) {
    const q = new URLSearchParams();
    FILTER_KEYS.forEach(k => { if (state[k]) q.set(k, state[k]); });
    if (state.sort && state.sort !== 'price-asc') q.set('sort', state.sort);
    const url = location.pathname + (q.toString() ? '?' + q : '');
    history[replace ? 'replaceState' : 'pushState']({}, '', url);
  }

  function query() {
    const q = new URLSearchParams({ category: 'holiday' });
    if (state.trip) q.set('trip_type', state.trip);
    if (state.destination) q.set('destination', state.destination);
    if (state.month) q.set('month', state.month);
    if (state.hotel) q.set('hotel_category', state.hotel);
    if (state.rating) q.set('min_rating', state.rating);
    if (state.minDays) q.set('min_days', state.minDays);
    if (state.maxDays) q.set('max_days', state.maxDays);
    if (state.maxPrice) q.set('max_price', state.maxPrice);
    return q;
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  /* ======================================================================
     THE THREE SHELVES
     ====================================================================== */
  function renderTiles(counts) {
    const by = Object.fromEntries((counts || []).map(c => [c.trip_type, c.count]));
    $('pklTiles').innerHTML = TRIPS.map(t => {
      const n = by[t.key] || 0;
      const on = state.trip === t.key;
      /* A SHELF WITH NOTHING ON IT IS STILL SHOWN, and says so, and cannot be
         selected. Hiding it would imply we do not run those trips; letting it
         be tapped would open an empty list for no reason. */
      return `<button type="button" class="pkl-tile${on ? ' is-on' : ''}${n ? '' : ' is-empty'}"
              data-trip="${esc(t.key)}"${n ? '' : ' disabled aria-disabled="true"'}>
        <span class="pkl-tile-icon">${icon(t.icon, 20)}</span>
        <span class="pkl-tile-body">
          <span class="pkl-tile-name">${esc(t.label)}</span>
          <span class="pkl-tile-line">${esc(t.line)}</span>
        </span>
        <span class="pkl-tile-count">${n ? esc(n) + ' package' + (n === 1 ? '' : 's') : 'None on sale yet'}</span>
      </button>`;
    }).join('');
    if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount($('pklTiles'));
  }

  /* ======================================================================
     THE RAIL — built from the facets, so it offers only what exists
     ====================================================================== */
  function renderRail(f) {
    const parts = [];

    const group = (title, inner) =>
      `<div class="pkl-group"><h3>${esc(title)}</h3>${inner}</div>`;

    const radios = (name, rows, current, allLabel) => `
      <div class="pkl-opts">
        <label class="pkl-opt${current ? '' : ' is-on'}">
          <input type="radio" name="${esc(name)}" value=""${current ? '' : ' checked'}>
          <span>${esc(allLabel)}</span>
        </label>
        ${rows.map(r => `
          <label class="pkl-opt${String(current) === String(r.value) ? ' is-on' : ''}">
            <input type="radio" name="${esc(name)}" value="${esc(r.value)}"
              ${String(current) === String(r.value) ? ' checked' : ''}>
            <span>${esc(r.label)}</span>
            <em>${esc(r.count)}</em>
          </label>`).join('')}
      </div>`;

    if ((f.destinations || []).length > 1) {
      parts.push(group('Destination', radios('destination',
        f.destinations.map(d => ({ value: d.value, label: d.value, count: d.count })),
        state.destination, 'All destinations')));
    }

    if ((f.months || []).length) {
      parts.push(group('Travel month', radios('month',
        f.months.map(m => ({ value: m.value, label: monthLabel(m.value), count: m.count })),
        state.month, 'Any month')));
    }

    /* DURATION IS OFFERED AS THE BANDS THE CATALOGUE ACTUALLY HAS. With trips
       of 4, 5 and 6 days, "7+ nights" is a band that can only ever return
       nothing, so it is not drawn. */
    const bands = [
      { value: '1-4', label: 'Up to 4 days', min: 1, max: 4 },
      { value: '5-7', label: '5 to 7 days', min: 5, max: 7 },
      { value: '8-99', label: '8 days or more', min: 8, max: 99 },
    ].map(b => ({
      ...b,
      count: (f.durations || []).filter(d => d.value >= b.min && d.value <= b.max)
        .reduce((n, d) => n + d.count, 0),
    })).filter(b => b.count > 0);
    if (bands.length > 1) {
      const current = state.minDays ? `${state.minDays}-${state.maxDays}` : '';
      parts.push(group('Duration', radios('duration', bands, current, 'Any length')));
    }

    /* Price: the real floor and ceiling of the catalogue, as a slider that
       cannot be dragged past either. */
    if (f.price_min != null && f.price_max != null && f.price_max > f.price_min) {
      const max = Math.ceil(f.price_max / 1000) * 1000;
      const min = Math.floor(f.price_min / 1000) * 1000;
      const now = state.maxPrice ? Number(state.maxPrice) : max;
      parts.push(group('Budget', `
        <div class="pkl-price">
          <input type="range" id="pklPrice" min="${min}" max="${max}" step="500" value="${now}"
                 aria-label="Highest price per person">
          <p class="pkl-price-read">Up to <b id="pklPriceRead">${esc(money(now))}</b> per person</p>
          <p class="pkl-price-ends"><span>${esc(money(min))}</span><span>${esc(money(max))}</span></p>
        </div>`));
    }

    /* Hotel standard and rating exist as columns and are empty today, so the
       facets come back empty and these two controls are simply not here. */
    if ((f.hotel_categories || []).length) {
      parts.push(group('Hotel category', radios('hotel',
        f.hotel_categories.map(h => ({ value: h.value, label: `${h.value}-star`, count: h.count })),
        state.hotel, 'Any standard')));
    }
    if (f.rated_count) {
      parts.push(group('Rating', radios('rating',
        [{ value: '4.5', label: '4.5 and above' }, { value: '4', label: '4.0 and above' },
         { value: '3.5', label: '3.5 and above' }].map(r => ({ ...r, count: '' })),
        state.rating, 'Any rating')));
    }

    const active = FILTER_KEYS.filter(k => k !== 'trip' && state[k]).length;
    $('pklRail').innerHTML = `
      <div class="pkl-rail-head">
        <h2>Filters</h2>
        ${active ? '<button type="button" class="pkl-clear" id="pklClear">Clear all</button>' : ''}
      </div>
      ${parts.join('') || '<p class="pkl-rail-none">No filters apply to this shelf yet.</p>'}`;
  }

  /* ======================================================================
     THE CARDS
     ====================================================================== */
  function card(p) {
    const art = destArt(p.image);
    const price = cardPrice(p);
    const shelfPrice = Number(p.priceFrom);
    /* Both numbers, when they differ: the card is showing the next
       departure's price, and hiding that the shelf price is lower would be
       the same trick in reverse. */
    const from = (p.price_next != null && shelfPrice && Math.abs(shelfPrice - price) > 0.5)
      ? `<span class="pkl-card-from">from ${esc(money(shelfPrice))} on other dates</span>` : '';

    const ticks = (p.highlights && p.highlights.length ? p.highlights : (p.inclusions || [])).slice(0, 3);
    const rating = (p.rating != null && p.rating_source)
      ? `<span class="pkl-card-rate">${icon('star', 13)}<b>${esc(Number(p.rating).toFixed(1))}</b>
           <em>${esc(p.rating_source)}</em></span>` : '';
    const next = p.next_departure
      ? `<span class="pkl-card-next">${icon('calendarDays', 13)}Next ${esc(shortDate(p.next_departure))}</span>`
      : `<span class="pkl-card-next is-none">No dates on sale</span>`;

    return `<article class="pkl-card">
      <a class="pkl-card-art" href="package/${esc(p.id)}" aria-label="${esc(p.name)} package details">
        ${art ? `<img src="${esc(art.small)}" srcset="${esc(art.small)} 480w, ${esc(art.src)} 960w"
                 sizes="(max-width: 700px) 92vw, 380px" alt="" loading="lazy" decoding="async"
                 onerror="this.remove()">`
              : `<span class="pkl-card-pin">${icon('packages', 26)}</span>`}
        <span class="pkl-card-tag">${esc((p.trip_type || '').replace(/^\w/, c => c.toUpperCase()))}</span>
      </a>
      <div class="pkl-card-body">
        <div class="pkl-card-top">
          <h3><a href="package/${esc(p.id)}">${esc(p.name)}</a></h3>
          ${rating}
        </div>
        <p class="pkl-card-where">${icon('mapPin', 13)}<span>${esc(p.destination || '')}</span></p>
        <p class="pkl-card-days">${esc(p.days)} Days${p.nights != null ? ' / ' + esc(p.nights) + ' Nights' : ''}</p>
        ${ticks.length ? `<ul class="pkl-card-ticks">${ticks
          .map(t => `<li>${icon('circleCheck', 13)}<span>${esc(t)}</span></li>`).join('')}</ul>` : ''}
        <div class="pkl-card-foot">
          <div class="pkl-card-price">
            <b>${esc(money(price))}</b><small>per person</small>${from}
          </div>
          ${next}
        </div>
        <a class="disc-btn pkl-card-btn" href="package/${esc(p.id)}">
          View details ${icon('arrowRight', 15)}
        </a>
      </div>
    </article>`;
  }

  function renderResults(rows) {
    const sorted = rows.slice().sort(SORTS[state.sort].fn);
    grid.innerHTML = sorted.map(card).join('');

    const shelf = state.trip ? (TRIPS.find(t => t.key === state.trip) || {}).label : null;
    $('pklCount').textContent = rows.length
      ? `${rows.length} ${shelf ? shelf.toLowerCase() + ' ' : ''}package${rows.length === 1 ? '' : 's'}`
      : 'No packages match';
    $('pklSort').value = state.sort;

    /* An empty result says WHICH choice emptied it and offers to undo that
       one, rather than a shrug and a "clear all". */
    const empty = $('pklEmpty');
    if (rows.length) { empty.hidden = true; }
    else {
      const named = [
        state.destination && `destination ${state.destination}`,
        state.month && monthLabel(state.month),
        state.maxPrice && `under ${money(Number(state.maxPrice))}`,
        state.minDays && `${state.minDays}–${state.maxDays} days`,
      ].filter(Boolean);
      empty.innerHTML = `<b>Nothing on this shelf matches${named.length ? ' ' + esc(named.join(', ')) : ''}.</b>
        <span>Every filter here is applied to what we really sell, so a combination can come back
        empty. Widen one and the list fills again.</span>
        <button type="button" class="disc-btn disc-btn-ghost" id="pklReset">Clear the filters</button>`;
      empty.hidden = false;
    }
    if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount(grid);
  }

  /* ======================================================================
     LOADING
     ====================================================================== */
  let inflight = 0;

  async function load(pushed) {
    const mine = ++inflight;
    grid.setAttribute('aria-busy', 'true');
    try {
      const [rows, facets, tiles] = await Promise.all([
        getJson('/api/customer/packages?' + query()),
        getJson('/api/customer/packages/facets?category=holiday'),
        getJson('/api/customer/packages/trip-types?category=holiday'),
      ]);
      /* A slower earlier request must not overwrite a newer answer. */
      if (mine !== inflight) return;
      renderTiles(tiles);
      renderRail(facets);
      renderResults(rows);
      $('pklStatus').hidden = true;
      $('pklLayout').hidden = false;
      if (!pushed) writeUrl(true);
    } catch (err) {
      if (mine !== inflight) return;
      $('pklLayout').hidden = true;
      const s = $('pklStatus');
      s.hidden = false;
      s.textContent = 'We could not load the tour packages just now.';
    } finally {
      grid.removeAttribute('aria-busy');
    }
  }

  /* ======================================================================
     EVENTS
     ====================================================================== */
  $('pklTiles').addEventListener('click', ev => {
    const btn = ev.target.closest('[data-trip]');
    if (!btn || btn.disabled) return;
    state.trip = (state.trip === btn.dataset.trip) ? '' : btn.dataset.trip;
    writeUrl(false);
    load(true);
  });

  $('pklRail').addEventListener('change', ev => {
    const el = ev.target;
    if (el.name === 'destination') state.destination = el.value;
    else if (el.name === 'month') state.month = el.value;
    else if (el.name === 'hotel') state.hotel = el.value;
    else if (el.name === 'rating') state.rating = el.value;
    else if (el.name === 'duration') {
      const [min, max] = (el.value || '').split('-');
      state.minDays = min || ''; state.maxDays = max || '';
    } else if (el.id === 'pklPrice') {
      state.maxPrice = el.value;
    } else return;
    writeUrl(false);
    load(true);
  });

  /* The slider reads live while dragging and only queries when let go -
     one request per decision, not one per pixel. */
  $('pklRail').addEventListener('input', ev => {
    if (ev.target.id !== 'pklPrice') return;
    const read = $('pklPriceRead');
    if (read) read.textContent = money(Number(ev.target.value));
  });

  document.addEventListener('click', ev => {
    if (ev.target.closest('#pklClear') || ev.target.closest('#pklReset')) {
      FILTER_KEYS.filter(k => k !== 'trip').forEach(k => { state[k] = ''; });
      writeUrl(false);
      load(true);
    }
  });

  $('pklSort').addEventListener('change', ev => {
    state.sort = SORTS[ev.target.value] ? ev.target.value : 'price-asc';
    writeUrl(false);
    load(true);
  });

  window.addEventListener('popstate', () => {
    FILTER_KEYS.forEach(k => { state[k] = ''; });
    state.sort = 'price-asc';
    readUrl();
    load(true);
  });

  /* The sort menu is static markup, so it is filled once from the same table
     the sorting uses - one list, not two that can drift. */
  $('pklSort').innerHTML = Object.entries(SORTS)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('');

  readUrl();
  load(true);
})();
