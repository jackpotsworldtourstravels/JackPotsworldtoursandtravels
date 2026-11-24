"""Admin B2C Suppliers & Pricing — the CRUD behind ``/api/admin/suppliers`` and
``/api/admin/festival-discounts``.

Writes the ``supplier_markups`` and ``festival_discounts`` rows the pricing
services read through ``customer_markup_service``. This desk only stores the
rules; the arithmetic that turns a base price into a selling/final price lives in
that one service, so the admin preview and a live quote cannot disagree.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import FestivalDiscount, SupplierMarkup


# ---------------------------------------------------------------- markups
def list_markups(db: Session) -> list[SupplierMarkup]:
    return db.execute(
        select(SupplierMarkup).order_by(SupplierMarkup.supplier, SupplierMarkup.service)
    ).scalars().all()


def upsert_markups(db: Session, items: list[dict]) -> list[SupplierMarkup]:
    """Create or update one row per (supplier, service). Returns the full set."""
    for item in items:
        supplier = item.get("supplier") or "TBO"
        service = item["service"]
        row = db.execute(
            select(SupplierMarkup).where(
                SupplierMarkup.supplier == supplier,
                SupplierMarkup.service == service,
            )
        ).scalar_one_or_none()
        if row is None:
            row = SupplierMarkup(supplier=supplier, service=service)
            db.add(row)
        row.markup_percent = item["markup_percent"]
        row.is_active = item.get("is_active", True)
        row.updated_at = dt.datetime.now(dt.timezone.utc)
    db.flush()
    return list_markups(db)


# ---------------------------------------------------------------- festivals
def list_festivals(db: Session) -> list[FestivalDiscount]:
    return db.execute(
        select(FestivalDiscount).order_by(FestivalDiscount.start_date.desc())
    ).scalars().all()


def get_festival(db: Session, festival_id: int) -> FestivalDiscount | None:
    return db.get(FestivalDiscount, festival_id)


def create_festival(db: Session, data: dict) -> FestivalDiscount:
    fest = FestivalDiscount(
        name=data["name"],
        discount_type=data["discount_type"],
        discount_value=data["discount_value"],
        applicable_type=data.get("applicable_type"),
        start_date=data["start_date"],
        end_date=data["end_date"],
        is_active=data.get("is_active", True),
        show_on_website=data.get("show_on_website", True),
    )
    db.add(fest)
    db.flush()
    return fest


_FEST_UPDATABLE = {
    "name", "discount_type", "discount_value", "applicable_type",
    "start_date", "end_date", "is_active", "show_on_website",
}


def update_festival(db: Session, festival_id: int, data: dict) -> FestivalDiscount | None:
    fest = db.get(FestivalDiscount, festival_id)
    if fest is None:
        return None
    for key, value in data.items():
        if key in _FEST_UPDATABLE:
            setattr(fest, key, value)
    db.flush()
    return fest


def set_festival_active(db: Session, festival_id: int, active: bool) -> FestivalDiscount | None:
    fest = db.get(FestivalDiscount, festival_id)
    if fest is None:
        return None
    fest.is_active = active
    db.flush()
    return fest
