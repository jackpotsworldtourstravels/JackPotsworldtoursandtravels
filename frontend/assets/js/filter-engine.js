'use strict';
/* ===========================================================================
   filter-engine.js — one results-page filter panel, for any product.
   ===========================================================================
   WHAT THIS IS. Everything a filter sidebar does that has nothing to do with
   what is being filtered: deriving options and counts, deciding which filters
   the data can answer, rendering the panel, collapsing sections, keeping focus
   across repaints, the dual-range slider, search-within-a-group, sorting, and
   reading and writing the whole lot to the URL.

   WHAT IT IS NOT. It knows nothing about flights or hotels. A product supplies
   a list of DEFINITIONS and a list of SORTS; `create()` returns a panel bound
   to them. flight-filters.js and hotel-filters.js are those two lists and
   almost nothing else.

   THE RULE THE WHOLE THING IS BUILT AROUND: a filter is shown only when the
   rows can answer it — two or more distinct options, or a range with a spread.
   Availability is asked of the DATA, never of a feature flag. So a product may
   define every filter it will ever want; the ones the backend does not yet
   populate render nothing, and appear on their own, with counts, in the URL and
   in "clear all", the day those fields arrive. Nothing is invented to fill a
   gap, and nothing is greyed out to promise one.

   COUNTS ARE COMPUTED AGAINST THE OTHER FILTERS. The number beside an option is
   how many results you would get by ticking it GIVEN everything else already
   ticked — the only number that stays true once a second filter is on. See
   rowsExcluding().

   -------------------------------------------------------------------------
   A DEFINITION
   -------------------------------------------------------------------------
     id      stable key; also the URL parameter, prefixed
     label   section heading
     type    'list'  multi-select checkboxes   (OR within, AND across groups)
             'radio' single-select             (one value at a time)
             'range' dual slider               (lo..hi inclusive)
     get(row)          -> value, or an ARRAY of values when `multi` is set
                          (range: a number). null/'' means "this row cannot
                          answer this filter" and is never counted.
     multi             get() returns many values per row — a hotel's amenities,
                       where one property is both "Pool" and "Spa". Matching is
                       "row has any selected value".
     label_(key)       display label for an option        (default: the key)
     note(key)         small print under the label
     order(key)        sort rank, lowest first            (default: by count)
     search            render a search-within box once the list is long
     icon(key, row)    HTML for a leading icon/logo, or ''
     format(n)         range: number -> display label
     step              range: slider step
   =========================================================================== */

const FilterEngine = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const num = (v, fallback) => (v == null || Number.isNaN(v) ? fallback : v);

  /** Every value a row offers for one filter, always as an array — which is
   *  what lets `multi` and ordinary scalar filters share one code path. */
  function valuesOf(def, row) {
    const v = def.get(row);
    if (v == null || v === '') return [];
    if (def.multi) return Array.isArray(v) ? v.filter(x => x != null && x !== '') : [v];
    return [v];
  }

  function create(config) {
    const DEFS = config.defs || [];
    const SORTS = config.sorts || [];
    const PREFIX = config.prefix || 'f_';
    const DEFAULT_SORT = config.defaultSort || (SORTS[0] && SORTS[0].id) || '';
    /* Sorting falls back to this when two rows tie, so a list never reorders
       itself between renders on equal keys. */
    const tiebreak = config.tiebreak || (() => 0);
    const heading = config.heading || 'Filters';

    const DEF_BY_ID = new Map(DEFS.map(d => [d.id, d]));
    const SORT_BY_ID = new Map(SORTS.map(s => [s.id, s]));

    /* ---------------------------------------------------------------- state
       value shapes:  list  -> Set<string>
                      radio -> string | ''
                      range -> {lo, hi} | null   (null = untouched, full span) */
    const values = new Map();
    const collapsed = new Set();
    const searchText = new Map();
    let rows = [];
    let onChange = null;
    let host = null;
    let sortId = DEFAULT_SORT;
    let dragging = false;

    const blankValue = def =>
      def.type === 'list' ? new Set() : def.type === 'radio' ? '' : null;

    function valueOf(def) {
      if (!values.has(def.id)) values.set(def.id, blankValue(def));
      return values.get(def.id);
    }

    const isSet = def => {
      const v = valueOf(def);
      if (def.type === 'list') return v.size > 0;
      if (def.type === 'radio') return !!v;
      return v != null;
    };

    /* ----------------------------------------------------- facets/availability */
    function optionsFor(def, list) {
      const counts = new Map();
      list.forEach(row => {
        valuesOf(def, row).forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
      });
      const out = [...counts.entries()].map(([key, count]) => ({
        key: String(key),
        label: def.label_ ? def.label_(key) : String(key),
        note: def.note ? def.note(key) : '',
        count,
      }));
      if (def.order) out.sort((a, b) => def.order(a.key) - def.order(b.key));
      else out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      return out;
    }

    function boundsFor(def, list) {
      const vals = list.map(def.get).filter(v => v != null && !Number.isNaN(v));
      if (!vals.length) return null;
      const lo = Math.min(...vals), hi = Math.max(...vals);
      return hi > lo ? { lo, hi } : null;
    }

    function isAvailable(def, list) {
      if (def.type === 'range') return boundsFor(def, list) != null;
      return optionsFor(def, list).length > 1;
    }

    const shownDefs = () => DEFS.filter(d => isAvailable(d, rows));
    const activeCount = () => shownDefs().filter(isSet).length;

    /* ------------------------------------------------------------- predicate */
    function testOne(def, row) {
      const v = valueOf(def);
      if (def.type === 'list') {
        if (!v.size) return true;
        /* OR within a group: any one of the ticked values is a match. */
        return valuesOf(def, row).some(x => v.has(String(x)));
      }
      if (def.type === 'radio') {
        if (!v) return true;
        return valuesOf(def, row).some(x => String(x) === v);
      }
      if (!v) return true;
      const got = def.get(row);
      /* A row with no value for a range filter is KEPT. An absent value is not
         a value outside the range, and dropping it would let a slider nobody
         moved quietly delete results the moment one row lacks the field. */
      if (got == null) return true;
      return got >= v.lo && got <= v.hi;
    }

    function rowsExcluding(skipId) {
      const active = DEFS.filter(d => d.id !== skipId && isSet(d) && isAvailable(d, rows));
      if (!active.length) return rows;
      return rows.filter(row => active.every(d => testOne(d, row)));
    }

    /* AND across groups. */
    const test = row => DEFS.every(d => !isAvailable(d, rows) || testOne(d, row));

    /* ---------------------------------------------------------------- sorting */
    const availableSorts = () => SORTS.filter(s => !s.available || s.available(rows));

    function sortRows(list, id) {
      const def = SORT_BY_ID.get(id) || SORT_BY_ID.get(DEFAULT_SORT);
      const out = (list || []).slice();
      if (!def) return out;
      const key = def.prepare ? def.prepare(out) : def.key;
      out.sort((a, b) => {
        const ka = key(a), kb = key(b);
        if (typeof ka === 'string' || typeof kb === 'string') {
          return String(ka).localeCompare(String(kb)) || tiebreak(a, b);
        }
        return (ka - kb) || tiebreak(a, b);
      });
      return out;
    }

    const apply = list => sortRows((list || rows).filter(test), sortId);

    /* -------------------------------------------------------------------- URL
       Namespaced so a filter can never collide with a search criterion.
       Multi-values join on "~": it survives a URL unescaped and cannot appear
       inside a name or a code, which a comma very nearly can. */
    function writeParams(params) {
      DEFS.forEach(def => {
        const k = PREFIX + def.id;
        delete params[k];
        if (!isAvailable(def, rows) || !isSet(def)) return;
        const v = valueOf(def);
        if (def.type === 'list') params[k] = [...v].join('~');
        else if (def.type === 'radio') params[k] = v;
        else params[k] = `${v.lo}-${v.hi}`;
      });
      delete params[PREFIX + 'sort'];
      if (sortId && sortId !== DEFAULT_SORT) params[PREFIX + 'sort'] = sortId;
      return params;
    }

    function readParams(get) {
      DEFS.forEach(def => {
        const raw = get(PREFIX + def.id);
        if (raw == null || raw === '') return;
        if (def.type === 'list') values.set(def.id, new Set(String(raw).split('~').filter(Boolean)));
        else if (def.type === 'radio') values.set(def.id, String(raw));
        else {
          const m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(String(raw));
          if (m) values.set(def.id, { lo: Number(m[1]), hi: Number(m[2]) });
        }
      });
      const s = get(PREFIX + 'sort');
      if (s && SORT_BY_ID.has(s)) sortId = s;
    }

    /** Drop anything the current rows cannot honour — a stale value from a URL
     *  would otherwise filter to nothing with no visible cause. */
    function reconcile() {
      DEFS.forEach(def => {
        if (!isAvailable(def, rows)) return;
        if (def.type === 'range') {
          const b = boundsFor(def, rows);
          const v = valueOf(def);
          if (!v || !b) return;
          const lo = Math.max(b.lo, v.lo), hi = Math.min(b.hi, v.hi);
          values.set(def.id, lo >= hi ? null : { lo, hi });
          return;
        }
        const keys = new Set(optionsFor(def, rows).map(o => o.key));
        const v = valueOf(def);
        if (def.type === 'list') [...v].forEach(k => { if (!keys.has(k)) v.delete(k); });
        else if (v && !keys.has(v)) values.set(def.id, '');
      });
    }

    function clearAll() {
      DEFS.forEach(def => values.set(def.id, blankValue(def)));
      searchText.clear();
    }

    /* -------------------------------------------------------------- rendering */
    function sectionHtml(def) {
      const open = !collapsed.has(def.id);
      const body = def.type === 'range' ? rangeHtml(def) : listHtml(def);
      const n = isSet(def) ? (def.type === 'list' ? valueOf(def).size : 1) : 0;
      return `<section class="ff-group" data-ff-group="${esc(def.id)}">
        <h4 class="ff-head">
          <button type="button" class="ff-toggle" data-ff-toggle="${esc(def.id)}"
                  aria-expanded="${open}" aria-controls="ff-body-${esc(def.id)}">
            <span class="ff-title">${esc(def.label)}</span>
            ${n ? `<span class="ff-badge">${n}</span>` : ''}
            <svg class="ff-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </h4>
        <div class="ff-body" id="ff-body-${esc(def.id)}"${open ? '' : ' hidden'}>${body}</div>
      </section>`;
    }

    function listHtml(def) {
      const scoped = rowsExcluding(def.id);
      const opts = optionsFor(def, rows).map(o => ({
        ...o,
        count: scoped.filter(r => valuesOf(def, r).some(x => String(x) === o.key)).length,
      }));

      const q = (searchText.get(def.id) || '').trim().toLowerCase();
      const shown = q ? opts.filter(o => o.label.toLowerCase().includes(q)) : opts;
      const v = valueOf(def);
      const inputType = def.type === 'radio' ? 'radio' : 'checkbox';

      /* A search box over three options is furniture; over a dozen it is the
         only way to find one. It appears on its own as the data grows. */
      const search = def.search && opts.length >= 5 ? `
        <div class="ff-search">
          <label class="sr-only" for="ff-q-${esc(def.id)}">Search ${esc(def.label)}</label>
          <input id="ff-q-${esc(def.id)}" type="search" autocomplete="off"
                 placeholder="Search ${esc(def.label.toLowerCase())}"
                 data-ff-search="${esc(def.id)}" value="${esc(searchText.get(def.id) || '')}">
        </div>` : '';

      const clear = isSet(def)
        ? `<button type="button" class="ff-clear-one" data-ff-clear="${esc(def.id)}">Clear</button>`
        : '';

      const body = shown.length ? shown.map(o => {
        const on = def.type === 'radio' ? v === o.key : v.has(o.key);
        const sample = rows.find(r => valuesOf(def, r).some(x => String(x) === o.key));
        const icon = def.icon ? def.icon(o.key, sample) : '';
        return `<label class="ff-opt${o.count ? '' : ' is-empty'}">
          <input type="${inputType}" ${def.type === 'radio' ? `name="ff-${esc(def.id)}"` : ''}
                 data-ff-opt="${esc(def.id)}" value="${esc(o.key)}" ${on ? 'checked' : ''}>
          ${icon}
          <span class="ff-opt-text">
            <span class="ff-opt-label">${esc(o.label)}</span>
            ${o.note ? `<span class="ff-opt-note">${esc(o.note)}</span>` : ''}
          </span>
          <span class="ff-count">${o.count}</span>
        </label>`;
      }).join('') : `<p class="ff-none">No matches for “${esc(q)}”.</p>`;

      return search + `<div class="ff-opts">${body}</div>` + clear;
    }

    function rangeHtml(def) {
      const b = boundsFor(def, rows);
      if (!b) return '';
      const v = valueOf(def) || { lo: b.lo, hi: b.hi };
      const step = def.step || 1;
      const fmt = def.format || String;
      return `
        <div class="ff-range" data-ff-range="${esc(def.id)}">
          <output class="ff-range-out">${esc(fmt(v.lo))} – ${esc(fmt(v.hi))}</output>
          <div class="ff-range-track">
            <div class="ff-range-fill"></div>
            <label class="sr-only" for="ff-lo-${esc(def.id)}">Minimum ${esc(def.label)}</label>
            <input id="ff-lo-${esc(def.id)}" class="ff-range-lo" type="range"
                   min="${b.lo}" max="${b.hi}" step="${step}" value="${v.lo}"
                   data-ff-bound="lo" aria-label="Minimum ${esc(def.label)}">
            <label class="sr-only" for="ff-hi-${esc(def.id)}">Maximum ${esc(def.label)}</label>
            <input id="ff-hi-${esc(def.id)}" class="ff-range-hi" type="range"
                   min="${b.lo}" max="${b.hi}" step="${step}" value="${v.hi}"
                   data-ff-bound="hi" aria-label="Maximum ${esc(def.label)}">
          </div>
          <div class="ff-range-ends"><span>${esc(fmt(b.lo))}</span><span>${esc(fmt(b.hi))}</span></div>
        </div>`;
    }

    /* ------------------------------------------------- focus across a repaint
       Every change repaints the panel, which detaches the control just used —
       and focus goes with it, to <body>. With a mouse that is invisible; on a
       keyboard it means ticking one filter throws you to the top of the
       document, so the second cannot be reached without tabbing the page
       again. A SELECTOR, not the node: the node is gone after the repaint. */
    function focusSelector(el) {
      if (!el || !host || !host.contains(el)) return null;
      const d = el.dataset || {};
      if (d.ffOpt) return `[data-ff-opt="${CSS.escape(d.ffOpt)}"][value="${CSS.escape(el.value)}"]`;
      if (d.ffSearch) return `[data-ff-search="${CSS.escape(d.ffSearch)}"]`;
      if (d.ffToggle) return `[data-ff-toggle="${CSS.escape(d.ffToggle)}"]`;
      if (d.ffClear) return `[data-ff-clear="${CSS.escape(d.ffClear)}"]`;
      if (el.hasAttribute('data-ff-clear-all')) return '[data-ff-clear-all]';
      if (d.ffBound) {
        const box = el.closest('[data-ff-range]');
        return box
          ? `[data-ff-range="${CSS.escape(box.dataset.ffRange)}"] [data-ff-bound="${CSS.escape(d.ffBound)}"]`
          : null;
      }
      return null;
    }

    const groupOf = el => {
      const g = el && el.closest && el.closest('[data-ff-group]');
      return g ? g.dataset.ffGroup : null;
    };

    function render() {
      if (!host || dragging) return;

      const active = document.activeElement;
      const want = focusSelector(active);
      const fallbackGroup = want ? groupOf(active) : null;
      const caret = (active && active.tagName === 'INPUT' && active.type === 'search')
        ? active.selectionStart : null;

      const n = activeCount();
      host.innerHTML = `
        <div class="ff-top">
          <h3 class="ff-heading">${esc(heading)}${n ? ` <span class="ff-badge">${n}</span>` : ''}</h3>
          ${n ? '<button type="button" class="ff-clear-all" data-ff-clear-all>Clear all</button>' : ''}
        </div>
        ${shownDefs().map(sectionHtml).join('')}`;

      paintRangeFills();

      if (!want) return;
      const again = host.querySelector(want)
        || (fallbackGroup && host.querySelector(`[data-ff-toggle="${CSS.escape(fallbackGroup)}"]`));
      if (!again) return;
      again.focus();
      if (caret != null && again.setSelectionRange) {
        try { again.setSelectionRange(caret, caret); } catch { /* no longer a text input */ }
      }
    }

    /** The band between the two thumbs — depends on both values, which CSS
     *  alone cannot see. */
    function paintRangeFills() {
      if (!host) return;
      host.querySelectorAll('[data-ff-range]').forEach(box => {
        const lo = box.querySelector('.ff-range-lo');
        const hi = box.querySelector('.ff-range-hi');
        const fill = box.querySelector('.ff-range-fill');
        if (!lo || !hi || !fill) return;
        const min = Number(lo.min), max = Number(lo.max);
        const span = (max - min) || 1;
        fill.style.left = ((Number(lo.value) - min) / span * 100) + '%';
        fill.style.right = ((max - Number(hi.value)) / span * 100) + '%';
      });
    }

    /* ----------------------------------------------------------------- events */
    let debounceTimer = 0;
    function announce(immediate) {
      clearTimeout(debounceTimer);
      /* Ranges fire on every pixel of a drag; a rebuild plus a re-filter per
         pixel is what makes a slider feel like it is fighting back. */
      if (immediate) { if (onChange) onChange(); return; }
      debounceTimer = setTimeout(() => { if (onChange) onChange(); }, 140);
    }

    function onRangeInput(input) {
      const box = input.closest('[data-ff-range]');
      const def = DEF_BY_ID.get(box.dataset.ffRange);
      if (!def) return;
      const lo = box.querySelector('.ff-range-lo');
      const hi = box.querySelector('.ff-range-hi');
      let a = Number(lo.value), b = Number(hi.value);
      /* Thumbs must not cross. Push the other rather than refusing the drag,
         which reads as the slider being stuck. */
      if (a > b) {
        if (input.dataset.ffBound === 'lo') { b = a; hi.value = String(b); }
        else { a = b; lo.value = String(a); }
      }
      values.set(def.id, { lo: a, hi: b });
      const out = box.querySelector('.ff-range-out');
      const fmt = def.format || String;
      if (out) out.textContent = `${fmt(a)} – ${fmt(b)}`;
      paintRangeFills();
      announce(false);
    }

    function bind() {
      host.addEventListener('click', e => {
        const toggle = e.target.closest('[data-ff-toggle]');
        if (toggle) {
          const id = toggle.dataset.ffToggle;
          if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
          const body = host.querySelector(`#ff-body-${CSS.escape(id)}`);
          const open = !collapsed.has(id);
          toggle.setAttribute('aria-expanded', String(open));
          if (body) body.hidden = !open;
          return;
        }
        const one = e.target.closest('[data-ff-clear]');
        if (one) {
          const def = DEF_BY_ID.get(one.dataset.ffClear);
          if (def) { values.set(def.id, blankValue(def)); render(); announce(true); }
          return;
        }
        if (e.target.closest('[data-ff-clear-all]')) { clearAll(); render(); announce(true); }
      });

      host.addEventListener('change', e => {
        if (e.target.closest('[data-ff-bound]')) {
          /* Keyboard users never fire pointerup — commit on change too. */
          announce(true);
          return;
        }
        const opt = e.target.closest('[data-ff-opt]');
        if (!opt) return;
        const def = DEF_BY_ID.get(opt.dataset.ffOpt);
        if (!def) return;
        if (def.type === 'radio') values.set(def.id, opt.checked ? opt.value : '');
        else {
          const set = valueOf(def);
          if (opt.checked) set.add(opt.value); else set.delete(opt.value);
        }
        render();
        announce(true);
      });

      host.addEventListener('input', e => {
        const bound = e.target.closest('[data-ff-bound]');
        if (bound) { onRangeInput(bound); return; }
        const search = e.target.closest('[data-ff-search]');
        if (search) {
          searchText.set(search.dataset.ffSearch, search.value);
          /* Narrowing the list changes nothing about what is selected, so
             nothing is re-filtered; render() puts the caret back. */
          render();
        }
      });

      host.addEventListener('pointerdown', e => {
        if (e.target.closest('[data-ff-bound]')) dragging = true;
      });
      const stopDrag = () => { if (dragging) { dragging = false; render(); } };
      document.addEventListener('pointerup', stopDrag);
      document.addEventListener('pointercancel', stopDrag);
    }

    /* ------------------------------------------------------------------ api */
    return {
      mount(el, cb) {
        host = typeof el === 'string' ? document.getElementById(el) : el;
        onChange = cb;
        if (host) { host.classList.add('ff-scope'); bind(); }
        return !!host;
      },
      setRows(list) {
        rows = Array.isArray(list) ? list : [];
        reconcile();
        if (!availableSorts().some(s => s.id === sortId)) sortId = DEFAULT_SORT;
        render();
      },
      refresh: render,
      test, apply, sortRows, activeCount,
      clear() { clearAll(); render(); },
      get sort() { return sortId; },
      set sort(v) { if (SORT_BY_ID.has(v)) sortId = v; },
      availableSorts,
      DEFAULT_SORT,
      writeParams, readParams,
      /* Exposed for the page's own "no results" copy and for tests. */
      isAvailable: def => isAvailable(def, rows),
      defs: () => shownDefs().map(d => d.id),
    };
  }

  return { create, valuesOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FilterEngine;
