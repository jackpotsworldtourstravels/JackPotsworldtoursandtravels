"""A sandbox gateway must never quietly collect from the public.

Nothing here opens a socket or moves money: HDFC's API is ``FakeHDFC``, the
database is SQLite, and settings are monkeypatched per test.

What is pinned, by area:

  * THE DEFAULT        a deployed host with HDFC pointed at a UAT host refuses
                       every new checkout, and says why in the startup log.
  * THE TWO CONTROLS   ALLOW_SANDBOX_PAYMENTS plus a non-empty
                       SANDBOX_PAYMENT_CUSTOMER_IDS; the flag alone allows
                       nobody, and the list is parsed so a typo can only shrink it.
  * WHO MAY CHECK OUT  decided on the server from the authenticated session, at
                       every checkout entry point; a browser-supplied id is never read.
  * THE PUBLIC CONFIG  the same answer the checkout would give THIS caller, and
                       never a hint that an allowlist exists.
  * NOT AFFECTED       local development, a laptop on a UAT tunnel, a live host on
                       HDFC's production host, and PAYMENT_PROVIDER=none.
  * CALLBACKS          return URL, webhook, reconcile sweep and by-name resolution
                       keep working for orders that are already open.
"""

from __future__ import annotations

import ast
import datetime as dt
import inspect
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select

import app.config
from app.auth.customer_deps import get_current_customer, get_current_customer_optional
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_customer import (
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingAddon,
    CustomerHotelBookingGuest,
    CustomerHotelBookingPayment,
    CustomerHotelBookingRoom,
    CustomerPaymentStatus,
)
from app.routers import customer_hotel_bookings, customer_package_bookings
from app.routers import payment_returns, payment_webhooks
from app.services import customer_booking_service, customer_hotel_booking_service as hotel_service
from app.services import customer_package_booking_service
from app.services import payment_verification_service as verification
from app.services import payments as P
from app.services.payments import hdfc_readiness, sandbox_guard
from tests.hdfc_fakes import (
    API_KEY,
    BASE,
    MERCHANT,
    WEBHOOK_PASS,
    FakeHDFC,
    FakeResponse,
    session_doc,
    webhook_body,
)

# Reuse the end-to-end harness (real adapter, real SQLite, fake HDFC HTTP).
from tests.test_hdfc_flow import (  # noqa: F401  (fixtures are used by name)
    AUTH,
    FRONTEND,
    KEY,
    OID,
    REF,
    _confirmations,
    _reload,
    _signed_return,
    _status_api,
    booking,
    hdb,
)
from tests.test_hdfc_production import (  # noqa: F401
    PROD_BASE,
    _customer_of,
    _fresh_provider_cache,
    _live_settings,
    _set,
    _uat_settings,
)

NEUTRAL = "Online payment is not available on this booking."


def _deployed_uat(monkeypatch, **over):
    """The incident: a public host, HDFC UAT, PAYMENT_ENVIRONMENT left at test."""
    _uat_settings(monkeypatch)
    _set(monkeypatch, deployed=True, allow_sandbox_payments=False,
         sandbox_payment_customer_ids="")
    if over:
        _set(monkeypatch, **over)


def _person(customer_id):
    return SimpleNamespace(customer_id=customer_id)


# ===========================================================================
# The default: closed
# ===========================================================================
def test_deployed_uat_gateway_is_refused_by_default(monkeypatch):
    _deployed_uat(monkeypatch)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        P.get_provider()

    assert isinstance(exc.value, P.PaymentMisconfigured)       # an operator fault
    assert exc.value.code == "sandbox_payments_blocked"
    assert exc.value.customer_message == NEUTRAL
    assert P.available_for_booking(None) is None
    assert P.available_for_booking(REF) is None
    fault = P.configuration_error()
    assert fault and "UAT" in fault and "ALLOW_SANDBOX_PAYMENTS" in fault
    for secret in (API_KEY, WEBHOOK_PASS):
        assert secret not in fault


def test_the_flag_without_an_allowlist_allows_nobody(monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="")
    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        P.get_provider()
    assert "SANDBOX_PAYMENT_CUSTOMER_IDS" in str(exc.value)

    # A list with nothing usable in it is an empty list, not "everybody".
    _set(monkeypatch, sandbox_payment_customer_ids=" , ;abc, -3 ,")
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.get_provider()


def test_an_allowlist_without_the_flag_allows_nobody(monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=False, sandbox_payment_customer_ids="11")
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.get_provider()


@pytest.mark.parametrize("raw,expected", [
    ("", set()),
    ("11", {11}),
    ("11, 42;7", {7, 11, 42}),
    ("11,abc,  ,-3,4.5,0x10", {11}),          # junk can only shrink the list
    ("١٢,²,11", {11}),                        # non-ASCII digits are not ids
    (None, set()),
])
def test_allowlist_is_parsed_strictly(monkeypatch, raw, expected):
    _set(monkeypatch, sandbox_payment_customer_ids=raw)
    assert sandbox_guard.allowlist() == frozenset(expected)


# ===========================================================================
# The two controls together
# ===========================================================================
def test_flag_and_allowlist_together_build_the_adapter(monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="11")
    assert P.get_provider().name == "hdfc"


def test_every_customer_but_the_allowlisted_is_refused_by_the_gate(monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids="11, 42")
    provider = P.get_provider()

    P.require_customer_access(provider, _person(11))
    P.require_customer_access(provider, _person(42))
    for refused in (_person(12), _person(None), _person("11"), _person(True), None,
                    object()):
        with pytest.raises(P.SandboxPaymentsBlocked):
            P.require_customer_access(provider, refused)


def test_disabled_flag_refuses_even_an_allowlisted_customer(monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=False, sandbox_payment_customer_ids="11")
    assert P.available_for_customer(None, _person(11)) is None


# ===========================================================================
# Not affected
# ===========================================================================
def test_local_development_and_a_uat_tunnel_are_not_affected(monkeypatch):
    _uat_settings(monkeypatch)                    # deployed=False, no controls set
    provider = P.get_provider()
    assert provider.name == "hdfc"
    P.require_customer_access(provider, _person(12345))
    assert P.available_for_customer(None, None) is provider
    assert P.available_for_customer(None, _person(12345)) is provider


def test_a_live_host_on_hdfcs_production_host_is_not_affected(monkeypatch):
    _live_settings(monkeypatch, allow_sandbox_payments=False, sandbox_payment_customer_ids="")
    provider = P.get_provider()
    assert provider.name == "hdfc"
    P.require_customer_access(provider, _person(12345))
    assert P.available_for_customer(None, None) is provider


def test_payments_off_is_still_a_choice_not_a_fault(monkeypatch):
    _deployed_uat(monkeypatch, payment_provider="none")
    with pytest.raises(P.PaymentNotConfigured) as exc:
        P.get_provider()
    assert not isinstance(exc.value, P.SandboxPaymentsBlocked)
    assert P.configuration_error() is None


def test_other_providers_are_not_gated_by_the_hdfc_rule(monkeypatch):
    # The guard keys on HDFC's UAT host. A different provider's gate is a
    # separate follow-up (Razorpay test keys), not this change.
    _deployed_uat(monkeypatch)
    assert not sandbox_guard.restricted("razorpay")
    assert sandbox_guard.customer_may_use("razorpay", None)


# ===========================================================================
# Callbacks for orders that are already open keep working
# ===========================================================================
def test_by_name_resolution_still_finds_hdfc_while_collection_is_blocked(monkeypatch):
    _deployed_uat(monkeypatch)
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.get_provider()

    verifier = P.get_provider_named("hdfc")

    assert verifier.name == "hdfc"
    # ...and the verifying adapter did not leak into the collecting slot.
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.get_provider()


@pytest.fixture()
def callbacks(hdb, monkeypatch):
    """The return and webhook routes over the REAL by-name resolver, with the
    sandbox guard tripped (deployed host, UAT gateway, both controls off)."""
    _deployed_uat(monkeypatch)
    monkeypatch.setattr(limiter, "enabled", False)
    api = FastAPI()
    api.state.limiter = limiter
    api.include_router(payment_webhooks.router)
    api.include_router(payment_returns.router)

    def _db():
        yield hdb

    api.dependency_overrides[get_db] = _db
    return TestClient(api, follow_redirects=False)


def test_the_webhook_still_verifies_and_confirms_an_open_order(callbacks, hdb, booking, monkeypatch):
    _status_api(monkeypatch)
    r = callbacks.post("/api/webhooks/payments/hdfc", content=webhook_body(OID), headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == "processed"
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(hdb) == 1


def test_the_webhook_still_rejects_bad_credentials(callbacks, hdb, booking, monkeypatch):
    fake = _status_api(monkeypatch)
    r = callbacks.post("/api/webhooks/payments/hdfc", content=webhook_body(OID),
                       headers={"Authorization": "Basic Zm9vOmJhcg=="})
    assert r.status_code == 401 and fake.calls == []


def test_the_return_url_still_verifies_server_side(callbacks, hdb, booking, monkeypatch):
    fake = _status_api(monkeypatch)
    r = callbacks.get("/api/payments/hdfc/return", params=_signed_return())
    assert r.status_code == 303
    assert r.headers["location"].startswith(f"{FRONTEND}/my-bookings.html?")
    assert fake.count("GET", f"/orders/{OID}") == 1
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value


def test_the_reconcile_sweep_still_settles_an_open_order(monkeypatch, hdb, booking):
    _deployed_uat(monkeypatch)
    _, pay = booking
    pay.created_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)
    hdb.commit()
    fake = _status_api(monkeypatch)

    tally = verification.reconcile_stale_pending(hdb)

    assert tally["seen"] == 1 and tally["captured"] == 1
    assert fake.count("GET", f"/orders/{OID}") == 1
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value


# ===========================================================================
# Checkout: enforced on the server, at the service every route goes through
# ===========================================================================
def _payment_rows(hdb) -> int:
    return hdb.execute(
        select(func.count()).select_from(CustomerHotelBookingPayment)
    ).scalar_one()


def test_a_customer_not_on_the_allowlist_gets_no_checkout(monkeypatch, hdb, booking):
    b, _ = booking
    customer = _customer_of(hdb, booking)
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids=str(customer.customer_id + 1))
    fake = FakeHDFC(monkeypatch, {})
    before = _payment_rows(hdb)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        hotel_service.start_checkout(hdb, customer, b, idempotency_key="mb-JPH000777-new-1")

    assert exc.value.customer_message == NEUTRAL
    assert fake.calls == []                                   # HDFC never contacted
    assert _payment_rows(hdb) == before                       # nothing written
    assert hdb.get(CustomerHotelBooking, b.customer_hotel_booking_id).status \
        == CustomerBookingStatus.PENDING.value


def test_resuming_an_open_order_is_also_refused_to_a_blocked_customer(monkeypatch, hdb, booking):
    b, _ = booking
    customer = _customer_of(hdb, booking)
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids=str(customer.customer_id + 1))
    fake = _status_api(monkeypatch, status="NEW")

    with pytest.raises(P.SandboxPaymentsBlocked):
        hotel_service.start_checkout(hdb, customer, b, idempotency_key=KEY)   # the open order's key

    assert fake.calls == []


def test_an_allowlisted_customer_can_open_a_checkout(monkeypatch, hdb, booking):
    b, _ = booking
    customer = _customer_of(hdb, booking)
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids=f"1, {customer.customer_id}")
    new_key = "mb-JPH000777-allowed"
    from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
    new_oid = HDFCSmartGatewayProvider.order_id_for(REF, new_key)
    fake = FakeHDFC(monkeypatch, {
        "POST /session": FakeResponse(200, session_doc(new_oid, amount="56.00")),
    })

    row, session = hotel_service.start_checkout(hdb, customer, b, idempotency_key=new_key)

    assert session.order_id == new_oid and row.provider == "hdfc"
    assert row.status == CustomerPaymentStatus.PENDING.value
    assert fake.count("POST", "/session") == 1


def test_with_the_flag_off_even_an_allowlisted_customer_is_refused(monkeypatch, hdb, booking):
    b, _ = booking
    customer = _customer_of(hdb, booking)
    _deployed_uat(monkeypatch, allow_sandbox_payments=False,
                  sandbox_payment_customer_ids=str(customer.customer_id))
    fake = FakeHDFC(monkeypatch, {})
    with pytest.raises(P.SandboxPaymentsBlocked):
        hotel_service.start_checkout(hdb, customer, b, idempotency_key="mb-JPH000777-flagoff")
    assert fake.calls == []


@pytest.mark.parametrize("module", [
    customer_booking_service, hotel_service, customer_package_booking_service,
])
def test_every_checkout_entry_point_applies_the_gate(module):
    """flights, hotels and packages each resolve the provider and call the
    per-customer gate BEFORE any order is created, and call it AGAIN on the
    provider that holds an existing order BEFORE its payment link is rebuilt.
    Pinned structurally so a new or refactored entry point cannot skip it."""
    tree = ast.parse(inspect.getsource(module.start_checkout))
    calls: list[tuple[int, int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = (node.func.attr if isinstance(node.func, ast.Attribute)
                    else getattr(node.func, "id", None))
            if name:
                calls.append((node.lineno, node.col_offset, name))
    names = [n for _, _, n in sorted(calls)]
    gates = [i for i, n in enumerate(names) if n == "require_customer_access"]
    assert len(gates) >= 2, "the gate must run on the configured provider AND the opener"
    assert names.index("get_provider_for_booking") < gates[0]
    assert gates[1] < names.index("_session_for"), "resume must be gated before the link is rebuilt"
    assert gates[0] < names.index("create_checkout")


def test_the_hotel_checkout_route_answers_503_with_a_neutral_message(monkeypatch, hdb, booking):
    b, _ = booking
    customer = _customer_of(hdb, booking)
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids=str(customer.customer_id + 1))
    fake = FakeHDFC(monkeypatch, {})
    # The route loads the booking with its rooms, guests and add-ons; the shared
    # harness only creates the tables the verifier needs.
    for model in (CustomerHotelBookingRoom, CustomerHotelBookingGuest,
                  CustomerHotelBookingAddon):
        model.__table__.create(hdb.get_bind(), checkfirst=True)
    monkeypatch.setattr(limiter, "enabled", False)
    api = FastAPI()
    api.state.limiter = limiter
    api.include_router(customer_hotel_bookings.router)

    def _db():
        yield hdb

    api.dependency_overrides[get_db] = _db
    api.dependency_overrides[get_current_customer] = lambda: customer
    client = TestClient(api, follow_redirects=False)

    # The browser supplying an id of its own changes nothing: there is no field
    # for one, and nothing reads it.
    r = client.post(f"/api/customer/hotel-bookings/{REF}/checkout?customer_id={customer.customer_id}",
                    json={"idempotency_key": "mb-JPH000777-route-1",
                          "customer_id": customer.customer_id})

    assert r.status_code == 503
    assert r.json()["detail"] == NEUTRAL
    assert fake.calls == []


# ===========================================================================
# The public payments config: the same answer the checkout would give THIS caller
# ===========================================================================
@pytest.fixture()
def config_client(hdb):
    api = FastAPI()
    api.include_router(customer_package_bookings.router)
    state = {"customer": None}

    def _db():
        yield hdb

    api.dependency_overrides[get_db] = _db
    api.dependency_overrides[get_current_customer_optional] = lambda: state["customer"]
    client = TestClient(api, follow_redirects=False)
    client.as_customer = lambda c: state.update(customer=c)
    return client


def _config(client):
    r = client.get("/api/customer/payments/config")
    assert r.status_code == 200
    return r


def test_config_offers_nothing_to_anyone_by_default(config_client, monkeypatch):
    _deployed_uat(monkeypatch)
    for caller in (None, _person(11)):
        config_client.as_customer(caller)
        body = _config(config_client).json()
        assert body["configured"] is False
        assert body["provider"] is None and body["key_id"] is None


def test_config_is_offered_only_to_allowlisted_customers(config_client, monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids="4242, 4343")

    config_client.as_customer(_person(4242))
    allowed = _config(config_client)
    assert allowed.json()["configured"] is True
    assert allowed.json()["provider"] == "hdfc" and allowed.json()["key_id"] == MERCHANT

    for caller in (None, _person(7), _person("4242")):
        config_client.as_customer(caller)
        refused = _config(config_client)
        assert refused.json()["configured"] is False
        assert refused.json()["provider"] is None and refused.json()["key_id"] is None
        # Indistinguishable from "payments are off", and never names the list.
        assert "4242" not in refused.text and "4343" not in refused.text

    assert "4343" not in allowed.text                       # nor does the allowed one


def test_config_ignores_an_id_in_the_query_string(config_client, monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="4242")
    config_client.as_customer(None)
    r = config_client.get("/api/customer/payments/config?customer_id=4242&booking_ref=JPH000001")
    assert r.json()["configured"] is False


def test_config_is_unchanged_for_local_development(config_client, monkeypatch):
    _uat_settings(monkeypatch)                              # deployed=False
    for caller in (None, _person(5)):
        config_client.as_customer(caller)
        body = _config(config_client).json()
        assert body["configured"] is True and body["provider"] == "hdfc"
        assert body["key_id"] == MERCHANT


# ===========================================================================
# The operator is told, loudly, and no secret is printed
# ===========================================================================
def test_startup_logs_an_error_when_the_guard_trips(monkeypatch, caplog):
    _deployed_uat(monkeypatch)
    with caplog.at_level("INFO"):
        P.check_configuration_at_startup()
    assert "PAYMENTS ARE MISCONFIGURED" in caplog.text
    assert "ALLOW_SANDBOX_PAYMENTS" in caplog.text
    for secret in (API_KEY, WEBHOOK_PASS):
        assert secret not in caplog.text


def test_startup_warns_on_every_boot_while_sandbox_payments_are_open(monkeypatch, caplog):
    _deployed_uat(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="11,12")
    with caplog.at_level("INFO"):
        P.check_configuration_at_startup()
    assert "SANDBOX PAYMENTS ARE ENABLED" in caplog.text and "2 allowlisted" in caplog.text
    for secret in (API_KEY, WEBHOOK_PASS):
        assert secret not in caplog.text


def test_startup_is_quiet_about_sandboxes_off_a_deployed_host(monkeypatch, caplog):
    _uat_settings(monkeypatch)
    with caplog.at_level("INFO"):
        P.check_configuration_at_startup()
    assert "SANDBOX PAYMENTS" not in caplog.text
    assert "MISCONFIGURED" not in caplog.text


def _readiness(monkeypatch, **over):
    _deployed_uat(monkeypatch, **over)
    return {c.name: c for c in hdfc_readiness.evaluate()}


def test_readiness_reports_each_state_of_the_sandbox_controls(monkeypatch):
    closed = _readiness(monkeypatch)
    assert closed["SANDBOX_PAYMENTS"].level == hdfc_readiness.PASS
    assert "refused" in closed["SANDBOX_PAYMENTS"].detail
    assert closed["adapter"].level == hdfc_readiness.PASS     # built without the guard

    empty = _readiness(monkeypatch, allow_sandbox_payments=True)
    assert empty["SANDBOX_PAYMENTS"].level == hdfc_readiness.WARN
    assert "nobody" in empty["SANDBOX_PAYMENTS"].detail

    opened = _readiness(monkeypatch, allow_sandbox_payments=True,
                        sandbox_payment_customer_ids="11")
    assert opened["SANDBOX_PAYMENTS"].level == hdfc_readiness.WARN
    assert "1 allowlisted" in opened["SANDBOX_PAYMENTS"].detail


def test_readiness_has_no_sandbox_line_off_a_deployed_host(monkeypatch):
    _uat_settings(monkeypatch)
    names = {c.name for c in hdfc_readiness.evaluate()}
    assert "SANDBOX_PAYMENTS" not in names
