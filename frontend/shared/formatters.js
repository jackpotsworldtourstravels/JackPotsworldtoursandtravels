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

/* ---------------------------------------------------------------------------
   groupThousands / moneyIntl — the INTERNATIONAL grouping, three digits at a
   time: 1,000 · 10,000 · 100,000 · 1,000,000 · 10,000,000.

   `moneyStr` above groups the Indian way (10,00,000) and stays the portal's
   default for every amount we bill, hold or settle — those are rupee figures
   read by an Indian desk. This pair exists for the **client fare**: what a
   merchant charges its own end customer, which the spec asks to be shown in the
   international convention wherever it appears, in both portals.

   Same string-in, string-out discipline as `moneyStr`: nothing here parses,
   rounds or sums, so a Decimal that crossed the wire as a string keeps every
   paise it was sent with.
   --------------------------------------------------------------------------- */
function groupThousands(digits) {
  return String(digits ?? '').replace(/\B(?=(\d{3})+$)/g, ',');
}

function moneyIntl(value, { currency = '₹', dash = '—' } = {}) {
  if (value === null || value === undefined || value === '') return dash;
  const raw = String(value).trim();
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  return `${negative ? '-' : ''}${currency}${groupThousands(whole)}${fraction ? '.' + fraction : ''}`;
}

/* Is a decimal string greater than zero, without parsing it? Used to decide
   whether to show a figure at all — never to compare two amounts. */
function moneyIsPositive(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('-')) return false;
  return /[1-9]/.test(raw);
}

/* The SIGN of a decimal string: -1, 0 or 1 — again without parsing it.
   ===========================================================================
   `Number("-0.00")` is `-0`, and `-0 < 0` is false, so a float round trip gets
   the one case this exists for exactly wrong. Reading the characters cannot:
   a leading "-" with any non-zero digit after it is negative, any non-zero
   digit without one is positive, and everything else — "0", "0.00", "-0.00",
   "" — is zero.

   Every screen that colours money by sign asks this, so red/green/neutral means
   the same thing in the merchant portal, the admin desk and the wallet ledger
   rather than three files each having a slightly different idea of zero. */
function moneySign(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !/[1-9]/.test(raw)) return 0;
  return raw.startsWith('-') ? -1 : 1;
}

/* The class name for that sign. Defined here beside moneySign so a caller
   cannot pick the colour and the sign from two different rules.

   `zero` deliberately gets the neutral weight, never green: a merchant whose
   wallet has just hit exactly nothing is not in a good state, and a green zero
   says it is. */
function moneyToneClass(value, prefix = 'cl-money') {
  const s = moneySign(value);
  return `${prefix}-${s < 0 ? 'neg' : s > 0 ? 'pos' : 'zero'}`;
}

/* ---------------------------------------------------------------------------
   tripTypeLabel / tripTypeArrow — the itinerary's trip type, spelled once.

   THIS EXISTS BECAUSE ADDING A THIRD VALUE BROKE SEVEN SCREENS AT ONCE.
   Every surface that showed a trip type wrote it as a binary ternary —
   `d.trip_type === 'round_trip' ? 'Round Trip' : 'One Way'` — in the merchant
   portal, the booking detail, the Admin bookings table, the Admin enquiry
   drawer, Booking Operations and the Manager queue. That is correct for exactly
   two values and silently mislabels every later one: `group_trip` would have
   rendered as "One Way" on all six, with nothing failing to announce it.

   A trip type is now named in one place, so a seventh screen cannot disagree
   and an eighth value only has to be added here. Unknown values fall back to
   the raw string rather than to a wrong label — a booking that reads
   "charter_trip" is a bug report; one that reads "One Way" is a wrong booking.
   --------------------------------------------------------------------------- */
const TRIP_TYPE_LABELS = {
  one_way: 'One Way',
  round_trip: 'Round Trip',
  /* "Group Booking" on every surface, matching the label the merchant chooses
     on the form. The shape — One Way Group or Round Trip Group — lives in
     `group_journey_type` and is appended by the screens that show it. */
  group_trip: 'Group Booking',
};

/* The full name of a group booking's shape, or null when it is not one.
   Here rather than in six screens for the reason the labels above are: a trip
   type named in one place cannot be named differently in another. */
const GROUP_JOURNEY_LABELS = {
  one_way_group: 'One Way Group',
  round_trip_group: 'Round Trip Group',
};
function groupJourneyLabel(t) {
  return GROUP_JOURNEY_LABELS[t] || null;
}
function tripTypeLabel(t) {
  return TRIP_TYPE_LABELS[t] || (t ? String(t).replace(/_/g, ' ') : '—');
}

/* The route glyph. Only a round trip comes back, so only it gets the two-way
   arrow — a group trip is one-way in the only sense this symbol reports. */
function tripTypeArrow(t) { return t === 'round_trip' ? '⇄' : '→'; }

/* AN ABSENT AIRLINE IS AN ANSWER, NOT A GAP.
   ===========================================================================
   The enquiry form defaults to "All Airlines" and sends no airline at all for
   it, so `null` here means the merchant deliberately left the carrier open and
   is asking us to quote whatever is best. Rendering that as "—" would make an
   open enquiry indistinguishable from one where the field failed to save, and
   the desk answering it would have no way to tell that it may quote freely.

   Here rather than in the ten screens that show an airline, for the same reason
   the trip-type labels above are: one fact, named one way, in six portals.

   `fmtFlightNumber` keeps the dash on purpose — an unstated flight number is
   genuinely "nothing to show", not a choice with a name. */
const ANY_AIRLINE_LABEL = 'All Airlines';
function fmtAirline(v) {
  const t = (v ?? '').toString().trim();
  return t || ANY_AIRLINE_LABEL;
}
function fmtFlightNumber(v) {
  const t = (v ?? '').toString().trim();
  return t || '—';
}

function fmtDate(s) { return s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function fmtDateTime(s) { return s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
function fmtTime(s) { return s ? new Date(s).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—'; }
