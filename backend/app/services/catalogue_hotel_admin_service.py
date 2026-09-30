"""Managing the hotel catalogue for the admin desk — Phase 5 of the B2C Admin
Portal build-out.

NO NEW TABLE, NO SECOND CATALOGUE. This edits ``customer_hotels`` and
``customer_hotel_rooms`` — the same rows the customer site's Hotel Results and
Hotel Details already read through ``customer_hotel_catalog_service``. That
service only ever shows ACTIVE rows, so the desk needs its own reads that also
see the disabled ones; nothing here changes how the customer side selects.

NO DELETE, ANYWHERE. A booking's room line points at ``customer_hotel_rooms``
with ``ON DELETE RESTRICT``, so a room that has ever been sold cannot be
removed, and pretending otherwise for the rooms that happen never to have been
sold would make "remove" mean two different things. Disabling is the one
withdrawal action: the customer site stops offering it, history is untouched.

SUPPLIER-SYNCED HOTELS ARE READ-ONLY WHERE THE SYNC WRITES. A row with
``source='hotelbeds'`` has its name, description, amenities, location and
active flag overwritten on every ``hotelbeds_sync_service`` run ("a sync
refreshes only what it owns"). An admin edit to those columns would look
saved and then vanish at the next sync, which is worse than refusing it, so
they are refused with the reason. Every hotel today is ``source='seed'``.

HOTEL-LEVEL PRICE FOLLOWS THE ROOMS. ``customer_hotels.price_per_night`` is the
"from" price on the results card and equals the cheapest room for every hotel
that has rooms. It is therefore not an editable field: changing a room's price
re-derives it (``_sync_from_price``), so the card can never quote a price no
room sells at.
"""
from __future__ import annotations

import re
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    CustomerDestination,
    CustomerHotel,
    CustomerHotelRoom,
    CustomerLocation,
)
from app.services import catalogue_images
from app.services.catalogue_common import blank_to_none, clean_list

#: Columns ``hotelbeds_sync_service._upsert`` writes on every run.
SYNC_OWNED = frozenset({
    "name", "description", "star_rating", "location", "address", "city",
    "amenities", "images", "destination_id", "location_id", "is_active",
})

_ROOM_CODE = re.compile(r"[^a-z0-9]+")


def _destination_names(db: Session, ids: set[int | None]) -> dict[int, str]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return dict(db.execute(
        select(CustomerDestination.customer_destination_id, CustomerDestination.name)
        .where(CustomerDestination.customer_destination_id.in_(ids))
    ).all())


def list_hotels(
    db: Session, *, page: int, page_size: int, search: str | None = None,
    is_active: bool | None = None, destination_id: int | None = None,
) -> tuple[list[dict], int]:
    stmt = select(CustomerHotel)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            CustomerHotel.name.ilike(like), CustomerHotel.location.ilike(like),
            CustomerHotel.city.ilike(like),
        ))
    if is_active is not None:
        stmt = stmt.where(CustomerHotel.is_active.is_(is_active))
    if destination_id is not None:
        stmt = stmt.where(CustomerHotel.destination_id == destination_id)

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(
        stmt.options(selectinload(CustomerHotel.rooms))
        .order_by(CustomerHotel.name, CustomerHotel.customer_hotel_id)
        .offset((page - 1) * page_size).limit(page_size)
    ))
    names = _destination_names(db, {h.destination_id for h in rows})
    return [{
        "id": h.customer_hotel_id, "name": h.name, "location": h.location, "city": h.city,
        "star_rating": h.star_rating, "price_per_night": h.price_per_night,
        "destination": names.get(h.destination_id), "rooms_total": len(h.rooms),
        "rooms_active": sum(1 for r in h.rooms if r.is_active),
        "is_active": h.is_active, "source": h.source,
    } for h in rows], total


def _get(db: Session, hotel_id: int) -> CustomerHotel | None:
    return db.execute(
        select(CustomerHotel).options(selectinload(CustomerHotel.rooms))
        .where(CustomerHotel.customer_hotel_id == hotel_id)
    ).scalar_one_or_none()


def _room_dict(r: CustomerHotelRoom) -> dict:
    return {
        "id": r.customer_hotel_room_id, "code": r.code, "name": r.name,
        "description": r.description, "bed_type": r.bed_type, "size_label": r.size_label,
        "max_guests": r.max_guests, "base_price_per_night": r.base_price_per_night,
        "meal_plan": r.meal_plan, "cancellation_policy": r.cancellation_policy,
        "perks": list(r.perks or []), "total_inventory": r.total_inventory,
        "is_active": r.is_active,
    }


def _detail(db: Session, h: CustomerHotel) -> dict:
    location_name = None
    if h.location_id is not None:
        location_name = db.scalar(
            select(CustomerLocation.name).where(CustomerLocation.customer_location_id == h.location_id)
        )
    return {
        "id": h.customer_hotel_id, "name": h.name, "description": h.description,
        "star_rating": h.star_rating, "guest_rating": h.guest_rating,
        "location": h.location, "address": h.address, "city": h.city,
        "price_per_night": h.price_per_night, "amenities": list(h.amenities or []),
        "image_key": h.image_key, "images": list(h.images or []),
        "cancellation_policy": h.cancellation_policy, "is_active": h.is_active,
        "source": h.source, "sync_owned": h.source != "seed",
        "destination_id": h.destination_id,
        "destination_name": _destination_names(db, {h.destination_id}).get(h.destination_id),
        "location_id": h.location_id, "location_name": location_name,
        "created_at": h.created_at,
        "rooms": [_room_dict(r) for r in sorted(h.rooms, key=lambda r: (r.base_price_per_night, r.customer_hotel_room_id))],
    }


def get_hotel(db: Session, hotel_id: int) -> dict | None:
    h = _get(db, hotel_id)
    return _detail(db, h) if h else None


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, message)


def update_hotel(db: Session, hotel_id: int, changes: dict) -> tuple[dict, list[str]] | None:
    """Apply a partial edit. Returns ``(detail, changed_fields)`` or None if no such hotel."""
    h = _get(db, hotel_id)
    if h is None:
        return None

    if h.source != "seed":
        blocked = sorted(SYNC_OWNED.intersection(changes))
        if blocked:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"This hotel is synced from its supplier, which rewrites {', '.join(blocked)} "
                "on every sync — an edit here would not last. Only the fields the sync does not "
                "touch can be changed.",
            )

    values: dict = {}
    for field in ("name", "location"):
        if field in changes:
            v = blank_to_none(changes[field])
            if v is None:
                raise _unprocessable(f"{field.title()} cannot be empty.")
            values[field] = v
    for field in ("description", "address", "city", "cancellation_policy"):
        if field in changes:
            values[field] = blank_to_none(changes[field])
    if "star_rating" in changes:
        if changes["star_rating"] is None:
            raise _unprocessable("Star rating cannot be cleared.")
        values["star_rating"] = changes["star_rating"]
    if "is_active" in changes:
        if changes["is_active"] is None:
            raise _unprocessable("is_active must be true or false.")
        values["is_active"] = changes["is_active"]
    if "amenities" in changes:
        values["amenities"] = clean_list(changes["amenities"], label="amenity", max_len=120)
    if "image_key" in changes:
        values["image_key"] = catalogue_images.validate_key("hotel", changes["image_key"])
    if "images" in changes:
        keys: list[str] = []
        for k in changes["images"] or []:
            k = catalogue_images.validate_key("hotel", k)
            if k and k not in keys:
                keys.append(k)
        values["images"] = keys

    # -- Geography: the location must sit inside the destination ------------
    if "destination_id" in changes or "location_id" in changes:
        dest_id = changes["destination_id"] if "destination_id" in changes else h.destination_id
        loc_id = changes["location_id"] if "location_id" in changes else h.location_id
        if dest_id is not None and db.get(CustomerDestination, dest_id) is None:
            raise _unprocessable("No such destination.")
        if loc_id is not None:
            loc = db.get(CustomerLocation, loc_id)
            if loc is None:
                raise _unprocessable("No such location.")
            if dest_id is None:
                dest_id = loc.destination_id
            elif loc.destination_id != dest_id:
                raise _unprocessable("That location is not inside the chosen destination.")
        # Moving to another destination without naming a location clears the
        # old one rather than leaving it pointing at the wrong place.
        if "destination_id" in changes and "location_id" not in changes and h.location_id is not None:
            old = db.get(CustomerLocation, h.location_id)
            if old is None or old.destination_id != dest_id:
                loc_id = None
        values["destination_id"] = dest_id
        values["location_id"] = loc_id

    for k, v in values.items():
        setattr(h, k, v)
    db.flush()
    return _detail(db, h), sorted(values)


# --------------------------------------------------------------------------- #
# Rooms
# --------------------------------------------------------------------------- #

def _sync_from_price(h: CustomerHotel) -> None:
    """Keep the card's "from" price equal to the cheapest ACTIVE room.

    Left alone when no room is active or the hotel is supplier-synced (whose
    price of 0 means "no price to show", never "free") — it must not be
    rewritten to a number the rooms no longer justify.
    """
    if h.source != "seed":
        return
    active = [Decimal(str(r.base_price_per_night)) for r in h.rooms if r.is_active]
    if active:
        h.price_per_night = min(active)


def create_room(db: Session, hotel_id: int, data: dict) -> tuple[dict, dict] | None:
    h = _get(db, hotel_id)
    if h is None:
        return None
    code = _ROOM_CODE.sub("-", data["code"].lower()).strip("-")[:20]
    if not code:
        raise _unprocessable("Room code must contain letters or numbers.")
    if any(r.code == code for r in h.rooms):
        raise HTTPException(status.HTTP_409_CONFLICT, f"This hotel already has a room with code {code!r}.")
    room = CustomerHotelRoom(
        hotel_id=h.customer_hotel_id, code=code, name=data["name"].strip(),
        description=blank_to_none(data.get("description")), bed_type=blank_to_none(data.get("bed_type")),
        size_label=blank_to_none(data.get("size_label")), max_guests=data["max_guests"],
        base_price_per_night=data["base_price_per_night"], meal_plan=data["meal_plan"].strip(),
        cancellation_policy=blank_to_none(data.get("cancellation_policy")),
        perks=clean_list(data.get("perks"), label="perk", max_len=60),
        total_inventory=data["total_inventory"], is_active=data["is_active"],
    )
    db.add(room)
    db.flush()
    db.refresh(h, attribute_names=["rooms"])
    _sync_from_price(h)
    db.flush()
    return _room_dict(room), _detail(db, h)


def update_room(db: Session, hotel_id: int, room_id: int, changes: dict) -> tuple[dict, dict, list[str]] | None:
    h = _get(db, hotel_id)
    if h is None:
        return None
    # Scoped to the hotel, as customer_hotel_catalog_service.get_room does: a
    # room id from another property must not be editable through this one.
    room = next((r for r in h.rooms if r.customer_hotel_room_id == room_id), None)
    if room is None:
        return None
    values: dict = {}
    for f in ("description", "bed_type", "size_label", "cancellation_policy"):
        if f in changes:
            values[f] = blank_to_none(changes[f])
    for f in ("name", "meal_plan"):
        if f in changes:
            v = blank_to_none(changes[f])
            if v is None:
                raise _unprocessable(f"{f.replace('_', ' ').title()} cannot be empty.")
            values[f] = v
    for f in ("max_guests", "base_price_per_night", "total_inventory", "is_active"):
        if f in changes:
            if changes[f] is None:
                raise _unprocessable(f"{f.replace('_', ' ')} cannot be cleared.")
            values[f] = changes[f]
    if "perks" in changes:
        values["perks"] = clean_list(changes["perks"], label="perk", max_len=60)
    for k, v in values.items():
        setattr(room, k, v)
    db.flush()
    _sync_from_price(h)
    db.flush()
    return _room_dict(room), _detail(db, h), sorted(values)
