import csv
import datetime
import io

from sqlalchemy import func, select
from sqlalchemy.orm import Session

# Catalog tables stay legacy — see booking_service.py's header comment.
from app.models.travel import Cruise, Flight, Hotel, TourPackage
from app.models.target_schema.merchants import Merchant
from app.models.target_schema.payments import Payment
from app.models.target_schema.service_requests import ServiceRequest
from app.models.target_schema.system_logs import SystemLog
from app.models.target_schema.users import User
from app.services.target_schema import service_request_service
from app.services.target_schema.booking_service import ITEM_NAME_FN, ITEM_MODELS

# Frontend-facing keys stay 'flight'/'hotel'/'cruise'/'package' — see
# routers/target_schema/bookings.py for the same translation at the booking-create boundary.
_ITEM_TYPE_OUT = {"flight": "flight", "hotel": "hotel", "cruise": "cruise", "tour_package": "package"}


def _today_start() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def list_all_bookings_paginated(db: Session, page: int, page_size: int):
    stmt = (
        select(ServiceRequest, User.email)
        .join(User, ServiceRequest.user_id == User.id)
        .where(ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer")
        .order_by(ServiceRequest.created_at.desc())
    )
    total = db.scalar(
        select(func.count()).select_from(
            select(ServiceRequest.id).where(
                ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer"
            ).subquery()
        )
    ) or 0
    stmt = stmt.limit(page_size).offset((page - 1) * page_size)
    return db.execute(stmt).all(), total


def list_all_payments_paginated(db: Session, page: int, page_size: int):
    stmt = (
        select(Payment, User.email)
        .join(User, Payment.user_id == User.id)
        .where(Payment.record_type == "transaction")
        .order_by(Payment.created_at.desc())
    )
    total = db.scalar(
        select(func.count()).select_from(
            select(Payment.id).where(Payment.record_type == "transaction").subquery()
        )
    ) or 0
    stmt = stmt.limit(page_size).offset((page - 1) * page_size)
    return db.execute(stmt).all(), total


def update_booking_status(db: Session, booking_id: int, new_status: str) -> tuple[ServiceRequest, str]:
    from app.services.target_schema import booking_service
    booking = service_request_service.get_by_id(db, booking_id)
    was_cancelled = booking.status == "cancelled"
    booking = service_request_service.update_status(db, booking_id, new_status)
    if new_status == "cancelled" and not was_cancelled:
        booking_service.restore_inventory(db, booking.item_type, booking.item_id, booking.quantity)
        booking_service.refund_payment_for_booking(db, booking)
        db.commit()
    email = db.scalar(select(User.email).where(User.id == booking.user_id))
    return booking, email


def list_contact_messages_paginated(db: Session, page: int, page_size: int):
    from app.services.target_schema import msg_log_service
    return msg_log_service.list_by_channel_paginated(db, "contact_form", page, page_size)


def delete_contact_message(db: Session, message_id: int) -> None:
    from app.services.target_schema import msg_log_service
    msg_log_service.admin_delete(db, message_id)


def list_newsletter_subscribers(db: Session):
    from app.models.target_schema.msg_logs import MsgLog
    return db.scalars(
        select(MsgLog).where(MsgLog.channel == "newsletter").order_by(MsgLog.created_at.desc())
    ).all()


def _count_status(db: Session, status_value: str) -> int:
    return db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            ServiceRequest.request_type == "booking", ServiceRequest.status == status_value
        )
    ) or 0


def _top_items(db: Session, item_type: str, limit: int = 5) -> list[dict]:
    rows = db.execute(
        select(
            ServiceRequest.item_id, func.count().label("bookings"),
            func.coalesce(func.sum(ServiceRequest.total_amount), 0).label("revenue"),
        )
        .where(
            ServiceRequest.request_type == "booking", ServiceRequest.item_type == item_type,
            ServiceRequest.status != "cancelled",
        )
        .group_by(ServiceRequest.item_id)
        .order_by(func.count().desc())
        .limit(limit)
    ).all()
    model = ITEM_MODELS[item_type]
    name_fn = ITEM_NAME_FN[item_type]
    results = []
    for item_id, bookings, revenue in rows:
        item = db.get(model, item_id)
        if not item:
            continue
        results.append({
            "item_type": _ITEM_TYPE_OUT[item_type], "item_id": item_id, "name": name_fn(item),
            "bookings": bookings, "revenue": float(revenue),
        })
    return results


def _top_destinations_by_location(db: Session, limit: int = 5) -> list[dict]:
    rows = db.execute(
        select(
            Hotel.location, func.count().label("bookings"),
            func.coalesce(func.sum(ServiceRequest.total_amount), 0).label("revenue"),
        )
        .join(Hotel, ServiceRequest.item_id == Hotel.id)
        .where(
            ServiceRequest.request_type == "booking", ServiceRequest.item_type == "hotel",
            ServiceRequest.status != "cancelled",
        )
        .group_by(Hotel.location)
        .order_by(func.count().desc())
        .limit(limit)
    ).all()
    return [{"name": loc, "bookings": b, "revenue": float(r)} for loc, b, r in rows]


def _most_active_users(db: Session, limit: int = 5) -> list[dict]:
    rows = db.execute(
        select(
            SystemLog.user_id, func.count().label("activity_count"), func.max(SystemLog.created_at).label("last_active"),
        )
        .where(SystemLog.log_type == "activity", SystemLog.user_id.is_not(None))
        .group_by(SystemLog.user_id)
        .order_by(func.count().desc())
        .limit(limit)
    ).all()
    results = []
    for user_id, activity_count, last_active in rows:
        user = db.get(User, user_id)
        if not user:
            continue
        results.append({
            "user_id": user_id, "full_name": user.full_name, "email": user.email,
            "activity_count": activity_count, "last_active": last_active,
        })
    return results


def _merchant_dashboard_stats(db: Session) -> dict:
    total_merchants = db.scalar(select(func.count()).select_from(Merchant)) or 0
    merchants_by_type = {
        (row[0] or "unspecified"): row[1]
        for row in db.execute(select(Merchant.company_type, func.count()).group_by(Merchant.company_type)).all()
    }
    total_merchant_users = db.scalar(
        select(func.count()).select_from(User).where(User.user_type == "merchant_staff")
    ) or 0
    pending_partner_requests = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            ServiceRequest.channel == "merchant", ServiceRequest.request_type == "booking",
            ServiceRequest.status == "pending",
        )
    ) or 0
    active_cancellation_requests = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            ServiceRequest.request_type == "cancellation", ServiceRequest.status.in_(("pending", "approved"))
        )
    ) or 0
    return {
        "total_merchants": total_merchants, "merchants_by_type": merchants_by_type,
        "total_merchant_users": total_merchant_users, "pending_partner_requests": pending_partner_requests,
        "active_cancellation_requests": active_cancellation_requests,
    }


def build_reports(db: Session) -> dict:
    from app.services.target_schema import system_log_service

    total_users = db.scalar(select(func.count()).select_from(User).where(User.user_type == "customer")) or 0
    active_users = db.scalar(
        select(func.count()).select_from(User).where(User.user_type == "customer", User.status == "active")
    ) or 0
    total_bookings = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer"
        )
    ) or 0
    total_revenue = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0)).where(
            Payment.record_type == "transaction", Payment.status == "success"
        )
    ) or 0
    rows = db.execute(
        select(ServiceRequest.item_type, func.count())
        .where(ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer")
        .group_by(ServiceRequest.item_type)
    ).all()
    bookings_by_type = {_ITEM_TYPE_OUT.get(row[0], row[0]): row[1] for row in rows if row[0]}
    payments_by_status = {
        row[0]: row[1] for row in db.execute(
            select(Payment.status, func.count()).where(Payment.record_type == "transaction").group_by(Payment.status)
        ).all()
    }
    newsletter_subscribers = len(list_newsletter_subscribers(db))
    contact_messages = list_contact_messages_paginated(db, 1, 1)[1]

    recent_users = db.scalars(
        select(User).where(User.user_type == "customer").order_by(User.created_at.desc()).limit(5)
    ).all()
    recent_bookings = [
        {
            "id": b.id, "user_email": email, "booking_type": _ITEM_TYPE_OUT.get(b.item_type, b.item_type),
            "total_price": float(b.total_amount or 0), "status": b.status, "created_at": b.created_at,
        }
        for b, email in db.execute(
            select(ServiceRequest, User.email).join(User, ServiceRequest.user_id == User.id)
            .where(ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer")
            .order_by(ServiceRequest.created_at.desc()).limit(5)
        ).all()
    ]
    recent_payments = [
        {"id": p.id, "user_email": email, "amount": float(p.amount or 0), "status": p.status, "created_at": p.created_at}
        for p, email in db.execute(
            select(Payment, User.email).join(User, Payment.user_id == User.id)
            .where(Payment.record_type == "transaction")
            .order_by(Payment.created_at.desc()).limit(5)
        ).all()
    ]

    today_start = _today_start()
    today_users = db.scalar(
        select(func.count()).select_from(User).where(User.user_type == "customer", User.created_at >= today_start)
    ) or 0
    today_bookings = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer",
            ServiceRequest.created_at >= today_start,
        )
    ) or 0
    today_revenue = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0)).where(
            Payment.record_type == "transaction", Payment.status == "success", Payment.created_at >= today_start
        )
    ) or 0
    today_payments = db.scalar(
        select(func.count()).select_from(Payment).where(
            Payment.record_type == "transaction", Payment.created_at >= today_start
        )
    ) or 0

    return {
        "total_users": total_users, "active_users": active_users, "total_bookings": total_bookings,
        "total_revenue": float(total_revenue), "bookings_by_type": bookings_by_type,
        "newsletter_subscribers": newsletter_subscribers, "contact_messages": contact_messages,
        "total_flights": db.scalar(select(func.count()).select_from(Flight)) or 0,
        "total_hotels": db.scalar(select(func.count()).select_from(Hotel)) or 0,
        "total_cruises": db.scalar(select(func.count()).select_from(Cruise)) or 0,
        "total_packages": db.scalar(select(func.count()).select_from(TourPackage)) or 0,
        "pending_bookings": _count_status(db, "pending"), "confirmed_bookings": _count_status(db, "confirmed"),
        "completed_bookings": _count_status(db, "completed"), "cancelled_bookings": _count_status(db, "cancelled"),
        "payments_by_status": payments_by_status,
        "recent_users": recent_users, "recent_bookings": recent_bookings, "recent_payments": recent_payments,
        "today_users": today_users, "today_logins": 0, "today_bookings": today_bookings,
        "today_revenue": float(today_revenue), "today_payments": today_payments,
        "users_online": 0, "active_sessions": 0,
        "top_destinations": _top_destinations_by_location(db),
        "top_flights": _top_items(db, "flight"), "top_hotels": _top_items(db, "hotel"),
        "top_cruises": _top_items(db, "cruise"), "top_packages": _top_items(db, "tour_package"),
        "most_active_users": _most_active_users(db),
        **_merchant_dashboard_stats(db),
    }


def monthly_stats(db: Session) -> list[dict]:
    revenue_rows = db.execute(
        select(func.to_char(Payment.created_at, "YYYY-MM").label("month"), func.coalesce(func.sum(Payment.amount), 0).label("revenue"))
        .where(Payment.record_type == "transaction", Payment.status == "success")
        .group_by("month")
    ).all()
    booking_rows = db.execute(
        select(func.to_char(ServiceRequest.created_at, "YYYY-MM").label("month"), func.count().label("bookings"))
        .where(ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer")
        .group_by("month")
    ).all()
    revenue_map = {row.month: float(row.revenue) for row in revenue_rows}
    bookings_map = {row.month: row.bookings for row in booking_rows}
    months = sorted(set(revenue_map) | set(bookings_map))
    return [{"month": m, "revenue": revenue_map.get(m, 0.0), "bookings": bookings_map.get(m, 0)} for m in months]


def export_bookings_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "user_email", "booking_type", "item_id", "status", "total_price", "travel_date", "created_at"])
    stmt = (
        select(ServiceRequest, User.email).join(User, ServiceRequest.user_id == User.id)
        .where(ServiceRequest.request_type == "booking", ServiceRequest.channel == "customer")
        .order_by(ServiceRequest.created_at.desc())
    )
    for b, email in db.execute(stmt).all():
        writer.writerow([
            b.id, email, _ITEM_TYPE_OUT.get(b.item_type, b.item_type), b.item_id, b.status,
            b.total_amount, b.departure_date, b.created_at,
        ])
    return buf.getvalue()


def export_payments_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "user_email", "amount", "method", "status", "transaction_ref", "created_at"])
    stmt = (
        select(Payment, User.email).join(User, Payment.user_id == User.id)
        .where(Payment.record_type == "transaction").order_by(Payment.created_at.desc())
    )
    for p, email in db.execute(stmt).all():
        writer.writerow([p.id, email, p.amount, p.method, p.status, p.transaction_ref, p.created_at])
    return buf.getvalue()


def export_users_csv(db: Session) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "full_name", "email", "user_type", "status", "created_at"])
    for u in db.scalars(select(User).where(User.user_type == "customer").order_by(User.created_at.desc())).all():
        writer.writerow([u.id, u.full_name, u.email, u.user_type, u.status, u.created_at])
    return buf.getvalue()


def export_contact_csv(db: Session) -> str:
    from app.models.target_schema.msg_logs import MsgLog
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "email", "subject", "message", "created_at"])
    for m in db.scalars(select(MsgLog).where(MsgLog.channel == "contact_form").order_by(MsgLog.created_at.desc())).all():
        writer.writerow([m.id, m.recipient_email, m.subject, m.message, m.created_at])
    return buf.getvalue()


CSV_EXPORTERS = {
    "users": export_users_csv, "bookings": export_bookings_csv, "payments": export_payments_csv,
    "contact": export_contact_csv,
}
