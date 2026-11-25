"""What the admin desk sees about flights — Phase 5 of the B2C Admin Portal
build-out.

THERE IS NO FLIGHT INVENTORY TO MANAGE, AND THIS DOES NOT INVENT ANY. Flights
on the B2C site are SUPPLIER-DRIVEN: a search is routed to whichever supplier
``flight_supplier_service`` has in force and the results are live, never
stored. A CRUD screen over "flights" would need a table of fake ones (and a
second source of truth beside the supplier), so the Flights screen is the
opposite of the other three: read-only, and about the wiring, not the stock.

READS, NEVER CALLS. Status is derived from configuration and from which
adapter code exists — it does not contact a supplier, so opening the screen
costs no API quota and cannot fail because a supplier is down.

TBO (TekTravels) IS THE CHOSEN SOLE SUPPLIER. Its adapter now exists under
``integrations/tbo`` and is wired for SEARCH in ``flight_supplier_service``, so
it is listed as ``integrated: True`` with ``configured`` reflecting whether its
credentials are set. The booking-path wiring (FareQuote revalidation, then
Book/Ticket) and the retirement of the demo/Duffel paths are staged for after
live sandbox verification, which the ``note`` states to the desk. Duffel (test
mode) keeps its adapter under ``integrations/duffel``.
"""
from __future__ import annotations

from app.integrations.duffel.client import DuffelClient
from app.integrations.tbo.client import TBOFlightClient
from app.services import flight_supplier_service as supplier


def supplier_status() -> dict:
    active = supplier.active_provider()
    return {
        "active_provider": active,
        "live": active != supplier.DEMO,
        "inventory_stored": False,
        "summary": (
            "Flights are not stocked. Every search is answered live by the supplier "
            "in force; nothing about a flight is stored or edited here."
            if active != supplier.DEMO else
            "No live supplier is connected, so the customer site shows sample flights "
            "from its own demo data. Nothing about a flight is stored or edited here."
        ),
        "flow": [
            "Customer searches on the flights page",
            "Our API routes the search to the supplier in force",
            "Supplier returns live results and fares",
            "The offer is re-checked with the supplier just before booking",
            "Booking is created against that live offer",
        ],
        "suppliers": [
            {
                "code": supplier.DEMO, "label": "Demo (sample data)", "integrated": True,
                "active": active == supplier.DEMO, "configured": True,
                "note": "Served client-side from sample data. The default, and what the site uses today.",
            },
            {
                "code": supplier.DUFFEL, "label": "Duffel (test mode)", "integrated": True,
                "active": active == supplier.DUFFEL, "configured": DuffelClient.is_configured(),
                "note": "Adapter built and dormant. Live only when FLIGHT_SUPPLIER=duffel and a test token is set.",
            },
            {
                "code": supplier.TBO, "label": "TBO / TekTravels", "integrated": True,
                "active": active == supplier.TBO, "configured": TBOFlightClient.is_configured(),
                "note": (
                    "The chosen sole supplier. Adapter built under integrations/tbo and "
                    "wired for search; live only when FLIGHT_SUPPLIER=tbo and credentials "
                    "are set. Booking-path wiring and demo retirement are staged for after "
                    "sandbox verification."
                ),
            },
        ],
    }
