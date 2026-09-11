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

from decimal import Decimal

from sqlalchemy import select
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
    """One package with its upcoming departures — the package's own detail view."""
    return db.execute(
        select(CustomerPackage)
        .options(selectinload(CustomerPackage.departures))
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
