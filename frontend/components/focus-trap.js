'use strict';
/* ==========================================================================
   focus-trap.js — keyboard containment for modal dialogs.

   WHY THIS EXISTS
   Every portal here opens modals by toggling `.open` on a `.modal-overlay`.
   That shows the dialog but does nothing about focus: the page behind stays
   in the tab order, so Tab walks out of the dialog and into a form the user
   cannot see, and closing the dialog drops focus back to `<body>` — leaving a
   keyboard or screen-reader user with no idea where they are. Both are
   WCAG 2.1 failures (2.4.3 Focus Order, 2.1.2 No Keyboard Trap in reverse).

   WHAT IT DOES
     * moves focus into the dialog on open, preferring the first useful
       control over the close button — a dialog that opens focused on "×"
       reads as "the thing to do here is leave";
     * cycles Tab / Shift+Tab within the dialog;
     * marks the rest of the page `aria-hidden` so assistive tech does not
       announce it through the overlay;
     * restores focus to whatever opened the dialog, on close.

   WHAT IT DELIBERATELY DOES NOT DO
   It does not close on Escape or on an overlay click. Those already exist,
   per-modal, and differ: some need to confirm before discarding input. This
   owns focus and nothing else, so it can be dropped onto an existing modal
   without changing how that modal decides to close.

   USAGE
     const release = trapFocus(dialogEl);   // on open
     release();                             // on close
   Calling `release()` twice is safe. Re-trapping the same element re-runs the
   open behaviour, which is what a modal that re-renders its own body wants.
   ========================================================================== */

/* Anything a user can tab to. `:not([disabled])` and the tabindex="-1"
   exclusion matter: a disabled submit button or a programmatically-focusable
   wrapper must not become the boundary of the cycle. */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => {
    /* offsetParent is null for display:none — cheap, and correct for the
       collapsed sections and hidden rows these dialogs contain. Elements in a
       `position:fixed` subtree also report null, so the rect is the fallback. */
    if (el.offsetParent !== null) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  });
}

function trapFocus(dialog, { initialFocus = null } = {}) {
  if (!dialog) return () => {};

  const previouslyFocused = document.activeElement;
  const hidden = [];

  /* Hide the rest of the page from assistive tech. Only the dialog's own
     top-level siblings are touched, so nothing inside it is affected and the
     original aria-hidden values are restored on release. */
  const shell = dialog.closest('.modal-overlay') || dialog;
  [...document.body.children].forEach(node => {
    if (node === shell || node.contains(shell)) return;
    hidden.push([node, node.getAttribute('aria-hidden')]);
    node.setAttribute('aria-hidden', 'true');
  });

  const focusFirst = () => {
    if (initialFocus && typeof initialFocus.focus === 'function') {
      initialFocus.focus();
      return;
    }
    const items = focusableWithin(dialog);
    /* Skip the close button when there is anything else to land on. */
    const target = items.find(el => !el.hasAttribute('data-focus-trap-skip')) || items[0];
    if (target) target.focus();
    else {
      /* A dialog with no controls at all (a loading state) still needs to hold
         focus, or Tab escapes immediately. */
      dialog.setAttribute('tabindex', '-1');
      dialog.focus();
    }
  };
  focusFirst();

  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    const items = focusableWithin(dialog);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    /* activeElement may be outside the dialog if something stole focus — treat
       that as "wrap to the start" rather than letting Tab continue outside. */
    if (!dialog.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  }

  document.addEventListener('keydown', onKeydown, true);

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    document.removeEventListener('keydown', onKeydown, true);
    hidden.forEach(([node, previous]) => {
      if (previous === null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', previous);
    });
    /* Restore focus only if it is still inside the dialog we are closing —
       if the user has already clicked elsewhere, yanking it back is worse
       than leaving it. */
    if (previouslyFocused && typeof previouslyFocused.focus === 'function'
        && (dialog.contains(document.activeElement) || document.activeElement === document.body)) {
      previouslyFocused.focus();
    }
  };
}
