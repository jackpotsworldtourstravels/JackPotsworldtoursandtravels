'use strict';
/* ===========================================================================
   home-cinema.js — the homepage's motion: one engine, GSAP + ScrollTrigger.
   ===========================================================================
   WHAT IT DRIVES, in the order the page is read:

     1. the opening sequence   photograph develops, eyebrow, headline lines,
                               the globe's route draws, a marker flies it,
                               the search card rises, the CTA comes alive
     2. the hero on scroll     the frame recedes, the photograph drifts and
                               scales, the copy lifts away faster, the card
                               tips back, the globe turns
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

   THE GLOBE IS NOT A LOOP. It is a 2D canvas redrawn only when something
   it shows has changed — the opening tween, a scroll position, the pointer.
   When the hero is off screen nothing asks it to draw. On a phone it is
   drawn once, still.

   REDUCED MOTION: nothing here runs except a single still render of the
   globe and the route; every element keeps its resting, visible state.

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

  /* A phone gets lighter motion: shorter travel, no 3D tilt, no pointer
     response and a still globe. Read once — a desktop resized down keeps
     its triggers, which only means slightly more motion than a phone. */
  const small = window.matchMedia('(max-width: 900px)').matches;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  /* =========================================================================
     THE GLOBE
     =========================================================================
     An orthographic dot globe on a <canvas>: land as a field of gold points,
     a graticule, an atmosphere, and the route Hyderabad -> Dubai -> Maldives
     -> Bali drawn as raised great-circle arcs.

     LAND is a 180x90 bitfield (2-degree cells) rasterised from world-atlas's
     land-110m (ISC) — 2.7KB of base64 instead of a geodata download. */
  const LAND = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/h///oAAAAAAAAAAAAAAAAAAAAAAAJ8H///wAA6AAAAAAAAAAAAAAAAAAAAAAP///wAAAAAAAAAAAAAAAAAAAAAAAAAAP//gAAAAAAAAH/gAAAAAAAAADwGi4AP//AAAAAAEAD//+IAAAAADwAAPwx/AD/+gAAAAAADf///8j4AAAP/x/f7xnwH//AAAAAAAAAAAAAAAAAB///////////////AAIAAAAAAAAAAAAH/////9x4D8AcABBhwAAAAAAAAAAAAH/////gAAB4AAAD5////////////8AP8////gHAAQAAAH5P/////////+DAABgD///gHkAAAAAEwP////////8AIAAAAA///wD+AAAAGAw/////////4A8AAAAAf//+H/AAAACCB/////////wAwAAAAAP///n/wAAATH//////////8AgAAAAAP////5QAAAAP//////////9AAAAAAAB////wQAAAA///////////8AAAAAAAD////4AAAAB//4fH//////4AAAAAAAD////0AAAAB9fweH//////wAAAAAAAD////gAAAAJgnwHP/////+BAAAAAAAD///+AAAAAfCTTHH/////cCAAAAAAAD///8AAAAAfACf/H////+MAAAAAAAAB///8AAAAAAAAC/H////+EEAAAAAAAA///4AAAAAF+AA///////AQAAAAAAAAf//wAAAAAP+AA///////BAAAAAAAAAP/5gAAAAAf/zh/f/////gAAAAAAAAAD/AAAAAAAf//9/P/////gAAAAAAAAAB+AQAAAAB///+/D/////AAAAAAAAAAA+AAAAAAD///+fwD///+AAAAAAAAAAAeAAAAAAD////f+B/7/4AAAAAAAAAAAeAAAAAAD////P+A/j+AAAAAAAAAAAAPEAAAAAD////n8A/B+AAAAAAAAAAAAB8AAAAAD////nwAeBeAgAAAAAAAAAAAPAAAAAD////3AAcAfAgAAAAAAAAAAABAAAAAD////4AAcAXgAAAAAAAAAAAABAAAAAB////4AAMASAQAAAAAAAAAAAAj+AAAB/////gAAAQAAAAAAAAAAAAAAH/gAAA/v///AACAAAIAAAAAAAAAAAAH/4AAAAD///AAAAICAAAAAAAAAAAAAH/8AAAAB//+AAAAUGAAAAAAAAAAAAAP/+AAAAB//4AAAAIeAAAAAAAAAAAAAP//AAAAB//4AAAAMcAAAAAAAAAAAAAP//wAAAB//wAAAAGEAsAAAAAAAAAAAf//+AAAA//gAAAACAAHgAAAAAAAAAAP///gAAA//gAAAAAAAHQAAAAAAAAAAH///AAAA//wAAAAAAAAAAAAAAAAAAAH//+AAAAf/wAAAAAAAAAAAAAAAAAAAD//+AAAAf/wgAAAAABxAAAAAAAAAAAB//+AAAA//wgAAAAAFxAAAAAAAAAAAA//8AAAA//jgAAAAAf/gAAAAAAAAAAAf/8AAAA/+DAAAAAAf/gAAAAAAAAAAAf/8AAAAf+DAAAAAB//wAAAAAAAAAAAf/gAAAAf/DAAAAAH//4AAAAAAAAAAAf/AAAAAf8AAAAAAH//8AAAAAAAAAAAf/AAAAAP8AAAAAAH//+AAAAAAAAAAA/+AAAAAP4AAAAAAH//+AAAAAAAAAAA/8AAAAAH4AAAAAAD8/8AAAAAAAAAAA/4AAAAAHgAAAAAADwX8AAAAAAAAAAA/gAAAAAAAAAAAAAAAD4AAAAAAAAAAB/gAAAAAAAAAAAAAAAD4AAAAAAAAAAB+AAAAAAAAAAAAAAAAAAAGAAAAAAAAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAgAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAEYRwAAAAAAAAAAAAIAAAAAAAAH/8H/////wAAAAAAAAAAA+AAAAAG+///8f//////4AAAAAAAGAAOAAAA///////////////AAAAD68D//wAAAD//////////////8AAAB/////8AAAD///////////////8AAAD/////4ABwH///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const CITIES = [
    { name: 'HYDERABAD', lat: 17.385, lon: 78.487 },
    { name: 'DUBAI',     lat: 25.205, lon: 55.271 },
    { name: 'MALDIVES',  lat: 4.175,  lon: 73.509 },
    { name: 'BALI',      lat: -8.340, lon: 115.092 },
  ];
  const RAD = Math.PI / 180;

  function Globe(canvas) {
    const ctx = canvas.getContext('2d');
    const state = { lon: 86, lat: 8, draw: 0, marker: 0, mx: 0, my: 0, spin: 0, zoom: 1 };
    let W = 0, H = 0, dpr = 1, queued = false;

    /* Land points, as precomputed sines and cosines. */
    const pts = [];
    (function decode() {
      const bin = atob(LAND);
      const cols = 180, rows = 90;
      for (let j = 0; j < rows; j++) {
        const lat = 90 - (j + 0.5) * 2;
        if (lat > 76 || lat < -58) continue;          // the ice caps read as noise
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          if (!((bin.charCodeAt(k >> 3) >> (7 - (k & 7))) & 1)) continue;
          const lon = -180 + (i + 0.5) * 2;
          pts.push(Math.cos(lat * RAD), Math.sin(lat * RAD), Math.cos(lon * RAD), Math.sin(lon * RAD));
        }
      }
    })();
    const P = new Float32Array(pts);

    /* A point on the unit sphere as [x, y, z] for (lat, lon). */
    const vec = (lat, lon) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.sin(lat * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD)];

    /* The route: each leg a great circle, slerped, lifted off the surface
       in the middle so it reads as a flight, not a road. */
    const legs = [];
    for (let c = 0; c < CITIES.length - 1; c++) {
      const a = vec(CITIES[c].lat, CITIES[c].lon), b = vec(CITIES[c + 1].lat, CITIES[c + 1].lon);
      const dot = Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
      const om = Math.acos(dot), so = Math.sin(om);
      const leg = [];
      for (let s = 0; s <= 60; s++) {
        const t = s / 60, f1 = Math.sin((1 - t) * om) / so, f2 = Math.sin(t * om) / so;
        const lift = 1 + 0.16 * om * Math.sin(Math.PI * t);
        const x = (f1 * a[0] + f2 * b[0]) * lift, y = (f1 * a[1] + f2 * b[1]) * lift, z = (f1 * a[2] + f2 * b[2]) * lift;
        leg.push([x, y, z]);
      }
      legs.push(leg);
    }

    /* The graticule: meridians and parallels every 20 degrees. */
    const grat = [];
    for (let lon = -180; lon < 180; lon += 20) {
      const line = []; for (let lat = -80; lat <= 80; lat += 4) line.push(vec(lat, lon)); grat.push(line);
    }
    for (let lat = -60; lat <= 60; lat += 20) {
      const line = []; for (let lon = -180; lon <= 180; lon += 4) line.push(vec(lat, lon)); grat.push(line);
    }

    let R = 0, cx = 0, cy = 0, c0 = 1, s0 = 0, cp = 1, sp = 0;
    function frame() {
      const lon0 = (state.lon + state.mx + state.spin) * RAD, lat0 = (state.lat + state.my) * RAD;
      c0 = Math.cos(lon0); s0 = Math.sin(lon0); cp = Math.cos(lat0); sp = Math.sin(lat0);
      R = Math.min(W, H) * 0.39 * state.zoom; cx = W / 2; cy = H / 2;
    }
    /* Rotate a world vector into view space: spin about the axis, then tilt. */
    function view(x, y, z) {
      const xr = x * c0 + z * s0, zr = -x * s0 + z * c0;       // yaw: lon0 to the front
      return [zr, y * cp - xr * sp, y * sp + xr * cp];           // tilt: lat0 to the centre
    }

    function draw() {
      queued = false;
      if (!W) return;
      frame();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      /* Atmosphere and body. */
      const halo = ctx.createRadialGradient(cx, cy, R * 0.86, cx, cy, R * 1.34);
      halo.addColorStop(0, 'rgba(217,178,111,0.20)');
      halo.addColorStop(0.35, 'rgba(120,150,210,0.08)');
      halo.addColorStop(1, 'rgba(120,150,210,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.34, 0, Math.PI * 2); ctx.fill();
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
      body.addColorStop(0, 'rgba(40,58,92,0.38)');
      body.addColorStop(1, 'rgba(6,10,18,0.62)');
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(240,217,166,0.28)'; ctx.lineWidth = 1; ctx.stroke();

      /* Graticule, front hemisphere only. */
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.8;
      for (const line of grat) {
        ctx.beginPath(); let pen = false;
        for (const v of line) {
          const p = view(v[0], v[1], v[2]);
          if (p[2] <= 0) { pen = false; continue; }
          const x = cx + p[0] * R, y = cy - p[1] * R;
          if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
        }
        ctx.stroke();
      }

      /* Land, in four brightness bands so the fill style changes four times
         a frame rather than four thousand. */
      const bands = [[], [], [], []];
      for (let i = 0; i < P.length; i += 4) {
        const cl = P[i], sl = P[i + 1], x = cl * P[i + 2], z = cl * P[i + 3];
        const p = view(x, sl, z);
        if (p[2] <= 0.02) continue;
        bands[Math.min(3, (p[2] * 4) | 0)].push(cx + p[0] * R, cy - p[1] * R, p[2]);
      }
      const alpha = [0.18, 0.32, 0.5, 0.72];
      for (let b = 0; b < 4; b++) {
        ctx.fillStyle = 'rgba(232,200,140,' + alpha[b] + ')';
        const arr = bands[b];
        for (let i = 0; i < arr.length; i += 3) {
          const s = 0.9 + arr[i + 2] * 1.3;
          ctx.fillRect(arr[i] - s / 2, arr[i + 1] - s / 2, s, s);
        }
      }

      /* The route, drawn up to `draw` (0..3 legs). */
      const proj = v => { const p = view(v[0], v[1], v[2]); return [cx + p[0] * R, cy - p[1] * R, p[2]]; };
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let l = 0; l < legs.length; l++) {
        const amt = Math.max(0, Math.min(1, state.draw - l));
        if (!amt) break;
        const leg = legs[l], n = Math.max(1, Math.round(amt * (leg.length - 1)));
        for (const pass of [[6, 'rgba(240,217,166,0.14)'], [1.8, 'rgba(246,226,184,0.95)']]) {
          ctx.lineWidth = pass[0]; ctx.strokeStyle = pass[1];
          ctx.beginPath(); let pen = false;
          for (let s = 0; s <= n; s++) {
            const p = proj(leg[s]);
            if (p[2] < -0.1) { pen = false; continue; }
            if (pen) ctx.lineTo(p[0], p[1]); else { ctx.moveTo(p[0], p[1]); pen = true; }
          }
          ctx.stroke();
        }
      }

      /* Cities: a dot, a ring once the route has reached them, a label. */
      ctx.font = '600 10px Montserrat, sans-serif';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '2.5px';
      CITIES.forEach((c, i) => {
        const p = proj(vec(c.lat, c.lon));
        if (p[2] <= 0.05) return;
        const reached = state.draw >= i - 0.02;
        ctx.fillStyle = reached ? '#fff3d6' : 'rgba(255,255,255,0.45)';
        ctx.beginPath(); ctx.arc(p[0], p[1], reached ? 3.4 : 2.2, 0, Math.PI * 2); ctx.fill();
        if (reached) {
          ctx.strokeStyle = 'rgba(240,217,166,0.55)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(p[0], p[1], 9, 0, Math.PI * 2); ctx.stroke();
          /* No names on a phone: there the globe sits behind the copy and
             the labels would collide with it. The dots and arcs stay. */
          if (small) return;
          ctx.fillStyle = 'rgba(255,255,255,' + (0.45 + 0.5 * p[2]) + ')';
          const right = i === 0 || i === 3;
          ctx.textAlign = right ? 'left' : 'right';
          ctx.fillText(c.name, p[0] + (right ? 16 : -16), p[1] + 3.5);
        }
      });

      /* The marker flying the route. */
      if (state.marker > 0.001 && state.marker < 2.999) {
        const l = Math.min(2, Math.floor(state.marker)), t = state.marker - l;
        const leg = legs[l], f = t * (leg.length - 1), s = Math.floor(f), u = f - s;
        const a = leg[s], b = leg[Math.min(leg.length - 1, s + 1)];
        const p = proj([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
        if (p[2] > -0.1) {
          const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 16);
          g.addColorStop(0, 'rgba(255,244,214,0.95)'); g.addColorStop(1, 'rgba(255,244,214,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p[0], p[1], 16, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    function render() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(draw);
    }
    function resize() {
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      render();
    }
    resize();
    return { state, render, resize };
  }

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
  function setupHero(globe) {
    const hero = $('#home');
    if (!hero) return;
    const stage = $('#cineStage'), media = $('.cine-media', hero), photo = $('.cine-photo', hero);
    const canvas = $('#cineGlobe'), copy = $('#cineCopy'), dock = $('#heroSearchDock');
    const eyebrow = $('.cine-eyebrow', hero), rule = $('.cine-eyebrow .cine-rule', hero);
    const lines = $$('.cine-title .cine-line > span', hero), ctaRow = $('.cine-cta-row', hero);
    const cue = $('.cine-scroll-cue', hero), nav = $('#siteHeader .jw-hdr__bar');
    const card = $('.search-card', dock), go = $('.search-go', dock);

    if (!motion) {
      if (globe) { globe.state.draw = 3; globe.state.marker = 0; globe.render(); }
      return;
    }

    /* --- 1. the opening sequence ----------------------------------------
       Timed to the brief: dark frame at 0, the photograph developing from
       0.2, eyebrow 0.4, the two headline lines 0.6 on their own beats, the
       route from 0.9, the marker from 1.2, the card 1.4, the CTA 1.6. */
    const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
    tl.fromTo(photo, { opacity: 0, scale: 1.16, filter: 'blur(18px) brightness(.45)' },
                     { opacity: 1, scale: 1, filter: 'blur(0px) brightness(1)', duration: 2.4, ease: 'power2.out', clearProps: 'filter' }, 0.2)
      .fromTo(nav, { opacity: 0, y: -18 }, { opacity: 1, y: 0, duration: 1.2, clearProps: 'transform' }, 0.3)
      .fromTo(eyebrow, { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 1.2 }, 0.4)
      .fromTo(rule, { scaleX: 0 }, { scaleX: 1, duration: 1.4 }, 0.45)
      /* y: 0 BOTH ENDS. The CSS pre-state is translateY(112%), which GSAP
         reads back as a pixel `y`; without zeroing it the lines would land
         a full line-height low, inside their masks, invisible. */
      .fromTo(lines, { y: 0, yPercent: 112, rotation: 2.5 }, { y: 0, yPercent: 0, rotation: 0, duration: 1.5, stagger: 0.16 }, 0.6)
      .fromTo(canvas, { opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1, duration: 2.2 }, 0.5)
      .fromTo(dock, { opacity: 0, y: 90 }, { opacity: 1, y: 0, duration: 1.6 }, 1.4)
      .add(() => card && card.classList.add('cine-glint'), 1.55)
      .fromTo(ctaRow, { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 1.2 }, 1.6)
      .add(() => go && go.classList.add('cine-live'), 1.75)
      .fromTo(cue, { opacity: 0 }, { opacity: 1, duration: 1 }, 2.1);
    if (globe) {
      globe.state.spin = -38;
      tl.to(globe.state, { spin: 0, duration: 3, ease: 'power3.out', onUpdate: globe.render }, 0.5)
        .to(globe.state, { draw: 3, duration: 1.9, ease: 'power2.inOut', onUpdate: globe.render }, 0.9)
        .to(globe.state, { marker: 2.999, duration: 2.6, ease: 'power2.inOut', onUpdate: globe.render }, 1.2);
    }
    /* The timeline now holds the starting frame inline; the CSS pre-state
       can go. */
    unpre();

    /* --- 2. the hero on scroll -------------------------------------------
       Transform-only: the stage recedes into the night (its rounded foot
       becomes a frame), the photograph drifts down and in, the copy leaves
       faster than the page, the card tips back, the globe turns. */
    const st = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: hero, start: 'top top', end: 'bottom top', scrub: 0.7,
        onUpdate: self => {
          if (!globe || small) return;
          globe.state.lon = 86 + self.progress * 46;
          globe.state.lat = 8 - self.progress * 10;
          globe.state.zoom = 1 + self.progress * 0.18;
          globe.render();
        },
      },
    });
    st.to(stage, { scale: small ? 0.95 : 0.9 }, 0)
      .to(media, { yPercent: 12, scale: 1.12 }, 0)
      .to(copy, { y: small ? -80 : -170, opacity: 0, duration: 0.65 }, 0)
      .to(canvas, { y: small ? -40 : -120 }, 0)
      .to(dock, small ? { yPercent: -6, scale: 0.96 } : { yPercent: -10, scale: 0.93, rotationX: 12, transformPerspective: 1400 }, 0)
      .to(cue, { opacity: 0, duration: 0.12 }, 0);

    /* --- the pointer: the globe leans toward it, a little ---------------- */
    if (globe && fine && !small) {
      const mx = gsap.quickTo(globe.state, 'mx', { duration: 1.4, ease: 'power3.out', onUpdate: globe.render });
      const my = gsap.quickTo(globe.state, 'my', { duration: 1.4, ease: 'power3.out', onUpdate: globe.render });
      hero.addEventListener('pointermove', e => {
        if (window.scrollY > hero.offsetHeight) return;
        mx((e.clientX / window.innerWidth - 0.5) * 16);
        my((e.clientY / window.innerHeight - 0.5) * -10);
      });
    }
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

    /* The footer: its gold rule draws across as it rises, and the columns
       follow, one after another. */
    const foot = $('.jw-footer');
    if (foot) {
      gsap.fromTo(foot, { '--cn-rule': 0 }, { '--cn-rule': 1, ease: 'none', scrollTrigger: { trigger: foot, start: 'top bottom', end: 'top 55%', scrub: 0.5 } });
      const cols = $$('.jw-f-grid > *', foot);
      gsap.fromTo(cols, { opacity: 0, y: 40 }, {
        opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.08,
        scrollTrigger: { trigger: foot, start: 'top 85%', toggleActions: 'play none none none' },
      });
      gsap.to($('.cine-finale-grid', sec), { y: small ? -30 : -80, ease: 'none', scrollTrigger: { trigger: sec, start: 'bottom bottom', end: 'bottom top', scrub: true } });
    }
  }

  /* =========================================================================
     ENTRY
     ========================================================================= */
  function init() {
    setupHeader();
    setupTabs();
    const canvas = $('#cineGlobe');
    let globe = null;
    try { globe = canvas && canvas.getContext ? Globe(canvas) : null; } catch (e) { globe = null; }
    if (globe) {
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(globe.render);
      window.addEventListener('resize', () => globe.resize());
    }
    setupHero(globe);
    if (!hasGsap) return;
    setupBridge();
    riseIn($('#cineDestHead'), '.cine-lede');
    setupWhy();
    setupFinale();
    /* Fonts change line heights, and the shelf changes the page length when
       it lands: measure once more when both have settled. */
    window.addEventListener('load', () => ScrollTrigger.refresh());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  return { cards };
})();
