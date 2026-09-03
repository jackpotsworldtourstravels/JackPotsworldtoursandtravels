"""Reading B2C customer payments for the admin desk.

THE B2B ``payments`` TABLE IS NOT IMPORTED HERE, AND MUST NOT BE.
``payments`` is merchant money: a travel agent's wallet top-ups, settlements
and refunds, verified by hand and governed by the frozen wallet module. This
module reads the three ``customer_*_booking_payments`` tables, which are a
member of the public paying for their own trip through a gateway. They are
different money, different people and different rules, and a screen that
silently mixed them would give a desk one list in which "verify" means two
incompatible things.

The separation is structural rather than remembered: ``models_customer`` has
its own declarative Base, so a join between the two sides cannot be written
here even by accident.

WHY THIS IS READ-ONLY
There is no write in this module and there must not be one. A payment moves
because a provider says so and the verification path agrees — never because a
member of staff pressed a button on a list. Adding an "approve" here would
create a second path to ``captured`` that bypasses every check Phase 6 makes.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    PaymentProviderEvent,
)

#: (product, payment model, booking model, the FK, the booking's title column)
#:
#: All three are listed even though only packages can currently take a payment:
#: the columns exist on all three (migration 0062), the webhook resolves
#: against all three, and a desk must not be shown a filtered view that hides a
#: payment merely because its product was wired up later.
_PRODUCTS = (
    (
        "package",
        CustomerPackageBookingPayment,
        CustomerPackageBooking,
        CustomerPackageBookingPayment.package_booking_id,
        CustomerPackageBooking.package_name,
        CustomerPackageBooking.departure_date,
    ),
    (
        "hotel",
        CustomerHotelBookingPayment,
        CustomerHotelBooking,
        CustomerHotelBookingPayment.hotel_booking_id,
        CustomerHotelBooking.hotel_name,
        CustomerHotelBooking.check_in_date,
    ),
    (
        "flight",
        CustomerBookingPayment,
        CustomerBooking,
        CustomerBookingPayment.customer_booking_id,
        CustomerBooking.flight_number,
        CustomerBooking.travel_date,
    ),
)

#: Statuses the filter offers. The database's own vocabulary, unchanged —
#: ``captured`` is not renamed to ``paid`` here or anywhere below the UI.
STATUSES = (
    "pending", "processing", "authorized", "captured",
    "failed", "cancelled", "expired", "refunded",
)


def _row(product: str, payment, booking, customer, title, travel) -> dict[str, Any]:
    """One flat row. Only the fields the schema allows through."""
    return {
        "payment_id": _pk(payment),
        "product": product,
        "booking_ref": booking.booking_ref,
        "booking_status": booking.status,
        "customer_id": customer.customer_id,
        "customer_name": customer.full_name,
        "customer_email": customer.email,
        "package_name": title,
        "travel_date": travel,
        "booking_amount": booking.total_amount,
        "amount": payment.amount,
        "currency": payment.currency,
        "status": payment.status,
        "provider_status": payment.provider_status,
        "method": payment.method,
        "provider": payment.provider,
        "provider_order_id": payment.provider_order_id,
        "provider_payment_id": payment.provider_payment_id,
        "failure_reason": payment.failure_reason,
        "paid_at": payment.paid_at,
        "created_at": payment.created_at,
        "updated_at": payment.updated_at,
    }


def _pk(payment) -> int:
    """The primary key, whichever of the three tables this is."""
    for attr in (
        "customer_package_booking_payment_id",
        "customer_hotel_booking_payment_id",
        "customer_booking_payment_id",
    ):
        value = getattr(payment, attr, None)
        if value is not None:
            return value
    raise ValueError(f"No primary key on {type(payment).__name__}")


def _base_query(db: Session, product_spec, *, status=None, provider=None,
                search=None, date_from=None, date_to=None):
    product, pay_model, book_model, fk, title_col, travel_col = product_spec
    q = (
        select(pay_model, book_model, Customer, title_col, travel_col)
        .join(book_model, fk == _booking_pk(book_model))
        .join(Customer, Customer.customer_id == book_model.customer_id)
    )
    if status:
        q = q.where(pay_model.status == status)
    if provider:
        q = q.where(pay_model.provider == provider)
    if date_from:
        q = q.where(pay_model.created_at >= date_from)
    if date_to:
        q = q.where(pay_model.created_at < date_to + dt.timedelta(days=1))
    if search:
        like = f"%{search.strip()}%"
        # Deliberately does NOT search the customer's mobile: this screen does
        # not display it, and a field you can search by is a field you have
        # disclosed.
        q = q.where(or_(
            book_model.booking_ref.ilike(like),
            Customer.full_name.ilike(like),
            Customer.email.ilike(like),
            pay_model.provider_payment_id.ilike(like),
            pay_model.provider_order_id.ilike(like),
        ))
    return q


def _booking_pk(book_model):
    for attr in (
        "customer_package_booking_id",
        "customer_hotel_booking_id",
        "customer_booking_id",
    ):
        col = getattr(book_model, attr, None)
        if col is not None:
            return col
    raise ValueError(f"No primary key on {book_model.__name__}")


def list_payments(
    db: Session, *, page: int = 1, page_size: int = 25, product: str | None = None,
    status: str | None = None, provider: str | None = None, search: str | None = None,
    date_from: dt.date | None = None, date_to: dt.date | None = None,
) -> dict[str, Any]:
    """Every B2C payment matching the filters, newest first.

    THE THREE PRODUCTS ARE QUERIED SEPARATELY AND MERGED IN PYTHON, not
    UNIONed. Their payment tables have different column names and different
    foreign keys, and a UNION would need a hand-written column list per table
    that drifts the moment one of them gains a field. The volumes here are a
    customer-portal's worth of payments, not a ledger's; correctness over a
    join that has to be right three times.
    """
    rows: list[dict[str, Any]] = []
    for spec in _PRODUCTS:
        if product and spec[0] != product:
            continue
        q = _base_query(db, spec, status=status, provider=provider, search=search,
                        date_from=date_from, date_to=date_to)
        for payment, booking, customer, title, travel in db.execute(q).all():
            rows.append(_row(spec[0], payment, booking, customer, title, travel))

    rows.sort(key=lambda r: r["created_at"], reverse=True)
    total = len(rows)
    page = max(1, page)
    page_size = max(1, min(200, page_size))
    start = (page - 1) * page_size
    return {
        "items": rows[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def counts(db: Session) -> dict[str, Any]:
    """Row counts per status, plus the deferred-event backlog."""
    by_status = {s: 0 for s in STATUSES}
    total = 0
    for product, pay_model, *_ in _PRODUCTS:
        for status, n in db.execute(
            select(pay_model.status, func.count()).group_by(pay_model.status)
        ).all():
            by_status[status] = by_status.get(status, 0) + n
            total += n

    deferred = db.execute(
        select(func.count()).select_from(PaymentProviderEvent)
        .where(PaymentProviderEvent.processing_status == "deferred")
    ).scalar() or 0

    return {"total": total, "by_status": by_status, "deferred_events": deferred}


def get_payment(db: Session, product: str, payment_id: int) -> dict[str, Any] | None:
    """One payment with the provider events that concern it."""
    spec = next((s for s in _PRODUCTS if s[0] == product), None)
    if spec is None:
        return None
    _, pay_model, book_model, fk, title_col, travel_col = spec

    found = db.execute(
        select(pay_model, book_model, Customer, title_col, travel_col)
        .join(book_model, fk == _booking_pk(book_model))
        .join(Customer, Customer.customer_id == book_model.customer_id)
        .where(_pk_col(pay_model) == payment_id)
    ).first()
    if found is None:
        return None

    payment, booking, customer, title, travel = found
    row = _row(product, payment, booking, customer, title, travel)

    # Events are matched on the provider's identifiers, which is how they were
    # recorded. An event with neither cannot be attributed to a payment and is
    # not guessed at.
    events = []
    if payment.provider and (payment.provider_payment_id or payment.provider_order_id):
        conditions = []
        if payment.provider_payment_id:
            conditions.append(
                PaymentProviderEvent.provider_payment_id == payment.provider_payment_id
            )
        if payment.provider_order_id:
            conditions.append(
                PaymentProviderEvent.provider_order_id == payment.provider_order_id
            )
        events = db.execute(
            select(PaymentProviderEvent)
            .where(
                PaymentProviderEvent.provider == payment.provider,
                or_(*conditions),
            )
            .order_by(PaymentProviderEvent.received_at.desc())
            .limit(50)
        ).scalars().all()

    row["events"] = events
    return row


def _pk_col(pay_model):
    for attr in (
        "customer_package_booking_payment_id",
        "customer_hotel_booking_payment_id",
        "customer_booking_payment_id",
    ):
        col = getattr(pay_model, attr, None)
        if col is not None:
            return col
    raise ValueError(f"No primary key column on {pay_model.__name__}")
