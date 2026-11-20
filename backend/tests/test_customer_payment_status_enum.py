"""Regression for the B2C payment-status ORM enum mismatch.

Migration 0062 added ``processing``, ``cancelled`` and ``expired`` to the
database enum ``customer_payment_status_enum``, and the payment-verification
path writes them (``_apply_non_capture``: ``payment.status = remote.status``).
The ORM column type ``_PAYMENT_STATUS`` had been left at the original five
values, so reading a payment in one of the three newer states raised
``LookupError`` in the SQLAlchemy Enum result processor — a 500 that one such
row could inflict on the whole admin payments list, counts and detail, and on
every other read of these tables.

These tests pin:
  * the ORM enum, the Python enum ``CustomerPaymentStatus`` and the admin
    service's advertised ``STATUSES`` all agree on the same eight values;
  * each of the eight statuses round-trips through the ORM on all three
    customer payment tables (the value that was stored is read straight back);
  * the three formerly-broken statuses specifically no longer raise;
  * the admin list / counts / detail endpoints return a payment in each of the
    three newer states instead of 500-ing.

Isolated temp-file SQLite; no provider call, no migration, no real data.
"""
from __future__ import annotations

import datetime as dt
import decimal
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, text
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base, Customer, CustomerBooking, CustomerBookingPayment, CustomerHotelBooking, CustomerHotelBookingPayment,
    CustomerPackageBooking, CustomerPackageBookingPayment, CustomerPaymentStatus, CustomerStatus, _PAYMENT_STATUS,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import customer_payment_admin
from app.services import activity_service
from app.services.customer_payment_admin_service import STATUSES

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)
PAY = "/api/admin/customer-payments"
_N = {"n": 960000}
_TABLES = (Customer, CustomerBooking, CustomerBookingPayment, CustomerHotelBooking, CustomerHotelBookingPayment,
           CustomerPackageBooking, CustomerPackageBookingPayment)

#: The eight values the database enum holds (migration 0044 + 0062).
_EIGHT = ("pending", "processing", "authorized", "captured", "failed", "cancelled", "expired", "refunded")


def _id():
    _N["n"] += 1
    return _N["n"]


def test_the_three_sources_of_truth_agree():
    assert set(_PAYMENT_STATUS.enums) == set(_EIGHT)
    assert {m.value for m in CustomerPaymentStatus} == set(_EIGHT)
    assert set(STATUSES) == set(_EIGHT)


@pytest.fixture()
def engine():
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng, tables=[m.__table__ for m in _TABLES])
    yield eng
    eng.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


@pytest.fixture()
def db(engine):
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    yield s
    s.close()


def _customer(db):
    cid = _id()
    db.add(Customer(customer_id=cid, customer_code=f"C{cid}", full_name="Test", email=f"c{cid}@tt-qa.com",
                    mobile="9000000000", status=CustomerStatus.ACTIVE, created_at=NOW))
    db.flush()
    return cid


def _flight(db, cid, booking_status="pending"):
    bid = _id()
    db.add(CustomerBooking(customer_booking_id=bid, booking_ref=f"JPF{bid}", customer_id=cid, total_amount=D("100.00"),
                           currency="INR", status=booking_status, created_at=NOW, origin_city="Delhi",
                           destination_city="Goa", flight_number="AI1", travel_date=dt.date.today(),
                           origin_code="DEL", destination_code="GOI"))
    db.flush()
    return bid


def _hotel(db, cid):
    bid = _id()
    db.add(CustomerHotelBooking(customer_hotel_booking_id=bid, booking_ref=f"JPH{bid}", customer_id=cid, hotel_id=1,
                                hotel_name="Sea View", room_id=1, room_name="Deluxe", check_in_date=dt.date.today(),
                                check_out_date=dt.date.today() + dt.timedelta(days=1), nights=1, total_amount=D("100.00"),
                                currency="INR", status="pending", created_at=NOW))
    db.flush()
    return bid


def _package(db, cid):
    bid = _id()
    db.add(CustomerPackageBooking(customer_package_booking_id=bid, booking_ref=f"JPP{bid}", customer_id=cid,
                                  package_id=1, package_name="Goa", package_days=3, departure_id=1,
                                  departure_date=dt.date.today(), pax_count=1, total_amount=D("100.00"),
                                  currency="INR", status="pending", created_at=NOW))
    db.flush()
    return bid


@pytest.mark.parametrize("status", _EIGHT)
def test_every_status_round_trips_on_all_three_payment_tables(db, status):
    """The value written is read straight back — no LookupError for any status,
    on flight, hotel or package payments."""
    cid = _customer(db)
    fb, hb, pb = _flight(db, cid), _hotel(db, cid), _package(db, cid)
    fp, hp, pp = _id(), _id(), _id()
    db.add(CustomerBookingPayment(customer_booking_payment_id=fp, customer_booking_id=fb, method="gateway",
                                  amount=D("100.00"), currency="INR", status=status, provider="hdfc", created_at=NOW))
    db.add(CustomerHotelBookingPayment(customer_hotel_booking_payment_id=hp, hotel_booking_id=hb, method="gateway",
                                       amount=D("100.00"), currency="INR", status=status, provider="hdfc", created_at=NOW))
    db.add(CustomerPackageBookingPayment(customer_package_booking_payment_id=pp, package_booking_id=pb, method="gateway",
                                         amount=D("100.00"), currency="INR", status=status, provider="hdfc", created_at=NOW))
    db.commit()
    db.expire_all()
    assert db.get(CustomerBookingPayment, fp).status == status
    assert db.get(CustomerHotelBookingPayment, hp).status == status
    assert db.get(CustomerPackageBookingPayment, pp).status == status


@pytest.mark.parametrize("status", ["processing", "cancelled", "expired"])
def test_formerly_broken_statuses_no_longer_raise_even_when_written_as_raw_sql(db, status):
    """Belt and braces: a row inserted exactly as PostgreSQL would hold it
    (raw SQL) reads back cleanly through the ORM for the three statuses that
    migration 0062 added but the ORM enum used to omit."""
    cid = _customer(db)
    fb = _flight(db, cid)
    pid = _id()
    db.commit()
    db.execute(text(
        "INSERT INTO customer_booking_payments "
        "(customer_booking_payment_id, customer_booking_id, method, status, amount, currency, created_at) "
        "VALUES (:pid, :bid, 'gateway', :st, 100, 'INR', :now)"
    ), {"pid": pid, "bid": fb, "st": status, "now": NOW})
    db.commit()
    db.expire_all()
    row = db.get(CustomerBookingPayment, pid)   # used to raise LookupError
    assert row.status == status


# ---------------------------------------------------------------- HTTP endpoints
class Env:
    def __init__(self, engine):
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        from app.models_customer import CustomerAdminAuditLog, PaymentProviderEvent  # noqa: PLC0415
        # Audit table (detail read writes one) + provider-events table (detail reads it).
        CustomerAdminAuditLog.__table__.create(engine, checkfirst=True)
        md = MetaData()
        ev = PaymentProviderEvent.__table__.to_metadata(md)
        for col in ev.columns:
            col.server_default = None
        ev.create(engine, checkfirst=True)
        app = FastAPI()
        app.include_router(customer_payment_admin.router)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=True)


@pytest.fixture()
def env(engine, monkeypatch):
    monkeypatch.setattr(activity_service, "log_activity", lambda *a, **k: None)
    md = MetaData()
    users = User.__table__.to_metadata(md)
    for con in list(users.constraints):
        if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
            users.constraints.discard(con)
    for idx in list(users.indexes):
        users.indexes.discard(idx)
    for col in users.columns:
        col.foreign_keys.clear()
        col.server_default = None
        if not col.primary_key:
            col.nullable = True
    users.create(engine)
    return Env(engine)


@pytest.fixture()
def admin(env):
    uid = _id()
    s = env.Session()
    s.add(User(user_id=uid, full_name="Pay Admin", email=f"a{uid}@tt-qa.com", password_hash="x", role=UserRole.ADMIN,
               status=UserStatus.ACTIVE, permissions=[P.B2C_PAYMENTS_VERIFY]))
    s.commit()
    s.close()
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def test_list_counts_and_detail_handle_processing_cancelled_expired(env, admin):
    s = env.Session()
    cid = _customer(s)
    ids = {}
    for status in ("processing", "cancelled", "expired", "captured"):
        bid = _flight(s, cid)
        pid = _id()
        s.add(CustomerBookingPayment(customer_booking_payment_id=pid, customer_booking_id=bid, method="gateway",
                                     amount=D("100.00"), currency="INR", status=status, provider="hdfc",
                                     provider_payment_id=f"PAY{pid}", provider_order_id=f"ORD{pid}", created_at=NOW))
        ids[status] = pid
    s.commit()
    s.close()

    # list: returns all four, no 500
    r = env.client.get(PAY, headers=admin)
    assert r.status_code == 200, r.text
    got = {i["status"] for i in r.json()["items"]}
    assert {"processing", "cancelled", "expired", "captured"} <= got

    # filtering by each of the three newer statuses returns exactly its row
    for status in ("processing", "cancelled", "expired"):
        rr = env.client.get(PAY, params={"status": status}, headers=admin)
        assert rr.status_code == 200, rr.text
        assert [i["payment_id"] for i in rr.json()["items"]] == [ids[status]], status

    # counts: tallies the three without error
    c = env.client.get(f"{PAY}/counts", headers=admin)
    assert c.status_code == 200, c.text
    by = c.json()["by_status"]
    assert by["processing"] == 1 and by["cancelled"] == 1 and by["expired"] == 1 and by["captured"] == 1

    # detail: each of the three opens instead of 500-ing
    for status in ("processing", "cancelled", "expired"):
        d = env.client.get(f"{PAY}/flight/{ids[status]}", headers=admin)
        assert d.status_code == 200 and d.json()["status"] == status, d.text
