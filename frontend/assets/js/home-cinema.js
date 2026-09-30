'use strict';
/* ===========================================================================
   home-cinema.js — the homepage's motion: one engine, GSAP + ScrollTrigger.
   ===========================================================================
   WHAT IT DRIVES, in the order the page is read:

     1. the opening sequence   photograph develops, headline lines rise,
                               the search card rises, the CTA comes alive
     2. the hero on scroll     the frame recedes, the photograph drifts and
                               scales, the copy lifts away faster, the card
                               lifts with it
     3. the header             clear -> compact dark glass (one trigger)
     4. the bridge             dusk to ivory; the route continues out of the
                               hero through four stops, a plane flying it
     5. the shelf              cards arrive from depth, photographs develop
                               once, and every card drifts at its own rate
     6. why us                 the panel opens, the statement fills, the
                               promises arrive along a lit rail
     7. the finale             the photograph opens through a circle, the
                               route crosses it, the copy and form arrive
     8. the footer             a gold rule draws across its top

   WHY GSAP. The brief is scroll-LINKED motion across eight sections, with
   scrubbed timelines, batching and pinning-grade maths. The site had no
   animation library; the alternative was a hand-written scroll engine that
   would have had to reinvent ScrollTrigger's single throttled listener,
   refresh-on-resize and batching. It is vendored (assets/js/vendor) and is
   the ONLY engine here: jw-motion.js still serves every other page and is
   handed back the shelf if this file cannot run (see cards()).

   ONE SCROLL LISTENER. Every trigger below is a ScrollTrigger, which shares
   one passive, rAF-throttled listener. No IntersectionObserver is created
   here; app.js's and jw-motion.js's remain the only ones on the page.

   REDUCED MOTION: nothing here runs; every element keeps its resting,
   visible state.

   FAIL-OPEN: if GSAP is missing, `html.cine-pre` is dropped at once and the
   shelf falls back to jw-motion's reveal, so the page is merely static.
   =========================================================================== */
const HomeCinema = (function () {
  const root = document.documentElement;
  const hasGsap = typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = hasGsap && !reduce;
  const unpre = () => root.classList.remove('cine-pre');
  if (!motion) unpre();
  if (hasGsap) gsap.registerPlugin(ScrollTrigger);

  /* A phone gets lighter motion: shorter travel, no 3D tilt. Read once — a
     desktop resized down keeps its triggers, which only means slightly more
     motion than a phone. */
  const small = window.matchMedia('(max-width: 900px)').matches;

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  /* The hero's opening timeline, kept so a page restored from the back/forward
     cache (pageshow.persisted) can be jumped to its finished frame instead of
     coming back frozen mid-intro with the card or photograph still hidden. */
  let introTl = null;

  /* =========================================================================
     THE HEADER
     ========================================================================= */
  function setupHeader() {
    /* The header's states and its indicator are jw-header.js's now (bound by
       hero-shell's initBehaviour on this page as on every other). */
    const header = $('#siteHeader');
    if (header) header.classList.remove('is-solid', 'cine-compact');
  }

  /* =========================================================================
     THE SEARCH CARD — the sliding tab pill
     ========================================================================= */
  function setupTabs() {
    const dock = $('#heroSearchDock');
    if (!dock) return;
    let ind = null, tabs = null;
    const place = (instant) => {
      if (!tabs || !ind) return;
      const on = $('.search-tab.is-on', tabs) || $('.search-tab', tabs);
      if (!on) return;
      if (instant) ind.style.transition = 'none';
      ind.style.width = on.offsetWidth + 'px';
      ind.style.transform = 'translateX(' + on.offsetLeft + 'px)';
      if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
    };
    const install = () => {
      const t = $('.search-tabs', dock);
      if (!t || t === tabs) return;
      tabs = t;
      ind = document.createElement('span');
      ind.className = 'cine-tab-ind';
      ind.setAttribute('aria-hidden', 'true');
      tabs.insertBefore(ind, tabs.firstChild);
      place(true);
      /* The card flips `is-on` itself (booking-card.js); watching the class
         keeps this in step with the keyboard, the footer links and any
         programmatic switch, not only clicks. */
      new MutationObserver(() => place(false)).observe(tabs, { attributes: true, subtree: true, attributeFilter: ['class'] });
    };
    install();
    new MutationObserver(install).observe(dock, { childList: true, subtree: true });
    window.addEventListener('resize', () => place(true));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => place(true));
  }

  /* =========================================================================
     THE HERO — the opening sequence, then the scroll
     ========================================================================= */
  function setupHero() {
    const hero = $('#home');
    if (!hero) return;
    const stage = $('#cineStage'), media = $('.cine-media', hero), photo = $('.cine-photo', hero);
    const copy = $('#cineCopy'), dock = $('#heroSearchDock');
    const lines = $$('.cine-title .cine-line > span', hero);
    const cue = $('.cine-scroll-cue', hero), nav = $('#siteHeader .jw-hdr__bar');
    const card = $('.search-card', dock), go = $('.search-go', dock);

    if (!motion) return;

    /* --- 1. the opening sequence ----------------------------------------
       Timed to the brief: dark frame at 0, the photograph developing from
       0.2, the two headline lines 0.6 on their own beats, the card 1.4. */
    const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
    introTl = tl;
    tl.fromTo(photo, { opacity: 0, scale: 1.16, filter: 'blur(18px) brightness(.45)' },
                     { opacity: 1, scale: 1, filter: 'blur(0px) brightness(1)', duration: 2.4, ease: 'power2.out', clearProps: 'filter' }, 0.2)
      .fromTo(nav, { opacity: 0, y: -18 }, { opacity: 1, y: 0, duration: 1.2, clearProps: 'transform' }, 0.3)
      /* y: 0 BOTH ENDS. The CSS pre-state is translateY(112%), which GSAP
         reads back as a pixel `y`; without zeroing it the lines would land
         a full line-height low, inside their masks, invisible. */
      .fromTo(lines, { y: 0, yPercent: 112, rotation: 2.5 }, { y: 0, yPercent: 0, rotation: 0, duration: 1.5, stagger: 0.16 }, 0.6)
      .fromTo(dock, { opacity: 0, y: 90 }, { opacity: 1, y: 0, duration: 1.6 }, 1.4)
      .add(() => card && card.classList.add('cine-glint'), 1.55)
      .add(() => go && go.classList.add('cine-live'), 1.75)
      .fromTo(cue, { opacity: 0 }, { opacity: 1, duration: 1 }, 2.1);
    /* The timeline now holds the starting frame inline; the CSS pre-state
       can go. */
    unpre();

    /* --- 2. the hero on scroll -------------------------------------------
       Transform-only: the stage recedes into the night (its rounded foot
       becomes a frame), the photograph drifts down and in, the copy leaves
       faster than the page. */
    const st = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: 0.7 },
    });
    st.to(stage, { scale: small ? 0.95 : 0.9 }, 0)
      .to(media, { yPercent: 12, scale: 1.12 }, 0)
      .to(copy, { y: small ? -80 : -170, opacity: 0, duration: 0.65 }, 0)
      .to(dock, small ? { yPercent: -6, scale: 0.96 } : { yPercent: -10, scale: 0.93 }, 0)
      .to(cue, { opacity: 0, duration: 0.12 }, 0);
  }

  /* =========================================================================
     THE BRIDGE — the route continuing out of the hero
     ========================================================================= */
  function setupBridge() {
    const wrap = $('#cineBridge'), svg = $('#cineBridgeSvg'), dest = $('#destinations');
    if (!wrap || !svg) return;
    const ghost = $('.cine-bridge-ghost', svg), line = $('.cine-bridge-line', svg), plane = $('.cine-plane', svg);
    const stops = $$('.cine-stop', wrap);
    let L = 0, stopAt = [], progress = reduce ? 1 : 0;
    const shown = stops.map(() => false);

    /* The path is built to the section's real size: a Catmull-Rom curve
       through the stops, converted to cubic Beziers. It starts at the top
       centre — the foot of the hero's scroll cue — so the line visibly
       carries on from the hero rather than starting from nowhere. */
    function layout() {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w) return;
      const narrow = w < 700;
      const at = narrow
        ? [[0.5, -0.02], [0.2, 0.15], [0.74, 0.37], [0.22, 0.6], [0.72, 0.82], [0.5, 1.08]]
        : [[0.5, -0.03], [0.15, 0.24], [0.38, 0.66], [0.61, 0.22], [0.84, 0.58], [0.66, 1.1]];
      const p = at.map(a => [a[0] * w, a[1] * h]);
      let d = 'M' + p[0][0].toFixed(1) + ' ' + p[0][1].toFixed(1);
      for (let i = 0; i < p.length - 1; i++) {
        const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
        const k = 0.5 / 3;
        d += ' C' + (p1[0] + (p2[0] - p0[0]) * k).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) * k).toFixed(1)
          + ' ' + (p2[0] - (p3[0] - p1[0]) * k).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) * k).toFixed(1)
          + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
      }
      ghost.setAttribute('d', d); line.setAttribute('d', d);
      L = line.getTotalLength();
      line.style.strokeDasharray = L + ' ' + (L + 10);

      /* Where along the path each stop falls, by nearest sample. */
      const samples = [];
      for (let s = 0; s <= 400; s++) { const q = line.getPointAtLength(L * s / 400); samples.push([q.x, q.y, L * s / 400]); }
      stopAt = p.slice(1, 5).map(pt => {
        let best = 0, bd = Infinity;
        samples.forEach(s => { const dd = (s[0] - pt[0]) ** 2 + (s[1] - pt[1]) ** 2; if (dd < bd) { bd = dd; best = s[2]; } });
        return best / L;
      });

      /* The chips: dot on the stop, text running away from the nearer edge. */
      stops.forEach((el, i) => {
        const [x, y] = p[i + 1];
        const cw = el.offsetWidth, ch = el.offsetHeight;
        const flip = x + cw - 22 > w - 12;
        el.classList.toggle('is-flip', flip);
        el.style.left = (flip ? x - cw + 22 : x - 22) + 'px';
        el.style.top = (y - ch / 2) + 'px';
        el.style.transformOrigin = flip ? '100% 50%' : '0 50%';
      });
      paint(progress);
    }

    function paint(pr) {
      progress = pr;
      if (!L) return;
      line.style.strokeDashoffset = (L * (1 - pr)).toFixed(1);
      const at = Math.max(0.001, Math.min(0.999, pr)) * L;
      const a = line.getPointAtLength(at), b = line.getPointAtLength(Math.min(L, at + 2));
      const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      plane.setAttribute('transform', 'translate(' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')');
      plane.style.opacity = pr > 0.01 && pr < 0.995 ? 1 : 0;
      stops.forEach((el, i) => {
        const on = pr >= stopAt[i] - 0.005;
        if (on === shown[i]) return;
        shown[i] = on;
        if (!motion) { el.style.opacity = on ? 1 : 0; return; }
        gsap.to(el, on
          ? { opacity: 1, scale: 1, x: 0, duration: 0.8, ease: 'back.out(1.6)' }
          : { opacity: 0, scale: 0.6, x: -10, duration: 0.35, ease: 'power2.in' });
      });
    }

    if (motion) gsap.set(stops, { opacity: 0, scale: 0.6, x: -10 });
    layout();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

    if (!motion) { paint(1); window.addEventListener('resize', layout); return; }

    ScrollTrigger.create({
      trigger: wrap, start: 'top bottom', end: 'bottom 55%', scrub: 0.6,
      onUpdate: self => paint(self.progress),
      onRefresh: layout,
    });
    /* Dusk to ivory: the dark layer lifts once the hero has gone. */
    gsap.fromTo('.cine-dusk', { opacity: 1 }, {
      opacity: 0, ease: 'none',
      scrollTrigger: { trigger: dest, start: 'top 10%', end: 'top -45%', scrub: true },
    });
  }

  /* =========================================================================
     HEADINGS — masked lines rising on arrival (the shelf, the finale)
     ========================================================================= */
  function riseIn(scope, extra) {
    if (!motion || !scope) return;
    const lines = $$('.cine-line > span', scope);
    const rule = $('.cine-rule', scope);
    const rest = extra ? $$(extra, scope) : [];
    const tl = gsap.timeline({
      defaults: { ease: 'expo.out' },
      scrollTrigger: { trigger: scope, start: 'top 82%', toggleActions: 'play none none none' },
    });
    if (rule) tl.fromTo(rule, { scaleX: 0 }, { scaleX: 1, duration: 1.2 }, 0);
    tl.fromTo(lines, { yPercent: 115, rotation: 3 }, { yPercent: 0, rotation: 0, duration: 1.4, stagger: 0.14 }, 0.05);
    if (rest.length) tl.fromTo(rest, { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 1.2, stagger: 0.1 }, 0.35);
    return tl;
  }

  /* =========================================================================
     THE SHELF — cards from depth, photographs developing, drift
     ========================================================================= */
  const seen = new Set();         // cards whose arrival has played, by id
  let shelfTriggers = [];
  let refreshTimer = 0;

  /** Take over a freshly rendered grid. Returns false when this layer cannot
   *  run, and home-destinations.js hands the grid to JWMotion instead. */
  function cards(grid) {
    if (!hasGsap || !grid) return false;
    const list = Array.from(grid.children);

    /* If the API answered before this file loaded, JWMotion may already have
       claimed the cards; its classes would put a CSS transition on the same
       transform this layer animates. */
    list.forEach(c => {
      c.className = c.className.replace(/\b(reveal|jw-rv|visible|delay-\d|jw-stagger-\d)\b/g, '').trim();
      $$('img', c).forEach(img => img.classList.remove('jw-dev', 'jw-dev-hero', 'is-developed'));
    });
    if (reduce) return true;

    shelfTriggers.forEach(t => t.kill());
    shelfTriggers = [];

    const fresh = list.filter(c => !seen.has(c.dataset.destId));
    const again = list.filter(c => seen.has(c.dataset.destId));

    /* ARRIVAL: from below and behind, in batches as rows come into view. */
    fresh.forEach(c => {
      gsap.set(c, { opacity: 0, y: small ? 50 : 80, scale: 0.94 });
      const img = $('.jw-dest-img', c), art = $('.jw-dest-art', c);
      if (img) gsap.set(img, { opacity: 0.2, scale: 1.08, filter: 'blur(18px)' });
      if (art) gsap.set(art, { clipPath: 'inset(16% 0% 0% 0% round 0px)' });
    });
    const batch = ScrollTrigger.batch(fresh, {
      start: 'top 90%', once: true,
      onEnter: els => {
        gsap.to(els, { opacity: 1, y: 0, scale: 1, duration: 1.3, ease: 'expo.out', stagger: 0.12, overwrite: 'auto' });
        els.forEach((c, i) => {
          seen.add(c.dataset.destId);
          const art = $('.jw-dest-art', c);
          if (art) gsap.to(art, { clipPath: 'inset(0% 0% 0% 0% round 0px)', duration: 1.3, ease: 'expo.out', delay: i * 0.12, clearProps: 'clipPath' });
          develop($('.jw-dest-img', c), i * 0.12);
        });
      },
    });
    shelfTriggers.push(...batch);

    /* DRIFT: every card at its own rate — the large ones slower, the small
       ones quicker — the photograph moving inside its frame against the
       card, and the words moving against both. */
    list.forEach((c, i) => {
      const big = c.matches(':nth-child(3n+1)');
      const rate = small ? (big ? 3 : 5) : (big ? 5 : 9) + (i % 3) * 2;
      const art = $('.jw-dest-art', c), body = $('.jw-dest-body', c);
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: c, start: 'top bottom', end: 'bottom top', scrub: 0.8 },
      });
      tl.fromTo(c, { yPercent: rate }, { yPercent: -rate }, 0);
      if (!small) tl.fromTo(c, { rotationX: 7, transformPerspective: 1600 }, { rotationX: -5 }, 0);
      if (art) tl.fromTo(art, { yPercent: -7 }, { yPercent: 7 }, 0);
      if (body) tl.fromTo(body, { y: small ? 10 : 26 }, { y: small ? -10 : -26 }, 0);
      shelfTriggers.push(tl.scrollTrigger);
    });

    /* Cards that had already arrived (the first nine, after "View all")
       are simply there; their photographs do not develop twice. */
    again.forEach(c => gsap.set(c, { opacity: 1, y: 0, scale: 1 }));

    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => ScrollTrigger.refresh(), 60);
    return true;
  }

  /** The photograph develops ONCE: blurred, slightly large and faint, to
   *  sharp, exact and solid over ~900ms — when it has pixels to show. */
  function develop(img, delay) {
    if (!img) return;
    const go = () => gsap.to(img, {
      opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.95, ease: 'power2.out',
      delay: delay || 0, clearProps: 'filter,transform,opacity',
    });
    if (img.complete && img.naturalWidth) { go(); return; }
    let done = false;
    const once = () => { if (!done) { done = true; go(); } };
    img.addEventListener('load', once, { once: true });
    img.addEventListener('error', once, { once: true });
    setTimeout(once, 3000);             // a slow network still gets a picture
  }

  /* =========================================================================
     WHY US
     ========================================================================= */
  function setupWhy() {
    const panel = $('#cineWhyPanel'), sec = panel && panel.closest('section');
    if (!panel || !motion) return;
    const fills = $$('.cine-fill', panel), track = $('.cine-why-track', panel);
    const items = $$('.cine-benefit', panel), rail = $('#cineWhyRailFill'), arcs = $('.cine-why-arcs', panel);

    /* The panel opens out of the ivory page. */
    gsap.fromTo(panel, { scale: small ? 0.95 : 0.88 }, {
      scale: 1, ease: 'none',
      scrollTrigger: { trigger: sec, start: 'top bottom', end: 'top 15%', scrub: 0.6 },
    });
    if (arcs) gsap.fromTo(arcs, { rotation: -20 }, { rotation: 35, ease: 'none', scrollTrigger: { trigger: sec, start: 'top bottom', end: 'bottom top', scrub: 1 } });

    /* The statement fills, word by word, as the promises go by. */
    gsap.set(fills, { '--fill': 0 });
    const fillTl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: small ? panel : track, start: 'top 75%', end: small ? 'top 10%' : 'center 55%', scrub: 0.5 },
    });
    fills.forEach((f, i) => fillTl.to(f, { '--fill': 1, duration: 1 }, i * 0.85));

    riseIn($('.cine-why-lead', panel), '.cine-why-sub');

    /* The rail draws down the list; each promise arrives with depth and
       lights its marker as the rail reaches it. */
    if (rail) gsap.fromTo(rail, { scaleY: 0 }, { scaleY: 1, ease: 'none', scrollTrigger: { trigger: track, start: 'top 65%', end: 'bottom 65%', scrub: 0.4 } });
    items.forEach(li => {
      gsap.fromTo(li, { opacity: 0, y: 60, rotationX: small ? 0 : -28 }, {
        opacity: 1, y: 0, rotationX: 0, duration: 1.2, ease: 'expo.out',
        scrollTrigger: { trigger: li, start: 'top 90%', toggleActions: 'play none none none' },
      });
      ScrollTrigger.create({ trigger: li, start: 'top 65%', toggleClass: { targets: li, className: 'is-lit' } });
    });
  }

  /* =========================================================================
     THE FINALE, and the footer after it
     ========================================================================= */
  function setupFinale() {
    const sec = $('#newsletter'), media = $('#cineFinaleMedia');
    if (!sec || !media || !motion) return;
    const img = $('img', media), path = $('#cineFinalePath');

    /* The photograph opens through a circle as the section arrives, and
       settles from a push-in while it does. */
    gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: sec, start: 'top bottom', end: 'top 5%', scrub: 0.6 },
    })
      .fromTo(media, { clipPath: 'circle(12% at 50% 62%)' }, { clipPath: 'circle(120% at 50% 62%)' }, 0)
      .fromTo(img, { scale: 1.32 }, { scale: 1.04 }, 0);
    gsap.fromTo(img, { yPercent: -4 }, { yPercent: 4, ease: 'none', scrollTrigger: { trigger: sec, start: 'top top', end: 'bottom top', scrub: true } });

    /* The route crosses the scene. */
    if (path) {
      path.style.strokeDasharray = '1 1.01';
      gsap.fromTo(path, { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: 'none', scrollTrigger: { trigger: sec, start: 'top 55%', end: 'bottom 85%', scrub: 0.6 } });
    }

    riseIn($('.cine-finale-copy', sec), '.cine-lede, .cine-cta, .cine-news');
    const cardEl = $('.cine-contact .contact-form-card', sec);
    if (cardEl) gsap.fromTo(cardEl, { opacity: 0, y: 90, rotationY: small ? 0 : -10, transformPerspective: 1600 }, {
      opacity: 1, y: 0, rotationY: 0, duration: 1.5, ease: 'expo.out',
      scrollTrigger: { trigger: cardEl, start: 'top 88%', toggleActions: 'play none none none' },
    });
    const plan = $('#cinePlanBtn');
    if (plan) gsap.fromTo(plan, { scale: 0.86 }, { scale: 1, duration: 1.4, ease: 'elastic.out(1, 0.6)', scrollTrigger: { trigger: plan, start: 'top 92%' } });

    /* The footer: its columns rise into view, one after another. */
    const foot = $('.jw-footer');
    if (foot) {
      const cols = $$('.jw-f-grid > *', foot);
      gsap.fromTo(cols, { opacity: 0, y: 40 }, {
        opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.08,
        scrollTrigger: { trigger: foot, start: 'top 85%', toggleActions: 'play none none none' },
      });
      gsap.to($('.cine-finale-grid', sec), { y: small ? -30 : -80, ease: 'none', scrollTrigger: { trigger: sec, start: 'bottom bottom', end: 'bottom top', scrub: true } });
    }
  }

  /* =========================================================================
     THE "PLAN YOUR JOURNEY" ENTRY POINT
     =========================================================================
     "Ready to go?" offers one form — the existing Get in touch card beside it.
     The button is an anchor to #contact, so the browser already scrolls there
     (smoothly; scroll-behavior is auto under reduced motion). This only adds
     what an anchor cannot: it moves the keyboard into the first field once the
     form is in view, so "Plan your journey" opens the traveller straight into
     it. preventScroll keeps that focus from fighting the anchor's own scroll.
     No second form, no state swap — the same card, reached deliberately. */
  function setupPlanCta() {
    const plan = $('#cinePlanBtn');
    const form = $('#contactForm');
    if (!plan || !form || plan.dataset.planBound) return;
    plan.dataset.planBound = '1';
    plan.addEventListener('click', () => {
      const first = form.querySelector('input, textarea, select');
      if (!first) return;
      /* After the anchor's smooth scroll settles; preventScroll so focusing
         does not yank the page past where the scroll is heading. */
      setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }, 600);
    });
  }

  /* =========================================================================
     ENTRY
     ========================================================================= */
  function init() {
    setupHeader();
    setupTabs();
    setupHero();
    setupPlanCta();
    if (!hasGsap) return;
    setupBridge();
    riseIn($('#cineDestHead'), '.cine-lede');
    setupWhy();
    setupFinale();
    /* Fonts change line heights, and the shelf changes the page length when
       it lands: measure once more when both have settled. */
    window.addEventListener('load', () => ScrollTrigger.refresh());
  }

  /* RETURNING TO THIS PAGE. A back/forward-cache restore (pageshow.persisted)
     re-shows the frozen DOM without re-running init or the intro, so anything
     the intro had not yet revealed — the card, the photograph — could come
     back stuck at opacity 0, and every scrubbed trigger holds stale measures
     from the scroll position we left. Jump the intro to its finished frame so
     nothing is left hidden, then refresh so the scroll-linked motion recomputes
     against the restored scroll. init runs once per real load, so this adds no
     duplicate listeners. */
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted || !hasGsap) return;
    if (introTl) introTl.progress(1);
    ScrollTrigger.refresh(true);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  return { cards };
})();
