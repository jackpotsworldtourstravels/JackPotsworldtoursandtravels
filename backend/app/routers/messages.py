"""Message delivery, seen by the people who can do something about it (M5).

PERMISSION — `notification.send`, NOT `notification.view`
`notification.view` is held by every merchant role: it is what opens their own
notification bell. These routes report on **every** merchant's message
delivery, including recipient addresses, so they are gated on
`notification.send`, which `_ADMIN` alone holds. This is the boundary CR-4d got
wrong once — a read endpoint is not automatically safe just because it reads.

WHY A FAILURE SCREEN EXISTS AT ALL
The roadmap's M5 requirement: *"a bounced or failed send is visible to staff,
not silently swallowed."* Before M5 nothing could be visible, because no email
send wrote a row — success and failure were equally invisible. Now every attempt
is logged with its outcome, and this is where the failures surface.
"""
import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.services import delivery_service

router = APIRouter(prefix="/api/admin/messages", tags=["admin · messages"])


class FailedMessage(BaseModel):
    message_id: int
    message_type: str
    recipient: str
    subject: str | None = None
    status: str
    #: Why it failed, in the words the mail layer used. Safe to show staff: it
    #: is an SMTP diagnostic, never message content and never a credential.
    error_message: str | None = None
    merchant_id: int | None = None
    request_id: int | None = None
    created_at: datetime.datetime


class FailedMessagePage(BaseModel):
    items: list[FailedMessage]
    total: int
    page: int
    page_size: int


class DeliveryCounts(BaseModel):
    failed_total: int = 0
    by_type: dict[str, int] = {}


@router.get(
    "/failed",
    response_model=FailedMessagePage,
    summary="Messages that did not go out",
    description=(
        "Requires `notification.send` (staff only). Failed and bounced sends, newest first — "
        "the M5 requirement that a failure is visible rather than silently swallowed. Carries "
        "the SMTP reason, never the message body of another company's mail."
    ),
)
def failed(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.NOTIFICATION_SEND)),
):
    rows, total = delivery_service.failed_messages(db, page=page, page_size=page_size)
    return FailedMessagePage(
        items=[
            FailedMessage(
                message_id=r.message_id,
                message_type=r.message_type.value,
                recipient=r.recipient,
                subject=r.subject,
                status=r.status.value,
                error_message=r.error_message,
                merchant_id=r.merchant_id,
                request_id=r.request_id,
                created_at=r.created_at,
            )
            for r in rows
        ],
        total=total, page=page, page_size=page_size,
    )


@router.get(
    "/counts",
    response_model=DeliveryCounts,
    summary="How much delivery is failing",
    description=(
        "Requires `notification.send`. One grouped query. A non-zero `failed_total` with SMTP "
        "unconfigured is expected in development — every attempt is recorded as failed rather "
        "than pretending mail went out."
    ),
)
def counts(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.NOTIFICATION_SEND)),
):
    return delivery_service.failure_counts(db)
