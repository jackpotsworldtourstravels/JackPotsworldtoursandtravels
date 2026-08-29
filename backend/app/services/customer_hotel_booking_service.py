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
