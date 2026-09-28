"""gaming_tour_enquiry_service.py — the Gaming Tour Enquiry desk.

ONE TABLE, ONE DESK, NO MERCHANT SCOPING. Every other queue this admin portal
reads (`ticket_service.scoped_query`, the Booking Enquiries screen) narrows by
which merchant a row belongs to; a gaming tour enquiry belongs to no merchant
at all; it is a member of the public's own request, so any platform admin may
see and work any row — there is nothing to scope.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models_v2 import GamingTourEnquiry, User
from app.schemas.gaming_tour_enquiry import GamingTourEnquiryCreate, GamingTourEnquiryUpdate

SEQUENCE = "seq_gaming_tour_enquiry_number"

#: What the queue still owes an answer — everything short of a terminal state.
OPEN_STATUSES = (
    "NEW", "ASSIGNED", "CONTACTED", "QUOTE_PREPARED", "CUSTOMER_CONFIRMED",
)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def next_reference(db: Session) -> str:
    """Allocate ``GT-20260928-000001``. Date-stamped and sequence-backed —
    the same pattern 0030/0046 built for Flight and Hotel enquiries — so two
    enquiries submitted in the same second cannot collide on the unique
    reference column."""
    number = db.scalar(select(func.nextval(SEQUENCE)))
    return f"GT-{_now():%Y%m%d}-{number:06d}"


def create(db: Session, payload: GamingTourEnquiryCreate) -> GamingTourEnquiry:
    row = GamingTourEnquiry(
        enquiry_reference=next_reference(db),
        customer_name=payload.name,
        email=str(payload.email),
        mobile_number=payload.mobile,
        from_airport=payload.from_airport,
        to_airport=payload.to_airport,
        travel_datetime=payload.travel_datetime,
        number_of_nights=payload.number_of_nights,
        casino_type=payload.casino_type,
        status="NEW",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get(db: Session, enquiry_id: int) -> GamingTourEnquiry | None:
    return db.get(GamingTourEnquiry, enquiry_id)


def list_enquiries(
    db: Session,
    *,
    status: str | None = None,
    search: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[GamingTourEnquiry], int]:
    """Newest first — an enquiry queue is read the way an inbox is."""
    stmt = select(GamingTourEnquiry)
    if status:
        stmt = stmt.where(GamingTourEnquiry.status == status)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                GamingTourEnquiry.enquiry_reference.ilike(like),
                GamingTourEnquiry.customer_name.ilike(like),
                GamingTourEnquiry.email.ilike(like),
                GamingTourEnquiry.mobile_number.ilike(like),
                GamingTourEnquiry.from_airport.ilike(like),
                GamingTourEnquiry.to_airport.ilike(like),
            )
        )
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(
        stmt.order_by(GamingTourEnquiry.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).scalars().all()
    return list(rows), total


def update(db: Session, row: GamingTourEnquiry, payload: GamingTourEnquiryUpdate) -> GamingTourEnquiry:
    """PATCH — only what was sent is written. Assigning an admin to a row
    still sitting at NEW moves it to ASSIGNED automatically UNLESS the same
    request also names a status, so "Assign to me" reads as one action
    rather than two clicks for a screen the brief asks to do both in one."""
    data = payload.model_dump(exclude_unset=True)
    if "admin_notes" in data:
        row.admin_notes = data["admin_notes"]
    if "assigned_admin_id" in data:
        row.assigned_admin_id = data["assigned_admin_id"]
        if "status" not in data and data["assigned_admin_id"] is not None and row.status == "NEW":
            row.status = "ASSIGNED"
    if "status" in data and data["status"] is not None:
        row.status = data["status"]
    db.commit()
    db.refresh(row)
    return row


def counts(db: Session) -> dict:
    """The dashboard card and the sidebar badge — same live-count shape the
    Ticket Enquiry queue already gives ``EnquiryCounts``."""
    rows = db.execute(
        select(GamingTourEnquiry.status, func.count()).group_by(GamingTourEnquiry.status)
    ).all()
    by_status = {s: c for s, c in rows}
    total = sum(by_status.values())
    return {
        "new": by_status.get("NEW", 0),
        "open": sum(by_status.get(s, 0) for s in OPEN_STATUSES),
        "total": total,
    }


def admin_item_dict(row: GamingTourEnquiry, admin_names: dict[int, str] | None = None) -> dict:
    names = admin_names or {}
    return {
        "id": row.id,
        "enquiry_reference": row.enquiry_reference,
        "customer_name": row.customer_name,
        "email": row.email,
        "mobile_number": row.mobile_number,
        "from_airport": row.from_airport,
        "to_airport": row.to_airport,
        "travel_datetime": row.travel_datetime,
        "number_of_nights": row.number_of_nights,
        "casino_type": row.casino_type,
        "status": row.status,
        "assigned_admin_id": row.assigned_admin_id,
        "assigned_admin_name": names.get(row.assigned_admin_id) if row.assigned_admin_id else None,
        "created_at": row.created_at,
    }


def admin_names_for(db: Session, rows: list[GamingTourEnquiry]) -> dict[int, str]:
    """One query for a whole page's worth of ``assigned_admin_name`` —
    resolved here rather than via a per-row ``relationship`` load, because
    User lives on the same Base but this service does not want an N+1 for a
    list screen."""
    ids = {r.assigned_admin_id for r in rows if r.assigned_admin_id}
    if not ids:
        return {}
    people = db.execute(select(User.user_id, User.full_name).where(User.user_id.in_(ids))).all()
    return {uid: name for uid, name in people}
