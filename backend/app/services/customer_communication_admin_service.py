"""Reading what B2C customers have been sent and have said — Phase 7 of the B2C
Admin Portal build-out (Communication).

READ-ONLY, AND THAT IS A DECISION, NOT A GAP. Three things a "Communication"
screen could plausibly do were looked at against the code and left out:

* COMPOSING OR BROADCASTING NOTIFICATIONS. ``CustomerNotification``'s own
  docstring says it is "a system-generated message — not a marketing inbox",
  written by the code that causes the event and "never composed ahead of time,
  so there is nothing here that was not actually true when it was written".
  An admin compose box would break that guarantee, so none is added.
* REPLYING TO SUPPORT TICKETS. The customer site's Support Center is now a live
  chat (CR-9); no customer page creates or reads a ticket any more. A staff
  reply would land in a thread the customer can never open. Tickets are shown
  for history only.
* WORKING THE LIVE CHAT. That is the Live Support desk (``admin_chat``), which
  already exists and stays the one place chats are answered. This module only
  summarises the queue so the two screens do not disagree about what is waiting.

No table is created or changed; every read is over existing customer_* tables.
"""
from __future__ import annotations

import math

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerCall,
    CustomerChatMessage,
    CustomerConversation,
    CustomerNotification,
    CustomerSupportMessage,
    CustomerSupportTicket,
)

NOTIFICATION_TYPES = ("booking_created", "booking_confirmed", "booking_cancelled", "booking_payment", "general")
TICKET_STATUSES = ("open", "in_progress", "resolved", "closed")
TICKET_PRIORITIES = ("low", "normal", "high", "urgent")


def _who(c: Customer) -> dict:
    return {"id": c.customer_id, "name": c.full_name, "email": c.email}


def _pages(total: int, page_size: int) -> int:
    return max(1, math.ceil(total / page_size))


def list_notifications(
    db: Session, *, page: int, page_size: int, notification_type: str | None = None,
    is_read: bool | None = None, search: str | None = None,
) -> dict:
    conds = []
    if notification_type:
        conds.append(CustomerNotification.notification_type == notification_type)
    if is_read is not None:
        conds.append(CustomerNotification.is_read.is_(is_read))
    if search:
        like = f"%{search.strip()}%"
        conds.append(or_(
            Customer.full_name.ilike(like), Customer.email.ilike(like),
            CustomerNotification.title.ilike(like), CustomerNotification.message.ilike(like),
            CustomerNotification.related_ref.ilike(like),
        ))
    base = select(CustomerNotification, Customer).join(
        Customer, Customer.customer_id == CustomerNotification.customer_id).where(*conds)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.execute(
        base.order_by(CustomerNotification.created_at.desc(), CustomerNotification.customer_notification_id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()

    # The summary is the WHOLE log, not the filtered view: it answers "how much
    # do we send and how much gets read", which a filter would distort.
    by_type = dict(db.execute(
        select(CustomerNotification.notification_type, func.count()).group_by(CustomerNotification.notification_type)
    ).all())
    unread = db.scalar(select(func.count()).where(CustomerNotification.is_read.is_(False))) or 0
    return {
        "items": [{
            "notification_id": n.customer_notification_id, "customer": _who(c),
            "notification_type": n.notification_type, "title": n.title, "message": n.message,
            "related_ref": n.related_ref, "is_read": n.is_read, "read_at": n.read_at,
            "created_at": n.created_at,
        } for n, c in rows],
        "total": total, "page": page, "page_size": page_size, "total_pages": _pages(total, page_size),
        "summary": {"total": sum(by_type.values()), "unread": unread, "by_type": by_type},
    }


def _ticket_row(t: CustomerSupportTicket, c: Customer, count: int) -> dict:
    return {
        "ticket_id": t.customer_support_ticket_id, "customer": _who(c), "subject": t.subject,
        "priority": t.priority, "status": t.status, "message_count": count,
        "created_at": t.created_at, "updated_at": t.updated_at,
    }


def list_tickets(
    db: Session, *, page: int, page_size: int, ticket_status: str | None = None,
    priority: str | None = None, search: str | None = None,
) -> dict:
    conds = []
    if ticket_status:
        conds.append(CustomerSupportTicket.status == ticket_status)
    if priority:
        conds.append(CustomerSupportTicket.priority == priority)
    if search:
        like = f"%{search.strip()}%"
        conds.append(or_(
            Customer.full_name.ilike(like), Customer.email.ilike(like),
            CustomerSupportTicket.subject.ilike(like),
        ))
    base = select(CustomerSupportTicket, Customer).join(
        Customer, Customer.customer_id == CustomerSupportTicket.customer_id).where(*conds)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.execute(
        base.order_by(CustomerSupportTicket.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    counts = dict(db.execute(
        select(CustomerSupportMessage.customer_support_ticket_id, func.count())
        .where(CustomerSupportMessage.customer_support_ticket_id.in_([t.customer_support_ticket_id for t, _ in rows]))
        .group_by(CustomerSupportMessage.customer_support_ticket_id)
    ).all()) if rows else {}
    return {
        "items": [_ticket_row(t, c, counts.get(t.customer_support_ticket_id, 0)) for t, c in rows],
        "total": total, "page": page, "page_size": page_size, "total_pages": _pages(total, page_size),
    }


def get_ticket(db: Session, ticket_id: int) -> dict | None:
    hit = db.execute(
        select(CustomerSupportTicket, Customer)
        .join(Customer, Customer.customer_id == CustomerSupportTicket.customer_id)
        .where(CustomerSupportTicket.customer_support_ticket_id == ticket_id)
    ).first()
    if hit is None:
        return None
    t, c = hit
    msgs = list(db.scalars(
        select(CustomerSupportMessage)
        .where(CustomerSupportMessage.customer_support_ticket_id == ticket_id)
        .order_by(CustomerSupportMessage.customer_support_message_id)
    ))
    return {
        **_ticket_row(t, c, len(msgs)), "description": t.description,
        "messages": [{"author_name": m.author_name, "is_staff": m.is_staff, "message": m.message,
                      "created_at": m.created_at} for m in msgs],
    }


def chat_overview(db: Session) -> dict:
    by_status = dict(db.execute(
        select(CustomerConversation.status, func.count()).group_by(CustomerConversation.status)
    ).all())
    unassigned = db.scalar(
        select(func.count()).where(
            CustomerConversation.status != "closed", CustomerConversation.assigned_admin_id.is_(None))
    ) or 0
    oldest_waiting = db.scalar(
        select(func.min(func.coalesce(CustomerConversation.last_message_at, CustomerConversation.created_at)))
        .where(CustomerConversation.status == "waiting")
    )
    calls = dict(db.execute(select(CustomerCall.status, func.count()).group_by(CustomerCall.status)).all())
    return {
        "conversations_total": sum(by_status.values()), "by_status": by_status,
        "unassigned_open": unassigned,
        "admin_unread": db.scalar(select(func.coalesce(func.sum(CustomerConversation.admin_unread_count), 0))) or 0,
        "messages_total": db.scalar(select(func.count()).select_from(CustomerChatMessage)) or 0,
        "calls_total": sum(calls.values()), "calls_by_status": calls, "oldest_waiting_at": oldest_waiting,
    }
