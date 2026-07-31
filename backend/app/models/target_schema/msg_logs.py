import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.models.target_schema.base import Base

msg_channel_enum = SAEnum(
    "notification", "email", "sms", "whatsapp", "live_chat", "newsletter", "contact_form", "otp",
    name="ts_msg_channel_enum", create_type=False,
)
msg_direction_enum = SAEnum("outbound", "inbound", name="ts_msg_direction_enum", create_type=False)
msg_status_enum = SAEnum("sent", "delivered", "failed", "read", name="ts_msg_status_enum", create_type=False)


class MsgLog(Base):
    """Every message that left or entered the system: notifications, email,
    SMS, WhatsApp, live chat, newsletter signups, contact-form submissions,
    OTP sends. High-volume/append-only, hence BigInteger PK.
    """

    __tablename__ = "ts_msg_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    channel: Mapped[str] = mapped_column(msg_channel_enum, nullable=False)
    direction: Mapped[str] = mapped_column(msg_direction_enum, nullable=False)

    user_id: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id", ondelete="SET NULL"), nullable=True)
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("ts_merchants.id", ondelete="SET NULL"), nullable=True)
    # For anonymous contact-form/newsletter rows with no user_id.
    recipient_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    recipient_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)

    subject: Mapped[str | None] = mapped_column(String(200), nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Links a notification back to the service_requests row that triggered it.
    related_entity_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    related_entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    is_read: Mapped[bool] = mapped_column(nullable=False, default=False)
    status: Mapped[str | None] = mapped_column(msg_status_enum, nullable=True)
    sent_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
