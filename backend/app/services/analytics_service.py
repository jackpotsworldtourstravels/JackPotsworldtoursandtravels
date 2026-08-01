"""Analytics — M6 (API_CONTRACT.md §6.9).

Every figure this module returns is produced by a SQL aggregate. Nothing is
counted in Python over a fetched page, and nothing is left for a browser to add
up — M4 removed ten client-side money sums for exactly that reason, and M6's
stated requirement is that each tile is reproducible by a direct query.

Three rules the rest of the file follows:

* **Scope comes from the caller, not from a parameter.** Booking and change
  request analytics run through ``ticket_service.scoped_query``, the same
  predicate the list endpoints use, so a merchant's analytics can only ever
  describe its own rows. ``merchant_id`` narrows further and is honoured only
  for platform staff.
* **The date column is named in the response.** A prior phase shipped a filter
  on ``travel_date`` that every reader took for ``created_at``. Here the caller
  picks, the same column is used for filtering *and* for the monthly series, and
  the answer says which it was — so a series can never describe a different
  population from the totals sitting above it.
* **Money is ``Decimal`` end to end.** Sums come back from Postgres as
  ``Numeric``; they are quantised once, here, and typed ``Decimal`` in the
  schema so Pydantic renders them as strings.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any, Literal

from fastapi import HTTPException, status as http_status
from sqlalchemy import Numeric, and_, case, cast, func, literal_column, select, text
from sqlalchemy.orm import Session

from app.models_v2 import (
    Payment,
    PaymentStatus,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    User,
    UserRole,
    UserStatus,
)
from app.services import ticket_service
from app.services.booking_ops_service import QUEUE_STAGES
from app.services.lifecycle import SPEC_LABELS

#: Which column a date range and a monthly series may run on. Two, deliberately:
#: "when was this booked" and "when do they fly" are both legitimate questions
#: and they give different answers, so the caller states which one it is asking.
DateField = Literal["travel_date", "created_at"]

#: The service-request types M3/CR-6 govern. Enquiries, support tickets and live
#: chat are ``service_requests`` rows too and are not what this analytic means.
CHANGE_REQUEST_TYPES: tuple[RequestType, ...] = (
    RequestType.CANCELLATION,
    RequestType.DATE_CHANGE,
    RequestType.REFUND,
    RequestType.PASSENGER_MODIFICATION,
    RequestType.EXTRA_BAGGAGE,
    RequestType.MEAL,
    RequestType.SEAT,
)

#: Stages a booking is *waiting* in. ``TICKET_ISSUED`` is in M1's queue because
#: the desk still files paperwork against it, but nobody is waiting for it to be
#: booked any more — counting its age as queue age makes an idle number grow
#: forever and drowns the bookings that genuinely need attention.
WAITING_STAGES: tuple[S, ...] = tuple(s for s in QUEUE_STAGES if s is not S.TICKET_ISSUED)

#: A booking un-ticketed this long is flagged. Three working days: chosen so the
#: figure means something on the day it is read, and stated in the response so a
#: reader is never guessing what "breached" was measured against.
SLA_HOURS = 72

#: Bound on the time-to-issue sample. Without it the average is dominated by
#: bookings issued under rules that no longer exist.
TIME_TO_ISSUE_WINDOW_DAYS = 90

_ZERO = Decimal("0.00")


def _q(value: Any) -> Decimal:
    """Quantise a Postgres ``Numeric`` (or ``None``) to two places."""
    return (Decimal(str(value)) if value is not None else _ZERO).quantize(Decimal("0.01"))


def _staff(actor: User) -> None:
    """Refuse anyone who is not platform staff.

    403 rather than 404, matching ``booking_ops_service._staff``: the caller
    already knows whether the operations desk is theirs, so there is nothing to
    conceal and a plain refusal is more useful than a fake not-found.
    """
    if not actor.is_platform_staff:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Operations analytics are restricted to platform staff",
        )


def _date_column(field: DateField):
    return ServiceRequest.travel_date if field == "travel_date" else ServiceRequest.created_at


def _month_expr(field: DateField):
    """``YYYY-MM`` for the chosen column.

    ``created_at`` is a timestamptz, so it is cast to a date first: grouping the
    raw timestamp by month is correct, but the two branches then return
    different types and the ``ORDER BY`` stops agreeing with the label.
    """
    column = _date_column(field)
    if field == "created_at":
        column = cast(column, ServiceRequest.travel_date.type)
    return func.to_char(func.date_trunc("month", column), "YYYY-MM")


def _range_conditions(field: DateField, date_from: dt.date | None, date_to: dt.date | None) -> list:
    column = _date_column(field)
    conditions = []
    if date_from is not None:
        conditions.append(column >= date_from)
    if date_to is not None:
        # ``created_at`` is a timestamp: ``<= date_to`` would drop everything
        # that happened during the closing day. The travel-date branch is a
        # plain date and needs no such care, but one predicate is easier to
        # trust than two.
        conditions.append(column < (date_to + dt.timedelta(days=1)) if field == "created_at" else column <= date_to)
    return conditions


# ---------------------------------------------------------------------------
# Bookings
# ---------------------------------------------------------------------------
def booking_analytics(
    db: Session,
    actor: User,
    *,
    date_field: DateField = "travel_date",
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    merchant_id: int | None = None,
) -> dict:
    """Volume, value and mix for the bookings this caller may see.

    ``by_status`` and ``by_month`` are partitions of the same population as
    ``totals`` — every booking appears in exactly one bucket of each — so a
    reader can add a column up and get the headline figure back. That property
    is asserted in ``tests/verify_m6.py`` rather than merely intended.
    """
    conditions = [
        ticket_service.scoped_query(actor),
        ServiceRequest.request_type == RequestType.BOOKING,
        *_range_conditions(date_field, date_from, date_to),
    ]
    if merchant_id is not None and actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    where = and_(*conditions)

    count_col = func.count()
    value_col = func.coalesce(func.sum(ServiceRequest.total_amount), 0)

    total_count, total_value = db.execute(
        select(count_col, value_col).select_from(ServiceRequest).where(where)
    ).one()

    status_rows = db.execute(
        select(ServiceRequest.status, count_col, value_col)
        .where(where)
        .group_by(ServiceRequest.status)
    ).all()
    by_status = sorted(
        (
            {
                "status": status.value,
                "label": SPEC_LABELS.get(status, status.value),
                "count": count,
                "value": _q(value),
            }
            for status, count, value in status_rows
        ),
        key=lambda r: r["count"],
        reverse=True,
    )

    month = _month_expr(date_field)
    month_rows = db.execute(
        select(month.label("month"), count_col, value_col)
        .where(where)
        .group_by(literal_column("month"))
        .order_by(literal_column("month"))
    ).all()
    by_month = [
        # A NULL travel_date has no month. It is kept as an explicit bucket
        # rather than dropped, because a series that silently omits rows stops
        # summing to the total above it.
        {"month": m or "unscheduled", "count": count, "value": _q(value)}
        for m, count, value in month_rows
    ]

    origin = func.coalesce(
        ServiceRequest.travel_details["origin_city"].astext,
        ServiceRequest.travel_details["origin"].astext,
        text("''"),
    )
    destination = func.coalesce(
        ServiceRequest.travel_details["destination_city"].astext,
        ServiceRequest.travel_details["destination"].astext,
        text("''"),
    )
    route = origin.concat(" → ").concat(destination)
    route_rows = db.execute(
        select(route.label("route"), count_col, value_col)
        .where(and_(where, origin != "", destination != ""))
        .group_by(literal_column("route"))
        .order_by(count_col.desc(), literal_column("route"))
        .limit(10)
    ).all()

    return {
        "scope": "platform" if actor.is_platform_staff else "merchant",
        "date_field": date_field,
        "date_from": date_from,
        "date_to": date_to,
        "merchant_id": merchant_id if actor.is_platform_staff else actor.merchant_id,
        "totals": {
            "bookings": total_count,
            "value": _q(total_value),
            "average_value": _q(Decimal(str(total_value)) / total_count) if total_count else _ZERO,
        },
        "by_status": by_status,
        "by_month": by_month,
        "top_routes": [
            {"route": r, "count": count, "value": _q(value)} for r, count, value in route_rows
        ],
    }


# ---------------------------------------------------------------------------
# Operations desk
# ---------------------------------------------------------------------------
def operations_metrics(db: Session, actor: User) -> dict:
    """How the post-approval desk is doing: what is waiting, for how long, who
    is carrying it, and how long a booking takes to become a ticket.

    Staff only — a merchant has no business reading another company's queue age
    or an operator's caseload, and there is no merchant-scoped meaning for
    either figure.
    """
    _staff(actor)

    base = [
        ServiceRequest.request_type == RequestType.BOOKING,
        ServiceRequest.status.in_(QUEUE_STAGES),
    ]
    stage_rows = db.execute(
        select(ServiceRequest.status, func.count()).where(and_(*base)).group_by(ServiceRequest.status)
    ).all()
    queue = {s.value: 0 for s in QUEUE_STAGES}
    for status, count in stage_rows:
        queue[status.value] = count
    queue["total"] = sum(queue[s.value] for s in QUEUE_STAGES)
    queue["unassigned"] = db.scalar(
        select(func.count())
        .select_from(ServiceRequest)
        .where(and_(*base, ServiceRequest.assigned_admin.is_(None)))
    ) or 0

    # --- age of what is still waiting -------------------------------------
    waiting = [
        ServiceRequest.request_type == RequestType.BOOKING,
        ServiceRequest.status.in_(WAITING_STAGES),
    ]
    age_hours = func.extract("epoch", func.now() - ServiceRequest.created_at) / 3600.0
    age_row = db.execute(
        select(
            func.count(),
            func.coalesce(func.max(age_hours), 0),
            func.coalesce(func.avg(age_hours), 0),
            func.coalesce(
                func.percentile_cont(0.5).within_group(age_hours.asc()), 0
            ),
            func.count(case((age_hours < 24, 1))),
            func.count(case((and_(age_hours >= 24, age_hours < SLA_HOURS), 1))),
            func.count(case((age_hours >= SLA_HOURS, 1))),
        ).select_from(ServiceRequest).where(and_(*waiting))
    ).one()
    waiting_count, oldest, average, median, under_24, mid, breached = age_row

    # --- who is carrying it ------------------------------------------------
    load = (
        select(ServiceRequest.assigned_admin, func.count().label("load"))
        .where(and_(*waiting), ServiceRequest.assigned_admin.isnot(None))
        .group_by(ServiceRequest.assigned_admin)
        .subquery()
    )
    issued_since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
    issued = (
        select(ServiceRequest.assigned_admin, func.count().label("issued"))
        .where(
            ServiceRequest.request_type == RequestType.BOOKING,
            ServiceRequest.assigned_admin.isnot(None),
            ServiceRequest.status.in_((S.TICKET_ISSUED, S.COMPLETED)),
            ServiceRequest.updated_at >= issued_since,
        )
        .group_by(ServiceRequest.assigned_admin)
        .subquery()
    )
    operator_rows = db.execute(
        select(
            User.user_id,
            User.full_name,
            func.coalesce(load.c.load, 0),
            func.coalesce(issued.c.issued, 0),
        )
        .select_from(User)
        .join(load, load.c.assigned_admin == User.user_id, isouter=True)
        .join(issued, issued.c.assigned_admin == User.user_id, isouter=True)
        .where(User.role == UserRole.ADMIN, User.status == UserStatus.ACTIVE)
        .order_by(func.coalesce(load.c.load, 0).desc(), User.full_name)
    ).all()

    # --- how long a booking takes to become a ticket -----------------------
    #
    # Measured from the row's creation to the ``status_history`` entry that
    # recorded the move to ``ticket_issued`` — the same append-only history the
    # Activity Timeline renders, so the number is auditable against a screen the
    # desk already reads. ``updated_at`` would have been simpler and wrong: any
    # later edit (a note, a reference, a completion) moves it.
    issued_at = (
        select(func.max(cast(literal_column("elem->>'at'"), ServiceRequest.created_at.type)))
        .select_from(func.jsonb_array_elements(ServiceRequest.status_history).alias("elem"))
        .where(literal_column("elem->>'to'") == S.TICKET_ISSUED.value)
        .correlate(ServiceRequest)
        .scalar_subquery()
    )
    hours_to_issue = func.extract("epoch", issued_at - ServiceRequest.created_at) / 3600.0
    tti = db.execute(
        select(
            func.count(),
            func.coalesce(func.avg(hours_to_issue), 0),
            func.coalesce(func.percentile_cont(0.5).within_group(hours_to_issue.asc()), 0),
            func.coalesce(func.percentile_cont(0.9).within_group(hours_to_issue.asc()), 0),
        )
        .select_from(ServiceRequest)
        .where(
            ServiceRequest.request_type == RequestType.BOOKING,
            ServiceRequest.status.in_((S.TICKET_ISSUED, S.COMPLETED)),
            ServiceRequest.created_at
            >= dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=TIME_TO_ISSUE_WINDOW_DAYS),
            issued_at.isnot(None),
        )
    ).one()

    return {
        "queue": queue,
        "waiting": {
            "stages": [s.value for s in WAITING_STAGES],
            "count": waiting_count,
            "oldest_hours": round(float(oldest), 1),
            "average_hours": round(float(average), 1),
            "median_hours": round(float(median), 1),
            "buckets": {
                "under_24h": under_24,
                "h24_to_72h": mid,
                "over_72h": breached,
            },
        },
        "sla": {"threshold_hours": SLA_HOURS, "breached": breached},
        "operators": [
            {
                "user_id": uid,
                "full_name": name,
                "active_load": active,
                "issued_last_30d": done,
            }
            for uid, name, active, done in operator_rows
        ],
        "time_to_issue": {
            "window_days": TIME_TO_ISSUE_WINDOW_DAYS,
            "sample": tti[0],
            "average_hours": round(float(tti[1]), 1),
            "median_hours": round(float(tti[2]), 1),
            "p90_hours": round(float(tti[3]), 1),
        },
    }


# ---------------------------------------------------------------------------
# Cancellations, reschedules and refunds
# ---------------------------------------------------------------------------
def _pricing_sum(key: str):
    """Sum a money figure out of the ``pricing`` JSONB.

    M3 stores these as decimal *strings* so they survive a JSON round trip
    without becoming floats. Casting to ``numeric`` in SQL keeps that property
    all the way to the sum — reading them into Python and adding would work too,
    but only until somebody added a row the page size did not cover.
    """
    return func.coalesce(
        func.sum(cast(func.nullif(ServiceRequest.pricing[key].astext, ""), Numeric(14, 2))), 0
    )


def change_request_analytics(
    db: Session,
    actor: User,
    *,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    merchant_id: int | None = None,
) -> dict:
    """Cancellations, date changes and ancillaries — volume, outcome and money.

    The money block counts **approved** requests only. A rejected cancellation
    charges nothing and refunds nothing; including it would report money that
    never moved, which is the failure M4 exists to prevent.
    """
    conditions = [
        ticket_service.scoped_query(actor),
        ServiceRequest.request_type.in_(CHANGE_REQUEST_TYPES),
        *_range_conditions("created_at", date_from, date_to),
    ]
    if merchant_id is not None and actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    where = and_(*conditions)

    #: Approved and its settled successors. A cancellation that has already
    #: walked the parent booking to Cancelled is still an approved cancellation.
    settled_statuses = (S.APPROVED, S.COMPLETED, S.CANCELLED)

    type_rows = db.execute(
        select(
            ServiceRequest.request_type,
            func.count(),
            func.count(case((ServiceRequest.status.in_(settled_statuses), 1))),
            func.count(case((ServiceRequest.status == S.REJECTED, 1))),
            func.count(
                case((ServiceRequest.status.in_((S.PENDING_APPROVAL, S.IN_REVIEW)), 1))
            ),
        )
        .where(where)
        .group_by(ServiceRequest.request_type)
    ).all()
    by_type = sorted(
        (
            {
                "type": rtype.value,
                "label": rtype.value.replace("_", " ").title(),
                "total": total,
                "approved": approved,
                "rejected": rejected,
                "pending": pending,
            }
            for rtype, total, approved, rejected, pending in type_rows
        ),
        key=lambda r: r["total"],
        reverse=True,
    )

    money_where = and_(where, ServiceRequest.status.in_(settled_statuses))
    charges, refund_due, refund_settled, refund_short, fare_difference = db.execute(
        select(
            _pricing_sum("cancellation_charge"),
            _pricing_sum("refund_amount"),
            _pricing_sum("refund_settled"),
            _pricing_sum("refund_unsettled"),
            _pricing_sum("fare_difference"),
        ).select_from(ServiceRequest).where(money_where)
    ).one()

    # ``refund_unsettled`` is NOT "everything still owed". ``change_request_service``
    # writes that key only when a refund is *settled* and the booking's own
    # payments could not cover it — the recorded shortfall. A cancellation that
    # was approved and never settled at all carries neither key, so summing
    # settled + unsettled understates the debt and the two figures silently fail
    # to reconcile against ``refunds_due``. What is genuinely outstanding is the
    # difference, and it is reported as such.
    outstanding = _q(refund_due) - _q(refund_settled)

    return {
        "scope": "platform" if actor.is_platform_staff else "merchant",
        "date_field": "created_at",
        "date_from": date_from,
        "date_to": date_to,
        "totals": {
            "requests": sum(r["total"] for r in by_type),
            "approved": sum(r["approved"] for r in by_type),
            "rejected": sum(r["rejected"] for r in by_type),
            "pending": sum(r["pending"] for r in by_type),
        },
        "by_type": by_type,
        "money": {
            "basis": "approved requests only",
            "cancellation_charges": _q(charges),
            "refunds_due": _q(refund_due),
            "refunds_settled": _q(refund_settled),
            #: due − settled. Everything still owed, however it got there.
            "refunds_outstanding": outstanding,
            #: The shortfall M4 records when a settlement ran but the booking's
            #: own payments could not cover the refund — a subset of the above,
            #: and the part that needs a manual disbursement rather than time.
            "refunds_short_settled": _q(refund_short),
            "fare_differences": _q(fare_difference),
        },
    }


# ---------------------------------------------------------------------------
# Payments rollup — the totals behind the payments report
# ---------------------------------------------------------------------------
def payment_totals(
    db: Session,
    actor: User,
    *,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    merchant_id: int | None = None,
) -> dict:
    """Totals for the payments report, filtered exactly as its export is.

    Kept beside the other analytics rather than in ``finance_service``: this
    describes *the report's* rows, and ``finance_service`` answers a different
    question (what a merchant owes, netted). Two answers to two questions, each
    from one query — not two computations of one number.
    """
    conditions = []
    if not actor.is_platform_staff:
        conditions.append(Payment.merchant_id == actor.merchant_id)
    elif merchant_id is not None:
        conditions.append(Payment.merchant_id == merchant_id)
    if date_from is not None:
        conditions.append(Payment.created_at >= date_from)
    if date_to is not None:
        conditions.append(Payment.created_at < date_to + dt.timedelta(days=1))
    where = and_(*conditions) if conditions else text("true")

    row = db.execute(
        select(
            func.count(),
            func.coalesce(func.sum(Payment.amount), 0),
            func.coalesce(
                func.sum(case((Payment.payment_status == PaymentStatus.SUCCESS, Payment.amount))), 0
            ),
            func.coalesce(
                func.sum(case((Payment.payment_status == PaymentStatus.PENDING, Payment.amount))), 0
            ),
            func.coalesce(
                func.sum(case((Payment.payment_status == PaymentStatus.REFUNDED, Payment.amount))), 0
            ),
        ).select_from(Payment).where(where)
    ).one()

    return {
        "payments": row[0],
        "total": _q(row[1]),
        "verified": _q(row[2]),
        "pending": _q(row[3]),
        "refunded": _q(row[4]),
    }
