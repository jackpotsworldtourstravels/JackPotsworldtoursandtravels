from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin, get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.pricing import (
    CouponCreate,
    CouponOut,
    CouponValidateRequest,
    CouponValidateResponse,
    DiscountCampaignCreate,
    DiscountCampaignOut,
    SeasonalPriceCreate,
    SeasonalPriceOut,
)
from app.services import activity_service, booking_service, pricing_service

router = APIRouter(prefix="/api", tags=["pricing"])
admin_router = APIRouter(prefix="/api/admin/pricing", tags=["admin-pricing"])


@router.post(
    "/coupons/validate",
    response_model=CouponValidateResponse,
    summary="Preview a coupon's discount before booking",
    description="Requires authentication. Validates a coupon code against an item/quantity and returns the discount preview without creating a booking.",
)
def validate_coupon_preview(
    payload: CouponValidateRequest, db: Session = Depends(get_db), _user: User = Depends(get_current_user)
):
    item = booking_service.get_item(db, payload.booking_type, payload.item_id)
    unit_price = pricing_service.get_effective_unit_price(db, payload.booking_type, item, None)
    subtotal = round(unit_price * payload.quantity, 2)
    campaign_discount, _campaign = pricing_service.get_active_campaign_discount(db, payload.booking_type, subtotal)
    amount_after_campaign = subtotal - campaign_discount

    try:
        coupon = pricing_service.validate_coupon(db, payload.code, payload.booking_type, amount_after_campaign)
    except HTTPException as exc:
        return CouponValidateResponse(valid=False, message=exc.detail)

    coupon_discount = pricing_service.apply_coupon_discount(coupon, amount_after_campaign)
    final_amount = max(round(subtotal - campaign_discount - coupon_discount, 2), 0.01)
    return CouponValidateResponse(
        valid=True, message="Coupon applied!", unit_price=unit_price, subtotal=subtotal,
        campaign_discount=campaign_discount, coupon_discount=coupon_discount, final_amount=final_amount,
    )


# ---------- Admin: Seasonal Pricing ----------
@admin_router.get("/seasonal", response_model=list[SeasonalPriceOut], summary="List seasonal prices (admin)")
def list_seasonal(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return pricing_service.list_seasonal_prices(db)


@admin_router.post("/seasonal", response_model=SeasonalPriceOut, summary="Create a seasonal price (admin)")
def create_seasonal(payload: SeasonalPriceCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    result = pricing_service.create_seasonal_price(db, payload)
    activity_service.log_activity(
        db, _admin.id, f"Admin created seasonal price for {payload.item_type} #{payload.item_id}",
        module="Admin", activity_type="Admin Action", reference_id=result["id"],
    )
    return result


@admin_router.put("/seasonal/{seasonal_id}", response_model=SeasonalPriceOut, summary="Update a seasonal price (admin)")
def update_seasonal(
    seasonal_id: int, payload: SeasonalPriceCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    result = pricing_service.update_seasonal_price(db, seasonal_id, payload)
    activity_service.log_activity(
        db, _admin.id, f"Admin updated seasonal price #{seasonal_id}",
        module="Admin", activity_type="Admin Action", reference_id=seasonal_id,
    )
    return result


@admin_router.delete("/seasonal/{seasonal_id}", status_code=204, summary="Delete a seasonal price (admin)")
def delete_seasonal(seasonal_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    pricing_service.delete_seasonal_price(db, seasonal_id)
    activity_service.log_activity(
        db, _admin.id, f"Admin deleted seasonal price #{seasonal_id}",
        module="Admin", activity_type="Admin Action", reference_id=seasonal_id,
    )


# ---------- Admin: Discount Campaigns ----------
@admin_router.get("/campaigns", response_model=list[DiscountCampaignOut], summary="List discount campaigns (admin)")
def list_campaigns_route(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return pricing_service.list_campaigns(db)


@admin_router.post("/campaigns", response_model=DiscountCampaignOut, summary="Create a discount campaign (admin)")
def create_campaign_route(
    payload: DiscountCampaignCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    result = pricing_service.create_campaign(db, payload)
    activity_service.log_activity(
        db, _admin.id, f"Admin created discount campaign '{payload.name}'",
        module="Admin", activity_type="Admin Action", reference_id=result.id,
    )
    return result


@admin_router.put("/campaigns/{campaign_id}", response_model=DiscountCampaignOut, summary="Update a discount campaign (admin)")
def update_campaign_route(
    campaign_id: int, payload: DiscountCampaignCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    result = pricing_service.update_campaign(db, campaign_id, payload)
    activity_service.log_activity(
        db, _admin.id, f"Admin updated discount campaign #{campaign_id}",
        module="Admin", activity_type="Admin Action", reference_id=campaign_id,
    )
    return result


@admin_router.delete("/campaigns/{campaign_id}", status_code=204, summary="Delete a discount campaign (admin)")
def delete_campaign_route(campaign_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    pricing_service.delete_campaign(db, campaign_id)
    activity_service.log_activity(
        db, _admin.id, f"Admin deleted discount campaign #{campaign_id}",
        module="Admin", activity_type="Admin Action", reference_id=campaign_id,
    )


# ---------- Admin: Coupons ----------
@admin_router.get("/coupons", response_model=list[CouponOut], summary="List coupons (admin)")
def list_coupons_route(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return pricing_service.list_coupons(db)


@admin_router.post("/coupons", response_model=CouponOut, summary="Create a coupon (admin)")
def create_coupon_route(payload: CouponCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    result = pricing_service.create_coupon(db, payload)
    activity_service.log_activity(
        db, _admin.id, f"Admin created coupon '{result.code}'",
        module="Admin", activity_type="Admin Action", reference_id=result.id,
    )
    return result


@admin_router.put("/coupons/{coupon_id}", response_model=CouponOut, summary="Update a coupon (admin)")
def update_coupon_route(
    coupon_id: int, payload: CouponCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    result = pricing_service.update_coupon(db, coupon_id, payload)
    activity_service.log_activity(
        db, _admin.id, f"Admin updated coupon #{coupon_id}",
        module="Admin", activity_type="Admin Action", reference_id=coupon_id,
    )
    return result


@admin_router.delete("/coupons/{coupon_id}", status_code=204, summary="Delete a coupon (admin)")
def delete_coupon_route(coupon_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    pricing_service.delete_coupon(db, coupon_id)
    activity_service.log_activity(
        db, _admin.id, f"Admin deleted coupon #{coupon_id}",
        module="Admin", activity_type="Admin Action", reference_id=coupon_id,
    )
