'use strict';
/* ===========================================================================
   Quick-sort chips on the FLIGHT results page (Feature #2).

   The flights page now shows the sort options as one-tap chips above the list,
   mirroring the hotels page's sort chips. The chips hold NO state of their own:
   renderSortChips() draws them from the SAME FlightFilters.availableSorts() the
   #txSort <select> uses, and a chip click drives that select's `change` — so the
   one existing sort path runs and no sort algorithm is duplicated. This is the
   function and the wiring that do it, in assets/js/travel-explore.js.

   There is no DOM test runner in this project (see hotel-image-map.provider.test.js),
   so this is a self-contained Node harness, like offers-strip.test.js. It does:

     1. BEHAVIOURAL — extracts renderSortChips() by brace-matching, runs it in a
        VM with a FlightFilters/state shim, and asserts: a chip per available
        sort; aria-pressed="true" on exactly the active sort; labels escaped;
        and that changing state.sort and re-rendering MOVES the pressed state
        (the chip↔select synchronisation contract).
     2. STRUCTURAL — the #txSortChips host (role=group) is on the page; a chip
        click sets #txSort and dispatches `change`; renderSortOptions() and the
        sort-change handler both call renderSortChips(); chips are real
        <button>s with aria-pressed.
     3. REGRESSION — renderSortChips() is render-only (no sort math, no booking/
        pricing/checkout), and the shared sort engine (availableSorts/sortRows)
        is still what does the sorting.

   run:  node frontend/tests/flight-sort-chips.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const EXPLORE = read('assets/js/travel-explore.js');
const FLIGHTS_HTML = read('flights.html');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Pull one `function <name>(...) { ... }` out of a source by brace-matching. */
function extractFn(src, sig, label) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${label}: ${sig} not found`); return null; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${label}: ${sig} braces did not balance`);
  return null;
}

const escShim = "const esc = s => String(s == null ? '' : s)"
  + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')"
  + ".replace(/\"/g,'&quot;').replace(/'/g,'&#39;');";

const OPTS = [
  { id: 'best', label: 'Best' },
  { id: 'cheapest', label: 'Cheapest' },
  { id: 'fastest', label: 'Fastest' },
  { id: 'dep-asc', label: 'Earliest departure' },
  { id: 'airline', label: 'A & B <x>' },   // forces the escaper to run
];

const fnSrc = extractFn(EXPLORE, 'function renderSortChips(', 'travel-explore.js');

/* Build one VM context holding a mutable `state`, render into `box`, and expose
   a render() so a test can re-render after changing state.sort. */
function makeChipRunner(activeSort) {
  const box = { innerHTML: '' };
  const state = { sort: activeSort };
  const sandbox = {
    box, state,
    FlightFilters: { availableSorts: () => OPTS },
    document: { getElementById: id => (id === 'txSortChips' ? box : null) },
    String, Array, console,
  };
  const script = `
    ${escShim}
    const $ = id => document.getElementById(id);
    ${fnSrc}
    globalThis.__render = () => renderSortChips();
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { render: () => { sandbox.__render(); return box.innerHTML; }, state };
}

/* Count aria-pressed="true" chips, and return the id of the pressed one. */
function pressedId(html) {
  const m = [...html.matchAll(/data-tx-sort="([^"]+)"[^>]*aria-pressed="(true|false)"/g)];
  const on = m.filter(x => x[2] === 'true');
  return { count: on.length, id: on[0] && on[0][1], total: m.length };
}

/* ---------------------------------------------------------------- *
 * 1. BEHAVIOURAL
 * ---------------------------------------------------------------- */
if (fnSrc) {
  const r = makeChipRunner('cheapest');
  const html = r.render();

  OPTS.forEach(o => check(html.includes(`data-tx-sort="${o.id}"`),
    `a chip must be rendered for the available sort "${o.id}"`));
  check((html.match(/class="ds-chip tx-sortchip"/g) || []).length === OPTS.length,
    'every chip must be a shared ds-chip tx-sortchip button');
  check((html.match(/<button type="button"/g) || []).length === OPTS.length,
    'every chip must be a real <button> (natively keyboard-focusable)');

  const p = pressedId(html);
  check(p.total === OPTS.length, 'every chip must carry an aria-pressed state');
  check(p.count === 1 && p.id === 'cheapest',
    `exactly the active sort must be aria-pressed="true" (got count=${p.count}, id=${p.id})`);

  // Escaping: the "A & B <x>" label must not reach the DOM as raw markup.
  check(html.includes('A &amp; B &lt;x&gt;') && !html.includes('<x>'),
    'chip labels must be HTML-escaped');

  // SYNC CONTRACT: changing the selected sort moves the pressed chip.
  r.state.sort = 'fastest';
  const html2 = r.render();
  const p2 = pressedId(html2);
  check(p2.count === 1 && p2.id === 'fastest',
    're-rendering after the sort changes must move aria-pressed to the new sort');

  /* DROPDOWN → CHIP: a direct change of the #txSort <select> must repaint the
     chips. The production change handler does exactly `state.sort = sort.value`
     then `renderSortChips()` (asserted structurally below). Here we drive that
     same sequence from a NEW select value and prove the pressed state moves off
     the previously active chip and onto the newly selected one. */
  const d = makeChipRunner('best');
  check(pressedId(d.render()).id === 'best',
    'dropdown-sync precondition: "best" starts aria-pressed="true"');
  const select = { value: 'dep-asc' };   // the user picks a different sort in the dropdown
  d.state.sort = select.value;           // what the change handler assigns from sort.value...
  const htmlAfter = d.render();          // ...before it repaints the chips
  const after = pressedId(htmlAfter);
  check(after.count === 1 && after.id === 'dep-asc',
    'after a dropdown change, the newly selected sort must be the only aria-pressed="true" chip');
  check(/data-tx-sort="dep-asc"[^>]*aria-pressed="true"/.test(htmlAfter),
    'the newly selected chip ("dep-asc") must become aria-pressed="true"');
  check(/data-tx-sort="best"[^>]*aria-pressed="false"/.test(htmlAfter),
    'the previously active chip ("best") must become aria-pressed="false"');
}

/* ---------------------------------------------------------------- *
 * 2. STRUCTURAL — host + wiring
 * ---------------------------------------------------------------- */
check(/id="txSortChips"/.test(FLIGHTS_HTML), 'flights.html must carry the #txSortChips host');
check(/id="txSortChips"[^>]*role="group"/.test(FLIGHTS_HTML) || /role="group"[^>]*aria-label="Sort flights"/.test(FLIGHTS_HTML),
  'the chip group must be role=group with an accessible label');

// renderSortOptions keeps the chips in step with the select (one call site).
check(/renderSortChips\(opts\)/.test(EXPLORE),
  'renderSortOptions() must call renderSortChips(opts) so chips match the select');

// A chip click drives the select and fires its change (no parallel sort state).
const clickWiring = /\[data-tx-sort\]/.test(EXPLORE)
  && /sel\.value = chip\.dataset\.txSort/.test(EXPLORE)
  && /dispatchEvent\(new Event\('change'/.test(EXPLORE);
check(clickWiring, 'a chip click must set #txSort.value and dispatch its change event');

// DROPDOWN → CHIP wiring: the change handler must take the select's value into
// state.sort and THEN repaint the chips, so a direct dropdown change re-presses.
check(/state\.sort = sort\.value;[\s\S]*?renderSortChips\(\);/.test(EXPLORE),
  'a dropdown change must set state.sort from the select value, then repaint the chips');

// The sort-change handler repaints the chips (keeps aria-pressed in step).
// renderSortOptions() calls renderSortChips(opts); the no-arg call is the
// resync in the change handler, so its presence proves the handler repaints.
check(/renderSortChips\(\);/.test(EXPLORE),
  'the sort-change handler must call renderSortChips() to resync the pressed state');

/* ---------------------------------------------------------------- *
 * 3. REGRESSION — render-only, shared engine still sorts
 * ---------------------------------------------------------------- */
if (fnSrc) {
  check(!/priceOf|durationOf|\.sort\(|sortRows|booking|checkout|payment|quote/i.test(fnSrc),
    'renderSortChips must be render-only — it must not sort or touch booking/checkout');
}
check(/FlightFilters\.sortRows\(/.test(EXPLORE),
  'sorting must still go through the shared FlightFilters.sortRows (not duplicated)');
check(/FlightFilters\.availableSorts\(\)/.test(EXPLORE),
  'the available sorts must still come from the shared FlightFilters.availableSorts()');

/* ---------------------------------------------------------------- */
if (failures.length) {
  console.error('FAIL — flight-sort-chips.test.js');
  failures.forEach(f => console.error('  • ' + f));
  process.exit(1);
}
console.log('PASS — flight-sort-chips.test.js (behavioural + structural + regression)');
