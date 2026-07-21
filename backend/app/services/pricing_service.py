import datetime

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.pricing import Coupon, DiscountCampaign, SeasonalPrice
from app.services import catalog_items

_CODE_NORMALIZE = lambda code: code.strip().upper()  # noqa: E731


# ---------- Effective price (base price, or an active seasonal override) ----------
def get_effective_unit_price(db: Session, booking_type: str, item, on_date: datetime.date | None) -> float:
    on_date = on_date or datetime.date.today()
    stmt = select(SeasonalPrice).where(
        SeasonalPrice.item_type == booking_type,
        SeasonalPrice.item_id == item.id,
        SeasonalPrice.is_active.is_(True),
        SeasonalPrice.start_date <= on_date,
        SeasonalPrice.end_date >= on_date,
    )
    override = db.scalar(stmt)
    if override:
        return float(override.override_price)
    return catalog_items.base_unit_price(booking_type, item)


# ---------- Discount campaigns (auto-applied, booking-date driven) ----------
def get_active_campaign_discount(db: Session, booking_type: str, base_amount: float) -> tuple[float, DiscountCampaign | None]:
    today = datetime.date.today()
    stmt = select(DiscountCampaign).where(
        DiscountCampaign.is_active.is_(True),
        DiscountCampaign.start_date <= today,
        DiscountCampaign.end_date >= today,
        or_(DiscountCampaign.applicable_type.is_(None), DiscountCampaign.applicable_type == booking_type),
    )
    campaigns = db.scalars(stmt).all()
    if not campaigns:
        return 0.0, None
    best = max(campaigns, key=lambda c: _discount_amount(c.discount_type, float(c.discount_value), base_amount))
    return _discount_amount(best.discount_type, float(best.discount_value), base_amount), best


def _discount_amount(discount_type: str, value: float, amount: float) -> float:
    raw = amount * value / 100 if discount_type == "percent" else value
    return round(min(raw, amount), 2)


# ---------- Coupons ----------
def get_coupon_by_code(db: Session, code: str) -> Coupon | None:
    return db.scalar(select(Coupon).where(Coupon.code == _CODE_NORMALIZE(code)))


def validate_coupon(db: Session, code: str, booking_type: str, amount_after_campaign: float) -> Coupon:
    """Raises HTTPException with a customer-facing message if the code can't be used right now."""
    coupon = get_coupon_by_code(db, code)
    if not coupon or not coupon.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid coupon code.")
    today = datetime.date.today()
    if not (coupon.valid_from <= today <= coupon.valid_until):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This coupon has expired or isn't active yet.")
    if coupon.applicable_type and coupon.applicable_type != booking_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This coupon only applies to {coupon.applicable_type} bookings.",
        )
    if coupon.usage_limit is not None and coupon.times_used >= coupon.usage_limit:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This coupon has reached its usage limit.")
    if coupon.min_booking_amount is not None and amount_after_campaign < float(coupon.min_booking_amount):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This coupon requires a minimum booking amount of ₹{float(coupon.min_booking_amount):,.2f}.",
        )
    return coupon


def apply_coupon_discount(coupon: Coupon, amount: float) -> float:
    return _discount_amount(coupon.discount_type, float(coupon.discount_value), amount)


# ---------- Admin CRUD ----------
def list_seasonal_prices(db: Session) -> list[dict]:
    rows = db.scalars(select(SeasonalPrice).order_by(SeasonalPrice.start_date.desc())).all()
    return [_seasonal_out(db, r) for r in rows]


def _seasonal_out(db: Session, row: SeasonalPrice) -> dict:
    return {**row.__dict__, "item_name": catalog_items.item_display_name(db, row.item_type, row.item_id)}


def create_seasonal_price(db: Session, payload) -> dict:
    row = SeasonalPrice(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return _seasonal_out(db, row)


def update_seasonal_price(db: Session, seasonal_id: int, payload) -> dict:
    row = db.get(SeasonalPrice, seasonal_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Seasonal price not found")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    return _seasonal_out(db, row)


def delete_seasonal_price(db: Session, seasonal_id: int) -> None:
    row = db.get(SeasonalPrice, seasonal_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Seasonal price not found")
    db.delete(row)
    db.commit()


def list_campaigns(db: Session) -> list[DiscountCampaign]:
    return db.scalars(select(DiscountCampaign).order_by(DiscountCampaign.start_date.desc())).all()


def create_campaign(db: Session, payload) -> DiscountCampaign:
    row = DiscountCampaign(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_campaign(db: Session, campaign_id: int, payload) -> DiscountCampaign:
    row = db.get(DiscountCampaign, campaign_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campaign not found")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    return row


def delete_campaign(db: Session, campaign_id: int) -> None:
    row = db.get(DiscountCampaign, campaign_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campaign not found")
    db.delete(row)
    db.commit()


def list_coupons(db: Session) -> list[Coupon]:
    return db.scalars(select(Coupon).order_by(Coupon.created_at.desc())).all()


def create_coupon(db: Session, payload) -> Coupon:
    data = payload.model_dump()
    data["code"] = _CODE_NORMALIZE(data["code"])
    if db.scalar(select(Coupon).where(Coupon.code == data["code"])):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A coupon with this code already exists.")
    row = Coupon(**data)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_coupon(db: Session, coupon_id: int, payload) -> Coupon:
    row = db.get(Coupon, coupon_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Coupon not found")
    data = payload.model_dump()
    data["code"] = _CODE_NORMALIZE(data["code"])
    existing = db.scalar(select(Coupon).where(Coupon.code == data["code"]))
    if existing and existing.id != coupon_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A coupon with this code already exists.")
    for key, value in data.items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    return row


def delete_coupon(db: Session, coupon_id: int) -> None:
    row = db.get(Coupon, coupon_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Coupon not found")
    db.delete(row)
    db.commit()
