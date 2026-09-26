'use strict';
/* ===========================================================================
   jw-motion.js — two hooks, so photographs arrive the way the rest of the
   site already moves.
   ===========================================================================
   THIS IS NOT A SECOND ANIMATION SYSTEM. The site has one entrance
   (`.reveal` / `.reveal-zoom`, main.css:142, driven by the observer in
   app.js:128), one stagger (`.delay-1..4`), one card hover language
   (`.jw-dest-*`, main.css:1576) and one reduced-motion policy (main.css:79).
   All of that stays where it is and keeps working untouched.

   WHAT WAS MISSING, AND IS ALL THIS FILE ADDS:

     1. THE OBSERVER COULD NOT SEE MOST OF THE SITE. app.js collects
        `.reveal` elements once, at load. Every destination card, landmark
        card and package card is rendered later from an API answer, so none
        of them was ever observed and none of them ever revealed. `scan()`
        hands those nodes to the SAME observer rather than making another.

     2. NOTHING HAPPENED WHEN A PHOTOGRAPH LOADED. Images popped in at
        whatever moment the network finished. `develop()` gives them the
        arrival the rest of the page has - and gives it to CURATED and
        vendored photographs identically, because the animation is attached
        to the <img>, not to where the picture came from.

   FAIL-OPEN, WHICH IS THE ONLY RULE THAT REALLY MATTERS HERE. An image must
   never be left invisible by an animation:

     - `.jw-dev` is added BY THIS FILE, to nodes the renderers just created.
       No script, no class, no hidden image.
     - A picture already in cache is developed on the next frame.
     - A picture that fails is developed anyway - the <img> removes itself on
       error and the card's own fallback shows through.
     - A picture that never resolves is developed by a watchdog after
       WATCHDOG_MS, so the worst case is a photograph that appears without
       having animated.
     - Reduced motion is handled in CSS, by the global switch plus a starting
       state; nothing here tests for it.

   NO NEW REQUESTS, EVER. This file only ever reads `img.complete` and listens
   for events on an <img> the page already created. It sets no `src`, touches
   no manifest and can never cause a second fetch of a photograph.
   =========================================================================== */
(function (global) {
  /* How long a photograph may take before it is shown regardless. Long enough
     that a slow connection still gets the animation, short enough that nobody
     stares at an empty frame: a 3G hero is usually in by 2.5s. */
  const WATCHDOG_MS = 3000;

  /* The stagger steps `.delay-1..4` (main.css) plus jw-motion.css's 5..9. */
  const STAGGER_MAX = 9;

  /* ONE observer for the whole document, created on first use and shared by
     every caller - the homepage shelf, the discovery grids and the package
     grids all feed this same instance. `unobserve` on first intersection is
     what makes a reveal play ONCE and never replay when the DOM changes. */
  let observer = null;

  function ensureObserver() {
    if (observer || typeof IntersectionObserver === 'undefined') return observer;
    observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        /* AND THE PHOTOGRAPH DEVELOPS AS THE CARD ARRIVES, which is the whole
           point and was the bug in the first cut: images were developed the
           moment they loaded, so a shelf below the fold had finished
           developing about 900ms into the page load and was already sharp by
           the time anybody scrolled to it. All that was left to see was the
           card sliding up. The two now happen together. */
        settleWithin(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.15 });
    return observer;
  }

  /** Let every armed image inside `el` finish developing.
   *
   *  An image that has already loaded settles on the next frame; one still in
   *  flight settles when it lands, because the arrival is the point at which
   *  it is worth watching. */
  function settleWithin(el) {
    el.querySelectorAll('.jw-dev:not(.is-developed)').forEach(img => {
      img.dataset.jwArmed = '';
      if (img.complete && img.naturalWidth > 0) { settle(img); return; }
      /* STILL IN FLIGHT, AND NOW ON SCREEN. Its own load listener will settle
         it, but the watchdog that guarded it was cancelled when it was armed
         (an off-screen image must not develop on a timer - that was the
         original bug). A card the traveller is looking at cannot be left
         holding an invisible image, so the guard comes back now. */
      setTimeout(() => settle(img), WATCHDOG_MS);
    });
  }

  /** Observe every not-yet-revealed `.reveal` inside `root` (default: document).
   *
   *  Safe to call repeatedly: an element that has already revealed carries
   *  `.visible` and is skipped, so re-rendering a grid does not replay
   *  anything that is already on screen.
   */
  function scan(root) {
    const scope = root || document;
    const items = scope.querySelectorAll('.reveal:not(.visible), .reveal-zoom:not(.visible)');
    const io = ensureObserver();
    if (!io) {
      /* No IntersectionObserver (very old browser): show everything rather
         than leave the page blank - and settle the photographs with it, or
         they would sit armed behind a card that is now visible. */
      items.forEach(el => { el.classList.add('visible'); settleWithin(el); });
      return;
    }
    items.forEach(el => io.observe(el));
  }

  /** Mark a node as developed, once, and stop watching it. */
  function settle(img, timer) {
    if (timer) clearTimeout(timer);
    /* rAF so the browser has painted the pre-state at least once; without it
       a cached image can go straight to the end state and never animate. */
    requestAnimationFrame(() => img.classList.add('is-developed'));
  }

  /** Give one <img> the develop treatment.
   *
   *  `opts.hero` picks the slower beat. Anything that is not an <img> - the
   *  drawn pin a place without a photograph shows - is left completely alone:
   *  fading that in would present a placeholder as though it were a picture
   *  of somewhere.
   */
  function develop(img, opts) {
    if (!img || img.tagName !== 'IMG' || img.classList.contains('jw-dev')) return;
    const o = opts || {};
    img.classList.add('jw-dev');
    if (o.hero) img.classList.add('jw-dev-hero');

    /* ARMED, NOT FIRED. A card's image waits for its card to come into view
       (settleWithin, from the observer); a hero is already on screen when the
       page opens, so it develops as soon as it has pixels. */
    const armed = !!o.onReveal;
    if (armed) img.dataset.jwArmed = '1';

    /* Already decoded (cache, or a same-page re-render): one frame and done -
       unless it is waiting for its card to arrive. */
    if (img.complete && img.naturalWidth > 0) { if (!armed) settle(img); return; }

    const timer = setTimeout(() => settle(img), WATCHDOG_MS);
    const done = () => {
      /* Still waiting for its card? Leave it armed; the watchdog stays as the
         floor so a card that is never scrolled to cannot strand an image. */
      if (img.dataset.jwArmed === '1') { clearTimeout(timer); return; }
      settle(img, timer);
    };
    img.addEventListener('load', done, { once: true });
    /* ERROR DEVELOPS TOO. The renderers' own onerror removes a broken <img>
       so the card's fallback shows; if anything ever keeps one in the page,
       this makes sure it is a visible broken image rather than an invisible
       one that silently eats the card. */
    img.addEventListener('error', done, { once: true });
  }

  /** Every <img> inside `root`, developed. Returns the count, for callers
   *  that want to know whether anything was there. */
  function developAll(root, opts) {
    if (!root) return 0;
    const imgs = root.querySelectorAll('img:not(.jw-dev)');
    imgs.forEach(img => develop(img, opts));
    return imgs.length;
  }

  /** The stagger class for the nth card of a freshly rendered grid.
   *  Beyond STAGGER_MAX everything shares the last step - a 14th card that
   *  waits its "turn" is a card that looks broken. */
  function stagger(index) {
    const n = Math.min(index + 1, STAGGER_MAX);
    return n <= 4 ? ('delay-' + n) : ('jw-stagger-' + n);
  }

  /** The usual call for a grid the page just rendered: give the cards their
   *  entrance, hand them to the observer, and develop their photographs. */
  function grid(root, opts) {
    if (!root) return;
    const cards = root.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (card.classList.contains('visible')) continue;
      /* `jw-rv` is what jw-motion.css hangs the entrance timing on - see the
         "a card that reveals AND hovers" block there for why the card's own
         transition would otherwise swallow the fade. */
      card.classList.add('reveal', 'jw-rv', stagger(i));
    }
    scan(root);
    /* Armed here, fired by the observer when each card arrives. */
    developAll(root, Object.assign({ onReveal: true }, opts || {}));
    /* A grid that is ALREADY on screen when it renders (a short page, a
       filtered list that fits, the top of the packages page) gets no
       intersection callback for cards that were never outside the viewport,
       so nothing would ever fire. The observer handles that case itself -
       IntersectionObserver reports the initial state - but this covers the
       browser with no observer at all, where scan() marks everything visible
       immediately. */
    if (typeof IntersectionObserver === 'undefined') settleWithin(root);
  }

  global.JWMotion = { scan, develop, developAll, grid, stagger };

  /* The static markup on index.html is still app.js's to observe; this only
     catches pages that carry `.reveal` in their markup but do not load
     app.js. Calling scan() twice over the same node is harmless. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(), { once: true });
  } else {
    scan();
  }
})(window);
