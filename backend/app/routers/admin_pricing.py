"""Admin B2C Suppliers & Pricing — ``/api/admin/suppliers``,
``/api/admin/festival-discounts`` and ``/api/admin/pricing/preview``.

Every endpoint requires ``b2c.pricing.manage`` (admin only; a super admin holds
it). This is the most sensitive B2C write: markups and festival discounts move
the prices the public site displays and charges. The preview endpoint runs the
exact same ``customer_markup_service`` the live quote runs, so what the admin
previews is what a customer will pay.
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require_scope
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome
from app.models_v2 import User
from app.schemas.admin_pricing import (
    FestivalCreate,
    FestivalRow,
    FestivalUpdate,
    MarkupRow,
    MarkupSaveRequest,
    PricingPreview,
)
from app.services import admin_pricing_service as service
from app.services import customer_admin_audit_service as b2c_audit
from app.services import customer_markup_service as markup
from app.services.catalogue_common import log_change

router = APIRouter(prefix="/api/admin", tags=["admin-pricing"])

_NO_FESTIVAL = "No such festival discount."


# ------------------------------------------------------------- supplier markups
@router.get(
    "/suppliers", response_model=list[MarkupRow], summary="Supplier markups",
    description="Requires `b2c.pricing.manage` (admin only). Current per-service markups.",
)
def list_markups(db: Session = Depends(get_db), _: User = Depends(require_scope(P.B2C_PRICING_MANAGE))):
    return service.list_markups(db)


@router.put(
    "/suppliers", response_model=list[MarkupRow], summary="Save supplier markups",
    description="Requires `b2c.pricing.manage`. Upserts one row per (supplier, service).",
)
def save_markups(
    payload: MarkupSaveRequest, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require_scope(P.B2C_PRICING_MANAGE)),
):
    rows = service.upsert_markups(db, [i.model_dump() for i in payload.items])
    log_change(
        db, request, user, action="Supplier markups saved", reference_id=0, module="B2CPricing",
        description=f"{user.full_name} saved markups: " + ", ".join(
            f"{i.service} {i.markup_percent}%" for i in payload.items),
    )
    b2c_audit.record_in_session(
        db, admin=user, action="pricing.markup.save", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="supplier_markup", entity_id=None,
        new={i.service: str(i.markup_percent) for i in payload.items},
    )
    db.commit()
    return rows


# ------------------------------------------------------------- festival discounts
@router.get(
    "/festival-discounts", response_model=list[FestivalRow], summary="Festival discounts",
    description="Requires `b2c.pricing.manage`. Newest first.",
)
def list_festivals(db: Session = Depends(get_db), _: User = Depends(require_scope(P.B2C_PRICING_MANAGE))):
    return service.list_festivals(db)


@router.post(
    "/festival-discounts", response_model=FestivalRow, status_code=status.HTTP_201_CREATED,
    summary="Create a festival discount", description="Requires `b2c.pricing.manage`.",
)
def create_festival(
    payload: FestivalCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require_scope(P.B2C_PRICING_MANAGE)),
):
    fest = service.create_festival(db, payload.model_dump())
    log_change(
        db, request, user, action="Festival discount created", reference_id=fest.festival_discount_id,
        module="B2CPricing", description=f"{user.full_name} created festival discount '{fest.name}'",
    )
    b2c_audit.record_in_session(
        db, admin=user, action="pricing.festival.create", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="festival_discount", entity_id=fest.festival_discount_id, new={"name": fest.name},
    )
    db.commit()
    db.refresh(fest)
    return fest


@router.patch(
    "/festival-discounts/{festival_id}", response_model=FestivalRow, summary="Edit a festival discount",
    description="Requires `b2c.pricing.manage`. Only the fields sent are written.",
    responses={404: {"description": _NO_FESTIVAL}},
)
def update_festival(
    festival_id: int, payload: FestivalUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require_scope(P.B2C_PRICING_MANAGE)),
):
    data = payload.model_dump(exclude_unset=True)
    fest = service.update_festival(db, festival_id, data)
    if fest is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_FESTIVAL)
    log_change(
        db, request, user, action="Festival discount updated", reference_id=festival_id,
        module="B2CPricing", description=f"{user.full_name} updated festival '{fest.name}': {', '.join(sorted(data)) or 'no fields'}",
    )
    b2c_audit.record_in_session(
        db, admin=user, action="pricing.festival.update", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="festival_discount", entity_id=festival_id, new={"changed": sorted(data)},
    )
    db.commit()
    db.refresh(fest)
    return fest


@router.delete(
    "/festival-discounts/{festival_id}", response_model=FestivalRow, summary="Deactivate a festival discount",
    description="Requires `b2c.pricing.manage`. Soft delete (is_active=false); reactivate with PATCH.",
    responses={404: {"description": _NO_FESTIVAL}},
)
def deactivate_festival(
    festival_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require_scope(P.B2C_PRICING_MANAGE)),
):
    fest = service.set_festival_active(db, festival_id, False)
    if fest is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_FESTIVAL)
    log_change(
        db, request, user, action="Festival discount deactivated", reference_id=festival_id,
        module="B2CPricing", description=f"{user.full_name} deactivated festival '{fest.name}'",
    )
    b2c_audit.record_in_session(
        db, admin=user, action="pricing.festival.deactivate", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="festival_discount", entity_id=festival_id, new={"is_active": False},
    )
    db.commit()
    db.refresh(fest)
    return fest


# ------------------------------------------------------------- live preview
@router.get(
    "/pricing/preview", response_model=PricingPreview, summary="Preview the price breakdown",
    description=(
        "Requires `b2c.pricing.manage`. Runs the live markup + festival pricing for a "
        "sample base amount — the same code a customer quote runs — so the owner can see "
        "base → markup → selling → festival → final before saving."
    ),
)
def preview(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_PRICING_MANAGE)),
    service_type: str = Query("flight", alias="service"),
    base: Decimal = Query(..., ge=0),
):
    if service_type not in markup.SERVICES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown service {service_type!r}.")
    result = markup.apply(db, service=service_type, base=base)
    return PricingPreview(service=service_type, **result)
