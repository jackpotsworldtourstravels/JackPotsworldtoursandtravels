"""TBO / TekTravels hotel integration.

The hotel half of the TBO adapter. It borrows authentication from the flight
package (``integrations.tbo.shared`` — one TokenId serves both products) and is
otherwise self-contained:

  * ``exceptions`` — re-exports the shared TBO error types (+ a hotel price alias)
  * ``schemas``    — the hotel request bodies and response parsers, across the
                     lite (Search/PreBook), classic (Book/Voucher/cancel) and
                     static-content surfaces
  * ``client``     — the hotel client targeting all four TBO host bases
  * ``mapper``     — TBO hotel options/bookings <-> our internal hotel shape

The switch between this adapter and the existing DATABASE catalogue lives one
level up in ``services/hotel_supplier_service.py`` and defaults to
``catalogue``, so a fresh checkout serves the catalogue hotels it does today.
"""
