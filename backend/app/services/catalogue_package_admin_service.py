"""Managing the tour-package catalogue for the admin desk — Phase 5 of the B2C
Admin Portal build-out.

NO NEW TABLE. This edits ``customer_packages``, ``customer_package_itinerary``
and ``customer_package_departures`` — the rows the customer site's Tour
Packages pages already read through ``customer_package_catalog_service``. That
service shows only ACTIVE packages and live departures; the desk needs to see
the rest too, so it has its own reads. How the customer side selects and
prices is untouched.

TWO PRICES, AND THEY ARE DIFFERENT THINGS. ``price_from`` is the package's
shelf price; each departure carries its own ``price_per_person``, and that is
what a booking is priced from. The listing card shows the NEXT departure's
price and says "from X on other dates" when the shelf price differs, so both
are editable here and neither is derived from the other.

NO DELETE. A booking points at its package and departure with ``ON DELETE
RESTRICT``, so anything ever sold cannot be removed. Withdrawal is disabling,
which is also what "Enable/disable package" asks for.

GAMING IS NOT MANAGED HERE. ``customer_packages.category`` can be ``gaming``
(migration 0069), but Gaming Tour Packages are an enquiry queue, not
inventory. Every package created here is ``holiday`` and ``category`` is not an
editable field.

NOT EDITABLE, ON PURPOSE: the recorded rating, its count and its source. A
score is a claim about where it came from (0082), and the API refuses to serve
one without the other; typing one into a form would make the site quote a
number nobody measured.
"""
from __future__ import annotations

import datetime as dt

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    CustomerPackage,
    CustomerPackageDeparture,
    CustomerPackageItineraryDay,
)
from app.services import catalogue_images
from app.services.catalogue_common import blank_to_none, clean_list


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, message)


def _is_upcoming(d: CustomerPackageDeparture, today: dt.date) -> bool:
    return d.is_active and d.departure_date >= today


def list_packages(
    db: Session, *, page: int, page_size: int, search: str | None = None,
    is_active: bool | None = None, trip_type: str | None = None,
) -> tuple[list[dict], int]:
    stmt = select(CustomerPackage)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(CustomerPackage.name.ilike(like), CustomerPackage.destination.ilike(like)))
    if is_active is not None:
        stmt = stmt.where(CustomerPackage.is_active.is_(is_active))
    if trip_type:
        stmt = stmt.where(CustomerPackage.trip_type == trip_type)

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(
        stmt.options(selectinload(CustomerPackage.departures))
        .order_by(CustomerPackage.name, CustomerPackage.customer_package_id)
        .offset((page - 1) * page_size).limit(page_size)
    ))
    today = dt.date.today()
    items = []
    for p in rows:
        upcoming = sorted(d.departure_date for d in p.departures if _is_upcoming(d, today))
        items.append({
            "id": p.customer_package_id, "name": p.name, "destination": p.destination,
            "trip_type": p.trip_type, "category": p.category, "days": p.days,
            "price_from": p.price_from, "is_active": p.is_active,
            "departures_upcoming": len(upcoming),
            "next_departure": upcoming[0] if upcoming else None,
        })
    return items, total


def _get(db: Session, package_id: int) -> CustomerPackage | None:
    return db.execute(
        select(CustomerPackage)
        .options(selectinload(CustomerPackage.itinerary), selectinload(CustomerPackage.departures))
        .where(CustomerPackage.customer_package_id == package_id)
    ).scalar_one_or_none()


def _warnings(p: CustomerPackage) -> list[str]:
    today = dt.date.today()
    out = []
    if not any(_is_upcoming(d, today) for d in p.departures):
        out.append("No upcoming departure — customers can see this package but cannot book it.")
    if not p.itinerary:
        out.append("No itinerary — the package page will show no day-by-day plan.")
    if not p.image_key:
        out.append("No image — the package card will use the site's fallback artwork.")
    if not p.is_active:
        out.append("Disabled — not listed on the customer site.")
    return out


def _detail(p: CustomerPackage) -> dict:
    today = dt.date.today()
    return {
        "id": p.customer_package_id, "name": p.name, "blurb": p.blurb,
        "description": p.description, "destination": p.destination, "trip_type": p.trip_type,
        "category": p.category, "days": p.days, "nights": p.nights, "price_from": p.price_from,
        "is_international": p.is_international, "hotel_category": p.hotel_category,
        "highlights": list(p.highlights or []), "inclusions": list(p.inclusions or []),
        "exclusions": list(p.exclusions or []), "cancellation_policy": p.cancellation_policy,
        "image_key": p.image_key, "is_active": p.is_active, "created_at": p.created_at,
        "itinerary": [{
            "day_number": d.day_number, "title": d.title, "description": d.description,
            "location": d.location, "image_key": d.image_key, "meals": list(d.meals or []),
        } for d in sorted(p.itinerary, key=lambda d: d.day_number)],
        "departures": [{
            "id": d.customer_package_departure_id, "departure_date": d.departure_date,
            "price_per_person": d.price_per_person, "seats_left": d.seats_left,
            "is_active": d.is_active, "past": d.departure_date < today,
        } for d in sorted(p.departures, key=lambda d: d.departure_date)],
        "warnings": _warnings(p),
    }


def get_package(db: Session, package_id: int) -> dict | None:
    p = _get(db, package_id)
    return _detail(p) if p else None


def _apply_scalars(p: CustomerPackage, data: dict) -> dict:
    """Validate and apply the fields common to create and update. Returns what was set."""
    values: dict = {}
    for f in ("name", "blurb"):
        if f in data:
            v = blank_to_none(data[f])
            if v is None:
                raise _unprocessable(f"{f.title()} cannot be empty.")
            values[f] = v
    for f in ("description", "destination", "cancellation_policy"):
        if f in data:
            values[f] = blank_to_none(data[f])
    for f in ("days", "price_from", "trip_type", "is_active"):
        if f in data:
            if data[f] is None:
                raise _unprocessable(f"{f.replace('_', ' ').title()} cannot be cleared.")
            values[f] = data[f]
    for f in ("nights", "hotel_category"):
        if f in data:
            values[f] = data[f]
    if "highlights" in data:
        values["highlights"] = clean_list(data["highlights"], label="highlight", max_len=120)
    if "inclusions" in data:
        values["inclusions"] = clean_list(data["inclusions"], label="inclusion", max_len=120)
    if "exclusions" in data:
        values["exclusions"] = clean_list(data["exclusions"], label="exclusion", max_len=120)
    if "image_key" in data:
        values["image_key"] = catalogue_images.validate_key("package", data["image_key"])
    # 'international' is the only trip type that is an international trip; the
    # boolean is kept in step so the two columns can never contradict.
    if "trip_type" in values:
        values["is_international"] = values["trip_type"] == "international"
    if "days" in values and "nights" not in values and p.nights is None:
        values["nights"] = max(values["days"] - 1, 0)
    for k, v in values.items():
        setattr(p, k, v)
    return values


def create_package(db: Session, data: dict) -> dict:
    p = CustomerPackage(
        name="", blurb="", days=1, price_from=0, category="holiday",
        inclusions=[], highlights=[], exclusions=[], is_active=False,
    )
    data = dict(data)
    if data.get("nights") is None:
        data["nights"] = max(data["days"] - 1, 0)
    _apply_scalars(p, data)
    db.add(p)
    db.flush()
    db.refresh(p, attribute_names=["itinerary", "departures"])
    return _detail(p)


def update_package(db: Session, package_id: int, changes: dict) -> tuple[dict, list[str]] | None:
    p = _get(db, package_id)
    if p is None:
        return None
    if "days" in changes and changes["days"] is not None and p.itinerary:
        longest = max(d.day_number for d in p.itinerary)
        if changes["days"] < longest:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"The itinerary already has a day {longest}. Remove those days before shortening the package to {changes['days']}.",
            )
    values = _apply_scalars(p, changes)
    db.flush()
    return _detail(p), sorted(values)


# --------------------------------------------------------------------------- #
# Itinerary
# --------------------------------------------------------------------------- #

def replace_itinerary(db: Session, package_id: int, days: list[dict]) -> dict | None:
    """Make the itinerary exactly ``days``.

    Existing rows are updated in place by day number, new ones added, missing
    ones removed — not delete-and-reinsert, because ``(package_id, day_number)``
    is unique and SQLAlchemy flushes inserts before deletes, which would trip
    that constraint on any resave.
    """
    p = _get(db, package_id)
    if p is None:
        return None
    numbers = [d["day_number"] for d in days]
    if len(set(numbers)) != len(numbers):
        raise _unprocessable("Each day number may appear only once.")
    if numbers and max(numbers) > p.days:
        raise _unprocessable(f"This package is {p.days} days long; the itinerary has a day {max(numbers)}.")

    existing = {d.day_number: d for d in p.itinerary}
    for d in days:
        meals = list(dict.fromkeys(d.get("meals") or []))
        fields = dict(
            title=d["title"].strip(), description=blank_to_none(d.get("description")),
            location=blank_to_none(d.get("location")), meals=meals or None,
            image_key=catalogue_images.validate_key("package", d.get("image_key")),
        )
        row = existing.pop(d["day_number"], None)
        if row is None:
            p.itinerary.append(CustomerPackageItineraryDay(day_number=d["day_number"], **fields))
        else:
            for k, v in fields.items():
                setattr(row, k, v)
    for gone in existing.values():
        p.itinerary.remove(gone)
    db.flush()
    return _detail(p)


# --------------------------------------------------------------------------- #
# Departures (per-date pricing and seats)
# --------------------------------------------------------------------------- #

def create_departure(db: Session, package_id: int, data: dict) -> dict | None:
    p = _get(db, package_id)
    if p is None:
        return None
    if data["departure_date"] < dt.date.today():
        raise _unprocessable("A departure cannot be added in the past.")
    if any(d.departure_date == data["departure_date"] for d in p.departures):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This package already has a departure on that date — edit or re-enable it instead.",
        )
    p.departures.append(CustomerPackageDeparture(
        departure_date=data["departure_date"], price_per_person=data["price_per_person"],
        seats_left=data["seats_left"], is_active=data["is_active"],
    ))
    db.flush()
    return _detail(p)


def update_departure(db: Session, package_id: int, departure_id: int, changes: dict) -> tuple[dict, list[str]] | None:
    p = _get(db, package_id)
    if p is None:
        return None
    # Scoped to the package: a departure id from another package is not editable here.
    dep = next((d for d in p.departures if d.customer_package_departure_id == departure_id), None)
    if dep is None:
        return None
    values = {}
    for f in ("price_per_person", "seats_left", "is_active"):
        if f in changes:
            if changes[f] is None:
                raise _unprocessable(f"{f.replace('_', ' ').title()} cannot be cleared.")
            values[f] = changes[f]
    for k, v in values.items():
        setattr(dep, k, v)
    db.flush()
    return _detail(p), sorted(values)
