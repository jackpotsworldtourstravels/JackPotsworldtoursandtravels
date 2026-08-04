'use strict';
/* Hotel name -> local photograph. The single place any surface resolves an image.
   ---------------------------------------------------------------------------
   The photographs live in frontend/assets/hotels/ as real, freely licensed files
   vendored by scripts/fetch_hotel_images.py; hotel-images.js (generated) is the
   manifest and must load before this file. Nothing here builds a remote URL —
   a blocked or rate-limited upload.wikimedia.org must never be able to turn a
   result card into a broken image. Same rule as the airline logos.

   Resolution is tiered, and which tier fired is reported back as `matched`
   because the tiers do not mean the same thing:

     'property'  the photograph is of THIS hotel.
     'brand'     the photograph is of a DIFFERENT property of the same chain
                 ("Taj Coromandel" has no free photograph, so it lands on the Taj
                 Mahal Palace). Honest enough for a thumbnail, but the caller
                 gets told so it can label or suppress it.
     'default'   no match at all — default-hotel.webp, never a broken <img>,
                 never an empty box.

   Matching is case-insensitive and tolerant of the variations a hotel feed
   actually produces: punctuation, diacritics, "&" vs "and", a leading "The",
   and trailing noise like "Hotel", "Resort & Spa", "Bengaluru". */

/* The portals sit one level below frontend/, the public site sits at its root,
   so the generated manifest stores a root-relative directory and the prefix is
   worked out here. Deliberately not reusing mh-visuals.js's MH_ASSET_PREFIX:
   this module is loaded on surfaces that do not load mh-visuals.js. */
const HOTEL_ASSET_PREFIX =
  /\/(merchant|admin|super-admin)(\/|$)/.test(location.pathname) ? '../' : '';

/* Words that carry no identity. Stripped only when something is left over, so a
   hotel genuinely called "The Resort" doesn't normalise to the empty string. */
const HOTEL_NOISE_WORDS = new Set([
  'hotel', 'hotels', 'resort', 'resorts', 'spa', 'inn', 'suites', 'suite',
  'lodge', 'residency', 'residences', 'towers', 'tower', 'the', 'a', 'an',
  'by', 'and', 'at', 'de', 'international', 'group', 'ltd', 'pvt', 'limited',
]);

/* City/region words that appear after a brand in the seeded catalogue. Removing
   them is what lets "Novotel Bengaluru Outer Ring Road" reach "novotel bengaluru". */
const HOTEL_TRAILING_NOISE = new Set([
  'airport', 'city', 'centre', 'center', 'downtown', 'road', 'outer', 'ring',
  'north', 'south', 'east', 'west', 'central', 'palace' /* only as a trailer */,
]);

/* "Le Royal Méridien" -> "le royal meridien", "Hotel & Spa" -> "hotel and spa". */
function hotelNormalize(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')                              // O'Brien -> obrien
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hotelTokens(name) {
  return hotelNormalize(name).split(' ').filter(Boolean);
}

/* Drops noise words; returns the original tokens if that would empty the name. */
function hotelCoreTokens(name) {
  const tokens = hotelTokens(name);
  const core = tokens.filter(t => !HOTEL_NOISE_WORDS.has(t));
  return core.length ? core : tokens;
}

function hotelSlugify(tokens) {
  return tokens.join('-');
}

/* Every progressively-shorter candidate key for a name, longest first:
   "novotel bengaluru outer ring road" -> that, then "novotel bengaluru outer
   ring", ... , then "novotel". Longest-first matters: it must reach
   "novotel-hyderabad" before it reaches the bare "novotel" brand. */
function hotelCandidateKeys(name) {
  const core = hotelCoreTokens(name);
  const keys = [];
  const full = hotelTokens(name);
  if (full.length) keys.push(full.join(' '));
  for (let end = core.length; end > 0; end--) {
    const key = core.slice(0, end).join(' ');
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/* Resolve a hotel name (and optionally its city) to a slug + how we got there.
   Returns { slug, matched }. Never returns null. */
function hotelImageSlug(name, city) {
  const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
  const aliases = typeof HOTEL_IMAGE_ALIASES !== 'undefined' ? HOTEL_IMAGE_ALIASES : {};
  const brands = typeof HOTEL_IMAGE_BRANDS !== 'undefined' ? HOTEL_IMAGE_BRANDS : {};
  const fallback = typeof HOTEL_IMAGE_DEFAULT !== 'undefined' ? HOTEL_IMAGE_DEFAULT : 'default-hotel';

  const keys = hotelCandidateKeys(name);

  /* 1. Curated property aliases, and 2. a name that already IS a slug
        ("Marina Bay Sands" -> marina-bay-sands). Both are property-level, so
        they are tried together longest-first rather than as separate passes —
        otherwise a short alias could beat a longer exact slug. */
  for (const key of keys) {
    if (aliases[key] && known[aliases[key]]) return { slug: aliases[key], matched: 'property' };
    const slug = hotelSlugify(key.split(' '));
    if (known[slug]) return { slug, matched: 'property' };
  }

  /* 3. Brand + city, for a feed that names them separately
        ("Novotel" in Hyderabad -> novotel-hyderabad). Still property-level:
        it identifies this property, not just the chain. */
  if (city) {
    const cityTokens = hotelCoreTokens(city);
    for (const key of keys) {
      const slug = hotelSlugify(key.split(' ').concat(cityTokens));
      if (known[slug]) return { slug, matched: 'property' };
    }
    /* ...and the first brand token plus the city, so "Taj Coromandel" in Chennai
       would find a taj-chennai file if one were ever added. */
    const first = hotelCoreTokens(name)[0];
    if (first) {
      const slug = hotelSlugify([first].concat(cityTokens));
      if (known[slug]) return { slug, matched: 'property' };
    }
  }

  /* 4. Chain token anywhere in the name. A photograph of the chain, not of this
        property — reported as such. */
  for (const token of hotelCoreTokens(name)) {
    if (brands[token] && known[brands[token]]) return { slug: brands[token], matched: 'brand' };
  }

  return { slug: fallback, matched: 'default' };
}

/* Slugs listed as representative are a stand-in for the chain however they were
   reached, so a tier-1 hit on one of them is still only a brand match. Without
   this, "The Oberoi" normalises to the bare slug `oberoi` and would claim to be
   a photograph of the New Delhi property, which it is not. */
function hotelImageMatchLevel(slug, matched) {
  if (matched === 'default') return matched;
  const rep = typeof HOTEL_IMAGE_REPRESENTATIVE !== 'undefined' ? HOTEL_IMAGE_REPRESENTATIVE : [];
  return rep.includes(slug) ? 'brand' : matched;
}

/* Full descriptor for a hotel image: paths, srcset, credit, and how it matched.
   `city` is optional and only ever improves the match. */
function hotelImage(name, city) {
  const dir = (typeof HOTEL_IMAGE_DIR !== 'undefined' ? HOTEL_IMAGE_DIR : 'assets/hotels/');
  const { slug, matched } = hotelImageSlug(name, city);
  const base = `${HOTEL_ASSET_PREFIX}${dir}${slug}`;
  const credits = typeof HOTEL_IMAGE_CREDITS !== 'undefined' ? HOTEL_IMAGE_CREDITS : {};
  return {
    slug,
    matched: hotelImageMatchLevel(slug, matched),
    src: `${base}.webp`,
    srcset: `${base}-480.webp 480w, ${base}.webp 960w`,
    credit: credits[slug] || null,
  };
}

/* The markup a card uses. One function so every surface gets the same lazy
   loading, the same skeleton and the same fallback behaviour.

   opts: { name, city, sizes, eager }

   - The <figure> owns a fixed 4:3 box (CSS aspect-ratio + width/height on the
     <img>), so the row reserves its space before the file arrives and nothing
     reflows as photographs land. This is also what makes loading="lazy" work:
     an auto-sized box measures 0x0 before load, the lazy loader never sees it
     approach the viewport, and the image silently never loads. That exact bug
     cost an afternoon on the airline logos — do not remove the fixed box.
   - `eager` opts the first card or two out of lazy loading; below the fold,
     lazy is the default.
   - alt names the hotel. A decorative empty alt would be wrong: for a screen
     reader the picture is the only confirmation that the row is a hotel. */
function hotelImageHtml(opts = {}) {
  const name = opts.name || 'Hotel';
  const img = hotelImage(name, opts.city);
  const sizes = opts.sizes || '(max-width: 720px) 100vw, 224px';
  const loading = opts.eager ? 'eager' : 'lazy';

  /* CC BY / CC BY-SA oblige us to name the photographer somewhere the user can
     reach. It rides on the figure as a small overlay rather than a separate
     credits page so the obligation travels with the image. */
  const credit = img.credit && img.credit.artist
    ? `<figcaption class="mh-hotel-credit">Photo: ${escapeHtml(img.credit.artist)}` +
      `${img.credit.licence ? ` · ${escapeHtml(img.credit.licence)}` : ''}</figcaption>`
    : '';

  return `<figure class="mh-hotel-media is-loading" data-hotel-slug="${escapeHtml(img.slug)}"
    data-hotel-match="${escapeHtml(img.matched)}">
    <img class="mh-hotel-img" src="${escapeHtml(img.src)}"
         srcset="${escapeHtml(img.srcset)}" sizes="${escapeHtml(sizes)}"
         width="960" height="720" loading="${loading}" decoding="async"
         alt="${escapeHtml(name)}">
    ${credit}
  </figure>`;
}

/* Two things this has to survive:

   1. A file that 404s (bad deploy, deleted asset) must fall back to
      default-hotel.webp, never a browser's broken-image glyph. `error` on <img>
      does not bubble, hence capture phase.
   2. The skeleton must come off even when the image finished loading BEFORE
      this listener existed — a cached photograph decodes faster than the script
      that would have watched it. Hence the `.complete` sweep, which is also
      re-run after every render.

   The default itself is guarded by data-fallback so a missing default cannot
   loop the error handler. */
function hotelImageSettle(scope) {
  (scope || document).querySelectorAll('.mh-hotel-img').forEach(img => {
    if (img.complete && img.naturalWidth > 0) {
      img.closest('.mh-hotel-media')?.classList.remove('is-loading');
    }
  });
}

function hotelImageInit() {
  if (document.body.dataset.hotelImages) return;
  document.body.dataset.hotelImages = '1';

  document.addEventListener('load', e => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('mh-hotel-img')) return;
    img.closest('.mh-hotel-media')?.classList.remove('is-loading');
  }, true);

  document.addEventListener('error', e => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('mh-hotel-img')) return;
    const fig = img.closest('.mh-hotel-media');
    if (img.dataset.fallback) {              // the default failed too — stop here
      fig?.classList.remove('is-loading');
      fig?.classList.add('is-blank');
      return;
    }
    img.dataset.fallback = '1';
    const dir = (typeof HOTEL_IMAGE_DIR !== 'undefined' ? HOTEL_IMAGE_DIR : 'assets/hotels/');
    const slug = typeof HOTEL_IMAGE_DEFAULT !== 'undefined' ? HOTEL_IMAGE_DEFAULT : 'default-hotel';
    const base = `${HOTEL_ASSET_PREFIX}${dir}${slug}`;
    img.srcset = `${base}-480.webp 480w, ${base}.webp 960w`;
    img.src = `${base}.webp`;
    if (fig) fig.dataset.hotelMatch = 'default';
  }, true);
}
