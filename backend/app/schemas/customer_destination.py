"""Response shapes for destination discovery.

Every field is something ``customer_destinations`` / ``customer_locations``
actually holds. There is no description and no photo URL on a destination: 0070
seeded geography and not marketing copy, and ``image`` is a key the client
resolves, not a link this service serves.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class DestinationSummary(BaseModel):
    """One place on the homepage's Destinations shelf."""

    id: str = Field(
        description=(
            "The destination's slug — 'goa', 'hyderabad'. This is the public identifier and "
            "what the locations route takes; the numeric primary key never leaves the "
            "database. A caller must never key off the display name."
        ),
    )
    name: str = Field(description="The place, as it is displayed.")
    slug: str = Field(
        description="Same value as `id`, named for what it is. Unique across destinations.",
    )
    country: str | None = Field(default=None, description="Country, where recorded.")
    image: str | None = Field(
        default=None,
        description=(
            "An image KEY, not a URL — the convention customer_hotels and customer_packages "
            "already use. The client resolves it against the artwork that shipped with the "
            "build; a key with no artwork, or a null key, falls back to a tinted card rather "
            "than to a broken image. Populated by migration 0071."
        ),
    )


class DestinationLocation(BaseModel):
    """One location inside a destination."""

    id: str = Field(
        description="Namespaced slug: 'goa__panaji'. Unique across the whole catalogue.",
    )
    destination_id: str = Field(description="Slug of the destination this belongs to.")
    name: str = Field(description="The location, as it is displayed.")
    slug: str = Field(
        description="The location's own slug, unique within its destination but not globally.",
    )
    description: str | None = Field(
        default=None,
        description="One line about the place (migration 0074), or null when none is recorded.",
    )
    image: str | None = Field(
        default=None,
        description="An image KEY, not a URL — same convention as a destination's `image`.",
    )
    hotel_count: int = Field(
        default=0,
        description=(
            "Active hotels mapped to this location by key (customer_hotels.location_id). "
            "Zero is a true answer about the catalogue, not an error."
        ),
    )


class DestinationHotelLocation(BaseModel):
    """One filter chip on the destination hotels page."""

    id: str = Field(description="Namespaced slug: 'goa__panaji'.")
    name: str
    slug: str


class DestinationHotel(BaseModel):
    """One property on the destination hotels grid.

    EVERY OPTIONAL FIELD IS GENUINELY OPTIONAL. A null here means the database
    does not hold that fact, and the card omits the row rather than printing a
    placeholder — a default star rating or a ₹0 price would be an invented
    claim about a real hotel.
    """

    id: str
    name: str
    image: str | None = Field(default=None, description="Image KEY, not a URL.")
    stars: int | None = None
    guest_rating: float | None = None
    location: str | None = Field(default=None, description="Display line, e.g. 'Panaji, Goa'.")
    address: str | None = None
    city: str | None = None
    description: str | None = None
    amenities: list[str] = []
    price_per_night: float | None = Field(
        default=None,
        description=(
            "Indicative nightly rate from the catalogue, or null when the row has "
            "none. NOT a live quote and never a guarantee of availability — "
            "dated rates come from the booking flow, not from this endpoint."
        ),
    )
    currency: str | None = None
    free_cancellation: bool = False
    location_id: str | None = Field(
        default=None,
        description="The location this hotel sits in, or null when unmapped.",
    )
    location_name: str | None = None
    distance_km: float | None = Field(
        default=None,
        description=(
            "Kilometres from the destination's AIRPORT, as the catalogue records it — the "
            "same figure the hotel results page labels 'km from airport'. Not a distance "
            "from the location: no coordinates are held that could measure one."
        ),
    )


class DestinationHotelsPage(BaseModel):
    """A page of hotels for one destination, with its locations for filtering."""

    destination: DestinationSummary
    locations: list[DestinationHotelLocation] = []
    hotels: list[DestinationHotel] = []
    page: int
    page_size: int
    total: int = Field(description="Total matching hotels, not the size of this page.")


class LocationHotelsPage(DestinationHotelsPage):
    """A page of hotels for one location, with the location itself."""

    location: DestinationLocation


class DestinationAttraction(BaseModel):
    """A famous place to visit — Charminar, the Burj Khalifa (migration 0075)."""

    id: str = Field(description="Namespaced slug: 'hyderabad__charminar'. Unique across the catalogue.")
    destination_id: str = Field(description="Slug of the destination this belongs to.")
    name: str
    slug: str = Field(description="The attraction's own slug, unique within its destination.")
    description: str | None = None
    image: str | None = Field(default=None, description="An image KEY, not a URL.")
    area_id: str | None = Field(
        default=None,
        description=(
            "The nearest listed AREA ('hyderabad__tank-bund') whose hotels View Hotels shows "
            "- hotels are filed by area, never by landmark. Null when no listed area is close "
            "enough to call nearby."
        ),
    )
    area_name: str | None = None
    hotel_count: int = Field(default=0, description="Active hotels in that area; 0 when none or no area.")


class AttractionFares(BaseModel):
    """What it costs to go, from data this database actually holds.

    A NULL IS AN ANSWER, and the honest one. The browser renders all three rows
    and prints "Currently unavailable" where the figure is null, because a
    number nobody can honour is worse on a booking site than a blank.
    """

    currency: str = "INR"
    hotel_from: float | None = Field(
        default=None,
        description=(
            "Lowest nightly rate among the ACTIVE hotels the View Hotels button "
            "will show - the nearest listed area's, or the whole destination's when "
            "the landmark has no listed area. Null when we list none."
        ),
    )
    hotel_scope: str | None = Field(
        default=None, description="'area' or 'destination' - which set that price came from.")
    hotel_scope_name: str | None = Field(
        default=None, description="The area or destination it came from, named.")
    flight_from: float | None = Field(
        default=None,
        description=(
            "Always null today. Flights are searched live and this database holds no "
            "fare table, so a 'from' price could only be invented."
        ),
    )
    package_from: float | None = Field(
        default=None,
        description=(
            "Always null today. customer_packages carries no destination link, so a "
            "package cannot be attributed to a place without guessing from its title."
        ),
    )


class AttractionDetail(DestinationAttraction):
    """One famous place, everything its own page needs."""

    destination_name: str
    country: str | None = None
    fare_details: AttractionFares
    nearby: list[DestinationAttraction] = Field(
        default_factory=list,
        description="Other famous places in the same destination, for Explore more.",
    )


class AttractionHotelsPage(DestinationHotelsPage):
    """Hotels near one attraction: the hotels of its nearest listed area."""

    attraction: DestinationAttraction
