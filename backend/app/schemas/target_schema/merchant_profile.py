from pydantic import BaseModel, EmailStr, Field


class MerchantProfileOut(BaseModel):
    partner_user_id: int = Field(validation_alias="id")
    full_name: str
    email: EmailStr
    phone_number: str | None = None
    partner_id: int | None = Field(validation_alias="merchant_id")
    company_name: str
    company_code: str

    model_config = {"from_attributes": True, "populate_by_name": True}


class MerchantProfileUpdateRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    phone_number: str | None = Field(default=None, max_length=32)


class MerchantChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=72)
    new_password: str = Field(min_length=8, max_length=72)


class MessageResponse(BaseModel):
    message: str
