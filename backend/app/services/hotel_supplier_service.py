"""The one switch between the catalogue hotel product and a real supplier.

    Frontend -> our API -> THIS -> (catalogue DB | TBO adapter) -> rooms

This is the hotel analogue of ``flight_supplier_service`` — and it did not exist
before TBO, because hotels have never been supplier-driven. ``HOTEL_SUPPLIER``
decides, and defaults to ``catalogue``:

  * ``catalogue`` (the default) is the DATABASE catalogue the site runs on
    today — ``customer_hotel_*`` tables, served by ``customer_hotel_catalog_service``
    and priced by ``customer_hotel_pricing_service``. Selecting it here changes
    NOTHING: this module returns an explicit "served from the catalogue" envelope
    rather than duplicating that logic, exactly as the flight switch does for demo.

  * ``tbo`` activates the live hotel adapter under ``integrations/tbo_hotel``,
    and ONLY then are TBO credentials read.

WHAT THIS MODULE DOES NOT DO: it does not price a catalogue room or read the
catalogue tables. It only routes a request to the provider in force and, for
TBO, normalises the answer through the adapter's mapper.

STAGING NOTE. Re-platforming hotels from the catalogue to a live supplier is a
DESIGN DECISION the user must make — keep the catalogue as a fallback, or cut
over fully. Until that decision and live sandbox verification, this switch stays
on ``catalogue`` and the TBO path is adapter-complete but dormant. The catalogue
hotel product is NOT removed here.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping

from app.config import settings
from app.integrations.tbo_hotel import mapper as tbo_hotel_mapper
from app.integrations.tbo_hotel.client import TBOHotelClient

logger = logging.getLogger(__name__)

CATALOGUE = "catalogue"
TBO = "tbo"


def active_provider() -> str:
    """The provider in force, lower-cased. Anything unset/unknown is ``catalogue``."""
    value = (settings.hotel_supplier or CATALOGUE).strip().lower()
    return value if value in (CATALOGUE, TBO) else CATALOGUE


def tbo_available() -> bool:
    """True only when TBO is selected AND its credentials are present."""
    return active_provider() == TBO and TBOHotelClient.is_configured()


def search_hotels(params: Mapping[str, Any], *, client: TBOHotelClient | None = None) -> dict:
    """Search for hotels with the active provider.

    Returns an envelope ``{provider, currency, results}``. For ``catalogue`` the
    results come from the existing catalogue service, so here it returns an
    explicit empty envelope with a note rather than duplicating that path. For
    ``tbo`` it runs Authenticate (cached) -> Search and maps each option.

    TBO Search needs ``hotel_codes`` (comma-separated TBO codes, batched <=100),
    ``check_in``/``check_out`` (YYYY-MM-DD), ``guest_nationality`` (lead guest
    ISO code, never hardcoded) and ``pax_rooms`` (one ``{adults, children,
    children_ages}`` per room).
    """
    provider = active_provider()
    if provider == CATALOGUE:
        return {
            "provider": CATALOGUE,
            "currency": None,
            "results": [],
            "note": "catalogue hotels are served from the database catalogue service",
        }

    # --- TBO ---
    client = client or TBOHotelClient()  # raises TBONotConfigured if unset
    hotel_codes = params.get("hotel_codes") or params.get("hotelCodes")
    check_in = params.get("check_in") or params.get("checkIn")
    check_out = params.get("check_out") or params.get("checkOut")
    nationality = params.get("guest_nationality") or params.get("nationality")
    pax_rooms = params.get("pax_rooms") or params.get("rooms")
    if not (hotel_codes and check_in and check_out and nationality and pax_rooms):
        raise ValueError(
            "TBO hotel search requires 'hotel_codes', 'check_in', 'check_out', "
            "'guest_nationality' and 'pax_rooms'"
        )

    options = client.search(
        check_in=check_in,
        check_out=check_out,
        hotel_codes=hotel_codes,
        guest_nationality=nationality,
        pax_rooms=pax_rooms,
        refundable_only=bool(params.get("refundable_only")),
        meal_type=params.get("meal_type") or "All",
    )
    results = tbo_hotel_mapper.options_to_hotels(options)
    return {
        "provider": TBO,
        "currency": results[0]["currency"] if results else None,
        "results": results,
    }


def prebook(booking_code: str, *, client: TBOHotelClient | None = None):
    """Re-price a chosen room before Book (the authoritative NetAmount).

    Only valid under ``HOTEL_SUPPLIER=tbo``; the catalogue path has no PreBook.
    """
    if active_provider() != TBO:
        raise ValueError("PreBook is only available when HOTEL_SUPPLIER=tbo")
    return (client or TBOHotelClient()).prebook(booking_code)
