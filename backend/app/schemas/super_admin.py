import datetime
import re

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator


class SuperAdminLoginRequest(BaseModel):
    username_or_email: str = Field(min_length=1)
    password: str = Field(min_length=1)


class SuperAdminTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    full_name: str


class MessageResponse(BaseModel):
    message: str


class DashboardStatsOut(BaseModel):
    total_admins: int
    total_merchants: int
    total_users: int


class AdminCreateRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr
    phone_number: str = Field(min_length=6, max_length=15)
    country_code: str = Field(min_length=1, max_length=5)
    password: str = Field(min_length=8, max_length=72)
    confirm_password: str = Field(min_length=8, max_length=72)

    @field_validator("phone_number")
    @classmethod
    def phone_digits_only(cls, v: str) -> str:
        if not re.fullmatch(r"\d+", v):
            raise ValueError("Phone number must contain digits only")
        return v

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if not re.search(r"[A-Z]", v) or not re.search(r"\d", v):
            raise ValueError("Password must contain at least one uppercase letter and one number")
        return v

    @model_validator(mode="after")
    def passwords_match(self) -> "AdminCreateRequest":
        if self.password != self.confirm_password:
            raise ValueError("Password and Confirm Password do not match")
        return self


class AdminOut(BaseModel):
    admin_id: str
    full_name: str
    username: str
    email: str
    phone_number: str
    country_code: str
    status: str
    created_at: datetime.datetime


class ProfileOut(BaseModel):
    full_name: str
    email: str
    phone_number: str
    role: str = "Super Administrator"
    created_date: datetime.datetime
    photo_url: str | None = None


class ProfileUpdateRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=150)
    phone_number: str | None = Field(default=None, max_length=15)
    photo_url: str | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=8, max_length=72)
    confirm_new_password: str = Field(min_length=8, max_length=72)

    @model_validator(mode="after")
    def passwords_match(self) -> "ChangePasswordRequest":
        if self.new_password != self.confirm_new_password:
            raise ValueError("New Password and Confirm New Password do not match")
        return self
