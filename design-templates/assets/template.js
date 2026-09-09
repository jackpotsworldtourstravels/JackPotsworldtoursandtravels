/* ===========================================================================
   PREMIUM TRAVEL PLATFORM — UI TEMPLATE BEHAVIOUR
   ===========================================================================
   Every widget here is initialised from a data-* attribute, so a page opts in
   by writing markup and never by writing script. Keyboard contracts follow
   the spec: Tab reaches, Arrow keys move within a composite, Enter activates,
   Escape closes.
   =========================================================================== */
(function () {
  'use strict';

  var onReady = function (fn) {
    if (document.readyState !== 'loading') { fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  };

  /* -------------------------------------------------------------------------
     Tabs — roving tabindex. Arrow keys move, Home/End jump, Enter/Space select.
     ------------------------------------------------------------------------- */
  function initTabs(root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    if (!tabs.length) { return; }

    function select(tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) { panel.hidden = !on; }
      });
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab); });
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight') { next = tabs[(i + 1) % tabs.length]; }
        else if (e.key === 'ArrowLeft') { next = tabs[(i - 1 + tabs.length) % tabs.length]; }
        else if (e.key === 'Home') { next = tabs[0]; }
        else if (e.key === 'End') { next = tabs[tabs.length - 1]; }
        else { return; }
        e.preventDefault();
        select(next);
        next.focus();
      });
    });
  }

  /* -------------------------------------------------------------------------
     Autocomplete — Arrow to move through options, Enter to take one,
     Escape to close without changing the value.
     ------------------------------------------------------------------------- */
  function initCombobox(root) {
    var input = root.querySelector('[data-combobox-input]');
    var list = root.querySelector('[data-combobox-list]');
    if (!input || !list) { return; }
    var options = Array.prototype.slice.call(list.querySelectorAll('[role="option"]'));
    var active = -1;

    function open() { list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      options.forEach(function (o) { o.setAttribute('aria-selected', 'false'); });
      active = -1;
    }
    function mark(i) {
      options.forEach(function (o, n) { o.setAttribute('aria-selected', n === i ? 'true' : 'false'); });
      if (options[i]) {
        input.setAttribute('aria-activedescendant', options[i].id);
        options[i].scrollIntoView({ block: 'nearest' });
      }
    }
    function take(opt) {
      input.value = opt.getAttribute('data-value') || opt.textContent.trim();
      close();
      input.focus();
    }

    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); open(); active = (active + 1) % options.length; mark(active); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); open(); active = (active - 1 + options.length) % options.length; mark(active); }
      else if (e.key === 'Enter' && active > -1) { e.preventDefault(); take(options[active]); }
      else if (e.key === 'Escape') { close(); }
    });
    options.forEach(function (opt) {
      opt.addEventListener('click', function () { take(opt); });
    });
    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) { close(); }
    });
  }

  /* -------------------------------------------------------------------------
     Drawer — focus moves in, Escape closes, focus returns to the trigger.
     ------------------------------------------------------------------------- */
  function initDrawer() {
    var drawer = document.querySelector('[data-drawer]');
    var opener = document.querySelector('[data-drawer-open]');
    if (!drawer || !opener) { return; }
    var panel = drawer.querySelector('.c-drawer__panel');
    var closers = drawer.querySelectorAll('[data-drawer-close]');

    function open() {
      drawer.setAttribute('data-open', 'true');
      document.body.style.overflow = 'hidden';
      var first = panel.querySelector('button, a');
      if (first) { first.focus(); }
    }
    function close() {
      drawer.setAttribute('data-open', 'false');
      document.body.style.overflow = '';
      opener.focus();
    }
    opener.addEventListener('click', open);
    Array.prototype.forEach.call(closers, function (c) { c.addEventListener('click', close); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.getAttribute('data-open') === 'true') { close(); }
    });
    panel.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') { return; }
      var f = panel.querySelectorAll('a[href], button:not([disabled]), input, select');
      if (!f.length) { return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* ---- carousel: arrows scroll by one card ------------------------------- */
  function initCarousel(root) {
    var track = root.querySelector('[data-carousel-track]');
    if (!track) { return; }
    root.querySelectorAll('[data-carousel-go]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dir = btn.getAttribute('data-carousel-go') === 'next' ? 1 : -1;
        var card = track.firstElementChild;
        var step = card ? card.getBoundingClientRect().width + 24 : 320;
        track.scrollBy({ left: dir * step, behavior: 'smooth' });
      });
    });
  }

  /* ---- footer accordion: mobile only, headings stay real headings -------- */
  function initAccordion() {
    document.querySelectorAll('[data-accordion-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        var panel = document.getElementById(btn.getAttribute('aria-controls'));
        if (panel) { panel.hidden = open; }
      });
    });
  }

  /* ---- dismissible promotional banner ----------------------------------- */
  function initDismiss() {
    document.querySelectorAll('[data-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.closest('[data-dismissible]');
        if (target) { target.hidden = true; }
      });
    });
  }

  /* ---- sticky nav shadow ------------------------------------------------- */
  function initSticky() {
    var nav = document.querySelector('[data-sticky-nav]');
    if (!nav) { return; }
    var sentinel = document.createElement('div');
    nav.parentNode.insertBefore(sentinel, nav);
    new IntersectionObserver(function (entries) {
      nav.setAttribute('data-stuck', entries[0].isIntersecting ? 'false' : 'true');
    }).observe(sentinel);
  }

  /* -------------------------------------------------------------------------
     Search submit — validates before it does anything, per the spec:
     an empty or identical origin/destination shows an inline error and the
     form does not proceed. The error clears the moment the field is edited.
     ------------------------------------------------------------------------- */
  function initSearchForm(form) {
    var status = form.querySelector('[data-form-status]');

    function fail(field, message) {
      var wrap = field.closest('.c-field');
      wrap.classList.add('c-field--error');
      var slot = wrap.querySelector('[data-error-slot]');
      if (slot) { slot.textContent = message; slot.hidden = false; }
      field.setAttribute('aria-invalid', 'true');
    }
    function clear(field) {
      var wrap = field.closest('.c-field');
      wrap.classList.remove('c-field--error');
      var slot = wrap.querySelector('[data-error-slot]');
      if (slot) { slot.hidden = true; slot.textContent = ''; }
      field.removeAttribute('aria-invalid');
    }

    form.querySelectorAll('input').forEach(function (input) {
      input.addEventListener('input', function () { clear(input); });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var from = form.querySelector('[name="origin"]');
      var to = form.querySelector('[name="destination"]');
      var ok = true;

      if (from && !from.value.trim()) { fail(from, 'Enter a city or airport to fly from'); ok = false; }
      if (to && !to.value.trim()) { fail(to, 'Enter a city or airport to fly to'); ok = false; }
      if (ok && from && to && from.value.trim().toLowerCase() === to.value.trim().toLowerCase()) {
        fail(to, 'Choose a destination different from your origin');
        ok = false;
      }
      if (!ok) {
        if (status) { status.textContent = 'Search not submitted. Fix the highlighted fields.'; }
        var firstBad = form.querySelector('[aria-invalid="true"]');
        if (firstBad) { firstBad.focus(); }
        return;
      }

      var btn = form.querySelector('[type="submit"]');
      if (btn) { btn.setAttribute('data-loading', 'true'); }
      if (status) { status.textContent = 'Searching for fares. Please wait.'; }
      window.setTimeout(function () {
        if (btn) { btn.removeAttribute('data-loading'); }
        if (status) { status.textContent = 'Search complete.'; }
      }, 1600);
    });
  }

  /* ---- results page: swap skeletons for real rows once loaded ----------- */
  function initResultsDemo() {
    var wrap = document.querySelector('[data-results]');
    if (!wrap) { return; }
    var skeleton = wrap.querySelector('[data-results-skeleton]');
    var live = wrap.querySelector('[data-results-live]');
    /* The status line lives in the section heading, ABOVE [data-results] —
       scoping this lookup to wrap found nothing and left "Loading…" on screen
       after the rows had arrived. */
    var status = document.querySelector('[data-results-status]');
    if (!skeleton || !live) { return; }
    window.setTimeout(function () {
      skeleton.hidden = true;
      live.hidden = false;
      if (status) { status.textContent = '6 flights found for Delhi to Goa on 14 September.'; }
    }, 1200);
  }

  onReady(function () {
    document.querySelectorAll('[data-tabs]').forEach(initTabs);
    document.querySelectorAll('[data-combobox]').forEach(initCombobox);
    document.querySelectorAll('[data-carousel]').forEach(initCarousel);
    document.querySelectorAll('[data-search-form]').forEach(initSearchForm);
    initDrawer();
    initAccordion();
    initDismiss();
    initSticky();
    initResultsDemo();
  });
}());
