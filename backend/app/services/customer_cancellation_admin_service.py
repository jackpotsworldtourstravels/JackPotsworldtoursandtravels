"""B2C cancellation/refund requests — Phase 3 of the B2C Admin Portal
build-out. Completes the lifecycle the plan drew: Customer -> Booking ->
Payment -> Cancellation -> Refund.

NO NEW MONEY MOVEMENT. This module changes ``CustomerCancellationRequest.
status`` and, on approval, the underlying booking's own ``status`` — it never
touches a payment row or calls a payment provider (there is none configured
locally, and in general a provider refund is Phase 4's concern, not this
one's). Marking a request ``refunded`` here records the admin desk's word
that the money actually went back — by bank transfer, by the provider's own
dashboard, whatever the desk actually did — not a instruction to any gateway.

See ``customer_cancellation_requests``'s migration (0089) for why this is one
polymorphic table instead of three, and why there is no ``decided_by`` column.
"""
from __future__ import annotations

import datetime as dt
import math
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerCancellationRequest
from app.services import customer_booking_admin_service as booking_service

SEQUENCE = "seq_customer_cancellation_number"

#: The five states the migration's CHECK constraint allows.
STATUSES = ("requested", "approved", "rejected", "refund_processing", "refunded")

#: Which action is legal from which current status, and what it moves to.
#: A dict rather than a chain of ifs, so the whole machine is visible at a
#: glance and the router can report "not from here" without duplicating it.
_TRANSITIONS: dict[str, tuple[str, str]] = {
    "approve": ("requested", "approved"),
    "reject": ("requested", "rejected"),
    "start_refund": ("approved", "refund_processing"),
    "complete_refund": ("refund_processing", "refunded"),
}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def next_reference(db: Session) -> str:
    """Allocate ``CXL-20260930-000001`` — the same date-stamped, sequence-
    backed pattern 0030/0046/0088 already established."""
    number = db.scalar(select(func.nextval(SEQUENCE)))
    return f"CXL-{_now():%Y%m%d}-{number:06d}"


def _service_label(product: str) -> str:
    return {"flight": "Flight", "hotel": "Hotel", "package": "Package"}.get(product, product.title())


def _row_dict(req: CustomerCancellationRequest, customer: Customer, booking) -> dict[str, Any]:
    return {
        "cancellation_id": req.cancellation_ref,
        "booking_id": req.booking_ref,
        "customer": {"id": customer.customer_id, "name": customer.full_name, "email": customer.email},
        "service_type": _service_label(req.product),
        "destination": booking_service.destination(req.product, booking) if booking else "—",
        "reason": req.reason,
        "requested_date": req.created_at,
        "status": req.status,
        "refund_amount": Decimal(str(req.refund_amount)) if req.refund_amount is not None else None,
        "booking_amount": Decimal(str(booking.total_amount or 0)) if booking else Decimal("0"),
        "admin_notes": req.admin_notes,
        "updated_at": req.updated_at,
    }


def create_request(
    db: Session, customer: Customer, booking_ref: str, reason: str | None,
) -> dict[str, Any] | str:
    """Customer-facing submission. Returns the created row, or one of the
    string sentinels the router turns into the matching HTTP response:
    ``"not_found"`` (no such booking, or it isn't this customer's),
    ``"terminal"`` (the booking is already cancelled/completed),
    ``"duplicate"`` (an open request already exists for this booking)."""
    product, booking = booking_service.find_booking(db, booking_ref)
    if booking is None or booking.customer_id != customer.customer_id:
        return "not_found"
    if booking.status in ("cancelled", "completed"):
        return "terminal"

    existing = db.execute(
        select(CustomerCancellationRequest).where(
            CustomerCancellationRequest.booking_ref == booking_ref,
            CustomerCancellationRequest.status.in_(("requested", "approved", "refund_processing")),
        )
    ).scalars().first()
    if existing is not None:
        return "duplicate"

    row = CustomerCancellationRequest(
        cancellation_ref=next_reference(db),
        customer_id=customer.customer_id,
        product=product,
        booking_ref=booking_ref,
        reason=reason,
        status="requested",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _row_dict(row, customer, booking)


def list_requests(
    db: Session, *, search: str | None = None, status: str | None = None,
    page: int = 1, page_size: int = 25,
) -> dict[str, Any]:
    q = select(CustomerCancellationRequest, Customer).join(
        Customer, Customer.customer_id == CustomerCancellationRequest.customer_id
    )
    if status:
        q = q.where(CustomerCancellationRequest.status == status)
    if search:
        like = f"%{search.strip()}%"
        q = q.where(or_(
            CustomerCancellationRequest.cancellation_ref.ilike(like),
            CustomerCancellationRequest.booking_ref.ilike(like),
            Customer.full_name.ilike(like),
            Customer.email.ilike(like),
        ))

    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    page = max(1, page)
    page_size = max(1, min(200, page_size))
    rows = db.execute(
        q.order_by(CustomerCancellationRequest.created_at.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()

    items = []
    for req, customer in rows:
        _product, booking = booking_service.find_booking(db, req.booking_ref)
        items.append(_row_dict(req, customer, booking))

    return {
        "items": items, "total": total, "page": page, "page_size": page_size,
        "total_pages": max(1, math.ceil(total / page_size)) if page_size else 1,
    }


def get_request(db: Session, cancellation_ref: str) -> dict[str, Any] | None:
    row = db.execute(
        select(CustomerCancellationRequest, Customer)
        .join(Customer, Customer.customer_id == CustomerCancellationRequest.customer_id)
        .where(CustomerCancellationRequest.cancellation_ref == cancellation_ref)
    ).first()
    if row is None:
        return None
    req, customer = row
    _product, booking = booking_service.find_booking(db, req.booking_ref)
    return _row_dict(req, customer, booking)


def decide(
    db: Session, cancellation_ref: str, action: str,
    refund_amount: Decimal | None, admin_notes: str | None,
) -> dict[str, Any] | str | None:
    """Returns the updated row, ``None`` if no such request, ``"invalid_
    action"`` if ``action`` isn't one of the four, or ``"wrong_state"`` if
    the request isn't currently in the status that action requires."""
    if action not in _TRANSITIONS:
        return "invalid_action"

    row = db.execute(
        select(CustomerCancellationRequest)
        .where(CustomerCancellationRequest.cancellation_ref == cancellation_ref)
    ).scalars().first()
    if row is None:
        return None

    required_from, target = _TRANSITIONS[action]
    if row.status != required_from:
        return "wrong_state"

    row.status = target
    if admin_notes:
        row.admin_notes = admin_notes

    if action == "approve":
        # The booking is cancelled the moment the request is approved — the
        # remaining two states (refund_processing/refunded) track the MONEY
        # coming back, not whether the trip itself still stands.
        product, booking = booking_service.find_booking(db, row.booking_ref)
        if booking is not None:
            booking.status = "cancelled"
        if refund_amount is not None:
            row.refund_amount = refund_amount
    elif action == "start_refund":
        if refund_amount is not None:
            row.refund_amount = refund_amount
        elif row.refund_amount is None:
            # No amount was set at approval and none was given now — default
            # to the booking's own total rather than leave it null while
            # `refund_processing`, which would show as "amount unknown" on
            # a screen whose whole job is to say how much is owed back.
            _product, booking = booking_service.find_booking(db, row.booking_ref)
            row.refund_amount = booking.total_amount if booking is not None else None

    db.commit()
    db.refresh(row)
    return get_request(db, cancellation_ref)


def counts(db: Session) -> dict[str, int]:
    result = {s: 0 for s in STATUSES}
    for s, n in db.execute(
        select(CustomerCancellationRequest.status, func.count())
        .group_by(CustomerCancellationRequest.status)
    ).all():
        result[s] = n
    return result
