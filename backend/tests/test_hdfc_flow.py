"""HDFC SmartGateway through the platform's own payment path, end to end.

    webhook / return URL  ->  payment_event_service / payment_returns
                          ->  payment_verification_hotel_service  (Order Status!)
                          ->  confirm_booking

The adapter is real; only HDFC's HTTP API is faked (``FakeHDFC``). The
database is real SQLite. What is proved here is the rule the whole design
rests on: NOTHING the browser or the webhook says confirms a booking -- only
an authenticated Order Status read whose order id, amount and currency match
our own booking row -- and doing it twice confirms it once.

Hotel bookings are used because the shared harness (conftest.py) already
builds them; all three products share the event service and the same
verifier design.
"""

from __future__ import annotations

import datetime as dt
import decimal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.config
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_customer import (
    Base,
    Customer,
    CustomerAuditLog,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerPackageBookingPayment,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerNotification,
    CustomerPaymentStatus,
    PaymentProviderEvent,
)
from app.routers import payment_returns, payment_webhooks
from app.services import payment_event_service as events
from app.services import payment_verification_hotel_service as verify
from app.services import payments as P
from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
from tests.hdfc_fakes import (
    RESPONSE_KEY,
    WEBHOOK_PASS,
    WEBHOOK_USER,
    FakeHDFC,
    FakeResponse,
    basic,
    make_provider,
    order_doc,
    webhook_body,
)
from tests.test_hdfc_provider import _php_style_signature

REF = "JPH000777"
KEY = "mb-JPH000777"
OID = HDFCSmartGatewayProvider.order_id_for(REF, KEY)
AUTH = {"Authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)}
FRONTEND = "https://tours.example.test"

_EVENTS_DDL = """
CREATE TABLE payment_provider_events (
    payment_provider_event_id INTEGER PRIMARY KEY,
    provider VARCHAR(40) NOT NULL,
    provider_event_id VARCHAR(120) NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    provider_payment_id VARCHAR(120),
    provider_order_id VARCHAR(120),
    payload TEXT NOT NULL DEFAULT '{}',
    processing_status VARCHAR(20) NOT NULL DEFAULT 'received',
    processing_note TEXT,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    UNIQUE (provider, provider_event_id)
)
"""

_IDS = {"n": 5000}


def _id():
    _IDS["n"] += 1
    return _IDS["n"]


@pytest.fixture()
def hdb():
    """SQLite shared across threads, so the TestClient's app sees our rows."""
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerHotelBooking.__table__,
        CustomerHotelBookingPayment.__table__, CustomerNotification.__table__,
        CustomerAuditLog.__table__,
        # Looked up (empty) by find_payment, which checks every product.
        CustomerPackageBookingPayment.__table__, CustomerBookingPayment.__table__,
    ])
    with engine.begin() as conn:
        # The event log's Postgres-only '{}'::jsonb default is why this table
        # is created by hand; the columns and the unique key are the model's.
        conn.execute(text(_EVENTS_DDL))
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def provider(monkeypatch):
    p = make_provider()
    real = P.get_provider_named

    def named(name):
        if (name or "").lower() == "hdfc":
            return p
        return real(name)

    monkeypatch.setattr(P, "get_provider_named", named)
    return p


@pytest.fixture()
def booking(hdb):
    c = Customer(customer_id=_id(), customer_code=f"CUST{_IDS['n']}",
                 full_name="Test Traveller", email=f"t{_IDS['n']}@example.test",
                 mobile="9000000000")
    hdb.add(c)
    hdb.flush()
    b = CustomerHotelBooking(
        customer_hotel_booking_id=_id(), booking_ref=REF, customer_id=c.customer_id,
        hotel_id=1, hotel_name="TEST PROPERTY", room_id=1, room_name="Test Room",
        check_in_date=dt.date(2026, 10, 12), check_out_date=dt.date(2026, 10, 13),
        nights=1, total_amount=decimal.Decimal("56.00"), currency="INR",
        status=CustomerBookingStatus.PENDING.value,
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    hdb.add(b)
    hdb.flush()
    pay = CustomerHotelBookingPayment(
        customer_hotel_booking_payment_id=_id(), hotel_booking_id=b.customer_hotel_booking_id,
        method="gateway", amount=decimal.Decimal("56.00"), currency="INR",
        status=CustomerPaymentStatus.PENDING.value, provider="hdfc",
        provider_order_id=OID, provider_payment_id=None, idempotency_key=KEY,
    )
    hdb.add(pay)
    hdb.commit()
    return b, pay


def _status_api(monkeypatch, **order_kw):
    return FakeHDFC(monkeypatch, {
        f"GET /orders/{OID}": FakeResponse(200, order_doc(OID, **order_kw)),
    })


def _confirmations(hdb) -> int:
    return hdb.execute(
        select(func.count()).select_from(CustomerNotification)
        .where(CustomerNotification.notification_type == "booking_confirmed")
    ).scalar_one()


def _reload(hdb, booking):
    b, p = booking
    hdb.expire_all()
    return hdb.get(CustomerHotelBooking, b.customer_hotel_booking_id), \
        hdb.get(CustomerHotelBookingPayment, p.customer_hotel_booking_payment_id)


def _deliver(hdb, provider, body, headers=AUTH):
    event = provider.verify_webhook(body, headers)
    return events.handle(hdb, provider.name, event)


# ===========================================================================
# Callback / webhook outcomes
# ===========================================================================
def test_successful_payment_confirms_booking_via_status_api(hdb, provider, booking, monkeypatch):
    api = _status_api(monkeypatch, status="CHARGED", amount=56)
    outcome, note = _deliver(hdb, provider, webhook_body(OID))
    b, p = _reload(hdb, booking)
    assert outcome == events.PROCESSED, note
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert p.provider_payment_id == OID and p.provider_status == "charged"
    # HDFC's per-attempt txn_id, the id in its settlement reports.
    assert p.provider_reference == f"JPTESTMID-{OID}-1"
    assert p.paid_at is not None and p.method == "card"
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    # The webhook was NOT believed on its own: HDFC was asked.
    assert api.count("GET", f"/orders/{OID}") == 1
    assert _confirmations(hdb) == 1


def test_webhook_claims_success_but_status_api_says_pending(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch, status="PENDING_VBV")
    outcome, _ = _deliver(hdb, provider, webhook_body(OID))       # body says CHARGED
    b, p = _reload(hdb, booking)
    assert outcome == events.DEFERRED
    assert p.status != CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.PENDING.value


def test_failed_payment(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch, status="AUTHORIZATION_FAILED", bank_error_message="Declined")
    outcome, _ = _deliver(hdb, provider, webhook_body(
        OID, event_name="ORDER_FAILED", status="AUTHORIZATION_FAILED"))
    b, p = _reload(hdb, booking)
    assert outcome == events.PROCESSED
    assert p.status == CustomerPaymentStatus.FAILED.value
    assert p.failure_reason
    assert b.status == CustomerBookingStatus.PENDING.value
    assert _confirmations(hdb) == 0


def test_cancelled_payment_customer_abandoned_authentication(hdb, provider, booking, monkeypatch):
    """HDFC has no 'cancelled' order status; a customer who backs out of
    authentication is AUTHENTICATION_FAILED. Never a confirmation."""
    _status_api(monkeypatch, status="AUTHENTICATION_FAILED")
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    hdb.commit()
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.FAILED.value
    assert b.status == CustomerBookingStatus.PENDING.value
    assert result.captured_now is False


def test_voided_order_is_not_captured(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch, status="VOIDED")
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    b, p = _reload(hdb, booking)
    assert result.captured_now is False
    assert p.status != CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.PENDING.value


def test_pending_payment_is_retryable_not_failed(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch, status="NEW")
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    assert result.disposition == verify.RETRYABLE and result.code == "not_yet_paid"
    _, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.PENDING.value


def test_unknown_provider_status_is_retryable(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch, status="BRAND_NEW_STATUS")
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    assert result.disposition == verify.RETRYABLE
    _, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.PENDING.value


def test_status_api_failure_writes_nothing(hdb, provider, booking, monkeypatch):
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(503, "down")})
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    assert result.disposition == verify.RETRYABLE and result.code == "provider_timeout"
    _, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.PENDING.value


# ===========================================================================
# Amount security
# ===========================================================================
def test_tampered_amount_is_rejected(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch, status="CHARGED", amount=1)          # ₹1, booking is ₹56
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    hdb.commit()
    b, p = _reload(hdb, booking)
    assert result.disposition == verify.REJECTED and result.code == "amount_mismatch"
    assert p.status != CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.PENDING.value


def test_webhook_amount_is_not_what_is_compared(hdb, provider, booking, monkeypatch):
    """A webhook body claiming the right amount changes nothing when HDFC's
    own Order Status says otherwise -- and vice versa."""
    _status_api(monkeypatch, status="CHARGED", amount=1)
    outcome, _ = _deliver(hdb, provider, webhook_body(OID, amount=56))
    b, p = _reload(hdb, booking)
    assert outcome == events.FAILED
    assert b.status == CustomerBookingStatus.PENDING.value


def test_tampered_order_id_is_rejected(hdb, provider, booking, monkeypatch):
    other = HDFCSmartGatewayProvider.order_id_for("JPH001000", KEY)
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(200, order_doc(other))})
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    assert result.disposition == verify.REJECTED and result.code == "order_mismatch"
    b, _ = _reload(hdb, booking)
    assert b.status == CustomerBookingStatus.PENDING.value


def test_currency_mismatch_is_rejected(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch, status="CHARGED", currency="USD")
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    assert result.disposition == verify.REJECTED and result.code == "currency_mismatch"


def test_webhook_for_an_order_we_never_opened_is_ignored(hdb, provider, booking, monkeypatch):
    api = _status_api(monkeypatch)
    other = HDFCSmartGatewayProvider.order_id_for("JPH001000", KEY)
    outcome, _ = _deliver(hdb, provider, webhook_body(other, event_id="evt_other"))
    assert outcome == events.IGNORED
    assert api.calls == []                       # no verification spent on it


# ===========================================================================
# Idempotency: one state transition, one booking confirmation
# ===========================================================================
def test_duplicate_webhook_confirms_once(hdb, provider, booking, monkeypatch):
    api = _status_api(monkeypatch)
    first = _deliver(hdb, provider, webhook_body(OID))
    second = _deliver(hdb, provider, webhook_body(OID))
    third = _deliver(hdb, provider, webhook_body(OID))
    assert first[0] == events.PROCESSED
    assert second[0] == third[0] == "duplicate"
    assert _confirmations(hdb) == 1
    assert api.count("GET", f"/orders/{OID}") == 1
    assert hdb.execute(select(func.count()).select_from(PaymentProviderEvent)).scalar_one() == 1


def test_replayed_webhook_with_new_event_id_confirms_once(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch)
    _deliver(hdb, provider, webhook_body(OID, event_id="evt_1"))
    _deliver(hdb, provider, webhook_body(OID, event_id="evt_2", event_name="TXN_CHARGED"))
    _, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert _confirmations(hdb) == 1


def test_late_failure_event_cannot_undo_a_capture(hdb, provider, booking, monkeypatch):
    _status_api(monkeypatch)
    _deliver(hdb, provider, webhook_body(OID, event_id="evt_ok"))
    _deliver(hdb, provider, webhook_body(OID, event_id="evt_late", event_name="TXN_FAILED",
                                         status="AUTHORIZATION_FAILED"))
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value


def test_success_on_a_cancelled_booking_is_kept_for_review(hdb, provider, booking, monkeypatch):
    """Payment succeeded, booking cannot be confirmed: the money is NOT lost --
    the payment is recorded captured and the booking is flagged for a human."""
    b, _ = booking
    b.status = CustomerBookingStatus.CANCELLED.value
    hdb.commit()
    _status_api(monkeypatch)
    result = verify.verify_and_capture(hdb, booking[1].customer_hotel_booking_payment_id)
    hdb.commit()
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CANCELLED.value
    assert result.captured_now is True and result.booking_confirmed_now is False
    audit = hdb.execute(select(CustomerAuditLog.action)).scalars().all()
    assert any("non-confirmable" in a for a in audit)


# ===========================================================================
# Over HTTP: the webhook route and the return route
# ===========================================================================
@pytest.fixture()
def client(hdb, provider, monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)
    monkeypatch.setattr(app.config.settings, "frontend_base_url", FRONTEND)
    api = FastAPI()
    api.state.limiter = limiter
    api.include_router(payment_webhooks.router)
    api.include_router(payment_returns.router)

    def _db():
        yield hdb

    api.dependency_overrides[get_db] = _db
    return TestClient(api, follow_redirects=False)


def _signed_return(order_id=OID, **extra):
    params = {"order_id": order_id, "status": "CHARGED", "status_id": "21", **extra}
    params["signature"] = _php_style_signature(params, RESPONSE_KEY)
    params["signature_algorithm"] = "HMAC-SHA256"
    return params


def test_http_webhook_bad_credentials_401_and_nothing_recorded(client, hdb, booking, monkeypatch):
    api = _status_api(monkeypatch)
    r = client.post("/api/webhooks/payments/hdfc", content=webhook_body(OID),
                    headers={"Authorization": basic(WEBHOOK_USER, "nope")})
    assert r.status_code == 401
    assert hdb.execute(select(func.count()).select_from(PaymentProviderEvent)).scalar_one() == 0
    assert api.calls == []


def test_http_webhook_success_then_duplicate_both_200(client, hdb, booking, monkeypatch):
    _status_api(monkeypatch)
    r1 = client.post("/api/webhooks/payments/hdfc", content=webhook_body(OID), headers=AUTH)
    r2 = client.post("/api/webhooks/payments/hdfc", content=webhook_body(OID), headers=AUTH)
    # HDFC re-sends anything that is not a 200 -- a duplicate must be 200 too.
    assert r1.status_code == 200 and r1.json()["status"] == events.PROCESSED
    assert r2.status_code == 200 and r2.json()["status"] == "duplicate"
    assert _confirmations(hdb) == 1


def test_signed_return_verifies_server_side_and_lands_on_my_trips(client, hdb, booking, monkeypatch):
    api = _status_api(monkeypatch)
    r = client.get("/api/payments/hdfc/return", params=_signed_return())
    assert r.status_code == 303
    loc = r.headers["location"]
    assert loc.startswith(f"{FRONTEND}/my-bookings.html?")
    assert f"ref={REF}" in loc and "kind=hotel" in loc and "payment_return=hdfc" in loc
    assert api.count("GET", f"/orders/{OID}") == 1
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value


def test_return_status_parameter_is_never_believed(client, hdb, booking, monkeypatch):
    """The browser says CHARGED (and the signature is valid); HDFC's Order
    Status says it failed. The server believes HDFC."""
    _status_api(monkeypatch, status="AUTHORIZATION_FAILED")
    client.get("/api/payments/hdfc/return", params=_signed_return())
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.FAILED.value
    assert b.status == CustomerBookingStatus.PENDING.value


def test_posted_return_is_accepted(client, hdb, booking, monkeypatch):
    _status_api(monkeypatch)
    r = client.post("/api/payments/hdfc/return", data=_signed_return())
    assert r.status_code == 303
    b, _ = _reload(hdb, booking)
    assert b.status == CustomerBookingStatus.CONFIRMED.value


def test_invalid_return_signature_verifies_nothing(client, hdb, booking, monkeypatch):
    api = _status_api(monkeypatch)
    params = _signed_return()
    params["signature"] = "AAAA" + params["signature"][4:]
    r = client.get("/api/payments/hdfc/return", params=params)
    assert r.status_code == 303 and "payment_return=unverified" in r.headers["location"]
    assert REF not in r.headers["location"]
    assert api.calls == []
    b, _ = _reload(hdb, booking)
    assert b.status == CustomerBookingStatus.PENDING.value


def test_missing_return_signature_verifies_nothing(client, hdb, booking, monkeypatch):
    api = _status_api(monkeypatch)
    r = client.get("/api/payments/hdfc/return", params={"order_id": OID, "status": "CHARGED"})
    assert "payment_return=unverified" in r.headers["location"]
    assert api.calls == []


def test_return_for_unknown_order_is_harmless(client, hdb, booking, monkeypatch):
    api = _status_api(monkeypatch)
    other = HDFCSmartGatewayProvider.order_id_for("JPH001000", KEY)
    r = client.get("/api/payments/hdfc/return", params=_signed_return(order_id=other))
    assert "payment_return=unknown" in r.headers["location"]
    assert api.calls == []


def test_duplicate_and_replayed_return_confirm_once(client, hdb, booking, monkeypatch):
    api = _status_api(monkeypatch)
    params = _signed_return()
    for _ in range(4):
        assert client.get("/api/payments/hdfc/return", params=params).status_code == 303
    assert _confirmations(hdb) == 1
    # After the first capture the verifier answers from the locked row.
    assert api.count("GET", f"/orders/{OID}") == 1


def test_return_and_webhook_racing_confirm_once(client, hdb, booking, monkeypatch):
    """Webhook before the browser, browser before the webhook: either order."""
    _status_api(monkeypatch)
    client.get("/api/payments/hdfc/return", params=_signed_return())
    r = client.post("/api/webhooks/payments/hdfc", content=webhook_body(OID), headers=AUTH)
    assert r.status_code == 200
    assert _confirmations(hdb) == 1


def test_redirect_target_cannot_be_chosen_by_the_request(client, hdb, booking, monkeypatch):
    _status_api(monkeypatch)
    r = client.get("/api/payments/hdfc/return",
                   params=_signed_return(next="https://evil.example.com"))
    assert r.headers["location"].startswith(f"{FRONTEND}/my-bookings.html?")
    assert "evil" not in r.headers["location"]
