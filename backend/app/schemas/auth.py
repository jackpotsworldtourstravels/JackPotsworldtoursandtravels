"""Auth request/response schemas for the three-portal B2B login."""
import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

#: Which portal a login is being attempted against. The login endpoint
#: rejects an account whose role doesn't belong to the named portal, so
#: an Admin's credentials can never open the Super Admin portal.
Portal = Literal["super_admin", "admin", "manager", "merchant"]


class LoginRequest(BaseModel):
    """Step 1 of the spec's Login -> Password -> OTP -> Dashboard flow."""

    email: EmailStr
    password: str
    portal: Portal


class LoginChallengeResponse(BaseModel):
    """Step 1 result: password accepted, OTP outstanding."""

    otp_required: bool = True
    challenge_token: str
    delivery: str = Field(description="'email' when SMTP is configured, else 'dev'")
    message: str
    #: Only populated in dev delivery mode (SMTP unconfigured), so local
    #: development and demos work without an SMTP account.
    dev_otp: str | None = None


class VerifyOtpRequest(BaseModel):
    """Step 2: exchange the challenge token plus the code for a session."""

    challenge_token: str
    code: str = Field(min_length=4, max_length=10)


class ResendOtpRequest(BaseModel):
    challenge_token: str


class RefreshRequest(BaseModel):
    refresh_token: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=72)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: "UserResponse | None" = None


class UserResponse(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    role: str
    portal: str
    merchant_role: str | None = None
    merchant_id: int | None = None
    merchant_name: str | None = None
    permissions: list[str] = []
    #: Which products this user's merchant may use — {"flights": bool,
    #: "hotels": bool, "visa": bool}. Empty on platform staff (no merchant to
    #: have access rows) and on any caller of this schema that hasn't wired
    #: it up. Populated once, in ``routers/auth.user_response()``, which is
    #: what login, `/api/auth/me` and `/api/profile` all funnel through — so
    #: this reaches the client the same instant `permissions` does, no extra
    #: round trip.
    service_access: dict[str, bool] = {}
    is_active: bool
    mobile: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    gender: str | None = None
    dob: datetime.date | None = None
    country: str | None = None
    state: str | None = None
    city: str | None = None
    address: str | None = None
    profile_photo: str | None = None
    last_login: datetime.datetime | None = None

    model_config = {"from_attributes": True}


class MessageResponse(BaseModel):
    message: str
    reset_link: str | None = None


TokenResponse.model_rebuild()
