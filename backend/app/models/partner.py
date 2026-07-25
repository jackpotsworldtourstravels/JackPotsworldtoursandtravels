import datetime

from sqlalchemy import DateTime, ForeignKey, SmallInteger, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base

# create_type=False on every enum below: the PostgreSQL ENUM types already exist
# (created by backend/db/partner_portal/01_types.sql via the Alembic migration) —
# SQLAlchemy must not try to CREATE TYPE them again.
partner_status_enum = SAEnum("active", "inactive", "suspended", name="partner_status_enum", create_type=False)
partner_user_status_enum = SAEnum("active", "inactive", "blocked", name="partner_user_status_enum", create_type=False)
otp_purpose_enum = SAEnum("login", "password_reset", name="otp_purpose_enum", create_type=False)


class Partner(Base):
    __tablename__ = "partners"

    partner_id: Mapped[int] = mapped_column(primary_key=True)
    company_name: Mapped[str] = mapped_column(String(150), nullable=False)
    company_code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    reference_prefix: Mapped[str] = mapped_column(String(6), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    status: Mapped[str] = mapped_column(partner_status_enum, nullable=False, default="active")
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    users: Mapped[list["PartnerUser"]] = relationship(back_populates="partner")


class PartnerUser(Base):
    __tablename__ = "partner_users"

    partner_user_id: Mapped[int] = mapped_column(primary_key=True)
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.partner_id", ondelete="CASCADE"), nullable=False)
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"), nullable=False)
    full_name: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(partner_user_status_enum, nullable=False, default="active")
    last_login_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    partner: Mapped["Partner"] = relationship(back_populates="users")


class PartnerOTPRequest(Base):
    __tablename__ = "partner_otp_requests"

    otp_id: Mapped[int] = mapped_column(primary_key=True)
    partner_user_id: Mapped[int] = mapped_column(
        ForeignKey("partner_users.partner_user_id", ondelete="CASCADE"), nullable=False
    )
    otp_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    purpose: Mapped[str] = mapped_column(otp_purpose_enum, nullable=False)
    attempt_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    verified_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
