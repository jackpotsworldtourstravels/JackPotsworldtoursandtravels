"""The HTTP client for the TBO (TekTravels) flight Air service.

The 17 Air-service methods run on one base
(``api.tektravels.com/BookingEngineService_Air/AirService.svc/rest``); the three
shared methods (Authenticate, Logout, GetAgencyBalance) run on the SharedData
service and are owned by :mod:`app.integrations.tbo.shared`. This client borrows
a :class:`TBOSession` for the TokenId, the whitelisted ``EndUserIp`` and the
HTTP core — it holds NO credential of its own.

-----------------------------------------------------------------------------
WHY THE RETRY RULES ARE ASYMMETRIC (carried from the spec)
-----------------------------------------------------------------------------
Reads — Search, FareRule, FareQuote, SSR, GetBookingDetails, the lookups — are
retried on transport failures and 5xx, because they are idempotent.

Writes — ``Book`` and ``Ticket`` — are NEVER retried. A timeout on either
leaves the outcome UNKNOWN: a second call can create a second PNR or issue a
second ticket. The spec is explicit: "Do not retry Ticket after a timeout. Call
GetBookingDetails to check whether the ticket was issued." So a write timeout is
surfaced as :class:`TBOTimeout` and reconciliation is the caller's job.

-----------------------------------------------------------------------------
SESSION EXPIRY IS HANDLED ONCE
-----------------------------------------------------------------------------
On a ``ResponseStatus`` 4 (InValidSession) a READ re-authenticates once and
retries. A WRITE does NOT auto-retry on expiry either — it raises so the caller
reconciles — because "retry the write" is exactly what must not happen blindly.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping, Sequence

from app.config import settings
from app.integrations.tbo import schemas
from app.integrations.tbo.exceptions import TBOSessionExpired
from app.integrations.tbo.shared import TBOSession, default_session

logger = logging.getLogger(__name__)


class TBOFlightClient:
    """A typed wrapper over the TBO Air-service endpoints we use."""

    def __init__(self, *, session: TBOSession | None = None, air_base_url: str | None = None) -> None:
        self._session = session or default_session()
        self._air_base = (air_base_url or settings.tbo_air_base_url).rstrip("/")

    @staticmethod
    def is_configured() -> bool:
        """True when the shared TBO credentials are present (no network)."""
        return TBOSession.is_configured()

    # -- auth injection + request helpers ---------------------------------- #

    def _auth(self, body: Mapping[str, Any], *, force_token: bool = False) -> dict:
        out = dict(body)
        out["EndUserIp"] = self._session.end_user_ip
        out["TokenId"] = self._session.token_id(force=force_token)
        return out

    def _read(self, path: str, body: Mapping[str, Any], *, wrapped: bool = True) -> dict:
        """A retriable read that re-authenticates once on an expired session."""
        try:
            payload = self._session.post_read(self._air_base, path, self._auth(body))
            return self._session.check_response(payload, wrapped=wrapped)
        except TBOSessionExpired:
            logger.info("TBO session expired on %s — re-authenticating once", path)
            self._session.invalidate()
            payload = self._session.post_read(self._air_base, path, self._auth(body, force_token=True))
            return self._session.check_response(payload, wrapped=wrapped)

    def _write(self, path: str, body: Mapping[str, Any]) -> dict:
        """A single-shot write — NEVER retried, NEVER auto-re-authenticated."""
        payload = self._session.post_write(self._air_base, path, self._auth(body))
        return self._session.check_response(payload, wrapped=True)

    # -- shared service ---------------------------------------------------- #

    def get_agency_balance(self) -> dict:
        """``GetAgencyBalance`` — deposit available for ticketing. Check it
        against the FareQuote OfferedFare before taking customer payment."""
        body = {"EndUserIp": self._session.end_user_ip, "TokenId": self._session.token_id()}
        payload = self._session.post_read(settings.tbo_air_base_url.rstrip("/"), "/GetAgencyBalance", body)
        return self._session.check_response(payload, wrapped=True)

    # -- the booking spine ------------------------------------------------- #

    def search(self, **kwargs: Any) -> schemas.TBOSearchResponse:
        """``/Search`` — available flights for a route and date."""
        inner = self._read("/Search", schemas.search_body(**kwargs))
        return schemas.parse_search(inner)

    def fare_rule(self, trace_id: str, result_index: str) -> dict:
        """``/FareRule`` — the airline fare rules panel (free text, sanitise)."""
        return self._read("/FareRule", schemas.trace_result_body(trace_id, result_index))

    def fare_quote(self, trace_id: str, result_index: str) -> schemas.TBOFareQuote:
        """``/FareQuote`` — REQUIRED before payment. Re-prices and confirms;
        read ``IsLCC`` and the required-field flags from HERE, not Search."""
        inner = self._read("/FareQuote", schemas.trace_result_body(trace_id, result_index))
        return schemas.parse_fare_quote(inner)

    def ssr(self, trace_id: str, result_index: str) -> dict:
        """``/SSR`` — seats, meals, extra baggage for the extras screen."""
        return self._read("/SSR", schemas.trace_result_body(trace_id, result_index))

    def book(self, *, trace_id: str, result_index: str, passengers: Sequence[Mapping[str, Any]]) -> schemas.TBOItinerary:
        """``/Book`` — Non-LCC only: hold the PNR. WRITE, not retried."""
        body = {"TraceId": trace_id, "ResultIndex": result_index, "Passengers": [dict(p) for p in passengers]}
        return schemas.parse_itinerary(self._write("/Book", body))

    def ticket_lcc(
        self, *, trace_id: str, result_index: str,
        passengers: Sequence[Mapping[str, Any]], price_change_accepted: bool = False,
    ) -> schemas.TBOItinerary:
        """``/Ticket`` for an LCC — books AND issues in one call. WRITE."""
        body = {
            "TraceId": trace_id, "ResultIndex": result_index,
            "IsPriceChangeAccepted": bool(price_change_accepted),
            "Passengers": [dict(p) for p in passengers],
        }
        return schemas.parse_itinerary(self._write("/Ticket", body))

    def ticket_non_lcc(
        self, *, trace_id: str, pnr: str, booking_id: int,
        price_change_accepted: bool = False, passport: Sequence[Mapping[str, Any]] | None = None,
    ) -> schemas.TBOItinerary:
        """``/Ticket`` for a Non-LCC — issue against the held PNR. WRITE."""
        body = {
            "TraceId": trace_id, "PNR": pnr, "BookingId": int(booking_id),
            "IsPriceChangeAccepted": bool(price_change_accepted),
            "Passport": [dict(p) for p in (passport or [])],
        }
        return schemas.parse_itinerary(self._write("/Ticket", body))

    def get_booking_details(self, **kwargs: Any) -> schemas.TBOItinerary:
        """``/GetBookingDetails`` — the authority on a booking's state. Use the
        TraceId form to resolve a Book/Ticket that timed out."""
        inner = self._read("/GetBookingDetails", schemas.get_booking_details_body(**kwargs))
        return schemas.parse_itinerary(inner)

    def release_pnr(self, booking_id: int, source: Any) -> dict:
        """``/ReleasePNRRequest`` — release a held Non-LCC PNR (no payment taken)."""
        return self._read("/ReleasePNRRequest", schemas.release_pnr_body(booking_id, source))

    def get_cancellation_charges(self, booking_id: int, **kwargs: Any) -> dict:
        """``/GetCancellationCharges`` — quote only, cancels nothing."""
        return self._read("/GetCancellationCharges", schemas.get_cancellation_charges_body(booking_id, **kwargs))

    def send_change_request(self, booking_id: int, *, remarks: str, **kwargs: Any) -> dict:
        """``/SendChangeRequest`` — raise a cancellation/reissue. Cannot be
        withdrawn once raised; store each ChangeRequestId."""
        return self._read("/SendChangeRequest", schemas.send_change_request_body(booking_id, remarks=remarks, **kwargs))

    def get_change_request_status(self, change_request_id: int) -> dict:
        """``/GetChangeRequestStatus`` — NOT wrapped in a ``Response`` object;
        fields are read at the top level. Settle refunds against
        ``RefundedAmount`` once ``ChangeRequestStatus`` is 4 (Completed)."""
        return self._read(
            "/GetChangeRequestStatus",
            schemas.get_change_request_status_body(change_request_id),
            wrapped=False,
        )
