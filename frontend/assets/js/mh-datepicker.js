'use strict';
/* Travel-style calendar replacing the browser-native date control.
   ---------------------------------------------------------------------------
   The original <input type="date"> element is KEPT IN THE DOM and keeps holding
   the machine value in `yyyy-mm-dd`; it is only switched to type="hidden" and
   given a styled trigger + popover alongside. That matters because the rest of
   the app reads these by selector and posts the result straight to the API:
   collectPassengerPayloads() does `[data-field="dob"].value` and mhVal() does
   `#mh-flightDate.value`. Swapping in a text input that displayed "12 Apr 1991"
   would have quietly changed the request payload, so it isn't done — the visible
   text and the submitted value are deliberately two different things.

   No validation is added. The native inputs carried no min/max, so imposing any
   here could reject data that was accepted before this pass. */

const MH_DP_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MH_DP_DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function mhDpParse(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function mhDpIso(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function mhDpPretty(d) {
  return `${String(d.getDate()).padStart(2, '0')} ${MH_DP_MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}
/* Monday-first offset for a month's 1st. */
function mhDpLead(year, month) { return (new Date(year, month, 1).getDay() + 6) % 7; }

/* opts: { placeholder, yearFrom, yearTo } */
function mhAttachDatePicker(input, opts = {}) {
  if (!input || input.dataset.mhDp) return;
  input.dataset.mhDp = '1';

  const placeholder = opts.placeholder || 'Select date';
  const thisYear = new Date().getFullYear();
  const yearFrom = opts.yearFrom ?? thisYear - 100;
  const yearTo = opts.yearTo ?? thisYear + 12;

  const host = document.createElement('div');
  host.className = 'mh-dp';
  input.parentNode.insertBefore(host, input);
  host.appendChild(input);
  input.type = 'hidden';           // value still readable via .value

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'mh-dp-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  host.appendChild(trigger);

  /* The original input is now hidden, so a <label for> pointing at it would name
     nothing and clicking it would focus nothing. Re-point the label at the
     trigger, which is the real control — that gives the button its accessible
     name and makes the label clickable again. */
  const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
  if (label) {
    trigger.id = `${input.id}-btn`;
    label.htmlFor = trigger.id;
  } else {
    /* Home's search fields use a bare <label> with no `for`; borrow its text so
       the button is still announced as "Travel Date" rather than "Select date". */
    const near = host.closest('.mh-field, .mh-bfield')?.querySelector('label');
    trigger.setAttribute('aria-label', (near?.textContent || placeholder).trim());
  }

  const pop = document.createElement('div');
  pop.className = 'mh-dp-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Choose a date');
  /* Moved to <body>: `.mh-card`'s backdrop-filter would otherwise be the
     containing block for this fixed element, and `.mh-hero`'s overflow:hidden
     would clip it. See mhPlacePopover in mh-autocomplete.js. */
  mhPortalPopover(pop);

  let view = mhDpParse(input.value) || new Date();
  view = new Date(view.getFullYear(), view.getMonth(), 1);

  const paintTrigger = () => {
    const d = mhDpParse(input.value);
    trigger.innerHTML = `
      <span class="mh-dp-ico" aria-hidden="true">🗓</span>
      <span class="${d ? 'mh-dp-val' : 'mh-dp-ph'}">${d ? escapeHtml(mhDpPretty(d)) : escapeHtml(placeholder)}</span>`;
  };

  let untrack = null;
  /* Open state lives on the popover, which is a <body> child — a descendant
     selector off the host cannot reach it. */
  const isOpen = () => pop.classList.contains('mh-open');

  const close = () => {
    host.classList.remove('mh-dp-open');
    pop.classList.remove('mh-open');
    trigger.setAttribute('aria-expanded', 'false');
    if (untrack) { untrack(); untrack = null; }
  };

  const paint = () => {
    const sel = mhDpParse(input.value);
    const today = new Date();
    const y = view.getFullYear();
    const m = view.getMonth();
    const days = new Date(y, m + 1, 0).getDate();
    const lead = mhDpLead(y, m);

    const years = [];
    for (let n = yearTo; n >= yearFrom; n--) years.push(n);

    let cells = '';
    for (let i = 0; i < lead; i++) cells += `<span class="mh-dp-cell mh-dp-blank"></span>`;
    for (let d = 1; d <= days; d++) {
      const iso = mhDpIso(new Date(y, m, d));
      const isSel = sel && mhDpIso(sel) === iso;
      const isToday = mhDpIso(today) === iso;
      cells += `<button type="button" class="mh-dp-cell${isSel ? ' sel' : ''}${isToday ? ' today' : ''}"
        data-mh-dp-day="${iso}" aria-label="${iso}"${isSel ? ' aria-current="date"' : ''}>${d}</button>`;
    }

    pop.innerHTML = `
      <div class="mh-dp-head">
        <button type="button" class="mh-dp-nav" data-mh-dp-step="-1" aria-label="Previous month">‹</button>
        <div class="mh-dp-sels">
          <select class="mh-dp-sel" data-mh-dp-month aria-label="Month">
            ${MH_DP_MONTHS.map((name, i) => `<option value="${i}"${i === m ? ' selected' : ''}>${name}</option>`).join('')}
          </select>
          <select class="mh-dp-sel" data-mh-dp-year aria-label="Year">
            ${years.map(n => `<option value="${n}"${n === y ? ' selected' : ''}>${n}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="mh-dp-nav" data-mh-dp-step="1" aria-label="Next month">›</button>
      </div>
      <div class="mh-dp-dow">${MH_DP_DOW.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="mh-dp-grid">${cells}</div>
      <div class="mh-dp-foot">
        <button type="button" class="mh-dp-quick" data-mh-dp-today>Today</button>
        <button type="button" class="mh-dp-quick" data-mh-dp-clear>Clear</button>
      </div>`;
  };

  const open = () => {
    view = mhDpParse(input.value) || new Date();
    view = new Date(view.getFullYear(), view.getMonth(), 1);
    paint();
    host.classList.add('mh-dp-open');
    pop.classList.add('mh-open');
    trigger.setAttribute('aria-expanded', 'true');
    /* Fixed-positioned so the hero's overflow:hidden (needed to clip the parallax
       video) can't shave the calendar's footer off — see mhPlacePopover. */
    mhPlacePopover(host, pop, 10);
    if (!untrack) untrack = mhTrackPopover(host, pop, isOpen, 10);
  };

  const commit = (iso) => {
    input.value = iso;
    paintTrigger();
    /* Home's date field is read on search, and other code may listen — emit the
       same event a native picker would. */
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  };

  trigger.addEventListener('click', () => {
    if (host.classList.contains('mh-dp-open')) close(); else open();
  });

  pop.addEventListener('click', (e) => {
    const day = e.target.closest('[data-mh-dp-day]');
    if (day) { commit(day.dataset.mhDpDay); return; }

    const step = e.target.closest('[data-mh-dp-step]');
    if (step) {
      view = new Date(view.getFullYear(), view.getMonth() + Number(step.dataset.mhDpStep), 1);
      paint();
      return;
    }
    if (e.target.closest('[data-mh-dp-today]')) { commit(mhDpIso(new Date())); return; }
    if (e.target.closest('[data-mh-dp-clear]')) { commit(''); return; }
  });

  pop.addEventListener('change', (e) => {
    const mSel = pop.querySelector('[data-mh-dp-month]');
    const ySel = pop.querySelector('[data-mh-dp-year]');
    if (e.target === mSel || e.target === ySel) {
      view = new Date(Number(ySel.value), Number(mSel.value), 1);
      paint();
    }
  });

  /* Bound on both nodes: the popover is no longer inside the host, so a keypress
     while focus is in the calendar does not bubble through it. */
  const onEsc = (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.stopPropagation();
    close();
    trigger.focus();
  };
  host.addEventListener('keydown', onEsc);
  pop.addEventListener('keydown', onEsc);

  /* Same reason: a click inside the calendar must not read as "outside". */
  document.addEventListener('mousedown', (e) => {
    if (!host.contains(e.target) && !pop.contains(e.target)) close();
  });

  paintTrigger();
}
