"""Request/response schemas for the B2C Offers & Coupons admin desk.

These describe the admin-managed shape of ``customer_coupons``; the public
booking flow has its own leaner ``CouponOffer`` (no min/max arithmetic exposed).
A coupon the admin writes here is the exact row the pricing service later reads
in ``customer_pricing_service.validate_coupon``.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DISCOUNT_TYPES = ("percent", "flat")
PRODUCT_TYPES = ("flight", "hotel", "package")


class CouponBase(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=400)
    discount_type: str = Field(default="percent")
    discount_value: Decimal = Field(gt=0)
    max_discount: Optional[Decimal] = Field(default=None, gt=0)
    min_amount: Decimal = Field(default=Decimal("0"), ge=0)
    #: None = every product; otherwise flight | hotel | package.
    product_type: Optional[str] = Field(default=None)
    #: None = domestic and international; True = international only; False = domestic only.
    international_only: Optional[bool] = None
    #: IATA carrier code, e.g. "6E"; None = any airline. Flight coupons only.
    airline: Optional[str] = Field(default=None, max_length=8)
    usage_limit: Optional[int] = Field(default=None, ge=1)
    show_on_website: bool = True
    valid_from: Optional[dt.date] = None
    valid_to: Optional[dt.date] = None
    is_active: bool = True

    @field_validator("discount_type")
    @classmethod
    def _known_type(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in DISCOUNT_TYPES:
            raise ValueError(f"discount_type must be one of {', '.join(DISCOUNT_TYPES)}")
        return v

    @field_validator("product_type")
    @classmethod
    def _known_product(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip().lower()
        if v not in PRODUCT_TYPES:
            raise ValueError(f"product_type must be one of {', '.join(PRODUCT_TYPES)} or blank for all")
        return v

    @field_validator("airline")
    @classmethod
    def _clean_airline(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        return v.strip().upper()

    @model_validator(mode="after")
    def _coherent(self):
        if self.discount_type == "percent" and self.discount_value > 100:
            raise ValueError("A percentage discount cannot exceed 100%.")
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("valid_to cannot be before valid_from.")
        # Airline/international only mean anything for flights; keep them from
        # being set on a coupon scoped to hotels or packages, which would read as
        # a silent contradiction in the table.
        if self.product_type in ("hotel", "package"):
            if self.airline or self.international_only is not None:
                raise ValueError("Airline and domestic/international apply to flight coupons only.")
        return self


class CouponCreate(CouponBase):
    code: str = Field(min_length=2, max_length=40)

    @field_validator("code")
    @classmethod
    def _clean_code(cls, v: str) -> str:
        v = (v or "").strip().upper().replace(" ", "")
        if not v.isalnum():
            raise ValueError("A coupon code may contain only letters and digits.")
        return v


class CouponUpdate(BaseModel):
    """Partial update — only the fields sent are written. Code is immutable once
    created (it may already be printed on a promotion), so it is not here."""

    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=400)
    discount_type: Optional[str] = None
    discount_value: Optional[Decimal] = Field(default=None, gt=0)
    max_discount: Optional[Decimal] = Field(default=None, gt=0)
    min_amount: Optional[Decimal] = Field(default=None, ge=0)
    product_type: Optional[str] = None
    international_only: Optional[bool] = None
    airline: Optional[str] = Field(default=None, max_length=8)
    usage_limit: Optional[int] = Field(default=None, ge=1)
    show_on_website: Optional[bool] = None
    valid_from: Optional[dt.date] = None
    valid_to: Optional[dt.date] = None
    is_active: Optional[bool] = None

    @field_validator("discount_type")
    @classmethod
    def _known_type(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip().lower()
        if v not in DISCOUNT_TYPES:
            raise ValueError(f"discount_type must be one of {', '.join(DISCOUNT_TYPES)}")
        return v

    @field_validator("airline")
    @classmethod
    def _clean_airline(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        return v.strip().upper()


class CouponRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    customer_coupon_id: int
    code: str
    title: str
    description: Optional[str] = None
    discount_type: str
    discount_value: Decimal
    max_discount: Optional[Decimal] = None
    min_amount: Decimal
    product_type: Optional[str] = None
    international_only: Optional[bool] = None
    airline: Optional[str] = None
    usage_limit: Optional[int] = None
    times_used: int
    show_on_website: bool
    is_active: bool
    valid_from: Optional[dt.date] = None
    valid_to: Optional[dt.date] = None
    created_at: dt.datetime


class CouponList(BaseModel):
    items: list[CouponRow]
    total: int
    counts: dict[str, int]


class GeneratedCode(BaseModel):
    code: str
