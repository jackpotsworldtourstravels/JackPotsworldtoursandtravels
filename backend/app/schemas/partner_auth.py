from pydantic import BaseModel, EmailStr, Field


class OTPRequestRequest(BaseModel):
    email: EmailStr


class OTPVerifyRequest(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=6, max_length=6)


class OTPVerifyResponse(BaseModel):
    verified: bool


class PartnerLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)


class PartnerTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    partner_user_id: int
    partner_id: int
    full_name: str
    company_name: str


class PartnerRefreshRequest(BaseModel):
    refresh_token: str


class PartnerRefreshResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class ForgotPasswordResetRequest(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=6, max_length=6)
    new_password: str = Field(min_length=8, max_length=72)


class MessageResponse(BaseModel):
    message: str


class PartnerProfileOut(BaseModel):
    partner_user_id: int
    full_name: str
    email: EmailStr
    phone_number: str | None = None
    partner_id: int
    company_name: str
    company_code: str

    model_config = {"from_attributes": True}


class PartnerProfileUpdateRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=150)
    phone_number: str | None = Field(default=None, max_length=20)


class PartnerChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=72)
    new_password: str = Field(min_length=8, max_length=72)
