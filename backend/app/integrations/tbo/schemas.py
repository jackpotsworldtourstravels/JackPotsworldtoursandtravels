"""The TBO Air-service wire shapes we send and the ones we parse back.

Two halves, the same split the Duffel adapter draws:

  * REQUEST BUILDERS turn our own inputs into the business half of a TBO body.
    They DELIBERATELY omit ``TokenId`` and ``EndUserIp`` — the client injects
    those from the shared session, so a credential is never threaded through
    application code.

  * RESPONSE PARSERS read TBO's JSON into small frozen dataclasses, reading
    ONLY what we use and tolerating missing optionals by returning ``None``.
    Nothing here invents a value: a field TBO omits stays ``None`` and the
    mapper decides how to show "unknown" in our schema.

Enums (JourneyType, CabinClass, PaxType, Gender, booking Status) are
transcribed from ``docs/TEKTRAVELS_FLIGHT_API_SPEC.pdf`` / the integration
guide. See :mod:`app.integrations.tbo.mapper` for the translation INTO our
internal flight shape.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

# --------------------------------------------------------------------------- #
# Enums (verbatim from the spec)
# --------------------------------------------------------------------------- #

JOURNEY_ONE_WAY = "1"
JOURNEY_RETURN = "2"
JOURNEY_MULTI_STOP = "3"

CABIN_ALL = "1"
CABIN_ECONOMY = "2"
CABIN_PREMIUM_ECONOMY = "3"
CABIN_BUSINESS = "4"
CABIN_PREMIUM_BUSINESS = "5"
CABIN_FIRST = "6"

#: Our cabin words -> TBO FlightCabinClass codes. Unknown -> Economy (2), the
#: safe B2C default, never guessed as a premium class.
_CABIN_MAP = {
    "all": CABIN_ALL, "any": CABIN_ALL,
    "economy": CABIN_ECONOMY, "eco": CABIN_ECONOMY, "": CABIN_ECONOMY,
    "premium economy": CABIN_PREMIUM_ECONOMY, "premium_economy": CABIN_PREMIUM_ECONOMY,
    "business": CABIN_BUSINESS,
    "premium business": CABIN_PREMIUM_BUSINESS,
    "first": CABIN_FIRST,
}

PAX_ADULT = 1
PAX_CHILD = 2
PAX_INFANT = 3

#: Booking Status (Response.Status / FlightItinerary.Status).
BOOKING_STATUS = {
    0: "Failed", 1: "Successful", 2: "Not saved", 3: "Not created",
    4: "Not allowed", 5: "Flown", 6: "Partially cancelled", 7: "Cancelled",
}


def cabin_code(value: str | None) -> str:
    return _CABIN_MAP.get((value or "").strip().lower(), CABIN_ECONOMY)


# --------------------------------------------------------------------------- #
# Request builders — business fields only (client adds TokenId + EndUserIp)
# --------------------------------------------------------------------------- #

def search_body(
    *,
    segments: Sequence[Mapping[str, Any]],
    adults: int = 1,
    children: int = 0,
    infants: int = 0,
    journey_type: str = JOURNEY_ONE_WAY,
    direct_only: bool = False,
    one_stop: bool = False,
    preferred_airlines: Sequence[str] | None = None,
    sources: Sequence[str] | None = None,
) -> dict:
    """Body for ``/Search``. ``segments`` is a list of
    ``{origin, destination, departure_date[, cabin]}``.

    Counts are sent as strings, as the spec shows. ``infants`` cannot exceed
    ``adults`` — the caller validates; this does not silently clamp.
    """
    seg_out = []
    for s in segments:
        date = s.get("departure_date") or s.get("date")
        dep = f"{date}T00:00:00" if date and "T" not in str(date) else date
        seg_out.append({
            "Origin": s.get("origin") or s.get("from"),
            "Destination": s.get("destination") or s.get("to"),
            "FlightCabinClass": cabin_code(s.get("cabin") or s.get("cabin_class")),
            "PreferredDepartureTime": dep,
            "PreferredArrivalTime": dep,
        })
    return {
        "AdultCount": str(int(adults)),
        "ChildCount": str(int(children)),
        "InfantCount": str(int(infants)),
        "DirectFlight": bool(direct_only),
        "OneStopFlight": bool(one_stop),
        "JourneyType": str(journey_type),
        "PreferredAirlines": list(preferred_airlines) if preferred_airlines else None,
        "Segments": seg_out,
        "Sources": list(sources) if sources else None,
    }


def trace_result_body(trace_id: str, result_index: str) -> dict:
    """Body shared by FareRule, FareQuote, SSR, FareUpsell, PriceRBD."""
    return {"TraceId": trace_id, "ResultIndex": result_index}


def release_pnr_body(booking_id: int, source: Any) -> dict:
    return {"BookingId": int(booking_id), "Source": str(source)}


def get_booking_details_body(
    *, booking_id: int | None = None, pnr: str | None = None,
    first_name: str | None = None, last_name: str | None = None,
    trace_id: str | None = None,
) -> dict:
    """Lookup by BookingId (best), or PNR+name, or TraceId (after a timeout)."""
    if booking_id is not None:
        return {"BookingId": int(booking_id)}
    if pnr:
        return {"PNR": pnr, "FirstName": first_name, "LastName": last_name}
    if trace_id:
        return {"TraceId": trace_id}
    raise ValueError("GetBookingDetails needs a BookingId, a PNR+name, or a TraceId")


def get_cancellation_charges_body(booking_id: int, *, request_type: int = 1, booking_mode: int = 5) -> dict:
    return {"BookingId": int(booking_id), "RequestType": int(request_type), "BookingMode": int(booking_mode)}


def send_change_request_body(
    booking_id: int, *, request_type: int = 1, cancellation_type: int = 3,
    remarks: str, sectors: Sequence[Mapping[str, str]] | None = None,
    ticket_ids: Sequence[int] | None = None,
) -> dict:
    body: dict[str, Any] = {
        "BookingId": int(booking_id),
        "RequestType": int(request_type),
        "CancellationType": int(cancellation_type),
        "Remarks": remarks,
    }
    if sectors:
        body["Sectors"] = [dict(s) for s in sectors]
    if ticket_ids:
        body["TicketId"] = [int(t) for t in ticket_ids]
    return body


def get_change_request_status_body(change_request_id: int) -> dict:
    return {"ChangeRequestId": int(change_request_id)}


# --------------------------------------------------------------------------- #
# Response parsers
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class TBOFare:
    currency: str | None
    base_fare: float | None
    tax: float | None
    published_fare: float | None
    offered_fare: float | None


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _fare(node: Mapping[str, Any] | None) -> TBOFare:
    node = node or {}
    return TBOFare(
        currency=node.get("Currency"),
        base_fare=_num(node.get("BaseFare")),
        tax=_num(node.get("Tax")),
        published_fare=_num(node.get("PublishedFare")),
        offered_fare=_num(node.get("OfferedFare")),
    )


@dataclass(frozen=True)
class TBOAirport:
    code: str | None
    name: str | None
    terminal: str | None
    city_code: str | None
    city_name: str | None


@dataclass(frozen=True)
class TBOSegment:
    airline_code: str | None
    airline_name: str | None
    flight_number: str | None
    cabin_class: int | None
    baggage: str | None
    cabin_baggage: str | None
    duration: int | None
    origin: TBOAirport
    destination: TBOAirport
    dep_time: str | None
    arr_time: str | None


def _airport(node: Mapping[str, Any] | None) -> TBOAirport:
    a = (node or {}).get("Airport") or {}
    return TBOAirport(
        code=a.get("AirportCode"), name=a.get("AirportName"), terminal=a.get("Terminal"),
        city_code=a.get("CityCode"), city_name=a.get("CityName"),
    )


def _segment(node: Mapping[str, Any]) -> TBOSegment:
    air = node.get("Airline") or {}
    return TBOSegment(
        airline_code=air.get("AirlineCode"),
        airline_name=air.get("AirlineName"),
        flight_number=air.get("FlightNumber"),
        cabin_class=node.get("CabinClass"),
        baggage=node.get("Baggage"),
        cabin_baggage=node.get("CabinBaggage"),
        duration=node.get("Duration"),
        origin=_airport(node.get("Origin")),
        destination=_airport(node.get("Destination")),
        dep_time=(node.get("Origin") or {}).get("DepTime"),
        arr_time=(node.get("Destination") or {}).get("ArrTime"),
    )


def _flatten_segments(seg_field: Any) -> list[TBOSegment]:
    """Segments arrive two-dimensional ([leg][segment]). Flatten in order."""
    out: list[TBOSegment] = []
    for leg in seg_field or []:
        inner = leg if isinstance(leg, list) else [leg]
        for s in inner:
            if isinstance(s, Mapping):
                out.append(_segment(s))
    return out


@dataclass(frozen=True)
class TBOResult:
    result_index: str | None
    source: Any
    is_lcc: bool | None
    is_refundable: bool | None
    result_fare_type: str | None
    last_ticket_date: str | None
    fare: TBOFare
    segments: tuple[TBOSegment, ...]
    raw: Mapping[str, Any] = field(default=None, repr=False)  # type: ignore[assignment]


def parse_result(node: Mapping[str, Any]) -> TBOResult:
    return TBOResult(
        result_index=node.get("ResultIndex"),
        source=node.get("Source"),
        is_lcc=node.get("IsLCC"),
        is_refundable=node.get("IsRefundable"),
        result_fare_type=node.get("ResultFareType"),
        last_ticket_date=node.get("LastTicketDate"),
        fare=_fare(node.get("Fare")),
        segments=tuple(_flatten_segments(node.get("Segments"))),
        raw=node,
    )


@dataclass(frozen=True)
class TBOSearchResponse:
    trace_id: str | None
    results: tuple[TBOResult, ...]


def parse_search(inner: Mapping[str, Any]) -> TBOSearchResponse:
    """``Response`` of a /Search into results. ``Results`` is ``[leg][option]``;
    we flatten every option across every leg (the first leg's options for a
    one-way; both legs for an LCC return)."""
    options: list[TBOResult] = []
    for leg in inner.get("Results") or []:
        inner_leg = leg if isinstance(leg, list) else [leg]
        for opt in inner_leg:
            if isinstance(opt, Mapping) and opt.get("ResultIndex"):
                options.append(parse_result(opt))
    return TBOSearchResponse(trace_id=inner.get("TraceId"), results=tuple(options))


@dataclass(frozen=True)
class TBOFareQuote:
    trace_id: str | None
    result_index: str | None
    source: Any
    is_price_changed: bool | None
    is_lcc: bool | None
    is_refundable: bool | None
    is_pan_required_at_book: bool | None
    is_passport_required_at_book: bool | None
    is_passport_required_at_ticket: bool | None
    is_gst_mandatory: bool | None
    last_ticket_date: str | None
    fare: TBOFare
    fare_breakdown: tuple[Mapping[str, Any], ...]
    raw: Mapping[str, Any] = field(default=None, repr=False)  # type: ignore[assignment]


def parse_fare_quote(inner: Mapping[str, Any]) -> TBOFareQuote:
    res = inner.get("Results") or {}
    return TBOFareQuote(
        trace_id=inner.get("TraceId"),
        result_index=res.get("ResultIndex"),
        source=res.get("Source"),
        is_price_changed=inner.get("IsPriceChanged"),
        is_lcc=res.get("IsLCC"),
        is_refundable=res.get("IsRefundable"),
        is_pan_required_at_book=res.get("IsPanRequiredAtBook"),
        is_passport_required_at_book=res.get("IsPassportRequiredAtBook"),
        is_passport_required_at_ticket=res.get("IsPassportRequiredAtTicket"),
        is_gst_mandatory=res.get("IsGSTMandatory"),
        last_ticket_date=res.get("LastTicketDate"),
        fare=_fare(res.get("Fare")),
        fare_breakdown=tuple(res.get("FareBreakdown") or ()),
        raw=res,
    )


@dataclass(frozen=True)
class TBOTicketInfo:
    pax_id: int | None
    ticket_id: int | None
    ticket_number: str | None
    status: str | None


@dataclass(frozen=True)
class TBOItinerary:
    booking_id: int | None
    pnr: str | None
    status: int | None
    source: Any
    is_lcc: bool | None
    last_ticket_date: str | None
    invoice_no: str | None
    fare: TBOFare
    tickets: tuple[TBOTicketInfo, ...]
    raw: Mapping[str, Any] = field(default=None, repr=False)  # type: ignore[assignment]


def parse_itinerary(inner: Mapping[str, Any]) -> TBOItinerary:
    """The ``FlightItinerary`` block shared by Book / Ticket / GetBookingDetails."""
    it = inner.get("FlightItinerary") or {}
    tickets: list[TBOTicketInfo] = []
    for p in it.get("Passenger") or []:
        tk = p.get("Ticket") or {}
        tickets.append(TBOTicketInfo(
            pax_id=p.get("PaxId"),
            ticket_id=tk.get("TicketId"),
            ticket_number=tk.get("TicketNumber"),
            status=tk.get("Status"),
        ))
    return TBOItinerary(
        booking_id=it.get("BookingId"),
        pnr=it.get("PNR"),
        status=it.get("Status") if it.get("Status") is not None else inner.get("Status"),
        source=it.get("Source"),
        is_lcc=it.get("IsLCC"),
        last_ticket_date=it.get("LastTicketDate"),
        invoice_no=it.get("InvoiceNo"),
        fare=_fare(it.get("Fare")),
        tickets=tuple(tickets),
        raw=it,
    )
