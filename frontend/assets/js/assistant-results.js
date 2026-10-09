'use strict';
/* ===========================================================================
   assistant-results.js — what the Travel Assistant shows after it understands
   ===========================================================================
   The server says WHAT was asked (a destination, a package search, the places in
   a destination). This file fetches the real answer from the endpoints the site
   already has and shapes it for the conversation:

       GET /api/customer/packages                       tour packages
       GET /api/customer/destinations                   the Destinations shelf
       GET /api/customer/destinations/{id}/locations    a destination's areas
       GET /api/customer/destinations/{id}/attractions  its famous places

   NOTHING HERE IS A SECOND SEARCH. Every price, length, departure and
   availability it returns is a field of those responses; no figure is written
   in this file, and a destination with no packages gets an empty state, never a
   made-up one. The package page's own filters stay the package page's.

   PURE ON PURPOSE. No DOM and no globals beyond what is injected (`fetch`, a
   cache, a storage), so tests/js/assistant-results.test.mjs runs it in Node
   against mocked responses. travel-assistant.js owns drawing it.
   =========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AssistantResults = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const API = '/api/customer';
  const CTX_KEY = 'jpc_assistant_ctx';
  /** A search is forgotten after this long idle. A conversation that resumes
   *  the next morning is a new one, and carrying yesterday's destination into
   *  it is the stale-context mistake the brief warns about. */
  const CTX_TTL_MS = 15 * 60 * 1000;
  /** Availability changes; a response is reused for this long and no longer. */
  const DATA_TTL_MS = 60 * 1000;
  const SHOWN = 6;

  /* ------------------------------------------------------------- context */
  /** The storage key for one DOOR. The typed Travel Assistant and the Voice
   *  Assistant are two interfaces with two screens of results, so each keeps its
   *  own search: a spoken "only family packages" must not edit a search that is
   *  on the typed panel's screen, or the reverse. (No key = the typed panel's,
   *  which is what the key has always meant.) */
  function ctxKey(door) { return door && door !== 'assistant' ? CTX_KEY + '_' + door : CTX_KEY; }

  /** @returns the remembered search, or null if there is none or it has expired. */
  function loadContext(storage, now, door) {
    const key = ctxKey(door);
    try {
      const raw = storage && storage.getItem(key);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || !rec.ctx || typeof rec.at !== 'number' || (now - rec.at) > CTX_TTL_MS) {
        storage.removeItem(key);
        return null;
      }
      return rec.ctx;
    } catch { return null; }
  }

  /** null clears it. */
  function saveContext(storage, ctx, now, door) {
    const key = ctxKey(door);
    try {
      if (!storage) return;
      if (!ctx) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify({ ctx, at: now }));
    } catch { /* private mode: the conversation still works, it just forgets */ }
  }

  /** "Start over" is understood here, without a round trip: it is about the
   *  conversation, not about travel. */
  function isStartOver(text) {
    return /^\s*(?:start over|start again|new search|reset|clear (?:it|that|everything|the search)?|forget (?:it|that))\s*[.!]*\s*$/i
      .test(String(text || ''));
  }

  /* --------------------------------------------------------------- cache */
  /** Run `load` once per key per DATA_TTL_MS. A failed load is not kept, so a
   *  retry after a network error actually retries. */
  function cached(cache, key, load, now) {
    const hit = cache.get(key);
    if (hit && (now - hit.at) < DATA_TTL_MS) return hit.promise;
    const promise = Promise.resolve().then(load);
    cache.set(key, { at: now, promise });
    promise.catch(() => { if (cache.get(key) && cache.get(key).promise === promise) cache.delete(key); });
    return promise;
  }

  async function getJson(deps, path) {
    const res = await deps.fetch(API + path);
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function getCached(deps, path) {
    return cached(deps.cache, path, () => getJson(deps, path), deps.now ? deps.now() : Date.now());
  }

  /* ------------------------------------------------------------- packages */
  /** The query string for GET /packages. Only keys the API has; the style and
   *  the party size are not among them. `spread` widens a length by ±n days. */
  function packageQuery(p, spread) {
    const qs = new URLSearchParams();
    if (p.dest) qs.set('destination', p.dest);
    if (p.pkgType) qs.set('trip_type', p.pkgType);
    if (p.days) {
      const s = spread || 0;
      qs.set('min_days', String(Math.max(1, p.days - s)));
      qs.set('max_days', String(p.days + s));
    }
    if (p.month) qs.set('month', p.month);
    const out = qs.toString();
    return '/packages' + (out ? '?' + out : '');
  }

  /** Words that count as a package "being" a style. LITERAL on purpose: a
   *  package is described as family-friendly only if its own text says so, and
   *  claiming otherwise to fill a result list is the invented fact this file
   *  exists to avoid. */
  const STYLE_WORDS = {
    family: ['family', 'families'], honeymoon: ['honeymoon'], adventure: ['adventure'],
    beach: ['beach'], cruise: ['cruise'], heritage: ['heritage'], luxury: ['luxury'],
    budget: ['budget'],
  };

  function packageText(pkg) {
    return [pkg.name, pkg.blurb, pkg.destination]
      .concat(pkg.highlights || [], pkg.inclusions || [])
      .filter(Boolean).join(' ').toLowerCase();
  }

  function matchesPreference(pkg, preference) {
    const words = STYLE_WORDS[preference];
    if (!words) return false;
    const text = packageText(pkg);
    return words.some(w => text.includes(w));
  }

  function monthLabel(month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month || '');
    if (!m) return '';
    return new Date(Date.UTC(+m[1], +m[2] - 1, 1))
      .toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  /** The search in words: "5-day family Goa packages departing October 2026". */
  function describeSearch(p) {
    const bits = [];
    if (p.pkgType) bits.push(p.pkgType);
    if (p.days) bits.push(p.days + '-day');
    if (p.preference) bits.push(p.preference);
    if (p.dest) bits.push(p.dest);
    bits.push('tour packages');
    let out = bits.join(' ');
    if (p.month) out += ' departing ' + monthLabel(p.month);
    return out;
  }

  function packagesPageHref(p) {
    /* `type` and `month` are the two keys the packages page reads
       (travel-explore.js seedFromUrl) — the landing page's own card sends the
       same. Length and party are not read there, so they are not sent. */
    const qs = new URLSearchParams();
    if (p.dest) qs.set('type', p.dest);
    if (p.month) qs.set('month', p.month);
    const out = qs.toString();
    return 'packages.html' + (out ? '?' + out : '');
  }

  /** Destinations that currently have at least one package — what to offer when
   *  a search comes back empty. Read from the same list, never typed in. */
  async function packageDestinations(deps) {
    const rows = await getCached(deps, '/packages');
    return Array.from(new Set(rows.map(r => r.destination).filter(Boolean)));
  }

  /**
   * @param p      {dest?, days?, month?, pkgType?, preference?, travellers?}
   * @param deps   {fetch, cache, now?}
   * @returns {rows, shown, total, notes, empty, alternatives, href, summary}
   */
  async function searchPackages(p, deps) {
    const params = p || {};
    const notes = [];
    let rows = await getCached(deps, packageQuery(params, 0));

    /* A length nobody sells is not the end of the conversation: "a three-day
       trip" when the shortest is four days. One day either side, and say so. */
    if (!rows.length && params.days) {
      const wider = await getCached(deps, packageQuery(params, 1));
      if (wider.length) {
        rows = wider;
        notes.push('No ' + params.days + '-day packages right now — showing '
          + Math.max(1, params.days - 1) + '–' + (params.days + 1) + ' day trips.');
      }
    }

    if (rows.length && params.preference) {
      const hits = rows.filter(r => matchesPreference(r, params.preference));
      if (hits.length) {
        rows = hits;
        notes.push('Showing the packages that mention “' + params.preference + '”.');
      } else {
        notes.push('None of our packages are described as ' + params.preference
          + ' trips, so these are all the matches.');
      }
    }

    const empty = rows.length === 0;
    let alternatives = [];
    if (empty) {
      try { alternatives = (await packageDestinations(deps)).filter(n => n !== params.dest).slice(0, 4); }
      catch { /* the empty state is still true without them */ }
    }

    return {
      rows, shown: rows.slice(0, SHOWN), total: rows.length, notes, empty, alternatives,
      href: packagesPageHref(params), summary: describeSearch(params), params,
    };
  }

  /* ---------------------------------------------------------------- artwork */
  /** The picture for an image KEY, from the artwork manifests the page already
   *  loaded — the same files and the same `?v=` stamps the Tour Packages page's
   *  cards use (package-listing.js destArt). Returns null when no artwork
   *  shipped for the key, and the card is then drawn without one: no stock photo,
   *  no placeholder pretending to be one.
   *
   *  @param manifests {destinations?: {files, dir}, locations?: {files, dir}} */
  function resolveArt(key, manifests) {
    if (!key || !manifests) return null;
    for (const m of [manifests.destinations, manifests.locations]) {
      if (!m || !m.files || !m.files[key]) continue;
      const stamp = m.files[key];
      const v = typeof stamp === 'string' ? '?v=' + stamp : '';
      const dir = m.dir || '';
      return { src: dir + key + '.webp' + v, small: dir + key + '-480.webp' + v };
    }
    return null;
  }

  /** One result row, as the card draws it. Every value is the API's own, and
   *  the price rules are the Tour Packages page's (package-listing.js): the next
   *  departure's per-person price when there is one, the shelf price when not,
   *  and the shelf price named when it differs, so the cheaper number is never
   *  hidden. A package with no departure date says so rather than showing a
   *  blank — it is arranged on request. */
  function packageCard(pkg) {
    const shelf = pkg.priceFrom != null ? Number(pkg.priceFrom) : NaN;
    const next = pkg.price_next != null ? Number(pkg.price_next) : NaN;
    const price = Number.isFinite(next) ? next : shelf;
    const differs = Number.isFinite(next) && Number.isFinite(shelf) && Math.abs(shelf - next) > 0.5;
    return {
      id: pkg.id,
      imageKey: pkg.image || null,
      title: pkg.name,
      meta: [pkg.days ? pkg.days + ' days' : null, pkg.destination].filter(Boolean).join(' · '),
      price: Number.isFinite(price) ? formatPrice(price) : null,
      otherDates: differs ? formatPrice(shelf) : null,
      departure: pkg.next_departure ? 'Next ' + formatDay(pkg.next_departure) : 'Dates on request',
      href: 'package-details/' + encodeURIComponent(pkg.id),
    };
  }

  function formatPrice(n) {
    return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
  }

  function formatDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return '';
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
      .toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  /* --------------------------------------------------------------- places */
  /**
   * The places inside a destination, from whichever of its two lists the
   * traveller's own word asked for — and the other one when that is empty.
   *
   * @param list 'locations' (the areas) or 'attractions' (the famous places)
   * @returns {kind, rows, fellBack, notFound, empty, alternatives}
   */
  async function searchPlaces(slug, list, deps) {
    const order = list === 'locations' ? ['locations', 'attractions'] : ['attractions', 'locations'];
    for (let i = 0; i < order.length; i += 1) {
      let rows;
      try {
        rows = await getCached(deps, '/destinations/' + encodeURIComponent(slug) + '/' + order[i]);
      } catch (err) {
        /* 404 is "no such destination", which is a different answer from "a
           real destination with nothing mapped under it yet" — the API says so
           on purpose, and so does the reply. */
        if (err && err.status === 404) return { notFound: true, rows: [], empty: true, kind: order[0], alternatives: await shelfNames(deps) };
        throw err;
      }
      if (rows.length) return { kind: order[i], rows, fellBack: i > 0, empty: false };
    }
    return { kind: order[0], rows: [], empty: true, alternatives: await shelfNames(deps) };
  }

  /** The destinations on the shelf — GET /destinations, which is independent of
   *  inventory — optionally only those of one country. Each row is the API's own
   *  (`id`/`slug`, `name`, `country`, `image` key). */
  async function listDestinations(country, deps) {
    const rows = await getCached(deps, '/destinations');
    return country ? rows.filter(r => r.country === country) : rows;
  }

  async function shelfNames(deps) {
    try {
      const rows = await getCached(deps, '/destinations');
      return rows.map(r => r.name).slice(0, 4);
    } catch { return []; }
  }

  /** The two links a place can offer. A famous place has a page of its own and
   *  a "hotels near" page; an area has neither, so it goes to the hotel search
   *  that already matches hotels by their area. */
  function placeLinks(slug, row, kind) {
    if (kind === 'locations') {
      return { hotels: 'hotels.html?dest=' + encodeURIComponent(row.name) };
    }
    return {
      detail: 'destination/' + encodeURIComponent(slug) + '/' + encodeURIComponent(row.slug),
      hotels: 'hotels/' + encodeURIComponent(slug) + '/' + encodeURIComponent(row.slug),
    };
  }

  /* --------------------------------------------------------------- actions */
  /** Actions drawn inside the conversation. Everything else navigates. */
  const INLINE_ACTIONS = ['show_packages', 'show_places', 'show_place', 'show_destination', 'show_destinations'];
  function isInlineAction(type) { return INLINE_ACTIONS.indexOf(type) !== -1; }

  return {
    CTX_KEY, CTX_TTL_MS, DATA_TTL_MS, SHOWN,
    loadContext, saveContext, ctxKey, isStartOver, cached, resolveArt, listDestinations,
    packageQuery, matchesPreference, describeSearch, packagesPageHref,
    searchPackages, packageCard, formatPrice, formatDay, monthLabel,
    searchPlaces, placeLinks, isInlineAction, INLINE_ACTIONS,
  };
});
