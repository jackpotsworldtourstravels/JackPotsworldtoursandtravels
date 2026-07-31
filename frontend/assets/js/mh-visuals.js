'use strict';
/* Merchant Portal — visual primitives for the booking surfaces.
   ---------------------------------------------------------------------------
   Why this file generates imagery instead of loading it:

   frontend/assets/images holds three files — the logo and two favicons. There
   are no airline logos, hotel photographs, cruise stills or destination shots
   in the repository, and no API returns an image URL (CatalogItemResponse
   carries `details` JSONB only; the seeded rows in 0027_seed_catalog_inventory
   have no image key). Pulling from an image CDN would put every result card on
   a third-party network request that a corporate network can block, so a
   merchant would be looking at broken tiles.

   So the "photography" is drawn: each card gets a deterministic inline SVG
   scene — a skyline for hotels, a horizon and hull for cruises, a beach for
   packages, a sky and wing for flights — tinted from a hash of the destination
   name. Same destination, same picture, every render, zero requests. Airline
   "logos" are monogram tiles on the same principle.

   The moment inventory starts carrying real image URLs, mhThumb() is the one
   function to change: return an <img> and every card follows.

   Loaded before partner-home.js and partner-request-ticket.js, both of which
   call into it. */

/* ------------------------------------------------------------------ hashing */

/* FNV-1a, kept small. Only needs to be stable and well-spread, not secure —
   it picks a palette entry, so a collision means two cities share a tint. */
function mhHash(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mhPick(list, seed) { return list[mhHash(seed) % list.length]; }

/* ------------------------------------------------------------ airline logos

   Real carrier marks, vendored into assets/images/airlines/ by
   scripts/fetch_airline_logos.mjs from the imgmongelli/airlines-logos-dataset.
   Files are named by IATA code, which is what the inventory can actually give us:
   travel_details.flight_number is "6E-1423" / "TG-338" / "AI-202", so the prefix
   before the separator IS the lookup key. airline-logos.js (generated) must load
   before this file.

   Nothing hotlinks to GitHub: a blocked CDN would turn every result card into a
   broken tile. Fallback order is IATA prefix -> airline name -> a drawn default
   icon; initials are never shown any more. */

const MH_TYPE_GLYPH = { flight: '✈', hotel: '🏨', cruise: '🚢', package: '🏝' };

/* The portals sit one level below `frontend/`, the public site sits at its root,
   so the generated map stores a root-relative directory and the prefix is worked
   out here rather than baked into the map. */
const MH_ASSET_PREFIX = /\/(merchant|admin|super-admin)(\/|$)/.test(location.pathname) ? '../' : '';

/* "6E-1423" -> 6E, "TG 338" -> TG, "AI202" -> AI, "ai-202" -> AI.
   IATA airline designators are two characters and may contain a digit ("6E",
   "9W"), so the pattern takes the first two alphanumerics and stops at the first
   separator — it must not swallow the numeric part of "AI202" into a 3-char code. */
function mhIataFromFlightNumber(flightNumber) {
  const s = String(flightNumber || '').trim().toUpperCase();
  if (!s) return null;
  const m = s.match(/^([A-Z0-9]{2})\s*[-\s/]?\s*\d/);
  return m ? m[1] : null;
}

/* Name lookup for inventory that names the carrier but carries no flight number.
   Tries the name as-is, then without a trailing "Airways"/"Airlines"/"Air Lines",
   because the dataset has "Etihad Airways" where a feed may say "Etihad". */
function mhIataFromName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw || typeof AIRLINE_NAME_TO_IATA === 'undefined') return null;
  if (AIRLINE_NAME_TO_IATA[raw]) return AIRLINE_NAME_TO_IATA[raw];
  const stripped = raw.replace(/\s+(airways|airlines|air lines|air)$/, '').trim();
  if (stripped && AIRLINE_NAME_TO_IATA[stripped]) return AIRLINE_NAME_TO_IATA[stripped];
  /* Last resort: the dataset name starts with what we were given
     ("Etihad" -> "Etihad Airways"). Only accepted when exactly one entry
     matches, so "Air" can't silently pick a random carrier. */
  const hits = Object.keys(AIRLINE_NAME_TO_IATA).filter(k => k.startsWith(raw));
  return hits.length === 1 ? AIRLINE_NAME_TO_IATA[hits[0]] : null;
}

/* Resolves to a vendored file path, or null when we have no logo for it. */
function mhAirlineLogoSrc(opts = {}) {
  if (typeof AIRLINE_LOGO_FILES === 'undefined') return null;
  const code = mhIataFromFlightNumber(opts.flightNumber) || mhIataFromName(opts.name);
  if (!code) return null;
  const file = AIRLINE_LOGO_FILES[code];
  return file ? `${MH_ASSET_PREFIX}${AIRLINE_LOGO_DIR}${file}` : null;
}

/* The "no logo" mark. Inline SVG rather than a default-airline.png: no extra
   request, no raster blur at any tile size, and it inherits currentColor so it
   themes with the portal. */
function mhDefaultAirlineIcon() {
  return `<svg class="mh-logo-fallback" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M21 15.5v-1.6a1 1 0 0 0-.62-.93L14 10.4V5.6a1.6 1.6 0 0 0-3.2 0v4.8l-6.38 2.57a1 1 0 0 0-.62.93v1.6l7-2.1v3.9l-2.2 1.5v1.2l3.8-1.1 3.8 1.1v-1.2l-2.2-1.5v-3.9z"/>
  </svg>`;
}

/* opts: { name, flightNumber, travelType, size:'sm'|'md' }

   Non-flight inventory (hotels, cruises, packages) has no carrier, so it keeps
   its type glyph instead of being given a misleading aeroplane. */
function mhAirlineLogo(opts = {}) {
  const size = opts.size || 'sm';
  const travelType = opts.travelType || 'flight';
  const src = mhAirlineLogoSrc(opts);

  if (src) {
    /* Deliberately NOT loading="lazy". Each logo is 3–12KB, a result set uses
       only a handful of distinct carriers (the whole vendored set is 503KB and
       repeats hit the HTTP cache), and the mark is primary content in the row a
       merchant is scanning — deferring it trades nothing for a blank tile. Lazy
       loading also proved fragile: an offscreen document never fires the
       intersection check, so the images stayed blank with no failed request to
       diagnose. `decoding="async"` still keeps decode off the critical path.

       width/height are set so the row doesn't reflow as images land, and the alt
       text names the carrier — besides the adjacent text this is the only way a
       screen reader learns whose fare this is, so it is labelled, not hidden. */
    return `<span class="mh-logo-tile mh-logo-${size}">
      <img class="mh-logo-img" src="${escapeHtml(src)}" width="96" height="40"
           alt="${escapeHtml(opts.name || 'Airline')} logo" decoding="async">
    </span>`;
  }
  if (travelType !== 'flight') {
    return `<span class="mh-logo-tile mh-logo-${size} mh-logo-glyph" aria-hidden="true">${
      MH_TYPE_GLYPH[travelType] || MH_TYPE_GLYPH.flight}</span>`;
  }
  return `<span class="mh-logo-tile mh-logo-${size} mh-logo-none"
    title="${escapeHtml(opts.name || 'Airline')}">${mhDefaultAirlineIcon()}</span>`;
}

/* A vendored file that somehow 404s (deleted asset, bad deploy) must degrade to
   the same default icon rather than showing a browser's broken-image glyph.
   Capture phase, because `error` on <img> does not bubble. */
function mhInitLogoFallback() {
  if (document.body.dataset.mhLogoFallback) return;
  document.body.dataset.mhLogoFallback = '1';
  document.addEventListener('error', e => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('mh-logo-img')) return;
    const tile = img.closest('.mh-logo-tile');
    if (!tile) return;
    tile.classList.add('mh-logo-none');
    tile.title = img.getAttribute('alt')?.replace(/ logo$/, '') || 'Airline';
    tile.innerHTML = mhDefaultAirlineIcon();
  }, true);
}

/* ------------------------------------------------------- destination scenes */

/* Sky gradients, dawn through dusk. Index is picked from the destination name,
   so Dubai is always the same warm sky and Singapore always the same teal one. */
const MH_SKIES = [
  ['#FFB88C', '#FF6B6B', '#2B1B4A'],   // sunset
  ['#7DD3FC', '#38BDF8', '#0C4A6E'],   // clear day
  ['#FDE68A', '#FB923C', '#7C2D12'],   // desert dusk
  ['#A5B4FC', '#6366F1', '#1E1B4B'],   // twilight
  ['#5EEAD4', '#14B8A6', '#134E4A'],   // tropical
  ['#FCA5A5', '#E879F9', '#4C1D95'],   // evening
];

/* A city silhouette that varies with the seed but always reads as a skyline:
   towers of differing heights across the baseline, a couple with spires. */
function mhSkylineShapes(seed) {
  const h = mhHash(seed);
    const bars = [];
  let x = 0;
  let i = 0;
  while (x < 160) {
    const w = 10 + ((h >> (i * 3)) & 7) * 2;          // 10–24
    const tall = 16 + ((h >> (i * 2 + 1)) & 15) * 2.6; // 16–55
    bars.push(`<rect x="${x}" y="${90 - tall}" width="${w - 2}" height="${tall + 2}" rx="1.5"/>`);
    if (((h >> i) & 3) === 0) {
      bars.push(`<rect x="${x + w / 2 - 1.2}" y="${90 - tall - 9}" width="2.4" height="9"/>`);
    }
    x += w;
    i++;
  }
  return bars.join('');
}

function mhSceneSvg(travelType, seed) {
  const [top, mid, dark] = mhPick(MH_SKIES, seed);
  const h = mhHash(seed);
  const sunX = 34 + (h % 90);
  const id = `mhsc${h.toString(36)}`;

  const sky = `
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${top}"/><stop offset="62%" stop-color="${mid}"/>
        <stop offset="100%" stop-color="${dark}"/>
      </linearGradient>
    </defs>
    <rect width="160" height="100" fill="url(#${id})"/>
    <circle cx="${sunX}" cy="34" r="13" fill="#FFF" opacity=".55"/>`;

  if (travelType === 'hotel') {
    return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">
      ${sky}
      <g fill="${dark}" opacity=".72">${mhSkylineShapes(seed)}</g>
      <rect y="88" width="160" height="12" fill="${dark}" opacity=".9"/>
    </svg>`;
  }
  if (travelType === 'cruise') {
    return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">
      ${sky}
      <path d="M0 66h160v34H0z" fill="${dark}" opacity=".55"/>
      <path d="M52 62h44l-4 10H56z" fill="#FFF" opacity=".92"/>
      <path d="M48 72h56l-8 11H56z" fill="#FFF" opacity=".8"/>
      <rect x="62" y="55" width="6" height="7" rx="1" fill="#FFF" opacity=".85"/>
      <rect x="72" y="55" width="6" height="7" rx="1" fill="#FFF" opacity=".85"/>
      <path d="M0 84q20-5 40 0t40 0 40 0 40 0" stroke="#FFF" stroke-opacity=".35" stroke-width="2" fill="none"/>
      <path d="M0 92q20-5 40 0t40 0 40 0 40 0" stroke="#FFF" stroke-opacity=".25" stroke-width="2" fill="none"/>
    </svg>`;
  }
  if (travelType === 'package') {
    return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">
      ${sky}
      <path d="M0 74h160v26H0z" fill="${dark}" opacity=".45"/>
      <path d="M0 86h160v14H0z" fill="#F5E6C8" opacity=".85"/>
      <path d="M124 86V56" stroke="${dark}" stroke-width="3" stroke-opacity=".8"/>
      <path d="M124 56q-16-6-22 4 12-2 22 2zM124 56q16-6 22 4-12-2-22 2zM124 54q-4-14 4-18-1 10 0 18z"
            fill="${dark}" opacity=".78"/>
      <path d="M18 88q12-16 24 0z" fill="${dark}" opacity=".35"/>
    </svg>`;
  }
  /* flight — sky, cloud bank, a wing edge across the corner */
  return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">
    ${sky}
    <ellipse cx="34" cy="78" rx="42" ry="13" fill="#FFF" opacity=".38"/>
    <ellipse cx="112" cy="86" rx="52" ry="15" fill="#FFF" opacity=".32"/>
    <path d="M160 20 96 62l64 6z" fill="${dark}" opacity=".55"/>
    <path d="M160 34 118 60l42 4z" fill="#FFF" opacity=".25"/>
  </svg>`;
}

/* The thumbnail a result card shows. `label` is overlaid so the picture is
   captioned rather than decorative — a drawn scene is evocative, not literal,
   and a merchant must still be able to read which place this is. */
function mhThumb(travelType, seedText, label) {
  return `<div class="mh-thumb mh-thumb-${escapeHtml(travelType || 'flight')}">
    ${mhSceneSvg(travelType, seedText || travelType || 'x')}
    ${label ? `<span class="mh-thumb-cap">${escapeHtml(label)}</span>` : ''}
  </div>`;
}

/* ------------------------------------------------------------ trust badges */

const MH_TRUST = [
  ['🏷', 'Best negotiated fare'],
  ['🔒', 'Secure payment'],
  ['🎧', '24×7 partner support'],
  ['⚡', 'Ticket issued right after approval'],
];

function mhTrustBadgesHtml() {
  return `<ul class="mh-trust" aria-label="Why book here">
    ${MH_TRUST.map(([icon, text]) => `<li><span aria-hidden="true">${icon}</span>${escapeHtml(text)}</li>`).join('')}
  </ul>`;
}

/* ------------------------------------------------------------------ ripple */

/* One document-level listener rather than a binding per button, so buttons
   rendered later (every result card, every passenger card) ripple without
   anyone remembering to wire them. Skipped under reduced-motion. */
function mhInitRipple() {
  if (document.body.dataset.mhRipple) return;
  document.body.dataset.mhRipple = '1';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  document.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.mh-btn, .mh-iconbtn, .mh-tab, .mh-chipbtn');
    if (!btn || btn.disabled) return;
    const r = btn.getBoundingClientRect();
    const ink = document.createElement('span');
    ink.className = 'mh-ink';
    const size = Math.max(r.width, r.height) * 2;
    ink.style.width = ink.style.height = `${size}px`;
    ink.style.left = `${e.clientX - r.left - size / 2}px`;
    ink.style.top = `${e.clientY - r.top - size / 2}px`;
    btn.appendChild(ink);
    ink.addEventListener('animationend', () => ink.remove(), { once: true });
  }, { passive: true });
}

/* --------------------------------------------------------- reveal on scroll */

/* Fades cards in as they enter the viewport. IntersectionObserver only —
   no polyfill, and if it's missing the cards are simply visible immediately
   (the class that hides them is added by JS, never by the stylesheet). */
let mhRevealObserver = null;

function mhReveal(scope) {
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!mhRevealObserver) {
    mhRevealObserver = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        en.target.classList.add('mh-in');
        mhRevealObserver.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
  }
  (scope || document).querySelectorAll('[data-mh-reveal]:not(.mh-in)').forEach(el => {
    el.classList.add('mh-pre');
    mhRevealObserver.observe(el);
  });
}
