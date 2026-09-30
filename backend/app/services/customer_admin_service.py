"""Reading B2C customers for the admin desk — Phase 1 of the B2C Admin
Portal build-out.

READ-ONLY, LIKE THE PAYMENTS DESK NEXT TO IT. There is no write here and none
is planned for this phase: a customer's own status change (block/suspend) is
account-administration, not a listing concern, and belongs with whichever
phase actually builds that workflow rather than bolted onto a GET module.

NO NEW TABLE. Every field below already exists on ``Customer`` and the three
per-product booking/payment/review tables migration 0053 onward built for the
customer-facing site; this only reads them for a different audience.
"""
from __future__ import annotations

import datetime as dt
import math
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerHotelBooking,
    CustomerPackageBooking,
    CustomerReview,
)
from app.services import customer_payment_admin_service as payments_service

#: (product, booking model, the booking's own title column, its travel-date
#: column, its status column already being a plain string on all three).
_BOOKING_PRODUCTS = (
    ("flight", CustomerBooking, None, CustomerBooking.travel_date),
    ("hotel", CustomerHotelBooking, CustomerHotelBooking.hotel_name, CustomerHotelBooking.check_in_date),
    ("package", CustomerPackageBooking, CustomerPackageBooking.package_name, CustomerPackageBooking.departure_date),
)

#: The three filter chips the Customers screen offers. "new" is a judgement
#: call, not a status the database stores: a customer created in the last 30
#: days. Documented here so the number is easy to find and to change.
NEW_CUSTOMER_WINDOW_DAYS = 30


def _booking_pk(model):
    for attr in ("customer_package_booking_id", "customer_hotel_booking_id", "customer_booking_id"):
        col = getattr(model, attr, None)
        if col is not None:
            return col
    raise ValueError(f"No primary key on {model.__name__}")


def _booking_title(product: str, row) -> str:
    if product == "flight":
        origin = row.origin_city or row.origin_code or "?"
        dest = row.destination_city or row.destination_code or "?"
        return f"{origin} → {dest}"
    if product == "hotel":
        return row.hotel_name
    return row.package_name


def _booking_counts(db: Session, customer_ids: list[int]) -> dict[int, int]:
    """One count per customer, summed across all three products — a single
    small query per product rather than one query per row, so the list
    screen's page load stays flat regardless of how many customers are on it."""
    counts: dict[int, int] = {cid: 0 for cid in customer_ids}
    if not customer_ids:
        return counts
    for _product, model, _title, _travel in _BOOKING_PRODUCTS:
        stmt = (
            select(model.customer_id, func.count())
            .where(model.customer_id.in_(customer_ids))
            .group_by(model.customer_id)
        )
        for cid, n in db.execute(stmt).all():
            counts[cid] = counts.get(cid, 0) + n
    return counts


def list_customers(
    db: Session, *, search: str | None = None, status: str | None = None,
    filter_: str | None = None, page: int = 1, page_size: int = 25,
) -> dict[str, Any]:
    """Newest first. ``filter_`` is the sidebar's own vocabulary (active /
    blocked / new); ``status`` is the database's, for a screen that wants to
    filter on ``inactive``/``suspended`` too. The two may overlap on purpose —
    ``filter_=active`` and ``status=active`` reach the same rows."""
    q = select(Customer)
    if filter_ == "active":
        q = q.where(Customer.status == "active")
    elif filter_ == "blocked":
        q = q.where(Customer.status == "blocked")
    elif filter_ == "new":
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=NEW_CUSTOMER_WINDOW_DAYS)
        q = q.where(Customer.created_at >= cutoff)
    if status:
        q = q.where(Customer.status == status)
    if search:
        like = f"%{search.strip()}%"
        q = q.where(or_(
            Customer.full_name.ilike(like),
            Customer.email.ilike(like),
            Customer.mobile.ilike(like),
            Customer.customer_code.ilike(like),
        ))

    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    page = max(1, page)
    page_size = max(1, min(200, page_size))
    rows = db.execute(
        q.order_by(Customer.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).scalars().all()

    counts = _booking_counts(db, [c.customer_id for c in rows])
    items = [
        {
            "customer_id": c.customer_id,
            "customer_code": c.customer_code,
            "full_name": c.full_name,
            "email": c.email,
            "mobile": c.mobile,
            "status": c.status.value if hasattr(c.status, "value") else c.status,
            "is_guest": c.is_guest,
            "created_at": c.created_at,
            "total_bookings": counts.get(c.customer_id, 0),
        }
        for c in rows
    ]
    return {
        "items": items, "total": total, "page": page, "page_size": page_size,
        "total_pages": max(1, math.ceil(total / page_size)) if page_size else 1,
    }


def get_customer(db: Session, customer_id: int) -> Customer | None:
    return db.get(Customer, customer_id)


def get_customer_detail(db: Session, customer: Customer) -> dict[str, Any]:
    """Profile + Booking History + Payment History + Reviews, in one call —
    the Customer Details screen renders all four from a single response."""
    bookings: list[dict[str, Any]] = []
    total_spend = Decimal("0")
    for product, model, _title_col, _travel_col in _BOOKING_PRODUCTS:
        rows = db.execute(
            select(model).where(model.customer_id == customer.customer_id)
        ).scalars().all()
        for r in rows:
            amount = Decimal(str(r.total_amount or 0))
            total_spend += amount
            bookings.append({
                "product": product,
                "booking_id": _booking_pk_value(r),
                "booking_ref": r.booking_ref,
                "title": _booking_title(product, r),
                "travel_date": getattr(r, "travel_date", None) or getattr(r, "check_in_date", None)
                    or getattr(r, "departure_date", None),
                "amount": amount,
                "status": r.status,
                "created_at": r.created_at,
            })
    bookings.sort(key=lambda b: b["created_at"], reverse=True)

    payments = payments_service.list_payments(
        db, page=1, page_size=200, customer_id=customer.customer_id,
    )["items"]

    review_rows = db.execute(
        select(CustomerReview)
        .where(CustomerReview.customer_id == customer.customer_id)
        .order_by(CustomerReview.created_at.desc())
    ).scalars().all()
    reviews = [
        {
            "review_id": r.customer_review_id,
            "item_type": r.item_type,
            "item_id": r.item_id,
            "rating": r.rating,
            "comment": r.comment,
            "created_at": r.created_at,
        }
        for r in review_rows
    ]

    return {
        "customer_id": customer.customer_id,
        "customer_code": customer.customer_code,
        "full_name": customer.full_name,
        "email": customer.email,
        "mobile": customer.mobile,
        "status": customer.status.value if hasattr(customer.status, "value") else customer.status,
        "is_guest": customer.is_guest,
        "email_verified": customer.email_verified,
        "mobile_verified": customer.mobile_verified,
        "created_at": customer.created_at,
        "updated_at": customer.updated_at,
        "total_bookings": len(bookings),
        "total_spend": total_spend,
        "bookings": bookings,
        "payments": payments,
        "reviews": reviews,
    }


def _booking_pk_value(row) -> int:
    for attr in ("customer_package_booking_id", "customer_hotel_booking_id", "customer_booking_id"):
        value = getattr(row, attr, None)
        if value is not None:
            return value
    raise ValueError(f"No primary key on {type(row).__name__}")
