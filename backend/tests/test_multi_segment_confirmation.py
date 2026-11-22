"""Integration: a MULTI-SEGMENT flight booking gets exactly ONE confirmation.

Phase 2 ties two features together — multi-segment bookings (one ``customer_bookings``
envelope owning N ``customer_booking_segments``) and the booking-confirmation outbox
(``CustomerBookingNotification``, idempotent per ``(booking_ref, channel)``). This
test proves they compose correctly: confirming a round trip (two segments) through
``payment_verification_flight_service.confirm_booking`` — the same seam a one-way
booking uses — enqueues ONE confirmation for the whole trip (one email + one SMS,
all on the single ``booking_ref``), never one per segment, and a redelivered
confirmation does not stack a second.

A demo flight (``FLIGHT_SUPPLIER`` defaults to ``demo``, no live supplier order)
passes the supplier guard, so this also exercises the demo-bookable path.
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
    CustomerBooking,
    CustomerBookingNotification,
    CustomerBookingPayment,
    CustomerBookingSegment,
    CustomerBookingStatus,
    CustomerNotification,
    CustomerPaymentStatus,
)
from app.services import payment_verification_flight_service as verify

D = decimal.Decimal
_IDS = {"n": 9000}


def _id():
    _IDS["n"] += 1
    return _IDS["n"]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerBooking.__table__, CustomerBookingSegment.__table__,
        CustomerBookingPayment.__table__, CustomerNotification.__table__,
        CustomerAuditLog.__table__, CustomerBookingNotification.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _round_trip(db, *, ref="JPB000777", leg_total="5500.00", n_legs=2):
    """A confirmable multi-segment flight booking: one envelope, N segments, a
    captured payment for the envelope total (the sum of the legs)."""
    now = dt.datetime.now(dt.timezone.utc)
    total = D(leg_total) * n_legs
    c = Customer(customer_id=_id(), customer_code=f"C{_IDS['n']}", full_name="Asha Rao",
                 email="asha@example.test", mobile="9000000013")
    db.add(c)
    db.flush()
    b = CustomerBooking(
        customer_booking_id=_id(), booking_ref=ref, customer_id=c.customer_id,
        journey_type="round_trip" if n_legs == 2 else "multi_city",
        airline="IndiGo", flight_number="6E 413",
        origin_code="HYD", origin_city="Hyderabad",
        destination_code="HYD", destination_city="Hyderabad",
        total_amount=total, currency="INR",
        status=CustomerBookingStatus.PENDING.value,
        created_at=now, updated_at=now,
    )
    db.add(b)
    db.flush()
    cities = ["Hyderabad", "Bengaluru", "Hyderabad", "Delhi", "Mumbai"]
    for i in range(n_legs):
        db.add(CustomerBookingSegment(
            customer_booking_segment_id=_id(), customer_booking_id=b.customer_booking_id,
            segment_index=i, airline="IndiGo", flight_number=f"6E 41{i}",
            origin_code="HYD", origin_city=cities[i],
            destination_code="BLR", destination_city=cities[i + 1],
            total_amount=D(leg_total),
            created_at=now,
        ))
    db.flush()
    p = CustomerBookingPayment(
        customer_booking_payment_id=_id(), customer_booking_id=b.customer_booking_id,
        method="gateway", amount=total, currency="INR",
        status=CustomerPaymentStatus.CAPTURED.value, provider="trustbrick",
        provider_order_id="order_RT", provider_payment_id="pay_RT",
        created_at=now, updated_at=now,
    )
    db.add(p)
    db.flush()
    return b, p


def _notifications(db):
    return db.scalar(select(func.count()).select_from(CustomerBookingNotification))


def _segments(db, booking):
    return db.scalar(select(func.count()).select_from(CustomerBookingSegment)
                     .where(CustomerBookingSegment.customer_booking_id == booking.customer_booking_id))


def test_a_round_trip_books_and_gets_exactly_one_confirmation_not_one_per_segment(db):
    b, p = _round_trip(db)
    assert _segments(db, b) == 2, "the booking owns two segments"
    assert verify.confirm_booking(db, p, b) is True
    db.commit()
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    rows = list(db.scalars(select(CustomerBookingNotification)))
    # ONE confirmation for the whole booking: one email + one SMS, NOT one per segment.
    assert len(rows) == 2, "exactly one email and one SMS — not two segments' worth"
    assert {r.channel for r in rows} == {"email", "sms"}
    assert all(r.booking_ref == "JPB000777" for r in rows), "all on the single booking_ref"
    assert all(r.product == "flight" and r.status == "queued" for r in rows)


def test_a_multi_city_trip_also_gets_exactly_one_confirmation(db):
    b, p = _round_trip(db, ref="JPB000778", n_legs=3)
    assert _segments(db, b) == 3
    assert verify.confirm_booking(db, p, b) is True
    db.commit()
    rows = list(db.scalars(select(CustomerBookingNotification)))
    assert len(rows) == 2, "three segments still produce one confirmation (email + SMS)"
    assert {r.channel for r in rows} == {"email", "sms"}


def test_a_redelivered_confirmation_does_not_stack_a_second(db):
    b, p = _round_trip(db, ref="JPB000779")
    assert verify.confirm_booking(db, p, b) is True
    db.commit()
    first = _notifications(db)
    assert first == 2
    # The booking is already CONFIRMED: a repeat call confirms nothing and enqueues nothing.
    assert verify.confirm_booking(db, p, b) is False
    db.commit()
    assert _notifications(db) == first


def test_an_amount_mismatch_across_the_segments_does_not_confirm_or_enqueue(db):
    # The payment must equal the envelope total (the sum of every segment). A capture
    # for one leg only is a mismatch: the booking stays pending and nothing is queued.
    b, p = _round_trip(db, ref="JPB000780")
    p.amount = D("5500.00")  # one leg, not the two-leg total of 11000
    db.flush()
    assert verify.confirm_booking(db, p, b) is False
    db.commit()
    assert b.status == CustomerBookingStatus.PENDING.value
    assert _notifications(db) == 0
