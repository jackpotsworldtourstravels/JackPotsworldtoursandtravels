"""HDFC SmartGateway — sandbox verification suite.

Three sandbox-safe cases, requested for the testing/sandbox (UAT) phase. Nothing
here opens a socket or moves money: HDFC's API is the ``FakeHDFC`` transport, the
database is SQLite, settings are monkeypatched per test, and every assertion runs
against the REAL production functions (no logic is re-implemented in the test).

  1. UAT allow-listed customer checkout — a deployed UAT host collects only for a
     listed customer, and fails closed on an unlisted customer, an unknown host,
     or a half-configured sandbox.  (app.services.payments.sandbox_guard)
  2. Captured-order JSON — a representative HDFC UAT Order Status document mapped
     through the adapter's own ``_payment_from``; an unknown status is never a
     success.  (HDFCSmartGatewayProvider._payment_from)
  3. UAT webhook de-duplication — a recorded webhook body through the adapter's
     Basic-auth check and the payment-event dedup path; a duplicate delivery
     neither re-processes nor re-captures, and invalid auth is refused.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.models_customer import (
    CustomerBookingStatus,
    CustomerPaymentStatus,
    PaymentProviderEvent,
)
from app.services import payment_event_service as events
from app.services import payments as P
from app.services.payments import base as payment_base
from app.services.payments import sandbox_guard
from app.services.payments.base import (
    AUTHORIZED,
    CANCELLED,
    CAPTURED,
    FAILED,
    INR,
    PENDING,
    PROCESSING,
    REFUNDED,
    WebhookVerificationError,
)
from tests.hdfc_fakes import (
    WEBHOOK_PASS,
    WEBHOOK_USER,
    basic,
    make_provider,
    order_doc,
    webhook_body,
)

# Settings helpers + the autouse provider-cache reset (reused, not re-written).
from tests.test_hdfc_production import (  # noqa: F401  (fixtures used by name)
    _fresh_provider_cache,
    _set,
    _uat_settings,
)
from tests.test_sandbox_payment_guard import _deployed_uat, _person

# The end-to-end webhook harness: real adapter + real SQLite + fake HDFC HTTP.
from tests.test_hdfc_flow import (  # noqa: F401  (fixtures used by name)
    AUTH,
    OID,
    _confirmations,
    _deliver,
    _reload,
    _status_api,
    booking,
    hdb,
    provider,
)


# ===========================================================================
# 1. UAT allow-listed customer checkout (and fail-closed everywhere else)
# ===========================================================================
def test_sandbox_allowlisted_customer_may_checkout_on_uat_host(monkeypatch):
    """A deployed UAT host, with BOTH controls set, lets a listed customer open
    a checkout — the build-time collection guard and the per-customer guard agree,
    and the collecting HDFC adapter actually builds."""
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids="4242, 777")

    assert sandbox_guard.classify_gateway() == sandbox_guard.UAT
    sandbox_guard.assert_collection_allowed()          # build-time gate: does not raise
    assert sandbox_guard.sandbox_open() is True
    assert P.get_provider().name == "hdfc"             # the collecting adapter builds

    assert sandbox_guard.customer_may_use("hdfc", _person(4242)) is True
    assert sandbox_guard.customer_may_use("hdfc", _person(777)) is True


def test_sandbox_non_allowlisted_customer_is_refused(monkeypatch):
    """Only the listed ids may check out; a browser-supplied string or a bool
    must never match a real int id, and an anonymous caller is refused."""
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids="4242")

    assert sandbox_guard.customer_may_use("hdfc", _person(4242)) is True
    assert sandbox_guard.customer_may_use("hdfc", _person(99)) is False
    # Type-confusion: "4242" (str) and True (== 1) must not pass as customer ids.
    assert sandbox_guard.customer_may_use("hdfc", _person("4242")) is False
    assert sandbox_guard.customer_may_use("hdfc", _person(True)) is False
    # Anonymous request on a restricted host.
    assert sandbox_guard.customer_may_use("hdfc", None) is False


def test_unknown_host_and_unsafe_configs_fail_closed(monkeypatch):
    """Three unsafe configurations, each refused at the build-time gate."""
    # (a) An unknown / aliased host never collects on a deployed host, flag or not.
    _deployed_uat(monkeypatch, hdfc_sg_base_url="https://smartgateway.example.test",
                  allow_sandbox_payments=True, sandbox_payment_customer_ids="4242")
    assert sandbox_guard.classify_gateway() == sandbox_guard.UNKNOWN
    with pytest.raises(P.SandboxPaymentsBlocked):
        sandbox_guard.assert_collection_allowed()
    assert sandbox_guard.customer_may_use("hdfc", _person(4242)) is False

    # (b) A recognised UAT host but the sandbox flag is OFF (the original incident).
    _deployed_uat(monkeypatch)                         # allow_sandbox_payments=False
    assert sandbox_guard.classify_gateway() == sandbox_guard.UAT
    with pytest.raises(P.SandboxPaymentsBlocked):
        sandbox_guard.assert_collection_allowed()

    # (c) Flag ON but the allow-list is empty: it allows nobody.
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids="")
    with pytest.raises(P.SandboxPaymentsBlocked):
        sandbox_guard.assert_collection_allowed()
    assert sandbox_guard.customer_may_use("hdfc", _person(4242)) is False


# ===========================================================================
# 2. Captured-order JSON mapped through the adapter's _payment_from
# ===========================================================================
def test_captured_uat_order_maps_to_a_successful_payment():
    """A representative HDFC UAT 'CHARGED' Order Status document → a CAPTURED
    payment with the amount, currency, order id and payment id intact."""
    provider = make_provider()
    order = order_doc("jpc_booking_123", status="CHARGED", amount=56, currency="INR")

    p = provider._payment_from(order)

    assert p.status == CAPTURED
    assert p.amount_minor == 5600                  # 56.00 INR in paise, Decimal-exact
    assert p.currency == INR
    assert p.provider_order_id == "jpc_booking_123"
    assert p.provider_payment_id == "jpc_booking_123"   # attempted -> id present
    assert p.provider_status == "charged"
    assert p.method == "card"
    assert p.provider_reference == "JPTESTMID-jpc_booking_123-1"


@pytest.mark.parametrize("raw_status, expected", [
    ("CHARGED", CAPTURED),               # the only success
    ("NEW", PENDING),                    # order opened, nothing attempted
    ("PENDING_VBV", PROCESSING),         # authentication in progress
    ("AUTHORIZED", AUTHORIZED),          # pre-auth
    ("AUTHORIZATION_FAILED", FAILED),    # bank refused
    ("VOIDED", CANCELLED),
    ("AUTO_REFUNDED", REFUNDED),
    ("WARP_SPEED_ENGAGED", PENDING),     # UNKNOWN status is never a success
    ("", PENDING),                       # empty status is never a success
])
def test_status_mapping_never_invents_success(raw_status, expected):
    provider = make_provider()
    p = provider._payment_from(order_doc("oid_1", status=raw_status))
    assert p.status == expected
    # CAPTURED is reached only by an actually-charged order; nothing else.
    assert (p.status == CAPTURED) == (raw_status == "CHARGED")
    assert (p.status in payment_base.TERMINAL_SUCCESS) == (raw_status == "CHARGED")


def test_fully_refunded_capture_is_not_a_success():
    """'CHARGED' + refunded=true is money that arrived and went back — REFUNDED,
    never a capture."""
    provider = make_provider()
    p = provider._payment_from(order_doc("oid_2", status="CHARGED", refunded=True))
    assert p.status == REFUNDED
    assert p.status not in payment_base.TERMINAL_SUCCESS


# ===========================================================================
# 3. UAT webhook authentication + payment-event de-duplication
# ===========================================================================
def _event_rows(hdb, event_id: str) -> int:
    return hdb.execute(
        select(func.count()).select_from(PaymentProviderEvent)
        .where(PaymentProviderEvent.provider_event_id == event_id)
    ).scalar_one()


def test_uat_webhook_authenticates_and_dedupes(hdb, provider, booking, monkeypatch):
    """A correctly-authenticated UAT webhook is processed exactly once; a
    duplicate delivery (same event id) is neither re-processed nor re-captured,
    and HDFC's Order Status is asked only once."""
    api = _status_api(monkeypatch, status="CHARGED", amount=56)
    body = webhook_body(OID, event_id="evt_sandbox_dedup")

    first = _deliver(hdb, provider, body)              # valid Basic auth (AUTH)
    second = _deliver(hdb, provider, body)
    third = _deliver(hdb, provider, body)

    assert first[0] == events.PROCESSED
    assert second[0] == third[0] == "duplicate"        # refused by the unique index

    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value   # captured ONCE
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(hdb) == 1                    # booking confirmed once
    assert api.count("GET", f"/orders/{OID}") == 1     # re-read once, not per delivery
    assert _event_rows(hdb, "evt_sandbox_dedup") == 1  # one event row, not three


def test_uat_webhook_rejects_invalid_authentication(hdb, provider, booking, monkeypatch):
    """A delivery that fails Basic-auth is refused before the body is trusted,
    records nothing, and leaves the booking unconfirmed."""
    _status_api(monkeypatch, status="CHARGED")
    body = webhook_body(OID, event_id="evt_sandbox_badauth")

    # Wrong password.
    with pytest.raises(WebhookVerificationError):
        provider.verify_webhook(body, {"Authorization": basic(WEBHOOK_USER, "not-the-pass")})
    # Missing Authorization header entirely.
    with pytest.raises(WebhookVerificationError):
        provider.verify_webhook(body, {})

    # Nothing recorded, nothing confirmed by a rejected delivery.
    assert _event_rows(hdb, "evt_sandbox_badauth") == 0
    b, p = _reload(hdb, booking)
    assert p.status != CustomerPaymentStatus.CAPTURED.value
    assert b.status != CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(hdb) == 0
