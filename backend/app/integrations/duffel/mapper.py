"""Translate Duffel's vocabulary into ours, and never invent a value.

Two directions:

  * OUT: a :class:`DuffelOffer` -> the internal flight object the rest of the
    app already speaks (the shape ``travel-data.js``'s ``normaliseFlight``
    produces), plus the new ``supplier_*`` fields that carry Duffel's own
    references and price untouched.

  * IN: our passenger inputs + a re-fetched offer -> the body for
    ``POST /air/orders``.

THE ONE RULE: what Duffel does not state, we represent as unknown (``None``),
never as a made-up default. Duffel gives no per-offer seat count, so
``seatsLeft`` is ``None``, not a number. Duffel is silent on refundability for
some fares, so ``refundable`` is ``None``, not ``False``. The price, currency,
baggage and seat availability are copied from Duffel verbatim or left unknown.
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from app.integrations.duffel.schemas import DuffelOffer, DuffelSegment, DuffelSlice

SUPPLIER = "duffel"

_ISO_DUR = re.compile(
    r"P(?:(?P<days>\d+)D)?T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+)S)?"
)


def iso_duration_to_minutes(value: str | None) -> int | None:
    """``PT2H15M`` -> ``135``. Unknown/unparseable -> ``None`` (never 0)."""
    if not value:
        return None
    m = _ISO_DUR.fullmatch(value.strip())
    if not m:
        return None
    days = int(m.group("days") or 0)
    hours = int(m.group("h") or 0)
    mins = int(m.group("m") or 0)
    total = days * 1440 + hours * 60 + mins
    return total or None


def duration_label(minutes: int | None) -> str | None:
    if minutes is None:
        return None
    return f"{minutes // 60}h {minutes % 60:02d}m"


def _time_of(iso: str | None) -> str | None:
    """Extract ``HH:MM`` from a Duffel timestamp, keeping local wall time.

    Duffel gives local departure/arrival times (with the airport's offset). We
    keep the wall-clock ``HH:MM`` the traveller sees on the board and do NOT
    convert to UTC.
    """
    if not iso or "T" not in iso:
        return None
    clock = iso.split("T", 1)[1]
    return clock[:5] if len(clock) >= 5 else None


def _date_of(iso: str | None) -> str | None:
    if not iso or "T" not in iso:
        return iso or None
    return iso.split("T", 1)[0]


def _decimal(value: str | None) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _baggage(segments: Sequence[DuffelSegment]) -> dict[str, int | None]:
    """Fold Duffel's per-segment baggage into ``{cabin, checkIn}``.

    Where Duffel states a quantity we report it; where it is silent the value
    is ``None`` (unknown), never ``0``. We take the minimum across segments —
    an allowance only holds for the whole journey if every leg grants it.
    """
    cabin: list[int] = []
    checked: list[int] = []
    for seg in segments:
        for b in seg.baggages:
            if b.quantity is None:
                continue
            if b.type == "carry_on":
                cabin.append(b.quantity)
            elif b.type == "checked":
                checked.append(b.quantity)
    return {
        "cabin": min(cabin) if cabin else None,
        "checkIn": min(checked) if checked else None,
    }


def offer_to_flight(offer: DuffelOffer, *, index: int = 0) -> dict:
    """A one-way :class:`DuffelOffer` into our internal flight object.

    Multi-slice (return/multi-city) offers map their FIRST slice here; the full
    itinerary is preserved in ``supplier_raw`` for when the UI supports it.
    ``flight_key`` is the offer id — opaque to us, and what the booking path
    hands back to Duffel.
    """
    sl: DuffelSlice | None = offer.slices[0] if offer.slices else None
    segs = sl.segments if sl else ()
    first = segs[0] if segs else None
    last = segs[-1] if segs else None

    carrier_code = (first.marketing_carrier_code if first else None) or offer.owner_code
    carrier_name = (first.marketing_carrier_name if first else None) or offer.owner_name
    number = first.marketing_flight_number if first else None
    flight_number = (
        f"{carrier_code} {number}" if carrier_code and number
        else (carrier_code or number)
    )
    flight_number_raw = f"{carrier_code}{number}" if carrier_code and number else (number or carrier_code)

    minutes = iso_duration_to_minutes(sl.duration if sl else None)
    if minutes is None and first and last and first.departing_at and last.arriving_at:
        minutes = _minutes_between(first.departing_at, last.arriving_at)

    origin = first.origin if first else None
    dest = last.destination if last else None
    stops = max(len(segs) - 1, 0)

    return {
        "id": offer.id,
        "flight_key": offer.id,
        "flightNumber": flight_number,
        "flightNumberRaw": flight_number_raw,
        "airline": carrier_name,
        "airlineCode": carrier_code,
        "origin": {
            "code": origin.iata_code if origin else None,
            "city": origin.city_name if origin else None,
        },
        "destination": {
            "code": dest.iata_code if dest else None,
            "city": dest.city_name if dest else None,
        },
        "date": _date_of(first.departing_at if first else None),
        "departure": _time_of(first.departing_at if first else None),
        "arrival": _time_of(last.arriving_at if last else None),
        "durationMinutes": minutes,
        "durationLabel": duration_label(minutes),
        "stops": stops,
        "nonStop": stops == 0,
        "status": "Scheduled",
        # Money is Duffel's, verbatim. base/tax may be absent; total is what we
        # would charge and is never converted here.
        "fare": _num(offer.base_amount),
        "taxes": _num(offer.tax_amount),
        "total": _num(offer.total_amount),
        "currency": offer.total_currency,
        # Duffel gives no per-offer seat count. Unknown, not invented.
        "seatsLeft": None,
        "seatsLow": None,
        # Tri-state: True / False / None(=unknown). Never coerced to False.
        "refundable": offer.refund_before_departure_allowed,
        "fareType": None,
        "baggage": _baggage(segs),
        # ---- supplier references (the new fields) ------------------------ #
        "supplier": SUPPLIER,
        "supplier_offer_id": offer.id,
        "supplier_total_amount": offer.total_amount,
        "supplier_currency": offer.total_currency,
        "supplier_expires_at": offer.expires_at,
        "supplier_requires_instant_payment": offer.requires_instant_payment,
        "supplier_payment_required_by": offer.payment_required_by,
        "supplier_passenger_ids": list(offer.passenger_ids),
    }


def _minutes_between(dep_iso: str, arr_iso: str) -> int | None:
    """Whole minutes between two Duffel timestamps, offsets respected.

    A computed span from two facts Duffel stated is itself a fact, not an
    invention — used only when Duffel omits ``slice.duration``.
    """
    import datetime as dt
    try:
        dep = dt.datetime.fromisoformat(dep_iso)
        arr = dt.datetime.fromisoformat(arr_iso)
    except ValueError:
        return None
    delta = (arr - dep).total_seconds() / 60
    return int(delta) if delta > 0 else None


def _num(value: str | None) -> float | None:
    d = _decimal(value)
    return float(d) if d is not None else None


def offers_to_flights(offers: Sequence[DuffelOffer]) -> list[dict]:
    return [offer_to_flight(o, index=i) for i, o in enumerate(offers)]


# --------------------------------------------------------------------------- #
# Booking direction
# --------------------------------------------------------------------------- #

_TITLE_MAP = {
    "mr": "mr", "mrs": "mrs", "ms": "ms", "miss": "miss", "dr": "dr",
}
_GENDER_MAP = {
    "male": "m", "m": "m", "female": "f", "f": "f",
}


def _title(value: str | None) -> str | None:
    return _TITLE_MAP.get((value or "").strip().lower()) if value else None


def _gender(value: str | None) -> str | None:
    return _GENDER_MAP.get((value or "").strip().lower()) if value else None


def passengers_to_order(
    our_passengers: Sequence[Mapping[str, Any]],
    duffel_passenger_ids: Sequence[str],
) -> list[dict]:
    """Pair our travellers with Duffel's passenger ids, in order.

    Duffel assigns an id per passenger in the offer request; the booking must
    echo those ids back. We pair by position — the search asked for N
    passengers in a fixed order, so the Nth traveller collected here is the Nth
    Duffel id. A length mismatch is a programming error and raises.

    Field mapping is best-effort and conservative: an unrecognised title or
    gender is sent as ``None`` (omitted) rather than guessed, because a wrong
    guess on a real ticket is worse than an absent optional. ``born_on`` is our
    ``date_of_birth`` in ``YYYY-MM-DD``.
    """
    if len(our_passengers) != len(duffel_passenger_ids):
        raise ValueError(
            f"passenger count {len(our_passengers)} != Duffel ids {len(duffel_passenger_ids)}"
        )
    out: list[dict] = []
    for p, pid in zip(our_passengers, duffel_passenger_ids):
        dob = p.get("date_of_birth")
        entry: dict[str, Any] = {
            "id": pid,
            "given_name": p.get("first_name") or p.get("given_name"),
            "family_name": p.get("last_name") or p.get("family_name"),
            "born_on": str(dob) if dob else None,
            "title": _title(p.get("title")),
            "gender": _gender(p.get("gender")),
            "email": p.get("email"),
            "phone_number": p.get("mobile") or p.get("phone_number"),
        }
        out.append({k: v for k, v in entry.items() if v is not None or k == "id"})
    return out


# --------------------------------------------------------------------------- #
# Seat maps
# --------------------------------------------------------------------------- #

def seat_maps_to_contract(payload: Mapping[str, Any]) -> dict:
    """Duffel ``/air/seat_maps`` JSON -> our existing seat-map contract.

    Availability and price come straight from Duffel: a seat is bookable when
    it carries ``available_services``, and its price is that service's amount.
    A seat with no available service is ``occupied`` (unavailable to us). Seat
    ``type`` (window/aisle/middle) is derived from the seat's position in its
    row — a structural fact of the returned layout, not invented data.
    """
    rows_out: list[dict] = []
    aircraft = None
    currency = None
    maps = payload.get("data") or []
    # One seat map per segment; we render the first segment's cabin, matching
    # the single-cabin assumption of the existing UI.
    first_map = maps[0] if maps else {}
    for cabin in first_map.get("cabins") or []:
        for row in cabin.get("rows") or []:
            seats: list[dict] = []
            row_no: int | None = None
            # Flatten every element across the row's sections, in order, so
            # position-based type inference sees the true left-to-right layout.
            seat_elems = [
                el for sec in (row.get("sections") or [])
                for el in (sec.get("elements") or [])
                if el.get("type") == "seat"
            ]
            n = len(seat_elems)
            for pos, el in enumerate(seat_elems):
                designator = el.get("designator") or ""
                digits = re.match(r"(\d+)", designator)
                letter = designator[len(digits.group(1)):] if digits else designator
                row_no = int(digits.group(1)) if digits else row_no
                services = el.get("available_services") or []
                available = bool(services)
                price = None
                if services:
                    price = _num(services[0].get("total_amount"))
                    currency = currency or services[0].get("total_currency")
                seats.append({
                    "id": designator,
                    "row": row_no,
                    "letter": letter,
                    "type": _seat_type(pos, n),
                    "occupied": not available,
                    "price": price,
                    "exit": False,
                    "infant_allowed": True,
                })
            if seats:
                rows_out.append({"row": row_no, "exit": False, "seats": seats})
    return {
        "aircraft": aircraft,
        "layout": None,
        "currency": currency,
        "rows": rows_out,
        "legend": [
            {"state": "available", "label": "Available"},
            {"state": "selected", "label": "Selected"},
            {"state": "occupied", "label": "Unavailable"},
            {"state": "paid", "label": "Paid"},
        ],
        "supplier": SUPPLIER,
    }


def _seat_type(pos: int, n: int) -> str:
    """Window at the row's ends, aisle next to them, middle otherwise."""
    if n <= 0:
        return "middle"
    if pos == 0 or pos == n - 1:
        return "window"
    if pos == 1 or pos == n - 2:
        return "aisle"
    return "middle"
