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

from fastapi import APIRouter, Depends, HTTPException, Query, Response
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

#: ``request_type=any`` — "do not filter by type at all", which is a different
#: instruction from omitting the parameter (that keeps each report's own
#: historical default). Spelled as a value rather than as a second boolean flag
#: so one parameter carries the whole three-way choice; see ``_booking_rows``.
ANY_TYPE = "any"

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


def _booking_rows(
    db: Session, actor: User, *, request_type: str | None = None, **filters
) -> tuple[list[tuple[str, str]], list[dict]]:
    # ``request_type`` narrows WITHIN this report, and has three meanings:
    # absent keeps the historical default (bookings only, so every existing
    # caller is byte-for-byte unchanged), ``ANY_TYPE`` drops the filter entirely,
    # and a concrete type selects just that one. The third case is what lets a
    # screen whose own Type filter is "all request types" export what it shows
    # instead of silently exporting bookings.
    if request_type is None:
        chosen = RequestType.BOOKING
    elif request_type == ANY_TYPE:
        chosen = None
    else:
        chosen = RequestType(request_type)
    items, _ = ticket_service.list_requests(
        db, actor, page=1, page_size=ROW_CAP, request_type=chosen, **filters
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


def _service_request_rows(
    db: Session, actor: User, *, request_type: str | None = None, **filters
) -> tuple[list[tuple[str, str]], list[dict]]:
    # One concrete type narrows to it; absent or ANY_TYPE keeps all seven, which
    # is what this report has always meant.
    wanted = _SERVICE_REQUEST_TYPES
    if request_type is not None and request_type != ANY_TYPE:
        wanted = (RequestType(request_type),)
    all_rows: list = []
    for rtype in wanted:
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
    statuses=None,
    request_type=None,
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
        request_statuses=statuses or None,
    )
    if report_type == "bookings":
        return _booking_rows(db, actor, request_type=request_type, **filters)
    if report_type == "service_requests":
        return _service_request_rows(db, actor, request_type=request_type, **filters)
    return _payment_rows(
        db, actor, date_from=date_from, date_to=date_to, merchant_id=merchant_id
    )


def _parse_statuses(raw: str | None) -> list[RequestStatus] | None:
    """``statuses=ticket_issued,completed`` → the enum members, or a 400.

    Comma-separated rather than a repeated query parameter because the portals
    reach this through one shared axios wrapper that serialises arrays as
    ``statuses[]=``; a string keeps the transport layer out of it. Unknown values
    are refused rather than dropped — silently ignoring one would hand back a
    file that is wrong in exactly the way this parameter exists to prevent.
    """
    if raw is None:
        return None
    out: list[RequestStatus] = []
    for part in raw.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            out.append(RequestStatus(value))
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unknown status '{value}'. Expected one of: "
                    + ", ".join(s.value for s in RequestStatus)
                ),
            ) from None
    return out or None


def _parse_request_type(raw: str | None) -> str | None:
    """``request_type`` as a concrete type, ``any``, or absent. 400 on anything else."""
    if raw is None or raw == ANY_TYPE:
        return raw
    try:
        RequestType(raw)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown request type '{raw}'. Expected '{ANY_TYPE}' or one of: "
                + ", ".join(t.value for t in RequestType)
            ),
        ) from None
    return raw


#: Shared wording for the two filters below, so /export and /summary cannot
#: describe them differently.
_STATUSES_DOC = (
    "Comma-separated statuses, e.g. `ticket_issued,completed`. Use it when the screen "
    "being exported shows more than one status at once; `status` (single) still works "
    "and the two intersect."
)
_REQUEST_TYPE_DOC = (
    "Narrow within the report: a request type, or `any` to drop the type filter "
    "entirely. Omit it to keep each report's own default (`bookings` = bookings only)."
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
    statuses: str | None = Query(None, description=_STATUSES_DOC),
    request_type: str | None = Query(None, description=_REQUEST_TYPE_DOC),
    merchant_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.REPORT_VIEW)),
):
    _, rows = _rows_for(
        db, current_user, type,
        date_from=date_from, date_to=date_to, search=search,
        status=status, statuses=_parse_statuses(statuses),
        request_type=_parse_request_type(request_type), merchant_id=merchant_id,
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
        "`date_to` against the payment's created date. `statuses` and `request_type` let a "
        "screen whose own filters do not reduce to one status or one type — Booking History "
        "is four terminal statuses merged — export exactly the rows it is showing."
    ),
)
def export_report(
    type: ReportType,
    format: ExportFormat,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    search: str | None = None,
    status: RequestStatus | None = None,
    statuses: str | None = Query(None, description=_STATUSES_DOC),
    request_type: str | None = Query(None, description=_REQUEST_TYPE_DOC),
    merchant_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.REPORT_EXPORT)),
):
    columns, rows = _rows_for(
        db, current_user, type,
        date_from=date_from, date_to=date_to, search=search,
        status=status, statuses=_parse_statuses(statuses),
        request_type=_parse_request_type(request_type), merchant_id=merchant_id,
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
