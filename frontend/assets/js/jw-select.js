'use strict';
/* ===========================================================================
   jw-select.js — the Flights page's one dropdown list.
   ===========================================================================
   Replaces the browser's own popup on the page's native <select>s with the
   JackpotsWorld list, and nothing else.

   THE <select> STAYS THE CONTROL. It keeps its place, its label, its
   validation styling, its id and every listener already bound to it. Only
   the OPEN LIST is ours: picking an option writes select.selectedIndex and
   fires `input` + `change`, exactly what a native pick fires, so the search
   card, the sort and the booking forms cannot tell the difference. Code that
   sets `.value` directly is reflected for free, because the closed control
   on screen is still the select itself.

   WHY NOT WRAP IT. Several of these selects are flex or grid children (the
   seat/add-on traveller picker, the dial code beside the phone number);
   wrapping them would change their layout. Instead the select ignores the
   pointer (CSS: .jw-sel-native) and its parent opens the list when a click
   lands on the select's box or its <label>. That also keeps phones from
   opening their native picker, which a mousedown preventDefault cannot.

   SCOPE. Only the selectors in TARGETS, all on flights.html: the search
   card's cabin, the Multi City editor's cabin, Sort by, and the selects in
   the flight booking sheet. The hidden trip-type select is driven by the
   trip tabs and is left alone. Nothing here runs on any other page.
   =========================================================================== */
(function () {
  /* `.search-card select` is the landing page's search card (Cabin class,
     Tour Package type and month); on flights.html it is the Multi City editor. */
  const TARGETS = '#ssCabin, #txSort, .search-card select, .bk-sheet.is-flight select';

  const CHECK = '<svg class="jw-sel-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let open = null;          // { sel, pop, list, opts, active }
  let uid = 0;
  let lastClosed = { sel: null, at: 0 };
  let typed = '', typedAt = 0, typedFrom = 0;

  /* ---------------------------------------------------------------- enhance */
  function enhance(sel) {
    if (sel.dataset.jwSelect || sel.multiple || sel.size > 1) return;
    sel.dataset.jwSelect = '1';
    sel.classList.add('jw-sel-native');
    sel.setAttribute('aria-haspopup', 'listbox');
    sel.setAttribute('aria-expanded', 'false');
    sel.addEventListener('keydown', onSelectKey);
    const host = sel.parentElement;
    if (host && !host.dataset.jwSelectHost) {
      host.dataset.jwSelectHost = '1';
      host.addEventListener('click', onHostClick);
    }
  }

  function scan(root) {
    (root || document).querySelectorAll(TARGETS).forEach(enhance);
  }

  /* A click on the select's box, or on its <label>. The select itself has
     pointer-events:none, so the event arrives on its parent. */
  function onHostClick(e) {
    if (e.target.closest && e.target.closest('.jw-sel-pop')) return;
    const sels = this.querySelectorAll(':scope > select.jw-sel-native');
    for (const sel of sels) {
      if (sel.disabled) continue;
      const r = sel.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const onLabel = sel.id && e.target.closest && e.target.closest('label[for="' + CSS.escape(sel.id) + '"]');
      if (!inside && !onLabel) continue;
      e.preventDefault();
      /* The outside-press that just closed this list must not reopen it. */
      if (lastClosed.sel === sel && Date.now() - lastClosed.at < 300) return;
      if (open && open.sel === sel) close(true); else openFor(sel);
      return;
    }
  }

  function onSelectKey(e) {
    const k = e.key;
    if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp' || k === 'F4') {
      e.preventDefault();
      openFor(e.currentTarget);
    }
  }

  /* ------------------------------------------------------------------ open */
  function labelFor(sel) {
    if (sel.getAttribute('aria-label')) return sel.getAttribute('aria-label');
    const lab = sel.id && document.querySelector('label[for="' + CSS.escape(sel.id) + '"]');
    return lab ? lab.textContent.trim() : '';
  }

  /* The search card's cells pad the select; the list hangs from the cell's
     edge so it sits clear of the card instead of over its lower padding. */
  const anchorOf = sel => sel.closest('.ss-cell') || sel;

  function openFor(sel) {
    if (sel.disabled) return;
    close(false);
    /* A field reached by keyboard can sit partly off screen; bring it in
       first, or the list would be placed against a box nobody can see. */
    const ar = anchorOf(sel).getBoundingClientRect();
    /* `instant`: the page scrolls smoothly, and mid-glide the field is still
       off screen — follow() would close the list the moment it opened. */
    if (ar.top < 0 || ar.bottom > window.innerHeight) anchorOf(sel).scrollIntoView({ block: 'center', behavior: 'instant' });
    const id = 'jwSel' + (++uid);
    const pop = document.createElement('div');
    pop.className = 'jw-sel-pop';
    const list = document.createElement('ul');
    list.className = 'jw-sel-list';
    list.id = id;
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    const name = labelFor(sel);
    if (name) list.setAttribute('aria-label', name);

    const opts = [];
    Array.prototype.forEach.call(sel.options, (o, i) => {
      if (o.hidden) return;
      const li = document.createElement('li');
      li.className = 'jw-sel-opt';
      li.id = id + '-' + i;
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === sel.selectedIndex));
      if (o.disabled) li.setAttribute('aria-disabled', 'true');
      const txt = document.createElement('span');
      txt.className = 'jw-sel-txt';
      txt.textContent = o.text;
      li.appendChild(txt);
      li.insertAdjacentHTML('beforeend', CHECK);
      list.appendChild(li);
      opts.push(li);
    });

    pop.appendChild(list);
    document.body.appendChild(pop);
    open = { sel, pop, list, opts, active: -1 };
    place();

    sel.setAttribute('aria-expanded', 'true');
    sel.setAttribute('aria-controls', id);
    sel.classList.add('is-jw-open');

    const current = opts.findIndex(li => +li.dataset.index === sel.selectedIndex);
    setActive(current >= 0 ? current : nextEnabled(-1, 1), true);
    list.focus({ preventScroll: true });

    list.addEventListener('click', onListClick);
    list.addEventListener('keydown', onListKey);
    list.addEventListener('mousemove', onListHover);
    lastRect = '';
    requestAnimationFrame(() => { if (open && open.pop === pop) pop.classList.add('is-open'); });
    requestAnimationFrame(track);
  }

  /* Below the field when it fits, above it when it does not; never wider
     than the viewport and never past either edge. */
  function place() {
    if (!open) return;
    const { pop, list, sel } = open;
    const r = anchorOf(sel).getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const gap = 6, edge = 8;

    /* As wide as the field, or as the longest option if that is wider — a
       narrow control (Sort by) must not clip "Earliest departure". Measured
       shrink-to-fit at the viewport's left edge, then capped to the screen. */
    pop.style.width = ''; pop.style.left = '0px'; pop.style.top = '0px';
    const content = Math.ceil(pop.getBoundingClientRect().width);
    const width = Math.min(Math.max(r.width, content, 200), vw - edge * 2);
    let left = r.left;
    if (left + width > vw - edge) left = r.right - width;
    left = Math.max(edge, Math.min(left, vw - edge - width));

    /* The pop's own padding (6px) and border (1px), top and bottom: the list
       gets the room minus this, so the whole pop — not just the list — fits. */
    const chrome = 14;
    list.style.maxHeight = '';
    const natural = list.scrollHeight;
    const below = vh - r.bottom - gap - edge - chrome;
    const above = r.top - gap - edge - chrome;
    const up = below < Math.min(natural, 220) && above > below;
    const room = Math.max(132, Math.min(320, up ? above : below));
    list.style.maxHeight = room + 'px';
    const h = Math.min(natural, room) + chrome;

    pop.style.width = width + 'px';
    pop.style.left = left + 'px';
    pop.style.top = (up ? r.top - gap - h : r.bottom + gap) + 'px';
    pop.classList.toggle('is-up', up);
  }

  /* ----------------------------------------------------------------- close */
  function close(returnFocus) {
    if (!open) return;
    const { sel, pop } = open;
    open = null;
    sel.setAttribute('aria-expanded', 'false');
    sel.removeAttribute('aria-controls');
    sel.classList.remove('is-jw-open');
    pop.classList.remove('is-open');
    setTimeout(() => pop.remove(), 170);
    if (returnFocus && sel.isConnected) sel.focus({ preventScroll: true });
  }

  function choose(pos) {
    if (!open) return;
    const li = open.opts[pos];
    if (!li || li.getAttribute('aria-disabled') === 'true') return;
    const sel = open.sel;
    const i = +li.dataset.index;
    const changed = sel.selectedIndex !== i;
    close(true);
    if (!changed) return;
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ------------------------------------------------------------ list input */
  function setActive(pos, centre) {
    if (!open || pos < 0) return;
    const prev = open.opts[open.active];
    if (prev) prev.classList.remove('is-active');
    const li = open.opts[pos];
    if (!li) return;
    open.active = pos;
    li.classList.add('is-active');
    open.list.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: centre ? 'center' : 'nearest' });
  }

  function nextEnabled(from, step) {
    if (!open) return -1;
    for (let p = from + step; p >= 0 && p < open.opts.length; p += step) {
      if (open.opts[p].getAttribute('aria-disabled') !== 'true') return p;
    }
    return from;
  }

  function onListClick(e) {
    const li = e.target.closest('.jw-sel-opt');
    if (li) choose(open.opts.indexOf(li));
  }

  function onListHover(e) {
    const li = e.target.closest('.jw-sel-opt');
    if (!li || !open) return;
    const pos = open.opts.indexOf(li);
    if (pos !== open.active && li.getAttribute('aria-disabled') !== 'true') {
      const prev = open.opts[open.active];
      if (prev) prev.classList.remove('is-active');
      open.active = pos;
      li.classList.add('is-active');
      open.list.setAttribute('aria-activedescendant', li.id);
    }
  }

  function onListKey(e) {
    if (!open) return;
    const k = e.key, last = open.opts.length - 1;
    if (k === 'ArrowDown') { e.preventDefault(); setActive(nextEnabled(open.active, 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive(nextEnabled(open.active, -1)); }
    else if (k === 'Home') { e.preventDefault(); setActive(nextEnabled(-1, 1)); }
    else if (k === 'End') { e.preventDefault(); setActive(nextEnabled(last + 1, -1)); }
    else if (k === 'PageDown') { e.preventDefault(); setActive(Math.min(last, open.active + 8)); }
    else if (k === 'PageUp') { e.preventDefault(); setActive(Math.max(0, open.active - 8)); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(open.active); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (k === 'Tab') { close(true); }   /* focus returns to the select; Tab then moves on */
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      /* Type-ahead. A single letter steps to the NEXT option starting with it
         (so "i i i" walks India → Indonesia → …). A longer string is matched
         from where typing began, inclusive — so "ind" on a list already at
         India stays on India instead of skipping to Indonesia. */
      const now = Date.now();
      if (now - typedAt >= 600) { typed = ''; typedFrom = open.active; }
      typed += k.toLowerCase();
      typedAt = now;
      const repeat = typed.split('').every(c => c === typed[0]);
      const needle = repeat ? typed[0] : typed;
      const start = repeat ? open.active + 1 : typedFrom;
      const n = open.opts.length;
      for (let s = 0; s < n; s++) {
        const p = ((start + s) % n + n) % n;
        const li = open.opts[p];
        if (li.getAttribute('aria-disabled') !== 'true'
            && li.textContent.trim().toLowerCase().startsWith(needle)) { setActive(p); break; }
      }
    }
  }

  /* ---------------------------------------------------------- page events */
  /* Only an outside PRESS arms the no-reopen guard: that press is followed by
     a click on the same field, which must not open the list it just closed.
     A list closed by keyboard or by picking an option reopens on the next
     click as normal. */
  document.addEventListener('pointerdown', e => {
    if (!open) return;
    if (open.pop.contains(e.target)) return;
    lastClosed = { sel: open.sel, at: Date.now() };
    close(false);
  }, true);

  /* Follow the field while the list is open — every frame, not only on
     scroll: the booking sheet settles its layout after a step renders and
     results can push Sort by down, both without a scroll event. Re-places
     only when the field actually moved, and closes once it leaves the
     screen. */
  let lastRect = '';
  function follow() {
    if (!open) return;
    const r = anchorOf(open.sel).getBoundingClientRect();
    if (!open.sel.isConnected || r.bottom < 0 || r.top > window.innerHeight) { close(false); return; }
    const key = [r.left, r.top, r.width, r.height, window.innerWidth, window.innerHeight].map(Math.round).join(',');
    if (key !== lastRect) { lastRect = key; place(); }
  }
  function track() {
    if (!open) return;
    follow();
    requestAnimationFrame(track);
  }

  /* The search strip re-renders on Back/Forward, Multi City builds its editor
     on demand, and the booking sheet redraws every step — enhance whatever
     arrives. A list whose select has been replaced is simply closed. */
  const observer = new MutationObserver(() => {
    scan(document);
    if (open && !open.sel.isConnected) close(false);
  });

  function init() {
    scan(document);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.JWSelect = { enhance, close: () => close(false) };
})();
