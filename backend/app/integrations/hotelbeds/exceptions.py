"""What can go wrong talking to Hotelbeds, as types the caller can act on.

The distinction that matters here is CONFIGURATION vs TRANSPORT vs REFUSAL,
because the three deserve opposite responses:

  * a missing key is a deployment fact — retrying cannot help, and the sync
    should say so once and stop;
  * a timeout is weather — the same request may well work in a minute;
  * a 403 on a sandbox key is a QUOTA, and retrying actively burns what little
    of it remains.

Every one of these carries a message safe to put in a log. None of them ever
carries the API key, the secret or the X-Signature — see ``safe_detail``.
"""
from __future__ import annotations


class HotelbedsError(Exception):
    """Base class — catch this to mean "the supplier leg failed"."""


class HotelbedsNotConfigured(HotelbedsError):
    """No API key and/or secret in the environment.

    Deliberately its own type rather than a generic error: it is the expected
    state of a fresh checkout, and the correct handling is to skip the sync
    with an explanation, not to alarm anyone.
    """


class HotelbedsTimeout(HotelbedsError):
    """The supplier did not answer inside the configured timeout.

    Safe to retry. Content calls are idempotent reads, so a retry cannot
    duplicate anything — which is NOT true of the booking endpoints, and is
    why that distinction is drawn in the client rather than left to callers.
    """


class HotelbedsTransportError(HotelbedsError):
    """The request never completed — DNS, TLS, connection reset, unreadable body."""


class HotelbedsAPIError(HotelbedsError):
    """The API answered, and the answer was a refusal.

    Attributes:
        status: HTTP status code.
        code: Hotelbeds' own error code when it sent one.
        detail: Sanitised message — see ``safe_detail`` in the client.
    """

    def __init__(self, status: int, detail: str, code: str | None = None) -> None:
        self.status = int(status)
        self.code = code
        self.detail = detail
        super().__init__(f"Hotelbeds {self.status}: {detail}")


class HotelbedsQuotaExceeded(HotelbedsAPIError):
    """403 — the request allowance for this key is spent.

    A sandbox key is capped at 50 requests PER DAY. Treating this as an
    ordinary error and retrying is the single easiest way to lose a day of
    development time, so it gets its own type and the client never retries it.
    """
