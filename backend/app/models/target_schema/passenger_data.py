import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.target_schema.base import Base
# Safe top-level import, same reasoning as payments.py.
from app.models.target_schema.service_requests import ServiceRequest

gender_enum = SAEnum("male", "female", name="ts_gender_enum", create_type=False)
passenger_type_enum = SAEnum("adult", "child", "infant", name="ts_passenger_type_enum", create_type=False)
# Fixed sets replacing the removed ancillary_service_catalog table. These are
# a reasonable starting placeholder inferred from the catalog's category/code
# shape (category, code, label, additional_charge) — confirm against the live
# ancillary_service_catalog rows before cutover and adjust the enum values if
# the real catalog has different codes.
baggage_option_enum = SAEnum(
    "none", "extra_15kg", "extra_20kg", "extra_30kg", name="ts_baggage_option_enum", create_type=False
)
meal_option_enum = SAEnum(
    "none", "veg", "non_veg", "vegan", "jain", "kosher", "halal", name="ts_meal_option_enum", create_type=False
)


class PassengerData(Base):
    """Named passengers tied to a service_request (booking/ticket_enquiry).

    Replaces partner_booking_passengers + cancellation_request_passengers
    (folded into service_requests.details.passenger_ids instead of a join
    table) + passenger-level ancillary selections. countries and
    ancillary_service_catalog are embedded here rather than kept as separate
    lookup tables — see docs/DATABASE_REDESIGN_9TABLE.md §1.
    """

    __tablename__ = "ts_passenger_data"
    __table_args__ = (
        CheckConstraint(
            "passport_issuing_country IS NULL OR passport_issuing_country ~ '^[A-Z]{2}$'",
            name="ck_ts_passenger_data_passport_country_iso2",
        ),
        CheckConstraint(
            "nationality_country IS NULL OR nationality_country ~ '^[A-Z]{2}$'",
            name="ck_ts_passenger_data_nationality_country_iso2",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    service_request_id: Mapped[int] = mapped_column(
        ForeignKey("ts_service_requests.id", ondelete="CASCADE"), nullable=False
    )

    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    gender: Mapped[str | None] = mapped_column(gender_enum, nullable=True)
    passenger_type: Mapped[str | None] = mapped_column(passenger_type_enum, nullable=True)
    date_of_birth: Mapped[datetime.date | None] = mapped_column(nullable=True)

    passport_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    passport_issue_date: Mapped[datetime.date | None] = mapped_column(nullable=True)
    passport_expiry_date: Mapped[datetime.date | None] = mapped_column(nullable=True)
    # ISO-3166-1 alpha-2 codes — replaces FK to the removed `countries` table.
    passport_issuing_country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    nationality_country: Mapped[str | None] = mapped_column(String(2), nullable=True)

    baggage_option: Mapped[str | None] = mapped_column(baggage_option_enum, nullable=True)
    meal_option: Mapped[str | None] = mapped_column(meal_option_enum, nullable=True)
    seat_preference: Mapped[str | None] = mapped_column(String(16), nullable=True)
    special_assistance: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Short free-form service codes not covered by the fixed enum options above.
    special_services: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    service_request: Mapped[ServiceRequest] = relationship(ServiceRequest, back_populates="passengers")
