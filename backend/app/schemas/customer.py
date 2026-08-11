"""Request/response schemas for the Customer Portal (V1).

Deliberately its own module rather than additions to ``schemas/auth.py``: that
one models a three-portal B2B login with roles, permissions, merchant ids and
a ``portal`` discriminator, none of which a customer has. Sharing
``UserResponse`` would have meant a customer response carrying
``merchant_id: null`` and ``permissions: []`` forever, which invites a frontend
to start reading them.
"""
import datetime
import re

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

#: Matches the B2B rules exactly (schemas/auth.py). 72 is bcrypt's silent
#: truncation point, so it is a correctness bound rather than a policy choice.
PasswordStr = Field(min_length=8, max_length=72)

#: Digits with an optional leading +, 8-15 digits — E.164's bound. The service
#: strips spaces and dashes before this ever sees the value.
_MOBILE_RE = re.compile(r"^\+?\d{8,15}$")


def _clean_mobile(value: str) -> str:
    cleaned = (value or "").strip().replace(" ", "").replace("-", "")
    if not _MOBILE_RE.match(cleaned):
        raise ValueError(
            "Enter a valid mobile number — 8 to 15 digits, optionally starting with +"
        )
    return cleaned


class CustomerSignupRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=150)
    email: EmailStr
    mobile: str
    #: Optional per the spec. Absent means "not told us".
    date_of_birth: datetime.date | None = None
    password: str = PasswordStr
    confirm_password: str

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v: str) -> str:
        return _clean_mobile(v)

    @field_validator("full_name")
    @classmethod
    def _name(cls, v: str) -> str:
        cleaned = " ".join((v or "").split())
        if len(cleaned) < 2:
            raise ValueError("Enter your full name")
        return cleaned

    @field_validator("date_of_birth")
    @classmethod
    def _dob(cls, v: datetime.date | None) -> datetime.date | None:
        if v is None:
            return None
        today = datetime.date.today()
        if v > today:
            raise ValueError("Date of birth cannot be in the future")
        # 120 years is the sanity bound, not an age policy — the portal has no
        # minimum age rule, and inventing one here would enforce it invisibly.
        if v < today.replace(year=today.year - 120):
            raise ValueError("Enter a valid date of birth")
        return v

    @model_validator(mode="after")
    def _passwords_match(self):
        # Checked server-side as well as in the form: the browser check is a
        # convenience, and this endpoint is reachable without it.
        if self.password != self.confirm_password:
            raise ValueError("Passwords do not match")
        return self


class CustomerLoginRequest(BaseModel):
    """Email **or** mobile, per the spec's login form."""

    identifier: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=72)


class CustomerLoginChallengeResponse(BaseModel):
    otp_required: bool = True
    challenge_token: str
    delivery: str = Field(description="'email' when SMTP is configured, else 'dev'")
    message: str
    #: Populated only in dev delivery mode, so local work needs no SMTP account.
    dev_otp: str | None = None


class CustomerVerifyOtpRequest(BaseModel):
    challenge_token: str
    code: str = Field(min_length=4, max_length=10)


class CustomerResendOtpRequest(BaseModel):
    challenge_token: str


class CustomerRefreshRequest(BaseModel):
    refresh_token: str


class CustomerForgotPasswordRequest(BaseModel):
    email: EmailStr


class CustomerResetPasswordRequest(BaseModel):
    token: str
    new_password: str = PasswordStr
    confirm_password: str

    @model_validator(mode="after")
    def _passwords_match(self):
        if self.new_password != self.confirm_password:
            raise ValueError("Passwords do not match")
        return self


class CustomerChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = PasswordStr
    confirm_password: str

    @model_validator(mode="after")
    def _check(self):
        if self.new_password != self.confirm_password:
            raise ValueError("Passwords do not match")
        if self.new_password == self.current_password:
            raise ValueError("New password must differ from the current one")
        return self


class CustomerProfileUpdateRequest(BaseModel):
    """Every field optional — this is a PATCH over the profile.

    ``email`` is absent on purpose. It is the login identifier and is unique
    across customers; changing it is an account-recovery operation, not a
    profile edit, and giving it a quiet home on this endpoint would let it be
    changed with nothing but a live session.
    """

    full_name: str | None = Field(default=None, min_length=2, max_length=150)
    mobile: str | None = None
    date_of_birth: datetime.date | None = None
    gender: str | None = Field(default=None, max_length=20)
    address_line1: str | None = Field(default=None, max_length=255)
    address_line2: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, max_length=20)
    profile_photo: str | None = Field(default=None, max_length=500)

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v: str | None) -> str | None:
        return None if v is None else _clean_mobile(v)


class CustomerResponse(BaseModel):
    """The signed-in customer.

    No ``role``, no ``permissions``, no ``merchant_id`` — see the module
    docstring. ``customer_code`` is the human-facing identifier (CUS-000001).
    """

    id: int
    customer_code: str
    full_name: str
    email: EmailStr
    mobile: str
    date_of_birth: datetime.date | None = None
    status: str
    email_verified: bool = False
    mobile_verified: bool = False
    gender: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    postal_code: str | None = None
    profile_photo: str | None = None
    last_login: datetime.datetime | None = None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


class CustomerTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    customer: "CustomerResponse | None" = None


class CustomerSessionResponse(BaseModel):
    id: int
    ip_address: str | None = None
    browser: str | None = None
    device: str | None = None
    login_at: datetime.datetime
    last_seen_at: datetime.datetime

    model_config = {"from_attributes": True}


class CustomerMessageResponse(BaseModel):
    message: str
    #: Debug-mode only, mirroring /api/auth/forgot-password.
    reset_link: str | None = None


CustomerTokenResponse.model_rebuild()
