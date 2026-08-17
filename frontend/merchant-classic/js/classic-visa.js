'use strict';
/* Classic — Visa Services.
   ===========================================================================
   Service-access-only in this phase (spec item 10): a placeholder page, no
   backend route, no fake applications. The nav item that leads here is
   revealed by classic-shell.js only when the session's service_access says
   visa is enabled — the same mechanism clNavApprovals already uses for a
   permission-gated item — and the deep-link guard there sends a merchant
   straight back to the Dashboard if they try to reach #visa without it. */

function clInitVisa() {
  $('cl-visa').innerHTML = `
    <div class="cl-page-head">
      <div><h1>Visa</h1></div>
    </div>
    <div class="cl-panel">
      <div class="cl-blank">
        <span class="cl-blank-ico">${clIco('shield', { size: 26 })}</span>
        <b>Visa Services</b>
        <p>Visa services will be available soon.</p>
      </div>
    </div>`;
}
