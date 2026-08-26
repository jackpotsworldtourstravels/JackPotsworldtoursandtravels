'use strict';
/* ===========================================================================
   pax-selector.js — the passenger picker, and the rules behind it.
   ===========================================================================
   ONE implementation, used by every trip type. One Way and Round Trip do not
   each get a copy: the booking card mounts a single instance and the trip type
   never touches it, which is why switching between them cannot lose or
   disagree about the party.

   TWO LAYERS, ON PURPOSE.

     PaxSelector.rules — pure functions over {adults, children, infants}. No
     DOM, no state. This is what validation, the URL reader and any future
     server-side check call; a rule that lives in a click handler can only be
     enforced by clicking.

     PaxSelector.create() — the popover that renders those rules as number
     blocks and keeps a value in sync.

   THE FOUR RULES, AND WHY maxChildren() LOOKS LIKE THAT

     1. Adults + children may not exceed 9 seated passengers.
     2. At least one adult, always.
     3. Children may not outnumber adults.
     4. Infants may not outnumber adults, and never exceed 6.

   Rules 1 and 3 both cap children and the smaller cap wins — which is not the
   same as either one alone. At 5 adults rule 3 would allow 5 children, but
   that is 10 seats; the intersection allows 4. Writing it as one min() is what
   stops the two rules being enforced in different places and disagreeing.

   THE POPOVER IS PORTALLED TO <body>. The hero it opens inside is
   `overflow:hidden` (main.css .hero), which clips an absolutely positioned
   child — the panel lost its bottom third. Fixed positioning against the
   trigger's rect has no clipping ancestor to fight, and it flips above the
   trigger when the space below is short.
   =========================================================================== */

const PaxSelector = (function () {

  /* Seated passengers. Infants travel on a lap and are not counted here —
     that is why the cap is adults + children and not the party total. */
  const MAX_SEATED   = 9;
  const MAX_ADULTS   = 9;
  const MAX_CHILDREN = 6;
  const MAX_INFANTS  = 6;

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

  const toInt = (n, dflt) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) ? v : dflt;
  };

  /* ---------------------------------------------------------------------
     Rules — pure, DOM-free, and the only place the limits are decided.
     --------------------------------------------------------------------- */

  /** How many children this many adults may bring. See the header: this is
   *  rule 1 and rule 3 intersected, not either one on its own. */
  function maxChildren(adults) {
    return Math.max(0, Math.min(MAX_CHILDREN, adults, MAX_SEATED - adults));
  }

  /** Infants ride on a lap, so one per adult, and never more than six. */
  function maxInfants(adults) {
    return Math.max(0, Math.min(MAX_INFANTS, adults));
  }

  /** Seats still available. Shown in the popover so a greyed-out block
   *  explains itself rather than just refusing to be clicked. */
  function seatsLeft(value) {
    const v = clamp(value);
    return MAX_SEATED - v.adults - v.children;
  }

  /** Force any {adults, children, infants} into a legal party.
   *
   *  Adults settle FIRST and the other two are then clamped against them —
   *  which is rule 5: raising adults widens the caps, lowering adults pulls
   *  children and infants down to the nearest value still allowed rather than
   *  leaving an impossible party on screen. */
  function clamp(value) {
    const v = value || {};
    const adults = Math.min(MAX_ADULTS, Math.max(1, toInt(v.adults, 1)));
    return {
      adults,
      children: Math.min(maxChildren(adults), Math.max(0, toInt(v.children, 0))),
      infants:  Math.min(maxInfants(adults),  Math.max(0, toInt(v.infants, 0))),
    };
  }

  /** True when the party is already legal — i.e. clamp() would change nothing. */
  function isValid(value) {
    const v = value || {};
    const c = clamp(v);
    return c.adults === toInt(v.adults, -1)
        && c.children === toInt(v.children, -1)
        && c.infants === toInt(v.infants, -1);
  }

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  /** "2 Adults, 1 Child" — zeroes are left out entirely rather than printed as
   *  "0 Children", which reads like a mistake rather than a default. */
  function summary(value) {
    const v = clamp(value);
    const parts = [plural(v.adults, 'Adult', 'Adults')];
    if (v.children) parts.push(plural(v.children, 'Child', 'Children'));
    if (v.infants)  parts.push(plural(v.infants, 'Infant', 'Infants'));
    return parts.join(', ');
  }

  function total(value) {
    const v = clamp(value);
    return v.adults + v.children + v.infants;
  }

  const rules = {
    MAX_SEATED, MAX_ADULTS, MAX_CHILDREN, MAX_INFANTS,
    maxChildren, maxInfants, seatsLeft, clamp, isValid, summary, total,
  };

  /* ---------------------------------------------------------------------
     The three groups the popover draws. Declared as data so the render loop,
     the keyboard handler and the clamp all read the same list — a fourth
     group would be one entry here and nothing else.
     --------------------------------------------------------------------- */
  const GROUPS = [
    { key: 'adults',   label: 'Adults',   note: '12 years and over', min: 1, max: MAX_ADULTS,   limit: () => MAX_ADULTS },
    { key: 'children', label: 'Children', note: '2 - 11 years',      min: 0, max: MAX_CHILDREN, limit: v => maxChildren(v.adults) },
    { key: 'infants',  label: 'Infants',  note: 'Under 2, on a lap', min: 0, max: MAX_INFANTS,  limit: v => maxInfants(v.adults) },
  ];

  let seq = 0;

  /* ---------------------------------------------------------------------
     The control
     --------------------------------------------------------------------- */
  /**
   * @param {Object}   opts
   * @param {Element|string} opts.mount    element (or id) the trigger renders into
   * @param {Object}   [opts.value]        starting party; clamped before use
   * @param {string}   [opts.label]        field label above the trigger
   * @param {Function} [opts.onChange]     called with the clamped value on change
   * @returns {{value, set, summary, refresh, open, close, destroy, trigger}}
   */
  function create(opts) {
    const host = typeof opts.mount === 'string' ? document.getElementById(opts.mount) : opts.mount;
    if (!host) return null;

    const id = 'pax' + (++seq);
    const labelText = opts.label || 'Passengers';
    let value = clamp(opts.value);
    let open = false;
    /* Set while a value change is applied, so the hint can say what had to
       give way rather than repeating the whole party back. */
    let lastAdjustment = '';

    host.innerHTML =
      '<label for="' + id + 'Btn" id="' + id + 'Label">' + esc(labelText) + '</label>' +
      '<button type="button" class="pax-trigger" id="' + id + 'Btn"' +
      /* aria-label, not aria-labelledby: the visible text can clamp to two lines
         and labelledby would win over it, so the accessible name has to be the
         one paintTrigger() writes with the full party in it. */
      ' aria-haspopup="dialog" aria-expanded="false">' +
      '<span class="pax-trigger-text">' + esc(summary(value)) + '</span>' +
      '<svg class="pax-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
      '</button>';

    const trigger = host.querySelector('#' + id + 'Btn');
    const triggerText = host.querySelector('.pax-trigger-text');

    /* Portalled, not a child of the field — see the header note about the
       hero's overflow:hidden. */
    const pop = document.createElement('div');
    pop.className = 'pax-pop';
    pop.id = id + 'Pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', labelText + ' - adults, children and infants');
    pop.hidden = true;
    document.body.appendChild(pop);
    trigger.setAttribute('aria-controls', pop.id);

    /* ------------------------------------------------------------------
       Painting
       ------------------------------------------------------------------ */
    function blockRow(g) {
      const allowed = g.limit(value);
      const current = value[g.key];
      let blocks = '';
      for (let n = g.min; n <= g.max; n++) {
        const on = n === current;
        const off = n > allowed;
        blocks += '<button type="button" class="pax-block' + (on ? ' is-on' : '') + '"' +
          ' role="radio" aria-checked="' + on + '" tabindex="' + (on ? '0' : '-1') + '"' +
          ' data-pax-key="' + g.key + '" data-pax-value="' + n + '"' +
          (off ? ' disabled aria-disabled="true"' : '') + '>' + n + '</button>';
      }
      return '<div class="pax-group" data-pax-group="' + g.key + '">' +
        '<div class="pax-group-head"><b>' + esc(g.label) + '</b><span>' + esc(g.note) + '</span></div>' +
        '<div class="pax-blocks" role="radiogroup" aria-label="' + esc(g.label) + '">' + blocks + '</div>' +
        '</div>';
    }

    /** The one line that explains why blocks are greyed out. It states the
     *  BINDING limit, not all four rules — somebody who has just filled the
     *  aircraft does not also need to be told about infants. */
    function hint() {
      if (lastAdjustment) return '<span class="is-adjusted">' + esc(lastAdjustment) + '</span>';
      const left = seatsLeft(value);
      if (!left) return 'Maximum ' + MAX_SEATED + ' passengers per booking.';
      if (value.children >= maxChildren(value.adults) && value.children > 0) {
        return 'Each child must travel with an adult.';
      }
      if (value.infants >= maxInfants(value.adults) && value.infants > 0) {
        return 'Each infant travels on the lap of an adult.';
      }
      return left + ' more passenger' + (left === 1 ? '' : 's') + ' can be added.';
    }

    function paint() {
      pop.innerHTML =
        '<div class="pax-pop-body">' + GROUPS.map(blockRow).join('') + '</div>' +
        '<div class="pax-pop-foot">' +
        '<p class="pax-hint" id="' + id + 'Hint" role="status">' + hint() + '</p>' +
        '<button type="button" class="pax-done" data-pax-done>Done</button>' +
        '</div>';
      paintTrigger();
    }

    /** The visible label can clamp to two lines, so the full party also goes on
     *  the button's title and accessible name — an ellipsised summary must not
     *  be the only place the numbers exist. */
    function paintTrigger() {
      const text = summary(value);
      triggerText.textContent = text;
      trigger.title = text;
      trigger.setAttribute('aria-label', labelText + ': ' + text);
    }

    /* ------------------------------------------------------------------
       Value
       ------------------------------------------------------------------ */
    /** @param quiet true while seeding, so onChange does not fire for a value
     *               the caller has just handed us. */
    function set(next, quiet) {
      const before = value;
      const wanted = Object.assign({}, before, next);
      const after = clamp(wanted);

      /* Rule 5's visible half: say what had to give way, rather than silently
         moving a number the traveller chose a moment ago. */
      const trimmed = [];
      if (after.children < toInt(wanted.children, after.children)) trimmed.push('Children');
      if (after.infants  < toInt(wanted.infants,  after.infants))  trimmed.push('Infants');
      lastAdjustment = trimmed.length
        ? trimmed.join(' and ') + ' reduced to fit ' + after.adults
          + ' adult' + (after.adults === 1 ? '' : 's') + '.'
        : '';

      const changed = after.adults !== before.adults
                   || after.children !== before.children
                   || after.infants !== before.infants;
      value = after;
      if (open) paint(); else paintTrigger();
      if (changed && !quiet && opts.onChange) opts.onChange(Object.assign({}, value));
      return Object.assign({}, value);
    }

    /* ------------------------------------------------------------------
       Open / close / position
       ------------------------------------------------------------------ */
    function place() {
      const r = trigger.getBoundingClientRect();
      /* Measured, not assumed: the panel's height changes with the hint line
         wrapping, and a guessed number flipped it onto the wrong side. */
      const h = pop.offsetHeight;
      const w = pop.offsetWidth;
      const gap = 8;
      const below = window.innerHeight - r.bottom;
      const flip = below < h + gap && r.top > below;

      /* Clamped, not merely flipped. On a short viewport neither side has room
         for the whole panel, and a flip alone still hung it off the bottom —
         so the chosen edge is then pulled back inside, and the panel's own
         max-height/overflow-y takes it from there. */
      let top = flip ? r.top - h - gap : r.bottom + gap;
      top = Math.min(top, window.innerHeight - h - gap);
      pop.style.top = Math.max(gap, top) + 'px';
      /* Nudged back inside the viewport where a left-aligned panel would run
         off it — the passengers field sits near the right end of the card. */
      let left = r.left;
      if (left + w > window.innerWidth - gap) left = window.innerWidth - w - gap;
      pop.style.left = Math.max(gap, left) + 'px';
      pop.classList.toggle('is-above', flip);
    }

    let raf = 0;
    const reposition = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; if (open) place(); });
    };

    function openPop() {
      if (open) return;
      open = true;
      lastAdjustment = '';
      paint();
      pop.hidden = false;
      /* Painted first so offsetHeight is real, then placed, then revealed —
         measuring a hidden element returns zero and drops it at the top. */
      place();
      pop.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      /* Land on the block that is already chosen, not the top of the panel. */
      const first = pop.querySelector('.pax-block.is-on');
      if (first) first.focus();
    }

    function closePop(returnFocus) {
      if (!open) return;
      open = false;
      pop.classList.remove('is-open');
      pop.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      paintTrigger();
      if (returnFocus) trigger.focus();
    }

    /** Re-focus the chosen block in a group after a repaint replaced the node
     *  the browser had focus on — losing focus to <body> breaks the keyboard
     *  flow mid-selection. */
    function refocus(key) {
      const el = pop.querySelector('[data-pax-group="' + key + '"] .pax-block.is-on');
      if (el) el.focus();
    }

    /* ------------------------------------------------------------------
       Wiring
       ------------------------------------------------------------------ */
    trigger.addEventListener('click', () => (open ? closePop() : openPop()));

    pop.addEventListener('click', e => {
      if (e.target.closest('[data-pax-done]')) { closePop(true); return; }
      const block = e.target.closest('[data-pax-value]');
      if (!block || block.disabled) return;
      set({ [block.dataset.paxKey]: Number(block.dataset.paxValue) });
      refocus(block.dataset.paxKey);
    });

    /* Arrow keys walk a row, Home/End jump to its ends — the behaviour
       role="radiogroup" promises a screen reader. */
    pop.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); closePop(true); return; }
      const block = e.target.closest('[data-pax-value]');
      if (!block) return;
      const row = Array.prototype.slice.call(
        block.closest('.pax-blocks').querySelectorAll('.pax-block:not([disabled])'));
      const at = row.indexOf(block);
      let to = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = Math.min(at + 1, row.length - 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = Math.max(at - 1, 0);
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = row.length - 1;
      else return;
      e.preventDefault();
      const next = row[to];
      if (!next) return;
      set({ [next.dataset.paxKey]: Number(next.dataset.paxValue) });
      refocus(next.dataset.paxKey);
    });

    /* CAPTURE PHASE, AND THAT IS THE WHOLE POINT.
       On the bubble phase this ran AFTER the panel's own click handler, which
       repaints — so the block that was just clicked had already been detached
       and `pop.contains(e.target)` was false. Every pick therefore read as a
       click outside and shut the panel: choosing "2 Adults" closed it, and
       every later change was applied to a hidden panel that never repainted.
       Capture runs before the repaint, when the node is still in the tree. */
    const onDocClick = e => {
      if (!open) return;
      if (pop.contains(e.target) || trigger.contains(e.target)) return;
      closePop();
    };
    document.addEventListener('click', onDocClick, true);

    function destroy() {
      closePop();
      document.removeEventListener('click', onDocClick, true);
      pop.remove();
    }

    /* Seeded values arrive from a URL anyone can edit, so they are clamped the
       same way a click is rather than trusted. */
    set(value, true);

    return {
      trigger: trigger,
      value: () => Object.assign({}, value),
      set: (v, quiet) => set(v, quiet),
      summary: () => summary(value),
      refresh: () => { if (open) paint(); else paintTrigger(); },
      open: openPop,
      close: closePop,
      destroy: destroy,
    };
  }

  return Object.assign({ create, rules }, rules);
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PaxSelector;
