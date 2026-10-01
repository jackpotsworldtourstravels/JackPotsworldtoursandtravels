'use strict';
/* ===========================================================================
   hotel-image-map.js — THE hotel photograph resolver. `window.HotelPhoto`.
   ===========================================================================
   Every surface that shows a picture for a hotel — results cards, the details
   gallery, the room / guest / review / payment / confirmation summaries, the
   destination and location shelves, package itineraries, the merchant and
   partner portals — asks this file, and only this file, what to show.

   THE RULE, NON-NEGOTIABLE: never show an image of a different hotel as though
   it represents the requested hotel. So there are exactly three answers, and
   the caller is always told which one it got (`kind`):

     'property'     a photograph VERIFIED to be of this property — same name,
                    same city, same area. Verified means a person looked at the
                    file and wrote the property down in VERIFIED_PROPERTIES
                    below. Nothing is inferred from a chain name.
     'destination'  no verified photo of the property exists, so a verified
                    photograph of the CITY is offered instead. It is never
                    silent: `label`/`note` say it is the destination and not the
                    hotel, and html() puts that on the picture itself. Surfaces
                    that must not show one (booking-summary thumbnails) pass
                    `allowDestination: false`.
     'placeholder'  neither exists. An honest branded panel saying a verified
                    hotel photo is unavailable — never default-hotel.webp, which
                    is a photograph of a real building in Pattaya.

   WHAT IS DELIBERATELY GONE. The old resolver had a 'brand' tier: "Taj
   anything" became the Taj Mahal Palace in Mumbai, "Hyatt anything" the Hyatt
   Regency in London, "Radisson" the Radisson Blu in Cologne, "Marriott" the
   Marriott Marquis in Washington, and "Novotel Hyderabad" (HITEC City) the
   Novotel at Hyderabad AIRPORT. It also trusted the API's `image` key, which
   the seed data set to those same chain files. Both are removed: the API key
   is not evidence of identity, and a chain is not a property.

   The city photographs are the curated destination set. That set used to
   hold Anantara Kihavah for the Maldives and Marina Bay Sands for Singapore —
   a resort and a hotel standing in for a place. Both slots now hold landmark
   photographs (Malé's beach, the Merlion); this file names those landmark
   files directly, so it never depended on the old ones.
   =========================================================================== */

/* The portals sit one level below frontend/, the public site at its root. */
const HOTEL_ASSET_PREFIX =
  /\/(merchant|admin|super-admin)(\/|$)/.test(location.pathname) ? '../' : '';

(function (global) {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ------------------------------------------------------------ normalising */
  function norm(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }
  const NOISE = new Set(['the', 'hotel', 'hotels', 'and', 'by', 'a', 'an', 'at', 'resort', 'resorts', 'spa']);

  /* Spellings a feed actually uses -> the one key the tables below are in. */
  const CITY_ALIASES = {
    'bangalore': 'bengaluru', 'bengaluru': 'bengaluru',
    'bombay': 'mumbai', 'mumbai': 'mumbai',
    'new delhi': 'delhi', 'delhi': 'delhi',
    'hyderabad': 'hyderabad', 'secunderabad': 'hyderabad',
    'srinagar': 'kashmir', 'kashmir': 'kashmir',
    'calcutta': 'kolkata', 'kolkata': 'kolkata',
    'panaji': 'goa', 'panjim': 'goa', 'goa': 'goa',
    'bangkok': 'bangkok', 'phuket': 'phuket',
    'male': 'maldives', 'maldives': 'maldives',
    'singapore': 'singapore', 'dubai': 'dubai', 'jaipur': 'jaipur',
    'bali': 'bali', 'tirupati': 'tirupati', 'tirumala': 'tirupati',
    'vijayawada': 'vijayawada', 'venice': 'venice', 'london': 'london',
    'cologne': 'cologne', 'washington': 'washington dc', 'washington dc': 'washington dc',
    'gurgaon': 'gurugram', 'gurugram': 'gurugram',
  };
  function cityKey(s) {
    const n = norm(s);
    if (!n) return '';
    if (CITY_ALIASES[n]) return CITY_ALIASES[n];
    /* "Hyderabad, Telangana" and "HITEC City Hyderabad" both carry the city
       as a word; take the first known one. */
    for (const k of Object.keys(CITY_ALIASES)) {
      if ((' ' + n + ' ').includes(' ' + k + ' ')) return CITY_ALIASES[k];
    }
    return n;
  }

  /** The facts about a hotel this file is allowed to use: its name and where
   *  it is. Accepts every shape the app has — the normalised results row, the
   *  raw API row, a package's itinerary row, a merchant ticket. */
  function identity(h) {
    h = h || {};
    const name = h.name || h.hotel_name || h.hotelName || '';
    const location = h.location || h.address || h.location_name || '';
    const parts = String(location).split(',').map(s => s.trim()).filter(Boolean);
    const city = cityKey(h.city || parts[parts.length - 1] || '') || cityKey(name);
    return { name, location, city, cityLabel: h.city || parts[parts.length - 1] || '' };
  }

  /* --------------------------------------------------- verified properties
     One row per photograph in assets/hotels/ that is of a known property.
     A hotel matches only when ALL of these hold:
       - its name, with the city, area and filler words taken out, is one of
         `names` (so "Novotel Bengaluru" -> "novotel");
       - its city is `city`;
       - one of `areas` appears in its name or its address.
     Anything less — a chain, a city, a guess — is not this property. */
  const VERIFIED_PROPERTIES = [
    { slug: 'novotel-bengaluru', subject: 'Novotel Bengaluru Outer Ring Road',
      names: ['novotel'], city: 'bengaluru', areas: ['outer ring road', 'orr'] },
    { slug: 'novotel-hyderabad', subject: 'Novotel Hyderabad Airport',
      names: ['novotel'], city: 'hyderabad', areas: ['airport', 'shamshabad', 'rgia'] },
    { slug: 'taj-palace', subject: 'The Taj Mahal Palace, Mumbai',
      names: ['taj mahal palace', 'taj mahal'], city: 'mumbai', areas: ['colaba', 'apollo bunder'], unique: true },
    { slug: 'hyatt-regency', subject: 'Hyatt Regency London – The Churchill',
      names: ['hyatt regency', 'hyatt regency churchill', 'hyatt regency london churchill'], city: 'london', areas: ['portman square', 'churchill'] },
    { slug: 'radisson', subject: 'Radisson Blu Hotel, Cologne',
      names: ['radisson blu', 'radisson'], city: 'cologne', areas: ['messe', 'deutz', 'cologne'] },
    { slug: 'marriott', subject: 'Washington Marriott Marquis',
      names: ['marriott marquis', 'washington marriott marquis'], city: 'washington dc', areas: ['mount vernon'], unique: true },
    { slug: 'hilton', subject: 'Hilton Molino Stucky Venice',
      names: ['hilton molino stucky', 'hilton molino stucky venice'], city: 'venice', areas: ['giudecca'], unique: true },
    { slug: 'oberoi', subject: 'The Oberoi, Gurgaon',
      names: ['oberoi', 'oberoi gurgaon', 'oberoi gurugram'], city: 'gurugram', areas: ['nh 8', 'nh8'], unique: true },
    { slug: 'atlantis-the-palm', subject: 'Atlantis The Palm, Dubai',
      names: ['atlantis palm', 'atlantis'], city: 'dubai', areas: ['palm'], unique: true },
    { slug: 'marina-bay-sands', subject: 'Marina Bay Sands, Singapore',
      names: ['marina bay sands'], city: 'singapore', areas: ['bayfront'], unique: true },
  ];

  const HOTEL_CREDITS_FALLBACK = {};   // filled from hotel-images.js when loaded
  function hotelCredit(slug) {
    const c = (typeof HOTEL_IMAGE_CREDITS !== 'undefined' && HOTEL_IMAGE_CREDITS[slug]) || HOTEL_CREDITS_FALLBACK[slug];
    return c ? { artist: c.artist, licence: c.licence, source: c.source || '' } : null;
  }
  function hotelStamp(slug) {
    const f = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : null;
    const v = f && f[slug];
    return typeof v === 'string' ? '?v=' + v : '';
  }

  function verifiedProperty(id) {
    const hay = ' ' + norm(id.name + ' ' + id.location) + ' ';
    for (const p of VERIFIED_PROPERTIES) {
      if (p.city !== id.city) continue;
      /* `unique`: a name only one building in the world carries (there is
         one Taj Mahal Palace, one Marina Bay Sands) needs no area to prove
         it. Everything else must name its area. */
      if (!p.unique && !p.areas.some(a => hay.includes(' ' + a + ' '))) continue;
      /* The name with the city (every spelling of it), the area words and
         the filler removed: "Novotel Bangalore Outer Ring Road" -> "novotel". */
      const cityWords = new Set([...Object.keys(CITY_ALIASES).filter(k => CITY_ALIASES[k] === p.city).join(' ').split(' '), ...NOISE]);
      const areaWords = new Set(p.areas.join(' ').split(' '));
      const withArea = norm(id.name).split(' ').filter(t => t && !cityWords.has(t));
      const core = withArea.filter(t => !areaWords.has(t));
      if (p.names.includes(withArea.join(' ')) || p.names.includes(core.join(' '))) return p;
    }
    return null;
  }

  /* ------------------------------------------------------- city photographs
     Verified photographs OF THE CITY, each a landmark or a street, never a
     hotel. `subject` is what is in the frame, so the label can say it. */
  const D = 'assets/destinations/', L = 'assets/locations/';
  const CITY_PHOTOS = {
    hyderabad:  { dir: D, file: 'hyderabad',  big: true, subject: 'Charminar, Hyderabad', city: 'Hyderabad', credit: ['Tarunsamanta', 'CC BY-SA 4.0'], v: 'a90e4bc2' },
    bengaluru:  { dir: D, file: 'bengaluru',  big: true, subject: 'Vidhana Soudha, Bengaluru', city: 'Bengaluru', credit: ['DeepanjanGhosh', 'CC BY-SA 4.0'], v: '92672edb' },
    delhi:      { dir: D, file: 'delhi',      big: true, subject: 'Humayun’s Tomb, Delhi', city: 'Delhi', credit: ['Jakub Hałun', 'CC BY-SA 4.0'], v: '1889a5aa' },
    dubai:      { dir: D, file: 'dubai',      big: true, subject: 'Downtown Dubai', city: 'Dubai', credit: ['bulletrain743 (Pixabay)', 'CC0'], v: 'a1c41c5a' },
    goa:        { dir: D, file: 'goa',        big: true, subject: 'Palolem Beach, Goa', city: 'Goa', credit: ['Nico Crisafulli', 'CC BY 2.0'], v: 'bbc2f3b2' },
    jaipur:     { dir: D, file: 'jaipur',     big: true, subject: 'Hawa Mahal, Jaipur', city: 'Jaipur', credit: ['Rupeshsarkar', 'CC BY-SA 4.0'], v: '2a1d5af6' },
    kashmir:    { dir: D, file: 'kashmir',    big: true, subject: 'Dal Lake, Srinagar', city: 'Srinagar', credit: ['Suhail Skindar Sofi', 'CC BY-SA 4.0'], v: '7c05c70e' },
    kolkata:    { dir: D, file: 'kolkata',    big: true, subject: 'Victoria Memorial, Kolkata', city: 'Kolkata', credit: ['Subhrajyoti07', 'CC BY-SA 4.0'], v: '33fb003c' },
    mumbai:     { dir: D, file: 'mumbai',     big: true, subject: 'Gateway of India, Mumbai', city: 'Mumbai', credit: ['SriSriChinmaya', 'CC BY-SA 4.0'], v: '46f2196c' },
    bali:       { dir: D, file: 'bali',       big: true, subject: 'Tanah Lot, Bali', city: 'Bali', credit: ['CEphoto, Uwe Aranas', 'CC BY-SA 3.0'], v: '33a6ca59' },
    bangkok:    { dir: D, file: 'thailand',   big: true, subject: 'Wat Arun, Bangkok', city: 'Bangkok', credit: ['miketnorton', 'CC BY 2.0'], v: '2bf204a5' },
    tirupati:   { dir: D, file: 'tirupati',   big: true, subject: 'Tirumala, Tirupati', city: 'Tirupati', credit: ['Nikhilb239', 'CC BY-SA 4.0'], v: 'f8e0d8c9' },
    vijayawada: { dir: D, file: 'vijayawada', big: true, subject: 'Prakasam Barrage, Vijayawada', city: 'Vijayawada', credit: ['Krishna Chaitanya Velaga', 'CC BY-SA 4.0'], v: '7fbbf111' },
    /* The destination set's own files for these two are hotels. */
    singapore:  { dir: L, file: 'singapore__merlion-park', subject: 'Merlion Park, Singapore', city: 'Singapore', credit: ['Supanut Arunoprayote', 'CC BY 4.0'], v: 'e05cb052' },
    maldives:   { dir: L, file: 'maldives__artificial-beach', subject: 'Artificial Beach, Malé', city: 'Maldives', credit: ['Adam Jones', 'CC BY-SA 2.0'], v: '9c36a4b1' },
  };

  /* ------------------------------------------------ provider photographs
     A content provider (Hotelbeds today) returns photographs KEYED ON THE
     PROPERTY'S OWN SUPPLIER ID, so they are property-verified by construction:
     the supplier's code is the identity, never a name and never a city. The
     backend hands them over as complete URLs in `provider_images` (see
     customer_hotel_booking.py); nothing here builds a URL or holds a secret.

     TRUST IS GATED ON A STABLE IDENTITY. A row is believed only when it
     actually carries one — `source === 'hotelbeds'` or a `hotelbeds_code`. An
     `images`/`provider_images` array on a row without that identity is ignored,
     which is exactly what stops a seed row from borrowing supplier imagery. */
  function hasProviderIdentity(h) {
    if (!h) return false;
    const code = h.hotelbeds_code != null ? h.hotelbeds_code : h.hotelbedsCode;
    return h.source === 'hotelbeds' || (code != null && code !== '');
  }
  function providerList(h) {
    const list = (h && (h.provider_images || h.providerImages)) || [];
    return Array.isArray(list) ? list.filter(im => im && im.url) : [];
  }
  /** The provider photo to show, or null. When a room code is given, its own
   *  tagged photo is preferred; absent that (the sync does not tag rooms yet)
   *  it falls back to the property's primary photo — never another property's,
   *  never another room's. */
  function providerPhoto(id, hotel, opts) {
    if (!hasProviderIdentity(hotel)) return null;
    const imgs = providerList(hotel);
    if (!imgs.length) return null;
    const roomCode = opts && opts.roomCode;
    let pick = null;
    if (roomCode != null && roomCode !== '') {
      pick = imgs.find(im => (im.room_code || im.roomCode) === roomCode) || null;
    }
    if (!pick) pick = imgs.find(im => im.is_primary || im.isPrimary) || imgs[0];
    if (!pick || !pick.url) return null;
    const thumb = pick.thumb || pick.url, large = pick.large || pick.url;
    const name = id.name || 'This hotel';
    return {
      kind: 'property', slug: '', provider: pick.source || 'hotelbeds',
      name, city: id.city, cityLabel: id.cityLabel,
      src: large,
      srcset: thumb + ' 480w, ' + pick.url + ' 960w, ' + large + ' 1600w',
      srcBig: large,
      credit: null, subject: name,
      label: 'Property photo', note: '',
      alt: name + ' — photograph of the property',
      roomCode: pick.room_code || pick.roomCode || null,
    };
  }

  /* ---------------------------------------------------------------- resolve */
  /**
   * @param hotel  any hotel-shaped object (see identity()).
   * @param opts   { allowDestination = true, roomCode }
   * @returns {{kind, src, srcset, srcBig, credit, subject, label, note, alt,
   *            slug, city, cityLabel, name}}
   */
  function resolve(hotel, opts) {
    const o = Object.assign({ allowDestination: true }, opts || {});
    const id = identity(hotel);
    const name = id.name || 'This hotel';

    /* Priority 1: a provider photo of THIS property, when the row has a real
       supplier identity. Property-verified, so it outranks the curated set and
       is returned whatever `allowDestination` says. */
    const prov = providerPhoto(id, hotel, o);
    if (prov) return prov;

    const p = verifiedProperty(id);
    if (p) {
      const base = HOTEL_ASSET_PREFIX + 'assets/hotels/' + p.slug, v = hotelStamp(p.slug);
      return {
        kind: 'property', slug: p.slug, name, city: id.city, cityLabel: id.cityLabel,
        src: base + '.webp' + v, srcset: base + '-480.webp' + v + ' 480w, ' + base + '.webp' + v + ' 960w',
        srcBig: base + '.webp' + v,
        credit: hotelCredit(p.slug), subject: p.subject,
        label: 'Property photo', note: '', alt: name + ' — photograph of the property',
      };
    }

    const c = o.allowDestination ? CITY_PHOTOS[id.city] : null;
    if (c) {
      const base = HOTEL_ASSET_PREFIX + c.dir + c.file, v = '?v=' + c.v;
      return {
        kind: 'destination', slug: c.file, name, city: id.city, cityLabel: c.city,
        src: base + '.webp' + v,
        srcset: base + '-480.webp' + v + ' 480w, ' + base + '.webp' + v + ' 960w'
          + (c.big ? ', ' + base + '-1600.webp' + v + ' 1600w' : ''),
        srcBig: base + (c.big ? '-1600' : '') + '.webp' + v,
        credit: { artist: c.credit[0], licence: c.credit[1], source: '' }, subject: c.subject,
        label: 'Destination photo', note: 'Not a photo of this hotel',
        alt: c.subject + ' — a photograph of the destination, not of ' + name,
      };
    }

    return {
      kind: 'placeholder', slug: '', name, city: id.city, cityLabel: id.cityLabel,
      src: '', srcset: '', srcBig: '', credit: null, subject: '',
      label: 'Verified hotel photo unavailable', note: '',
      alt: 'No verified photograph of ' + name + ' is available',
    };
  }

  /* ------------------------------------------------------------------ markup */
  const MARK = '<svg class="hp-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">'
    + '<path d="M12 54V24l20-12 20 12v30"/><path d="M6 54h52"/><path d="M26 54V40h12v14"/>'
    + '<path d="M20 30h4M40 30h4M20 38h4M40 38h4"/></svg>';

  /**
   * The one figure every surface renders. The lifecycle is the design
   * system's: the branded panel is always underneath (placeholder), the
   * photograph arrives as `img.ds-dev` (faint + blurred), DS.develop sharpens
   * it once loaded and on screen, and `.is-settled` drops the transitions
   * (stable). Without jw-system.js the image is simply shown.
   *
   * opts: { surface: 'card'|'hero'|'gallery'|'thumb'|'tile', sizes, eager,
   *         allowDestination, className, credit (default true), photo }
   *   `photo` — a resolve() result, when the caller already has one.
   */
  function html(hotel, opts) {
    const o = Object.assign({ surface: 'card', credit: true }, opts || {});
    if (o.surface === 'thumb') o.allowDestination = false;
    const r = o.photo || resolve(hotel, o);
    const cls = ['hp', 'hp--' + r.kind, 'hp--' + o.surface, o.className || ''].join(' ').trim();
    const sizes = o.sizes || (o.surface === 'hero' ? '100vw' : o.surface === 'thumb' ? '96px' : '(max-width: 760px) 100vw, 420px');

    const ph = '<div class="hp-ph" aria-hidden="true">' + MARK
      + (o.surface === 'thumb' ? '' : '<span class="hp-ph-t">' + (r.kind === 'placeholder' ? 'Verified hotel photo unavailable' : '') + '</span>')
      + '</div>';

    if (r.kind === 'placeholder') {
      return '<figure class="' + esc(cls) + '" data-photo-kind="placeholder" role="img" aria-label="' + esc(r.alt) + '">'
        + ph + '</figure>';
    }

    const img = '<img class="hp-img ds-dev" src="' + esc(r.src) + '" srcset="' + esc(r.srcset) + '" sizes="' + esc(sizes) + '"'
      + ' width="960" height="720" loading="' + (o.eager ? 'eager' : 'lazy') + '" decoding="async" alt="' + esc(r.alt) + '">';

    const tag = r.kind === 'destination' && o.surface !== 'thumb'
      ? '<span class="hp-tag"><b>' + esc(r.label) + '</b>' + esc(r.note) + '</span>' : '';

    const credit = o.credit && r.credit
      ? '<figcaption class="hp-credit">' + (r.kind === 'destination' ? esc(r.subject) + ' · ' : '')
        + 'Photo: ' + esc(r.credit.artist) + (r.credit.licence ? ' · ' + esc(r.credit.licence) : '') + '</figcaption>'
      : '';

    return '<figure class="' + esc(cls) + '" data-photo-kind="' + esc(r.kind) + '" data-photo-slug="' + esc(r.slug) + '">'
      + ph + img + tag + credit + '</figure>';
  }

  /** Develop every hotel photograph inside `scope` through the design
   *  system's one observer, and make a failed file fall back to the branded
   *  panel rather than a broken-image glyph. Safe to call after every render. */
  function develop(scope) {
    const root = scope || document;
    const fresh = root.querySelectorAll('.hp .hp-img:not([data-hp-bound])');
    if (!fresh.length) return;
    const ds = global.DS && typeof global.DS.develop === 'function' ? global.DS : null;
    fresh.forEach(img => {
      img.dataset.hpBound = '1';
      /* A file that fails becomes the honest placeholder — and loses the
         label and credit that described a photograph no longer there. */
      const fail = () => {
        const fig = img.closest('.hp');
        if (fig) {
          fig.classList.remove('hp--property', 'hp--destination');
          fig.classList.add('hp--placeholder', 'is-failed');
          fig.dataset.photoKind = 'placeholder';
          fig.querySelectorAll('.hp-tag, .hp-credit').forEach(n => n.remove());
          const t = fig.querySelector('.hp-ph-t');
          if (t) t.textContent = 'Verified hotel photo unavailable';
        }
        img.remove();
      };
      if (img.complete && img.naturalWidth === 0 && img.currentSrc) fail();
      else img.addEventListener('error', fail, { once: true });
      /* One image at a time, so the design system's observer registers each
         exactly once however often this runs. */
      if (ds) ds.develop(img);
      else img.classList.add('is-dev', 'is-settled');
    });
  }

  /* Watch any container that re-renders hotel figures and develop what
     arrives, so no caller can forget to. */
  function watch(el) {
    if (!el || el.dataset.hpWatched) return;
    el.dataset.hpWatched = '1';
    develop(el);
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => develop(el)).observe(el, { childList: true, subtree: true });
    }
  }

  /** A booking-summary thumbnail. The property's own verified photograph or
   *  the honest placeholder — NEVER a city photograph: at the size of a
   *  summary thumbnail there is no room for a label, so a city picture there
   *  would be read as the hotel. */
  function thumb(hotel) {
    return html(hotel, { surface: 'thumb', allowDestination: false, credit: false });
  }

  global.HotelPhoto = { resolve, html, thumb, develop, watch, identity, VERIFIED_PROPERTIES, CITY_PHOTOS };

  /* Every surface renders these figures with innerHTML, many of them on each
     repaint (summary rails, galleries, shelves). One watcher on the body
     develops whatever arrives, batched to a frame, so no screen can forget —
     develop() only touches figures it has not bound yet. */
  let queued = false;
  const flush = () => { queued = false; develop(document); };
  const boot = () => {
    develop(document);
    if (typeof MutationObserver === 'undefined') return;
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(flush); } })
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else if (document.body) boot();

  /* =====================================================================
     LEGACY NAMES — the merchant and partner portals and the destination
     shelves still call these. They now go through resolve(), so they obey
     the same rule; the brand tier they used to reach is gone.
     ===================================================================== */
  /** @deprecated use HotelPhoto.resolve */
  global.hotelImage = function (name, city) {
    const r = resolve({ name, city });
    return { slug: r.slug, matched: r.kind, kind: r.kind, src: r.src, srcset: r.srcset, credit: r.credit };
  };
  /** @deprecated use HotelPhoto.html */
  global.hotelImageHtml = function (opts) {
    const o = opts || {};
    return html({ name: o.name, city: o.city, location: o.location }, { surface: 'card', sizes: o.sizes, eager: o.eager });
  };
  global.hotelImageSettle = function (scope) { develop(scope); };
  global.hotelImageInit = function () { develop(document); };
})(window);
