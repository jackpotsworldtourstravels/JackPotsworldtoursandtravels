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

  /* TWO MANIFESTS, IN ORDER. A package's image_key is either a city slug
     ("goa") or one particular place inside it ("goa__fort-aguada"), and the
     second is what lets four Goa packages show four different photographs
     instead of the same coastline four times. Either way it is a KEY that has
     to be present in artwork that shipped; a path is never built from a name. */
  const fromManifest = (key, files, dir, fallbackDir) => {
    if (!key || typeof files !== 'object' || !files || !files[key]) return null;
    const d = (typeof dir === 'string') ? dir : fallbackDir;
    /* ?v=<stamp> WHEN THE MANIFEST CARRIES ONE. The path is derived from the
       key, so replacing a photograph changes the bytes behind a URL that does
       not change - and a browser that has been here keeps the old picture.
       The manifest's value is a content stamp of that file, so the URL moves
       when the picture does. An older manifest whose values are `true` yields
       no query and behaves exactly as before. */
    const stamp = files[key];
    const v = (typeof stamp === 'string') ? '?v=' + stamp : '';
    return { src: d + key + '.webp' + v, small: d + key + '-480.webp' + v };
  };
  const destArt = key =>
    fromManifest(key, typeof DESTINATION_IMAGE_FILES !== 'undefined' ? DESTINATION_IMAGE_FILES : null,
                 typeof DESTINATION_IMAGE_DIR !== 'undefined' ? DESTINATION_IMAGE_DIR : null,
                 'assets/destinations/')
    || fromManifest(key, typeof LOCATION_IMAGE_FILES !== 'undefined' ? LOCATION_IMAGE_FILES : null,
                    typeof LOCATION_IMAGE_DIR !== 'undefined' ? LOCATION_IMAGE_DIR : null,
                    'assets/locations/');

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

  /* "Goa, India" where the destinations catalogue knows the country, "Goa"
     where it does not. The country is looked up server-side against
     customer_destinations; nothing here infers one from a name. */
  const where = p => [p.destination, p.country].filter(Boolean).join(', ');

  /* THE PRICE A CARD SHOWS is the next departure's where there is one, and
     the shelf price otherwise - and the sort uses the same number, so the
     order on screen matches the figures on screen. */
  const cardPrice = p => Number(p.price_next != null ? p.price_next : p.priceFrom) || 0;

  /* ======================================================================
     STATE — which is the URL
     ====================================================================== */
  const FILTER_KEYS = ['trip', 'destination', 'month', 'hotel', 'rating', 'minDays', 'maxDays', 'maxPrice'];
  const state = { sort: 'price-asc' };

  /* THE LANDING PAGE'S SEARCH CARD SPEAKS ITS OWN LANGUAGE, and this page has
     to understand it. Choosing "Pilgrimage Tour Package" and a month on the
     home page navigates here as

         packages.html?type=Pilgrimage%20Tour%20Package&month=July

     - a label, not a slug, and a month NAME, not a YYYY-MM. Those are the
     words the card has always sent (booking-card.js `criteria('packages')`),
     and a page that quietly ignored them showed every package under a heading
     the traveller thought said Pilgrimage. Translated here rather than
     changed there, because the card also feeds gaming-packages.html. */
  const TYPE_WORDS = { domestic: 'domestic', international: 'international', pilgrimage: 'pilgrimage' };
  const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
                       'july', 'august', 'september', 'october', 'november', 'december'];

  function fromCardParams(q) {
    const type = (q.get('type') || '').toLowerCase();
    if (!state.trip) {
      const hit = Object.keys(TYPE_WORDS).find(k => type.includes(k));
      if (hit) state.trip = TYPE_WORDS[hit];
    }

    /* "July" means the NEXT July that something departs in. A bare month name
       has no year in it, and resolving it against the catalogue's own list of
       departure months is the only reading that cannot produce a month we do
       not sell. If the facets have not arrived yet the raw value is kept and
       reconciled once they do. */
    const raw = (q.get('month') || '').trim();
    if (raw && !state.month) {
      if (/^\d{4}-\d{2}$/.test(raw)) state.month = raw;
      else state.pendingMonth = raw.toLowerCase();
    }
  }

  function resolvePendingMonth(months) {
    if (!state.pendingMonth) return false;
    const idx = MONTH_NAMES.indexOf(state.pendingMonth);
    state.pendingMonth = '';
    if (idx < 0) return false;
    const match = (months || []).map(m => m.value)
      .find(v => Number(v.slice(5, 7)) === idx + 1);
    if (!match) return false;         /* nothing departs that month: show all */
    state.month = match;
    return true;
  }

  function readUrl() {
    const q = new URLSearchParams(location.search);
    FILTER_KEYS.forEach(k => { const v = q.get(k); if (v) state[k] = v; });
    /* THE BUG THIS GUARD EXISTS FOR. `month` is in FILTER_KEYS, so arriving
       from the landing page's search card - which sends the month as the word
       "July" - put "July" straight into the query string of the API call. The
       endpoint takes YYYY-MM and answered 422, and the page reported that it
       could not load the packages: an empty Tour Packages page for anybody
       who searched from the home page instead of clicking through.

       A month that is not YYYY-MM is not a month this page can send. It is
       handed to fromCardParams below, which knows what a month NAME is. */
    if (state.month && !/^\d{4}-\d{2}$/.test(state.month)) {
      state.pendingMonth = String(state.month).toLowerCase();
      state.month = '';
    }
    if (q.get('sort') && SORTS[q.get('sort')]) state.sort = q.get('sort');
    fromCardParams(q);
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
    /* Belt as well as braces: nothing that is not a YYYY-MM month reaches the
       API, whatever put it in `state`. A malformed filter should narrow
       nothing, never take the whole list down with a 422. */
    if (state.month && /^\d{4}-\d{2}$/.test(state.month)) q.set('month', state.month);
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
      /* NOT "sold out" and not a blank: a package with no departure dates in
         the catalogue is one we arrange on request, which is a real way tour
         operators sell and is what the enquiry link on the detail page is
         for. */
      : `<span class="pkl-card-next is-none">${icon('mail', 13)}Dates on request</span>`;

    return `<article class="pkl-card">
      <a class="pkl-card-art" href="package-details/${esc(p.id)}" aria-label="${esc(p.name)} package details">
        ${art ? `<img src="${esc(art.small)}" srcset="${esc(art.small)} 480w, ${esc(art.src)} 960w"
                 sizes="(max-width: 700px) 92vw, 380px" alt="" loading="lazy" decoding="async"
                 onerror="this.remove()">`
              : `<span class="pkl-card-pin">${icon('packages', 26)}</span>`}
        <span class="pkl-card-tag">${esc((p.trip_type || '').replace(/^\w/, c => c.toUpperCase()))}</span>
      </a>
      <div class="pkl-card-body">
        <div class="pkl-card-top">
          <h3><a href="package-details/${esc(p.id)}">${esc(p.name)}</a></h3>
          ${rating}
        </div>
        <p class="pkl-card-where">${icon('mapPin', 13)}<span>${esc(where(p))}</span></p>
        <p class="pkl-card-days">${esc(p.days)} Days${p.nights != null ? ' / ' + esc(p.nights) + ' Nights' : ''}</p>
        ${ticks.length ? `<ul class="pkl-card-ticks">${ticks
          .map(t => `<li>${icon('circleCheck', 13)}<span>${esc(t)}</span></li>`).join('')}</ul>` : ''}
        <div class="pkl-card-foot">
          <div class="pkl-card-price">
            <b>${esc(money(price))}</b><small>per person</small>${from}
          </div>
          ${next}
        </div>
        <a class="disc-btn pkl-card-btn" href="package-details/${esc(p.id)}">
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

    /* AN EMPTY LIST IS AN ANSWER, NOT A FAILURE, and the two now say
       different things on screen. A shelf with nothing on it says exactly
       that; a shelf emptied by a filter names the filter that did it, because
       "no packages available" under four active filters sends somebody away
       from a catalogue that has plenty. */
    const empty = $('pklEmpty');
    const narrowed = FILTER_KEYS.filter(k => k !== 'trip' && state[k]);
    if (rows.length) { empty.hidden = true; }
    else if (!narrowed.length) {
      empty.innerHTML = `<b>No packages available for this category.</b>
        <span>Nothing is on sale on this shelf at the moment. Tell us where you want to go and we
        will put a trip together — or look at what is running on the other shelves.</span>
        <div class="pkl-empty-acts">
          <a class="disc-btn" href="contact-us.html">Ask us to plan one ${icon('arrowRight', 15)}</a>
          <button type="button" class="disc-btn disc-btn-ghost" id="pklAllShelves">See every package</button>
        </div>`;
      empty.hidden = false;
    } else {
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
     ======================================================================
     THREE SKELETON CARDS while the request is out, in the shape of the cards
     that will replace them: a grid that grows from nothing to three rows
     moves everything under the reader's cursor, and a spinner on its own says
     "wait" without saying what for. Three because that is a full row on a
     laptop, and drawing more than arrive is its own small lie. */
  const skeleton = () => `<article class="pkl-card is-skeleton" aria-hidden="true">
      <div class="pkl-card-art"></div>
      <div class="pkl-card-body">
        <div class="sk sk-title"></div>
        <div class="sk sk-line"></div>
        <div class="sk sk-line sk-short"></div>
        <div class="sk sk-ticks"></div>
        <div class="sk sk-foot"></div>
      </div>
    </article>`;

  function showSkeletons() {
    grid.innerHTML = skeleton().repeat(3);
    grid.setAttribute('aria-busy', 'true');
    const empty = $('pklEmpty');
    if (empty) empty.hidden = true;
    $('pklStatus').hidden = true;
    $('pklLayout').hidden = false;
  }

  let inflight = 0;

  /* THE LIST IS THE PAGE; THE RAIL AND THE TILES ARE DECORATION AROUND IT.
     They used to be fetched together in one Promise.all, which meant a 404 on
     /facets - a server running code older than this page, exactly what a
     half-finished deploy produces - threw away a perfectly good list of
     packages and put up "we could not load" over a working catalogue.

     So: the packages are awaited and rendered on their own, and the other two
     are allowed to fail quietly. A page with no filter rail is a page that
     still sells trips. */
  async function load(pushed) {
    const mine = ++inflight;
    showSkeletons();

    let rows;
    try {
      rows = await getJson('/api/customer/packages?' + query());
    } catch (err) {
      if (mine !== inflight) return;
      failed(err);
      return;
    }
    if (mine !== inflight) return;

    renderResults(rows);
    $('pklStatus').hidden = true;
    $('pklLayout').hidden = false;
    grid.removeAttribute('aria-busy');
    if (!pushed) writeUrl(true);

    /* Enrichment, not a dependency: each of these renders if it answers and
       is skipped if it does not. Failures are logged, because a rail that
       silently never appears is a bug nobody reports. */
    getJson('/api/customer/packages/trip-types?category=holiday')
      .then(t => { if (mine === inflight) renderTiles(t); })
      .catch(e => console.warn('[packages] category counts unavailable:', e.status || e));
    getJson('/api/customer/packages/facets?category=holiday')
      .then(f => {
        if (mine !== inflight) return;
        /* A month name from the landing card can only be turned into a real
           month once the catalogue's months are known, so it is resolved here
           and the list is asked for again - once, because resolvePending
           clears the pending value whether or not it matched. */
        if (resolvePendingMonth(f.months)) { writeUrl(true); load(true); return; }
        renderRail(f);
      })
      .catch(e => console.warn('[packages] filters unavailable:', e.status || e));
  }

  /* THE LIST ITSELF FAILED, which is a different thing from a shelf being
     empty and is told apart on screen: this one has a reason and a Retry,
     where an empty shelf has neither because there is nothing to retry.
     The status code is named - "the server said 500" is what turns "it does
     not work" into a bug somebody can fix. */
  function failed(err) {
    grid.innerHTML = '';
    grid.removeAttribute('aria-busy');
    $('pklLayout').hidden = true;
    const s = $('pklStatus');
    s.hidden = false;
    const why = err && err.status
      ? `The packages service answered ${err.status}.`
      : 'The packages service could not be reached.';
    s.innerHTML = `<b>We could not load the tour packages just now.</b>
      <span>${esc(why)} Nothing is wrong with your connection to the rest of the site —
      if this persists, the packages API on this server is behind the page.</span>`;
    s.classList.add('pkl-failed');
    const old = $('pklRetry');
    if (old) old.remove();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pklRetry';
    btn.className = 'dh-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => { btn.remove(); s.classList.remove('pkl-failed'); load(true); });
    s.insertAdjacentElement('afterend', btn);
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
    } else if (ev.target.closest('#pklAllShelves')) {
      /* The only control that also drops the SHELF - offered on an empty
         shelf, where clearing the filters alone would change nothing. */
      FILTER_KEYS.forEach(k => { state[k] = ''; });
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
  /* The landing card's own words are translated on arrival and the URL is
     rewritten to this page's vocabulary, so a refresh, a bookmark or a shared
     link carries ?trip=domestic&month=2026-10 rather than a phrase from a
     dropdown that only one page understands. */
  const cameFromCard = /[?&](type|month)=/.test(location.search);
  readUrl();
  if (cameFromCard) writeUrl(true);
  load(true);
})();
