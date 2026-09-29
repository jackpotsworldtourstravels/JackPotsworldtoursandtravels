"""What can go wrong talking to Duffel, as types the caller can act on.

Same three-way split the Hotelbeds integration draws, for the same reason —
CONFIGURATION vs TRANSPORT vs REFUSAL each deserve an opposite response:

  * no token, or a token that is not a ``duffel_test_`` token, is a deployment
    fact — retrying cannot help, and the caller should fall back to the demo
    provider (or refuse) with one clear message, not alarm anyone;
  * a timeout is weather — a search may well work a moment later, and a search
    is a safe read to try again;
  * a 4xx/5xx from Duffel is a REFUSAL that carries the supplier's own error
    code, and some of them (an expired or unavailable offer, a price change)
    are normal parts of the flow the booking path must branch on rather than
    treat as a crash.

None of these ever carries the access token. See ``safe_detail`` in the client.
"""
from __future__ import annotations


class DuffelError(Exception):
    """Base class — catch this to mean "the Duffel leg failed"."""


class DuffelNotConfigured(DuffelError):
    """No access token, or a token that is not a ``duffel_test_`` token.

    Its own type on purpose: it is the expected state of a checkout that has
    not opted into Duffel, and the correct handling is to stay on the demo
    provider with an explanation, never to point live credentials at anything.

    THE GUARD IS DELIBERATELY POSITIVE. The client refuses to start unless the
    token begins with ``duffel_test_``; a blank token, a live ``duffel_live_``
    token, or anything else all land here. Going to production is therefore a
    deliberate code change, not something a stray environment variable can do.
    """


class DuffelTimeout(DuffelError):
    """Duffel did not answer inside the configured timeout.

    Safe to retry for reads (offer requests, fetching an offer, seat maps).
    NOT safe to retry for order creation — Duffel documents no idempotency key
    for ``POST /air/orders``, so a blind retry can double-book. That asymmetry
    is enforced in the client, not left to callers.
    """


class DuffelTransportError(DuffelError):
    """The request never completed — DNS, TLS, connection reset, unreadable body."""


class DuffelAPIError(DuffelError):
    """Duffel answered, and the answer was a refusal.

    Attributes:
        status: HTTP status code.
        code: Duffel's own ``errors[].code`` when it sent one (e.g.
            ``offer_no_longer_available``), which the flow branches on.
        title: Duffel's ``errors[].title``.
        detail: Sanitised message safe to log and, where appropriate, surface.
    """

    def __init__(
        self,
        status: int,
        detail: str,
        code: str | None = None,
        title: str | None = None,
    ) -> None:
        self.status = int(status)
        self.code = code
        self.title = title
        self.detail = detail
        super().__init__(f"Duffel {self.status}{f' [{code}]' if code else ''}: {detail}")


class DuffelOfferExpired(DuffelAPIError):
    """The offer being priced or booked is no longer valid.

    Raised for Duffel's ``offer_no_longer_available`` /
    ``offer_request_already_actioned`` family, and when a re-fetched offer has
    an ``expires_at`` in the past. It is NOT a crash: the booking path turns it
    into "prices have moved, please search again" and never books on stale data.
    """


class DuffelPriceChanged(DuffelError):
    """A re-fetched offer costs a different amount than the one shown.

    Carries both amounts so the caller can decide. Like an expired offer, this
    is a normal branch of the flow — we never book at a price the customer did
    not see.
    """

    def __init__(self, offer_id: str, shown_amount: str, now_amount: str, currency: str) -> None:
        self.offer_id = offer_id
        self.shown_amount = shown_amount
        self.now_amount = now_amount
        self.currency = currency
        super().__init__(
            f"Offer {offer_id} was {shown_amount} {currency}, is now {now_amount} {currency}"
        )
