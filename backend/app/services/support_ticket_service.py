import datetime

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.misc import SupportTicket
from app.models.user import User
from app.services import activity_service, notification_service


def create_ticket(db: Session, user: User, subject: str, description: str, priority: str) -> SupportTicket:
    ticket = SupportTicket(user_id=user.id, subject=subject, description=description, priority=priority)
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    activity_service.log_activity(
        db, user.id, f"Support Ticket Created ({subject})",
        activity_type="Support Ticket Created", module="Support", reference_id=ticket.id,
        description=f"{user.full_name} raised a support ticket: {subject}",
    )
    notification_service.notify_admins(
        db, "New support ticket", f"{user.full_name} raised a ticket: {subject} (priority: {priority}).",
    )
    return ticket


def list_user_tickets(db: Session, user: User) -> list[SupportTicket]:
    stmt = select(SupportTicket).where(SupportTicket.user_id == user.id).order_by(SupportTicket.created_at.desc())
    return db.scalars(stmt).all()


def list_all_tickets_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(SupportTicket)) or 0
    stmt = (
        select(SupportTicket, User.email)
        .join(User, SupportTicket.user_id == User.id)
        .order_by(SupportTicket.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    items = [
        {**ticket.__dict__, "user_email": email}
        for ticket, email in db.execute(stmt).all()
    ]
    return items, total


def update_ticket_status(db: Session, ticket_id: int, new_status: str) -> SupportTicket:
    ticket = db.get(SupportTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Support ticket not found")
    ticket.status = new_status
    if new_status in ("resolved", "closed") and ticket.resolved_at is None:
        ticket.resolved_at = datetime.datetime.utcnow()
    elif new_status in ("open", "in_progress"):
        ticket.resolved_at = None
    db.commit()
    db.refresh(ticket)
    return ticket
