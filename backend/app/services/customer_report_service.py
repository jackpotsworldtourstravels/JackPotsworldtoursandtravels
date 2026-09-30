"""B2C report rows and exports for the admin desk — Phase 8 of the B2C Admin
Portal build-out (Reports).

REUSES, DOES NOT RE-IMPLEMENT. Downloads go through ``export_service.
build_export`` (CSV / Excel / PDF) — the same builder the B2B Reports screen
uses — and the same per-product booking/payment tables Phases 2-4 read. This
module only turns those rows into ``(columns, rows)`` for the builder. No table
is created or changed.

FIVE REPORTS: bookings, payments, cancellations (& refunds), customers, reviews.
Every one takes a created-date window; bookings, payments, cancellations and
reviews also take a status, and bookings, payments and cancellations a product.

ONE DAY BOUNDARY: INDIA TIME. A "date" filter means that calendar day in IST
(UTC+05:30, no daylight saving), for every report, so "1 Sept to 30 Sept" cuts
the same instant whichever report is chosen. The source services each cut the
day slightly differently (database time zone vs UTC), which is why the report
queries are written here rather than borrowed from their list functions.

SPREADSHEET-FORMULA SAFETY. A customer typed their name, and a review's words,
into a public form. A cell that begins ``=``, ``+``, ``-`` or ``@`` is run as a
formula when the file is opened in Excel, so every text value that came from a
customer is defused (:func:`safe`) before it reaches a file. The B2B export does
not do this because its text is staff-entered; this data is not.

ROW CAP. ``ROW_CAP`` rows, like the B2B reports; ``truncated`` says when it bit.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerCancellationRequest,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerReview,
)
from app.services import customer_review_admin_service as review_service

ROW_CAP = 5000
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

REPORT_TYPES = ("bookings", "payments", "cancellations", "customers", "reviews")
LABELS = {
    "bookings": "Bookings", "payments": "Payments", "cancellations": "Cancellations & Refunds",
    "customers": "Customers", "reviews": "Reviews",
}
PRODUCTS = ("flight", "hotel", "package")

#: The statuses each report can be filtered by (each table's own vocabulary).
STATUS_CHOICES = {
    "bookings": ("pending", "confirmed", "cancelled", "completed"),
    "payments": ("pending", "processing", "authorized", "captured", "failed", "cancelled", "expired", "refunded"),
    "cancellations": ("requested", "approved", "rejected", "refund_processing", "refunded"),
    "customers": ("active", "inactive", "blocked", "suspended"),
    "reviews": ("pending", "approved", "rejected"),
}
#: Which reports take a product filter.
PRODUCT_FILTERED = {"bookings", "payments", "cancellations"}
#: What each report's date filter is applied to, for the screen to say out loud.
DATE_FIELD = {
    "bookings": "booked on", "payments": "payment created", "cancellations": "requested on",
    "customers": "registered on", "reviews": "written on",
}
#: The money column each report can total, and what the total means.
#: The labels say exactly what is summed. A bookings total counts every status
#: shown (cancelled included) and a payments total counts every attempt (pending
#: and failed included) — neither is "revenue"; Analytics separates booked value
#: from collected money.
VALUE = {
    "bookings": ("amount", "Sum of these bookings (any status, cancelled included)"),
    "payments": ("amount", "Sum of these payment attempts (not only captured)"),
    "cancellations": ("refund_amount", "Sum of refund amounts"),
}

_DANGEROUS = ("=", "+", "-", "@", "\t", "\r")


def safe(value: Any) -> str:
    """Text for a spreadsheet cell: customer-typed text can never start a formula."""
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(_DANGEROUS) else text


def _money(value) -> str:
    return "" if value is None else str(Decimal(str(value)).quantize(Decimal("0.01")))


def _when(value: dt.datetime | None) -> str:
    return value.astimezone(IST).strftime("%Y-%m-%d %H:%M") if value else ""


def bounds(date_from: dt.date | None, date_to: dt.date | None) -> tuple[dt.datetime | None, dt.datetime | None]:
    """[start, end) as India-time instants for an inclusive date window."""
    start = dt.datetime.combine(date_from, dt.time.min, tzinfo=IST) if date_from else None
    end = dt.datetime.combine(date_to + dt.timedelta(days=1), dt.time.min, tzinfo=IST) if date_to else None
    return start, end


def _window(col, start, end) -> list:
    conds = []
    if start is not None:
        conds.append(col >= start)
    if end is not None:
        conds.append(col < end)
    return conds


# --------------------------------------------------------------------------- #
# Row builders — each returns (columns, rows)
# --------------------------------------------------------------------------- #

def _bookings(db, *, start, end, status, product):
    specs = (
        ("flight", CustomerBooking, lambda b: f"{b.origin_city or b.origin_code or '?'} → {b.destination_city or b.destination_code or '?'}", lambda b: b.travel_date),
        ("hotel", CustomerHotelBooking, lambda b: b.hotel_name, lambda b: b.check_in_date),
        ("package", CustomerPackageBooking, lambda b: b.package_name, lambda b: b.departure_date),
    )
    rows: list[dict] = []
    for p, model, title, travel in specs:
        if product and p != product:
            continue
        q = select(model, Customer).join(Customer, Customer.customer_id == model.customer_id).where(*_window(model.created_at, start, end))
        if status:
            q = q.where(model.status == status)
        for b, c in db.execute(q.order_by(model.created_at.desc()).limit(ROW_CAP)).all():
            rows.append({
                "booking_ref": b.booking_ref, "product": p, "customer": safe(c.full_name), "email": safe(c.email),
                "item": safe(title(b)), "travel_date": str(travel(b) or ""),
                "status": b.status.value if hasattr(b.status, "value") else b.status,
                "amount": _money(b.total_amount), "currency": b.currency, "booked_on": _when(b.created_at),
                "_at": b.created_at,
            })
    rows.sort(key=lambda r: r["_at"], reverse=True)
    cols = [("booking_ref", "Booking ID"), ("product", "Service"), ("customer", "Customer"), ("email", "Email"),
            ("item", "Trip / Stay"), ("travel_date", "Travel date"), ("status", "Status"),
            ("amount", "Amount"), ("currency", "Currency"), ("booked_on", "Booked on (IST)")]
    return cols, rows


def _payments(db, *, start, end, status, product):
    specs = (
        ("package", CustomerPackageBookingPayment, CustomerPackageBooking, CustomerPackageBookingPayment.package_booking_id, "customer_package_booking_id"),
        ("hotel", CustomerHotelBookingPayment, CustomerHotelBooking, CustomerHotelBookingPayment.hotel_booking_id, "customer_hotel_booking_id"),
        ("flight", CustomerBookingPayment, CustomerBooking, CustomerBookingPayment.customer_booking_id, "customer_booking_id"),
    )
    rows: list[dict] = []
    for p, pay, book, fk, pk_name in specs:
        if product and p != product:
            continue
        q = (select(pay, book, Customer).join(book, fk == getattr(book, pk_name))
             .join(Customer, Customer.customer_id == book.customer_id).where(*_window(pay.created_at, start, end)))
        if status:
            q = q.where(pay.status == status)
        for pm, b, c in db.execute(q.order_by(pay.created_at.desc()).limit(ROW_CAP)).all():
            rows.append({
                "booking_ref": b.booking_ref, "product": p, "customer": safe(c.full_name), "email": safe(c.email),
                "provider": safe(pm.provider or ""), "provider_ref": safe(pm.provider_payment_id or pm.provider_order_id or ""),
                "status": pm.status.value if hasattr(pm.status, "value") else pm.status,
                "amount": _money(pm.amount), "currency": pm.currency, "created": _when(pm.created_at),
                "paid_at": _when(pm.paid_at), "_at": pm.created_at,
            })
    rows.sort(key=lambda r: r["_at"], reverse=True)
    cols = [("booking_ref", "Booking ID"), ("product", "Service"), ("customer", "Customer"), ("email", "Email"),
            ("provider", "Gateway"), ("provider_ref", "Gateway reference"), ("status", "Payment status"),
            ("amount", "Amount"), ("currency", "Currency"), ("created", "Created (IST)"), ("paid_at", "Paid (IST)")]
    return cols, rows


def _cancellations(db, *, start, end, status, product):
    m = CustomerCancellationRequest
    q = select(m, Customer).join(Customer, Customer.customer_id == m.customer_id).where(*_window(m.created_at, start, end))
    if status:
        q = q.where(m.status == status)
    if product:
        q = q.where(m.product == product)
    rows = [{
        "ref": r.cancellation_ref, "booking_ref": r.booking_ref, "product": r.product,
        "customer": safe(c.full_name), "email": safe(c.email), "reason": safe(r.reason or ""), "status": r.status,
        "refund_amount": _money(r.refund_amount), "requested": _when(r.created_at), "updated": _when(r.updated_at),
    } for r, c in db.execute(q.order_by(m.created_at.desc()).limit(ROW_CAP)).all()]
    cols = [("ref", "Cancellation ID"), ("booking_ref", "Booking ID"), ("product", "Service"), ("customer", "Customer"),
            ("email", "Email"), ("reason", "Reason"), ("status", "Status"), ("refund_amount", "Refund amount"),
            ("requested", "Requested (IST)"), ("updated", "Updated (IST)")]
    return cols, rows


def _customers(db, *, start, end, status, product):
    counts: dict[int, int] = {}
    for model in (CustomerBooking, CustomerHotelBooking, CustomerPackageBooking):
        for cid, n in db.execute(select(model.customer_id, func.count()).group_by(model.customer_id)):
            counts[cid] = counts.get(cid, 0) + n
    q = select(Customer).where(*_window(Customer.created_at, start, end))
    if status:
        q = q.where(Customer.status == status)
    rows = [{
        "code": c.customer_code, "name": safe(c.full_name), "email": safe(c.email), "mobile": safe(c.mobile),
        "status": c.status.value if hasattr(c.status, "value") else c.status,
        "account": "Guest" if c.is_guest else "Registered",
        "email_verified": "Yes" if c.email_verified else "No", "mobile_verified": "Yes" if c.mobile_verified else "No",
        "bookings": counts.get(c.customer_id, 0), "registered": _when(c.created_at),
    } for c in db.scalars(q.order_by(Customer.created_at.desc()).limit(ROW_CAP))]
    cols = [("code", "Customer ID"), ("name", "Name"), ("email", "Email"), ("mobile", "Mobile"), ("status", "Status"),
            ("account", "Account"), ("email_verified", "Email verified"), ("mobile_verified", "Mobile verified"),
            ("bookings", "Total bookings"), ("registered", "Registered (IST)")]
    return cols, rows


def _reviews(db, *, start, end, status, product):
    q = select(CustomerReview, Customer).join(Customer, Customer.customer_id == CustomerReview.customer_id).where(
        *_window(CustomerReview.created_at, start, end))
    if status:
        q = q.where(CustomerReview.status == status)
    found = db.execute(q.order_by(CustomerReview.created_at.desc()).limit(ROW_CAP)).all()
    names = review_service.item_names(db, {(r.item_type, r.item_id) for r, _ in found})
    rows = []
    for r, c in found:
        name, prod = names[(r.item_type, r.item_id)]
        rows.append({
            "customer": safe(c.full_name), "email": safe(c.email), "product": prod, "item": safe(name),
            "rating": r.rating, "comment": safe(r.comment or ""), "status": r.status,
            "reply": safe(r.admin_reply or ""), "written": _when(r.created_at),
        })
    cols = [("customer", "Customer"), ("email", "Email"), ("product", "Service"), ("item", "Item"), ("rating", "Rating"),
            ("comment", "Review"), ("status", "Status"), ("reply", "Our reply"), ("written", "Written (IST)")]
    return cols, rows


_BUILDERS = {"bookings": _bookings, "payments": _payments, "cancellations": _cancellations,
             "customers": _customers, "reviews": _reviews}


def build(
    db: Session, report: str, *, date_from: dt.date | None = None, date_to: dt.date | None = None,
    status: str | None = None, product: str | None = None,
) -> tuple[list[tuple[str, str]], list[dict]]:
    start, end = bounds(date_from, date_to)
    cols, rows = _BUILDERS[report](db, start=start, end=end, status=status, product=product)
    rows = rows[:ROW_CAP]
    for r in rows:
        r.pop("_at", None)
    return cols, rows


def preview(db: Session, report: str, **filters) -> dict:
    cols, rows = build(db, report, **filters)
    total_value = None
    # A total across mixed currencies would be a meaningless number, so it is
    # withheld rather than shown (every row is INR today).
    if report in VALUE and len({r.get("currency") for r in rows if r.get("currency")}) <= 1:
        key = VALUE[report][0]
        total_value = str(sum((Decimal(r[key]) for r in rows if r.get(key)), Decimal("0")).quantize(Decimal("0.01")))
    return {
        "type": report, "label": LABELS[report], "date_field": DATE_FIELD[report],
        "columns": [{"key": k, "label": l} for k, l in cols],
        "rows": rows[:10], "row_count": len(rows), "truncated": len(rows) >= ROW_CAP, "row_cap": ROW_CAP,
        "total_value": total_value, "value_label": VALUE[report][1] if report in VALUE else None,
    }
