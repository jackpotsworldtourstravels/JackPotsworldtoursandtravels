"""A sandbox gateway must never quietly collect from the public.

WHY THIS EXISTS
HDFC SmartGateway pointed at a UAT host takes no money, yet every layer above
the adapter treats a UAT "CHARGED" like any other: the payment is captured, the
booking is confirmed, the customer sees "Payment Successful". On a deployed
host that is a customer told they paid when they did not. It happened: the host
ran PAYMENT_PROVIDER=hdfc with PAYMENT_ENVIRONMENT=test (which is the DEFAULT)
and a UAT base URL, and nothing refused that combination, because the adapter
only checks that the host matches the environment value -- and UAT plus "test"
is a consistent pair.

WHAT IS DECIDED HERE, AND ON WHAT EVIDENCE
Sandbox is decided by the gateway host, not by PAYMENT_ENVIRONMENT. That
variable defaults to "test", so a rule keyed on it would also break a real live
host that never set it. The UAT hostname is a fact; a default is not.

THE RULE, on a deployed host (DEPLOYED=true) with a UAT HDFC gateway:

    1. By default nobody can open a checkout: get_provider() raises
       :class:`SandboxPaymentsBlocked`, the public payments config reports "not
       configured", checkout answers 503, and the startup log says why.
    2. A controlled test needs BOTH ALLOW_SANDBOX_PAYMENTS=true AND a non-empty
       SANDBOX_PAYMENT_CUSTOMER_IDS. The flag alone allows nobody -- an empty
       list is a closed door, never "every customer".
    3. Even then only the listed customers may open a checkout, decided on the
       server from the authenticated session. A customer id sent by the browser
       is never read.

WHAT THIS DELIBERATELY DOES NOT TOUCH
Orders that are already open. The return URL, the webhook, reconcile and the
stale-payment sweep resolve HDFC by NAME (``get_hdfc_provider``) and are never
gated: a customer who paid an order opened earlier must still be verified,
whatever this host decides about NEW sandbox checkouts.

Local development and CI run with DEPLOYED unset, so none of this applies to
them, and neither does it apply to a laptop reaching UAT through a tunnel.

NOT COVERED (follow-up): Razorpay test keys (rzp_test_...) on a deployed host.
"""
from __future__ import annotations

import logging
from urllib.parse import urlsplit

import app.config
from app.services.payments.base import PaymentMisconfigured

logger = logging.getLogger(__name__)

#: The provider whose sandbox is detectable from configuration today.
_HDFC = "hdfc"

_PUBLIC_MESSAGE = "Online payment is not available on this booking."


class SandboxPaymentsBlocked(PaymentMisconfigured):
    """A sandbox gateway on a deployed host, and this request is not allowed.

    A subclass of :class:`PaymentMisconfigured` on purpose: it is an operator
    fault, so the startup log reports it loudly, while the customer sees the
    same neutral sentence as for any unavailable payment.
    """

    code = "sandbox_payments_blocked"
    customer_message = _PUBLIC_MESSAGE


def _settings(settings=None):
    return settings or app.config.settings


def allowlist(settings=None) -> frozenset[int]:
    """The customer ids permitted to open a sandbox checkout.

    Parsed strictly: anything that is not a plain ASCII integer is ignored, so a
    typo can only SHRINK the list, never widen it.
    """
    raw = str(getattr(_settings(settings), "sandbox_payment_customer_ids", "") or "")
    ids: set[int] = set()
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if part.isascii() and part.isdigit():
            ids.add(int(part))
    return frozenset(ids)


def uat_gateway_selected(settings=None) -> bool:
    """True when HDFC_SG_BASE_URL is one of HDFC's documented UAT hosts."""
    from app.services.payments.hdfc_provider import UAT_HOSTS

    base = str(getattr(_settings(settings), "hdfc_sg_base_url", "") or "").strip()
    host = (urlsplit(base).hostname or "").lower() if base else ""
    return host in UAT_HOSTS


def restricted(provider_name: str | None = _HDFC, settings=None) -> bool:
    """Is NEW collection through this provider restricted on this host?"""
    s = _settings(settings)
    return (
        (provider_name or "").lower() == _HDFC
        and bool(getattr(s, "deployed", False))
        and uat_gateway_selected(s)
    )


def assert_collection_allowed(settings=None) -> None:
    """Raise unless this host may build a COLLECTING HDFC adapter.

    Called when the configured provider is built, so every path that opens a
    checkout (``get_provider`` and everything above it) fails closed together.
    """
    s = _settings(settings)
    if not restricted(_HDFC, s):
        return
    if not bool(getattr(s, "allow_sandbox_payments", False)):
        raise SandboxPaymentsBlocked(
            "PAYMENT_PROVIDER=hdfc points at an HDFC UAT (sandbox) host on a deployed "
            "host (DEPLOYED=true). A sandbox takes no money but confirms bookings, so "
            "public checkout is refused. Use HDFC's production host with "
            "PAYMENT_ENVIRONMENT=live for real payments, or, for a controlled test, "
            "set ALLOW_SANDBOX_PAYMENTS=true together with SANDBOX_PAYMENT_CUSTOMER_IDS."
        )
    if not allowlist(s):
        raise SandboxPaymentsBlocked(
            "ALLOW_SANDBOX_PAYMENTS=true needs SANDBOX_PAYMENT_CUSTOMER_IDS (a "
            "comma-separated list of customer ids). An empty list allows nobody."
        )


def customer_may_use(provider_name: str | None, customer) -> bool:
    """May THIS authenticated customer open a checkout with this provider?

    ``customer`` is the server-resolved account (or None for an anonymous
    request). Never a value taken from the request body or query string.
    """
    if not restricted(provider_name):
        return True
    customer_id = getattr(customer, "customer_id", None)
    # An int and nothing else: a string "11", or True (== 1), must not match.
    return (
        isinstance(customer_id, int)
        and not isinstance(customer_id, bool)
        and customer_id in allowlist()
    )


def require_customer_access(provider, customer) -> None:
    """The per-customer gate every checkout entry point calls.

    Called AFTER the provider is resolved and BEFORE any order is opened or any
    row is written, and also before an already-open order is handed back: a
    customer who is not allowed gets nothing from a sandbox.
    """
    name = getattr(provider, "name", None)
    if customer_may_use(name, customer):
        return
    logger.warning(
        "Sandbox checkout refused: provider=%s customer_id=%s is not on the "
        "sandbox allowlist.", name, getattr(customer, "customer_id", None),
    )
    raise SandboxPaymentsBlocked("Customer is not on the sandbox payment allowlist.")
