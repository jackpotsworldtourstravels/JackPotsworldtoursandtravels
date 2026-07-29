"""Schemas for administrator and merchant-staff account management."""
import datetime

from pydantic import BaseModel, EmailStr, Field

from app.models_v2 import MerchantRole, UserRole, UserStatus


class AccountResponse(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    phone: str | None = None
    role: UserRole
    merchant_role: MerchantRole | None = None
    merchant_id: int | None = None
    status: UserStatus
    otp_enabled: bool
    last_login: datetime.datetime | None = None
    login_count: int = 0
    #: True when a heartbeat has landed within the last
    #: session_service.ONLINE_THRESHOLD_MINUTES. Only populated by endpoints
    #: that pass a precomputed set — see AccountResponse.of(online=...).
    is_online: bool = False
    created_at: datetime.datetime

    model_config = {"from_attributes": True}

    @classmethod
    def of(cls, user, *, online: bool = False) -> "AccountResponse":
        return cls(
            id=user.user_id,
            full_name=user.full_name,
            email=user.email,
            phone=user.phone,
            role=user.role,
            merchant_role=user.merchant_role,
            merchant_id=user.merchant_id,
            is_online=online,
            status=user.status,
            otp_enabled=user.otp_enabled,
            last_login=user.last_login,
            login_count=user.login_count or 0,
            created_at=user.created_at,
        )


class CredentialsResponse(BaseModel):
    """Returned once when an account is created or its password reset.

    ``temporary_password`` is the only time the plaintext exists outside the
    user's head — it is hashed on write and cannot be read back.
    """

    account: AccountResponse
    temporary_password: str
    message: str = (
        "Share these credentials securely. The password cannot be retrieved again — "
        "use 'Reset Password' to issue a new one."
    )


class CreateAdminRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)
    #: Omit to have a strong password generated and returned once.
    password: str | None = Field(default=None, min_length=8, max_length=72)


class UpdateAdminRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)


class StatusChangeRequest(BaseModel):
    status: UserStatus


class CreateMerchantUserRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)
    #: merchant_admin can manage the company; merchant_user is staff.
    role: UserRole = UserRole.MERCHANT_USER
    #: Manager / Supervisor / Operator / Finance / Data Operator.
    merchant_role: MerchantRole | None = None
    password: str | None = Field(default=None, min_length=8, max_length=72)


class UpdateMerchantUserRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    phone: str | None = Field(default=None, max_length=30)
    merchant_role: MerchantRole | None = None


class PermissionMatrixResponse(BaseModel):
    """The fixed role -> permission table. Read-only by design — see
    app/auth/rbac.py::role_permission_matrix()."""

    all_codes: list[str]
    roles: dict[str, list[str]]
    merchant_roles: dict[str, list[str]]


class AdminPermissionsResponse(BaseModel):
    """One admin's permission picture: what their role grants by default,
    what's been explicitly added on top, and the union of both."""

    admin_id: int
    role_defaults: list[str]
    extra_grants: list[str]
    effective: list[str]


class UpdateAdminPermissionsRequest(BaseModel):
    """Replaces the admin's *extra* grants. Codes already implied by the
    role default are accepted but have no additional effect — the union is
    idempotent, per app/auth/rbac.py's model. There is no way to revoke a
    role-default permission through this endpoint; that would require
    changing the role itself."""

    extra_grants: list[str] = Field(default_factory=list)
