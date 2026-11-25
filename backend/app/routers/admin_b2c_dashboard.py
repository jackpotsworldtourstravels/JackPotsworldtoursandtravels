"""Admin B2C dashboard — ``GET /api/admin/b2c-dashboard/summary``.

The operational "what needs me now" landing for the B2C Admin Portal, kept
separate from the B2C Analytics overview (period trends) on purpose — see
``customer_dashboard_admin_service``. Read-only; gated on ``b2c.reports.view``,
the same code as the analytics overview (no new permission). The body carries
only counts and INR totals, never customer PII, so it needs no sensitive-export
code and writes no audit row.
"""
from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query, status
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
        "PII). `days` (1 / 7 / 30) windows the period metrics (bookings, money, "
        "service level) to the last N days — default 7 (one week). A `start_date` + "
        "`end_date` (YYYY-MM-DD, inclusive) instead gives a custom range. The live "
        "queues (support, pending reviews) are always current-state."
    ),
)
def dashboard_summary(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_REPORTS_VIEW)),
    days: int | None = Query(None, ge=1, le=366),
    start_date: dt.date | None = Query(None),
    end_date: dt.date | None = Query(None),
):
    if (start_date is None) != (end_date is None):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Provide both start_date and end_date, or neither.")
    start = end = None
    if start_date is not None:
        if end_date < start_date:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "end_date cannot be before start_date.")
        start = dt.datetime.combine(start_date, dt.time.min, tzinfo=dt.timezone.utc)
        # end is exclusive, so include the whole end_date.
        end = dt.datetime.combine(end_date, dt.time.min, tzinfo=dt.timezone.utc) + dt.timedelta(days=1)
    elif days is not None:
        start = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    # With no days and no custom range, start/end stay None → all-time.
    return service.summary(db, start=start, end=end)
