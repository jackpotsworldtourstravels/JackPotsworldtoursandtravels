import datetime
from typing import Literal

from pydantic import BaseModel, Field

ServiceRequestResolution = Literal["approved", "rejected", "completed"]


class MessageResponse(BaseModel):
    message: str


class AdminPartnerBookingListItemOut(BaseModel):
    booking_id: int
    reference_number: str
    partner_id: int
    company_name: str
    requester_name: str
    travel_type: str
    departure: str
    arrival: str
    departure_date: datetime.date
    passenger_count: int
    total_amount: float | None = None
    status: str
    created_at: datetime.datetime


class AncillarySelectionOut(BaseModel):
    catalog_id: int
    label: str
    additional_charge: float


class AdminPassengerOut(BaseModel):
    passenger_id: int
    full_name: str
    gender: str
    passenger_type: str
    passport_number: str
    date_of_birth: datetime.date
    meal_preference: str | None = None
    special_assistance: str | None = None
    baggage_selection: AncillarySelectionOut | None = None
    meal_selection: AncillarySelectionOut | None = None
    seat_preference: str | None = None
    special_services: list[AncillarySelectionOut] = Field(default_factory=list)


class AdminPartnerBookingDetailOut(BaseModel):
    booking_id: int
    reference_number: str
    company_name: str
    requester_name: str
    requester_email: str
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
    passengers: list[AdminPassengerOut] = []
    created_at: datetime.datetime


class ApproveBookingRequest(BaseModel):
    total_amount: float | None = Field(default=None, gt=0)


class RejectBookingRequest(BaseModel):
    reason: str = Field(min_length=1)


class AdminServiceRequestListItemOut(BaseModel):
    service_request_id: int
    service_request_number: str
    request_type: str
    status: str
    reason: str | None = None
    booking_id: int
    reference_number: str
    partner_id: int
    company_name: str
    requested_by: str
    created_at: datetime.datetime
    resolved_at: datetime.datetime | None = None


class ResolveServiceRequestRequest(BaseModel):
    status: ServiceRequestResolution
