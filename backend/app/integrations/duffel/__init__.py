"""Duffel (flights) integration — TEST MODE by design.

This package is to Duffel what ``integrations/hotelbeds`` is to Hotelbeds: the
ONLY place in the project that holds the access token and speaks the supplier's
wire format. Nothing above it sees the token; nothing below it exists.

Layout, smallest to largest:

  * ``exceptions``  — configuration vs transport vs refusal, as actionable types
  * ``schemas``     — the request/response shapes we send and parse
  * ``client``      — the HTTP client (the token lives here, nowhere else)
  * ``mapper``      — Duffel offers/orders <-> our internal flight shape

The switch between this adapter and the existing demo pricing lives one level
up, in ``services/flight_supplier_service.py``, and defaults to ``demo`` so a
fresh checkout behaves exactly as it does today.
"""
