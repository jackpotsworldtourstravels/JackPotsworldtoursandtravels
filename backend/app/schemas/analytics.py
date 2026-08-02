"""Analytics schemas (M6).

Every money field is ``Decimal``, never ``float`` — Pydantic renders a Decimal
as a JSON string, which is what stops a browser turning ₹24,500.50 into
₹24,501 on the way to a tile. Counts are ``int`` because a count is not money.

Durations are ``float`` hours on purpose: they are not money, they are never
summed into money, and "1.5 hours" is the honest rendering of ninety minutes.
"""
import datetime
from decimal import Decimal

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Bookings
# ---------------------------------------------------------------------------
class BookingTotals(BaseModel):
    bookings: int
    value: Decimal
    average_value: Decimal
    #: 0040 — client-fare savings. Defaulted so an older caller reading this
    #: payload is unaffected and a partial deploy still validates.
    #: ``savings_bookings`` counts only the bookings that carried a client fare,
    #: so "you saved X across N bookings" never implies it covers all of them.
    saved: Decimal = Decimal("0")
    savings_bookings: int = 0


class StatusSlice(BaseModel):
    status: str
    label: str
    count: int
    value: Decimal


class MonthSlice(BaseModel):
    #: ``YYYY-MM``, or ``unscheduled`` for rows with no date in the chosen
    #: column — kept as a bucket so the series still sums to the total.
    month: str
    count: int
    value: Decimal


class RouteSlice(BaseModel):
    route: str
    count: int
    value: Decimal


class BookingAnalytics(BaseModel):
    scope: str
    #: Which column both the range filter and the monthly series ran on.
    date_field: str
    date_from: datetime.date | None = None
    date_to: datetime.date | None = None
    merchant_id: int | None = None
    totals: BookingTotals
    by_status: list[StatusSlice]
    by_month: list[MonthSlice]
    top_routes: list[RouteSlice]


# ---------------------------------------------------------------------------
# Operations desk
# ---------------------------------------------------------------------------
class AgeBuckets(BaseModel):
    under_24h: int
    h24_to_72h: int
    over_72h: int


class WaitingMetrics(BaseModel):
    #: The statuses these figures are measured over, named so a reader never has
    #: to guess whether a ticketed booking is inflating the average.
    stages: list[str]
    count: int
    oldest_hours: float
    average_hours: float
    median_hours: float
    buckets: AgeBuckets


class SlaMetrics(BaseModel):
    threshold_hours: int
    breached: int


class OperatorLoad(BaseModel):
    user_id: int
    full_name: str
    active_load: int
    issued_last_30d: int


class TimeToIssue(BaseModel):
    window_days: int
    sample: int
    average_hours: float
    median_hours: float
    p90_hours: float


class OperationsMetrics(BaseModel):
    queue: dict[str, int]
    waiting: WaitingMetrics
    sla: SlaMetrics
    operators: list[OperatorLoad]
    time_to_issue: TimeToIssue


# ---------------------------------------------------------------------------
# Change requests
# ---------------------------------------------------------------------------
class ChangeRequestTotals(BaseModel):
    requests: int
    approved: int
    rejected: int
    pending: int


class ChangeRequestTypeSlice(BaseModel):
    type: str
    label: str
    total: int
    approved: int
    rejected: int
    pending: int


class ChangeRequestMoney(BaseModel):
    #: States what population the figures below were measured over, so the panel
    #: cannot be read as "every cancellation ever raised".
    basis: str
    cancellation_charges: Decimal
    refunds_due: Decimal
    refunds_settled: Decimal
    #: ``refunds_due − refunds_settled``. Everything still owed.
    refunds_outstanding: Decimal
    #: The recorded shortfall where a settlement ran but the booking's own
    #: payments could not cover the refund. A **subset** of `refunds_outstanding`,
    #: not a second figure to add to it — see the service for why the raw
    #: ``refund_unsettled`` key cannot stand in for "still owed".
    refunds_short_settled: Decimal
    fare_differences: Decimal


class ChangeRequestAnalytics(BaseModel):
    scope: str
    date_field: str
    date_from: datetime.date | None = None
    date_to: datetime.date | None = None
    totals: ChangeRequestTotals
    by_type: list[ChangeRequestTypeSlice]
    money: ChangeRequestMoney


# ---------------------------------------------------------------------------
# Report summary — what an export is about to contain
# ---------------------------------------------------------------------------
class ReportSummary(BaseModel):
    """The header figures for a report screen.

    Built from the *same* row builders the export uses, so "showing N rows" and
    the file the user downloads can never describe different sets. ``truncated``
    is true when the export cap bit; a screen that says "1,000 rows" over a
    5,000-row cap without saying so is the bug this field exists to prevent.
    """

    type: str
    rows: int
    truncated: bool
    row_cap: int
    #: Present only for report types that carry money.
    total_value: Decimal | None = None
    date_field: str
