"""The contract every payment provider implements.

WHY THIS FILE EXISTS AT ALL
The booking flow must not know which payment provider is configured. Everything
above this line — the Pay Now endpoint, the checkout page, the webhook handler,
the admin screen — is written against :class:`CheckoutSession`,
:class:`ProviderPayment` and :class:`ProviderEvent`, and swapping Razorpay for
Cashfree, PayU or anyone else is a new module in this package plus one
environment variable. Nothing in ``customer_package_booking_service`` imports a
vendor SDK, and no vendor status word reaches the database's ``status`` column.

Same shape as ``app/services/passport_ocr/`` deliberately: a Protocol here, one
module per vendor, a cached factory in ``__init__``. One pattern to learn.

THE MONEY IS AN INTEGER NUMBER OF PAISE, EVERYWHERE BELOW THIS LINE
Razorpay, and every Indian aggregator, takes and returns the minor unit. Our
tables store ``Numeric(12, 2)`` rupees, which is right for a ledger. The
conversion happens in exactly two functions — :func:`to_minor` and
:func:`from_minor` — because a float rupee that has been through
``amount * 100`` is how ₹1,12,999.99 becomes 11299998 paise and a customer is
charged a paisa less than they agreed. ``Decimal`` throughout, never ``float``.

WHAT A PROVIDER IS NOT ALLOWED TO DECIDE
Not the amount, not the currency, not whose booking this is. The adapter is
asked to collect a figure the caller computed from the database, and on the way
back it reports what the provider said happened. Verification — does this
amount match, does this currency match, does this booking belong to this
customer — is done by the service above, against our own rows, for every
provider. An adapter that verified its own payments would be a provider marking
its own homework.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Protocol

# ---------------------------------------------------------------------------
# Status vocabulary
# ---------------------------------------------------------------------------
#: Our words for where a payment stands. These are the values of
#: ``CustomerPaymentStatus`` and are what every adapter maps a vendor's status
#: onto. Kept as plain strings here so this module has no import back into the
#: models — the contract must be usable by a test that never touches a database.
PENDING = "pending"
PROCESSING = "processing"
AUTHORIZED = "authorized"
CAPTURED = "captured"
FAILED = "failed"
CANCELLED = "cancelled"
EXPIRED = "expired"
REFUNDED = "refunded"

#: The only state in which money has arrived and been verified.
TERMINAL_SUCCESS = frozenset({CAPTURED})
#: States that will never change again on their own. A reconciliation pass can
#: stop asking about these.
TERMINAL = frozenset({CAPTURED, FAILED, CANCELLED, EXPIRED, REFUNDED})

#: Order matters: a webhook may arrive out of order, and a payment that is
#: already ``captured`` must not be dragged back to ``processing`` by a late
#: delivery of an earlier event. The service compares ranks, not equality.
_RANK = {
    PENDING: 0,
    PROCESSING: 1,
    AUTHORIZED: 2,
    CAPTURED: 3,
    # The unhappy terminals sit above the happy path's non-terminal states but
    # below CAPTURED: a failure that arrives after a verified capture is a
    # reconciliation matter for a human, never an automatic downgrade.
    FAILED: 2,
    CANCELLED: 2,
    EXPIRED: 2,
    REFUNDED: 4,
}


def rank(status: str) -> int:
    """How far along the lifecycle a status is. Unknown sorts lowest."""
    return _RANK.get(status, -1)


def is_forward(current: str, incoming: str) -> bool:
    """May ``incoming`` replace ``current``?

    False for a repeat of the same state (nothing to do) and for anything that
    would move a payment backwards. This is what makes an out-of-order or
    duplicated webhook harmless without the handler having to enumerate pairs.
    """
    return rank(incoming) > rank(current)


# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------
#: The only currency this platform collects. An adapter that is handed anything
#: else raises rather than guessing — see PaymentProviderError subclasses.
INR = "INR"

#: Minor units per major unit, by currency. INR and GBP are both 100; the map
#: exists so a zero-decimal currency (JPY) cannot be silently multiplied by 100
#: if one is ever added.
_MINOR_UNITS = {"INR": 100, "GBP": 100, "EUR": 100, "USD": 100}


def to_minor(amount: Decimal | str | int, currency: str = INR) -> int:
    """Rupees to paise, exactly.

    Takes ``Decimal`` or the string a ``Numeric`` column yields. A ``float`` is
    accepted only after being routed through ``str`` by the caller — passing one
    directly is a quantisation bug waiting to happen, and this raises on the
    fractional paise that would result.
    """
    factor = _MINOR_UNITS.get(currency.upper())
    if factor is None:
        raise PaymentMisconfigured(f"No minor-unit rule for currency {currency!r}.")
    try:
        value = Decimal(str(amount))
    except (InvalidOperation, ValueError) as exc:
        raise PaymentFailed(f"Not a usable amount: {amount!r}") from exc
    minor = value * factor
    if minor != minor.to_integral_value():
        raise PaymentFailed(
            f"{value} {currency} is not a whole number of minor units — "
            "a payment cannot be for a fraction of a paisa."
        )
    return int(minor)


def from_minor(minor: int, currency: str = INR) -> Decimal:
    """Paise back to rupees, as a Decimal. Never a float."""
    factor = _MINOR_UNITS.get(currency.upper())
    if factor is None:
        raise PaymentMisconfigured(f"No minor-unit rule for currency {currency!r}.")
    return (Decimal(int(minor)) / Decimal(factor)).quantize(Decimal("0.01"))


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class PaymentProviderError(Exception):
    """Base for anything that stops a payment being created or resolved."""

    #: Short, stable, safe to show a customer and to branch on in a test.
    code = "payment_failed"
    #: What the customer is told. Never contains a provider message verbatim —
    #: those leak internal detail and are written for developers.
    customer_message = "We couldn't start the payment. Please try again."

    def __init__(self, *args: Any, code: str | None = None) -> None:
        super().__init__(*args)
        if code:
            self.code = code


class PaymentNotConfigured(PaymentProviderError):
    """No provider is selected on this deployment. Not a fault — a choice.

    Mirrors ``OCRNotConfigured``: a deployment that has never configured
    payments offers no Pay Now rather than a button that fails.
    """

    code = "payment_not_configured"
    customer_message = "Online payment is not available on this booking."


class PaymentMisconfigured(PaymentProviderError):
    """A provider was selected and cannot run. An operator has to fix it."""

    code = "payment_misconfigured"


class PaymentFailed(PaymentProviderError):
    """The provider was reached and refused, or answered something unusable."""

    code = "payment_failed"


class PaymentTimeout(PaymentProviderError):
    """The provider did not answer in time.

    SEPARATE FROM PaymentFailed ON PURPOSE. A timeout on order creation means
    we do not know whether an order exists, so the caller must reuse the same
    idempotency key on retry rather than creating a second one.
    """

    code = "payment_timeout"
    customer_message = (
        "The payment service didn't respond in time. Please try again in a moment."
    )


class WebhookVerificationError(PaymentProviderError):
    """A webhook body did not verify. It is discarded, not processed.

    Raised before the payload is parsed or stored. An unverified body is not
    evidence of anything, and treating it as an event would let anyone who can
    reach the endpoint confirm any booking.
    """

    code = "webhook_invalid_signature"


# ---------------------------------------------------------------------------
# Values crossing the boundary
# ---------------------------------------------------------------------------
@dataclasses.dataclass(frozen=True)
class CheckoutSession:
    """Everything the browser needs to open the provider's checkout.

    DELIBERATELY CONTAINS NO SECRET. The publishable key identifies the merchant
    account to the provider's own script and is meant to be public; the key
    secret and the webhook secret never leave the server, and there is no field
    here that could carry one by accident.
    """

    #: The provider's order id. Stored on the payment row.
    order_id: str
    #: Minor units, echoed back from the provider so the client and the server
    #: cannot disagree about the figure.
    amount_minor: int
    currency: str
    #: The publishable identifier the provider's client script needs.
    publishable_key: str
    #: Which adapter produced this. The frontend uses it to pick a renderer.
    provider: str
    #: A hosted page to send the customer to, when the provider offers one.
    #: ``None`` for a drop-in — see the checkout notes in the router.
    redirect_url: str | None = None
    #: Anything else the client script needs, provider-specific and non-secret
    #: (prefill, theme, notes). Kept opaque so adding a field is not a schema
    #: change all the way up.
    options: Mapping[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass(frozen=True)
class ProviderPayment:
    """What the provider says about one payment, normalised.

    The adapter fills this from a webhook body or from a status API call, and
    the two must agree — the same mapping function serves both, so a status
    that would be read one way by the webhook path cannot be read another way
    by reconciliation.
    """

    #: Our vocabulary, never the vendor's. One of the module constants above.
    status: str
    #: The vendor's own word, kept for the operator and for the audit row.
    provider_status: str
    #: The provider's payment identifier. ``None`` before a customer has paid.
    provider_payment_id: str | None = None
    #: The order the payment belongs to.
    provider_order_id: str | None = None
    #: Minor units, as the provider reports them. Compared against our own
    #: figure by the service, never trusted as the amount to record.
    amount_minor: int | None = None
    currency: str | None = None
    #: "upi", "card", "netbanking"… as the provider reports it, lowercased.
    method: str | None = None
    #: Provider-supplied failure detail. Shown to staff, not to the customer.
    failure_reason: str | None = None
    #: When the provider says the money arrived.
    paid_at: dt.datetime | None = None
    #: The untouched provider object, for the event log.
    raw: Mapping[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass(frozen=True)
class ProviderEvent:
    """One verified webhook delivery, normalised.

    ``event_id`` IS REQUIRED AND MUST COME FROM THE PROVIDER. It is half of the
    unique key that makes a redelivery collide in the database instead of being
    processed twice. An adapter that cannot produce one must raise rather than
    invent a value — a synthesised id (a hash of the body, a uuid) would be
    different on every delivery and would defeat the guarantee entirely.
    """

    event_id: str
    event_type: str
    #: The payment this event is about, if it is about one at all. Events that
    #: concern no payment are recorded and ignored rather than dropped.
    payment: ProviderPayment | None
    #: Did the adapter RECOGNISE this event type, or merely parse it?
    #:
    #: WHY THIS IS NOT INFERRED FROM ``payment.status``. An unsubscribed event
    #: still carries an entity, and that entity still has a status: a dispute
    #: notification about a captured payment carries ``captured``. Reading the
    #: entity would therefore route an event nobody handles into the capture
    #: path on the strength of a word that was never an assertion about this
    #: event. The adapter knows which types it maps; this is it saying so.
    supported: bool = True
    raw: Mapping[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass(frozen=True)
class ProviderRefund:
    """What the provider says about one refund."""

    provider_refund_id: str
    status: str
    provider_status: str
    amount_minor: int
    currency: str
    raw: Mapping[str, Any] = dataclasses.field(default_factory=dict)


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------
class PaymentProvider(Protocol):
    """What a payment adapter has to provide.

    Deliberately synchronous, like the OCR providers: the callers are ordinary
    request handlers, and the one long call (order creation) is bounded by the
    adapter's own timeout rather than by making the application async.
    """

    #: Stable identifier stored on every row this provider produces. Half of
    #: every unique index in migration 0062, so it must never change for a
    #: provider that has live rows.
    name: str

    #: The publishable key the browser needs. Never the secret.
    publishable_key: str

    def create_checkout(
        self,
        *,
        amount_minor: int,
        currency: str,
        reference: str,
        idempotency_key: str,
        customer: Mapping[str, Any] | None = None,
        notes: Mapping[str, Any] | None = None,
        may_exist: bool = False,
    ) -> CheckoutSession:
        """Open an order with the provider for an amount the CALLER computed.

        ``reference`` is our booking reference, for the provider's dashboard and
        for reconciliation. ``idempotency_key`` must make a repeated call return
        the same order rather than opening a second one.

        ``may_exist`` tells the adapter that an order for this key may ALREADY
        have been opened by an attempt that failed before recording its id. An
        adapter whose provider genuinely honours the key can ignore it; one
        whose provider does not — Razorpay does not, see
        ``razorpay_provider``'s module docstring — must look the order up
        BEFORE creating, because after a timeout neither side knows whether one
        exists, and creating one to find out is what opens the second order.
        """
        ...

    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment:
        """Ask the provider what actually happened. The reconciliation path."""
        ...

    def fetch_order(self, provider_order_id: str) -> ProviderPayment:
        """Ask about an order when no payment id is known yet."""
        ...

    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        """Verify a signature over the RAW BYTES, then parse.

        Raises :class:`WebhookVerificationError` if the signature does not
        match. Must not parse, decode or re-serialise the body before the
        comparison: a signature is over bytes, and JSON round-tripping changes
        them.
        """
        ...

    def capture(
        self, *, provider_payment_id: str, amount_minor: int, currency: str
    ) -> ProviderPayment:
        """Move an AUTHORIZED payment to captured for an amount WE computed.

        Only called when an authenticated re-fetch has already shown the
        payment to be ``authorized`` and every check has passed. It is not
        called for a payment the provider already reports as captured — most
        providers reject that, and issuing it would turn a healthy reconcile
        into a spurious error.

        ``amount_minor`` is the caller's figure, from the booking row. A capture
        for an amount the provider did not authorise is refused by the provider,
        which is the last line of defence behind our own comparison.
        """
        ...

    def refund(
        self,
        *,
        provider_payment_id: str,
        amount_minor: int,
        idempotency_key: str,
        notes: Mapping[str, Any] | None = None,
    ) -> ProviderRefund:
        """Refund all or part of a captured payment.

        Raises :class:`PaymentProviderError` with code ``refund_unsupported``
        if the provider has no refund API, so the caller can report that rather
        than pretending money went back.
        """
        ...


__all__ = [
    "PENDING", "PROCESSING", "AUTHORIZED", "CAPTURED",
    "FAILED", "CANCELLED", "EXPIRED", "REFUNDED",
    "TERMINAL", "TERMINAL_SUCCESS", "INR",
    "rank", "is_forward", "to_minor", "from_minor",
    "PaymentProviderError", "PaymentNotConfigured", "PaymentMisconfigured",
    "PaymentFailed", "PaymentTimeout", "WebhookVerificationError",
    "CheckoutSession", "ProviderPayment", "ProviderEvent", "ProviderRefund",
    "PaymentProvider",
]
