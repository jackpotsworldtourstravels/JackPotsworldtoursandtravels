from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_auth import MessageResponse
from app.schemas.partner_booking import BookingCreatedOut, BookingDetailOut, PassengerCreate, TicketRequestCreate
from app.services import partner_booking_service

router = APIRouter(prefix="/api/partner/bookings", tags=["partner-bookings"])


@router.post("", response_model=BookingCreatedOut, status_code=status.HTTP_201_CREATED, summary="Create a draft ticket request")
def create_booking(
    payload: TicketRequestCreate, db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)
):
    return partner_booking_service.create_ticket_request(db, current.partner_id, current.partner_user_id, payload)


@router.post("/{booking_id}/passengers", status_code=status.HTTP_201_CREATED, summary="Add a passenger to a draft booking")
def add_passenger(
    booking_id: int,
    payload: PassengerCreate,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    passenger_id = partner_booking_service.add_passenger(db, current.partner_id, booking_id, payload)
    return {"passenger_id": passenger_id}


@router.post("/{booking_id}/submit", response_model=MessageResponse, summary="Send for Approval")
def submit_booking(
    booking_id: int, db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)
):
    partner_booking_service.submit_for_approval(db, current.partner_id, booking_id)
    return MessageResponse(message="Submitted for approval.")


@router.get("/{booking_id}", response_model=BookingDetailOut, summary="Booking detail")
def get_booking(
    booking_id: int, db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)
):
    return partner_booking_service.get_booking_detail(db, current.partner_id, booking_id)
