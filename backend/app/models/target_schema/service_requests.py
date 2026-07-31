import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, SmallInteger, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.target_schema.base import Base

request_type_enum = SAEnum(
    "booking", "ticket_enquiry", "cancellation", "refund", "date_change",
    "passenger_modification", "support_ticket", name="ts_request_type_enum", create_type=False,
)
channel_enum = SAEnum("customer", "merchant", name="ts_channel_enum", create_type=False)
item_type_enum = SAEnum("flight", "hotel", "cruise", "tour_package", name="ts_item_type_enum", create_type=False)
trip_type_enum = SAEnum("one_way", "round_trip", name="ts_trip_type_enum", create_type=False)
cabin_class_enum = SAEnum(
    "economy", "premium_economy", "business", "first_class", name="ts_cabin_class_enum", create_type=False
)
# 'draft' added after porting the merchant ticket-request flow: a
# partner_bookings row starts as legacy status 'draft' (created, passengers
# still being added) before being explicitly submitted for approval —
# genuinely distinct from 'pending' (already submitted, awaiting an admin
# action). Conflating the two would make "is this ready for admin review"
# unanswerable from status alone.
request_status_enum = SAEnum(
    "draft", "pending", "approved", "rejected", "confirmed", "cancelled", "resolved", "completed",
    name="ts_request_status_enum", create_type=False,
)
priority_enum = SAEnum("low", "medium", "high", "urgent", name="ts_priority_enum", create_type=False)


class ServiceRequest(Base):
    """Every 'someone asked for something, it has a lifecycle' record.

    Replaces legacy bookings, partner_bookings, service_requests + its 4
    subtype tables, and support_tickets. request_type is the discriminator;
    parent_request_id links a subtype row (cancellation/refund/date_change/
    passenger_modification/support_ticket) back to the booking it's about.
    """

    __tablename__ = "ts_service_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_number: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    request_type: Mapped[str] = mapped_column(request_type_enum, nullable=False)
    channel: Mapped[str] = mapped_column(channel_enum, nullable=False)

    user_id: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id"), nullable=True)
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("ts_merchants.id"), nullable=True)
    parent_request_id: Mapped[int | None] = mapped_column(ForeignKey("ts_service_requests.id"), nullable=True)

    # Polymorphic catalog reference — no DB-level FK, matches the existing
    # bookings.item_id pattern (catalog tables are flights/hotels/cruises/tour_packages).
    item_type: Mapped[str | None] = mapped_column(item_type_enum, nullable=True)
    item_id: Mapped[int | None] = mapped_column(nullable=True)

    trip_type: Mapped[str | None] = mapped_column(trip_type_enum, nullable=True)
    cabin_class: Mapped[str | None] = mapped_column(cabin_class_enum, nullable=True)
    departure: Mapped[str | None] = mapped_column(String(255), nullable=True)
    arrival: Mapped[str | None] = mapped_column(String(255), nullable=True)
    departure_date: Mapped[datetime.date | None] = mapped_column(nullable=True)
    return_date: Mapped[datetime.date | None] = mapped_column(nullable=True)
    new_travel_date: Mapped[datetime.date | None] = mapped_column(nullable=True)

    quantity: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    coupon_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    total_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    amount_requested: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    status: Mapped[str] = mapped_column(request_status_enum, nullable=False, default="pending")
    priority: Mapped[str | None] = mapped_column(priority_enum, nullable=True)

    subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Sparse subtype-specific fields: field_changed/old_value/new_value
    # (passenger_modification), passenger_ids (cancellation/date_change/
    # passenger_modification — which passenger_data rows are affected),
    # extra ticket_enquiry fields.
    details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    approved_by: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id"), nullable=True)
    rejected_by: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id"), nullable=True)
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id"), nullable=True)
    approved_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejected_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Deferred-callable targets below, not bare string forward refs: this
    # app's declarative Base is shared with the legacy app.models package,
    # which also defines classes named Payment/ServiceRequest — a bare-name
    # string forward ref is ambiguous in the shared registry and raises
    # InvalidRequestError at mapper configuration time. A callable resolved
    # at mapper-configure time (well after all modules are imported) sidesteps
    # that lookup entirely and also avoids a payments.py <-> service_requests.py
    # circular import (payments.py imports this module directly).
    parent_request: Mapped["ServiceRequest | None"] = relationship(
        lambda: ServiceRequest, remote_side=lambda: [ServiceRequest.id]
    )
    passengers: Mapped[list["PassengerData"]] = relationship(back_populates="service_request")
    payments: Mapped[list["Payment"]] = relationship(
        lambda: __import__("app.models.target_schema.payments", fromlist=["Payment"]).Payment,
        back_populates="service_request",
    )
