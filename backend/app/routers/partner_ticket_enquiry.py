import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_booking import TicketEnquiryItemOut
from app.services import partner_booking_service

router = APIRouter(prefix="/api/partner", tags=["partner-ticket-enquiry"])


@router.get("/ticket-enquiry", response_model=list[TicketEnquiryItemOut], summary="Search available flights")
def ticket_enquiry(
    departure: str | None = None,
    arrival: str | None = None,
    date: datetime.date | None = None,
    cabin_class: str | None = None,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    return partner_booking_service.search_ticket_enquiry(db, departure, arrival, date, cabin_class)
