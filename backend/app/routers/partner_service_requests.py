import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_booking import RequestHistoryItemOut
from app.schemas.partner_service_request import (
    CancellationRequestCreate,
    DateChangeRequestCreate,
    PassengerModificationRequestCreate,
    RefundRequestCreate,
    ServiceRequestCreatedOut,
)
from app.services import partner_booking_service, partner_service_request_service

router = APIRouter(prefix="/api/partner", tags=["partner-service-requests"])


@router.get("/request-history", response_model=list[RequestHistoryItemOut], summary="Filterable request history")
def request_history(
    status: str | None = None,
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    return partner_booking_service.get_request_history(db, current.partner_id, status, from_date, to_date)


@router.post("/service-requests/cancellation", response_model=ServiceRequestCreatedOut, summary="Cancel selected passengers")
def cancellation(
    payload: CancellationRequestCreate,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    sr_number = partner_service_request_service.cancel_passengers(db, current.partner_id, current.partner_user_id, payload)
    return ServiceRequestCreatedOut(service_request_number=sr_number)


@router.post("/service-requests/date-change", response_model=ServiceRequestCreatedOut, summary="Request a travel date change")
def date_change(
    payload: DateChangeRequestCreate,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    sr_number = partner_service_request_service.create_date_change(db, current.partner_id, current.partner_user_id, payload)
    return ServiceRequestCreatedOut(service_request_number=sr_number)


@router.post("/service-requests/refund", response_model=ServiceRequestCreatedOut, summary="Request a refund")
def refund(
    payload: RefundRequestCreate,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    sr_number = partner_service_request_service.create_refund(db, current.partner_id, current.partner_user_id, payload)
    return ServiceRequestCreatedOut(service_request_number=sr_number)


@router.post(
    "/service-requests/passenger-modification",
    response_model=ServiceRequestCreatedOut,
    summary="Request a passenger detail correction",
)
def passenger_modification(
    payload: PassengerModificationRequestCreate,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    sr_number = partner_service_request_service.create_passenger_modification(
        db, current.partner_id, current.partner_user_id, payload
    )
    return ServiceRequestCreatedOut(service_request_number=sr_number)
