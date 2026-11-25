"""Translate TBO's vocabulary into ours, and never invent a value.

Two directions:

  * OUT: a :class:`TBOResult` from Search -> the internal flight object the rest
    of the app already speaks (the shape ``travel-data.js``'s ``normaliseFlight``
    produces, and the Duffel mapper also targets), plus the ``supplier_*``
    fields that carry TBO's own references and price untouched.

  * IN: our passenger inputs + the FareQuote FareBreakdown -> the ``Passengers``
    array that Book and Ticket want.

THE ONE RULE, carried from the Duffel mapper: what TBO does not state we show as
unknown (``None``), never a made-up default. Baggage is TBO's own label string
("15 KG"), copied verbatim; a fare TBO omits is ``None``, not 0.

THE OFFER HANDLE. A TBO flight is identified by a (TraceId, ResultIndex) PAIR,
not a single id — the TraceId scopes the search session (~15 min) and the
ResultIndex the option within it. We join them as ``"<TraceId>|<ResultIndex>"``
for the one opaque ``supplier_offer_id`` the booking tables carry, and split it
back before any FareQuote / Book call. This keeps the DB schema unchanged.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

from app.integrations.tbo.schemas import (
    PAX_ADULT,
    PAX_CHILD,
    PAX_INFANT,
    TBOResult,
    TBOSegment,
)

SUPPLIER = "tbo"

_HANDLE_SEP = "|"


def offer_handle(trace_id: str, result_index: str) -> str:
    """Join the (TraceId, ResultIndex) pair into one opaque handle."""
    return f"{trace_id}{_HANDLE_SEP}{result_index}"


def parse_offer_handle(handle: str) -> tuple[str, str]:
    """Split a handle back into (TraceId, ResultIndex). Raises if malformed."""
    trace, sep, result_index = (handle or "").partition(_HANDLE_SEP)
    if not (sep and trace and result_index):
        raise ValueError(f"not a TBO offer handle: {handle!r}")
    return trace, result_index


def _time_of(iso: str | None) -> str | None:
    """``HH:MM`` from a TBO local timestamp, kept as wall-clock (not converted)."""
    if not iso or "T" not in iso:
        return None
    clock = iso.split("T", 1)[1]
    return clock[:5] if len(clock) >= 5 else None


def _date_of(iso: str | None) -> str | None:
    if not iso or "T" not in iso:
        return iso or None
    return iso.split("T", 1)[0]


def _duration_label(minutes: int | None) -> str | None:
    if minutes is None:
        return None
    return f"{minutes // 60}h {minutes % 60:02d}m"


def result_to_flight(result: TBOResult, trace_id: str | None) -> dict:
    """A :class:`TBOResult` into our internal flight object.

    Multi-segment results map their first/last segment into the summary; every
    segment is preserved under ``supplier_raw``. ``flight_key`` is the offer
    handle — what the booking path hands back to TBO via FareQuote/Book.
    """
    segs: Sequence[TBOSegment] = result.segments
    first = segs[0] if segs else None
    last = segs[-1] if segs else None

    carrier_code = first.airline_code if first else None
    carrier_name = first.airline_name if first else None
    number = first.flight_number if first else None
    flight_number = f"{carrier_code} {number}" if carrier_code and number else (carrier_code or number)
    flight_number_raw = f"{carrier_code}{number}" if carrier_code and number else (number or carrier_code)

    minutes = sum((s.duration or 0) for s in segs) or None
    stops = max(len(segs) - 1, 0)
    handle = offer_handle(trace_id, result.result_index) if (trace_id and result.result_index) else result.result_index

    return {
        "id": handle,
        "flight_key": handle,
        "flightNumber": flight_number,
        "flightNumberRaw": flight_number_raw,
        "airline": carrier_name,
        "airlineCode": carrier_code,
        "origin": {
            "code": first.origin.code if first else None,
            "city": first.origin.city_name if first else None,
        },
        "destination": {
            "code": last.destination.code if last else None,
            "city": last.destination.city_name if last else None,
        },
        "date": _date_of(first.dep_time if first else None),
        "departure": _time_of(first.dep_time if first else None),
        "arrival": _time_of(last.arr_time if last else None),
        "durationMinutes": minutes,
        "durationLabel": _duration_label(minutes),
        "stops": stops,
        "nonStop": stops == 0,
        "status": "Scheduled",
        # Money is TBO's, verbatim. OfferedFare is the net payable by the agency;
        # PublishedFare the gross before markup. We surface OfferedFare as the
        # bookable total and never convert currency here.
        "fare": result.fare.base_fare,
        "taxes": result.fare.tax,
        "total": result.fare.offered_fare if result.fare.offered_fare is not None else result.fare.published_fare,
        "currency": result.fare.currency,
        # TBO's Search does carry NoOfSeatAvailable per segment, but not an
        # offer-level count; left unknown rather than guessed from one segment.
        "seatsLeft": None,
        "seatsLow": None,
        # Tri-state — never coerced to False when TBO is silent.
        "refundable": result.is_refundable,
        "fareType": result.result_fare_type,
        # TBO states baggage as a label ("15 KG"), not a piece count — kept verbatim.
        "baggage": {
            "cabin": first.cabin_baggage if first else None,
            "checkIn": first.baggage if first else None,
        },
        # ---- supplier references (the new fields) ------------------------ #
        "supplier": SUPPLIER,
        "supplier_offer_id": handle,
        "supplier_source": result.source,
        "supplier_is_lcc": result.is_lcc,
        "supplier_total_amount": result.fare.offered_fare,
        "supplier_currency": result.fare.currency,
        "supplier_last_ticket_date": result.last_ticket_date,
    }


def results_to_flights(results: Sequence[TBOResult], trace_id: str | None) -> list[dict]:
    return [result_to_flight(r, trace_id) for r in results]


# --------------------------------------------------------------------------- #
# Booking direction
# --------------------------------------------------------------------------- #

_PAX_TYPE_MAP = {
    "adult": PAX_ADULT, "adt": PAX_ADULT, "": PAX_ADULT,
    "child": PAX_CHILD, "chd": PAX_CHILD,
    "infant": PAX_INFANT, "inf": PAX_INFANT, "infant_without_seat": PAX_INFANT,
}
_GENDER_MAP = {"male": 1, "m": 1, "female": 2, "f": 2}


def _pax_type(value: Any) -> int:
    if isinstance(value, int):
        return value if value in (PAX_ADULT, PAX_CHILD, PAX_INFANT) else PAX_ADULT
    return _PAX_TYPE_MAP.get((str(value) or "").strip().lower(), PAX_ADULT)


def _gender(value: Any) -> int | None:
    if isinstance(value, int):
        return value if value in (1, 2) else None
    return _GENDER_MAP.get((str(value) or "").strip().lower())


def _dob(value: Any) -> str | None:
    if not value:
        return None
    s = str(value)
    return s if "T" in s else f"{s}T00:00:00"


def _fare_for_pax_type(fare_breakdown: Sequence[Mapping[str, Any]], pax_type: int) -> dict | None:
    """The FareQuote FareBreakdown entry for this PaxType, copied verbatim.

    The spec is explicit: each passenger object in Book/Ticket carries the
    per-PaxType breakdown, NOT the whole-flight fare. Returns ``None`` when TBO
    sent no matching entry — the caller decides, we do not fabricate one.
    """
    for entry in fare_breakdown:
        if entry.get("PassengerType") == pax_type:
            return dict(entry)
    return None


def passengers_to_book(
    our_passengers: Sequence[Mapping[str, Any]],
    fare_breakdown: Sequence[Mapping[str, Any]],
) -> list[dict]:
    """Our travellers -> the TBO ``Passengers`` array for Book / Ticket (LCC).

    Field mapping is conservative: an unrecognised gender is sent as ``None``
    (omitted) rather than guessed, because a wrong guess on a real ticket is
    worse than an absent optional. Exactly one passenger is marked lead — the
    first — unless a traveller already carries ``is_lead``.
    """
    out: list[dict] = []
    lead_marked = any(p.get("is_lead") or p.get("IsLeadPax") for p in our_passengers)
    for i, p in enumerate(our_passengers):
        pax_type = _pax_type(p.get("pax_type") or p.get("type") or p.get("PaxType"))
        is_lead = bool(p.get("is_lead") or p.get("IsLeadPax")) or (not lead_marked and i == 0)
        entry: dict[str, Any] = {
            "Title": p.get("title") or p.get("Title"),
            "FirstName": p.get("first_name") or p.get("FirstName"),
            "LastName": p.get("last_name") or p.get("LastName"),
            "PaxType": pax_type,
            "DateOfBirth": _dob(p.get("date_of_birth") or p.get("DateOfBirth")),
            "Gender": _gender(p.get("gender") or p.get("Gender")),
            "AddressLine1": p.get("address_line1") or p.get("AddressLine1"),
            "City": p.get("city") or p.get("City"),
            "CountryCode": p.get("country_code") or p.get("CountryCode"),
            "CountryName": p.get("country_name") or p.get("CountryName"),
            "Nationality": p.get("nationality") or p.get("Nationality"),
            "ContactNo": p.get("mobile") or p.get("contact_no") or p.get("ContactNo"),
            "Email": p.get("email") or p.get("Email"),
            "IsLeadPax": is_lead,
            "PassportNo": p.get("passport_no") or p.get("PassportNo"),
            "PassportExpiry": p.get("passport_expiry") or p.get("PassportExpiry"),
            "Fare": _fare_for_pax_type(fare_breakdown, pax_type),
        }
        out.append({k: v for k, v in entry.items() if v is not None})
    return out
