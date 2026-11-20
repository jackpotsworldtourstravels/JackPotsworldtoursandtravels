"""What the admin desk is allowed to see about a B2C customer.

An allow-list, the same discipline ``customer_payment_admin.py`` uses: fields
are chosen, not serialised because they happened to be on the model. No
password hash, no OTP, no raw auth row — ``CustomerAuth``/``CustomerOtp`` are
never imported by this module.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.customer_payment_admin import CustomerPaymentRow


class CustomerListItem(BaseModel):
    """One row on the Customers list."""

    model_config = ConfigDict(from_attributes=True)

    customer_id: int
    customer_code: str
    full_name: str
    email: str
    mobile: str
    status: str
    is_guest: bool
    created_at: dt.datetime
    total_bookings: int


class CustomerList(BaseModel):
    items: list[CustomerListItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class CustomerBookingSummary(BaseModel):
    """One row of a customer's Booking History, whichever product it is."""

    product: str  # flight | hotel | package
    booking_id: int
    booking_ref: str
    title: str
    travel_date: dt.date | None
    amount: Decimal
    status: str
    created_at: dt.datetime


class CustomerReviewSummary(BaseModel):
    review_id: int
    item_type: str
    item_id: int
    rating: int
    comment: str | None
    created_at: dt.datetime


class CustomerDetail(BaseModel):
    """Profile Information + Booking History + Payment History + Reviews."""

    model_config = ConfigDict(from_attributes=True)

    customer_id: int
    customer_code: str
    full_name: str
    email: str
    mobile: str
    status: str
    is_guest: bool
    email_verified: bool
    mobile_verified: bool
    created_at: dt.datetime
    updated_at: dt.datetime

    total_bookings: int
    total_spend: Decimal

    bookings: list[CustomerBookingSummary]
    payments: list[CustomerPaymentRow]
    reviews: list[CustomerReviewSummary]


# --- Stage 3 M1: account actions --------------------------------------------
class CustomerBlockRequest(BaseModel):
    """Blocking requires a reason (it is recorded in the audit trail)."""

    reason: str = Field(..., min_length=1, max_length=500)


class CustomerUnblockRequest(BaseModel):
    """Unblocking reason is optional."""

    reason: str | None = Field(None, max_length=500)


class CustomerPasswordResetRequest(BaseModel):
    """Admin-initiated reset. ``force_logout`` also kills live sessions now.

    There is deliberately no password field: the admin never sees, generates or
    sets a password — the customer receives the standard secure email link."""

    force_logout: bool = False


class CustomerStatusChangeResponse(BaseModel):
    status: str          # the action taken: "blocked" | "active"
    customer_id: int
    from_status: str
    to_status: str


class CustomerPasswordResetResponse(BaseModel):
    """Never carries a token, link or password — only that the email was sent."""

    status: str          # "reset email sent"
