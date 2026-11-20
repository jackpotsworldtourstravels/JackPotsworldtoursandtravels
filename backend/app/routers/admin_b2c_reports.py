"""Admin B2C reports & analytics — ``/api/admin/b2c-reports/*`` and
``/api/admin/b2c-analytics/*``. Phase 8 of the B2C Admin Portal build-out. See
``customer_report_service`` (row builders; reuses the B2B export builder and the
Phase 2-4 booking/payment tables) and ``customer_analytics_admin_service``
(every figure reproducible by SQL; booked value is not collected money).

PERMISSIONS (Phase 13, owner decisions D2/C1). Only explicit ``b2c.*`` grants
count (``require_scope``; a super admin passes). ``report.view``/``report.export``
and ``customer.view`` grant NOTHING here: merchant roles hold the first two for
their OWN reports, and ``customer.view`` used to be accepted as an alternative,
which let a view-only admin download every customer's name, email and mobile.

* types / preview / analytics: ``b2c.reports.view``
* export (CSV / Excel / PDF):  ``b2c.reports.view`` + ``b2c.reports.export`` +
  ``b2c.customers.export`` — ALL five reports carry customer names and email
  addresses (the customers report also mobiles), so every export is a
  sensitive customer-data export. A refused export is audited as DENIED.
"""
from __future__ import annotations

import datetime as dt
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_b2c_scope, require_scope
from app.models_customer import AdminAuditOutcome
from app.services import customer_admin_audit_service as b2c_audit
from app.services.b2c_admin_readiness import require_audit_ready
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

_VIEW = require_scope(P.B2C_REPORTS_VIEW)

#: Every B2C report exposes customer personal data (name + email at least), so
#: every export needs the sensitive customer-data export code (owner C1).
SENSITIVE_REPORTS = frozenset({"bookings", "payments", "cancellations", "customers", "reviews"})
_EXPORT_CODES = (P.B2C_REPORTS_VIEW, P.B2C_REPORTS_EXPORT)


def _export_access(
    type: str = Query(...),
    user: User = Depends(require_scope(P.B2C_REPORTS_VIEW)),
) -> User:
    """Export gate: view + export, plus the customer-data export code for a
    sensitive report. A refusal is written to the B2C audit trail (metadata only)."""
    needed = list(_EXPORT_CODES)
    if type in SENSITIVE_REPORTS:
        needed.append(P.B2C_CUSTOMERS_EXPORT)
    missing = [c for c in needed if not has_b2c_scope(user, c)]
    if missing:
        b2c_audit.record_independently(
            admin=user, action="report.export", outcome=AdminAuditOutcome.DENIED,
            entity_type="report", entity_id=str(type), reason="missing " + ", ".join(missing),
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing required scope: " + " + ".join(missing))
    return user

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
            description="Requires `b2c.reports.view`.")
def report_types(_: User = Depends(_VIEW)):
    return [{
        "type": t, "label": reports.LABELS[t], "date_field": reports.DATE_FIELD[t],
        "statuses": list(reports.STATUS_CHOICES[t]),
        "products": list(reports.PRODUCTS) if t in reports.PRODUCT_FILTERED else [],
    } for t in reports.REPORT_TYPES]


@router.get(
    "/preview", response_model=ReportPreview, summary="Row count, total and first rows for a report",
    dependencies=[Depends(require_audit_ready)],
    description=(
        "Requires `b2c.reports.view`. Built by the same code the download "
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
    user: User = Depends(_VIEW),
):
    result = reports.preview(db, type, **_checked(type, date_from, date_to, report_status, product))
    # Sensitive-data read (D2): recorded independently (no business txn), metadata
    # only. required=True — the preview is NOT returned unless this SUCCESS audit
    # is durably persisted (the door-gate only narrows, it does not close, the
    # window in which the audit store could become unwritable); fails closed (503).
    b2c_audit.record_independently(
        required=True,
        admin=user, action="report.preview", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="report", entity_id=str(type),
    )
    return result


@router.get(
    "/export", summary="Download a report as CSV, Excel or PDF",
    dependencies=[Depends(require_audit_ready)],
    description=(
        "Requires `b2c.reports.view` + `b2c.reports.export` + `b2c.customers.export` (every B2C "
        "report contains customer names and email addresses). Same filters as `/preview`. "
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
    user: User = Depends(_export_access),
):
    filters = _checked(type, date_from, date_to, report_status, product)
    columns, rows = reports.build(db, type, **filters)
    content, media_type = export_service.build_export(format, columns, rows, f"{reports.LABELS[type]} Report")
    log_change(
        db, request, user, action="B2C report exported", module="B2CReports",
        description=f"{user.full_name} exported the B2C {type} report as {format} ({len(rows)} rows)",
    )
    b2c_audit.record_in_session(
        db, admin=user, action="report.export", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="report", entity_id=str(type), new={"format": format, "rows": len(rows)},
    )
    db.commit()
    filename = f"b2c-{type}-report-{dt.date.today().isoformat()}.{format}"
    return Response(content=content, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@analytics_router.get(
    "/overview", response_model=AnalyticsOverview, summary="B2C analytics over the last N calendar months",
    description=(
        "Requires `b2c.reports.view`. Every figure is reproducible by a direct "
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
