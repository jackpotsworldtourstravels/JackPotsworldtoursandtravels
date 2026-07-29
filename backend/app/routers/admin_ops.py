"""Admin Portal operations — Approval Queue, Payment Management, Active Users, Communication
(API_CONTRACT.md §4.1-§4.4, Phase 3).
"""
import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import Payment, PaymentStatus, User, UserRole, UserStatus
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
    description="Requires `merchant_user.manage`. Filterable by status, role, merchant, search.",
)
def list_active_users(
    status: UserStatus | None = None,
    role: UserRole | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    users, total = account_service.list_all_users(
        db, page, page_size, status=status, role=role, merchant_id=merchant_id, search=search
    )
    online_ids = session_service.online_user_ids(db, [u.user_id for u in users])
    return Page.build(
        [AccountResponse.of(u, online=u.user_id in online_ids) for u in users],
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
    db: Session = Depends(get_db),
    _: User = Depends(require(P.NOTIFICATION_SEND)),
):
    settings = communication_service.update_settings(
        db, merchant_id, **payload.model_dump(exclude_unset=True)
    )
    return CommunicationSettingsResponse.of(settings)


@router.post(
    "/notifications/broadcast",
    response_model=BroadcastResponse,
    summary="Broadcast a notification",
    description=(
        "Requires `notification.send`. Sends to every user of the given merchants, or every "
        "active merchant when `merchant_ids` is omitted. A merchant with notifications "
        "disabled in its communication settings is skipped, not force-sent."
    ),
)
def broadcast_notification(
    payload: BroadcastRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.NOTIFICATION_SEND)),
):
    sent, skipped = communication_service.broadcast(
        db, payload.merchant_ids, payload.title, payload.message
    )
    return BroadcastResponse(sent=sent, skipped=skipped)
