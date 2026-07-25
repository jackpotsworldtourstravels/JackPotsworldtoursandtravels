import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, SmallInteger, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base

travel_type_enum = SAEnum("flight", "hotel", "cruise", name="travel_type_enum", create_type=False)
trip_type_enum = SAEnum("one_way", "round_trip", name="trip_type_enum", create_type=False)
cabin_class_enum = SAEnum(
    "economy", "premium_economy", "business", "first_class", name="cabin_class_enum", create_type=False
)
booking_status_enum = SAEnum(
    "draft", "pending_approval", "approved", "rejected", "completed", "cancelled",
    name="booking_status_enum", create_type=False,
)
gender_enum = SAEnum("male", "female", name="gender_enum", create_type=False)
passenger_type_enum = SAEnum("adult", "child", "infant", name="passenger_type_enum", create_type=False)


class BookingReferenceCounter(Base):
    __tablename__ = "booking_reference_counters"

    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.partner_id", ondelete="CASCADE"), primary_key=True)
    year: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    last_value: Mapped[int] = mapped_column(nullable=False, default=0)


class PartnerBooking(Base):
    __tablename__ = "partner_bookings"

    booking_id: Mapped[int] = mapped_column(primary_key=True)
    reference_number: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.partner_id"), nullable=False)
    partner_user_id: Mapped[int] = mapped_column(ForeignKey("partner_users.partner_user_id"), nullable=False)
    travel_type: Mapped[str] = mapped_column(travel_type_enum, nullable=False)
    flight_id: Mapped[int | None] = mapped_column(ForeignKey("flights.id"), nullable=True)
    hotel_id: Mapped[int | None] = mapped_column(ForeignKey("hotels.id"), nullable=True)
    cruise_id: Mapped[int | None] = mapped_column(ForeignKey("cruises.id"), nullable=True)
    airline_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    flight_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    trip_type: Mapped[str | None] = mapped_column(trip_type_enum, nullable=True)
    departure: Mapped[str] = mapped_column(String(150), nullable=False)
    arrival: Mapped[str] = mapped_column(String(150), nullable=False)
    departure_date: Mapped[datetime.date] = mapped_column(nullable=False)
    return_date: Mapped[datetime.date | None] = mapped_column(nullable=True)
    cabin_class: Mapped[str | None] = mapped_column(cabin_class_enum, nullable=True)
    status: Mapped[str] = mapped_column(booking_status_enum, nullable=False, default="draft")
    total_amount: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    rejected_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejected_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    passengers: Mapped[list["PartnerBookingPassenger"]] = relationship(back_populates="booking")


class PartnerBookingPassenger(Base):
    __tablename__ = "partner_booking_passengers"

    passenger_id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(
        ForeignKey("partner_bookings.booking_id", ondelete="CASCADE"), nullable=False
    )
    full_name: Mapped[str] = mapped_column(String(150), nullable=False)
    id_type: Mapped[str] = mapped_column(String(30), nullable=False, default="passport")
    gender: Mapped[str] = mapped_column(gender_enum, nullable=False)
    passenger_type: Mapped[str] = mapped_column(passenger_type_enum, nullable=False)
    passport_issuing_country_id: Mapped[int] = mapped_column(ForeignKey("countries.country_id"), nullable=False)
    passport_number: Mapped[str] = mapped_column(String(30), nullable=False)
    passport_issue_date: Mapped[datetime.date] = mapped_column(nullable=False)
    passport_expiry_date: Mapped[datetime.date] = mapped_column(nullable=False)
    date_of_birth: Mapped[datetime.date] = mapped_column(nullable=False)
    nationality_country_id: Mapped[int] = mapped_column(ForeignKey("countries.country_id"), nullable=False)
    meal_preference: Mapped[str | None] = mapped_column(String(80), nullable=True)
    special_assistance: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    booking: Mapped["PartnerBooking"] = relationship(back_populates="passengers")
