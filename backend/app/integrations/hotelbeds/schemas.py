"""JackPots-shaped views of Hotelbeds content.

THE TRANSLATION BOUNDARY. Above this file nothing knows what
``categoryCode``, ``zoneCode`` or ``ApiContent`` mean; below it nothing knows
what a ``customer_hotel`` is. Keeping both halves ignorant of each other is
what lets the supplier change without the sync rewriting itself.

These are dataclasses rather than Pydantic models on purpose: they are internal
plumbing between an adapter and a service, never serialised to a customer, and
the project's Pydantic schemas are reserved for things that ARE.

WHAT IS DELIBERATELY ABSENT: price, currency, availability and cancellation
terms. Those are live facts that belong to the Booking API, and letting them
into a catalogue record is precisely the confusion the architecture exists to
prevent. A hotel row is what a property IS, never what it costs today.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class HbZone:
    """One zone inside a destination — our ``customer_locations`` tier."""

    zone_code: int
    name: str


@dataclass(frozen=True)
class HbDestination:
    """One destination — our ``customer_destinations`` tier.

    ``code`` is Hotelbeds' own string code (the thing their /hotels endpoint
    filters on). It is never assumed equal to our slug; the mapping is stored.
    """

    code: str
    name: str
    country_code: str
    zones: tuple[HbZone, ...] = ()


@dataclass(frozen=True)
class HbRoom:
    """A room TYPE the property offers, not a bookable rate."""

    room_code: str
    description: str
    min_pax: int | None = None
    max_pax: int | None = None
    max_adults: int | None = None
    max_children: int | None = None


@dataclass(frozen=True)
class HbHotel:
    """A property, normalised.

    Every field here was verified present in OpenAPI-Hotel-ContentAPI-3.0.yaml.
    Nothing is invented: where Hotelbeds has no equivalent — notably a guest
    review score, which the Content API simply does not carry — the field is
    absent rather than defaulted to something that would read as real.
    """

    code: int
    name: str
    description: str | None
    address: str | None
    postal_code: str | None
    city: str | None
    country_code: str | None
    destination_code: str | None
    zone_code: int | None
    latitude: float | None
    longitude: float | None
    #: Parsed from ``categoryCode`` ("4EST" -> 4). None when unparseable —
    #: never silently 3, because a wrong star count is a claim about a hotel.
    star_rating: int | None
    category_code: str | None
    accommodation_type_code: str | None
    chain_code: str | None
    #: Facility NAMES, flattened for our ARRAY(String(60)) column.
    amenities: tuple[str, ...] = ()
    #: Relative paths, e.g. "00/000112/000112a_hb_ro_025.jpg". NOT full URLs —
    #: the base is chosen at render time by size, and baking one in here would
    #: freeze a display decision into stored data.
    image_paths: tuple[str, ...] = ()
    rooms: tuple[HbRoom, ...] = field(default_factory=tuple)
    last_update: str | None = None
