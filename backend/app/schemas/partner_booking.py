import datetime
from typing import Literal

from pydantic import BaseModel, Field

TravelType = Literal["flight", "hotel", "cruise"]
TripType = Literal["one_way", "round_trip"]
CabinClass = Literal["economy", "premium_economy", "business", "first_class"]
Gender = Literal["male", "female"]
PassengerType = Literal["adult", "child", "infant"]


class PassengerCreate(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    gender: Gender
    passenger_type: PassengerType
    passport_issuing_country_id: int
    passport_number: str = Field(min_length=1, max_length=30)
    passport_issue_date: datetime.date
    passport_expiry_date: datetime.date
    date_of_birth: datetime.date
    nationality_country_id: int
    meal_preference: str | None = Field(default=None, max_length=80)
    special_assistance: str | None = None


class PassengerOut(BaseModel):
    passenger_id: int
    full_name: str
    gender: str
    passenger_type: str
    passport_number: str
    date_of_birth: datetime.date
    meal_preference: str | None = None
    special_assistance: str | None = None

    model_config = {"from_attributes": True}


class TicketRequestCreate(BaseModel):
    travel_type: TravelType
    flight_id: int | None = None
    hotel_id: int | None = None
    cruise_id: int | None = None
    airline_name: str | None = Field(default=None, max_length=100)
    flight_number: str | None = Field(default=None, max_length=20)
    trip_type: TripType | None = None
    departure: str = Field(min_length=1, max_length=150)
    arrival: str = Field(min_length=1, max_length=150)
    departure_date: datetime.date
    return_date: datetime.date | None = None
    cabin_class: CabinClass | None = None


class BookingCreatedOut(BaseModel):
    booking_id: int
    reference_number: str


class BookingDetailOut(BaseModel):
    booking_id: int
    reference_number: str
    travel_type: str
    airline_name: str | None = None
    flight_number: str | None = None
    departure: str
    arrival: str
    departure_date: datetime.date
    return_date: datetime.date | None = None
    cabin_class: str | None = None
    status: str
    total_amount: float | None = None
    rejection_reason: str | None = None
    passengers: list[PassengerOut] = []
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class RequestHistoryItemOut(BaseModel):
    booking_id: int
    reference_number: str
    service_request_number: str | None = None
    passenger_name: str
    travel_type: str
    destination: str
    travel_date: datetime.date | None = None
    status: str
    created_at: datetime.datetime


class TicketEnquiryItemOut(BaseModel):
    flight_id: int
    airline: str
    from_airport: str
    to_airport: str
    departure_time: datetime.datetime
    arrival_time: datetime.datetime
    cabin_class: str
    seats_available: int
    price: float


class DashboardStatsOut(BaseModel):
    total_requests: int
    pending_requests: int
    approved_requests: int
    rejected_requests: int
    completed_requests: int
    cancelled_requests: int
    today_requests: int
    today_revenue: float
