'use strict';
/* ===========================================================================
   booking-steps.js — the booking progress bar, for every product.
   ===========================================================================
   WHY THIS FILE EXISTS

   There were two of these. hotel-results.js carried `stepperHtml()` in the
   `hr-` namespace, drawn on six hotel screens; travel-explore.js carried
   `renderStepper()` in the `tx-` namespace, drawn on the flights results page.
   Two implementations, two stylesheets, two sets of labels — and Tour Packages
   had neither, so a traveller booking a package could not see where they were
   at all. That is the whole of "one predictable experience regardless of what
   you are booking": not similar bars, the SAME bar.

   WHAT IS SHARED AND WHAT IS NOT

   Shared: the markup, the `bs-` classes, the three states (done / current /
   ahead), the tick, the scrolling behaviour, the accessibility.

   Not shared: the step LIST. A flight has Seat Selection and a hotel does not;
   a hotel has Room Selection and a flight does not. Forcing one list on all
   three would mean either inventing steps a product does not have or dropping
   steps it does. So each product names its own, in FLOWS below, and the shape
   they have in common is the shape the user actually sees.

   THE LISTS ARE THE SOURCE OF TRUTH FOR STEP NUMBERS. Every screen asks for
   its own index — HotelRooms passes 3, HotelPayment passes 6 — so inserting a
   step means changing this file and the callers together, deliberately, rather
   than discovering later that two screens disagree about which step they are.
   =========================================================================== */

const BookingSteps = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? ''))
    : String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  /* The journeys, in the order the traveller walks them.

     Every list starts at Search — which happens on the landing page, is always
     behind them by the time any of these render, and is shown done rather than
     omitted: a progress bar that starts at step 2 reads as though something
     was skipped. */
  const FLOWS = {
    flights: [
      'Search', 'Select Flight', 'Traveller Details',
      'Seat Selection', 'Review', 'Payment', 'Confirmation',
    ],
    hotels: [
      'Search', 'Select Hotel', 'Hotel Details', 'Room Selection',
      'Guest Details', 'Review', 'Payment', 'Confirmation',
    ],
    packages: [
      'Search', 'Select Package', 'Traveller Details',
      'Review', 'Payment', 'Confirmation',
    ],
  };

  const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"'
    + ' stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  /** @param {string} product  a key of FLOWS
   *  @param {number} at       zero-based index of the CURRENT step
   *  @returns {string} markup, or '' for a product with no journey defined —
   *          an unknown name draws nothing rather than a bar of one step. */
  function html(product, at) {
    const steps = FLOWS[product];
    if (!steps) return '';
    const here = Math.max(0, Math.min(steps.length - 1, Number(at) || 0));

    return '<nav class="bs-steps" aria-label="Booking progress">'
      + steps.map((label, i) => {
        const state = i < here ? 'is-done' : i === here ? 'is-current' : '';
        /* A tick for what is behind, a number for everything else. The number
           is the step's position, so it keeps counting past the current one. */
        const mark = i < here ? TICK : String(i + 1);
        return (i ? '<span class="bs-line" aria-hidden="true"></span>' : '')
          + '<span class="bs-step ' + state + '"'
          + (i === here ? ' aria-current="step"' : '')
          + '>'
          /* The dot is decorative — the label carries the meaning, and a
             screen reader announcing "3" before every step name is noise. */
          + '<span class="bs-dot" aria-hidden="true">' + mark + '</span>'
          + '<span class="bs-label">' + esc(label) + '</span>'
          + '</span>';
      }).join('')
      + '</nav>';
  }

  /** Draw into an element, by id or node. A missing host is not an error: the
   *  same renderer runs on screens that do not all carry a stepper slot. */
  function mount(host, product, at) {
    const el = typeof host === 'string' ? document.getElementById(host) : host;
    if (!el) return null;
    el.innerHTML = html(product, at);
    return el;
  }

  /** How many steps a product has, for a caller that wants to name the last
   *  one without hardcoding a number. */
  const count = product => (FLOWS[product] || []).length;

  return { html, mount, count, FLOWS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BookingSteps;
