import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, SmallInteger, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.target_schema.base import Base

# All ts_* enum types are created by backend/db/target_schema/01_types.sql
# (via the Alembic migration) — create_type=False so SQLAlchemy never issues
# CREATE TYPE itself. Prefixed ts_ to avoid colliding with the 13 legacy enum
# types (partner_status_enum, etc.) that remain live until cutover retires them.
user_type_enum = SAEnum(
    "customer", "admin", "super_admin", "merchant_staff", name="ts_user_type_enum", create_type=False
)
# Matches real usage across both legacy vocabularies this replaces: customer/
# admin users (is_active/is_blocked/is_deleted booleans) and merchant_staff
# (partner_user_status_enum: active/inactive/blocked). An earlier draft used
# 'suspended', a value neither legacy system actually uses — caught while
# wiring up the merchant-staff deactivate action, which writes 'inactive'.
# Trade-off: collapsing 3 independent customer booleans into 1 dominant-state
# enum (precedence deleted > blocked > inactive > active) loses the ability
# to represent e.g. "blocked AND separately deactivated" at the same time —
# acceptable since the admin UI already treats them as mutually exclusive in
# practice, but noted here since it's a real behavior change, not a no-op.
user_status_enum = SAEnum("active", "inactive", "blocked", "deleted", name="ts_user_status_enum", create_type=False)
merchant_role_type_enum = SAEnum(
    "admin", "user", "maker", "checker", name="ts_merchant_role_type_enum", create_type=False
)
merchant_member_role_enum = SAEnum(
    "admin", "user", "data_operator", "request_ticket", "cancellation_ticket", "supervisor", "manager",
    name="ts_merchant_member_role_enum", create_type=False,
)
otp_purpose_enum = SAEnum("login", "password_reset", name="ts_otp_purpose_enum", create_type=False)


class User(Base):
    """Every human actor: customer, admin, super_admin, or merchant_staff.

    Replaces legacy users, roles, permissions, role_permissions, partner_users,
    and the live-OTP-state portion of partner_otp_requests.
    """

    __tablename__ = "ts_users"
    __table_args__ = (
        CheckConstraint(
            "user_type != 'merchant_staff' OR merchant_id IS NOT NULL",
            name="ck_ts_users_merchant_staff_has_merchant",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_type: Mapped[str] = mapped_column(user_type_enum, nullable=False)
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("ts_merchants.id"), nullable=True)
    role_type: Mapped[str | None] = mapped_column(merchant_role_type_enum, nullable=True)
    member_role: Mapped[str | None] = mapped_column(merchant_member_role_enum, nullable=True)
    permissions: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    username: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    phone_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)

    gender: Mapped[str | None] = mapped_column(String(16), nullable=True)
    dob: Mapped[datetime.date | None] = mapped_column(nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    address: Mapped[str | None] = mapped_column(String(300), nullable=True)

    otp_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    otp_purpose: Mapped[str | None] = mapped_column(otp_purpose_enum, nullable=True)
    otp_expires_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    otp_attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    # Set when an OTP is successfully verified, cleared once consumed by the
    # login/reset step it gated (or once its own short window lapses). Needed
    # because the merchant portal's login is a 3-step flow (request OTP ->
    # verify OTP -> submit password) — otp_hash alone can't gate step 3 since
    # it's already been cleared by the time step 2 succeeds.
    otp_verified_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    reset_token_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reset_token_expires_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    status: Mapped[str] = mapped_column(user_status_enum, nullable=False, default="active")
    is_verified: Mapped[bool] = mapped_column(nullable=False, default=False)
    force_logout_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Deferred callable, not a direct import: merchants.py imports this module
    # at top level, so importing Merchant back here at module scope would cycle.
    merchant: Mapped["Merchant | None"] = relationship(
        lambda: __import__("app.models.target_schema.merchants", fromlist=["Merchant"]).Merchant,
        back_populates="staff", foreign_keys=[merchant_id],
    )
