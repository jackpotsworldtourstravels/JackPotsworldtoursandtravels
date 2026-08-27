'use strict';
/* ===========================================================================
   hotel-details.js — the expanded panel under a hotel card.
   ===========================================================================
   A LIST OF SECTIONS, EACH ITS OWN COMPONENT, EACH CONDITIONAL.

   Same shape as filter-engine.js and for the same reason: the hierarchy is
   declared once, and whether a part of it renders is decided by asking the
   DATA, never by a flag or a comment promising it later. Every section below
   is written in full. A section whose `has()` says the payload cannot fill it
   returns nothing and leaves no heading, no empty box and no "coming soon"
   behind — and starts appearing, complete, the moment the API sends its field.

   WHAT GET /api/customer/hotels/{id} ACTUALLY RETURNS:

       id  name  description  image  images[]  stars  guest_rating
       location  distanceKm  amenities[]  cancellation_policy
       rooms[]  -> id code name description bed_type size_label max_guests
                   price meal_plan cancellation_policy perks[] left

   So today: gallery, rooms, amenities, cancellation, and property information
   render. `houseRules`, `nearby`, `map` and `extraCharges` are defined against
   the field names the API would use and render nothing, because no property
   carries them. That is the whole difference between this file being finished
   and being a stub.

   THE MAP IS KEYED ON COORDINATES, NOT ON A GUESS. A "map" drawn from a
   location string is a picture of a place we have not been told the position
   of. It renders when `lat`/`lng` (or a supplied `mapUrl`) arrive and not
   before — which is what backend-ready means here.
   =========================================================================== */

const HotelDetails = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

  const nonEmpty = v => Array.isArray(v) ? v.filter(x => x != null && x !== '') : [];
  const text = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

  /* ----------------------------------------------------------------- rooms */
  function roomRow(r) {
    const price = num(r.price);
    const meta = [text(r.bed_type), text(r.size_label),
                  r.max_guests != null ? `Up to ${r.max_guests} guests` : null]
      .filter(Boolean).join(' · ');
    /* "2 left" is a fact worth showing; a comfortable number is not, and
       printing one on every room turns scarcity into wallpaper. */
    const scarce = r.left != null && r.left <= 3
      ? `<span class="hd-left">Only ${r.left} left</span>` : '';
    const perks = nonEmpty(r.perks);
    return `<article class="hd-room">
      <div class="hd-room-main">
        <h5>${esc(r.name)}</h5>
        ${meta ? `<p class="hd-room-meta">${esc(meta)}</p>` : ''}
        ${text(r.description) ? `<p class="hd-room-desc">${esc(r.description)}</p>` : ''}
        <div class="hd-tags">
          ${text(r.meal_plan) ? `<span class="tx-chip">${esc(r.meal_plan)}</span>` : ''}
          ${perks.map(p => `<span class="tx-chip">${esc(p)}</span>`).join('')}
        </div>
        ${text(r.cancellation_policy)
          ? `<p class="hd-room-cancel">${esc(r.cancellation_policy)}</p>` : ''}
      </div>
      <div class="hd-room-buy">
        ${price != null ? `<b>${esc(money(price))}</b><span>per night</span>` : '<b>On request</b>'}
        ${scarce}
        <button type="button" class="tx-btn tx-btn-primary"
                data-hd-room="${esc(r.id)}" data-hd-hotel="{HOTEL_ID}">Select</button>
      </div>
    </article>`;
  }

  /* -------------------------------------------------------------- sections
     Each: an id, a heading, whether the payload can fill it, and how. */
  const SECTIONS = [
    {
      id: 'gallery', label: 'Photographs',
      bare: true,   // no heading — the pictures are their own heading
      has: (h, d) => typeof HotelGallery !== 'undefined' && HotelGallery.keysOf(h, d).length > 0,
      html: (h, d) => HotelGallery.html(h, d),
    },
    {
      id: 'rooms', label: 'Choose a room',
      has: (h, d) => nonEmpty(d && d.rooms).length > 0,
      html: (h, d) => `<div class="hd-rooms">${
        d.rooms.map(roomRow).join('').replaceAll('{HOTEL_ID}', esc(h.id))
      }</div>`,
    },
    {
      id: 'about', label: 'About this property',
      has: (h, d) => !!text(d && d.description),
      html: (h, d) => `<p class="hd-prose">${esc(d.description)}</p>`,
    },
    {
      id: 'amenities', label: 'Amenities',
      has: (h, d) => nonEmpty((d && d.amenities) || (h && h.amenities)).length > 0,
      html: (h, d) => `<ul class="hd-amenities">${
        nonEmpty((d && d.amenities) || h.amenities)
          .map(a => `<li>${esc(a)}</li>`).join('')
      }</ul>`,
    },
    {
      id: 'policies', label: 'Policies',
      /* Cancellation is the only policy the API sends. House rules, check-in
         windows and extra charges each render as their own row the day they
         arrive; none is invented in the meantime. */
      has: (h, d) => !!text((d && d.cancellation_policy) || (h && h.cancellationPolicy))
                  || nonEmpty(d && d.house_rules).length > 0
                  || !!text(d && d.check_in_time),
      html: (h, d) => {
        const rows = [];
        const cancel = text((d && d.cancellation_policy) || (h && h.cancellationPolicy));
        if (cancel) rows.push(['Cancellation', cancel]);
        const ci = text(d && d.check_in_time), co = text(d && d.check_out_time);
        if (ci || co) rows.push(['Check-in / check-out', [ci, co].filter(Boolean).join(' — ')]);
        nonEmpty(d && d.house_rules).forEach(r => rows.push(['House rule', r]));
        return `<dl class="hd-policies">${rows.map(([k, v]) =>
          `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
      },
    },
    {
      id: 'charges', label: 'Taxes and extra charges',
      has: (h, d) => nonEmpty(d && d.extra_charges).length > 0 || (d && d.tax_note),
      html: (h, d) => `<ul class="hd-charges">${
        nonEmpty(d.extra_charges).map(c => `<li>${esc(
          typeof c === 'string' ? c : `${c.label}: ${c.amount != null ? money(c.amount) : ''}`
        )}</li>`).join('')
      }${d.tax_note ? `<li>${esc(d.tax_note)}</li>` : ''}</ul>`,
    },
    {
      id: 'nearby', label: 'Nearby',
      has: (h, d) => nonEmpty(d && d.nearby).length > 0,
      html: (h, d) => `<ul class="hd-nearby">${
        nonEmpty(d.nearby).map(n => {
          const label = typeof n === 'string' ? n : n.name;
          const dist = (typeof n === 'object' && n.distance_km != null)
            ? `<span>${esc(Number(n.distance_km).toFixed(1))} km</span>` : '';
          return `<li>${esc(label)}${dist}</li>`;
        }).join('')
      }</ul>`,
    },
    {
      id: 'map', label: 'Location',
      /* Coordinates or a supplied embed, never a picture of a guess. */
      has: (h, d) => (num(d && d.lat) != null && num(d && d.lng) != null) || !!text(d && d.map_url),
      html: (h, d) => {
        const label = esc((d && d.location) || (h && h.location) || '');
        if (text(d && d.map_url)) {
          return `<div class="hd-map"><iframe src="${esc(d.map_url)}" loading="lazy"
                    title="Map showing ${label}" referrerpolicy="no-referrer"></iframe></div>`;
        }
        const lat = num(d.lat), lng = num(d.lng);
        return `<div class="hd-map hd-map-pending" data-lat="${lat}" data-lng="${lng}">
          <p>${label}</p>
          <span>${esc(lat.toFixed(4))}, ${esc(lng.toFixed(4))}</span>
        </div>`;
      },
    },
  ];

  function sectionHtml(sec, hotel, detail) {
    let body;
    try {
      if (!sec.has(hotel, detail)) return '';
      body = sec.html(hotel, detail);
    } catch (err) {
      /* One malformed section must not take the panel with it. */
      console.warn('[hotel-details] section failed:', sec.id, err);
      return '';
    }
    if (!body) return '';
    if (sec.bare) return `<section class="hd-sec hd-sec-${sec.id}">${body}</section>`;
    return `<section class="hd-sec hd-sec-${sec.id}">
      <h4 class="hd-h">${esc(sec.label)}</h4>
      ${body}
    </section>`;
  }

  return {
    SECTIONS,

    /** The whole panel. Returns '' if no section can be filled, so the caller
     *  can decide not to expand at all rather than opening an empty drawer. */
    html(hotel, detail) {
      const body = SECTIONS.map(s => sectionHtml(s, hotel, detail)).join('');
      return body ? `<div class="hd">${body}</div>` : '';
    },

    /** Which sections rendered — used by the tests and worth having when
     *  someone asks why a heading is missing. */
    rendered(hotel, detail) {
      return SECTIONS.filter(s => {
        try { return s.has(hotel, detail) && !!s.html(hotel, detail); } catch { return false; }
      }).map(s => s.id);
    },

    mount(scope) {
      if (typeof HotelGallery !== 'undefined') HotelGallery.mount(scope);
    },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HotelDetails;
