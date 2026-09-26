'use strict';
/* ===========================================================================
   jw-loader.js — the JackPots World branded travel loader. One component.
   ===========================================================================
   THE SITE ALREADY HAS A LOADING LANGUAGE, and this does not replace it. Flight,
   hotel and package LISTS paint content-shaped skeletons (travel-explore.js,
   hotel-results.js, package-listing.js): a skeleton preserves the layout and
   never blocks, which is exactly what a results grid wants and exactly what the
   brief's own performance rules ask for. Nothing here touches those.

   WHERE THIS BELONGS INSTEAD is the blocking, content-less wait — the moment a
   payment is being confirmed or a booking finalised, where there is no list to
   shape and the traveller must simply be told "we are working on it". That is
   the one place a branded animation earns its keep, and it is where this is
   wired (payment-screen.js).

   NO NEW DEPENDENCY. The globe and the aeroplane are CSS and inline SVG — no
   Lottie, no GSAP, no image to fetch. It follows spinner.js's precedent of a
   component that injects its own <style> once, so a single <script> makes it
   available on a page with no CSS wiring to keep in step.

   ONLY transform and opacity animate, so the whole thing stays on the compositor
   at 60fps. Reduced motion is honoured: the orbit and spin freeze to a still
   globe-and-plane, which reads perfectly well as "loading" without moving.
   =========================================================================== */
(function (global) {
  const STYLE_ID = 'jw-loader-style';

  /* The self-contained stylesheet, injected once. Every colour is a soft blue on
     white — no black, no gold — with a single coral accent for the aeroplane so
     the loader still reads as JackPots. */
  const CSS = `
  .jwl{display:flex; flex-direction:column; align-items:center; justify-content:center;
       gap:18px; text-align:center; color:#1f3b57;}
  .jwl-stage{position:relative; width:120px; height:120px; display:grid; place-items:center;}
  /* THE GLOBE — a soft-blue sphere. The radial highlight sits top-left so it
     reads as lit from one side rather than as a flat disc. */
  .jwl-globe{position:relative; width:84px; height:84px; border-radius:50%;
     background:radial-gradient(circle at 32% 28%, #eaf4ff 0%, #9cc7ef 42%, #4f8fc9 76%, #3a6f9e 100%);
     box-shadow:inset -6px -8px 16px rgba(23,58,94,.35), 0 8px 22px -8px rgba(35,90,140,.5);
     overflow:hidden;}
  /* Longitude lines, faked with two thin ellipses whose horizontal scale
     breathes — the cheapest convincing "this sphere is turning" there is. */
  .jwl-globe::before, .jwl-globe::after{content:''; position:absolute; inset:6px;
     border-radius:50%; border:1.5px solid rgba(255,255,255,.5);
     animation:jwlSpin 2.4s ease-in-out infinite;}
  .jwl-globe::after{inset:6px 26px; animation-delay:-1.2s;}
  /* A couple of faint landmasses, so it is a world and not a marble. */
  .jwl-land{position:absolute; background:rgba(96,150,110,.55); border-radius:40% 55% 50% 45%;}
  .jwl-land.a{width:26px; height:20px; top:18px; left:14px; transform:rotate(-12deg);}
  .jwl-land.b{width:20px; height:16px; bottom:16px; right:16px; border-radius:55% 45% 50% 50%;}
  /* THE ORBIT — an invisible ring the aeroplane rides. It is the ring that
     rotates; the plane sits at its top and is carried round, so one keyframe
     drives the whole flight. */
  .jwl-orbit{position:absolute; inset:0; animation:jwlOrbit 3s linear infinite;}
  .jwl-plane{position:absolute; top:-2px; left:50%; width:26px; height:26px; margin-left:-13px;
     display:grid; place-items:center; color:#e8604c;
     filter:drop-shadow(0 3px 5px rgba(35,90,140,.4));}
  .jwl-plane svg{width:22px; height:22px; transform:rotate(45deg);}
  /* The dotted trail the plane leaves, a faint ring inside the orbit. */
  .jwl-trail{position:absolute; inset:8px; border-radius:50%;
     border:1.5px dashed rgba(79,143,201,.35);}

  .jwl-logo{height:30px; width:auto; object-fit:contain; opacity:.95;}
  .jwl-text{margin:0; font-size:15px; font-weight:600; letter-spacing:.01em; color:#274866;
     min-height:1.2em;}
  .jwl-sub{margin:-8px 0 0; font-size:12.5px; color:#6b8299;}

  /* SUCCESS / ERROR — the globe gives way to a drawn tick or cross. The stage
     keeps its size so nothing around it jumps when the state changes. */
  .jwl-mark{position:absolute; inset:0; display:none; place-items:center;}
  .jwl-mark svg{width:64px; height:64px; fill:none; stroke-width:5.5;
     stroke-linecap:round; stroke-linejoin:round;}
  .jwl-mark svg path, .jwl-mark svg circle{stroke-dasharray:120; stroke-dashoffset:120;
     animation:jwlDraw .55s cubic-bezier(.65,0,.35,1) forwards;}
  .jwl.is-success .jwl-globe, .jwl.is-success .jwl-orbit,
  .jwl.is-error .jwl-globe, .jwl.is-error .jwl-orbit{display:none;}
  .jwl.is-success .jwl-mark-ok, .jwl.is-error .jwl-mark-bad{display:grid;}
  .jwl.is-success .jwl-mark-ok svg{stroke:#2e9c6f;}
  .jwl.is-error .jwl-mark-bad svg{stroke:#d64545;}

  /* THE FULL-SCREEN OVERLAY, for a wait that owns the whole page (a booking
     being finalised). White with the softest blue wash, blurred page behind. */
  .jwl-overlay{position:fixed; inset:0; z-index:4000; display:flex; align-items:center;
     justify-content:center; padding:24px;
     background:radial-gradient(circle at 50% 38%, #ffffff 0%, #eef5fd 55%, #e4eefaef 100%);
     backdrop-filter:blur(3px); opacity:0; animation:jwlFade .25s ease forwards;}
  .jwl-overlay .jwl{max-width:340px;}

  @keyframes jwlOrbit{to{transform:rotate(360deg);}}
  @keyframes jwlSpin{0%,100%{transform:scaleX(1);} 50%{transform:scaleX(.15);}}
  @keyframes jwlDraw{to{stroke-dashoffset:0;}}
  @keyframes jwlFade{to{opacity:1;}}

  /* A single 200ms lift when a loader mounts inline, so it does not just pop. */
  .jwl-in{animation:jwlIn .28s ease;}
  @keyframes jwlIn{from{opacity:0; transform:translateY(6px);} to{opacity:1; transform:none;}}

  @media (max-width:480px){
    .jwl-stage{width:104px; height:104px;}
    .jwl-globe{width:74px; height:74px;}
    .jwl-text{font-size:14px;}
  }
  @media (prefers-reduced-motion:reduce){
    .jwl-orbit, .jwl-globe::before, .jwl-globe::after, .jwl-overlay, .jwl-in{animation:none !important;}
    .jwl-overlay{opacity:1;}
    .jwl-mark svg path, .jwl-mark svg circle{stroke-dashoffset:0; animation:none;}
  }`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /* A pleasant default line per context, so a caller can pass a key instead of a
     sentence. Any explicit `text` wins over these. */
  const MESSAGES = {
    flights: 'Finding the best flights…',
    hotels: 'Finding perfect stays…',
    packages: 'Creating your travel experience…',
    destinations: 'Mapping your destination…',
    payment: 'Confirming your booking…',
    booking: 'Finalising your booking…',
    default: 'Preparing your journey…',
  };

  const PLANE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z"/></svg>';

  /** The loader's inner markup, so any host (the payment screen, a card, an
   *  overlay) can drop the same globe-and-plane in wherever it needs it. */
  function markup(opts) {
    const o = opts || {};
    const text = o.text || MESSAGES[o.context] || MESSAGES.default;
    const sub = o.sub ? `<p class="jwl-sub">${escapeText(o.sub)}</p>` : '';
    const logo = o.logo === false ? ''
      : `<img class="jwl-logo" src="assets/images/jackpots-logo-full.png" alt=""
             onerror="this.remove()">`;
    ensureStyle();
    return `<div class="jwl jwl-in" role="status" aria-live="polite">
      ${logo}
      <div class="jwl-stage">
        <div class="jwl-globe"><span class="jwl-land a"></span><span class="jwl-land b"></span></div>
        <div class="jwl-trail" aria-hidden="true"></div>
        <div class="jwl-orbit" aria-hidden="true"><span class="jwl-plane">${PLANE}</span></div>
        <div class="jwl-mark jwl-mark-ok" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M18 34l10 10 20-24"/></svg></div>
        <div class="jwl-mark jwl-mark-bad" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M20 20l24 24M44 20L20 44"/></svg></div>
      </div>
      <p class="jwl-text">${escapeText(text)}</p>
      ${sub}
    </div>`;
  }

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** Render the loader into a host element (string id or node). Returns the
   *  `.jwl` node so a caller can flip it to success/error later. */
  function mount(host, opts) {
    const el = typeof host === 'string' ? document.getElementById(host) : host;
    if (!el) return null;
    el.innerHTML = markup(opts);
    return el.querySelector('.jwl');
  }

  let overlayEl = null;

  /** A full-screen branded wait, for a blocking moment that owns the page. */
  function show(opts) {
    ensureStyle();
    hide();
    overlayEl = document.createElement('div');
    overlayEl.className = 'jwl-overlay';
    overlayEl.setAttribute('role', 'status');
    overlayEl.innerHTML = markup(opts);
    document.body.appendChild(overlayEl);
    return overlayEl.querySelector('.jwl');
  }

  /** Flip a mounted loader (or the overlay) to its success state, with a line. */
  function toState(node, cls, text) {
    const jwl = resolve(node);
    if (!jwl) return;
    jwl.classList.remove('is-success', 'is-error');
    jwl.classList.add(cls);
    const t = jwl.querySelector('.jwl-text');
    if (t && text != null) t.textContent = text;
  }
  const success = (node, text) => toState(node, 'is-success', text);
  const error = (node, text) => toState(node, 'is-error', text);

  function resolve(node) {
    if (node && node.classList && node.classList.contains('jwl')) return node;
    if (overlayEl) return overlayEl.querySelector('.jwl');
    return document.querySelector('.jwl');
  }

  /** Take the overlay down. Inline loaders are removed by their own host. */
  function hide() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  global.JWLoader = { markup, mount, show, success, error, hide, MESSAGES };
})(window);
