"""Two hardening fixes to the sandbox payment guard, each pinned by regression tests.

FINDING A -- RESUMING AN EXISTING ORDER
A checkout is "resumed" when the customer presses Pay Now again with the same
idempotency key: the order already opened is handed back, together with ITS
provider's payment link. The first version of the guard checked only the
CONFIGURED provider, so with another provider configured an old HDFC sandbox
order could be re-opened and paid. The gate now also runs on the provider that
holds the order, before the link is rebuilt, in the flight, hotel and package
services. Verification (return, webhook, reconcile, sweep) is untouched.

FINDING B -- A DEPLOYED HOST COLLECTS ONLY ON AN EXPLICITLY RECOGNISED HOST
The first version recognised only UAT hosts, so a trailing-dot, aliased or
unknown gateway host fell outside the rule. Now a deployed host collects only on
(a) a recognised PRODUCTION host with PAYMENT_ENVIRONMENT=live, or (b) a
recognised UAT host with both sandbox controls. Everything else is refused.

Nothing here opens a socket or moves money: HDFC's API is ``FakeHDFC`` and the
database is SQLite.
"""

from __future__ import annotations

import datetime as dt
import decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models_customer import (
    Base,
    Customer,
    CustomerAuditLog,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerNotification,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
)
from app.services import customer_booking_service, customer_package_booking_service
from app.services import customer_hotel_booking_service as hotel_service
from app.services import payment_event_service as pes
from app.services import payments as P
from app.services.payments import hdfc_readiness, sandbox_guard
from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
from tests.hdfc_fakes import BASE, FakeHDFC, FakeResponse, order_doc
from tests.test_hdfc_flow import _EVENTS_DDL
from tests.test_hdfc_production import (  # noqa: F401  (autouse fixture is used by name)
    _fresh_provider_cache,
    _live_settings,
    _set,
    _uat_settings,
)
from tests.test_sandbox_payment_guard import NEUTRAL, _deployed_uat, _person, _readiness

_RID = {"n": 90000}


def _rid() -> int:
    _RID["n"] += 1
    return _RID["n"]


# ===========================================================================
# FINDING A: resuming an EXISTING order is gated on the provider that holds it
# ===========================================================================
@pytest.fixture(params=["hotel", "flight", "package"])
def resume_case(request):
    """A booking of each product with an OPEN, pending HDFC order, as the 28
    incident rows are: (service, db, customer, booking, key, order_id)."""
    kind = request.param
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerBooking.__table__, CustomerBookingPayment.__table__,
        CustomerPackageBooking.__table__, CustomerPackageBookingPayment.__table__,
        CustomerHotelBooking.__table__, CustomerHotelBookingPayment.__table__,
        CustomerNotification.__table__, CustomerAuditLog.__table__,
    ])
    with engine.begin() as conn:
        conn.execute(text(_EVENTS_DDL))
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    ref = {"hotel": "JPH000555", "flight": "JPB000555", "package": "JPP000555"}[kind]
    key = f"mb-{ref}-open"
    oid = HDFCSmartGatewayProvider.order_id_for(ref, key)
    customer = Customer(customer_id=_rid(), customer_code=f"CUST{_rid()}",
                        full_name="Test Traveller", email=f"t{_rid()}@example.test",
                        mobile="9000000000")
    db.add(customer)
    db.flush()
    now = dt.datetime.now(dt.timezone.utc)
    amount = decimal.Decimal("56.00")
    pending = CustomerPaymentStatus.PENDING.value
    common = dict(method="gateway", amount=amount, currency="INR", status=pending,
                  provider="hdfc", provider_order_id=oid, idempotency_key=key)
    if kind == "hotel":
        booking = CustomerHotelBooking(
            customer_hotel_booking_id=_rid(), booking_ref=ref, customer_id=customer.customer_id,
            hotel_id=1, hotel_name="TEST PROPERTY", room_id=1, room_name="Test Room",
            check_in_date=dt.date(2026, 12, 12), check_out_date=dt.date(2026, 12, 13),
            nights=1, total_amount=amount, currency="INR",
            status=CustomerBookingStatus.PENDING.value, created_at=now)
        db.add(booking)
        db.flush()
        db.add(CustomerHotelBookingPayment(
            customer_hotel_booking_payment_id=_rid(),
            hotel_booking_id=booking.customer_hotel_booking_id, **common))
        service = hotel_service
    elif kind == "flight":
        booking = CustomerBooking(
            customer_booking_id=_rid(), booking_ref=ref, customer_id=customer.customer_id,
            total_amount=amount, currency="INR",
            status=CustomerBookingStatus.PENDING.value, created_at=now)
        db.add(booking)
        db.flush()
        db.add(CustomerBookingPayment(
            customer_booking_payment_id=_rid(),
            customer_booking_id=booking.customer_booking_id, **common))
        service = customer_booking_service
    else:
        booking = CustomerPackageBooking(
            customer_package_booking_id=_rid(), booking_ref=ref, customer_id=customer.customer_id,
            package_id=1, package_name="Test Package", package_days=3, departure_id=1,
            departure_date=dt.date(2026, 12, 1), total_amount=amount, currency="INR",
            status=CustomerBookingStatus.PENDING.value, created_at=now)
        db.add(booking)
        db.flush()
        db.add(CustomerPackageBookingPayment(
            customer_package_booking_payment_id=_rid(),
            package_booking_id=booking.customer_package_booking_id, **common))
        service = customer_package_booking_service
    db.commit()
    try:
        yield service, db, customer, booking, key, oid
    finally:
        db.close()
        engine.dispose()


def _another_provider_is_configured(monkeypatch):
    """PAYMENT_PROVIDER moved to a different provider while HDFC's settings and
    its old orders remain: the configured provider and the one holding the order
    now differ."""
    other = SimpleNamespace(name="razorpay", publishable_key="rzp_not_a_real_key")
    monkeypatch.setattr(P, "get_provider_for_booking", lambda ref: other)


def _open_order_at_hdfc(monkeypatch, oid, status="NEW"):
    return FakeHDFC(monkeypatch, {
        f"GET /orders/{oid}": FakeResponse(200, order_doc(oid, status=status, amount="56.00")),
    })


def test_resume_of_an_hdfc_order_is_refused_when_another_provider_is_configured(
        monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _deployed_uat(monkeypatch)                    # deployed, UAT gateway, both controls off
    _another_provider_is_configured(monkeypatch)
    fake = _open_order_at_hdfc(monkeypatch, oid)

    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        service.start_checkout(db, customer, booking, idempotency_key=key)

    assert exc.value.customer_message == NEUTRAL
    assert fake.calls == []                       # no payment link was fetched from HDFC


def test_resume_is_refused_to_a_customer_not_on_the_allowlist(monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids=str(customer.customer_id + 1))
    _another_provider_is_configured(monkeypatch)
    fake = _open_order_at_hdfc(monkeypatch, oid)

    with pytest.raises(P.SandboxPaymentsBlocked):
        service.start_checkout(db, customer, booking, idempotency_key=key)

    assert fake.calls == []


def test_an_allowlisted_customer_can_still_resume_in_a_controlled_test(monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _deployed_uat(monkeypatch, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids=str(customer.customer_id))
    _another_provider_is_configured(monkeypatch)
    fake = _open_order_at_hdfc(monkeypatch, oid)

    row, session = service.start_checkout(db, customer, booking, idempotency_key=key)

    assert session.provider == "hdfc" and session.order_id == oid
    assert str(session.redirect_url).startswith(BASE)
    assert fake.count("GET", f"/orders/{oid}") == 1


def test_resume_is_unchanged_off_a_deployed_host(monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _uat_settings(monkeypatch)                    # deployed=False: local dev / UAT tunnel
    _another_provider_is_configured(monkeypatch)
    _open_order_at_hdfc(monkeypatch, oid)

    row, session = service.start_checkout(db, customer, booking, idempotency_key=key)

    assert session.provider == "hdfc" and str(session.redirect_url).startswith(BASE)


def test_resume_with_hdfc_configured_is_refused_by_default_for_every_product(
        monkeypatch, resume_case):
    service, db, customer, booking, key, oid = resume_case
    _deployed_uat(monkeypatch)                    # HDFC IS the configured provider
    fake = _open_order_at_hdfc(monkeypatch, oid)

    with pytest.raises(P.SandboxPaymentsBlocked):
        service.start_checkout(db, customer, booking, idempotency_key=key)

    assert fake.calls == []


def test_verification_of_the_open_order_still_works_while_resume_is_refused(
        monkeypatch, resume_case):
    """Refusing to RESUME must not stop the order being VERIFIED."""
    service, db, customer, booking, key, oid = resume_case
    _deployed_uat(monkeypatch)
    fake = _open_order_at_hdfc(monkeypatch, oid, status="CHARGED")
    payment = next(
        p for model in pes._PAYMENT_MODELS
        for p in db.execute(select(model)).scalars()
        if p.provider_order_id == oid
    )

    result = pes.verify_payment_row(db, payment, "hdfc")
    db.commit()

    assert result is not None and fake.count("GET", f"/orders/{oid}") == 1
    db.refresh(payment)
    assert payment.status == CustomerPaymentStatus.CAPTURED.value


# ===========================================================================
# FINDING B: a deployed host collects only on an EXPLICITLY recognised host
# ===========================================================================
UAT_ORIGINS = [
    "https://smartgateway.hdfcuat.bank.in",
    "https://smartgatewayuat.hdfcbank.com",
    "https://SmartGateway.HdfcUat.Bank.In",            # hostnames are case-insensitive
    "https://smartgateway.hdfcuat.bank.in/",
    "https://smartgateway.hdfcuat.bank.in:443",
    "  https://smartgateway.hdfcuat.bank.in  ",
]

UNRECOGNISED_BASES = [
    "https://smartgateway.hdfcuat.bank.in.",           # trailing dot
    "https://smartgatewayuat.hdfcbank.com.",
    "https://smartgateway.hdfc.bank.in.",              # trailing dot on production
    "https://smartgateway.example.test",               # unknown host
    "https://uat.smartgateway.hdfcuat.bank.in",        # sub-domain alias
    "https://smartgateway.hdfcuat.bank.in.evil.example",
    "https://smartgateway.hdfcuat.bank.in@evil.example",   # userinfo trick
    "https://user:pw@smartgateway.hdfcuat.bank.in",
    "https://smartgateway.hdfcuat.bank.in:8443",       # non-default port
    "http://smartgateway.hdfcuat.bank.in",             # not https
    "https://smartgateway.hdfcuat.bank.in/v1",         # a path
    "https://smartgateway.hdfcuat.bank.in?x=1",        # a query
    "https://smartgateway.hdfcuat.bank.in#frag",       # a fragment
    "https://",
    "not a url",
    "smartgateway.hdfcuat.bank.in",                    # no scheme
    "",
    None,
]


@pytest.mark.parametrize("base", UAT_ORIGINS)
def test_a_recognised_uat_host_collects_only_with_both_controls(monkeypatch, base):
    _deployed_uat(monkeypatch, hdfc_sg_base_url=base)
    assert sandbox_guard.classify_gateway() == sandbox_guard.UAT
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.get_provider()                                   # controls off: refused
    _set(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="11")
    assert P.get_provider().name == "hdfc"                 # controls on: allowed


@pytest.mark.parametrize("base", UNRECOGNISED_BASES)
def test_an_unrecognised_gateway_host_never_collects_on_a_deployed_host(monkeypatch, base):
    # Even with BOTH controls on and a perfectly good allowlist.
    _deployed_uat(monkeypatch, hdfc_sg_base_url=base, allow_sandbox_payments=True,
                  sandbox_payment_customer_ids="11")

    assert sandbox_guard.classify_gateway() == sandbox_guard.UNKNOWN
    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        P.get_provider()
    assert "recognised" in str(exc.value)
    assert not sandbox_guard.customer_may_use("hdfc", _person(11))
    assert P.available_for_customer(None, _person(11)) is None
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.require_customer_access(SimpleNamespace(name="hdfc"), _person(11))


@pytest.mark.parametrize("base", UNRECOGNISED_BASES[:12])
def test_an_unrecognised_host_does_not_affect_local_development(monkeypatch, base):
    _uat_settings(monkeypatch)                             # deployed=False
    _set(monkeypatch, hdfc_sg_base_url=base)
    assert sandbox_guard.customer_may_use("hdfc", _person(12345))
    assert not sandbox_guard.restricted("hdfc")


def test_an_unrecognised_host_still_verifies_existing_orders(monkeypatch):
    # A mis-spelt host must refuse NEW checkouts, not strand paid orders.
    _deployed_uat(monkeypatch, hdfc_sg_base_url="https://smartgateway.example.test")
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.get_provider()
    assert P.get_provider_named("hdfc").name == "hdfc"


def test_the_approved_production_configuration_collects_without_sandbox_controls(monkeypatch):
    _live_settings(monkeypatch, allow_sandbox_payments=False, sandbox_payment_customer_ids="")
    assert sandbox_guard.classify_gateway() == sandbox_guard.PRODUCTION
    assert not sandbox_guard.restricted("hdfc")
    provider = P.get_provider()
    assert provider.name == "hdfc"
    P.require_customer_access(provider, _person(777))      # any customer
    assert P.available_for_customer(None, None) is provider


@pytest.mark.parametrize("env", ["test", "sandbox", "", "local"])
def test_a_production_host_without_a_live_environment_is_refused(monkeypatch, env):
    _live_settings(monkeypatch, payment_environment=env)
    with pytest.raises(P.PaymentProviderError):            # guard or adapter: refused
        P.get_provider()
    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        sandbox_guard.assert_collection_allowed()
    assert "not live" in str(exc.value)


@pytest.mark.parametrize("base", [
    "https://smartgateway.hdfc.bank.in.",
    "https://smartgateway.hdfc.bank.in@evil.example",
    "https://pay.hdfc.bank.in",
    "https://smartgateway.hdfc.bank.in:8443",
])
def test_an_unrecognised_host_is_not_production_even_in_a_live_environment(monkeypatch, base):
    _live_settings(monkeypatch, hdfc_sg_base_url=base)
    assert sandbox_guard.classify_gateway() == sandbox_guard.UNKNOWN
    assert sandbox_guard.restricted("hdfc")
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.get_provider()


def test_a_uat_host_in_a_live_environment_is_refused(monkeypatch):
    _live_settings(monkeypatch, hdfc_sg_base_url=BASE, allow_sandbox_payments=True,
                   sandbox_payment_customer_ids="11")
    with pytest.raises(P.PaymentProviderError):            # the adapter's own refusal
        P.get_provider()


def test_readiness_blocks_an_unrecognised_gateway_host(monkeypatch):
    checks = _readiness(monkeypatch, hdfc_sg_base_url="https://smartgateway.hdfcuat.bank.in.")
    assert checks["SANDBOX_PAYMENTS"].level == hdfc_readiness.BLOCK
    assert "recognised" in checks["SANDBOX_PAYMENTS"].detail


def test_readiness_has_no_sandbox_line_for_the_approved_production_configuration(monkeypatch):
    _live_settings(monkeypatch)
    assert "SANDBOX_PAYMENTS" not in {c.name for c in hdfc_readiness.evaluate()}
