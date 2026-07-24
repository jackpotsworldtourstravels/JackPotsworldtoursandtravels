import csv
import datetime
import io

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.booking import Booking, Payment
from app.models.misc import ActivityLog, ContactUs, Newsletter, SupportTicket
from app.models.travel import Cruise, Flight, Hotel, TourPackage
from app.models.user import User
from app.services import booking_service, session_service


def list_all_bookings(db: Session):
    stmt = select(Booking, User.email).join(User, Booking.user_id == User.id).order_by(Booking.created_at.desc())
    return db.execute(stmt).all()


def list_all_bookings_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(Booking)) or 0
    stmt = (
        select(Booking, User.email)
        .join(User, Booking.user_id == User.id)
        .order_by(Booking.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return db.execute(stmt).all(), total


def list_all_payments(db: Session):
    stmt = select(Payment, User.email).join(User, Payment.user_id == User.id).order_by(Payment.created_at.desc())
    return db.execute(stmt).all()


def list_all_payments_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(Payment)) or 0
    stmt = (
        select(Payment, User.email)
        .join(User, Payment.user_id == User.id)
        .order_by(Payment.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return db.execute(stmt).all(), total


def update_booking_status(db: Session, booking_id: int, new_status: str) -> tuple[Booking, str]:
    booking = db.get(Booking, booking_id)
    if not booking:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    was_cancelled = booking.status == "cancelled"
    booking.status = new_status
    db.commit()
    db.refresh(booking)
    if new_status == "cancelled" and not was_cancelled:
        booking_service.restore_inventory_for_booking(db, booking)
        booking_service.refund_payment_for_booking(db, booking)
        db.refresh(booking)
    email = db.scalar(select(User.email).where(User.id == booking.user_id))
    return booking, email


def list_contact_messages(db: Session) -> list[ContactUs]:
    return db.scalars(select(ContactUs).order_by(ContactUs.created_at.desc())).all()


def list_contact_messages_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(ContactUs)) or 0
    stmt = select(ContactUs).order_by(ContactUs.created_at.desc()).limit(page_size).offset((page - 1) * page_size)
    return db.scalars(stmt).all(), total


def delete_contact_message(db: Session, message_id: int) -> None:
    message = db.get(ContactUs, message_id)
    if not message:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    db.delete(message)
    db.commit()


def list_newsletter_subscribers(db: Session) -> list[Newsletter]:
    return db.scalars(select(Newsletter).order_by(Newsletter.subscribed_at.desc())).all()


def _count_status(db: Session, status_value: str) -> int:
    return db.scalar(select(func.count()).select_from(Booking).where(Booking.status == status_value)) or 0


def _today_start() -> datetime.datetime:
    return datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)


_TOP_ITEM_NAME = {
    "flight": lambda item: f"{item.from_airport} → {item.to_airport}",
    "hotel": lambda item: item.name,
    "cruise": lambda item: item.name,
    "package": lambda item: item.title,
}
_TOP_ITEM_MODEL = {"flight": Flight, "hotel": Hotel, "cruise": Cruise, "package": TourPackage}


def _top_items(db: Session, booking_type: str, limit: int = 5) -> list[dict]:
    rows = db.execute(
        select(
            Booking.item_id,
            func.count().label("bookings"),
            func.coalesce(func.sum(Booking.total_price), 0).label("revenue"),
        )
        .where(Booking.booking_type == booking_type, Booking.status != "cancelled")
        .group_by(Booking.item_id)
        .order_by(func.count().desc())
        .limit(limit)
    ).all()
    model = _TOP_ITEM_MODEL[booking_type]
    name_fn = _TOP_ITEM_NAME[booking_type]
    results = []
    for item_id, bookings, revenue in rows:
        item = db.get(model, item_id)
        if not item:
            continue
        results.append(
            {
                "item_type": booking_type,
                "item_id": item_id,
                "name": name_fn(item),
                "bookings": bookings,
                "revenue": float(revenue),
            }
        )
    return results


def _top_destinations_by_location(db: Session, limit: int = 5) -> list[dict]:
    """Real geographic destinations (hotel bookings grouped by hotel location) — distinct from
    _top_items('flight'), which ranks flight routes, not destinations."""
    rows = db.execute(
        select(
            Hotel.location,
            func.count().label("bookings"),
            func.coalesce(func.sum(Booking.total_price), 0).label("revenue"),
        )
        .join(Hotel, Booking.item_id == Hotel.id)
        .where(Booking.booking_type == "hotel", Booking.status != "cancelled")
        .group_by(Hotel.location)
        .order_by(func.count().desc())
        .limit(limit)
    ).all()
    return [{"name": location, "bookings": bookings, "revenue": float(revenue)} for location, bookings, revenue in rows]


def _most_active_users(db: Session, limit: int = 5) -> list[dict]:
    rows = db.execute(
        select(
            ActivityLog.user_id,
            func.count().label("activity_count"),
            func.max(ActivityLog.created_at).label("last_active"),
        )
        .where(ActivityLog.user_id.is_not(None))
        .group_by(ActivityLog.user_id)
        .order_by(func.count().desc())
        .limit(limit)
    ).all()
    results = []
    for user_id, activity_count, last_active in rows:
        user = db.get(User, user_id)
        if not user:
            continue
        results.append(
            {
                "user_id": user_id,
                "full_name": user.full_name,
                "email": user.email,
                "activity_count": activity_count,
                "last_active": last_active,
            }
        )
    return results


def build_reports(db: Session) -> dict:
    total_users = db.scalar(select(func.count()).select_from(User)) or 0
    active_users = db.scalar(select(func.count()).select_from(User).where(User.is_active.is_(True))) or 0
    total_bookings = db.scalar(select(func.count()).select_from(Booking)) or 0
    total_revenue = (
        db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.status == "success")) or 0
    )
    rows = db.execute(select(Booking.booking_type, func.count()).group_by(Booking.booking_type)).all()
    bookings_by_type = {row[0]: row[1] for row in rows}
    payments_by_status = {
        row[0]: row[1] for row in db.execute(select(Payment.status, func.count()).group_by(Payment.status)).all()
    }
    newsletter_subscribers = db.scalar(select(func.count()).select_from(Newsletter)) or 0
    contact_messages = db.scalar(select(func.count()).select_from(ContactUs)) or 0

    recent_users = db.scalars(select(User).order_by(User.created_at.desc()).limit(5)).all()
    recent_bookings = [
        {**booking.__dict__, "user_email": email}
        for booking, email in db.execute(
            select(Booking, User.email).join(User, Booking.user_id == User.id).order_by(Booking.created_at.desc()).limit(5)
        ).all()
    ]
    recent_payments = [
        {**payment.__dict__, "user_email": email}
        for payment, email in db.execute(
            select(Payment, User.email).join(User, Payment.user_id == User.id).order_by(Payment.created_at.desc()).limit(5)
        ).all()
    ]

    today_start = _today_start()
    today_users = db.scalar(select(func.count()).select_from(User).where(User.created_at >= today_start)) or 0
    today_bookings = db.scalar(select(func.count()).select_from(Booking).where(Booking.created_at >= today_start)) or 0
    today_revenue = (
        db.scalar(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.status == "success", Payment.created_at >= today_start
            )
        )
        or 0
    )
    today_payments = (
        db.scalar(select(func.count()).select_from(Payment).where(Payment.created_at >= today_start)) or 0
    )

    return {
        "total_users": total_users,
        "active_users": active_users,
        "total_bookings": total_bookings,
        "total_revenue": float(total_revenue),
        "bookings_by_type": bookings_by_type,
        "newsletter_subscribers": newsletter_subscribers,
        "contact_messages": contact_messages,
        "total_flights": db.scalar(select(func.count()).select_from(Flight)) or 0,
        "total_hotels": db.scalar(select(func.count()).select_from(Hotel)) or 0,
        "total_cruises": db.scalar(select(func.count()).select_from(Cruise)) or 0,
        "total_packages": db.scalar(select(func.count()).select_from(TourPackage)) or 0,
        "pending_bookings": _count_status(db, "pending"),
        "confirmed_bookings": _count_status(db, "confirmed"),
        "completed_bookings": _count_status(db, "completed"),
        "cancelled_bookings": _count_status(db, "cancelled"),
        "payments_by_status": payments_by_status,
        "recent_users": recent_users,
        "recent_bookings": recent_bookings,
        "recent_payments": recent_payments,
        "today_users": today_users,
        "today_logins": session_service.count_todays_logins(db),
        "today_bookings": today_bookings,
        "today_revenue": float(today_revenue),
        "today_payments": today_payments,
        "users_online": session_service.count_online_users(db),
        "active_sessions": session_service.count_active_sessions(db),
        "top_destinations": _top_destinations_by_location(db),
        "top_flights": _top_items(db, "flight"),
        "top_hotels": _top_items(db, "hotel"),
        "top_cruises": _top_items(db, "cruise"),
        "top_packages": _top_items(db, "package"),
        "most_active_users": _most_active_users(db),
        "open_support_tickets": db.scalar(
            select(func.count()).select_from(SupportTicket).where(SupportTicket.status.in_(["open", "in_progress"]))
        ) or 0,
    }


def monthly_stats(db: Session) -> list[dict]:
    revenue_rows = db.execute(
        select(
            func.to_char(Payment.created_at, "YYYY-MM").label("month"),
            func.coalesce(func.sum(Payment.amount), 0).label("revenue"),
        )
        .where(Payment.status == "success")
        .group_by("month")
    ).all()
    booking_rows = db.execute(
        select(
            func.to_char(Booking.created_at, "YYYY-MM").label("month"),
            func.count().label("bookings"),
        ).group_by("month")
    ).all()
    revenue_map = {row.month: float(row.revenue) for row in revenue_rows}
    bookings_map = {row.month: row.bookings for row in booking_rows}
    months = sorted(set(revenue_map) | set(bookings_map))
    return [{"month": m, "revenue": revenue_map.get(m, 0.0), "bookings": bookings_map.get(m, 0)} for m in months]


def export_users_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "full_name", "email", "role", "is_active", "created_at"])
    for user in db.scalars(select(User).order_by(User.created_at.desc())).all():
        writer.writerow([user.id, user.full_name, user.email, user.role.name, user.is_active, user.created_at])
    return buf.getvalue()


def export_bookings_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "user_email", "booking_type", "item_id", "status", "total_price", "travel_date", "created_at"])
    for booking, email in list_all_bookings(db):
        writer.writerow(
            [booking.id, email, booking.booking_type, booking.item_id, booking.status, booking.total_price, booking.travel_date, booking.created_at]
        )
    return buf.getvalue()


def export_payments_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "user_email", "amount", "method", "status", "transaction_ref", "created_at"])
    for payment, email in list_all_payments(db):
        writer.writerow([payment.id, email, payment.amount, payment.method, payment.status, payment.transaction_ref, payment.created_at])
    return buf.getvalue()


def export_flights_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "airline", "from_airport", "to_airport", "departure_time", "arrival_time", "cabin_class", "price", "seats_available", "created_at"])
    for f in db.scalars(select(Flight).order_by(Flight.id)).all():
        writer.writerow([f.id, f.airline, f.from_airport, f.to_airport, f.departure_time, f.arrival_time, f.cabin_class, f.price, f.seats_available, f.created_at])
    return buf.getvalue()


def export_hotels_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "name", "location", "price_per_night", "rating", "amenities", "rooms_available", "created_at"])
    for h in db.scalars(select(Hotel).order_by(Hotel.id)).all():
        writer.writerow([h.id, h.name, h.location, h.price_per_night, h.rating, h.amenities, h.rooms_available, h.created_at])
    return buf.getvalue()


def export_cruises_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "name", "cruise_type", "departure_port", "duration_days", "price", "departure_month", "created_at"])
    for c in db.scalars(select(Cruise).order_by(Cruise.id)).all():
        writer.writerow([c.id, c.name, c.cruise_type, c.departure_port, c.duration_days, c.price, c.departure_month, c.created_at])
    return buf.getvalue()


def export_packages_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "title", "package_type", "duration_days", "price", "rating", "description", "available_month", "created_at"])
    for p in db.scalars(select(TourPackage).order_by(TourPackage.id)).all():
        writer.writerow([p.id, p.title, p.package_type, p.duration_days, p.price, p.rating, p.description, p.available_month, p.created_at])
    return buf.getvalue()


def export_contact_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "name", "email", "phone", "subject", "message", "created_at"])
    for c in list_contact_messages(db):
        writer.writerow([c.id, c.name, c.email, c.phone, c.subject, c.message, c.created_at])
    return buf.getvalue()
