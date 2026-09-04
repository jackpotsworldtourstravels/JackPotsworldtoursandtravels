'use strict';
/* ===========================================================================
   package-search.js — the Tour Packages search panel.
   ===========================================================================
   Third panel on the same SearchWidgets: a destination autocomplete, a
   traveller stepper, and plain selects for the bands. No new listbox, no new
   month grid.

   EVERY ONE OF THE FIVE CRITERIA IS BACKED BY REAL DATA. That was not obvious
   at the start — a package row carries only id, name, days, priceFrom and
   blurb, so budget and duration were clearly filterable and "departure month"
   looked like it needed a field the data does not have.

   It does not. BookingData.departures() already generates the dates a package
   actually sells (the next six Saturdays, which is how group departures are
   sold), and the package booking flow has always used them. So the months
   offered here are READ from those departures rather than invented, which
   means asking for a month we do not sell correctly finds nothing instead of
   quietly pretending.

     Destination      -> name
     Duration         -> days
     Budget           -> priceFrom
     Departure month  -> BookingData.departures()
     Travellers       -> carried into the booking's own Travellers field

   Nothing here searches. It validates, writes `state`, and calls onSearch().
   =========================================================================== */

const PackageSearch = (function () {

  const W = SearchWidgets;
  const $ = id => document.getElementById(id);
  const esc = W.esc;

  const RECENT_KEY = 'jpc_recent_packages';
  const RECENT_MAX = 5;

  const BUDGETS = [
    { id: 'any',   label: 'Any budget',        min: 0,     max: Infinity },
    { id: '0-30',  label: 'Under ₹30,000',     min: 0,     max: 30000 },
    { id: '30-50', label: '₹30,000 – 50,000',  min: 30000, max: 50000 },
    { id: '50-70', label: '₹50,000 – 70,000',  min: 50000, max: 70000 },
    { id: '70+',   label: '₹70,000+',          min: 70000, max: Infinity },
  ];

  const DURATIONS = [
    { id: 'any', label: 'Any length', min: 0, max: Infinity },
    { id: '1-4', label: 'Up to 4 days', min: 0, max: 4 },
    { id: '5-7', label: '5 to 7 days', min: 5, max: 7 },
    { id: '8+',  label: '8 days or more', min: 8, max: Infinity },
  ];

  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];

  let state = null;
  let onSearch = null;
  let packages = [];
  /** packageId -> [ISO date], from BookingData.departures(). */
  let departures = new Map();
  let searching = false;

  /* ---------------------------------------------------------------------
     Departure months, read from what actually departs
     --------------------------------------------------------------------- */
  async function loadDepartures(rows) {
    departures = new Map();
    await Promise.all(rows.map(async p => {
      try {
        const list = await BookingData.departures(p);
        departures.set(p.id, list.map(d => d.date));
      } catch { departures.set(p.id, []); }
    }));
  }

  /** "2026-09" keys for every month anything departs in, in order. */
  function availableMonths() {
    const keys = new Set();
    departures.forEach(dates => dates.forEach(d => keys.add(d.slice(0, 7))));
    return [...keys].sort();
  }

  function monthLabel(key) {
    const [y, m] = key.split('-');
    return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
  }

  function departsIn(pkgId, monthKey) {
    if (!monthKey || monthKey === 'any') return true;
    return (departures.get(pkgId) || []).some(d => d.startsWith(monthKey));
  }

  /* ---------------------------------------------------------------------
     Destination
     --------------------------------------------------------------------- */
  function recent() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw) ? raw.slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }

  function remember(dest) {
    if (!dest) return;
    try {
      localStorage.setItem(RECENT_KEY,
        JSON.stringify([dest, ...recent().filter(d => d !== dest)].slice(0, RECENT_MAX)));
    } catch { /* private mode */ }
  }

  function destinationSource(query) {
    const rows = packages.map(p => ({
      key: p.name,
      label: p.name,
      sub: `${p.days} days · from ${money(p.priceFrom)}`,
    }));
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      const recents = recent()
        .filter(r => rows.some(x => x.key === r))
        .map(r => ({ ...rows.find(x => x.key === r), group: 'Recent searches' }));
      const rest = rows
        .filter(r => !recents.some(x => x.key === r.key))
        .map(r => ({ ...r, group: 'All destinations' }));
      return [...recents, ...rest];
    }
    /* The blurb is searched too, so "beach" or "safari" finds something —
       it is the only place the data says what a trip contains. */
    return rows
      .filter((r, i) => r.label.toLowerCase().includes(q)
                     || String(packages[i].blurb).toLowerCase().includes(q))
      .slice(0, 8)
      .map(r => ({ ...r, group: '' }));
  }

  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  /* ---------------------------------------------------------------------
     Filtering — the one definition of what a package search means
     --------------------------------------------------------------------- */
  function matches(p, criteria) {
    const c = criteria || state;
    if (c.pkgDest && String(p.name).toLowerCase() !== String(c.pkgDest).toLowerCase()) return false;
    const b = BUDGETS.find(x => x.id === (c.pkgBudget || 'any'));
    if (b && b.id !== 'any' && !(p.priceFrom >= b.min && p.priceFrom < b.max)) return false;
    const d = DURATIONS.find(x => x.id === (c.pkgDuration || 'any'));
    if (d && d.id !== 'any' && !(p.days >= d.min && p.days <= d.max)) return false;
    if (!departsIn(p.id, c.pkgMonth)) return false;
    return true;
  }

  /* ---------------------------------------------------------------------
     Travellers
     --------------------------------------------------------------------- */
  function paxSummary() {
    const n = state.pkgTravellers || 2;
    return `${n} traveller${n === 1 ? '' : 's'}`;
  }

  function paintPax() {
    const pop = $('txPkgPaxPop');
    if (!pop) return;
    pop.innerHTML = `
      ${W.stepperRow('travellers', 'Travellers', 'Everyone on the trip',
                     state.pkgTravellers || 2, 1, 12)}
      <p class="tx-pax-note">Group departures seat up to 12 on one booking.</p>
      <button type="button" class="tx-btn tx-btn-primary tx-pax-done" id="txPkgPaxDone">Done</button>`;
    const trigger = $('txPkgPaxBtn');
    if (trigger) trigger.textContent = paxSummary();
  }

  function mountPax() {
    const btn = $('txPkgPaxBtn');
    const pop = $('txPkgPaxPop');
    if (!btn || !pop) return;
    const close = W.dismissable('txPkgPaxPop', 'txPkgPaxBtn');
    btn.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
      if (!pop.hidden) paintPax();
    });
    pop.addEventListener('click', e => {
      const step = e.target.closest('[data-step-key]');
      if (step) {
        const next = (state.pkgTravellers || 2) + Number(step.dataset.delta);
        state.pkgTravellers = Math.min(12, Math.max(1, next));
        paintPax();
        return;
      }
      if (e.target.id === 'txPkgPaxDone' && close) close();
    });
  }

  /* ---------------------------------------------------------------------
     Markup
     --------------------------------------------------------------------- */
  function render(panel) {
    const months = availableMonths();
    panel.innerHTML = `
      <div class="tx-searchgrid tx-pkggrid">
        ${W.autocompleteField('txPkgDest', 'Destination', {
          placeholder: 'Anywhere — or name a place',
          value: state.pkgDest || '',
          key: state.pkgDest || '',
        })}
        <div class="tx-sf">
          <label for="txPkgMonth">Departure month</label>
          <select id="txPkgMonth">
            <option value="any">Any month</option>
            ${months.map(m => `<option value="${esc(m)}"${
              m === state.pkgMonth ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}
          </select>
        </div>
        <div class="tx-sf">
          <label for="txPkgBudget">Budget</label>
          <select id="txPkgBudget">${BUDGETS.map(b =>
            `<option value="${esc(b.id)}"${b.id === (state.pkgBudget || 'any') ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}</select>
        </div>
        <div class="tx-sf">
          <label for="txPkgDuration">Duration</label>
          <select id="txPkgDuration">${DURATIONS.map(d =>
            `<option value="${esc(d.id)}"${d.id === (state.pkgDuration || 'any') ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select>
        </div>
        <div class="tx-sf tx-pax">
          <label for="txPkgPaxBtn">Travellers</label>
          <button type="button" class="tx-pax-trigger" id="txPkgPaxBtn" aria-haspopup="dialog" aria-expanded="false"></button>
          <div class="tx-pax-pop" id="txPkgPaxPop" role="dialog" aria-label="Travellers" hidden></div>
          <p class="tx-err" id="txPkgPaxErr" role="alert"></p>
        </div>
        <button type="button" class="tx-btn tx-btn-primary tx-searchgo" id="txPkgGo">Search packages</button>
      </div>`;
  }

  function bind(panel) {
    W.mountAutocomplete('txPkgDest', {
      source: destinationSource,
      emptyText: 'No packages match that.',
      onPick: row => { state.pkgDest = row.key; remember(row.key); },
    });
    /* Destination is the one optional field — "anywhere" is a real answer to
       "where do you fancy", so clearing the box clears the filter rather than
       failing validation. */
    $('txPkgDest')?.addEventListener('input', e => {
      if (!e.target.value.trim()) state.pkgDest = '';
    });
    $('txPkgMonth')?.addEventListener('change', e => { state.pkgMonth = e.target.value; });
    $('txPkgBudget')?.addEventListener('change', e => { state.pkgBudget = e.target.value; });
    $('txPkgDuration')?.addEventListener('change', e => { state.pkgDuration = e.target.value; });
    mountPax();
    paintPax();
    $('txPkgGo')?.addEventListener('click', submit);
  }

  /* ---------------------------------------------------------------------
     Validate
     --------------------------------------------------------------------- */
  function validate() {
    W.clearAllErrors('#txSearchPanel');
    const el = $('txPkgDest');
    const typed = (el?.value || '').trim();
    /* Blank means anywhere. Typed-but-unmatched is a mistake worth naming.
       The destination is read off the FIELD every time rather than trusted to
       have been written by the picker — it is set by onPick, but a re-render
       or a value set any other way would otherwise be silently ignored and
       the search would quietly return everywhere. */
    if (!typed) {
      state.pkgDest = '';
    } else if (el.dataset.key) {
      state.pkgDest = el.dataset.key;
    } else {
      const hit = packages.find(p => p.name.toLowerCase() === typed.toLowerCase());
      if (!hit) {
        return W.setError('txPkgDest', 'We could not find that destination — pick one, or clear it to see everywhere.');
      }
      state.pkgDest = hit.name;
    }
    if ((state.pkgTravellers || 2) < 1) {
      return W.setError('txPkgPax', 'At least one traveller.');
    }
    return true;
  }

  function request() {
    return {
      destination: state.pkgDest || null,
      departureMonth: state.pkgMonth && state.pkgMonth !== 'any' ? state.pkgMonth : null,
      budget: state.pkgBudget || 'any',
      duration: state.pkgDuration || 'any',
      travellers: state.pkgTravellers || 2,
    };
  }

  async function submit() {
    if (searching) return;
    if (!validate()) return;
    const btn = $('txPkgGo');
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
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Search packages'; }
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
  }

  async function init(sharedState, rows, handler) {
    state = sharedState;
    packages = rows || [];
    onSearch = handler;
    if (!state.pkgTravellers) state.pkgTravellers = 2;
    if (!state.pkgBudget) state.pkgBudget = 'any';
    if (!state.pkgDuration) state.pkgDuration = 'any';
    if (!state.pkgMonth) state.pkgMonth = 'any';
    /* Months come from the departures, so they have to be loaded before the
       select can be rendered. */
    await loadDepartures(packages);
    mount();
  }

  /* destinationSource is exported for the results-page search strip, which
     offers the same destination box this panel does — one list, so the two
     cannot suggest different places. */
  return { init, mount, request, validate, matches, availableMonths, monthLabel,
           destinationSource, BUDGETS, DURATIONS };
})();
