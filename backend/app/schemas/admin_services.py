"""Request/response schemas for the B2C Service Management admin desk and the
public service nav feed.

The admin desk writes the ``service_registry`` rows; the public feed exposes the
customer-visible subset (``service_registry_service.public_services``).
"""
from __future__ import annotations

import datetime as dt
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.service_registry_service import INTEGRATION_STATUSES


# ----------------------------------------------------------------- admin rows
class ServiceRow(BaseModel):
    """One registry row, full detail, for the admin desk."""

    model_config = ConfigDict(from_attributes=True)

    service_registry_id: int
    code: str
    name: str
    description: Optional[str] = None
    href: str
    icon: Optional[str] = None
    enabled: bool
    nav_visible: bool
    home_visible: bool
    nav_order: int
    maintenance_mode: bool
    maintenance_message: Optional[str] = None
    integration_status: str
    provider: Optional[str] = None
    created_at: dt.datetime
    updated_at: dt.datetime


class ServiceUpdate(BaseModel):
    """Partial update. ``code`` is immutable and intentionally absent."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    description: Optional[str] = Field(default=None, max_length=300)
    href: Optional[str] = Field(default=None, min_length=1, max_length=120)
    icon: Optional[str] = Field(default=None, max_length=40)
    enabled: Optional[bool] = None
    nav_visible: Optional[bool] = None
    home_visible: Optional[bool] = None
    nav_order: Optional[int] = Field(default=None, ge=0, le=100000)
    maintenance_mode: Optional[bool] = None
    maintenance_message: Optional[str] = Field(default=None, max_length=300)
    integration_status: Optional[str] = None
    provider: Optional[str] = Field(default=None, max_length=80)

    @field_validator("integration_status")
    @classmethod
    def _known_status(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip().lower()
        if v not in INTEGRATION_STATUSES:
            raise ValueError(f"integration_status must be one of {', '.join(INTEGRATION_STATUSES)}")
        return v


class ServiceReorder(BaseModel):
    """Set nav_order from the order of these codes."""

    codes: list[str] = Field(min_length=1)


# ----------------------------------------------------------------- public feed
class PublicServiceRow(BaseModel):
    """The customer-visible subset of a service, for navigation + homepage."""

    code: str
    name: str
    href: str
    icon: Optional[str] = None
    nav_order: int
    home_visible: bool
    maintenance_mode: bool
    maintenance_message: Optional[str] = None
    integration_status: str
