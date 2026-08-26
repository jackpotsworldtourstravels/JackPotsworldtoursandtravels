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
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    Customer,
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingAddon,
    CustomerHotelBookingGuest,
    CustomerHotelBookingPayment,
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


def _price_stay(db: Session, stay: dict, addons: list[dict], coupon_code: str | None) -> dict:
    room = catalog.get_room(db, stay["hotel_id"], stay["room_id"])
    if room is None:
        raise HotelBookingError("That room is not available at this property.")

    check_in, check_out = stay["check_in"], stay["check_out"]
    if check_out <= check_in:
        raise HotelBookingError("Check-out must be at least one night after check-in.")
    nights = pricing.nights_between(check_in, check_out)
    rooms_count = stay.get("rooms_count") or 1
    if rooms_count > room.total_inventory:
        raise HotelBookingError(
            f"Only {room.total_inventory} of this room type can be booked at once."
        )

    try:
        priced = pricing.quote(
            db, room=room, nights=nights, rooms_count=rooms_count,
            addon_selections=addons, coupon_code=coupon_code,
        )
    except pricing.HotelPricingError as exc:
        raise HotelBookingError(str(exc)) from exc

    priced["room"] = room
    priced["nights"] = nights
    priced["rooms_count"] = rooms_count
    return priced


def create_booking(db: Session, customer: Customer, payload: dict) -> CustomerHotelBooking:
    """Price the request from scratch, then write it down.

    Nothing the client sends about money is read — the room, the dates, the
    party and the add-ons are inputs; every rupee is recomputed here.
    """
    stay = payload["stay"]
    guests = payload.get("guests") or []
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
    )
    db.add(booking)
    db.flush()

    for i, g in enumerate(guests):
        db.add(CustomerHotelBookingGuest(
            hotel_booking_id=booking.customer_hotel_booking_id,
            guest_index=i,
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
