"""Schemas for merchant (partner company) management."""
import datetime
from decimal import Decimal

from pydantic import BaseModel, EmailStr, Field

from app.models_v2 import CompanyType, MerchantStatus
from app.schemas.accounts import AccountResponse


class ServiceAccessInput(BaseModel):
    """The Onboard form's Service / Product Access card, at creation.

    Defaults match ``service_access_service.DEFAULT_ACCESS``: Flights on,
    the newer products opt-in.
    """

    flights: bool = True
    hotels: bool = False
    visa: bool = False
    holidays: bool = False


class ServiceAccessUpdateRequest(BaseModel):
    """The Edit form's independent "Save Service Access" action.

    All-optional, partial-update shape — same convention
    ``UpdateMerchantRequest`` uses for the merchant-fields form: only a key
    that is actually sent changes anything.
    """

    flights: bool | None = None
    hotels: bool | None = None
    visa: bool | None = None
    holidays: bool | None = None


class ServiceAccessResponse(BaseModel):
    merchant_id: int
    flights: bool
    hotels: bool
    visa: bool
    holidays: bool


class MerchantResponse(BaseModel):
    id: int
    merchant_code: str
    merchant_name: str
    company_name: str
    company_type: CompanyType
    email: EmailStr
    phone: str | None = None
    reference_prefix: str
    booking_sequence: int
    wallet_balance: Decimal
    credit_limit: Decimal
    country: str | None = None
    country_code: str | None = None
    city: str | None = None
    address: str | None = None
    status: MerchantStatus
    user_count: int = 0
    # Per-merchant rollups for the Admin Merchant Management table. Both DEFAULT
    # TO ZERO and are only populated by the list endpoint, which computes them
    # in two grouped queries. Every other producer of this schema (create,
    # detail, approve, status-change) omits them and still validates — that is
    # what keeps this addition backward compatible for existing callers.
    tickets_issued: int = 0
    awaiting_verification: int = 0
    #: Which products this merchant may use — {"flights": bool, "hotels": bool,
    #: "visa": bool}. Empty dict on any caller that didn't compute it (same
    #: backward-compatible convention as tickets_issued/awaiting_verification
    #: above): the Admin list/detail screens populate it, other producers of
    #: this schema don't need to and still validate.
    service_access: dict[str, bool] = {}
    created_at: datetime.datetime

    model_config = {"from_attributes": True}

    @classmethod
    def of(
        cls,
        merchant,
        user_count: int | None = None,
        tickets_issued: int = 0,
        awaiting_verification: int = 0,
        service_access: dict[str, bool] | None = None,
    ) -> "MerchantResponse":
        return cls(
            id=merchant.merchant_id,
            merchant_code=merchant.merchant_code,
            merchant_name=merchant.merchant_name,
            company_name=merchant.company_name,
            company_type=merchant.company_type,
            email=merchant.email,
            phone=merchant.phone,
            reference_prefix=merchant.reference_prefix,
            booking_sequence=merchant.booking_sequence,
            wallet_balance=merchant.wallet_balance,
            credit_limit=merchant.credit_limit,
            country=merchant.country,
            country_code=merchant.country_code,
            city=merchant.city,
            address=merchant.address,
            status=merchant.status,
            user_count=user_count if user_count is not None else len(merchant.users),
            tickets_issued=tickets_issued,
            awaiting_verification=awaiting_verification,
            service_access=service_access or {},
            created_at=merchant.created_at,
        )


class CreateMerchantRequest(BaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    merchant_name: str = Field(min_length=1, max_length=150)
    company_type: CompanyType = CompanyType.BUSINESS_PARTNER
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)

    #: The first login created alongside the company.
    contact_person: str = Field(min_length=1, max_length=150)
    contact_email: EmailStr

    country: str | None = Field(default=None, max_length=100)
    country_code: str | None = Field(default=None, max_length=2)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = None
    credit_limit: Decimal = Field(default=Decimal("0"), ge=0)

    #: Auto-derived from the company name when omitted.
    merchant_code: str | None = Field(default=None, max_length=32)
    reference_prefix: str | None = Field(default=None, max_length=8)

    #: The Onboard form's Service / Product Access card. ``None`` (the form
    #: was never touched, or an older caller) keeps every default from
    #: ``service_access_service.DEFAULT_ACCESS`` rather than disabling
    #: everything.
    service_access: ServiceAccessInput | None = None


class UpdateMerchantRequest(BaseModel):
    merchant_name: str | None = Field(default=None, max_length=150)
    company_name: str | None = Field(default=None, max_length=200)
    company_type: CompanyType | None = None

    #: The company's contact address, editable from the Admin Portal's Edit
    #: Merchant form. ``EmailStr`` is the same validation ``CreateMerchantRequest``
    #: applies, so a malformed address is a 422 here exactly as it is there.
    #:
    #: NOT A LOGIN. ``merchants.email`` is where the platform writes to the
    #: company; the credentials its people sign in with are ``users.email`` rows,
    #: managed separately under ``/merchants/{id}/users``. Changing this does not
    #: change anybody's username, and deliberately so — the first user's login is
    #: seeded from this address at creation and diverges from it afterwards.
    email: EmailStr | None = None

    phone: str | None = Field(default=None, max_length=30)
    country: str | None = Field(default=None, max_length=100)
    country_code: str | None = Field(default=None, max_length=2)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = None
    credit_limit: Decimal | None = Field(default=None, ge=0)


class MerchantStatusRequest(BaseModel):
    status: MerchantStatus


class MerchantCreatedResponse(BaseModel):
    """Creation result, including the first login's one-time password."""

    merchant: MerchantResponse
    first_user: AccountResponse
    temporary_password: str
    message: str = (
        "Merchant created and awaiting approval. Share these credentials securely — "
        "the password cannot be retrieved again."
    )
