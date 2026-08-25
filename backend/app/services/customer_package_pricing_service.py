"""What a tour package costs. The only place that answers that question.

Same discipline as the flight and hotel pricing services: the browser names
the trip — the package, the departure, the party, the add-on codes, a
coupon — and never the price. ``P.packagePrice()`` in ``booking-products.js``
still exists as the offline fallback and the first paint; this is a verified
port of it.

GST IS 5%, PORTED UNCHANGED. ``P.packagePrice()`` has always taken 5% of the
per-person total as GST — the same rate a domestic tour package is actually
sold under in India. Moving the arithmetic server-side is not a reason to
invent a new one.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.orm import Session

from app.models_customer import CustomerPackageDeparture
from app.services import customer_package_catalog_service as catalog
from app.services import customer_pricing_service as flight_pricing

TWO_DP = Decimal("0.01")


def _money(value) -> Decimal:
    return Decimal(str(value)).quantize(TWO_DP, rounding=ROUND_HALF_UP)


class PackagePricingError(ValueError):
    """A chosen add-on does not exist, or a coupon does not apply."""


def price_addons(addon_selections: list[dict], pax_count: int) -> tuple[Decimal, list[dict]]:
    """Price the chosen add-ons. ``per: "passenger"`` (travel insurance)
    multiplies by the party size unless bought for one named traveller;
    everything else is once per booking — mirrors
    ``customer_pricing_service.price_addons`` for a flight."""
    total = Decimal("0")
    rows: list[dict] = []

    for sel in addon_selections:
        code = (sel.get("code") or "").strip()
        if not code:
            continue
        item = catalog.find_addon(code)
        if item is None:
            raise PackagePricingError(f"'{code}' is not an add-on available on this package.")

        unit = _money(item["price"])
        qty = pax_count if item["per"] == "passenger" else 1
        if item["per"] == "passenger" and sel.get("traveller_index") is not None:
            qty = 1

        line = _money(unit * qty)
        total += line
        rows.append({
            "addon_type": item["addon_type"], "code": item["code"], "name": item["name"],
            "description": item.get("description"), "unit_price": unit, "quantity": qty,
            "traveller_index": sel.get("traveller_index"),
        })

    return _money(total), rows


def quote(
    db: Session,
    *,
    departure: CustomerPackageDeparture,
    pax_count: int,
    is_international: bool,
    addon_selections: list[dict] | None = None,
    coupon_code: str | None = None,
) -> dict:
    """The whole trip, priced from choices alone."""
    base_total = _money(Decimal(str(departure.price_per_person)) * pax_count)
    taxes = _money(base_total * Decimal("0.05"))
    addon_total, addon_rows = price_addons(addon_selections or [], pax_count)

    discount = Decimal("0")
    coupon = None
    coupon_error = None
    if coupon_code:
        try:
            discount, coupon = flight_pricing.validate_coupon(
                db, coupon_code, product_type="package",
                is_international=is_international, amount=base_total,
            )
        except flight_pricing.PricingError as exc:
            coupon_error = str(exc)

    total = _money(base_total + taxes + addon_total - discount)

    lines = [
        {"label": f"Package × {pax_count}", "amount": base_total},
        {"label": "GST", "amount": taxes},
    ]
    if addon_total:
        lines.append({"label": "Add-ons", "amount": addon_total})
    if discount:
        lines.append({"label": f"Discount ({coupon.code})", "amount": -discount})

    return {
        "currency": "INR",
        "base_total": base_total,
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
