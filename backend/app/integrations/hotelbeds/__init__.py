"""Hotelbeds / HBX Group — the hotel CONTENT supplier.

Two APIs live behind one account and one signature scheme:

    Content API   static catalogue — properties, addresses, images, facilities,
                  room types. Synced into our own tables. Implemented here.
    Booking API   live availability, rates and reservations. NOT implemented
                  yet, by design: catalogue first, verified, then booking.

That separation is the whole architecture. A catalogue row says what a property
IS; it never says what a room costs tonight or whether one is free. Anything
that needs those must ask the Booking API at the time of asking.

Credentials live in the environment and are read only by ``client``. See
``app/config.py`` for why neither half may ever reach a browser.
"""
from app.integrations.hotelbeds.client import HotelbedsClient, content_client
from app.integrations.hotelbeds.content import HotelbedsContent, image_url
from app.integrations.hotelbeds.exceptions import (
    HotelbedsAPIError,
    HotelbedsError,
    HotelbedsNotConfigured,
    HotelbedsQuotaExceeded,
    HotelbedsTimeout,
    HotelbedsTransportError,
)

__all__ = [
    "HotelbedsClient",
    "HotelbedsContent",
    "content_client",
    "image_url",
    "HotelbedsError",
    "HotelbedsNotConfigured",
    "HotelbedsTimeout",
    "HotelbedsTransportError",
    "HotelbedsAPIError",
    "HotelbedsQuotaExceeded",
]
