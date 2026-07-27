'use strict';
/* ==========================================================================
   formatters.js — small display-formatting helpers used by every portal.
   Previously copy-pasted (byte-for-byte identical, except money() -- see
   below) into admin.js, app.js, and partner-shared.js. This is now the one
   canonical definition; those three files no longer define their own.
   ========================================================================== */

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* partner-shared.js's version null-guarded (n == null ? '—' : ...); admin.js/
   app.js's did not, and would render "₹NaN" for a missing amount. The
   null-safe version is the canonical one -- strictly safer, identical
   output for every real number either version was ever actually called
   with. */
function money(n) { return n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'); }

function fmtDate(s) { return s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function fmtDateTime(s) { return s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
function fmtTime(s) { return s ? new Date(s).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—'; }
