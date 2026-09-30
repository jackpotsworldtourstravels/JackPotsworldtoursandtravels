"""The HTTP client for the Duffel Flights API — TEST MODE by construction.

THE ONLY PLACE IN THE PROJECT THAT HOLDS THE DUFFEL TOKEN. Nothing above this
module sees it, and it is never logged, never echoed in an error, never
returned. If you find ``settings.duffel_access_token`` read anywhere else, that
is the bug.

-----------------------------------------------------------------------------
TEST MODE IS ENFORCED, NOT ASSUMED
-----------------------------------------------------------------------------
The constructor refuses to build unless the token begins with ``duffel_test_``.
A blank token, a live ``duffel_live_`` token, or anything else raises
:class:`DuffelNotConfigured`. So this client CANNOT talk to production, and
pointing it there is a deliberate code change rather than an environment slip.

-----------------------------------------------------------------------------
WHY THE RETRY RULES ARE ASYMMETRIC
-----------------------------------------------------------------------------
Reads — offer requests, fetching an offer, seat maps — are retried on transport
failures, timeouts and 5xx, because they are idempotent: the worst a repeat
does is cost a little time.

Writes — ``POST /air/orders`` and ``POST /air/payments`` — are NEVER retried.
Duffel documents no idempotency key for order creation, so a blind retry after
a timeout can create a SECOND booking. A timeout on a write is therefore
"unknown", surfaced as :class:`DuffelTimeout`, and reconciliation (looking the
order up by the ``booking_ref`` we stamped into ``metadata``) is the caller's
job — never a silent retry here.

``Accept-Encoding: gzip`` is sent because offer responses are large and
``requests`` inflates transparently.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping

import requests

from app.config import settings
from app.integrations.duffel.exceptions import (
    DuffelAPIError,
    DuffelNotConfigured,
    DuffelOfferExpired,
    DuffelTimeout,
    DuffelTransportError,
)

logger = logging.getLogger(__name__)

#: The only token prefix this client will accept. See module docstring.
_TEST_TOKEN_PREFIX = "duffel_test_"

#: Statuses worth trying again for READS. 429 is Duffel's rate limit, which
#: clears; 5xx are transient. 401/403/404/422 are never retried — a wrong token
#: does not become right, and a validation error does not become valid.
_RETRYABLE = frozenset({429, 500, 502, 503, 504})

#: Three attempts total for reads.
_MAX_READ_ATTEMPTS = 3

#: Duffel error codes that mean "this offer is gone" — a normal branch of the
#: booking flow, surfaced as DuffelOfferExpired so callers re-search instead of
#: crashing.
_OFFER_GONE_CODES = frozenset({
    "offer_no_longer_available",
    "offer_request_already_actioned",
    "offer_expired",
})


def safe_detail(text: str | None) -> str:
    """A message safe to log: never the token, always something.

    Defence in depth — the token is never placed in a URL or body, so it should
    not appear in an error at all, but a bad proxy could echo a request header.
    This strips any ``duffel_test_...`` / ``duffel_live_...`` run just in case.
    """
    import re
    s = (text or "").strip() or "no detail"
    return re.sub(r"duffel_(test|live)_[A-Za-z0-9_-]+", "duffel_***", s)


class DuffelClient:
    """A thin, typed wrapper over the Duffel REST endpoints we use.

    Construct one per operation or reuse it — it holds a ``requests.Session``
    for connection reuse and is otherwise stateless.
    """

    def __init__(
        self,
        token: str | None = None,
        *,
        base_url: str | None = None,
        api_version: str | None = None,
        timeout_seconds: float | None = None,
        session: requests.Session | None = None,
    ) -> None:
        token = (token if token is not None else settings.duffel_access_token) or ""
        token = token.strip()
        if not token.startswith(_TEST_TOKEN_PREFIX):
            # Note: the offending value is NOT included in the message.
            raise DuffelNotConfigured(
                "Duffel is not configured for test mode: DUFFEL_ACCESS_TOKEN must "
                "be a 'duffel_test_' token. Refusing to run."
            )
        self._token = token
        self._base_url = (base_url or settings.duffel_api_base_url).rstrip("/")
        self._version = api_version or settings.duffel_api_version
        self._timeout = timeout_seconds if timeout_seconds is not None else settings.duffel_timeout_seconds
        self._session = session or requests.Session()

    # -- configuration ----------------------------------------------------- #

    @classmethod
    def is_configured(cls) -> bool:
        """True when a test token is present — without constructing a client.

        The supplier switch uses this to decide whether Duffel mode is even
        available, so a missing token degrades to the demo provider quietly
        rather than raising on import.
        """
        token = (settings.duffel_access_token or "").strip()
        return token.startswith(_TEST_TOKEN_PREFIX)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Duffel-Version": self._version,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        }

    # -- the core request -------------------------------------------------- #

    def _raise_for_api_error(self, resp: requests.Response) -> None:
        code = title = None
        detail = f"HTTP {resp.status_code}"
        try:
            body = resp.json()
            errs = body.get("errors") or []
            if errs:
                first = errs[0]
                code = first.get("code")
                title = first.get("title")
                detail = first.get("message") or first.get("title") or detail
        except ValueError:
            detail = resp.text or detail
        detail = safe_detail(detail)
        if code in _OFFER_GONE_CODES:
            raise DuffelOfferExpired(resp.status_code, detail, code=code, title=title)
        raise DuffelAPIError(resp.status_code, detail, code=code, title=title)

    def _read(self, method: str, path: str, *, params=None, json=None) -> dict:
        """A retriable request, for idempotent reads only."""
        url = f"{self._base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(1, _MAX_READ_ATTEMPTS + 1):
            try:
                resp = self._session.request(
                    method, url, headers=self._headers(),
                    params=params, json=json, timeout=self._timeout,
                )
            except requests.Timeout as exc:
                last_exc = DuffelTimeout(f"{method} {path} timed out")
            except requests.RequestException as exc:
                last_exc = DuffelTransportError(f"{method} {path}: {safe_detail(str(exc))}")
            else:
                if resp.status_code < 400:
                    return resp.json()
                if resp.status_code in _RETRYABLE and attempt < _MAX_READ_ATTEMPTS:
                    logger.warning("Duffel %s %s -> %s, retrying", method, path, resp.status_code)
                    continue
                self._raise_for_api_error(resp)
            if attempt < _MAX_READ_ATTEMPTS:
                logger.warning("Duffel %s %s transport issue, retrying", method, path)
        assert last_exc is not None
        raise last_exc

    def _write_once(self, method: str, path: str, *, json=None) -> dict:
        """A single-shot request — NEVER retried. See module docstring."""
        url = f"{self._base_url}{path}"
        try:
            resp = self._session.request(
                method, url, headers=self._headers(), json=json, timeout=self._timeout,
            )
        except requests.Timeout:
            # Unknown outcome: the order may or may not exist. The caller must
            # reconcile by lookup, not retry.
            raise DuffelTimeout(f"{method} {path} timed out — outcome unknown, do not retry")
        except requests.RequestException as exc:
            raise DuffelTransportError(f"{method} {path}: {safe_detail(str(exc))}")
        if resp.status_code >= 400:
            self._raise_for_api_error(resp)
        return resp.json()

    # -- endpoints --------------------------------------------------------- #

    def create_offer_request(
        self, body: Mapping[str, Any], *,
        return_offers: bool = True, supplier_timeout_ms: int | None = None,
    ) -> dict:
        """``POST /air/offer_requests`` — the flight search."""
        params: dict[str, Any] = {"return_offers": str(return_offers).lower()}
        if supplier_timeout_ms is not None:
            params["supplier_timeout"] = int(supplier_timeout_ms)
        return self._read("POST", "/air/offer_requests", params=params, json=dict(body))

    def get_offer(self, offer_id: str, *, return_available_services: bool = False) -> dict:
        """``GET /air/offers/{id}`` — re-fetch a single offer before booking."""
        params = (
            {"return_available_services": "true"} if return_available_services else None
        )
        return self._read("GET", f"/air/offers/{offer_id}", params=params)

    def get_seat_maps(self, offer_id: str) -> dict:
        """``GET /air/seat_maps?offer_id=`` — the cabin for an offer."""
        return self._read("GET", "/air/seat_maps", params={"offer_id": offer_id})

    def create_order(self, body: Mapping[str, Any]) -> dict:
        """``POST /air/orders`` — book. NOT retried; see module docstring."""
        return self._write_once("POST", "/air/orders", json=dict(body))

    def create_payment(self, body: Mapping[str, Any]) -> dict:
        """``POST /air/payments`` — pay a hold order. NOT retried."""
        return self._write_once("POST", "/air/payments", json=dict(body))
