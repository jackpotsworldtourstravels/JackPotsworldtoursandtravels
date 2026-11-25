"""Translate TBO hotel payloads into ours, and never invent a value.

Two directions, mirroring the flight mapper:

  * OUT: TBO Search options -> a normalised hotel/room shape the app can render,
    plus ``supplier_*`` fields carrying TBO's own references (HotelCode,
    BookingCode) and price untouched.

  * IN: our room/guest inputs -> the ``HotelRoomsDetails`` array that Book wants.

THE ONE RULE: what TBO does not state we show as unknown (``None``), never a
default. ``BookingCode`` is the handle that threads Search -> PreBook -> Book;
``NetAmount`` from PreBook is the authoritative price Book must echo.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

from app.integrations.tbo_hotel.schemas import TBOHotelOption, TBOHotelRoom

SUPPLIER = "tbo"

#: PaxType — Adult / Child (Age mandatory, <= 12).
PAX_ADULT = 1
PAX_CHILD = 2


def room_to_dict(room: TBOHotelRoom) -> dict:
    """One TBO room rate into our normalised room shape."""
    total = room.total_fare
    return {
        "booking_code": room.booking_code,
        "name": list(room.name),
        "mealPlan": room.meal_type,
        "refundable": room.is_refundable,
        "baseFare": room.base_price,
        "taxes": room.total_tax,
        "total": total,
        "cancelPolicies": [dict(c) for c in room.cancel_policies],
        # ---- supplier references ---------------------------------------- #
        "supplier": SUPPLIER,
        "supplier_booking_code": room.booking_code,
        "supplier_total_amount": total,
    }


def option_to_hotel(option: TBOHotelOption) -> dict:
    """One TBO hotel option (a HotelCode + its rooms) into our hotel shape.

    The descriptive content (name, images, address, rating) is NOT in the
    Search response — it comes from the static-content HotelDetails call, keyed
    by ``supplier_hotel_code``. We carry the code and leave the content fields
    ``None`` rather than inventing them here.
    """
    return {
        "supplier": SUPPLIER,
        "supplier_hotel_code": option.hotel_code,
        "currency": option.currency,
        "name": None,
        "location": None,
        "rooms": [room_to_dict(r) for r in option.rooms],
    }


def options_to_hotels(options: Sequence[TBOHotelOption]) -> list[dict]:
    return [option_to_hotel(o) for o in options]


# --------------------------------------------------------------------------- #
# Booking direction
# --------------------------------------------------------------------------- #

_PAX_TYPE_MAP = {"adult": PAX_ADULT, "adt": PAX_ADULT, "": PAX_ADULT, "child": PAX_CHILD, "chd": PAX_CHILD}


def _pax_type(value: Any) -> int:
    if isinstance(value, int):
        return value if value in (PAX_ADULT, PAX_CHILD) else PAX_ADULT
    return _PAX_TYPE_MAP.get((str(value) or "").strip().lower(), PAX_ADULT)


def _passenger(guest: Mapping[str, Any], *, is_lead: bool) -> dict:
    """One guest -> a TBO ``HotelPassenger``. Lead carries Phoneno + Email."""
    pax_type = _pax_type(guest.get("pax_type") or guest.get("type") or guest.get("PaxType"))
    entry: dict[str, Any] = {
        "Title": guest.get("title") or guest.get("Title"),
        "FirstName": guest.get("first_name") or guest.get("FirstName"),
        "MiddleName": guest.get("middle_name") or guest.get("MiddleName"),
        "LastName": guest.get("last_name") or guest.get("LastName"),
        "PaxType": pax_type,
        "LeadPassenger": bool(is_lead),
        "PassportNo": guest.get("passport_no") or guest.get("PassportNo"),
        "PAN": guest.get("pan") or guest.get("PAN"),
    }
    if pax_type == PAX_CHILD:
        age = guest.get("age") or guest.get("Age")
        entry["Age"] = int(age) if age is not None else None
    if is_lead:
        entry["Phoneno"] = guest.get("mobile") or guest.get("phoneno") or guest.get("Phoneno")
        entry["Email"] = guest.get("email") or guest.get("Email")
    return {k: v for k, v in entry.items() if v is not None}


def rooms_to_book(rooms_guests: Sequence[Sequence[Mapping[str, Any]]]) -> list[dict]:
    """Our per-room guest lists -> ``HotelRoomsDetails`` for Book.

    ``rooms_guests`` is one list of guests per room. The first guest of each
    room is its lead (unless one is flagged). Exactly one guest per room carries
    the contact details, as TBO requires.
    """
    out: list[dict] = []
    for guests in rooms_guests:
        lead_marked = any(g.get("is_lead") or g.get("LeadPassenger") for g in guests)
        passengers = [
            _passenger(g, is_lead=bool(g.get("is_lead") or g.get("LeadPassenger")) or (not lead_marked and i == 0))
            for i, g in enumerate(guests)
        ]
        out.append({"HotelPassenger": passengers})
    return out
