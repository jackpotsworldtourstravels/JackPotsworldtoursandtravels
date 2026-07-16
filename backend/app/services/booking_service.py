import secrets

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.booking import Booking, Payment
from app.models.user import User
from app.schemas.booking import BookingCreate
from app.services import activity_service, notification_service
from app.services.catalog_items import ITEM_MODELS


def _get_item(db: Session, booking_type: str, item_id: int):
    model = ITEM_MODELS[booking_type]
    item = db.get(model, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{booking_type} {item_id} not found")
    return item


def _unit_price(booking_type: str, item) -> float:
    return float(item.price_per_night) if booking_type == "hotel" else float(item.price)


def _check_availability(booking_type: str, item, quantity: int) -> None:
    """Reject overbooking where the catalog tracks real capacity.

    Cruises and tour packages have no capacity column in this data model, so
    their quantity isn't checked against anything — same scope boundary as
    the search-filter work in an earlier stage.
    """
    if booking_type == "flight" and item.seats_available < quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only {item.seats_available} seat(s) available on this flight.",
        )
    if booking_type == "hotel" and item.rooms_available < quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only {item.rooms_available} room(s) available at this hotel.",
        )


def create_booking_with_payment(db: Session, user: User, payload: BookingCreate) -> tuple[Booking, Payment]:
    item = _get_item(db, payload.booking_type, payload.item_id)
    _check_availability(payload.booking_type, item, payload.quantity)
    # Server recomputes the price from the catalog — the client-supplied total_price is ignored.
    total_price = round(_unit_price(payload.booking_type, item) * payload.quantity, 2)

    booking = Booking(
        user_id=user.id,
        booking_type=payload.booking_type,
        item_id=payload.item_id,
        status="confirmed",
        total_price=total_price,
        quantity=payload.quantity,
        travel_date=payload.travel_date,
    )
    db.add(booking)
    db.flush()

    payment = Payment(
        booking_id=booking.id,
        user_id=user.id,
        amount=total_price,
        method="mock",
        status="success",
        transaction_ref=f"TXN-{secrets.token_hex(6).upper()}",
    )
    db.add(payment)
    db.commit()
    db.refresh(booking)
    db.refresh(payment)

    activity_service.log_activity(db, user.id, f"Booking Created ({payload.booking_type} #{payload.item_id})")
    notification_service.create_notification(
        db, user.id, "Booking confirmed",
        f"Your {payload.booking_type} booking (#{booking.id}) is confirmed.",
    )
    notification_service.create_notification(
        db, user.id, "Payment successful",
        f"Payment of ₹{total_price:,.2f} for booking #{booking.id} was successful.",
    )
    return booking, payment


def list_user_bookings(db: Session, user: User) -> list[Booking]:
    stmt = select(Booking).where(Booking.user_id == user.id).order_by(Booking.created_at.desc())
    return db.scalars(stmt).all()


def refund_payment_for_booking(db: Session, booking: Booking) -> None:
    payment = db.scalar(select(Payment).where(Payment.booking_id == booking.id, Payment.status == "success"))
    if not payment:
        return
    payment.status = "refunded"
    db.commit()
    activity_service.log_activity(db, booking.user_id, f"Payment Refunded (#{booking.id})")
    notification_service.create_notification(
        db, booking.user_id, "Payment refunded", f"Your payment for booking #{booking.id} has been refunded."
    )


def cancel_booking(db: Session, user: User, booking_id: int) -> Booking:
    booking = db.get(Booking, booking_id)
    if not booking or booking.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    if booking.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Booking is already cancelled")
    booking.status = "cancelled"
    db.commit()
    db.refresh(booking)

    activity_service.log_activity(db, user.id, f"Booking Cancelled (#{booking.id})")
    notification_service.create_notification(
        db, user.id, "Booking cancelled", f"Your booking #{booking.id} has been cancelled."
    )
    refund_payment_for_booking(db, booking)
    return booking


def list_user_payments(db: Session, user: User) -> list[Payment]:
    stmt = select(Payment).where(Payment.user_id == user.id).order_by(Payment.created_at.desc())
    return db.scalars(stmt).all()
