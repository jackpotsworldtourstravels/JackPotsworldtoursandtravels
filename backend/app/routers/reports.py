"""Reports export — API_CONTRACT.md §6.2.

Shared by every portal: scope is inferred from the caller the same way
``ticket_service.list_requests`` already scopes Request History, so a merchant automatically
gets only its own data with no separate merchant-vs-admin endpoint.

The on-screen report table reuses the existing `GET /api/requests` list endpoint directly — a
plain filtered list is not a new capability, so it doesn't need a parallel endpoint.

`GET /api/reports/summary` (M6) is the header for that table: how many rows the current filters
match, and what they are worth. It is built from **the same row builders the export uses**, so
"showing N rows" and the file the user downloads cannot describe different sets — which is the
classic reporting bug, and the one M6's verification requirement names. The aggregated time
series lives in `analytics.py`, where it can be grouped in SQL rather than counted over rows.
"""
import datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import Payment, RequestStatus, RequestType, SystemLog, User
from app.schemas.analytics import ReportSummary
from app.services import export_service, ticket_service
from app.services.lifecycle import SPEC_LABELS

router = APIRouter(prefix="/api/reports", tags=["reports"])

ReportType = Literal["bookings", "service_requests", "payments"]
ExportFormat = Literal["csv", "xlsx", "pdf"]

#: Hard cap on the rows any one report may contain. Named rather than repeated
#: at each call site, because ``/summary`` reports it back to the screen: a page
#: that says "1,000 rows" when the cap bit at 5,000 is lying about the download
#: it is offering.
ROW_CAP = 5000

#: Which column ``date_from``/``date_to`` filter on, per report type. Stated in
#: the summary response because a prior phase shipped a filter on
#: ``travel_date`` that every reader took for ``created_at``.
DATE_FIELDS: dict[str, str] = {
    "bookings": "travel_date",
    "service_requests": "travel_date",
    "payments": "created_at",
}

_SERVICE_REQUEST_TYPES = (
    RequestType.CANCELLATION, RequestType.DATE_CHANGE, RequestType.REFUND,
    RequestType.PASSENGER_MODIFICATION, RequestType.EXTRA_BAGGAGE,
    RequestType.MEAL, RequestType.SEAT,
)


def _booking_rows(db: Session, actor: User, **filters) -> tuple[list[tuple[str, str]], list[dict]]:
    items, _ = ticket_service.list_requests(
        db, actor, page=1, page_size=ROW_CAP, request_type=RequestType.BOOKING, **filters
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
            db, actor, page=1, page_size=ROW_CAP, request_type=rtype, **filters
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
        # Half-open, deliberately. ``created_at`` is a timestamp and ``date_to``
        # a date, so ``<= date_to`` compares against midnight and silently drops
        # every payment taken during the closing day of the range. Fixed in M6
        # when the totals endpoint was written and the two disagreed.
        conditions.append(Payment.created_at < date_to + datetime.timedelta(days=1))

    stmt = select(Payment).order_by(Payment.created_at.desc()).limit(ROW_CAP)
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


def _rows_for(
    db: Session,
    actor: User,
    report_type: str,
    *,
    date_from,
    date_to,
    search,
    status,
    merchant_id,
) -> tuple[list[tuple[str, str]], list[dict]]:
    """The one place a report's rows are built.

    ``/export`` and ``/summary`` both come through here. If they each assembled
    their own filters, the count on the screen and the rows in the file would
    drift the first time one of them gained an option — which is precisely the
    failure M6's verification requirement is written to catch.
    """
    filters = dict(
        merchant_id=merchant_id if actor.is_platform_staff else None,
        search=search, date_from=date_from, date_to=date_to, request_status=status,
    )
    if report_type == "bookings":
        return _booking_rows(db, actor, **filters)
    if report_type == "service_requests":
        return _service_request_rows(db, actor, **filters)
    return _payment_rows(
        db, actor, date_from=date_from, date_to=date_to, merchant_id=merchant_id
    )


@router.get(
    "/summary",
    response_model=ReportSummary,
    summary="Row count and value for the current report filters",
    description=(
        "Requires `report.view`. How many rows the filters match and what they are worth — the "
        "header for a report screen, and the figure that tells a user how big the download will "
        "be before they take it. Built from the same row builders `GET /api/reports/export` "
        "uses, so the two can never describe different sets. `truncated` is true when the "
        f"{ROW_CAP}-row cap bit; `date_field` names the column `date_from`/`date_to` filtered on, "
        "which is **not** the same column for every report type."
    ),
)
def report_summary(
    type: ReportType,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    search: str | None = None,
    status: RequestStatus | None = None,
    merchant_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.REPORT_VIEW)),
):
    _, rows = _rows_for(
        db, current_user, type,
        date_from=date_from, date_to=date_to, search=search,
        status=status, merchant_id=merchant_id,
    )
    # ``amount`` is the money column on both report types that carry one; the
    # service-request export carries none, so the field is omitted rather than
    # reported as zero — a zero would read as "nothing was charged".
    total = None
    if type in ("bookings", "payments"):
        total = sum(
            (Decimal(r["amount"]) for r in rows if r.get("amount")), Decimal("0")
        ).quantize(Decimal("0.01"))

    return ReportSummary(
        type=type,
        rows=len(rows),
        truncated=len(rows) >= ROW_CAP,
        row_cap=ROW_CAP,
        total_value=total,
        date_field=DATE_FIELDS[type],
    )


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
    columns, rows = _rows_for(
        db, current_user, type,
        date_from=date_from, date_to=date_to, search=search,
        status=status, merchant_id=merchant_id,
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
