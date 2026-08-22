'use strict';
/* ===========================================================================
   flight-search.js — the Flights search panel.
   ===========================================================================
   Lifted out of travel-explore.js, which owns RESULTS: fetching, filtering,
   sorting and rendering the list. This owns the CRITERIA: the controls a
   traveller uses to say what they want. The seam between them is `state` plus
   one callback, so neither has to know how the other works.

   BUILT FROM THE PAGE'S OWN DESIGN SYSTEM. Every control reuses the tx-*
   classes already in travel-explore.css — tx-sf for a field, tx-btn for a
   button, tx-chip for a pill. The three widgets that genuinely did not exist
   (an airport picker, a calendar, a traveller popup) add tx-ap-*, tx-cal-* and
   tx-pax-* in the same idiom rather than a new visual language.

   NOTHING HERE SEARCHES. It validates, writes `state`, and calls onSearch().
   travel-explore decides what that means.
   =========================================================================== */

const FlightSearch = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const $ = id => document.getElementById(id);
  const iso = d => d.toISOString().slice(0, 10);
  const today = () => iso(new Date());

  /* Airports the traveller has actually used, most recent first. Kept small:
     a "recent" list long enough to scroll is just the full list again. */
  const RECENT_KEY = 'jpc_recent_airports';
  const RECENT_MAX = 5;

  /* Shown before anything has been typed.
     Every code here EXISTS in TravelData.airports — an earlier draft listed
     BOM and DXB, which this schedule does not serve, and they silently
     vanished from the list. Popular means "popular among what we sell". */
  const POPULAR = ['HYD', 'DEL', 'BLR', 'CCU', 'BKK', 'JED'];

  let state = null;
  let onSearch = null;
  let searching = false;

  /* ---------------------------------------------------------------------
     Recent airports
     --------------------------------------------------------------------- */
  function recentCodes() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(c => TravelData.airports[c]).slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }

  function rememberAirport(code) {
    if (!code || !TravelData.airports[code]) return;
    try {
      const next = [code, ...recentCodes().filter(c => c !== code)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch { /* private mode — recents are a convenience, not a requirement */ }
  }

  /* ---------------------------------------------------------------------
     Airport picker

     A text box over a listbox, not a <select>: a traveller types "Bombay",
     "BOM" or "Mumbai" and any of the three should find it. The <select> it
     replaces could only be driven by the city name it happened to be labelled
     with.
     --------------------------------------------------------------------- */
  function matchAirports(query) {
    const all = Object.entries(TravelData.airports);
    const q = query.trim().toLowerCase();
    if (!q) {
      const recents = recentCodes();
      const popular = POPULAR.filter(c => TravelData.airports[c] && !recents.includes(c));
      return [
        ...recents.map(c => ({ code: c, ...TravelData.airports[c], group: 'Recent searches' })),
        ...popular.map(c => ({ code: c, ...TravelData.airports[c], group: 'Popular airports' })),
      ];
    }
    return all
      .map(([code, a]) => ({ code, ...a }))
      .filter(a => code_matches(a, q))
      /* Code match first: somebody typing "DEL" means the airport, not every
         city whose name happens to contain those letters. */
      .sort((a, b) => (b.code.toLowerCase().startsWith(q) ? 1 : 0) - (a.code.toLowerCase().startsWith(q) ? 1 : 0))
      .slice(0, 8)
      .map(a => ({ ...a, group: '' }));
  }

  function code_matches(a, q) {
    return a.code.toLowerCase().includes(q)
        || String(a.city).toLowerCase().includes(q)
        || String(a.country).toLowerCase().includes(q);
  }

  function airportLabel(code) {
    const a = TravelData.airports[code];
    return a ? `${a.city} (${code})` : '';
  }

  /** Wire one airport field. `onPick` fires with the chosen code. */
  function mountAirport(inputId, onPick) {
    const input = $(inputId);
    const list = $(inputId + 'List');
    if (!input || !list) return;
    let active = -1;
    let rows = [];

    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    };

    const paint = () => {
      rows = matchAirports(input.value);
      if (!rows.length) {
        list.innerHTML = '<div class="tx-ap-empty">No airports match that.</div>';
      } else {
        let lastGroup = null;
        list.innerHTML = rows.map((a, i) => {
          const head = a.group && a.group !== lastGroup
            ? `<div class="tx-ap-group">${esc(a.group)}</div>` : '';
          lastGroup = a.group || lastGroup;
          return `${head}<div class="tx-ap-opt${i === active ? ' is-active' : ''}" role="option"
                 id="${esc(inputId)}Opt${i}" data-code="${esc(a.code)}" aria-selected="${i === active}">
              <b>${esc(a.city)}</b><span>${esc(a.code)} · ${esc(a.country)}</span>
            </div>`;
        }).join('');
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    const choose = i => {
      const a = rows[i];
      if (!a) return;
      input.value = airportLabel(a.code);
      input.dataset.code = a.code;
      rememberAirport(a.code);
      close();
      clearError(inputId);
      if (onPick) onPick(a.code);
    };

    input.addEventListener('focus', paint);
    input.addEventListener('input', () => {
      /* Typing invalidates the previous pick — otherwise a half-edited box
         still carries the code it used to hold. */
      input.dataset.code = '';
      active = -1;
      paint();
    });

    input.addEventListener('keydown', e => {
      if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { paint(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); paint(); scrollActive(list); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); scrollActive(list); }
      else if (e.key === 'Enter') {
        if (!list.hidden && active > -1) { e.preventDefault(); choose(active); }
      } else if (e.key === 'Escape') { close(); }
      else if (e.key === 'Tab') { close(); }
      input.setAttribute('aria-activedescendant', active > -1 ? `${inputId}Opt${active}` : '');
    });

    list.addEventListener('mousedown', e => {
      /* mousedown, not click: blur would close the list first. */
      const opt = e.target.closest('[data-code]');
      if (!opt) return;
      e.preventDefault();
      choose(rows.findIndex(r => r.code === opt.dataset.code));
    });

    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  function scrollActive(list) {
    const el = list.querySelector('.tx-ap-opt.is-active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------------------------------------------------------------
     Calendar

     A rendered month rather than <input type=date>, because the spec asks for
     things the native control cannot show: weekends marked, and a slot for a
     fare under each day. The native input stays underneath as the value store,
     so the form still works if this script fails to run.
     --------------------------------------------------------------------- */
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const DOW = ['Mo','Tu','We','Th','Fr','Sa','Su'];

  /** Hook for real fares. Returns null today; when a fare API lands, this is
   *  the only thing that changes to light the calendar up. */
  function fareFor(/* dateIso */) { return null; }

  function monthGrid(year, month, opts) {
    const first = new Date(year, month, 1);
    /* Monday-first, which is how Indian calendars print. */
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const min = opts.min || today();
    const cells = [];

    for (let i = 0; i < lead; i++) cells.push('<div class="tx-cal-cell is-empty"></div>');
    for (let d = 1; d <= days; d++) {
      const date = new Date(year, month, d);
      const key = iso(date);
      const dow = date.getDay();
      const weekend = dow === 0 || dow === 6;
      const disabled = key < min;
      const selected = key === opts.value;
      const fare = fareFor(key);
      cells.push(`
        <button type="button" class="tx-cal-cell${weekend ? ' is-weekend' : ''}${
          selected ? ' is-selected' : ''}" data-date="${key}" ${disabled ? 'disabled' : ''}
          aria-pressed="${selected}" aria-label="${esc(`${d} ${MONTHS[month]} ${year}`)}">
          <span class="tx-cal-day">${d}</span>
          ${fare ? `<span class="tx-cal-fare">${esc(fare)}</span>` : ''}
        </button>`);
    }
    return cells.join('');
  }

  /** Wire one calendar field. `onPick` fires with the chosen ISO date. */
  function mountCalendar(fieldId, onPick) {
    const input = $(fieldId);            // hidden native input, the value store
    const button = $(fieldId + 'Btn');   // what the traveller clicks
    const pop = $(fieldId + 'Cal');
    if (!input || !button || !pop) return;

    let view = new Date(input.value || today());
    view = new Date(view.getFullYear(), view.getMonth(), 1);

    const label = () => {
      button.textContent = input.value
        ? new Date(input.value).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
        : 'Select a date';
      button.classList.toggle('is-empty', !input.value);
    };

    const paint = () => {
      pop.innerHTML = `
        <div class="tx-cal-head">
          <button type="button" class="tx-cal-nav" data-nav="-1" aria-label="Previous month">&#8249;</button>
          <b>${esc(MONTHS[view.getMonth()])} ${view.getFullYear()}</b>
          <button type="button" class="tx-cal-nav" data-nav="1" aria-label="Next month">&#8250;</button>
        </div>
        <div class="tx-cal-dow">${DOW.map(d => `<span>${d}</span>`).join('')}</div>
        <div class="tx-cal-grid" role="grid">${
          monthGrid(view.getFullYear(), view.getMonth(), { min: input.min || today(), value: input.value })}</div>`;
    };

    const open = () => { paint(); pop.hidden = false; button.setAttribute('aria-expanded', 'true'); };
    const close = () => { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); };

    button.addEventListener('click', () => (pop.hidden ? open() : close()));

    pop.addEventListener('click', e => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.nav), 1);
        paint();
        return;
      }
      const cell = e.target.closest('[data-date]');
      if (!cell || cell.disabled) return;
      input.value = cell.dataset.date;
      label();
      close();
      clearError(fieldId);
      if (onPick) onPick(input.value);
    });

    document.addEventListener('click', e => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== button) close();
    });
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); button.focus(); } });

    label();
    return { open, close, refresh: () => { label(); if (!pop.hidden) paint(); } };
  }

  /* ---------------------------------------------------------------------
     Traveller popup
     --------------------------------------------------------------------- */
  const CHILD_AGES = Array.from({ length: 10 }, (_, i) => i + 2);   // 2..11
  const DEFAULT_CHILD_AGE = 8;

  function paxSummary() {
    const p = state.pax;
    const total = p.adults + p.children + p.infants;
    const cabin = (BookingData.CABIN_CLASSES.find(c => c.id === state.cabin) || {}).label || 'Economy';
    return `${total} traveller${total === 1 ? '' : 's'} · ${cabin}`;
  }

  function stepperRow(key, label, note, min, max) {
    const v = state.pax[key];
    return `
      <div class="tx-pax-row">
        <div><b>${esc(label)}</b><span>${esc(note)}</span></div>
        <div class="tx-pax-step">
          <button type="button" class="tx-pax-btn" data-pax="${key}" data-delta="-1"
                  ${v <= min ? 'disabled' : ''} aria-label="One fewer ${esc(label)}">&minus;</button>
          <output data-pax-out="${key}">${v}</output>
          <button type="button" class="tx-pax-btn" data-pax="${key}" data-delta="1"
                  ${v >= max ? 'disabled' : ''} aria-label="One more ${esc(label)}">+</button>
        </div>
      </div>`;
  }

  function paintPax() {
    const pop = $('txPaxPop');
    if (!pop) return;
    pop.innerHTML = `
      ${stepperRow('adults', 'Adults', '12 years and over', 1, 9)}
      ${stepperRow('children', 'Children', '2 to 11 years', 0, 8)}
      ${stepperRow('infants', 'Infants', 'Under 2, on a lap', 0, 8)}
      ${state.pax.children ? `<div class="tx-pax-ages">
        <b>Child ages</b>
        <div class="tx-pax-agegrid">${Array.from({ length: state.pax.children }, (_, i) => `
          <label><span>Child ${i + 1}</span>
            <select data-childage="${i}">${CHILD_AGES.map(a =>
              `<option value="${a}"${(state.childAges[i] || DEFAULT_CHILD_AGE) === a ? ' selected' : ''}>${a}</option>`).join('')}</select>
          </label>`).join('')}</div>
      </div>` : ''}
      <div class="tx-pax-cabin">
        <b>Cabin class</b>
        <div class="tx-chips">${BookingData.CABIN_CLASSES.map(c => `
          <button type="button" class="tx-chip${c.id === state.cabin ? ' is-on' : ''}" data-cabin="${esc(c.id)}">${esc(c.label)}</button>`).join('')}</div>
      </div>
      ${state.pax.infants > state.pax.adults
        ? `<p class="tx-pax-note is-error" id="txPaxNote" role="status">Each infant must travel with an adult.</p>`
        : `<p class="tx-pax-note" id="txPaxNote" role="status"></p>`}
      <button type="button" class="tx-btn tx-btn-primary tx-pax-done" id="txPaxDone">Done</button>`;
    const trigger = $('txPaxBtn');
    if (trigger) trigger.textContent = paxSummary();
  }

  function mountPax() {
    const btn = $('txPaxBtn');
    const pop = $('txPaxPop');
    if (!btn || !pop) return;

    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
      if (!pop.hidden) paintPax();
    });

    pop.addEventListener('click', e => {
      const step = e.target.closest('[data-pax]');
      if (step) {
        const key = step.dataset.pax;
        const delta = Number(step.dataset.delta);
        const limits = { adults: [1, 9], children: [0, 8], infants: [0, 8] }[key];
        const next = Math.min(limits[1], Math.max(limits[0], state.pax[key] + delta));
        state.pax[key] = next;
        if (key === 'children') state.childAges = state.childAges.slice(0, next);
        /* An infant travels on an adult's lap, so there cannot be more infants
           than adults. paintPax() renders that warning from `state`, which is
           why it is NOT written here first — this used to set the message and
           then immediately repaint over it. */
        paintPax();
        return;
      }
      const cabin = e.target.closest('[data-cabin]');
      if (cabin) { state.cabin = cabin.dataset.cabin; paintPax(); return; }
      if (e.target.id === 'txPaxDone') close();
    });

    pop.addEventListener('change', e => {
      const age = e.target.closest('[data-childage]');
      if (age) state.childAges[Number(age.dataset.childage)] = Number(age.value);
    });

    document.addEventListener('click', e => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) close();
    });
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); btn.focus(); } });
  }

  /* ---------------------------------------------------------------------
     Inline validation. No toasts, no alerts — the message goes under the
     field it is about.
     --------------------------------------------------------------------- */
  function setError(fieldId, message) {
    const box = $(fieldId + 'Err');
    const ctrl = $(fieldId + 'Btn') || $(fieldId);
    if (box) box.textContent = message || '';
    if (ctrl) {
      ctrl.classList.toggle('is-invalid', !!message);
      ctrl.setAttribute('aria-invalid', message ? 'true' : 'false');
      if (message) ctrl.focus();
    }
    return !message;
  }
  const clearError = id => setError(id, '');
  function clearAllErrors() {
    document.querySelectorAll('#txSearchPanel .tx-err').forEach(e => { e.textContent = ''; });
    document.querySelectorAll('#txSearchPanel .is-invalid').forEach(e => {
      e.classList.remove('is-invalid'); e.setAttribute('aria-invalid', 'false');
    });
  }

  /* ---------------------------------------------------------------------
     Markup
     --------------------------------------------------------------------- */
  function airportField(id, label, value) {
    return `
      <div class="tx-sf tx-ap">
        <label for="${id}">${esc(label)}</label>
        <input id="${id}" type="text" class="tx-ap-input" autocomplete="off" role="combobox"
               aria-autocomplete="list" aria-expanded="false" aria-controls="${id}List"
               placeholder="City or airport" value="${esc(value ? airportLabel(value) : '')}"
               data-code="${esc(value || '')}">
        <div class="tx-ap-list" id="${id}List" role="listbox" aria-label="${esc(label)} suggestions" hidden></div>
        <p class="tx-err" id="${id}Err" role="alert"></p>
      </div>`;
  }

  function dateField(id, label, value, min) {
    return `
      <div class="tx-sf tx-cal">
        <label for="${id}Btn">${esc(label)}</label>
        <input type="hidden" id="${id}" value="${esc(value || '')}" min="${esc(min || today())}">
        <button type="button" class="tx-cal-btn" id="${id}Btn" aria-haspopup="dialog" aria-expanded="false"></button>
        <div class="tx-cal-pop" id="${id}Cal" role="dialog" aria-label="${esc(label)}" hidden></div>
        <p class="tx-err" id="${id}Err" role="alert"></p>
      </div>`;
  }

  function segmentRow(i, seg, removable) {
    return `
      <div class="tx-seg" data-seg="${i}">
        <div class="tx-seg-grid">
          ${airportField(`txSegFrom${i}`, `Flight ${i + 1} — From`, seg.from)}
          ${airportField(`txSegTo${i}`, 'To', seg.to)}
          ${dateField(`txSegDate${i}`, 'Departure', seg.date, today())}
        </div>
        ${removable ? `<button type="button" class="tx-seg-remove" data-remove-seg="${i}">Remove</button>` : ''}
      </div>`;
  }

  function render(panel) {
    const trip = state.trip || 'oneway';
    const isRound = trip === 'round';
    const isMulti = trip === 'multi';

    const tripTabs = [
      ['oneway', 'One way'], ['round', 'Round trip'], ['multi', 'Multi-city'],
    ].map(([id, label]) => `
      <label class="tx-radio"><input type="radio" name="txTrip" value="${id}"${
        trip === id ? ' checked' : ''}> <span>${esc(label)}</span></label>`).join('');

    const simple = `
      <div class="tx-searchgrid">
        ${airportField('txFrom', 'From', state.from || 'HYD')}
        <button type="button" class="tx-swap" id="txSwap" aria-label="Swap origin and destination">
          <span data-jp-icon="swap" data-jp-size="sm"></span></button>
        ${airportField('txTo', 'To', state.to)}
        ${dateField('txDepart', 'Departure', state.depart || today(), today())}
        <div id="txReturnWrap"${isRound ? '' : ' hidden'}>
          ${dateField('txReturn', 'Return', state.ret, state.depart || today())}
        </div>
        <div class="tx-sf tx-pax">
          <label for="txPaxBtn">Travellers &amp; cabin</label>
          <button type="button" class="tx-pax-trigger" id="txPaxBtn" aria-haspopup="dialog" aria-expanded="false"></button>
          <div class="tx-pax-pop" id="txPaxPop" role="dialog" aria-label="Travellers and cabin" hidden></div>
        </div>
        <button type="button" class="tx-btn tx-btn-primary tx-searchgo" id="txSearchGo">Search flights</button>
      </div>`;

    const multi = `
      <div class="tx-segments" id="txSegments">
        ${state.segments.map((s, i) => segmentRow(i, s, state.segments.length > 2)).join('')}
      </div>
      <div class="tx-seg-actions">
        <button type="button" class="tx-btn tx-btn-ghost" id="txAddSeg"
          ${state.segments.length >= 5 ? 'disabled' : ''}>+ Add another flight</button>
        <div class="tx-sf tx-pax">
          <label for="txPaxBtn">Travellers &amp; cabin</label>
          <button type="button" class="tx-pax-trigger" id="txPaxBtn" aria-haspopup="dialog" aria-expanded="false"></button>
          <div class="tx-pax-pop" id="txPaxPop" role="dialog" aria-label="Travellers and cabin" hidden></div>
        </div>
        <button type="button" class="tx-btn tx-btn-primary tx-searchgo" id="txSearchGo">Search flights</button>
      </div>`;

    panel.innerHTML = `<div class="tx-trip">${tripTabs}</div>${isMulti ? multi : simple}`;
  }

  /* ---------------------------------------------------------------------
     Wiring
     --------------------------------------------------------------------- */
  function bind(panel) {
    panel.querySelectorAll('input[name="txTrip"]').forEach(r => {
      r.addEventListener('change', () => {
        const was = state.trip;
        state.trip = r.value;
        if (r.value !== 'round') state.ret = '';

        if (r.value === 'multi' && was !== 'multi') {
          /* Carry the route the traveller just typed into the first leg.
             Reading the LIVE fields, not `state`: the simple form writes state
             only when a picker fires, so a route sitting in the boxes would
             otherwise be thrown away by switching tabs. Seeded only when the
             first leg is still blank, so returning to multi-city does not
             overwrite legs already filled in. */
          const from = readCode('txFrom') || state.from || 'HYD';
          const to = readCode('txTo') || state.to || '';
          const date = $('txDepart')?.value || state.depart || today();
          if (!state.segments.length || !state.segments[0].to) {
            state.segments = [
              { from, to, date },
              { from: to, to: '', date: '' },
            ];
          }
        } else if (r.value !== 'multi' && was === 'multi') {
          /* And back the other way, so the simple form is not blank after
             planning a trip in the multi-city one. */
          const first = state.segments[0];
          if (first && first.from) {
            state.from = first.from;
            state.to = first.to || state.to;
            state.depart = first.date || state.depart;
          }
        }
        mount();
      });
    });

    if (state.trip === 'multi') {
      state.segments.forEach((_, i) => {
        mountAirport(`txSegFrom${i}`, code => { state.segments[i].from = code; });
        mountAirport(`txSegTo${i}`, code => { state.segments[i].to = code; });
        mountCalendar(`txSegDate${i}`, d => { state.segments[i].date = d; });
      });
      $('txAddSeg')?.addEventListener('click', () => {
        if (state.segments.length >= 5) return;
        const last = state.segments[state.segments.length - 1];
        state.segments.push({ from: last.to || '', to: '', date: '' });
        mount();
      });
      panel.querySelectorAll('[data-remove-seg]').forEach(b => b.addEventListener('click', () => {
        state.segments.splice(Number(b.dataset.removeSeg), 1);
        mount();
      }));
    } else {
      mountAirport('txFrom', code => { state.from = code; });
      mountAirport('txTo', code => { state.to = code; });

      const retCal = mountCalendar('txReturn', d => { state.ret = d; });
      mountCalendar('txDepart', d => {
        state.depart = d;
        /* A return can never precede departure, so move the floor with it and
           drop a now-impossible return rather than leaving it to fail later. */
        const ret = $('txReturn');
        if (ret) {
          ret.min = d;
          if (ret.value && ret.value < d) { ret.value = ''; state.ret = ''; }
          retCal?.refresh();
        }
        /* Round trip: the next thing they need is the return date, so open it. */
        if (state.trip === 'round') setTimeout(() => $('txReturnBtn')?.click(), 120);
      });

      $('txSwap')?.addEventListener('click', () => {
        const from = $('txFrom');
        const to = $('txTo');
        [from.value, to.value] = [to.value, from.value];
        [from.dataset.code, to.dataset.code] = [to.dataset.code, from.dataset.code];
        [state.from, state.to] = [state.to, state.from];
        clearError('txFrom'); clearError('txTo');
      });
    }

    mountPax();
    paintPax();
    $('txSearchGo')?.addEventListener('click', submit);
  }

  /* ---------------------------------------------------------------------
     Validate, then hand over
     --------------------------------------------------------------------- */
  function readCode(id) {
    const el = $(id);
    if (!el) return '';
    /* dataset.code is only set by picking from the list. A typed string that
       exactly names one airport is accepted too; anything else is not a
       choice, and is reported rather than guessed at. */
    if (el.dataset.code) return el.dataset.code;
    const typed = el.value.trim().toLowerCase();
    if (!typed) return '';
    const hit = Object.entries(TravelData.airports)
      .find(([c, a]) => `${a.city} (${c})`.toLowerCase() === typed || c.toLowerCase() === typed);
    return hit ? hit[0] : '';
  }

  /** Blank field and unrecognised text are different mistakes and deserve
   *  different messages — "choose an airport" reads as though nothing was
   *  typed, which is confusing when something was. */
  function airportError(id, blankMessage) {
    const typed = ($(id)?.value || '').trim();
    return setError(id, typed
      ? 'We could not find that airport — pick one from the list.'
      : blankMessage);
  }

  function validate() {
    clearAllErrors();

    if (state.pax.adults < 1) return setError('txPax', 'At least one adult must travel.');
    if (state.pax.infants > state.pax.adults) {
      $('txPaxBtn')?.click();
      return setError('txPax', 'Each infant must travel with an adult.');
    }

    if (state.trip === 'multi') {
      for (let i = 0; i < state.segments.length; i++) {
        const from = readCode(`txSegFrom${i}`);
        const to = readCode(`txSegTo${i}`);
        const date = $(`txSegDate${i}`)?.value;
        if (!from) return airportError(`txSegFrom${i}`, 'Choose where this flight departs from.');
        if (!to) return airportError(`txSegTo${i}`, 'Choose where this flight arrives.');
        if (from === to) return setError(`txSegTo${i}`, 'Origin and destination cannot be the same.');
        if (!date) return setError(`txSegDate${i}`, 'Choose a departure date.');
        if (i > 0) {
          const prev = $(`txSegDate${i - 1}`)?.value;
          if (prev && date < prev) return setError(`txSegDate${i}`, 'Each flight must depart after the one before it.');
        }
        state.segments[i] = { from, to, date };
      }
      return true;
    }

    const from = readCode('txFrom');
    const to = readCode('txTo');
    if (!from) return airportError('txFrom', 'Choose where you are flying from.');
    if (!to) return airportError('txTo', 'Choose where you are flying to.');
    if (from === to) return setError('txTo', 'Origin and destination cannot be the same.');
    const depart = $('txDepart').value;
    if (!depart) return setError('txDepart', 'Choose a departure date.');
    if (state.trip === 'round') {
      const ret = $('txReturn').value;
      if (!ret) return setError('txReturn', 'Choose a return date, or switch to one way.');
      if (ret < depart) return setError('txReturn', 'The return date cannot be before departure.');
      state.ret = ret;
    } else {
      state.ret = '';
    }
    state.from = from;
    state.to = to;
    state.depart = depart;
    return true;
  }

  /** The shape a search request carries, whatever runs it. */
  function request() {
    return {
      tripType: state.trip,
      fromAirport: state.from,
      toAirport: state.to,
      departureDate: state.depart,
      returnDate: state.ret || null,
      segments: state.trip === 'multi' ? state.segments.slice() : null,
      travellers: state.pax.adults + state.pax.children + state.pax.infants,
      adults: state.pax.adults,
      children: state.pax.children,
      /* One age per child, always. A child count can arrive from the URL with
         no ages behind it, and the popup only writes them once it is opened,
         so the gap is filled with the same default the selector shows rather
         than handing a caller a shorter array than the count it sits beside. */
      childAges: Array.from({ length: state.pax.children },
                            (_, i) => state.childAges[i] || DEFAULT_CHILD_AGE),
      infants: state.pax.infants,
      cabinClass: state.cabin,
      /* No fare-type control exists yet; the field is here because the request
         contract names it, and a caller reading it gets a real default rather
         than undefined. */
      fareType: state.fareType || 'regular',
    };
  }

  async function submit() {
    /* Two clicks must not run two searches. The guard is on the module, not
       the button, so a second click during an await is dropped even if the
       button is re-rendered underneath it. */
    if (searching) return;
    if (!validate()) return;

    const btn = $('txSearchGo');
    searching = true;
    if (btn) {
      btn.disabled = true;
      btn.dataset.label = btn.textContent;
      btn.innerHTML = '<span class="tx-spin" aria-hidden="true"></span> Searching…';
    }
    try {
      if (onSearch) await onSearch(request());
    } finally {
      searching = false;
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Search flights'; }
    }
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  function mount() {
    const panel = $('txSearchPanel');
    if (!panel) return;
    render(panel);
    bind(panel);
    if (typeof JPIcon !== 'undefined') JPIcon.mount(panel);
  }

  /** @param sharedState travel-explore's `state`, written in place.
   *  @param handler     called with request() once the form is valid. */
  function init(sharedState, handler) {
    state = sharedState;
    onSearch = handler;
    if (!Array.isArray(state.childAges)) state.childAges = [];
    if (!Array.isArray(state.segments) || state.segments.length < 2) {
      state.segments = [
        { from: state.from || 'HYD', to: state.to || '', date: state.depart || today() },
        { from: state.to || '', to: '', date: '' },
      ];
    }
    mount();
  }

  return { init, mount, request, validate, matchAirports, recentCodes };
})();
