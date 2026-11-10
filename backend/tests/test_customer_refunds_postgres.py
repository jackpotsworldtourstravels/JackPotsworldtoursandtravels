"""Refund concurrency against a REAL PostgreSQL - the part SQLite cannot show.

SQLite ignores ``SELECT ... FOR UPDATE``, so the SQLite suite proves the logic
but not the lock. These tests run only when ``REFUND_TEST_POSTGRES_URL`` points
at a database that has been migrated to head (the CI ``postgres-migrations`` job
does exactly that). They create their own rows and never touch a provider: the
gateway is a fake.

    REFUND_TEST_POSTGRES_URL=postgresql+psycopg2://user:pw@host/db pytest tests/test_customer_refunds_postgres.py
"""
from __future__ import annotations

import os
import threading
import time
import uuid

import pytest

URL = os.environ.get("REFUND_TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not URL, reason="REFUND_TEST_POSTGRES_URL not set (needs a migrated PostgreSQL)")

if URL:
    from sqlalchemy import create_engine, select, text
    from sqlalchemy.orm import sessionmaker

    from app.models_customer import CustomerHotelBookingPayment, CustomerRefundAttempt
    from app.services import customer_refund_service as svc
    from app.services import payments as payment_providers
    from tests.test_customer_refunds import (
        MAKER,
        OTHER_MAKER,
        Gateway,
        cancellation,
        captured_payment,
    )
    from app.models_customer import Customer
    from tests.conftest import _next_id


@pytest.fixture()
def world(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "refund_approval_threshold_minor", 10**12)   # no maker-checker here
    from tests import conftest as shared
    from tests import test_customer_refunds as base

    # Fresh id spaces every run: this database outlives the process.
    shared._NEXT_ID["n"] = 10_000_000 + uuid.uuid4().int % 800_000_000
    base._CXL["n"] = uuid.uuid4().int % 900_000_000
    engine = create_engine(URL)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    gw = Gateway()
    gw.id_prefix = f"rfnd_{uuid.uuid4().hex[:8]}_"
    monkeypatch.setattr(payment_providers, "get_provider_named", lambda name: gw)
    monkeypatch.setattr(svc, "_user_names", lambda db, ids: {})
    s = Session()
    tag = uuid.uuid4().hex[:8].upper()
    cust = Customer(customer_id=_next_id() + int(time.time()) % 100000, customer_code=f"CUST-{tag}",
                    full_name="Concurrency", email=f"c-{tag}@example.test", mobile=str(9000000000 + uuid.uuid4().int % 99999999))
    s.add(cust)
    s.commit()
    booking, pay = captured_payment(s, cust, ref=f"JPH{tag}", pid=f"pay_{tag}")
    yield {"Session": Session, "cust": cust, "booking": booking, "pay": pay, "gw": gw, "s": s}
    s.close()
    engine.dispose()


def test_a_second_refund_waits_for_the_payment_row_lock(world):
    """B must BLOCK while another transaction holds the payment row FOR UPDATE,
    then see whatever that transaction committed."""
    Session, s, gw = world["Session"], world["s"], world["gw"]
    c = cancellation(s, world["booking"], world["cust"], refund_amount="60.00")
    pay_id = world["pay"].customer_hotel_booking_payment_id

    holder = Session()
    holder.execute(select(CustomerHotelBookingPayment).where(
        CustomerHotelBookingPayment.customer_hotel_booking_payment_id == pay_id).with_for_update())

    done = {}

    def run():
        b = Session()
        try:
            done["result"] = svc.initiate_refund(b, c.cancellation_ref, MAKER)
        except Exception as exc:
            done["error"] = repr(exc)
        finally:
            b.close()

    t = threading.Thread(target=run)
    t.start()
    time.sleep(1.5)
    assert t.is_alive() and not gw.calls, "the refund must wait for the payment row lock"
    holder.commit()                       # release
    t.join(timeout=15)
    assert not t.is_alive() and done.get("result", (0, done))[1] == "succeeded" and len(gw.calls) == 1
    holder.close()


def test_simultaneous_refunds_on_one_payment_never_exceed_the_capture(world):
    """Two cancellations, one payment (100): 70 + 50 asked at the same instant.
    Exactly one may go out; the other is refused."""
    Session, s, gw = world["Session"], world["s"], world["gw"]
    a = cancellation(s, world["booking"], world["cust"], refund_amount="70.00")
    b = cancellation(s, world["booking"], world["cust"], refund_amount="50.00")
    gw.on_refund = lambda: time.sleep(0.5)          # keep the first in flight
    barrier = threading.Barrier(2)
    out = {}

    def run(name, ref, who):
        sess = Session()
        try:
            barrier.wait(timeout=10)
            try:
                out[name] = svc.initiate_refund(sess, ref, who)[1]
            except svc.RefundError as exc:
                out[name] = exc.code
        finally:
            sess.close()

    ts = [threading.Thread(target=run, args=("a", a.cancellation_ref, MAKER)),
          threading.Thread(target=run, args=("b", b.cancellation_ref, OTHER_MAKER))]
    [t.start() for t in ts]
    [t.join(timeout=30) for t in ts]

    assert sorted(out.values()) == ["exceeds_remaining", "succeeded"], out
    assert len(gw.calls) == 1
    total = s.execute(text(
        "SELECT COALESCE(SUM(amount_minor),0) FROM customer_refund_attempts "
        "WHERE payment_row_id=:p AND status IN ('succeeded','processing')"),
        {"p": world["pay"].customer_hotel_booking_payment_id}).scalar()
    assert total <= 10000


def test_double_submit_of_one_cancellation_sends_one_refund(world):
    Session, s, gw = world["Session"], world["s"], world["gw"]
    c = cancellation(s, world["booking"], world["cust"], refund_amount="100.00")
    gw.on_refund = lambda: time.sleep(0.5)
    barrier = threading.Barrier(2)
    out = []

    def run(who):
        sess = Session()
        try:
            barrier.wait(timeout=10)
            attempt, outcome = svc.initiate_refund(sess, c.cancellation_ref, who)
            out.append((attempt.refund_attempt_id, outcome))
        except Exception as exc:                       # surfaced by the assertion below
            out.append(("error", repr(exc)))
        finally:
            sess.close()

    ts = [threading.Thread(target=run, args=(MAKER,)), threading.Thread(target=run, args=(OTHER_MAKER,))]
    [t.start() for t in ts]
    [t.join(timeout=30) for t in ts]

    assert len(out) == 2 and len({i for i, _ in out}) == 1, out      # same attempt for both
    assert len(gw.calls) == 1
    rows = s.execute(select(CustomerRefundAttempt).where(
        CustomerRefundAttempt.cancellation_ref == c.cancellation_ref)).scalars().all()
    assert len(rows) == 1
