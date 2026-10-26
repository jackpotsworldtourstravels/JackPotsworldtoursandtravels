'use strict';
/* Screen-reader announcement of the search OUTCOME (flights + hotels).
 *
 * The result lists in assets/js/travel-explore.js update asynchronously. Before
 * this fix only the loading skeleton was announced ("Searching…", role=status);
 * the OUTCOME never was, because the visible "Showing X of X" count is hidden on
 * flights and neither list is itself a live region. A screen-reader user heard
 * "Searching for flights…" and then silence — no "12 flights found", no "No
 * flights found". announceResults() now writes the outcome into one shared
 * visually-hidden polite live region.
 *
 * There is no DOM test runner in this project (see the note in
 * hotel-image-map.provider.test.js), so this is a self-contained Node harness.
 * It does two things:
 *   1. BEHAVIOURAL — it extracts announceResults() and its state, runs it in a
 *      VM with a tiny document + timer shim, and asserts the live region it
 *      builds carries the right ARIA contract and ends up holding the message.
 *   2. STRUCTURAL — it asserts BOTH render paths call announceResults and that
 *      every outcome message the fix promises is present, so a later edit that
 *      drops one is caught.
 *
 *   run:  node frontend/tests/search-live-region.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'js', 'travel-explore.js'), 'utf8')
  .replace(/\r\n/g, '\n');   // normalise CRLF so the markers below match on Windows

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* ---------------------------------------------------------------- *
 * 1. Behavioural: run the real announceResults() in isolation.
 * ---------------------------------------------------------------- */
const START = 'let liveRegion = null;';
const END = '}, 150);\n  }';
const s = SRC.indexOf(START);
const e = SRC.indexOf(END, s);
if (s === -1 || e === -1) {
  failures.push('could not locate announceResults() to exercise it — did its '
    + 'shape change? (looked for "' + START + '" … "' + END + '")');
} else {
  const snippet = SRC.slice(s, e + END.length);

  // A timer queue we drain by hand, so the debounce runs deterministically.
  const queue = [];
  const el = {
    attrs: {}, className: '', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; },
  };
  const sandbox = {
    document: {
      createElement: () => el,
      body: { appendChild() {} },
    },
    setTimeout: (fn) => { queue.push(fn); return queue.length; },
    clearTimeout: () => {},
  };
  // Expose announceResults onto the sandbox so we can call it.
  vm.runInNewContext(snippet + '\nthis.__announce = announceResults;', sandbox);

  sandbox.__announce('12 flights found');
  // Drain nested timers (clear step schedules the post step).
  for (let i = 0; i < 10 && queue.length; i++) { queue.shift()(); }

  check(el.attrs.role === 'status',
    `live region role is ${JSON.stringify(el.attrs.role)}, expected "status"`);
  check(el.attrs['aria-live'] === 'polite',
    `live region aria-live is ${JSON.stringify(el.attrs['aria-live'])}, expected "polite"`);
  check(el.className === 'sr-only',
    `live region class is ${JSON.stringify(el.className)}, expected "sr-only" (visually hidden)`);
  check(el.textContent === '12 flights found',
    `live region text is ${JSON.stringify(el.textContent)}, expected the announced message`);
}

/* ---------------------------------------------------------------- *
 * 2. Structural: both surfaces announce, and every message exists.
 * ---------------------------------------------------------------- */
const calls = (SRC.match(/announceResults\(/g) || []).length;
check(calls >= 3,
  `announceResults is referenced ${calls} time(s); expected >= 3 `
  + `(definition + the flights render + the hotels render)`);

for (const fragment of [
  'No flights found for this route',       // flights: empty one-way route
  'No flights match those filters',        // flights: filtered to empty
  'No round-trip combinations available',  // flights: empty round-trip pairing
  'No stays found for this search',        // hotels: empty search
  'No stays match those filters',          // hotels: filtered to empty
]) {
  check(SRC.includes(fragment), `missing outcome message: "${fragment}"`);
}
// A positive flight-count announcement exists, for one-way AND round trips.
// (The message reads "${found.length} <flight|round-trip option>s found".)
check(/\$\{found\.length\}[^;]*flight[^;]*found/.test(SRC),
  'no positive flight-count announcement found');
check(SRC.includes("round-trip option"),
  'the positive flight announcement does not cover round trips');
check(/found\$\{page\.length|\} found`[\s\S]{0,40}stay|stay['"`]} found/.test(SRC) || SRC.includes('stays found'),
  'no positive stay-count announcement found');

/* ---------------------------------------------------------------- */
if (failures.length) {
  console.error(`FAILED with ${failures.length} problem(s):`);
  failures.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('PASS: search results announce their outcome to assistive tech '
  + '(live region ARIA contract verified; both render paths announce).');
