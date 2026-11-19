"""Response schema for the B2C Admin Portal dashboard — the operational
"what needs me now" snapshot (``GET /api/admin/b2c-dashboard/summary``).

Amounts are INR strings, exactly as the B2C analytics overview returns them
(``customer_analytics_admin_service._m``), so the browser renders and never
re-computes money. No customer PII is carried here — only counts and totals.
"""
from __future__ import annotations

from pydantic import BaseModel


class DashboardCustomers(BaseModel):
    total: int
    blocked: int
    guests: int
    registered: int
    new_30d: int


class DashboardBookings(BaseModel):
    total: int
    #: Count per booking status (``pending`` / ``confirmed`` / ``cancelled`` /
    #: ``completed``), summed across flights, hotels and packages.
    by_status: dict[str, int]
    #: Total ``total_amount`` of bookings that are not cancelled (INR).
    booked_value: str
    #: Sum of payments that were captured, all time (INR) — money actually in,
    #: including payments later refunded in full (status ``refunded``).
    collected: str


class DashboardReviews(BaseModel):
    pending: int
    approved: int


class DashboardSupport(BaseModel):
    #: Conversations in ``waiting`` or ``active`` (not resolved/closed).
    open_conversations: int
    #: ``waiting`` conversations with no assigned agent — the live queue.
    waiting_unassigned: int
    #: Total unread-by-admin messages across open conversations.
    admin_unread: int


class B2CDashboardSummary(BaseModel):
    #: Server clock (Asia/Kolkata, ISO 8601) the snapshot was taken at.
    generated_at: str
    customers: DashboardCustomers
    bookings: DashboardBookings
    reviews: DashboardReviews
    support: DashboardSupport
