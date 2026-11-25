"""B2C dashboard — the operational "what needs me now" landing for the B2C
Admin Portal.

This is deliberately NOT the B2C Analytics overview. Analytics answers "how is
the desk doing over a period" (monthly series, funnels, top items);
``customer_analytics_admin_service``). This answers "what is open right now":
all-time counts of things that need an admin's attention plus the headline
money figures, so the dashboard can send the admin straight to the queue that
needs them.

Every figure is a direct ``COUNT`` / ``SUM``, reproducible by a single SQL
query, and uses **no month bucketing** (no ``to_char`` / ``timezone`` casts), so
it runs identically on PostgreSQL and on the SQLite test harness — unlike the
analytics overview, which is PostgreSQL-only. Read-only; the router gates it on
``b2c.reports.view`` (the same code as the analytics overview). It never writes,
and carries no customer PII — only counts and INR totals.

BOOKED VALUE vs COLLECTED (the analytics rule, applied here too):
* ``booked_value`` — ``total_amount`` of bookings not cancelled: what is on the
  books, paid or not.
* ``collected``   — sum of payments that were captured: money actually received.
  ``refunded`` counts too: customer_refund_service moves a payment from
  ``captured`` to ``refunded`` only after refunding it in full, so leaving it
  out would make collected money shrink when a refund is paid.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerConversation,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerReview,
    CustomerStatus,
)
from app.services.customer_report_service import IST

_TWO = Decimal("0.01")

#: Known customer-booking statuses (same vocabulary as the analytics service).
_BOOKING_STATUSES = ("pending", "confirmed", "cancelled", "completed")

#: Conversations needing attention are those not resolved or closed.
_OPEN_CONVERSATION = ("waiting", "active")

#: Payment statuses meaning the money arrived (``refunded`` is reached only
#: from ``captured``) — the same rule as the analytics service.
_COLLECTED = ("captured", "refunded")

#: (booking model, payment model) — the same three products the analytics
#: service sums over. Each payment row carries its booking's money, so summing
#: captured payments per table equals summing per booking (no join needed).
_PRODUCTS = (
    (CustomerBooking, CustomerBookingPayment),
    (CustomerHotelBooking, CustomerHotelBookingPayment),
    (CustomerPackageBooking, CustomerPackageBookingPayment),
)


def _m(value) -> str:
    """Quantise to 2 dp as a string, exactly like the analytics service."""
    return str(Decimal(str(value or 0)).quantize(_TWO))


def summary(
    db: Session,
    *,
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
) -> dict:
    """The operational snapshot.

    ``start``/``end`` (UTC, end exclusive) scope the PERIOD metrics — bookings,
    their status split, booked value, collected payments and the service level —
    to a date window (the dashboard's 1 day / 1 week / 1 month / custom filter).
    When both are None the figures are all-time, exactly as before. The live
    queues (support, pending reviews, blocked customers) are a "right now" state
    and are never windowed — an open chat is open regardless of the period.
    """
    now = dt.datetime.now(IST)
    since_30d = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)

    def _within(col):
        """Date-window predicates for a model's created_at, or [] for all-time."""
        preds = []
        if start is not None:
            preds.append(col >= start)
        if end is not None:
            preds.append(col < end)
        return preds

    # ---- customers (current state; new_30d is always the rolling 30 days) ---
    cust_total = db.scalar(select(func.count()).select_from(Customer)) or 0
    cust_blocked = db.scalar(
        select(func.count()).where(Customer.status == CustomerStatus.BLOCKED)
    ) or 0
    cust_guests = db.scalar(select(func.count()).where(Customer.is_guest.is_(True))) or 0
    cust_new_30d = db.scalar(
        select(func.count()).where(Customer.created_at >= since_30d)
    ) or 0
    customers = {
        "total": cust_total,
        "blocked": cust_blocked,
        "guests": cust_guests,
        "registered": cust_total - cust_guests,
        "new_30d": cust_new_30d,
    }

    # ---- bookings (windowed by created_at when a period is given) -----------
    status_counts = {s: 0 for s in _BOOKING_STATUSES}
    total_bookings = 0
    booked_value = Decimal(0)
    collected = Decimal(0)
    for book, pay in _PRODUCTS:
        stmt = select(book.status, func.count(), func.coalesce(func.sum(book.total_amount), 0)).group_by(book.status)
        for p in _within(book.created_at):
            stmt = stmt.where(p)
        for st, n, value in db.execute(stmt):
            status_counts[st] = status_counts.get(st, 0) + n
            total_bookings += n
            if st != "cancelled":
                booked_value += Decimal(str(value))
        pay_stmt = select(func.coalesce(func.sum(pay.amount), 0)).where(pay.status.in_(_COLLECTED))
        for p in _within(pay.created_at):
            pay_stmt = pay_stmt.where(p)
        collected += Decimal(str(db.scalar(pay_stmt) or 0))
    # Service level: share of bookings in the period that reached confirmed or
    # completed (i.e. were served), vs everything booked. 100% when there are
    # no bookings yet, so an empty desk does not read as a failure.
    served = status_counts.get("confirmed", 0) + status_counts.get("completed", 0)
    service_level = round(served / total_bookings * 100) if total_bookings else 100
    bookings = {
        "total": total_bookings,
        "by_status": status_counts,
        "booked_value": _m(booked_value),
        "collected": _m(collected),
    }

    # ---- reviews -----------------------------------------------------------
    reviews = {
        "pending": db.scalar(
            select(func.count()).where(CustomerReview.status == "pending")
        ) or 0,
        "approved": db.scalar(
            select(func.count()).where(CustomerReview.status == "approved")
        ) or 0,
    }

    # ---- support (live conversations) --------------------------------------
    open_conversations = db.scalar(
        select(func.count()).where(CustomerConversation.status.in_(_OPEN_CONVERSATION))
    ) or 0
    waiting_unassigned = db.scalar(
        select(func.count()).where(
            CustomerConversation.status == "waiting",
            CustomerConversation.assigned_admin_id.is_(None),
        )
    ) or 0
    admin_unread = db.scalar(
        select(func.coalesce(func.sum(CustomerConversation.admin_unread_count), 0)).where(
            CustomerConversation.status.in_(_OPEN_CONVERSATION)
        )
    ) or 0
    support = {
        "open_conversations": open_conversations,
        "waiting_unassigned": waiting_unassigned,
        "admin_unread": int(admin_unread),
    }

    return {
        "generated_at": now.isoformat(),
        "service_level": service_level,
        "customers": customers,
        "bookings": bookings,
        "reviews": reviews,
        "support": support,
    }
