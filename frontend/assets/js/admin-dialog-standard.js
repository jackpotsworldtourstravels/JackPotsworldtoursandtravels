/* =============================================================================
   ADMIN DIALOG STANDARD — the header close control                 2026-08-04
   =============================================================================
   Companion to jp-ds.css §15. That section standardises the frame, the grid,
   the inputs and the footer of every Admin dialog purely in CSS, because the
   builders already emit the vocabulary it styles. The ONE part of the standard
   a stylesheet cannot deliver is the close button in the header, since most
   dialogs never render one — so it is added here, once, for all of them.

   WHY A GENERIC INJECTOR RATHER THAN SEVENTEEN BUILDER EDITS
   The dialogs are empty shells filled by template literals in ten different
   JS files. Adding a button to each builder would mean seventeen edits to code
   that also constructs payloads, and this work is not allowed to touch a field,
   a validation rule or a workflow. Watching for a dialog to open and decorating
   its header touches none of that.

   HOW IT CLOSES — AND WHY IT DOES NOT JUST REMOVE `.open`
   Two of these dialogs (wdReview, wdLedger) and two more (prRaise, prDetail)
   install a FOCUS TRAP when they open, and release it in their backdrop-click
   handler. A close button that only removed `.open` would
   hide the dialog and leave the trap live — keyboard focus cycling inside an
   invisible element, with no way out. So the button replays the dialog's own
   dismiss path in priority order:

     1. Dispatch a click on the overlay itself. Every handler in the portal
        tests `e.target === overlay`, so this is exactly the backdrop click the
        dialog already handles — releasing its trap, calling its own
        `opsCloseWork()` / `provCloseModal()` / `done(null)` as applicable.
     2. If the dialog has no such handler and is therefore still open, remove
        `.open`, which is what its own Cancel button does.

   Reusing path 1 means this file never has to know which dialogs trap focus,
   which is the sort of list that goes stale the moment someone adds a dialog.
   ========================================================================== */

(function () {
  'use strict';

  /* The drawer and the operations modals already ship their own close control
     (`.profile-header-close`, `.ops-modal-close`), so they are left alone —
     a second X in the same corner is worse than none. */
  var SKIP_IF_PRESENT = '.jp-dlg-x, .ops-modal-close, .profile-header-close';

  function closeDialog(overlay) {
    /* Path 1 — the dialog's own backdrop dismiss. */
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    /* Path 2 — nothing listened, so fall back to what Cancel does. */
    if (overlay.classList.contains('open')) overlay.classList.remove('open');
  }

  function decorate(overlay) {
    var card = overlay.querySelector('.modal-card');
    if (!card) return;
    /* Only headers the standard actually styles: a direct `<h2>` child. A
       dialog that builds its own head (`.ops-modal-head`) is not ours. */
    var head = card.querySelector(':scope > h2');
    if (!head || head.querySelector(SKIP_IF_PRESENT)) return;

    var btn = document.createElement('button');
    btn.type = 'button';                 /* never submit the form it sits above */
    btn.className = 'jp-dlg-x';
    btn.setAttribute('aria-label', 'Close dialog');
    btn.innerHTML = '&times;';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();               /* do not re-enter via the card */
      closeDialog(overlay);
    });
    head.appendChild(btn);
  }

  function watch(overlay) {
    if (overlay.dataset.jpDlgWatched) return;
    overlay.dataset.jpDlgWatched = '1';

    /* TWO OBSERVERS, AND THE SECOND ONE IS NOT OPTIONAL.
       Watching `.open` alone is not enough: `openRaisePaymentRequestModal` is
       async and AWAITS its data before writing innerHTML, so the dialog is
       already open — and still empty — when the class observer fires. A
       requestAnimationFrame retry does not help either, because the await
       resolves a macrotask later than the frame. That dialog was the one that
       came back without a close button when this file only watched the class.

       So the content itself is observed too, and the decoration is re-applied
       whenever the card's children change while it is open. That also covers
       a builder re-rendering its body in place, which would otherwise discard
       the button silently. */
    new MutationObserver(function () {
      if (overlay.classList.contains('open')) decorate(overlay);
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });

    new MutationObserver(function () {
      if (overlay.classList.contains('open')) decorate(overlay);
    }).observe(overlay, { childList: true, subtree: true });
  }

  function init() {
    document.querySelectorAll('.modal-overlay').forEach(watch);

    /* DIALOGS THAT DO NOT EXIST YET ALSO NEED THE BUTTON.       (2026-08-10)
       The scan above only ever saw the overlays hard-coded in admin/index.html.
       Two dialogs are BUILT AT CALL TIME and appended to <body> — confirmDialog()
       in components/confirm-dialog.js and promptDialog() in admin-bookings.js —
       so they were never watched and never decorated: every other dialog in the
       portal had an X in its header and those two did not.

       They open the instant they are appended (`class="modal-overlay open"`),
       which is why they are decorated here directly as well as watched: the
       class observer inside watch() only fires on a LATER change, and for these
       two the class is already correct on arrival. */
    new MutationObserver(function (records) {
      records.forEach(function (rec) {
        rec.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('modal-overlay')) {
            watch(node);
            if (node.classList.contains('open')) decorate(node);
          }
        });
      });
    }).observe(document.body, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
