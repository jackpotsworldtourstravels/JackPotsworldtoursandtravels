from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.user import User
from app.schemas.booking import AdminBookingOut, AdminPaymentOut, BookingStatusUpdate
from app.schemas.misc import ContactMessageOut, NewsletterSubscriberOut, ReportsOut
from app.services import admin_service

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/bookings", response_model=list[AdminBookingOut])
def list_bookings(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    rows = admin_service.list_all_bookings(db)
    return [AdminBookingOut(**booking.__dict__, user_email=email) for booking, email in rows]


@router.patch("/bookings/{booking_id}", response_model=AdminBookingOut)
def update_booking_status(
    booking_id: int,
    payload: BookingStatusUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    booking, email = admin_service.update_booking_status(db, booking_id, payload.status)
    return AdminBookingOut(**booking.__dict__, user_email=email)


@router.get("/payments", response_model=list[AdminPaymentOut])
def list_payments(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    rows = admin_service.list_all_payments(db)
    return [AdminPaymentOut(**payment.__dict__, user_email=email) for payment, email in rows]


@router.get("/contact", response_model=list[ContactMessageOut])
def list_contact_messages(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.list_contact_messages(db)


@router.get("/newsletter", response_model=list[NewsletterSubscriberOut])
def list_newsletter_subscribers(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.list_newsletter_subscribers(db)


@router.get("/reports", response_model=ReportsOut)
def get_reports(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.build_reports(db)
