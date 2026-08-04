"""Dashboard KPIs — one aggregate query per portal (API_CONTRACT.md §6.1).

Merchant only for now (Phase 2). Admin and Super Admin dashboards are the same pattern —
add ``admin_dashboard``/``super_admin_dashboard`` here when those phases are built, rather
than a separate module, so the three stay easy to compare.
"""
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import (
    Merchant,
    MerchantStatus,
    MessageType,
    MsgLog,
    Payment,
    PaymentStatus,
    RequestStatus,
    RequestType,
    ServiceRequest,
    SystemLog,
    User,
    UserRole,
    UserStatus,
)
from app.services import ticket_service

#: Terminal-ish statuses a live chat thread no longer needs attention in.
_CHAT_CLOSED = (RequestStatus.COMPLETED, RequestStatus.REJECTED, RequestStatus.CANCELLED)


def merchant_dashboard(db: Session, actor: User) -> dict:
    merchant = db.get(Merchant, actor.merchant_id)

    status_rows = db.execute(
        select(ServiceRequest.status, func.count())
        .where(ticket_service.scoped_query(actor))
        .group_by(ServiceRequest.status)
    ).all()
    #: Matches RequestsByStatus's fields exactly — SUBMITTED and VERIFIED aren't reachable
    #: states for a merchant's own bookings/service requests (see lifecycle.py) so they're
    #: intentionally not part of this KPI shape.
    requests_by_status = {
        "draft": 0, "pending_approval": 0, "in_review": 0, "approved": 0,
        "payment_pending": 0, "paid": 0, "ticket_issued": 0, "completed": 0,
        "rejected": 0, "cancelled": 0,
    }
    for status_value, count in status_rows:
        if status_value.value in requests_by_status:
            requests_by_status[status_value.value] = count

    pending_payments_count = db.scalar(
        select(func.count())
        .select_from(Payment)
        .where(
            Payment.merchant_id == actor.merchant_id,
            Payment.payment_status == PaymentStatus.PENDING,
        )
    ) or 0

    unread_notifications_count = db.scalar(
        select(func.count())
        .select_from(MsgLog)
        .where(
            MsgLog.user_id == actor.user_id,
            MsgLog.message_type == MessageType.NOTIFICATION,
            MsgLog.is_read.is_(False),
        )
    ) or 0

    open_chat_threads_count = db.scalar(
        select(func.count())
        .select_from(ServiceRequest)
        .where(
            ticket_service.scoped_query(actor),
            ServiceRequest.request_type == RequestType.LIVE_CHAT,
            ServiceRequest.status.notin_(_CHAT_CLOSED),
        )
    ) or 0

    recent = db.scalars(
        select(ServiceRequest)
        .options(selectinload(ServiceRequest.passengers))
        .where(ticket_service.scoped_query(actor))
        .order_by(ServiceRequest.created_at.desc())
        .limit(5)
    ).all()

    return {
        "wallet_balance": merchant.wallet_balance if merchant else 0,
        "credit_limit": merchant.credit_limit if merchant else 0,
        "requests_by_status": requests_by_status,
        "pending_payments_count": pending_payments_count,
        "unread_notifications_count": unread_notifications_count,
        "open_chat_threads_count": open_chat_threads_count,
        "recent_requests": list(recent),
    }


def admin_dashboard(db: Session, actor: User) -> dict:
    """Platform-wide KPIs for the Admin Portal (API_CONTRACT.md §6.1)."""
    import datetime as _dt

    merchant_rows = db.execute(
        select(Merchant.status, func.count()).group_by(Merchant.status)
    ).all()
    merchants = {"total": 0, "pending_approval": 0, "active": 0, "suspended": 0}
    for status_value, count in merchant_rows:
        merchants["total"] += count
        if status_value is MerchantStatus.PENDING_APPROVAL:
            merchants["pending_approval"] = count
        elif status_value is MerchantStatus.ACTIVE:
            merchants["active"] = count
        elif status_value is MerchantStatus.SUSPENDED:
            merchants["suspended"] = count

    # Enquiries are excluded here and counted separately below. They are
    # ``service_requests`` rows too, so before this filter a pending enquiry
    # inflated "Pending Approval" — a number the Admin reads as "bookings
    # awaiting my decision". The two queues have different actions and their
    # own screens, so they get their own counters.
    status_rows = db.execute(
        select(ServiceRequest.status, func.count())
        .where(
            ticket_service.scoped_query(actor),
            ServiceRequest.request_type != RequestType.TICKET_ENQUIRY,
        )
        .group_by(ServiceRequest.status)
    ).all()
    requests_by_status = {
        "draft": 0, "pending_approval": 0, "in_review": 0, "approved": 0,
        "payment_pending": 0, "paid": 0, "ticket_issued": 0, "completed": 0,
        "rejected": 0, "cancelled": 0,
    }
    for status_value, count in status_rows:
        if status_value.value in requests_by_status:
            requests_by_status[status_value.value] = count

    payments_pending_count = db.scalar(
        select(func.count()).select_from(Payment).where(Payment.payment_status == PaymentStatus.PENDING)
    ) or 0

    today_start = _dt.datetime.now(_dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    payments_verified_today = db.scalar(
        select(func.count())
        .select_from(Payment)
        .where(Payment.payment_status == PaymentStatus.SUCCESS, Payment.updated_at >= today_start)
    ) or 0

    open_support_tickets = db.scalar(
        select(func.count())
        .select_from(ServiceRequest)
        .where(
            ServiceRequest.request_type == RequestType.SUPPORT_TICKET,
            ServiceRequest.status.notin_(_CHAT_CLOSED),
        )
    ) or 0

    open_chat_threads = db.scalar(
        select(func.count())
        .select_from(ServiceRequest)
        .where(
            ServiceRequest.request_type == RequestType.LIVE_CHAT,
            ServiceRequest.status.notin_(_CHAT_CLOSED),
        )
    ) or 0

    activity_rows = db.execute(
        select(SystemLog, User.full_name)
        .join(User, SystemLog.user_id == User.user_id, isouter=True)
        .order_by(SystemLog.created_at.desc())
        .limit(5)
    ).all()
    recent_activity = [
        {
            "id": log.log_id, "user_name": full_name, "module": log.module,
            "action": log.action, "description": log.description,
            "created_at": log.created_at.isoformat(),
        }
        for log, full_name in activity_rows
    ]

    # The Ticket Enquiry queue, tracked independently of booking approvals.
    # "Awaiting" is Pending + Under Review — both are still the desk's problem;
    # the split between them is who has picked one up, which the screen shows.
    def _enquiries(*statuses) -> int:
        return db.scalar(
            select(func.count())
            .select_from(ServiceRequest)
            .where(
                ticket_service.scoped_query(actor),
                ServiceRequest.request_type == RequestType.TICKET_ENQUIRY,
                ServiceRequest.status.in_(statuses),
            )
        ) or 0

    enquiries = {
        "pending": _enquiries(RequestStatus.PENDING_APPROVAL),
        "in_review": _enquiries(RequestStatus.IN_REVIEW),
        "awaiting_response": _enquiries(
            RequestStatus.PENDING_APPROVAL, RequestStatus.IN_REVIEW
        ),
        "available": _enquiries(RequestStatus.APPROVED),
        "not_available": _enquiries(RequestStatus.REJECTED),
        "answered_today": db.scalar(
            select(func.count())
            .select_from(ServiceRequest)
            .where(
                ticket_service.scoped_query(actor),
                ServiceRequest.request_type == RequestType.TICKET_ENQUIRY,
                ServiceRequest.status.in_((RequestStatus.APPROVED, RequestStatus.REJECTED)),
                ServiceRequest.updated_at >= today_start,
            )
        ) or 0,
    }

    return {
        "merchants": merchants,
        "requests_by_status": requests_by_status,
        "enquiries": enquiries,
        "payments_pending_count": payments_pending_count,
        "payments_verified_today": payments_verified_today,
        "open_support_tickets": open_support_tickets,
        "open_chat_threads": open_chat_threads,
        "recent_activity": recent_activity,
    }


def super_admin_dashboard(db: Session) -> dict:
    """System-overview KPIs for the Super Admin Portal.

    Deliberately excludes the ticket/payment operational queues that
    ``admin_dashboard`` surfaces — those are Admin's domain per the
    permission matrix (Super Admin holds no ticket/payment permissions at
    all), so putting them here would nudge toward operational involvement
    the spec explicitly denies. What's left is what a Super Admin actually
    oversees: Admins, and the system they run.
    """
    admin_rows = db.execute(
        select(User.status, func.count())
        .where(User.role == UserRole.ADMIN)
        .group_by(User.status)
    ).all()
    admins = {"total": 0, "active": 0, "suspended": 0}
    for status_value, count in admin_rows:
        admins["total"] += count
        if status_value is UserStatus.ACTIVE:
            admins["active"] = count
        elif status_value is UserStatus.SUSPENDED:
            admins["suspended"] = count

    merchant_rows = db.execute(
        select(Merchant.status, func.count()).group_by(Merchant.status)
    ).all()
    merchants = {"total": 0, "pending_approval": 0, "active": 0, "suspended": 0}
    for status_value, count in merchant_rows:
        merchants["total"] += count
        if status_value is MerchantStatus.PENDING_APPROVAL:
            merchants["pending_approval"] = count
        elif status_value is MerchantStatus.ACTIVE:
            merchants["active"] = count
        elif status_value is MerchantStatus.SUSPENDED:
            merchants["suspended"] = count

    total_merchant_users = db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.role.in_((UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER)))
    ) or 0

    open_chat_threads = db.scalar(
        select(func.count())
        .select_from(ServiceRequest)
        .where(
            ServiceRequest.request_type == RequestType.LIVE_CHAT,
            ServiceRequest.status.notin_(_CHAT_CLOSED),
        )
    ) or 0

    schema_version = db.scalar(text("SELECT version_num FROM alembic_version")) or "unknown"

    activity_rows = db.execute(
        select(SystemLog, User.full_name)
        .join(User, SystemLog.user_id == User.user_id, isouter=True)
        .order_by(SystemLog.created_at.desc())
        .limit(5)
    ).all()
    recent_activity = [
        {
            "id": log.log_id, "user_name": full_name, "module": log.module,
            "action": log.action, "description": log.description,
            "created_at": log.created_at.isoformat(),
        }
        for log, full_name in activity_rows
    ]

    return {
        "admins": admins,
        "merchants": merchants,
        "total_merchant_users": total_merchant_users,
        "open_chat_threads": open_chat_threads,
        "schema_version": schema_version,
        "recent_activity": recent_activity,
    }
