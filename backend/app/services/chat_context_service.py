"""What the agent needs to know before they say hello (CR-11).

THE PROBLEM THIS SOLVES
An agent opens a chat and the first four exchanges are always the same: what is
your booking reference, which trip, has the payment gone through, what is your
phone number. The customer has already told us all of it — it is in three
booking tables — and asking again is both slow and a small insult to someone who
booked twenty minutes ago.

WHAT IT RETURNS
The customer's own details, plus their recent bookings across all three products
in one list, newest departure first, each with the payment state that actually
matters. It is READ-ONLY and derived entirely from tables that already exist:
nothing here writes, and no new table was added for it.

ONE SHAPE FOR THREE PRODUCTS
A flight, a hotel stay and a tour package have almost nothing in common as rows.
They are flattened into one `BookingSummary` shape here rather than in the
frontend, because the alternative is three render paths in the console and an
agent whose eye has to re-learn the layout depending on what the customer
bought. `title` and `detail` are built per product; everything else is common.

WHY THE PAYMENT STATE IS COMPUTED, NOT READ
There is no `is_paid` column. A booking's payment lives in its own attempts
table, and the question "has this been paid" means "is there a CAPTURED attempt"
— `CustomerPaymentStatus.CAPTURED` is the terminal success state and there is
deliberately no `PAID` synonym. Computing it here means the console and the
customer's own My Bookings screen cannot disagree about what "Paid" means.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerProfile,
)

#: How many bookings the pane shows. An agent needs the trip being discussed and
#: enough history to recognise a repeat customer — not a full account statement,
#: which is what the customer's own My Bookings screen is for.
RECENT_LIMIT = 6

#: The terminal success state. Named once so this module and the customer's own
#: screens cannot drift on what "Paid" means.
_CAPTURED = "captured"


def _money(value: Optional[Decimal | float]) -> Optional[float]:
    """Numeric(12,2) -> a JSON number, or None.

    float() rather than str(): the console formats it for display and a string
    that has to be parsed back before it can be compared or summed is a trap
    for whatever gets built on this next.
    """
    return None if value is None else float(value)


def _iso(value: Optional[dt.date | dt.datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _paid_state(db: Session, model, fk_name: str, booking_id: int) -> dict[str, Any]:
    """Has this booking been paid for, and how much of it.

    `fk_name` is passed in because the three payment tables do NOT agree on it:
    `customer_booking_id`, `hotel_booking_id`, `package_booking_id`. Hard-coding
    one and reusing it is an AttributeError at runtime on two of three products,
    which is exactly what happened while writing this.

    Returns the *best* attempt, not the latest: a customer who failed a payment
    and then succeeded has both rows, and showing the failure because it came
    second would have an agent telling someone their payment did not go through
    when it did.
    """
    rows = db.execute(
        select(model.status, model.amount)
        .where(getattr(model, fk_name) == booking_id)
    ).all()
    if not rows:
        return {"paid": False, "payment_status": "none", "paid_amount": 0.0}
    captured = [amount for status, amount in rows if str(status) == _CAPTURED]
    if captured:
        return {
            "paid": True,
            "payment_status": _CAPTURED,
            "paid_amount": float(sum(captured)),
        }
    # No successful attempt. Report the most recent one's status so the agent
    # can say "your payment failed" rather than "I don't see a payment".
    return {
        "paid": False,
        "payment_status": str(rows[-1][0]),
        "paid_amount": 0.0,
    }


def _flight_rows(db: Session, customer_id: int) -> list[dict[str, Any]]:
    rows = db.execute(
        select(CustomerBooking)
        .where(CustomerBooking.customer_id == customer_id)
        .order_by(CustomerBooking.customer_booking_id.desc())
        .limit(RECENT_LIMIT)
    ).scalars()
    out = []
    for b in rows:
        route = " → ".join(
            p for p in (b.origin_city or b.origin_code, b.destination_city or b.destination_code)
            if p
        )
        out.append({
            "product": "flight",
            "booking_ref": b.booking_ref,
            "reference_extra": b.pnr,          # the airline's own, which callers quote
            "title": route or "Flight",
            "detail": " · ".join(p for p in (
                b.airline, b.flight_number, b.cabin_class,
                f"{b.stops} stop{'s' if b.stops != 1 else ''}" if b.stops else "Direct",
            ) if p),
            "travel_date": _iso(b.travel_date),
            "status": str(b.status),
            "total_amount": _money(b.total_amount),
            "currency": b.currency,
            "created_at": _iso(b.created_at),
            **_paid_state(db, CustomerBookingPayment, "customer_booking_id", b.customer_booking_id),
        })
    return out


def _hotel_rows(db: Session, customer_id: int) -> list[dict[str, Any]]:
    rows = db.execute(
        select(CustomerHotelBooking)
        .where(CustomerHotelBooking.customer_id == customer_id)
        .order_by(CustomerHotelBooking.customer_hotel_booking_id.desc())
        .limit(RECENT_LIMIT)
    ).scalars()
    out = []
    for b in rows:
        nights = f"{b.nights} night{'s' if b.nights != 1 else ''}" if b.nights else None
        out.append({
            "product": "hotel",
            "booking_ref": b.booking_ref,
            "reference_extra": None,
            "title": b.hotel_name or "Hotel",
            "detail": " · ".join(p for p in (
                b.hotel_location, b.room_name, nights, b.meal_plan,
            ) if p),
            "travel_date": _iso(b.check_in_date),
            "status": str(b.status),
            "total_amount": _money(b.total_amount),
            "currency": b.currency,
            "created_at": _iso(b.created_at),
            **_paid_state(
                db, CustomerHotelBookingPayment,
                "hotel_booking_id", b.customer_hotel_booking_id,
            ),
        })
    return out


def _package_rows(db: Session, customer_id: int) -> list[dict[str, Any]]:
    rows = db.execute(
        select(CustomerPackageBooking)
        .where(CustomerPackageBooking.customer_id == customer_id)
        .order_by(CustomerPackageBooking.customer_package_booking_id.desc())
        .limit(RECENT_LIMIT)
    ).scalars()
    out = []
    for b in rows:
        days = f"{b.package_days} days" if b.package_days else None
        pax = f"{b.pax_count} traveller{'s' if b.pax_count != 1 else ''}" if b.pax_count else None
        out.append({
            "product": "package",
            "booking_ref": b.booking_ref,
            "reference_extra": None,
            "title": b.package_name or "Tour package",
            "detail": " · ".join(p for p in (days, pax) if p),
            "travel_date": _iso(b.departure_date),
            "status": str(b.status),
            "total_amount": _money(b.total_amount),
            "currency": b.currency,
            "created_at": _iso(b.created_at),
            **_paid_state(
                db, CustomerPackageBookingPayment,
                "package_booking_id", b.customer_package_booking_id,
            ),
        })
    return out


def for_customer(db: Session, customer_id: int) -> dict[str, Any]:
    """Everything the console pane shows for one customer.

    THREE QUERIES PLUS ONE PER BOOKING FOR PAYMENT, capped at RECENT_LIMIT per
    product — so at most twenty-one small queries on a screen an agent opens
    once per conversation. A single join across three product tables and their
    payment tables would be one query and an unreadable one; this is the trade
    made deliberately, and the cap is what keeps it honest.
    """
    customer = db.get(Customer, customer_id)
    if customer is None:
        return {"customer": None, "bookings": [], "totals": {}}

    profile = db.execute(
        select(CustomerProfile).where(CustomerProfile.customer_id == customer_id)
    ).scalar_one_or_none()

    bookings = _flight_rows(db, customer_id) + _hotel_rows(db, customer_id) \
        + _package_rows(db, customer_id)
    # Newest first by when it was BOOKED, not by travel date: an agent answering
    # a chat is nearly always being asked about the thing just booked, and a
    # trip taken last year would otherwise sort above it.
    bookings.sort(key=lambda b: b["created_at"] or "", reverse=True)
    bookings = bookings[:RECENT_LIMIT]

    return {
        "customer": {
            "customer_id": customer.customer_id,
            "customer_code": customer.customer_code,
            "full_name": customer.full_name,
            "email": customer.email,
            "mobile": customer.mobile,
            "city": getattr(profile, "city", None) if profile else None,
            "created_at": _iso(customer.created_at),
        },
        "bookings": bookings,
        "totals": {
            "booking_count": len(bookings),
            "unpaid_count": sum(1 for b in bookings if not b["paid"]),
        },
    }
