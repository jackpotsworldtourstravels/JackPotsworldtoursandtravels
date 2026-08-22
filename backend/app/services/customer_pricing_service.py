"""What a flight booking costs. The only place that answers that question.

THE POINT OF THIS MODULE IS THAT THE BROWSER NO LONGER PRICES ANYTHING.

``booking-products.js`` used to compute the fare itself — base times cabin
multiplier times passengers, plus seats, plus add-ons — and the total it
arrived at was the total that got booked. Nothing stopped a page (or anyone
with the console open) from booking a ₹25,000 ticket for ₹1.

So the arithmetic moved here, and it is redone from scratch on every quote and
again at booking time. The client sends *what was chosen* — the flight, the
cabin, the party, the seat ids, the add-on codes, the coupon — and never *what
it costs*. Any total the client happens to be displaying is a rendering of the
last quote, not an input.

FARE DERIVATION IS PORTED, NOT INVENTED. ``base`` and ``taxes`` follow exactly
the formula ``travel-data.js`` has always used, so a flight that quoted ₹16,958
in the browser still quotes ₹16,958 here. When a real search/fare API lands,
:func:`flight_fare` is the one function that changes.

MONEY IS ``Decimal`` END TO END. Rupee amounts are whole here, but a 30% coupon
on an odd fare is not, and float would round it somewhere unhelpful.
"""
from __future__ import annotations

import datetime as dt
import math
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_customer import CustomerCoupon
from app.services import customer_catalog_service as catalog

TWO_DP = Decimal("0.01")


def _money(value) -> Decimal:
    """Round to paise, half up — the way a receipt rounds, not the way IEEE does."""
    return Decimal(str(value)).quantize(TWO_DP, rounding=ROUND_HALF_UP)


def _js_round(value: float) -> int:
    """JavaScript's ``Math.round``: half away from zero, not banker's.

    Python's ``round(2.5)`` is 2 and JS's is 3. The fare formula below rounds
    to the nearest 50, so getting this wrong would shift real fares by ₹50.
    """
    return int(math.floor(value + 0.5))


def flight_fare(flight_number: str, duration_minutes: int | None) -> tuple[Decimal, Decimal]:
    """Per-passenger base fare and taxes for one flight, in economy.

    Ported line for line from ``travel-data.js``. ``flight_number`` is the seed,
    which is why two different flights of the same length price differently and
    why the same flight prices the same on every load.
    """
    minutes = duration_minutes or 120
    base = _js_round((2200 + minutes * 9 + catalog._seeded(flight_number, "fare") * 1800) / 50) * 50
    taxes = _js_round(base * 0.18 / 10) * 10
    return _money(base), _money(taxes)


def cabin_multiplier(cabin_id: str | None) -> Decimal:
    for c in catalog.CABIN_CLASSES:
        if c["id"] == (cabin_id or "economy"):
            return Decimal(str(c["multiplier"]))
    return Decimal("1")


class PricingError(ValueError):
    """A chosen item does not exist, or cannot be sold to this party."""


def price_seats(flight_key: str, seat_selections: list[dict], passenger_types: list[str]) -> tuple[Decimal, list[dict]]:
    """Price the chosen seats, refusing any the aircraft would not allow.

    ``seat_selections`` is ``[{passenger_index, seat_number}]``. The price comes
    from the seat map, never from the request.
    """
    total = Decimal("0")
    priced: list[dict] = []
    taken: set[str] = set()

    for sel in seat_selections:
        seat_id = (sel.get("seat_number") or "").strip().upper()
        if not seat_id:
            continue
        idx = int(sel.get("passenger_index", 0))

        price = catalog.seat_price(flight_key, seat_id)
        if price is None:
            raise PricingError(f"Seat {seat_id} is not a seat on this aircraft.")
        if catalog.seat_is_occupied(flight_key, seat_id):
            raise PricingError(f"Seat {seat_id} is already taken.")
        # Two travellers on one booking cannot both sit in 12A, and the seat
        # map alone would not catch it — occupancy is about other bookings.
        if seat_id in taken:
            raise PricingError(f"Seat {seat_id} was selected twice.")

        kind = passenger_types[idx] if idx < len(passenger_types) else "adult"
        if kind == "infant" and not catalog.seat_allows_infant(flight_key, seat_id):
            raise PricingError(f"Seat {seat_id} is an exit row and cannot be used by an infant.")

        taken.add(seat_id)
        total += price
        priced.append({"passenger_index": idx, "seat_number": seat_id, "price": price})

    return _money(total), priced


def price_addons(addon_selections: list[dict], pax_count: int) -> tuple[dict, list[dict]]:
    """Price the chosen add-ons against the catalogue.

    Returns the per-group totals the Fare Summary shows and the rows to persist.
    ``per: 'passenger'`` multiplies by the party size; ``per: 'booking'`` does
    not — the client's opinion on which is which is not consulted.
    """
    totals = {"baggage": Decimal("0"), "meal": Decimal("0"), "service": Decimal("0")}
    rows: list[dict] = []

    for sel in addon_selections:
        code = (sel.get("code") or "").strip()
        if not code:
            continue
        item = catalog.find_addon(code)
        if item is None:
            raise PricingError(f"'{code}' is not an add-on available on this flight.")

        unit = _money(item["price"])
        qty = pax_count if item["per"] == "passenger" else 1
        # A per-passenger add-on may be bought for one traveller rather than
        # the whole party, in which case the request names them.
        if item["per"] == "passenger" and sel.get("passenger_index") is not None:
            qty = 1

        line = _money(unit * qty)
        totals[item["addon_type"]] += line
        rows.append({
            "addon_type": item["addon_type"],
            "code": item["code"],
            "name": item["name"],
            "description": item.get("description"),
            "unit_price": unit,
            "quantity": qty,
            "passenger_index": sel.get("passenger_index"),
            "line_total": line,
        })

    return {k: _money(v) for k, v in totals.items()}, rows


def validate_coupon(
    db: Session,
    code: str,
    *,
    product_type: str,
    is_international: bool,
    amount: Decimal,
) -> tuple[Decimal, CustomerCoupon]:
    """Resolve a coupon to an actual discount, or explain why it does not apply.

    ``amount`` is what the discount is taken off — the fare before extras, not
    the grand total, so a coupon never discounts a seat or a meal.
    """
    cleaned = (code or "").strip().upper()
    if not cleaned:
        raise PricingError("Enter a coupon code.")

    coupon = db.execute(
        select(CustomerCoupon).where(func.upper(CustomerCoupon.code) == cleaned)
    ).scalar_one_or_none()

    # Deliberately the same message for "no such code" and "inactive": a coupon
    # table is not something to let strangers enumerate.
    if coupon is None or not coupon.is_active:
        raise PricingError(f"{cleaned} is not a valid coupon.")

    if coupon.product_type and coupon.product_type != product_type:
        raise PricingError(f"{cleaned} does not apply to flight bookings.")

    if coupon.international_only is not None and coupon.international_only != is_international:
        which = "international" if coupon.international_only else "domestic"
        raise PricingError(f"{cleaned} applies to {which} flights only.")

    today = dt.date.today()
    if coupon.valid_from and today < coupon.valid_from:
        raise PricingError(f"{cleaned} is not active yet.")
    if coupon.valid_to and today > coupon.valid_to:
        raise PricingError(f"{cleaned} has expired.")

    min_amount = _money(coupon.min_amount or 0)
    if amount < min_amount:
        raise PricingError(
            f"{cleaned} needs a fare of at least ₹{min_amount:,.0f} — this one is ₹{amount:,.0f}."
        )

    value = _money(coupon.discount_value)
    if coupon.discount_type == "percent":
        discount = _money(amount * value / Decimal("100"))
        if coupon.max_discount is not None:
            discount = min(discount, _money(coupon.max_discount))
    else:
        discount = value

    # A coupon worth more than the fare pays the fare, not the difference.
    discount = min(discount, amount)
    return discount, coupon


def quote(
    db: Session,
    *,
    flight_key: str,
    flight_number: str,
    duration_minutes: int | None,
    cabin: str | None,
    passenger_types: list[str],
    seat_selections: list[dict] | None = None,
    addon_selections: list[dict] | None = None,
    coupon_code: str | None = None,
    is_international: bool = False,
) -> dict:
    """The whole fare, derived from choices alone.

    This is what both ``POST /quote`` and ``POST /bookings`` price with, so the
    number the customer reviews and the number they are charged are produced by
    one code path rather than two that agree until they do not.
    """
    # An infant does not occupy a seat and is not charged a seat fare; every
    # other traveller pays. Charging for an infant's seat would be inventing a
    # fare rule the airline did not state.
    paying = [t for t in passenger_types if t != "infant"]
    pax_paying = max(1, len(paying))
    pax_count = max(1, len(passenger_types))

    unit_base, unit_taxes = flight_fare(flight_number, duration_minutes)
    mult = cabin_multiplier(cabin)

    # Rounded per passenger before multiplying, matching the browser's old
    # `Math.round(fare * mult) * pax` exactly.
    base_fare = _money(Decimal(_js_round(float(unit_base * mult))) * pax_paying)
    taxes = _money(Decimal(_js_round(float(unit_taxes * mult))) * pax_paying)

    seat_charges, priced_seats = price_seats(
        flight_key, seat_selections or [], passenger_types
    )
    addon_totals, addon_rows = price_addons(addon_selections or [], pax_count)

    discount = Decimal("0")
    coupon = None
    coupon_error = None
    if coupon_code:
        try:
            discount, coupon = validate_coupon(
                db, coupon_code, product_type="flight",
                is_international=is_international, amount=base_fare,
            )
        except PricingError as exc:
            # A quote reports a bad coupon rather than failing: the customer
            # still needs to see the fare while they fix the code.
            coupon_error = str(exc)

    total = _money(
        base_fare + taxes + seat_charges
        + addon_totals["baggage"] + addon_totals["meal"] + addon_totals["service"]
        - discount
    )

    lines = [
        {"label": f"Base fare × {pax_paying}", "amount": base_fare},
        {"label": "Taxes & surcharges", "amount": taxes},
    ]
    if seat_charges:
        lines.append({"label": "Seat charges", "amount": seat_charges})
    if addon_totals["baggage"]:
        lines.append({"label": "Baggage", "amount": addon_totals["baggage"]})
    if addon_totals["meal"]:
        lines.append({"label": "Meals", "amount": addon_totals["meal"]})
    if addon_totals["service"]:
        lines.append({"label": "Other services", "amount": addon_totals["service"]})
    if discount:
        lines.append({"label": f"Discount ({coupon.code})", "amount": -discount})

    return {
        "currency": "INR",
        "base_fare": base_fare,
        "taxes": taxes,
        "seat_charges": seat_charges,
        "baggage_total": addon_totals["baggage"],
        "meal_total": addon_totals["meal"],
        "service_total": addon_totals["service"],
        "discount": discount,
        "total_amount": total,
        "coupon_code": coupon.code if coupon else None,
        "coupon_title": coupon.title if coupon else None,
        "coupon_error": coupon_error,
        "lines": lines,
        "priced_seats": priced_seats,
        "addon_rows": addon_rows,
        "passengers_charged": pax_paying,
        "passengers_total": pax_count,
    }

def available_coupons(db: Session, *, product_type: str = "flight") -> list[CustomerCoupon]:
    """Active coupons that could apply to a product, for the offers panel.

    Date-filtered here so an expired code is never advertised; everything else
    (minimum spend, domestic/international) is left to :func:`validate_coupon`,
    which is the only thing that knows the fare it would be applied to.
    """
    today = dt.date.today()
    rows = db.execute(
        select(CustomerCoupon)
        .where(
            CustomerCoupon.is_active.is_(True),
            (CustomerCoupon.product_type.is_(None))
            | (CustomerCoupon.product_type == product_type),
        )
        .order_by(CustomerCoupon.code)
    ).scalars()
    return [
        c for c in rows
        if not (c.valid_from and today < c.valid_from)
        and not (c.valid_to and today > c.valid_to)
    ]
