from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.support_ticket import SupportTicketCreate, SupportTicketOut
from app.services import support_ticket_service

router = APIRouter(prefix="/api/support-tickets", tags=["support-tickets"])


@router.get(
    "",
    response_model=list[SupportTicketOut],
    summary="List my support tickets",
    description="Requires authentication. Returns all support tickets raised by the current user.",
)
def my_tickets(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return support_ticket_service.list_user_tickets(db, current_user)


@router.post(
    "",
    response_model=SupportTicketOut,
    status_code=status.HTTP_201_CREATED,
    summary="Raise a support ticket",
    description="Requires authentication. Creates a new support ticket for the current user.",
)
def create_ticket(
    payload: SupportTicketCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return support_ticket_service.create_ticket(db, current_user, payload.subject, payload.description, payload.priority)
