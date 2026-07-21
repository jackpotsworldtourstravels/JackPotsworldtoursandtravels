import datetime

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    # Extended profile fields — all optional so the existing signup modal (which only
    # sends full_name/email/password) keeps working unchanged.
    first_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    mobile: str | None = Field(default=None, max_length=20)
    gender: str | None = Field(default=None, max_length=20)
    dob: datetime.date | None = None
    country: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=300)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserLoginRequest(BaseModel):
    """Customer login accepts either an email address or a mobile number."""

    identifier: str = Field(min_length=3, max_length=255)
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=72)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    role: str
    is_active: bool
    first_name: str | None = None
    last_name: str | None = None
    mobile: str | None = None
    gender: str | None = None
    dob: datetime.date | None = None
    country: str | None = None
    state: str | None = None
    city: str | None = None
    address: str | None = None
    profile_photo: str | None = None

    model_config = {"from_attributes": True}


class MessageResponse(BaseModel):
    message: str
    reset_link: str | None = None
