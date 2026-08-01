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

/* ---------------------------------------------------------------------------
   moneyStr — for values that came from finance_service (M4).

   `money()` above does `Math.round(n)`. On a count or a headline figure that is
   fine, and it has been fine for a year. On a ledger it is two bugs: it makes a
   float out of a value the backend went to some trouble to keep as `Decimal`,
   and it discards the paise — so a ₹24,500.50 balance renders ₹24,501 and a
   running balance visibly stops adding up.

   `Decimal` fields cross the wire as JSON *strings* precisely so a float cannot
   get near them. This keeps them strings: it groups the integer part by hand
   (Indian convention — 27,14,760) and leaves the fraction exactly as sent.
   Nothing here parses, rounds or sums.

   Use this for anything that came from finance_service. `money()` remains
   correct for everything else.
   --------------------------------------------------------------------------- */
function moneyStr(value, { currency = '₹', dash = '—' } = {}) {
  if (value === null || value === undefined || value === '') return dash;
  const raw = String(value).trim();
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  /* `(\d{2})*` and not `+`: the comma before the final triple has no pair after
     it, so requiring at least one pair skips it and renders 27,14760. */
  const grouped = whole.replace(/\B(?=(\d{2})*(\d{3})$)/g, ',');
  return `${negative ? '-' : ''}${currency}${grouped}${fraction ? '.' + fraction : ''}`;
}

/* Is a decimal string greater than zero, without parsing it? Used to decide
   whether to show a figure at all — never to compare two amounts. */
function moneyIsPositive(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('-')) return false;
  return /[1-9]/.test(raw);
}

function fmtDate(s) { return s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function fmtDateTime(s) { return s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
function fmtTime(s) { return s ? new Date(s).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—'; }
