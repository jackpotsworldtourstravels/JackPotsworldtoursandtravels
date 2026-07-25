import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base

export_format_enum = SAEnum("pdf", "excel", name="export_format_enum", create_type=False)


class PartnerPayment(Base):
    __tablename__ = "partner_payments"

    payment_id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("partner_bookings.booking_id"), nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    method: Mapped[str] = mapped_column(String(30), nullable=False, default="invoice")
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="success")
    transaction_ref: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    refunded_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    refund_reference: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ReportGenerationLog(Base):
    __tablename__ = "report_generation_log"

    report_id: Mapped[int] = mapped_column(primary_key=True)
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.partner_id"), nullable=False)
    partner_user_id: Mapped[int] = mapped_column(ForeignKey("partner_users.partner_user_id"), nullable=False)
    filters: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    export_format: Mapped[str] = mapped_column(export_format_enum, nullable=False)
    generated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PartnerNotification(Base):
    __tablename__ = "partner_notifications"

    notification_id: Mapped[int] = mapped_column(primary_key=True)
    partner_user_id: Mapped[int] = mapped_column(
        ForeignKey("partner_users.partner_user_id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    message: Mapped[str] = mapped_column(String(2000), nullable=False)
    is_read: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PartnerAuditLog(Base):
    __tablename__ = "partner_audit_logs"

    audit_id: Mapped[int] = mapped_column(primary_key=True)
    partner_id: Mapped[int | None] = mapped_column(ForeignKey("partners.partner_id"), nullable=True)
    partner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("partner_users.partner_user_id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    entity_id: Mapped[int | None] = mapped_column(nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
