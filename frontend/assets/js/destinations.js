'use strict';
/* ===========================================================================
   destinations.js — where a hotel search can go, and how typing finds it.
   ===========================================================================
   The hotel counterpart to airports.js, and it exists for the same reason: the
   landing page needs a destination picker without loading the hotel catalogue,
   the hotel image map and a results renderer to get one.

   TWO SOURCES, MERGED, AND THEY ARE NOT THE SAME KIND OF THING.

     SEED (below) — the destinations this company markets. Cities and regions,
     taken from what the landing page actually sells. Static, ~1KB, available on
     every page including the one with no catalogue.

     merge(rows) — everything derivable from the live hotel catalogue once it
     loads: the hotel names themselves, and the areas and cities their
     `location` field names. Called by the results page; the seed is what the
     landing page runs on alone.

   WHAT IS DELIBERATELY ABSENT: landmarks and tourist attractions. The spec asks
   for them and there is no field anywhere in this product that carries one —
   not in the catalogue, not in the packages, not in the location reference.
   Writing "Charminar" in here would be inventing inventory data in the UI
   layer, and the first person to search it would get a destination we cannot
   fulfil. The `kind` below already supports 'landmark', so the day a feed
   carries them this file gains rows and nothing else changes.
   =========================================================================== */

const JPDestinations = (function () {

  const RECENT_KEY = 'jpc_recent_destinations';
  const RECENT_MAX = 5;
  const SUGGEST_MAX = 8;

  /* The destinations the landing page markets — its Popular Destinations band
     and its featured packages — plus the cities we fly to, since "a hotel near
     the airport" is the other half of a flight booking. Nothing here is a place
     we do not sell. */
  const SEED = [
    { key: 'Goa',        label: 'Goa',        sub: 'Beach state · India',    kind: 'region' },
    { key: 'Kashmir',    label: 'Kashmir',    sub: 'Valley · India',         kind: 'region' },
    { key: 'Kerala',     label: 'Kerala',     sub: 'Backwaters · India',     kind: 'region' },
    { key: 'Manali',     label: 'Manali',     sub: 'Hill station · India',   kind: 'city' },
    { key: 'Bali',       label: 'Bali',       sub: 'Island · Indonesia',     kind: 'region' },
    { key: 'Dubai',      label: 'Dubai',      sub: 'City · UAE',             kind: 'city' },
    { key: 'Thailand',   label: 'Thailand',   sub: 'Country · South-East Asia', kind: 'region' },
    { key: 'Maldives',   label: 'Maldives',   sub: 'Islands · Indian Ocean', kind: 'region' },
    { key: 'Hyderabad',  label: 'Hyderabad',  sub: 'City · India',           kind: 'city' },
    { key: 'Delhi',      label: 'Delhi',      sub: 'City · India',           kind: 'city' },
    { key: 'Bengaluru',  label: 'Bengaluru',  sub: 'City · India',           kind: 'city' },
    { key: 'Kolkata',    label: 'Kolkata',    sub: 'City · India',           kind: 'city' },
    { key: 'Bangkok',    label: 'Bangkok',    sub: 'City · Thailand',        kind: 'city' },
    { key: 'Jeddah',     label: 'Jeddah',     sub: 'City · Saudi Arabia',    kind: 'city' },
  ];

  /* Marketed first, before anything is typed. A subset of SEED, so it can never
     name somewhere the list itself does not carry. */
  const TRENDING = ['Goa', 'Kerala', 'Dubai', 'Bali', 'Maldives'];

  /* Filled by merge(). Kept apart from SEED so a second merge replaces the
     catalogue rows instead of stacking duplicates on top of them. */
  let catalogue = [];

  /** Rank for ordering: a person typing "Hyderabad" almost always means the
   *  city, not a hotel that happens to have it in its name. */
  const RANK = { city: 0, region: 0, area: 1, landmark: 1, resort: 2, hotel: 3 };
  const rank = d => (RANK[d.kind] === undefined ? 4 : RANK[d.kind]);

  const all = () => SEED.concat(catalogue);

  /**
   * Fold the live hotel catalogue in. `location` is "Area, City", so cities and
   * areas are both derivable; `name` is the property itself.
   * @param {Array} rows hotel rows, or anything with {name, location}
   */
  function merge(rows) {
    if (!Array.isArray(rows)) return;
    const cities = new Map();
    const areas = new Map();
    const properties = [];
    const seeded = new Set(SEED.map(d => d.key.toLowerCase()));

    rows.forEach(h => {
      const parts = String(h.location || '').split(',').map(s => s.trim()).filter(Boolean);
      const city = parts[parts.length - 1];
      const area = parts.length > 1 ? parts[0] : null;
      if (city) cities.set(city, (cities.get(city) || 0) + 1);
      if (area) areas.set(area, city);
      if (h.name) {
        /* A resort is a hotel that says so in its own name — the catalogue has
           no type field, and this is the only honest way to tell them apart. */
        const isResort = /\bresort\b/i.test(h.name);
        properties.push({
          key: h.name, label: h.name,
          sub: (isResort ? 'Resort · ' : 'Hotel · ') + (h.location || ''),
          kind: isResort ? 'resort' : 'hotel',
        });
      }
    });

    catalogue = []
      /* A city already in the seed keeps its seed row rather than gaining a
         second one that says the same thing with a different subtitle. */
      .concat([...cities].filter(([c]) => !seeded.has(c.toLowerCase()))
        .map(([c, n]) => ({ key: c, label: c, kind: 'city',
          sub: 'City · ' + n + ' propert' + (n === 1 ? 'y' : 'ies') })))
      .concat([...areas].map(([a, c]) => ({ key: a, label: a, sub: 'Area · ' + c, kind: 'area' })))
      .concat(properties);
  }

  function recent() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw) ? raw.slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }

  function remember(dest) {
    if (!dest) return;
    try {
      localStorage.setItem(RECENT_KEY,
        JSON.stringify([dest].concat(recent().filter(d => d !== dest)).slice(0, RECENT_MAX)));
    } catch { /* private mode — recents are a convenience, not a requirement */ }
  }

  const find = value => {
    const v = String(value || '').trim().toLowerCase();
    return v ? all().find(d => d.label.toLowerCase() === v) || null : null;
  };

  const has = value => !!find(value);

  /** What a typed box means. A picked row sets data-key; free text counts only
   *  when it names something exactly, so a half-typed word is reported rather
   *  than searched for. */
  function keyOf(value) {
    const hit = find(value);
    return hit ? hit.key : '';
  }

  /**
   * Rows for a query, in the shape the shared listbox wants.
   * Empty query: recents, then what we market, then everything else.
   */
  function match(query) {
    const q = String(query || '').trim().toLowerCase();
    const list = all();

    if (!q) {
      const recents = recent()
        .filter(d => list.some(x => x.label.toLowerCase() === d.toLowerCase()))
        .map(d => Object.assign({}, find(d), { group: 'Recent searches' }));
      const taken = new Set(recents.map(r => r.key.toLowerCase()));
      const trending = TRENDING
        .filter(t => !taken.has(t.toLowerCase()))
        .map(t => Object.assign({}, find(t), { group: 'Trending destinations' }))
        .filter(Boolean);
      trending.forEach(t => taken.add(t.key.toLowerCase()));
      const rest = list
        .filter(d => (d.kind === 'city' || d.kind === 'region') && !taken.has(d.key.toLowerCase()))
        .map(d => Object.assign({}, d, { group: 'Popular destinations' }));
      return recents.concat(trending).concat(rest).slice(0, 12);
    }

    return list
      .filter(d => d.label.toLowerCase().includes(q) || String(d.sub).toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b)
        || (b.label.toLowerCase().startsWith(q) ? 1 : 0) - (a.label.toLowerCase().startsWith(q) ? 1 : 0))
      .slice(0, SUGGEST_MAX)
      .map(d => Object.assign({}, d, { group: '' }));
  }

  return { SEED, TRENDING, merge, match, recent, remember, find, has, keyOf, all };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = JPDestinations;
