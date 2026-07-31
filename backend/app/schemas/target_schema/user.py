import datetime

from pydantic import BaseModel, Field


class ProfileUpdate(BaseModel):
    full_name: str = Field(min_length=1, max_length=255)
    phone_number: str | None = Field(default=None, max_length=32)
    gender: str | None = Field(default=None, max_length=16)
    dob: datetime.date | None = None
    country: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=300)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


class HeartbeatRequest(BaseModel):
    current_page: str | None = Field(default=None, max_length=200)
