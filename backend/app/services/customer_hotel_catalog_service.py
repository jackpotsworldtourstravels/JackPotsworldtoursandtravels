"""The hotel catalogue: properties, their rooms, and what can be added to a stay.

THIS IS A STAND-IN, AND SAYS SO — same seam ``customer_catalog_service.py``
already documents for flights. There is no channel manager and no real supplier
behind this portal yet. ``customer_hotels``/``customer_hotel_rooms`` (migration
0055) hold exactly the properties ``SAMPLE_HOTELS`` always showed, seeded once;
this module only reads them. When a real supplier lands, it replaces the
bodies of :func:`list_hotels` and :func:`get_hotel` and nothing else moves —
the router, the pricing service and the frontend are already reading through
this seam.

WHY ADD-ONS ARE HARD-CODED HERE RATHER THAN A TABLE. Four items
(breakfast/transfer/late checkout/insurance) that never change price is not
worth a table and a migration; ``_FLIGHT_ADDONS`` in
``customer_catalog_service.py`` made the same call for the same reason before
a real SSR feed existed. Kept in this file, not that one, so nothing about
hotels is read through a flight-named module.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models_customer import CustomerHotel, CustomerHotelRoom

#: All four are billed once per booking, not per guest — a room only gets one
#: breakfast spread and one late checkout, however many people are in it.
_HOTEL_ADDONS = {
    "meal": [
        {"code": "breakfast", "name": "Daily breakfast", "price": 750,
         "description": "A full breakfast spread for the length of your stay.", "per": "booking"},
    ],
    "service": [
        {"code": "airportpick", "name": "Airport pickup", "price": 1250,
         "description": "A private transfer from the airport to the property.", "per": "booking"},
        {"code": "latecheckout", "name": "Late checkout", "price": 900,
         "description": "Check out by 6 PM instead of the standard time.", "per": "booking"},
        {"code": "insurance", "name": "Travel insurance", "price": 899,
         "description": "Trip cancellation and medical cover.", "per": "booking"},
    ],
}


def list_hotels(db: Session) -> list[CustomerHotel]:
    """Every active property — what the Hotel Results grid renders.

    Filtering by destination/price band stays client-side, matching how
    flights work: the sample-sized catalogue is fetched once and narrowed in
    the browser, which is also why there is no ``destination`` parameter here.

    Rooms are eager-loaded because ``HotelSearchResult`` carries two fields
    derived from them (``meal_plans``, and the room set behind the results
    card's meal badge). Serialising N properties would otherwise issue N extra
    queries — the classic N+1 — for data every row needs.
    """
    return list(
        db.execute(
            select(CustomerHotel)
            .options(selectinload(CustomerHotel.rooms))
            .where(CustomerHotel.is_active.is_(True))
            .order_by(CustomerHotel.customer_hotel_id)
        ).scalars()
    )


def get_hotel(db: Session, hotel_id: int) -> CustomerHotel | None:
    """One property with its rooms — the Hotel Details step."""
    return db.execute(
        select(CustomerHotel)
        .options(selectinload(CustomerHotel.rooms))
        .where(CustomerHotel.customer_hotel_id == hotel_id, CustomerHotel.is_active.is_(True))
    ).scalar_one_or_none()


def get_room(db: Session, hotel_id: int, room_id: int) -> CustomerHotelRoom | None:
    """One room, scoped to the property it belongs to.

    Scoped rather than looked up by id alone: a room id from a different
    hotel must not be sellable against this one just because both are
    integers a client could type.
    """
    return db.execute(
        select(CustomerHotelRoom).where(
            CustomerHotelRoom.customer_hotel_room_id == room_id,
            CustomerHotelRoom.hotel_id == hotel_id,
            CustomerHotelRoom.is_active.is_(True),
        )
    ).scalar_one_or_none()


def addons() -> dict:
    return {
        "meal": [dict(a) for a in _HOTEL_ADDONS["meal"]],
        "service": [dict(a) for a in _HOTEL_ADDONS["service"]],
    }


def find_addon(code: str) -> dict | None:
    for group in ("meal", "service"):
        for item in _HOTEL_ADDONS[group]:
            if item["code"] == code:
                return {**item, "addon_type": group, "price": Decimal(str(item["price"]))}
    return None
