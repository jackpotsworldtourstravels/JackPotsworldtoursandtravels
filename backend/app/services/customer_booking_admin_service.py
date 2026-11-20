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


def destination(product: str, row) -> str:
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


def find_booking(db: Session, booking_ref: str) -> tuple[str, object] | tuple[None, None]:
    """Public wrapper on ``_find_product`` for other modules — Phase 3's
    cancellation service uses this to resolve a ``booking_ref`` to its
    product and row without a second implementation of the same lookup.
    Returns ``(product, booking_row)`` or ``(None, None)``."""
    spec, row = _find_product(db, booking_ref)
    if spec is None:
        return None, None
    return spec[0], row


def booking_payment_rows(db: Session, booking_ref: str):
    """Every payment row recorded against a booking, newest first, as
    ``(product, booking_row, [payment rows])``; ``(None, None, [])`` if there is
    no such booking. The refund service reads payments through this so it
    resolves a booking exactly the way the rest of the admin does."""
    spec, row = _find_product(db, booking_ref)
    if spec is None:
        return None, None, []
    _product, _label, _book, pay_model, pay_fk, _trav, _trav_fk = spec
    rows = db.execute(
        select(pay_model).where(pay_fk == _booking_pk_value(row)).order_by(pay_model.created_at.desc())
    ).scalars().all()
    return spec[0], row, list(rows)


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
                "destination": destination(product, booking),
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
        "destination": destination(product, booking),
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


class StatusChangeRefused(Exception):
    """The requested change is not allowed; the message says what to do instead."""


#: Phase 13 (owner decision C3). Marking a booking completed needs evidence that
#: the service was delivered, and no approved completion-evidence workflow
#: exists yet — so the transition is refused, not guessed at.
COMPLETION_BLOCKED = (
    "Marking a booking completed is not available yet: it needs an approved "
    "completion-evidence workflow."
)


def _product_services(product: str):
    """(booking service, its error class, payment-verification module) for one product."""
    from app.services import (  # noqa: PLC0415 - avoid import cycles at module load
        customer_booking_service as flight_svc,
        customer_hotel_booking_service as hotel_svc,
        customer_package_booking_service as package_svc,
        payment_verification_flight_service as flight_verify,
        payment_verification_hotel_service as hotel_verify,
        payment_verification_service as package_verify,
    )
    return {
        "flight": (flight_svc, flight_svc.BookingError, flight_verify),
        "hotel": (hotel_svc, hotel_svc.HotelBookingError, hotel_verify),
        "package": (package_svc, package_svc.PackageBookingError, package_verify),
    }[product]


def admin_cancel(db: Session, product: str, booking, *, actor_name: str) -> None:
    """THE admin cancellation path (owner decision D5; also used by
    cancellation-request approval, X1).

    Runs the product's own ``cancel()`` — the same function the customer's
    Cancel button uses — so the existing side effects all happen: ``cancelled_at``
    is stamped, a package's seats go back on sale, and a captured payment is
    recorded as "refund owed" (flight: only when the supplier reservation is
    missing; package and hotel: any captured payment). NO refund is issued.
    Then the same in-app ``booking_cancelled`` notification the customer route
    sends (no email, SMS or push). Nothing is committed here.
    """
    from app.services import customer_account_service as acct  # noqa: PLC0415
    from app.services import customer_audit_service  # noqa: PLC0415

    svc, error_cls, _verify = _product_services(product)
    try:
        svc.cancel(db, booking)
    except error_cls as exc:
        raise StatusChangeRefused(str(exc)) from exc
    customer = db.get(Customer, booking.customer_id)
    customer_audit_service.log(
        db, customer, "Booking cancelled by support", module="Bookings",
        description=f"{booking.booking_ref} cancelled by {actor_name}"[:1000], commit=False,
    )
    acct.notify(
        db, booking.customer_id, "booking_cancelled",
        title="Booking cancelled",
        message=f"{booking.booking_ref} has been cancelled.",
        related_ref=booking.booking_ref,
    )


def _admin_confirm(db: Session, product: str, booking) -> None:
    """Confirm ONLY through the product's own ``confirm_booking`` (owner D3).

    That function is the single writer of CONFIRMED on the payment path: it
    requires a CAPTURED payment equal to the booking total, refuses cancelled or
    completed bookings, runs the flight supplier guard, and sends the existing
    confirmation notification once. No payment is created, captured or
    verified here — a booking with no captured gateway payment (including one
    paid offline, C2) cannot be confirmed from the admin screen.
    """
    from app.services import supplier_guard  # noqa: PLC0415

    svc, _error_cls, verify = _product_services(product)
    payment = svc.captured_payment(db, booking)
    if payment is None:
        raise StatusChangeRefused(
            "This booking has no captured payment, so it cannot be confirmed. Bookings are "
            "confirmed by payment verification; offline payments are not supported yet."
        )
    if product == "flight" and booking.supplier_status == supplier_guard.RESERVATION_MISSING:
        raise StatusChangeRefused(
            "This flight is paid but has no supplier reservation. Record the supplier "
            "reservation on the Reconciliation desk; that confirms it."
        )
    # LOCK ORDER payment -> booking, the order confirm_booking documents.
    db.refresh(payment, with_for_update=True)
    if not verify.confirm_booking(db, payment, booking):
        raise StatusChangeRefused(
            "The booking could not be confirmed: the captured payment does not match the "
            "booking total, or the supplier reservation is missing. Check the Reconciliation desk."
        )


def update_status(
    db: Session, booking_ref: str, new_status: str, *, actor_name: str = "Support",
) -> dict[str, Any] | None | str:
    """Apply an admin status change through the existing workflows (Phase 13).

    Returns the updated booking dict (with ``previous_status``), ``None`` if no
    such booking, or ``"invalid"`` for an unknown status. Raises
    :class:`StatusChangeRefused` for a transition that is not allowed. Never
    commits — the router commits the change and its audit rows together.

    TRANSITIONS (owner decisions D3-D5, C3):
      same -> same            no write
      pending   -> confirmed  only via the product's confirm_booking
      pending   -> cancelled  product cancel() + notification
      confirmed -> cancelled  product cancel() + notification
      * -> completed          refused (C3: no completion-evidence workflow)
      * -> pending            refused
      cancelled / completed   terminal — nothing reopens them
    """
    wanted = new_status.strip().lower()
    if wanted not in BOOKING_STATUSES:
        return "invalid"
    spec, booking = _find_product(db, booking_ref)
    if booking is None:
        return None
    product = spec[0]
    previous = booking.status

    if wanted == previous:
        detail = get_booking(db, booking_ref)
        detail["previous_status"] = previous
        detail["changed"] = False
        return detail
    if previous in (CustomerBookingStatus.CANCELLED.value, CustomerBookingStatus.COMPLETED.value):
        raise StatusChangeRefused(f"A {previous} booking cannot be changed.")
    if wanted == CustomerBookingStatus.COMPLETED.value:
        raise StatusChangeRefused(COMPLETION_BLOCKED)
    if wanted == CustomerBookingStatus.PENDING.value:
        raise StatusChangeRefused("A booking cannot be moved back to pending.")

    if wanted == CustomerBookingStatus.CANCELLED.value:
        # Lock the booking and re-read its status: a payment or a customer
        # cancellation may have landed since it was loaded.
        db.refresh(booking, with_for_update=True)
        admin_cancel(db, product, booking, actor_name=actor_name)
    elif wanted == CustomerBookingStatus.CONFIRMED.value:
        _admin_confirm(db, product, booking)

    db.flush()
    detail = get_booking(db, booking_ref)
    detail["previous_status"] = previous
    detail["changed"] = True
    return detail


def dashboard_counts(db: Session) -> dict[str, int]:
    """Total + per-product booking counts, for the B2C dashboard cards."""
    counts = {"total": 0, "flight": 0, "hotel": 0, "package": 0, "gaming": 0}
    for product, _label, book_model, *_rest in _PRODUCTS:
        n = db.scalar(select(func.count()).select_from(book_model)) or 0
        counts[product] = n
        counts["total"] += n
    return counts
