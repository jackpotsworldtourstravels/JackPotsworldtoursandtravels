import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Numeric, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.target_schema.base import Base
# Safe top-level import: service_requests.py resolves its back-reference to
# this class via a deferred callable specifically to avoid a cycle here.
from app.models.target_schema.service_requests import ServiceRequest, item_type_enum

record_type_enum = SAEnum(
    "transaction", "coupon", "discount_campaign", name="ts_payment_record_type_enum", create_type=False
)
payment_status_enum = SAEnum(
    "pending", "success", "failed", "refunded", name="ts_payment_status_enum", create_type=False
)
discount_type_enum = SAEnum("percent", "flat", name="ts_discount_type_enum", create_type=False)


class Payment(Base):
    """Every monetary record: a real transaction, a coupon code, or a discount
    campaign definition. Merged per explicit instruction — see
    docs/DATABASE_REDESIGN_9TABLE.md §5.2 for the denormalization trade-off
    this represents (transactional rows sharing a table with reference data).
    """

    __tablename__ = "ts_payments"
    __table_args__ = (
        CheckConstraint(
            "record_type != 'transaction' OR amount IS NOT NULL", name="ck_ts_payments_transaction_has_amount"
        ),
        CheckConstraint(
            "record_type = 'transaction' OR code IS NOT NULL", name="ck_ts_payments_reference_has_code"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    record_type: Mapped[str] = mapped_column(record_type_enum, nullable=False)

    service_request_id: Mapped[int | None] = mapped_column(ForeignKey("ts_service_requests.id"), nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id"), nullable=True)
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("ts_merchants.id"), nullable=True)

    amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    method: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str | None] = mapped_column(payment_status_enum, nullable=True)
    transaction_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    refund_reference: Mapped[str | None] = mapped_column(String(64), nullable=True)
    refunded_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    code: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    discount_type: Mapped[str | None] = mapped_column(discount_type_enum, nullable=True)
    discount_value: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    # Which catalog item type a coupon/discount_campaign applies to — replaces
    # legacy discount_campaigns.applicable_type / coupons.applicable_type.
    # NULL means "applies to all types", same convention as the legacy columns.
    applicable_item_type: Mapped[str | None] = mapped_column(item_type_enum, nullable=True)
    valid_from: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    valid_until: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    usage_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    used_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    min_order_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    is_active: Mapped[bool] = mapped_column(nullable=False, default=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    service_request: Mapped[ServiceRequest | None] = relationship(ServiceRequest, back_populates="payments")
