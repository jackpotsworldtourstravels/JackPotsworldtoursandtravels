"""The one switch between the demo flight provider and a real supplier.

    Frontend -> our API -> THIS -> (demo | Duffel adapter | TBO adapter) -> supplier

``FLIGHT_SUPPLIER`` decides, and defaults to ``demo``. A fresh checkout, and
the checkout the site runs on today, therefore behaves EXACTLY as before: the
demo path is untouched, the Duffel and TBO paths are dormant, and nothing here
reads a supplier credential unless ``FLIGHT_SUPPLIER`` names that supplier on
purpose.

TBO (TekTravels) is the CHOSEN sole supplier. Its adapter lives under
``integrations/tbo``; it is wired for SEARCH here. The booking path
(revalidate = FareQuote, then Book/Ticket) is adapter-complete but its wiring
into ``supplier_guard`` — and the retirement of the demo path — is staged for
after live sandbox verification, so that until then selecting ``tbo`` fails
CLOSED at checkout rather than serving an unverified booking flow.

WHAT THIS MODULE DOES NOT DO: it does not price a demo flight, generate a seat
map's seeded occupancy, or quote a booking. Those live in
``customer_pricing_service`` and ``customer_catalog_service`` and are called,
not reimplemented — "do not duplicate flight business logic". This module only
routes a request to the provider in force and, for Duffel, normalises the
answer through the adapter's mapper.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping

from app.config import settings
from app.integrations.duffel import mapper, schemas
from app.integrations.duffel.client import DuffelClient
from app.integrations.duffel.exceptions import (
    DuffelNotConfigured,
    DuffelOfferExpired,
    DuffelPriceChanged,
)
from app.integrations.tbo import mapper as tbo_mapper
from app.integrations.tbo.client import TBOFlightClient
from app.integrations.tbo.exceptions import TBOPriceChanged

logger = logging.getLogger(__name__)

DEMO = "demo"
DUFFEL = "duffel"
TBO = "tbo"


def active_provider() -> str:
    """The provider in force, lower-cased. Anything unset/unknown is ``demo``."""
    value = (settings.flight_supplier or DEMO).strip().lower()
    return value if value in (DEMO, DUFFEL, TBO) else DEMO


def duffel_available() -> bool:
    """True only when Duffel is both selected AND holds a test token."""
    return active_provider() == DUFFEL and DuffelClient.is_configured()


def tbo_available() -> bool:
    """True only when TBO is selected AND its credentials are present."""
    return active_provider() == TBO and TBOFlightClient.is_configured()


# --------------------------------------------------------------------------- #
# Search
# --------------------------------------------------------------------------- #

def _passengers_from_params(params: Mapping[str, Any]) -> list[dict]:
    """``{adults, children, infants}`` -> Duffel passenger list.

    Defaults to a single adult when nothing is specified — the same default the
    search UI uses. Never fabricates ages; a child/infant is sent by type.
    """
    adults = int(params.get("adults") or 1)
    children = int(params.get("children") or 0)
    infants = int(params.get("infants") or 0)
    out: list[dict] = [{"type": "adult"} for _ in range(max(adults, 1))]
    out += [{"type": "child"} for _ in range(children)]
    out += [{"type": "infant_without_seat"} for _ in range(infants)]
    return out


def search_flights(params: Mapping[str, Any], *, client: DuffelClient | None = None) -> dict:
    """Search for flights with the active provider.

    Returns an envelope ``{provider, currency, results}``. ``results`` is a list
    of internal flight objects (the shape the app already renders). ``currency``
    is the supplier's own currency for the first result, surfaced so callers can
    see it WITHOUT assuming INR — the whole point of the currency check.

    Demo mode is served client-side today (the frontend reads its sample set and
    never calls this route), so here it returns an explicit empty envelope with
    a note rather than duplicating the sample data on the server.
    """
    provider = active_provider()
    if provider == DEMO:
        return {
            "provider": DEMO,
            "currency": None,
            "results": [],
            "note": "demo flights are served client-side from sample data",
        }

    if provider == TBO:
        return _search_tbo(params)

    # --- Duffel ---
    client = client or DuffelClient()  # raises DuffelNotConfigured if no test token
    origin = params.get("from") or params.get("origin")
    destination = params.get("to") or params.get("destination")
    date = params.get("date") or params.get("departure_date")
    if not (origin and destination and date):
        raise ValueError("search requires 'from', 'to' and 'date'")

    body = schemas.offer_request_body(
        slices=[{"origin": origin, "destination": destination, "departure_date": date}],
        passengers=_passengers_from_params(params),
        cabin_class=params.get("cabin") or params.get("cabin_class"),
    )
    payload = client.create_offer_request(
        body, supplier_timeout_ms=_supplier_timeout_ms(),
    )
    offers = schemas.parse_offers(payload)
    results = mapper.offers_to_flights(offers)
    return {
        "provider": DUFFEL,
        "currency": results[0]["currency"] if results else None,
        "results": results,
    }


def _search_tbo(params: Mapping[str, Any], *, client: TBOFlightClient | None = None) -> dict:
    """Search with TBO: Authenticate (cached) -> Search -> map to our shape.

    Returns the same ``{provider, currency, results}`` envelope as the Duffel
    path, plus ``trace_id`` — a TBO search session identifier the booking path
    needs alongside each result's offer handle, and which expires in ~15 min.
    """
    client = client or TBOFlightClient()  # raises TBONotConfigured if unset
    origin = params.get("from") or params.get("origin")
    destination = params.get("to") or params.get("destination")
    date = params.get("date") or params.get("departure_date")
    if not (origin and destination and date):
        raise ValueError("search requires 'from', 'to' and 'date'")

    resp = client.search(
        segments=[{
            "origin": origin, "destination": destination, "departure_date": date,
            "cabin": params.get("cabin") or params.get("cabin_class"),
        }],
        adults=int(params.get("adults") or 1),
        children=int(params.get("children") or 0),
        infants=int(params.get("infants") or 0),
    )
    results = tbo_mapper.results_to_flights(resp.results, resp.trace_id)
    return {
        "provider": TBO,
        "currency": results[0]["currency"] if results else None,
        "results": results,
        "trace_id": resp.trace_id,
    }


def _supplier_timeout_ms() -> int | None:
    value = settings.duffel_supplier_timeout_ms
    return int(value) if value else None


# --------------------------------------------------------------------------- #
# Offer revalidation — never book on stale search data
# --------------------------------------------------------------------------- #

def revalidate_offer(
    offer_id: str,
    *,
    shown_amount: str | None = None,
    client: DuffelClient | None = None,
) -> schemas.DuffelOffer:
    """Re-fetch an offer immediately before booking and vet it.

    Raises :class:`DuffelOfferExpired` if the offer is gone or has expired, and
    :class:`DuffelPriceChanged` if its total no longer matches what the customer
    was shown. Returns the fresh offer otherwise. This is the guard that makes
    "never book using stale search data" true.

    Under ``FLIGHT_SUPPLIER=tbo`` the equivalent re-price is a FareQuote on the
    offer handle; see :func:`revalidate_offer_tbo`.
    """
    if active_provider() == TBO:
        return revalidate_offer_tbo(offer_id, shown_amount=shown_amount)
    client = client or DuffelClient()
    fresh = schemas.parse_single_offer(client.get_offer(offer_id))

    if fresh.expires_at and _is_past(fresh.expires_at):
        raise DuffelOfferExpired(410, f"offer {offer_id} expired at {fresh.expires_at}",
                                 code="offer_expired")

    if shown_amount is not None and fresh.total_amount is not None:
        if _norm_amount(shown_amount) != _norm_amount(fresh.total_amount):
            raise DuffelPriceChanged(
                offer_id, shown_amount, fresh.total_amount, fresh.total_currency or "",
            )
    return fresh


def revalidate_offer_tbo(
    offer_id: str,
    *,
    shown_amount: str | None = None,
    client: TBOFlightClient | None = None,
) -> "object":
    """Re-price a TBO offer immediately before booking, via FareQuote.

    The ``offer_id`` is the ``"<TraceId>|<ResultIndex>"`` handle the mapper
    produced. FareQuote re-prices against live inventory; if the OfferedFare no
    longer matches what the customer was shown, raise :class:`TBOPriceChanged`
    so the booking path never charges a price the customer did not see. Returns
    the fresh :class:`TBOFareQuote` otherwise.
    """
    trace_id, result_index = tbo_mapper.parse_offer_handle(offer_id)
    client = client or TBOFlightClient()
    quote = client.fare_quote(trace_id, result_index)
    if shown_amount is not None and quote.fare.offered_fare is not None:
        if _norm_amount(shown_amount) != _norm_amount(quote.fare.offered_fare):
            raise TBOPriceChanged(
                offer_id, str(shown_amount), str(quote.fare.offered_fare),
                quote.fare.currency or "",
            )
    return quote


def _is_past(iso: str) -> bool:
    import datetime as dt
    try:
        when = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return False
    now = dt.datetime.now(dt.timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.timezone.utc)
    return when <= now


def _norm_amount(value: str) -> str:
    from decimal import Decimal, InvalidOperation
    try:
        return str(Decimal(str(value)).normalize())
    except (InvalidOperation, ValueError):
        return str(value)


# --------------------------------------------------------------------------- #
# Seat map
# --------------------------------------------------------------------------- #

def seat_map(offer_id: str, *, client: DuffelClient | None = None) -> dict:
    """Duffel seat map for an offer, in our existing contract shape."""
    client = client or DuffelClient()
    return mapper.seat_maps_to_contract(client.get_seat_maps(offer_id))
