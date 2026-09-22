"""Destinations and the locations inside them.

MASTER DATA, READ FROM ITS OWN TABLES. An earlier version of this module derived
a destination by scanning ``customer_hotels.location`` and
``customer_packages.name``, and the note it carried argued that deriving beat
storing because the only source available was those two columns. That was wrong
about what a destination IS. Under it a place existed only while something was
for sale there, so Goa — which this company sells a tour package to — answered
"no locations available" the moment you asked, simply because no Goa hotel had
been loaded. Seven of the nine places it found were dead ends for that reason.

``customer_destinations`` and ``customer_locations`` (migration 0070) hold the
geography now. It is independent of inventory in both directions: a destination
with no hotels and no packages still lists its locations, and a hotel appearing
in a new city does not silently invent a destination.

THE PUBLIC ID IS THE SLUG, not the primary key. ``/destinations/goa/locations``
reads better than ``/destinations/7/locations``, it survives a reseed, and it is
the identifier the frontend already keys off. The numeric key stays inside the
database where it belongs; nothing outside this module sees it.

HOTELS ARE NOW JOINED TO GEOGRAPHY, AND BY KEY. Migration 0072 gave
``customer_hotels`` a real ``destination_id`` and ``location_id``, so
``list_destination_hotels`` below answers "every hotel in Goa" with an indexed
predicate rather than by matching text. That distinction is the whole point: the
free-text ``location`` column still exists and is still what a card prints, but
nothing decides where a hotel IS by reading it.

The join is still one-directional in the sense that matters: a destination with
no hotels is a destination, not an error. Goa listing nothing is a true answer
about our catalogue, and this module reports it as one rather than hiding the
destination.
"""
from __future__ import annotations

import re
import unicodedata

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    CustomerAttraction,
    CustomerDestination,
    CustomerHotel,
    CustomerLocation,
)

#: Page size ceiling. A destination fed by a content provider can hold hundreds
#: of properties, and letting a caller ask for all of them in one response is
#: how a page takes ten seconds to paint.
MAX_PAGE_SIZE = 60
DEFAULT_PAGE_SIZE = 24


def _slug(value: str) -> str:
    """Fold a name to its url-safe form — the same rule migration 0070 seeded with.

    Applied to the INCOMING id as well, so ``/destinations/Goa/locations`` and
    ``/destinations/goa/locations`` are the same request rather than one of them
    being a 404 on a technicality.
    """
    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-")


def _destination_row(d: CustomerDestination) -> dict:
    return {
        "id": d.slug,
        "name": d.name,
        "slug": d.slug,
        "country": d.country,
        "image": d.image_key,
    }


def list_destinations(db: Session) -> list[dict]:
    """Every active destination, in the order the shelf should show them."""
    rows = db.scalars(
        select(CustomerDestination)
        .where(CustomerDestination.is_active.is_(True))
        .order_by(CustomerDestination.sort_order, CustomerDestination.name)
    ).all()
    return [_destination_row(d) for d in rows]


def list_locations(db: Session, destination_id: str) -> list[dict] | None:
    """The locations inside one destination, or ``None`` if no such destination.

    ``None`` and ``[]`` are different answers and the router turns them into
    different responses: an unknown slug is a 404, a real destination with
    nothing recorded under it yet is an empty list. A caller cannot tell "we
    have not mapped that place yet" from "you asked for somewhere that does not
    exist" otherwise.
    """
    wanted = _slug(destination_id or "")
    if not wanted:
        return None

    dest = db.scalar(
        select(CustomerDestination)
        .where(
            CustomerDestination.slug == wanted,
            CustomerDestination.is_active.is_(True),
        )
    )
    if dest is None:
        return None

    rows = db.scalars(
        select(CustomerLocation)
        .where(
            CustomerLocation.destination_id == dest.customer_destination_id,
            CustomerLocation.is_active.is_(True),
        )
        .order_by(CustomerLocation.sort_order, CustomerLocation.name)
    ).all()

    # How many active hotels sit in each location, in ONE grouped query rather
    # than one per card. The join is the location_id foreign key (0072) — the
    # hotel's free-text location is never read to decide this.
    counts = dict(db.execute(
        select(CustomerHotel.location_id, func.count())
        .where(
            CustomerHotel.destination_id == dest.customer_destination_id,
            CustomerHotel.is_active.is_(True),
            CustomerHotel.location_id.is_not(None),
        )
        .group_by(CustomerHotel.location_id)
    ).all())

    return [_location_row(dest, loc, counts.get(loc.customer_location_id, 0)) for loc in rows]


def _location_row(dest: CustomerDestination, loc: CustomerLocation, hotel_count: int = 0) -> dict:
    return {
        "id": f"{dest.slug}__{loc.slug}",
        "destination_id": dest.slug,
        "name": loc.name,
        "slug": loc.slug,
        "description": loc.description,
        "image": loc.image_key,
        "hotel_count": int(hotel_count or 0),
    }


def _find_destination(db: Session, destination_id: str) -> CustomerDestination | None:
    """Resolve the public slug to a row, folding the incoming value first."""
    wanted = _slug(destination_id or "")
    if not wanted:
        return None
    return db.scalar(
        select(CustomerDestination).where(
            CustomerDestination.slug == wanted,
            CustomerDestination.is_active.is_(True),
        )
    )


def _hotel_row(h: CustomerHotel, loc: CustomerLocation | None, dest: CustomerDestination) -> dict:
    """One hotel, shaped for the results card.

    ONLY WHAT THE ROW ACTUALLY HOLDS. Every optional field is sent as null when
    absent rather than as a plausible-looking default, because the card hides a
    null and prints a default — and a printed default is an invented fact about
    somebody's hotel.

    ``price`` is the clearest case. A catalogue row synced from a content
    provider has no price at all and stores 0; sending that through would put
    "₹0" on a card. Zero means "no catalogue price", so it leaves as null and
    the card shows nothing rather than a lie.
    """
    price = float(h.price_per_night or 0)
    return {
        "id": str(h.customer_hotel_id),
        "name": h.name,
        "image": h.image_key,
        "stars": h.star_rating,
        "guest_rating": float(h.guest_rating) if h.guest_rating is not None else None,
        "location": h.location,
        "address": h.address,
        "city": h.city,
        "description": h.description,
        "amenities": list(h.amenities or []),
        "price_per_night": price if price > 0 else None,
        "currency": "INR" if price > 0 else None,
        "free_cancellation": h.free_cancellation,
        #: Which location inside the destination, by key. Null is a real and
        #: common state — a hotel can be known to be in Goa before anyone has
        #: decided it is in Calangute — and the filter treats it as such.
        "location_id": f"{dest.slug}__{loc.slug}" if loc else None,
        "location_name": loc.name if loc else None,
        # From the airport — see DestinationHotel.distance_km. Null stays null.
        "distance_km": float(h.distance_km) if h.distance_km is not None else None,
    }


def list_destination_hotels(
    db: Session,
    destination_id: str,
    location_id: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict | None:
    """Every hotel in one destination, paginated. ``None`` if no such destination.

    THE FILTER IS A FOREIGN KEY, NOT A STRING. ``CustomerHotel.destination_id``
    is an indexed column written by migration 0072 and by the catalogue sync;
    the hotel's own ``location`` text is never compared to anything here. That
    is what makes this correct for every destination without a single
    destination-specific branch.

    ``location_id`` accepts the namespaced form the locations route hands out
    ('goa__panaji'). It is resolved against THIS destination's locations only,
    so a location slug shared by two destinations cannot leak hotels across.

    Args:
        destination_id: Our public slug.
        location_id: Optional 'dest__loc' filter.
        page: 1-based.
        page_size: Clamped to ``MAX_PAGE_SIZE``.

    Returns:
        ``{destination, locations, hotels, page, page_size, total}`` or None.
    """
    dest = _find_destination(db, destination_id)
    if dest is None:
        return None

    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))

    # The locations of this destination, needed both as filter chips and to
    # label each hotel. One query, reused.
    locations = db.scalars(
        select(CustomerLocation)
        .where(
            CustomerLocation.destination_id == dest.customer_destination_id,
            CustomerLocation.is_active.is_(True),
        )
        .order_by(CustomerLocation.sort_order, CustomerLocation.name)
    ).all()
    by_id = {loc.customer_location_id: loc for loc in locations}

    where = [
        CustomerHotel.destination_id == dest.customer_destination_id,
        CustomerHotel.is_active.is_(True),
    ]

    # Resolve the optional location filter WITHIN this destination.
    wanted_location = None
    if location_id:
        raw = str(location_id)
        # Accept 'goa__panaji' or plain 'panaji'; the destination half is
        # redundant here because the destination is already fixed by the route.
        loc_slug = _slug(raw.split("__", 1)[1] if "__" in raw else raw)
        wanted_location = next((l for l in locations if l.slug == loc_slug), None)
        if wanted_location is None:
            # A filter naming a location this destination does not have is an
            # empty result, not an error — the page can say so plainly.
            return {
                "destination": _destination_row(dest),
                "locations": [
                    {"id": f"{dest.slug}__{l.slug}", "name": l.name, "slug": l.slug}
                    for l in locations
                ],
                "hotels": [], "page": page, "page_size": page_size, "total": 0,
            }
        where.append(CustomerHotel.location_id == wanted_location.customer_location_id)

    total = db.scalar(select(func.count()).select_from(CustomerHotel).where(*where)) or 0

    rows = db.scalars(
        select(CustomerHotel)
        .where(*where)
        # Cheapest first is the ordering the hotel results grid already uses;
        # rows with no catalogue price (0) sort last rather than first, which
        # is why the price is keyed on being positive.
        .order_by(
            (CustomerHotel.price_per_night <= 0),
            CustomerHotel.price_per_night,
            CustomerHotel.name,
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
        .options(selectinload(CustomerHotel.rooms))
    ).all()

    return {
        "destination": _destination_row(dest),
        "locations": [
            {"id": f"{dest.slug}__{l.slug}", "name": l.name, "slug": l.slug}
            for l in locations
        ],
        "hotels": [_hotel_row(h, by_id.get(h.location_id), dest) for h in rows],
        "page": page,
        "page_size": page_size,
        "total": int(total),
    }


def list_location_hotels(
    db: Session,
    location_id: str,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict | None:
    """Hotels in one location, addressed by its namespaced id ('hyderabad__tank-bund').

    The last step of the destination flow (Destination -> location -> hotels).
    It is ``list_destination_hotels`` with the location fixed, not a second
    query: the destination half of the id selects the destination, the location
    half is resolved WITHIN it, and the same foreign-key filter picks the hotels.
    So a location slug shared by two destinations can never leak hotels across.

    Returns ``None`` — a 404 at the router — when either half names nothing, so
    "no such place" is never confused with "a real place with no hotels yet",
    which is an empty ``hotels`` list.
    """
    raw = str(location_id or "")
    if "__" not in raw:
        return None
    dest_part, loc_part = raw.split("__", 1)

    dest = _find_destination(db, dest_part)
    if dest is None:
        return None
    loc = db.scalar(
        select(CustomerLocation).where(
            CustomerLocation.destination_id == dest.customer_destination_id,
            CustomerLocation.slug == _slug(loc_part),
            CustomerLocation.is_active.is_(True),
        )
    )
    if loc is None:
        return None

    result = list_destination_hotels(
        db, dest.slug, location_id=loc.slug, page=page, page_size=page_size,
    )
    if result is None:
        return None
    result["location"] = _location_row(dest, loc, result["total"])
    return result


# ---------------------------------------------------------------------------
# Attractions — the famous places a destination page lists (migration 0075).
# ---------------------------------------------------------------------------
def _attraction_row(dest: CustomerDestination, a: CustomerAttraction,
                    area: CustomerLocation | None, hotel_count: int) -> dict:
    return {
        "id": f"{dest.slug}__{a.slug}",
        "destination_id": dest.slug,
        "name": a.name,
        "slug": a.slug,
        "description": a.description,
        "image": a.image_key,
        "area_id": f"{dest.slug}__{area.slug}" if area else None,
        "area_name": area.name if area else None,
        "hotel_count": int(hotel_count or 0),
    }


def _hotel_counts_by_area(db: Session, dest: CustomerDestination) -> dict[int, int]:
    """Active hotels per area of one destination, in ONE grouped query."""
    return dict(db.execute(
        select(CustomerHotel.location_id, func.count())
        .where(
            CustomerHotel.destination_id == dest.customer_destination_id,
            CustomerHotel.is_active.is_(True),
            CustomerHotel.location_id.is_not(None),
        )
        .group_by(CustomerHotel.location_id)
    ).all())


def list_attractions(db: Session, destination_id: str) -> list[dict] | None:
    """The famous places in one destination, or ``None`` if no such destination.

    Each carries the hotel count of its nearest listed area, because that area
    is what "View Hotels" will show — a count of anything else would promise a
    page the traveller does not then get.
    """
    dest = _find_destination(db, destination_id)
    if dest is None:
        return None
    rows = db.scalars(
        select(CustomerAttraction)
        .where(
            CustomerAttraction.destination_id == dest.customer_destination_id,
            CustomerAttraction.is_active.is_(True),
        )
        .order_by(CustomerAttraction.sort_order, CustomerAttraction.name)
        .options(selectinload(CustomerAttraction.area))
    ).all()
    counts = _hotel_counts_by_area(db, dest)
    out = []
    for a in rows:
        area = a.area if (a.area and a.area.is_active) else None
        n = counts.get(area.customer_location_id, 0) if area else 0
        out.append(_attraction_row(dest, a, area, n))
    return out


def _fare_details(db: Session, dest: CustomerDestination,
                  area: CustomerLocation | None) -> dict:
    """What it costs to go, from data we actually hold. Nulls where we do not.

    NOTHING HERE IS ESTIMATED, and two of the three are null on purpose:

      hotels    REAL. ``min(price_per_night)`` over the active hotels of the
                landmark's nearest listed area - the same hotels "View Hotels"
                then shows, so the price the traveller reads is the price on
                the page they land on. Falls back to the whole destination
                when the landmark has no listed area, and says which it is.

      flights   NULL, ALWAYS, for now. There is no fare table in this
                database: flights are searched live, and a "from" price would
                have to be invented or scraped from a search we have not run.
                The panel says "Currently unavailable" rather than a number
                nobody can honour.

      packages  NULL, ALWAYS, for now. ``customer_packages`` has no link to a
                destination - no column, no join table - so a package cannot
                be attributed to a place without matching its title as text,
                which is a guess wearing a price tag. A ``destination_id`` on
                that table is the one change that would make this real.

    The shape is stable either way, so the browser renders the same three rows
    and fills in the ones that have an answer.
    """
    scope = "area" if area else "destination"
    q = (
        select(func.min(CustomerHotel.price_per_night))
        .where(
            CustomerHotel.destination_id == dest.customer_destination_id,
            CustomerHotel.is_active.is_(True),
        )
    )
    if area:
        q = q.where(CustomerHotel.location_id == area.customer_location_id)
    hotel_from = db.scalar(q)

    return {
        "currency": "INR",
        "hotel_from": float(hotel_from) if hotel_from is not None else None,
        "hotel_scope": scope if hotel_from is not None else None,
        "hotel_scope_name": (area.name if area else dest.name) if hotel_from is not None else None,
        "flight_from": None,
        "package_from": None,
    }


def get_attraction(db: Session, destination_id: str, attraction_id: str) -> dict | None:
    """One famous place: the row, its fares, and the others in the same city.

    ``attraction_id`` takes either the bare slug ('charminar') or the
    namespaced id the list endpoint hands out ('hyderabad__charminar'), because
    both are things a caller legitimately has. A namespaced id naming a
    different destination is a miss, not a redirect - the two must agree.
    """
    dest = _find_destination(db, destination_id)
    if dest is None:
        return None

    slug = attraction_id
    if "__" in attraction_id:
        owner, _, slug = attraction_id.partition("__")
        if _slug(owner) != dest.slug:
            return None

    a = db.scalars(
        select(CustomerAttraction)
        .where(
            CustomerAttraction.destination_id == dest.customer_destination_id,
            CustomerAttraction.slug == _slug(slug),
            CustomerAttraction.is_active.is_(True),
        )
        .options(selectinload(CustomerAttraction.area))
    ).first()
    if a is None:
        return None

    area = a.area if (a.area and a.area.is_active) else None
    counts = _hotel_counts_by_area(db, dest)
    row = _attraction_row(dest, a, area,
                          counts.get(area.customer_location_id, 0) if area else 0)
    row["destination_name"] = dest.name
    row["country"] = dest.country
    row["fare_details"] = _fare_details(db, dest, area)

    # The others in the same city, for "Explore more locations". Four, because
    # the row on the detail page holds four without wrapping to a second line
    # on a laptop; the destination page is where all of them live.
    others = db.scalars(
        select(CustomerAttraction)
        .where(
            CustomerAttraction.destination_id == dest.customer_destination_id,
            CustomerAttraction.customer_attraction_id != a.customer_attraction_id,
            CustomerAttraction.is_active.is_(True),
        )
        .order_by(CustomerAttraction.sort_order, CustomerAttraction.name)
        .limit(4)
        .options(selectinload(CustomerAttraction.area))
    ).all()
    row["nearby"] = [
        _attraction_row(dest, o, o.area if (o.area and o.area.is_active) else None,
                        counts.get(o.area.customer_location_id, 0)
                        if (o.area and o.area.is_active) else 0)
        for o in others
    ]
    return row


def list_attraction_hotels(
    db: Session,
    attraction_id: str,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict | None:
    """Hotels near one attraction ('hyderabad__charminar'), or ``None`` if unknown.

    Near means IN ITS NEAREST LISTED AREA. Hotels are filed by area (0072) and
    never by landmark, so this is ``list_destination_hotels`` with that area as
    the filter — the same foreign-key query, not a second one. An attraction
    with no nearby area is a real place with no hotels to offer: an empty page,
    not a 404, and never a distant area's hotels passed off as nearby.
    """
    raw = str(attraction_id or "")
    if "__" not in raw:
        return None
    dest_part, slug_part = raw.split("__", 1)
    dest = _find_destination(db, dest_part)
    if dest is None:
        return None
    a = db.scalar(
        select(CustomerAttraction)
        .where(
            CustomerAttraction.destination_id == dest.customer_destination_id,
            CustomerAttraction.slug == _slug(slug_part),
            CustomerAttraction.is_active.is_(True),
        )
        .options(selectinload(CustomerAttraction.area))
    )
    if a is None:
        return None
    area = a.area if (a.area and a.area.is_active) else None

    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    if area is None:
        result = {
            "destination": _destination_row(dest), "locations": [], "hotels": [],
            "page": page, "page_size": page_size, "total": 0,
        }
    else:
        result = list_destination_hotels(
            db, dest.slug, location_id=area.slug, page=page, page_size=page_size,
        )
        if result is None:
            return None
    result["attraction"] = _attraction_row(dest, a, area, result["total"])
    return result
