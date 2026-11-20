"""Admin B2C communication — ``/api/admin/communication/*``. Phase 7 of the B2C
Admin Portal build-out.

The reads (``/notifications``, ``/tickets``, ``/chat-overview``) are gated on
`customer.view`. Stage 3 M2 adds THREE single-recipient send actions, each gated
on the explicit `b2c.communication.send` scope, behind the audit-readiness gate,
with a SUCCESS audit atomic with the business write and FAILURE/DENIED recorded
otherwise:

* M2.1 ``POST /customers/{id}/notify``  — one in-app notification to one customer;
* M2.2 ``POST /customers/{id}/email``   — one email to the customer's verified
  address (external side effect handled: SMTP 502; sent-but-audit-fails 500);
* M2.3 ``POST /tickets/{id}/reply``     — one staff reply on one existing ticket
  (is_staff, applies only the existing resolved→open rule, no auto email/SMS).

Audit payloads are metadata only (lengths/ids, never subject/title/body). Live
Support remains where live chats are answered. Admin only.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.auth.rbac import P, require_scope
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome
from app.models_v2 import User
from app.schemas.customer_communication_admin import (
    ChatOverview,
    CustomerEmailRequest,
    CustomerEmailResponse,
    CustomerNotifyRequest,
    CustomerNotifyResponse,
    CustomerTicketReplyRequest,
    NotificationList,
    TicketDetail,
    TicketList,
)
from app.services import customer_admin_audit_service as b2c_audit
from app.services import customer_communication_admin_service as service
from app.services import email_service
from app.services.b2c_admin_readiness import require_audit_ready

router = APIRouter(prefix="/api/admin/communication", tags=["admin-communication"])
logger = logging.getLogger("jackpots.b2c_communication")


def _send_gate(action: str):
    """Authorization gate for the send actions: the explicit
    ``b2c.communication.send`` scope (super-admin or an explicit grant — never a
    B2B role default). A denial is recorded as a DENIED audit event naming the
    refused action and 403s. ``get_current_admin`` rejects non-admins first."""

    def gate(customer_id: int = Path(...), admin: User = Depends(get_current_admin)) -> User:
        if not admin.has_permission(P.B2C_COMMUNICATION_SEND):
            b2c_audit.record_independently(
                admin=admin, action=action, outcome=AdminAuditOutcome.DENIED,
                entity_type="customer", entity_id=customer_id,
                reason="missing b2c.communication.send",
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "B2C communication access required")
        return admin

    return gate


def _ticket_send_gate(action: str):
    """As ``_send_gate`` but for a ticket-scoped path (DENIED audit names the
    ticket, not a customer)."""

    def gate(ticket_id: int = Path(...), admin: User = Depends(get_current_admin)) -> User:
        if not admin.has_permission(P.B2C_COMMUNICATION_SEND):
            b2c_audit.record_independently(
                admin=admin, action=action, outcome=AdminAuditOutcome.DENIED,
                entity_type="customer_support_ticket", entity_id=ticket_id,
                reason="missing b2c.communication.send",
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "B2C communication access required")
        return admin

    return gate


@router.get(
    "/notifications", response_model=NotificationList,
    summary="Notifications sent to customers",
    description=(
        "Requires `customer.view` (admin only). Newest first. Every one was written by the "
        "event it describes (a booking, a cancellation, a payment); `summary` covers the whole "
        "log regardless of filters."
    ),
)
def list_notifications(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    notification_type: str | None = Query(None, alias="type"),
    is_read: bool | None = Query(None, alias="read"),
    search: str | None = Query(None, max_length=120),
):
    if notification_type and notification_type not in service.NOTIFICATION_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown type {notification_type!r}.")
    return service.list_notifications(
        db, page=page, page_size=page_size, notification_type=notification_type,
        is_read=is_read, search=search,
    )


@router.get(
    "/tickets", response_model=TicketList, summary="Legacy support tickets (history only)",
    description=(
        "Requires `customer.view` (admin only). The customer site now uses live chat, so "
        "tickets are no longer created; existing ones are listed for history."
    ),
)
def list_tickets(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    ticket_status: str | None = Query(None, alias="status"),
    priority: str | None = Query(None),
    search: str | None = Query(None, max_length=120),
):
    if ticket_status and ticket_status not in service.TICKET_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown status {ticket_status!r}.")
    if priority and priority not in service.TICKET_PRIORITIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown priority {priority!r}.")
    return service.list_tickets(
        db, page=page, page_size=page_size, ticket_status=ticket_status, priority=priority, search=search,
    )


@router.get(
    "/tickets/{ticket_id}", response_model=TicketDetail, summary="One legacy ticket with its thread",
    description="Requires `customer.view` (admin only).", responses={404: {"description": "No such ticket."}},
)
def get_ticket(ticket_id: int, db: Session = Depends(get_db), _: User = Depends(require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW))):
    row = service.get_ticket(db, ticket_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such ticket.")
    return row


@router.get(
    "/chat-overview", response_model=ChatOverview, summary="Live chat and call totals",
    description=(
        "Requires `customer.view` (admin only). A summary only — chats are answered on the "
        "Live Support desk."
    ),
)
def chat_overview(db: Session = Depends(get_db), _: User = Depends(require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW))):
    return service.chat_overview(db)


# --- Stage 3 M2.1: send one in-app notification to one customer -------------
@router.post(
    "/customers/{customer_id}/notify",
    response_model=CustomerNotifyResponse,
    summary="Send an in-app notification to one customer",
    description=(
        "Requires `b2c.communication.send` (super-admin or explicit grant — never "
        "a B2B role default). Creates a SINGLE in-app notification (type `general`) "
        "the customer sees through their existing notifications API/UI. The SUCCESS "
        "audit commits atomically with the notification; a missing audit table "
        "(migration 0095 unapplied) returns 503 and creates nothing. Not a broadcast."
    ),
    dependencies=[Depends(require_audit_ready)],
    responses={
        403: {"description": "Missing b2c.communication.send."},
        404: {"description": "No such customer."},
        422: {"description": "Invalid title/message."},
    },
)
def notify_customer(
    customer_id: int,
    payload: CustomerNotifyRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(_send_gate("customer.notify")),
):
    try:
        row = service.send_notification(
            db, customer_id, title=payload.title, message=payload.message,
        )
    except Exception as exc:  # noqa: BLE001 — record the failed attempt, then surface it
        db.rollback()
        b2c_audit.record_independently(
            admin=admin, action="customer.notify", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason=str(exc),
        )
        raise
    if row is None:
        b2c_audit.record_independently(
            admin=admin, action="customer.notify", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason="no such customer",
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such customer.")

    # SUCCESS audit rides the SAME commit as the notification insert (atomic; the
    # readiness gate above guarantees the table exists). Store CONTENT-FREE
    # METADATA ONLY — the notification id, its type and the message length, never
    # the title or the body. The title is admin-authored but can still carry a
    # customer's name/reference, so it is not copied into the trail; an auditor
    # retrieves the actual content from customer_notifications via the id, under
    # the usual customer-data access controls.
    b2c_audit.record_in_session(
        db, admin=admin, action="customer.notify", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer", entity_id=customer_id,
        new={
            "notification_id": row.customer_notification_id,
            "notification_type": row.notification_type,
            "message_length": len(payload.message),
        },
    )
    db.commit()
    return CustomerNotifyResponse(
        outcome="sent", notification_id=row.customer_notification_id,
        customer_id=customer_id, notification_type=row.notification_type,
    )


# --- Stage 3 M2.2: send one email to one customer ---------------------------
@router.post(
    "/customers/{customer_id}/email",
    response_model=CustomerEmailResponse,
    summary="Send an email to one customer",
    description=(
        "Requires `b2c.communication.send`. Sends a SINGLE email to the customer's "
        "own **verified** address (resolved server-side — the admin cannot set the "
        "recipient). Reuses the existing SMTP service. A customer with no verified "
        "email gets 422 and nothing is sent. Behind the audit-readiness gate (503 "
        "while 0095 unapplied). The SUCCESS audit stores metadata only (channel + "
        "subject/message lengths), never the subject text or the body."
    ),
    dependencies=[Depends(require_audit_ready)],
    responses={
        403: {"description": "Missing b2c.communication.send."},
        404: {"description": "No such customer."},
        422: {"description": "Invalid subject/message, or no verified email."},
        502: {"description": "The email could not be sent."},
        500: {"description": "Email sent but its audit could not be recorded."},
    },
)
def email_customer(
    customer_id: int,
    payload: CustomerEmailRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(_send_gate("customer.email")),
):
    customer = service.get_customer(db, customer_id)
    if customer is None:
        b2c_audit.record_independently(
            admin=admin, action="customer.email", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason="no such customer",
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such customer.")

    # A verified email is required; nothing is sent otherwise.
    if not (customer.email and customer.email_verified):
        b2c_audit.record_independently(
            admin=admin, action="customer.email", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason="no verified email on file",
        )
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Customer has no verified email address; an email cannot be sent.",
        )

    delivered = email_service.send_admin_customer_email(
        customer.email, payload.subject, payload.message,
    )
    if not delivered:
        # SMTP failure — nothing was sent, no external side effect.
        b2c_audit.record_independently(
            admin=admin, action="customer.email", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason="email delivery failed",
        )
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "The email could not be sent; please try again.",
        )

    # The email IS sent now and cannot be un-sent. The SUCCESS audit must persist
    # durably before we report success. METADATA ONLY — channel + lengths, never
    # the subject text or the body.
    b2c_audit.record_in_session(
        db, admin=admin, action="customer.email", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer", entity_id=customer_id,
        new={
            "channel": "email",
            "subject_length": len(payload.subject),
            "message_length": len(payload.message),
        },
    )
    try:
        db.commit()
    except Exception:  # noqa: BLE001 — EXTERNAL SIDE EFFECT: email already sent
        # We cannot un-send the email, and we cannot claim a recorded success.
        # Do NOT pretend it was unsent: log CRITICAL, best-effort record an
        # independent FAILURE anomaly on a fresh session, and return 500.
        db.rollback()
        logger.critical(
            "EMAIL SENT to customer %s but the SUCCESS audit failed to commit; "
            "manual audit reconciliation required.", customer_id,
        )
        b2c_audit.record_independently(
            admin=admin, action="customer.email", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id,
            reason="email sent but success audit persistence failed",
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "The email was sent but could not be fully recorded; it has been flagged for reconciliation.",
        )

    return CustomerEmailResponse(outcome="sent", customer_id=customer_id, delivered=True)


# --- Stage 3 M2.3: reply on an existing customer support ticket -------------
@router.post(
    "/tickets/{ticket_id}/reply",
    response_model=TicketDetail,
    summary="Reply on a customer support ticket",
    description=(
        "Requires `b2c.communication.send`. Adds ONE staff reply (`is_staff=true`, "
        "author = the admin) to an existing ticket, scoped to that ticket and its "
        "customer. Behind the audit-readiness gate; SUCCESS audit is atomic with the "
        "message. The reply IS visible to the customer in their ticket thread. STATUS: "
        "only the existing rule applies — a reply to a `resolved` ticket reopens it to "
        "`open`, exactly as a customer reply does; no other transition. No email/SMS is "
        "sent automatically (no existing ticket workflow requires one)."
    ),
    dependencies=[Depends(require_audit_ready)],
    responses={
        403: {"description": "Missing b2c.communication.send."},
        404: {"description": "No such ticket."},
        422: {"description": "Invalid message."},
    },
)
def reply_to_ticket(
    ticket_id: int,
    payload: CustomerTicketReplyRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(_ticket_send_gate("support.reply")),
):
    try:
        row = service.reply_ticket(
            db, ticket_id, author_name=admin.full_name, message=payload.message,
        )
    except Exception as exc:  # noqa: BLE001 — record the failed attempt, then surface it
        db.rollback()
        b2c_audit.record_independently(
            admin=admin, action="support.reply", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer_support_ticket", entity_id=ticket_id, reason=str(exc),
        )
        raise
    if row is None:
        b2c_audit.record_independently(
            admin=admin, action="support.reply", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer_support_ticket", entity_id=ticket_id, reason="no such ticket",
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such ticket.")

    # SUCCESS audit rides the SAME commit as the message insert (atomic). METADATA
    # ONLY — the message length and that it is a staff reply, never the body (the
    # admin's identity is already in the audit's actor snapshot).
    b2c_audit.record_in_session(
        db, admin=admin, action="support.reply", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_support_ticket", entity_id=ticket_id,
        new={"message_length": len(payload.message), "author": "staff"},
    )
    db.commit()
    # Return ONLY this ticket's own thread (no cross-ticket/customer exposure).
    return service.get_ticket(db, ticket_id)
