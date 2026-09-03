"""Creating, listing and cancelling a customer's tour-package bookings.

Same two disciplines as the flight and hotel booking services:

THE BOOKING REFERENCE IS REAL. ``booking_ref`` (``JPP000123``) is drawn from
its own Postgres sequence — flights are ``JPB``, hotels are ``JPH``, so a
reference alone says which table it lives in.

THE STATUS IS ``pending`` UNTIL A PAYMENT IS VERIFIED. Creating a booking
takes no money and neither does opening a checkout: :func:`start_checkout`
asks the provider to collect a figure computed here, and the booking and its
payment both stay ``pending``. Only the verified webhook path may move them,
which is why nothing in this module sets ``captured`` or ``confirmed``.

:func:`record_payment` remains for deployments with no provider configured —
it writes down which method the traveller intends to use and charges nothing.

PASSPORT RULES MIRROR A FLIGHT'S EXACTLY (0053). Required, and valid six
months from the departure date, only when the package's destination is
international — a domestic trip (Kashmir, Goa) never asks for one.
"""
from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal

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
from app.services import customer_audit_service
from app.services import customer_package_catalog_service as catalog
from app.services import customer_package_pricing_service as pricing
from app.services import customer_traveller_service as travellers
from app.services import payments as payment_providers
from app.services.customer_booking_service import PAYMENT_METHODS

logger = logging.getLogger(__name__)

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
    # Read BEFORE the status changes: captured_payment() does not depend on
    # the booking's status today, but a cancellation that silently abandons
    # money is exactly the thing this is here to notice, and it must not stop
    # noticing because some later edit made that lookup status-aware.
    paid = captured_payment(db, booking)

    booking.status = CustomerBookingStatus.CANCELLED.value
    booking.cancelled_at = dt.datetime.now(dt.timezone.utc)
    # The seats this booking held go back on sale — same reasoning a
    # cancelled hotel room would free its inventory, if hotels tracked it.
    departure = catalog.get_departure(db, booking.package_id, booking.departure_id)
    if departure is not None:
        departure.seats_left = departure.seats_left + booking.pax_count
    if paid is not None:
        _flag_refund_owed(db, booking, paid)
    db.flush()
    return booking


def _flag_refund_owed(
    db: Session,
    booking: CustomerPackageBooking,
    payment: CustomerPackageBookingPayment,
) -> None:
    """Record that a cancelled booking is holding a customer's money.

    THIS ISSUES NO REFUND AND DECIDES NO AMOUNT. Nothing in this codebase calls
    ``PaymentProvider.refund()``; whether a cancellation is refunded in full, in
    part, or net of a fee is a commercial decision that lives in the package's
    cancellation policy, not here. What this does is make the case impossible to
    miss, because the alternative — the state this replaced — was a paid booking
    quietly becoming a cancelled one with no trace that money was still held.

    The shape is deliberately the same as the reverse race in
    ``payment_verification_service.confirm_booking``: a capture landing on an
    already-cancelled booking logs ERROR and audits "needs review" rather than
    guessing. These are the two orderings of one situation and an operator
    should find them the same way.

    ``commit=False`` because this belongs to the cancellation's transaction. A
    refund flag that committed while the cancellation was later rolled back
    would send staff after money that was never abandoned.
    """
    from app.models_customer import CustomerAuditStatus

    logger.error(
        "REFUND OWED: %s was cancelled holding a captured payment "
        "(payment_id=%s provider_payment_id=%s amount=%s %s). "
        "No refund is issued automatically — needs manual review.",
        booking.booking_ref,
        payment.customer_package_booking_payment_id,
        payment.provider_payment_id,
        payment.amount,
        payment.currency,
    )
    customer = db.get(Customer, booking.customer_id)
    customer_audit_service.log(
        db, customer, "Cancelled with a captured payment — refund owed",
        module="Payments",
        description=(
            f"{booking.booking_ref} was cancelled while payment "
            f"{payment.provider_payment_id or payment.customer_package_booking_payment_id} "
            f"was captured for {payment.amount} {payment.currency}. "
            f"No refund has been issued."
        )[:1000],
        status=CustomerAuditStatus.FAILED,
        commit=False,
    )


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


# ---------------------------------------------------------------------------
# Taking a real payment (Phase 3). Opening a checkout only — nothing here
# moves money-state, and nothing here trusts a browser.
# ---------------------------------------------------------------------------
def payable_amount(booking: CustomerPackageBooking) -> Decimal:
    """What this booking costs, read from the row the server priced.

    THE WHOLE POINT OF THIS FUNCTION IS THAT IT TAKES NO ARGUMENT FROM A
    REQUEST. ``create_booking`` recomputed every rupee through
    ``customer_package_pricing_service`` and wrote the total down; this reads
    that total back. A client that sends ``{"amount": 1}`` alongside its
    booking reference changes nothing, because no code path reads an amount out
    of a payment request — there is no field for one to arrive in.
    """
    return Decimal(str(booking.total_amount or 0))


def captured_payment(
    db: Session, booking: CustomerPackageBooking
) -> CustomerPackageBookingPayment | None:
    """The verified payment for this booking, if it has been paid.

    Used to refuse a second checkout on a booking that is already paid for —
    the failure mode a customer reaches by pressing Back from the confirmation
    screen and paying again.
    """
    return db.execute(
        select(CustomerPackageBookingPayment).where(
            CustomerPackageBookingPayment.package_booking_id
            == booking.customer_package_booking_id,
            CustomerPackageBookingPayment.status == CustomerPaymentStatus.CAPTURED.value,
        )
    ).scalars().first()


def reconcilable_payment(
    db: Session, booking: CustomerPackageBooking
) -> CustomerPackageBookingPayment | None:
    """The attempt worth asking the provider about, if there is one.

    WHY THE MOST RECENT ONE WITH A PROVIDER REFERENCE
    A booking can hold several attempts: a customer who abandoned a checkout and
    opened another has two, and only the later one names the order they actually
    paid. An attempt with no ``provider_order_id`` was never opened at the
    provider and there is nothing to ask about, so it is skipped rather than
    reported as unpayable.

    A CAPTURED ROW IS RETURNED, NOT FILTERED OUT. ``verify_and_capture`` answers
    ``already_captured`` for it in one cheap read under the row lock, which is
    the honest answer to "did this get paid?" and costs no provider call. Hiding
    it here would turn a paid booking into "nothing to reconcile", which reads
    like a failure.
    """
    return db.execute(
        select(CustomerPackageBookingPayment)
        .where(
            CustomerPackageBookingPayment.package_booking_id
            == booking.customer_package_booking_id,
            CustomerPackageBookingPayment.provider_order_id.isnot(None),
        )
        .order_by(CustomerPackageBookingPayment.created_at.desc())
    ).scalars().first()


def find_payment_by_idempotency_key(
    db: Session, booking: CustomerPackageBooking, key: str
) -> CustomerPackageBookingPayment | None:
    """The attempt this booking already has under this key, if any.

    Scoped to the booking as well as the key, matching the unique index from
    migration 0062. The same shape as ``find_by_idempotency_key`` above, which
    protects the BOOKING; this protects the ATTEMPT.
    """
    return db.execute(
        select(CustomerPackageBookingPayment).where(
            CustomerPackageBookingPayment.package_booking_id
            == booking.customer_package_booking_id,
            CustomerPackageBookingPayment.idempotency_key == key,
        )
    ).scalar_one_or_none()


def start_checkout(
    db: Session,
    customer: Customer,
    booking: CustomerPackageBooking,
    *,
    idempotency_key: str,
):
    """Open a provider checkout for this booking. Takes no money.

    Returns ``(payment_row, CheckoutSession)``.

    WHAT THIS RETURNS IS AN INVITATION TO PAY, NOT A PAYMENT.
    The payment row is written ``pending`` and the booking is not touched at
    all. Only the verified webhook path may promote either, which is why the
    words ``CAPTURED`` and ``CONFIRMED`` appear nowhere in this function.

    PRESSING PAY NOW TWICE OPENS ONE ORDER.
    Three mechanisms, in the order they are reached:

    1. the attempt already recorded under this key is returned as-is, so a
       double-click or a reload re-uses the order it already opened;
    2. the unique index on ``(package_booking_id, idempotency_key)`` decides
       the race the lookup above cannot — two simultaneous requests can both
       find nothing — and the loser re-reads the winner's row;
    3. when a row already claimed this key but carries no order id — a previous
       attempt that failed between claiming and recording — ``may_exist`` makes
       the adapter LOOK THE ORDER UP BEFORE CREATING ONE.

    (3) is the one that matters and the one that used to be missing. It was
    written as "Razorpay rejects a repeated receipt and the adapter fetches the
    original", and neither half is true: receipt uniqueness is an opt-in account
    setting that is off by default, and the receipt filter does not filter. Both
    verified against a live test account on 2026-09-02. Until this was fixed, a
    checkout whose provider call timed out opened a SECOND order on retry, with
    nothing to notice it.

    Any one would usually do. All three are here because what is being guarded
    against is a customer paying twice.
    """
    if booking.customer_id != customer.customer_id:
        # Belt and braces: the router already resolved this booking through
        # get_owned(). Repeated because this function WRITES a payment, and a
        # payment written against someone else's booking is the worst outcome
        # available in this module.
        raise PackageBookingError("This booking belongs to another customer.")
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise PackageBookingError("This booking has been cancelled and cannot be paid for.")
    if booking.status == CustomerBookingStatus.COMPLETED.value:
        raise PackageBookingError("This booking is already completed.")

    already = captured_payment(db, booking)
    if already is not None:
        raise PackageBookingError(
            f"{booking.booking_ref} has already been paid for. No further payment is needed."
        )

    key = (idempotency_key or "").strip()
    if len(key) < 8:
        raise PackageBookingError(
            "A payment needs an idempotency key of at least 8 characters."
        )

    provider = payment_providers.get_provider()

    # (1) The attempt this key already produced.
    existing = find_payment_by_idempotency_key(db, booking, key)
    if existing is not None and existing.provider_order_id:
        return existing, _session_for(existing, booking, customer, provider)

    amount = payable_amount(booking)
    if amount <= 0:
        raise PackageBookingError(
            f"{booking.booking_ref} has no amount to pay. "
            "Contact support rather than paying zero."
        )
    currency = (booking.currency or payment_providers.INR).upper()
    amount_minor = payment_providers.to_minor(amount, currency)

    payment = existing
    if payment is None:
        payment = CustomerPackageBookingPayment(
            package_booking_id=booking.customer_package_booking_id,
            # The provider decides between UPI Intent and UPI QR from the
            # device, and offers cards/netbanking if the account has them. What
            # the customer ACTUALLY used is written back by the webhook from the
            # provider's own answer — guessing it here would put a method on the
            # row that nobody chose.
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

    # (3) The provider call.
    #
    # may_exist IS THE WHOLE FIX. `payment` is non-None here only when a row
    # already claimed this key and has no provider_order_id — which is exactly
    # "an earlier attempt may have opened an order and failed before telling
    # us". In that state the adapter must look before it creates. On a first
    # attempt this is False and the call is unchanged.
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
            "package": booking.package_name,
            "customer_id": customer.customer_id,
        },
    )

    # WHAT THE PROVIDER OPENED MUST BE WHAT WE ASKED FOR.
    # Checked here as well as at capture, so a mismatch is caught before the
    # customer is shown a figure rather than after they have paid it.
    if session.amount_minor != amount_minor or (session.currency or "").upper() != currency:
        raise PackageBookingError(
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


def _checkout_options(booking: CustomerPackageBooking, customer: Customer) -> dict:
    """Non-secret display detail for the provider's checkout widget.

    Prefill is a convenience the customer can overwrite and is never used for
    verification. No passport, no address, no document detail — a checkout
    widget has no use for any of it, and this is the boundary where that is
    decided.
    """
    return {
        "name": "JackPots World Tours & Travels",
        "description": f"{booking.package_name} - {booking.booking_ref}",
        "prefill": {
            "name": customer.full_name,
            "email": customer.email,
            "contact": customer.mobile,
        },
    }
