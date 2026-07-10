from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.booking import Booking, Payment
from app.models.misc import ContactUs, Newsletter
from app.models.user import User


def list_all_bookings(db: Session):
    stmt = select(Booking, User.email).join(User, Booking.user_id == User.id).order_by(Booking.created_at.desc())
    return db.execute(stmt).all()


def list_all_payments(db: Session):
    stmt = select(Payment, User.email).join(User, Payment.user_id == User.id).order_by(Payment.created_at.desc())
    return db.execute(stmt).all()


def update_booking_status(db: Session, booking_id: int, new_status: str) -> tuple[Booking, str]:
    booking = db.get(Booking, booking_id)
    if not booking:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    booking.status = new_status
    db.commit()
    db.refresh(booking)
    email = db.scalar(select(User.email).where(User.id == booking.user_id))
    return booking, email


def list_contact_messages(db: Session) -> list[ContactUs]:
    return db.scalars(select(ContactUs).order_by(ContactUs.created_at.desc())).all()


def list_newsletter_subscribers(db: Session) -> list[Newsletter]:
    return db.scalars(select(Newsletter).order_by(Newsletter.subscribed_at.desc())).all()


def build_reports(db: Session) -> dict:
    total_users = db.scalar(select(func.count()).select_from(User)) or 0
    total_bookings = db.scalar(select(func.count()).select_from(Booking)) or 0
    total_revenue = (
        db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.status == "success")) or 0
    )
    rows = db.execute(select(Booking.booking_type, func.count()).group_by(Booking.booking_type)).all()
    bookings_by_type = {row[0]: row[1] for row in rows}
    newsletter_subscribers = db.scalar(select(func.count()).select_from(Newsletter)) or 0
    contact_messages = db.scalar(select(func.count()).select_from(ContactUs)) or 0
    return {
        "total_users": total_users,
        "total_bookings": total_bookings,
        "total_revenue": float(total_revenue),
        "bookings_by_type": bookings_by_type,
        "newsletter_subscribers": newsletter_subscribers,
        "contact_messages": contact_messages,
    }
