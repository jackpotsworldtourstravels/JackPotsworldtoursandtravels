"""TBO / TekTravels (Travel Boutique Online) integration.

This package is to TBO what ``integrations/duffel`` is to Duffel: the ONLY place
in the project that holds the TBO API credentials and speaks the supplier's wire
format. TBO is the chosen SOLE supplier for both flights and hotels; this
(flight) package also owns the SHARED authentication, because one TokenId serves
both products.

Layout, smallest to largest:

  * ``exceptions`` — configuration vs transport vs refusal, as actionable types
                     (shared with the hotel adapter)
  * ``shared``     — Authenticate + the day-scoped TokenId cache + the HTTP core
                     (the ONLY place credentials are read)
  * ``schemas``    — the Air-service request bodies we send and the ones we parse
  * ``client``     — the TBO Air-service client (the 17 flight methods)
  * ``mapper``     — TBO results/itineraries <-> our internal flight shape

The hotel half lives in ``integrations/tbo_hotel`` and borrows ``shared`` here.
The switch between this adapter and the demo provider lives one level up in
``services/flight_supplier_service.py`` and defaults to ``demo``, so a fresh
checkout behaves exactly as it does today.
"""
