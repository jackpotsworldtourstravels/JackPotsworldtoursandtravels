from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_booking import DashboardStatsOut
from app.services import partner_booking_service

router = APIRouter(prefix="/api/partner", tags=["partner-dashboard"])


@router.get("/dashboard", response_model=DashboardStatsOut, summary="Dashboard KPI cards")
def dashboard(db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)):
    return partner_booking_service.get_dashboard_stats(db, current.partner_id)
