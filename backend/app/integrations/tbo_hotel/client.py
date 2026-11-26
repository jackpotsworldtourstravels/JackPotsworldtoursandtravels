"""The HTTP client for the TBO hotel APIs — across FOUR host bases.

Unlike the flight interface (one Air-service surface), the hotel surface spans:

  * the SHARED service — Authenticate / Logout / GetAgencyBalance (owned by
    ``integrations.tbo.shared``);
  * the newer "lite" ``affiliate.tektravels.com/HotelAPI`` — Search, PreBook;
  * the classic ``HotelBE.tektravels.com/hotelservice.svc`` — Book,
    GetBookingDetail, GenerateVoucher, SendChangeRequest, GetChangeRequestStatus;
  * the TBO Holidays static host ``api.tbotechnology.in/TBOHolidays_HotelAPI`` —
    CountryList, CityList, TBOHotelCodeList, HotelDetails.

This client borrows a :class:`TBOSession` for the TokenId, the whitelisted
``EndUserIp`` and the HTTP core — it holds NO credential of its own.

WRITE SAFETY. ``Book``, ``GenerateVoucher`` and ``SendChangeRequest`` are
single-shot — never retried. A hold booking (``IsVoucherBooking=false``) must be
vouchered before its Last Cancellation Date; a timeout on Book/Voucher leaves
the outcome UNKNOWN and is resolved with GetBookingDetail, never a blind retry.
Cancellation is asynchronous: SendChangeRequest opens a request and the final
charge/refund arrive via GetChangeRequestStatus — never report an instant refund.

OPEN QUESTION for certification: the TBO Holidays static host's authentication
(Basic vs TokenId) is not pinned by the web-sourced hotel guide. The static
methods here send the documented body WITHOUT a session token; confirm the real
scheme against the live Swagger before relying on them in production.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping, Sequence

from app.config import settings
from app.integrations.tbo import shared as tbo_shared
from app.integrations.tbo.exceptions import TBOAPIError, TBOSessionExpired
from app.integrations.tbo.shared import TBOSession, default_session
from app.integrations.tbo_hotel import schemas

logger = logging.getLogger(__name__)


class TBOHotelClient:
    """A typed wrapper over the TBO hotel endpoints we use."""

    def __init__(
        self,
        *,
        session: TBOSession | None = None,
        search_base_url: str | None = None,
        book_base_url: str | None = None,
        static_base_url: str | None = None,
    ) -> None:
        self._session = session or default_session()
        self._search_base = (search_base_url or settings.tbo_hotel_search_base_url).rstrip("/")
        self._book_base = (book_base_url or settings.tbo_hotel_book_base_url).rstrip("/")
        self._static_base = (static_base_url or settings.tbo_hotel_static_base_url).rstrip("/")

    @staticmethod
    def is_configured() -> bool:
        """True when the shared TBO credentials are present (no network)."""
        return TBOSession.is_configured()

    # -- auth injection ---------------------------------------------------- #

    def _auth(self, body: Mapping[str, Any], *, force_token: bool = False) -> dict:
        out = dict(body)
        out["EndUserIp"] = self._session.end_user_ip
        out["TokenId"] = self._session.token_id(force=force_token)
        return out

    # -- lite surface (Search / PreBook): Status.Code envelope ------------- #

    def _lite_read(self, path: str, body: Mapping[str, Any]) -> dict:
        payload = self._session.post_read(self._search_base, path, self._auth(body))
        if not schemas.status_code_ok(payload):
            desc = (payload.get("Status") or {}).get("Description") or "TBO hotel request refused"
            code = (payload.get("Status") or {}).get("Code")
            raise TBOAPIError(tbo_shared.safe_detail(desc), code=code)
        return payload

    def search(self, **kwargs: Any) -> tuple[schemas.TBOHotelOption, ...]:
        """``/Search`` — rooms + a ``BookingCode`` per bookable rate.

        Returns an empty tuple when TBO found no availability (Status 201), which
        is a normal result, not an error.
        """
        payload = self._lite_read("/Search", schemas.search_body(**kwargs))
        if schemas.status_code_is_empty(payload):
            return ()
        return schemas.parse_search(payload)

    def prebook(self, booking_code: str) -> schemas.TBOHotelPreBook:
        """``/PreBook`` — the authoritative NetAmount + the pax/document rules
        the Book call must satisfy. Surface IsPriceChanged / policy changes."""
        payload = self._lite_read("/PreBook", schemas.prebook_body(booking_code))
        return schemas.parse_prebook(payload)

    # -- classic HotelService: ResponseStatus envelope --------------------- #

    def _classic_read(self, path: str, body: Mapping[str, Any]) -> dict:
        """A retriable classic-service read that re-auths once on expiry."""
        try:
            payload = self._session.post_read(self._book_base, path, self._auth(body))
            return self._session.check_response(payload, wrapped=False)
        except TBOSessionExpired:
            logger.info("TBO hotel session expired on %s — re-authenticating once", path)
            self._session.invalidate()
            payload = self._session.post_read(self._book_base, path, self._auth(body, force_token=True))
            return self._session.check_response(payload, wrapped=False)

    def _classic_write(self, path: str, body: Mapping[str, Any]) -> dict:
        """A single-shot classic-service write — NEVER retried / re-authed."""
        payload = self._session.post_write(self._book_base, path, self._auth(body))
        return self._session.check_response(payload, wrapped=False)

    def book(self, **kwargs: Any) -> schemas.TBOHotelBooking:
        """``/book/`` — WRITE. ``IsVoucherBooking=false`` holds; voucher later."""
        return schemas.parse_booking(self._classic_write("/book/", schemas.book_body(**kwargs)))

    def get_booking_detail(self, **kwargs: Any) -> schemas.TBOHotelBooking:
        """``/Getbookingdetail`` — the reconciliation authority (status, invoice,
        LastCancellationDate). Resolve a timed-out Book/Voucher with this."""
        return schemas.parse_booking(self._classic_read("/Getbookingdetail", schemas.get_booking_detail_body(**kwargs)))

    def generate_voucher(self, booking_id: int) -> schemas.TBOHotelBooking:
        """``/GenerateVoucher`` — voucher a hold before Last Cancellation Date. WRITE."""
        return schemas.parse_booking(self._classic_write("/GenerateVoucher", schemas.generate_voucher_body(booking_id)))

    def send_change_request(self, booking_id: int, *, remarks: str) -> schemas.TBOHotelBooking:
        """``/SendChangeRequest`` — open an (async) cancellation. WRITE, not retried."""
        body = schemas.send_change_request_body(booking_id, remarks=remarks)
        return schemas.parse_booking(self._classic_write("/SendChangeRequest", body))

    def get_change_request_status(self, change_request_id: int) -> schemas.TBOHotelBooking:
        """``/GetChangeRequestStatus`` — poll until Processed (3) for the final
        CancellationCharge + RefundAmount."""
        body = schemas.get_change_request_status_body(change_request_id)
        return schemas.parse_booking(self._classic_read("/GetChangeRequestStatus", body))

    # -- static content (TBO Holidays host) -------------------------------- #

    def country_list(self) -> dict:
        return self._session.post_read(self._static_base, "/CountryList", {})

    def city_list(self, country_code: str) -> dict:
        return self._session.post_read(self._static_base, "/CityList", schemas.city_list_body(country_code))

    def hotel_code_list(self, city_code: int) -> dict:
        return self._session.post_read(self._static_base, "/TBOHotelCodeList", schemas.hotel_code_list_body(city_code))

    def hotel_details(self, hotel_codes: str | Sequence[Any], **kwargs: Any) -> dict:
        return self._session.post_read(self._static_base, "/Hoteldetails", schemas.hotel_details_body(hotel_codes, **kwargs))
