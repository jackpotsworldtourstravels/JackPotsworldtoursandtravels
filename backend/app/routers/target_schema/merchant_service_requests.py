from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_merchant_staff
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.merchant_service_request import (
    CancellationRequestCreate,
    DateChangeRequestCreate,
    PassengerModificationRequestCreate,
    RefundRequestCreate,
    ServiceRequestCreatedOut,
)
from app.services.target_schema import merchant_service_request_service

router = APIRouter(prefix="/api/partner/service-requests", tags=["partner-service-requests"])


@router.post("/cancellation", response_model=ServiceRequestCreatedOut, summary="Cancel selected passengers")
def cancellation(payload: CancellationRequestCreate, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    sr_number = merchant_service_request_service.cancel_passengers(db, current.merchant_id, current.id, **payload.model_dump())
    return ServiceRequestCreatedOut(service_request_number=sr_number)


@router.post("/date-change", response_model=ServiceRequestCreatedOut, summary="Request a travel date change")
def date_change(payload: DateChangeRequestCreate, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    sr_number = merchant_service_request_service.create_date_change(db, current.merchant_id, current.id, **payload.model_dump())
    return ServiceRequestCreatedOut(service_request_number=sr_number)


@router.post("/refund", response_model=ServiceRequestCreatedOut, summary="Request a refund")
def refund(payload: RefundRequestCreate, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    sr_number = merchant_service_request_service.create_refund(db, current.merchant_id, current.id, **payload.model_dump())
    return ServiceRequestCreatedOut(service_request_number=sr_number)


@router.post("/passenger-modification", response_model=ServiceRequestCreatedOut, summary="Request a passenger detail correction")
def passenger_modification(payload: PassengerModificationRequestCreate, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    sr_number = merchant_service_request_service.create_passenger_modification(db, current.merchant_id, current.id, **payload.model_dump())
    return ServiceRequestCreatedOut(service_request_number=sr_number)
