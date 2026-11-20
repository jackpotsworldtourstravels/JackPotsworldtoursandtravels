"""Admin Portal operations — Approval Queue, Payment Management, Active Users, Communication
(API_CONTRACT.md §4.1-§4.4, Phase 3).
"""
import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import Payment, PaymentStatus, ServiceRequest, User, UserRole, UserStatus
from app.schemas.accounts import AccountResponse
from app.schemas.admin_ops import (
    ApprovalQueueItemResponse,
    BroadcastRequest,
    BroadcastResponse,
    CommunicationSettingsResponse,
    RefundRequest,
    UpdateCommunicationSettingsRequest,
)
from app.schemas.pagination import Page
from app.schemas.ticket import PaymentSummary
from app.services import (
    account_service,
    activity_service,
    approval_service,
    communication_service,
    session_service,
    ticket_service,
)

router = APIRouter(prefix="/api/admin", tags=["admin · operations"])


# ---------------------------------------------------------------------------
# Approval Queue (§4.2)
# ---------------------------------------------------------------------------
@router.get(
    "/approval-queue",
    response_model=Page[ApprovalQueueItemResponse],
    summary="Unified Approval Queue",
    description=(
        "Requires `merchant.view` or `ticket.view`. Merged, filterable list of pending "
        "merchant approvals and pending ticket/service requests — one table, not two screens."
    ),
)
def approval_queue(
    status: str | None = None,
    merchant_id: int | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    request_type: str | None = None,
    priority: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_VIEW, P.TICKET_VIEW)),
):
    items, total = approval_service.list_approval_queue(
        db, current_user, status=status, merchant_id=merchant_id, date_from=date_from,
        date_to=date_to, request_type=request_type, priority=priority,
        page=page, page_size=page_size,
    )
    return Page.build(
        [ApprovalQueueItemResponse(**i) for i in items], total, page, page_size
    )


# ---------------------------------------------------------------------------
# Payment Management (§4.3)
# ---------------------------------------------------------------------------
@router.get(
    "/payments",
    response_model=Page[PaymentSummary],
    summary="Payment Management — full payment list",
    description=(
        "Requires `payment.view`. Every payment platform-wide, filterable by status/merchant/"
        "date/transaction id. `GET /api/admin/payments/pending` remains the dedicated "
        "verification-queue view; this is the general list (also serves Payment History with "
        "a status filter)."
    ),
)
def list_payments(
    status: PaymentStatus | None = None,
    merchant_id: int | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VIEW)),
):
    from sqlalchemy import func, or_

    conditions = []
    if status is not None:
        conditions.append(Payment.payment_status == status)
    if merchant_id is not None:
        conditions.append(Payment.merchant_id == merchant_id)
    if date_from is not None:
        conditions.append(Payment.created_at >= date_from)
    if date_to is not None:
        conditions.append(Payment.created_at <= date_to)
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(Payment.transaction_id.ilike(pattern), Payment.payment_method.ilike(pattern)))
    where = conditions or [True]

    total = db.scalar(select(func.count()).select_from(Payment).where(*where)) or 0
    rows = db.scalars(
        select(Payment)
        # PaymentSummary reads the booking and its merchant for every row; without
        # this that is two extra queries per payment on a cross-merchant listing.
        .options(selectinload(Payment.request).selectinload(ServiceRequest.merchant))
        .where(*where)
        .order_by(Payment.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return Page.build([PaymentSummary.of(p) for p in rows], total, page, page_size)


@router.post(
    "/payments/{payment_id}/refund",
    response_model=PaymentSummary,
    summary="Refund a payment",
    description="Requires `payment.manage`. Full or partial refund against a successful payment.",
)
def refund_payment(
    payment_id: int,
    payload: RefundRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_MANAGE)),
):
    payment = ticket_service.refund_payment(
        db, current_user, payment_id, amount=payload.amount, reason=payload.reason
    )
    return PaymentSummary.of(payment)


# ---------------------------------------------------------------------------
# Active Users (§4.1)
# ---------------------------------------------------------------------------
@router.get(
    "/users",
    response_model=Page[AccountResponse],
    summary="Active Users — cross-merchant user list",
    description=(
        "Requires `merchant_user.manage`. Filterable by status, role, merchant, search and "
        "**presence** — `online`, `offline` or `never_logged_in`. Every row carries the "
        "connection its most recent session came from: IP, device, browser, OS and the times "
        "it started and was last seen. An account that has never signed in reports "
        "`presence=never_logged_in` and nulls throughout, rather than empty strings."
    ),
)
def list_active_users(
    status: UserStatus | None = None,
    role: UserRole | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    presence: Literal["online", "offline", "never_logged_in"] | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    users, total = account_service.list_all_users(
        db, page, page_size, status=status, role=role, merchant_id=merchant_id,
        search=search, presence=presence,
    )
    # Two queries for the whole page rather than two per row: the live-heartbeat
    # set and the newest session per user, both keyed by the ids we already have.
    user_ids = [u.user_id for u in users]
    online_ids = session_service.online_user_ids(db, user_ids)
    sessions = session_service.latest_sessions(db, user_ids)
    return Page.build(
        [
            AccountResponse.of(
                u,
                online=u.user_id in online_ids,
                session=sessions.get(u.user_id),
                presence=session_service.presence_of(u, sessions.get(u.user_id)),
            )
            for u in users
        ],
        total, page, page_size,
    )


# ---------------------------------------------------------------------------
# Communication (§4.4)
# ---------------------------------------------------------------------------
@router.get(
    "/communication-settings/{merchant_id}",
    response_model=CommunicationSettingsResponse,
    summary="Get a merchant's communication settings",
    description="Requires `notification.send`.",
)
def get_communication_settings(
    merchant_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.NOTIFICATION_SEND)),
):
    return CommunicationSettingsResponse.of(communication_service.get_settings(db, merchant_id))


@router.put(
    "/communication-settings/{merchant_id}",
    response_model=CommunicationSettingsResponse,
    summary="Update a merchant's communication settings",
    description="Requires `notification.send`. Only the fields present in the body are changed.",
)
def update_communication_settings(
    merchant_id: int,
    payload: UpdateCommunicationSettingsRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.NOTIFICATION_SEND)),
):
    fields = payload.model_dump(exclude_unset=True)
    settings = communication_service.update_settings(db, merchant_id, **fields)
    # Switching a merchant's email / notifications off changes who is told what, so it leaves an actor-attributed
    # trail like every other admin write. Only the NAMES of the fields that changed are recorded.
    changed = sorted(k for k, v in fields.items() if v is not None)
    if changed:
        meta = activity_service.request_context(request)
        activity_service.log_activity(
            db, user.user_id, "Communication settings updated", meta["ip_address"],
            activity_type="Update", module="Communication",
            description=f"{user.full_name} changed communication settings ({', '.join(changed)}) for merchant {merchant_id}",
            browser=meta["browser"], device=meta["device"], reference_id=merchant_id, merchant_id=merchant_id,
            details={"changed_fields": changed},
        )
        db.commit()
    return CommunicationSettingsResponse.of(settings)


@router.post(
    "/notifications/broadcast",
    response_model=BroadcastResponse,
    summary="Broadcast a notification",
    description=(
        "Requires `notification.send`. Audience is explicit: `send_to_all=true` reaches every "
        "active merchant; otherwise `merchant_ids` must list at least one existing, active "
        "merchant (an empty/missing list is rejected, never read as everyone; unknown or "
        "inactive ids return 400 and nothing is sent). A merchant with notifications "
        "disabled in its communication settings is skipped, not force-sent."
    ),
)
def broadcast_notification(
    payload: BroadcastRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.NOTIFICATION_SEND)),
):
    sent, skipped, failed = communication_service.broadcast(
        db, payload.send_to_all, payload.merchant_ids, payload.title, payload.message
    )
    # Actor-attributed System Log for a sensitive mass action. The notifications
    # themselves were already committed per recipient inside broadcast(); this
    # records WHO sent them, to WHAT scope, with WHAT result. CONTENT-FREE: only
    # the recipient scope, the (sent, skipped) counts and the title/message
    # LENGTHS are stored — never the title, the message body or any recipient.
    scope = (
        "all active merchants" if payload.send_to_all
        else f"{len(payload.merchant_ids)} selected merchant(s)"
    )
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Notification broadcast", meta["ip_address"],
        activity_type="Create", module="Notifications",
        description=(
            f"{user.full_name} broadcast a notification to {scope} — "
            f"sent {sent}, skipped {skipped}, failed {failed}"
        ),
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
        details={
            "recipient_scope": "all" if payload.send_to_all else "selected",
            "merchant_count": None if payload.send_to_all else len(payload.merchant_ids),
            "sent": sent,
            "skipped": skipped,
            "failed": failed,
            "title_length": len(payload.title),
            "message_length": len(payload.message),
        },
    )
    db.commit()
    return BroadcastResponse(sent=sent, skipped=skipped, failed=failed)
