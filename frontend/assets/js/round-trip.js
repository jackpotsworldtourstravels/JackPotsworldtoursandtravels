'use strict';
/* ===========================================================================
   round-trip.js — the round-trip rules that have nothing to do with the DOM.
   ===========================================================================
   Pairing an onward and a return flight, pricing the pair, and the few facts a
   trip card prints about it (refundability, baggage). Pure functions over plain
   objects, so each rule can be tested on its own: travel-explore.js supplies
   the search state and the clock, this file never reads either.

   PRICING FOLLOWS THE SERVER, NOT THE OTHER WAY ROUND. The number a traveller
   is shown here has to be the number the booking flow then quotes
   (customer_pricing_service.py), so the same rules are applied:
     - the cabin multiplier scales each leg's fare and taxes, rounded per
       traveller BEFORE multiplying (JavaScript's Math.round, as the server's
       `_js_round` does);
     - an infant does not pay: the party is adults + children, never fewer than
       one;
     - a leg priced by a SUPPLIER (priceBasis 'party') already covers the whole
       party and the cabin the supplier was asked for, so it is added as it is
       and never multiplied again.

   A pair exists only when both legs exist in the data returned for their own
   direction. Nothing here invents a flight, a time or a fare.
   =========================================================================== */

const RoundTrip = (function () {

  /** A return that takes off sooner than this after the onward flight lands is
   *  not a connection a traveller can make. */
  const MIN_TURNAROUND_MIN = 90;

  /** Math.round: round-half-up for the positive numbers that occur here. The
   *  server's `_js_round` exists to match this exactly. */
  const jsRound = n => Math.round(Number(n));

  /** Travellers who pay a fare: adults and children, never fewer than one. An
   *  infant does not occupy a seat and is not charged one. */
  function payingTravellers(pax) {
    const p = pax || {};
    return Math.max(1, (Number(p.adults) || 0) + (Number(p.children) || 0));
  }

  const hasPrice = f => !!f && f.total != null && f.fare != null && f.taxes != null;

  /** What the pair costs, for this party in this cabin.
   *
   *  @param {object} out        onward flight (travel-data normalised)
   *  @param {object} ret        return flight
   *  @param {{pax?:object, multiplier?:number}} [o]
   *  @returns {{known:boolean, basis:'per-traveller'|'party'|null,
   *             perTraveller:number|null, party:number|null,
   *             fare:number|null, taxes:number|null, paying:number}}
   */
  function priceTrip(out, ret, o) {
    const opts = o || {};
    const paying = payingTravellers(opts.pax);
    const unknown = { known: false, basis: null, perTraveller: null, party: null, fare: null, taxes: null, paying };
    if (!hasPrice(out) || !hasPrice(ret)) return unknown;

    const bases = [out, ret].map(f => (f.priceBasis === 'party' ? 'party' : 'per-traveller'));
    if (bases[0] !== bases[1]) return unknown;    // two different bases cannot be added honestly

    if (bases[0] === 'party') {
      const fare = Number(out.fare) + Number(ret.fare);
      const taxes = Number(out.taxes) + Number(ret.taxes);
      return { known: true, basis: 'party', perTraveller: null, party: Number(out.total) + Number(ret.total),
               fare, taxes, paying };
    }

    const mult = Number(opts.multiplier) > 0 ? Number(opts.multiplier) : 1;
    let unitFare = 0;
    let unitTaxes = 0;
    [out, ret].forEach(f => {
      unitFare += jsRound(Number(f.fare) * mult);
      unitTaxes += jsRound(Number(f.taxes) * mult);
    });
    return { known: true, basis: 'per-traveller', perTraveller: unitFare + unitTaxes,
             party: (unitFare + unitTaxes) * paying,
             fare: unitFare * paying, taxes: unitTaxes * paying, paying };
  }

  /** Refundability of a pair. Tri-state, like the data: unknown stays unknown.
   *  Only two known `true`s make a refundable trip, and any known `false` makes
   *  it non-refundable; an unknown leg beside a refundable one is unknown. */
  function combineRefundable(a, b) {
    if (a === false || b === false) return false;
    if (a === true && b === true) return true;
    return null;
  }

  /** A baggage allowance as text. The sample board already says "7 kg"; a
   *  supplier sends a bare number of kilograms. Anything else is not guessed:
   *  null means "not published" and the card prints no figure for it. */
  function bagLabel(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v + ' kg' : null;
    const s = String(v).trim();
    if (!s) return null;
    return /^\d+(\.\d+)?$/.test(s) ? s + ' kg' : s;
  }

  /** The words for a leg's refund state — never "Non-refundable" for a leg
   *  whose data did not say. */
  function refundLabel(refundable) {
    return refundable === true ? 'Refundable'
      : refundable === false ? 'Non-refundable'
      : 'Refund terms not published';
  }

  /** What changing your mind costs, per leg. The known cases keep the wording
   *  the single-flight details panel uses; an unknown leg says so rather than
   *  borrowing a policy nobody stated. */
  function ruleText(refundable) {
    if (refundable === true) return 'Refundable fare: cancellation and date change are allowed for a fee.';
    if (refundable === false) return 'Non-refundable: cancellation forfeits the fare. A date change is allowed for a fee.';
    return 'Cancellation and date-change terms are not published for this fare and are confirmed at booking.';
  }

  /** The same, short enough for the card's footer column. */
  function ruleShort(refundable) {
    if (refundable === true) return 'Cancel & date change for a fee.';
    if (refundable === false) return 'Non-refundable; date change for a fee.';
    return 'Terms not published; confirmed at booking.';
  }

  /** One row for the filter panel, sort, paging and the card: the two flights
   *  plus the handful of fields every row of the panel reads. The row's own
   *  airline / departure / arrival describe the ONWARD leg; the return leg's
   *  have their own fields. */
  function makeTrip(out, ret, o) {
    const opts = o || {};
    const price = priceTrip(out, ret, opts);
    const stops = Math.max(Number(out.stops) || 0, Number(ret.stops) || 0);
    const refundable = combineRefundable(out.refundable, ret.refundable);
    return {
      isTrip: true,
      id: out.id + '+' + ret.id,
      out, ret,
      /* True when EITHER leg is sample data. A trip is never "live" because
         one leg is: the card says sample, and the booking flow refuses it. */
      sample: !!(out.sample || ret.sample),
      price,
      airline: out.airline, airlineCode: out.airlineCode, flightNumber: out.flightNumber,
      origin: out.origin, destination: out.destination,
      departure: out.departure, arrival: out.arrival,
      retAirline: ret.airline, retAirlineCode: ret.airlineCode,
      stops, nonStop: stops === 0,
      durationMinutes: (out.durationMinutes != null && ret.durationMinutes != null)
        ? out.durationMinutes + ret.durationMinutes : null,
      /* What the filters and sorts read as "the price": the cabin- and
         party-correct figure when it is known, so the price slider, Cheapest
         and the date strip all speak in the same number the card shows. */
      fare: price.fare,
      taxes: price.taxes,
      total: price.known ? (price.basis === 'party' ? price.party : price.perTraveller) : null,
      currency: out.currency,
      refundable,
      fareType: refundable == null ? null : (refundable ? 'Refundable' : 'Non-refundable'),
      status: out.status,
    };
  }

  /** Every VALID onward x return pairing.
   *
   *  @param {object[]} outs     candidate onward flights
   *  @param {object[]} backs    candidate return flights
   *  @param {object} c          {from, to, day, ret, pax, multiplier,
   *                              departed(f), departureInstant(f, iso),
   *                              arrivalInstant(f, iso)}
   *
   *  VALID: the return day is not before the onward day; on a same-day trip
   *  the return takes off at least MIN_TURNAROUND_MIN after the onward flight
   *  lands. An onward arrival that is not published cannot be checked, so a
   *  same-day pair is left out rather than guessed in. */
  function pairTrips(outs, backs, c) {
    const outbound = outs.filter(f => f.origin.code === c.from
      && f.destination.code === c.to && !c.departed(f));
    const inbound = backs.filter(f => f.origin.code === c.to && f.destination.code === c.from);
    if (c.ret < c.day) return [];
    const trips = [];
    outbound.forEach(o => inbound.forEach(r => {
      if (c.ret === c.day) {
        const lands = c.arrivalInstant(o, c.day);
        const leaves = c.departureInstant(r, c.ret);
        if (lands == null || leaves == null || leaves < lands + MIN_TURNAROUND_MIN * 60000) return;
      }
      const out = Object.assign({}, o, { date: c.day });
      const ret = Object.assign({}, r, { date: c.ret });
      trips.push(makeTrip(out, ret, { pax: c.pax, multiplier: c.multiplier }));
    }));
    return trips;
  }

  return {
    MIN_TURNAROUND_MIN, payingTravellers, priceTrip, combineRefundable,
    bagLabel, refundLabel, ruleText, ruleShort, makeTrip, pairTrips,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RoundTrip;
