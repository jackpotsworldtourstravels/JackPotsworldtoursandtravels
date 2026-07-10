import secrets

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.booking import Booking, Payment
from app.models.travel import Cruise, Flight, Hotel, TourPackage
from app.models.user import User
from app.schemas.booking import BookingCreate

_ITEM_MODELS = {
    "flight": Flight,
    "hotel": Hotel,
    "cruise": Cruise,
    "package": TourPackage,
}


def _validate_item_exists(db: Session, booking_type: str, item_id: int) -> None:
    model = _ITEM_MODELS[booking_type]
    if not db.get(model, item_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{booking_type} {item_id} not found")


def create_booking_with_payment(db: Session, user: User, payload: BookingCreate) -> tuple[Booking, Payment]:
    _validate_item_exists(db, payload.booking_type, payload.item_id)

    booking = Booking(
        user_id=user.id,
        booking_type=payload.booking_type,
        item_id=payload.item_id,
        status="confirmed",
        total_price=payload.total_price,
        travel_date=payload.travel_date,
    )
    db.add(booking)
    db.flush()

    payment = Payment(
        booking_id=booking.id,
        user_id=user.id,
        amount=payload.total_price,
        method="mock",
        status="success",
        transaction_ref=f"TXN-{secrets.token_hex(6).upper()}",
    )
    db.add(payment)
    db.commit()
    db.refresh(booking)
    db.refresh(payment)
    return booking, payment


def list_user_bookings(db: Session, user: User) -> list[Booking]:
    stmt = select(Booking).where(Booking.user_id == user.id).order_by(Booking.created_at.desc())
    return db.scalars(stmt).all()


def cancel_booking(db: Session, user: User, booking_id: int) -> Booking:
    booking = db.get(Booking, booking_id)
    if not booking or booking.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    booking.status = "cancelled"
    db.commit()
    db.refresh(booking)
    return booking


def list_user_payments(db: Session, user: User) -> list[Payment]:
    stmt = select(Payment).where(Payment.user_id == user.id).order_by(Payment.created_at.desc())
    return db.scalars(stmt).all()
