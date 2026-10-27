"""The HDFC gateway order id on the reconcile response — the one thing the
success page needs so it can show the bank's order number next to our Booking
ID, as HDFC's verification request asks.

WHAT IS BEING PROVED, AND WHY IT IS THE WHOLE POINT
The gateway order id (HDFC's ``JP`` + 18 hex, or any provider's order id) sits
on the payment row from the moment a checkout is opened — long before the money
is verified. So the only safe way to surface it to the customer is to return it
ONLY once the payment is ``captured``, i.e. only after the server-side verifier
has read Order Status and matched the order, amount and currency against this
booking. These tests pin exactly that: captured -> the id is returned; pending,
failed or no-payment -> it is absent; and it is always the id off the row for
the booking the customer owns, never one chosen by the request.

The reconcile endpoint functions are called directly, with the booking lookup,
the reconcilable-payment lookup and the verifier stubbed. That keeps the test on
the new code — the gateway-order-id gate inside each endpoint — rather than on
the ORM relationships and customer auth those endpoints also depend on, which
the end-to-end suites (test_hdfc_flow.py, test_hdfc_products.py) already cover.
"""
from __future__ import annotations

import decimal

import pytest

from app.auth.rate_limit import limiter
from app.models_customer import CustomerPaymentStatus
from app.routers import (
    customer_bookings,
    customer_hotel_bookings,
    customer_package_bookings,
)
from app.schemas.customer_booking import FlightReconcileRequest
from app.schemas.customer_hotel_booking import HotelReconcileRequest
from app.schemas.customer_package_booking import PackageReconcileRequest

OID = "JP0123456789abcdef01"            # an HDFC-shaped order id (20 chars)


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    """The package reconcile route carries slowapi's @limiter.limit, which
    demands a real starlette Request when enabled. These tests call the
    endpoint functions directly, so the limiter is switched off — rate limiting
    is not what is under test here."""
    monkeypatch.setattr(limiter, "enabled", False)


# ---------------------------------------------------------------------------
# One row per product: the module whose names each endpoint resolves, the
# endpoint function, its request schema, the verifier module it calls, and the
# primary-key attribute the endpoint reads off the payment row.
# ---------------------------------------------------------------------------
class _Case:
    def __init__(self, name, router, endpoint, request_cls, verifier, pay_pk):
        self.name = name
        self.router = router
        self.endpoint = endpoint
        self.request_cls = request_cls
        self.verifier = verifier
        self.pay_pk = pay_pk


CASES = [
    _Case(
        "package", customer_package_bookings,
        customer_package_bookings.reconcile_package_payment,
        PackageReconcileRequest, customer_package_bookings.payment_verification_service,
        "customer_package_booking_payment_id",
    ),
    _Case(
        "flight", customer_bookings,
        customer_bookings.reconcile_flight_payment,
        FlightReconcileRequest, customer_bookings.verify_flight,
        "customer_booking_payment_id",
    ),
    _Case(
        "hotel", customer_hotel_bookings,
        customer_hotel_bookings.reconcile_hotel_payment,
        HotelReconcileRequest, customer_hotel_bookings.verify_hotel,
        "customer_hotel_booking_payment_id",
    ),
]
IDS = [c.name for c in CASES]


class _Payment:
    def __init__(self, pk_attr, *, status, order_id, amount="56.00", currency="INR"):
        setattr(self, pk_attr, 1)
        self.status = status
        self.provider = "hdfc"
        self.provider_order_id = order_id
        self.amount = decimal.Decimal(amount) if amount is not None else None
        self.currency = currency


class _Booking:
    def __init__(self, ref="JPH000777", status="confirmed"):
        self.booking_ref = ref
        self.status = status


class _Result:
    """Enough of a Verification for the endpoint to render a response."""

    def __init__(self, *, disposition="done", code="already_captured",
                 captured_now=False, confirmed_now=False):
        self.disposition = disposition
        self.code = code
        self.captured_now = captured_now
        self.booking_confirmed_now = confirmed_now


class _DB:
    def commit(self):
        pass

    def refresh(self, _obj):
        pass


def _wire(case, monkeypatch, *, booking, payment, result=None):
    """Stub the lookups and the verifier the endpoint reaches, so the call
    exercises only the gateway-order-id gate."""
    monkeypatch.setattr(case.router.bookings, "get_owned",
                        lambda db, customer, ref: booking)
    monkeypatch.setattr(case.router.bookings, "reconcilable_payment",
                        lambda db, b: payment)
    monkeypatch.setattr(case.verifier, "verify_and_capture",
                        lambda db, pid, **kw: result or _Result())
    # The audit write and its request context fire only when something moved;
    # neutralise both so no real Request or DB session is needed.
    monkeypatch.setattr(case.router.customer_audit_service, "log",
                        lambda *a, **k: None)
    monkeypatch.setattr(case.router.activity_service, "request_context",
                        lambda request: {})


def _call(case):
    return case.endpoint(
        request=object(), booking_ref="JPH000777",
        payload=case.request_cls(), db=_DB(), customer=object(),
    )


# ---------------------------------------------------------------------------
# Captured -> the gateway order id is shown, with the verified amount
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_captured_payment_exposes_the_gateway_order_id(case, monkeypatch):
    payment = _Payment(case.pay_pk, status=CustomerPaymentStatus.CAPTURED.value,
                       order_id=OID)
    _wire(case, monkeypatch, booking=_Booking(), payment=payment)

    resp = _call(case)

    # The bank's order number, straight off the verified row.
    assert resp.gateway_order_id == OID
    # Regression: the fields the success screen already relied on are intact.
    assert resp.booking_ref == "JPH000777"
    assert resp.booking_status == "confirmed"
    assert resp.payment_status == CustomerPaymentStatus.CAPTURED.value
    assert resp.amount == 56.0 and resp.currency == "INR"


# ---------------------------------------------------------------------------
# Not captured -> the id is withheld (the missing-gateway-order-id case)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES, ids=IDS)
@pytest.mark.parametrize("status", [
    CustomerPaymentStatus.PENDING.value,
    CustomerPaymentStatus.FAILED.value,
])
def test_unverified_payment_hides_the_gateway_order_id(case, status, monkeypatch):
    # The order id is PRESENT on the row (a checkout was opened) but the money
    # is not verified, so the response must not carry it.
    payment = _Payment(case.pay_pk, status=status, order_id=OID)
    result = _Result(disposition="retryable", code="not_yet_paid")
    _wire(case, monkeypatch, booking=_Booking(status="pending"),
          payment=payment, result=result)

    resp = _call(case)

    assert resp.gateway_order_id is None
    assert resp.payment_status == status


# ---------------------------------------------------------------------------
# No checkout ever opened -> no payment, no id, no error
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_no_payment_yields_no_gateway_order_id(case, monkeypatch):
    monkeypatch.setattr(case.router.bookings, "get_owned",
                        lambda db, customer, ref: _Booking(status="pending"))
    monkeypatch.setattr(case.router.bookings, "reconcilable_payment",
                        lambda db, b: None)

    resp = _call(case)

    assert resp.code == "no_payment"
    assert resp.gateway_order_id is None
    assert resp.payment_status is None


# ---------------------------------------------------------------------------
# Ownership: the id returned is the one off the owned booking's row, never a
# value the request could influence; a booking that is not the customer's 404s.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_gateway_order_id_is_read_off_the_owned_payment(case, monkeypatch):
    other = "JP00000000000000beef"
    payment = _Payment(case.pay_pk, status=CustomerPaymentStatus.CAPTURED.value,
                       order_id=other)
    _wire(case, monkeypatch, booking=_Booking(), payment=payment)

    resp = _call(case)

    # Exactly the owned row's order id — not OID, not anything from the request.
    assert resp.gateway_order_id == other


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_a_booking_that_is_not_the_customers_404s_and_leaks_nothing(case, monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(case.router.bookings, "get_owned",
                        lambda db, customer, ref: None)

    with pytest.raises(HTTPException) as exc:
        _call(case)
    assert exc.value.status_code == 404
