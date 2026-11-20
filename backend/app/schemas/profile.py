"""Schema for the shared Profile screen (all three portals — API_CONTRACT.md §6.6)."""
import datetime
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints


class UpdateProfileRequest(BaseModel):
    #: Trimmed before the length check: "   " used to pass min_length=1 and was stored as the account's name.
    full_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=150)] | None = None
    phone: str | None = Field(default=None, max_length=30)
    gender: str | None = Field(default=None, max_length=20)
    dob: datetime.date | None = None
    country: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = None
