"""Admin B2C Offers & Coupons — the CRUD behind ``/api/admin/coupons/*``.

Writes the SAME ``customer_coupons`` rows the public booking flow reads in
``customer_pricing_service`` (validate_coupon / available_coupons). Nothing here
prices anything or decides what a code is worth on a given fare — that stays in
the pricing service, the one place that knows the fare. This desk only manages
the rules: what a code is, who it targets, when it is valid, and whether the site
advertises it.
"""
from __future__ import annotations

import datetime as dt
import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_customer import CustomerCoupon

#: Unambiguous alphabet for generated codes — no 0/O or 1/I to misread off a
#: promotion. Admin-typed codes are not restricted to it.
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_LEN = 8


class DuplicateCode(ValueError):
    """The code already exists — coupon codes are unique."""


class CouponError(ValueError):
    """A coupon request that cannot be honoured (unknown id, bad input)."""


def generate_code(db: Session, prefix: str | None = None) -> str:
    """A random, unique, human-readable coupon code.

    Collision-checked against the table so a generated code is free to use
    immediately. A short prefix (e.g. ``DIWALI``) may lead it; the random tail
    keeps it unique.
    """
    clean_prefix = "".join(c for c in (prefix or "").upper() if c.isalnum())[:12]
    for _ in range(50):
        tail = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LEN))
        code = f"{clean_prefix}{tail}" if clean_prefix else tail
        exists = db.execute(
            select(CustomerCoupon.customer_coupon_id).where(
                func.upper(CustomerCoupon.code) == code
            )
        ).first()
        if not exists:
            return code
    raise CouponError("Could not generate a unique code — try again.")


def _counts(db: Session) -> dict[str, int]:
    total = db.execute(select(func.count()).select_from(CustomerCoupon)).scalar_one()
    active = db.execute(
        select(func.count()).select_from(CustomerCoupon).where(CustomerCoupon.is_active.is_(True))
    ).scalar_one()
    return {"total": int(total), "active": int(active), "inactive": int(total) - int(active)}


def list_coupons(
    db: Session,
    *,
    page: int = 1,
    page_size: int = 25,
    status_: str | None = None,
    product: str | None = None,
    search: str | None = None,
) -> dict:
    """Paged list, newest first, with per-status counts under the same filters
    (minus status, which the tabs switch between)."""
    stmt = select(CustomerCoupon)
    if status_ == "active":
        stmt = stmt.where(CustomerCoupon.is_active.is_(True))
    elif status_ == "inactive":
        stmt = stmt.where(CustomerCoupon.is_active.is_(False))
    if product:
        stmt = stmt.where(CustomerCoupon.product_type == product)
    if search:
        like = f"%{search.strip().upper()}%"
        stmt = stmt.where(
            func.upper(CustomerCoupon.code).like(like)
            | func.upper(CustomerCoupon.title).like(like)
        )

    total = db.execute(
        select(func.count()).select_from(stmt.order_by(None).subquery())
    ).scalar_one()
    rows = db.execute(
        stmt.order_by(CustomerCoupon.customer_coupon_id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).scalars().all()
    return {"items": rows, "total": int(total), "counts": _counts(db)}


def get_coupon(db: Session, coupon_id: int) -> CustomerCoupon | None:
    return db.get(CustomerCoupon, coupon_id)


def create_coupon(db: Session, data: dict, *, admin_id: int | None = None) -> CustomerCoupon:
    code = (data.get("code") or "").strip().upper()
    existing = db.execute(
        select(CustomerCoupon.customer_coupon_id).where(func.upper(CustomerCoupon.code) == code)
    ).first()
    if existing:
        raise DuplicateCode(f"A coupon with code {code} already exists.")

    coupon = CustomerCoupon(
        code=code,
        title=data["title"],
        description=data.get("description"),
        discount_type=data["discount_type"],
        discount_value=data["discount_value"],
        max_discount=data.get("max_discount"),
        min_amount=data.get("min_amount") or 0,
        product_type=data.get("product_type"),
        international_only=data.get("international_only"),
        airline=data.get("airline"),
        usage_limit=data.get("usage_limit"),
        times_used=0,
        show_on_website=data.get("show_on_website", True),
        is_active=data.get("is_active", True),
        valid_from=data.get("valid_from"),
        valid_to=data.get("valid_to"),
        created_by=admin_id,
    )
    db.add(coupon)
    db.flush()
    return coupon


#: Fields an update may set. ``code``, ``times_used``, ``created_by`` and
#: ``created_at`` are deliberately not writable here.
_UPDATABLE = {
    "title", "description", "discount_type", "discount_value", "max_discount",
    "min_amount", "product_type", "international_only", "airline", "usage_limit",
    "show_on_website", "is_active", "valid_from", "valid_to",
}


def update_coupon(db: Session, coupon_id: int, data: dict) -> CustomerCoupon | None:
    coupon = db.get(CustomerCoupon, coupon_id)
    if coupon is None:
        return None
    for key, value in data.items():
        if key in _UPDATABLE:
            setattr(coupon, key, value)
    db.flush()
    return coupon


def set_active(db: Session, coupon_id: int, active: bool) -> CustomerCoupon | None:
    """Soft enable/disable. Deactivating is the 'delete' — a code that has been
    advertised or used is never hard-removed, so history and any booking that
    references it stay intact."""
    coupon = db.get(CustomerCoupon, coupon_id)
    if coupon is None:
        return None
    coupon.is_active = active
    db.flush()
    return coupon
