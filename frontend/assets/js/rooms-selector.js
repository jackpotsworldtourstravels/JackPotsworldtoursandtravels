'use strict';
/* ===========================================================================
   rooms-selector.js — the Rooms & Guests picker, and the rules behind it.
   ===========================================================================
   The hotel counterpart to pax-selector.js, and split the same way for the same
   reason:

     RoomsSelector.rules — pure functions over a rooms array. No DOM, no state.
     This is what validation and the URL reader call; a rule that only lives in
     a click handler can only be enforced by clicking.

     RoomsSelector.create() — the popover that renders those rules and keeps a
     value in sync.

   THE SHAPE IS AN ARRAY OF ROOMS, NOT A PARTY.
       [{ adults: 2, children: 1, childAges: [7] }, ...]
   A hotel prices per room, so two adults in one room and two adults in two
   rooms are different bookings and cannot share a representation. Flights are
   the opposite — one cabin, one party — which is why PaxSelector is a single
   {adults, children, infants} and this is not.

   CHILD AGES START UNSET, ON PURPOSE. An age changes whether a child needs a
   bed, counts toward occupancy, or stays free, so a default of "8" would be the
   system quietly answering a question only the guest can. `null` here means
   "not chosen yet", isComplete() reports it, and validation refuses the search
   until every one is filled in.

   MAX_ROOMS IS 4 BECAUSE THAT IS THE STANDARD MODE'S LIMIT. Anything larger is
   the Group Deals enquiry, which is a different flow with a different
   submission, not this control with a bigger number in it.
   =========================================================================== */

const RoomsSelector = (function () {

  const MAX_ROOMS            = 4;
  const MIN_ADULTS_PER_ROOM  = 1;
  const MAX_ADULTS_PER_ROOM  = 8;
  const MAX_CHILDREN_PER_ROOM = 4;
  const CHILD_AGE_MIN = 0;
  const CHILD_AGE_MAX = 17;

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const W = () => (typeof SearchWidgets !== 'undefined' ? SearchWidgets : null);

  const toInt = (n, dflt) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) ? v : dflt;
  };

  const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* ---------------------------------------------------------------------
     Rules — pure, DOM-free, the only place the limits are decided.
     --------------------------------------------------------------------- */

  function blankRoom() {
    return { adults: 2, children: 0, childAges: [] };
  }

  /** Force anything into a legal rooms array.
   *
   *  childAges is resized WITH the child count rather than beside it: a room
   *  that drops from 3 children to 1 must not keep a third age hanging around
   *  to be submitted, and one that grows must gain a null to be filled in, not
   *  silently inherit the age of a child who is no longer on the booking. */
  function clamp(rooms, maxRooms) {
    const cap = maxRooms || MAX_ROOMS;
    const list = Array.isArray(rooms) && rooms.length ? rooms : [blankRoom()];
    return list.slice(0, cap).map(r => {
      const adults = clampNum(toInt(r && r.adults, 2), MIN_ADULTS_PER_ROOM, MAX_ADULTS_PER_ROOM);
      const children = clampNum(toInt(r && r.children, 0), 0, MAX_CHILDREN_PER_ROOM);
      const ages = Array.isArray(r && r.childAges) ? r.childAges : [];
      return {
        adults,
        children,
        childAges: Array.from({ length: children }, (_, i) => {
          const a = toInt(ages[i], null);
          return (a === null || a < CHILD_AGE_MIN || a > CHILD_AGE_MAX) ? null : a;
        }),
      };
    });
  }

  function totals(rooms) {
    return clamp(rooms).reduce((a, r) => ({
      adults: a.adults + r.adults,
      children: a.children + r.children,
    }), { adults: 0, children: 0 });
  }

  /** Every child still waiting for an age, as {room, child} 1-based pairs.
   *  Returned as a list rather than a boolean so the message can name the one
   *  that is missing instead of saying "some age is missing somewhere". */
  function missingAges(rooms) {
    const out = [];
    clamp(rooms).forEach((room, i) => {
      room.childAges.forEach((age, c) => {
        if (age === null) out.push({ room: i + 1, child: c + 1, roomIndex: i, childIndex: c });
      });
    });
    return out;
  }

  const isComplete = rooms => missingAges(rooms).length === 0;

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  /** "2 Rooms • 4 Adults • 2 Children". Zero children is left out entirely
   *  rather than printed as "0 Children", which reads as a mistake. */
  function summary(rooms) {
    const list = clamp(rooms);
    const t = totals(list);
    const parts = [
      plural(list.length, 'Room', 'Rooms'),
      plural(t.adults, 'Adult', 'Adults'),
    ];
    if (t.children) parts.push(plural(t.children, 'Child', 'Children'));
    return parts.join(' • ');
  }

  const rules = {
    MAX_ROOMS, MIN_ADULTS_PER_ROOM, MAX_ADULTS_PER_ROOM, MAX_CHILDREN_PER_ROOM,
    CHILD_AGE_MIN, CHILD_AGE_MAX,
    blankRoom, clamp, totals, missingAges, isComplete, summary,
  };

  /* ---------------------------------------------------------------------
     The control
     --------------------------------------------------------------------- */
  let seq = 0;

  /**
   * @param {Object} opts
   * @param {Element|string} opts.mount   element (or id) the trigger renders into
   * @param {Array}  [opts.value]         starting rooms; clamped before use
   * @param {string} [opts.label]         field label above the trigger
   * @param {Function} [opts.onChange]    called with the clamped rooms on change
   */
  function create(opts) {
    const host = typeof opts.mount === 'string' ? document.getElementById(opts.mount) : opts.mount;
    if (!host) return null;

    const id = 'rm' + (++seq);
    const labelText = opts.label || 'Rooms & Guests';
    let value = clamp(opts.value);
    let open = false;

    host.innerHTML =
      '<label for="' + id + 'Btn" id="' + id + 'Label">' + esc(labelText) + '</label>'
      + '<button type="button" class="pax-trigger" id="' + id + 'Btn"'
      + ' aria-haspopup="dialog" aria-expanded="false">'
      + '<span class="pax-trigger-text"></span>'
      + '<svg class="pax-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
      + '</button>';

    const trigger = host.querySelector('#' + id + 'Btn');
    const triggerText = host.querySelector('.pax-trigger-text');

    /* Portalled for the same reason the passenger popover and the airport
       lists are: .search-card carries a backdrop-filter, which both clips an
       absolutely positioned child and captures a fixed one. */
    const pop = document.createElement('div');
    pop.className = 'pax-pop rooms-pop';
    pop.id = id + 'Pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', labelText);
    pop.hidden = true;
    document.body.appendChild(pop);
    trigger.setAttribute('aria-controls', pop.id);

    /* ------------------------------------------------------------------
       Painting
       ------------------------------------------------------------------ */
    const AGE_OPTIONS = Array.from({ length: CHILD_AGE_MAX - CHILD_AGE_MIN + 1 },
                                   (_, i) => CHILD_AGE_MIN + i);

    /** A +/- row. SearchWidgets.stepperRow is the shared markup helper every
     *  other stepper in the product uses; only the skin is ours. */
    function stepper(key, label, note, val, min, max, roomIdx) {
      const w = W();
      if (w) return w.stepperRow(key, label, note, val, min, max, 'data-room-idx="' + roomIdx + '"');
      /* search-widgets.js absent (it is not on every page): a plain fallback so
         the control still works rather than rendering nothing. */
      return '<div class="tx-pax-row"><div><b>' + esc(label) + '</b><span>' + esc(note) + '</span></div>'
        + '<div class="tx-pax-step">'
        + '<button type="button" class="tx-pax-btn" data-step-key="' + key + '" data-delta="-1"'
        + ' data-room-idx="' + roomIdx + '"' + (val <= min ? ' disabled' : '')
        + ' aria-label="One fewer ' + esc(label) + '">&minus;</button>'
        + '<output>' + val + '</output>'
        + '<button type="button" class="tx-pax-btn" data-step-key="' + key + '" data-delta="1"'
        + ' data-room-idx="' + roomIdx + '"' + (val >= max ? ' disabled' : '')
        + ' aria-label="One more ' + esc(label) + '">+</button>'
        + '</div></div>';
    }

    function ageGrid(room, i) {
      if (!room.children) return '';
      const cells = room.childAges.map((age, c) =>
        '<label class="rooms-age' + (age === null ? ' is-unset' : '') + '">'
        + '<span>Child ' + (c + 1) + '</span>'
        + '<select data-room-age="' + i + '" data-child="' + c + '"'
        + ' aria-label="Age of child ' + (c + 1) + ' in room ' + (i + 1) + '">'
        + '<option value=""' + (age === null ? ' selected' : '') + '>Age</option>'
        + AGE_OPTIONS.map(a => '<option value="' + a + '"' + (age === a ? ' selected' : '') + '>'
            + (a === 0 ? 'Under 1' : a) + '</option>').join('')
        + '</select></label>').join('');
      return '<div class="rooms-ages"><b>Child ages at check-in</b>'
        + '<div class="rooms-agegrid">' + cells + '</div></div>';
    }

    function paint() {
      const rooms = value.map((room, i) =>
        '<section class="rooms-room" data-room="' + i + '">'
        + '<header class="rooms-room-head"><b>Room ' + (i + 1) + '</b>'
        + (value.length > 1
            ? '<button type="button" class="rooms-remove" data-remove-room="' + i + '"'
              + ' aria-label="Remove room ' + (i + 1) + '">Remove</button>'
            : '')
        + '</header>'
        + stepper('adults', 'Adults', '18 and over', room.adults,
                  MIN_ADULTS_PER_ROOM, MAX_ADULTS_PER_ROOM, i)
        + stepper('children', 'Children', '0 to 17 years', room.children,
                  0, MAX_CHILDREN_PER_ROOM, i)
        + ageGrid(room, i)
        + '</section>').join('');

      const atCap = value.length >= MAX_ROOMS;
      pop.innerHTML =
        '<div class="rooms-list">' + rooms + '</div>'
        + '<button type="button" class="mc-add rooms-add" data-add-room' + (atCap ? ' disabled' : '') + '>'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"'
        + ' aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add another room</button>'
        + '<div class="pax-pop-foot">'
        + '<p class="pax-hint" role="status">' + hint(atCap) + '</p>'
        + '<button type="button" class="pax-done" data-rooms-done>Done</button>'
        + '</div>';
      paintTrigger();
    }

    function hint(atCap) {
      const missing = missingAges(value);
      if (missing.length) {
        const m = missing[0];
        return '<span class="is-adjusted">Choose an age for child ' + m.child
          + ' in room ' + m.room + '.</span>';
      }
      if (atCap) {
        return MAX_ROOMS + ' rooms is the most that can be booked here — '
          + 'switch to Group Deals for a larger party.';
      }
      const t = totals(value);
      return t.adults + t.children === 0 ? '' : 'Rates are quoted per room, per night.';
    }

    function paintTrigger() {
      const text = summary(value);
      triggerText.textContent = text;
      trigger.title = text;
      trigger.setAttribute('aria-label', labelText + ': ' + text);
    }

    /* ------------------------------------------------------------------
       Value
       ------------------------------------------------------------------ */
    function set(next, quiet) {
      const after = clamp(next);
      const changed = JSON.stringify(after) !== JSON.stringify(value);
      value = after;
      if (open) paint(); else paintTrigger();
      if (changed && !quiet && opts.onChange) opts.onChange(copy());
      return copy();
    }

    const copy = () => value.map(r => ({
      adults: r.adults, children: r.children, childAges: r.childAges.slice(),
    }));

    /* ------------------------------------------------------------------
       Open / close / position
       ------------------------------------------------------------------ */
    function place() {
      const field = trigger.closest('.field') || trigger;
      const r = field.getBoundingClientRect();
      const h = pop.offsetHeight;
      const w = pop.offsetWidth;
      const gap = 8;
      const below = window.innerHeight - r.bottom;
      const flip = below < h + gap && r.top > below;
      let top = flip ? r.top - h - gap : r.bottom + gap;
      top = Math.min(top, window.innerHeight - h - gap);
      pop.style.top = Math.max(gap, top) + 'px';
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
      paint();
      pop.hidden = false;
      place();
      pop.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      /* Land on the first thing still needing an answer, if there is one. */
      const gap = pop.querySelector('.rooms-age.is-unset select');
      (gap || pop.querySelector('.tx-pax-btn:not([disabled])') || pop).focus();
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

    /* ------------------------------------------------------------------
       Wiring
       ------------------------------------------------------------------ */
    trigger.addEventListener('click', () => (open ? closePop() : openPop()));

    pop.addEventListener('click', e => {
      if (e.target.closest('[data-rooms-done]')) { closePop(true); return; }

      const step = e.target.closest('[data-step-key]');
      if (step) {
        const i = Number(step.dataset.roomIdx);
        const key = String(step.dataset.stepKey).replace(/\d+$/, '');
        const delta = Number(step.dataset.delta);
        const next = copy();
        const room = next[i];
        if (!room) return;
        room[key] = room[key] + delta;
        /* A child added here has no age yet, and clamp() is what puts the null
           in — the count and the ages array are resized together in one place
           rather than by every caller that changes a count. */
        set(next);
        /* Adding a child should land the traveller on the age they now owe. */
        if (key === 'children' && delta > 0) {
          const sel = pop.querySelector('[data-room-age="' + i + '"][data-child="' + (room.children - 1) + '"]');
          if (sel) sel.focus();
        } else {
          refocusStep(i, key, delta);
        }
        return;
      }

      const rm = e.target.closest('[data-remove-room]');
      if (rm) {
        const next = copy();
        next.splice(Number(rm.dataset.removeRoom), 1);
        set(next);
        const add = pop.querySelector('[data-add-room]');
        if (add) add.focus();
        return;
      }

      if (e.target.closest('[data-add-room]')) {
        if (value.length >= MAX_ROOMS) return;
        set(copy().concat([blankRoom()]));
        /* The new room's own controls are what they came for. */
        const last = pop.querySelector('.rooms-room:last-of-type .tx-pax-btn:not([disabled])');
        if (last) last.focus();
      }
    });

    /** Put focus back on the same button after a repaint replaced it. */
    function refocusStep(i, key, delta) {
      const sel = '[data-room-idx="' + i + '"][data-step-key^="' + key + '"][data-delta="' + delta + '"]';
      const btn = pop.querySelector(sel);
      if (btn && !btn.disabled) btn.focus();
      else {
        const any = pop.querySelector('[data-room-idx="' + i + '"][data-step-key^="' + key + '"]:not([disabled])');
        if (any) any.focus();
      }
    }

    pop.addEventListener('change', e => {
      const age = e.target.closest('[data-room-age]');
      if (!age) return;
      const next = copy();
      const room = next[Number(age.dataset.roomAge)];
      if (!room) return;
      room.childAges[Number(age.dataset.child)] = age.value === '' ? null : Number(age.value);
      set(next);
      /* Repaint replaced the <select>; put the caret back on it so a keyboard
         user can carry straight on to the next child. */
      const again = pop.querySelector('[data-room-age="' + age.dataset.roomAge
        + '"][data-child="' + age.dataset.child + '"]');
      if (again) again.focus();
    });

    pop.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); closePop(true); }
    });

    /* Capture, for the same reason pax-selector uses capture: the panel
       repaints on click, so by the bubble phase the clicked node is detached
       and a containment test reads it as a click outside. */
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

    set(value, true);

    return {
      trigger,
      value: copy,
      set: (v, quiet) => set(v, quiet),
      summary: () => summary(value),
      missingAges: () => missingAges(value),
      isComplete: () => isComplete(value),
      totals: () => totals(value),
      refresh: () => { if (open) paint(); else paintTrigger(); },
      open: openPop,
      close: closePop,
      destroy,
    };
  }

  return Object.assign({ create, rules }, rules);
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RoomsSelector;
