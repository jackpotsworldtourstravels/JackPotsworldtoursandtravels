"""Managing destinations and their locations for the admin desk — Phase 5 of
the B2C Admin Portal build-out.

NO NEW TABLE. This edits ``customer_destinations`` and ``customer_locations``,
the rows behind the homepage shelf, the destination pages and the hotel
filters. ``customer_destination_service`` (what the customer site reads) shows
only active rows and is not touched.

"POPULAR" IS THE HOMEPAGE ORDER, NOT A FLAG. There is no ``is_popular`` column,
and adding one nothing reads would be a switch that does nothing. What the
customer site actually does is show the first ``HOMEPAGE_SHELF_SIZE`` active
destinations by ``sort_order`` (``home-destinations.js``: ``FIRST_SHOWN``)
and put the rest behind "show more". So a destination is popular exactly when
it sits inside that window, and making one popular means moving it up —
which is what ``reorder`` does.

DESCRIPTIONS LIVE ON LOCATIONS. ``customer_locations.description`` is the line
the destination page prints on each place's card; ``customer_destinations``
has no description column and the customer site renders none, so none is
offered.

SLUGS ARE FIXED ONCE CREATED. A destination's slug is the public identifier —
it is in URLs, in the ``/destinations/{slug}/locations`` route, and a
package's ``image_key`` was built from it — so renaming a destination changes
its display name only.

NO DELETE. Hotels reference a destination/location (``SET NULL``) and packages
reference one by name; withdrawing a destination is disabling it.
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models_customer import CustomerDestination, CustomerHotel, CustomerLocation
from app.services import catalogue_images
from app.services.catalogue_common import blank_to_none
from app.services.customer_destination_service import _slug

#: Mirrors ``FIRST_SHOWN`` in frontend/assets/js/home-destinations.js. If that
#: constant changes, this must change with it — the two together are what
#: "popular" means.
HOMEPAGE_SHELF_SIZE = 9

_STEP = 10


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, message)


def _all_ordered(db: Session) -> list[CustomerDestination]:
    return list(db.scalars(
        select(CustomerDestination)
        .options(selectinload(CustomerDestination.locations))
        .order_by(CustomerDestination.sort_order, CustomerDestination.name)
    ))


def _hotel_counts(db: Session, column) -> dict[int, int]:
    return dict(db.execute(
        select(column, func.count()).where(CustomerHotel.is_active.is_(True), column.is_not(None))
        .group_by(column)
    ).all())


def _summaries(db: Session) -> list[dict]:
    rows = _all_ordered(db)
    hotels = _hotel_counts(db, CustomerHotel.destination_id)
    out, rank = [], 0
    for d in rows:
        position = None
        if d.is_active:
            rank += 1
            position = rank
        out.append({
            "id": d.customer_destination_id, "name": d.name, "slug": d.slug,
            "country": d.country, "image_key": d.image_key, "is_active": d.is_active,
            "position": position,
            "popular": position is not None and position <= HOMEPAGE_SHELF_SIZE,
            "locations_total": len(d.locations),
            "hotels_active": hotels.get(d.customer_destination_id, 0),
        })
    return out


def list_destinations(db: Session) -> list[dict]:
    return _summaries(db)


def _location_dict(loc: CustomerLocation, hotels: dict[int, int]) -> dict:
    return {
        "id": loc.customer_location_id, "name": loc.name, "slug": loc.slug,
        "description": loc.description, "image_key": loc.image_key,
        "sort_order": loc.sort_order, "is_active": loc.is_active,
        "hotels_active": hotels.get(loc.customer_location_id, 0),
    }


def get_destination(db: Session, destination_id: int) -> dict | None:
    summary = next((s for s in _summaries(db) if s["id"] == destination_id), None)
    if summary is None:
        return None
    dest = db.execute(
        select(CustomerDestination).options(selectinload(CustomerDestination.locations))
        .where(CustomerDestination.customer_destination_id == destination_id)
    ).scalar_one()
    hotels = _hotel_counts(db, CustomerHotel.location_id)
    return {**summary, "locations": [_location_dict(l, hotels) for l in dest.locations]}


def create_destination(db: Session, data: dict) -> dict:
    name = data["name"].strip()
    slug = _slug(name)
    if not slug:
        raise _unprocessable("Name must contain letters or numbers.")
    if db.scalar(select(CustomerDestination.customer_destination_id).where(CustomerDestination.slug == slug)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"A destination with the address {slug!r} already exists.")
    # Appended after the last one; the desk then moves it where it belongs.
    last = db.scalar(select(func.max(CustomerDestination.sort_order))) or 0
    dest = CustomerDestination(
        name=name, slug=slug, country=blank_to_none(data.get("country")),
        image_key=catalogue_images.validate_key("destination", data.get("image_key")),
        sort_order=min(last + _STEP, 32000), is_active=data.get("is_active", True),
    )
    db.add(dest)
    db.flush()
    return get_destination(db, dest.customer_destination_id)


def update_destination(db: Session, destination_id: int, changes: dict) -> tuple[dict, list[str]] | None:
    dest = db.get(CustomerDestination, destination_id)
    if dest is None:
        return None
    values: dict = {}
    if "name" in changes:
        v = blank_to_none(changes["name"])
        if v is None:
            raise _unprocessable("Name cannot be empty.")
        values["name"] = v
    if "country" in changes:
        values["country"] = blank_to_none(changes["country"])
    if "image_key" in changes:
        values["image_key"] = catalogue_images.validate_key("destination", changes["image_key"])
    if "is_active" in changes:
        if changes["is_active"] is None:
            raise _unprocessable("is_active must be true or false.")
        values["is_active"] = changes["is_active"]
    for k, v in values.items():
        setattr(dest, k, v)
    db.flush()
    return get_destination(db, destination_id), sorted(values)


def reorder(db: Session, ids: list[int]) -> list[dict]:
    """Set the homepage order to exactly ``ids``.

    The list must be EVERY destination, once each. A partial or stale list
    (another admin added one since this page loaded) is refused instead of
    guessing where the missing ones go, because guessing would silently change
    which destinations are popular.
    """
    rows = {d.customer_destination_id: d for d in db.scalars(select(CustomerDestination))}
    if len(set(ids)) != len(ids) or set(ids) != set(rows):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "The order sent does not match the current destinations — reload and try again.",
        )
    for i, dest_id in enumerate(ids):
        rows[dest_id].sort_order = min((i + 1) * _STEP, 32000)
    db.flush()
    return _summaries(db)


# --------------------------------------------------------------------------- #
# Locations
# --------------------------------------------------------------------------- #

def create_location(db: Session, destination_id: int, data: dict) -> dict | None:
    dest = db.get(CustomerDestination, destination_id)
    if dest is None:
        return None
    name = data["name"].strip()
    slug = _slug(name)
    if not slug:
        raise _unprocessable("Name must contain letters or numbers.")
    # Slugs are unique within a destination, not globally (uq_customer_location_slug).
    if db.scalar(select(CustomerLocation.customer_location_id).where(
        CustomerLocation.destination_id == destination_id, CustomerLocation.slug == slug,
    )):
        raise HTTPException(status.HTTP_409_CONFLICT, f"{dest.name} already has a location called {name!r}.")
    order = data.get("sort_order")
    if order is None:
        last = db.scalar(select(func.max(CustomerLocation.sort_order)).where(
            CustomerLocation.destination_id == destination_id)) or 0
        order = min(last + _STEP, 32000)
    db.add(CustomerLocation(
        destination_id=destination_id, name=name, slug=slug,
        description=blank_to_none(data.get("description")),
        image_key=catalogue_images.validate_key("location", data.get("image_key")),
        sort_order=order, is_active=data.get("is_active", True),
    ))
    db.flush()
    return get_destination(db, destination_id)


def update_location(db: Session, destination_id: int, location_id: int, changes: dict) -> tuple[dict, list[str]] | None:
    loc = db.get(CustomerLocation, location_id)
    # Scoped to the destination in the URL, so a location id from another one is a 404.
    if loc is None or loc.destination_id != destination_id:
        return None
    values: dict = {}
    if "name" in changes:
        v = blank_to_none(changes["name"])
        if v is None:
            raise _unprocessable("Name cannot be empty.")
        values["name"] = v
    if "description" in changes:
        values["description"] = blank_to_none(changes["description"])
    if "image_key" in changes:
        values["image_key"] = catalogue_images.validate_key("location", changes["image_key"])
    for f in ("sort_order", "is_active"):
        if f in changes:
            if changes[f] is None:
                raise _unprocessable(f"{f.replace('_', ' ').title()} cannot be cleared.")
            values[f] = changes[f]
    for k, v in values.items():
        setattr(loc, k, v)
    db.flush()
    return get_destination(db, destination_id), sorted(values)
