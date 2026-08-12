'use strict';
/* ===========================================================================
   jp-icons.js — the animated travel icon family
   ===========================================================================
   THE ONLY PLACE ICON MARKUP IS WRITTEN. Callers ask for a name:

       JPIcon.html('flights')                 -> markup string
       JPIcon.stars(4)                        -> a 5-star rating row
       <span data-jp-icon="hotels"></span>    -> hydrated by JPIcon.mount()

   Nothing else in the product knows what an icon is made of, which is what
   makes a library swap a change to THIS FILE ONLY. To move to Lordicon:
   replace html() with the <lord-icon> element and drop ICONS. Every call site,
   every stylesheet class and every placeholder keeps working.

   DRAWING RULES, so eight icons look like one set:
     * 24x24 viewBox, stroke-width 1.6, round caps and joins
     * stroke: currentColor, fill: none  (hence free light/dark support)
     * geometry on a half-pixel grid where it meets a straight edge
     * exactly one or two moving parts, tagged data-jpi="<role>"; the roles and
       their timing live in jp-icons.css

   Motion is decorative. Every icon here sits next to its own text label, so
   each SVG is aria-hidden and contributes nothing to the accessible name.
   =========================================================================== */

const JPIcon = (function () {

  /* Each entry is just the inner geometry; wrap() adds the shared attributes so
     stroke width and colour cannot drift between icons. */
  const ICONS = {

    /* AN AEROPLANE, NOT A PAPER PLANE.

       The first attempt was the folded-paper "send" mark. It is the wrong
       symbol for an airline: on a booking site a paper plane means submit or
       message, and every travel platform uses an aircraft silhouette. This is
       the top-down plan view — swept wings, tailplane, nose up — which is what
       an aeroplane reads as at 14px.

       Drawn nose-up because that is the conventional orientation; the route
       line in a flight card rotates it 90deg so it flies along the line
       (see travel-explore.css). */
    flights: `
      <path data-jpi="lift" d="M12 2.4c.88 0 1.6 1.06 1.6 2.37v3.6l7.4 4.32v2.1l-7.4-2.2v3.94l2.4 1.78v1.6L12 18.9l-4 1.2v-1.6l2.4-1.78V12.8l-7.4 2.2v-2.1l7.4-4.32v-3.6C10.4 3.46 11.12 2.4 12 2.4Z"/>`,

    /* Hotel block. The windows come on one after another. */
    hotels: `
      <path d="M3.2 20.8h17.6"/>
      <path d="M5.4 20.8V5.6a1.4 1.4 0 0 1 1.4-1.4h6.4a1.4 1.4 0 0 1 1.4 1.4v15.2"/>
      <path d="M14.6 20.8V10h4a1.4 1.4 0 0 1 1.4 1.4v9.4"/>
      <path data-jpi="seq" d="M8 8h3.4"/>
      <path data-jpi="seq" d="M8 11.6h3.4"/>
      <path data-jpi="seq" d="M8 15.2h3.4"/>`,

    /* Ship riding a swell. Hull rocks, water drifts. */
    cruises: `
      <path data-jpi="rock" d="M4.6 14.6 6.2 9.4h11.6l1.6 5.2"/>
      <path data-jpi="rock" d="M9.4 9.4V5.8h4.2v3.6"/>
      <path data-jpi="rock" d="M12 5.8V3.4"/>
      <path data-jpi="shift" d="M2.8 18.6c1.3.95 2.6.95 3.9 0s2.6-.95 3.9 0 2.6.95 3.9 0 2.6-.95 3.9 0"/>`,

    /* Island: palm and sun. The sun turns, the crown lifts.

       The first attempt read as a flag on a pole — one long near-vertical trunk
       and three thin arcs that vanished below about 20px. This one has a short
       curved trunk, a four-frond crown wide enough to be a silhouette, and the
       sun moved clear of the leaves instead of overlapping one. */
    packages: `
      <circle data-jpi="spin" cx="18.6" cy="4.9" r="2.1" style="transform-origin:18.6px 4.9px"/>
      <path d="M2.6 20.9h18.8"/>
      <path d="M11 20.9c0-3.9.4-6.3 1.5-7.9"/>
      <path data-jpi="lift" d="M12.5 12.6c-2.2-2-5.4-1.9-7.4.3"/>
      <path data-jpi="lift" d="M12.5 12.6c2.2-2 5.4-1.9 7.4.3"/>
      <path data-jpi="lift" d="M12.5 12.6c-1-2.7-3.3-4.3-6-4.3"/>
      <path data-jpi="lift" d="M12.5 12.6c1-2.7 3.3-4.3 6-4.3"/>`,

    /* Passport. The stamp lands. */
    visa: `
      <rect x="4.8" y="2.8" width="14.4" height="18.4" rx="2.2"/>
      <circle data-jpi="pop" cx="12" cy="9.8" r="3.1" style="transform-origin:12px 9.8px"/>
      <path d="M9 17.4h6"/>
      <path d="M12 6.7v6.2M8.9 9.8h6.2" opacity=".45"/>`,

    /* Admission ticket. Tilts, and the tear line runs. */
    activities: `
      <path data-jpi="rock" d="M3.4 8.6a2 2 0 0 1 2-2h13.2a2 2 0 0 1 2 2v1.2a2.2 2.2 0 0 0 0 4.4v1.2a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-1.2a2.2 2.2 0 0 0 0-4.4z" style="transform-origin:12px 12px"/>
      <path data-jpi="shift" d="M14.4 6.6v10.8" stroke-dasharray="2 2.2"/>`,

    /* Airport transfer. The car eases forward. */
    transfers: `
      <path data-jpi="shift" d="M4 16.6v-3.1l1.8-4.2A2 2 0 0 1 7.6 8h8.8a2 2 0 0 1 1.8 1.3l1.8 4.2v3.1"/>
      <path data-jpi="shift" d="M4 13.5h16"/>
      <circle data-jpi="shift" cx="7.6" cy="17.2" r="1.6"/>
      <circle data-jpi="shift" cx="16.4" cy="17.2" r="1.6"/>`,

    /* Travel insurance. The tick draws itself in. */
    insurance: `
      <path d="M12 2.9 5.2 5.6v5.6c0 4.1 2.8 7.9 6.8 9.2 4-1.3 6.8-5.1 6.8-9.2V5.6z"/>
      <path data-jpi="draw" style="--jpi-len:11" d="M9 12.1l2.1 2.1 4.1-4.2"/>`,

    /* Rating star. Solid — see jp-icons.css. */
    star: `<path d="m12 2.6 2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.62l-5.88 3.09 1.12-6.55L2.48 9.52l6.58-.96z"/>`,

    /* ---- The landing page's own controls ----------------------------------
       These were emoji too, but written as HTML NUMERIC ENTITIES (&#9992;),
       which is why a scan for emoji CHARACTERS reported the page clean. Search
       for `&#` when auditing, not just for the glyphs. */

    /* Swap origin and destination. .swap-btn already rotates 180deg on hover,
       so this stays still and lets the button carry the motion. */
    swap: `
      <path d="M4 8.6h15.2M15.7 5.1 19.2 8.6 15.7 12.1"/>
      <path d="M20 15.4H4.8M8.3 11.9 4.8 15.4l3.5 3.5"/>`,

    /* Back to top. */
    arrowUp: `
      <path data-jpi="lift" d="M12 20.2V4.4"/>
      <path data-jpi="lift" d="M5.6 10.8 12 4.4l6.4 6.4"/>`,

    /* Open the chat assistant. */
    chat: `
      <path data-jpi="pop" style="transform-origin:12px 12px" d="M20.4 11.9a7.6 7.6 0 0 1-8.2 7.6 8.4 8.4 0 0 1-2.6-.5L4.2 20.7l1.6-4.5a7.5 7.5 0 0 1-1.1-4 7.6 7.6 0 0 1 8.2-7.6 7.6 7.6 0 0 1 7.5 7.3z"/>
      <path d="M9 11.9h.01M12 11.9h.01M15 11.9h.01"/>`,

    /* Voice search. */
    mic: `
      <rect data-jpi="lift" x="9.4" y="2.8" width="5.2" height="10.6" rx="2.6"/>
      <path d="M5.7 11.6a6.3 6.3 0 0 0 12.6 0"/>
      <path d="M12 17.9v3.3"/>`,

    /* The AI suggestion action. */
    sparkle: `
      <path data-jpi="pop" style="transform-origin:11px 9.6px" d="M11 3.4l1.6 4.6 4.6 1.6-4.6 1.6L11 15.8 9.4 11.2 4.8 9.6l4.6-1.6z"/>
      <path data-jpi="pop" style="transform-origin:18.4px 17.4px" d="M18.4 14.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>`,

    /* Notifications. */
    bell: `
      <path data-jpi="rock" d="M18 8.4a6 6 0 1 0-12 0c0 6.9-2.9 8.8-2.9 8.8h17.8S18 15.3 18 8.4" style="transform-origin:12px 6px"/>
      <path d="M13.7 20.9a2 2 0 0 1-3.4 0"/>`,
  };

  /** Human labels, used for the title/aria when an icon is asked to stand alone. */
  const LABELS = {
    flights: 'Flights', hotels: 'Hotels', cruises: 'Cruises',
    packages: 'Tour Packages', visa: 'Visa Services', activities: 'Activities',
    transfers: 'Airport Transfers', insurance: 'Travel Insurance',
    star: 'Rating', bell: 'Notifications',
    swap: 'Swap', arrowUp: 'Back to top', chat: 'Chat', mic: 'Voice search',
    sparkle: 'Suggestions',
  };

  function wrap(name, inner, opts) {
    const o = opts || {};
    const cls = ['jpi', name === 'star' ? 'jpi-star' : '', o.size ? `jpi-${o.size}` : '', o.className || '']
      .filter(Boolean).join(' ');
    /* Labelled only when the caller says the icon carries meaning on its own.
       Everywhere in this product it sits beside its own text, so the default is
       hidden — a screen reader announcing "Flights Flights" is worse than
       silent decoration. */
    const a11y = o.label
      ? `role="img" aria-label="${o.label === true ? (LABELS[name] || name) : o.label}"`
      : 'aria-hidden="true"';
    return `<span class="${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${inner}</svg></span>`;
  }

  /** Markup for one icon. Unknown names return '' rather than a broken glyph. */
  function html(name, opts) {
    const inner = ICONS[name];
    if (!inner) { console.warn('[jp-icons] unknown icon:', name); return ''; }
    return wrap(name, inner, opts);
  }

  /** A rating row. `max` stars, the first `n` lit. */
  function stars(n, max) {
    const total = max || 5;
    const lit = Math.max(0, Math.min(total, Math.round(n || 0)));
    let out = `<span class="jpi-stars" role="img" aria-label="${lit} out of ${total} stars">`;
    for (let i = 0; i < total; i++) out += wrap('star', ICONS.star, { className: i < lit ? '' : 'jpi-off' });
    return out + '</span>';
  }

  /* ---------------------------------------------------------------------
     Hydration + the viewport trigger
     --------------------------------------------------------------------- */
  let observer = null;

  function ensureObserver() {
    if (observer || !('IntersectionObserver' in window)) return observer;
    observer = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.classList.add('jpi--play');
        /* Plays ONCE. Re-firing every time an icon scrolls back into view turns
           a considered entrance into a twitch. */
        observer.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: .35 });
    return observer;
  }

  /** Turn <span data-jp-icon="name"> placeholders inside `root` into icons, and
   *  arm every icon found there. Safe to call repeatedly — rendered icons are
   *  marked so a re-render does not double-observe. */
  function mount(root) {
    const scope = root || document;

    scope.querySelectorAll('[data-jp-icon]').forEach(el => {
      if (el.dataset.jpDone) return;
      const markup = html(el.dataset.jpIcon, {
        size: el.dataset.jpSize || '',
        label: el.dataset.jpLabel || false,
      });
      if (!markup) return;
      el.outerHTML = markup;
    });

    /* <span data-jp-stars="5"> -> a rating row, filled IN PLACE so the host
       keeps its own class (.stars on the landing page carries the gold). */
    scope.querySelectorAll('[data-jp-stars]').forEach(el => {
      if (el.dataset.jpDone) return;
      el.innerHTML = stars(Number(el.dataset.jpStars), Number(el.dataset.jpMax) || 5);
      el.dataset.jpDone = '1';
    });

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const obs = reduced ? null : ensureObserver();

    scope.querySelectorAll('.jpi').forEach(el => {
      if (el.dataset.jpDone) return;
      el.dataset.jpDone = '1';
      /* No observer (reduced motion, or an old browser): show the finished
         state. A drawn tick would otherwise stay invisible forever. */
      if (!obs) { el.classList.add('jpi--static'); return; }
      obs.observe(el);
    });
  }

  /** The bare 24x24 geometry, for embedding inside another SVG (the cruise and
   *  package card scenes draw one at 64px). The caller owns stroke and fill —
   *  a nested <svg> would inherit neither the scene's palette nor its scale. */
  function inner(name) { return ICONS[name] || ''; }

  return { html, inner, stars, mount, names: Object.keys(ICONS), LABELS };
})();

document.addEventListener('DOMContentLoaded', () => JPIcon.mount());
if (document.readyState !== 'loading') JPIcon.mount();
