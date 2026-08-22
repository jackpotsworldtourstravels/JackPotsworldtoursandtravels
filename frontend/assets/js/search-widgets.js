'use strict';
/* ===========================================================================
   search-widgets.js — the controls both search panels are built from.
   ===========================================================================
   Flights needed an airport picker, a calendar and inline errors. Hotels needs
   a destination picker, a calendar and inline errors. They are the same three
   widgets pointed at different data, so they live here once and each panel
   supplies what is particular to it.

   THE AUTOCOMPLETE KNOWS NOTHING ABOUT AIRPORTS. It takes a `source(query)`
   that returns rows and an `onPick`; whether a row is an airport, a city or a
   hotel is the caller's business. That is the whole reason this file exists —
   the alternative was a second copy of the keyboard handling, the grouping and
   the blur timing, which would have drifted apart within a week.

   Markup is emitted by the field() helpers so the two panels cannot disagree
   about class names, and every class is already in travel-explore.css.
   =========================================================================== */

const SearchWidgets = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const $ = id => document.getElementById(id);
  const iso = d => d.toISOString().slice(0, 10);
  const today = () => iso(new Date());

  /** Whole nights between two ISO days. */
  function nightsBetween(a, b) {
    if (!a || !b) return 0;
    const ms = new Date(b) - new Date(a);
    return Math.max(0, Math.round(ms / 86400000));
  }

  function addDays(isoDate, n) {
    const d = new Date(isoDate);
    d.setDate(d.getDate() + n);
    return iso(d);
  }

  /* ---------------------------------------------------------------------
     Inline errors. The message goes under the field it is about — never a
     toast, never an alert.
     --------------------------------------------------------------------- */
  function setError(fieldId, message) {
    const box = $(fieldId + 'Err');
    const ctrl = $(fieldId + 'Btn') || $(fieldId);
    if (box) box.textContent = message || '';
    if (ctrl) {
      ctrl.classList.toggle('is-invalid', !!message);
      ctrl.setAttribute('aria-invalid', message ? 'true' : 'false');
      if (message) ctrl.focus();
    }
    return !message;
  }

  const clearError = id => setError(id, '');

  function clearAllErrors(rootSelector) {
    const root = document.querySelector(rootSelector || '#txSearchPanel');
    if (!root) return;
    root.querySelectorAll('.tx-err').forEach(e => { e.textContent = ''; });
    root.querySelectorAll('.is-invalid').forEach(e => {
      e.classList.remove('is-invalid');
      e.setAttribute('aria-invalid', 'false');
    });
  }

  /* ---------------------------------------------------------------------
     Autocomplete
     --------------------------------------------------------------------- */
  /**
   * @param inputId  id of the text input; its list must be `${inputId}List`
   * @param opts.source(query) -> [{ key, label, sub, group }]
   * @param opts.onPick(row)
   * @param opts.format(row) -> the string written into the box
   */
  function mountAutocomplete(inputId, opts) {
    const input = $(inputId);
    const list = $(inputId + 'List');
    if (!input || !list) return null;
    const format = opts.format || (r => r.label);
    let active = -1;
    let rows = [];

    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    };

    const paint = () => {
      rows = opts.source(input.value) || [];
      if (!rows.length) {
        list.innerHTML = `<div class="tx-ap-empty">${esc(opts.emptyText || 'Nothing matches that.')}</div>`;
      } else {
        let lastGroup = null;
        list.innerHTML = rows.map((r, i) => {
          const head = r.group && r.group !== lastGroup
            ? `<div class="tx-ap-group">${esc(r.group)}</div>` : '';
          lastGroup = r.group || lastGroup;
          return `${head}<div class="tx-ap-opt${i === active ? ' is-active' : ''}" role="option"
                 id="${esc(inputId)}Opt${i}" data-key="${esc(r.key)}" aria-selected="${i === active}">
              <b>${esc(r.label)}</b>${r.sub ? `<span>${esc(r.sub)}</span>` : ''}
            </div>`;
        }).join('');
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    const choose = i => {
      const r = rows[i];
      if (!r) return;
      input.value = format(r);
      input.dataset.key = r.key;
      close();
      clearError(inputId);
      if (opts.onPick) opts.onPick(r);
    };

    input.addEventListener('focus', paint);
    input.addEventListener('input', () => {
      /* Typing invalidates the previous pick — a half-edited box must not
         still carry the key it used to hold. */
      input.dataset.key = '';
      active = -1;
      paint();
    });

    input.addEventListener('keydown', e => {
      if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { paint(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); paint(); scrollActive(list); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); scrollActive(list); }
      else if (e.key === 'Enter') { if (!list.hidden && active > -1) { e.preventDefault(); choose(active); } }
      else if (e.key === 'Escape' || e.key === 'Tab') { close(); }
      input.setAttribute('aria-activedescendant', active > -1 ? `${inputId}Opt${active}` : '');
    });

    list.addEventListener('mousedown', e => {
      /* mousedown, not click: blur would close the list before click landed. */
      const opt = e.target.closest('[data-key]');
      if (!opt) return;
      e.preventDefault();
      choose(rows.findIndex(r => String(r.key) === opt.dataset.key));
    });

    input.addEventListener('blur', () => setTimeout(close, 120));
    return { paint, close };
  }

  function scrollActive(list) {
    const el = list.querySelector('.tx-ap-opt.is-active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------------------------------------------------------------
     Calendar
     --------------------------------------------------------------------- */
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const DOW = ['Mo','Tu','We','Th','Fr','Sa','Su'];

  function monthGrid(year, month, opts) {
    const first = new Date(year, month, 1);
    /* Monday-first, which is how Indian calendars print. */
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const min = opts.min || today();
    const cells = [];

    for (let i = 0; i < lead; i++) cells.push('<div class="tx-cal-cell is-empty"></div>');
    for (let d = 1; d <= days; d++) {
      const date = new Date(year, month, d);
      const key = iso(date);
      const dow = date.getDay();
      const weekend = dow === 0 || dow === 6;
      const disabled = key < min || (opts.max && key > opts.max);
      const selected = key === opts.value;
      /* A second date marks the other end of a stay, so the nights between
         them can be shaded. */
      const inRange = opts.rangeEnd && opts.value && key > opts.value && key < opts.rangeEnd;
      const rangeEnd = opts.rangeEnd && key === opts.rangeEnd;
      const note = opts.noteFor ? opts.noteFor(key) : null;
      cells.push(`
        <button type="button" class="tx-cal-cell${weekend ? ' is-weekend' : ''}${
          selected ? ' is-selected' : ''}${inRange ? ' is-inrange' : ''}${rangeEnd ? ' is-rangeend' : ''}"
          data-date="${key}" ${disabled ? 'disabled' : ''}
          aria-pressed="${selected}" aria-label="${esc(`${d} ${MONTHS[month]} ${year}`)}">
          <span class="tx-cal-day">${d}</span>
          ${note ? `<span class="tx-cal-fare">${esc(note)}</span>` : ''}
        </button>`);
    }
    return cells.join('');
  }

  /**
   * @param fieldId  hidden input holding the ISO value; button is `${fieldId}Btn`,
   *                 popup is `${fieldId}Cal`
   * @param opts.onPick(iso)
   * @param opts.noteFor(iso) -> a short string under the day, or null
   * @param opts.rangeEnd() -> iso of the other end of a stay, or null
   */
  function mountCalendar(fieldId, opts) {
    opts = opts || {};
    const input = $(fieldId);
    const button = $(fieldId + 'Btn');
    const pop = $(fieldId + 'Cal');
    if (!input || !button || !pop) return null;

    let view = new Date(input.value || today());
    view = new Date(view.getFullYear(), view.getMonth(), 1);

    const label = () => {
      button.textContent = input.value
        ? new Date(input.value).toLocaleDateString('en-IN',
            { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
        : (opts.placeholder || 'Select a date');
      button.classList.toggle('is-empty', !input.value);
    };

    const paint = () => {
      pop.innerHTML = `
        <div class="tx-cal-head">
          <button type="button" class="tx-cal-nav" data-nav="-1" aria-label="Previous month">&#8249;</button>
          <b>${esc(MONTHS[view.getMonth()])} ${view.getFullYear()}</b>
          <button type="button" class="tx-cal-nav" data-nav="1" aria-label="Next month">&#8250;</button>
        </div>
        <div class="tx-cal-dow">${DOW.map(d => `<span>${d}</span>`).join('')}</div>
        <div class="tx-cal-grid" role="grid">${monthGrid(view.getFullYear(), view.getMonth(), {
          min: input.min || today(),
          max: input.max || null,
          value: input.value,
          rangeEnd: opts.rangeEnd ? opts.rangeEnd() : null,
          noteFor: opts.noteFor,
        })}</div>
        ${opts.footer ? `<div class="tx-cal-foot">${opts.footer()}</div>` : ''}`;
    };

    const open = () => { paint(); pop.hidden = false; button.setAttribute('aria-expanded', 'true'); };
    const close = () => { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); };

    button.addEventListener('click', () => (pop.hidden ? open() : close()));

    pop.addEventListener('click', e => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.nav), 1);
        paint();
        return;
      }
      const cell = e.target.closest('[data-date]');
      if (!cell || cell.disabled) return;
      input.value = cell.dataset.date;
      label();
      close();
      clearError(fieldId);
      if (opts.onPick) opts.onPick(input.value);
    });

    document.addEventListener('click', e => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== button) close();
    });
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); button.focus(); } });

    label();
    return { open, close, refresh: () => { label(); if (!pop.hidden) paint(); } };
  }

  /* ---------------------------------------------------------------------
     Markup helpers, so both panels emit identical structure
     --------------------------------------------------------------------- */
  function autocompleteField(id, label, opts) {
    opts = opts || {};
    return `
      <div class="tx-sf tx-ap">
        <label for="${id}">${esc(label)}</label>
        <input id="${id}" type="text" class="tx-ap-input" autocomplete="off" role="combobox"
               aria-autocomplete="list" aria-expanded="false" aria-controls="${id}List"
               placeholder="${esc(opts.placeholder || '')}" value="${esc(opts.value || '')}"
               data-key="${esc(opts.key || '')}">
        <div class="tx-ap-list" id="${id}List" role="listbox" aria-label="${esc(label)} suggestions" hidden></div>
        <p class="tx-err" id="${id}Err" role="alert"></p>
      </div>`;
  }

  function calendarField(id, label, value, min, max) {
    return `
      <div class="tx-sf tx-cal">
        <label for="${id}Btn">${esc(label)}</label>
        <input type="hidden" id="${id}" value="${esc(value || '')}" min="${esc(min || today())}"${
          max ? ` max="${esc(max)}"` : ''}>
        <button type="button" class="tx-cal-btn" id="${id}Btn" aria-haspopup="dialog" aria-expanded="false"></button>
        <div class="tx-cal-pop" id="${id}Cal" role="dialog" aria-label="${esc(label)}" hidden></div>
        <p class="tx-err" id="${id}Err" role="alert"></p>
      </div>`;
  }

  /** A +/- stepper row, shared by the traveller and rooms popups. */
  function stepperRow(key, label, note, value, min, max, extraAttr) {
    return `
      <div class="tx-pax-row">
        <div><b>${esc(label)}</b><span>${esc(note)}</span></div>
        <div class="tx-pax-step">
          <button type="button" class="tx-pax-btn" data-step-key="${esc(key)}" data-delta="-1"
                  ${extraAttr || ''} ${value <= min ? 'disabled' : ''}
                  aria-label="One fewer ${esc(label)}">&minus;</button>
          <output data-step-out="${esc(key)}">${value}</output>
          <button type="button" class="tx-pax-btn" data-step-key="${esc(key)}" data-delta="1"
                  ${extraAttr || ''} ${value >= max ? 'disabled' : ''}
                  aria-label="One more ${esc(label)}">+</button>
        </div>
      </div>`;
  }

  /** Close a popup when a click lands outside it or Escape is pressed. */
  function dismissable(popId, triggerId, onClose) {
    const pop = $(popId);
    const trigger = $(triggerId);
    if (!pop || !trigger) return;
    const close = () => {
      pop.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (onClose) onClose();
    };
    document.addEventListener('click', e => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) close();
    });
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); trigger.focus(); } });
    return close;
  }

  return {
    esc, iso, today, nightsBetween, addDays,
    setError, clearError, clearAllErrors,
    mountAutocomplete, mountCalendar,
    autocompleteField, calendarField, stepperRow, dismissable,
    MONTHS, DOW,
  };
})();
