from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_user
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.support_ticket import SupportTicketCreate, SupportTicketOut
from app.services.target_schema import msg_log_service, service_request_service, system_log_service

router = APIRouter(prefix="/api/support-tickets", tags=["support-tickets"])


@router.get("", response_model=list[SupportTicketOut], summary="List my support tickets")
def my_tickets(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service_request_service.list_by_user(db, current_user.id, request_type="support_ticket")


@router.post("", response_model=SupportTicketOut, status_code=status.HTTP_201_CREATED, summary="Raise a support ticket")
def create_ticket(payload: SupportTicketCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ticket = service_request_service.create_subtype_request(
        db, request_type="support_ticket", channel="customer", user_id=current_user.id, merchant_id=None,
        subject=payload.subject, description=payload.description, priority=payload.priority,
    )
    system_log_service.log_activity(
        db, user_id=current_user.id, event=f"{current_user.full_name} raised a support ticket: {payload.subject}",
        entity_type="service_request", entity_id=ticket.id, activity_type="Support Ticket Created", module="Support",
    )
    msg_log_service.notify_admins(
        db, "New support ticket",
        f"{current_user.full_name} raised a ticket: {payload.subject} (priority: {payload.priority}).",
    )
    return ticket
