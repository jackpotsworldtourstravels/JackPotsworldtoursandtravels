import datetime

from fastapi import HTTPException, status
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models.booking import Booking, Payment
from app.models.misc import ActivityLog, Review, SupportTicket, UserSession, Wishlist
from app.models.user import Role, User
from app.services import auth_service, catalog_items, email_service, session_service
from app.services.session_service import ONLINE_THRESHOLD_MINUTES

_SORT_MAP = {
    "newest": lambda b, p, a: User.created_at.desc(),
    "oldest": lambda b, p, a: User.created_at.asc(),
    "most_bookings": lambda b, p, a: func.coalesce(b.c.total_bookings, 0).desc(),
    "highest_spending": lambda b, p, a: func.coalesce(b.c.total_spend, 0).desc(),
    "most_active": lambda b, p, a: func.coalesce(a.c.activity_count, 0).desc(),
}


def _online_cutoff() -> datetime.datetime:
    return datetime.datetime.utcnow() - datetime.timedelta(minutes=ONLINE_THRESHOLD_MINUTES)


def _booking_agg_subquery():
    return (
        select(
            Booking.user_id.label("user_id"),
            func.count().label("total_bookings"),
            func.coalesce(
                func.sum(case((Booking.status != "cancelled", Booking.total_price), else_=0)), 0
            ).label("total_spend"),
        )
        .group_by(Booking.user_id)
        .subquery()
    )


def _payment_agg_subquery():
    return (
        select(
            Payment.user_id.label("user_id"),
            func.count().label("total_payments"),
        )
        .where(Payment.status == "success")
        .group_by(Payment.user_id)
        .subquery()
    )


def _activity_agg_subquery():
    return (
        select(
            ActivityLog.user_id.label("user_id"),
            func.count().label("activity_count"),
        )
        .where(ActivityLog.user_id.is_not(None))
        .group_by(ActivityLog.user_id)
        .subquery()
    )


def _session_agg_subquery():
    return (
        select(
            UserSession.user_id.label("user_id"),
            func.max(UserSession.last_seen_at).label("last_seen"),
        )
        .where(UserSession.is_active.is_(True), UserSession.last_seen_at >= _online_cutoff())
        .group_by(UserSession.user_id)
        .subquery()
    )


def list_customers_paginated(
    db: Session,
    page: int,
    page_size: int,
    search: str | None = None,
    status_filter: str | None = None,
    sort: str = "newest",
):
    b = _booking_agg_subquery()
    p = _payment_agg_subquery()
    a = _activity_agg_subquery()
    s = _session_agg_subquery()

    base = (
        select(User, b.c.total_bookings, b.c.total_spend, p.c.total_payments, s.c.last_seen)
        .join(Role, User.role_id == Role.id)
        .where(Role.name == "user")
        .outerjoin(b, b.c.user_id == User.id)
        .outerjoin(p, p.c.user_id == User.id)
        .outerjoin(a, a.c.user_id == User.id)
        .outerjoin(s, s.c.user_id == User.id)
    )

    if status_filter == "deleted":
        base = base.where(User.is_deleted.is_(True))
    else:
        base = base.where(User.is_deleted.is_(False))

    if search:
        pattern = f"%{search}%"
        conditions = [User.full_name.ilike(pattern), User.email.ilike(pattern), User.mobile.ilike(pattern)]
        if search.isdigit():
            conditions.append(User.id == int(search))
        base = base.where(or_(*conditions))

    if status_filter == "online":
        base = base.where(s.c.last_seen.is_not(None))
    elif status_filter == "offline":
        base = base.where(s.c.last_seen.is_(None))
    elif status_filter == "active":
        base = base.where(User.is_active.is_(True))
    elif status_filter == "inactive":
        base = base.where(User.is_active.is_(False))
    elif status_filter == "blocked":
        base = base.where(User.is_blocked.is_(True))
    elif status_filter == "verified":
        base = base.where(User.is_verified.is_(True))
    elif status_filter == "unverified":
        base = base.where(User.is_verified.is_(False))

    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0

    order_by = _SORT_MAP.get(sort, _SORT_MAP["newest"])(b, p, a)
    stmt = base.order_by(order_by).limit(page_size).offset((page - 1) * page_size)

    rows = db.execute(stmt).all()
    items = []
    for user, total_bookings, total_spend, total_payments, last_seen in rows:
        spend = float(total_spend or 0)
        items.append(
            {
                "id": user.id,
                "full_name": user.full_name,
                "email": user.email,
                "mobile": user.mobile,
                "profile_photo": user.profile_photo,
                "created_at": user.created_at,
                "last_login_at": user.last_login_at,
                "login_count": user.login_count,
                "total_bookings": total_bookings or 0,
                "total_payments": total_payments or 0,
                "total_spend": spend,
                "reward_points": int(spend // 100),
                "is_active": user.is_active,
                "is_blocked": user.is_blocked,
                "is_verified": user.is_verified,
                "is_deleted": user.is_deleted,
                "is_online": last_seen is not None,
            }
        )
    return items, total


def get_customer_stats(db: Session) -> dict:
    b = _booking_agg_subquery()
    p = _payment_agg_subquery()
    a = _activity_agg_subquery()
    s = _session_agg_subquery()
    customer_ids = select(User.id).join(Role, User.role_id == Role.id).where(Role.name == "user", User.is_deleted.is_(False))

    total_customers = db.scalar(select(func.count()).select_from(customer_ids.subquery())) or 0
    online_customers = db.scalar(
        select(func.count(func.distinct(s.c.user_id))).select_from(s).where(s.c.user_id.in_(customer_ids))
    ) or 0
    blocked_customers = db.scalar(
        select(func.count()).select_from(User).join(Role, User.role_id == Role.id).where(
            Role.name == "user", User.is_blocked.is_(True), User.is_deleted.is_(False)
        )
    ) or 0
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    new_today = db.scalar(
        select(func.count()).select_from(User).join(Role, User.role_id == Role.id).where(
            Role.name == "user", User.created_at >= today_start
        )
    ) or 0

    most_active_row = db.execute(
        select(User.full_name)
        .join(a, a.c.user_id == User.id)
        .join(Role, User.role_id == Role.id)
        .where(Role.name == "user", User.is_deleted.is_(False))
        .order_by(a.c.activity_count.desc())
        .limit(1)
    ).first()
    highest_spender_row = db.execute(
        select(User.full_name)
        .join(b, b.c.user_id == User.id)
        .join(Role, User.role_id == Role.id)
        .where(Role.name == "user", User.is_deleted.is_(False))
        .order_by(b.c.total_spend.desc())
        .limit(1)
    ).first()

    return {
        "total_customers": total_customers,
        "online_customers": online_customers,
        "blocked_customers": blocked_customers,
        "new_customers_today": new_today,
        "most_active_customer": most_active_row[0] if most_active_row else None,
        "highest_spending_customer": highest_spender_row[0] if highest_spender_row else None,
    }


def get_customer_or_404(db: Session, customer_id: int) -> User:
    user = db.scalar(select(User).join(Role, User.role_id == Role.id).where(User.id == customer_id, Role.name == "user"))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return user


def get_customer_profile(db: Session, customer_id: int) -> dict:
    user = get_customer_or_404(db, customer_id)

    bookings = db.scalars(select(Booking).where(Booking.user_id == customer_id).order_by(Booking.created_at.desc())).all()
    payments = db.scalars(select(Payment).where(Payment.user_id == customer_id).order_by(Payment.created_at.desc())).all()
    payment_status_by_booking = {pay.booking_id: pay.status for pay in payments}

    booking_out = [
        {
            "id": bk.id,
            "booking_type": bk.booking_type,
            "destination": catalog_items.item_display_name(db, bk.booking_type, bk.item_id),
            "travel_date": bk.travel_date,
            "total_price": float(bk.total_price),
            "status": bk.status,
            "payment_status": payment_status_by_booking.get(bk.id),
        }
        for bk in bookings
    ]
    payment_out = [
        {
            "id": pay.id,
            "transaction_ref": pay.transaction_ref,
            "amount": float(pay.amount),
            "method": pay.method,
            "status": pay.status,
            "created_at": pay.created_at,
        }
        for pay in payments
    ]

    timeline_rows = db.scalars(
        select(ActivityLog).where(ActivityLog.user_id == customer_id).order_by(ActivityLog.created_at.desc()).limit(100)
    ).all()
    timeline_out = [
        {
            "activity_type": t.activity_type,
            "description": t.description or t.action,
            "module": t.module,
            "status": t.status,
            "created_at": t.created_at,
        }
        for t in timeline_rows
    ]

    tickets = db.scalars(
        select(SupportTicket).where(SupportTicket.user_id == customer_id).order_by(SupportTicket.created_at.desc())
    ).all()
    ticket_out = [
        {
            "id": t.id, "subject": t.subject, "priority": t.priority, "status": t.status,
            "created_at": t.created_at, "resolved_at": t.resolved_at,
        }
        for t in tickets
    ]

    reviews = db.scalars(select(Review).where(Review.user_id == customer_id).order_by(Review.created_at.desc())).all()
    review_out = [
        {
            "id": r.id, "item_type": r.item_type, "item_id": r.item_id,
            "destination": catalog_items.item_display_name(db, r.item_type, r.item_id),
            "rating": r.rating, "comment": r.comment, "created_at": r.created_at,
        }
        for r in reviews
    ]

    wishlist = db.scalars(select(Wishlist).where(Wishlist.user_id == customer_id).order_by(Wishlist.created_at.desc())).all()
    wishlist_out = [
        {
            "id": w.id, "item_type": w.item_type, "item_id": w.item_id,
            "destination": catalog_items.item_display_name(db, w.item_type, w.item_id),
            "created_at": w.created_at,
        }
        for w in wishlist
    ]

    non_cancelled = [bk for bk in bookings if bk.status != "cancelled"]
    total_spending = sum(float(bk.total_price) for bk in non_cancelled)
    completed_trips = sum(1 for bk in bookings if bk.status == "confirmed")
    cancelled_trips = sum(1 for bk in bookings if bk.status == "cancelled")
    avg_booking_value = (total_spending / len(non_cancelled)) if non_cancelled else 0.0

    def _favorite(booking_type: str) -> str | None:
        counts: dict[int, int] = {}
        for bk in bookings:
            if bk.booking_type == booking_type and bk.status != "cancelled":
                counts[bk.item_id] = counts.get(bk.item_id, 0) + 1
        if not counts:
            return None
        top_item_id = max(counts, key=counts.get)
        return catalog_items.item_display_name(db, booking_type, top_item_id)

    last_activity = timeline_rows[0].created_at if timeline_rows else None

    latest_session = session_service.latest_session(db, customer_id)
    is_online = session_service.is_user_online(db, customer_id)

    return {
        "id": user.id, "full_name": user.full_name, "email": user.email, "mobile": user.mobile,
        "gender": user.gender, "dob": user.dob, "country": user.country, "state": user.state,
        "city": user.city, "address": user.address, "profile_photo": user.profile_photo,
        "created_at": user.created_at, "last_login_at": user.last_login_at, "login_count": user.login_count,
        "is_active": user.is_active, "is_blocked": user.is_blocked, "is_verified": user.is_verified,
        "is_deleted": user.is_deleted,
        "session": {
            "is_online": is_online,
            "current_page": latest_session.current_page if latest_session else None,
            "browser": latest_session.browser if latest_session else None,
            "os": latest_session.os if latest_session else None,
            "device": latest_session.device if latest_session else None,
            "ip_address": latest_session.ip_address if latest_session else None,
            "login_at": latest_session.login_at if latest_session else None,
        },
        "analytics": {
            "total_bookings": len(bookings),
            "completed_trips": completed_trips,
            "cancelled_trips": cancelled_trips,
            "total_spending": total_spending,
            "average_booking_value": round(avg_booking_value, 2),
            "favorite_destination": _favorite("flight"),
            "favorite_hotel": _favorite("hotel"),
            "favorite_cruise": _favorite("cruise"),
            "favorite_package": _favorite("package"),
            "last_activity": last_activity,
        },
        "bookings": booking_out,
        "payments": payment_out,
        "timeline": timeline_out,
        "support_tickets": ticket_out,
        "reviews": review_out,
        "wishlist": wishlist_out,
    }


def update_customer_by_admin(db: Session, customer_id: int, payload) -> User:
    user = get_customer_or_404(db, customer_id)
    existing = db.scalar(select(User).where(User.email == payload.email))
    if existing and existing.id != customer_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")
    user.full_name = payload.full_name
    user.email = payload.email
    user.mobile = payload.mobile
    user.gender = payload.gender
    user.dob = payload.dob
    user.country = payload.country
    user.state = payload.state
    user.city = payload.city
    user.address = payload.address
    if payload.is_verified is not None:
        user.is_verified = payload.is_verified
    db.commit()
    db.refresh(user)
    return user


def set_customer_blocked(db: Session, customer_id: int, is_blocked: bool) -> User:
    user = get_customer_or_404(db, customer_id)
    user.is_blocked = is_blocked
    db.commit()
    db.refresh(user)
    return user


def soft_delete_customer(db: Session, customer_id: int) -> User:
    user = get_customer_or_404(db, customer_id)
    user.is_deleted = True
    user.deleted_at = datetime.datetime.utcnow()
    user.is_active = False
    db.commit()
    db.refresh(user)
    return user


def restore_customer(db: Session, customer_id: int) -> User:
    user = db.get(User, customer_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    user.is_deleted = False
    user.deleted_at = None
    db.commit()
    db.refresh(user)
    return user


def reset_customer_password(db: Session, customer_id: int) -> str | None:
    user = get_customer_or_404(db, customer_id)
    raw_token = auth_service.start_password_reset(db, user.email)
    if raw_token is None:
        return None
    reset_link = f"{settings.frontend_base_url}/reset-password?token={raw_token}"
    email_service.send_password_reset_email(user.email, reset_link, settings.reset_token_expire_minutes)
    return f"/reset-password?token={raw_token}"


def force_logout_customer(db: Session, customer_id: int) -> None:
    user = get_customer_or_404(db, customer_id)
    user.force_logout_at = datetime.datetime.utcnow()
    db.commit()
    session_service.force_logout_all(db, customer_id)
