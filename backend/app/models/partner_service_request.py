import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base

service_request_type_enum = SAEnum(
    "cancellation", "date_change", "refund", "passenger_modification",
    name="service_request_type_enum", create_type=False,
)
service_request_status_enum = SAEnum(
    "submitted", "in_review", "approved", "rejected", "completed",
    name="service_request_status_enum", create_type=False,
)


class ServiceRequest(Base):
    __tablename__ = "service_requests"

    service_request_id: Mapped[int] = mapped_column(primary_key=True)
    service_request_number: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    booking_id: Mapped[int] = mapped_column(ForeignKey("partner_bookings.booking_id"), nullable=False)
    partner_user_id: Mapped[int] = mapped_column(ForeignKey("partner_users.partner_user_id"), nullable=False)
    request_type: Mapped[str] = mapped_column(service_request_type_enum, nullable=False)
    status: Mapped[str] = mapped_column(service_request_status_enum, nullable=False, default="submitted")
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CancellationRequest(Base):
    __tablename__ = "cancellation_requests"

    service_request_id: Mapped[int] = mapped_column(
        ForeignKey("service_requests.service_request_id", ondelete="CASCADE"), primary_key=True
    )


class CancellationRequestPassenger(Base):
    __tablename__ = "cancellation_request_passengers"

    service_request_id: Mapped[int] = mapped_column(
        ForeignKey("cancellation_requests.service_request_id", ondelete="CASCADE"), primary_key=True
    )
    passenger_id: Mapped[int] = mapped_column(
        ForeignKey("partner_booking_passengers.passenger_id"), primary_key=True
    )


class DateChangeRequest(Base):
    __tablename__ = "date_change_requests"

    service_request_id: Mapped[int] = mapped_column(
        ForeignKey("service_requests.service_request_id", ondelete="CASCADE"), primary_key=True
    )
    passenger_id: Mapped[int] = mapped_column(ForeignKey("partner_booking_passengers.passenger_id"), nullable=False)
    old_travel_date: Mapped[datetime.date] = mapped_column(nullable=False)
    new_travel_date: Mapped[datetime.date] = mapped_column(nullable=False)


class RefundRequest(Base):
    __tablename__ = "refund_requests"

    service_request_id: Mapped[int] = mapped_column(
        ForeignKey("service_requests.service_request_id", ondelete="CASCADE"), primary_key=True
    )
    amount_requested: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("partner_payments.payment_id"), nullable=True)


class PassengerModificationRequest(Base):
    __tablename__ = "passenger_modification_requests"

    service_request_id: Mapped[int] = mapped_column(
        ForeignKey("service_requests.service_request_id", ondelete="CASCADE"), primary_key=True
    )
    passenger_id: Mapped[int] = mapped_column(ForeignKey("partner_booking_passengers.passenger_id"), nullable=False)
    field_changed: Mapped[str] = mapped_column(String(60), nullable=False)
    old_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    new_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
