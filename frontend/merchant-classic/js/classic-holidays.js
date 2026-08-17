'use strict';
/* Classic — Holidays.
   ===========================================================================
   Service-access-only, same posture as classic-visa.js when Visa first
   shipped: a placeholder page, no backend route, no fake packages. The nav
   item that leads here is revealed by classic-shell.js only when the
   session's service_access says holidays is enabled — the same mechanism
   clNavVisa already uses — and the deep-link guard there sends a merchant
   straight back to the Dashboard if they try to reach #holidays without it. */

function clInitHolidays() {
  $('cl-holidays').innerHTML = `
    <div class="cl-page-head">
      <div><h1>Holidays</h1></div>
    </div>
    <div class="cl-panel">
      <div class="cl-blank">
        <span class="cl-blank-ico">${clIco('sun', { size: 26 })}</span>
        <b>Holiday Packages</b>
        <p>Holiday packages will be available soon.</p>
      </div>
    </div>`;
}
