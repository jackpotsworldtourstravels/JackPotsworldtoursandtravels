"""Request/response schemas for the customer hotel booking flow.

Same rule as ``customer_booking.py``: request schemas never carry money. The
client names a hotel, a room, a stay and a party; the server prices it in
``customer_hotel_pricing_service``.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

GUEST_TYPES = ("adult", "child")


class RoomOption(BaseModel):
    """One room type at a property, as the Room Selection step lists it."""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(validation_alias="customer_hotel_room_id")
    code: str
    name: str
    description: str | None
    bed_type: str | None
    size_label: str | None
    max_guests: int
    price: Decimal = Field(validation_alias="base_price_per_night")
    meal_plan: str
    cancellation_policy: str | None
    perks: list[str]
    left: int = Field(validation_alias="total_inventory")


class HotelSearchResult(BaseModel):
    """A row on the Hotel Results grid — the shape ``normaliseHotel()`` reads."""

    model_config = ConfigDict(from_attributes=True)

    id: str = Field(validation_alias="customer_hotel_id")
    name: str
    image: str | None = Field(validation_alias="image_key")
    stars: int = Field(validation_alias="star_rating")
    guest_rating: Decimal | None
    location: str
    distanceKm: Decimal | None = Field(validation_alias="distance_km")
    pricePerNight: Decimal = Field(validation_alias="price_per_night")
    amenities: list[str]
    cancellation_policy: str | None
    #: Derived from the property's rooms and its policy text — see the
    #: properties of the same names on ``CustomerHotel``. Sent so the results
    #: card can show a meal plan and a free-cancellation badge, and so the
    #: filter rail can offer those facets, without the browser having to fetch
    #: every property's rooms to find out.
    meal_plans: list[str] = []
    free_cancellation: bool = False

    @field_validator("id", mode="before")
    @classmethod
    def _stringify(cls, v):
        return str(v)


class HotelDetail(BaseModel):
    """Everything the Hotel Details step shows: images, policies, rooms."""

    model_config = ConfigDict(from_attributes=True)

    id: str = Field(validation_alias="customer_hotel_id")
    name: str
    description: str | None
    image: str | None = Field(validation_alias="image_key")
    images: list[str]
    stars: int = Field(validation_alias="star_rating")
    guest_rating: Decimal | None
    location: str
    distanceKm: Decimal | None = Field(validation_alias="distance_km")
    amenities: list[str]
    cancellation_policy: str | None
    rooms: list[RoomOption]

    @field_validator("id", mode="before")
    @classmethod
    def _stringify(cls, v):
        return str(v)


class HotelAddonItem(BaseModel):
    code: str
    name: str
    price: Decimal
    description: str | None = None
    per: str = "booking"
    group: str


class HotelAddonCatalogue(BaseModel):
    meal: list[HotelAddonItem]
    service: list[HotelAddonItem]


# ---------------------------------------------------------------------------
# Guests, rooms, requests
# ---------------------------------------------------------------------------
class GuestInput(BaseModel):
    """A person staying. Passport is never asked for — a hotel checks an
    ID at the desk, not a document this portal collects."""

    guest_type: str = "adult"
    #: Which room this guest is staying in, 0-based, matching the order of
    #: ``StayInput.room_ids``. Optional: a single-room booking has only one
    #: answer, and callers that predate multi-room do not send it.
    room_index: int | None = Field(default=None, ge=0, le=3)
    title: str | None = Field(default=None, max_length=10)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    gender: str | None = Field(default=None, max_length=20)
    date_of_birth: dt.date | None = None
    nationality: str | None = Field(default=None, max_length=100)
    is_contact: bool = False
    mobile: str | None = None
    email: EmailStr | None = None

    @field_validator("guest_type")
    @classmethod
    def _kind(cls, v: str) -> str:
        v = (v or "adult").lower()
        if v not in GUEST_TYPES:
            raise ValueError(f"Guest type must be one of {', '.join(GUEST_TYPES)}")
        return v


class HotelAddonSelection(BaseModel):
    code: str = Field(min_length=1, max_length=40)


class StayInput(BaseModel):
    """The stay being booked — what a hotel_id/room_id pair, dates and party
    size fully describe. No price is carried; the server re-reads the room."""

    hotel_id: int = Field(gt=0)
    room_id: int = Field(gt=0)
    check_in: dt.date
    check_out: dt.date
    rooms_count: int = Field(default=1, ge=1, le=4)
    adults: int = Field(default=1, ge=1, le=32)
    children: int = Field(default=0, ge=0, le=16)
    child_ages: list[int] = Field(default_factory=list)
    #: One room id per room booked, in the order the traveller configured them
    #: — this is what lets a stay mix room types (see migration 0058). Optional
    #: and empty by default, so every caller that predates it keeps describing
    #: "``rooms_count`` of ``room_id``" and behaves exactly as before.
    room_ids: list[int] = Field(default_factory=list, max_length=4)

    @field_validator("room_ids")
    @classmethod
    def _positive(cls, v: list[int]) -> list[int]:
        if any(r <= 0 for r in v):
            raise ValueError("Every room id must be a positive number.")
        return v

    @model_validator(mode="after")
    def _rooms_agree(self) -> "StayInput":
        """``room_ids`` and ``rooms_count`` must describe the same stay.

        Rather than let one silently win, a mismatch is refused: booking three
        rooms while naming two of them is a client bug, and quietly picking
        either interpretation would charge for a stay nobody asked for.
        """
        if self.room_ids and len(self.room_ids) != self.rooms_count:
            raise ValueError(
                f"{len(self.room_ids)} rooms were chosen but {self.rooms_count} were asked for."
            )
        return self

    @field_validator("check_out")
    @classmethod
    def _after_checkin(cls, v: dt.date, info) -> dt.date:
        ci = info.data.get("check_in")
        if ci and v <= ci:
            raise ValueError("Check-out must be at least one night after check-in.")
        return v


class HotelQuoteRequest(BaseModel):
    stay: StayInput
    addons: list[HotelAddonSelection] = Field(default_factory=list)
    coupon_code: str | None = Field(default=None, max_length=40)


class FareLine(BaseModel):
    label: str
    amount: Decimal


class HotelQuoteResponse(BaseModel):
    currency: str
    nights: int
    room_subtotal: Decimal
    taxes: Decimal
    addon_total: Decimal
    discount: Decimal
    total_amount: Decimal
    coupon_code: str | None = None
    coupon_title: str | None = None
    coupon_error: str | None = None
    lines: list[FareLine]


class HotelBookingCreate(BaseModel):
    #: Identifies ONE submission. Send the same key when retrying and the
    #: server returns the booking it already made rather than making another
    #: (migration 0060). Optional, so existing callers are unaffected.
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=64)
    stay: StayInput
    guests: list[GuestInput] = Field(min_length=1, max_length=32)
    addons: list[HotelAddonSelection] = Field(default_factory=list)
    special_requests: list[str] = Field(default_factory=list)
    notes: str | None = Field(default=None, max_length=500)
    coupon_code: str | None = Field(default=None, max_length=40)


class HotelBookingRoomResponse(BaseModel):
    """One room on the stay. Present for every booking made after migration
    0058; older bookings have none and are still fully described by the
    parent's own ``room_name``/``rooms_count``."""

    model_config = ConfigDict(from_attributes=True)

    room_index: int
    room_id: int
    room_name: str
    meal_plan: str | None
    price_per_night: Decimal


class HotelBookingGuestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    guest_index: int
    room_index: int | None
    guest_type: str
    title: str | None
    first_name: str
    last_name: str
    gender: str | None
    date_of_birth: dt.date | None
    nationality: str | None
    is_contact: bool
    mobile: str | None
    email: str | None


class HotelBookingAddonResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    addon_type: str
    code: str
    name: str
    description: str | None
    unit_price: Decimal
    quantity: int


class HotelBookingPaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    method: str
    status: str
    amount: Decimal
    currency: str
    provider: str | None
    provider_reference: str | None
    created_at: dt.datetime


class HotelBookingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    booking_ref: str
    product_type: str = "hotel"
    status: str

    hotel_id: int
    hotel_name: str
    hotel_location: str | None
    room_id: int
    room_name: str
    meal_plan: str | None
    check_in_date: dt.date
    check_out_date: dt.date
    nights: int
    rooms_count: int
    adults: int
    children: int
    child_ages: list[int] | None
    special_requests: list[str] | None
    notes: str | None

    room_subtotal: Decimal
    taxes: Decimal
    addon_total: Decimal
    discount: Decimal
    total_amount: Decimal
    currency: str
    coupon_code: str | None

    cancelled_at: dt.datetime | None
    created_at: dt.datetime

    rooms: list[HotelBookingRoomResponse] = []
    guests: list[HotelBookingGuestResponse] = []
    addons: list[HotelBookingAddonResponse] = []
    payments: list[HotelBookingPaymentResponse] = []


class HotelPaymentRequest(BaseModel):
    method: str = Field(min_length=1, max_length=30)
