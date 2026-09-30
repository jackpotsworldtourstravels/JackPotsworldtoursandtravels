"""Admin B2C reports & analytics — ``/api/admin/b2c-reports/*`` and
``/api/admin/b2c-analytics/*``. Phase 8 of the B2C Admin Portal build-out. See
``customer_report_service`` (row builders; reuses the B2B export builder and the
Phase 2-4 booking/payment tables) and ``customer_analytics_admin_service``
(every figure reproducible by SQL; booked value is not collected money).

TWO PERMISSIONS, BOTH REQUIRED. ``report.view``/``report.export`` alone are not
enough: merchant roles hold them for their OWN reports, so gating a B2C report
on them would let a merchant read every customer's name and email. Every
endpoint here also requires ``customer.view`` (Admin only), and a download
requires ``report.export`` on top.
"""
from __future__ import annotations

import datetime as dt
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_report_admin import AnalyticsOverview, ReportPreview, ReportTypeInfo
from app.services import (
    customer_analytics_admin_service as analytics,
    customer_report_service as reports,
    export_service,
)
from app.services.catalogue_common import log_change

router = APIRouter(prefix="/api/admin/b2c-reports", tags=["admin-b2c-reports"])
analytics_router = APIRouter(prefix="/api/admin/b2c-analytics", tags=["admin-b2c-analytics"])

_VIEW = require(P.REPORT_VIEW, P.CUSTOMER_VIEW, require_all=True)
_EXPORT = require(P.REPORT_EXPORT, P.CUSTOMER_VIEW, require_all=True)

ReportName = Literal["bookings", "payments", "cancellations", "customers", "reviews"]


def _checked(report: str, date_from, date_to, status_: str | None, product: str | None) -> dict:
    if date_from and date_to and date_to < date_from:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "date_to is before date_from.")
    if status_ and status_ not in reports.STATUS_CHOICES[report]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown status {status_!r} for the {report} report.")
    if product:
        if report not in reports.PRODUCT_FILTERED:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"The {report} report has no product filter.")
        if product not in reports.PRODUCTS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown product {product!r}.")
    return dict(date_from=date_from, date_to=date_to, status=status_, product=product)


@router.get("/types", response_model=list[ReportTypeInfo], summary="The reports available and their filters",
            description="Requires `report.view` and `customer.view` (admin only).")
def report_types(_: User = Depends(_VIEW)):
    return [{
        "type": t, "label": reports.LABELS[t], "date_field": reports.DATE_FIELD[t],
        "statuses": list(reports.STATUS_CHOICES[t]),
        "products": list(reports.PRODUCTS) if t in reports.PRODUCT_FILTERED else [],
    } for t in reports.REPORT_TYPES]


@router.get(
    "/preview", response_model=ReportPreview, summary="Row count, total and first rows for a report",
    description=(
        "Requires `report.view` and `customer.view` (admin only). Built by the same code the download "
        "uses, so the preview and the file can never describe different sets. Dates are India-time days."
    ),
)
def preview_report(
    type: ReportName,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    report_status: str | None = Query(None, alias="status"),
    product: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(_VIEW),
):
    return reports.preview(db, type, **_checked(type, date_from, date_to, report_status, product))


@router.get(
    "/export", summary="Download a report as CSV, Excel or PDF",
    description=(
        "Requires `report.export` and `customer.view` (admin only). Same filters as `/preview`. "
        f"At most {reports.ROW_CAP} rows. Customer-typed text is defused so a spreadsheet cannot run it as a formula."
    ),
)
def export_report(
    type: ReportName,
    format: Literal["csv", "xlsx", "pdf"],
    request: Request,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    report_status: str | None = Query(None, alias="status"),
    product: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(_EXPORT),
):
    filters = _checked(type, date_from, date_to, report_status, product)
    columns, rows = reports.build(db, type, **filters)
    content, media_type = export_service.build_export(format, columns, rows, f"{reports.LABELS[type]} Report")
    log_change(
        db, request, user, action="B2C report exported", module="B2CReports",
        description=f"{user.full_name} exported the B2C {type} report as {format} ({len(rows)} rows)",
    )
    db.commit()
    filename = f"b2c-{type}-report-{dt.date.today().isoformat()}.{format}"
    return Response(content=content, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@analytics_router.get(
    "/overview", response_model=AnalyticsOverview, summary="B2C analytics over the last N calendar months",
    description=(
        "Requires `report.view` and `customer.view` (admin only). Every figure is reproducible by a direct "
        "SQL query. `booked_value` is what is on the books; `collected` is captured payments — the only "
        "money actually received."
    ),
)
def analytics_overview(
    months: int = Query(analytics.DEFAULT_MONTHS, ge=analytics.MIN_MONTHS, le=analytics.MAX_MONTHS),
    db: Session = Depends(get_db),
    _: User = Depends(_VIEW),
):
    return analytics.overview(db, months)
