/* flights-sticky-search.js — pins the Edit Search card while the results scroll.
   ==========================================================================
   Loaded by flights.html only. The CSS that does the visual work is the
   "STICKY EDIT SEARCH CARD" block at the foot of flights-ref.css; read its
   note for why this is a class toggle and not `position: sticky`.

   WHAT IT DOES
     - When the top of #heroSearchDock reaches the pin line (--fx-stick-top
       from the viewport top), adds `.is-stuck` to the dock. The dock's height
       is pinned inline first, so the page below the hero does not move.
     - When the dock's slot scrolls back below the line it lets go again, so
       the card returns to where it was; the flow is never altered.
     - Only the COLLAPSED summary is pinned. Pressing Edit opens the existing
       editor, which can be taller than a phone's screen, so opening it while
       pinned releases the card and scrolls to the editor in the page instead.
     - Writes --fx-bar-h (the pinned bar: card + gaps) for the backdrop band, and
       --fx-stick-offset (bar + 14px) for the filter rail's sticky `top`, which
       has to clear the bar now that the header is no longer fixed.

   It reads and toggles classes only: the card's markup, its URL handling and
   the search itself are BookingCard's and travel-explore.js's, untouched. */
(function () {
  'use strict';

  if (!document.body || document.body.getAttribute('data-sp-service') !== 'flights') return;
  const dock = document.getElementById('heroSearchDock');
  if (!dock) return;

  const root = document.documentElement;
  let stuck = false;

  const card = () => dock.querySelector('.search-card');
  const pinLine = () => parseFloat(getComputedStyle(document.body).getPropertyValue('--fx-stick-top')) || 10;

  function release() {
    if (!stuck) return;
    stuck = false;
    dock.classList.remove('is-stuck');
    dock.style.minHeight = '';
  }

  function pin() {
    if (stuck) return;
    /* Height first, class second: once the card is fixed the dock would
       otherwise collapse and the results would jump up under it. */
    dock.style.minHeight = dock.offsetHeight + 'px';
    dock.classList.add('is-stuck');
    stuck = true;
  }

  /* Only the PINNED card is measured: unpinned it is the full hero card (its
     own padding included), which is taller than the compact bar it becomes.
     The bar's height drives the backdrop band and the filter rail's offset. */
  function measure() {
    const c = card();
    if (!stuck || !c) return;
    const h = c.getBoundingClientRect().height;
    if (!h) return;
    const bar = Math.round(h + 2 * pinLine());
    root.style.setProperty('--fx-bar-h', bar + 'px');
    root.style.setProperty('--fx-stick-offset', (bar + 14) + 'px');
  }

  /* Idempotent and cheap (one rect read), so it runs straight from the scroll
     event rather than through requestAnimationFrame: the card flips on the
     same frame the slot crosses the line, and a page whose frames are
     throttled (a background tab) still ends up in the right state. */
  function paint() {
    const c = card();
    const hidden = dock.offsetParent === null && !stuck;   // hero not displayed
    const booking = document.body.classList.contains('bk-inpage');
    const open = !!c && !c.classList.contains('is-collapsed');
    if (!c || hidden || booking || open) { release(); return; }
    if (dock.getBoundingClientRect().top <= pinLine()) pin(); else release();
    measure();
  }

  window.addEventListener('scroll', paint, { passive: true });
  /* A different width can change the card's height (the phone layout stacks
     the summary), so let go and re-measure rather than keep a stale slot. */
  window.addEventListener('resize', () => { release(); paint(); });
  /* The card is mounted after this script, folds after every search and opens
     on Edit: all of those are a class or child change under the dock. */
  new MutationObserver(paint).observe(dock, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class']
  });

  /* Edit while pinned: BookingCard has already opened the editor in place.
     Bring the page to it, so the editor is reachable at any card height. */
  dock.addEventListener('click', (e) => {
    if (!stuck || !e.target.closest('[data-search-strip]')) return;
    setTimeout(() => {
      const c = card();
      if (!c || c.classList.contains('is-collapsed')) return;
      release();
      const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      dock.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    }, 0);
  });

  paint();
})();
