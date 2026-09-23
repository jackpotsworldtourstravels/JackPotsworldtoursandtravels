"""The tour-package catalogue: trips, their departures, and what can be added.

Same stand-in seam as ``customer_hotel_catalog_service.py`` — no real DMC/tour
operator feed exists yet. ``customer_packages``/``customer_package_departures``
(migration 0056) hold exactly the seven trips ``SAMPLE_PACKAGES`` always
showed, seeded once; this module only reads them. When a real supplier lands,
it replaces the bodies of :func:`list_packages`/:func:`get_package` and
nothing else moves.

ADD-ONS ARE HARD-CODED HERE, LIKE A HOTEL'S ARE. Four items that never change
price is not worth a table — see ``customer_hotel_catalog_service.py``'s
docstring for the same call made the same way. Travel insurance is priced
per traveller (``per: "passenger"``); the other three are once per booking,
matching what ``booking-data.js``'s ``ADDONS.package`` has always sold.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import Date, cast, func, select
from sqlalchemy.orm import Session, selectinload

from app.models_customer import CustomerPackage, CustomerPackageDeparture

_PACKAGE_ADDONS = {
    "service": [
        {"code": "upgrade", "name": "Hotel upgrade", "price": 7500,
         "description": "Move up to the next room category at every stop.", "per": "booking"},
        {"code": "guide", "name": "Private guide", "price": 5200,
         "description": "A dedicated English-speaking guide for the whole trip.", "per": "booking"},
        {"code": "transfer", "name": "Airport transfer", "price": 1250,
         "description": "Private cab to or from the airport.", "per": "booking"},
        {"code": "insurance", "name": "Travel insurance", "price": 1499,
         "description": "Trip cancellation and medical cover.", "per": "passenger"},
    ],
}


#: The shelves a package can sit on, mirroring migration 0069's CHECK. Kept
#: here rather than imported from the migration because a migration is a
#: historical record and this is today's vocabulary.
CATEGORIES = ("holiday", "gaming")

#: The three shelves the Tour Packages journey offers (0083's CHECK). A
#: DIFFERENT AXIS from CATEGORIES above: that one says holiday or gaming,
#: this one says where in the world and what kind of trip.
TRIP_TYPES = ("domestic", "pilgrimage", "international")


def _departure_months(pkg: CustomerPackage) -> list[str]:
    """'2026-11' for every month this package actually departs in, ascending.

    FROM THE DEPARTURES TABLE, never from a calendar. A month is offered in
    the filter because a departure exists in it - which is the only reason a
    traveller could pick it and get a result.
    """
    seen = {d.departure_date.strftime("%Y-%m") for d in pkg.departures
            if d.is_active and d.departure_date >= dt.date.today()}
    return sorted(seen)


def search_packages(
    db: Session,
    *,
    category: str | None = None,
    trip_type: str | None = None,
    destination: str | None = None,
    min_days: int | None = None,
    max_days: int | None = None,
    min_price: Decimal | float | None = None,
    max_price: Decimal | float | None = None,
    month: str | None = None,
    min_rating: float | None = None,
    hotel_category: int | None = None,
) -> list[CustomerPackage]:
    """The listing page's query. Every filter is optional and AND-ed.

    APPLIED BY THE DATABASE, not by the browser. The grid used to load all
    seven packages and filter them in JavaScript, which is fine for seven and
    wrong the moment there are two hundred - and it cannot express "departs in
    March" at all, because the browser never had the departures.

    A FILTER THAT NAMES SOMETHING WE DO NOT HAVE RETURNS NOTHING. `month` is
    matched against real departure dates, `min_rating` only ever matches rows
    that carry a recorded rating, and `hotel_category` only rows that state
    one - none of them quietly widen to "everything" when they find no match,
    because a page that says "12 packages in March" and lists trips that
    depart in June is worse than an empty one.
    """
    stmt = select(CustomerPackage).where(CustomerPackage.is_active.is_(True))

    if category is not None:
        stmt = stmt.where(CustomerPackage.category == category)
    if trip_type is not None:
        stmt = stmt.where(CustomerPackage.trip_type == trip_type)
    if destination:
        # Case-insensitive exact match on the column, not a LIKE on the name:
        # the filter offers the destinations we have, so the value came from
        # that list and should match one row-set exactly.
        stmt = stmt.where(func.lower(CustomerPackage.destination) == destination.strip().lower())
    if min_days is not None:
        stmt = stmt.where(CustomerPackage.days >= min_days)
    if max_days is not None:
        stmt = stmt.where(CustomerPackage.days <= max_days)
    if min_price is not None:
        stmt = stmt.where(CustomerPackage.price_from >= Decimal(str(min_price)))
    if max_price is not None:
        stmt = stmt.where(CustomerPackage.price_from <= Decimal(str(max_price)))
    if min_rating is not None:
        stmt = stmt.where(
            CustomerPackage.rating.is_not(None),
            CustomerPackage.rating >= Decimal(str(min_rating)),
        )
    if hotel_category is not None:
        stmt = stmt.where(CustomerPackage.hotel_category == hotel_category)

    if month:
        # A trip is "in March" when it has a live departure that month, in the
        # future. EXISTS rather than a join, so a package with four March
        # departures is still one row.
        start = dt.date.fromisoformat(month + "-01")
        end = (start.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        stmt = stmt.where(
            select(CustomerPackageDeparture.customer_package_departure_id)
            .where(
                CustomerPackageDeparture.package_id == CustomerPackage.customer_package_id,
                CustomerPackageDeparture.is_active.is_(True),
                CustomerPackageDeparture.departure_date >= func.greatest(start, cast(func.now(), Date)),
                CustomerPackageDeparture.departure_date < end,
            )
            .exists()
        )

    return list(
        db.execute(
            stmt.options(selectinload(CustomerPackage.departures))
                .order_by(CustomerPackage.price_from, CustomerPackage.customer_package_id)
        ).scalars()
    )


def facets(db: Session, *, category: str | None = None) -> dict:
    """What the filter rail may offer, WITH COUNTS, from the rows that exist.

    Every list here is derived from the catalogue: a destination appears
    because a package goes there, a month because something departs in it, a
    hotel standard because a trip states one. Nothing is a hard-coded menu, so
    a filter can never offer a choice that returns an empty page - and a
    filter with nothing to offer (hotel standards, today) comes back empty and
    the rail simply does not draw it.
    """
    rows = search_packages(db, category=category)

    def counted(values: list) -> list[dict]:
        out: dict = {}
        for v in values:
            if v is None:
                continue
            out[v] = out.get(v, 0) + 1
        return [{"value": k, "count": n} for k, n in sorted(out.items(), key=lambda kv: str(kv[0]))]

    months: dict[str, int] = {}
    for pkg in rows:
        for m in _departure_months(pkg):
            months[m] = months.get(m, 0) + 1

    prices = [float(p.price_from) for p in rows]
    durations = [p.days for p in rows]

    return {
        "trip_types": counted([p.trip_type for p in rows]),
        "destinations": counted([p.destination for p in rows]),
        "hotel_categories": counted([p.hotel_category for p in rows]),
        "months": [{"value": m, "count": n} for m, n in sorted(months.items())],
        "durations": counted(durations),
        "price_min": min(prices) if prices else None,
        "price_max": max(prices) if prices else None,
        "duration_min": min(durations) if durations else None,
        "duration_max": max(durations) if durations else None,
        # How many packages carry a rating at all. Zero today, which is why
        # the rail draws no rating filter rather than one that empties the page.
        "rated_count": sum(1 for p in rows if p.rating is not None and p.rating_source),
        "total": len(rows),
    }


def trip_type_counts(db: Session, *, category: str | None = None) -> list[dict]:
    """The three category tiles, each with the number of trips behind it.

    A SHELF WITH NOTHING ON IT STILL APPEARS, with a count of zero, and the
    page says so. Pilgrimage is empty today - hiding the tile would suggest we
    do not run pilgrimages, and a tile that opens an empty list without
    warning wastes a tap; a "0 packages" tile does neither.
    """
    rows = search_packages(db, category=category)
    counts = {t: 0 for t in TRIP_TYPES}
    for pkg in rows:
        if pkg.trip_type in counts:
            counts[pkg.trip_type] += 1
    return [{"trip_type": t, "count": counts[t]} for t in TRIP_TYPES]


def list_packages(db: Session, category: str | None = None) -> list[CustomerPackage]:
    """Every active package, optionally narrowed to one shelf.

    ``category=None`` means EVERY shelf, and that is what the existing callers
    pass — the Tour Packages grid asks for ``holiday`` explicitly, so nothing
    depends on the unfiltered form meaning "holidays". An unknown category is
    the caller's problem to reject (the router does); this returns nothing for
    it rather than silently falling back to everything, because a page that
    asks for a shelf that does not exist should look empty, not full.
    """
    stmt = select(CustomerPackage).where(CustomerPackage.is_active.is_(True))
    if category is not None:
        stmt = stmt.where(CustomerPackage.category == category)
    return list(
        db.execute(stmt.order_by(CustomerPackage.customer_package_id)).scalars()
    )


def get_package(db: Session, package_id: int) -> CustomerPackage | None:
    """One package with its departures, its day-by-day and its hotels.

    The three relationships are eager-loaded because the detail page shows all
    of them and a lazy load per section is three round trips for one screen.
    Both new lists are usually EMPTY (0083 seeded none): the page draws the
    sections it has rows for.
    """
    return db.execute(
        select(CustomerPackage)
        .options(
            selectinload(CustomerPackage.departures),
            selectinload(CustomerPackage.itinerary),
            selectinload(CustomerPackage.hotels),
        )
        .where(CustomerPackage.customer_package_id == package_id, CustomerPackage.is_active.is_(True))
    ).scalar_one_or_none()


def get_departure(db: Session, package_id: int, departure_id: int) -> CustomerPackageDeparture | None:
    """One departure, scoped to the package it belongs to — a departure id
    from a different package must not be sellable against this one."""
    return db.execute(
        select(CustomerPackageDeparture).where(
            CustomerPackageDeparture.customer_package_departure_id == departure_id,
            CustomerPackageDeparture.package_id == package_id,
            CustomerPackageDeparture.is_active.is_(True),
        )
    ).scalar_one_or_none()


def addons() -> dict:
    return {"service": [dict(a) for a in _PACKAGE_ADDONS["service"]]}


def find_addon(code: str) -> dict | None:
    for item in _PACKAGE_ADDONS["service"]:
        if item["code"] == code:
            return {**item, "addon_type": "service", "price": Decimal(str(item["price"]))}
    return None
