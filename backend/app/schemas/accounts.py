"""Schemas for administrator and merchant-staff account management."""
import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from app.models_v2 import MerchantRole, UserRole, UserStatus
from app.services import session_service


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

    # ---- the login-session picture (additive; every field defaults) --------
    # An account list that only says "Active" answers a question nobody asked:
    # `status` is whether the account is *permitted* to sign in, which is a
    # different fact from whether anyone has. These describe the most recent
    # session and are all None for an account that has never had one.
    #
    # They are OPTIONAL WITH DEFAULTS on purpose. This schema is also returned
    # by the Super Admin, merchant-team and account-creation endpoints, which
    # have no session to report; leaving them unset there keeps one schema
    # rather than forking it, and every existing consumer is unaffected.
    #: One of session_service.PRESENCE_* — online / recently_active / offline /
    #: never_logged_in. Derived, never stored.
    presence: str | None = None
    presence_label: str | None = None
    #: The address the last session connected FROM (public where a proxy
    #: forwarded one), and a LAN address if one was visible. `local_ip` is
    #: genuinely absent most of the time — see activity_service.client_addresses.
    last_login_ip: str | None = None
    last_login_local_ip: str | None = None
    #: "Desktop" / "Mobile" / "Tablet", the browser with its major version, and
    #: the operating system with its version where the client would tell us.
    last_login_device: str | None = None
    last_login_browser: str | None = None
    last_login_os: str | None = None
    #: When that session started, and when it last showed a sign of life. The
    #: second is what "Recently Active" is measured from.
    last_login_at: datetime.datetime | None = None
    last_seen_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}

    @classmethod
    def of(cls, user, *, online: bool = False, session=None, presence: str | None = None):
        extra = (getattr(session, "extra_data", None) or {}) if session else {}
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
            presence=presence,
            presence_label=session_service.PRESENCE_LABELS.get(presence or ""),
            last_login_ip=str(session.ip_address) if session and session.ip_address else None,
            last_login_local_ip=extra.get("local_ip"),
            last_login_device=session.device if session else None,
            last_login_browser=session.browser if session else None,
            last_login_os=extra.get("os"),
            # The session row's own timestamp, not `users.last_login`: they
            # agree, but this one is the login THESE device/IP fields belong to,
            # and a row that describes one session must not date itself from
            # another.
            last_login_at=session.created_at if session else None,
            last_seen_at=session_service.last_seen_at(session),
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
    #: ``admin`` or ``manager``. Defaults to Admin so every existing caller
    #: keeps working; the service refuses anything outside that pair.
    role: Literal["admin", "manager"] = "admin"


class UpdateAdminRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)
    #: Omit to leave the role alone. Supplying `admin` or `manager` moves the
    #: account between the two; the service refuses while a Manager still holds
    #: a booking under review.
    role: Literal["admin", "manager"] | None = None


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
