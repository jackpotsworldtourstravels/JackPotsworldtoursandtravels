"""What the admin desk reads and writes on the B2C Catalogue Management
screens — Phase 5 of the B2C Admin Portal build-out. An allow-list, the same
discipline every other admin/* schema in this package uses: a write body names
exactly the columns an admin may change, and ``extra="forbid"`` turns anything
else (a typo, or an attempt at a column that is not theirs, such as a package's
recorded rating) into a 422 instead of a silent no-op.

Reuses ``Page`` from ``schemas.pagination`` for every list, like the Phase 2/3
screens do, rather than restating the paging fields.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Write(BaseModel):
    """Base for every request body: unknown fields are an error."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# --------------------------------------------------------------------------- #
# Image library
# --------------------------------------------------------------------------- #

class ImageChoice(BaseModel):
    key: str
    library: str
    thumbnail: str


# --------------------------------------------------------------------------- #
# Flights — supplier status only. There is no flight inventory to edit.
# --------------------------------------------------------------------------- #

class FlightSupplierOption(BaseModel):
    code: str
    label: str
    #: True when adapter code for this supplier exists in the codebase.
    integrated: bool
    #: True for the one currently answering flight searches.
    active: bool
    #: Whether it holds what it needs to answer (a test token, for Duffel).
    #: Never the credential itself.
    configured: bool
    note: str


class FlightSupplierStatus(BaseModel):
    active_provider: str
    live: bool
    inventory_stored: bool
    summary: str
    flow: list[str]
    suppliers: list[FlightSupplierOption]


# --------------------------------------------------------------------------- #
# Hotels
# --------------------------------------------------------------------------- #

class HotelListItem(BaseModel):
    id: int
    name: str
    location: str
    city: str | None
    star_rating: int
    price_per_night: Decimal
    destination: str | None
    rooms_total: int
    rooms_active: int
    is_active: bool
    source: str


class RoomOut(BaseModel):
    id: int
    code: str
    name: str
    description: str | None
    bed_type: str | None
    size_label: str | None
    max_guests: int
    base_price_per_night: Decimal
    meal_plan: str
    cancellation_policy: str | None
    perks: list[str]
    total_inventory: int
    is_active: bool


class HotelDetail(BaseModel):
    id: int
    name: str
    description: str | None
    star_rating: int
    guest_rating: Decimal | None
    location: str
    address: str | None
    city: str | None
    price_per_night: Decimal
    amenities: list[str]
    image_key: str | None
    images: list[str]
    cancellation_policy: str | None
    is_active: bool
    source: str
    #: True for a row the supplier sync writes: its content fields are refused
    #: here because the next sync would overwrite them.
    sync_owned: bool
    destination_id: int | None
    destination_name: str | None
    location_id: int | None
    location_name: str | None
    created_at: dt.datetime
    rooms: list[RoomOut]


class HotelUpdate(_Write):
    name: str | None = Field(None, min_length=1, max_length=150)
    description: str | None = Field(None, max_length=4000)
    star_rating: int | None = Field(None, ge=1, le=5)
    location: str | None = Field(None, min_length=1, max_length=200)
    address: str | None = Field(None, max_length=255)
    city: str | None = Field(None, max_length=120)
    cancellation_policy: str | None = Field(None, max_length=255)
    destination_id: int | None = None
    location_id: int | None = None
    amenities: list[str] | None = Field(None, max_length=30)
    image_key: str | None = Field(None, max_length=60)
    images: list[str] | None = Field(None, max_length=12)
    is_active: bool | None = None


class RoomCreate(_Write):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(None, max_length=400)
    bed_type: str | None = Field(None, max_length=60)
    size_label: str | None = Field(None, max_length=30)
    max_guests: int = Field(2, ge=1, le=20)
    base_price_per_night: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    meal_plan: str = Field("Room only", min_length=1, max_length=60)
    cancellation_policy: str | None = Field(None, max_length=255)
    perks: list[str] = Field(default_factory=list, max_length=12)
    total_inventory: int = Field(5, ge=0, le=1000)
    is_active: bool = True


class RoomUpdate(_Write):
    """No ``code``: it is what a booking's room line was created against."""

    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=400)
    bed_type: str | None = Field(None, max_length=60)
    size_label: str | None = Field(None, max_length=30)
    max_guests: int | None = Field(None, ge=1, le=20)
    base_price_per_night: Decimal | None = Field(None, gt=0, max_digits=12, decimal_places=2)
    meal_plan: str | None = Field(None, min_length=1, max_length=60)
    cancellation_policy: str | None = Field(None, max_length=255)
    perks: list[str] | None = Field(None, max_length=12)
    total_inventory: int | None = Field(None, ge=0, le=1000)
    is_active: bool | None = None


# --------------------------------------------------------------------------- #
# Tour packages
# --------------------------------------------------------------------------- #

TripType = Literal["domestic", "pilgrimage", "international"]


class PackageListItem(BaseModel):
    id: int
    name: str
    destination: str | None
    trip_type: str | None
    category: str
    days: int
    price_from: Decimal
    is_active: bool
    departures_upcoming: int
    next_departure: dt.date | None


class ItineraryDayOut(BaseModel):
    day_number: int
    title: str
    description: str | None
    location: str | None
    image_key: str | None
    meals: list[str]


class DepartureOut(BaseModel):
    id: int
    departure_date: dt.date
    price_per_person: Decimal
    seats_left: int
    is_active: bool
    #: True once the date has passed — shown but no longer editable as live.
    past: bool


class PackageDetail(BaseModel):
    id: int
    name: str
    blurb: str
    description: str | None
    destination: str | None
    trip_type: str | None
    category: str
    days: int
    nights: int | None
    price_from: Decimal
    is_international: bool
    hotel_category: int | None
    highlights: list[str]
    inclusions: list[str]
    exclusions: list[str]
    cancellation_policy: str | None
    image_key: str | None
    is_active: bool
    created_at: dt.datetime
    itinerary: list[ItineraryDayOut]
    departures: list[DepartureOut]
    #: Plain-language reasons this package is not fully ready to sell. Never
    #: blocks a save — a draft is allowed — only tells the admin what is missing.
    warnings: list[str]


class PackageCreate(_Write):
    """A NEW PACKAGE STARTS DISABLED unless ``is_active`` is sent: it has no
    departures yet, and a live package nobody can book is a worse first
    impression than one that is not listed."""

    name: str = Field(min_length=1, max_length=150)
    blurb: str = Field(min_length=1, max_length=300)
    description: str | None = Field(None, max_length=8000)
    destination: str | None = Field(None, max_length=120)
    trip_type: TripType
    days: int = Field(ge=1, le=60)
    nights: int | None = Field(None, ge=0, le=60)
    price_from: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    hotel_category: Literal[3, 4, 5] | None = None
    highlights: list[str] = Field(default_factory=list, max_length=10)
    inclusions: list[str] = Field(default_factory=list, max_length=30)
    exclusions: list[str] = Field(default_factory=list, max_length=30)
    cancellation_policy: str | None = Field(None, max_length=255)
    image_key: str | None = Field(None, max_length=60)
    is_active: bool = False


class PackageUpdate(_Write):
    """No ``category`` (holiday vs gaming is not an admin edit — gaming trips
    are enquiry-based) and no rating fields (a score is a claim about where it
    came from, and is not the desk's to type)."""

    name: str | None = Field(None, min_length=1, max_length=150)
    blurb: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = Field(None, max_length=8000)
    destination: str | None = Field(None, max_length=120)
    trip_type: TripType | None = None
    days: int | None = Field(None, ge=1, le=60)
    nights: int | None = Field(None, ge=0, le=60)
    price_from: Decimal | None = Field(None, gt=0, max_digits=12, decimal_places=2)
    hotel_category: Literal[3, 4, 5] | None = None
    highlights: list[str] | None = Field(None, max_length=10)
    inclusions: list[str] | None = Field(None, max_length=30)
    exclusions: list[str] | None = Field(None, max_length=30)
    cancellation_policy: str | None = Field(None, max_length=255)
    image_key: str | None = Field(None, max_length=60)
    is_active: bool | None = None


class ItineraryDayIn(_Write):
    day_number: int = Field(ge=1, le=60)
    title: str = Field(min_length=1, max_length=160)
    description: str | None = Field(None, max_length=4000)
    location: str | None = Field(None, max_length=120)
    image_key: str | None = Field(None, max_length=60)
    meals: list[Literal["breakfast", "lunch", "dinner"]] = Field(default_factory=list, max_length=3)


class ItineraryReplace(_Write):
    """The whole itinerary, as it should now read. Days absent from it are
    removed; an empty list clears it."""

    days: list[ItineraryDayIn] = Field(max_length=60)


class DepartureCreate(_Write):
    departure_date: dt.date
    price_per_person: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    seats_left: int = Field(12, ge=0, le=500)
    is_active: bool = True


class DepartureUpdate(_Write):
    """No date: a booking is made against a departure, so a wrong date is
    fixed by disabling it and adding the right one."""

    price_per_person: Decimal | None = Field(None, gt=0, max_digits=12, decimal_places=2)
    seats_left: int | None = Field(None, ge=0, le=500)
    is_active: bool | None = None


# --------------------------------------------------------------------------- #
# Destinations
# --------------------------------------------------------------------------- #

class DestinationListItem(BaseModel):
    id: int
    name: str
    slug: str
    country: str | None
    image_key: str | None
    is_active: bool
    #: 1-based place in the homepage order, counting active destinations only;
    #: null for a disabled one.
    position: int | None
    #: True while this destination is inside the homepage shelf's first-shown
    #: window — what "popular" means on the customer site.
    popular: bool
    locations_total: int
    hotels_active: int


class LocationOut(BaseModel):
    id: int
    name: str
    slug: str
    description: str | None
    image_key: str | None
    sort_order: int
    is_active: bool
    hotels_active: int


class DestinationDetail(DestinationListItem):
    locations: list[LocationOut]


class DestinationCreate(_Write):
    name: str = Field(min_length=1, max_length=120)
    country: str | None = Field(None, max_length=80)
    image_key: str | None = Field(None, max_length=60)
    is_active: bool = True


class DestinationUpdate(_Write):
    """No ``slug`` (it is the public identifier every link and image key was
    built from) and no ``sort_order`` (that is ``/reorder``'s job, so there is
    one way to change the homepage order)."""

    name: str | None = Field(None, min_length=1, max_length=120)
    country: str | None = Field(None, max_length=80)
    image_key: str | None = Field(None, max_length=60)
    is_active: bool | None = None


class DestinationReorder(_Write):
    ids: list[int] = Field(min_length=1, max_length=500)


class LocationCreate(_Write):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(None, max_length=1000)
    image_key: str | None = Field(None, max_length=60)
    sort_order: int | None = Field(None, ge=0, le=32000)
    is_active: bool = True


class LocationUpdate(_Write):
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=1000)
    image_key: str | None = Field(None, max_length=60)
    sort_order: int | None = Field(None, ge=0, le=32000)
    is_active: bool | None = None
