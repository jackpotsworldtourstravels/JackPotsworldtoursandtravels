import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

Role = Literal["user", "admin"]


class ProfileUpdate(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    mobile: str | None = Field(default=None, max_length=20)
    gender: str | None = Field(default=None, max_length=20)
    dob: datetime.date | None = None
    country: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=300)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


class SetActiveRequest(BaseModel):
    is_active: bool


class HeartbeatRequest(BaseModel):
    current_page: str | None = Field(default=None, max_length=200)


class AdminUserCreate(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    role: Role = "user"


class AdminUserUpdate(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    role: Role
