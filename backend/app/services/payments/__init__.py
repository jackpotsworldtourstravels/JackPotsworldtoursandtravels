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

    if name == "trustbrick":
        return _build_trustbrick()

    raise PaymentMisconfigured(
        f"Unknown PAYMENT_PROVIDER {name!r}. "
        "Use 'razorpay', 'trustbrick', 'mock' or 'none'."
    )


def _build_trustbrick() -> PaymentProvider:
    """The TrustBrick adapter, from settings. Raises if it cannot run."""
    settings = app.config.settings
    from app.services.payments.trustbrick_provider import TrustBrickProvider

    return TrustBrickProvider(
        base_url=settings.trustbrick_base_url or "",
        key_id=settings.trustbrick_key_id or "",
        secret=settings.trustbrick_secret or "",
        callback_secret=settings.trustbrick_callback_secret or "",
        timeout_seconds=settings.trustbrick_timeout_seconds,
        publishable_key=settings.trustbrick_publishable_key or "",
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


# ---------------------------------------------------------------------------
# TrustBrick, alongside the configured provider rather than instead of it
# ---------------------------------------------------------------------------
# WHY THERE IS A SECOND SLOT AT ALL
# TrustBrick has to be reachable while PAYMENT_PROVIDER is still ``razorpay``,
# for two reasons that have nothing to do with each other:
#
#   1. a pilot booking is routed to it explicitly (see get_provider_for_booking)
#      while every other booking keeps the live Razorpay path;
#   2. its callback arrives at /api/webhooks/payments/trustbrick, and that route
#      resolves the adapter by NAME — so a delivery for a payment TrustBrick
#      collected must find the TrustBrick adapter even though it is not the
#      configured default.
#
# Making TrustBrick the global provider would satisfy (2) and break (1). This
# slot satisfies both without either provider knowing about the other.
_cached_trustbrick: PaymentProvider | None = None


def get_trustbrick_provider() -> PaymentProvider:
    """The TrustBrick adapter, whatever PAYMENT_PROVIDER says.

    Raises :class:`PaymentNotConfigured` when TrustBrick has no settings, so a
    deployment that has never configured it behaves exactly as it does today.
    """
    global _cached_trustbrick
    settings = app.config.settings
    if not (settings.trustbrick_base_url and settings.trustbrick_key_id
            and settings.trustbrick_secret and settings.trustbrick_callback_secret):
        raise PaymentNotConfigured(
            "TrustBrick partner payments are not configured on this deployment."
        )
    if _cached_trustbrick is not None:
        return _cached_trustbrick
    with _lock:
        if _cached_trustbrick is None:
            _cached_trustbrick = _build_trustbrick()
        return _cached_trustbrick


def trustbrick_is_available() -> bool:
    try:
        get_trustbrick_provider()
        return True
    except PaymentProviderError:
        return False


def available_for_booking(booking_ref: str | None = None) -> PaymentProvider | None:
    """The adapter that would collect for THIS booking, or None if none would.

    The booking-aware counterpart of :func:`is_available`,
    :func:`provider_name` and :func:`publishable_key`, which answer for the
    deployment as a whole. That global answer is wrong for a pilot: with
    PAYMENT_PROVIDER unset, the deployment offers no payment, and yet a booking
    named in TRUSTBRICK_PILOT_BOOKING_REFS can still be collected for. A
    checkout screen asking "can this booking be paid?" was getting the answer to
    "can any booking be paid?" and hiding a Pay Now that would have worked.

    Returns the provider rather than a response shape: what the API chooses to
    publish is the router's business, and nothing below this line should know
    the field names of an HTTP payload.

    ``None`` for a booking that cannot be paid for, which is the same answer a
    deployment with no provider gives for every booking. That symmetry is
    deliberate - an unknown or non-pilot reference is indistinguishable from
    "payments are off", so this cannot be used to test whether a booking exists.
    """
    try:
        if booking_ref:
            return get_provider_for_booking(booking_ref)
        return get_provider()
    except PaymentProviderError:
        return None


def _pilot_refs() -> frozenset[str]:
    raw = getattr(app.config.settings, "trustbrick_pilot_booking_refs", "") or ""
    return frozenset(part.strip().upper() for part in raw.split(",") if part.strip())


def get_provider_for_booking(booking_ref: str) -> PaymentProvider:
    """Which adapter should collect for THIS booking.

    FAILS CLOSED, AND SILENTLY CHANGES NOTHING.
    With ``TRUSTBRICK_PILOT_BOOKING_REFS`` unset — the default — this is
    ``get_provider()`` and the live Razorpay path is untouched for every
    booking. A reference named in that setting, and only such a reference, is
    routed to TrustBrick.

    A pilot reference on a deployment where TrustBrick is NOT configured falls
    back to the ordinary provider rather than failing: a half-configured pilot
    must not stop a customer paying.
    """
    ref = (booking_ref or "").strip().upper()
    if ref and ref in _pilot_refs():
        try:
            provider = get_trustbrick_provider()
        except PaymentProviderError as exc:
            logger.warning(
                "%s is listed as a TrustBrick pilot booking but TrustBrick is "
                "not usable (%s); falling back to the configured provider.",
                ref, exc,
            )
        else:
            logger.info("Routing %s through TrustBrick (pilot).", ref)
            return provider
    return get_provider()


def get_provider_named(name: str) -> PaymentProvider:
    """The configured provider, but only if it is the one asked for.

    The webhook route is addressed by provider name so the URL a provider is
    given never becomes ambiguous. This is what stops a delivery meant for one
    provider being verified with another's secret — which would fail anyway,
    but would fail as "bad signature" rather than as the routing mistake it is.
    """
    wanted = (name or "").strip().lower()

    # TrustBrick is resolvable by name even when it is not the configured
    # default, because its callback route addresses it by name and a payment it
    # collected must be verifiable regardless of what PAYMENT_PROVIDER says.
    # Checked before the default so a deployment that has switched over to
    # TrustBrick globally still resolves it through one path.
    if wanted == "trustbrick":
        return get_trustbrick_provider()

    provider = get_provider()
    if provider.name != wanted:
        raise PaymentNotConfigured(
            f"No provider named {name!r} is configured on this deployment."
        )
    return provider


def reset_provider_cache() -> None:
    """Drop the cached providers. For tests that change the configuration."""
    global _cached, _cached_trustbrick
    with _lock:
        _cached = None
        _cached_trustbrick = None


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
    "get_provider_for_booking",
    "available_for_booking",
    "get_trustbrick_provider",
    "trustbrick_is_available",
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
