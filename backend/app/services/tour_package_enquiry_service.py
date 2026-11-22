"""tour_package_enquiry_service.py — stores a Tour Package enquiry raised from
the Contact Us page. See `app.models_v2.TourPackageEnquiry` for the table
shape and why it carries no merchant/customer foreign key."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models_customer import CustomerPackage
from app.models_v2 import SystemLog, TourPackageEnquiry, User
from app.schemas.tour_package_enquiry import (
    OPEN_STATUSES,
    TourPackageEnquiryCreate,
    TourPackageEnquiryUpdate,
)

SEQUENCE = "seq_tour_package_enquiry_number"

#: The System Logs module these enquiries' audit rows are written under, so the
#: queue's history read (:func:`audit_trail`) can find them again.
AUDIT_MODULE = "TourPackageEnquiries"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _existing_package_id(db: Session, package_id: int | None) -> int | None:
    """Degrade a stale/removed package id to ``None`` rather than let the
    database's own foreign key reject the whole enquiry.

    ``package_id`` is read off the query string at the moment the customer
    clicked "Enquire about dates"; by the time they submit, the catalogue row
    could in principle have been deleted. ``package_name`` is always stored
    as free text regardless, so the enquiry stays answerable either way —
    this only decides whether it keeps its link to the live catalogue row.
    """
    if package_id is None:
        return None
    found = db.execute(
        select(CustomerPackage.customer_package_id)
        .where(CustomerPackage.customer_package_id == package_id)
    ).scalar_one_or_none()
    return found


def next_reference(db: Session) -> str:
    """Allocate ``TPE-20261001-000001`` — the same date-stamped, sequence-backed
    pattern Flight (0030), Hotel (0046) and Gaming Tour (0088) enquiries use,
    so two submissions in the same second cannot collide on the unique
    reference column."""
    number = db.scalar(select(func.nextval(SEQUENCE)))
    return f"TPE-{_now():%Y%m%d}-{number:06d}"


def create(db: Session, payload: TourPackageEnquiryCreate) -> TourPackageEnquiry:
    row = TourPackageEnquiry(
        enquiry_reference=next_reference(db),
        customer_name=payload.name,
        email=str(payload.email),
        mobile_number=payload.mobile,
        package_id=_existing_package_id(db, payload.package_id),
        package_name=payload.package_name,
        preferred_travel_date=payload.preferred_travel_date,
        number_of_travellers=payload.number_of_travellers,
        message=payload.message,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Admin queue (Phase 2 Bug 3). No merchant scoping — a tour package enquiry
# belongs to the public, so any platform admin may work any row, exactly as the
# Gaming Tour desk does.
# ---------------------------------------------------------------------------
def get(db: Session, enquiry_id: int) -> TourPackageEnquiry | None:
    return db.get(TourPackageEnquiry, enquiry_id)


def list_enquiries(
    db: Session,
    *,
    status: str | None = None,
    search: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[TourPackageEnquiry], int]:
    """Newest first — an enquiry queue is read the way an inbox is."""
    stmt = select(TourPackageEnquiry)
    if status:
        stmt = stmt.where(TourPackageEnquiry.status == status)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                TourPackageEnquiry.enquiry_reference.ilike(like),
                TourPackageEnquiry.customer_name.ilike(like),
                TourPackageEnquiry.email.ilike(like),
                TourPackageEnquiry.mobile_number.ilike(like),
                TourPackageEnquiry.package_name.ilike(like),
            )
        )
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(
        stmt.order_by(TourPackageEnquiry.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).scalars().all()
    return list(rows), total


def update(db: Session, row: TourPackageEnquiry, payload: TourPackageEnquiryUpdate) -> TourPackageEnquiry:
    """PATCH — only what was sent is written. Assigning an admin to a row still
    sitting at NEW moves it to ASSIGNED automatically UNLESS the same request
    also names a status, so "Assign to me" is one action, not two. Mirrors
    ``gaming_tour_enquiry_service.update``."""
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
    """The dashboard card and sidebar badge — same live-count shape the Gaming
    Tour and Ticket Enquiry queues give."""
    rows = db.execute(
        select(TourPackageEnquiry.status, func.count()).group_by(TourPackageEnquiry.status)
    ).all()
    by_status = {s: c for s, c in rows}
    return {
        "new": by_status.get("NEW", 0),
        "open": sum(by_status.get(s, 0) for s in OPEN_STATUSES),
        "total": sum(by_status.values()),
    }


def admin_names_for(db: Session, rows: list[TourPackageEnquiry]) -> dict[int, str]:
    """One query for a whole page's ``assigned_admin_name`` — resolved here
    rather than via a per-row relationship load, to avoid an N+1 on the list
    screen (the same approach the Gaming Tour service takes)."""
    ids = {r.assigned_admin_id for r in rows if r.assigned_admin_id}
    if not ids:
        return {}
    people = db.execute(select(User.user_id, User.full_name).where(User.user_id.in_(ids))).all()
    return {uid: name for uid, name in people}


def admin_item_dict(row: TourPackageEnquiry, admin_names: dict[int, str] | None = None) -> dict:
    names = admin_names or {}
    return {
        "id": row.id,
        "enquiry_reference": row.enquiry_reference,
        "customer_name": row.customer_name,
        "email": row.email,
        "mobile_number": row.mobile_number,
        "package_id": row.package_id,
        "package_name": row.package_name,
        "preferred_travel_date": row.preferred_travel_date,
        "number_of_travellers": row.number_of_travellers,
        "status": row.status,
        "assigned_admin_id": row.assigned_admin_id,
        "assigned_admin_name": names.get(row.assigned_admin_id) if row.assigned_admin_id else None,
        "created_at": row.created_at,
    }


def audit_trail(db: Session, enquiry_id: int, *, limit: int = 100) -> list[dict]:
    """The actor-attributed history for one enquiry, newest first.

    Reads the ``system_logs`` rows :func:`routers.tour_package_enquiries` writes
    on every admin change (module :data:`AUDIT_MODULE`). ``reference_id``,
    ``from_status`` and ``to_status`` live inside ``extra_data`` — that is where
    ``activity_service.log_activity`` stores a reference id and any caller
    detail, there being no ``reference_id`` column on ``system_logs``. The
    reference match is therefore done in Python (one narrow module's rows,
    ordered newest-first and capped) rather than with a dialect-specific JSON
    path, so it behaves identically on PostgreSQL and the SQLite test harness.
    The DB-level ``audit_logs`` trigger captures the full before/after row
    separately; this is the WHO-did-WHAT trail a human reads on the detail
    screen."""
    rows = db.execute(
        select(SystemLog, User.full_name)
        .join(User, SystemLog.user_id == User.user_id, isouter=True)
        .where(SystemLog.module == AUDIT_MODULE)
        .order_by(SystemLog.created_at.desc(), SystemLog.log_id.desc())
        .limit(max(limit * 20, 500))
    ).all()
    out: list[dict] = []
    for log, actor_name in rows:
        extra = log.extra_data or {}
        if extra.get("reference_id") != enquiry_id:
            continue
        out.append({
            "at": log.created_at,
            "actor_id": log.user_id,
            "actor_name": actor_name,
            "action": log.action,
            "description": log.description,
            "from_status": extra.get("from_status"),
            "to_status": extra.get("to_status"),
        })
        if len(out) >= limit:
            break
    return out
