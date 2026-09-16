'use strict';
/* booking-enquiry-core.js — what a valid Booking Enquiry IS, in one place.
   ===========================================================================
   Two portals collect a flight enquiry: the Merchant Portal (Classic), where a
   merchant raises its own, and the Admin Portal's Manual Booking screens,
   where the desk raises one FOR a merchant that telephoned it in. They are the
   same enquiry and must obey the same rules.

   WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
   ---------------------------------------------------------------------------
   It is the RULES and the CONTRACT: the trip types, the cabins, the carriers,
   what makes a form invalid, and the exact shape posted to /api/enquiries.
   All of it pure — every function takes a plain object and returns a plain
   object, and nothing here reads the DOM, fetches, or knows a CSS class.

   It is NOT a component. The two portals have genuinely different design
   systems — `cl-` classes from classic.css, `jp-admin` scoping from jp-ds.css —
   and a shared renderer would have to import one portal's stylesheet into the
   other. So each portal keeps its own markup and asks this file the only
   questions that must not drift: "is this valid?" and "what do I send?".

   That split is the point. Markup diverging is cosmetic; a validation rule or
   a payload key diverging is two portals writing different records into one
   table, which is the bug worth engineering against.

   THE SHAPES
   ---------------------------------------------------------------------------
   `values` is whatever the portal collected, already trimmed:

       { tripType, groupJourneyType, from:{code,city}, to:{code,city},
         airline:{name,code}|null, flightNumber, date, time, returnDate,
         returnTime, travelClass, bookingClass, adults, children, infants,
         groupPax, groupImport, notes, clientFare, onBehalfOfMerchantId }

   `validate(values)` returns `null` when the form is good, otherwise
   `{ field, message }` — the FIRST problem in the order the fields appear, so
   the caller sends the operator back to the first thing that is wrong rather
   than the last.

   `payload(values)` returns the exact body for POST /api/enquiries. Call it
   only on values that have passed `validate`. */

(function (root) {

  /* Airlines the desk deals with most. A suggestion list, not an enum: the
     backend stores whatever string arrives, because a merchant can legitimately
     ask about a carrier that is not here. */
  const AIRLINES = [
    { name: 'Air India', code: 'AI' },
    { name: 'IndiGo', code: '6E' },
    { name: 'Akasa Air', code: 'QP' },
    { name: 'SpiceJet', code: 'SG' },
    { name: 'Vistara', code: 'UK' },
    { name: 'Air India Express', code: 'IX' },
    { name: 'Emirates', code: 'EK' },
    { name: 'Qatar Airways', code: 'QR' },
    { name: 'Etihad Airways', code: 'EY' },
    { name: 'Singapore Airlines', code: 'SQ' },
    { name: 'Lufthansa', code: 'LH' },
    { name: 'British Airways', code: 'BA' },
    { name: 'Thai Airways', code: 'TG' },
    { name: 'Malaysia Airlines', code: 'MH' },
    { name: 'Oman Air', code: 'WY' },
    { name: 'Saudia', code: 'SV' },
    { name: 'Turkish Airlines', code: 'TK' },
    { name: 'Air Arabia', code: 'G9' },
  ];

  const TRAVEL_CLASSES = ['Economy', 'Premium Economy', 'Business', 'First Class'];

  /* The three the form offers. `group_trip` is a question about seats for a
     party, which is why it collects a head count instead of a breakdown. */
  const TRIP_TYPES = [
    { id: 'one_way', label: 'One Way' },
    { id: 'round_trip', label: 'Round Trip' },
    { id: 'group_trip', label: 'Group Booking' },
  ];

  const GROUP_JOURNEY_TYPES = [
    { id: 'one_way_group', label: 'One Way' },
    { id: 'round_trip_group', label: 'Round Trip' },
  ];

  /* AI217, 6E456, UK 955A. Two or three alphanumerics, up to four digits, an
     optional suffix letter. */
  const FLIGHT_RE = /^[A-Z0-9]{2,3}\s*\d{1,4}[A-Z]?$/i;

  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const isGroup = (v) => v.tripType === 'group_trip';

  /* Whether this journey comes back. Round trip always does; a group does only
     when its own journey type says so — two different fields answering one
     question, which is why every caller asks here instead of re-deriving it. */
  const hasReturn = (v) =>
    v.tripType === 'round_trip' ||
    (isGroup(v) && v.groupJourneyType === 'round_trip_group');

  /* ---------------------------------------------------------------- validate
     The order is the order the fields appear on the form. Changing it changes
     which error an operator is shown first, so it is not arbitrary. */
  function validate(v) {
    const fail = (field, message) => ({ field, message });

    if (!v.from || !v.from.code) return fail('from', 'Choose the city you are flying from.');
    if (!v.to || !v.to.code) return fail('to', 'Choose the city you are flying to.');
    if (v.from.code === v.to.code) return fail('to', 'From and To cannot be the same city.');

    /* Neither airline nor flight number is required — blank means "any
       carrier", "no particular service", and the desk decides when it quotes.
       A flight number that IS typed is checked, because a half-remembered one
       is worse than none: the desk would quote the wrong service. */
    const flight = (v.flightNumber || '').trim();
    if (flight && !FLIGHT_RE.test(flight)) {
      return fail('flightNumber',
        'That does not look like a flight number. Use a form like AI217 or 6E456, '
        + 'or leave it blank and we will choose the flight.');
    }

    if (!v.date) return fail('date', 'Choose the travel date.');
    if (v.date < todayIso()) return fail('date', 'The travel date cannot be in the past.');

    /* THE DEPARTURE TIME IS REQUIRED BY THE API — `preferred_time: str` with an
       HH:MM pattern, not nullable — so it is required here rather than being
       discovered as a 422 after the form was filled in. The Merchant Portal
       never trips this because its time control carries a default; a portal
       whose control does not must still be told before it posts.

       The RETURN time is genuinely optional (`str | None`) and is not checked. */
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time || '')) {
      return fail('time', 'Choose the preferred departure time.');
    }

    if (isGroup(v)) {
      /* A group enquiry carries a count, not a manifest. The adults/infants
         rules below are about a breakdown a group form does not show. */
      const pax = Number(v.groupPax);
      if (!Number.isFinite(pax) || pax < 1) {
        return fail('groupPax', 'Enter how many passengers are travelling.');
      }
    } else {
      if (!(v.travelClass || '').trim()) return fail('travelClass', 'Choose the cabin class.');
      if (Number(v.adults) < 1) return fail('adults', 'At least one adult must travel.');
      if (Number(v.infants) > Number(v.adults)) {
        return fail('infants', 'There cannot be more infants than adults.');
      }
    }

    if (hasReturn(v)) {
      if (!v.returnDate) return fail('returnDate', 'Choose the return date.');
      if (v.returnDate < v.date) {
        return fail('returnDate', 'The return date cannot be before the departure date.');
      }
    }
    return null;
  }

  /* ----------------------------------------------------------------- payload
     The body POST /api/enquiries takes. Every branch here mirrors a rule the
     server enforces, so a form that passed `validate` is not refused by it. */
  function payload(v) {
    const group = isGroup(v);
    const pax = Number(v.groupPax) || 0;
    const imported = v.groupImport ? v.groupImport.passengers_imported : null;

    const body = {
      /* Required since Hotel Enquiry shipped: EnquiryCreate is a discriminated
         union keyed on this field, read before anything else is parsed. */
      travel_type: 'flight',
      trip_type: v.tripType,
      /* Refused on anything but a group — the server enforces the pairing. */
      group_journey_type: group ? v.groupJourneyType : null,

      origin: v.from.code,
      origin_city: v.from.city || null,
      destination: v.to.code,
      destination_city: v.to.city || null,

      /* AN OPEN ENQUIRY SENDS NO AIRLINE AT ALL. "All Airlines" is a label, not
         a value; sending it would store a carrier by that name. */
      airline: v.airline ? v.airline.name : null,
      airline_code: v.airline ? v.airline.code : null,
      flight_number: (v.flightNumber || '').trim() || null,

      travel_date: v.date,
      preferred_time: v.time || null,
      return_date: hasReturn(v) ? v.returnDate : null,
      return_preferred_time: hasReturn(v) ? (v.returnTime || null) : null,

      /* Not on screen for a group, so neither read nor sent there. */
      travel_class: group ? null : ((v.travelClass || '').trim() || null),
      booking_class: group ? null : ((v.bookingClass || '').trim() || null),

      /* WHERE A GROUP'S PARTY SIZE COMES FROM, and it is two different places:
         on an enquiry the number that was typed, because nobody has listed the
         travellers yet; on a direct booking the imported rows, because the
         sheet is then the authority and a typed 45 against a sheet of 44 would
         fail the server's arithmetic. */
      passenger_count: group
        ? (v.groupImport ? imported : pax)
        : Number(v.adults) + Number(v.children) + Number(v.infants),
      adults: group ? (v.groupImport ? imported : pax) : Number(v.adults),
      children: group ? 0 : Number(v.children),
      infants: group ? 0 : Number(v.infants),
      group_import_id: group && v.groupImport ? v.groupImport.import_id : null,

      notes: (v.notes || '').trim() || null,
      /* Sent as null when blank, never 0 — the column distinguishes "not
         recorded" from "quoted at zero", and a 0 would drop a zero-saving
         booking into the merchant's savings average. */
      client_fare: (v.clientFare === '' || v.clientFare == null) ? null : Number(v.clientFare),
    };

    /* MANUAL BOOKING ONLY. Present exactly when the desk is raising this for a
       named merchant; the Merchant Portal never sets it, and the server refuses
       it from a caller without `ticket.manual`. Omitted rather than sent as
       null so a merchant's payload is byte-for-byte what it was before this
       file existed. */
    if (v.onBehalfOfMerchantId) {
      body.on_behalf_of_merchant_id = Number(v.onBehalfOfMerchantId);
    }
    return body;
  }

  root.BookingEnquiryCore = {
    AIRLINES, TRAVEL_CLASSES, TRIP_TYPES, GROUP_JOURNEY_TYPES, FLIGHT_RE,
    todayIso, isGroup, hasReturn, validate, payload,
  };
})(typeof window !== 'undefined' ? window : globalThis);
