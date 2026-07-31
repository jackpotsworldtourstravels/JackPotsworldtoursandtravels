import datetime

from sqlalchemy import DateTime, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.target_schema.base import Base
# Safe top-level import: users.py does not import this module, so there's no cycle.
from app.models.target_schema.users import User

# Matches the legacy partner_status_enum vocabulary exactly (active/inactive/
# suspended) — an earlier draft of this design invented 'pending'/'rejected'
# values that don't exist anywhere in the actual system; admin_merchant_service.py's
# activate/deactivate actions only ever write 'active'/'inactive'.
merchant_status_enum = SAEnum("active", "inactive", "suspended", name="ts_merchant_status_enum", create_type=False)


class Merchant(Base):
    """Partner company account. Replaces legacy partners + profile fields +
    booking_reference_counters (composite PK partner_id+year -> reference_counters JSONB map).
    """

    __tablename__ = "ts_merchants"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    reference_prefix: Mapped[str | None] = mapped_column(String(8), nullable=True)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False)
    company_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    contact_person: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    address: Mapped[str | None] = mapped_column(String(300), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)
    gst_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    pan_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(merchant_status_enum, nullable=False, default="active")
    # {"2026": 42, ...} — replaces the composite-PK per-year counter table.
    reference_counters: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    staff: Mapped[list[User]] = relationship(User, back_populates="merchant", foreign_keys=[User.merchant_id])
