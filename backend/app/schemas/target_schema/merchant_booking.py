import datetime
from typing import Literal

from pydantic import BaseModel, Field

TravelType = Literal["flight", "hotel", "cruise"]
TripType = Literal["one_way", "round_trip"]
CabinClass = Literal["economy", "premium_economy", "business", "first_class"]
Gender = Literal["male", "female"]
PassengerType = Literal["adult", "child", "infant"]
SeatPreference = Literal["window", "aisle", "middle", "front_row", "exit_row"]
BaggageOption = Literal["none", "extra_15kg", "extra_20kg", "extra_30kg"]
MealOption = Literal["none", "veg", "non_veg", "vegan", "jain", "kosher", "halal"]


class PassengerCreate(BaseModel):
    full_name: str = Field(min_length=1, max_length=255)
    gender: Gender
    passenger_type: PassengerType
    # ISO-3166-1 alpha-2 codes, not catalog IDs — see DATABASE_REDESIGN_9TABLE.md §1.
    passport_issuing_country: str = Field(min_length=2, max_length=2)
    passport_number: str = Field(min_length=1, max_length=32)
    passport_issue_date: datetime.date
    passport_expiry_date: datetime.date
    date_of_birth: datetime.date
    nationality_country: str = Field(min_length=2, max_length=2)
    baggage_option: BaggageOption | None = None
    meal_option: MealOption | None = None
    special_assistance: str | None = None
    seat_preference: SeatPreference | None = None
    special_services: list[str] = Field(default_factory=list)


class PassengerOut(BaseModel):
    id: int
    full_name: str
    gender: str | None
    passenger_type: str | None
    passport_number: str | None
    date_of_birth: datetime.date | None
    baggage_option: str | None = None
    meal_option: str | None = None
    special_assistance: str | None = None
    seat_preference: str | None = None
    special_services: list[str] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class TicketRequestCreate(BaseModel):
    travel_type: TravelType
    flight_id: int | None = None
    hotel_id: int | None = None
    cruise_id: int | None = None
    airline_name: str | None = Field(default=None, max_length=100)
    flight_number: str | None = Field(default=None, max_length=20)
    trip_type: TripType | None = None
    departure: str = Field(min_length=1, max_length=255)
    arrival: str = Field(min_length=1, max_length=255)
    departure_date: datetime.date
    return_date: datetime.date | None = None
    cabin_class: CabinClass | None = None


class BookingCreatedOut(BaseModel):
    booking_id: int = Field(validation_alias="id")
    reference_number: str = Field(validation_alias="request_number")

    model_config = {"from_attributes": True, "populate_by_name": True}


class BookingDetailOut(BaseModel):
    booking_id: int = Field(validation_alias="id")
    reference_number: str = Field(validation_alias="request_number")
    travel_type: str = Field(validation_alias="item_type")
    departure: str | None
    arrival: str | None
    departure_date: datetime.date | None
    return_date: datetime.date | None = None
    cabin_class: str | None = None
    status: str
    total_amount: float | None = None
    rejection_reason: str | None = None
    passengers: list[PassengerOut] = []
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class RequestHistoryItemOut(BaseModel):
    booking_id: int = Field(validation_alias="id")
    reference_number: str = Field(validation_alias="request_number")
    request_type: str
    departure: str | None
    arrival: str | None
    travel_date: datetime.date | None = Field(default=None, validation_alias="departure_date")
    status: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class TicketEnquiryItemOut(BaseModel):
    flight_id: int = Field(validation_alias="id")
    airline: str
    from_airport: str
    to_airport: str
    departure_time: datetime.datetime
    arrival_time: datetime.datetime
    cabin_class: str
    seats_available: int
    price: float

    model_config = {"from_attributes": True, "populate_by_name": True}


class DashboardStatsOut(BaseModel):
    total_requests: int
    pending_requests: int
    approved_requests: int
    rejected_requests: int
    completed_requests: int
    cancelled_requests: int
    today_requests: int
    today_revenue: float
