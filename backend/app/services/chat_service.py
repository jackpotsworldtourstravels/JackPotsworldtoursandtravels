"""Support Management / Live Chat.

Kept in a module named for the file the earlier phase plan pointed at
(``support_tickets.py``), but what it implements is the spec's Live Chat
flow — there is no separate "raise a ticket" step in the approved spec's
Merchant flow, only "Live Chat":

    Merchant: Open Chat -> Admin Receives -> Conversation -> Resolved -> Close Ticket

Admin's "Support Management" nav item is the admin-side queue over these
same threads, not a second workflow — it lists every thread across every
merchant so Admin can triage, and "Live Chat" is the conversation view for
one thread at a time.

One conversation is one ``service_requests`` row
(``request_type='live_chat'``). Messages are ``msg_logs`` rows
(``message_type='live_chat'``) — the schema's own docstrings already name
Live Chat as one of the things ``msg_logs`` absorbs, so this needed no
migration.

Status machine (deliberately not routed through ``lifecycle.transition`` —
that module's edges are booking-specific and do not apply here):

    SUBMITTED (open) -> IN_REVIEW (claimed / being worked) -> COMPLETED (resolved & closed)

Permission mapping, matching the spec's Chat Support row (View / Manage / Create):

    merchant     -> chat.create, chat.view   (open + reply on its own threads)
    admin        -> chat.manage, chat.view, support.manage (respond, resolve, queue)
    super_admin  -> chat.view only            (visibility, cannot participate)
"""
import datetime

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_permission
from app.models_v2 import (
    MessageStatus,
    MessageType,
    MsgLog,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    User,
)
from app.services import activity_service, notification_service

_OPEN_STATUSES = (S.SUBMITTED, S.IN_REVIEW)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _next_number(db: Session) -> str:
    # Shares the service-request sequence rather than allocating a new
    # PostgreSQL sequence for a fourth document prefix — chat threads are not
    # numbered documents anyone reconciles against, just a human-readable id.
    number = db.scalar(select(func.nextval("seq_service_request_number")))
    return f"CHT-{_now().year}-{number:06d}"


def _record_status(request: ServiceRequest, to: S, actor: User, label: str) -> None:
    request.status_history = list(request.status_history or []) + [
        {
            "from": request.status.value,
            "to": to.value,
            "label": label,
            "by": actor.user_id,
            "by_name": actor.full_name,
            "at": _now().isoformat(),
        }
    ]
    request.status = to


def scoped_query(actor: User):
    conditions = [ServiceRequest.request_type == RequestType.LIVE_CHAT]
    if not actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == actor.merchant_id)
    return and_(*conditions)


def open_thread(db: Session, actor: User, subject: str, message: str) -> ServiceRequest:
    if actor.merchant_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only merchant accounts can open a chat",
        )
    thread = ServiceRequest(
        request_number=_next_number(db),
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.LIVE_CHAT,
        status=S.SUBMITTED,
        title=subject or "Support chat",
        status_history=[
            {
                "from": None,
                "to": S.SUBMITTED.value,
                "label": "Chat opened",
                "by": actor.user_id,
                "by_name": actor.full_name,
                "at": _now().isoformat(),
            }
        ],
    )
    db.add(thread)
    db.flush()

    db.add(
        MsgLog(
            merchant_id=actor.merchant_id,
            user_id=actor.user_id,
            request_id=thread.request_id,
            message_type=MessageType.LIVE_CHAT,
            direction="inbound",
            sender_name=actor.full_name,
            sender_email=actor.email,
            recipient="support",
            message=message,
            status=MessageStatus.DELIVERED,
            sent_time=_now(),
            delivered_time=_now(),
        )
    )
    db.commit()
    db.refresh(thread)

    activity_service.log_activity(
        db, actor.user_id, "Chat opened",
        activity_type="Support", module="Live Chat",
        description=f"{actor.full_name} opened a chat: {subject}",
        reference_id=thread.request_id, merchant_id=actor.merchant_id,
    )
    notification_service.notify_admins(
        db, "New support chat",
        f"{actor.full_name} ({thread.merchant.company_name if thread.merchant else 'merchant'}) "
        f"opened a chat: {subject}",
    )
    return thread


def list_threads(
    db: Session, actor: User, *, thread_status: S | None = None, page: int = 1, page_size: int = 20
) -> tuple[list[ServiceRequest], int]:
    conditions = [scoped_query(actor)]
    if thread_status is not None:
        conditions.append(ServiceRequest.status == thread_status)
    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    stmt = (
        select(ServiceRequest)
        .where(where)
        .order_by(ServiceRequest.updated_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def get_thread(db: Session, actor: User, thread_id: int) -> ServiceRequest:
    thread = db.scalars(
        select(ServiceRequest).where(
            and_(ServiceRequest.request_id == thread_id, scoped_query(actor))
        )
    ).first()
    if not thread:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return thread


def list_messages(db: Session, thread: ServiceRequest) -> list[MsgLog]:
    stmt = (
        select(MsgLog)
        .where(
            and_(MsgLog.request_id == thread.request_id, MsgLog.message_type == MessageType.LIVE_CHAT)
        )
        .order_by(MsgLog.created_at.asc())
    )
    return list(db.scalars(stmt).all())


def unread_thread_count(db: Session, actor: User) -> int:
    """Open threads awaiting a response — drives a badge on the nav item."""
    where = and_(scoped_query(actor), ServiceRequest.status.in_(_OPEN_STATUSES))
    return db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0


def send_message(db: Session, actor: User, thread_id: int, message: str) -> MsgLog:
    thread = get_thread(db, actor, thread_id)
    if thread.status is S.COMPLETED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="This chat is closed — open a new one to keep talking.",
        )

    is_admin_side = actor.is_platform_staff
    if is_admin_side and not has_permission(actor, P.CHAT_MANAGE):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail=f"Missing required permission: {P.CHAT_MANAGE}",
        )
    if not is_admin_side and not has_permission(actor, P.CHAT_CREATE):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail=f"Missing required permission: {P.CHAT_CREATE}",
        )

    row = MsgLog(
        merchant_id=thread.merchant_id,
        user_id=actor.user_id,
        request_id=thread.request_id,
        message_type=MessageType.LIVE_CHAT,
        direction="outbound" if is_admin_side else "inbound",
        sender_name=actor.full_name,
        sender_email=actor.email,
        recipient="admin" if not is_admin_side else "merchant",
        message=message,
        status=MessageStatus.DELIVERED,
        sent_time=_now(),
        delivered_time=_now(),
    )
    db.add(row)

    # First admin reply auto-claims and moves the thread out of the open queue.
    if is_admin_side and thread.status is S.SUBMITTED:
        thread.assigned_admin = actor.user_id
        _record_status(thread, S.IN_REVIEW, actor, "Admin joined the conversation")
    else:
        thread.updated_at = _now()

    db.commit()
    db.refresh(row)

    if not is_admin_side:
        notification_service.notify_admins(
            db, "New chat message", f"{actor.full_name}: {message[:120]}"
        )
    elif thread.user_id:
        notification_service.create_notification(
            db, thread.user_id, "New reply on your chat", f"{actor.full_name}: {message[:120]}"
        )
    return row


def claim_thread(db: Session, actor: User, thread_id: int) -> ServiceRequest:
    thread = get_thread(db, actor, thread_id)
    if thread.status is not S.SUBMITTED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Chat is already {thread.status.value}",
        )
    thread.assigned_admin = actor.user_id
    _record_status(thread, S.IN_REVIEW, actor, "Claimed by admin")
    db.commit()
    db.refresh(thread)
    return thread


def resolve_thread(db: Session, actor: User, thread_id: int) -> ServiceRequest:
    thread = get_thread(db, actor, thread_id)
    if thread.status is S.COMPLETED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Chat is already resolved"
        )
    _record_status(thread, S.COMPLETED, actor, "Resolved and closed")
    thread.completed_at = _now()
    thread.resolved_at = _now()
    db.commit()
    db.refresh(thread)
    if thread.user_id:
        notification_service.create_notification(
            db, thread.user_id, "Your chat was resolved",
            f"{thread.title} has been marked resolved and closed by our support team.",
        )
    return thread
