"""The shared TBO session: Authenticate, the TokenId cache, and the HTTP core.

THE ONLY PLACE IN THE PROJECT THAT HOLDS THE TBO API PASSWORD. Nothing above
this module sees it; it is never logged, never echoed in an error, never
returned. TBO issues ONE TokenId per application per day and the same token
serves BOTH flights and hotels, so authentication lives here — in the flight
package by file location, but owned jointly — and the flight (Air) and hotel
clients borrow this session rather than each holding credentials.

-----------------------------------------------------------------------------
CONFIGURATION IS CHECKED, NOT ASSUMED
-----------------------------------------------------------------------------
A call cannot succeed until FOUR things exist — ClientId, UserName, Password
and a public ``EndUserIp`` that TBO has whitelisted — so :meth:`is_configured`
is the gate the supplier switches read to decide whether TBO mode is even
available. Absent any of them, TBO is simply unavailable and the provider in
force (demo flights / catalogue hotels) stays, exactly as a fresh checkout
behaves today. The sandbox host bases come from the Postman collection TBO
issues with the account; until they are set, this stays dormant.

-----------------------------------------------------------------------------
WHY THE TOKEN IS CACHED, AND WHY LOGOUT IS NOT CALLED CASUALLY
-----------------------------------------------------------------------------
One TokenId is shared by the whole application. We Authenticate once, cache the
TokenId for the calendar day, and reuse it for every other call. Calling Logout
ends EVERY search in progress because the token is shared, so it is never
called between customer sessions — only on an explicit shutdown/rotate.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
import threading
from typing import Any, Mapping

import requests

from app.config import settings
from app.integrations.tbo.exceptions import (
    TBOAPIError,
    TBONotConfigured,
    TBOSessionExpired,
    TBOTimeout,
    TBOTransportError,
)

logger = logging.getLogger(__name__)

#: HTTP statuses worth trying again for READS. 5xx and 429 are transient.
_RETRYABLE = frozenset({429, 500, 502, 503, 504})
_MAX_READ_ATTEMPTS = 3

#: TBO ``ResponseStatus`` / Authenticate ``Status`` enum — 4 means the session
#: is invalid (token expired or logged out). The one value the flow re-auths on.
_INVALID_SESSION = 4


def safe_detail(text: str | None, *password: str | None) -> str:
    """A message safe to log: never a credential, always something.

    Strips any configured password occurrence verbatim, then redacts anything
    that looks like a ``Password`` value in a JSON fragment, as defence in depth
    against a proxy echoing a request body.
    """
    s = (text or "").strip() or "no detail"
    for secret in password:
        if secret:
            s = s.replace(secret, "***")
    s = re.sub(r'("Password"\s*:\s*")[^"]*(")', r"\1***\2", s, flags=re.IGNORECASE)
    return s


class _TokenCacheEntry:
    __slots__ = ("token_id", "member_id", "agency_id", "issued_date")

    def __init__(self, token_id: str, member_id: Any, agency_id: Any, issued_date: dt.date) -> None:
        self.token_id = token_id
        self.member_id = member_id
        self.agency_id = agency_id
        self.issued_date = issued_date


class TBOSession:
    """Holds the TBO credentials, the HTTP session and the day-scoped token.

    One instance can be shared across the flight and hotel clients. It is
    thread-safe around the token cache: concurrent searches authenticate at
    most once per day between them.
    """

    def __init__(
        self,
        *,
        client_id: str | None = None,
        username: str | None = None,
        password: str | None = None,
        end_user_ip: str | None = None,
        shared_base_url: str | None = None,
        timeout_seconds: float | None = None,
        session: requests.Session | None = None,
    ) -> None:
        self._client_id = (client_id if client_id is not None else settings.tbo_client_id) or ""
        self._username = (username if username is not None else settings.tbo_username) or ""
        self._password = (password if password is not None else settings.tbo_password) or ""
        self._end_user_ip = (end_user_ip if end_user_ip is not None else settings.tbo_end_user_ip) or ""
        self._shared_base = (shared_base_url or settings.tbo_shared_base_url).rstrip("/")
        self._timeout = timeout_seconds if timeout_seconds is not None else settings.tbo_timeout_seconds
        self._session = session or requests.Session()
        self._lock = threading.Lock()
        self._cache: _TokenCacheEntry | None = None

    # -- configuration ----------------------------------------------------- #

    @staticmethod
    def is_configured() -> bool:
        """True when all four credentials are present — without a network call.

        The supplier switches read this to decide whether TBO mode is available
        at all, so a missing credential degrades to the provider in force
        quietly rather than raising on import or mid-search.
        """
        return all((
            (settings.tbo_client_id or "").strip(),
            (settings.tbo_username or "").strip(),
            (settings.tbo_password or "").strip(),
            (settings.tbo_end_user_ip or "").strip(),
        ))

    def _require_configured(self) -> None:
        if not all((self._client_id, self._username, self._password, self._end_user_ip)):
            # The offending values are NOT included in the message.
            raise TBONotConfigured(
                "TBO is not configured: TBO_CLIENT_ID, TBO_USERNAME, TBO_PASSWORD and a "
                "whitelisted TBO_END_USER_IP must all be set. Refusing to run."
            )

    @property
    def client_id(self) -> str:
        return self._client_id

    @property
    def end_user_ip(self) -> str:
        return self._end_user_ip

    def _safe(self, text: str | None) -> str:
        return safe_detail(text, self._password)

    # -- the HTTP core ----------------------------------------------------- #

    def _headers(self) -> dict[str, str]:
        return {"Content-Type": "application/json", "Accept": "application/json"}

    def post_read(self, base_url: str, path: str, body: Mapping[str, Any]) -> dict:
        """A retriable POST, for idempotent reads (Search, FareQuote, lookups)."""
        return self._post(base_url, path, body, retry=True)

    def post_write(self, base_url: str, path: str, body: Mapping[str, Any]) -> dict:
        """A single-shot POST — NEVER retried. For Book / Ticket / voucher.

        A timeout here leaves the outcome UNKNOWN; the caller must reconcile by
        lookup (GetBookingDetails / GetBookingDetail), never retry.
        """
        return self._post(base_url, path, body, retry=False)

    def _post(self, base_url: str, path: str, body: Mapping[str, Any], *, retry: bool) -> dict:
        url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
        attempts = _MAX_READ_ATTEMPTS if retry else 1
        last_exc: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                resp = self._session.post(
                    url, headers=self._headers(), json=dict(body), timeout=self._timeout,
                )
            except requests.Timeout:
                if not retry:
                    raise TBOTimeout(f"POST {path} timed out — outcome unknown, do not retry")
                last_exc = TBOTimeout(f"POST {path} timed out")
            except requests.RequestException as exc:
                last_exc = TBOTransportError(f"POST {path}: {self._safe(str(exc))}")
                if not retry:
                    raise last_exc
            else:
                if resp.status_code < 400:
                    try:
                        return resp.json()
                    except ValueError:
                        raise TBOTransportError(f"POST {path}: non-JSON response")
                if retry and resp.status_code in _RETRYABLE and attempt < attempts:
                    logger.warning("TBO POST %s -> %s, retrying", path, resp.status_code)
                    continue
                raise TBOAPIError(self._safe(resp.text), status=resp.status_code)
            if attempt < attempts:
                logger.warning("TBO POST %s transport issue, retrying", path)
        assert last_exc is not None
        raise last_exc

    # -- authentication ---------------------------------------------------- #

    def token_id(self, *, force: bool = False) -> str:
        """Return a valid TokenId, authenticating only when needed.

        Reuses the cached token for the rest of the calendar day it was issued.
        ``force`` re-authenticates regardless — used once after an
        InValidSession response.
        """
        self._require_configured()
        today = dt.datetime.now(dt.timezone.utc).date()
        with self._lock:
            if not force and self._cache is not None and self._cache.issued_date == today:
                return self._cache.token_id
            entry = self._authenticate()
            self._cache = entry
            return entry.token_id

    def _authenticate(self) -> _TokenCacheEntry:
        body = {
            "ClientId": self._client_id,
            "UserName": self._username,
            "Password": self._password,
            "EndUserIp": self._end_user_ip,
        }
        payload = self._post(self._shared_base, "/Authenticate", body, retry=True)
        status = payload.get("Status")
        err = payload.get("Error") or {}
        token = payload.get("TokenId")
        if status != 1 or not token:
            raise TBOAPIError(
                self._safe(err.get("ErrorMessage") or "Authenticate failed"),
                code=err.get("ErrorCode"),
                response_status=status,
            )
        member = payload.get("Member") or {}
        return _TokenCacheEntry(
            token_id=token,
            member_id=member.get("MemberId"),
            agency_id=member.get("AgencyId"),
            issued_date=dt.datetime.now(dt.timezone.utc).date(),
        )

    def invalidate(self) -> None:
        """Drop the cached token so the next call re-authenticates."""
        with self._lock:
            self._cache = None

    # -- response checking (business-level) -------------------------------- #

    def check_response(self, payload: Mapping[str, Any], *, wrapped: bool = True) -> dict:
        """Raise on a TBO business-level refusal; return the inner object.

        Air-service and classic hotel calls wrap the result in ``Response`` with
        a ``ResponseStatus`` and ``Error``. GetChangeRequestStatus (flights) is
        the exception — it is not wrapped — so pass ``wrapped=False`` there and
        the fields are read at the top level. ``ResponseStatus`` 4 is raised as
        :class:`TBOSessionExpired` so the caller can re-auth and retry once.
        """
        inner = payload.get("Response") if wrapped else payload
        if not isinstance(inner, Mapping):
            raise TBOAPIError(self._safe(str(payload)[:300]))
        status = inner.get("ResponseStatus")
        err = inner.get("Error") or {}
        if status == _INVALID_SESSION:
            raise TBOSessionExpired(
                self._safe(err.get("ErrorMessage") or "Session expired"),
                code=err.get("ErrorCode"), response_status=status,
            )
        if status is not None and status != 1:
            raise TBOAPIError(
                self._safe(err.get("ErrorMessage") or "TBO refused the request"),
                code=err.get("ErrorCode"), response_status=status,
            )
        return dict(inner)


#: A lazily-built process-wide session, so the TokenId cache is actually shared
#: between the flight and hotel clients rather than re-authenticated per client.
_DEFAULT_SESSION: TBOSession | None = None
_DEFAULT_LOCK = threading.Lock()


def default_session() -> TBOSession:
    """The shared :class:`TBOSession`, built on first use from settings."""
    global _DEFAULT_SESSION
    with _DEFAULT_LOCK:
        if _DEFAULT_SESSION is None:
            _DEFAULT_SESSION = TBOSession()
        return _DEFAULT_SESSION


def reset_default_session() -> None:
    """Forget the shared session — for tests and credential rotation."""
    global _DEFAULT_SESSION
    with _DEFAULT_LOCK:
        _DEFAULT_SESSION = None
