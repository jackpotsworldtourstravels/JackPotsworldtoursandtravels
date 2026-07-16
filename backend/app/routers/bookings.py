from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.booking import BookingConfirmation, BookingCreate, BookingOut, PaymentOut
from app.services import booking_service

router = APIRouter(prefix="/api/bookings", tags=["bookings"])
payments_router = APIRouter(prefix="/api/payments", tags=["payments"])


@router.post(
    "",
    response_model=BookingConfirmation,
    status_code=status.HTTP_201_CREATED,
    summary="Create a booking and mock payment",
    description=(
        "Requires authentication. Books a flight, hotel, cruise, or package for the current user and "
        "immediately processes a mock payment. Checks availability where the catalog tracks capacity "
        "(flights, hotels). The server recalculates the total price from the catalog and quantity; the "
        "client-supplied total_price is ignored."
    ),
)
def create_booking(
    payload: BookingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    booking, payment = booking_service.create_booking_with_payment(db, current_user, payload)
    return BookingConfirmation(booking=booking, payment=payment)


@router.get(
    "",
    response_model=list[BookingOut],
    summary="List my bookings",
    description="Requires authentication. Returns all bookings made by the current user, most recent first.",
)
def my_bookings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return booking_service.list_user_bookings(db, current_user)


@router.delete(
    "/{booking_id}",
    response_model=BookingOut,
    summary="Cancel one of my bookings",
    description=(
        "Requires authentication. Cancels a booking owned by the current user and refunds the associated "
        "successful payment. Returns the updated booking; fails if it belongs to someone else, doesn't "
        "exist, or is already cancelled."
    ),
)
def cancel_my_booking(
    booking_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return booking_service.cancel_booking(db, current_user, booking_id)


@payments_router.get(
    "/history",
    response_model=list[PaymentOut],
    summary="List my payment history",
    description="Requires authentication. Returns all payments made by the current user, most recent first.",
)
def payment_history(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return booking_service.list_user_payments(db, current_user)
