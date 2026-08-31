"""Creating, listing and cancelling a customer's flight bookings.

THE BOOKING REFERENCE IS REAL. THE PNR IS NOT INVENTED.

``booking_ref`` (``JPB000123``) is this platform's own identifier, drawn from a
Postgres sequence and unique by index — a genuine backend response the customer
can quote to support, and the id My Bookings addresses a booking by.

``pnr`` stays NULL. A PNR is issued by an airline through a GDS, and there is
no airline integration behind this portal. Generating a six-character string
and calling it a PNR would be worse than leaving it empty: a traveller would
quote it at a check-in desk and be told it does not exist. So the column is
nullable, the API returns ``null``, and the confirmation screen says the PNR is
pending rather than showing a fiction. When ticketing is integrated, it writes
the real one here and nothing else changes.

FOR THE SAME REASON THE STATUS IS ``pending``, NOT ``confirmed``. Nothing has
been ticketed and no money has moved. :func:`record_payment` is where a real
gateway result would promote it.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerBookingAddon,
    CustomerBookingPassenger,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerPaymentStatus,
)
from app.services import customer_pricing_service as pricing
from app.services import customer_traveller_service as travellers

REF_SEQ = "seq_customer_booking_ref"

#: Methods the portal will offer. There is no gateway wired up yet, so this is
#: the list of what a future integration must support, not a list of things
#: that can currently take money — see :func:`record_payment`.
PAYMENT_METHODS = [
    {"id": "upi", "name": "UPI", "note": "GPay, PhonePe, Paytm, BHIM"},
    {"id": "card", "name": "Credit card", "note": "Visa, Mastercard, Amex, RuPay"},
    {"id": "debit", "name": "Debit card", "note": "All major Indian banks"},
    {"id": "netbank", "name": "Net banking", "note": "50+ banks supported"},
    {"id": "wallet", "name": "Wallet", "note": "Paytm, Amazon Pay, Mobikwik"},
]
_METHOD_IDS = {m["id"] for m in PAYMENT_METHODS}


class BookingError(ValueError):
    """The booking cannot be created or changed as asked."""


def next_booking_ref(db: Session) -> str:
    n = db.execute(text(f"SELECT nextval('{REF_SEQ}')")).scalar_one()
    return f"JPB{n:06d}"


def _validate_passengers(passengers: list[dict], *, is_international: bool,
                         travel_date: dt.date | None) -> None:
    """The rules that must hold whatever the browser let through.

    Passport is required only where it is genuinely required — international
    travel — and the six-month rule is measured from the travel date, not from
    today, which is the rule airlines and border control actually apply.
    """
    if not passengers:
        raise BookingError("A booking needs at least one traveller.")

    adults = sum(1 for p in passengers if p.get("traveller_type", "adult") == "adult")
    infants = sum(1 for p in passengers if p.get("traveller_type") == "infant")
    if adults == 0:
        raise BookingError("At least one adult must travel.")
    # One lap, one infant. This is an airline rule, not an invented one.
    if infants > adults:
        raise BookingError("Each infant must travel with an adult.")

    contacts = [p for p in passengers if p.get("is_contact")]
    if len(contacts) != 1:
        raise BookingError("Exactly one traveller must carry the booking contact details.")

    for i, p in enumerate(passengers, start=1):
        if not (p.get("first_name") or "").strip():
            raise BookingError(f"Traveller {i}: first name is required.")
        if not (p.get("last_name") or "").strip():
            raise BookingError(f"Traveller {i}: last name is required.")

        if not is_international:
            continue

        if not (p.get("passport_number") or "").strip():
            raise BookingError(
                f"Traveller {i}: passport number is required for international travel."
            )
        expiry = p.get("passport_expiry")
        if not expiry:
            raise BookingError(
                f"Traveller {i}: passport expiry is required for international travel."
            )
        months = travellers.passport_months_remaining(expiry, travel_date)
        if months is not None and months < 6:
            raise BookingError(
                f"Traveller {i}: passport must be valid for at least 6 months "
                "from the travel date."
            )


def find_by_idempotency_key(
    db: Session, customer: Customer, key: str
) -> CustomerBooking | None:
    """The booking this customer already made under this key, if any.

    Scoped to the customer as well as the key: the unique index is on the pair,
    and looking up by key alone would let one account's key surface another
    account's booking.
    """
    return db.execute(
        select(CustomerBooking)
        .options(
            selectinload(CustomerBooking.passengers),
            selectinload(CustomerBooking.addons),
            selectinload(CustomerBooking.payments),
        )
        .where(
            CustomerBooking.customer_id == customer.customer_id,
            CustomerBooking.idempotency_key == key,
        )
    ).scalar_one_or_none()


def create_booking(db: Session, customer: Customer, payload: dict) -> CustomerBooking:
    """Price the request from scratch, then write it down.

    Nothing the client sends about money is read. The itinerary, the party, the
    seats, the add-ons and the coupon are inputs; every rupee is recomputed here
    through :mod:`customer_pricing_service`.

    SUBMITTING TWICE MAKES ONE BOOKING. When the payload carries an
    ``idempotency_key`` the booking already made under it is returned as-is.
    The lookup is a fast path, not the guarantee — two simultaneous requests
    can both find nothing — so the unique index from migration 0061 is what
    actually decides, and the loser of that race re-reads the winner's row.
    """
    flight = payload["flight"]
    passengers = payload.get("passengers") or []
    travel_date = flight.get("travel_date")
    is_international = bool(flight.get("is_international"))
    key = (payload.get("idempotency_key") or "").strip() or None

    if key:
        existing = find_by_idempotency_key(db, customer, key)
        if existing is not None:
            return existing

    _validate_passengers(
        passengers, is_international=is_international, travel_date=travel_date
    )

    passenger_types = [p.get("traveller_type", "adult") for p in passengers]

    try:
        priced = pricing.quote(
            db,
            flight_key=flight["flight_key"],
            flight_number=flight["flight_number"],
            duration_minutes=flight.get("duration_minutes"),
            cabin=flight.get("cabin_class"),
            passenger_types=passenger_types,
            seat_selections=payload.get("seats") or [],
            addon_selections=payload.get("addons") or [],
            coupon_code=payload.get("coupon_code"),
            is_international=is_international,
        )
    except pricing.PricingError as exc:
        raise BookingError(str(exc)) from exc

    # A coupon that failed to apply is an error at booking time even though it
    # is only a warning on a quote — the customer is about to be charged, and
    # charging more than the screen last showed is not acceptable.
    if priced["coupon_error"]:
        raise BookingError(priced["coupon_error"])

    booking = CustomerBooking(
        booking_ref=next_booking_ref(db),
        pnr=None,  # see module docstring
        customer_id=customer.customer_id,
        product_type="flight",
        status=CustomerBookingStatus.PENDING.value,
        airline=flight.get("airline"),
        flight_number=flight.get("flight_number"),
        origin_code=flight.get("origin_code"),
        origin_city=flight.get("origin_city"),
        destination_code=flight.get("destination_code"),
        destination_city=flight.get("destination_city"),
        travel_date=travel_date,
        departure_time=flight.get("departure_time"),
        arrival_time=flight.get("arrival_time"),
        duration_label=flight.get("duration_label"),
        stops=flight.get("stops") or 0,
        cabin_class=flight.get("cabin_class"),
        is_international=is_international,
        base_fare=priced["base_fare"],
        taxes=priced["taxes"],
        seat_charges=priced["seat_charges"],
        baggage_total=priced["baggage_total"],
        meal_total=priced["meal_total"],
        service_total=priced["service_total"],
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

    seat_by_index = {s["passenger_index"]: s for s in priced["priced_seats"]}
    for i, p in enumerate(passengers):
        seat = seat_by_index.get(i)
        db.add(CustomerBookingPassenger(
            customer_booking_id=booking.customer_booking_id,
            passenger_index=i,
            traveller_type=p.get("traveller_type", "adult"),
            title=p.get("title"),
            first_name=(p.get("first_name") or "").strip(),
            last_name=(p.get("last_name") or "").strip(),
            gender=p.get("gender"),
            date_of_birth=p.get("date_of_birth"),
            nationality=p.get("nationality"),
            passport_number=(p.get("passport_number") or None),
            passport_expiry=p.get("passport_expiry"),
            issuing_country=p.get("issuing_country"),
            frequent_flyer_airline=p.get("frequent_flyer_airline"),
            frequent_flyer_number=p.get("frequent_flyer_number"),
            seat_number=seat["seat_number"] if seat else None,
            seat_price=seat["price"] if seat else Decimal("0"),
            is_contact=bool(p.get("is_contact")),
            mobile=p.get("mobile"),
            email=p.get("email"),
        ))

    for row in priced["addon_rows"]:
        db.add(CustomerBookingAddon(
            customer_booking_id=booking.customer_booking_id,
            passenger_index=row["passenger_index"],
            addon_type=row["addon_type"],
            code=row["code"],
            name=row["name"],
            description=row.get("description"),
            unit_price=row["unit_price"],
            quantity=row["quantity"],
        ))

    if payload.get("save_travellers"):
        travellers.save_many(db, customer, passengers)

    db.flush()
    return booking


def list_for_customer(db: Session, customer: Customer) -> list[CustomerBooking]:
    return list(
        db.execute(
            select(CustomerBooking)
            .options(
                selectinload(CustomerBooking.passengers),
                selectinload(CustomerBooking.addons),
                selectinload(CustomerBooking.payments),
            )
            .where(CustomerBooking.customer_id == customer.customer_id)
            .order_by(CustomerBooking.created_at.desc())
        ).scalars()
    )


def get_owned(db: Session, customer: Customer, booking_ref: str) -> CustomerBooking | None:
    """One booking by reference, scoped to its owner.

    Scoped rather than looked up globally: booking references are sequential
    and therefore guessable, so ownership is a filter, not an afterthought.
    """
    return db.execute(
        select(CustomerBooking)
        .options(
            selectinload(CustomerBooking.passengers),
            selectinload(CustomerBooking.addons),
            selectinload(CustomerBooking.payments),
        )
        .where(
            CustomerBooking.booking_ref == booking_ref,
            CustomerBooking.customer_id == customer.customer_id,
        )
    ).scalar_one_or_none()


def cancel(db: Session, booking: CustomerBooking) -> CustomerBooking:
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise BookingError("This booking is already cancelled.")
    if booking.status == CustomerBookingStatus.COMPLETED.value:
        raise BookingError("A completed booking cannot be cancelled.")
    booking.status = CustomerBookingStatus.CANCELLED.value
    booking.cancelled_at = dt.datetime.now(dt.timezone.utc)
    db.flush()
    return booking


def record_payment(
    db: Session, booking: CustomerBooking, method: str
) -> CustomerBookingPayment:
    """Record a payment attempt against the booking.

    THIS DOES NOT TAKE MONEY, AND MUST NOT PRETEND TO. No gateway is
    integrated, so the attempt is written as ``pending`` and the booking stays
    ``pending`` with it. Returning ``captured`` here would tell the customer
    they had paid when nothing had been charged, and would mark a ticket
    payable that no one has paid for.

    A real integration replaces the body below: create the provider's order,
    hand the client back whatever it needs to complete the payment, and let the
    provider's webhook — not this call — move the row to ``captured`` and the
    booking to ``confirmed``.
    """
    if method not in _METHOD_IDS:
        raise BookingError(f"'{method}' is not a supported payment method.")
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise BookingError("This booking has been cancelled.")

    payment = CustomerBookingPayment(
        customer_booking_id=booking.customer_booking_id,
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
