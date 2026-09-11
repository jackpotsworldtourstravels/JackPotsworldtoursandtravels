"""Creating, listing and cancelling a customer's hotel bookings.

Same two disciplines as ``customer_booking_service.py``, applied to a stay
instead of a flight:

THE BOOKING REFERENCE IS REAL. ``booking_ref`` (``JPH000123``) is drawn from
its own Postgres sequence, unique by index — a genuine reference the customer
can quote to support, distinct from a flight's ``JPB`` series so the two can
never collide and a reference alone says which table to look in.

THE STATUS IS ``pending``, NOT ``confirmed``. No payment gateway is
integrated, so nothing has actually been paid for yet — :func:`record_payment`
is where a real gateway result would promote it, exactly as it is for flights.
"""
from __future__ import annotations

import datetime as dt

from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    Customer,
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingAddon,
    CustomerHotelBookingGuest,
    CustomerHotelBookingPayment,
    CustomerHotelBookingRoom,
    CustomerPaymentStatus,
)
from app.services import customer_hotel_catalog_service as catalog
from app.services import customer_hotel_pricing_service as pricing
from app.services import payments as payment_providers
from app.services.customer_booking_service import PAYMENT_METHODS

REF_SEQ = "seq_customer_hotel_booking_ref"
_METHOD_IDS = {m["id"] for m in PAYMENT_METHODS}


class HotelBookingError(ValueError):
    """The stay cannot be booked or changed as asked."""


def next_booking_ref(db: Session) -> str:
    n = db.execute(text(f"SELECT nextval('{REF_SEQ}')")).scalar_one()
    return f"JPH{n:06d}"


def _validate_guests(guests: list[dict]) -> None:
    if not guests:
        raise HotelBookingError("A booking needs at least one guest.")

    adults = sum(1 for g in guests if g.get("guest_type", "adult") == "adult")
    if adults == 0:
        raise HotelBookingError("At least one adult must be staying.")

    contacts = [g for g in guests if g.get("is_contact")]
    if len(contacts) != 1:
        raise HotelBookingError("Exactly one guest must carry the booking contact details.")

    for i, g in enumerate(guests, start=1):
        if not (g.get("first_name") or "").strip():
            raise HotelBookingError(f"Guest {i}: first name is required.")
        if not (g.get("last_name") or "").strip():
            raise HotelBookingError(f"Guest {i}: last name is required.")


def _resolve_rooms(db: Session, stay: dict) -> list:
    """The rooms being booked, in order.

    ``room_ids`` names one room per room booked and may mix types; without it
    the stay is ``rooms_count`` of the single ``room_id``, which is how every
    caller before migration 0058 describes itself. Each id is resolved through
    ``catalog.get_room``, which scopes it to the property — a room id from a
    different hotel must not become bookable here just because it is an
    integer somebody could type.
    """
    hotel_id = stay["hotel_id"]
    room_ids = list(stay.get("room_ids") or [])
    rooms_count = stay.get("rooms_count") or 1

    if not room_ids:
        room_ids = [stay["room_id"]] * rooms_count
    elif len(room_ids) != rooms_count:
        raise HotelBookingError(
            f"{len(room_ids)} rooms were chosen but {rooms_count} were asked for."
        )

    rooms = []
    for rid in room_ids:
        room = catalog.get_room(db, hotel_id, rid)
        if room is None:
            raise HotelBookingError("That room is not available at this property.")
        rooms.append(room)
    return rooms


def _price_stay(db: Session, stay: dict, addons: list[dict], coupon_code: str | None) -> dict:
    rooms = _resolve_rooms(db, stay)
    room = rooms[0]

    check_in, check_out = stay["check_in"], stay["check_out"]
    if check_out <= check_in:
        raise HotelBookingError("Check-out must be at least one night after check-in.")
    nights = pricing.nights_between(check_in, check_out)
    rooms_count = len(rooms)

    # Inventory is per room TYPE, so the check counts how many of each type
    # this stay asks for rather than comparing the whole party to one room's
    # stock — two Deluxe plus one Premium must not fail because three exceeds
    # the Premium's inventory of two.
    wanted: dict[int, int] = {}
    for r in rooms:
        wanted[r.customer_hotel_room_id] = wanted.get(r.customer_hotel_room_id, 0) + 1
    for r in rooms:
        n = wanted[r.customer_hotel_room_id]
        if n > r.total_inventory:
            raise HotelBookingError(
                f"Only {r.total_inventory} {r.name} can be booked at once."
            )

    try:
        priced = pricing.quote(
            db, room=room, nights=nights, rooms_count=rooms_count, rooms=rooms,
            addon_selections=addons, coupon_code=coupon_code,
        )
    except pricing.HotelPricingError as exc:
        raise HotelBookingError(str(exc)) from exc

    priced["room"] = room
    priced["rooms"] = rooms
    priced["nights"] = nights
    priced["rooms_count"] = rooms_count
    return priced


def quote_stay(db: Session, stay: dict, addons: list[dict], coupon_code: str | None) -> dict:
    """Price a stay without booking it — what ``POST /hotel-bookings/quote``
    answers.

    Deliberately the SAME function the real booking prices through. The quote
    route used to resolve the room and re-implement the checks itself, and the
    two drifted the moment per-room selections arrived: the booking honoured
    ``room_ids`` while the quote silently priced ``rooms_count`` of the first
    room, so a Superior-plus-Deluxe stay was quoted as two Superiors. Sharing
    one function is what makes the endpoint's own promise — "the same code
    path prices the real booking" — actually true.
    """
    return _price_stay(db, stay, addons, coupon_code)


def find_by_idempotency_key(
    db: Session, customer: Customer, key: str
) -> CustomerHotelBooking | None:
    """The booking this customer already made under this key, if any.

    Scoped to the customer as well as the key: the unique index is on the pair,
    and looking up by key alone would let one account's key surface another
    account's booking.
    """
    return db.execute(
        select(CustomerHotelBooking)
        .options(
            selectinload(CustomerHotelBooking.rooms),
            selectinload(CustomerHotelBooking.guests),
            selectinload(CustomerHotelBooking.addons),
            selectinload(CustomerHotelBooking.payments),
        )
        .where(
            CustomerHotelBooking.customer_id == customer.customer_id,
            CustomerHotelBooking.idempotency_key == key,
        )
    ).scalar_one_or_none()


def create_booking(db: Session, customer: Customer, payload: dict) -> CustomerHotelBooking:
    """Price the request from scratch, then write it down.

    Nothing the client sends about money is read — the room, the dates, the
    party and the add-ons are inputs; every rupee is recomputed here.

    SUBMITTING TWICE MAKES ONE BOOKING. When the payload carries an
    ``idempotency_key`` the booking already made under it is returned as-is.
    The lookup is a fast path, not the guarantee — two simultaneous requests
    can both find nothing — so the unique index from migration 0060 is what
    actually decides, and the loser of that race re-reads the winner's row.
    """
    stay = payload["stay"]
    guests = payload.get("guests") or []
    key = (payload.get("idempotency_key") or "").strip() or None

    if key:
        existing = find_by_idempotency_key(db, customer, key)
        if existing is not None:
            return existing

    _validate_guests(guests)

    priced = _price_stay(db, stay, payload.get("addons") or [], payload.get("coupon_code"))
    if priced["coupon_error"]:
        raise HotelBookingError(priced["coupon_error"])
    room = priced["room"]
    hotel = room.hotel

    booking = CustomerHotelBooking(
        booking_ref=next_booking_ref(db),
        customer_id=customer.customer_id,
        status=CustomerBookingStatus.PENDING.value,
        hotel_id=stay["hotel_id"],
        hotel_name=hotel.name,
        hotel_location=hotel.location,
        room_id=room.customer_hotel_room_id,
        room_name=room.name,
        meal_plan=room.meal_plan,
        check_in_date=stay["check_in"],
        check_out_date=stay["check_out"],
        nights=priced["nights"],
        rooms_count=priced["rooms_count"],
        adults=stay.get("adults") or 1,
        children=stay.get("children") or 0,
        child_ages=stay.get("child_ages") or None,
        special_requests=payload.get("special_requests") or None,
        notes=payload.get("notes"),
        room_subtotal=priced["room_subtotal"],
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

    # One row per room booked, in the order they were configured, with the
    # rate snapshotted — see migration 0058. The parent's own room_id/
    # room_name above stay the first room and the summary.
    for i, r in enumerate(priced["rooms"]):
        db.add(CustomerHotelBookingRoom(
            hotel_booking_id=booking.customer_hotel_booking_id,
            room_index=i,
            room_id=r.customer_hotel_room_id,
            room_name=r.name,
            meal_plan=r.meal_plan,
            price_per_night=r.base_price_per_night,
        ))

    for i, g in enumerate(guests):
        db.add(CustomerHotelBookingGuest(
            hotel_booking_id=booking.customer_hotel_booking_id,
            guest_index=i,
            room_index=g.get("room_index"),
            guest_type=g.get("guest_type", "adult"),
            title=g.get("title"),
            first_name=(g.get("first_name") or "").strip(),
            last_name=(g.get("last_name") or "").strip(),
            gender=g.get("gender"),
            date_of_birth=g.get("date_of_birth"),
            nationality=g.get("nationality"),
            is_contact=bool(g.get("is_contact")),
            mobile=g.get("mobile"),
            email=g.get("email"),
        ))

    for row in priced["addon_rows"]:
        db.add(CustomerHotelBookingAddon(
            hotel_booking_id=booking.customer_hotel_booking_id,
            addon_type=row["addon_type"], code=row["code"], name=row["name"],
            description=row.get("description"), unit_price=row["unit_price"],
            quantity=row["quantity"],
        ))

    db.flush()
    return booking


def list_for_customer(db: Session, customer: Customer) -> list[CustomerHotelBooking]:
    return list(
        db.execute(
            select(CustomerHotelBooking)
            .options(
                selectinload(CustomerHotelBooking.rooms),
                selectinload(CustomerHotelBooking.guests),
                selectinload(CustomerHotelBooking.addons),
                selectinload(CustomerHotelBooking.payments),
            )
            .where(CustomerHotelBooking.customer_id == customer.customer_id)
            .order_by(CustomerHotelBooking.created_at.desc())
        ).scalars()
    )


def get_owned(db: Session, customer: Customer, booking_ref: str) -> CustomerHotelBooking | None:
    """One booking by reference, scoped to its owner — same rule as flights:
    booking references are sequential and therefore guessable, so ownership
    is a filter applied server-side, not an afterthought."""
    return db.execute(
        select(CustomerHotelBooking)
        .options(
            selectinload(CustomerHotelBooking.rooms),
                selectinload(CustomerHotelBooking.guests),
            selectinload(CustomerHotelBooking.addons),
            selectinload(CustomerHotelBooking.payments),
        )
        .where(
            CustomerHotelBooking.booking_ref == booking_ref,
            CustomerHotelBooking.customer_id == customer.customer_id,
        )
    ).scalar_one_or_none()


def cancel(db: Session, booking: CustomerHotelBooking) -> CustomerHotelBooking:
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise HotelBookingError("This booking is already cancelled.")
    if booking.status == CustomerBookingStatus.COMPLETED.value:
        raise HotelBookingError("A completed booking cannot be cancelled.")
    booking.status = CustomerBookingStatus.CANCELLED.value
    booking.cancelled_at = dt.datetime.now(dt.timezone.utc)
    db.flush()
    return booking


def record_payment(
    db: Session, booking: CustomerHotelBooking, method: str
) -> CustomerHotelBookingPayment:
    """Record a payment attempt. Does not take money — see
    ``customer_booking_service.record_payment``, which this mirrors exactly."""
    if method not in _METHOD_IDS:
        raise HotelBookingError(f"'{method}' is not a supported payment method.")
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise HotelBookingError("This booking has been cancelled.")

    payment = CustomerHotelBookingPayment(
        hotel_booking_id=booking.customer_hotel_booking_id,
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
def payable_amount(booking: CustomerHotelBooking) -> Decimal:
    """What this booking costs, read from the row the server priced.

    THE WHOLE POINT OF THIS FUNCTION IS THAT IT TAKES NO ARGUMENT FROM A
    REQUEST. ``create_booking`` recomputed every rupee through
    ``customer_hotel_pricing_service`` and wrote the total down; this reads that total
    back. A client that sends ``{"amount": 1}`` alongside its booking reference
    changes nothing, because no code path reads an amount out of a payment
    request -- there is no field for one to arrive in.
    """
    return Decimal(str(booking.total_amount or 0))


def captured_payment(
    db: Session, booking: CustomerHotelBooking
) -> CustomerHotelBookingPayment | None:
    """The verified payment for this booking, if it has been paid.

    Used to refuse a second checkout on a booking that is already paid for --
    the failure mode a customer reaches by pressing Back from the confirmation
    screen and paying again.
    """
    return db.execute(
        select(CustomerHotelBookingPayment).where(
            CustomerHotelBookingPayment.hotel_booking_id == booking.customer_hotel_booking_id,
            CustomerHotelBookingPayment.status == CustomerPaymentStatus.CAPTURED.value,
        )
    ).scalars().first()


def reconcilable_payment(
    db: Session, booking: CustomerHotelBooking
) -> CustomerHotelBookingPayment | None:
    """The attempt worth asking the provider about, if there is one.

    The most recent one that actually reached the provider. An attempt with no
    ``provider_order_id`` was never opened there and there is nothing to ask
    about, so it is skipped rather than reported as unpayable. A captured row is
    returned rather than filtered out: the verifier answers ``already_captured``
    for it in one cheap read, which is the honest answer to "did this get paid?".
    """
    return db.execute(
        select(CustomerHotelBookingPayment)
        .where(
            CustomerHotelBookingPayment.hotel_booking_id == booking.customer_hotel_booking_id,
            CustomerHotelBookingPayment.provider_order_id.isnot(None),
        )
        .order_by(CustomerHotelBookingPayment.created_at.desc())
    ).scalars().first()


def find_payment_by_idempotency_key(
    db: Session, booking: CustomerHotelBooking, key: str
) -> CustomerHotelBookingPayment | None:
    """The attempt this booking already has under this key, if any.

    Scoped to the booking as well as the key, matching the unique index from
    migration 0062.
    """
    return db.execute(
        select(CustomerHotelBookingPayment).where(
            CustomerHotelBookingPayment.hotel_booking_id == booking.customer_hotel_booking_id,
            CustomerHotelBookingPayment.idempotency_key == key,
        )
    ).scalar_one_or_none()


def _checkout_options(booking: CustomerHotelBooking, customer: Customer) -> dict:
    """Non-secret display detail for the provider's checkout widget.

    Prefill is a convenience the customer can overwrite and is never used for
    verification. No passport and no document detail -- a checkout widget has no
    use for any of it, and this is the boundary where that is decided.
    """
    label = booking.hotel_name or "Hotel stay"
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
    booking: CustomerHotelBooking,
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
    2. the unique index on ``(hotel_booking_id, idempotency_key)`` decides
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
        raise HotelBookingError("This booking belongs to another customer.")
    if booking.status == CustomerBookingStatus.CANCELLED.value:
        raise HotelBookingError("This booking has been cancelled and cannot be paid for.")
    if booking.status == CustomerBookingStatus.COMPLETED.value:
        raise HotelBookingError("This booking is already completed.")

    already = captured_payment(db, booking)
    if already is not None:
        raise HotelBookingError(
            f"{booking.booking_ref} has already been paid for. "
            "No further payment is needed."
        )

    key = (idempotency_key or "").strip()
    if len(key) < 8:
        raise HotelBookingError(
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
                raise HotelBookingError(
                    f"{booking.booking_ref} has an open payment with "
                    f"{existing.provider}, which is not available on this "
                    "deployment. Contact support rather than paying twice."
                )
        return existing, _session_for(existing, booking, customer, opener)

    amount = payable_amount(booking)
    if amount <= 0:
        raise HotelBookingError(
            f"{booking.booking_ref} has no amount to pay. "
            "Contact support rather than paying zero."
        )
    currency = (booking.currency or payment_providers.INR).upper()
    amount_minor = payment_providers.to_minor(amount, currency)

    payment = existing
    if payment is None:
        payment = CustomerHotelBookingPayment(
            hotel_booking_id=booking.customer_hotel_booking_id,
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
            "product_type": "hotel",
            "customer_id": customer.customer_id,
        },
    )

    # WHAT THE PROVIDER OPENED MUST BE WHAT WE ASKED FOR. Checked here as well
    # as at capture, so a mismatch is caught before the customer is shown a
    # figure rather than after they have paid it.
    if session.amount_minor != amount_minor or (session.currency or "").upper() != currency:
        raise HotelBookingError(
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
