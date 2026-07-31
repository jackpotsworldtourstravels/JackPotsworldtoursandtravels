import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.target_schema.base import Base


class CommunicationSettings(Base):
    """Per-user or per-merchant communication preferences. Config-shaped data,
    kept distinct from users/merchants (1:1 but a separate concern) and from
    msg_logs (settings aren't messages).
    """

    __tablename__ = "ts_communication_settings"
    __table_args__ = (
        CheckConstraint(
            "(user_id IS NOT NULL) != (merchant_id IS NOT NULL)",
            name="ck_ts_communication_settings_exactly_one_owner",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id", ondelete="CASCADE"), nullable=True)
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("ts_merchants.id", ondelete="CASCADE"), nullable=True)

    email_enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    sms_enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    whatsapp_enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    push_enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    # Finer-grained category toggles (promotions, booking updates, etc.) not
    # worth a fixed column each.
    preferences: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
