"""Analytics — M6 (API_CONTRACT.md §6.9).

Scope is inferred from the caller, exactly as ``reports.py`` and
``ticket_service.list_requests`` already do it, so there is no merchant-vs-admin
pair of endpoints to keep in step. A merchant asking for booking analytics gets
its own bookings; an admin gets the platform, and may narrow with
``merchant_id``.

**Permission codes are reused, not invented.** Reading numbers about your own
data is ``report.view``, which merchants, staff and Super Admin already hold —
and which the service layer scopes. The one endpoint that is *not* about the
caller's own data, the operations desk's queue health, is gated on
``ticket.approve``: an Admin-only code that already means "may work a booking",
with a second ``is_platform_staff`` check in the service. CR-4d shipped a staff
read on ``payment.view`` — a code every merchant role holds — and any merchant
could read every other merchant's balance. The lesson is applied here up front:
a code a merchant holds may only ever gate a merchant-scoped read.
"""
import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.analytics import (
    BookingAnalytics,
    ChangeRequestAnalytics,
    OperationsMetrics,
)
from app.services import analytics_service
from app.services.analytics_service import DateField

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get(
    "/bookings",
    response_model=BookingAnalytics,
    summary="Booking volume, value and mix",
    description=(
        "Requires `report.view`. Scoped to the caller: a merchant sees only its own bookings, "
        "platform staff see every merchant's and may narrow with `merchant_id`. "
        "`date_field` chooses the column the range filter **and** the monthly series run on — "
        "`travel_date` (when they fly, the default, matching the Reports screen) or `created_at` "
        "(when the booking was raised). The response echoes it back. `by_status` and `by_month` "
        "each partition the same population as `totals`, so either column adds up to the headline."
    ),
)
def booking_analytics(
    date_field: DateField = "travel_date",
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    merchant_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.REPORT_VIEW)),
):
    return analytics_service.booking_analytics(
        db,
        current_user,
        date_field=date_field,
        date_from=date_from,
        date_to=date_to,
        merchant_id=merchant_id,
    )


@router.get(
    "/change-requests",
    response_model=ChangeRequestAnalytics,
    summary="Cancellation, reschedule and ancillary analytics",
    description=(
        "Requires `report.view`, scoped to the caller. Counts every service-request type by "
        "outcome, and the money M3 recorded against the **approved** ones — a rejected "
        "cancellation charged nothing, so including it would report money that never moved. "
        "Filters on `created_at`: a change request has no travel date of its own."
    ),
)
def change_request_analytics(
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    merchant_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.REPORT_VIEW)),
):
    return analytics_service.change_request_analytics(
        db, current_user, date_from=date_from, date_to=date_to, merchant_id=merchant_id
    )


@router.get(
    "/operations",
    response_model=OperationsMetrics,
    summary="Operations desk queue health",
    description=(
        "Requires `ticket.approve` — the Admin-only code that already means *may work a "
        "booking* — and platform staff. What is waiting and for how long, who is carrying it, "
        "how many bookings have breached the 72-hour ageing threshold, and how long a booking "
        "takes to become a ticket. Ageing is measured over Approved / Payment Pending / Paid "
        "only: a ticketed booking is no longer waiting, and counting it makes an idle number "
        "grow forever. Time-to-issue reads the append-only `status_history`, so the figure is "
        "auditable against the Activity Timeline the desk already sees."
    ),
)
def operations_metrics(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE)),
):
    return analytics_service.operations_metrics(db, current_user)
