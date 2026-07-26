import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

CompanyType = Literal["gaming_company", "corporate_company", "travel_agency", "business_partner"]
MerchantStatus = Literal["active", "inactive"]
RoleType = Literal["admin", "user", "maker", "checker"]
MemberRole = Literal[
    "admin", "user", "data_operator", "request_ticket", "cancellation_ticket", "supervisor", "manager"
]

ROLE_TYPE_MEMBER_ROLES: dict[str, list[str]] = {
    "admin": ["admin"],
    "user": ["user"],
    "maker": ["data_operator", "request_ticket", "cancellation_ticket"],
    "checker": ["supervisor", "manager"],
}


class MessageResponse(BaseModel):
    message: str


class MerchantListItemOut(BaseModel):
    partner_id: int
    company_name: str
    company_type: str | None = None
    contact_person: str | None = None
    email: str
    phone_number: str | None = None
    status: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class MerchantCreateRequest(BaseModel):
    company_name: str = Field(min_length=1, max_length=150)
    company_type: CompanyType
    contact_person: str = Field(min_length=1, max_length=150)
    email: EmailStr
    phone_number: str = Field(min_length=1, max_length=20)
    address: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=100)
    gst_number: str | None = Field(default=None, max_length=20)
    pan_number: str | None = Field(default=None, max_length=15)
    status: MerchantStatus = "active"


class MerchantUpdateRequest(BaseModel):
    company_name: str | None = Field(default=None, min_length=1, max_length=150)
    company_type: CompanyType | None = None
    contact_person: str | None = Field(default=None, max_length=150)
    email: EmailStr | None = None
    phone_number: str | None = Field(default=None, max_length=20)
    address: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=100)
    gst_number: str | None = Field(default=None, max_length=20)
    pan_number: str | None = Field(default=None, max_length=15)


class MerchantDetailOut(BaseModel):
    partner_id: int
    company_name: str
    company_code: str
    company_type: str | None = None
    contact_person: str | None = None
    email: str
    phone_number: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    gst_number: str | None = None
    pan_number: str | None = None
    status: str
    created_at: datetime.datetime
    user_count: int = 0
    booking_count: int = 0
    request_count: int = 0


class MerchantUserCreateRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr
    phone_number: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=8, max_length=72)
    confirm_password: str = Field(min_length=8, max_length=72)
    role_type: RoleType
    member_role: MemberRole


class MerchantUserOut(BaseModel):
    partner_user_id: int
    full_name: str
    username: str | None = None
    email: str
    phone_number: str | None = None
    role_type: str | None = None
    member_role: str | None = None
    status: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class MerchantUserUpdateRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=150)
    phone_number: str | None = Field(default=None, max_length=20)
    role_type: RoleType | None = None
    member_role: MemberRole | None = None


class ResetPasswordOut(BaseModel):
    message: str
    new_password: str
