import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_reports import ExportFormat, ReportRowOut
from app.services import partner_reports_service

router = APIRouter(prefix="/api/partner", tags=["partner-reports"])


@router.get("/reports", response_model=list[ReportRowOut], summary="Filtered report")
def reports(
    request_date_from: datetime.date | None = None,
    request_date_to: datetime.date | None = None,
    travel_date_from: datetime.date | None = None,
    travel_date_to: datetime.date | None = None,
    passenger_name: str | None = None,
    service_request_number: str | None = None,
    sector_departure: str | None = None,
    sector_arrival: str | None = None,
    export_format: ExportFormat = "pdf",
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    return partner_reports_service.generate_report(
        db, current.partner_id, current.partner_user_id,
        request_date_from, request_date_to, travel_date_from, travel_date_to,
        passenger_name, service_request_number, sector_departure, sector_arrival, export_format,
    )
