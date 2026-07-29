"""Schema for the shared Profile screen (all three portals — API_CONTRACT.md §6.6)."""
import datetime

from pydantic import BaseModel, Field


class UpdateProfileRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=150)
    phone: str | None = Field(default=None, max_length=30)
    gender: str | None = Field(default=None, max_length=20)
    dob: datetime.date | None = None
    country: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = None
