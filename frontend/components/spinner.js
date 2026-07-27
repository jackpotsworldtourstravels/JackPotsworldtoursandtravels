'use strict';
/* ==========================================================================
   spinner.js — small reusable loading-spinner helper. New (no existing page
   had a shared spinner before this -- the app previously showed loading
   state per-page as literal "Loading…" text, e.g. every admin.html table's
   `<tr><td class="empty-state">Loading…</td></tr>` and the .btn-coral
   "Creating…" label swap in the Merchant Management Create User page).
   This does not replace those -- it's additive, for new code that wants a
   visual spinner instead of a text placeholder. Styled with each portal's
   own --border-color/--coral CSS variables, so it matches whichever portal
   it's used in without its own stylesheet.
   ========================================================================== */
function showSpinner(container) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.innerHTML = '<span class="jp-spinner" aria-label="Loading" role="status"></span>';
  if (!document.getElementById('jp-spinner-style')) {
    const style = document.createElement('style');
    style.id = 'jp-spinner-style';
    style.textContent = `
      .jp-spinner{display:inline-block; width:22px; height:22px; border-radius:50%;
        border:3px solid var(--border-color, rgba(0,0,0,0.1)); border-top-color:var(--coral, #FF6B35);
        animation:jp-spin .7s linear infinite;}
      @keyframes jp-spin{to{transform:rotate(360deg);}}
    `;
    document.head.appendChild(style);
  }
}
function hideSpinner(container) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (el) el.innerHTML = '';
}
