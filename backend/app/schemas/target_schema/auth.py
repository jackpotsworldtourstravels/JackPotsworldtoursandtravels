import datetime

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    phone_number: str | None = Field(default=None, max_length=32)
    gender: str | None = Field(default=None, max_length=16)
    dob: datetime.date | None = None
    country: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=300)


class LoginRequest(BaseModel):
    identifier: str = Field(min_length=3, max_length=255, description="Email or phone number")
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
    user_type: str
    full_name: str
    email: EmailStr
    phone_number: str | None = None
    status: str
    merchant_id: int | None = None
    role_type: str | None = None
    member_role: str | None = None
    gender: str | None = None
    dob: datetime.date | None = None
    country: str | None = None
    state: str | None = None
    city: str | None = None
    address: str | None = None

    model_config = {"from_attributes": True}


class MessageResponse(BaseModel):
    message: str
    reset_link: str | None = None


# --- Merchant portal OTP login (steps 1-3) ---

class OTPRequestRequest(BaseModel):
    email: EmailStr


class OTPVerifyRequest(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=6, max_length=6)


class OTPVerifyResponse(BaseModel):
    verified: bool


class MerchantLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)


class ForgotPasswordResetRequest(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=6, max_length=6)
    new_password: str = Field(min_length=8, max_length=72)
