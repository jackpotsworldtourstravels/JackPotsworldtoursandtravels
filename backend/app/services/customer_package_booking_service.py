"""Creating, listing and cancelling a customer's tour-package bookings.

Same two disciplines as the flight and hotel booking services:

THE BOOKING REFERENCE IS REAL. ``booking_ref`` (``JPP000123``) is drawn from
its own Postgres sequence — flights are ``JPB``, hotels are ``JPH``, so a
reference alone says which table it lives in.

THE STATUS IS ``pending``. No payment gateway is integrated, so nothing has
actually been paid for — :func:`record_payment` is where a real gateway
result would promote it.

PASSPORT RULES MIRROR A FLIGHT'S EXACTLY (0053). Required, and valid six
months from the departure date, only when the package's destination is
international — a domestic trip (Kashmir, Goa) never asks for one.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    Customer,
    CustomerBookingStatus,
    CustomerPackageBooking,
    CustomerPackageBookingAddon,
    CustomerPackageBookingPayment,
    CustomerPackageBookingTraveller,
    CustomerPaymentStatus,
)
from app.services import customer_package_catalog_service as catalog
from app.services import customer_package_pricing_service as pricing
from app.services import customer_traveller_service as travellers
from app.services.customer_booking_service import PAYMENT_METHODS

REF_SEQ = "seq_customer_package_booking_ref"
_METHOD_IDS = {m["id"] for m in PAYMENT_METHODS}


class PackageBookingError(ValueError):
    """The trip cannot be booked or changed as asked."""


def next_booking_ref(db: Session) -> str:
    n = db.execute(text(f"SELECT nextval('{REF_SEQ}')")).scalar_one()
    return f"JPP{n:06d}"


def _validate_travellers(
    travellers_in: list[dict], *, is_international: bool, departure_date: dt.date | None,
) -> None:
    if not travellers_in:
        raise PackageBookingError("A booking needs at least one traveller.")

    adults = sum(1 for t in travellers_in if t.get("traveller_type", "adult") == "adult")
    if adults == 0:
        raise PackageBookingError("At least one adult must travel.")

    contacts = [t for t in travellers_in if t.get("is_contact")]
    if len(contacts) != 1:
        raise PackageBookingError("Exactly one traveller must carry the booking contact details.")

    for i, t in enumerate(travellers_in, start=1):
        if not (t.get("first_name") or "").strip():
            raise PackageBookingError(f"Traveller {i}: first name is required.")
        if not (t.get("last_name") or "").strip():
            raise PackageBookingError(f"Traveller {i}: last name is required.")

        if not is_international:
            continue

        if not (t.get("passport_number") or "").strip():
            raise PackageBookingError(
                f"Traveller {i}: passport number is required for this destination."
            )
        expiry = t.get("passport_expiry")
        if not expiry:
            raise PackageBookingError(
                f"Traveller {i}: passport expiry is required for this destination."
            )
        months = travellers.passport_months_remaining(expiry, departure_date)
        if months is not None and months < 6:
            raise PackageBookingError(
                f"Traveller {i}: passport must be valid for at least 6 months "
                "from the departure date."
            )


def _price_trip(db: Session, trip: dict, addons: list[dict], coupon_code: str | None) -> dict:
    package = catalog.get_package(db, trip["package_id"])
    if package is None:
        raise PackageBookingError("That package is not available.")
    departure = catalog.get_departure(db, trip["package_id"], trip["departure_id"])
    if departure is None:
        raise PackageBookingError("That departure date is not available.")

    pax_count = trip.get("pax_count") or 1
    if pax_count > departure.seats_left:
        raise PackageBookingError(
            f"Only {departure.seats_left} seats are left on this departure."
        )

    try:
        priced = pricing.quote(
            db, departure=departure, pax_count=pax_count,
            is_international=package.is_international,
            addon_selections=addons, coupon_code=coupon_code,
        )
    except pricing.PackagePricingError as exc:
        raise PackageBookingError(str(exc)) from exc

    priced["package"] = package
    priced["departure"] = departure
    priced["pax_count"] = pax_count
    return priced


def find_by_idempotency_key(
    db: Session, customer: Customer, key: str
) -> CustomerPackageBooking | None:
    """The booking this customer already made under this key, if any.

    Scoped to the customer as well as the key: the unique index is on the pair,
    and looking up by key alone would let one account's key surface another
    account's booking.
    """
    return db.execute(
        select(CustomerPackageBooking)
        .options(
            selectinload(CustomerPackageBooking.travellers),
            selectinload(CustomerPackageBooking.addons),
            selectinload(CustomerPackageBooking.payments),
        )
        .where(
            CustomerPackageBooking.customer_id == customer.customer_id,
            CustomerPackageBooking.idempotency_key == key,
        )
    ).scalar_one_or_none()


def create_booking(db: Session, customer: Customer, payload: dict) -> CustomerPackageBooking:
    """Price the request from scratch, then write it down.

    SUBMITTING TWICE MAKES ONE BOOKING. When the payload carries an
    ``idempotency_key`` the booking already made under it is returned as-is.
    The lookup is a fast path, not the guarantee — two simultaneous requests
    can both find nothing — so the unique index from migration 0061 is what
    actually decides, and the loser of that race re-reads the winner's row.
    """
    trip = payload["trip"]
    travellers_in = payload.get("travellers") or []
    key = (payload.get("idempotency_key") or "").strip() or None

    if key:
        existing = find_by_idempotency_key(db, customer, key)
        if existing is not None:
            return existing

    priced = _price_trip(db, trip, payload.get("addons") or [], payload.get("coupon_code"))
    if priced["coupon_error"]:
        raise PackageBookingError(priced["coupon_error"])
    package = priced["package"]
    departure = priced["departure"]

    _validate_travellers(
        travellers_in, is_international=package.is_international,
        departure_date=departure.departure_date,
    )

    booking = CustomerPackageBooking(
        booking_ref=next_booking_ref(db),
        customer_id=customer.customer_id,
        status=CustomerBookingStatus.PENDING.value,
        package_id=package.customer_package_id,
        package_name=package.name,
        package_days=package.days,
        is_international=package.is_international,
        departure_id=departure.customer_package_departure_id,
        departure_date=departure.departure_date,
        pax_count=priced["pax_count"],
        base_total=priced["base_total"],
        taxes=priced["taxes"],
        addon_total=priced["addon_total"],
        discount=priced["discount"],
        total_amount=priced["total_amount"],
        currency=priced["currency"],
        coupon_code=priced["coupon_code"],
        idempotency_key=key,
    )
    db.add(booking)
    try:
        db.flush()
    except IntegrityError:
        # Lost the race: another request carrying this same key inserted first.
        # Roll this attempt back and hand back the booking that won, so both
        # callers see one booking rather than one of them seeing an error.
        db.rollback()
        if key:
            existing = find_by_idempotency_key(db, customer, key)
            if existing is not None:
                return existing
        raise

    for i, t in enumerate(travellers_in):
        db.add(CustomerPackageBookingTraveller(
            package_booking_id=booking.customer_package_booking_id,
            traveller_index=i,
            traveller_type=t.get("traveller_type", "adult"),
            title=t.get("title"),
            first_name=(t.get("first_name") or "").strip(),
            last_name=(t.get("last_name") or "").strip(),
            gender=t.get("gender"),
            date_of_birth=t.get("date_of_birth"),
            nationality=t.get("nationality"),
            passport_number=(t.get("passport_number") or None),
            passport_expiry=t.get("passport_expiry"),
            issuing_country=t.get("issuing_country"),
            is_contact=bool(t.get("is_contact")),
            mobile=t.get("mobile"),
            email=t.get("email"),
        ))

    for row in priced["addon_rows"]:
        db.add(CustomerPackageBookingAddon(
            package_booking_id=booking.customer_package_booking_id,
            traveller_index=row["traveller_index"],
            addon_type=row["addon_type"], code=row["code"], name=row["name"],
            description=row.get("description"), unit_price=row["unit_price"],
            quantity=row["quantity"],
        ))

    departure.seats_left = departure.seats_left - priced["pax_count"]

    db.flush()
    return booking


def list_for_customer(db: Session, customer: Customer) -> list[CustomerPackageBooking]:
    return list(
        db.execute(
            select(CustomerPackageBooking)
            .options(
                selectinload(CustomerPackageBooking.travellers),
                selectinload(CustomerPackageBooking.addons),
                selectinload(CustomerPackageBooking.payments),
            )
            .where(CustomerPackageBooking.customer_id == customer.customer_id)
            .order_by(CustomerPackageBooking.created_at.desc())
        ).scalars()
    )


def get_owned(db: Session, customer: Customer, booking_ref: str) -> CustomerPackageBooking | None:
    """One booking by reference, scoped to its owner — same rule as flights
    and hotels: booking references are sequential and therefore guessable,
    so ownership is a filter applied server-side."""
    return db.execute(
        select(CustomerPackageBooking)
        .options(
            selectinload(CustomerPackageBooking.travellers),
            selectinload(CustomerPackageBooking.addons),
            selectinload(CustomerPackageBooking.payments),
        )
        .where(
            CustomerPackageBooking.booking_ref == booking_ref,
            CustomerPackageBooking.customer_id == customer.customer_id,
        )
    ).scalar_one_or_none()


def cancel(db: Session, booking: CustomerPackageBooking) -> CustomerPackageBooking:
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise PackageBookingError("This booking is already cancelled.")
    if booking.status == CustomerBookingStatus.COMPLETED.value:
        raise PackageBookingError("A completed booking cannot be cancelled.")
    booking.status = CustomerBookingStatus.CANCELLED.value
    booking.cancelled_at = dt.datetime.now(dt.timezone.utc)
    # The seats this booking held go back on sale — same reasoning a
    # cancelled hotel room would free its inventory, if hotels tracked it.
    departure = catalog.get_departure(db, booking.package_id, booking.departure_id)
    if departure is not None:
        departure.seats_left = departure.seats_left + booking.pax_count
    db.flush()
    return booking


def record_payment(
    db: Session, booking: CustomerPackageBooking, method: str
) -> CustomerPackageBookingPayment:
    """Record a payment attempt. Does not take money — mirrors
    ``customer_booking_service.record_payment`` exactly."""
    if method not in _METHOD_IDS:
        raise PackageBookingError(f"'{method}' is not a supported payment method.")
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise PackageBookingError("This booking has been cancelled.")

    payment = CustomerPackageBookingPayment(
        package_booking_id=booking.customer_package_booking_id,
        method=method,
        status=CustomerPaymentStatus.PENDING.value,
        amount=booking.total_amount,
        currency=booking.currency,
        provider=None,
        provider_reference=None,
    )
    db.add(payment)
    db.flush()
    return payment
