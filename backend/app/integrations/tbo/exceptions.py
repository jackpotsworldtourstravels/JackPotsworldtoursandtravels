"""What can go wrong talking to TBO / TekTravels, as types the caller acts on.

The same three-way split the Duffel and Hotelbeds integrations draw, for the
same reason — CONFIGURATION vs TRANSPORT vs REFUSAL each want an opposite
response:

  * missing credentials / host bases is a deployment fact — retrying cannot
    help, and the caller should stay on the provider in force (demo flights,
    catalogue hotels) with one clear message, never point live credentials at
    anything;
  * a timeout or a dropped connection is weather — a read may well work a
    moment later, and a read is safe to try again;
  * a TBO error payload (``Error.ErrorCode`` / ``ResponseStatus`` other than 1
    / ``Status`` 0) is a REFUSAL carrying the supplier's own code, and a few of
    them — an expired session, a changed fare — are normal branches of the flow
    the booking path must handle rather than crash on.

TBO shares one Authenticate across flights AND hotels (the SharedData service),
so these live in the FLIGHT package but are imported by the hotel adapter too —
one vocabulary of failure for one supplier. None of these ever carries the API
password; see ``safe_detail`` in ``shared.py``.
"""
from __future__ import annotations


class TBOError(Exception):
    """Base class — catch this to mean "the TBO leg failed"."""


class TBONotConfigured(TBOError):
    """Credentials or host bases are missing, so TBO cannot be reached.

    Its own type on purpose: it is the expected state of a checkout that has
    not been given a TBO account yet. The correct handling is to stay on the
    provider in force (demo flights / catalogue hotels) with an explanation,
    never to pretend a supplier is live.

    TBO needs FOUR things before a single call can succeed — ClientId,
    UserName, Password and a whitelisted ``EndUserIp`` — plus the sandbox host
    bases from the Postman collection. Any one absent lands here.
    """


class TBOTimeout(TBOError):
    """TBO did not answer inside the configured timeout.

    Safe to retry for reads (Search, FareRule, FareQuote, GetBookingDetails).
    NOT safe to retry for the write calls — ``Book`` and ``Ticket`` — because a
    blind repeat after a timeout can create a SECOND PNR or issue a SECOND
    ticket. On a write timeout the outcome is UNKNOWN: resolve it with
    GetBookingDetails (by TraceId or BookingId), never by retrying. That
    asymmetry is enforced in the client, not left to callers.
    """


class TBOTransportError(TBOError):
    """The request never completed — DNS, TLS, connection reset, unreadable body."""


class TBOAPIError(TBOError):
    """TBO answered, and the answer was a refusal.

    Attributes:
        status: HTTP status code, when there was one.
        code: TBO's own ``Error.ErrorCode`` (an int), when it sent one.
        detail: Sanitised ``Error.ErrorMessage`` safe to log.
        response_status: TBO's ``ResponseStatus`` / ``Status`` when present —
            the booking path branches on it (e.g. 4 InValidSession).
    """

    def __init__(
        self,
        detail: str,
        *,
        status: int | None = None,
        code: int | None = None,
        response_status: int | None = None,
    ) -> None:
        self.status = status
        self.code = code
        self.detail = detail
        self.response_status = response_status
        bits = []
        if status is not None:
            bits.append(f"HTTP {status}")
        if code is not None:
            bits.append(f"ErrorCode {code}")
        prefix = f"TBO {' '.join(bits)}: " if bits else "TBO: "
        super().__init__(f"{prefix}{detail}")


class TBOSessionExpired(TBOAPIError):
    """The TokenId is no longer valid (``ResponseStatus`` 4 — InValidSession).

    A normal, expected branch: the shared TokenId lasts about a day (hotels) or
    ~12h (flights). The caller re-authenticates once and retries the call. It
    is surfaced as its own type so the retry-once rule is explicit rather than a
    magic number buried in a handler.
    """


class TBOPriceChanged(TBOError):
    """A re-price (FareQuote / PreBook / Book VerifyPrice) returned a new fare.

    Carries both amounts so the caller can decide. Like an expired session this
    is a normal branch of the flow — we never book, ticket or voucher at a
    price the customer did not see and agree to.
    """

    def __init__(self, handle: str, shown_amount: str, now_amount: str, currency: str) -> None:
        self.handle = handle
        self.shown_amount = shown_amount
        self.now_amount = now_amount
        self.currency = currency
        super().__init__(
            f"{handle} was {shown_amount} {currency}, is now {now_amount} {currency}"
        )
