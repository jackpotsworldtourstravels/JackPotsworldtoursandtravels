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
