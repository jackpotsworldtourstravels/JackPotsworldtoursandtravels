'use strict';
/* ===========================================================================
   hotel-gallery.js — a photograph viewer that is correct at one image.
   ===========================================================================
   ONE IMAGE IS THE NORMAL CASE, NOT A DEGENERATE ONE. `HotelDetail.images` is
   an array and today every property has exactly one entry in it. A gallery
   that only works at three or more would mean building it twice — once for now
   and once later — so this is written for n images and hides whatever n does
   not justify:

       n = 0   nothing renders at all; the caller's section disappears
       n = 1   the frame, and no thumbnails, no arrows, no counter — a strip of
               one thumbnail under a photograph is furniture that says nothing
       n > 1   thumbnails, arrows, counter, keyboard and swipe

   Nothing here needs changing the day the API returns eight images: the same
   call renders the fuller thing.

   LAZY BY DEFAULT. Only the visible frame is eager; every other frame and every
   thumbnail carries loading="lazy", so an expanded card does not fetch a
   megabyte of photographs the traveller may never scroll to.

   THE FULLSCREEN VIEWER IS A DIALOG. Arrow keys move, Escape closes, focus is
   trapped while it is open and restored to whatever opened it — a lightbox that
   drops focus at <body> is one a keyboard cannot leave.
   =========================================================================== */

const HotelGallery = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

  const DIR = () => (typeof HOTEL_IMAGE_DIR === 'string' ? HOTEL_IMAGE_DIR : 'assets/hotels/');
  const KNOWN = key => (typeof HOTEL_IMAGE_FILES !== 'undefined' && HOTEL_IMAGE_FILES[key]);
  const FALLBACK = () => (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');

  /** An image key from the API -> the vendored file, or the shared fallback.
   *  Unknown keys resolve rather than 404: the API may name a property we have
   *  no photograph of, and a broken image is worse than a generic one. */
  const slugFor = key => (KNOWN(key) ? key : FALLBACK());

  function frameHtml(key, alt, eager) {
    const slug = slugFor(key);
    const dir = DIR();
    return `<img src="${esc(dir + slug + '.webp')}"
      srcset="${esc(dir + slug + '-480.webp')} 480w, ${esc(dir + slug + '.webp')} 1024w"
      sizes="(max-width: 760px) 92vw, 620px"
      alt="${esc(alt)}" decoding="async"
      loading="${eager ? 'eager' : 'lazy'}">`;
  }

  /** The image keys a property actually has, de-duplicated and never empty of
   *  meaning: `images` when the detail endpoint sent any, otherwise the single
   *  `image` the results row already carried. */
  function keysOf(hotel, detail) {
    const many = (detail && Array.isArray(detail.images) ? detail.images : []).filter(Boolean);
    const one = (detail && detail.image) || (hotel && hotel.imageKey);
    const all = many.length ? many : (one ? [one] : []);
    return [...new Set(all)];
  }

  let seq = 0;

  /** Build the gallery markup. Returns '' when there is nothing to show, so a
   *  caller can conditionally drop its whole section on a falsy check. */
  function html(hotel, detail) {
    const keys = keysOf(hotel, detail);
    if (!keys.length) return '';
    const name = (hotel && hotel.name) || (detail && detail.name) || 'Property';
    const id = `hg-${++seq}`;
    const multi = keys.length > 1;

    const frames = keys.map((k, i) => `
      <figure class="hg-frame${i === 0 ? ' is-active' : ''}" data-hg-frame="${i}"${i === 0 ? '' : ' aria-hidden="true"'}>
        ${frameHtml(k, `${name} — photograph ${i + 1} of ${keys.length}`, i === 0)}
      </figure>`).join('');

    /* Everything below the frame exists only when there is more than one
       photograph to move between. */
    const controls = multi ? `
      <button type="button" class="hg-nav hg-prev" data-hg-step="-1" aria-label="Previous photograph">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <button type="button" class="hg-nav hg-next" data-hg-step="1" aria-label="Next photograph">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <p class="hg-counter" data-hg-counter aria-hidden="true">1 / ${keys.length}</p>` : '';

    const thumbs = multi ? `
      <div class="hg-thumbs" role="tablist" aria-label="Photographs of ${esc(name)}">
        ${keys.map((k, i) => `
          <button type="button" class="hg-thumb${i === 0 ? ' is-active' : ''}" role="tab"
                  aria-selected="${i === 0}" data-hg-go="${i}"
                  aria-label="Photograph ${i + 1} of ${keys.length}">
            <img src="${esc(DIR() + slugFor(k) + '-480.webp')}" alt="" loading="lazy" decoding="async">
          </button>`).join('')}
      </div>` : '';

    return `<div class="hg" id="${id}" data-hg data-hg-count="${keys.length}">
      <div class="hg-stage">
        ${frames}
        ${controls}
        <button type="button" class="hg-expand" data-hg-open aria-label="View photographs full screen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </div>
      ${thumbs}
      <span class="sr-only" role="status" data-hg-live></span>
    </div>`;
  }

  /* --------------------------------------------------------------------- */
  function frames(root) { return [...root.querySelectorAll('[data-hg-frame]')]; }

  function show(root, index) {
    const all = frames(root);
    if (!all.length) return;
    const n = all.length;
    const i = ((index % n) + n) % n;      // wrap both ways
    all.forEach((f, j) => {
      const on = j === i;
      f.classList.toggle('is-active', on);
      if (on) f.removeAttribute('aria-hidden'); else f.setAttribute('aria-hidden', 'true');
    });
    root.querySelectorAll('[data-hg-go]').forEach(t => {
      const on = Number(t.dataset.hgGo) === i;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    const counter = root.querySelector('[data-hg-counter]');
    if (counter) counter.textContent = `${i + 1} / ${n}`;
    /* Announced, because for a screen reader the picture changing is otherwise
       completely silent. */
    const live = root.querySelector('[data-hg-live]');
    if (live) live.textContent = `Photograph ${i + 1} of ${n}`;
    root.dataset.hgIndex = String(i);
  }

  const indexOf = root => Number(root.dataset.hgIndex || 0);

  /* ------------------------------------------------------------ fullscreen */
  let openRoot = null;
  let restoreFocus = null;

  function overlay() {
    let el = document.getElementById('hgOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'hgOverlay';
    el.className = 'hg-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Photograph viewer');
    el.hidden = true;
    el.innerHTML = `
      <button type="button" class="hg-close" data-hg-close aria-label="Close viewer">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <button type="button" class="hg-nav hg-prev" data-hg-ostep="-1" aria-label="Previous photograph">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="hg-overlay-stage" data-hg-ostage></div>
      <button type="button" class="hg-nav hg-next" data-hg-ostep="1" aria-label="Next photograph">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <p class="hg-overlay-counter" data-hg-ocounter></p>`;
    document.body.appendChild(el);
    return el;
  }

  function paintOverlay() {
    if (!openRoot) return;
    const el = overlay();
    const all = frames(openRoot);
    const i = indexOf(openRoot);
    const src = all[i] && all[i].querySelector('img');
    const stage = el.querySelector('[data-hg-ostage]');
    if (src && stage) {
      stage.innerHTML = `<img src="${esc(src.getAttribute('src'))}" alt="${esc(src.alt)}" decoding="async">`;
    }
    const c = el.querySelector('[data-hg-ocounter]');
    if (c) c.textContent = `${i + 1} / ${all.length}`;
    /* One photograph needs no arrows here either. */
    el.querySelectorAll('[data-hg-ostep]').forEach(b => { b.hidden = all.length < 2; });
    if (c) c.hidden = all.length < 2;
  }

  function openViewer(root) {
    openRoot = root;
    restoreFocus = document.activeElement;
    const el = overlay();
    el.hidden = false;
    document.body.classList.add('hg-locked');
    paintOverlay();
    el.querySelector('[data-hg-close]').focus();
  }

  function closeViewer() {
    const el = document.getElementById('hgOverlay');
    if (el) el.hidden = true;
    document.body.classList.remove('hg-locked');
    openRoot = null;
    /* Back to the control that opened it — a viewer that closes to <body> is
       one a keyboard user has to tab back into the page from. */
    if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
    restoreFocus = null;
  }

  /* ---------------------------------------------------------------- events
     Delegated on document once: galleries are rendered into cards that are
     themselves re-rendered, so per-instance listeners would be lost. */
  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;

    document.addEventListener('click', e => {
      const step = e.target.closest('[data-hg-step]');
      if (step) {
        const root = step.closest('[data-hg]');
        show(root, indexOf(root) + Number(step.dataset.hgStep));
        return;
      }
      const go = e.target.closest('[data-hg-go]');
      if (go) { show(go.closest('[data-hg]'), Number(go.dataset.hgGo)); return; }

      const open = e.target.closest('[data-hg-open]');
      if (open) { openViewer(open.closest('[data-hg]')); return; }

      const ostep = e.target.closest('[data-hg-ostep]');
      if (ostep && openRoot) {
        show(openRoot, indexOf(openRoot) + Number(ostep.dataset.hgOstep));
        paintOverlay();
        return;
      }
      if (e.target.closest('[data-hg-close]')) { closeViewer(); return; }
      /* The backdrop itself, but not the picture on it. */
      if (e.target.id === 'hgOverlay') closeViewer();
    });

    document.addEventListener('keydown', e => {
      if (openRoot) {
        if (e.key === 'Escape') { e.preventDefault(); closeViewer(); return; }
        if (e.key === 'ArrowRight') { show(openRoot, indexOf(openRoot) + 1); paintOverlay(); return; }
        if (e.key === 'ArrowLeft') { show(openRoot, indexOf(openRoot) - 1); paintOverlay(); return; }
        if (e.key === 'Tab') {
          /* Trap: the dialog's own controls are the whole tab ring. */
          const el = document.getElementById('hgOverlay');
          const focusables = [...el.querySelectorAll('button:not([hidden])')];
          if (!focusables.length) return;
          const first = focusables[0], last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        return;
      }
      /* Arrow keys move the gallery only while it actually holds focus, so
         they do not hijack the page's own scrolling. */
      const root = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest('[data-hg]') : null;
      if (!root || Number(root.dataset.hgCount) < 2) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); show(root, indexOf(root) + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(root, indexOf(root) - 1); }
    });

    /* Swipe. Pointer events rather than touch*, so a trackpad drag and a
       finger are the same gesture and neither needs its own branch. */
    let startX = null, startY = null, swiping = null;
    document.addEventListener('pointerdown', e => {
      const root = e.target.closest('[data-hg] .hg-stage, .hg-overlay-stage');
      if (!root) return;
      startX = e.clientX; startY = e.clientY;
      swiping = e.target.closest('[data-hg]') || (openRoot && document.getElementById('hgOverlay'));
    });
    document.addEventListener('pointerup', e => {
      if (startX == null || !swiping) { startX = startY = swiping = null; return; }
      const dx = e.clientX - startX, dy = e.clientY - startY;
      startX = startY = null;
      const target = openRoot || (swiping.dataset && swiping.dataset.hg != null ? swiping : null);
      swiping = null;
      /* Horizontal, and far enough to be a swipe rather than a tap that
         wandered — and more horizontal than vertical, so a scroll is not one. */
      if (!target || Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      show(target, indexOf(target) + (dx < 0 ? 1 : -1));
      if (openRoot) paintOverlay();
    });
  }

  return {
    html,
    /** Call after inserting html() into the DOM. */
    mount(scope) {
      wire();
      (scope || document).querySelectorAll('[data-hg]').forEach(root => {
        if (!root.dataset.hgIndex) show(root, 0);
      });
    },
    keysOf,
    close: closeViewer,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HotelGallery;
