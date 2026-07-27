'use strict';
/* ==========================================================================
   confirm-dialog.js — reusable, promise-based confirmation dialog. Built on
   the exact .modal-overlay/.modal-card markup and classes already used
   throughout every portal (e.g. super-admin.html's own Sign Out
   confirmation, admin.html's onboard/create-user modals) -- same look,
   just generated dynamically instead of hand-written per dialog. New
   utility, not wired into any existing native confirm()/alert() call site
   -- those keep working exactly as they do today; this is here for new
   code that wants a themed dialog instead of the browser's native one.

   Usage:
     const ok = await confirmDialog({
       title: 'Delete this merchant?',
       message: 'This cannot be undone.',
       confirmText: 'Delete', danger: true,
     });
     if (ok) { ... }
   ========================================================================== */
function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:400px;">
        <h2>${escapeHtml(title)}</h2>
        ${message ? `<p style="font-size:13.5px; color:var(--text-muted); margin:-6px 0 4px;">${escapeHtml(message)}</p>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-coral'}" data-confirm>${escapeHtml(confirmText)}</button>
          <button type="button" class="btn btn-ghost" data-cancel>${escapeHtml(cancelText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const cleanup = result => { overlay.remove(); resolve(result); };
    overlay.querySelector('[data-confirm]').addEventListener('click', () => cleanup(true));
    overlay.querySelector('[data-cancel]').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
  });
}
