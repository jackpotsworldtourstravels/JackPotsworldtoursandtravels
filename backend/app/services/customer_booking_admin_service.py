"""Reading and updating B2C bookings for the admin desk — Phase 2 of the B2C
Admin Portal build-out. This is the module that answers the question the
whole build-out started from: when a customer books a flight, hotel or
package from the public site, an admin can now find it here.

NO NEW TABLE. Every field comes from ``customer_bookings``,
``customer_hotel_bookings`` and ``customer_package_bookings`` (plus their
existing passenger/guest/traveller and payment child tables) — the same
three products ``customer_payment_admin_service.py`` and
``customer_admin_service.py`` already read for the payments desk and the
Customer Details screen. This module is the one place that also WRITES: a
booking's own ``status`` column, and nothing else.

GAMING PACKAGES HAS NO BOOKING TABLE. The public Gaming Packages page is a
call-back enquiry form (see gaming-packages.html / GamingTourEnquiry) — there
is no browsable product and nothing is ever booked through it in the sense
the other three are. The `service_type=gaming` filter is accepted, not
rejected, because the sidebar offers it for symmetry with Catalogue
Management; it deliberately returns zero rows rather than erroring, and a
gaming lead that becomes a real trip is tracked on the Gaming Tour Packages
screen (Converted Bookings), not here.
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
    CustomerBookingPassenger,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingGuest,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerPackageBookingTraveller,
)

#: (product, display label, booking model, payment model, the payment's FK
#: to the booking, passenger/guest/traveller model, its FK to the booking).
_PRODUCTS = (
    ("flight", "Flight", CustomerBooking, CustomerBookingPayment,
     CustomerBookingPayment.customer_booking_id,
     CustomerBookingPassenger, CustomerBookingPassenger.customer_booking_id),
    ("hotel", "Hotel", CustomerHotelBooking, CustomerHotelBookingPayment,
     CustomerHotelBookingPayment.hotel_booking_id,
     CustomerHotelBookingGuest, CustomerHotelBookingGuest.hotel_booking_id),
    ("package", "Package", CustomerPackageBooking, CustomerPackageBookingPayment,
     CustomerPackageBookingPayment.package_booking_id,
     CustomerPackageBookingTraveller, CustomerPackageBookingTraveller.package_booking_id),
)

#: The sidebar's own vocabulary for the Service filter — "gaming" is real (see
#: the module docstring) and always empty.
SERVICE_TYPES = ("flight", "hotel", "package", "gaming")

#: The database's own booking-status values — also the only values PATCH
#: .../status accepts. Upper-cased forms (CONFIRMED, PENDING, ...) are
#: accepted too, since that is the case the admin UI and the brief's own
#: example both use; they are lower-cased before being checked or stored.
BOOKING_STATUSES = tuple(s.value for s in CustomerBookingStatus)


def _booking_pk(model):
    for attr in ("customer_package_booking_id", "customer_hotel_booking_id", "customer_booking_id"):
        col = getattr(model, attr, None)
        if col is not None:
            return col
    raise ValueError(f"No primary key on {model.__name__}")


def _booking_pk_value(row) -> int:
    for attr in ("customer_package_booking_id", "customer_hotel_booking_id", "customer_booking_id"):
        value = getattr(row, attr, None)
        if value is not None:
            return value
    raise ValueError(f"No primary key on {type(row).__name__}")


def _destination(product: str, row) -> str:
    if product == "flight":
        origin = row.origin_city or row.origin_code or "?"
        dest = row.destination_city or row.destination_code or "?"
        return f"{origin} → {dest}"
    if product == "hotel":
        return row.hotel_location or row.hotel_name
    return row.package_name


def _travel_date(product: str, row) -> dt.date | None:
    if product == "flight":
        return row.travel_date
    if product == "hotel":
        return row.check_in_date
    return row.departure_date


def _find_product(db: Session, booking_ref: str):
    """The one product (of the three) whose booking carries this reference,
    or ``(None, None)``. Refs are prefixed per product in practice (JPP/JPH/
    the flight desk's own), so this never matches more than one row — but it
    is written to tolerate a collision by taking the first match rather than
    to assume the prefix convention holds forever."""
    for product, label, book_model, pay_model, pay_fk, trav_model, trav_fk in _PRODUCTS:
        row = db.execute(
            select(book_model).where(book_model.booking_ref == booking_ref)
        ).scalars().first()
        if row is not None:
            return (product, label, book_model, pay_model, pay_fk, trav_model, trav_fk), row
    return None, None


def _latest_payment(db: Session, pay_model, fk_col, booking_pk_value):
    return db.execute(
        select(pay_model).where(fk_col == booking_pk_value).order_by(pay_model.created_at.desc())
    ).scalars().first()


def list_bookings(
    db: Session, *, search: str | None = None, service_type: str | None = None,
    booking_status: str | None = None, page: int = 1, page_size: int = 25,
) -> dict[str, Any]:
    """Every B2C booking matching the filters, newest first.

    QUERIED PER PRODUCT AND MERGED IN PYTHON, the same call
    ``customer_payment_admin_service.list_payments`` already made for the
    identical reason: the three tables share no columns a UNION could rely
    on, and the volumes here are an admin desk's worth of bookings, not a
    ledger's.
    """
    if service_type == "gaming":
        return {"items": [], "total": 0, "page": max(1, page), "page_size": max(1, page_size),
                "total_pages": 1}

    rows: list[dict[str, Any]] = []
    for product, label, book_model, pay_model, pay_fk, _trav_model, _trav_fk in _PRODUCTS:
        if service_type and service_type != product:
            continue
        q = select(book_model, Customer).join(Customer, Customer.customer_id == book_model.customer_id)
        if booking_status:
            q = q.where(book_model.status == booking_status.lower())
        if search:
            like = f"%{search.strip()}%"
            conds = [
                book_model.booking_ref.ilike(like),
                Customer.full_name.ilike(like),
                Customer.email.ilike(like),
            ]
            if product == "flight":
                conds += [book_model.origin_city.ilike(like), book_model.destination_city.ilike(like)]
            elif product == "hotel":
                conds += [book_model.hotel_name.ilike(like), book_model.hotel_location.ilike(like)]
            else:
                conds.append(book_model.package_name.ilike(like))
            q = q.where(or_(*conds))

        booking_rows = db.execute(q).all()
        book_pks = [_booking_pk_value(b) for b, _c in booking_rows]
        payments_by_booking: dict[int, Any] = {}
        if book_pks:
            for p in db.execute(
                select(pay_model).where(pay_fk.in_(book_pks)).order_by(pay_model.created_at.desc())
            ).scalars().all():
                pk = getattr(p, pay_fk.key)
                payments_by_booking.setdefault(pk, p)  # first hit per key = newest, order_by above

        for booking, customer in booking_rows:
            pk = _booking_pk_value(booking)
            payment = payments_by_booking.get(pk)
            rows.append({
                "booking_id": booking.booking_ref,
                "customer": {
                    "id": customer.customer_id,
                    "name": customer.full_name,
                    "email": customer.email,
                },
                "service_type": label,
                "destination": _destination(product, booking),
                "travel_date": _travel_date(product, booking),
                "amount": Decimal(str(booking.total_amount or 0)),
                "payment_status": (payment.status.upper() if payment else "NO_PAYMENT"),
                "booking_status": booking.status.upper(),
                "created_at": booking.created_at,
            })

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
        "total_pages": max(1, math.ceil(total / page_size)) if page_size else 1,
    }


def get_booking(db: Session, booking_ref: str) -> dict[str, Any] | None:
    spec, booking = _find_product(db, booking_ref)
    if booking is None:
        return None
    product, label, book_model, pay_model, pay_fk, trav_model, trav_fk = spec
    customer = db.get(Customer, booking.customer_id)
    pk = _booking_pk_value(booking)

    travellers = db.execute(
        select(trav_model).where(trav_fk == pk).order_by(trav_model.guest_index
            if hasattr(trav_model, "guest_index") else trav_model.traveller_index
            if hasattr(trav_model, "traveller_index") else trav_model.passenger_index)
    ).scalars().all()
    traveller_names = [
        {
            "name": f"{t.title + ' ' if getattr(t, 'title', None) else ''}{t.first_name} {t.last_name}",
            "type": getattr(t, "traveller_type", None) or "guest",
        }
        for t in travellers
    ]

    payment = _latest_payment(db, pay_model, pay_fk, pk)

    return {
        "booking_id": booking.booking_ref,
        "customer": {
            "id": customer.customer_id,
            "name": customer.full_name,
            "email": customer.email,
            "mobile": customer.mobile,
        },
        "service_type": label,
        "destination": _destination(product, booking),
        "travel_date": _travel_date(product, booking),
        "passengers": traveller_names,
        "amount": Decimal(str(booking.total_amount or 0)),
        "currency": booking.currency,
        "booking_status": booking.status.upper(),
        "created_at": booking.created_at,
        "payment": {
            "transaction_id": payment.provider_payment_id or payment.provider_order_id if payment else None,
            "method": payment.method if payment else None,
            "status": payment.status.upper() if payment else "NO_PAYMENT",
            "amount": Decimal(str(payment.amount)) if payment else None,
        },
    }


def update_status(
    db: Session, booking_ref: str, new_status: str,
) -> dict[str, Any] | None | str:
    """Returns the updated booking dict, ``None`` if no such booking, or the
    literal string ``"invalid"`` if ``new_status`` is not one of
    BOOKING_STATUSES — the router turns each into the right HTTP response."""
    wanted = new_status.strip().lower()
    if wanted not in BOOKING_STATUSES:
        return "invalid"
    spec, booking = _find_product(db, booking_ref)
    if booking is None:
        return None
    booking.status = wanted
    db.commit()
    db.refresh(booking)
    return get_booking(db, booking_ref)


def dashboard_counts(db: Session) -> dict[str, int]:
    """Total + per-product booking counts, for the B2C dashboard cards."""
    counts = {"total": 0, "flight": 0, "hotel": 0, "package": 0, "gaming": 0}
    for product, _label, book_model, *_rest in _PRODUCTS:
        n = db.scalar(select(func.count()).select_from(book_model)) or 0
        counts[product] = n
        counts["total"] += n
    return counts
