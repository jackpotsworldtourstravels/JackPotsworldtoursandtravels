"""B2C analytics for the admin desk — Phase 8 of the B2C Admin Portal build-out
(Analytics).

THE B2B ANALYTICS RULE APPLIES HERE: every figure must be reproducible by a
direct SQL query. Nothing is estimated, projected or smoothed; where a figure is
a percentage the screen derives it from two counts that arrive in the response,
and it is a label, never a stored number.

BOOKED VALUE AND COLLECTED MONEY ARE DIFFERENT NUMBERS, AND BOTH ARE SHOWN.
A booking's ``total_amount`` is what the customer agreed to pay; money has only
been collected once a payment is ``captured``. Reporting the first as "revenue"
would overstate income by everything unpaid — today the payment provider is off,
so every booking is pending and collected money is genuinely zero. So:

* ``booked_value``   — total_amount of bookings not cancelled (pending, confirmed
                       or completed): what is on the books.
* ``confirmed_value`` — of that, bookings confirmed or completed.
* ``collected``      — sum of captured payments. This is the only "money in".
* ``refunded``       — refund_amount of cancellation requests marked refunded.

Amounts are summed as INR. Every booking today is INR; ``non_inr_bookings``
counts any that are not, so a mixed-currency table is flagged rather than added
up silently.

MONTHS ARE INDIA-TIME CALENDAR MONTHS (Asia/Kolkata), oldest first, and the
server supplies the frame so the browser draws and never computes a bucket.
The window is ``months`` calendar months ending with the current one.
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
    CustomerCancellationRequest,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerReview,
)
from app.services.customer_report_service import IST

MIN_MONTHS, MAX_MONTHS, DEFAULT_MONTHS = 1, 24, 6

_TWO = Decimal("0.01")

#: (product, booking model, booking pk attr, payment model, payment FK attr)
_PRODUCTS = (
    ("flight", CustomerBooking, "customer_booking_id", CustomerBookingPayment, "customer_booking_id"),
    ("hotel", CustomerHotelBooking, "customer_hotel_booking_id", CustomerHotelBookingPayment, "hotel_booking_id"),
    ("package", CustomerPackageBooking, "customer_package_booking_id", CustomerPackageBookingPayment, "package_booking_id"),
)
_STATUSES = ("pending", "confirmed", "cancelled", "completed")


def _m(value) -> str:
    return str(Decimal(str(value or 0)).quantize(_TWO))


def month_frame(months: int, today: dt.date | None = None) -> list[str]:
    """The last ``months`` calendar months ('YYYY-MM'), oldest first, ending with this one."""
    today = today or dt.datetime.now(IST).date()
    y, mo = today.year, today.month
    out = []
    for _ in range(months):
        out.append(f"{y:04d}-{mo:02d}")
        mo -= 1
        if mo == 0:
            y, mo = y - 1, 12
    return out[::-1]


def _start(frame: list[str]) -> dt.datetime:
    y, mo = map(int, frame[0].split("-"))
    return dt.datetime(y, mo, 1, tzinfo=IST)


def _month(col):
    return func.to_char(func.timezone("Asia/Kolkata", col), "YYYY-MM")


def _fill(frame: list[str], rows: dict[str, tuple]) -> list[dict]:
    return [{"month": k, "count": rows.get(k, (0, 0))[0], "value": _m(rows.get(k, (0, 0))[1])} for k in frame]


def overview(db: Session, months: int = DEFAULT_MONTHS) -> dict:
    months = max(MIN_MONTHS, min(MAX_MONTHS, months))
    frame = month_frame(months)
    start = _start(frame)

    # ---- customers ---------------------------------------------------------
    cust_total = db.scalar(select(func.count()).select_from(Customer)) or 0
    cust_guests = db.scalar(select(func.count()).where(Customer.is_guest.is_(True))) or 0
    c_month = _month(Customer.created_at)
    cust_by_month = dict(db.execute(
        select(c_month, func.count()).where(Customer.created_at >= start).group_by(c_month)
    ).all())
    customers = {
        "total": cust_total, "guests": cust_guests, "registered": cust_total - cust_guests,
        "new_in_period": sum(cust_by_month.values()),
        "by_month": [{"month": k, "count": cust_by_month.get(k, 0)} for k in frame],
    }

    # ---- bookings ----------------------------------------------------------
    by_month: dict[str, dict[str, tuple]] = {}
    products, status_totals = [], {s: [0, Decimal(0)] for s in _STATUSES}
    booked_value = confirmed_value = Decimal(0)
    cancelled = created = non_inr = 0
    with_payment = captured_bookings = 0
    for product, book, pk_attr, pay, fk_attr in _PRODUCTS:
        in_period = book.created_at >= start
        b_month = _month(book.created_at)
        by_month[product] = {
            k: (n, v) for k, n, v in db.execute(
                select(b_month, func.count(), func.coalesce(func.sum(book.total_amount), 0))
                .where(in_period).group_by(b_month))
        }
        st = {s: (n, v) for s, n, v in db.execute(
            select(book.status, func.count(), func.coalesce(func.sum(book.total_amount), 0))
            .where(in_period).group_by(book.status))}
        p_count = sum(n for n, _ in st.values())
        p_cancelled = st.get("cancelled", (0, 0))[0]
        p_booked = sum((Decimal(str(v)) for s, (n, v) in st.items() if s != "cancelled"), Decimal(0))
        p_confirmed = sum((Decimal(str(v)) for s, (n, v) in st.items() if s in ("confirmed", "completed")), Decimal(0))
        for s, (n, v) in st.items():
            status_totals[s][0] += n
            status_totals[s][1] += Decimal(str(v))
        products.append({
            "product": product, "bookings": p_count, "cancelled": p_cancelled,
            "booked_value": _m(p_booked), "confirmed_value": _m(p_confirmed),
        })
        created += p_count; cancelled += p_cancelled; booked_value += p_booked; confirmed_value += p_confirmed
        non_inr += db.scalar(select(func.count()).where(in_period, book.currency != "INR")) or 0
        pk, fk = getattr(book, pk_attr), getattr(pay, fk_attr)
        with_payment += db.scalar(select(func.count(func.distinct(fk))).select_from(pay).join(book, fk == pk).where(in_period)) or 0
        captured_bookings += db.scalar(
            select(func.count(func.distinct(fk))).select_from(pay).join(book, fk == pk)
            .where(in_period, pay.status == "captured")) or 0

    bookings = {
        "created": created, "cancelled": cancelled, "booked_value": _m(booked_value),
        "confirmed_value": _m(confirmed_value), "non_inr_bookings": non_inr,
        "by_status": [{"status": s, "count": n, "value": _m(v)} for s, (n, v) in status_totals.items()],
        "by_product": products,
        "monthly": [
            {"product": p, "series": _fill(frame, by_month[p])} for p, *_ in _PRODUCTS
        ],
    }

    # ---- payments (collected money) ---------------------------------------
    pay_status: dict[str, list] = {}
    pay_provider: dict[str, list] = {}
    for _, _, _, pay, _ in _PRODUCTS:
        for s, n, v in db.execute(
            select(pay.status, func.count(), func.coalesce(func.sum(pay.amount), 0))
            .where(pay.created_at >= start).group_by(pay.status)
        ):
            e = pay_status.setdefault(s, [0, Decimal(0)]); e[0] += n; e[1] += Decimal(str(v))
        for prov, n, v in db.execute(
            select(pay.provider, func.count(), func.coalesce(func.sum(pay.amount), 0))
            .where(pay.created_at >= start, pay.status == "captured").group_by(pay.provider)
        ):
            e = pay_provider.setdefault(prov or "unknown", [0, Decimal(0)]); e[0] += n; e[1] += Decimal(str(v))
    payments = {
        "collected": _m(pay_status.get("captured", [0, 0])[1]),
        "captured_count": pay_status.get("captured", [0, 0])[0],
        "by_status": [{"status": s, "count": n, "amount": _m(v)} for s, (n, v) in sorted(pay_status.items())],
        "by_provider": [{"provider": p, "count": n, "amount": _m(v)} for p, (n, v) in sorted(pay_provider.items())],
    }

    # ---- refunds -----------------------------------------------------------
    cr = CustomerCancellationRequest
    ref = {s: (n, v) for s, n, v in db.execute(
        select(cr.status, func.count(), func.coalesce(func.sum(cr.refund_amount), 0))
        .where(cr.created_at >= start).group_by(cr.status))}
    refunds = {
        "requests": sum(n for n, _ in ref.values()), "refunded": _m(ref.get("refunded", (0, 0))[1]),
        "by_status": [{"status": s, "count": n, "amount": _m(v)} for s, (n, v) in sorted(ref.items())],
    }

    # ---- funnel ------------------------------------------------------------
    funnel = [
        {"step": "Bookings created", "count": created},
        {"step": "Payment attempted", "count": with_payment},
        {"step": "Payment captured", "count": captured_bookings},
    ]

    # ---- top items ---------------------------------------------------------
    def top(model, label_col, expr=None):
        label = expr if expr is not None else label_col
        rows = db.execute(
            select(label, func.count().label("n"), func.coalesce(func.sum(model.total_amount), 0))
            .where(model.created_at >= start, model.status != "cancelled")
            .group_by(label).order_by(func.count().desc(), label).limit(5)).all()
        return [{"name": name or "—", "bookings": n, "value": _m(v)} for name, n, v in rows]

    route = func.concat(
        func.coalesce(CustomerBooking.origin_city, CustomerBooking.origin_code, "?"), " → ",
        func.coalesce(CustomerBooking.destination_city, CustomerBooking.destination_code, "?"))
    top_items = {
        "packages": top(CustomerPackageBooking, CustomerPackageBooking.package_name),
        "hotels": top(CustomerHotelBooking, CustomerHotelBooking.hotel_name),
        "flight_routes": top(CustomerBooking, None, route),
    }

    # ---- reviews -----------------------------------------------------------
    avg = db.scalar(select(func.avg(CustomerReview.rating)).where(CustomerReview.status == "approved"))
    reviews = {
        "approved": db.scalar(select(func.count()).where(CustomerReview.status == "approved")) or 0,
        "pending": db.scalar(select(func.count()).where(CustomerReview.status == "pending")) or 0,
        "average": _m(avg) if avg is not None else None,
    }

    return {
        "months": months, "frame": frame, "since": frame[0], "customers": customers, "bookings": bookings,
        "payments": payments, "refunds": refunds, "funnel": funnel, "top": top_items, "reviews": reviews,
        "definitions": {
            "booked_value": "Total of bookings not cancelled — what is on the books, paid or not.",
            "confirmed_value": "Of that, bookings confirmed or completed.",
            "collected": "Captured payments — the only money actually received.",
            "refunded": "Refund amounts on cancellation requests marked refunded.",
        },
    }
