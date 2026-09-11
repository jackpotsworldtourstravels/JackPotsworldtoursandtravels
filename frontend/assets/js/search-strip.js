'use strict';
/* ===========================================================================
   search-strip.js — the results pages' search strip.
   ===========================================================================
   A SEPARATE COMPONENT FROM booking-card.js, ON PURPOSE.

   The landing page's card and this strip answer the same question and are not
   the same control. The card SELLS a search: product tabs, a trust row, room
   for Group Deals and a five-leg multi-city itinerary. The strip EDITS one
   that has already run: a single compact row above a page of results, every
   cell a label and its current value, nothing that is not a criterion.

   An earlier attempt made the card render itself smaller on results pages.
   That kept the card's markup, its tab strip, its trust row and its panel
   stack alive behind a class — so the two layouts could never really diverge,
   and every change to one risked the other. This file owns its own markup and
   index.html never loads it.

   WHAT IT DOES NOT OWN, AND DELIBERATELY REUSES
       SearchWidgets.mountAutocomplete   the airport / destination listbox
       PaxSelector.create                travellers, and the rules about them
       RoomsSelector.create              rooms and guests, and child ages
       <input type="date">               the platform's own picker
   The pickers are the parts with real rules in them — a party that cannot fly,
   a child with no age — and those rules live in one place for the whole
   product. This file is a layout.

   IT DOES NOT KNOW WHAT A SEARCH MEANS. render() takes an onSearch callback
   and hands it a criteria object; where that goes, and whether the results
   re-render or the page navigates, is the host page's business — the same
   division booking-card.js has with its search handler.
   =========================================================================== */

const SearchStrip = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? ''))
    : String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const $ = id => document.getElementById(id);

  /* Local midnight, not toISOString(): that converts to UTC first, and in IST
     local midnight is still yesterday over there — every default date landed a
     day early. Same reasoning, same code, as booking-card.js. */
  function isoDay(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  /** "Wed, 21 Oct 26" — the strip is narrow, so the year is two digits. */
  function prettyDay(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-GB', { weekday: 'short' })
      + ', ' + d.getDate() + ' ' + d.toLocaleDateString('en-GB', { month: 'short' })
      + ' ' + String(d.getFullYear()).slice(2);
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];

  const CABINS = ['Economy', 'Premium Economy', 'Business', 'First'];
  const CABIN_KEY = { 'Economy': 'economy', 'Premium Economy': 'premium',
                      'Business': 'business', 'First': 'first' };
  const CABIN_LABEL = { economy: 'Economy', premium: 'Premium Economy',
                        business: 'Business', first: 'First' };

  const BUDGETS = [
    { v: 'any', label: 'Any budget' },
    { v: '0-25000', label: 'Under ₹25,000' },
    { v: '25000-50000', label: '₹25,000 – ₹50,000' },
    { v: '50000-100000', label: '₹50,000 – ₹1,00,000' },
    { v: '100000-', label: 'Over ₹1,00,000' },
  ];

  /* ---------------------------------------------------------------------
     Cells

     Every cell is the same shape — a small caps label over the current value —
     which is what makes the row read as one control rather than eight. The
     three kinds differ only in what sits under the label.
     --------------------------------------------------------------------- */
  const cell = (cls, label, control, forId) =>
    '<div class="ss-cell ' + (cls || '') + '">'
    + '<label class="ss-lab"' + (forId ? ' for="' + forId + '"' : '') + '>' + esc(label) + '</label>'
    + control + '</div>';

  /** A text box with a listbox under it. The ids are what
   *  SearchWidgets.mountAutocomplete looks for: `id` and `id + 'List'`. */
  const acCell = (id, label, placeholder) =>
    cell('ss-ac', label,
      '<input id="' + id + '" class="ss-val ss-input" type="text" autocomplete="off"'
      + ' role="combobox" aria-autocomplete="list" aria-expanded="false"'
      + ' aria-controls="' + id + 'List" placeholder="' + esc(placeholder || '') + '">'
      + '<div class="tx-ap-list ss-list" id="' + id + 'List" role="listbox"'
      + ' aria-label="' + esc(label) + ' suggestions" hidden></div>', id);

  /** A readonly display with the platform's date picker layered over it — the
   *  same pairing the landing page's card uses, so both get the native
   *  calendar rather than a hand-built one that would need its own locale,
   *  keyboard model and min/max handling. */
  const dateCell = (id, label, placeholder) =>
    cell('ss-date', label,
      '<input id="' + id + '" class="ss-val ss-input ss-date-display" readonly'
      + ' placeholder="' + esc(placeholder || 'Select date') + '">'
      + '<input type="date" class="ss-date-native" id="' + id + 'Native"'
      + ' aria-label="' + esc(label) + '">', id);

  const selectCell = (id, label, options) =>
    cell('ss-sel', label,
      '<select id="' + id + '" class="ss-val ss-select">' + options + '</select>', id);

  /** Travellers / Rooms & Guests. The selector modules render their own
   *  trigger button into this slot at mount. */
  const popCell = (id, label) =>
    cell('ss-pop', label, '<div class="ss-popmount" id="' + id + '"></div>');

  const opts = (list, sel) => list.map(o => {
    const v = typeof o === 'string' ? o : o.v;
    const t = typeof o === 'string' ? o : o.label;
    return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>'
      + esc(t) + '</option>';
  }).join('');

  const SWAP = '<button type="button" class="ss-swap" id="ssSwap" aria-label="Swap origin and destination">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M7 16H3l4-4"/><path d="M3 16h14a4 4 0 0 0 0-8"/>'
    + '</svg></button>';

  /* TWO BUTTONS, TWO DIFFERENT JOBS, AND THE SECOND IS NOT A DUPLICATE.

     Search runs whatever the row is currently showing. Modify opens the
     LANDING PAGE'S CARD directly underneath the row — the only editor on the
     site that can reach the criteria this row has no cells for: a five-leg
     multi-city itinerary, the special-fare categories, and Hotels' Group
     Deals. flightsHtml below deliberately withholds the Multi City option
     unless the search that arrived already was one, because the row cannot
     edit an itinerary; this button is where that editor now lives, so the
     option no longer has to be hidden to avoid promising something. */
  const ACTIONS = '<div class="ss-actions">'
    + '<button type="button" class="ss-modify" id="ssModify"'
    + ' aria-expanded="false" aria-controls="ssFull">Modify</button>'
    + '<button type="button" class="ss-go" id="ssGo">Search</button>'
    + '</div>';

  /* ---------------------------------------------------------------------
     The three layouts
     --------------------------------------------------------------------- */
  function flightsHtml(v) {
    /* Multi City is offered only when the search that arrived IS one. The
       strip is a single row and cannot edit a five-leg itinerary; showing the
       option to somebody on a one-way search would promise an editor that is
       not here. Shown when it applies so the row can at least say truthfully
       what is being displayed. */
    const trips = [{ v: 'oneway', label: 'One Way' }, { v: 'round', label: 'Round Trip' }]
      .concat(v.trip === 'multi' ? [{ v: 'multi', label: 'Multi City' }] : []);

    return selectCell('ssTrip', 'Trip type', opts(trips, v.trip || 'oneway'))
      + acCell('ssFrom', 'From', 'City or airport')
      + SWAP
      + acCell('ssTo', 'To', 'Where to?')
      + dateCell('ssDep', 'Depart')
      + dateCell('ssRet', 'Return', 'Add return')
      + popCell('ssPax', 'Travellers')
      + selectCell('ssCabin', 'Cabin class',
          opts(CABINS, CABIN_LABEL[v.cabin] || 'Economy'))
      + ACTIONS;
  }

  function hotelsHtml() {
    return acCell('ssDest', 'Destination', 'City, area or hotel')
      + dateCell('ssIn', 'Check-in')
      + dateCell('ssOut', 'Check-out')
      + popCell('ssRooms', 'Rooms & guests')
      + ACTIONS;
  }

  function packagesHtml(v) {
    return acCell('ssPkgDest', 'Destination', 'Anywhere')
      + selectCell('ssPkgMonth', 'Departure month',
          opts([{ v: 'any', label: 'Any month' }].concat(
            MONTHS.map(m => ({ v: m, label: m }))), v.month || 'any'))
      + popCell('ssPkgPax', 'Travellers')
      + selectCell('ssPkgBudget', 'Budget', opts(BUDGETS, v.budget || 'any'))
      + ACTIONS;
  }

  const LAYOUTS = { flights: flightsHtml, hotels: hotelsHtml, packages: packagesHtml };

  /* ---------------------------------------------------------------------
     Mount
     --------------------------------------------------------------------- */
  let product = null;
  let root = null;
  let pax = null;
  let rooms = null;
  let onSearch = null;
  let destSource = null;

  function setDate(id, iso) {
    const disp = $(id);
    const nat = $(id + 'Native');
    if (!disp || !nat) return;
    nat.value = iso || '';
    disp.value = iso ? prettyDay(iso) : '';
  }
  const getDate = id => ($(id + 'Native') || {}).value || '';

  function bindDate(id, onChange) {
    const disp = $(id);
    const nat = $(id + 'Native');
    if (!disp || !nat) return;
    /* The readonly display is the visible control, so a click on it has to
       reach the native input — showPicker() where the browser has it, and a
       plain focus+click everywhere else. */
    const open = () => {
      if (nat.showPicker) { try { nat.showPicker(); return; } catch (e) { /* fall through */ } }
      nat.focus();
      nat.click();
    };
    disp.addEventListener('click', open);
    disp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    nat.addEventListener('change', () => {
      disp.value = nat.value ? prettyDay(nat.value) : '';
      if (onChange) onChange(nat.value);
    });
  }

  /** JPAirports.match() already answers an empty query with recents and
   *  popular airports, so there is no branch here — and excluding the OTHER
   *  box's airport is the table's job too, which is why its code is passed
   *  through rather than filtered afterwards. */
  function airportSource(skipId) {
    return q => {
      if (typeof JPAirports === 'undefined') return [];
      const skip = skipId ? (($(skipId) || {}).dataset || {}).key : '';
      return JPAirports.match(q, skip);
    };
  }

  function setAirport(id, code) {
    const el = $(id);
    if (!el) return;
    el.value = code && typeof JPAirports !== 'undefined' ? JPAirports.label(code) : (code || '');
    el.dataset.key = code ? String(code).toUpperCase() : '';
  }
  const readAirport = id => {
    const el = $(id);
    if (!el) return '';
    if (el.dataset.key) return el.dataset.key;
    return (typeof JPAirports !== 'undefined') ? (JPAirports.codeOf(el.value) || '') : '';
  };

  /** What the strip is currently asking for. Shapes match what the pages
   *  already consume, so no caller had to change to read this. */
  function criteria() {
    if (product === 'flights') {
      const p = pax ? pax.value() : { adults: 1, children: 0, infants: 0 };
      const trip = ($('ssTrip') || {}).value || 'oneway';
      return {
        trip,
        from: readAirport('ssFrom'),
        to: readAirport('ssTo'),
        depart: getDate('ssDep'),
        ret: trip === 'round' ? getDate('ssRet') : '',
        adults: p.adults, children: p.children, infants: p.infants,
        cabin: CABIN_KEY[($('ssCabin') || {}).value] || 'economy',
      };
    }
    if (product === 'hotels') {
      const list = rooms ? rooms.value() : [];
      const t = (typeof RoomsSelector !== 'undefined' && list.length)
        ? RoomsSelector.totals(list) : { adults: 2, children: 0 };
      return {
        dest: (($('ssDest') || {}).value || '').trim(),
        checkIn: getDate('ssIn'),
        checkOut: getDate('ssOut'),
        rooms: list.length || 1,
        adults: t.adults, children: t.children,
        guests: t.adults + t.children,
        roomsDetail: list,
      };
    }
    const p = pax ? pax.value() : { adults: 1, children: 0, infants: 0 };
    return {
      dest: (($('ssPkgDest') || {}).value || '').trim(),
      month: ($('ssPkgMonth') || {}).value || 'any',
      travellers: p.adults + p.children,
      budget: ($('ssPkgBudget') || {}).value || 'any',
    };
  }

  /** Round trip shows the return date; one way TAKES IT OFF THE ROW. Called
   *  on mount and on every trip-type change, so the first paint and the tenth
   *  cannot disagree about it.
   *
   *  IT USED TO BE GREYED AND THAT WAS THE BUG. `.ss-cell.is-off` dimmed the
   *  text and killed pointer events on the invisible native input, but the
   *  readonly display sitting on top of it kept its own click handler — so a
   *  one-way search still opened a calendar, still accepted a date, and still
   *  showed it. criteria() dropped the value on the way out, which made it
   *  worse rather than better: the row said a return was booked and the search
   *  that ran was one-way.
   *
   *  Hidden, not disabled, because the cell is not a criterion of a one-way
   *  trip at all. `hidden` needs the author rule in search-strip.css —
   *  `.ss-cell` sets `display:flex`, which outranks the UA sheet's
   *  `[hidden] { display:none }` and left the cell fully visible. The native
   *  input is disabled as well so a hidden cell cannot be tabbed into. */
  function paintTrip() {
    if (product !== 'flights' || !root) return;
    const trip = ($('ssTrip') || {}).value || 'oneway';
    const ret = $('ssRet');
    if (!ret) return;
    const off = trip !== 'round';
    const cell = ret.closest('.ss-cell');
    if (cell) cell.hidden = off;
    ret.readOnly = true;
    ret.tabIndex = off ? -1 : 0;
    const nat = $('ssRetNative');
    if (nat) nat.disabled = off;
    if (off) setDate('ssRet', '');
  }

  /* ---------------------------------------------------------------------
     Modify — the landing page's card, opened underneath the row

     WHY THIS IS NOT A SECOND SEARCH FORM. The row and the card are already
     two editors for one search (see the file header); what the row cannot do
     is reach the criteria it has no cells for — a five-leg itinerary, the
     special-fare categories, Hotels' Group Deals. Rather than grow the row
     into the card, Modify OPENS the card, and whatever comes back out of it
     is reshaped into exactly what criteria() returns, so the host page's
     onSearch cannot tell which of the two produced the search it is handed.

     ONE CARD PER PAGE. BookingCard is a module singleton, so mounting it here
     is safe only because the results pages mount it nowhere else — hero-shell
     builds the strip into the hero dock, not the card. index.html never loads
     this file.
     --------------------------------------------------------------------- */
  let fullHost = null;    /* the <div class="ss-full"> under the row */
  let fullBuilt = false;  /* has BookingCard been mounted into it yet?   */
  let escBound = false;   /* render() may run again; the listener must not */

  /** BookingCard speaks hyphenated cabin labels ('premium-economy'); this
   *  strip and the results pages speak CABIN_KEY ('premium'). */
  function cabinKeyOf(c) {
    const want = String(c || '').replace(/-/g, ' ').trim().toLowerCase();
    if (want === 'premium' || want === 'premium economy') return 'premium';
    if (want === 'business') return 'business';
    if (want === 'first') return 'first';
    return 'economy';
  }

  /** What the card handed back, in the shape criteria() returns. */
  function fromCard(kind, p) {
    if (kind === 'flights') {
      return {
        trip: p.trip || 'oneway',
        from: p.from || '',
        to: p.to || '',
        depart: p.depart || '',
        /* Same rule criteria() applies: only a round trip carries one, so a
           stale return from a previous selection cannot ride along. */
        ret: p.trip === 'round' ? (p.ret || '') : '',
        adults: p.adults, children: p.children, infants: p.infants,
        cabin: cabinKeyOf(p.cabin),
        /* Already a string — BookingCard encodes the itinerary itself so it
           can survive a URL. Passed through for a page that reads it. */
        legs: p.legs || '',
        fare: p.fare || 'regular',
      };
    }
    if (kind === 'hotels') {
      return {
        dest: p.dest || '',
        checkIn: p.checkIn || '',
        checkOut: p.checkOut || '',
        rooms: p.rooms || 1,
        adults: p.adults, children: p.children,
        guests: p.guests,
        roomsDetail: p.roomsDetail || [],
      };
    }
    /* Packages: the card asks for a type and a month and nothing else, so the
       budget and the party stay whatever the ROW is showing rather than being
       silently reset to a default nobody chose. */
    const now = criteria();
    return {
      dest: p.type || now.dest,
      month: p.month || 'any',
      travellers: now.travellers,
      budget: now.budget,
    };
  }

  /** Put a criteria object back into the ROW's own cells.
   *
   *  WITHOUT THIS THE ROW LIES. A search run from the Modify panel re-renders
   *  the results and rewrites the URL, but the row above them is a separate
   *  set of controls and kept whatever it was showing — change the destination
   *  in the card, press Search, and the list said "Hyderabad to Bengaluru"
   *  over a row whose To box was empty. The row is the page's description of
   *  the search; it has to be the one that ran.
   *
   *  Shapes are criteria()'s, so this is the inverse of fromCard() above. */
  function seedRow(v) {
    if (product === 'flights') {
      const trip = $('ssTrip');
      if (trip) {
        /* flightsHtml only offers Multi City when the search that arrived was
           one. The card can now MAKE it one, so the option has to appear. */
        if (v.trip === 'multi'
            && !Array.prototype.some.call(trip.options, o => o.value === 'multi')) {
          trip.insertAdjacentHTML('beforeend', '<option value="multi">Multi City</option>');
        }
        trip.value = v.trip || 'oneway';
      }
      setAirport('ssFrom', v.from);
      setAirport('ssTo', v.to);
      setDate('ssDep', v.depart || '');
      setDate('ssRet', v.ret || '');
      if (pax && pax.set) {
        pax.set({ adults: v.adults, children: v.children, infants: v.infants }, true);
      }
      const cabin = $('ssCabin');
      if (cabin) cabin.value = CABIN_LABEL[v.cabin] || 'Economy';
      /* LAST, because it is what hides the Return cell — and it reads the trip
         type this function has just written. */
      paintTrip();
      return;
    }
    if (product === 'hotels') {
      const dest = $('ssDest');
      if (dest) dest.value = v.dest || '';
      setDate('ssIn', v.checkIn || '');
      setDate('ssOut', v.checkOut || '');
      if (rooms && rooms.set && v.roomsDetail && v.roomsDetail.length) {
        rooms.set(v.roomsDetail, true);
      }
      return;
    }
    const pdest = $('ssPkgDest');
    if (pdest) pdest.value = v.dest || '';
    const month = $('ssPkgMonth');
    if (month) month.value = v.month || 'any';
    const budget = $('ssPkgBudget');
    if (budget) budget.value = v.budget || 'any';
  }

  function closeModify() {
    if (!fullHost) return;
    fullHost.hidden = true;
    const btn = $('ssModify');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('is-on');
    }
  }

  function openFull() {
    if (!fullHost || typeof BookingCard === 'undefined') return;
    if (!fullBuilt) {
      /* SEEDED FROM THE ROW, not from the card's own defaults — the card is
         opening on top of a page of results, and it has to describe the
         search that produced them. */
      const now = criteria();
      const seed = product === 'flights' ? { flights: now }
        : product === 'hotels' ? { hotels: now }
        : { packages: { type: now.dest, month: now.month } };
      BookingCard.render(fullHost, Object.assign({ tab: product }, seed));
      BookingCard.setSearchHandler((kind, params) => {
        /* A GROUP DEALS SUBMISSION IS AN ENQUIRY, NOT A SEARCH. Same check
           the landing page makes, through the same module, so the enquirer's
           name, email and phone cannot fall through into a search. */
        if (typeof GroupEnquiry !== 'undefined' && GroupEnquiry.isGroup(kind, params)) {
          GroupEnquiry.handle(params);
          return;
        }
        closeModify();
        const next = fromCard(kind, params);
        seedRow(next);
        if (onSearch) onSearch(next);
      });
      fullBuilt = true;
    }
    fullHost.hidden = false;
    const btn = $('ssModify');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('is-on');
    }
  }

  function bindModify(el) {
    fullHost = el.querySelector('.ss-full');
    fullBuilt = false;
    const btn = $('ssModify');
    if (!btn || !fullHost) return;
    /* No card on the page means no editor to open, so the button is not
       offered at all — better than one that does nothing when pressed. */
    if (typeof BookingCard === 'undefined') { btn.remove(); return; }
    btn.addEventListener('click', () => {
      if (fullHost.hidden) openFull(); else closeModify();
    });
    if (escBound) return;
    escBound = true;
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && fullHost && !fullHost.hidden) closeModify();
    });
  }

  /**
   * @param {string|Element} host
   * @param {Object} o
   * @param {string} o.product  'flights' | 'hotels' | 'packages'
   * @param {Object} [o.value]  the search to show; shapes as criteria() returns
   * @param {Function} [o.onSearch]  handed criteria() when Search is pressed
   * @param {Function} [o.destinations]  () => rows, for the hotel/package box
   */
  function render(host, o) {
    const el = typeof host === 'string' ? $(host) : host;
    if (!el) return null;
    o = o || {};
    product = LAYOUTS[o.product] ? o.product : 'flights';
    onSearch = o.onSearch || null;
    destSource = o.destinations || null;
    const v = o.value || {};

    el.innerHTML = '<div class="ss-strip ss-' + product + '" role="search"'
      + ' aria-label="Edit your search">' + LAYOUTS[product](v) + '</div>'
      /* Empty until Modify is pressed. BookingCard is a heavy control — four
         panels, three pickers and a video switcher — and building it on every
         results page for a button most visitors never press is a cost for
         nothing. See openFull(). */
      /* `hr-card-scope` is what dresses the card once it is mounted — the
         reference styling for the tabs, the fare tiles and the quick tools
         lives in home-ref.css and used to be scoped to the landing page's
         body alone. See the note at the top of that file. */
      + '<div class="ss-full hr-card-scope" id="ssFull" hidden></div>';
    root = el.querySelector('.ss-strip');

    if (product === 'flights') {
      if (typeof SearchWidgets !== 'undefined') {
        SearchWidgets.mountAutocomplete('ssFrom', { source: airportSource('ssTo') });
        SearchWidgets.mountAutocomplete('ssTo', { source: airportSource('ssFrom') });
      }
      setAirport('ssFrom', v.from);
      setAirport('ssTo', v.to);
      setDate('ssDep', v.depart || isoDay(new Date()));
      if (v.ret) setDate('ssRet', v.ret);
      const depNat = $('ssDepNative');
      if (depNat) depNat.min = isoDay(new Date());
      bindDate('ssDep', iso => {
        /* A return before the outbound is not a trip. Nudge it rather than
           rejecting it later at validation. */
        const rn = $('ssRetNative');
        if (rn) rn.min = iso;
        if (getDate('ssRet') && getDate('ssRet') < iso) setDate('ssRet', iso);
      });
      bindDate('ssRet');
      if (typeof PaxSelector !== 'undefined') {
        pax = PaxSelector.create({
          mount: $('ssPax'), label: 'Travellers',
          value: {
            adults: v.adults || 1, children: v.children || 0, infants: v.infants || 0,
          },
        });
      }
      const trip = $('ssTrip');
      if (trip) trip.addEventListener('change', paintTrip);
      const swap = $('ssSwap');
      if (swap) swap.addEventListener('click', () => {
        const a = $('ssFrom'), b = $('ssTo');
        const av = a.value, ak = a.dataset.key || '';
        a.value = b.value; a.dataset.key = b.dataset.key || '';
        b.value = av; b.dataset.key = ak;
      });
      paintTrip();
    }

    if (product === 'hotels') {
      if (typeof SearchWidgets !== 'undefined' && destSource) {
        SearchWidgets.mountAutocomplete('ssDest', { source: destSource });
      }
      if (v.dest) $('ssDest').value = v.dest;
      const today = new Date();
      setDate('ssIn', v.checkIn || isoDay(today));
      setDate('ssOut', v.checkOut || '');
      const inNat = $('ssInNative');
      if (inNat) inNat.min = isoDay(today);
      bindDate('ssIn', iso => {
        const on = $('ssOutNative');
        if (on) on.min = iso;
        /* Check-out must be at least the next night. */
        if (getDate('ssOut') && getDate('ssOut') <= iso) {
          const d = new Date(iso + 'T00:00:00');
          d.setDate(d.getDate() + 1);
          setDate('ssOut', isoDay(d));
        }
      });
      bindDate('ssOut');
      if (typeof RoomsSelector !== 'undefined') {
        rooms = RoomsSelector.create({
          mount: $('ssRooms'), label: 'Rooms & guests',
          value: (v.roomsDetail && v.roomsDetail.length)
            ? v.roomsDetail : [RoomsSelector.blankRoom()],
        });
      }
    }

    if (product === 'packages') {
      if (typeof SearchWidgets !== 'undefined' && destSource) {
        SearchWidgets.mountAutocomplete('ssPkgDest', { source: destSource });
      }
      if (v.dest) $('ssPkgDest').value = v.dest;
      if (typeof PaxSelector !== 'undefined') {
        pax = PaxSelector.create({
          mount: $('ssPkgPax'), label: 'Travellers',
          value: { adults: v.travellers || 2, children: 0, infants: 0 },
        });
      }
    }

    /** Half-typed boxes must not become a search.
     *
     *  readAirport() falls back to codeOf(), so a box reading "Mum" resolves
     *  to nothing — and without this the strip searched for `to=Mum`, which
     *  no results page can answer and which then sat in the URL. The cell is
     *  marked and the search does not run. */
    function valid() {
      let ok = true;
      const bad = id => {
        const el = $(id);
        if (!el) return;
        ok = false;
        el.closest('.ss-cell').classList.add('is-invalid');
        el.focus();
      };
      root.querySelectorAll('.is-invalid').forEach(c => c.classList.remove('is-invalid'));
      if (product === 'flights') {
        if (($('ssTo').value || '').trim() && !readAirport('ssTo')) bad('ssTo');
        else if (($('ssFrom').value || '').trim() && !readAirport('ssFrom')) bad('ssFrom');
      }
      return ok;
    }

    const submit = () => { if (valid() && onSearch) onSearch(criteria()); };

    const go = $('ssGo');
    if (go) go.addEventListener('click', submit);
    bindModify(el, v);
    /* Enter anywhere in the strip runs the search, which is what a row of
       inputs with one button leads everybody to expect. */
    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (e.target.closest('.ss-list')) return;   // the listbox owns Enter
      e.preventDefault();
      submit();
    });

    return root;
  }

  return { render, criteria, prettyDay, closeModify };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SearchStrip;
