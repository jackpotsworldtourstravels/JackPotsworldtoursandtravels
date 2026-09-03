'use strict';
/* ===========================================================================
   booking-card.js — the hero search card, rendered once and used everywhere.
   ===========================================================================
   WHY THIS IS A MODULE AND NOT MARKUP IN index.html

   The card now exists on TWO pages: the landing page, and the Flights page,
   which is a continuation of it rather than a different layout. Two copies of
   this markup would have disagreed within a week — and the whole point of the
   Flights page looking like the landing page is that the card is not merely
   similar but the SAME control, holding the same criteria.

   IT RENDERS SYNCHRONOUSLY, DURING PARSE. index.html calls render() from an
   inline <script> sitting where the card goes, so the DOM exists by the time
   app.js runs at the bottom of the page and its handlers (voice search, the
   auth gate, the account center) still find `.search-panel`, `.search-go` and
   the field ids exactly where they were.

   IT CARRIES THE PRODUCT TABS, AND SWITCHING THEM DOES NOT NAVIGATE. Flights,
   Hotels, Cruises and Tour Packages sit above the fields; clicking one swaps
   the panel underneath in place and changes nothing else on the page. That is
   a SEARCH control, not navigation — it decides what is being searched for,
   the same way the trip type decides what a flight search means. Navigation
   happens on Search, through the host page's handler. See PANELS and TABS.

   WHAT IT OWNS: the markup of one product panel, the hero video that goes with
   it, the date fields, the swap button, the trip type, the return-route mirror
   and the passenger popup. WHAT IT DOES NOT: which product is being searched,
   where a search goes, and whether the traveller is allowed to run one. Those
   are the host page's business and arrive through render()'s `tab` option and
   setSearchHandler() — which is why the landing page can put an auth gate in
   front of a search while the Flights page just re-renders its list in place.

   PASSENGER RULES LIVE IN pax-selector.js, not here. See its header for the
   four rules and why the caps intersect.
   =========================================================================== */

const BookingCard = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const $ = id => document.getElementById(id);

  /* Local midnight, not toISOString() — that converts to UTC first, and in IST
     (the timezone this site is built for) local midnight is still yesterday in
     UTC, so every default date landed a day early. */
  function isoDay(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  /** N days after an ISO day, as an ISO day. */
  function addDays(iso, n) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return isoDay(d);
  }

  const TRIPS = [
    { id: 'oneway', label: 'One Way' },
    { id: 'round',  label: 'Round Trip' },
    { id: 'multi',  label: 'Multi City' },
  ];

  const CABINS = ['Economy', 'Premium Economy', 'Business', 'First'];

  const state = {
    tab: 'flights',
    trip: 'oneway',
    hotelMode: 'rooms',
  };

  let pax = null;            // the PaxSelector instance, one for every trip type
  let rooms = null;          // the RoomsSelector instance, standard hotel mode
  let searchHandler = null;  // set by the host page
  let root = null;           // the .search-card element

  /* ---------------------------------------------------------------------
     Markup
     --------------------------------------------------------------------- */
  const calIcon = '<svg class="cal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/>'
    + '<path d="M16 2v4M8 2v4M3 10h18"/></svg>';

  /** `area` is the named grid area the flights row places this field in
   *  (booking-card.css). The hotels panel uses main.css's plain column
   *  template and passes none, so it gets no attribute rather than a
   *  placeholder one that the CSS would then have to ignore. */
  /** `attr` names WHICH grid the area belongs to — the flights row places its
   *  cells by data-fg, the hotels row by data-hf, and a date field is used by
   *  both. Passing the attribute in beats emitting both and letting each grid
   *  ignore the one it does not use. */
  const dateField = (id, label, area, attr) =>
    '<div class="field field-date"' + (area ? ' data-' + (attr || 'fg') + '="' + area + '"' : '') + '>'
    + '<label for="' + id + '">' + esc(label) + '</label>'
    + '<input id="' + id + '" class="date-display" placeholder="Add date" readonly>'
    + '<input type="date" class="date-native" aria-hidden="true" tabindex="-1">'
    + calIcon
    + '</div>';

  /** A return-leg airport box. Readonly and marked as mirrored rather than
   *  disabled: a disabled input is skipped by the tab order and by most screen
   *  readers, and the traveller still needs to be able to READ where they are
   *  coming back from. */
  const mirrorField = (id, label, area) =>
    '<div class="field field-mirrored" data-fg="' + area + '">'
    + '<label for="' + id + '">' + esc(label) + '</label>'
    + '<input id="' + id + '" readonly aria-readonly="true" tabindex="0"'
    + ' aria-describedby="fMirrorNote">'
    + '</div>';

  /* ONE airport box, one swap button, one date box — built here and used by
     every trip type. Multi city rows are not a second implementation of the
     route controls; they are these, with different ids.

     `role` is 'from' or 'to', and it is what the swap button looks for inside
     its own [data-swap-scope]. Naming the pair by role rather than by id is why
     a single handler can swap the outbound row AND any multi-city leg without
     knowing which one it is sitting in. */
  const airportField = (id, label, role, value, placeholder, area) =>
    '<div class="field field-airport"' + (area ? ' data-fg="' + area + '"' : '') + '>'
    + '<label for="' + id + '">' + esc(label) + '</label>'
    + '<input id="' + id + '" data-swap-' + role + '="1"'
    + ' value="' + esc(value || '') + '"'
    + ' data-key="' + esc(codeFrom(value)) + '"'
    + ' placeholder="' + esc(placeholder) + '" autocomplete="off"'
    /* The combobox contract SearchWidgets.mountAutocomplete expects: it writes
       aria-expanded and aria-activedescendant, and paints into `${id}List`. */
    + ' role="combobox" aria-autocomplete="list" aria-expanded="false"'
    + ' aria-controls="' + id + 'List">'
    + '<div class="tx-ap-list" id="' + id + 'List" role="listbox"'
    + ' aria-label="' + esc(label) + ' suggestions" hidden></div>'
    + '</div>';

  const swapButton = area =>
    '<button class="swap-btn" type="button"' + (area ? ' data-fg="' + area + '"' : '')
    + ' aria-label="Swap origin and destination">'
    + '<span data-jp-icon="swap" data-jp-size="sm"></span></button>';

  function flightsPanel() {
    const trip = TRIPS.map(t =>
      '<button type="button" class="trip-type' + (t.id === state.trip ? ' is-on' : '') + '"'
      + ' role="radio" aria-checked="' + (t.id === state.trip) + '"'
      + ' tabindex="' + (t.id === state.trip ? '0' : '-1') + '"'
      + ' data-trip="' + t.id + '">' + esc(t.label) + '</button>').join('');

    const cabin = CABINS.map(c => '<option>' + esc(c) + '</option>').join('');

    return panelOpen('flights')
      /* First control in the PANEL, before any field — the trip type decides
         what the rest of the row even means. The product tabs sit above the
         panel, outside it, because they choose which panel this is. */
      + '<div class="trip-types" role="radiogroup" aria-label="Trip type">' + trip + '</div>'

      /* data-swap-scope pairs the swap button with the two boxes it belongs
         to. Every multi-city row declares its own, which is what lets one
         handler serve all of them. */
      + '<div class="search-fields flight-grid" data-trip-fields data-swap-scope>'
      + airportField('fFrom', 'From Airport', 'from', 'Hyderabad (HYD)', 'City or airport', 'from')
      + swapButton('swap')
      + airportField('fTo', 'To Airport', 'to', 'Delhi (DEL)', 'Where to?', 'to')
      + dateField('fDep', 'Departure', 'dep')

      /* Return leg. Present in the DOM for every trip type so the row keeps
         its shape; one way disables the date and hides the two mirrored
         airports rather than collapsing the column. */
      + mirrorField('fRetFrom', 'Return From', 'rfrom')
      + '<div class="mirror-mark" data-fg="mirror" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '<path d="M17 2l4 4-4 4"/><path d="M3 6h18"/><path d="M7 22l-4-4 4-4"/><path d="M21 18H3"/>'
      + '</svg></div>'
      + mirrorField('fRetTo', 'Return To', 'rto')
      + dateField('fRet', 'Return', 'ret')
      + '</div>'

      /* MULTI CITY. The route rows live here; Passengers and Cabin do NOT —
         they are the same two DOM nodes as the row above, relocated by
         paintTrip(). One itinerary has one party and one cabin, and moving the
         real elements rather than rendering a second pair is what guarantees
         the value cannot differ between trip types. */
      + '<div class="mc" data-trip-multi hidden>'
      + '<div class="mc-routes" id="mcRoutes"></div>'
      + '<div class="mc-actions">'
      + '<button type="button" class="mc-add" id="mcAdd">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"'
      + ' aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add Another City</button>'
      + '<p class="mc-limit" id="mcLimit" role="status"></p>'
      + '</div>'
      + '<div class="mc-party" id="mcParty"></div>'
      + '</div>'

      /* The party. Rendered once, here, and moved into .mc-party for multi
         city — never duplicated. */
      + '<div class="field field-pax" data-fg="pax" id="fPaxField"></div>'
      + '<div class="field" data-fg="cabin" id="fCabinField"><label for="fCabin">Cabin</label>'
      + '<select id="fCabin">' + cabin + '</select></div>'
      + '</div>';
  }

  /* ---------------------------------------------------------------------
     Hotels

     TWO MODES, ONE SET OF COMMON FIELDS. "Up to 4 Rooms" is a search that ends
     on a results page; "Group Deals" is an enquiry that ends in an inbox. They
     are different enough to need different validation and different submission,
     and alike enough that Destination, Check-in and Check-out must survive a
     switch between them — so those three are rendered ONCE, outside either
     mode's block, and only the mode-specific fields are toggled. Re-rendering
     the panel per mode is what would lose them.
     --------------------------------------------------------------------- */
  const HOTEL_MODES = [
    { id: 'rooms', label: 'Up to 4 Rooms' },
    { id: 'group', label: 'Group Deals' },
  ];

  /* The ceiling on a group enquiry. Configurable because it is a commercial
     policy, not a technical limit — nothing breaks at 21, the desk just has to
     be willing to quote it. */
  const MAX_GROUP_ROOMS = 20;
  const MAX_GROUP_GUESTS = 200;

  const textField = (id, label, area, opts) => {
    opts = opts || {};
    return '<div class="field" data-hf="' + area + '">'
      + '<label for="' + id + '">' + esc(label)
      + (opts.optional ? ' <span class="field-optional">optional</span>' : '') + '</label>'
      + '<input id="' + id + '" type="' + (opts.type || 'text') + '"'
      + (opts.mode ? ' inputmode="' + opts.mode + '"' : '')
      + (opts.autocomplete ? ' autocomplete="' + opts.autocomplete + '"' : '')
      + ' placeholder="' + esc(opts.placeholder || '') + '"></div>';
  };

  const numberField = (id, label, area, value, min, max) =>
    '<div class="field" data-hf="' + area + '">'
    + '<label for="' + id + '">' + esc(label) + '</label>'
    + '<input id="' + id + '" type="number" inputmode="numeric"'
    + ' value="' + value + '" min="' + min + '" max="' + max + '" step="1"></div>';

  function hotelsPanel() {
    const modes = HOTEL_MODES.map(m =>
      '<button type="button" class="trip-type' + (m.id === state.hotelMode ? ' is-on' : '') + '"'
      + ' role="radio" aria-checked="' + (m.id === state.hotelMode) + '"'
      + ' tabindex="' + (m.id === state.hotelMode ? '0' : '-1') + '"'
      + ' data-hmode="' + m.id + '">' + esc(m.label) + '</button>').join('');

    return panelOpen('hotels')
      + '<div class="trip-types" role="radiogroup" aria-label="Hotel booking type">' + modes + '</div>'

      /* Common to both modes — never re-rendered, so switching cannot lose
         what is already typed into them. */
      + '<div class="search-fields hotel-grid" data-hotel-fields>'
      + '<div class="field field-airport" data-hf="dest">'
      + '<label for="hDest">Destination</label>'
      + '<input id="hDest" placeholder="City, area, hotel or resort" autocomplete="off"'
      + ' data-key="" role="combobox" aria-autocomplete="list" aria-expanded="false"'
      + ' aria-controls="hDestList">'
      + '<div class="tx-ap-list" id="hDestList" role="listbox"'
      + ' aria-label="Destination suggestions" hidden></div></div>'
      + dateField('hIn', 'Check-in', 'in', 'hf')
      + dateField('hOut', 'Check-out', 'out', 'hf')
      /* Read-only, derived from the two dates. It is the one number a guest
         checks before anything else, and making them count it is rude. */
      + '<div class="field field-nights" data-hf="nights">'
      + '<label for="hNights">Nights</label>'
      + '<output class="nights-out" id="hNights">&mdash;</output></div>'

      /* Standard mode */
      + '<div class="field field-pax" data-hf="rooms" id="hRoomsField"></div>'

      /* Group mode */
      + numberField('hGroupRooms', 'Rooms', 'grooms', 5, 1, MAX_GROUP_ROOMS)
      + numberField('hGroupGuests', 'Expected guests', 'gguests', 10, 1, MAX_GROUP_GUESTS)
      + '</div>'

      /* Group mode only: who to quote back to. */
      + '<div class="hotel-group" data-hotel-group hidden>'
      + '<p class="hotel-group-lead">Parties over four rooms are quoted by hand. '
      + 'Tell us how to reach you and the desk will come back with a price.</p>'
      + '<div class="search-fields hotel-contact">'
      + textField('hName', 'Full name', 'name', { autocomplete: 'name', placeholder: 'Your name' })
      + textField('hEmail', 'Email address', 'email', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' })
      + textField('hPhone', 'Phone number', 'phone', { type: 'tel', mode: 'tel', autocomplete: 'tel', placeholder: '+91 12345 67890' })
      + textField('hCompany', 'Company / organisation', 'company', { autocomplete: 'organization', placeholder: 'If you are booking for one', optional: true })
      + '<div class="field" data-hf="notes"><label for="hNotes">Special requests '
      + '<span class="field-optional">optional</span></label>'
      + '<textarea id="hNotes" rows="2" placeholder="Meeting space, airport transfers, dietary needs…"></textarea></div>'
      + '</div></div>'
      + '</div>';
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  const monthOptions = selected =>
    MONTHS.map(m => '<option' + (m === selected ? ' selected' : '') + '>' + m + '</option>').join('');

  function cruisesPanel() {
    return panelOpen('cruises')
      + '<div class="search-fields cols-5">'
      + '<div class="field"><label for="crType">Cruise Type</label><select id="crType">'
      + '<option>Goa Cruise</option><option>Kerala Backwater Cruise</option>'
      + '<option>Singapore Cruise</option><option>Dubai Cruise</option></select></div>'
      + '<div class="field"><label for="crMonth">Month</label><select id="crMonth">'
      + monthOptions('July') + '</select></div>'
      + '<div class="field"><label for="crDur">Duration</label><select id="crDur">'
      + '<option>2 Days</option><option>3 Days</option><option>5 Days</option>'
      + '<option>7 Days</option></select></div>'
      + '<div class="field"><label for="crTrav">Travellers</label><input id="crTrav" value="2 Adults"></div>'
      + '</div></div>';
  }

  function packagesPanel() {
    return panelOpen('packages')
      + '<div class="search-fields cols-3">'
      + '<div class="field"><label for="pType">Tour Package Type</label><select id="pType">'
      + '<option>Casino Tour Package</option><option>Domestic Tour Package</option>'
      + '<option>Pilgrimage Tour Package</option></select></div>'
      + '<div class="field"><label for="pMonth">Month</label><select id="pMonth">'
      + monthOptions('July') + '</select></div>'
      + '</div></div>';
  }

  /* THE PRODUCT TABS, AND WHY ALL FOUR PANELS ARE BUILT.

     The card opens with a Flights / Hotels / Cruises / Tour Packages strip and
     every panel is in the DOM behind it, one of them `.active`. It is not the
     header's product nav wearing a different hat: the header NAVIGATES — a
     click there loads that product's page — while these tabs change what the
     card in front of you is asking about, on the page you are already on, with
     nothing else disturbed. A traveller who came to compare a flight and a
     hotel for the same weekend should not lose the page to find out.

     ALL FOUR ARE BUILT, NOT LAZILY. The panels carry mounted sub-controls —
     the passenger popup hangs off #fPaxField, the rooms-and-guests popover off
     #hRoomsField — and those are created once in render(). Building a panel
     later would mean re-running that mount, and a half-built card is how the
     Rooms selector ends up missing on the second visit to the Hotels tab.
     Four panels is a few hundred bytes of markup; correctness is worth more.

     `tab` at mount still decides which one OPENS — render(host,{tab:'hotels'})
     — so the Hotels page opens on Hotels. It no longer decides which ones
     EXIST. */
  const PANELS = {
    flights: flightsPanel,
    hotels: hotelsPanel,
    cruises: cruisesPanel,
    packages: packagesPanel,
  };

  /* The products, in the order the landing page has always listed them. `icon`
     is a jp-icons name; the label carries the meaning, so a missing icon
     library leaves a working tab rather than a broken glyph. */
  const TABS = [
    { id: 'flights',  label: 'Flights',       icon: 'flights' },
    { id: 'hotels',   label: 'Hotels',        icon: 'hotels' },
    { id: 'cruises',  label: 'Cruises',       icon: 'cruises' },
    { id: 'packages', label: 'Tour Packages', icon: 'packages' },
  ];

  const panelId = name => 'bcPanel-' + name;
  const tabId = name => 'bcTab-' + name;

  /** A panel's opening tag. Every panel is a tabpanel labelled by its tab, so
   *  a screen reader announces "Hotels, tab panel" rather than an unnamed
   *  region, and only the open one is in the tab order. */
  function panelOpen(name) {
    const on = state.tab === name;
    return '<div class="search-panel' + (on ? ' active' : '') + '"'
      + ' data-panel="' + name + '" id="' + panelId(name) + '"'
      + ' role="tabpanel" aria-labelledby="' + tabId(name) + '"'
      + (on ? '' : ' hidden') + '>';
  }

  function tabsHtml() {
    return '<div class="search-tabs" role="tablist" aria-label="What are you booking?">'
      + TABS.map(t => {
        const on = t.id === state.tab;
        return '<button type="button" class="search-tab' + (on ? ' is-on' : '') + '"'
          + ' id="' + tabId(t.id) + '" role="tab"'
          + ' aria-selected="' + on + '" aria-controls="' + panelId(t.id) + '"'
          + ' tabindex="' + (on ? '0' : '-1') + '"'
          + ' data-tab="' + t.id + '">'
          + (typeof JPIcon !== 'undefined' ? JPIcon.html(t.icon, { size: 'sm' }) : '')
          + '<span>' + esc(t.label) + '</span></button>';
      }).join('')
      + '</div>';
  }

  function cardHtml() {
    const trust = [
      'Trusted by 2 Million+ Travellers', '24/7 Support',
      'Secure Payments', 'Instant Confirmation',
    ].map(t => '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '<path d="M20 6L9 17l-5-5"/></svg>' + esc(t) + '</span>').join('');

    return '<div class="search-card" role="region" aria-label="Booking search">'
      /* THE COLLAPSED SUMMARY, for a phone on a results page. Always rendered,
         shown by CSS only where it belongs — see .search-strip in
         booking-card.css. It is the card's own disclosure button, so it stays
         on screen while the card is open and is the way to shut it again. */
      + '<button type="button" class="search-strip" data-search-strip'
      + ' aria-expanded="true" aria-label="Your search — tap to change">'
      + '<span class="search-strip-text">'
      + '<span class="search-strip-main"></span>'
      + '<span class="search-strip-sub"></span>'
      + '</span>'
      + '<span class="search-strip-edit">Edit'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
      + ' stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
      + '</span></button>'
      /* THE PRODUCT TABS ARE THE FIRST THING IN THE CARD PROPER, above every
         field. What you are booking is the question that decides what the rest
         of the card even means, so it is asked first. */
      + tabsHtml()
      + '<div class="search-body">'
      + TABS.map(t => PANELS[t.id]()).join('')
      + '</div>'
      /* ONE Search button for the whole card, at the bottom right.
         It used to be the last cell of each panel's field row, which pinned it
         to the outer edge and made it a different height per panel — and with
         Multi City able to grow to five route rows there is no field row for it
         to be the end of any more. Out here it sits below whatever the panel is
         showing, in the same place every time, and the note beside it explains
         whatever the current trip type is doing. */
      + '<div class="search-foot">'
      + '<p class="search-foot-note" id="fMirrorNote" role="status"></p>'
      + '<p class="search-foot-error" role="alert"></p>'
      + '<button class="btn btn-coral search-go">Search</button>'
      + '</div>'
      + '<div class="trust-row">' + trust + '</div>'
      + '</div>';
  }

  /* ---------------------------------------------------------------------
     Multi city

     ROWS ARE ADDED AND REMOVED IN PLACE, NOT RE-RENDERED. Re-rendering the
     whole list on every change is simpler to write and wrong to use: it throws
     away what is typed in the other rows, drops focus to <body> mid-edit, and
     restarts any animation in flight. So add appends one node, remove deletes
     one, and everything else on screen is left alone.

     IDS NEVER SHIFT. A row keeps the id it was born with (mcFrom3 stays
     mcFrom3) even when the row above it is deleted; only the VISIBLE numbering
     is recomputed from DOM order. Index-based ids would have to be rewritten on
     every removal, and a <label for> or an aria-label that missed the rewrite
     points at the wrong box in a way nothing visibly complains about.
     --------------------------------------------------------------------- */
  const MAX_LEGS = 5;
  let routeSeq = 0;

  function routeRowHtml(uid, seg) {
    seg = seg || {};
    return '<div class="mc-route" data-mc-route="' + uid + '" data-swap-scope>'
      + '<span class="mc-num" aria-hidden="true"></span>'
      + airportField('mcFrom' + uid, 'From Airport', 'from', seg.from || '', 'City or airport')
      + swapButton()
      + airportField('mcTo' + uid, 'To Airport', 'to', seg.to || '', 'Where to?')
      + dateField('mcDate' + uid, 'Departure')
      + '<button type="button" class="mc-remove" data-mc-remove="' + uid + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
      + '<span class="sr-only">Remove this flight</span></button>'
      + '</div>';
  }

  const routeRows = () =>
    root ? Array.prototype.slice.call(root.querySelectorAll('.mc-route')) : [];

  const liveRoutes = () => routeRows().filter(r => !r.classList.contains('is-leaving'));

  /** Numbering, the remove buttons and the Add button ceiling — everything that
   *  depends on a row POSITION rather than its contents. Called after every add
   *  and every remove, so no row can keep a stale number. */
  function paintRouteChrome() {
    const rows = liveRoutes();
    rows.forEach((row, i) => {
      const num = row.querySelector('.mc-num');
      if (num) num.textContent = String(i + 1);

      const rm = row.querySelector('.mc-remove');
      if (rm) {
        /* The first leg IS the itinerary; there is nothing to remove it back
           to. Its button keeps its cell so every row stays aligned — hidden,
           not absent, and visibility:hidden also takes it out of the tab
           order. */
        rm.classList.toggle('is-hidden', i === 0);
        rm.setAttribute('aria-label', 'Remove flight ' + (i + 1));
      }

      /* A screen reader hears three rows of "From Airport" otherwise. The
         visible label stays short; the accessible name carries the leg. */
      const from = row.querySelector('[data-swap-from]');
      const to = row.querySelector('[data-swap-to]');
      const date = row.querySelector('.date-display');
      if (from) from.setAttribute('aria-label', 'Flight ' + (i + 1) + ' from airport');
      if (to) to.setAttribute('aria-label', 'Flight ' + (i + 1) + ' to airport');
      if (date) date.setAttribute('aria-label', 'Flight ' + (i + 1) + ' departure date');
    });

    const add = $('mcAdd');
    if (add) add.disabled = rows.length >= MAX_LEGS;
    const limit = $('mcLimit');
    if (limit) {
      limit.textContent = rows.length >= MAX_LEGS
        ? 'Up to ' + MAX_LEGS + ' flights in one itinerary.'
        : '';
    }
  }

  const inputValue = (row, role) => {
    const el = row.querySelector('[data-swap-' + role + ']');
    return el ? el.value.trim() : '';
  };

  const routeInput = (row, role) => row.querySelector('[data-swap-' + role + ']');

  /** The rows read back in the order they are on screen. */
  function readRoutes() {
    return liveRoutes().map(row => ({
      from: readAirport(routeInput(row, 'from')),
      to: readAirport(routeInput(row, 'to')),
      date: (row.querySelector('.date-native') || {}).value || '',
      row: row,
    }));
  }

  function appendRoute(seg, animate) {
    const host = $('mcRoutes');
    if (!host || liveRoutes().length >= MAX_LEGS) return null;
    const uid = ++routeSeq;
    host.insertAdjacentHTML('beforeend', routeRowHtml(uid, seg));
    const row = host.lastElementChild;
    if (seg && seg.date) setDate('mcDate' + uid, seg.date);
    bindRoute(row);
    paintRouteChrome();
    if (typeof JPIcon !== 'undefined') JPIcon.mount(row);
    if (animate) {
      /* The class only carries a keyframe animation with no fill-mode, so the
         row is at its natural height with or without it — taking it off again
         is housekeeping, not what makes the row appear. See the CSS for why
         entry is an animation and removal is a transition. */
      row.classList.add('is-entering');
      const clear = () => row.classList.remove('is-entering');
      row.addEventListener('animationend', clear, { once: true });
      setTimeout(clear, 400);
    }
    return row;
  }

  function removeRoute(uid) {
    const row = root && root.querySelector('[data-mc-route="' + uid + '"]');
    if (!row || liveRoutes().length <= 1) return;

    /* Move focus off the row BEFORE it goes, or it lands on <body> and a
       keyboard user is dropped at the top of the document. */
    if (row.contains(document.activeElement)) {
      const rows = liveRoutes();
      const at = rows.indexOf(row);
      const neighbour = rows[at + 1] || rows[at - 1];
      const target = (neighbour && neighbour.querySelector('.mc-remove:not(.is-hidden)'))
        || (neighbour && neighbour.querySelector('input'))
        || $('mcAdd');
      if (target) target.focus();
    }

    row.classList.add('is-leaving');
    /* Renumbered immediately: the row is on its way out and must not be counted
       while it animates, or "Flight 3" lingers over a list of two. */
    paintRouteChrome();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      row.remove();
      /* The row's two airport dropdowns live in <body>, not in the row. */
      sweepDropdowns();
      paintRouteChrome();
    };
    row.addEventListener('transitionend', e => {
      if (e.target === row && e.propertyName === 'max-height') finish();
    });
    /* transitionend never fires if the row is display:none-d mid-flight — the
       traveller switching trip type, say — and a node left behind would still
       be read back by readRoutes(). */
    setTimeout(finish, 420);
  }

  /** Build the itinerary from scratch. Used at mount and when legs arrive in a
   *  URL; everything on screen is discarded, which is only correct here because
   *  there is nothing yet to preserve. */
  function renderRoutes(segments) {
    const host = $('mcRoutes');
    if (!host) return;
    host.innerHTML = '';
    const legs = (segments && segments.length >= 2) ? segments.slice(0, MAX_LEGS) : [
      { from: '', to: '', date: '' },
      { from: '', to: '', date: '' },
    ];
    legs.forEach(seg => appendRoute(seg, false));
  }

  /* ---------------------------------------------------------------------
     Hero videos — one per product, lazy-loaded on first use.
     Lives here rather than in app.js because the Flights page has the same
     video layer and does not load app.js.
     --------------------------------------------------------------------- */
  const HERO_VIDEO_SPEED = 1.35;   // a touch faster than real time, still natural

  /** Applied once at mount and again per clip, because playbackRate set before
   *  a lazy-loaded clip has metadata is discarded when it arrives. */
  function armHeroVideos() {
    document.querySelectorAll('.hero-video-layer video').forEach(v => {
      v.playbackRate = HERO_VIDEO_SPEED;
      v.addEventListener('loadedmetadata', () => { v.playbackRate = HERO_VIDEO_SPEED; });
    });
  }

  function switchHeroVideo(name) {
    const videos = document.querySelectorAll('.hero-video-layer video');
    videos.forEach(v => {
      if (v.dataset.video === name) {
        v.classList.add('active');
        if (!v.getAttribute('src') && v.dataset.src) v.setAttribute('src', v.dataset.src);
        v.playbackRate = HERO_VIDEO_SPEED;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      } else {
        v.classList.remove('active');
        v.pause();
      }
    });
  }

  /* A group enquiry is the one submission that goes over the network from this
     card — everything else navigates, and a page that is leaving needs no
     pending state. So the button has to say it is working, and must not be
     pressable twice while it is. */
  let busy = false;

  /** The one Search button, labelled for whatever is being submitted. */
  /* ---------------------------------------------------------------------
     The collapsed summary

     WHAT IT READS. The DISPLAYED values, straight out of the fields, not
     `state` and not criteria(). Two reasons: the card already formats them for
     humans ("Thu, 10 Sep", "1 Room \u2022 2 Adults", "Hyderabad (HYD)"), and
     reading what is on screen means the strip cannot disagree with the card it
     is standing in for — which is the one thing a summary must never do.
     --------------------------------------------------------------------- */
  /** "Hyderabad (HYD)" -> "Hyderabad". The code is precision the strip has no
   *  room for; the full label is one tap away. */
  const shortPlace = v => String(v || '').split(' (')[0].trim();

  const textOf = id => { const e = $(id); return e ? (e.value || e.textContent || '').trim() : ''; };

  /** [main, sub] for whichever panel is open, or null when there is nothing
   *  worth summarising yet. */
  function summaryParts() {
    const join = list => list.filter(Boolean).join(' \u00b7 ');

    if (state.tab === 'flights') {
      if (state.trip === 'multi') {
        const rows = readRoutes();
        const first = rows[0] || {};
        const main = rows.length
          ? shortPlace(inputValue(first.row, 'from')) + ' \u2192 '
            + shortPlace(inputValue(first.row, 'to'))
            + (rows.length > 1 ? ' +' + (rows.length - 1) : '')
          : 'Multi City';
        return [main, join(['Multi City', paxText(), val('fCabin')])];
      }
      const from = shortPlace(textOf('fFrom'));
      const to = shortPlace(textOf('fTo'));
      const main = (from || to) ? (from || '?') + ' \u2192 ' + (to || '?') : 'Search flights';
      const dates = state.trip === 'round' && textOf('fRet')
        ? textOf('fDep') + ' \u2013 ' + textOf('fRet')
        : textOf('fDep');
      return [main, join([dates, paxText(), val('fCabin')])];
    }

    if (state.tab === 'hotels') {
      const main = shortPlace(textOf('hDest')) || 'Search hotels';
      const dates = textOf('hIn') && textOf('hOut')
        ? textOf('hIn') + ' \u2013 ' + textOf('hOut') : '';
      const party = state.hotelMode === 'group'
        ? 'Group deals'
        : (roomsBtnText() || '');
      return [main, join([dates, party])];
    }

    if (state.tab === 'cruises') {
      return [val('crType') || 'Search cruises', join([val('crMonth'), val('crDur'), textOf('crTrav')])];
    }

    return [val('pType') || 'Tour packages', val('pMonth')];
  }

  /** The passenger trigger's own words, so the strip says what the popup says. */
  function paxText() {
    const btn = root && root.querySelector('#fPaxField .pax-trigger-text');
    return btn ? btn.textContent.trim() : '';
  }
  function roomsBtnText() {
    const btn = root && root.querySelector('#hRoomsField .pax-trigger-text');
    return btn ? btn.textContent.trim() : '';
  }

  function paintSummary() {
    if (!root) return;
    const main = root.querySelector('.search-strip-main');
    const sub = root.querySelector('.search-strip-sub');
    if (!main || !sub) return;
    const parts = summaryParts();
    main.textContent = parts[0] || '';
    sub.textContent = parts[1] || '';
  }

  /** Open or shut the card behind the strip. The strip itself never hides —
   *  it is the handle, and a disclosure with no handle to close it is a trap. */
  function setCollapsed(on) {
    if (!root) return;
    root.classList.toggle('is-collapsed', !!on);
    const strip = root.querySelector('[data-search-strip]');
    if (strip) strip.setAttribute('aria-expanded', String(!on));
    if (on) paintSummary();
  }

  function paintSearchButton() {
    const go = root && root.querySelector('.search-go');
    if (!go || busy) return;   // a repaint mid-send must not undo setBusy's label
    const group = state.tab === 'hotels' && state.hotelMode === 'group';
    go.textContent = group ? 'Request Group Quote' : 'Search';
    go.classList.toggle('is-wide', group);
  }

  function setBusy(on, label) {
    busy = !!on;
    const go = root && root.querySelector('.search-go');
    if (!go) return;
    go.disabled = busy;
    go.classList.toggle('is-busy', busy);
    go.setAttribute('aria-busy', String(busy));
    if (busy) go.textContent = label || 'Sending…';
    else paintSearchButton();
  }

  /** The enquiry landed. Replace the form with an acknowledgement rather than
   *  leaving the fields sitting there — a form that still looks submittable
   *  after a successful submit is an invitation to send it twice. */
  function showGroupSuccess(info) {
    const panel = root && root.querySelector('[data-panel="hotels"]');
    if (!panel) return;
    const who = (info && info.name) ? String(info.name).split(/\s+/)[0] : '';
    const where = (info && info.dest) ? info.dest : 'your group';

    const done = document.createElement('div');
    done.className = 'hotel-sent';
    done.setAttribute('role', 'status');
    done.innerHTML =
      '<svg class="hotel-sent-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2.4" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'
      + '<h3>' + (who ? 'Thanks, ' + esc(who) + '.' : 'Thanks — that\'s with us.') + '</h3>'
      + '<p>Your enquiry for ' + esc(where) + ' has reached the group desk. '
      + 'We reply to group enquiries within one working day.</p>'
      + '<button type="button" class="btn btn-ghost hotel-sent-again" data-group-again>'
      + 'Make another enquiry</button>';

    panel.classList.add('is-sent');
    panel.appendChild(done);
    /* The footer belongs to the form that is no longer there. */
    const foot = root.querySelector('.search-foot');
    if (foot) foot.hidden = true;
    const again = done.querySelector('[data-group-again]');
    if (again) {
      again.addEventListener('click', () => {
        done.remove();
        panel.classList.remove('is-sent');
        if (foot) foot.hidden = false;
        clearError();
        setBusy(false);
        const dest = $('hDest');
        if (dest) dest.focus();
      });
      again.focus();
    }
  }

  /** Show the named product's panel, and mark its tab.
   *
   *  Returns false for a product the card does not hold, changing nothing —
   *  the four are always built, so today that only happens on a bad name, but
   *  the caller still gets a truthful answer. app.js's voice search relies on
   *  it: false means "this card cannot serve that", and it navigates instead.
   *
   *  IT NEVER NAVIGATES AND NEVER RE-RENDERS. Toggling classes is the whole of
   *  it, so everything typed into the other panels — an origin, a date, a room
   *  count — is exactly where it was left when the traveller comes back. */
  function activateTab(name) {
    if (!root) return false;
    const panels = Array.prototype.slice.call(root.querySelectorAll('.search-panel'));
    /* Checked BEFORE anything is toggled. Toggling first and bailing out after
       would have deactivated the panel the card is actually showing on its way
       to discovering it does not have the one being asked for. */
    if (!panels.some(p => p.dataset.panel === name)) return false;
    panels.forEach(p => {
      const on = p.dataset.panel === name;
      p.classList.toggle('active', on);
      /* `hidden` as well as the class: a display:none panel is still reachable
         by a screen reader in some browsers, and its fields would be read out
         as part of a search nobody is running. */
      p.hidden = !on;
    });
    root.querySelectorAll('.search-tab').forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
      /* Roving tabindex: one stop for the whole strip, arrows move within it,
         which is what role="tablist" promises. */
      b.tabIndex = on ? 0 : -1;
    });
    state.tab = name;
    switchHeroVideo(name);
    clearError();
    paintSearchButton();
    const note = $('fMirrorNote');
    if (note) {
      note.textContent = name === 'flights' ? (FOOT_NOTE[state.trip] || '')
        : name === 'hotels' ? (HOTEL_FOOT_NOTE[state.hotelMode] || '') : '';
    }
    paintSummary();
    return true;
  }

  /* ---------------------------------------------------------------------
     Trip type
     --------------------------------------------------------------------- */
  /** Everything that changes when the trip type does, in ONE place.
   *
   *  The alternative — a handler per control, each toggling its own bit — is
   *  what lets a card end up with the return date enabled and the return route
   *  hidden at the same time. Called on every switch and once at mount, so the
   *  first paint and the tenth switch cannot disagree. */
  const FOOT_NOTE = {
    oneway: '',
    round: 'Your return route mirrors the outbound trip automatically.',
    multi: 'Passengers and cabin apply to every flight in this itinerary.',
  };

  function paintTrip() {
    if (!root) return;
    const panel = root.querySelector('[data-panel="flights"]');
    if (!panel) return;
    const grid = panel.querySelector('[data-trip-fields]');
    const mc = panel.querySelector('[data-trip-multi]');
    const round = state.trip === 'round';
    const multi = state.trip === 'multi';

    panel.querySelectorAll('.trip-type').forEach(b => {
      const on = b.dataset.trip === state.trip;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });

    grid.classList.toggle('is-round', round);
    grid.hidden = multi;
    if (mc) mc.hidden = !multi;

    /* THE PARTY IS MOVED, NOT COPIED.
       Passengers and Cabin are the same two elements for every trip type —
       relocated into the multi-city block and back, rather than rendered twice
       and kept in step. There is no second PaxSelector to drift, no second
       <select id="fCabin"> to make the id ambiguous, and switching trip type
       cannot lose what was chosen because nothing is re-created. */
    const paxField = $('fPaxField');
    const cabinField = $('fCabinField');
    const home = multi ? $('mcParty') : grid;
    if (home && paxField && cabinField && paxField.parentElement !== home) {
      home.appendChild(paxField);
      home.appendChild(cabinField);
    }

    /* One way: the return date stays in the row so the card keeps its shape,
       but it cannot be typed into, clicked open or tabbed to. */
    const retField = panel.querySelector('[data-fg="ret"]');
    const retDisplay = $('fRet');
    const retNative = retField ? retField.querySelector('.date-native') : null;
    if (retField) retField.classList.toggle('is-disabled', !round);
    if (retDisplay) {
      retDisplay.disabled = !round;
      retDisplay.tabIndex = round ? 0 : -1;
      retDisplay.setAttribute('aria-disabled', String(!round));
      if (!round) {
        retDisplay.value = '';
        retDisplay.placeholder = 'Not needed';
        if (retNative) retNative.value = '';
      } else if (!retDisplay.value) {
        retDisplay.placeholder = 'Add date';
      }
    }

    if (round) mirrorRoute();
    if (multi) paintRouteChrome();

    const note = $('fMirrorNote');
    if (note) note.textContent = FOOT_NOTE[state.trip] || '';
  }

  /* ---------------------------------------------------------------------
     Hotel mode

     Same shape as paintTrip: everything that changes with the mode happens
     here, once, so the panel cannot end up showing a group contact form beside
     a four-room limit.
     --------------------------------------------------------------------- */
  const HOTEL_FOOT_NOTE = {
    rooms: '',
    group: 'We reply to group enquiries within one working day.',
  };

  function paintHotelMode() {
    if (!root) return;
    const panel = root.querySelector('[data-panel="hotels"]');
    if (!panel) return;
    const group = state.hotelMode === 'group';

    panel.querySelectorAll('[data-hmode]').forEach(b => {
      const on = b.dataset.hmode === state.hotelMode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });

    const grid = panel.querySelector('[data-hotel-fields]');
    if (grid) grid.classList.toggle('is-group', group);
    const contact = panel.querySelector('[data-hotel-group]');
    if (contact) contact.hidden = !group;

    /* The Search button is the card's, shared with every other panel, so its
       label is the one thing that has to be told which mode it is in. Group
       Deals does not search — it asks — and a button that still said "Search"
       would be describing the wrong action. */
    if (state.tab === 'hotels') paintSearchButton();
    paintNights();
  }

  function setHotelMode(next) {
    if (state.hotelMode === next) return;
    state.hotelMode = next;
    clearError();
    paintHotelMode();
  }

  /** The stay length, from the two dates. Written on every date change rather
   *  than at submit, because it is feedback about the choice being made. */
  function paintNights() {
    const out = $('hNights');
    if (!out) return;
    const n = nightsBetween(nativeDate('hIn'), nativeDate('hOut'));
    out.textContent = n ? n + (n === 1 ? ' Night' : ' Nights') : '\u2014';
  }

  /** Whole nights between two ISO days. */
  function nightsBetween(a, b) {
    if (!a || !b) return 0;
    const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
    return Math.max(0, Math.round(ms / 86400000));
  }

  function setTrip(next) {
    if (state.trip === next) return;
    const was = state.trip;

    /* Carry the route the traveller has already typed across the switch.
       Reading the LIVE boxes, not `state` — the simple row only writes state
       when a search is submitted, so a route sitting in the inputs would
       otherwise be thrown away by pressing a trip-type pill. Seeded only into
       an EMPTY first leg, so coming back to Multi City does not overwrite an
       itinerary already planned. */
    if (next === 'multi' && was !== 'multi') {
      const rows = readRoutes();
      const first = rows[0];
      if (first && !first.from && !first.to) {
        setInput(routeInput(first.row, 'from'), $('fFrom'));
        setInput(routeInput(first.row, 'to'), $('fTo'));
        const dep = nativeDate('fDep');
        if (dep) setDate(first.row.querySelector('.date-display').id, dep);
      }
    } else if (next !== 'multi' && was === 'multi') {
      /* And back the other way, so the simple row is not blank after planning
         an itinerary in the multi-city one. */
      const first = readRoutes()[0];
      if (first && (first.from || first.to)) {
        if (!val('fFrom')) setInput($('fFrom'), routeInput(first.row, 'from'));
        if (!val('fTo')) setInput($('fTo'), routeInput(first.row, 'to'));
      }
    }

    state.trip = next;
    paintTrip();
  }

  /** Copy one airport box onto another, label and confirmed code together. */
  function setInput(target, source) {
    if (!target || !source || !source.value) return;
    target.value = source.value;
    target.dataset.key = source.dataset.key || '';
  }

  /* ---------------------------------------------------------------------
     Return route mirror

     Outbound HYD -> DXB means coming back DXB -> HYD. The two return boxes are
     written from the outbound ones on every edit rather than being editable
     copies, so they cannot drift out of step — and they are readonly for the
     same reason. When per-leg routes become a real feature, this is the one
     function that changes.
     --------------------------------------------------------------------- */
  function mirrorRoute() {
    const from = $('fFrom');
    const to = $('fTo');
    const rFrom = $('fRetFrom');
    const rTo = $('fRetTo');
    if (!from || !to || !rFrom || !rTo) return;
    rFrom.value = to.value;
    rTo.value = from.value;
  }

  /* ---------------------------------------------------------------------
     Reading the card
     --------------------------------------------------------------------- */
  const val = id => (($(id) || {}).value || '').trim();

  /** The ISO value behind a formatted date field. The visible input is a
   *  readonly display; the real value is on the type="date" sibling. */
  function nativeDate(displayId) {
    const el = $(displayId);
    const field = el && el.closest('.field-date');
    const native = field && field.querySelector('.date-native');
    return (native && native.value) || '';
  }

  /** "Hyderabad (HYD)" -> "HYD", falling back to the raw string so a hand-typed
   *  city is carried rather than silently dropped. airports.js owns the parsing
   *  because it owns the table it has to match against; this is the shim for
   *  the landing page's own bracket format when that file is absent. */
  function codeFrom(value) {
    if (typeof JPAirports !== 'undefined') return JPAirports.codeOf(value);
    const v = String(value || '').trim();
    const m = /\(([A-Za-z]{3})\)/.exec(v);
    return m ? m[1].toUpperCase() : v;
  }

  /** What an airport box actually means.
   *
   *  data-key FIRST: it is set only by choosing from the list, so it is a
   *  confirmed airport, and it survives a label this table happens to render
   *  differently from what the traveller typed. Free text falls through to
   *  parsing, because a picker must never be the ONLY way to fill a field. */
  function readAirport(el) {
    if (!el) return '';
    if (el.dataset && el.dataset.key) return el.dataset.key;
    return codeFrom(el.value);
  }

  const airportCode = id => readAirport($(id));

  /** "HYD:DXB:2026-09-10,DXB:BKK:2026-09-20" — the itinerary as one query
   *  parameter. Colons and commas survive a URL unescaped and stay readable in
   *  the address bar, which repeated legs[0][from]-style keys do not. */
  const encodeLegs = legs =>
    legs.map(l => [l.from, l.to, l.date].join(':')).join(',');

  function decodeLegs(raw) {
    return String(raw || '').split(',').map(part => {
      const bits = part.split(':');
      return { from: (bits[0] || '').toUpperCase(), to: (bits[1] || '').toUpperCase(), date: bits[2] || '' };
    }).filter(l => l.from && l.to);
  }

  /** "2:7,2" — one room per comma, adults first then each child's age.
   *
   *  Same shape and the same reasoning as encodeLegs above: the rooms array is
   *  the only nested value a hotel search carries, and URLSearchParams turns a
   *  nested value into the string "[object Object]". That is what this used to
   *  put in the address bar, which quietly threw away the child ages the search
   *  will not run without — a gate that costs the traveller a decision and then
   *  discards the answer. */
  const encodeRooms = list =>
    (list || []).map(r => [r.adults].concat(r.childAges || []).join(':')).join(',');

  function decodeRooms(raw) {
    return String(raw || '').split(',').filter(Boolean).map(part => {
      const bits = part.split(':').map(n => parseInt(n, 10));
      const ages = bits.slice(1).filter(Number.isFinite);
      return {
        adults: Number.isFinite(bits[0]) ? bits[0] : 2,
        children: ages.length,
        childAges: ages,
      };
    }).filter(r => r.adults > 0);
  }

  /** Everything the Flights page needs to reproduce this search.
   *
   *  The party and the cabin are read the same way for all three trip types,
   *  because there is only one of each on the card — see paintTrip. */
  function flightCriteria() {
    const party = pax ? pax.value() : { adults: 1, children: 0, infants: 0 };
    const cabin = (val('fCabin') || 'Economy').toLowerCase().replace(/\s+/g, '-');
    const base = {
      trip: state.trip,
      adults: party.adults,
      children: party.children,
      infants: party.infants,
      cabin: cabin,
    };

    if (state.trip === 'multi') {
      const legs = readRoutes().map(l => ({ from: l.from, to: l.to, date: l.date }));
      return Object.assign(base, {
        /* ENCODED HERE, not by the caller. Criteria go into a URL by way of
           `new URLSearchParams(Object.entries(params))`, which stringifies an
           array of objects as "[object Object],[object Object]" — the itinerary
           arrived at the Flights page as literal garbage. Every value in this
           object is now a string or a number, which is what a query parameter
           can actually carry; whoever needs the array back calls decodeLegs. */
        legs: encodeLegs(legs),
        /* The first leg doubles as from/to/depart so a reader that knows
           nothing about itineraries still gets a sensible single search
           rather than three empty fields. */
        from: (legs[0] || {}).from || '',
        to: (legs[0] || {}).to || '',
        depart: (legs[0] || {}).date || '',
        ret: '',
      });
    }

    return Object.assign(base, {
      from: airportCode('fFrom'),
      to: airportCode('fTo'),
      depart: nativeDate('fDep'),
      /* Only a round trip has one. Sending a stale return date from a previous
         round-trip selection would search a trip nobody asked for. */
      ret: state.trip === 'round' ? nativeDate('fRet') : '',
    });
  }

  /** What a destination box means. Same contract as an airport box: a picked
   *  row sets data-key, free text counts only when it names something exactly. */
  function readDestination() {
    const el = $('hDest');
    if (!el) return '';
    if (el.dataset.key) return el.dataset.key;
    return (typeof JPDestinations !== 'undefined')
      ? JPDestinations.keyOf(el.value)
      : el.value.trim();
  }

  const intOf = (id, dflt) => {
    const n = parseInt(val(id), 10);
    return Number.isFinite(n) ? n : dflt;
  };

  /** Everything the results page — or the group desk — needs.
   *
   *  Both modes share the first four fields, which is the whole reason those
   *  controls are rendered once: a switch between modes changes what is
   *  ASKED FOR, not what has already been said. */
  function hotelCriteria() {
    const group = state.hotelMode === 'group';
    const base = {
      mode: state.hotelMode,
      dest: readDestination(),
      checkIn: nativeDate('hIn'),
      checkOut: nativeDate('hOut'),
      nights: nightsBetween(nativeDate('hIn'), nativeDate('hOut')),
    };

    if (group) {
      return Object.assign(base, {
        rooms: intOf('hGroupRooms', 5),
        guests: intOf('hGroupGuests', 10),
        name: val('hName'),
        email: val('hEmail'),
        phone: val('hPhone'),
        company: val('hCompany'),
        notes: val('hNotes'),
      });
    }

    const list = rooms ? rooms.value() : [{ adults: 2, children: 0, childAges: [] }];
    const t = (typeof RoomsSelector !== 'undefined')
      ? RoomsSelector.totals(list) : { adults: 2, children: 0 };
    return Object.assign(base, {
      rooms: list.length,
      adults: t.adults,
      children: t.children,
      /* The per-room breakdown is what a hotel actually prices; the flat
         adults/children totals above are for the results filter.

         TWO REPRESENTATIONS, DELIBERATELY. `roomsDetail` is the array, for a
         caller in this tab that wants the structure (the validator reads it to
         find a missing age). `pax` is the same thing flattened, because that is
         what a URL can carry — whoever needs the array back calls decodeRooms,
         exactly as the Flights page does with decodeLegs. */
      roomsDetail: list,
      pax: encodeRooms(list),
      guests: t.adults + t.children,
    });
  }

  function criteria(kind) {
    if (kind === 'flights') return flightCriteria();
    if (kind === 'hotels') return hotelCriteria();
    if (kind === 'packages') return { type: val('pType'), month: val('pMonth') };
    return {};
  }

  /* ---------------------------------------------------------------------
     Validation. Inline where the card can show it, and the field is focused
     so a keyboard user lands on the thing that is wrong.
     --------------------------------------------------------------------- */
  const VALIDATORS = {
    flights(p) {
      /* The party is checked FIRST, for every trip type. The popup cannot
         produce an illegal one, but a seeded URL can, and this is the last gate
         before a search runs. */
      if (typeof PaxSelector !== 'undefined' && !PaxSelector.isValid(p)) {
        return ['That combination of passengers is not allowed.', null];
      }

      if (p.trip === 'multi') {
        const rows = readRoutes();
        for (let i = 0; i < rows.length; i++) {
          const leg = rows[i];
          const at = role => (leg.row.querySelector('[data-swap-' + role + ']') || {}).id;
          const dateId = (leg.row.querySelector('.date-display') || {}).id;
          const n = i + 1;
          if (!leg.from) return ['Choose where flight ' + n + ' departs from.', at('from')];
          if (!leg.to) return ['Choose where flight ' + n + ' arrives.', at('to')];
          if (leg.from === leg.to) {
            return ['Flight ' + n + ' cannot start and end in the same city.', at('to')];
          }
          if (!leg.date) return ['Choose a departure date for flight ' + n + '.', dateId];
          if (i > 0 && leg.date < rows[i - 1].date) {
            return ['Flight ' + n + ' cannot depart before flight ' + i + '.', dateId];
          }
        }
        return null;
      }

      if (!p.from) return ['Choose where you are flying from.', 'fFrom'];
      if (!p.to) return ['Choose where you are flying to.', 'fTo'];
      if (p.from === p.to) return ['Origin and destination cannot be the same.', 'fTo'];
      if (!p.depart) return ['Choose a departure date.', 'fDep'];
      if (p.trip === 'round') {
        if (!p.ret) return ['Choose a return date, or switch to One Way.', 'fRet'];
        if (p.ret < p.depart) return ['The return date cannot be before departure.', 'fRet'];
      }
      return null;
    },
    hotels(p) {
      /* Common to both modes, and checked first — a group enquiry with no
         destination is as unanswerable as a search with none. */
      if (!p.dest) {
        const typed = val('hDest');
        return [typed
          ? 'We could not find that destination — pick one from the list.'
          : 'Tell us where you are going.', 'hDest'];
      }
      if (!p.checkIn) return ['Choose a check-in date.', 'hIn'];
      if (!p.checkOut) return ['Choose a check-out date.', 'hOut'];
      if (p.checkOut <= p.checkIn) {
        return ['Check-out must be at least one night after check-in.', 'hOut'];
      }

      if (p.mode === 'group') {
        if (p.rooms < 1) return ['How many rooms does the group need?', 'hGroupRooms'];
        if (p.guests < 1) return ['How many guests are you expecting?', 'hGroupGuests'];
        if (!p.name) return ['Tell us who to address the quote to.', 'hName'];
        if (!isEmail(p.email)) {
          return [p.email ? 'That email address does not look right.'
                          : 'We need an email address to send the quote to.', 'hEmail'];
        }
        if (!isPhone(p.phone)) {
          return [p.phone ? 'That phone number does not look right.'
                          : 'We need a phone number in case we have a question.', 'hPhone'];
        }
        return null;
      }

      if (!p.rooms) return ['Choose at least one room.', null];
      if (!p.adults) return ['Every room needs at least one adult.', null];
      /* Rule 8's last line: a child with no age cannot be priced, so the search
         does not proceed until every one has been answered. The popup is opened
         on the way so the answer is one click away rather than a hunt. */
      if (typeof RoomsSelector !== 'undefined' && !RoomsSelector.isComplete(p.roomsDetail)) {
        const m = RoomsSelector.missingAges(p.roomsDetail)[0];
        if (rooms) rooms.open();
        return ['Choose an age for child ' + m.child + ' in room ' + m.room + '.', null];
      }
      return null;
    },
    packages() { return null; },
  };

  /* ---------------------------------------------------------------------
     Inline errors — never alert(), never a toast that floats away from the
     field it is about.

     The message goes in the card's own footer beside the Search button and the
     offending field is outlined, rather than a message under each field: the
     grid rows are a fixed height and a paragraph appearing inside one pushes
     every other field down, which moves the control the traveller is about to
     click. One line in the footer says the same thing and nothing moves.
     --------------------------------------------------------------------- */
  function clearError() {
    if (!root) return;
    const box = root.querySelector('.search-foot-error');
    if (box) box.textContent = '';
    root.querySelectorAll('.is-invalid').forEach(el => {
      el.classList.remove('is-invalid');
      el.removeAttribute('aria-invalid');
    });
  }

  /* Deliberately permissive. These reject what is obviously not an address or
     a number; they do not try to decide what a valid one looks like worldwide,
     because the only real test is whether the reply arrives. */
  const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
  const isPhone = v => (String(v || '').match(/\d/g) || []).length >= 8;

  function complain(message, focusId) {
    clearError();
    const box = root && root.querySelector('.search-foot-error');
    if (box) box.textContent = message;
    else if (typeof showToast === 'function') showToast(message, true);

    const el = focusId && $(focusId);
    if (!el) return;
    const field = el.closest('.field') || el;
    field.classList.add('is-invalid');
    el.setAttribute('aria-invalid', 'true');
    if (!el.disabled) {
      el.focus();
      /* A field inside a hidden mode block cannot be focused; scroll the card
         itself into view instead so the outline is at least visible. */
      if (document.activeElement !== el && root.scrollIntoView) {
        root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  function submit() {
    /* The button is the card's now, not a panel's, so which product is being
       searched comes from whichever panel is showing rather than from where the
       button happens to sit. */
    const panel = root && root.querySelector('.search-panel.active');
    const kind = panel && panel.dataset.panel;
    if (!kind) return;

    /* Clear FIRST, so a message from the previous attempt cannot outlive the
       thing it was about. Switching tab or mode does not clear it, so without
       this a Group Deals complaint stays on screen through a switch to the
       standard flow and a search that then succeeds. */
    clearError();

    const params = criteria(kind);
    const check = VALIDATORS[kind];
    const bad = check ? check(params) : null;
    if (bad) { complain(bad[0], bad[1]); return; }

    /* A search that ran is a search that is settled: on a phone the card folds
       back to its one-line summary so the results it just produced are the
       thing on screen, not the form that produced them. */
    setCollapsed(true);
    if (searchHandler) searchHandler(kind, params);
  }

  /* ---------------------------------------------------------------------
     Seeding — a search arriving in the URL, so the card shows what is being
     displayed underneath it rather than its own defaults.
     --------------------------------------------------------------------- */
  function setDate(displayId, iso) {
    const el = $(displayId);
    const field = el && el.closest('.field-date');
    if (!field || !iso) return;
    const native = field.querySelector('.date-native');
    native.value = iso;
    paintDate(field);
  }

  function paintDate(field) {
    const display = field.querySelector('.date-display');
    const native = field.querySelector('.date-native');
    if (!native.value) return;
    const d = new Date(native.value + 'T00:00:00');
    display.value = d.toLocaleDateString('en-US', { weekday: 'short' })
      + ', ' + d.getDate() + ' ' + d.toLocaleDateString('en-US', { month: 'short' });
  }

  /** @param p a flightCriteria()-shaped object; unknown fields are ignored. */
  function seedFlights(p) {
    if (!p) return;
    if (p.trip === 'oneway' || p.trip === 'round' || p.trip === 'multi') state.trip = p.trip;

    /* An itinerary arriving from a URL replaces the rows wholesale — this runs
       before anything is typed, so there is nothing to preserve. */
    const legs = typeof p.legs === 'string' ? decodeLegs(p.legs) : p.legs;
    if (legs && legs.length) {
      renderRoutes(legs.map(l => ({
        from: l.from ? labelFor(l.from) : '',
        to: l.to ? labelFor(l.to) : '',
        date: l.date || '',
      })));
    }
    /* `undefined` means "leave it alone"; an empty string means "clear it".
       The Flights page needs the second: arriving there with no criteria shows
       every departure from the base, and a To box still reading "Delhi (DEL)"
       would be describing a search the list below is not running. */
    if (p.from !== undefined) setAirport($('fFrom'), p.from);
    if (p.to !== undefined) setAirport($('fTo'), p.to);
    if (p.depart) setDate('fDep', p.depart);
    if (p.ret && state.trip === 'round') setDate('fRet', p.ret);
    if (p.cabin && $('fCabin')) {
      const want = String(p.cabin).replace(/-/g, ' ').toLowerCase();
      const hit = CABINS.find(c => c.toLowerCase() === want
        || (want === 'premium' && c === 'Premium Economy'));
      if (hit) $('fCabin').value = hit;
    }
    if (pax) pax.set({ adults: p.adults, children: p.children, infants: p.infants }, true);
    paintTrip();
    /* Same reason as seedHotels below: the strip must describe the search that
       was actually run, and seeding happens after render(). */
    paintSummary();
  }

  /** @param p a hotelCriteria()-shaped object; unknown fields are ignored. */
  function seedHotels(p) {
    if (!p) return;
    if (p.mode === 'rooms' || p.mode === 'group') state.hotelMode = p.mode;
    if (p.dest !== undefined && $('hDest')) {
      $('hDest').value = p.dest || '';
      $('hDest').dataset.key = p.dest || '';
    }
    if (p.checkIn) setDate('hIn', p.checkIn);
    if (p.checkOut) setDate('hOut', p.checkOut);
    if (rooms && p.roomsDetail && p.roomsDetail.length) rooms.set(p.roomsDetail, true);
    else if (rooms && p.rooms) {
      /* Only a room COUNT survived the URL — rebuild that many default rooms
         rather than dropping to one, and spread the adults across them. */
      const n = Math.max(1, Math.min(RoomsSelector.MAX_ROOMS, p.rooms));
      const adults = Math.max(n, p.adults || n * 2);
      rooms.set(Array.from({ length: n }, (_, i) => ({
        adults: Math.max(1, Math.floor(adults / n) + (i < adults % n ? 1 : 0)),
        children: 0, childAges: [],
      })), true);
    }
    if (p.groupRooms && $('hGroupRooms')) $('hGroupRooms').value = p.groupRooms;
    if (p.groupGuests && $('hGroupGuests')) $('hGroupGuests').value = p.groupGuests;
    paintHotelMode();
    paintNights();
    /* The strip describes the SEEDED search, not the card's defaults. Seeding
       runs after render(), so without this the folded card on a results page
       said "Wed, 2 Sep" over a list of the 10th. */
    paintSummary();
  }

  /** @param p a packages criteria object — {type, month}; others ignored.
   *
   *  The third seeder, and it exists for the same reason as the other two: the
   *  card on a results page has to show the search that produced the list
   *  under it. Without this, arriving at packages.html?type=…&month=… restored
   *  the RESULTS from the URL and left the card on its own defaults, so the
   *  page said "Casino Tour Package / July" over a search for something else.
   *
   *  A value the select does not offer is left alone rather than forced in:
   *  the options are the catalogue's, and appending an unknown one would
   *  invite a search for a package that does not exist. */
  function seedPackages(p) {
    if (!p) return;
    const set = (id, want) => {
      const el = $(id);
      if (!el || !want) return;
      const hit = Array.prototype.slice.call(el.options)
        .find(o => o.value.toLowerCase() === String(want).toLowerCase());
      if (hit) el.value = hit.value;
    };
    set('pType', p.type);
    set('pMonth', p.month);
    paintSummary();
  }

  /** "HYD" -> "Hyderabad (HYD)", or the bare code if airports.js is absent. */
  function labelFor(code) {
    return (typeof JPAirports !== 'undefined') ? JPAirports.label(code) : String(code || '');
  }

  /** Write an airport box the way a PICK would: label in the value, code in
   *  data-key. A seeded field that set only the text would be re-parsed on
   *  submit, which is fine for "Hyderabad (HYD)" and wrong for anything the
   *  table renders differently from what came down the wire. */
  function setAirport(el, code) {
    if (!el) return;
    el.value = code ? labelFor(code) : '';
    el.dataset.key = code ? String(code).toUpperCase() : '';
  }

  /* ---------------------------------------------------------------------
     Wiring
     --------------------------------------------------------------------- */
  function bind() {
    /* The collapsed summary. Delegated so it survives a re-render, and it
       repaints on any change inside the card so the strip is never describing
       a search the fields no longer hold. */
    root.addEventListener('click', e => {
      if (e.target.closest('[data-search-strip]')) {
        setCollapsed(!root.classList.contains('is-collapsed'));
        return;
      }
      /* Anything else clicked in here might have changed a value — the pax and
         rooms popups commit on their own buttons, which fire no `change`. */
      paintSummary();
    });
    root.addEventListener('change', paintSummary);

    /* Product tabs. Arrow keys walk the strip and Home/End jump to its ends —
       role="tablist" promises that and the browser gives us nothing, because
       the tabs are buttons. Selection follows focus, which is the right
       pattern here: every panel is already built, so moving along the strip
       costs nothing and the traveller sees each product as they arrive at it. */
    const tabBtns = Array.prototype.slice.call(root.querySelectorAll('.search-tab'));
    const goToTab = btn => { activateTab(btn.dataset.tab); btn.focus(); };
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
      btn.addEventListener('keydown', e => {
        const at = tabBtns.indexOf(btn);
        let to = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % tabBtns.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + tabBtns.length) % tabBtns.length;
        else if (e.key === 'Home') to = 0;
        else if (e.key === 'End') to = tabBtns.length - 1;
        else return;
        e.preventDefault();
        goToTab(tabBtns[to]);
      });
    });

    /* Trip type. Arrow keys walk the group, which is what role="radiogroup"
       promises — the pills are buttons, so the browser gives us nothing. */
    const tripBtns = Array.prototype.slice.call(root.querySelectorAll('.trip-type'));
    tripBtns.forEach(btn => {
      btn.addEventListener('click', () => setTrip(btn.dataset.trip));
      btn.addEventListener('keydown', e => {
        let to = -1;
        const at = tripBtns.indexOf(btn);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % tripBtns.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + tripBtns.length) % tripBtns.length;
        else return;
        e.preventDefault();
        setTrip(tripBtns[to].dataset.trip);
        tripBtns[to].focus();
      });
    });

    /* Swap. Delegated and scope-based: ONE handler serves the outbound row and
       every multi-city leg, because each of them declares a [data-swap-scope]
       around its own pair. Per-row handlers would have to be attached to rows
       that do not exist yet. */
    root.addEventListener('click', e => {
      const btn = e.target.closest('.swap-btn');
      if (!btn || !root.contains(btn)) return;
      const scope = btn.closest('[data-swap-scope]');
      if (!scope) return;
      const from = scope.querySelector('[data-swap-from]');
      const to = scope.querySelector('[data-swap-to]');
      if (!from || !to) return;
      const tmp = from.value;
      from.value = to.value;
      to.value = tmp;
      /* data-key travels with the text. Swapping the labels alone would leave
         each box asserting the airport the OTHER one is now showing, and
         readAirport trusts the key first. */
      const tmpKey = from.dataset.key || '';
      from.dataset.key = to.dataset.key || '';
      to.dataset.key = tmpKey;
      /* Only the outbound row has a mirror to keep up to date; a multi-city
         leg is its own route. */
      if (scope.hasAttribute('data-trip-fields')) mirrorRoute();
    });

    /* Add / remove a leg. Delegated for the same reason as the swap. */
    const add = $('mcAdd');
    if (add) {
      add.addEventListener('click', () => {
        /* Route continuity: the new leg starts where the last one ended, and
           only the origin is filled — where they go next is the question being
           asked, and answering it for them is not help. */
        const rows = readRoutes();
        const last = rows[rows.length - 1];
        const row = appendRoute({ from: last ? inputValue(last.row, 'to') : '' }, true);
        /* Focus the box the traveller has to fill in next, not the row. */
        const next = row && row.querySelector('[data-swap-to]');
        if (next) next.focus();
      });
    }

    root.addEventListener('click', e => {
      const rm = e.target.closest('[data-mc-remove]');
      if (rm && root.contains(rm)) removeRoute(rm.dataset.mcRemove);
    });

    /* Date fields present at mount. Rows added later are wired by bindRoute,
       which is the same code — see bindDateField. */
    root.querySelectorAll('.field-date').forEach(bindDateField);

    mountAirportPair('fFrom', 'fTo');

    /* The mirror follows the outbound boxes however they are edited. */
    ['fFrom', 'fTo'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('input', mirrorRoute);
        el.addEventListener('change', mirrorRoute);
      }
    });

    /* --- Hotels --------------------------------------------------------- */
    const modeBtns = Array.prototype.slice.call(root.querySelectorAll('[data-hmode]'));
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => setHotelMode(btn.dataset.hmode));
      btn.addEventListener('keydown', e => {
        let to = -1;
        const at = modeBtns.indexOf(btn);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % modeBtns.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + modeBtns.length) % modeBtns.length;
        else return;
        e.preventDefault();
        setHotelMode(modeBtns[to].dataset.hmode);
        modeBtns[to].focus();
      });
    });

    mountDestination('hDest');

    /* Typing anywhere clears a standing error — leaving "we need an email" up
       while one is being typed is the form arguing with the person filling it. */
    root.addEventListener('input', e => {
      if (e.target.closest('.field')) clearError();
    });

    /* Search — one button for the whole card. */
    const go = root.querySelector('.search-go');
    if (go) go.addEventListener('click', e => { e.preventDefault(); submit(); });
  }

  /** Click opens the native picker, the chosen day is formatted into the
   *  display input, and the real value stays on the hidden one.
   *
   *  Its own function because multi-city rows appear after bind() has run and
   *  need exactly this, not a copy of it. */
  function bindDateField(field) {
    const display = field.querySelector('.date-display');
    const native = field.querySelector('.date-native');
    const icon = field.querySelector('.cal-icon');
    if (!display || !native) return;
    const openPicker = () => {
      if (display.disabled) return;
      if (native.showPicker) {
        try { native.showPicker(); } catch (e) { native.focus(); }
      } else {
        native.focus();
        native.click();
      }
    };
    display.addEventListener('click', openPicker);
    if (icon) icon.addEventListener('click', openPicker);
    native.addEventListener('change', () => {
      paintDate(field);
      clearError();

      /* Check-out cannot be the arrival day — a stay is at least one night —
         so the floor moves with check-in, and a date that has just become
         impossible is corrected here rather than rejected at submit. */
      if (field.dataset.hf === 'in') {
        const out = root.querySelector('[data-hf="out"] .date-native');
        if (out) {
          const floor = addDays(native.value, 1);
          out.min = floor;
          if (out.value && out.value <= native.value) {
            out.value = floor;
            paintDate(out.closest('.field-date'));
          }
        }
      }
      if (field.dataset.hf === 'in' || field.dataset.hf === 'out') paintNights();

      /* A return can never precede departure, so move the floor with it and
         drop a now-impossible return rather than failing at submit. */
      if (field.dataset.fg === 'dep') {
        const ret = root.querySelector('[data-fg="ret"] .date-native');
        if (ret) {
          ret.min = native.value;
          if (ret.value && ret.value < native.value) {
            ret.value = '';
            $('fRet').value = '';
          }
        }
      }
    });
  }

  /* ---------------------------------------------------------------------
     Airport picker

     The LISTBOX is SearchWidgets.mountAutocomplete — the same one the hotels
     and packages panels use, so the keyboard handling, the grouping and the
     blur timing exist once. The AIRPORTS are airports.js. This function is only
     the join between them, which is all that was ever particular to flights.

     Degrades to a plain text box if either file is missing: the field still
     accepts "Hyderabad (HYD)" or "Kolkata" and readAirport() still resolves it,
     so a picker that fails to load costs suggestions, not the search.
     --------------------------------------------------------------------- */
  /** Keep a dropdown pinned under its input as a FIXED element.
   *
   *  WHY IT IS NOT SIMPLY ABSOLUTE INSIDE THE FIELD. The card lives in .hero,
   *  which is overflow:hidden (main.css) — an absolutely positioned list opening
   *  from a field near the top of the card runs about 100px past the hero's
   *  bottom edge and is cut off there. Same problem the passenger popover had,
   *  same answer: fixed positioning has no clipping ancestor to fight.
   *
   *  Driven by a MutationObserver rather than by mountAutocomplete calling us,
   *  because the shared widget shows and hides the list by setting [hidden] and
   *  owes this file no hook. Watching the attribute means the widget stays
   *  general and the hotels panel, which has no hero to be clipped by, needs no
   *  change at all. */
  function anchorDropdown(input, list) {
    /* PORTALLED TO <body>, AND position:fixed IS NOT ENOUGH ON ITS OWN.
       .search-card carries `backdrop-filter: blur(20px)` (main.css) — and a
       backdrop-filter makes the element a containing block for fixed-position
       DESCENDANTS, exactly as transform does. Left inside the card, the list
       resolved its coordinates against the card instead of the viewport and
       landed 500px down the page from the field it belongs to. Out here there
       is no such ancestor, which is the same reason the passenger popover is
       moved out.

       data-ap-owner is how a portalled list is later matched back to its input,
       for both the styling hook and the sweep below. */
    list.dataset.apOwner = input.id;
    document.body.appendChild(list);

    const place = () => {
      /* Anchored to the FIELD, not the input: the input is inset by the field's
         18px of padding, and a list that lined up with the text rather than
         with the box it came out of reads as belonging to nothing. */
      const field = input.closest('.field') || input;
      const r = field.getBoundingClientRect();
      const gap = 6;
      /* The field is the floor, not the width. "Thiruvananthapuram (TRV)" does
         not fit in a 176px column, and a suggestion list that truncates its
         suggestions is not helping anyone choose between them. */
      list.style.minWidth = r.width + 'px';
      const w = list.offsetWidth;
      list.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
      /* Flip above when the space below is short — a phone in landscape has
         very little of it. */
      const below = window.innerHeight - r.bottom;
      const h = list.offsetHeight;
      list.style.top = (below < h + gap && r.top > below)
        ? Math.max(8, r.top - h - gap) + 'px'
        : (r.bottom + gap) + 'px';
    };

    let raf = 0;
    const reposition = () => {
      if (raf || list.hidden) return;
      raf = requestAnimationFrame(() => { raf = 0; if (!list.hidden) place(); });
    };

    new MutationObserver(() => {
      if (list.hidden) {
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
      } else {
        place();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
      }
    }).observe(list, { attributes: true, attributeFilter: ['hidden'] });

    /* The widget repaints the list in place while typing, which changes its
       height without touching [hidden]. */
    new MutationObserver(() => { if (!list.hidden) place(); })
      .observe(list, { childList: true });
  }

  /** Portalled lists whose input has left the document — a removed multi-city
   *  leg, or a previous render of the whole card. They cannot remove themselves
   *  because they are no longer anywhere near the node that was deleted. */
  function sweepDropdowns() {
    document.querySelectorAll('.tx-ap-list[data-ap-owner]').forEach(list => {
      if (!document.getElementById(list.dataset.apOwner)) list.remove();
    });
  }

  function mountAirport(inputId, pairedId) {
    if (typeof SearchWidgets === 'undefined' || typeof JPAirports === 'undefined') return null;
    const input = $(inputId);
    const list = $(inputId + 'List');
    if (!input || !list) return null;
    anchorDropdown(input, list);
    /* Typing replaces rather than appends. Landing a caret at the end of
       "Hyderabad (HYD)" and expecting the traveller to clear it first is how a
       filled field becomes harder to change than an empty one. */
    input.addEventListener('focus', () => input.select());

    return SearchWidgets.mountAutocomplete(inputId, {
      source: q => {
        /* A FILLED BOX IS NOT A QUERY. The widget passes the input's value, and
           on focus that value is the label of the airport already chosen —
           "Hyderabad (HYD)" matches no city, so opening a filled field showed an
           empty list. Recognising the box's own label as "nothing typed yet"
           makes focus offer alternatives, which is what opening it is for. */
        const chosen = input.dataset.key;
        const query = (chosen && q === JPAirports.label(chosen)) ? '' : q;
        /* The other half of the pair is excluded live rather than validated
           afterwards: offering the origin as a destination only to reject it on
           submit is a worse way to say the same thing. */
        return JPAirports.match(query, pairedId ? readAirport($(pairedId)) : '');
      },
      emptyText: 'No airports match that — try a city name or a 3-letter code.',
      format: r => JPAirports.label(r.code),
      onPick: r => {
        JPAirports.remember(r.code);
        /* The return leg follows the outbound however it is filled in, and a
           pick does not fire `input`. */
        mirrorRoute();
      },
    });
  }

  /** The destination box. Same shared listbox as the airport pickers, pointed
   *  at destinations.js instead — the widget does not know or care which. */
  function mountDestination(inputId) {
    if (typeof SearchWidgets === 'undefined' || typeof JPDestinations === 'undefined') return null;
    const input = $(inputId);
    const list = $(inputId + 'List');
    if (!input || !list) return null;
    anchorDropdown(input, list);
    input.addEventListener('focus', () => input.select());
    return SearchWidgets.mountAutocomplete(inputId, {
      source: q => {
        /* Focusing a filled box offers alternatives rather than filtering by
           the label already in it — see mountAirport for the same reasoning. */
        const chosen = input.dataset.key;
        return JPDestinations.match(chosen && q === chosen ? '' : q);
      },
      emptyText: 'No destinations match that — try a city, area or hotel name.',
      format: r => r.label,
      onPick: r => JPDestinations.remember(r.key),
    });
  }

  /** Both airport boxes of a scope, wired to exclude each other. */
  function mountAirportPair(fromId, toId) {
    mountAirport(fromId, toId);
    mountAirport(toId, fromId);
  }

  /** Everything a freshly appended multi-city row needs. The swap and the
   *  remove button are delegated from the card, so only the date picker and the
   *  two airport pickers are actually per-row. */
  function bindRoute(row) {
    const field = row.querySelector('.field-date');
    if (field) bindDateField(field);
    const from = routeInput(row, 'from');
    const to = routeInput(row, 'to');
    if (from && to) mountAirportPair(from.id, to.id);
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  /**
   * @param {Element|string} host   element (or id) the card is rendered into
   * @param {Object} [opts]
   * @param {string} [opts.tab]     which product this card searches; the only
   *                                panel it builds. Defaults to flights.
   * @param {Object} [opts.flights] criteria to seed the flights panel with
   */
  function render(host, opts) {
    const el = typeof host === 'string' ? document.getElementById(host) : host;
    if (!el) return null;
    opts = opts || {};
    /* WHICH product this card is. Unknown names fall back to flights rather
       than rendering an empty card. */
    if (opts.tab && PANELS[opts.tab]) state.tab = opts.tab;

    el.innerHTML = cardHtml();
    /* Anything portalled out by a previous render is orphaned the moment the
       card's markup is replaced. */
    sweepDropdowns();
    root = el.querySelector('.search-card');
    armHeroVideos();

    /* Departure defaults to today so the card is submittable without a date
       hunt; the return is deliberately left empty, because a guessed return
       date is a trip nobody planned. */
    setDate('fDep', isoDay(new Date()));
    const depNative = root.querySelector('[data-fg="dep"] .date-native');
    if (depNative) depNative.min = isoDay(new Date());

    /* Mount-guarded: a card built for a non-flights product has no #fPaxField
       to hang the picker on, and the selectors do not check for themselves. */
    if (typeof PaxSelector !== 'undefined' && $('fPaxField')) {
      pax = PaxSelector.create({
        mount: $('fPaxField'),
        label: 'Passengers',
        value: { adults: 1, children: 0, infants: 0 },
      });
    }

    if (typeof RoomsSelector !== 'undefined' && $('hRoomsField')) {
      rooms = RoomsSelector.create({
        mount: $('hRoomsField'),
        label: 'Rooms & Guests',
        value: [RoomsSelector.blankRoom()],
        onChange: () => clearError(),
      });
    }

    /* Tomorrow and the night after: a hotel search with no dates is not a
       search, and today/tomorrow is the shortest real stay. */
    const today = new Date();
    setDate('hIn', addDays(isoDay(today), 1));
    setDate('hOut', addDays(isoDay(today), 2));
    const inNative = root.querySelector('[data-hf="in"] .date-native');
    const outNative = root.querySelector('[data-hf="out"] .date-native');
    if (inNative) inNative.min = isoDay(today);
    if (outNative) outNative.min = addDays(isoDay(today), 2);

    bind();
    /* Two empty legs, because one leg is not a multi-city trip and asking the
       traveller to press Add before they can type anything is a step with no
       purpose. seedFlights replaces these if an itinerary arrives in the URL. */
    renderRoutes();
    if (opts.flights) seedFlights(opts.flights);
    if (opts.hotels) seedHotels(opts.hotels);
    if (opts.packages) seedPackages(opts.packages);
    paintTrip();
    paintHotelMode();
    paintNights();
    activateTab(state.tab);
    paintSummary();
    if (typeof JPIcon !== 'undefined') JPIcon.mount(root);
    return root;
  }

  return {
    render,
    /* The itinerary codec is exported because the Flights page has to read the
       same `legs=` parameter this card writes. One encoder, one decoder. */
    encodeLegs,
    decodeLegs,
    /* Same pair for the hotel party, so a results page can get the per-room
       breakdown (and the child ages) back out of the URL. */
    encodeRooms,
    decodeRooms,
    activateTab,
    criteria,
    flightCriteria,
    seedFlights,
    seedHotels,
    seedPackages,
    paintTrip,
    paintHotelMode,
    get hotelMode() { return state.hotelMode; },
    hotelCriteria,
    roomsValue: () => (rooms ? rooms.value() : []),
    setSearchHandler(fn) { searchHandler = fn; },
    /* hero-shell folds the card on the results pages; only it knows the
       page is a results page rather than the landing page. */
    setCollapsed,
    /* The group-enquiry submission is the search handler's job, not the card's
       — the card does not know where an enquiry goes any more than it knows
       which page a search lands on. These are how it reports back. */
    setBusy,
    showGroupSuccess,
    complain,
    clearError,
    get trip() { return state.trip; },
    get tab() { return state.tab; },
    passengers: () => (pax ? pax.value() : { adults: 1, children: 0, infants: 0 }),
  };
})();
