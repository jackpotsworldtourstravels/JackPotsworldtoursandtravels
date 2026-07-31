from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_user
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.booking import BookingConfirmation, BookingCreate, BookingOut, PaymentOut
from app.services.target_schema import booking_service

router = APIRouter(prefix="/api/bookings", tags=["bookings"])
payments_router = APIRouter(prefix="/api/payments", tags=["payments"])

# Frontend still sends 'package' — the new item_type enum uses 'tour_package'
# (matches the tour_packages table name). See schemas/target_schema/booking.py.
_ITEM_TYPE_IN = {"flight": "flight", "hotel": "hotel", "cruise": "cruise", "package": "tour_package"}
_ITEM_TYPE_OUT = {v: k for k, v in _ITEM_TYPE_IN.items()}


@router.post(
    "", response_model=BookingConfirmation, status_code=status.HTTP_201_CREATED,
    summary="Create a booking and mock payment",
)
def create_booking(payload: BookingCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    booking, payment = booking_service.create_booking_with_payment(
        db, current_user, item_type=_ITEM_TYPE_IN[payload.booking_type], item_id=payload.item_id,
        quantity=payload.quantity, travel_date=payload.travel_date, coupon_code=payload.coupon_code,
    )
    return BookingConfirmation(
        booking=_booking_out(booking), payment=PaymentOut.model_validate(payment),
    )


def _booking_out(booking) -> BookingOut:
    out = BookingOut.model_validate(booking)
    out.booking_type = _ITEM_TYPE_OUT.get(out.booking_type, out.booking_type)
    return out


@router.get("", response_model=list[BookingOut], summary="List my bookings")
def my_bookings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return [_booking_out(b) for b in booking_service.list_user_bookings(db, current_user)]


@router.delete("/{booking_id}", response_model=BookingOut, summary="Cancel one of my bookings")
def cancel_my_booking(booking_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _booking_out(booking_service.cancel_booking(db, current_user, booking_id))


@payments_router.get("/history", response_model=list[PaymentOut], summary="List my payment history")
def payment_history(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return booking_service.list_user_payments(db, current_user)
