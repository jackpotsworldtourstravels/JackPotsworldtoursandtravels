import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_merchant_staff
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.merchant_reports import ReportRowOut
from app.services.target_schema import merchant_reports_service

router = APIRouter(prefix="/api/partner/reports", tags=["partner-reports"])


@router.get("", response_model=list[ReportRowOut], summary="Generate a filtered request report")
def generate_report(
    request_date_from: datetime.date | None = None, request_date_to: datetime.date | None = None,
    travel_date_from: datetime.date | None = None, travel_date_to: datetime.date | None = None,
    passenger_name: str | None = None, service_request_number: str | None = None,
    sector_departure: str | None = None, sector_arrival: str | None = None, export_format: str = "excel",
    db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff),
):
    return merchant_reports_service.generate_report(
        db, current.merchant_id, current.id, request_date_from=request_date_from, request_date_to=request_date_to,
        travel_date_from=travel_date_from, travel_date_to=travel_date_to, passenger_name=passenger_name,
        service_request_number=service_request_number, sector_departure=sector_departure,
        sector_arrival=sector_arrival, export_format=export_format,
    )
