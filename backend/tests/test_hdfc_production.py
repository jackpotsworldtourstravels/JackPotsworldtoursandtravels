"""Production readiness of the HDFC SmartGateway integration.

Nothing here opens a socket or moves money: HDFC's API is ``FakeHDFC``, the
database is SQLite, and settings are monkeypatched per test.

What is pinned, by area:

  * LOCAL DEMO vs REAL      payment_mode(): demo only on a laptop, never when
                            deployed or live.
  * MOCK IN PRODUCTION      PAYMENT_PROVIDER=mock is refused on a deployed or
                            live host, even when PAYMENT_ENVIRONMENT was left
                            at its default.
  * LIVE CONFIGURATION      the refusals only a live deployment gets, and the
                            read-only readiness checklist (which must never
                            print a secret).
  * INITIATION              Pay Now twice opens one HDFC order; the order is
                            bound to the booking's own amount.
  * RECOVERY                the sweep that settles payments no return/webhook
                            reached, across all three products, and survives an
                            HDFC outage without writing anything.
"""

from __future__ import annotations

import datetime as dt
import decimal

import pytest

import app.config
from app.models_customer import (
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
    PaymentProviderEvent,
)
from app.services import customer_hotel_booking_service as hotel_service
from app.services import payment_event_service as events
from app.services import payment_verification_service as verification
from app.services import payments as P
from app.services.payments import hdfc_readiness
from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
from tests.hdfc_fakes import (
    API_KEY,
    BASE,
    MERCHANT,
    RESPONSE_KEY,
    WEBHOOK_PASS,
    WEBHOOK_USER,
    FakeHDFC,
    FakeResponse,
    make_provider,
    order_doc,
    session_doc,
    webhook_body,
)

# Reuse the end-to-end harness (real adapter, real SQLite, fake HDFC HTTP).
from tests.test_hdfc_flow import (  # noqa: F401  (fixtures are used by name)
    AUTH,
    KEY,
    OID,
    REF,
    _confirmations,
    _deliver,
    _reload,
    _status_api,
    booking,
    hdb,
    provider,
)

PROD_BASE = "https://smartgateway.hdfc.bank.in"
LIVE_FRONT = "https://jackpotsworldtours.com"
LIVE_RETURN = "https://jackpotsworldtours.com/api/payments/hdfc/return"
LIVE_WEBHOOK_PASS = "a-long-live-webhook-secret-42"


def _set(monkeypatch, **values):
    s = app.config.settings
    for k, v in values.items():
        monkeypatch.setattr(s, k, v)
    P.reset_provider_cache()


@pytest.fixture(autouse=True)
def _fresh_provider_cache():
    P.reset_provider_cache()
    yield
    P.reset_provider_cache()


def _live_settings(monkeypatch, **overrides):
    values = dict(
        payment_provider="hdfc", payment_environment="live", payment_mode="",
        deployed=True, frontend_base_url=LIVE_FRONT,
        hdfc_sg_base_url=PROD_BASE, hdfc_sg_merchant_id=MERCHANT,
        hdfc_sg_api_key=API_KEY, hdfc_sg_client_id=None,
        hdfc_sg_webhook_username=WEBHOOK_USER, hdfc_sg_webhook_password=LIVE_WEBHOOK_PASS,
        hdfc_sg_response_key=RESPONSE_KEY, hdfc_sg_return_url=None,
        payment_sweep_enabled=True,
    )
    values.update(overrides)
    _set(monkeypatch, **values)


# ===========================================================================
# Local demo vs real
# ===========================================================================
@pytest.mark.parametrize("asked,deployed,env,expected", [
    ("", False, "test", "demo"),            # a laptop with no configuration
    ("demo", False, "test", "demo"),
    ("real", False, "test", "real"),        # gateway path tested locally
    ("", True, "test", "real"),             # a server needs no configuration
    ("demo", True, "test", "real"),         # demo refused when deployed
    ("", False, "live", "real"),
    ("demo", False, "live", "real"),        # demo refused when live
    ("demo", False, "production", "real"),
    ("something-odd", False, "test", "real"),   # unknown never means demo
])
def test_payment_mode_matrix(monkeypatch, asked, deployed, env, expected):
    _set(monkeypatch, payment_mode=asked, deployed=deployed, payment_environment=env)
    assert P.payment_mode() == expected


# ===========================================================================
# Production rejects the mock provider
# ===========================================================================
def test_mock_provider_allowed_on_a_local_test_host(monkeypatch):
    _set(monkeypatch, payment_provider="mock", payment_environment="test", deployed=False)
    assert P.get_provider().name == "mock"


def test_mock_provider_refused_on_a_deployed_host_even_with_default_environment(monkeypatch):
    # PAYMENT_ENVIRONMENT left at its default "test": the old guard let this through.
    _set(monkeypatch, payment_provider="mock", payment_environment="test", deployed=True)
    with pytest.raises(P.PaymentMisconfigured) as exc:
        P.get_provider()
    assert "deployed" in str(exc.value)
    assert P.is_available() is False
    assert "deployed" in (P.configuration_error() or "")


@pytest.mark.parametrize("env", ["live", "production"])
def test_mock_provider_refused_when_live(monkeypatch, env):
    _set(monkeypatch, payment_provider="mock", payment_environment=env, deployed=False)
    with pytest.raises(P.PaymentMisconfigured):
        P.get_provider()


def test_hdfc_by_name_never_resolves_to_the_mock(monkeypatch):
    """The webhook/return routes address HDFC by name; a mock must not answer."""
    _set(monkeypatch, payment_provider="mock", payment_environment="test", deployed=False,
         hdfc_sg_base_url=None)
    with pytest.raises(P.PaymentNotConfigured):
        P.get_provider_named("hdfc")


# ===========================================================================
# Live configuration
# ===========================================================================
def test_a_correct_live_configuration_builds_the_production_adapter(monkeypatch):
    _live_settings(monkeypatch)
    p = P.get_provider()
    assert p.name == "hdfc"
    # Production: payment_page_client_id is the merchant id, never "hdfcmaster".
    assert p._client_id == MERCHANT
    assert p._base == PROD_BASE


def test_live_refuses_the_uat_client_id():
    with pytest.raises(P.PaymentMisconfigured) as exc:
        make_provider(base_url=PROD_BASE, environment="live", client_id="hdfcmaster",
                      webhook_password=LIVE_WEBHOOK_PASS)
    assert "UAT" in str(exc.value)


def test_live_refuses_a_short_webhook_password():
    with pytest.raises(P.PaymentMisconfigured) as exc:
        make_provider(base_url=PROD_BASE, environment="live", webhook_password="short-pw")
    message = str(exc.value)
    assert "WEBHOOK_PASSWORD" in message and "short-pw" not in message


def test_uat_is_still_allowed_a_short_webhook_password():
    make_provider(webhook_password="short-pw")        # UAT: not enforced


def test_live_refuses_a_localhost_return_url():
    with pytest.raises(P.PaymentMisconfigured):
        make_provider(base_url=PROD_BASE, environment="live",
                      webhook_password=LIVE_WEBHOOK_PASS,
                      return_url="https://localhost/api/payments/hdfc/return")


@pytest.mark.parametrize("front", [
    "http://jackpotsworldtours.com",        # plain http
    "https://localhost",
    "",                                     # unset
])
def test_live_refuses_a_frontend_url_the_customer_cannot_return_to(monkeypatch, front):
    _live_settings(monkeypatch, frontend_base_url=front,
                   hdfc_sg_return_url=LIVE_RETURN)
    with pytest.raises(P.PaymentMisconfigured) as exc:
        P.get_provider()
    assert "FRONTEND_BASE_URL" in str(exc.value)


def test_a_misconfigured_live_host_offers_no_payment_and_says_why(monkeypatch):
    _live_settings(monkeypatch, hdfc_sg_base_url=BASE)      # UAT host while live
    assert P.is_available() is False
    assert P.configuration_error()


# ---- the readiness checklist ----------------------------------------------
def _levels(checks):
    return {c.name: c.level for c in checks}


def test_readiness_passes_for_a_correct_live_configuration(monkeypatch):
    _live_settings(monkeypatch)
    checks = hdfc_readiness.evaluate()
    assert hdfc_readiness.blockers(checks) == []
    assert hdfc_readiness.warnings(checks) == []
    assert "READY" in hdfc_readiness.render(checks)


def test_readiness_blocks_a_test_environment_deployment(monkeypatch):
    _live_settings(monkeypatch, payment_environment="test", hdfc_sg_base_url=BASE)
    levels = _levels(hdfc_readiness.evaluate())
    assert levels["PAYMENT_ENVIRONMENT"] == hdfc_readiness.BLOCK
    assert levels["HDFC_SG_BASE_URL"] == hdfc_readiness.WARN        # UAT, not live: warn


def test_readiness_blocks_uat_host_when_live(monkeypatch):
    _live_settings(monkeypatch, hdfc_sg_base_url=BASE)
    levels = _levels(hdfc_readiness.evaluate())
    assert levels["HDFC_SG_BASE_URL"] == hdfc_readiness.BLOCK
    assert levels["adapter"] == hdfc_readiness.BLOCK


def test_readiness_names_every_missing_setting(monkeypatch):
    _live_settings(monkeypatch, hdfc_sg_merchant_id=None, hdfc_sg_api_key="",
                   hdfc_sg_webhook_username=None, hdfc_sg_webhook_password=None)
    checks = {c.name: c for c in hdfc_readiness.evaluate()}
    detail = checks["required settings"].detail
    for name in ("HDFC_SG_MERCHANT_ID", "HDFC_SG_API_KEY",
                 "HDFC_SG_WEBHOOK_USERNAME", "HDFC_SG_WEBHOOK_PASSWORD"):
        assert name in detail
    assert checks["required settings"].level == hdfc_readiness.BLOCK


def test_readiness_warns_without_a_response_key(monkeypatch):
    _live_settings(monkeypatch, hdfc_sg_response_key=None)
    checks = hdfc_readiness.evaluate()
    assert hdfc_readiness.blockers(checks) == []
    assert _levels(checks)["HDFC_SG_RESPONSE_KEY"] == hdfc_readiness.WARN


def test_readiness_reports_demo_mode_as_a_blocker(monkeypatch):
    # Local, test environment: payment_mode() resolves to demo.
    _live_settings(monkeypatch, payment_environment="test", deployed=False,
                   hdfc_sg_base_url=BASE)
    assert _levels(hdfc_readiness.evaluate())["PAYMENT_MODE"] == hdfc_readiness.BLOCK


def test_readiness_output_never_contains_a_secret(monkeypatch):
    """Every secret in play, in every state of the checklist."""
    secrets = (API_KEY, LIVE_WEBHOOK_PASS, RESPONSE_KEY, "short-secret-pw")
    for overrides in (
        {},                                                     # all good
        {"hdfc_sg_webhook_password": "short-secret-pw"},        # too short
        {"hdfc_sg_base_url": BASE},                             # wrong host
        {"hdfc_sg_response_key": None},
        {"hdfc_sg_client_id": "hdfcmaster"},
    ):
        _live_settings(monkeypatch, **overrides)
        text = hdfc_readiness.render(hdfc_readiness.evaluate())
        for secret in secrets:
            assert secret not in text, f"secret leaked with {overrides}"


def test_startup_warns_but_does_not_log_secrets(monkeypatch, caplog):
    _live_settings(monkeypatch, hdfc_sg_response_key=None)
    with caplog.at_level("INFO"):
        P.check_configuration_at_startup()
    text = caplog.text
    assert "REAL money" in text
    assert "HDFC_SG_RESPONSE_KEY" in text
    for secret in (API_KEY, LIVE_WEBHOOK_PASS):
        assert secret not in text


# ===========================================================================
# Initiation: idempotent, and bound to the booking
# ===========================================================================
def _uat_settings(monkeypatch):
    _set(monkeypatch, payment_provider="hdfc", payment_environment="test",
         deployed=False, frontend_base_url="https://tours.example.test",
         hdfc_sg_base_url=BASE, hdfc_sg_merchant_id=MERCHANT, hdfc_sg_api_key=API_KEY,
         hdfc_sg_client_id=None, hdfc_sg_webhook_username=WEBHOOK_USER,
         hdfc_sg_webhook_password=WEBHOOK_PASS, hdfc_sg_response_key=RESPONSE_KEY,
         hdfc_sg_return_url=None, trustbrick_pilot_booking_refs="")


def _customer_of(hdb, booking):
    from app.models_customer import Customer
    return hdb.get(Customer, booking[0].customer_id)


def test_pay_now_twice_with_the_same_key_opens_one_order(monkeypatch, hdb, booking):
    _uat_settings(monkeypatch)
    b, pay = booking
    fake = FakeHDFC(monkeypatch, {
        f"GET /orders/{OID}": FakeResponse(200, order_doc(OID, status="NEW", amount="56.00")),
    })
    customer = _customer_of(hdb, booking)

    row1, session1 = hotel_service.start_checkout(hdb, customer, b, idempotency_key=KEY)
    row2, session2 = hotel_service.start_checkout(hdb, customer, b, idempotency_key=KEY)

    assert row1.customer_hotel_booking_payment_id == row2.customer_hotel_booking_payment_id \
        == pay.customer_hotel_booking_payment_id
    assert session1.order_id == session2.order_id == OID
    assert fake.count("POST", "/session") == 0              # no second order, ever
    assert session1.redirect_url.startswith(BASE)


def test_a_new_attempt_creates_an_order_bound_to_the_booking_amount(monkeypatch, hdb, booking):
    _uat_settings(monkeypatch)
    b, _ = booking
    new_key = "mb-JPH000777-second"
    new_oid = HDFCSmartGatewayProvider.order_id_for(REF, new_key)
    fake = FakeHDFC(monkeypatch, {
        "POST /session": FakeResponse(200, session_doc(new_oid, amount="56.00")),
    })
    customer = _customer_of(hdb, booking)

    row, session = hotel_service.start_checkout(hdb, customer, b, idempotency_key=new_key)

    assert session.order_id == new_oid
    assert session.amount_minor == 5600 and session.currency == "INR"
    sent = fake.calls[0]["json"]
    # Amount and identity come from OUR booking row, never from the request.
    assert sent["amount"] == "56.00" and sent["currency"] == "INR"
    assert sent["udf1"] == REF and sent["order_id"] == new_oid
    assert sent["customer_id"].startswith("JPC")
    assert row.provider == "hdfc" and row.provider_order_id == new_oid
    assert row.status == CustomerPaymentStatus.PENDING.value     # nothing is paid yet
    assert hdb.get(CustomerHotelBooking, b.customer_hotel_booking_id).status \
        == CustomerBookingStatus.PENDING.value


def test_an_order_for_a_different_amount_is_refused_before_the_customer_sees_it(
        monkeypatch, hdb, booking):
    _uat_settings(monkeypatch)
    b, _ = booking
    new_key = "mb-JPH000777-third"
    new_oid = HDFCSmartGatewayProvider.order_id_for(REF, new_key)
    FakeHDFC(monkeypatch, {
        "POST /session": FakeResponse(200, session_doc(new_oid, amount="1.00")),
    })
    customer = _customer_of(hdb, booking)
    with pytest.raises(hotel_service.HotelBookingError) as exc:
        hotel_service.start_checkout(hdb, customer, b, idempotency_key=new_key)
    assert "different amount" in str(exc.value)


def test_a_booking_belonging_to_someone_else_is_never_opened(monkeypatch, hdb, booking):
    _uat_settings(monkeypatch)
    b, _ = booking
    fake = FakeHDFC(monkeypatch, {})
    other = _customer_of(hdb, booking)
    other = type("Other", (), {"customer_id": other.customer_id + 99})()
    with pytest.raises(hotel_service.HotelBookingError):
        hotel_service.start_checkout(hdb, other, b, idempotency_key="mb-someone-else-1")
    assert fake.calls == []


# ===========================================================================
# Recovery: payments nothing reached us about
# ===========================================================================
def _age(hdb, pay, *, minutes):
    pay.created_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)
    hdb.commit()


def test_stale_pending_payment_is_settled_without_a_return_or_webhook(
        monkeypatch, hdb, booking, provider):
    b, pay = booking
    _age(hdb, pay, minutes=10)
    fake = _status_api(monkeypatch)                         # HDFC says CHARGED, 56.00

    tally = verification.reconcile_stale_pending(hdb)

    assert tally["seen"] == 1 and tally["captured"] == 1
    b, pay = _reload(hdb, booking)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(hdb) == 1
    assert fake.count("GET", f"/orders/{OID}") == 1


def test_running_the_stale_sweep_again_confirms_nothing_twice(monkeypatch, hdb, booking, provider):
    _, pay = booking
    _age(hdb, pay, minutes=10)
    _status_api(monkeypatch)
    verification.reconcile_stale_pending(hdb)
    again = verification.reconcile_stale_pending(hdb)
    # A captured row is no longer pending, so it is not even asked about.
    assert again["seen"] == 0
    assert _confirmations(hdb) == 1


def test_a_young_payment_is_left_alone(monkeypatch, hdb, booking, provider):
    _, pay = booking
    _age(hdb, pay, minutes=1)           # customer may still be on HDFC's page
    fake = _status_api(monkeypatch)
    tally = verification.reconcile_stale_pending(hdb)
    assert tally["seen"] == 0 and fake.calls == []


def test_an_old_abandoned_payment_is_no_longer_polled(monkeypatch, hdb, booking, provider):
    _, pay = booking
    _age(hdb, pay, minutes=60 * 25)
    fake = _status_api(monkeypatch)
    assert verification.reconcile_stale_pending(hdb)["seen"] == 0
    assert fake.calls == []


def test_hdfc_outage_during_the_sweep_writes_nothing(monkeypatch, hdb, booking, provider):
    import requests

    b, pay = booking
    _age(hdb, pay, minutes=10)
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": requests.Timeout("slow")})

    tally = verification.reconcile_stale_pending(hdb)

    assert tally["seen"] == 1 and tally["retryable"] == 1 and tally["captured"] == 0
    b, pay = _reload(hdb, booking)
    assert pay.status == CustomerPaymentStatus.PENDING.value
    assert b.status == CustomerBookingStatus.PENDING.value
    assert _confirmations(hdb) == 0


def test_a_pending_bank_answer_stays_pending_and_is_asked_again(monkeypatch, hdb, booking, provider):
    _, pay = booking
    _age(hdb, pay, minutes=10)
    _status_api(monkeypatch, status="PENDING_VBV")
    first = verification.reconcile_stale_pending(hdb)
    assert first["retryable"] == 1
    _, pay = _reload(hdb, booking)
    assert pay.status != CustomerPaymentStatus.CAPTURED.value

    _status_api(monkeypatch)                                # the bank settles
    second = verification.reconcile_stale_pending(hdb)
    assert second["captured"] == 1
    assert _confirmations(hdb) == 1


def test_the_sweep_rejects_an_amount_that_does_not_match_the_booking(
        monkeypatch, hdb, booking, provider):
    _, pay = booking
    _age(hdb, pay, minutes=10)
    _status_api(monkeypatch, amount=1)                      # HDFC charged Rs 1
    tally = verification.reconcile_stale_pending(hdb)
    assert tally["rejected"] == 1 and tally["captured"] == 0
    b, pay = _reload(hdb, booking)
    assert pay.status != CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.PENDING.value
    assert _confirmations(hdb) == 0


def test_the_sweep_never_touches_other_providers(monkeypatch, hdb, booking, provider):
    _, pay = booking
    pay.provider = "razorpay"
    _age(hdb, pay, minutes=10)
    fake = _status_api(monkeypatch)
    assert verification.reconcile_stale_pending(hdb)["seen"] == 0
    assert fake.calls == []


def test_a_recent_failure_that_was_retried_and_paid_is_picked_up(
        monkeypatch, hdb, booking, provider):
    """HDFC lets the customer retry the SAME order after a failed attempt."""
    _, pay = booking
    pay.status = CustomerPaymentStatus.FAILED.value
    _age(hdb, pay, minutes=30)
    _status_api(monkeypatch)
    assert verification.reconcile_stale_pending(hdb)["captured"] == 1
    b, pay = _reload(hdb, booking)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value


def test_an_old_failure_is_final(monkeypatch, hdb, booking, provider):
    _, pay = booking
    pay.status = CustomerPaymentStatus.FAILED.value
    _age(hdb, pay, minutes=60 * 3)
    fake = _status_api(monkeypatch)
    assert verification.reconcile_stale_pending(hdb)["seen"] == 0
    assert fake.calls == []


def test_the_sweep_reads_all_three_products(monkeypatch, hdb, booking, provider):
    """Packages, flights and hotels all reach the same verifier."""
    now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)
    hdb.add(CustomerBookingPayment(
        customer_booking_payment_id=9101, customer_booking_id=1, method="gateway",
        amount=decimal.Decimal("10.00"), currency="INR",
        status=CustomerPaymentStatus.PENDING.value, provider="hdfc",
        provider_order_id="JPFLIGHTORDER000001", created_at=now))
    hdb.add(CustomerPackageBookingPayment(
        customer_package_booking_payment_id=9102, package_booking_id=1, method="gateway",
        amount=decimal.Decimal("10.00"), currency="INR",
        status=CustomerPaymentStatus.PENDING.value, provider="hdfc",
        provider_order_id="JPPACKAGEORDER00001", created_at=now))
    _, hotel_pay = booking
    _age(hdb, hotel_pay, minutes=10)

    seen = []

    def spy(db, row, provider_name):
        seen.append((type(row).__name__, provider_name))
        return None

    monkeypatch.setattr(events, "verify_payment_row", spy)
    tally = verification.reconcile_stale_pending(hdb)

    assert tally["seen"] == 3
    assert sorted(t for t, _ in seen) == [
        "CustomerBookingPayment", "CustomerHotelBookingPayment",
        "CustomerPackageBookingPayment"]
    assert {p for _, p in seen} == {"hdfc"}


def test_a_failing_row_does_not_stop_the_pass(monkeypatch, hdb, booking, provider):
    _, pay = booking
    _age(hdb, pay, minutes=10)
    hdb.add(CustomerPackageBookingPayment(
        customer_package_booking_payment_id=9103, package_booking_id=1, method="gateway",
        amount=decimal.Decimal("10.00"), currency="INR",
        status=CustomerPaymentStatus.PENDING.value, provider="hdfc",
        provider_order_id="JPPACKAGEORDER00002",
        created_at=dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)))
    hdb.commit()
    real = events.verify_payment_row

    def flaky(db, row, provider_name):
        if isinstance(row, CustomerPackageBookingPayment):
            raise RuntimeError("boom")
        return real(db, row, provider_name)

    monkeypatch.setattr(events, "verify_payment_row", flaky)
    _status_api(monkeypatch)
    tally = verification.reconcile_stale_pending(hdb)
    assert tally["errors"] == 1 and tally["captured"] == 1


# ---- the deferred-event sweep, for a non-package payment --------------------
def test_a_deferred_hotel_event_is_retried_not_ignored(monkeypatch, hdb, booking, provider):
    """Regression: the sweep resolved PACKAGE payments only, so a deferred
    hotel/flight event was marked 'ignored: no local payment' and never retried."""
    _status_api(monkeypatch, status="PENDING_VBV")
    outcome, _ = _deliver(hdb, provider, webhook_body(OID, status="CHARGED"))
    assert outcome == events.DEFERRED
    assert _confirmations(hdb) == 0

    _status_api(monkeypatch)                                # bank settles
    tally = verification.process_deferred_events(hdb)

    assert tally["seen"] == 1 and tally["ignored"] == 0 and tally["captured"] == 1
    b, pay = _reload(hdb, booking)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(hdb) == 1
    row = hdb.query(PaymentProviderEvent).one()
    assert row.processing_status == events.PROCESSED
