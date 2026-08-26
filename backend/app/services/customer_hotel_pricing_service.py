"""What a hotel stay costs. The only place that answers that question.

Same discipline as ``customer_pricing_service.py``: the browser names the
stay — the room, the dates, the party, the add-on codes, a coupon — and never
the price. ``P.hotelPrice()`` in ``booking-products.js`` still exists as the
offline fallback and the first paint; this is a verified port of it, so the
number the customer reviews and the number written to the booking agree.

TAX IS 12%, PORTED UNCHANGED. ``P.hotelPrice()`` has always rounded the room
subtotal to the nearest rupee and taken 12% of it as "Taxes & service" — the
same figure a GST-registered Indian property would actually charge on a room
tariff. Moving the arithmetic server-side is not a reason to invent a new one.
"""
from __future__ import annotations

import datetime as dt
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.orm import Session

from app.models_customer import CustomerHotelRoom
from app.services import customer_hotel_catalog_service as catalog
from app.services import customer_pricing_service as flight_pricing

TWO_DP = Decimal("0.01")


def _money(value) -> Decimal:
    return Decimal(str(value)).quantize(TWO_DP, rounding=ROUND_HALF_UP)


class HotelPricingError(ValueError):
    """A chosen room or add-on does not exist, or a coupon does not apply."""


def nights_between(check_in: dt.date, check_out: dt.date) -> int:
    return max(1, (check_out - check_in).days)


def price_addons(addon_selections: list[dict]) -> tuple[Decimal, list[dict]]:
    """Every hotel add-on is billed once per booking — see the catalogue
    module docstring on why there is no per-guest multiplier here."""
    total = Decimal("0")
    rows: list[dict] = []
    seen = set()

    for sel in addon_selections:
        code = (sel.get("code") or "").strip()
        if not code or code in seen:
            continue
        item = catalog.find_addon(code)
        if item is None:
            raise HotelPricingError(f"'{code}' is not an add-on available on this stay.")
        seen.add(code)
        unit = _money(item["price"])
        total += unit
        rows.append({
            "addon_type": item["addon_type"], "code": item["code"], "name": item["name"],
            "description": item.get("description"), "unit_price": unit, "quantity": 1,
        })

    return _money(total), rows


def quote(
    db: Session,
    *,
    room: CustomerHotelRoom,
    nights: int,
    rooms_count: int,
    addon_selections: list[dict] | None = None,
    coupon_code: str | None = None,
) -> dict:
    """The whole stay, priced from choices alone — used by both
    ``POST /hotel-bookings/quote`` and ``POST /hotel-bookings``."""
    room_subtotal = _money(Decimal(str(room.base_price_per_night)) * nights * rooms_count)
    taxes = _money(room_subtotal * Decimal("0.12"))
    addon_total, addon_rows = price_addons(addon_selections or [])

    discount = Decimal("0")
    coupon = None
    coupon_error = None
    if coupon_code:
        try:
            discount, coupon = flight_pricing.validate_coupon(
                db, coupon_code, product_type="hotel",
                is_international=False, amount=room_subtotal,
            )
        except flight_pricing.PricingError as exc:
            coupon_error = str(exc)

    total = _money(room_subtotal + taxes + addon_total - discount)

    lines = [
        {"label": f"{room.name} × {nights} {'night' if nights == 1 else 'nights'}"
                  + (f" × {rooms_count} rooms" if rooms_count > 1 else ""),
         "amount": room_subtotal},
        {"label": "Taxes & service", "amount": taxes},
    ]
    if addon_total:
        lines.append({"label": "Add-ons", "amount": addon_total})
    if discount:
        lines.append({"label": f"Discount ({coupon.code})", "amount": -discount})

    return {
        "currency": "INR",
        "nights": nights,
        "room_subtotal": room_subtotal,
        "taxes": taxes,
        "addon_total": addon_total,
        "discount": discount,
        "total_amount": total,
        "coupon_code": coupon.code if coupon else None,
        "coupon_title": coupon.title if coupon else None,
        "coupon_error": coupon_error,
        "lines": lines,
        "addon_rows": addon_rows,
    }
