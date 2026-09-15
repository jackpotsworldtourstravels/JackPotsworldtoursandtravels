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

    /* =====================================================================
       A. THE TRAVEL FAMILY — the products in the main navigation.

       These are Lucide geometry, not the hand-drawn shapes that were here
       before. The hand-drawn set was consistent with itself and with nothing
       else: the rest of the product carried eighty-odd loose SVGs at nine
       different stroke weights, and the nav was a tenth of them. One library
       settles it, and Lucide is the one whose travel coverage is complete —
       Plane, BedDouble, Palmtree, Ship, TrainFront, BusFront, CarFront,
       FileCheck2 and Ticket all exist, so not one product in the bar needs a
       custom drawing.

       THE MOTION SURVIVED THE SWAP. Each icon keeps a data-jpi role, so the
       hover and scroll-in animations in jp-icons.css play exactly as before —
       the roles are tagged onto whichever Lucide path is the moving part,
       which is why the geometry could change without the timing changing.
       ===================================================================== */

    /* Plane. The whole airframe lifts — it is one path, so there is nothing
       finer to move, and a plane that rises reads right anyway. */
    plane: `
      <path data-jpi="lift" d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>`,

    /* BedDouble. Headboard and rail hold still; the mattress line and the
       pillow divide come up in sequence, which is the old hotel-window
       stagger doing the same job on different geometry. */
    bedDouble: `
      <path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/>
      <path data-jpi="seq" d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/>
      <path data-jpi="seq" d="M12 4v6"/>
      <path data-jpi="seq" d="M2 18h20"/>`,

    /* Palmtree. The crown lifts, the trunk stays planted. */
    palmtree: `
      <path data-jpi="lift" d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/>
      <path data-jpi="lift" d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/>
      <path data-jpi="lift" d="M5.89 9.71c-2.15 2.15-2.3 5.06-.35 7.01l4.24-4.24.7-.7.71-.71 2.12-2.12c-1.95-1.95-4.86-1.8-7.02.35z"/>
      <path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/>`,

    /* Ship. Hull rocks, the swell underneath drifts — the two-part motion the
       old drawing had, kept on Lucide's hull and waterline. */
    ship: `
      <path data-jpi="rock" d="M12 10.189V14"/>
      <path data-jpi="rock" d="M12 2v3"/>
      <path data-jpi="rock" d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"/>
      <path data-jpi="rock" d="M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76"/>
      <path data-jpi="shift" d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>`,

    /* TrainFront. The body holds; the cab lights and the rails below move. */
    trainFront: `
      <path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/>
      <path data-jpi="seq" d="m9 15-1-1"/>
      <path data-jpi="seq" d="m15 15 1-1"/>
      <path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/>
      <path data-jpi="seq" d="m8 19-2 3"/>
      <path data-jpi="seq" d="m16 19 2 3"/>`,

    /* BusFront. Glides, the way the cab and transfer marks do. */
    busFront: `
      <path data-jpi="glide" d="M4 6 2 7"/>
      <path d="M10 6h4"/>
      <path data-jpi="glide" d="m22 7-2-1"/>
      <rect width="16" height="16" x="4" y="3" rx="2"/>
      <path d="M4 11h16"/>
      <path d="M8 15h.01"/>
      <path d="M16 15h.01"/>
      <path d="M6 19v2"/>
      <path d="M18 21v-2"/>`,

    /* CarFront — cabs, and airport transfers. */
    carFront: `
      <path data-jpi="glide" d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"/>
      <path d="M7 14h.01"/>
      <path d="M17 14h.01"/>
      <rect width="18" height="8" x="3" y="10" rx="2"/>
      <path d="M5 18v2"/>
      <path d="M19 18v2"/>`,

    /* FileCheck2 — the visa mark. The tick draws, as the passport stamp did. */
    fileCheck2: `
      <path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path data-jpi="draw" style="--jpi-len:10" d="m3 15 2 2 4-4"/>`,

    /* Ticket — activities. The perforation comes up in sequence. */
    ticket: `
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>
      <path data-jpi="seq" d="M13 5v2"/>
      <path data-jpi="seq" d="M13 11v2"/>
      <path data-jpi="seq" d="M13 17v2"/>`,

    /* Gamepad2 — gaming packages. Lucide has no casino mark, and a controller
       is what the product actually sells holidays around, so this is the
       honest symbol rather than a reason to draw a custom one. */
    gamepad2: `
      <line x1="6" x2="10" y1="11" y2="11"/>
      <line x1="8" x2="8" y1="9" y2="13"/>
      <line data-jpi="seq" x1="15" x2="15.01" y1="12" y2="12"/>
      <line data-jpi="seq" x1="18" x2="18.01" y1="10" y2="10"/>
      <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>`,

    /* MoreHorizontal — the overflow product menu. */
    moreHorizontal: `
      <circle data-jpi="seq" cx="5" cy="12" r="1"/>
      <circle data-jpi="seq" cx="12" cy="12" r="1"/>
      <circle data-jpi="seq" cx="19" cy="12" r="1"/>`,

    /* =====================================================================
       B. HEADER AND ACCOUNT
       ===================================================================== */

    handshake: `
      <path d="m11 17 2 2a1 1 0 1 0 3-3"/>
      <path data-jpi="lift" d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/>
      <path d="m21 3 1 11h-2"/>
      <path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/>
      <path d="M3 4h8"/>`,

    receipt: `
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/>
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/>
      <path d="M12 17.5v-11"/>`,

    clipboardList: `
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      <path data-jpi="seq" d="M12 11h4"/>
      <path data-jpi="seq" d="M12 16h4"/>
      <path d="M8 11h.01"/>
      <path d="M8 16h.01"/>`,

    heart: `
      <path data-jpi="pop" style="transform-origin:12px 12px" d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>`,

    bell: `
      <path d="M10.268 21a2 2 0 0 0 3.464 0"/>
      <path data-jpi="rock" style="transform-origin:12px 16px" d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>`,

    userRound: `
      <circle cx="12" cy="8" r="5"/>
      <path d="M20 21a8 8 0 0 0-16 0"/>`,

    userPlus: `
      <path d="M2 21a8 8 0 0 1 13.292-6"/>
      <circle cx="10" cy="8" r="5"/>
      <path data-jpi="seq" d="M19 16v6"/>
      <path data-jpi="seq" d="M22 19h-6"/>`,

    usersRound: `
      <path d="M18 21a8 8 0 0 0-16 0"/>
      <circle cx="10" cy="8" r="5"/>
      <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>`,

    settings: `
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle data-jpi="spin" style="transform-origin:12px 12px" cx="12" cy="12" r="3"/>`,

    circleHelp: `
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <path d="M12 17h.01"/>`,

    logOut: `
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <path data-jpi="glide" d="m16 17 5-5-5-5"/>
      <path d="M21 12H9"/>`,

    /* =====================================================================
       C. THE SEARCH CARD
       ===================================================================== */

    listFilter: `
      <path d="M3 6h18"/>
      <path d="M7 12h10"/>
      <path d="M10 18h4"/>`,

    arrowDownUp: `
      <path d="m3 16 4 4 4-4"/>
      <path d="M7 20V4"/>
      <path d="m21 8-4-4-4 4"/>
      <path d="M17 4v16"/>`,

    planeTakeoff: `
      <path d="M2 22h20"/>
      <path data-jpi="lift" d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z"/>`,

    planeLanding: `
      <path d="M2 22h20"/>
      <path data-jpi="glide" d="M3.77 10.77 2 9l2-4.5 1.1.55c.55.28.9.84.9 1.45s.35 1.17.9 1.45L8 8.5l3-6 1.05.53a2 2 0 0 1 1.09 1.52l.72 5.4a2 2 0 0 0 1.09 1.52l4.4 2.2c.42.22.78.55 1.01.96l.6 1.03c.22.37-.05.84-.48.84h-.98a2 2 0 0 1-.89-.21L3.77 10.77Z"/>`,

    arrowLeftRight: `
      <path data-jpi="shift" d="M8 3 4 7l4 4"/>
      <path d="M4 7h16"/>
      <path data-jpi="shift" d="m16 21 4-4-4-4"/>
      <path d="M20 17H4"/>`,

    calendarDays: `
      <path d="M8 2v4"/>
      <path d="M16 2v4"/>
      <rect width="18" height="18" x="3" y="4" rx="2"/>
      <path d="M3 10h18"/>
      <path data-jpi="seq" d="M8 14h.01"/>
      <path data-jpi="seq" d="M12 14h.01"/>
      <path data-jpi="seq" d="M16 14h.01"/>
      <path d="M8 18h.01"/>
      <path d="M12 18h.01"/>
      <path d="M16 18h.01"/>`,

    calendarClock: `
      <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/>
      <path d="M16 2v4"/>
      <path d="M8 2v4"/>
      <path d="M3 10h5"/>
      <path d="M17.5 17.5 16 16.3V14"/>
      <circle cx="16" cy="16" r="6"/>`,

    armchair: `
      <path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/>
      <path d="M3 11v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0Z"/>
      <path d="M5 18v2"/>
      <path d="M19 18v2"/>`,

    search: `
      <circle cx="11" cy="11" r="8"/>
      <path data-jpi="glide" d="m21 21-4.3-4.3"/>`,

    /* =====================================================================
       D. FARES, FILTERS AND SORTING
       ===================================================================== */

    circleDot: `
      <circle cx="12" cy="12" r="10"/>
      <circle data-jpi="pop" style="transform-origin:12px 12px" cx="12" cy="12" r="1"/>`,

    circle: `<circle cx="12" cy="12" r="10"/>`,

    badgeCheck: `
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/>
      <path data-jpi="pop" style="transform-origin:12px 12px" d="m9 12 2 2 4-4"/>`,

    graduationCap: `
      <path data-jpi="lift" d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/>
      <path d="M22 10v6"/>
      <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>`,

    shieldCheck: `
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
      <path data-jpi="pop" style="transform-origin:12px 12px" d="m9 12 2 2 4-4"/>`,

    stethoscope: `
      <path d="M11 2v2"/>
      <path d="M5 2v2"/>
      <path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/>
      <path d="M8 15a6 6 0 0 0 12 0v-3"/>
      <circle data-jpi="pop" style="transform-origin:20px 10px" cx="20" cy="10" r="2"/>`,

    slidersHorizontal: `
      <line x1="21" x2="14" y1="4" y2="4"/>
      <line x1="10" x2="3" y1="4" y2="4"/>
      <line x1="21" x2="12" y1="12" y2="12"/>
      <line x1="8" x2="3" y1="12" y2="12"/>
      <line x1="21" x2="16" y1="20" y2="20"/>
      <line x1="12" x2="3" y1="20" y2="20"/>
      <line data-jpi="shift" x1="14" x2="14" y1="2" y2="6"/>
      <line data-jpi="shift" x1="8" x2="8" y1="10" y2="14"/>
      <line data-jpi="shift" x1="16" x2="16" y1="18" y2="22"/>`,

    circleStop: `
      <circle cx="12" cy="12" r="10"/>
      <rect x="9" y="9" width="6" height="6" rx="1"/>`,

    indianRupee: `
      <path d="M6 3h12"/>
      <path d="M6 8h12"/>
      <path d="m6 13 8.5 8"/>
      <path d="M6 13h3"/>
      <path d="M9 13c6.667 0 6.667-10 0-10"/>`,

    clock3: `
      <circle cx="12" cy="12" r="10"/>
      <polyline data-jpi="spin" style="transform-origin:12px 12px" points="12 6 12 12 16.5 12"/>`,

    timer: `
      <line x1="10" x2="14" y1="2" y2="2"/>
      <line data-jpi="spin" style="transform-origin:12px 14px" x1="12" x2="15" y1="14" y2="11"/>
      <circle cx="12" cy="14" r="8"/>`,

    luggage: `
      <path d="M6 20a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2"/>
      <path data-jpi="lift" d="M8 18V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"/>
      <path d="M10 20h4"/>
      <circle cx="16" cy="20" r="2"/>
      <circle cx="8" cy="20" r="2"/>`,

    tag: `
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>
      <circle data-jpi="pop" style="transform-origin:7.5px 7.5px" cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`,

    rotateCcw: `
      <path data-jpi="spin" style="transform-origin:12px 12px" d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>`,

    zap: `
      <path data-jpi="pop" style="transform-origin:12px 12px" d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>`,

    /* Solid, not stroked. A 12px outlined star is mush — jp-icons.css fills
       this one and strips the stroke (.jpi-star). */
    star: `
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`,

    /* =====================================================================
       E. RESULT CARD AND BOOKING FLOW
       ===================================================================== */

    fileText: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path data-jpi="seq" d="M10 9H8"/>
      <path data-jpi="seq" d="M16 13H8"/>
      <path data-jpi="seq" d="M16 17H8"/>`,

    info: `
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 16v-4"/>
      <path d="M12 8h.01"/>`,

    share2: `
      <circle data-jpi="pop" style="transform-origin:18px 5px" cx="18" cy="5" r="3"/>
      <circle cx="6" cy="12" r="3"/>
      <circle data-jpi="pop" style="transform-origin:18px 19px" cx="18" cy="19" r="3"/>
      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/>
      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>`,

    arrowRight: `
      <path d="M5 12h14"/>
      <path data-jpi="shift" d="m12 5 7 7-7 7"/>`,

    arrowLeft: `
      <path d="M19 12H5"/>
      <path data-jpi="shift" d="m12 19-7-7 7-7"/>`,

    arrowUp: `
      <path data-jpi="lift" d="m5 12 7-7 7 7"/>
      <path d="M12 19V5"/>`,

    circleCheck: `
      <circle cx="12" cy="12" r="10"/>
      <path data-jpi="pop" style="transform-origin:12px 12px" d="m9 12 2 2 4-4"/>`,

    circleCheckBig: `
      <path d="M21.801 10A10 10 0 1 1 17 3.335"/>
      <path data-jpi="draw" style="--jpi-len:22" d="m9 11 3 3L22 4"/>`,

    circleMinus: `
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 12h8"/>`,

    circleX: `
      <circle cx="12" cy="12" r="10"/>
      <path d="m15 9-6 6"/>
      <path d="m9 9 6 6"/>`,

    triangleAlert: `
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
      <path data-jpi="seq" d="M12 9v4"/>
      <path data-jpi="seq" d="M12 17h.01"/>`,

    contact: `
      <path d="M16 2v2"/>
      <path d="M17.915 22a6 6 0 0 0-12 0"/>
      <path d="M8 2v2"/>
      <circle cx="12" cy="12" r="4"/>
      <rect x="3" y="4" width="18" height="18" rx="2"/>`,

    globe: `
      <circle cx="12" cy="12" r="10"/>
      <path data-jpi="shift" d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
      <path d="M2 12h20"/>`,

    smartphone: `
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/>
      <path d="M12 18h.01"/>`,

    mail: `
      <rect width="20" height="16" x="2" y="4" rx="2"/>
      <path data-jpi="lift" d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>`,

    utensils: `
      <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/>
      <path d="M7 2v20"/>
      <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>`,

    /* =====================================================================
       F. PAYMENT AND CONFIRMATION
       ===================================================================== */

    creditCard: `
      <rect width="20" height="14" x="2" y="5" rx="2"/>
      <line x1="2" x2="22" y1="10" y2="10"/>`,

    landmark: `
      <path d="M10 18v-7"/>
      <path d="M11.12 2.198a2 2 0 0 1 1.76.006l7.866 3.847c.476.233.31.949-.22.949H3.474c-.53 0-.695-.716-.22-.949z"/>
      <path d="M14 18v-7"/>
      <path d="M18 18v-7"/>
      <path d="M3 22h18"/>
      <path d="M6 18v-7"/>`,

    walletCards: `
      <rect width="18" height="18" x="3" y="3" rx="2"/>
      <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2"/>
      <path data-jpi="lift" d="M3 11h3c.8 0 1.6.3 2.1.9l1.1.9c1.6 1.6 4.1 1.6 5.7 0l1.1-.9c.5-.6 1.3-.9 2.1-.9H21"/>`,

    ticketCheck: `
      <path d="M2 9a3 3 0 1 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 1 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>
      <path data-jpi="pop" style="transform-origin:12px 12px" d="m9 12 2 2 4-4"/>`,

    download: `
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline data-jpi="lift" points="7 10 12 15 17 10"/>
      <line x1="12" x2="12" y1="15" y2="3"/>`,

    upload: `
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline data-jpi="lift" points="17 8 12 3 7 8"/>
      <line x1="12" x2="12" y1="3" y2="15"/>`,

    briefcaseBusiness: `
      <path d="M12 12h.01"/>
      <path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
      <path d="M22 13a18.15 18.15 0 0 1-20 0"/>
      <rect width="20" height="14" x="2" y="6" rx="2"/>`,

    /* =====================================================================
       G. UI PRIMITIVES — the small marks every screen needs. They are here so
       that a chevron in the search card and a chevron in a filter panel are
       the same chevron, which is most of what "one system" means in practice.
       ===================================================================== */

    chevronDown:  `<path d="m6 9 6 6 6-6"/>`,
    chevronUp:    `<path d="m18 15-6-6-6 6"/>`,
    chevronLeft:  `<path d="m15 18-6-6 6-6"/>`,
    chevronRight: `<path d="m9 18 6-6-6-6"/>`,
    plus:         `<path d="M5 12h14"/><path d="M12 5v14"/>`,
    minus:        `<path d="M5 12h14"/>`,
    x:            `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
    check:        `<path data-jpi="pop" style="transform-origin:12px 12px" d="M20 6 9 17l-5-5"/>`,
    menu:         `<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>`,

    mapPin: `
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/>
      <circle cx="12" cy="10" r="3"/>`,

    phone: `
      <path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>`,

    lock: `
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,

    messageCircle: `
      <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>`,

    mic: `
      <path d="M12 19v3"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <rect data-jpi="pop" style="transform-origin:12px 8px" x="9" y="2" width="6" height="13" rx="3"/>`,

    sparkles: `
      <path data-jpi="pop" style="transform-origin:12px 12px" d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
      <path data-jpi="seq" d="M20 3v4"/>
      <path data-jpi="seq" d="M22 5h-4"/>
      <path data-jpi="seq" d="M4 17v2"/>
      <path data-jpi="seq" d="M5 18H3"/>`,

    house: `
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/>
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,

    pencil: `
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
      <path d="m15 5 4 4"/>`,

    /* An infant traveller. Lucide's Baby, because the flow distinguishes adult,
       child and infant and three copies of UserRound distinguishes nothing. */
    baby: `
      <path d="M9 12h.01"/>
      <path d="M15 12h.01"/>
      <path d="M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5"/>
      <path d="M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1"/>`,

    headset: `
      <path d="M3 11h3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>
      <path d="M21 11h-3a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z"/>
      <path d="M3 11a9 9 0 1 1 18 0"/>
      <path d="M21 16v2a4 4 0 0 1-4 4h-5"/>`,

    sun: `
      <circle data-jpi="spin" style="transform-origin:12px 12px" cx="12" cy="12" r="4"/>
      <path d="M12 2v2"/><path d="M12 20v2"/>
      <path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>
      <path d="M2 12h2"/><path d="M20 12h2"/>
      <path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,

    moon: `
      <path data-jpi="lift" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,

    wifi: `
      <path d="M12 20h.01"/>
      <path data-jpi="seq" d="M8.5 16.429a5 5 0 0 1 7 0"/>
      <path data-jpi="seq" d="M5 12.859a10 10 0 0 1 14 0"/>
      <path data-jpi="seq" d="M2 8.82a15 15 0 0 1 20 0"/>`,

    eye: `
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
      <circle data-jpi="pop" style="transform-origin:12px 12px" cx="12" cy="12" r="3"/>`,

    eyeOff: `
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>
      <path d="m2 2 20 20"/>`,

    key: `
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>`,
  };

  /* THE NAMES THE PRODUCT ALREADY CALLS. Every call site written before this
     library existed asks for 'flights', 'hotels', 'swap' and the rest, and
     data-jp-icon attributes carrying those names sit in static HTML across the
     site. They resolve here rather than being renamed through forty files —
     the point of an abstraction is that changing the geometry does not become
     a find-and-replace. Left of the colon is what callers say; right of it is
     the Lucide icon they get. */
  const ALIASES = {
    flights: 'plane',        hotels: 'bedDouble',    cruises: 'ship',
    packages: 'palmtree',    visa: 'fileCheck2',     activities: 'ticket',
    transfers: 'carFront',   gaming: 'gamepad2',     insurance: 'shieldCheck',
    trains: 'trainFront',    buses: 'busFront',      cabs: 'carFront',
    more: 'moreHorizontal',  swap: 'arrowLeftRight', home: 'house',
    chat: 'messageCircle',   sparkle: 'sparkles',    account: 'userRound',
    wishlist: 'heart',       bookings: 'receipt',    partner: 'handshake',
    help: 'circleHelp',      logout: 'logOut',       close: 'x',
  };
  Object.keys(ALIASES).forEach(k => { if (!ICONS[k]) ICONS[k] = ICONS[ALIASES[k]]; });

  /** Human labels, used for the title/aria when an icon is asked to stand alone. */
  /* Only for icons that can appear WITHOUT their own text label — an icon-only
     button in the header, a status mark in a confirmation. Anything sitting
     beside a written label stays aria-hidden and is not listed here, because a
     screen reader announcing "Flights Flights" is worse than silent
     decoration. See wrap(): the caller opts in with { label: true }. */
  const LABELS = {
    flights: 'Flights', hotels: 'Hotels', cruises: 'Cruises',
    packages: 'Tour Packages', visa: 'Visa Services', activities: 'Activities',
    transfers: 'Airport Transfers', insurance: 'Travel Insurance',
    gaming: 'Gaming Packages', trains: 'Trains', buses: 'Buses', cabs: 'Cabs',
    star: 'Rating', bell: 'Notifications',
    swap: 'Swap', arrowUp: 'Back to top', chat: 'Chat', mic: 'Voice search',
    sparkle: 'Suggestions', more: 'More travel services', home: 'Home',

    /* Header and account — every one of these is an icon-only control. */
    handshake: 'My Partner', partner: 'My Partner',
    receipt: 'My Bookings', bookings: 'My Bookings',
    clipboardList: 'My Trips', heart: 'Wishlist', wishlist: 'Wishlist',
    userRound: 'Account', account: 'Account', settings: 'Settings',
    circleHelp: 'Help', help: 'Help', logOut: 'Log out', logout: 'Log out',
    menu: 'Menu', x: 'Close', close: 'Close',

    /* Controls that are routinely drawn without text. */
    search: 'Search', arrowLeftRight: 'Swap origin and destination',
    plus: 'Add', minus: 'Remove', download: 'Download', share2: 'Share',
    slidersHorizontal: 'Filters', arrowDownUp: 'Sort',
    info: 'More information', chevronDown: 'Show more',

    /* Status marks, which carry meaning on their own by definition. */
    circleCheckBig: 'Confirmed', circleCheck: 'Included',
    circleMinus: 'Not included', triangleAlert: 'Warning',
    circleX: 'Cancelled', ticketCheck: 'E-ticket', lock: 'Secure',
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
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${inner}</svg></span>`;
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
        /* THE PLACEHOLDER'S CLASSES SURVIVE HYDRATION. mount() replaces the
           whole element, so without this a `<i data-jp-icon class="npm-mark">`
           lost the class that sized it and the icon snapped to the default
           1.25em the moment scripting caught up. Carrying it across is what
           lets a call site write the size class once, in the markup, instead
           of every stylesheet having to reach through to the inner <svg>. */
        className: el.getAttribute('class') || '',
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
