"""TrustBrick on a deployed host must never collect through a Razorpay TEST key.

TrustBrick holds the Razorpay merchant account, so a test-mode order takes no
money while the booking flow would show the customer a payment page for it.
These tests pin the guard in ``sandbox_guard`` (and the adapter's own check of
the ``key_id`` TrustBrick reports) across flight, hotel and package checkout.

Nothing here opens a socket or moves money: ``requests.request`` is replaced by
a recorder, the database is SQLite, and every key is a synthetic placeholder.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

import app.config
from app.models_customer import (
    CustomerBookingPayment,
    CustomerHotelBookingPayment,
    CustomerPackageBookingPayment,
)
from app.services import payments as P
from app.services.payments import sandbox_guard
from app.services.payments import trustbrick_provider as tb
from tests.test_sandbox_guard_resume_and_hosts import resume_case  # noqa: F401  (fixture)
from tests.test_sandbox_payment_guard import NEUTRAL
from tests.test_hdfc_production import _fresh_provider_cache, _set  # noqa: F401

TEST_KEY = "rzp_test_SYNTHETICKEY0001"
LIVE_KEY = "rzp_live_SYNTHETICKEY0002"
SECRETS = ("synthetic-tb-secret", "synthetic-tb-callback-secret")
_PAYMENT_TABLES = (CustomerBookingPayment, CustomerHotelBookingPayment,
                   CustomerPackageBookingPayment)


class FakeTrustBrick:
    """Stands in for ``requests.request``; records every call."""

    def __init__(self, monkeypatch, reported_key=LIVE_KEY):
        self.calls: list[tuple[str, str]] = []
        self.reported_key = reported_key
        monkeypatch.setattr(tb.requests, "request", self._request)

    def _request(self, method, url, **kw):
        self.calls.append((method, url))
        amount = 5600
        data = {"provider_order_id": "order_SYNTH0001", "amount_paise": amount,
                "currency": "INR", "payment_reference": "tbp_synth",
                "created": True}
        if self.reported_key:
            data["key_id"] = self.reported_key
        return SimpleNamespace(status_code=200,
                               json=lambda: {"ok": True, "data": data})


def _configure(monkeypatch, ref, *, deployed=True, key=None, provider="none", pilot=True):
    _set(monkeypatch,
         payment_provider=provider, payment_environment="live", deployed=deployed,
         trustbrick_base_url="https://tb.example.test", trustbrick_key_id="tb_key",
         trustbrick_secret=SECRETS[0], trustbrick_callback_secret=SECRETS[1],
         trustbrick_publishable_key=key,
         trustbrick_pilot_booking_refs=ref if pilot else "")


def _payment_count(db):
    return sum(db.scalar(select(func.count()).select_from(t)) for t in _PAYMENT_TABLES)


def _use_new_key(service, db, customer, booking, key="fresh-key-0001"):
    return service.start_checkout(db, customer, booking, idempotency_key=key)


# ---------------------------------------------------------------------------
# The key predicate
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("key,expected", [
    (TEST_KEY, True),
    ("  RZP_TEST_abc  ", True),
    ("Rzp_Test_abc", True),
    (LIVE_KEY, False),
    ("", False),
    (None, False),
    ("garbage", False),
    ("rzp_tes", False),
    ("xrzp_test_abc", False),
])
def test_is_test_key(key, expected):
    assert sandbox_guard.is_test_key(key) is expected


# ---------------------------------------------------------------------------
# New checkout: refused before any order or payment row
# ---------------------------------------------------------------------------
def test_deployed_configured_test_key_refuses_new_checkout(monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=TEST_KEY)
    fake = FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    before = _payment_count(db)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        _use_new_key(service, db, customer, booking)

    assert exc.value.customer_message == NEUTRAL
    assert fake.calls == []                           # no order opened at TrustBrick
    db.rollback()
    assert _payment_count(db) == before               # no payment row persisted


def test_deployed_reported_test_key_is_refused_before_the_order_id_is_stored(
        monkeypatch, resume_case):
    """Nothing configured: the test key is only learned from TrustBrick's reply."""
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=None)
    fake = FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    before = _payment_count(db)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        _use_new_key(service, db, customer, booking)

    assert exc.value.customer_message == NEUTRAL
    assert len(fake.calls) == 1                       # the order call was the only one
    db.rollback()
    assert _payment_count(db) == before               # the caller never persisted it
    # What was learned keeps later checkouts and the public config closed.
    assert P.available_for_customer(booking.booking_ref, customer) is None
    with pytest.raises(P.SandboxPaymentsBlocked):
        _use_new_key(service, db, customer, booking, key="fresh-key-0002")
    assert len(fake.calls) == 1


def test_deployed_live_key_is_not_rejected_and_pilot_routing_is_unchanged(
        monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=LIVE_KEY)
    FakeTrustBrick(monkeypatch, reported_key=LIVE_KEY)

    payment, session = _use_new_key(service, db, customer, booking)

    assert session.provider == "trustbrick"
    assert session.publishable_key == LIVE_KEY
    assert payment.provider_order_id == "order_SYNTH0001"


def test_deployed_live_key_with_no_configured_key_is_not_rejected(monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=None)
    FakeTrustBrick(monkeypatch, reported_key=LIVE_KEY)

    _payment, session = _use_new_key(service, db, customer, booking)

    assert session.publishable_key == LIVE_KEY


@pytest.mark.parametrize("configured,reported", [(None, ""), ("", ""), ("garbage", "garbage")])
def test_missing_or_malformed_keys_keep_existing_behaviour(
        monkeypatch, resume_case, configured, reported):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=configured)
    FakeTrustBrick(monkeypatch, reported_key=reported)

    _payment, session = _use_new_key(service, db, customer, booking)

    assert session.provider == "trustbrick"           # not judged by this guard


def test_local_host_with_a_test_key_still_works(monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, deployed=False, key=TEST_KEY)
    FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)

    _payment, session = _use_new_key(service, db, customer, booking)

    assert session.provider == "trustbrick" and session.publishable_key == TEST_KEY
    assert P.available_for_customer(booking.booking_ref, customer) is not None


# ---------------------------------------------------------------------------
# Resume, routing and fallbacks
# ---------------------------------------------------------------------------
def test_resume_never_returns_a_test_mode_checkout(monkeypatch, resume_case):
    service, db, customer, booking, key, _oid = resume_case
    for table in _PAYMENT_TABLES:                     # the open order is TrustBrick's
        for row in db.scalars(select(table)):
            row.provider = "trustbrick"
    db.commit()
    _configure(monkeypatch, booking.booking_ref, key=TEST_KEY, pilot=False)
    fake = FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    # The routed provider is something else: only the order's holder is TrustBrick.
    other = SimpleNamespace(name="razorpay", publishable_key=LIVE_KEY)
    monkeypatch.setattr(P, "get_provider_for_booking", lambda ref: other)

    with pytest.raises(P.SandboxPaymentsBlocked):
        service.start_checkout(db, customer, booking, idempotency_key=key)

    assert fake.calls == []


def test_resume_with_a_live_key_still_works(monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    for table in _PAYMENT_TABLES:
        for row in db.scalars(select(table)):
            row.provider = "trustbrick"
    db.commit()
    _configure(monkeypatch, booking.booking_ref, key=LIVE_KEY)
    FakeTrustBrick(monkeypatch)

    _row, session = service.start_checkout(db, customer, booking, idempotency_key=key)

    assert session.provider == "trustbrick" and session.order_id == oid


def test_global_trustbrick_provider_and_by_name_routes_cannot_bypass(monkeypatch):
    _configure(monkeypatch, "JPB000009", key=TEST_KEY, provider="trustbrick", pilot=False)

    # Non-pilot booking on a global PAYMENT_PROVIDER=trustbrick, and the pilot route.
    assert P.available_for_customer("JPB000001", None) is None
    assert P.available_for_customer(None, None) is None
    _configure(monkeypatch, "JPB000009", key=TEST_KEY)
    assert P.available_for_customer("JPB000009", None) is None
    # The adapter is still reachable by name for verification...
    assert P.get_provider_named("trustbrick").name == "trustbrick"
    # ...but handing it to a checkout is refused.
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.require_customer_access(P.get_provider_named("trustbrick"), None)


def test_public_config_hides_a_test_key_and_offers_a_live_one(monkeypatch):
    _configure(monkeypatch, "JPB000009", key=TEST_KEY)
    assert P.available_for_customer("JPB000009", None) is None

    _configure(monkeypatch, "JPB000009", key=LIVE_KEY)
    provider = P.available_for_customer("JPB000009", None)
    assert provider is not None and provider.publishable_key == LIVE_KEY


# ---------------------------------------------------------------------------
# Verification, callbacks and recovery are not gated
# ---------------------------------------------------------------------------
def test_verification_paths_keep_working_with_a_test_key(monkeypatch):
    _configure(monkeypatch, "JPB000009", key=TEST_KEY)
    provider = P.get_provider_named("trustbrick")

    doc = {"status": "CAPTURED", "amount_paise": 5600, "currency": "INR",
           "provider_order_id": "order_SYNTH0001", "provider_payment_id": "pay_SYNTH1"}
    monkeypatch.setattr(
        tb.requests, "request",
        lambda *a, **k: SimpleNamespace(
            status_code=200,
            json=lambda: {"ok": True, "data": {"payment": doc, **doc}}))

    assert provider.fetch_payment("pay_SYNTH1").status == P.CAPTURED
    assert provider.fetch_order("order_SYNTH0001").status == P.CAPTURED
    assert provider.capture(provider_payment_id="pay_SYNTH1", amount_minor=5600,
                            currency="INR").status == P.CAPTURED


def test_callback_verification_is_not_gated(monkeypatch):
    import json
    import time

    _configure(monkeypatch, "JPB000009", key=TEST_KEY)
    provider = P.get_provider_named("trustbrick")
    body = json.dumps({"event": "payment.captured", "event_id": "evt_synth1",
                       "status": "CAPTURED", "amount_paise": 5600,
                       "currency": "INR"}).encode()
    ts, nonce = str(int(time.time())), "n" * 32
    sig = tb.TrustBrickProvider.compute_signature(
        SECRETS[1], "POST", tb.CALLBACK_PATH, ts, nonce, body)

    event = provider.verify_webhook(body, {
        tb.HEADER_TIMESTAMP: ts, tb.HEADER_NONCE: nonce,
        tb.HEADER_SIGNATURE: sig, tb.HEADER_EVENT_ID: "evt_synth1"})

    assert event.supported and event.payment.status == P.CAPTURED


# ---------------------------------------------------------------------------
# Nothing secret in logs or messages
# ---------------------------------------------------------------------------
def test_refusals_do_not_leak_keys_or_secrets(monkeypatch, caplog, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=None)
    FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    caplog.set_level(logging.DEBUG)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        _use_new_key(service, db, customer, booking)
    with pytest.raises(P.SandboxPaymentsBlocked) as exc2:
        _use_new_key(service, db, customer, booking, key="fresh-key-0002")

    text = caplog.text + str(exc.value) + exc.value.customer_message + str(exc2.value)
    for forbidden in (TEST_KEY, *SECRETS):
        assert forbidden not in text
    assert "TEST" in caplog.text                       # but the operator can diagnose it
