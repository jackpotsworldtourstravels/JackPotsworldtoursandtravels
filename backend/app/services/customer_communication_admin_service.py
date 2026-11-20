"""Reading what B2C customers have been sent and have said — Phase 7 of the B2C
Admin Portal build-out (Communication).

MOSTLY READS, PLUS A FEW EXPLICIT, AUDITED WRITES. Some things a "Communication"
screen could do were weighed against the code; what shipped and what did not is
spelled out below:

* COMPOSING OR BROADCASTING NOTIFICATIONS. ``CustomerNotification`` is still a
  system-generated log for the events the code raises. Stage 3 M2.1 adds ONE
  explicit, owner-approved exception: :func:`send_notification` lets an
  authorised admin (``b2c.communication.send``) send a SINGLE customer a direct
  in-app notification (type ``general``). It is NOT a broadcast and NOT
  marketing — one customer, one row, fully audited — so the "true when written"
  guarantee is preserved: an admin message is a real thing an admin did. No
  bulk/compose-ahead path is added.
* REPLYING TO SUPPORT TICKETS — THIS HAS SHIPPED. An earlier note here said
  tickets were "history only" and that "no customer page creates or reads a
  ticket any more" because the Support Center became a live chat (CR-9). That
  was wrong and is corrected: B2C Support Tickets are a live, two-way system
  that COEXISTS with Live Chat. A customer raises, lists and reads their own
  tickets (subject / description / priority / status + the message thread) from
  the Account Center — ``/api/customer/support-tickets`` in
  ``customer_account.py`` — and an authorised admin (``b2c.communication.send``)
  replies through ``POST /api/admin/communication/tickets/{id}/reply``
  (:func:`reply_ticket`), which reopens a resolved ticket exactly as a customer
  reply does. Stage 3 M2.4 adds ONE in-app :class:`CustomerNotification` per
  staff reply so the reply is not invisible until the customer happens to come
  back — IN-APP ONLY, never email / SMS / WhatsApp / push. Live Chat stays the
  separate real-time channel; B2B merchants have their own thread system in
  ``support_tickets.py`` (rooted at ``models_v2.User``), untouched by this.
* WORKING THE LIVE CHAT. That is the Live Support desk (``admin_chat``), which
  already exists and stays the one place chats are answered. This module only
  summarises the queue so the two screens do not disagree about what is waiting.

No table is created or changed: the explicit writes (M2.1 notify, M2.3 ticket
reply, M2.4 reply notification) insert rows into existing customer_* tables, and
every read is over those same tables.
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


def get_customer(db: Session, customer_id: int) -> Customer | None:
    """One customer by id, or None. Used by the send actions to validate the
    recipient (404) and, for email, to require a verified address."""
    return db.get(Customer, customer_id)


def reply_ticket(db: Session, ticket_id: int, *, author_name: str, message: str) -> CustomerSupportMessage | None:
    """Add ONE staff reply to an existing ticket. Mutate-only: added + flushed
    (id available) but NOT committed — the caller owns the commit so the SUCCESS
    audit is atomic with the message. Returns the new row, or ``None`` if the
    ticket does not exist (caller maps to 404).

    Staff representation matches the customer path (``customer_account_service``
    ``add_ticket_message``): ``is_staff=True`` with the admin's name as author.
    STATUS: it applies ONLY the EXISTING reply rule — a reply to a ``resolved``
    ticket reopens it to ``open`` (exactly what a customer reply already does);
    no new transition is introduced, so the workflow is preserved.

    STAGE 3 M2.4 (audit follow-up): it also raises EXACTLY ONE in-app
    :class:`CustomerNotification` for the ticket's owner, reusing the same
    in-app notification system the rest of the customer's notifications use. A
    ticket reply was otherwise invisible until the customer happened to reopen
    the ticket. This is IN-APP ONLY — it inserts one row the customer sees in
    their notifications UI and sends NO email / SMS / WhatsApp / push. One
    reply, one message, one notification, all in the caller's single
    transaction, so a rolled-back reply leaves no orphan notification."""
    ticket = db.get(CustomerSupportTicket, ticket_id)
    if ticket is None:
        return None
    row = CustomerSupportMessage(
        customer_support_ticket_id=ticket.customer_support_ticket_id,
        author_name=author_name, is_staff=True, message=message,
    )
    db.add(row)
    if ticket.status == "resolved":  # same rule as a customer reply; nothing else changes
        ticket.status = "open"
    # One in-app notification so the reply is not invisible. related_ref links it
    # to the ticket (so the customer UI can deep-link to the thread); type is the
    # existing ``general`` so no new notification type/enum has to be introduced.
    subject = (ticket.subject or "your support ticket").strip()
    if len(subject) > 90:
        subject = subject[:87] + "…"
    db.add(CustomerNotification(
        customer_id=ticket.customer_id,
        notification_type="general",
        title="Support replied to your ticket",
        message=f'A member of our support team replied to your ticket "{subject}". '
                "Open it to read their response.",
        related_ref=f"ticket:{ticket.customer_support_ticket_id}",
    ))
    db.flush()
    return row


# --- Stage 3 M2.1: send one in-app notification to one customer --------------
def send_notification(
    db: Session, customer_id: int, *, title: str, message: str,
    notification_type: str = "general",
) -> CustomerNotification | None:
    """Create ONE in-app notification for ONE customer. Mutate-only: the row is
    added and flushed (so its id is available) but NOT committed — the caller
    owns the commit so the SUCCESS audit is atomic with the insert. Returns the
    new row, or ``None`` if no such customer (the caller maps that to 404)."""
    customer = db.get(Customer, customer_id)
    if customer is None:
        return None
    row = CustomerNotification(
        customer_id=customer.customer_id,
        notification_type=notification_type,
        title=title,
        message=message,
    )
    db.add(row)
    db.flush()  # assign the PK; the caller commits (atomic with the audit row)
    return row


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
