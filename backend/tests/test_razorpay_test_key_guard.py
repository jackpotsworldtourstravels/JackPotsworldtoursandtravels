"""A Razorpay TEST key (rzp_test_...) must not collect on a deployed host.

Razorpay's test mode takes no money, yet the booking can look paid -- the same
hazard sandbox_guard closes for HDFC UAT. The guard sits in the per-customer
checkout gate (``require_customer_access`` / ``customer_may_use``), which every
new AND resumed checkout passes through, and NOT in the provider factory: the
webhook, return URL, reconcile and sweep resolve the adapter through the
factory, and a payment opened earlier must stay verifiable.

Synthetic keys only; nothing here opens a socket.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import app.config
from app.services import payments as P
from app.services.payments import sandbox_guard
from tests.test_sandbox_guard_resume_and_hosts import resume_case  # noqa: F401  (fixture)
from tests.test_sandbox_payment_guard import NEUTRAL, _person

TEST_KEY = "rzp_test_SYNTHETICKEY01"
LIVE_KEY = "rzp_live_SYNTHETICKEY01"


@pytest.fixture(autouse=True)
def _fresh_cache():
    P.reset_provider_cache()
    yield
    P.reset_provider_cache()


def _razorpay(monkeypatch, *, deployed, key_id=TEST_KEY):
    s = app.config.settings
    for k, v in dict(
        payment_provider="razorpay", payment_environment="test", payment_mode="",
        deployed=deployed, razorpay_key_id=key_id, razorpay_key_secret="synthetic-secret",
        razorpay_webhook_secret="synthetic-webhook", trustbrick_pilot_booking_refs="",
        allow_sandbox_payments=False, sandbox_payment_customer_ids="",
    ).items():
        monkeypatch.setattr(s, k, v)
    P.reset_provider_cache()


# --- the rule ---------------------------------------------------------------
def test_deployed_test_key_is_refused_with_operator_detail_and_neutral_customer_text(monkeypatch):
    _razorpay(monkeypatch, deployed=True)
    provider = P.get_provider()                      # the factory itself is untouched
    assert provider.name == "razorpay"

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        P.require_customer_access(provider, _person(11))

    assert exc.value.customer_message == NEUTRAL
    assert "RAZORPAY_KEY_ID" in str(exc.value) and "DEPLOYED" in str(exc.value)
    assert TEST_KEY not in str(exc.value)            # the key itself is never echoed
    assert P.available_for_customer(None, _person(11)) is None
    assert not sandbox_guard.customer_may_use("razorpay", _person(11))


@pytest.mark.parametrize("key", [" RZP_TEST_abc ", "rzp_test_x", "Rzp_Test_x"])
def test_prefix_is_matched_after_trimming_and_case_folding(monkeypatch, key):
    _razorpay(monkeypatch, deployed=True, key_id=key)
    assert sandbox_guard.razorpay_test_key_blocked("razorpay")


def test_deployed_live_format_key_is_not_refused_by_this_check(monkeypatch):
    _razorpay(monkeypatch, deployed=True, key_id=LIVE_KEY)
    provider = P.get_provider()
    P.require_customer_access(provider, _person(11))
    assert P.available_for_customer(None, _person(11)) is provider


def test_local_and_ci_test_keys_remain_supported(monkeypatch):
    _razorpay(monkeypatch, deployed=False)
    provider = P.get_provider()
    P.require_customer_access(provider, None)
    assert P.available_for_customer(None, None) is provider
    assert P.publishable_key() == TEST_KEY


@pytest.mark.parametrize("key", [None, "", "   "])
def test_missing_key_keeps_the_existing_configuration_error(monkeypatch, key):
    _razorpay(monkeypatch, deployed=True, key_id=key)
    assert not sandbox_guard.razorpay_test_key_blocked("razorpay")
    with pytest.raises(P.PaymentMisconfigured) as exc:
        P.get_provider()
    assert not isinstance(exc.value, P.SandboxPaymentsBlocked)
    assert "RAZORPAY_KEY_ID" in str(exc.value)


@pytest.mark.parametrize("key", ["not-a-razorpay-key", "test_rzp_x", "rzp_tes_x", "xrzp_test_x"])
def test_malformed_key_is_not_treated_as_a_test_key(monkeypatch, key):
    _razorpay(monkeypatch, deployed=True, key_id=key)
    assert not sandbox_guard.razorpay_test_key_blocked("razorpay")


def test_other_providers_are_unaffected_by_a_razorpay_test_key(monkeypatch):
    _razorpay(monkeypatch, deployed=True)
    assert not sandbox_guard.razorpay_test_key_blocked("hdfc")
    assert not sandbox_guard.razorpay_test_key_blocked("trustbrick")
    assert sandbox_guard.customer_may_use("trustbrick", None)


# --- verification and recovery are never gated ---------------------------------
def test_verification_paths_still_resolve_the_adapter(monkeypatch):
    _razorpay(monkeypatch, deployed=True)
    adapter = P.get_provider_named("razorpay")        # webhook / return / reconcile / sweep
    assert adapter.name == "razorpay"
    assert P.is_available() and P.configuration_error() is None
    with pytest.raises(P.WebhookVerificationError):   # reaches the signature check, not the guard
        adapter.verify_webhook(b"{}", {"X-Razorpay-Signature": "bad"})


# --- checkout entry points ------------------------------------------------------
def _patch_razorpay_creation(monkeypatch):
    calls = []
    monkeypatch.setattr(P.get_provider(), "create_checkout", lambda **kw: calls.append(kw))
    return calls


def test_a_new_checkout_is_refused_before_any_order_or_row_is_created(monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _razorpay(monkeypatch, deployed=True)
    calls = _patch_razorpay_creation(monkeypatch)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        service.start_checkout(db, customer, booking, idempotency_key="fresh-key-0001")

    assert exc.value.customer_message == NEUTRAL
    assert calls == [] and len(db.new) == 0


def _payment_rows(db) -> int:
    from sqlalchemy import func, select
    from app.models_customer import (
        CustomerBookingPayment, CustomerHotelBookingPayment, CustomerPackageBookingPayment,
    )
    return sum(
        db.execute(select(func.count()).select_from(m)).scalar_one()
        for m in (CustomerBookingPayment, CustomerHotelBookingPayment,
                  CustomerPackageBookingPayment)
    )


@pytest.mark.parametrize("resume_case", ["hotel", "package"], indirect=True)
def test_hotel_and_package_new_checkouts_are_refused_before_anything_is_written(
        monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _razorpay(monkeypatch, deployed=True)
    calls = _patch_razorpay_creation(monkeypatch)
    rows_before = _payment_rows(db)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        service.start_checkout(db, customer, booking, idempotency_key="fresh-key-0003")

    assert exc.value.customer_message == NEUTRAL
    assert calls == []                                  # no provider order was created
    assert len(db.new) == 0 and len(db.dirty) == 0      # nothing added to the session
    assert _payment_rows(db) == rows_before             # nothing persisted


def test_a_resumed_razorpay_checkout_is_refused(monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    row = service.find_payment_by_idempotency_key(db, booking, key)
    row.provider = "razorpay"
    db.commit()
    _razorpay(monkeypatch, deployed=True)
    calls = _patch_razorpay_creation(monkeypatch)

    with pytest.raises(P.SandboxPaymentsBlocked):
        service.start_checkout(db, customer, booking, idempotency_key=key)
    assert calls == []


def test_resume_cannot_bypass_via_another_configured_provider(monkeypatch, resume_case):
    # Routing points at a stub, but the open order was made by Razorpay: the
    # gate runs again on the provider that holds the order.
    service, db, customer, booking, key, oid = resume_case
    row = service.find_payment_by_idempotency_key(db, booking, key)
    row.provider = "razorpay"
    db.commit()
    _razorpay(monkeypatch, deployed=True)
    monkeypatch.setattr(P, "get_provider_for_booking", lambda ref: SimpleNamespace(name="stub"))

    with pytest.raises(P.SandboxPaymentsBlocked):
        service.start_checkout(db, customer, booking, idempotency_key=key)


def test_pilot_fallback_to_razorpay_is_still_gated(monkeypatch):
    # A pilot ref whose TrustBrick is not configured falls back to the
    # configured Razorpay provider; the gate judges that provider by name.
    _razorpay(monkeypatch, deployed=True)
    monkeypatch.setattr(app.config.settings, "trustbrick_pilot_booking_refs", "JPB000555")
    provider = P.get_provider_for_booking("JPB000555")
    assert provider.name == "razorpay"
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.require_customer_access(provider, _person(11))


def test_deployed_live_key_checkout_gets_past_the_gate(monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _razorpay(monkeypatch, deployed=True, key_id=LIVE_KEY)

    def reached(**kw):
        raise RuntimeError("reached")

    monkeypatch.setattr(P.get_provider(), "create_checkout", reached)
    with pytest.raises(RuntimeError, match="reached"):   # past the gate, at the adapter call
        service.start_checkout(db, customer, booking, idempotency_key="fresh-key-0002")


# --- startup -------------------------------------------------------------------
def test_startup_logs_an_error_for_a_deployed_test_key(monkeypatch, caplog):
    _razorpay(monkeypatch, deployed=True)
    with caplog.at_level("ERROR"):
        P.check_configuration_at_startup()
    assert "test key" in caplog.text and TEST_KEY not in caplog.text


def test_startup_is_quiet_for_local_test_keys(monkeypatch, caplog):
    _razorpay(monkeypatch, deployed=False)
    with caplog.at_level("ERROR"):
        P.check_configuration_at_startup()
    assert "test key" not in caplog.text
