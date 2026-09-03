"""Payments: one contract, one adapter per provider, chosen by configuration.

    Pay Now  -> POST /api/customer/package-bookings/{ref}/pay
             -> customer_package_booking_service     (booking, amount, rows, audit)
             -> get_provider()                       (this module)
             -> RazorpayProvider                     (or another adapter)
             -> CheckoutSession                      (order id + publishable key)
             -> the browser's drop-in checkout

    money in -> POST /api/webhooks/payments/{provider}
             -> verify_webhook() on the adapter      (raw bytes, before parsing)
             -> payment_event_service                (dedupe, verify, capture)
             -> customer_package_booking_service     (payment + booking, one txn)

Nothing above ``get_provider`` knows which provider is configured, and nothing
below it knows about bookings. Adding Cashfree or PayU is a new module
implementing :class:`~base.PaymentProvider` plus a branch in :func:`_build`; no
caller changes.

Same shape as ``app/services/passport_ocr/`` on purpose — the module import
rather than a bound ``settings``, the cached instance, the reset hook for
tests, the startup check that logs rather than raises. One pattern to learn.

A CONFIGURATION FAULT IS NOT CACHED.
:class:`~base.PaymentNotConfigured` is re-raised on every call rather than
frozen as a permanently dead provider, so setting the environment variables and
restarting is the whole fix — and a deployment that has never configured
payments answers "unavailable" and offers no Pay Now, rather than crashing at
import.
"""
from __future__ import annotations

import logging
import threading

# The MODULE, not `from app.config import settings`. `reset_provider_cache()`
# exists so a test can point the platform at the mock provider and back, and a
# bound reference would still be reading the settings object that existed at
# import time. Same reasoning as passport_ocr/__init__.py.
import app.config
from app.services.payments.base import (  # re-exported: this is the public surface
    AUTHORIZED,
    CANCELLED,
    CAPTURED,
    EXPIRED,
    FAILED,
    INR,
    PENDING,
    PROCESSING,
    REFUNDED,
    TERMINAL,
    TERMINAL_SUCCESS,
    CheckoutSession,
    PaymentFailed,
    PaymentMisconfigured,
    PaymentNotConfigured,
    PaymentProvider,
    PaymentProviderError,
    PaymentTimeout,
    ProviderEvent,
    ProviderPayment,
    ProviderRefund,
    WebhookVerificationError,
    from_minor,
    is_forward,
    rank,
    to_minor,
)

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_cached: PaymentProvider | None = None

#: Values of PAYMENT_PROVIDER that mean "offer no online payment at all".
_OFF = ("", "none", "off", "disabled")


def _build() -> PaymentProvider:
    settings = app.config.settings
    name = (getattr(settings, "payment_provider", "") or "").strip().lower()

    if name in _OFF:
        raise PaymentNotConfigured(
            "Online payment is not enabled on this deployment. "
            "Set PAYMENT_PROVIDER to switch it on."
        )

    if name == "razorpay":
        from app.services.payments.razorpay_provider import RazorpayProvider

        return RazorpayProvider(
            key_id=settings.razorpay_key_id,
            key_secret=settings.razorpay_key_secret,
            webhook_secret=settings.razorpay_webhook_secret,
            timeout_seconds=settings.payment_timeout_seconds,
        )

    if name == "mock":
        # REFUSED WHERE IT COULD TAKE A REAL CUSTOMER'S BOOKING.
        # The mock opens orders that can never be paid. On a local or CI host
        # that is the point; on a deployment with a live frontend it would show
        # travellers a Pay Now that silently goes nowhere. `payment_environment`
        # must say `test` for this to be selectable, which an operator has to
        # set deliberately.
        env = (getattr(settings, "payment_environment", "test") or "").strip().lower()
        if env not in ("test", "sandbox", "local"):
            raise PaymentMisconfigured(
                "PAYMENT_PROVIDER=mock is only allowed when PAYMENT_ENVIRONMENT "
                f"is test/sandbox/local (it is {env!r}). The mock takes no money "
                "and can never report a payment, so on a live host it would give "
                "travellers a Pay Now button that does nothing."
            )
        from app.services.payments.mock_provider import MockPaymentProvider

        return MockPaymentProvider(
            key_id=settings.razorpay_key_id or "mock_key",
            secret=settings.razorpay_webhook_secret or "mock_secret",
        )

    raise PaymentMisconfigured(
        f"Unknown PAYMENT_PROVIDER {name!r}. Use 'razorpay', 'mock' or 'none'."
    )


def get_provider() -> PaymentProvider:
    """The configured provider, or raise :class:`PaymentNotConfigured`."""
    global _cached
    if _cached is not None:
        return _cached
    with _lock:
        if _cached is None:
            _cached = _build()
        return _cached


def get_provider_named(name: str) -> PaymentProvider:
    """The configured provider, but only if it is the one asked for.

    The webhook route is addressed by provider name so the URL a provider is
    given never becomes ambiguous. This is what stops a delivery meant for one
    provider being verified with another's secret — which would fail anyway,
    but would fail as "bad signature" rather than as the routing mistake it is.
    """
    provider = get_provider()
    if provider.name != (name or "").strip().lower():
        raise PaymentNotConfigured(
            f"No provider named {name!r} is configured on this deployment."
        )
    return provider


def reset_provider_cache() -> None:
    """Drop the cached provider. For tests that change the configuration."""
    global _cached
    with _lock:
        _cached = None


def is_available() -> bool:
    """Can a customer be offered Pay Now at all?

    Asked by the endpoint the checkout calls on load, so a deployment without
    payments renders the honest "no payment is taken yet" notice it renders
    today rather than a button that fails.
    """
    try:
        get_provider()
        return True
    except PaymentProviderError:
        return False


def provider_name() -> str | None:
    """The configured provider's stable name, or None when payments are off."""
    try:
        return get_provider().name
    except PaymentProviderError:
        return None


def publishable_key() -> str | None:
    """The key the browser is allowed to see, or None. NEVER the secret."""
    try:
        return get_provider().publishable_key
    except PaymentProviderError:
        return None


def configuration_error() -> str | None:
    """The operator-facing fault, if a provider was selected and cannot run.

    ``None`` covers both healthy states — a working provider, and ``none``,
    which is a deliberate choice rather than a fault.
    """
    try:
        get_provider()
        return None
    except PaymentMisconfigured as exc:
        return str(exc)
    except PaymentProviderError:
        return None


def check_configuration_at_startup() -> None:
    """Log loudly if payments are selected and broken. Called from main.py.

    A log and not a raise, for the same reason OCR is: a bad payment key must
    not stop the platform from taking bookings — the booking is written first
    and paid for second — but it must also never be discovered only because a
    customer mentioned that Pay Now did nothing.
    """
    fault = configuration_error()
    if fault:
        logger.error(
            "PAYMENTS ARE MISCONFIGURED and no customer will be able to pay: %s",
            fault,
        )
        return
    if not is_available():
        logger.info("Online payment is off (PAYMENT_PROVIDER is not set).")
        return

    settings = app.config.settings
    env = (getattr(settings, "payment_environment", "test") or "test").lower()
    logger.info(
        "Payments enabled: provider=%s environment=%s", provider_name(), env,
    )
    if env in ("live", "production"):
        # Live money. Say so on every boot, the way OTP_DEV_ECHO does, so a host
        # that was switched to live by accident announces it rather than being
        # discovered by a customer's bank statement.
        logger.warning(
            "PAYMENT_ENVIRONMENT=%s — this host takes REAL money from customers.",
            env,
        )


__all__ = [
    "get_provider",
    "get_provider_named",
    "reset_provider_cache",
    "is_available",
    "provider_name",
    "publishable_key",
    "configuration_error",
    "check_configuration_at_startup",
    # contract
    "PaymentProvider",
    "CheckoutSession",
    "ProviderPayment",
    "ProviderEvent",
    "ProviderRefund",
    "PaymentProviderError",
    "PaymentNotConfigured",
    "PaymentMisconfigured",
    "PaymentFailed",
    "PaymentTimeout",
    "WebhookVerificationError",
    # vocabulary + money
    "PENDING", "PROCESSING", "AUTHORIZED", "CAPTURED",
    "FAILED", "CANCELLED", "EXPIRED", "REFUNDED",
    "TERMINAL", "TERMINAL_SUCCESS", "INR",
    "to_minor", "from_minor", "rank", "is_forward",
]
