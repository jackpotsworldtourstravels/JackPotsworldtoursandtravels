import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

DiscountType = Literal["percent", "flat"]
ApplicableType = Literal["flight", "hotel", "cruise", "package"]


class SeasonalPriceCreate(BaseModel):
    item_type: ApplicableType
    item_id: int
    start_date: datetime.date
    end_date: datetime.date
    override_price: float = Field(gt=0)
    label: str | None = Field(default=None, max_length=150)
    is_active: bool = True

    @model_validator(mode="after")
    def _check_dates(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class SeasonalPriceOut(SeasonalPriceCreate):
    id: int
    item_name: str | None = None

    model_config = {"from_attributes": True}


class DiscountCampaignCreate(BaseModel):
    name: str = Field(max_length=150)
    description: str | None = Field(default=None, max_length=500)
    discount_type: DiscountType
    discount_value: float = Field(gt=0)
    applicable_type: ApplicableType | None = None
    start_date: datetime.date
    end_date: datetime.date
    is_active: bool = True

    @model_validator(mode="after")
    def _check(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        if self.discount_type == "percent" and self.discount_value > 100:
            raise ValueError("percent discount cannot exceed 100")
        return self


class DiscountCampaignOut(DiscountCampaignCreate):
    id: int

    model_config = {"from_attributes": True}


class CouponCreate(BaseModel):
    code: str = Field(min_length=3, max_length=40)
    description: str | None = Field(default=None, max_length=500)
    discount_type: DiscountType
    discount_value: float = Field(gt=0)
    applicable_type: ApplicableType | None = None
    min_booking_amount: float | None = Field(default=None, ge=0)
    usage_limit: int | None = Field(default=None, ge=1)
    valid_from: datetime.date
    valid_until: datetime.date
    is_active: bool = True

    @model_validator(mode="after")
    def _check(self):
        if self.valid_until < self.valid_from:
            raise ValueError("valid_until must be on or after valid_from")
        if self.discount_type == "percent" and self.discount_value > 100:
            raise ValueError("percent discount cannot exceed 100")
        return self


class CouponOut(CouponCreate):
    id: int
    times_used: int

    model_config = {"from_attributes": True}


class CouponValidateRequest(BaseModel):
    code: str
    booking_type: ApplicableType
    item_id: int
    quantity: int = Field(default=1, ge=1, le=10)


class CouponValidateResponse(BaseModel):
    valid: bool
    message: str
    unit_price: float | None = None
    subtotal: float | None = None
    campaign_discount: float = 0
    coupon_discount: float = 0
    final_amount: float | None = None
