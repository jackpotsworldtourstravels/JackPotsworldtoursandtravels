"""Admin B2C Offers & Coupons — ``/api/admin/coupons/*``.

Manage the discount codes the public booking flow applies. Every endpoint here
requires ``b2c.coupons.manage`` (admin only; a super admin holds it implicitly).
There is no separate read scope — this is a manage-only desk, and the same screen
that lists codes is the one that edits them.

The codes written here are read, and only ever priced, by
``customer_pricing_service``; see ``admin_coupon_service`` for why pricing never
lives on this side.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require_scope
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome
from app.models_v2 import User
from app.schemas.admin_coupon import (
    CouponCreate,
    CouponList,
    CouponRow,
    CouponUpdate,
    GeneratedCode,
)
from app.services import admin_coupon_service as service
from app.services import customer_admin_audit_service as b2c_audit
from app.services.catalogue_common import log_change

router = APIRouter(prefix="/api/admin/coupons", tags=["admin-coupons"])

_NO_COUPON = "No such coupon."
_STATUSES = ("active", "inactive")
_PRODUCTS = ("flight", "hotel", "package")


@router.get(
    "", response_model=CouponList, summary="List coupons",
    description="Requires `b2c.coupons.manage` (admin only). Newest first, with per-status counts.",
)
def list_coupons(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_COUPONS_MANAGE)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    coupon_status: str | None = Query(None, alias="status"),
    product: str | None = Query(None),
    search: str | None = Query(None, max_length=120),
):
    if coupon_status and coupon_status not in _STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown status {coupon_status!r}.")
    if product and product not in _PRODUCTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown product {product!r}.")
    return service.list_coupons(
        db, page=page, page_size=page_size, status_=coupon_status, product=product, search=search,
    )


@router.post(
    "/generate-code", response_model=GeneratedCode, summary="Suggest a unique code",
    description="Requires `b2c.coupons.manage`. Returns a random, unused code (optionally prefixed).",
)
def generate_code(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_COUPONS_MANAGE)),
    prefix: str | None = Query(None, max_length=12),
):
    try:
        return GeneratedCode(code=service.generate_code(db, prefix))
    except service.CouponError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


@router.post(
    "", response_model=CouponRow, status_code=status.HTTP_201_CREATED, summary="Create a coupon",
    description="Requires `b2c.coupons.manage`. Code must be unique.",
    responses={409: {"description": "Duplicate code."}},
)
def create_coupon(
    payload: CouponCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require_scope(P.B2C_COUPONS_MANAGE)),
):
    try:
        coupon = service.create_coupon(db, payload.model_dump(), admin_id=getattr(user, "user_id", None))
    except service.DuplicateCode as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    log_change(
        db, request, user, action="Coupon created", reference_id=coupon.customer_coupon_id,
        module="B2CCoupons", description=f"{user.full_name} created coupon {coupon.code}",
    )
    b2c_audit.record_in_session(
        db, admin=user, action="coupon.create", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_coupon", entity_id=coupon.customer_coupon_id,
        new={"code": coupon.code, "discount_type": coupon.discount_type},
    )
    db.commit()
    db.refresh(coupon)
    return coupon


@router.get(
    "/{coupon_id}", response_model=CouponRow, summary="One coupon",
    description="Requires `b2c.coupons.manage`.",
    responses={404: {"description": _NO_COUPON}},
)
def get_coupon(
    coupon_id: int, db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_COUPONS_MANAGE)),
):
    coupon = service.get_coupon(db, coupon_id)
    if coupon is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_COUPON)
    return coupon


@router.patch(
    "/{coupon_id}", response_model=CouponRow, summary="Edit a coupon",
    description="Requires `b2c.coupons.manage`. Only the fields sent are written; the code is immutable.",
    responses={404: {"description": _NO_COUPON}},
)
def update_coupon(
    coupon_id: int, payload: CouponUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require_scope(P.B2C_COUPONS_MANAGE)),
):
    data = payload.model_dump(exclude_unset=True)
    coupon = service.update_coupon(db, coupon_id, data)
    if coupon is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_COUPON)
    log_change(
        db, request, user, action="Coupon updated", reference_id=coupon_id,
        module="B2CCoupons",
        description=f"{user.full_name} updated coupon {coupon.code}: {', '.join(sorted(data)) or 'no fields'}",
    )
    b2c_audit.record_in_session(
        db, admin=user, action="coupon.update", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_coupon", entity_id=coupon_id, new={"changed": sorted(data)},
    )
    db.commit()
    db.refresh(coupon)
    return coupon


@router.delete(
    "/{coupon_id}", response_model=CouponRow, summary="Deactivate a coupon",
    description=(
        "Requires `b2c.coupons.manage`. Soft delete: the code is marked inactive, never "
        "hard-removed, so history and any booking that used it stay intact. Reactivate with "
        "PATCH `is_active=true`."
    ),
    responses={404: {"description": _NO_COUPON}},
)
def deactivate_coupon(
    coupon_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require_scope(P.B2C_COUPONS_MANAGE)),
):
    coupon = service.set_active(db, coupon_id, False)
    if coupon is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_COUPON)
    log_change(
        db, request, user, action="Coupon deactivated", reference_id=coupon_id,
        module="B2CCoupons", description=f"{user.full_name} deactivated coupon {coupon.code}",
    )
    b2c_audit.record_in_session(
        db, admin=user, action="coupon.deactivate", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_coupon", entity_id=coupon_id, new={"is_active": False},
    )
    db.commit()
    db.refresh(coupon)
    return coupon
