'use strict';
/* Smart travel search — a ranked, keyboard-driven autocomplete for every
   location field in the merchant portal.
   ---------------------------------------------------------------------------
   Two sources, no new backend endpoints:

   'airport'  — the static reference data in travel-locations.js. Used for
                flights and cruises, where the thing being picked is a place and
                the catalog filters on an IATA code.
   'catalog'  — live inventory titles, read from the SAME
                GET /api/catalog/search the search button already calls, so
                hotels and packages suggest actual sellable stock rather than
                cities the merchant cannot book. Debounced and cached.

   The selected value is handed to the caller two ways: the input shows a human
   label ("Hyderabad (HYD)") while `input.dataset.searchToken` carries the value
   the API should filter on ("HYD"). mhVal() prefers the token, so a picked
   suggestion searches precisely and free typing still falls back to the raw
   string. Typing again clears the token — otherwise editing "Hyderabad (HYD)"
   down to "Hyd" would still secretly search HYD. */

const MH_AC_DEBOUNCE = 250;
const MH_AC_MAX = 5;

/* ------------------------------------------------------- popover placement */

/* Shared by this file and mh-datepicker.js (which loads after it).

   Popovers are moved to <body> and positioned `fixed` from the anchor's viewport
   rect, flipping above when there's no room below and clamping horizontally.
   Two separate reasons force the portal, and both were caught in the browser:

   1. `.mh-hero` needs `overflow:hidden` to clip the parallaxed background video,
      and that clip also shaved the calendar's bottom 37px — footer buttons
      included — when it opened from the hero's search card.
   2. `.mh-card` sets `backdrop-filter`, which per spec makes an element a
      containing block for *fixed* descendants. So `position:fixed` alone was not
      enough: offsets were resolved against the card, not the viewport, and the
      flip-above calculation silently produced the wrong coordinates.

   Living under <body> escapes both. `mh-scope` is re-applied to the moved node so
   the `--mh-*` tokens (including the dark-theme overrides, which are keyed off
   :root) still resolve outside the Home subtree.

   Must be re-run while open — a fixed element does not follow its anchor on
   scroll — hence mhTrackPopover below. */
function mhPlacePopover(anchor, pop, gap = 8) {
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || a.width;
  const h = pop.offsetHeight;
  const room = window.innerHeight - a.bottom;
  const above = room < h + gap && a.top > h + gap;

  pop.style.position = 'fixed';
  pop.style.top = above ? `${Math.round(a.top - h - gap)}px` : `${Math.round(a.bottom + gap)}px`;
  pop.style.bottom = 'auto';
  pop.style.left = `${Math.round(Math.max(8, Math.min(a.left, window.innerWidth - w - 8)))}px`;
  pop.style.right = 'auto';
}

/* Re-parents a popover to <body> once, keeping the tokens it needs. */
function mhPortalPopover(pop) {
  if (pop.dataset.mhPortaled) return;
  pop.dataset.mhPortaled = '1';
  pop.classList.add('mh-scope');
  document.body.appendChild(pop);
}

/* Keeps a fixed popover glued to its anchor until it closes. Returns a detach fn. */
function mhTrackPopover(anchor, pop, isOpen, gap) {
  const on = () => { if (isOpen()) mhPlacePopover(anchor, pop, gap); };
  window.addEventListener('scroll', on, true);
  window.addEventListener('resize', on);
  return () => {
    window.removeEventListener('scroll', on, true);
    window.removeEventListener('resize', on);
  };
}

/* Cache lives for the page session. Keyed by `type:query` so the hotel and
   package tabs don't read each other's rows. Also doubles as the "frequently
   selected" cache the brief asks for: picks are unshifted into MH_AC_RECENT and
   offered before any typing. */
const mhAcCache = new Map();
const MH_AC_RECENT_MAX = 6;
const mhAcRecent = new Map();   // source key -> array of rows

function mhAcRecentFor(key) { return mhAcRecent.get(key) || []; }

function mhAcRemember(key, row) {
  const list = mhAcRecentFor(key).filter(r => r.token !== row.token);
  list.unshift(row);
  mhAcRecent.set(key, list.slice(0, MH_AC_RECENT_MAX));
}

/* Rows for the "before you type" state: previous picks first, then the popular
   shortlist to fill the remaining slots. Popular destinations are the same
   static list Home's discover strip uses — passed in rather than imported so
   this file stays independent of the Home screen.

   The token differs by source for the same reason the search fields do: flight
   and cruise inventory carries an IATA code in `travel_details.origin`, hotel
   and package inventory carries a city name, so a code would match nothing. */
function mhAcPreTypeRows(recentKey, popular, source) {
  const rows = mhAcRecentFor(recentKey).map(r => ({ ...r, group: 'Recently used' }));
  const taken = new Set(rows.map(r => String(r.token).toLowerCase()));
  for (const p of popular || []) {
    if (rows.length >= MH_AC_MAX) break;
    const token = source === 'airport' ? p.code : p.city;
    if (taken.has(String(token).toLowerCase())) continue;
    rows.push({
      token,
      value: source === 'airport' ? `${p.city} (${p.code})` : p.city,
      primary: `${p.flag ? `${p.flag} ` : ''}${p.city}`,
      secondary: p.country || '',
      badge: source === 'airport' ? p.code : '',
      group: 'Popular with partners',
    });
  }
  return rows.slice(0, MH_AC_MAX);
}

/* <mark> around the typed run, so "Hyd" reads as **Hyd**erabad. Escapes first —
   these strings include user input. */
function mhAcHighlight(text, query) {
  const safe = escapeHtml(String(text ?? ''));
  const q = String(query || '').trim();
  if (!q) return safe;
  const at = safe.toLowerCase().indexOf(escapeHtml(q).toLowerCase());
  if (at < 0) return safe;
  const len = escapeHtml(q).length;
  return `${safe.slice(0, at)}<mark class="mh-ac-mark">${safe.slice(at, at + len)}</mark>${safe.slice(at + len)}`;
}

/* ------------------------------------------------------------------ sources */

function mhAcAirportRows(query) {
  return searchTravelLocations(query, MH_AC_MAX).map(loc => ({
    token: travelLocationSearchToken(loc),
    value: travelLocationInputValue(loc),
    primary: travelLocationLabel(loc),
    secondary: loc.airport || '',
    badge: loc.code,
  }));
}

/* Hotels / packages: distinct titles from live inventory.
   Uses `q`, not `destination`. `destination` filters on the destination code/city
   only, so typing a property name ("Taj") returned nothing while the inventory
   plainly contained "Taj Coromandel · Chennai". `q` is the endpoint's existing
   free-text filter and spans title, airline, flight number and both city fields —
   so both "Taj" and "Chennai" now find that row. No new endpoint either way. */
async function mhAcCatalogRows(query, travelType) {
  const { data } = await axios.get(`${API_BASE}/api/catalog/search`, {
    headers: partnerAuthHeaders(),
    params: { travel_type: travelType, q: query, page_size: 12 },
  });
  const seen = new Set();
  const rows = [];
  for (const item of data.items || []) {
    const d = item.details || {};
    const title = item.title || '';
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const city = d.destination_city || d.city || d.destination || '';
    rows.push({
      token: city || title,
      value: title,
      primary: title,
      secondary: [city, d.country].filter(Boolean).join(', '),
      badge: '',
    });
    if (rows.length >= MH_AC_MAX) break;
  }
  return rows;
}

async function mhAcFetch(source, travelType, query) {
  const key = `${source}:${travelType}:${query.toLowerCase()}`;
  if (mhAcCache.has(key)) return mhAcCache.get(key);
  let rows = [];
  try {
    rows = source === 'catalog'
      ? await mhAcCatalogRows(query, travelType)
      : mhAcAirportRows(query);
  } catch (err) {
    /* A failed suggestion lookup must never block typing or searching — fall
       back to the static places so the field still helps. */
    rows = mhAcAirportRows(query);
  }
  mhAcCache.set(key, rows);
  return rows;
}

/* ------------------------------------------------------------------ attach */

/* opts: { source: 'airport'|'catalog', travelType: string }
   Idempotent — re-rendering a search card and re-attaching is safe. */
function mhAttachAutocomplete(input, opts = {}) {
  if (!input || input.dataset.mhAc) return;
  input.dataset.mhAc = '1';

  const source = opts.source || 'airport';
  const travelType = opts.travelType || 'flight';
  const recentKey = `${source}:${travelType}`;
  const host = input.closest('.mh-field') || input.parentElement;
  host.classList.add('mh-ac-host');

  const list = document.createElement('div');
  list.className = 'mh-ac-list';
  list.setAttribute('role', 'listbox');
  list.id = `${input.id || 'mhAc'}-listbox`;
  mhPortalPopover(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('autocomplete', 'off');

  let rows = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  let untrack = null;
  /* Open state now lives on the list, not the host — the list is a <body> child,
     so a descendant selector off the host could never reach it. */
  const isOpen = () => list.classList.contains('mh-open');

  const close = () => {
    host.classList.remove('mh-ac-open');
    list.classList.remove('mh-open');
    list.innerHTML = '';
    rows = []; active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (untrack) { untrack(); untrack = null; }
  };

  /* Called once the list is on-screen — offsetHeight is 0 while display:none. */
  const place = () => {
    mhPlacePopover(host, list);
    if (!untrack) untrack = mhTrackPopover(host, list, isOpen);
  };

  const paint = (query) => {
    if (!rows.length) {
      list.innerHTML = `<div class="mh-ac-empty">No matching locations found.</div>`;
      list.style.width = `${Math.round(Math.max(host.getBoundingClientRect().width, 240))}px`;
      host.classList.add('mh-ac-open');
      list.classList.add('mh-open');
      input.setAttribute('aria-expanded', 'true');
      place();
      return;
    }
    /* Width follows the field so the list lines up under it. */
    list.style.width = `${Math.round(Math.max(host.getBoundingClientRect().width, 290))}px`;
    let lastGroup = null;
    list.innerHTML = rows.map((r, i) => {
      /* Group headings only appear in the pre-type state, where rows carry a
         `group`; a real query returns one ranked list and labelling it would
         imply a distinction that isn't there. */
      const heading = r.group && r.group !== lastGroup
        ? `<div class="mh-ac-group" role="presentation">${escapeHtml(r.group)}</div>` : '';
      lastGroup = r.group || lastGroup;
      return `${heading}
      <div class="mh-ac-item${i === active ? ' active' : ''}" role="option" id="${list.id}-o${i}"
           aria-selected="${i === active}" data-mh-ac-i="${i}">
        <span class="mh-ac-pin" aria-hidden="true">${r.badge ? '✈' : '◉'}</span>
        <span class="mh-ac-text">
          <span class="mh-ac-primary">${mhAcHighlight(r.primary, query)}</span>
          ${r.secondary ? `<span class="mh-ac-secondary">${mhAcHighlight(r.secondary, query)}</span>` : ''}
        </span>
        ${r.badge ? `<span class="mh-ac-code">${escapeHtml(r.badge)}</span>` : ''}
      </div>`;
    }).join('');
    host.classList.add('mh-ac-open');
    list.classList.add('mh-open');
    input.setAttribute('aria-expanded', 'true');
    place();
  };

  const setActive = (i) => {
    active = i;
    [...list.querySelectorAll('.mh-ac-item')].forEach((el, n) => {
      const on = n === i;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) {
        el.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', el.id);
      }
    });
  };

  const choose = (i) => {
    const row = rows[i];
    if (!row) return;
    input.value = row.value;
    input.dataset.searchToken = row.token;
    mhAcRemember(recentKey, row);
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  input.addEventListener('input', () => {
    /* Free typing invalidates any previously picked precise token. */
    delete input.dataset.searchToken;
    const query = input.value.trim();
    clearTimeout(timer);
    if (!query) { close(); return; }
    const mine = ++seq;
    timer = setTimeout(async () => {
      const found = await mhAcFetch(source, travelType, query);
      if (mine !== seq) return;           // a newer keystroke already won
      rows = found; active = -1;
      paint(query);
    }, MH_AC_DEBOUNCE);
  });

  /* Focus with an empty field offers previous picks and popular destinations
     instead of nothing — the same "before you type" state the public site has. */
  input.addEventListener('focus', () => {
    if (input.value.trim()) return;
    const pre = mhAcPreTypeRows(recentKey, opts.popular, source);
    if (!pre.length) return;
    rows = pre; active = -1;
    paint('');
  });

  input.addEventListener('keydown', (e) => {
    const open = host.classList.contains('mh-ac-open');
    if (e.key === 'ArrowDown') {
      if (!open) return;
      e.preventDefault();
      setActive(active + 1 >= rows.length ? 0 : active + 1);
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      setActive(active - 1 < 0 ? rows.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      /* stopImmediatePropagation, not just preventDefault: Home also binds
         Enter-to-search on these same inputs, and picking a city out of the list
         should commit the choice without firing a search in the same keypress. */
      if (open && active >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(active);
      }
    } else if (e.key === 'Escape') {
      if (open) { e.stopPropagation(); close(); }
    } else if (e.key === 'Tab') {
      close();
    }
  });

  /* mousedown, not click: click fires after blur, by which point the list is gone. */
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-mh-ac-i]');
    if (!item) return;
    e.preventDefault();
    choose(Number(item.dataset.mhAcI));
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}
