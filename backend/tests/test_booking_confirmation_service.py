"""Unit tests for booking_confirmation_service (Phase 2 Bug 1).

A throw-away in-memory SQLite database with just the two tables this service
touches (Customer, CustomerBookingNotification). Bookings are light stand-ins
carrying only the fields the composer reads — the service never loads them from
the DB, it is handed the row that was just confirmed. Email and SMS are
monkeypatched, so nothing leaves the process.
"""
from __future__ import annotations

import datetime as dt
import decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models_customer import Base, Customer, CustomerBookingNotification
from app.services import booking_confirmation_service as bcs
from app.services import email_service, sms_service

_IDS = {"n": 7000}


def _id():
    _IDS["n"] += 1
    return _IDS["n"]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerBookingNotification.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def _confirmation_on(monkeypatch):
    monkeypatch.setattr(settings, "booking_confirmation_enabled", True)
    monkeypatch.setattr(settings, "booking_confirmation_max_attempts", 3)


def _customer(db, *, email="traveller@example.test", mobile="9000000012"):
    c = Customer(customer_id=_id(), customer_code=f"C{_IDS['n']}", full_name="Asha Rao",
                 email=email, mobile=mobile)
    db.add(c)
    db.flush()
    return c


def _flight(customer, ref="JPF000123"):
    return SimpleNamespace(
        booking_ref=ref, customer_id=customer.customer_id, total_amount=decimal.Decimal("12345.00"),
        currency="INR", origin_city="Delhi", destination_city="Goa", airline="IndiGo",
        flight_number="6E-203", travel_date=dt.date(2026, 12, 1), departure_time="08:10",
        arrival_time="10:40", cabin_class="Economy", pnr=None,
    )


# --------------------------------------------------------------- enqueue
def test_enqueue_queues_email_and_sms(db):
    c = _customer(db)
    rows = bcs.enqueue(db, _flight(c), "flight")
    channels = sorted(r.channel for r in rows)
    assert channels == ["email", "sms"]
    assert all(r.status == "queued" for r in rows)
    assert all(r.product == "flight" for r in rows)


def test_enqueue_email_only_when_no_mobile(db):
    c = _customer(db, mobile="")
    rows = bcs.enqueue(db, _flight(c), "flight")
    assert [r.channel for r in rows] == ["email"]


def test_enqueue_is_idempotent_per_channel(db):
    c = _customer(db)
    bcs.enqueue(db, _flight(c), "flight")
    bcs.enqueue(db, _flight(c), "flight")  # retry / redelivered callback
    total = db.scalar(select(__import__("sqlalchemy").func.count()).select_from(CustomerBookingNotification))
    assert total == 2  # one email + one sms, not four


def test_enqueue_disabled_writes_nothing(db, monkeypatch):
    monkeypatch.setattr(settings, "booking_confirmation_enabled", False)
    c = _customer(db)
    assert bcs.enqueue(db, _flight(c), "flight") == []


def test_compose_has_reference_amount_link_and_no_card_data(db):
    c = _customer(db)
    rows = bcs.enqueue(db, _flight(c), "flight")
    email = next(r for r in rows if r.channel == "email")
    assert "JPF000123" in email.body
    assert "INR 12,345.00" in email.body
    assert "/my-bookings" in email.body
    # Nothing sensitive is ever composed in.
    low = email.body.lower()
    for forbidden in ("card", "cvv", "password", "token"):
        assert forbidden not in low


def test_compose_hotel_and_package_headlines(db):
    c = _customer(db)
    hotel = SimpleNamespace(booking_ref="JPH1", customer_id=c.customer_id,
                            total_amount=decimal.Decimal("900.00"), currency="INR",
                            hotel_name="Sea View", hotel_location="Goa", room_name="Deluxe",
                            check_in_date=dt.date(2026, 12, 1), check_out_date=dt.date(2026, 12, 3),
                            nights=2, rooms_count=1)
    pkg = SimpleNamespace(booking_ref="JPP1", customer_id=c.customer_id,
                          total_amount=decimal.Decimal("50000.00"), currency="INR",
                          package_name="Bali Escape", package_days=5,
                          departure_date=dt.date(2026, 12, 10), pax_count=2)
    he = next(r for r in bcs.enqueue(db, hotel, "hotel") if r.channel == "email")
    pe = next(r for r in bcs.enqueue(db, pkg, "package") if r.channel == "email")
    assert "Sea View" in he.body and "JPH1" in he.body
    assert "Bali Escape" in pe.body and "JPP1" in pe.body


# --------------------------------------------------------------- process_pending
def test_process_sends_email_and_marks_sent(db, monkeypatch):
    c = _customer(db, mobile="")  # email only, keeps this test to one channel
    bcs.enqueue(db, _flight(c), "flight")
    db.commit()
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
    monkeypatch.setattr(settings, "smtp_from_email", "no-reply@example.test")
    sent = []
    monkeypatch.setattr(email_service, "_send", lambda to, subj, text, html: sent.append(to) or True)

    tally = bcs.process_pending(db)
    assert tally == {"seen": 1, "sent": 1, "failed": 0, "suppressed": 0}
    row = db.scalar(select(CustomerBookingNotification))
    assert row.status == "sent" and row.sent_at is not None and row.attempts == 1
    assert sent == ["traveller@example.test"]


def test_email_without_smtp_is_suppressed_not_failed(db, monkeypatch):
    c = _customer(db, mobile="")
    bcs.enqueue(db, _flight(c), "flight")
    db.commit()
    monkeypatch.setattr(settings, "smtp_host", None)
    monkeypatch.setattr(settings, "smtp_from_email", None)
    monkeypatch.setattr(email_service, "_send", lambda *a, **k: False)
    tally = bcs.process_pending(db)
    assert tally["suppressed"] == 1 and tally["failed"] == 0
    assert db.scalar(select(CustomerBookingNotification)).status == "suppressed"


def test_email_refused_is_failed_and_retried_then_parked(db, monkeypatch):
    c = _customer(db, mobile="")
    bcs.enqueue(db, _flight(c), "flight")
    db.commit()
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
    monkeypatch.setattr(settings, "smtp_from_email", "no-reply@example.test")
    monkeypatch.setattr(email_service, "_send", lambda *a, **k: False)  # configured but refused

    # max_attempts is 3 (fixture): three sweeps should exhaust it.
    for _ in range(3):
        bcs.process_pending(db)
    row = db.scalar(select(CustomerBookingNotification))
    assert row.status == "failed" and row.attempts == 3
    # A fourth sweep no longer touches it (attempts >= max).
    assert bcs.process_pending(db)["seen"] == 0
    parked, total = bcs.failed(db)
    assert total == 1 and parked[0].booking_ref == "JPF000123"


def test_sms_suppressed_when_disabled(db, monkeypatch):
    c = _customer(db)  # has mobile
    bcs.enqueue(db, _flight(c), "flight")
    db.commit()
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
    monkeypatch.setattr(settings, "smtp_from_email", "no-reply@example.test")
    monkeypatch.setattr(email_service, "_send", lambda *a, **k: True)
    monkeypatch.setattr(settings, "sms_enabled", False)
    tally = bcs.process_pending(db)
    assert tally["sent"] == 1 and tally["suppressed"] == 1  # email sent, sms suppressed
    sms_row = db.scalar(select(CustomerBookingNotification).where(CustomerBookingNotification.channel == "sms"))
    assert sms_row.status == "suppressed"


def test_sms_sent_via_console_when_enabled(db, monkeypatch):
    c = _customer(db)
    bcs.enqueue(db, _flight(c), "flight")
    db.commit()
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
    monkeypatch.setattr(settings, "smtp_from_email", "no-reply@example.test")
    monkeypatch.setattr(email_service, "_send", lambda *a, **k: True)
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "console")
    tally = bcs.process_pending(db)
    assert tally["sent"] == 2
