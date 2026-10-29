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

THE RULE: FAIL CLOSED ON A DEPLOYED HOST (DEPLOYED=true)
HDFC may COLLECT on a deployed host in exactly two configurations, and nothing
else is allowed:

    PRODUCTION   PAYMENT_ENVIRONMENT=live AND a gateway host that is explicitly
                 one of HDFC's known PRODUCTION hosts.
    SANDBOX      ALLOW_SANDBOX_PAYMENTS=true AND a non-empty
                 SANDBOX_PAYMENT_CUSTOMER_IDS AND a gateway host that is
                 explicitly one of HDFC's known UAT hosts; and then only the
                 listed customers may open a checkout.

The gateway host is judged by :func:`classify_gateway`, which recognises a host
only when the WHOLE base URL is exactly what the adapter documents (https, no
credentials, default port, no path) and the lower-cased hostname is in
``UAT_HOSTS`` / ``PRODUCTION_HOSTS``. A trailing dot, an alias, an unknown host,
a userinfo trick or an unparseable URL is "unknown", and an unknown host never
collects on a deployed host, flag or no flag. (An earlier version recognised only
UAT hosts, so a mistyped or aliased UAT host fell outside the rule.)

Sandbox is judged by the gateway host, not by PAYMENT_ENVIRONMENT. That
variable defaults to "test", so a rule keyed on it would also misjudge a real
live host that never set it.

THE PER-CUSTOMER GATE
:func:`require_customer_access` is called by every checkout entry point after the
provider is resolved and BEFORE any order is created. It is called again on the
provider that actually opened an EXISTING order when a checkout is resumed: the
configured provider and the provider holding an old order can differ (PAYMENT_PROVIDER
switched, a pilot booking routed elsewhere), and a resume hands the customer that
order's payment link. The customer is the authenticated server-side account;
an id sent by the browser is never read.

WHAT THIS DELIBERATELY DOES NOT TOUCH
Verification. The return URL, the webhook, reconcile and the stale-payment sweep
resolve HDFC by NAME (``get_hdfc_provider``) and are never gated: a customer who
paid an order opened earlier must still be verified, whatever this host decides
about NEW checkouts.

Local development and CI run with DEPLOYED unset, so none of this applies to
them, and neither does it apply to a laptop reaching UAT through a tunnel.

RAZORPAY TEST KEYS
A Razorpay ``rzp_test_`` key id on a deployed host is the same hazard: the
checkout opens, nothing is charged, and the booking can look paid. The same gate
(:func:`require_customer_access` / :func:`customer_may_use`) therefore refuses to
open or resume a Razorpay checkout there -- see :func:`razorpay_test_key_blocked`.
The factory is NOT touched, so a Razorpay payment opened earlier is still
verified (webhook, return, reconcile, sweep). There is no allowlist for it: a
Razorpay test key on a deployed host is simply refused.

TRUSTBRICK TEST KEYS (rzp_test_...) ON A DEPLOYED HOST
TrustBrick holds the Razorpay merchant account, so the mode a TrustBrick
checkout runs in is TrustBrick's, not ours. The only place this platform learns
it is the publishable key: ``TRUSTBRICK_PUBLISHABLE_KEY`` (operator-declared) and
the ``key_id`` TrustBrick returns from every order it opens (what the browser
will actually be given; the adapter remembers it). On a deployed host a
TrustBrick checkout is refused when EITHER starts with ``rzp_test_``
(case-insensitive, trimmed): a test order takes no money yet the booking flow
would show the customer a payment page for it. Live-format, empty and malformed
values are not judged here -- this rule only recognises the test prefix.

Three layers, because the reported key can only be seen in full AFTER TrustBrick
opens an order: (1) :func:`customer_may_use` / :func:`require_customer_access`
before any order or payment row, and again before a resumed order's link is
handed back; (2) the adapter's own ``create_checkout`` refuses a test ``key_id``
before the caller can persist the order id; (3) the public config answers "not
available". Verification, callbacks, webhooks and reconcile resolve TrustBrick
by name and are never gated.

A test ``key_id`` TrustBrick REPORTED is remembered for
``LEARNED_TEST_KEY_TTL_SECONDS`` (5 minutes), so a refused checkout does not ask
TrustBrick again for every customer. When that lapses, exactly ONE checkout is
let through as a probe (a lease, see ``TrustBrickProvider.try_claim_probe``) to
ask again; every other concurrent request stays refused until the probe's reply
lands, so a host whose TrustBrick has moved to live recovers by itself, without a
restart, and a host still in test mode creates one idempotent test-mode order per
window rather than one per request. Residual: before the first reply a process
cannot know TrustBrick's mode, so requests racing in at that moment can each open
a (harmless, no-money, idempotent) test-mode order on TrustBrick's side; none is
ever stored or shown here.
"""
from __future__ import annotations

import logging
from urllib.parse import urlsplit

import app.config
from app.services.payments.base import PaymentMisconfigured

logger = logging.getLogger(__name__)

#: The provider whose sandbox is detectable from configuration today.
_HDFC = "hdfc"
_RAZORPAY = "razorpay"
_TRUSTBRICK = "trustbrick"
_TEST_KEY_PREFIX = "rzp_test_"

#: How long a TEST key TrustBrick reported keeps new checkouts refused before ONE
#: checkout is allowed through to ask again, and how long that probe holds the lease.
LEARNED_TEST_KEY_TTL_SECONDS = 300.0
PROBE_LEASE_SECONDS = 30.0

UAT = "uat"
PRODUCTION = "production"
UNKNOWN = "unknown"

_LIVE = ("live", "production")

_PUBLIC_MESSAGE = "Online payment is not available on this booking."


class SandboxPaymentsBlocked(PaymentMisconfigured):
    """HDFC on a deployed host, in a configuration or for a customer not allowed.

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


def classify_gateway(settings=None) -> str:
    """``"uat"``, ``"production"`` or ``"unknown"`` for HDFC_SG_BASE_URL.

    Recognised only when the entire base URL is exactly an approved origin:
    https, an approved hostname (compared lower-cased, with NO trailing dot), no
    userinfo, the default port, and no path, query or fragment. Everything else
    -- unset, malformed, aliased, trailing-dot, unlisted -- is ``"unknown"``.
    """
    from app.services.payments.hdfc_provider import PRODUCTION_HOSTS, UAT_HOSTS

    base = str(getattr(_settings(settings), "hdfc_sg_base_url", "") or "").strip()
    if not base:
        return UNKNOWN
    try:
        parts = urlsplit(base)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return UNKNOWN
    if (
        parts.scheme != "https"
        or not host
        or parts.username is not None
        or parts.password is not None
        or port not in (None, 443)
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        return UNKNOWN
    host = host.lower()
    if host in UAT_HOSTS:
        return UAT
    if host in PRODUCTION_HOSTS:
        return PRODUCTION
    return UNKNOWN


def _is_approved_production(settings) -> bool:
    env = str(getattr(settings, "payment_environment", "") or "").strip().lower()
    return env in _LIVE and classify_gateway(settings) == PRODUCTION


def restricted(provider_name: str | None = _HDFC, settings=None) -> bool:
    """Is collection through this provider restricted on this host?

    True for HDFC on a deployed host UNLESS it is the approved production
    configuration (live environment on a recognised production host).
    """
    s = _settings(settings)
    return (
        (provider_name or "").lower() == _HDFC
        and bool(getattr(s, "deployed", False))
        and not _is_approved_production(s)
    )


def sandbox_open(settings=None) -> bool:
    """Both controls set AND the gateway is a recognised UAT host."""
    s = _settings(settings)
    return (
        bool(getattr(s, "allow_sandbox_payments", False))
        and bool(allowlist(s))
        and classify_gateway(s) == UAT
    )


def assert_collection_allowed(settings=None) -> None:
    """Raise unless this host may build a COLLECTING HDFC adapter.

    Called when the configured provider is built, so every path that opens a
    checkout (``get_provider`` and everything above it) fails closed together.
    """
    s = _settings(settings)
    if not restricted(_HDFC, s):
        return
    kind = classify_gateway(s)
    if kind != UAT:
        why = (
            "a production host but PAYMENT_ENVIRONMENT is not live"
            if kind == PRODUCTION else
            "not a recognised HDFC host (an unknown, aliased or malformed URL is refused)"
        )
        raise SandboxPaymentsBlocked(
            "PAYMENT_PROVIDER=hdfc on a deployed host (DEPLOYED=true) needs either "
            "PAYMENT_ENVIRONMENT=live with HDFC's recognised PRODUCTION host, or a "
            f"recognised HDFC UAT host together with the sandbox controls. HDFC_SG_BASE_URL is {why}."
        )
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


def is_test_key(key) -> bool:
    """Is this a Razorpay TEST key? Prefix only, case/space-insensitive."""
    return str(key or "").strip().lower().startswith(_TEST_KEY_PREFIX)


def razorpay_test_key_blocked(provider_name: str | None, settings=None) -> bool:
    """Is this Razorpay checkout refused because the key id is a TEST key on a deployed host?

    Judged from RAZORPAY_KEY_ID alone, never from the secret. A missing or
    malformed key id is not "a test key": the adapter's own validation owns that.
    """
    s = _settings(settings)
    if (provider_name or "").lower() != _RAZORPAY or not bool(getattr(s, "deployed", False)):
        return False
    return is_test_key(getattr(s, "razorpay_key_id", None))


def _learned_key_state(provider) -> str | None:
    """``"fresh"`` / ``"expired"`` for a TEST key the adapter holds, else ``None``.

    The real adapter timestamps a key it LEARNED from a TrustBrick reply and lets it
    expire; a key it was only configured with, and any stand-in without the method,
    never expires.
    """
    state = getattr(provider, "learned_test_key_state", None)
    if callable(state):
        return state()
    return "fresh" if is_test_key(getattr(provider, "publishable_key", None)) else None


def trustbrick_test_key_blocked(provider=None, settings=None) -> bool:
    """Would a TrustBrick checkout run on a Razorpay test key on this deployed host?

    Judges the configured ``TRUSTBRICK_PUBLISHABLE_KEY`` and the key the adapter
    has learned from TrustBrick, for as long as that learned key is fresh; either
    one being a test key blocks. Only a deployed host (DEPLOYED=true) is
    restricted. Pure: it never claims the re-check probe (see
    :func:`require_customer_access`).
    """
    s = _settings(settings)
    if not bool(getattr(s, "deployed", False)):
        return False
    return (
        is_test_key(getattr(s, "trustbrick_publishable_key", None))
        or _learned_key_state(provider) == "fresh"
    )


def trustbrick_session_key_blocked(provider=None, settings=None) -> bool:
    """Is the key a TrustBrick checkout would hand the BROWSER a test key, whatever its age?

    The expiry in :func:`trustbrick_test_key_blocked` only decides when ONE probe may re-ask
    TrustBrick; it is not evidence that TrustBrick went live. What ends a block is a reply
    that carries a live key. So once a checkout has been opened, the key it is about to
    return is judged here without any expiry. Deployed hosts only.
    """
    s = _settings(settings)
    if not bool(getattr(s, "deployed", False)):
        return False
    return (
        is_test_key(getattr(s, "trustbrick_publishable_key", None))
        or is_test_key(getattr(provider, "publishable_key", None))
    )


def customer_may_use(provider_name: str | None, customer, provider=None) -> bool:
    """May THIS authenticated customer open or resume a checkout with this provider?

    Self-contained on purpose (it re-checks the flag and the gateway host rather
    than assuming a build-time check ran): a resume reaches HDFC through the
    by-name adapter, which was never subject to the collection guard.

    ``provider`` is the adapter itself, passed so TrustBrick's reported key can
    be judged; HDFC's rule needs only the name.

    ``customer`` is the server-resolved account (or None for an anonymous
    request). Never a value taken from the request body or query string.
    """
    name = (provider_name or "").lower()
    if name == _RAZORPAY and razorpay_test_key_blocked(name):
        return False
    if name == _TRUSTBRICK:
        return not trustbrick_test_key_blocked(provider)
    if not restricted(provider_name):
        return True
    if not sandbox_open():
        return False
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
    row is written, and again on the provider that holds an existing order before
    its payment link is handed back: a customer who is not allowed gets nothing
    from a sandbox.
    """
    name = getattr(provider, "name", None)
    name_l = (name or "").lower()
    if (
        name_l == _TRUSTBRICK
        and _learned_key_state(provider) == "expired"
        and not trustbrick_test_key_blocked(provider)
    ):
        # The learned TEST key has lapsed: let ONE checkout through to ask TrustBrick
        # again. Everyone else stays refused until that reply lands (or the lease
        # lapses), so a recovering host does not open a test order per request.
        claim = getattr(provider, "try_claim_probe", None)
        if callable(claim) and not claim():
            logger.warning(
                "TrustBrick checkout refused: a re-check of TrustBrick's Razorpay mode is "
                "already in flight after a test key was reported on a deployed host."
            )
            raise SandboxPaymentsBlocked(
                "TrustBrick previously reported a Razorpay test key on a deployed host; "
                "a re-check is in progress."
            )
    if customer_may_use(name, customer, provider):
        return
    if name_l == _RAZORPAY and razorpay_test_key_blocked(name):
        logger.error(
            "Razorpay checkout refused: RAZORPAY_KEY_ID is a test key (rzp_test_...) on "
            "a deployed host (DEPLOYED=true). Configure the live key, or use a "
            "non-deployed environment for test keys."
        )
        raise SandboxPaymentsBlocked(
            "RAZORPAY_KEY_ID is a test key on a deployed host (DEPLOYED=true); "
            "new Razorpay checkouts are refused."
        )
    if name_l == _TRUSTBRICK:
        # No key value in the log: the prefix is the whole diagnosis.
        logger.error(
            "TrustBrick checkout refused: the TrustBrick/Razorpay publishable key is "
            "a TEST key (rzp_test_) on a deployed host (DEPLOYED=true). Fix "
            "TRUSTBRICK_PUBLISHABLE_KEY and/or switch TrustBrick's Razorpay account to "
            "live mode (a reported test key is re-checked automatically after "
            "%d seconds).", int(LEARNED_TEST_KEY_TTL_SECONDS),
        )
        raise SandboxPaymentsBlocked("TrustBrick is reporting a Razorpay test key on a deployed host.")
    logger.warning(
        "Sandbox checkout refused: provider=%s customer_id=%s is not permitted "
        "(sandbox payments are closed or the customer is not on the allowlist).",
        name, getattr(customer, "customer_id", None),
    )
    raise SandboxPaymentsBlocked("Customer may not open a checkout with this provider.")
