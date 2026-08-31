"""Request/response schemas for the customer flight booking flow.

NOTE WHAT THE REQUEST SCHEMAS DO NOT CONTAIN: prices. There is no ``amount``,
no ``total``, no ``seat_price`` on anything the client posts. The client names
what was chosen — a flight, a cabin, seat ids, add-on codes, a coupon — and the
server prices it. A schema that accepted a total would be a schema that could
be sent the wrong one.
"""
from __future__ import annotations

import datetime as dt
import re
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

TRAVELLER_TYPES = ("adult", "child", "infant")

_MOBILE_RE = re.compile(r"^\+?\d{8,15}$")


def _clean_mobile(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    cleaned = value.strip().replace(" ", "").replace("-", "")
    if not _MOBILE_RE.match(cleaned):
        raise ValueError("Enter a valid mobile number — 8 to 15 digits, optionally starting with +")
    return cleaned


class TravellerBase(BaseModel):
    """A person, saved or travelling.

    Only the two names are required. Passport is optional here even for
    international travel — the requirement is enforced at booking time, where
    the itinerary is known, rather than by a schema that cannot see it.
    """

    traveller_type: str = "adult"
    title: str | None = Field(default=None, max_length=10)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    gender: str | None = Field(default=None, max_length=20)
    date_of_birth: dt.date | None = None
    nationality: str | None = Field(default=None, max_length=100)
    passport_number: str | None = Field(default=None, max_length=40)
    passport_expiry: dt.date | None = None
    issuing_country: str | None = Field(default=None, max_length=100)
    frequent_flyer_airline: str | None = Field(default=None, max_length=100)
    frequent_flyer_number: str | None = Field(default=None, max_length=60)
    mobile: str | None = None
    email: EmailStr | None = None

    @field_validator("traveller_type")
    @classmethod
    def _kind(cls, v: str) -> str:
        v = (v or "adult").lower()
        if v not in TRAVELLER_TYPES:
            raise ValueError(f"Traveller type must be one of {', '.join(TRAVELLER_TYPES)}")
        return v

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v: str | None) -> str | None:
        return _clean_mobile(v)

    @field_validator("date_of_birth")
    @classmethod
    def _dob(cls, v: dt.date | None) -> dt.date | None:
        if v is not None and v > dt.date.today():
            raise ValueError("Date of birth cannot be in the future")
        return v


class TravellerCreate(TravellerBase):
    pass


class TravellerResponse(TravellerBase):
    model_config = ConfigDict(from_attributes=True)

    customer_traveller_id: int


class PassengerInput(TravellerBase):
    """A traveller on a specific booking."""

    #: Exactly one passenger on a booking carries the contact details.
    is_contact: bool = False


class SeatSelection(BaseModel):
    passenger_index: int = Field(ge=0)
    seat_number: str = Field(min_length=2, max_length=10)


class AddonSelection(BaseModel):
    code: str = Field(min_length=1, max_length=40)
    #: NULL means the whole party; an index means just that traveller.
    passenger_index: int | None = Field(default=None, ge=0)


class FlightInput(BaseModel):
    """The itinerary being bought.

    ``flight_key`` seeds the seat map and ``flight_number`` seeds the fare, so
    between them the server can re-derive every price without trusting one.
    """

    flight_key: str = Field(min_length=1, max_length=80)
    flight_number: str = Field(min_length=1, max_length=20)
    airline: str | None = Field(default=None, max_length=100)
    origin_code: str | None = Field(default=None, max_length=10)
    origin_city: str | None = Field(default=None, max_length=100)
    destination_code: str | None = Field(default=None, max_length=10)
    destination_city: str | None = Field(default=None, max_length=100)
    travel_date: dt.date | None = None
    departure_time: str | None = Field(default=None, max_length=10)
    arrival_time: str | None = Field(default=None, max_length=10)
    duration_label: str | None = Field(default=None, max_length=40)
    duration_minutes: int | None = Field(default=None, ge=0, le=3000)
    stops: int = Field(default=0, ge=0, le=5)
    cabin_class: str | None = Field(default="economy", max_length=40)
    is_international: bool = False


class QuoteRequest(BaseModel):
    flight: FlightInput
    #: Only the types matter for pricing; names are not needed to quote.
    passenger_types: list[str] = Field(min_length=1)
    seats: list[SeatSelection] = Field(default_factory=list)
    addons: list[AddonSelection] = Field(default_factory=list)
    coupon_code: str | None = Field(default=None, max_length=40)

    @field_validator("passenger_types")
    @classmethod
    def _kinds(cls, v: list[str]) -> list[str]:
        out = []
        for k in v:
            k = (k or "adult").lower()
            if k not in TRAVELLER_TYPES:
                raise ValueError(f"Traveller type must be one of {', '.join(TRAVELLER_TYPES)}")
            out.append(k)
        return out


class FareLine(BaseModel):
    label: str
    amount: Decimal


class QuoteResponse(BaseModel):
    currency: str
    base_fare: Decimal
    taxes: Decimal
    seat_charges: Decimal
    baggage_total: Decimal
    meal_total: Decimal
    service_total: Decimal
    discount: Decimal
    total_amount: Decimal
    coupon_code: str | None = None
    coupon_title: str | None = None
    #: Set when a coupon was sent but could not be applied. The quote still
    #: returns a fare — the customer needs to see it while they fix the code.
    coupon_error: str | None = None
    lines: list[FareLine]
    passengers_charged: int
    passengers_total: int


class BookingCreate(BaseModel):
    flight: FlightInput
    passengers: list[PassengerInput] = Field(min_length=1, max_length=9)
    seats: list[SeatSelection] = Field(default_factory=list)
    addons: list[AddonSelection] = Field(default_factory=list)
    coupon_code: str | None = Field(default=None, max_length=40)
    #: "Add these travellers to My Traveller List" on the traveller step.
    save_travellers: bool = False
    #: Identifies ONE submission. Send the same key when retrying and the
    #: server returns the booking it already made rather than making another
    #: (migration 0061). Optional, so existing callers are unaffected.
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=64)


class BookingPassengerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    passenger_index: int
    traveller_type: str
    title: str | None
    first_name: str
    last_name: str
    gender: str | None
    date_of_birth: dt.date | None
    nationality: str | None
    passport_number: str | None
    passport_expiry: dt.date | None
    issuing_country: str | None
    frequent_flyer_airline: str | None
    frequent_flyer_number: str | None
    seat_number: str | None
    seat_price: Decimal
    is_contact: bool
    mobile: str | None
    email: str | None


class BookingAddonResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    addon_type: str
    code: str
    name: str
    description: str | None
    unit_price: Decimal
    quantity: int
    passenger_index: int | None


class BookingPaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    method: str
    status: str
    amount: Decimal
    currency: str
    provider: str | None
    provider_reference: str | None
    created_at: dt.datetime


class BookingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    booking_ref: str
    #: NULL until an airline issues one. See customer_booking_service.
    pnr: str | None
    product_type: str
    status: str

    airline: str | None
    flight_number: str | None
    origin_code: str | None
    origin_city: str | None
    destination_code: str | None
    destination_city: str | None
    travel_date: dt.date | None
    departure_time: str | None
    arrival_time: str | None
    duration_label: str | None
    stops: int
    cabin_class: str | None
    is_international: bool

    base_fare: Decimal
    taxes: Decimal
    seat_charges: Decimal
    baggage_total: Decimal
    meal_total: Decimal
    service_total: Decimal
    discount: Decimal
    total_amount: Decimal
    currency: str
    coupon_code: str | None

    cancelled_at: dt.datetime | None
    created_at: dt.datetime

    passengers: list[BookingPassengerResponse] = []
    addons: list[BookingAddonResponse] = []
    payments: list[BookingPaymentResponse] = []


class PaymentRequest(BaseModel):
    method: str = Field(min_length=1, max_length=30)


class CouponValidateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=40)
    #: What the discount is taken off — the fare before extras.
    flight: FlightInput
    passenger_types: list[str] = Field(min_length=1)


class CouponValidateResponse(BaseModel):
    code: str
    title: str
    description: str | None = None
    discount: Decimal
    applies: bool
    message: str | None = None

class CouponOffer(BaseModel):
    """One coupon as the "view available coupons" panel lists it.

    Deliberately does not expose min_amount/max_discount arithmetic — the panel
    offers a code to try, and validate() is what says what it is worth on this
    particular fare.
    """

    model_config = ConfigDict(from_attributes=True)

    code: str
    title: str
    description: str | None = None
    discount_type: str
    discount_value: Decimal
