"""Admin B2C dashboard — ``GET /api/admin/b2c-dashboard/summary``.

The operational "what needs me now" landing for the B2C Admin Portal, kept
separate from the B2C Analytics overview (period trends) on purpose — see
``customer_dashboard_admin_service``. Read-only; gated on ``b2c.reports.view``,
the same code as the analytics overview (no new permission). The body carries
only counts and INR totals, never customer PII, so it needs no sensitive-export
code and writes no audit row.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.rbac import P, require_scope
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_dashboard_admin import B2CDashboardSummary
from app.services import customer_dashboard_admin_service as service

router = APIRouter(prefix="/api/admin/b2c-dashboard", tags=["admin-b2c-dashboard"])


@router.get(
    "/summary",
    response_model=B2CDashboardSummary,
    summary="Operational snapshot of the B2C desk",
    description=(
        "Requires `b2c.reports.view`. Read-only counts and INR totals (no customer "
        "PII): customers, bookings by status, booked vs collected money, pending "
        "reviews, and the live support queue."
    ),
)
def dashboard_summary(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_REPORTS_VIEW)),
):
    return service.summary(db)
