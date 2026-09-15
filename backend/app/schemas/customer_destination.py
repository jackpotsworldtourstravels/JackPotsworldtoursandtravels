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


class DestinationHotelsPage(BaseModel):
    """A page of hotels for one destination, with its locations for filtering."""

    destination: DestinationSummary
    locations: list[DestinationHotelLocation] = []
    hotels: list[DestinationHotel] = []
    page: int
    page_size: int
    total: int = Field(description="Total matching hotels, not the size of this page.")
