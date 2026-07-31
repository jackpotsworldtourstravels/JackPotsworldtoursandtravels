import datetime

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_merchant_staff
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.merchant_booking import (
    BookingCreatedOut,
    BookingDetailOut,
    DashboardStatsOut,
    PassengerCreate,
    RequestHistoryItemOut,
    TicketEnquiryItemOut,
    TicketRequestCreate,
)
from app.schemas.target_schema.merchant_profile import MessageResponse
from app.services.target_schema import merchant_booking_service

router = APIRouter(prefix="/api/partner", tags=["partner-bookings"])
bookings_router = APIRouter(prefix="/api/partner/bookings", tags=["partner-bookings"])


@router.get("/dashboard", response_model=DashboardStatsOut, summary="Dashboard KPI cards")
def dashboard(db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    return merchant_booking_service.get_dashboard_stats(db, current.merchant_id)


@router.get("/ticket-enquiry", response_model=list[TicketEnquiryItemOut], summary="Search available flights")
def ticket_enquiry(
    departure: str | None = None, arrival: str | None = None, date: datetime.date | None = None,
    cabin_class: str | None = None, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff),
):
    return merchant_booking_service.search_ticket_enquiry(db, departure, arrival, date, cabin_class)


@router.get("/request-history", response_model=list[RequestHistoryItemOut], summary="Filterable request history")
def request_history(
    status_filter: str | None = None, from_date: datetime.date | None = None, to_date: datetime.date | None = None,
    db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff),
):
    return merchant_booking_service.get_request_history(db, current.merchant_id, status_filter, from_date, to_date)


@bookings_router.post("", response_model=BookingCreatedOut, status_code=status.HTTP_201_CREATED, summary="Create a draft ticket request")
def create_booking(payload: TicketRequestCreate, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    return merchant_booking_service.create_ticket_request(db, current.merchant_id, current.id, payload.model_dump())


@bookings_router.post("/{booking_id}/passengers", status_code=status.HTTP_201_CREATED, summary="Add a passenger to a draft booking")
def add_passenger(booking_id: int, payload: PassengerCreate, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    passenger_id = merchant_booking_service.add_passenger(db, current.merchant_id, booking_id, payload.model_dump())
    return {"passenger_id": passenger_id}


@bookings_router.post("/{booking_id}/submit", response_model=MessageResponse, summary="Send for Approval")
def submit_booking(booking_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    merchant_booking_service.submit_for_approval(db, current.merchant_id, booking_id)
    return MessageResponse(message="Submitted for approval.")


@bookings_router.get("/{booking_id}", response_model=BookingDetailOut, summary="Booking detail")
def get_booking(booking_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    return merchant_booking_service.get_booking_detail(db, current.merchant_id, booking_id)
