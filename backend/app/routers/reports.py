"""Reports export — API_CONTRACT.md §6.2.

Shared by every portal: scope is inferred from the caller the same way
``ticket_service.list_requests`` already scopes Request History, so a merchant automatically
gets only its own data with no separate merchant-vs-admin endpoint.

Only the export (file download) side is built here. The on-screen report table reuses the
existing `GET /api/requests` list endpoint directly — a plain filtered list is not a new
capability, so it doesn't need a parallel endpoint. `GET /api/reports/summary` (an aggregated
time series, for a future analytics chart) is deferred until a screen actually needs it.
"""
import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import Payment, RequestStatus, RequestType, SystemLog, User
from app.services import export_service, ticket_service
from app.services.lifecycle import SPEC_LABELS

router = APIRouter(prefix="/api/reports", tags=["reports"])

ReportType = Literal["bookings", "service_requests", "payments"]
ExportFormat = Literal["csv", "xlsx", "pdf"]

_SERVICE_REQUEST_TYPES = (
    RequestType.CANCELLATION, RequestType.DATE_CHANGE, RequestType.REFUND,
    RequestType.PASSENGER_MODIFICATION, RequestType.EXTRA_BAGGAGE,
    RequestType.MEAL, RequestType.SEAT,
)


def _booking_rows(db: Session, actor: User, **filters) -> tuple[list[tuple[str, str]], list[dict]]:
    items, _ = ticket_service.list_requests(
        db, actor, page=1, page_size=5000, request_type=RequestType.BOOKING, **filters
    )
    columns = [
        ("reference", "Reference"), ("request_number", "Request Number"),
        ("passengers", "Passenger(s)"), ("travel_type", "Travel Type"),
        ("sector", "Sector"), ("request_date", "Request Date"),
        ("travel_date", "Travel Date"), ("amount", "Amount"), ("status", "Status"),
    ]
    rows = [
        {
            "reference": r.booking_reference or "",
            "request_number": r.request_number,
            "passengers": ", ".join(p.full_name for p in r.passengers),
            "travel_type": (r.travel_type.value if r.travel_type else ""),
            "sector": f"{(r.travel_details or {}).get('origin_city', '')} → "
                      f"{(r.travel_details or {}).get('destination_city', '')}",
            "request_date": r.created_at.date().isoformat(),
            "travel_date": r.travel_date.isoformat() if r.travel_date else "",
            "amount": str(r.total_amount),
            "status": SPEC_LABELS.get(r.status, r.status.value),
        }
        for r in items
    ]
    return columns, rows


def _service_request_rows(db: Session, actor: User, **filters) -> tuple[list[tuple[str, str]], list[dict]]:
    all_rows: list = []
    for rtype in _SERVICE_REQUEST_TYPES:
        items, _ = ticket_service.list_requests(
            db, actor, page=1, page_size=5000, request_type=rtype, **filters
        )
        all_rows.extend(items)
    all_rows.sort(key=lambda r: r.created_at, reverse=True)
    columns = [
        ("request_number", "Request Number"), ("type", "Type"),
        ("booking_reference", "Booking Reference"), ("remarks", "Remarks"),
        ("request_date", "Request Date"), ("status", "Status"),
    ]
    rows = [
        {
            "request_number": r.request_number,
            "type": r.request_type.value.replace("_", " ").title(),
            "booking_reference": r.booking_reference or "",
            "remarks": r.remarks or "",
            "request_date": r.created_at.date().isoformat(),
            "status": SPEC_LABELS.get(r.status, r.status.value),
        }
        for r in all_rows
    ]
    return columns, rows


def _payment_rows(db: Session, actor: User, *, date_from, date_to, merchant_id) -> tuple[list[tuple[str, str]], list[dict]]:
    conditions = []
    if not actor.is_platform_staff:
        conditions.append(Payment.merchant_id == actor.merchant_id)
    elif merchant_id is not None:
        conditions.append(Payment.merchant_id == merchant_id)
    if date_from is not None:
        conditions.append(Payment.created_at >= date_from)
    if date_to is not None:
        conditions.append(Payment.created_at <= date_to)

    stmt = select(Payment).order_by(Payment.created_at.desc()).limit(5000)
    if conditions:
        stmt = stmt.where(*conditions)
    payments = list(db.scalars(stmt).all())

    columns = [
        ("transaction_id", "Transaction ID"), ("method", "Method"),
        ("amount", "Amount"), ("currency", "Currency"),
        ("status", "Status"), ("paid_date", "Paid Date"),
    ]
    rows = [
        {
            "transaction_id": p.transaction_id or "",
            "method": p.payment_method or "",
            "amount": str(p.amount),
            "currency": p.currency,
            "status": p.payment_status.value,
            "paid_date": p.paid_date.date().isoformat() if p.paid_date else "",
        }
        for p in payments
    ]
    return columns, rows


@router.get(
    "/export",
    summary="Export a report as CSV, Excel, or PDF",
    description=(
        "Requires `report.export`. `type=bookings|service_requests` filters follow the same "
        "date/search semantics as `GET /api/requests`; `type=payments` filters by `date_from`/"
        "`date_to` against the payment's created date."
    ),
)
def export_report(
    type: ReportType,
    format: ExportFormat,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    search: str | None = None,
    status: RequestStatus | None = None,
    merchant_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.REPORT_EXPORT)),
):
    filters = dict(
        merchant_id=merchant_id if current_user.is_platform_staff else None,
        search=search, date_from=date_from, date_to=date_to, request_status=status,
    )
    if type == "bookings":
        columns, rows = _booking_rows(db, current_user, **filters)
    elif type == "service_requests":
        columns, rows = _service_request_rows(db, current_user, **filters)
    else:
        columns, rows = _payment_rows(
            db, current_user, date_from=date_from, date_to=date_to, merchant_id=merchant_id
        )

    title = f"{type.replace('_', ' ').title()} Report"
    content, media_type = export_service.build_export(format, columns, rows, title)

    db.add(SystemLog(
        user_id=current_user.user_id, merchant_id=current_user.merchant_id,
        module="reports", action="export",
        description=f"{current_user.full_name} exported a {type} report as {format}",
    ))
    db.commit()

    filename = f"{type}-report-{datetime.date.today().isoformat()}.{format}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
