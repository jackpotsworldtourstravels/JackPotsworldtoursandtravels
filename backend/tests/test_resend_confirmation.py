"""Issue #16 — Secure Resend Booking Confirmation.

Service-level tests for ``booking_confirmation_service.resend``: it re-queues an
existing (sent/failed) confirmation so the sweep sends it again, creates rows
when none exist yet, recomposes from current data, and respects the feature
gate. The owner/confirmed/rate-limit gating lives on the routers (thin wrappers
over this)."""
from __future__ import annotations

import datetime as dt
import decimal

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.models_customer import (
    Base, Customer, CustomerBookingNotification, CustomerHotelBooking,
    CustomerNotificationPreferences,
)
from app.services import booking_confirmation_service as bcs

_N = {"n": 9000}


def _id():
    _N["n"] += 1
    return _N["n"]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerHotelBooking.__table__, CustomerBookingNotification.__table__,
        CustomerNotificationPreferences.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    monkeypatch.setattr(settings, "booking_confirmation_enabled", True)


def _customer(db, email="guest@example.com", mobile="9000000000"):
    c = Customer(customer_id=_id(), customer_code=f"C{_N['n']}", full_name="Trav", email=email, mobile=mobile)
    db.add(c)
    db.flush()
    return c


def _booking(db, customer, ref="JPH700"):
    b = CustomerHotelBooking(
        customer_hotel_booking_id=_id(), booking_ref=ref, customer_id=customer.customer_id,
        status="confirmed", hotel_id=1, hotel_name="Test Property", room_id=1, room_name="Deluxe",
        check_in_date=dt.date(2026, 2, 1), check_out_date=dt.date(2026, 2, 3), nights=2,
        total_amount=decimal.Decimal("5600.00"), currency="INR",
    )
    db.add(b)
    db.flush()
    return b


def _rows(db, ref):
    return list(db.scalars(select(CustomerBookingNotification).where(
        CustomerBookingNotification.booking_ref == ref)).all())


def test_resend_requeues_an_already_sent_confirmation(db):
    c = _customer(db)
    b = _booking(db, c)
    for channel, recip in (("email", c.email), ("sms", c.mobile)):
        db.add(CustomerBookingNotification(
            customer_booking_notification_id=_id(), booking_ref=b.booking_ref, product="hotel",
            customer_id=c.customer_id, channel=channel, recipient=recip, subject="s", body="old",
            status="sent", attempts=3, error_message="prev", sent_at=dt.datetime.now(dt.timezone.utc),
        ))
    db.flush()
    out = bcs.resend(db, b, "hotel")
    assert len(out) == 2
    for row in _rows(db, b.booking_ref):
        assert row.status == "queued" and row.attempts == 0
        assert row.error_message is None and row.sent_at is None


def test_resend_creates_rows_when_none_exist(db):
    c = _customer(db)
    b = _booking(db, c, ref="JPH701")
    assert _rows(db, b.booking_ref) == []
    out = bcs.resend(db, b, "hotel")
    # Email + SMS, both queued (customer has both an email and a mobile).
    assert {r.channel for r in out} == {"email", "sms"}
    assert all(r.status == "queued" for r in _rows(db, b.booking_ref))


def test_resend_is_a_noop_when_confirmations_disabled(db, monkeypatch):
    monkeypatch.setattr(settings, "booking_confirmation_enabled", False)
    c = _customer(db)
    b = _booking(db, c, ref="JPH702")
    assert bcs.resend(db, b, "hotel") == []
    assert _rows(db, b.booking_ref) == []


def test_resend_rejects_unknown_product(db):
    c = _customer(db)
    b = _booking(db, c, ref="JPH703")
    assert bcs.resend(db, b, "cruise") == []
