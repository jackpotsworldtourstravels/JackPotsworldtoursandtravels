'use strict';
/* ===========================================================================
   jw-system.js — the design system's behaviour. `window.DS`.
   ===========================================================================
   The companion of jw-system.css. It owns what CSS cannot do alone:

     DS.observe(el, fn)      THE page's IntersectionObserver. One instance,
                             many callbacks. jw-motion.js routes through it
                             when this file is present, so a page never runs
                             two observers.
     [data-ds-reveal]        rises into view once; `data-ds-stagger` on a
                             parent staggers its revealed children.
     img.ds-dev              develops once — faint, blurred and large, to
                             sharp and exact — when it is both loaded and on
                             screen. Never twice.
     DS.state(el, opts)      the one loading / empty / error / offline /
                             expired / not-found composition.
     DS.skeleton(el, kind,n) contextual skeletons instead of a spinner.
     DS.tabs(root)           the sliding tab pill, with arrow-key support.
     DS.open(el) / close()   modal and drawer / bottom sheet: scrim, focus
                             trap (components/focus-trap.js when loaded),
                             Escape, scroll lock, focus restored.
     DS.gsap()               GSAP + ScrollTrigger, loaded ON DEMAND from
                             assets/js/vendor — the site's single animation
                             engine, fetched only by a page that has scroll
                             choreography ([data-ds-parallax], .ds-hero).

   FAIL-OPEN. Hidden starting states in the stylesheet apply only under
   `html.ds-motion`, which is set here, after the observer exists. Reduced
   motion never sets it.

   THE FIVE MOTION FAMILIES, AND WHERE EACH ONE ALREADY LIVES. There is ONE
   motion system — this file and jw-system.css — and every animation on the
   site is one of five families. This is the map, not a new layer: nothing
   below re-implements these, they name what is already here.

     DEVELOP  a photograph arriving: placeholder -> blur -> sharp -> settled.
              `img.ds-dev` + DS.develop (jw-system.css §"develop"). The image
              lifecycle, unchanged.
     RISE     a card or section entering the viewport, once, with an optional
              parent stagger. `[data-ds-reveal]` / `data-ds-stagger`, via the
              one shared observer; JWMotion.grid arms API-rendered grids.
     ROUTE    a travel line drawing itself across a frame. `ds-draw` on
              `.ds-hero__route` and on the `.ds-state__art` arc — the brand
              motif used for the hero and for loading/empty states alike.
     MORPH    a set of results or a stepper changing: skeleton -> rows is the
              RISE entrance replayed on the new list (DS.skeleton then
              JWMotion.grid); a stepper advancing adds the small check-pop /
              ring-settle beat (jw-system.css §3.14). Never a layout jump.
     REVEAL   a page or hero opening: the shade, grain, breadcrumb, eyebrow
              and display H1 of `.ds-hero`, plus DS.gsap choreography loaded
              on demand. The page's single entrance.

   Reduced motion collapses all five to their settled state — no draw, no
   stagger, no continuous shimmer — because `html.ds-motion` is never set.
   =========================================================================== */
(function (global) {
  const doc = document, root = doc.documentElement;
  const reduce = global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = global.matchMedia('(max-width: 900px)').matches;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (function () {
    const s = doc.currentScript && doc.currentScript.src;
    return s ? s.replace(/[^/]*$/, '') : 'assets/js/';
  })();

  /* ------------------------------------------------------------------ observe */
  let io = null;
  const watchers = new Map();
  function observe(el, fn, once) {
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { fn(el, true); return; }
    if (!io) {
      io = new IntersectionObserver(entries => entries.forEach(e => {
        const list = watchers.get(e.target);
        if (!list) return;
        list.slice().forEach(w => {
          w.fn(e.target, e.isIntersecting, e);
          if (w.once && e.isIntersecting) {
            list.splice(list.indexOf(w), 1);
            if (!list.length) { watchers.delete(e.target); io.unobserve(e.target); }
          }
        });
      }), { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
    }
    if (!watchers.has(el)) { watchers.set(el, []); io.observe(el); }
    watchers.get(el).push({ fn, once: once !== false });
  }

  /* ------------------------------------------------------------------ reveal */
  function reveal(scope) {
    const els = (scope || doc).querySelectorAll('[data-ds-reveal]:not(.is-in)');
    els.forEach(el => {
      if (el.dataset.dsBound) return;
      el.dataset.dsBound = '1';
      const parent = el.parentElement && el.parentElement.closest('[data-ds-stagger]');
      if (parent && !el.style.getPropertyValue('--ds-delay')) {
        const kids = Array.from(parent.querySelectorAll('[data-ds-reveal]'));
        const step = parseFloat(parent.dataset.dsStagger) || 0.09;
        el.style.setProperty('--ds-delay', Math.min(kids.indexOf(el), 8) * step + 's');
      }
      observe(el, (t, on) => { if (on) { t.classList.add('is-in'); develop(t); } });
    });
  }

  /* ----------------------------------------------------------------- develop */
  function settle(img) {
    requestAnimationFrame(() => {
      img.classList.add('is-dev');
      setTimeout(() => img.classList.add('is-settled'), 1200);
    });
  }
  function developOne(img) {
    if (img.dataset.dsDev) return;
    img.dataset.dsDev = '1';
    const go = () => settle(img);
    if (img.complete && img.naturalWidth) go();
    else {
      img.addEventListener('load', go, { once: true });
      img.addEventListener('error', go, { once: true });
      setTimeout(go, 3000);              // a slow network still gets its picture
    }
  }
  /** Develop every `.ds-dev` image inside (or being) `scope` once it is seen. */
  function develop(scope) {
    const list = scope && scope.matches && scope.matches('img.ds-dev') ? [scope]
      : Array.from((scope || doc).querySelectorAll('img.ds-dev'));
    list.forEach(img => {
      if (img.dataset.dsDev) return;
      if (reduce) { img.classList.add('is-dev', 'is-settled'); return; }
      observe(img, (t, on) => { if (on) developOne(t); });
    });
  }

  /* ------------------------------------------------------------------- state */
  const ART = {
    route: '<svg class="ds-state__art" viewBox="0 0 180 72" aria-hidden="true">'
      + '<path class="ghost" d="M14 58 C 60 -6, 120 -6, 166 58"/>'
      + '<path class="arc" d="M14 58 C 60 -6, 120 -6, 166 58"/>'
      + '<circle class="n" cx="14" cy="58" r="5"/><circle class="n2" cx="14" cy="58" r="10"/>'
      + '<circle class="n" cx="166" cy="58" r="5"/><circle class="n2" cx="166" cy="58" r="10"/></svg>',
  };
  const STATES = {
    loading:  { kicker: 'One moment',        title: 'Loading your journey',              body: '' },
    empty:    { kicker: 'Nothing here yet',  title: 'No journeys yet',                   body: '' },
    error:    { kicker: 'Something went wrong', title: 'We couldn’t load this',     body: 'Please try again in a moment.' },
    offline:  { kicker: 'Offline',           title: 'The connection was lost',           body: 'Check your connection, then try again.' },
    expired:  { kicker: 'Signed out',        title: 'Your session expired',              body: 'Sign in again to carry on where you left off.' },
    notfound: { kicker: 'Not found',         title: 'We couldn’t find that',        body: '' },
    partial:  { kicker: 'Partly loaded',     title: 'Some details are missing',          body: 'What we could load is shown below.' },
  };
  /** Render a state into `el`. opts: { kind, kicker, title, body, actions:
   *  [{ label, href | onClick, variant }] }. Returns the element. */
  function state(el, opts) {
    const o = Object.assign({ kind: 'empty' }, opts || {});
    const d = STATES[o.kind] || STATES.empty;
    const title = o.title || d.title, body = o.body != null ? o.body : d.body, kicker = o.kicker || d.kicker;
    const acts = (o.actions || []).map((a, i) => {
      const cls = 'ds-btn ' + (a.variant ? 'ds-btn--' + a.variant : (i ? 'ds-btn--outline' : 'ds-btn--primary'));
      const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
      return a.href
        ? '<a class="' + cls + '" href="' + esc(a.href) + '">' + esc(a.label) + arrow + '</a>'
        : '<button type="button" class="' + cls + '" data-ds-act="' + i + '">' + esc(a.label) + arrow + '</button>';
    }).join('');
    el.innerHTML = '<div class="ds-state ds-state--' + esc(o.kind) + '"'
      + (o.kind === 'loading' ? ' role="status" aria-live="polite"' : (o.kind === 'error' || o.kind === 'offline' ? ' role="alert"' : ''))
      + '>' + ART.route
      + '<span class="ds-state__kicker">' + esc(kicker) + '</span>'
      + '<h2 class="ds-state__title">' + esc(title) + '</h2>'
      + (body ? '<p class="ds-state__body">' + esc(body) + '</p>' : '')
      + (acts ? '<div class="ds-state__actions">' + acts + '</div>' : '')
      + '</div>';
    (o.actions || []).forEach((a, i) => {
      const b = el.querySelector('[data-ds-act="' + i + '"]');
      if (b && a.onClick) b.addEventListener('click', a.onClick);
    });
    return el;
  }

  /* ---------------------------------------------------------------- skeleton */
  const SKELS = {
    card: '<div class="ds-skel-card"><div class="ds-skel ds-skel--media"></div><div class="ds-skel ds-skel--title" style="margin-top:16px"></div><div class="ds-skel ds-skel--line w-80"></div><div class="ds-skel ds-skel--line w-40"></div></div>',
    row: '<div class="ds-skel-row"><div class="ds-skel ds-skel--media"></div><div><div class="ds-skel ds-skel--title"></div><div class="ds-skel ds-skel--line w-80"></div><div class="ds-skel ds-skel--line w-60"></div></div><div class="ds-skel ds-skel--pill"></div></div>',
    media: '<div class="ds-skel ds-skel--media"></div>',
    text: '<div><div class="ds-skel ds-skel--title"></div><div class="ds-skel ds-skel--line"></div><div class="ds-skel ds-skel--line w-80"></div><div class="ds-skel ds-skel--line w-60"></div></div>',
  };
  function skeleton(el, kind, n) {
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = '<span class="ds-sr" role="status">Loading</span>' + Array.from({ length: n || 3 }, () => SKELS[kind] || SKELS.card).join('');
    return el;
  }

  /* -------------------------------------------------------------------- tabs */
  function tabs(rootEl, onChange) {
    if (!rootEl || rootEl.dataset.dsTabs) return;
    rootEl.dataset.dsTabs = '1';
    rootEl.setAttribute('role', 'tablist');
    const items = Array.from(rootEl.querySelectorAll('.ds-tab'));
    const ind = doc.createElement('span');
    ind.className = 'ds-tabs__ind'; ind.setAttribute('aria-hidden', 'true');
    rootEl.insertBefore(ind, rootEl.firstChild);
    const place = instant => {
      const on = items.find(t => t.getAttribute('aria-selected') === 'true') || items[0];
      if (!on) return;
      if (instant) ind.style.transition = 'none';
      ind.style.width = on.offsetWidth + 'px';
      ind.style.transform = 'translateX(' + (on.offsetLeft - 5) + 'px)';
      if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
    };
    const select = (t, focus) => {
      items.forEach(x => { const on = x === t; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; });
      if (focus) t.focus();
      place(false);
      if (onChange) onChange(t, items.indexOf(t));
    };
    items.forEach((t, i) => {
      t.setAttribute('role', 'tab');
      if (!t.hasAttribute('aria-selected')) t.setAttribute('aria-selected', i === 0);
      t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', e => {
        const k = e.key; let n = null;
        if (k === 'ArrowRight') n = items[(i + 1) % items.length];
        if (k === 'ArrowLeft') n = items[(i - 1 + items.length) % items.length];
        if (k === 'Home') n = items[0];
        if (k === 'End') n = items[items.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
    place(true);
    global.addEventListener('resize', () => place(true));
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => place(true));
    return { select: i => items[i] && select(items[i]) };
  }

  /* ------------------------------------------------------------ modal/drawer */
  let scrim = null;
  const stack = [];
  function getScrim() {
    if (scrim) return scrim;
    scrim = doc.createElement('div');
    scrim.className = 'ds-scrim';
    scrim.addEventListener('click', () => { const top = stack[stack.length - 1]; if (top && !top.el.hasAttribute('data-ds-sticky')) close(top.el); });
    doc.body.appendChild(scrim);
    return scrim;
  }
  function open(el) {
    if (!el || el.classList.contains('is-open')) return;
    const opener = doc.activeElement;
    getScrim().classList.add('is-open');
    el.classList.add('is-open');
    el.setAttribute('aria-modal', 'true');
    if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
    root.classList.add('ds-locked');
    const release = typeof global.trapFocus === 'function' ? global.trapFocus(el) : (() => {
      const f = el.querySelector('input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])');
      if (f) setTimeout(() => f.focus(), 60);
      return () => opener && opener.focus && opener.focus();
    })();
    const onKey = e => { if (e.key === 'Escape' && stack[stack.length - 1] && stack[stack.length - 1].el === el) close(el); };
    doc.addEventListener('keydown', onKey);
    stack.push({ el, release, onKey });
    el.querySelectorAll('[data-ds-close]').forEach(b => { if (!b.dataset.dsCloseBound) { b.dataset.dsCloseBound = '1'; b.addEventListener('click', () => close(el)); } });
  }
  function close(el) {
    const i = stack.findIndex(s => s.el === el);
    if (i < 0) return;
    const s = stack.splice(i, 1)[0];
    el.classList.remove('is-open');
    doc.removeEventListener('keydown', s.onKey);
    if (s.release) s.release();
    if (!stack.length) { if (scrim) scrim.classList.remove('is-open'); root.classList.remove('ds-locked'); }
  }

  /* -------------------------------------------------------------------- gsap */
  let gsapLoad = null;
  function load(src) {
    return new Promise((res, rej) => {
      const s = doc.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = rej;
      doc.head.appendChild(s);
    });
  }
  /** GSAP + ScrollTrigger, fetched once, on demand. Resolves to `gsap`, or
   *  to null under reduced motion / on failure — callers treat null as
   *  "stay still". */
  function getGsap() {
    if (reduce) return Promise.resolve(null);
    if (global.gsap && global.ScrollTrigger) { global.gsap.registerPlugin(global.ScrollTrigger); return Promise.resolve(global.gsap); }
    if (!gsapLoad) {
      gsapLoad = load(base + 'vendor/gsap.min.js?v=3.13.0')
        .then(() => load(base + 'vendor/ScrollTrigger.min.js?v=3.13.0'))
        .then(() => { global.gsap.registerPlugin(global.ScrollTrigger); return global.gsap; })
        .catch(() => null);
    }
    return gsapLoad;
  }

  /* -------------------------------------------------------- hero + parallax */
  /** Scroll depth for every [data-ds-parallax="speed"] and every .ds-hero:
   *  the photograph drifts and scales, the words leave a little faster. */
  function depth() {
    const heroes = doc.querySelectorAll('.ds-hero');
    const layers = doc.querySelectorAll('[data-ds-parallax]');
    if (reduce || (!heroes.length && !layers.length)) return;
    getGsap().then(g => {
      if (!g) return;
      const k = small ? 0.5 : 1;            // a phone gets half the travel
      heroes.forEach(h => {
        const media = h.querySelector('.ds-hero__media'), inner = h.querySelector('.ds-hero__inner');
        const tl = g.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: h, start: 'top top', end: 'bottom top', scrub: 0.6 } });
        if (media) tl.fromTo(media, { yPercent: 0, scale: 1.02 }, { yPercent: 12 * k, scale: 1.1 }, 0);
        if (inner) tl.to(inner, { y: -90 * k, opacity: 0.1 }, 0);
      });
      layers.forEach(el => {
        const s = (parseFloat(el.dataset.dsParallax) || 0.15) * k;
        g.fromTo(el, { yPercent: 40 * s }, { yPercent: -40 * s, ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 0.8 } });
      });
      /* The hero route draws itself across the frame once. */
      doc.querySelectorAll('.ds-hero__route path:not(.ghost)').forEach(p => {
        const L = p.getTotalLength ? p.getTotalLength() : 0;
        if (!L) return;
        /* The path is drawn non-scaling-stroke inside a stretched viewBox, so
           its on-screen length is not L. The dash only has to be long enough
           to animate; once the line is drawn it is released, or a wide or
           tall hero was left with the tail of its route missing. */
        g.fromTo(p, { strokeDasharray: L, strokeDashoffset: L }, {
          strokeDashoffset: 0, duration: 2.4, ease: 'power2.inOut', delay: 0.4,
          onComplete: () => { p.style.strokeDasharray = 'none'; p.style.strokeDashoffset = '0'; },
        });
      });
    });
  }

  /* -------------------------------------------------------------------- init */
  function init() {
    reveal(); develop(); depth();
    doc.querySelectorAll('.ds-tabs').forEach(t => tabs(t));
  }
  /* The cross-document view transition (jw-system.css §3.17) is the
     browser's, but a SKIPPED one — a reload mid-fade, a hidden tab — rejects
     its promises with nobody listening, which lands in the console as an
     uncaught AbortError on every such navigation. A skip is not an error. */
  ['pageswap', 'pagereveal'].forEach(type => global.addEventListener(type, e => {
    const vt = e.viewTransition;
    if (vt) ['ready', 'finished', 'updateCallbackDone'].forEach(k => vt[k] && vt[k].catch(() => {}));
  }));
  if (!reduce) root.classList.add('ds-motion');
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  global.DS = { observe, reveal, develop, state, skeleton, tabs, open, close, gsap: getGsap, reduce, small, esc };
})(window);
