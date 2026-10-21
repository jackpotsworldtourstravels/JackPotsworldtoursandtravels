"""HDFC through the PACKAGE and FLIGHT verifiers, not just the hotel one.

test_hdfc_flow.py proves the rules end to end on hotel bookings because the
shared harness builds them. Each product has its own verifier module, so the
same rules are re-proved here for the other two, parametrised: a verified
Order Status confirms the booking once; a duplicate webhook changes nothing; a
wrong amount or order is refused; a settled-but-unannounced payment is found by
the recovery sweep. HDFC's HTTP API is ``FakeHDFC``; no money moves.
"""

from __future__ import annotations

import datetime as dt
import decimal

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models_customer import (
    Base,
    Customer,
    CustomerAuditLog,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerHotelBookingPayment,
    CustomerNotification,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
)
from app.services import payment_event_service as events
from app.services import payment_verification_service as verification
from app.services import payments as P
from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
from tests.hdfc_fakes import FakeHDFC, FakeResponse, make_provider, order_doc, webhook_body
from tests.test_hdfc_flow import _EVENTS_DDL, AUTH

_N = {"n": 70000}


def _id():
    _N["n"] += 1
    return _N["n"]


@pytest.fixture()
def pdb():
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerBooking.__table__, CustomerBookingPayment.__table__,
        CustomerPackageBooking.__table__, CustomerPackageBookingPayment.__table__,
        CustomerHotelBookingPayment.__table__, CustomerNotification.__table__,
        CustomerAuditLog.__table__,
    ])
    with engine.begin() as conn:
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
    monkeypatch.setattr(P, "get_provider_named",
                        lambda name: p if (name or "").lower() == "hdfc" else real(name))
    return p


@pytest.fixture(params=["package", "flight"])
def case(request, pdb):
    """(product, booking, payment, order_id) with a pending HDFC payment of Rs 56."""
    kind = request.param
    ref = "JPP000321" if kind == "package" else "JPF000321"
    key = f"mb-{ref}"
    oid = HDFCSmartGatewayProvider.order_id_for(ref, key)
    c = Customer(customer_id=_id(), customer_code=f"CUST{_id()}", full_name="Test Traveller",
                 email=f"t{_id()}@example.test", mobile="9000000000")
    pdb.add(c)
    pdb.flush()
    created = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)
    if kind == "package":
        b = CustomerPackageBooking(
            customer_package_booking_id=_id(), booking_ref=ref, customer_id=c.customer_id,
            package_id=1, package_name="Test Package", package_days=3, departure_id=1,
            departure_date=dt.date(2026, 12, 1), total_amount=decimal.Decimal("56.00"),
            currency="INR", status=CustomerBookingStatus.PENDING.value, created_at=created)
        pdb.add(b)
        pdb.flush()
        pay = CustomerPackageBookingPayment(
            customer_package_booking_payment_id=_id(),
            package_booking_id=b.customer_package_booking_id, method="gateway",
            amount=decimal.Decimal("56.00"), currency="INR",
            status=CustomerPaymentStatus.PENDING.value, provider="hdfc",
            provider_order_id=oid, idempotency_key=key, created_at=created)
    else:
        b = CustomerBooking(
            customer_booking_id=_id(), booking_ref=ref, customer_id=c.customer_id,
            total_amount=decimal.Decimal("56.00"), currency="INR",
            status=CustomerBookingStatus.PENDING.value, created_at=created)
        pdb.add(b)
        pdb.flush()
        pay = CustomerBookingPayment(
            customer_booking_payment_id=_id(), customer_booking_id=b.customer_booking_id,
            method="gateway", amount=decimal.Decimal("56.00"), currency="INR",
            status=CustomerPaymentStatus.PENDING.value, provider="hdfc",
            provider_order_id=oid, idempotency_key=key, created_at=created)
    pdb.add(pay)
    pdb.commit()
    return kind, b, pay, oid


def _status(monkeypatch, oid, **kw):
    return FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid, **kw))})


def _state(pdb, kind, b, pay):
    pdb.expire_all()
    if kind == "package":
        return (pdb.get(CustomerPackageBooking, b.customer_package_booking_id),
                pdb.get(CustomerPackageBookingPayment, pay.customer_package_booking_payment_id))
    return (pdb.get(CustomerBooking, b.customer_booking_id),
            pdb.get(CustomerBookingPayment, pay.customer_booking_payment_id))


def _confirmations(pdb) -> int:
    return pdb.execute(
        select(func.count()).select_from(CustomerNotification)
        .where(CustomerNotification.notification_type == "booking_confirmed")
    ).scalar_one()


def _deliver(pdb, provider, body, event_id="evt_1"):
    return events.handle(pdb, provider.name, provider.verify_webhook(body, AUTH))


def test_verified_webhook_confirms_once_and_a_duplicate_changes_nothing(
        monkeypatch, pdb, provider, case):
    kind, b, pay, oid = case
    _status(monkeypatch, oid)
    first, _ = _deliver(pdb, provider, webhook_body(oid, event_id="evt_A"))
    dup, _ = _deliver(pdb, provider, webhook_body(oid, event_id="evt_A"))
    replay, _ = _deliver(pdb, provider, webhook_body(oid, event_id="evt_B"))   # new id

    assert first == events.PROCESSED and dup == "duplicate"
    booking, payment = _state(pdb, kind, b, pay)
    assert payment.status == CustomerPaymentStatus.CAPTURED.value
    assert booking.status == CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(pdb) == 1                         # replay did not re-confirm


def test_a_webhook_that_claims_success_while_hdfc_says_pending_confirms_nothing(
        monkeypatch, pdb, provider, case):
    kind, b, pay, oid = case
    _status(monkeypatch, oid, status="PENDING_VBV")
    outcome, _ = _deliver(pdb, provider, webhook_body(oid, status="CHARGED"))
    assert outcome == events.DEFERRED
    booking, payment = _state(pdb, kind, b, pay)
    assert payment.status != CustomerPaymentStatus.CAPTURED.value
    assert booking.status == CustomerBookingStatus.PENDING.value
    assert _confirmations(pdb) == 0


def test_a_wrong_amount_is_refused(monkeypatch, pdb, provider, case):
    kind, b, pay, oid = case
    _status(monkeypatch, oid, amount=1)
    _deliver(pdb, provider, webhook_body(oid, amount=56))   # webhook body is not believed
    booking, payment = _state(pdb, kind, b, pay)
    assert payment.status != CustomerPaymentStatus.CAPTURED.value
    assert booking.status == CustomerBookingStatus.PENDING.value
    assert _confirmations(pdb) == 0


def test_a_different_order_id_is_refused(monkeypatch, pdb, provider, case):
    kind, b, pay, oid = case
    # Our order id looked up, but HDFC answers with another order's document.
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(
        200, order_doc("JPSOMEONEELSE00001"))})
    _deliver(pdb, provider, webhook_body(oid))
    booking, payment = _state(pdb, kind, b, pay)
    assert payment.status != CustomerPaymentStatus.CAPTURED.value
    assert _confirmations(pdb) == 0


def test_failed_payment_is_recorded_and_confirms_nothing(monkeypatch, pdb, provider, case):
    kind, b, pay, oid = case
    _status(monkeypatch, oid, status="AUTHORIZATION_FAILED", bank_error_message="Declined")
    _deliver(pdb, provider, webhook_body(oid, event_name="ORDER_FAILED",
                                         status="AUTHORIZATION_FAILED"))
    booking, payment = _state(pdb, kind, b, pay)
    assert payment.status == CustomerPaymentStatus.FAILED.value
    assert booking.status == CustomerBookingStatus.PENDING.value


def test_recovery_sweep_settles_a_payment_nothing_announced(monkeypatch, pdb, provider, case):
    kind, b, pay, oid = case
    _status(monkeypatch, oid)
    tally = verification.reconcile_stale_pending(pdb)
    assert tally["captured"] == 1
    booking, payment = _state(pdb, kind, b, pay)
    assert payment.status == CustomerPaymentStatus.CAPTURED.value
    assert booking.status == CustomerBookingStatus.CONFIRMED.value
    assert verification.reconcile_stale_pending(pdb)["seen"] == 0
    assert _confirmations(pdb) == 1


def test_recovery_sweep_survives_an_hdfc_outage(monkeypatch, pdb, provider, case):
    import requests

    kind, b, pay, oid = case
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": requests.Timeout("slow")})
    tally = verification.reconcile_stale_pending(pdb)
    assert tally["retryable"] == 1
    booking, payment = _state(pdb, kind, b, pay)
    assert payment.status == CustomerPaymentStatus.PENDING.value
    assert booking.status == CustomerBookingStatus.PENDING.value
