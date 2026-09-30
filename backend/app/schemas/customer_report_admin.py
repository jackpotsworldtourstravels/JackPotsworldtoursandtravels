"""What the admin desk reads on the B2C Reports and Analytics screens — Phase 8
of the B2C Admin Portal build-out. Read-only; every money figure crosses the
wire as a decimal STRING (never a float), the same rule the B2B analytics
follow, and the browser formats it.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #

class ReportColumn(BaseModel):
    key: str
    label: str


class ReportTypeInfo(BaseModel):
    type: str
    label: str
    date_field: str
    statuses: list[str]
    #: Empty when the report has no product filter.
    products: list[str]


class ReportPreview(BaseModel):
    type: str
    label: str
    #: What the from/to dates filter on ("booked on", "registered on", ...).
    date_field: str
    columns: list[ReportColumn]
    #: The first few rows, so the desk can see what a download will contain.
    rows: list[dict[str, Any]]
    row_count: int
    truncated: bool
    row_cap: int
    total_value: str | None
    value_label: str | None


# --------------------------------------------------------------------------- #
# Analytics
# --------------------------------------------------------------------------- #

class MonthCount(BaseModel):
    month: str
    count: int


class MonthValue(MonthCount):
    value: str


class CustomerStats(BaseModel):
    total: int
    guests: int
    registered: int
    new_in_period: int
    by_month: list[MonthCount]


class StatusValue(BaseModel):
    status: str
    count: int
    value: str


class ProductStats(BaseModel):
    product: str
    bookings: int
    cancelled: int
    booked_value: str
    confirmed_value: str


class ProductSeries(BaseModel):
    product: str
    series: list[MonthValue]


class BookingStats(BaseModel):
    created: int
    cancelled: int
    booked_value: str
    confirmed_value: str
    non_inr_bookings: int
    by_status: list[StatusValue]
    by_product: list[ProductStats]
    monthly: list[ProductSeries]


class StatusAmount(BaseModel):
    status: str
    count: int
    amount: str


class ProviderAmount(BaseModel):
    provider: str
    count: int
    amount: str


class PaymentStats(BaseModel):
    collected: str
    captured_count: int
    by_status: list[StatusAmount]
    by_provider: list[ProviderAmount]


class RefundStats(BaseModel):
    requests: int
    refunded: str
    by_status: list[StatusAmount]


class FunnelStep(BaseModel):
    step: str
    count: int


class TopItem(BaseModel):
    name: str
    bookings: int
    value: str


class TopItems(BaseModel):
    packages: list[TopItem]
    hotels: list[TopItem]
    flight_routes: list[TopItem]


class ReviewStats(BaseModel):
    approved: int
    pending: int
    average: str | None


class AnalyticsOverview(BaseModel):
    months: int
    #: The calendar months in the window ('YYYY-MM', oldest first), so the
    #: browser draws buckets and never computes them.
    frame: list[str]
    since: str
    customers: CustomerStats
    bookings: BookingStats
    payments: PaymentStats
    refunds: RefundStats
    funnel: list[FunnelStep]
    top: TopItems
    reviews: ReviewStats
    definitions: dict[str, str]
