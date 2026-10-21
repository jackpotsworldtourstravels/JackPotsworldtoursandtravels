"""Shared fakes for the deferred-payment-sweep tests.

A provider stub named "razorpay" (a drop-in provider, unlike HDFC's hosted page)
plus the database and row builders both sweep test files use. Nothing here
contacts a gateway: the stub answers from memory and the database is SQLite.

Same shape as ``hdfc_fakes.py`` on purpose.
"""

from __future__ import annotations

import datetime as dt
import decimal
import itertools
from types import SimpleNamespace

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
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerNotification,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
    PaymentProviderEvent,
)
from app.services import payments as P
from app.services.payments.base import (
    CAPTURED,
    PaymentNotConfigured,
    ProviderPayment,
)
from tests.test_hdfc_flow import _EVENTS_DDL

KINDS = ("package", "flight", "hotel")

_IDS = itertools.count(910000)
_SEQ = itertools.count(1)
_EPOCH = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)

_MODELS = {
    "package": (CustomerPackageBooking, CustomerPackageBookingPayment),
    "flight": (CustomerBooking, CustomerBookingPayment),
    "hotel": (CustomerHotelBooking, CustomerHotelBookingPayment),
}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class StubProvider:
    """A drop-in provider whose answers the test controls.

    ``explode_for`` holds provider payment ids whose lookup raises a plain
    ``RuntimeError`` -- the kind of unexpected, non-provider fault the verifiers
    deliberately do not catch.
    """

    name = "razorpay"
    publishable_key = "stub"

    def __init__(self, status: str = CAPTURED, amount_minor: int = 5600) -> None:
        self.status = status
        self.amount_minor = amount_minor
        self.explode_for: set[str] = set()
        self.orders: dict[str, str] = {}              # payment id -> order id
        self.asked: list[str] = []

    def _remote(self, pay_id: str | None) -> ProviderPayment:
        return ProviderPayment(
            status=self.status, provider_status=str(self.status),
            provider_payment_id=pay_id, provider_order_id=self.orders.get(pay_id),
            amount_minor=self.amount_minor, currency="INR", method="upi",
        )

    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment:
        self.asked.append(provider_payment_id)
        if provider_payment_id in self.explode_for:
            raise RuntimeError("unexpected fault while verifying (not a provider error)")
        return self._remote(provider_payment_id)

    def fetch_order(self, provider_order_id: str) -> ProviderPayment:
        pay_id = next((p for p, o in self.orders.items() if o == provider_order_id), None)
        return self.fetch_payment(pay_id) if pay_id else self._remote(None)


def make_db():
    """SQLite with the tables every product and the event log need."""
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerBooking.__table__, CustomerBookingPayment.__table__,
        CustomerPackageBooking.__table__, CustomerPackageBookingPayment.__table__,
        CustomerHotelBooking.__table__, CustomerHotelBookingPayment.__table__,
        CustomerNotification.__table__, CustomerAuditLog.__table__,
    ])
    with engine.begin() as conn:
        # The event log's Postgres-only '{}'::jsonb default is why this table is
        # created by hand; see test_hdfc_flow.
        conn.execute(text(_EVENTS_DDL))
    return engine, sessionmaker(bind=engine, expire_on_commit=False)()


def _customer(db, n: int) -> None:
    # A distinct mobile per customer: the real schema has a unique constraint on
    # it (uq_customers_mobile) that the model-built SQLite tables do not.
    db.add(Customer(customer_id=n, customer_code=f"C{n}", full_name="Test Traveller",
                    email=f"t{n}@example.test", mobile=f"9{n % 10**9:09d}"))
    db.flush()


def _booking_and_payment(db, kind: str, n: int, *, ref: str, provider: str,
                         pay_id: str | None, order_id: str, key: str,
                         created: dt.datetime) -> None:
    """One pending booking of Rs 56 and its pending payment, for any product."""
    common = dict(booking_ref=ref, customer_id=n, total_amount=decimal.Decimal("56.00"),
                  currency="INR", status=CustomerBookingStatus.PENDING.value,
                  created_at=created)
    paid = dict(method="gateway", amount=decimal.Decimal("56.00"), currency="INR",
                status=CustomerPaymentStatus.PENDING.value, provider=provider,
                provider_payment_id=pay_id, provider_order_id=order_id,
                idempotency_key=key, created_at=created)
    if kind == "package":
        db.add(CustomerPackageBooking(
            customer_package_booking_id=n, package_id=1, package_name="Pkg",
            package_days=3, departure_id=1, departure_date=dt.date(2026, 12, 1), **common))
        db.flush()
        db.add(CustomerPackageBookingPayment(
            customer_package_booking_payment_id=n, package_booking_id=n, **paid))
    elif kind == "flight":
        db.add(CustomerBooking(customer_booking_id=n, **common))
        db.flush()
        db.add(CustomerBookingPayment(
            customer_booking_payment_id=n, customer_booking_id=n, **paid))
    else:
        db.add(CustomerHotelBooking(
            customer_hotel_booking_id=n, hotel_id=1, hotel_name="Test Hotel", room_id=1,
            room_name="Test Room", check_in_date=dt.date(2026, 10, 12),
            check_out_date=dt.date(2026, 10, 13), nights=1, **common))
        db.flush()
        db.add(CustomerHotelBookingPayment(
            customer_hotel_booking_payment_id=n, hotel_booking_id=n, **paid))


def add_deferred(db, stub: StubProvider, kind: str) -> SimpleNamespace:
    """A pending payment of ``kind`` plus the webhook event deferred about it.

    Events are stamped in creation order, which is the order the sweep drains
    them in (``received_at``).
    """
    n = next(_IDS)
    pay_id, order_id = f"pay_{kind}_{n}", f"order_{kind}_{n}"
    _customer(db, n)
    _booking_and_payment(db, kind, n, ref=f"JP{kind[:1].upper()}{n}", provider="razorpay",
                         pay_id=pay_id, order_id=order_id, key=f"k{n}", created=_now())
    stub.orders[pay_id] = order_id
    db.add(PaymentProviderEvent(
        provider="razorpay", provider_event_id=f"evt_{n}", event_type="payment.captured",
        provider_payment_id=pay_id, provider_order_id=order_id, payload={},
        processing_status="deferred",
        received_at=_EPOCH + dt.timedelta(seconds=next(_SEQ))))
    db.commit()
    return SimpleNamespace(kind=kind, id=n, pay_id=pay_id, order_id=order_id)


def add_deferred_event_without_payment(db) -> SimpleNamespace:
    """A deferred event naming a payment this deployment has no row for."""
    n = next(_IDS)
    db.add(PaymentProviderEvent(
        provider="razorpay", provider_event_id=f"evt_{n}", event_type="payment.captured",
        provider_payment_id=f"pay_unknown_{n}", provider_order_id=f"order_unknown_{n}",
        payload={}, processing_status="deferred",
        received_at=_EPOCH + dt.timedelta(seconds=next(_SEQ))))
    db.commit()
    return SimpleNamespace(pay_id=f"pay_unknown_{n}")


def add_stale_hdfc_hotel(db, order_id: str, *, minutes_old: int = 10) -> SimpleNamespace:
    """An HDFC hotel payment still ``pending`` after ``minutes_old`` minutes --
    the kind the stale-payment recovery exists to settle."""
    n = next(_IDS)
    _customer(db, n)
    _booking_and_payment(
        db, "hotel", n, ref=f"JPH{n}", provider="hdfc", pay_id=None, order_id=order_id,
        key=f"hk{n}", created=_now() - dt.timedelta(minutes=minutes_old))
    db.commit()
    return SimpleNamespace(kind="hotel", id=n, order_id=order_id)


def state(db, case: SimpleNamespace) -> SimpleNamespace:
    """The event (if any), payment and booking rows for ``case``, freshly read."""
    db.expire_all()
    booking_model, payment_model = _MODELS[case.kind]
    event = None
    if getattr(case, "pay_id", None):
        event = db.execute(select(PaymentProviderEvent).where(
            PaymentProviderEvent.provider_payment_id == case.pay_id)).scalar_one_or_none()
    return SimpleNamespace(
        event=event, payment=db.get(payment_model, case.id), booking=db.get(booking_model, case.id))


def confirmations(db) -> int:
    return db.execute(
        select(func.count()).select_from(CustomerNotification)
        .where(CustomerNotification.notification_type == "booking_confirmed")
    ).scalar_one()


def use_providers(monkeypatch, *, stub: StubProvider | None = None, hdfc=None,
                  razorpay_unconfigured: bool = False) -> None:
    """Resolve provider names to these fakes; anything else goes to the real lookup."""
    real = P.get_provider_named

    def named(name):
        wanted = (name or "").lower()
        if wanted == "razorpay":
            if razorpay_unconfigured or stub is None:
                raise PaymentNotConfigured("razorpay is not the configured provider")
            return stub
        if wanted == "hdfc" and hdfc is not None:
            return hdfc
        return real(name)

    monkeypatch.setattr(P, "get_provider_named", named)


class KeepOpen:
    """A session stand-in whose ``close()`` does nothing, so a test can read the
    rows a scheduler entry point wrote through the same in-memory connection."""

    def __init__(self, session) -> None:
        self._s = session

    def __getattr__(self, name):
        return getattr(self._s, name)

    def close(self) -> None:
        pass
