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
from app.services import payments as payment_providers
from app.services import customer_payment_window as payment_window

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

# ---------------------------------------------------------------------------
# Taking a real payment. Opening a checkout only -- nothing here moves
# money-state, and nothing here trusts a browser.
#
# This mirrors customer_package_booking_service function for function. Packages
# were wired first and are the reference implementation; anything that differs
# here is a bug in one of the two, not a deliberate variation.
# ---------------------------------------------------------------------------
def payable_amount(booking: CustomerBooking) -> Decimal:
    """What this booking costs, read from the row the server priced.

    THE WHOLE POINT OF THIS FUNCTION IS THAT IT TAKES NO ARGUMENT FROM A
    REQUEST. ``create_booking`` recomputed every rupee through
    ``customer_pricing_service`` and wrote the total down; this reads that total
    back. A client that sends ``{"amount": 1}`` alongside its booking reference
    changes nothing, because no code path reads an amount out of a payment
    request -- there is no field for one to arrive in.
    """
    return Decimal(str(booking.total_amount or 0))


def refunded_payment(db: Session, booking):
    """A refunded payment against this booking, if there is one.

    Used to refuse a SECOND checkout on a booking whose money has already been
    taken and given back. Without this the traveller is offered a Pay button on
    a booking that is, commercially, finished -- and paying it would collect
    money against a reference nobody is going to honour.
    """
    return db.execute(
        select(CustomerBookingPayment).where(
            CustomerBookingPayment.customer_booking_id == booking.customer_booking_id,
            CustomerBookingPayment.status == CustomerPaymentStatus.REFUNDED.value,
        )
    ).scalars().first()


def captured_payment(
    db: Session, booking: CustomerBooking
) -> CustomerBookingPayment | None:
    """The verified payment for this booking, if it has been paid.

    Used to refuse a second checkout on a booking that is already paid for --
    the failure mode a customer reaches by pressing Back from the confirmation
    screen and paying again.
    """
    return db.execute(
        select(CustomerBookingPayment).where(
            CustomerBookingPayment.customer_booking_id == booking.customer_booking_id,
            CustomerBookingPayment.status == CustomerPaymentStatus.CAPTURED.value,
        )
    ).scalars().first()


def reconcilable_payment(
    db: Session, booking: CustomerBooking
) -> CustomerBookingPayment | None:
    """The attempt worth asking the provider about, if there is one.

    The most recent one that actually reached the provider. An attempt with no
    ``provider_order_id`` was never opened there and there is nothing to ask
    about, so it is skipped rather than reported as unpayable. A captured row is
    returned rather than filtered out: the verifier answers ``already_captured``
    for it in one cheap read, which is the honest answer to "did this get paid?".
    """
    return db.execute(
        select(CustomerBookingPayment)
        .where(
            CustomerBookingPayment.customer_booking_id == booking.customer_booking_id,
            CustomerBookingPayment.provider_order_id.isnot(None),
        )
        .order_by(CustomerBookingPayment.created_at.desc())
    ).scalars().first()


def find_payment_by_idempotency_key(
    db: Session, booking: CustomerBooking, key: str
) -> CustomerBookingPayment | None:
    """The attempt this booking already has under this key, if any.

    Scoped to the booking as well as the key, matching the unique index from
    migration 0062.
    """
    return db.execute(
        select(CustomerBookingPayment).where(
            CustomerBookingPayment.customer_booking_id == booking.customer_booking_id,
            CustomerBookingPayment.idempotency_key == key,
        )
    ).scalar_one_or_none()


def _checkout_options(booking: CustomerBooking, customer: Customer) -> dict:
    """Non-secret display detail for the provider's checkout widget.

    Prefill is a convenience the customer can overwrite and is never used for
    verification. No passport and no document detail -- a checkout widget has no
    use for any of it, and this is the boundary where that is decided.
    """
    flight = " ".join(p for p in (booking.airline, booking.flight_number) if p)
    route = " - ".join(
        p for p in (booking.origin_city, booking.destination_city) if p
    )
    label = flight or route or "Flight"
    return {
        "name": "JackPots World Tours & Travels",
        "description": f"{label} - {booking.booking_ref}",
        "prefill": {
            "name": customer.full_name,
            "email": customer.email,
            "contact": customer.mobile,
        },
    }


def _session_for(payment, booking, customer, provider):
    """Rebuild the checkout session for an attempt that already has an order.

    Rebuilt rather than stored: the amount comes back off the payment row, so a
    session handed to a returning customer cannot drift from what was recorded.
    """
    return payment_providers.CheckoutSession(
        order_id=payment.provider_order_id,
        amount_minor=payment_providers.to_minor(
            Decimal(str(payment.amount)), payment.currency
        ),
        currency=payment.currency,
        publishable_key=provider.publishable_key,
        provider=provider.name,
        redirect_url=None,
        options=_checkout_options(booking, customer),
    )


def start_checkout(
    db: Session,
    customer: Customer,
    booking: CustomerBooking,
    *,
    idempotency_key: str,
):
    """Open a provider checkout for this booking. Takes no money.

    Returns ``(payment_row, CheckoutSession)``.

    WHAT THIS RETURNS IS AN INVITATION TO PAY, NOT A PAYMENT.
    The payment row is written ``pending`` and the booking is not touched at
    all. Only the verified provider path may promote either, which is why the
    words ``CAPTURED`` and ``CONFIRMED`` appear nowhere in this function.

    PRESSING PAY NOW TWICE OPENS ONE ORDER. Three mechanisms, in order:

    1. the attempt already recorded under this key is returned as-is, so a
       double-click or a reload re-uses the order it already opened;
    2. the unique index on ``(customer_booking_id, idempotency_key)`` decides
       the race the lookup above cannot -- two simultaneous requests can both
       find nothing -- and the loser re-reads the winner's row;
    3. when a row already claimed this key but carries no order id -- a previous
       attempt that failed between claiming and recording -- ``may_exist`` makes
       the adapter LOOK THE ORDER UP BEFORE CREATING ONE.

    Any one would usually do. All three are here because what is being guarded
    against is a customer paying twice.
    """
    if booking.customer_id != customer.customer_id:
        # Belt and braces: the router already resolved this booking through
        # get_owned(). Repeated because this function WRITES a payment, and a
        # payment written against someone else's booking is the worst outcome
        # available in this module.
        raise BookingError("This booking belongs to another customer.")
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise BookingError("This booking has been cancelled and cannot be paid for.")
    if booking.status == CustomerBookingStatus.COMPLETED.value:
        raise BookingError("This booking is already completed.")

    already = captured_payment(db, booking)
    if already is not None:
        raise BookingError(
            f"{booking.booking_ref} has already been paid for. "
            "No further payment is needed."
        )

    refunded = refunded_payment(db, booking)
    if refunded is not None:
        raise BookingError(payment_window.refunded_message(booking.booking_ref))
    if payment_window.window_closed(booking.created_at):
        raise BookingError(payment_window.expired_message(booking.booking_ref))

    key = (idempotency_key or "").strip()
    if len(key) < 8:
        raise BookingError(
            "A payment needs an idempotency key of at least 8 characters."
        )

    # WHICH ADAPTER COLLECTS FOR THIS BOOKING. Almost always the configured
    # provider; a booking named in TRUSTBRICK_PILOT_BOOKING_REFS goes through
    # TrustBrick instead. An empty pilot list makes this exactly get_provider().
    provider = payment_providers.get_provider_for_booking(booking.booking_ref)

    # (1) The attempt this key already produced.
    existing = find_payment_by_idempotency_key(db, booking, key)
    if existing is not None and existing.provider_order_id:
        # Rebuilt with the adapter that ACTUALLY opened it, not with whatever is
        # configured now: a pilot list edited between two attempts would
        # otherwise hand the customer a session carrying the wrong provider's
        # publishable key, and a checkout that cannot open.
        opener = provider
        if existing.provider and existing.provider != provider.name:
            try:
                opener = payment_providers.get_provider_named(existing.provider)
            except payment_providers.PaymentProviderError:
                raise BookingError(
                    f"{booking.booking_ref} has an open payment with "
                    f"{existing.provider}, which is not available on this "
                    "deployment. Contact support rather than paying twice."
                )
        return existing, _session_for(existing, booking, customer, opener)

    amount = payable_amount(booking)
    if amount <= 0:
        raise BookingError(
            f"{booking.booking_ref} has no amount to pay. "
            "Contact support rather than paying zero."
        )
    currency = (booking.currency or payment_providers.INR).upper()
    amount_minor = payment_providers.to_minor(amount, currency)

    payment = existing
    if payment is None:
        payment = CustomerBookingPayment(
            customer_booking_id=booking.customer_booking_id,
            # The provider decides between UPI Intent and UPI QR from the
            # device, and offers cards/netbanking if the account has them. What
            # the customer ACTUALLY used is written back by the webhook from the
            # provider's own answer -- guessing it here would put a method on
            # the row that nobody chose.
            method="gateway",
            status=CustomerPaymentStatus.PENDING.value,
            amount=amount,
            currency=currency,
            provider=provider.name,
            idempotency_key=key,
        )
        db.add(payment)
        try:
            # (2) Claim the key before calling out, so a race is decided by the
            # index rather than by two requests both opening an order.
            db.flush()
        except IntegrityError:
            db.rollback()
            won = find_payment_by_idempotency_key(db, booking, key)
            if won is not None and won.provider_order_id:
                return won, _session_for(won, booking, customer, provider)
            raise

    # (3) The provider call. ``may_exist`` is true only when a row already
    # claimed this key and has no provider_order_id -- which is exactly "an
    # earlier attempt may have opened an order and failed before telling us".
    # In that state the adapter must look before it creates.
    session = provider.create_checkout(
        amount_minor=amount_minor,
        currency=currency,
        reference=booking.booking_ref,
        idempotency_key=key,
        may_exist=existing is not None,
        customer={
            "name": customer.full_name,
            "email": customer.email,
            "contact": customer.mobile,
        },
        notes={
            "booking_ref": booking.booking_ref,
            "product_type": "flight",
            "customer_id": customer.customer_id,
        },
    )

    # WHAT THE PROVIDER OPENED MUST BE WHAT WE ASKED FOR. Checked here as well
    # as at capture, so a mismatch is caught before the customer is shown a
    # figure rather than after they have paid it.
    if session.amount_minor != amount_minor or (session.currency or "").upper() != currency:
        raise BookingError(
            "The payment provider opened an order for a different amount than "
            f"{booking.booking_ref} is for. Nothing has been charged."
        )

    payment.provider = session.provider
    payment.provider_order_id = session.order_id
    payment.provider_status = "created"
    db.flush()

    return payment, payment_providers.CheckoutSession(
        order_id=session.order_id,
        amount_minor=session.amount_minor,
        currency=session.currency,
        publishable_key=session.publishable_key,
        provider=session.provider,
        redirect_url=session.redirect_url,
        options={**dict(session.options), **_checkout_options(booking, customer)},
    )
