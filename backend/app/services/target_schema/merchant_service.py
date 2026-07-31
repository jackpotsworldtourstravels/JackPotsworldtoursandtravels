import datetime
import re
import secrets

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.target_schema.merchants import Merchant
from app.models.target_schema.service_requests import ServiceRequest
from app.models.target_schema.users import User

_SORT_MAP = {
    "newest": Merchant.created_at.desc(),
    "oldest": Merchant.created_at.asc(),
    "name_asc": Merchant.company_name.asc(),
    "name_desc": Merchant.company_name.desc(),
}


def get_by_id(db: Session, merchant_id: int) -> Merchant:
    merchant = db.get(Merchant, merchant_id)
    if not merchant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")
    return merchant


def _generate_company_code(db: Session, company_name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]", "", company_name).upper()[:8] or "MERCHANT"
    for i in range(1, 100):
        candidate = f"{base}{i:02d}"
        if not db.scalar(select(Merchant.id).where(Merchant.company_code == candidate)):
            return candidate
    return f"{base}{secrets.token_hex(3).upper()}"


def _generate_reference_prefix(db: Session, company_name: str) -> str:
    words = re.findall(r"[A-Za-z]+", company_name)
    base = "".join(w[0] for w in words[:2]).upper() or "MC"
    if len(base) < 2:
        base = (base + "XX")[:2]
    candidate = base
    suffix = 0
    while db.scalar(select(Merchant.id).where(Merchant.reference_prefix == candidate)):
        suffix += 1
        candidate = (base + str(suffix))[:6]
    return candidate


def create_merchant(db: Session, *, company_name: str, email: str | None = None, **profile_fields) -> Merchant:
    if email and db.scalar(select(Merchant).where(Merchant.email == email)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A merchant with this email already exists")
    now = datetime.datetime.now(datetime.timezone.utc)
    merchant = Merchant(
        company_code=_generate_company_code(db, company_name),
        reference_prefix=_generate_reference_prefix(db, company_name),
        company_name=company_name, email=email, created_at=now, updated_at=now,
        **{k: v for k, v in profile_fields.items() if v is not None},
    )
    db.add(merchant)
    db.commit()
    db.refresh(merchant)
    return merchant


def update_merchant(db: Session, merchant_id: int, **fields) -> Merchant:
    merchant = get_by_id(db, merchant_id)
    if fields.get("email"):
        dupe = db.scalar(select(Merchant).where(Merchant.email == fields["email"], Merchant.id != merchant_id))
        if dupe:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Another merchant already uses this email")
    for field in (
        "company_name", "company_type", "contact_person", "email", "phone_number", "address",
        "city", "state", "country", "gst_number", "pan_number", "status",
    ):
        if field in fields and fields[field] is not None:
            setattr(merchant, field, fields[field])
    db.commit()
    db.refresh(merchant)
    return merchant


def set_status(db: Session, merchant_id: int, new_status: str) -> Merchant:
    return update_merchant(db, merchant_id, status=new_status)


def get_detail(db: Session, merchant_id: int) -> dict:
    merchant = get_by_id(db, merchant_id)
    user_count = db.scalar(select(func.count()).select_from(User).where(User.merchant_id == merchant_id)) or 0
    booking_count = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            ServiceRequest.merchant_id == merchant_id, ServiceRequest.request_type == "booking"
        )
    ) or 0
    request_count = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            ServiceRequest.merchant_id == merchant_id, ServiceRequest.request_type != "booking"
        )
    ) or 0
    return {
        "partner_id": merchant.id, "company_name": merchant.company_name, "company_code": merchant.company_code,
        "company_type": merchant.company_type, "contact_person": merchant.contact_person, "email": merchant.email,
        "phone_number": merchant.phone_number, "address": merchant.address, "city": merchant.city,
        "state": merchant.state, "country": merchant.country, "gst_number": merchant.gst_number,
        "pan_number": merchant.pan_number, "status": merchant.status, "created_at": merchant.created_at,
        "user_count": user_count, "booking_count": booking_count, "request_count": request_count,
    }


def delete_merchant(db: Session, merchant_id: int) -> None:
    detail = get_detail(db, merchant_id)
    if detail["user_count"] or detail["booking_count"] or detail["request_count"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This merchant has users, bookings, or service requests on record and cannot be deleted. Deactivate it instead.",
        )
    db.delete(get_by_id(db, merchant_id))
    db.commit()


def next_reference_number(db: Session, merchant_id: int) -> str:
    """Atomic per-merchant, per-year sequence — replaces booking_reference_counters'
    composite PK (partner_id, year) with a JSONB counter map on the merchant row.
    """
    merchant = get_by_id(db, merchant_id)
    year = str(datetime.date.today().year)
    counters = dict(merchant.reference_counters or {})
    counters[year] = counters.get(year, 0) + 1
    merchant.reference_counters = counters
    db.commit()
    prefix = merchant.reference_prefix or merchant.company_code
    return f"{prefix}-{year}-{counters[year]:05d}"


def list_paginated(
    db: Session, *, page: int, page_size: int, search: str | None = None, status_filter: str | None = None,
    date_from: datetime.date | None = None, date_to: datetime.date | None = None, sort: str = "newest",
) -> tuple[list[Merchant], int]:
    stmt = select(Merchant)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                Merchant.company_name.ilike(pattern), Merchant.email.ilike(pattern),
                Merchant.contact_person.ilike(pattern), Merchant.phone_number.ilike(pattern),
            )
        )
    if status_filter:
        stmt = stmt.where(Merchant.status == status_filter)
    if date_from:
        stmt = stmt.where(Merchant.created_at >= date_from)
    if date_to:
        stmt = stmt.where(Merchant.created_at < date_to + datetime.timedelta(days=1))

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    stmt = stmt.order_by(_SORT_MAP.get(sort, _SORT_MAP["newest"])).limit(page_size).offset((page - 1) * page_size)
    return db.scalars(stmt).all(), total
