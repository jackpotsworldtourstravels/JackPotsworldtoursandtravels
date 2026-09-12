"""A small harness for testing payment verification without a real database.

WHY THIS EXISTS
The Tours backend had no unit-test harness -- `tests/` at the repo root holds
integration scripts that need a running server and a live provider. That is a
poor place to pin the behaviour of code that decides money has moved: it cannot
be run while writing the code, and it cannot exercise a provider that disagrees
with us, which is the only interesting case.

WHY SQLITE NEEDS A SHIM
The customer catalogue uses PostgreSQL ARRAY columns, which SQLite cannot
render. The shim below teaches it to store them as text, which is enough -- no
test here reads an array. Everything the tests DO read (amounts, currencies,
statuses, provider identifiers) is an ordinary column type and behaves
identically on both engines.
"""

from __future__ import annotations

import datetime as dt
import decimal
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


@compiles(ARRAY, "sqlite")
def _sqlite_array(element, compiler, **kw):  # noqa: D401 - test shim
    """Render a PostgreSQL ARRAY as TEXT on SQLite. No test reads one."""
    return "TEXT"


@compiles(JSONB, "sqlite")
def _sqlite_jsonb(element, compiler, **kw):  # noqa: D401 - test shim
    """Likewise for JSONB, used by the webhook event log."""
    return "TEXT"


from app.models_customer import (  # noqa: E402
    Base,
    Customer,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPaymentStatus,
)


@pytest.fixture()
def db():
    """A fresh in-memory database per test."""
    engine = create_engine("sqlite://")
    # ONLY THE TABLES THESE TESTS TOUCH.
    # Creating the whole schema drags in Postgres-only server defaults
    # ("{}"::jsonb on the webhook event log) that SQLite cannot parse. Nothing
    # here reads those tables, and narrowing the harness is better than teaching
    # it to fake half of PostgreSQL.
    Base.metadata.create_all(engine, tables=[
        Customer.__table__,
        CustomerHotelBooking.__table__,
        CustomerHotelBookingPayment.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


#: SQLite does not run PostgreSQL identity sequences, so the harness supplies
#: primary keys itself. They carry no meaning beyond being distinct.
_NEXT_ID = {"n": 1000}


def _next_id() -> int:
    _NEXT_ID["n"] += 1
    return _NEXT_ID["n"]


@pytest.fixture()
def customer(db):
    c = Customer(
        customer_id=_next_id(),
        customer_code="CUST0001",
        full_name="Test Traveller",
        email="traveller@example.test",
        mobile="9000000000",
    )
    db.add(c)
    db.flush()
    return c


def make_booking(db, customer, *, ref="JPH000999", total="56.00", currency="INR",
                 status="pending", created_at=None):
    """A hotel booking carrying the fields the verifier actually reads."""
    b = CustomerHotelBooking(
        customer_hotel_booking_id=_next_id(),
        booking_ref=ref,
        customer_id=customer.customer_id,
        hotel_id=1,
        hotel_name="TEST PROPERTY",
        room_id=1,
        room_name="Test Room",
        check_in_date=dt.date(2026, 9, 12),
        check_out_date=dt.date(2026, 9, 13),
        nights=1,
        total_amount=decimal.Decimal(total),
        currency=currency,
        status=status,
        created_at=created_at or dt.datetime.now(dt.timezone.utc),
    )
    db.add(b)
    db.flush()
    return b


def make_payment(db, booking, *, amount="56.00", currency="INR",
                 status=CustomerPaymentStatus.FAILED.value,
                 provider="trustbrick", order_id="order_TEST",
                 payment_id="pay_declined"):
    p = CustomerHotelBookingPayment(
        customer_hotel_booking_payment_id=_next_id(),
        hotel_booking_id=booking.customer_hotel_booking_id,
        method="gateway",
        amount=decimal.Decimal(amount),
        currency=currency,
        status=status,
        provider=provider,
        provider_order_id=order_id,
        provider_payment_id=payment_id,
    )
    db.add(p)
    db.flush()
    return p


class FakeRemote:
    """What an adapter reports back about one provider payment."""

    def __init__(self, *, status, payment_id, order_id, amount_minor=5600,
                 currency="INR", provider_status=None, method="card",
                 failure_reason=None):
        self.status = status
        self.provider_payment_id = payment_id
        self.provider_order_id = order_id
        self.amount_minor = amount_minor
        self.currency = currency
        self.provider_status = provider_status or status
        self.method = method
        self.failure_reason = failure_reason


class FakeProvider:
    """A provider that can forget a payment id, exactly as TrustBrick does.

    ``known`` maps payment id -> FakeRemote. An id absent from it raises the
    same error the real adapter raises for a 404, which is the situation this
    whole fix exists for.
    """

    name = "trustbrick"

    def __init__(self, *, known=None, order=None):
        self.known = dict(known or {})
        self.order = order
        self.fetch_payment_calls = []
        self.fetch_order_calls = []
        self.capture_calls = []

    def fetch_payment(self, payment_id):
        from app.services import payments as payment_providers

        self.fetch_payment_calls.append(payment_id)
        if payment_id not in self.known:
            raise payment_providers.PaymentProviderError(
                f"TrustBrick has no such payment: {payment_id}"
            )
        return self.known[payment_id]

    def fetch_order(self, order_id):
        from app.services import payments as payment_providers

        self.fetch_order_calls.append(order_id)
        if self.order is None:
            raise payment_providers.PaymentProviderError("No such order.")
        return self.order

    def capture(self, *, provider_payment_id, amount_minor, currency):
        self.capture_calls.append(provider_payment_id)
        raise AssertionError(
            "capture() must not be called for a refunded payment."
        )
