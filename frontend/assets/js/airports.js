'use strict';
/* ===========================================================================
   airports.js — the airport reference, and how a typed query finds one.
   ===========================================================================
   WHY THIS IS ITS OWN FILE

   The table used to live inside travel-data.js, which meant the only way to put
   an airport picker on the landing page was to load a flight schedule and a
   hotel image map with it — and index.html says in as many words that it
   carries none of that weight. This is the ~2KB both pages actually need.

   NO DOM, NO WIDGET. match() returns plain rows; whoever is drawing a listbox
   decides what to do with them. The picker in the booking card and the one in
   the hotels panel are the same SearchWidgets.mountAutocomplete pointed at this
   — the alternative was a second copy of the keyboard handling, the grouping
   and the blur timing, which is exactly how the two would have drifted.

   THE OFFSET IS NOT DECORATION. Departure and arrival are both LOCAL times, so
   `arrival - departure` is only the real duration when both ends share a
   timezone. Hyderabad -> Jeddah 05:05 -> 08:50 subtracts to 3h45m; the flight
   actually takes 6h15m. travel-data.js's durationMinutes() converts both ends
   to UTC first, and these are what it converts with.
   =========================================================================== */

const JPAirports = (function () {

  const IST = 330;               // +05:30, in minutes

  const TABLE = {
    HYD: { city: 'Hyderabad',          country: 'India',        utc: IST },
    DEL: { city: 'Delhi',              country: 'India',        utc: IST },
    JAI: { city: 'Jaipur',             country: 'India',        utc: IST },
    CJB: { city: 'Coimbatore',         country: 'India',        utc: IST },
    AYJ: { city: 'Ayodhya',            country: 'India',        utc: IST },
    CCU: { city: 'Kolkata',            country: 'India',        utc: IST },
    NAG: { city: 'Nagpur',             country: 'India',        utc: IST },
    TIR: { city: 'Tirupati',           country: 'India',        utc: IST },
    TRV: { city: 'Thiruvananthapuram', country: 'India',        utc: IST },
    IXU: { city: 'Aurangabad',         country: 'India',        utc: IST },
    VGA: { city: 'Vijayawada',         country: 'India',        utc: IST },
    STV: { city: 'Surat',              country: 'India',        utc: IST },
    BLR: { city: 'Bengaluru',          country: 'India',        utc: IST },
    JED: { city: 'Jeddah',             country: 'Saudi Arabia', utc: 180 },
    MED: { city: 'Madinah',            country: 'Saudi Arabia', utc: 180 },
    BAH: { city: 'Bahrain',            country: 'Bahrain',      utc: 180 },
    BKK: { city: 'Bangkok',            country: 'Thailand',     utc: 420 },
  };

  /* Offered before anything is typed.
     EVERY CODE HERE EXISTS IN THE TABLE ABOVE — an earlier draft of this list
     named BOM and DXB, which nothing we sell flies to, and they silently
     vanished from the suggestions. "Popular" means popular among what we
     actually serve, so this list is checked against the table before use. */
  const POPULAR = ['HYD', 'DEL', 'BLR', 'CCU', 'BKK', 'JED'];

  /* Airports this traveller has actually used, most recent first. Kept short on
     purpose: a "recent" list long enough to scroll is just the full list again. */
  const RECENT_KEY = 'jpc_recent_airports';
  const RECENT_MAX = 5;
  const SUGGEST_MAX = 8;

  const has = code => Object.prototype.hasOwnProperty.call(TABLE, String(code || '').toUpperCase());

  /** The record for a code, or a usable stand-in. Never undefined: a code the
   *  table does not know still has to render as something. */
  function get(code) {
    const c = String(code || '').toUpperCase();
    return TABLE[c] || { city: c, country: '', utc: IST };
  }

  /** "HYD" -> "Hyderabad (HYD)". An unknown code prints as itself rather than
   *  as an empty box. */
  function label(code) {
    const c = String(code || '').toUpperCase();
    return TABLE[c] ? TABLE[c].city + ' (' + c + ')' : String(code || '');
  }

  /** "Hyderabad (HYD)" -> "HYD".
   *
   *  Falls back to matching the text against the table, then to the raw string,
   *  so a hand-typed city is carried rather than silently dropped. This is what
   *  a submitted form is read with when nothing was picked from the list. */
  function codeOf(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    const bracketed = /\(([A-Za-z]{3})\)\s*$/.exec(v);
    if (bracketed) return bracketed[1].toUpperCase();
    if (has(v)) return v.toUpperCase();
    const typed = v.toLowerCase();
    const hit = Object.keys(TABLE).find(c => TABLE[c].city.toLowerCase() === typed);
    return hit || v;
  }

  function recent() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(has).slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }

  function remember(code) {
    const c = String(code || '').toUpperCase();
    if (!has(c)) return;
    try {
      localStorage.setItem(RECENT_KEY,
        JSON.stringify([c].concat(recent().filter(x => x !== c)).slice(0, RECENT_MAX)));
    } catch { /* private mode — recents are a convenience, not a requirement */ }
  }

  /** One airport in the shape the shared listbox wants: key/label/sub/group. */
  function row(code, group) {
    const a = get(code);
    return { key: code, code: code, label: a.city, sub: code + ' · ' + a.country, group: group || '' };
  }

  function looksLike(code, q) {
    const a = TABLE[code];
    return code.toLowerCase().includes(q)
        || a.city.toLowerCase().includes(q)
        || a.country.toLowerCase().includes(q);
  }

  /**
   * Rows for a query. An empty query offers recents then popular; anything else
   * searches code, city and country so "Bombay", "BOM" and "Mumbai" would all
   * find the same airport if we flew there.
   *
   * @param {string} query
   * @param {string} [exclude] a code to leave out — the destination list should
   *        not offer the airport already chosen as the origin.
   */
  function match(query, exclude) {
    const skip = String(exclude || '').toUpperCase();
    const q = String(query || '').trim().toLowerCase();

    if (!q) {
      const recents = recent().filter(c => c !== skip);
      const popular = POPULAR.filter(c => has(c) && c !== skip && !recents.includes(c));
      return recents.map(c => row(c, 'Recent searches'))
        .concat(popular.map(c => row(c, 'Popular airports')));
    }

    return Object.keys(TABLE)
      .filter(c => c !== skip && looksLike(c, q))
      /* Code match first: somebody typing "DEL" means the airport, not every
         city whose name happens to contain those letters. */
      .sort((a, b) => (b.toLowerCase().startsWith(q) ? 1 : 0) - (a.toLowerCase().startsWith(q) ? 1 : 0))
      .slice(0, SUGGEST_MAX)
      .map(c => row(c, ''));
  }

  return { TABLE, IST, POPULAR, has, get, label, codeOf, match, remember, recent, row };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = JPAirports;
