"""What the admin desk sees about a B2C cancellation/refund request — Phase 3
of the B2C Admin Portal build-out. An allow-list, the same discipline every
other admin/* schema in this package uses.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import BaseModel


class CancellationCustomerRef(BaseModel):
    id: int
    name: str
    email: str


class CancellationListItem(BaseModel):
    cancellation_id: str
    booking_id: str
    customer: CancellationCustomerRef
    service_type: str
    reason: str | None
    requested_date: dt.datetime
    status: str
    refund_amount: Decimal | None


class CancellationList(BaseModel):
    items: list[CancellationListItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class CancellationDetail(CancellationListItem):
    destination: str
    booking_amount: Decimal
    admin_notes: str | None
    updated_at: dt.datetime


class CancellationDecision(BaseModel):
    """PATCH body for every admin action on a request. `action` picks the
    transition; `refund_amount` and `admin_notes` are read only where the
    action uses them — see customer_cancellation_admin_service.decide()."""

    action: str  # approve | reject | start_refund | complete_refund
    refund_amount: Decimal | None = None
    admin_notes: str | None = None


class CancellationCreate(BaseModel):
    """The customer-facing submission — POST /api/customer/cancellation-
    requests. Separate from the existing instant self-cancel endpoints
    (.../bookings/{ref}/cancel and friends), which are untouched: this is an
    ADDITIVE path for a booking a customer wants an admin to review rather
    than cancel outright, e.g. one already past the free-cancellation window."""

    booking_ref: str
    reason: str | None = None


# ---------------------------------------------------------------------------
# Refund execution (customer_refund_service)
# ---------------------------------------------------------------------------
class RefundUserRef(BaseModel):
    id: int
    name: str


class RefundAttemptOut(BaseModel):
    attempt_id: int
    attempt_number: int
    status: str            # pending | processing | succeeded | failed | manual_required
    status_label: str
    amount: Decimal
    currency: str
    provider: str
    provider_refund_id: str | None = None
    provider_status: str | None = None
    failure_reason: str | None = None
    is_manual: bool
    admin_override: bool
    manual_reference: str | None = None
    manual_reason: str | None = None
    approval_required: bool
    uncertain: bool
    initiated_by: RefundUserRef | None = None
    approved_by: RefundUserRef | None = None
    completed_by: RefundUserRef | None = None
    created_at: dt.datetime
    updated_at: dt.datetime
    completed_at: dt.datetime | None = None


class RefundBlocker(BaseModel):
    code: str
    message: str


class RefundOverview(BaseModel):
    """The refund panel for one cancellation. Amounts are rupees (Decimal)."""

    cancellation_id: str
    provider: str | None = None
    currency: str = "INR"
    manual_only: bool = False
    captured_amount: Decimal | None = None
    previously_refunded: Decimal | None = None
    in_progress: Decimal | None = None
    remaining_refundable: Decimal | None = None
    requested_amount: Decimal | None = None
    cancellation_remaining: Decimal | None = None
    approval_required: bool | None = None
    blocker: RefundBlocker | None = None
    payment: dict | None = None
    attempts: list[RefundAttemptOut] = []


class RefundInitiate(BaseModel):
    """POST .../refund. ``refund_amount`` (rupees) fixes what THIS cancellation
    refunds in total - allowed only before any money has gone. ``amount`` is
    this attempt's size and defaults to what is left of that total."""

    refund_amount: Decimal | None = None
    amount: Decimal | None = None


class RefundActionResult(BaseModel):
    outcome: str
    message: str
    overview: RefundOverview


class ManualRefundRecord(BaseModel):
    """POST .../refund/manual -- money already returned outside any gateway."""

    amount: Decimal | None = None
    reference: str
    reason: str
    admin_override: bool = False


class ResolveFailed(BaseModel):
    reason: str


class ReconcileResult(BaseModel):
    seen: int
    succeeded: int
    failed: int
    still_processing: int
    not_found: int
    stale: int
    errors: int
