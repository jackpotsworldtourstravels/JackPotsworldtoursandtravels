"""Request/response schemas for the B2C Suppliers & Pricing admin desk.

Two concerns: the per-service markup on a supplier's base price, and the
time-boxed festival/seasonal discounts on the resulting selling price. The
pricing services read what this desk writes (see customer_markup_service).
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SERVICES = ("flight", "hotel", "package", "other")
DISCOUNT_TYPES = ("percent", "flat")


# ---------------------------------------------------------------- markups
class MarkupRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    supplier: str
    service: str
    markup_percent: Decimal
    is_active: bool


class MarkupUpsert(BaseModel):
    supplier: str = Field(default="TBO", max_length=40)
    service: str
    markup_percent: Decimal = Field(ge=0, le=999)
    is_active: bool = True

    @field_validator("service")
    @classmethod
    def _known_service(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in SERVICES:
            raise ValueError(f"service must be one of {', '.join(SERVICES)}")
        return v

    @field_validator("supplier")
    @classmethod
    def _clean_supplier(cls, v: str) -> str:
        return (v or "TBO").strip() or "TBO"


class MarkupSaveRequest(BaseModel):
    items: list[MarkupUpsert] = Field(min_length=1)


# ---------------------------------------------------------------- festivals
class FestivalBase(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    discount_type: str = Field(default="percent")
    discount_value: Decimal = Field(gt=0)
    #: None = every product; otherwise flight | hotel | package.
    applicable_type: Optional[str] = None
    start_date: dt.date
    end_date: dt.date
    is_active: bool = True
    show_on_website: bool = True

    @field_validator("discount_type")
    @classmethod
    def _known_type(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in DISCOUNT_TYPES:
            raise ValueError(f"discount_type must be one of {', '.join(DISCOUNT_TYPES)}")
        return v

    @field_validator("applicable_type")
    @classmethod
    def _known_applicable(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip().lower()
        if v not in ("flight", "hotel", "package"):
            raise ValueError("applicable_type must be flight, hotel, package or blank for all")
        return v

    @model_validator(mode="after")
    def _coherent(self):
        if self.discount_type == "percent" and self.discount_value > 100:
            raise ValueError("A percentage discount cannot exceed 100%.")
        if self.end_date < self.start_date:
            raise ValueError("end_date cannot be before start_date.")
        return self


class FestivalCreate(FestivalBase):
    pass


class FestivalUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    discount_type: Optional[str] = None
    discount_value: Optional[Decimal] = Field(default=None, gt=0)
    applicable_type: Optional[str] = None
    start_date: Optional[dt.date] = None
    end_date: Optional[dt.date] = None
    is_active: Optional[bool] = None
    show_on_website: Optional[bool] = None

    @field_validator("discount_type")
    @classmethod
    def _known_type(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip().lower()
        if v not in DISCOUNT_TYPES:
            raise ValueError(f"discount_type must be one of {', '.join(DISCOUNT_TYPES)}")
        return v


class FestivalRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    festival_discount_id: int
    name: str
    discount_type: str
    discount_value: Decimal
    applicable_type: Optional[str] = None
    start_date: dt.date
    end_date: dt.date
    is_active: bool
    show_on_website: bool
    created_at: dt.datetime


# ---------------------------------------------------------------- preview
class PricingPreview(BaseModel):
    service: str
    base: Decimal
    markup_percent: Decimal
    selling: Decimal
    festival_name: Optional[str] = None
    festival_amount: Decimal
    festival_percent: int
    final: Decimal
