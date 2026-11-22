"""Integration: confirming a booking enqueues its confirmation (Phase 2 Bug 1).

Exercises the real ``payment_verification_hotel_service.confirm_booking`` — the
single seam all five confirmation paths funnel through — and proves the
confirmation row is written in the SAME transaction that flips the booking to
CONFIRMED, idempotently. Same throw-away SQLite shape as test_hdfc_flow.py plus
the new outbox table.
"""
from __future__ import annotations

import datetime as dt
import decimal

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.models_customer import (
    Base,
    Customer,
    CustomerAuditLog,
    CustomerBookingNotification,
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerNotification,
    CustomerPaymentStatus,
)
from app.services import payment_verification_hotel_service as verify

D = decimal.Decimal
_IDS = {"n": 8000}


def _id():
    _IDS["n"] += 1
    return _IDS["n"]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerHotelBooking.__table__, CustomerHotelBookingPayment.__table__,
        CustomerNotification.__table__, CustomerAuditLog.__table__,
        CustomerBookingNotification.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _confirmable(db, *, ref="JPH000555", total="900.00"):
    c = Customer(customer_id=_id(), customer_code=f"C{_IDS['n']}", full_name="Asha Rao",
                 email="asha@example.test", mobile="9000000012")
    db.add(c)
    db.flush()
    b = CustomerHotelBooking(
        customer_hotel_booking_id=_id(), booking_ref=ref, customer_id=c.customer_id,
        hotel_id=1, hotel_name="Sea View", room_id=1, room_name="Deluxe",
        check_in_date=dt.date(2026, 12, 1), check_out_date=dt.date(2026, 12, 2), nights=1,
        total_amount=D(total), currency="INR", status=CustomerBookingStatus.PENDING.value,
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    db.add(b)
    db.flush()
    p = CustomerHotelBookingPayment(
        customer_hotel_booking_payment_id=_id(), hotel_booking_id=b.customer_hotel_booking_id,
        method="gateway", amount=D(total), currency="INR",
        status=CustomerPaymentStatus.CAPTURED.value, provider="trustbrick",
        provider_order_id="order_X", provider_payment_id="pay_X",
    )
    db.add(p)
    db.flush()
    return b, p


def _notifications(db):
    return db.scalar(select(func.count()).select_from(CustomerBookingNotification))


def test_confirm_booking_enqueues_confirmation(db):
    b, p = _confirmable(db)
    assert verify.confirm_booking(db, p, b) is True
    db.commit()
    # The booking is confirmed AND a confirmation is queued, atomically.
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    rows = list(db.scalars(select(CustomerBookingNotification)))
    assert {r.channel for r in rows} == {"email", "sms"}
    assert all(r.product == "hotel" and r.status == "queued" for r in rows)
    assert all(r.booking_ref == "JPH000555" for r in rows)


def test_second_confirm_is_a_noop_and_does_not_double_enqueue(db):
    b, p = _confirmable(db)
    assert verify.confirm_booking(db, p, b) is True
    db.commit()
    first = _notifications(db)
    # A redelivered callback: confirm_booking sees CONFIRMED and returns False.
    assert verify.confirm_booking(db, p, b) is False
    db.commit()
    assert _notifications(db) == first


def test_unconfirmable_booking_enqueues_nothing(db):
    """An amount mismatch must not confirm, and must not queue a confirmation."""
    b, p = _confirmable(db, total="900.00")
    p.amount = D("1.00")  # captured the wrong amount
    db.flush()
    assert verify.confirm_booking(db, p, b) is False
    db.commit()
    assert b.status == CustomerBookingStatus.PENDING.value
    assert _notifications(db) == 0
