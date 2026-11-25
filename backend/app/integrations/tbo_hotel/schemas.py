"""The TBO hotel wire shapes we send and the ones we parse back.

The same two-half split as the flight adapter. REQUEST BUILDERS omit
``TokenId`` / ``EndUserIp`` (the client injects them); RESPONSE PARSERS read
only what we use and return ``None`` for anything TBO omits — never a fabricated
default.

The hotel surface spans two API generations with different envelopes:

  * the newer "lite" Search / PreBook (affiliate.tektravels.com/HotelAPI) and
    the TBO Holidays static content wrap their result in a ``Status`` object
    ``{Code, Description}`` and carry a ``HotelResult`` / list;
  * the classic HotelService (HotelBE.tektravels.com) Book / GetBookingDetail /
    GenerateVoucher / change-request calls carry a ``ResponseStatus`` enum and
    an ``Error`` object at the TOP level (not wrapped in ``Response``).

These enums are transcribed from the hotel integration guide; the guide is
web-sourced (there is no hotel PDF), so confirm the exact success ``Code``
values against the live Swagger before certification.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

# --------------------------------------------------------------------------- #
# Enums (from the hotel integration guide)
# --------------------------------------------------------------------------- #

#: Book / GenerateVoucher / GetBookingDetail booking Status.
BOOK_STATUS = {0: "BookFailed", 1: "Confirmed", 3: "VerifyPrice", 6: "Cancelled"}
STATUS_BOOK_FAILED = 0
STATUS_CONFIRMED = 1
STATUS_VERIFY_PRICE = 3
STATUS_CANCELLED = 6

#: ResponseStatus (classic HotelService) — same enum as the flight side.
RESPONSE_SUCCESS = 1
RESPONSE_INVALID_SESSION = 4

#: ChangeRequestStatus (cancellation).
CHANGE_STATUS = {0: "NotSet", 1: "Pending", 2: "InProgress", 3: "Processed", 4: "Rejected"}
CHANGE_PROCESSED = 3

#: RequestType for SendChangeRequest.
REQUEST_HOTEL_CANCEL = 4

#: Status.Code values the lite/static surface returns for a usable response.
#: 200 = successful; 201 = successful but no availability (empty, not an error).
#: Anything else is treated as a refusal. Confirm against live Swagger.
STATUS_CODE_OK = 200
STATUS_CODE_NO_RESULT = 201
_OK_CODES = frozenset({STATUS_CODE_OK, STATUS_CODE_NO_RESULT, 1})


# --------------------------------------------------------------------------- #
# Request builders — business fields only (client adds TokenId + EndUserIp)
# --------------------------------------------------------------------------- #

def search_body(
    *,
    check_in: str,
    check_out: str,
    hotel_codes: str | Sequence[str],
    guest_nationality: str,
    pax_rooms: Sequence[Mapping[str, Any]],
    response_time: int = 23,
    detailed: bool = False,
    refundable_only: bool = False,
    meal_type: str = "All",
) -> dict:
    """Body for ``/Search``. ``pax_rooms`` is a list of
    ``{adults, children, children_ages?}`` — one per room.

    ``hotel_codes`` is a comma-separated string (or list, joined here); TBO
    accepts at most ~100 per request, which the CALLER batches. ``guest_nationality``
    is the lead guest's ISO country code and must NOT be hardcoded.
    """
    codes = hotel_codes if isinstance(hotel_codes, str) else ",".join(str(c) for c in hotel_codes)
    rooms = []
    for r in pax_rooms:
        entry: dict[str, Any] = {
            "Adults": int(r.get("adults") or 1),
            "Children": int(r.get("children") or 0),
        }
        ages = r.get("children_ages") or r.get("child_ages")
        entry["ChildrenAges"] = [int(a) for a in ages] if ages else []
        rooms.append(entry)
    return {
        "CheckIn": check_in,
        "CheckOut": check_out,
        "HotelCodes": codes,
        "GuestNationality": guest_nationality,
        "NoOfRooms": len(rooms),
        "PaxRooms": rooms,
        "ResponseTime": int(response_time),
        "IsDetailedResponse": bool(detailed),
        "Filters": {"Refundable": bool(refundable_only), "MealType": meal_type},
    }


def prebook_body(booking_code: str) -> dict:
    """Body for ``/PreBook`` — re-price the chosen bookable unit."""
    return {"BookingCode": booking_code}


def book_body(
    *,
    booking_code: str,
    net_amount: float,
    guest_nationality: str,
    is_voucher_booking: bool,
    rooms: Sequence[Mapping[str, Any]],
) -> dict:
    """Body for ``/book/`` (classic HotelService).

    ``rooms`` is a list of ``{passengers: [...]}``; each passenger dict is
    passed to :func:`passenger_body`-shaped output by the mapper. ``net_amount``
    MUST be the value PreBook returned — the caller snapshots and echoes it.
    """
    return {
        "BookingCode": booking_code,
        "GuestNationality": guest_nationality,
        "IsVoucherBooking": bool(is_voucher_booking),
        "NetAmount": net_amount,
        "HotelRoomsDetails": [dict(r) for r in rooms],
    }


def get_booking_detail_body(
    *, booking_id: int | None = None, confirmation_no: str | None = None,
    first_name: str | None = None, last_name: str | None = None, trace_id: str | None = None,
) -> dict:
    if booking_id is not None:
        return {"BookingId": int(booking_id)}
    if confirmation_no:
        return {"ConfirmationNo": confirmation_no, "FirstName": first_name, "LastName": last_name}
    if trace_id:
        return {"TraceId": trace_id}
    raise ValueError("GetBookingDetail needs a BookingId, a ConfirmationNo+name, or a TraceId")


def generate_voucher_body(booking_id: int) -> dict:
    return {"BookingId": int(booking_id)}


def send_change_request_body(booking_id: int, *, remarks: str, request_type: int = REQUEST_HOTEL_CANCEL) -> dict:
    return {"BookingId": int(booking_id), "RequestType": int(request_type), "Remarks": remarks}


def get_change_request_status_body(change_request_id: int) -> dict:
    return {"ChangeRequestId": int(change_request_id)}


def city_list_body(country_code: str) -> dict:
    return {"CountryCode": country_code}


def hotel_code_list_body(city_code: int) -> dict:
    return {"CityCode": int(city_code)}


def hotel_details_body(hotel_codes: str | Sequence[Any], *, language: str = "EN", room_detail: bool = True) -> dict:
    codes = hotel_codes if isinstance(hotel_codes, str) else ",".join(str(c) for c in hotel_codes)
    return {"Hotelcodes": codes, "Language": language, "IsRoomDetailRequired": str(bool(room_detail))}


# --------------------------------------------------------------------------- #
# Response helpers
# --------------------------------------------------------------------------- #

def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def status_code_ok(payload: Mapping[str, Any]) -> bool:
    """Whether a lite/static ``Status.Code`` indicates a usable response."""
    code = (payload.get("Status") or {}).get("Code")
    return code in _OK_CODES


def status_code_is_empty(payload: Mapping[str, Any]) -> bool:
    """201 — a successful search that simply found no availability."""
    return (payload.get("Status") or {}).get("Code") == STATUS_CODE_NO_RESULT


# --------------------------------------------------------------------------- #
# Response parsers
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class TBOHotelRoom:
    booking_code: str | None
    name: tuple[str, ...]
    meal_type: str | None
    is_refundable: bool | None
    total_fare: float | None
    total_tax: float | None
    base_price: float | None
    net_amount: float | None
    cancel_policies: tuple[Mapping[str, Any], ...]
    raw: Mapping[str, Any] = field(default=None, repr=False)  # type: ignore[assignment]


def _room(node: Mapping[str, Any]) -> TBOHotelRoom:
    names = node.get("Name")
    if isinstance(names, str):
        names = [names]
    return TBOHotelRoom(
        booking_code=node.get("BookingCode"),
        name=tuple(names or ()),
        meal_type=node.get("MealType"),
        is_refundable=node.get("IsRefundable"),
        total_fare=_num(node.get("TotalFare")),
        total_tax=_num(node.get("TotalTax")),
        base_price=_num(node.get("BasePrice")),
        net_amount=_num(node.get("NetAmount")),
        cancel_policies=tuple(node.get("CancelPolicies") or ()),
        raw=node,
    )


@dataclass(frozen=True)
class TBOHotelOption:
    hotel_code: str | None
    currency: str | None
    rooms: tuple[TBOHotelRoom, ...]


def _hotel_option(node: Mapping[str, Any]) -> TBOHotelOption:
    return TBOHotelOption(
        hotel_code=str(node.get("HotelCode")) if node.get("HotelCode") is not None else None,
        currency=node.get("Currency"),
        rooms=tuple(_room(r) for r in node.get("Rooms") or []),
    )


def parse_search(payload: Mapping[str, Any]) -> tuple[TBOHotelOption, ...]:
    """``/Search`` (or PreBook) ``HotelResult`` into hotel options."""
    return tuple(_hotel_option(h) for h in payload.get("HotelResult") or [])


@dataclass(frozen=True)
class TBOHotelPreBook:
    booking_code: str | None
    currency: str | None
    net_amount: float | None
    requirement_flags: Mapping[str, Any]
    tax_breakup: tuple[Mapping[str, Any], ...]
    cancel_policies: tuple[Mapping[str, Any], ...]
    raw: Mapping[str, Any] = field(default=None, repr=False)  # type: ignore[assignment]


_FLAG_KEYS = (
    "PanMandatory", "PassportMandatory", "GSTAllowed", "PanCountRequired",
    "SamePaxNameAllowed", "SpaceAllowed", "SpecialCharAllowed",
    "PaxNameMinLength", "PaxNameMaxLength", "PackageFare", "PackageDetailsMandatory",
)


def parse_prebook(payload: Mapping[str, Any]) -> TBOHotelPreBook:
    options = payload.get("HotelResult") or []
    first = options[0] if options else {}
    rooms = first.get("Rooms") or []
    room = rooms[0] if rooms else {}
    flags = {k: room.get(k) for k in _FLAG_KEYS if k in room}
    return TBOHotelPreBook(
        booking_code=room.get("BookingCode"),
        currency=first.get("Currency"),
        net_amount=_num(room.get("NetAmount")),
        requirement_flags=flags,
        tax_breakup=tuple(room.get("TaxBreakup") or ()),
        cancel_policies=tuple(room.get("CancelPolicies") or ()),
        raw=payload,
    )


@dataclass(frozen=True)
class TBOHotelBooking:
    booking_id: int | None
    confirmation_no: str | None
    booking_ref_no: str | None
    status: int | None
    status_label: str | None
    voucher_status: bool | None
    hotel_booking_status: str | None
    is_price_changed: bool | None
    is_cancellation_policy_changed: bool | None
    net_amount: float | None
    invoice_number: str | None
    last_cancellation_date: str | None
    change_request_id: int | None
    cancellation_charge: float | None
    refund_amount: float | None
    change_request_status: int | None
    raw: Mapping[str, Any] = field(default=None, repr=False)  # type: ignore[assignment]


def _rooms_last_cxl(payload: Mapping[str, Any]) -> str | None:
    rooms = payload.get("Rooms")
    if isinstance(rooms, Mapping):
        return rooms.get("LastCancellationDate")
    if isinstance(rooms, list) and rooms and isinstance(rooms[0], Mapping):
        return rooms[0].get("LastCancellationDate")
    return None


def parse_booking(payload: Mapping[str, Any]) -> TBOHotelBooking:
    """Book / GetBookingDetail / GenerateVoucher share enough shape to parse once."""
    status = payload.get("Status")
    return TBOHotelBooking(
        booking_id=payload.get("BookingId"),
        confirmation_no=payload.get("ConfirmationNo"),
        booking_ref_no=payload.get("BookingRefNo") or payload.get("BookingReferenceNo"),
        status=status,
        status_label=BOOK_STATUS.get(status) if isinstance(status, int) else None,
        voucher_status=payload.get("VoucherStatus"),
        hotel_booking_status=payload.get("HotelBookingStatus"),
        is_price_changed=payload.get("IsPriceChanged"),
        is_cancellation_policy_changed=payload.get("IsCancellationPolicyChanged"),
        net_amount=_num(payload.get("NetAmount")),
        invoice_number=payload.get("InvoiceNumber"),
        last_cancellation_date=_rooms_last_cxl(payload),
        change_request_id=payload.get("ChangeRequestId"),
        cancellation_charge=_num(payload.get("CancellationCharge")),
        refund_amount=_num(payload.get("RefundAmount")),
        change_request_status=payload.get("ChangeRequestStatus"),
        raw=payload,
    )
