"""tour_package_enquiry_service.py — stores a Tour Package enquiry raised from
the Contact Us page. See `app.models_v2.TourPackageEnquiry` for the table
shape and why it carries no merchant/customer foreign key."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_customer import CustomerPackage
from app.models_v2 import TourPackageEnquiry
from app.schemas.tour_package_enquiry import TourPackageEnquiryCreate

SEQUENCE = "seq_tour_package_enquiry_number"


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
