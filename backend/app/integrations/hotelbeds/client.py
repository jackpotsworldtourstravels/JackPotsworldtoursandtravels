"""The signed HTTP client for the Hotelbeds (HBX Group) APIs.

THE ONLY PLACE IN THE PROJECT THAT TOUCHES THESE CREDENTIALS. Nothing above
this module sees the key, the secret or the signature, and nothing below it
exists. If you find yourself reading ``settings.hotelbeds_secret`` anywhere
else, that is the bug.

-----------------------------------------------------------------------------
AUTHENTICATION
-----------------------------------------------------------------------------
Hotelbeds signs every request with a rolling SHA-256 digest, documented at
https://developer.hotelbeds.com/documentation/getting-started/ as:

    X-Signature = SHA256(apiKey + secret + currentUnixTimeSeconds)

in lowercase hex. Three consequences the rest of this file is shaped by:

  1. The signature EXPIRES. It embeds a timestamp, so it must be computed per
     request — never cached, never reused across a retry. ``_headers`` is
     therefore called inside the attempt loop, not outside it.
  2. The signature IS a credential. Anyone holding it can spend the quota for
     the window it covers. It is never logged and never returned in an error.
  3. Clock skew breaks authentication. A machine whose clock is minutes out
     will be refused with a 401 that says nothing about clocks, which is worth
     remembering before debugging anything else.

``Accept-Encoding: gzip`` is REQUIRED by the API, not merely polite — a content
page with ``fields=all`` is megabytes, and ``requests`` transparently inflates
it for us.

-----------------------------------------------------------------------------
WHY THE RETRY RULES LOOK ASYMMETRIC
-----------------------------------------------------------------------------
Only reads are retried, and only on transport failures and 5xx. A 403 is never
retried because on a sandbox key it means the daily allowance (50 requests) is
gone, and hammering it simply guarantees tomorrow starts the same way. A 401 is
never retried because a wrong secret does not become right.

This client deliberately offers GET only. The booking endpoints are POST and
are NOT idempotent; giving this class a general ``post()`` would make it one
careless call away from double-booking a room. When booking is built it gets
its own method with its own no-retry contract, added on purpose.
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any, Mapping

import requests

from app.config import settings
from app.integrations.hotelbeds.exceptions import (
    HotelbedsAPIError,
    HotelbedsNotConfigured,
    HotelbedsQuotaExceeded,
    HotelbedsTimeout,
    HotelbedsTransportError,
)

logger = logging.getLogger(__name__)

#: Statuses worth trying again. 429 is included because Hotelbeds uses it for
#: short-window throttling, which genuinely does clear; 403 is NOT, because for
#: this API it means the daily allowance is spent.
_RETRYABLE = frozenset({500, 502, 503, 504, 429})

#: Two retries, so three attempts total. Content syncs run against a quota
#: measured in tens of requests a day, so an aggressive retry budget would be
#: self-defeating.
_MAX_ATTEMPTS = 3


def compute_signature(api_key: str, secret: str, now: int | None = None) -> str:
    """SHA-256 of key+secret+unix-seconds, lowercase hex.

    A free function, and tested as one, because it is the single piece of this
    integration that is pure: given the same three inputs it must always give
    the same digest, and that is verifiable without a network or an account.
    """
    stamp = int(time.time()) if now is None else int(now)
    return hashlib.sha256(f"{api_key}{secret}{stamp}".encode("utf-8")).hexdigest()


def safe_detail(body: Any, status: int) -> tuple[str, str | None]:
    """Turn a supplier error body into something safe to log and show.

    Returns ``(detail, code)``.

    Hotelbeds returns errors as ``{"error": {"code": ..., "message": ...}}``.
    We keep the code and the message because both are genuinely diagnostic, and
    we keep NOTHING else: a supplier is free to echo request context back, and
    a request of ours carries an API key. Anything unrecognised collapses to a
    generic line naming only the status.
    """
    if isinstance(body, Mapping):
        err = body.get("error")
        if isinstance(err, Mapping):
            code = err.get("code")
            message = err.get("message")
            if message:
                return str(message)[:300], (str(code) if code else None)
        message = body.get("message")
        if message:
            return str(message)[:300], None
    return f"Request refused with HTTP {status}.", None


class HotelbedsClient:
    """Signed GET access to one Hotelbeds API base.

    Construct it with a base URL so the same class serves the Content API and,
    later, the Booking API — they share an account, a signature scheme and a
    quota, and differ only in host path.
    """

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        secret: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self._base_url = (base_url or settings.hotelbeds_content_base_url).rstrip("/")
        self._api_key = api_key or settings.hotelbeds_api_key
        self._secret = secret or settings.hotelbeds_secret
        self._timeout = float(timeout_seconds or settings.hotelbeds_timeout_seconds or 60.0)
        self._session = requests.Session()

    # ------------------------------------------------------------------ meta
    @property
    def configured(self) -> bool:
        """Whether a key AND a secret are present. Cheap enough to call freely."""
        return bool(self._api_key and self._secret)

    def require_configured(self) -> None:
        """Raise the configuration error, with the fix in the message."""
        if not self.configured:
            raise HotelbedsNotConfigured(
                "HOTELBEDS_API_KEY and HOTELBEDS_SECRET are not set in backend/.env. "
                "Register at https://developer.hotelbeds.com to obtain them; the "
                "catalogue sync cannot run without them."
            )

    def _headers(self) -> dict[str, str]:
        """Fresh headers, including a signature valid from this second.

        Recomputed per attempt on purpose — see the module docstring.
        """
        return {
            "Api-key": self._api_key or "",
            "X-Signature": compute_signature(self._api_key or "", self._secret or ""),
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        }

    # ------------------------------------------------------------------ call
    def get(self, path: str, params: Mapping[str, Any] | None = None) -> dict:
        """GET one Content API path and return the decoded body.

        Args:
            path: Path below the base URL, e.g. ``/hotels``.
            params: Query parameters. ``None`` values are dropped rather than
                sent as the string "None", and sequences are passed through for
                ``requests`` to repeat — which is what the API wants for
                repeated keys like ``fields``.

        Raises:
            HotelbedsNotConfigured: no credentials.
            HotelbedsQuotaExceeded: 403, the daily allowance is spent.
            HotelbedsAPIError: any other refusal.
            HotelbedsTimeout / HotelbedsTransportError: the call never landed.
        """
        self.require_configured()

        url = f"{self._base_url}/{path.lstrip('/')}"
        clean = {k: v for k, v in (params or {}).items() if v is not None}

        last_transport: Exception | None = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                response = self._session.get(
                    url, params=clean, headers=self._headers(), timeout=self._timeout,
                )
            except requests.Timeout as exc:
                last_transport = exc
                if attempt == _MAX_ATTEMPTS:
                    raise HotelbedsTimeout(
                        f"Hotelbeds did not answer {path} within {self._timeout}s "
                        f"after {attempt} attempts."
                    ) from exc
                self._backoff(attempt)
                continue
            except requests.RequestException as exc:
                last_transport = exc
                if attempt == _MAX_ATTEMPTS:
                    raise HotelbedsTransportError(
                        f"Could not reach Hotelbeds for {path}: {type(exc).__name__}."
                    ) from exc
                self._backoff(attempt)
                continue

            if response.status_code == 200:
                try:
                    return response.json()
                except ValueError as exc:
                    raise HotelbedsTransportError(
                        f"Hotelbeds returned a non-JSON body for {path}."
                    ) from exc

            # A refusal. Decode what we safely can before deciding.
            try:
                body = response.json()
            except ValueError:
                body = None
            detail, code = safe_detail(body, response.status_code)

            if response.status_code == 403:
                # Never retried. On a sandbox key this is the daily cap.
                raise HotelbedsQuotaExceeded(response.status_code, detail, code)

            if response.status_code in _RETRYABLE and attempt < _MAX_ATTEMPTS:
                logger.warning(
                    "Hotelbeds %s answered %s; retrying (%s/%s).",
                    path, response.status_code, attempt, _MAX_ATTEMPTS,
                )
                self._backoff(attempt)
                continue

            raise HotelbedsAPIError(response.status_code, detail, code)

        # Unreachable: every path above either returns or raises.
        raise HotelbedsTransportError(
            f"Hotelbeds {path} failed after {_MAX_ATTEMPTS} attempts."
        ) from last_transport

    @staticmethod
    def _backoff(attempt: int) -> None:
        """Linear, not exponential, and short.

        The quota is the scarce resource here, not the supplier's patience, and
        a sync that pauses for a minute between attempts just moves the failure
        later. Two seconds, then four.
        """
        time.sleep(2.0 * attempt)


def content_client() -> HotelbedsClient:
    """The Content API client, built from settings."""
    return HotelbedsClient(base_url=settings.hotelbeds_content_base_url)
