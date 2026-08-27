'use strict';
/* ===========================================================================
   hotel-filters.js — what a property can be filtered and sorted BY.
   ===========================================================================
   The panel itself is filter-engine.js. This file is the hotel half: a list of
   definitions, a list of sorts, and the readers they share.

   WHAT THE BACKEND ACTUALLY SENDS, and therefore what can be filtered. The
   results grid is fed by ``GET /api/customer/hotels`` -> ``HotelSearchResult``,
   whose whole shape is:

       id  name  image  stars  guest_rating  location
       distanceKm  pricePerNight  amenities[]  cancellation_policy

   Seven filters below read those fields and render. The rest are defined
   against the field names the API would use and render NOTHING today, because
   no row carries them — property type, brand, meal plan, room type, bed type,
   payment options, deals and property policies are not columns on
   ``customer_hotels``. Meal plan, room type and bed type DO exist, but on
   ``customer_hotel_rooms``, which only the per-hotel Details endpoint returns;
   they are not on a results row, so they cannot narrow a results grid.

   The engine decides all of that from the data, so the day any of those fields
   is added to HotelSearchResult its filter appears on its own — with counts, in
   the URL, in "clear all". Nothing here is invented to fill a gap, and nothing
   is greyed out to promise one.

   DERIVED FACETS ARE NOT INVENTED DATA. `neighbourhood`, `city`, the guest
   rating bands and the cancellation window are all read out of fields the API
   really sends — "Banjara Hills, Hyderabad" genuinely contains both an area and
   a city. Deriving a facet from a real value is not the same as making one up.
   =========================================================================== */

const HotelFilters = (function () {

  const nz = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const km = n => `${Number(n || 0).toFixed(0)} km`;

  const priceOf = h => nz(h && h.pricePerNight);
  const ratingOf = h => nz(h && h.guestRating);
  const starsOf = h => nz(h && h.stars);
  const distanceOf = h => nz(h && h.distanceKm);

  /* "Banjara Hills, Hyderabad" -> area / city. Both are real values in the one
     `location` string the API sends; splitting it is reading, not inventing. A
     location with no comma is treated as a city with no stated area, which is
     what a single-token value means. */
  const parts = h => String((h && h.location) || '').split(',').map(s => s.trim()).filter(Boolean);
  const neighbourhoodOf = h => { const p = parts(h); return p.length > 1 ? p[0] : null; };
  const cityOf = h => { const p = parts(h); return p.length ? p[p.length - 1] : null; };

  /* Guest-rating bands. The thresholds are the ones the spec names; a property
     is placed by its real score, and a band with nobody in it never appears
     because the engine only offers options the rows produce. */
  const RATING_BANDS = [
    { id: 'excellent', label: 'Excellent', note: '4.5 and above', min: 4.5 },
    { id: 'very-good', label: 'Very good', note: '4.0 and above', min: 4.0 },
    { id: 'good',      label: 'Good',      note: '3.5 and above', min: 3.5 },
    { id: 'average',   label: 'Average',   note: '3.0 and above', min: 3.0 },
  ];
  const ratingBandOf = h => {
    const r = ratingOf(h);
    if (r == null) return null;
    const band = RATING_BANDS.find(b => r >= b.min);
    return band ? band.id : null;
  };
  const bandLabel = id => (RATING_BANDS.find(b => b.id === id) || {}).label || id;
  const bandNote = id => (RATING_BANDS.find(b => b.id === id) || {}).note || '';
  const bandOrder = id => RATING_BANDS.findIndex(b => b.id === id);

  /* The cancellation policy is one sentence of free text, not a code. What is
     genuinely IN it is whether cancellation is free and how long before
     check-in — so that is what becomes the facet, with the window kept because
     "free up to 48 hours" and "free up to 24 hours" are a real choice between
     two real rows. Text that says neither is left unclassified rather than
     guessed at: an unreadable policy must not become a reassuring badge. */
  const cancellationOf = h => {
    const t = String((h && h.cancellationPolicy) || '').toLowerCase();
    if (!t) return null;
    if (/non[- ]?refundable/.test(t)) return 'non-refundable';
    const m = /free cancellation up to (\d+)\s*hour/.exec(t);
    if (m) return `free-${m[1]}`;
    if (/free cancellation/.test(t)) return 'free';
    return null;
  };
  const cancellationLabel = key => {
    if (key === 'non-refundable') return 'Non-refundable';
    if (key === 'free') return 'Free cancellation';
    const m = /^free-(\d+)$/.exec(key);
    return m ? `Free cancellation · ${m[1]}h before` : key;
  };
  const cancellationOrder = key => {
    if (key === 'non-refundable') return 999;
    const m = /^free-(\d+)$/.exec(key);
    /* Longest free window first — it is the most generous, and the one someone
       filtering for flexibility wants at the top. */
    return m ? -Number(m[1]) : 0;
  };

  const DEFS = [
    { id: 'price', label: 'Price per night', type: 'range',
      get: priceOf, format: money, step: 100 },

    { id: 'stars', label: 'Star rating', type: 'list',
      get: starsOf,
      label_: k => `${k} star${Number(k) === 1 ? '' : 's'}`,
      /* Highest first: nobody scans star filters upward. */
      order: k => -Number(k) },

    { id: 'guestRating', label: 'Guest rating', type: 'list',
      get: ratingBandOf, label_: bandLabel, note: bandNote, order: bandOrder },

    /* MULTI-VALUED: one property is both "Pool" and "Spa", so a row offers many
       values and matching is "has any of the ticked ones". */
    { id: 'amenities', label: 'Amenities', type: 'list', multi: true, search: true,
      get: h => h.amenities },

    { id: 'cancellation', label: 'Cancellation', type: 'list',
      get: cancellationOf, label_: cancellationLabel, order: cancellationOrder },

    { id: 'neighbourhood', label: 'Neighbourhood', type: 'list', search: true,
      get: neighbourhoodOf },

    { id: 'city', label: 'City', type: 'list', get: cityOf },

    { id: 'distance', label: 'Distance from airport', type: 'range',
      get: distanceOf, format: km, step: 1 },

    /* ------------------------------------------------------------------
       Defined, and deliberately empty until the API says otherwise.
       Each reads the field name HotelSearchResult would use. None of them
       renders today; all of them will, unchanged, the day it does.
       ------------------------------------------------------------------ */
    { id: 'propertyType', label: 'Property type', type: 'list', get: h => h.propertyType },
    { id: 'brand', label: 'Brand', type: 'list', search: true, get: h => h.brand },
    { id: 'mealPlan', label: 'Meal plan', type: 'list', multi: true, get: h => h.mealPlans },
    { id: 'roomType', label: 'Room type', type: 'list', multi: true, get: h => h.roomTypes },
    { id: 'bedType', label: 'Bed type', type: 'list', multi: true, get: h => h.bedTypes },
    { id: 'payment', label: 'Payment options', type: 'list', multi: true, get: h => h.paymentOptions },
    { id: 'deals', label: 'Deals', type: 'list', multi: true, get: h => h.deals },
    { id: 'policies', label: 'Property policies', type: 'list', multi: true, get: h => h.policies },
  ];

  const n = (v, fallback) => (v == null || Number.isNaN(v) ? fallback : v);
  const has = (rows, fn) => rows.some(h => fn(h) != null);

  /** A percentage off, if the API ever sends an original price to compare
   *  against. Nothing sends one today, so "Highest discount" stays hidden. */
  const discountOf = h => {
    const was = nz(h && (h.originalPrice != null ? h.originalPrice : h.strikePrice));
    const now = priceOf(h);
    if (was == null || now == null || was <= now) return null;
    return (was - now) / was;
  };

  const SORTS = [
    { id: 'recommended', label: 'Recommended',
      /* Neither the cheapest nor the best-rated property is "recommended" on
         its own. Guest rating and price are each scaled to 0..1 across the
         CURRENT result set; rating counts double, because someone browsing a
         results page is choosing a place to sleep before a saving. Scaled per
         set so a ₹2,000 spread and a ₹60,000 one both use the whole scale. */
      prepare(rows) {
        const span = arr => { const lo = Math.min(...arr); return { lo, span: Math.max(...arr) - lo || 1 }; };
        const prices = rows.map(priceOf).filter(v => v != null);
        const ratings = rows.map(ratingOf).filter(v => v != null);
        const p = prices.length ? span(prices) : null;
        const r = ratings.length ? span(ratings) : null;
        return h => {
          let s = 0;
          if (r) s -= 2 * ((n(ratingOf(h), r.lo) - r.lo) / r.span);
          if (p) s += (n(priceOf(h), p.lo) - p.lo) / p.span;
          return s;
        };
      } },
    { id: 'price-asc', label: 'Price: low to high', key: h => n(priceOf(h), Infinity),
      available: rows => has(rows, priceOf) },
    { id: 'price-desc', label: 'Price: high to low', key: h => -n(priceOf(h), -Infinity),
      available: rows => has(rows, priceOf) },
    { id: 'rating-desc', label: 'Guest rating', key: h => -n(ratingOf(h), -Infinity),
      available: rows => has(rows, ratingOf) },
    { id: 'stars-desc', label: 'Star rating', key: h => -n(starsOf(h), -Infinity),
      available: rows => has(rows, starsOf) },
    { id: 'distance-asc', label: 'Distance', key: h => n(distanceOf(h), Infinity),
      available: rows => has(rows, distanceOf) },
    { id: 'value', label: 'Best value',
      /* Rating per rupee — the most stars-per-money, not the cheapest. */
      key: h => {
        const r = ratingOf(h), p = priceOf(h);
        return (r == null || p == null || p <= 0) ? Infinity : -(r / p);
      },
      available: rows => has(rows, ratingOf) && has(rows, priceOf) },
    { id: 'discount-desc', label: 'Highest discount', key: h => -n(discountOf(h), -Infinity),
      available: rows => has(rows, discountOf) },
  ];

  const panel = FilterEngine.create({
    defs: DEFS, sorts: SORTS, prefix: 'h_', defaultSort: 'recommended',
    /* Ties settle by name, so equal-priced properties keep a stable order
       between renders rather than shuffling. */
    tiebreak: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
  });

  return Object.assign(panel, {
    priceOf, ratingOf, starsOf, distanceOf,
    neighbourhoodOf, cityOf, cancellationOf, cancellationLabel, ratingBandOf,
    RATING_BANDS,
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HotelFilters;
