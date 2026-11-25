"""Issue #19 — review eligibility.

A review may be written only when the customer owns a booking for that exact
item that reached COMPLETED (operational completion), across flight, hotel and
package booking types. A confirmed/paid-but-not-completed booking, a booking for
a different item, and another customer's booking all fail.
"""
import datetime as dt

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import tests.conftest  # installs the SQLite type shim
from app.database.session import Base
from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerHotelBooking,
    CustomerPackageBooking,
)
from app.services import customer_account_service as acct

FUTURE = dt.date.today() + dt.timedelta(days=10)
_ids = iter(range(5000, 9000))


@pytest.fixture()
def session():
    engine = create_engine("sqlite://")
    for t in (Customer, CustomerBooking, CustomerHotelBooking, CustomerPackageBooking):
        t.__table__.create(engine)
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


def _cust(s, cid=None):
    cid = cid or next(_ids)
    c = Customer(customer_id=cid, customer_code=f"C{cid}", full_name="T", email=f"{cid}@x.test", mobile="9000000000")
    s.add(c)
    s.flush()
    return c


def _flight(s, cust, status):
    s.add(CustomerBooking(customer_booking_id=next(_ids), booking_ref=f"JPB{next(_ids)}",
                          customer_id=cust.customer_id, status=status))
    s.flush()


def _hotel(s, cust, hotel_id, status):
    s.add(CustomerHotelBooking(customer_hotel_booking_id=next(_ids), booking_ref=f"JPH{next(_ids)}",
                               customer_id=cust.customer_id, hotel_id=hotel_id, hotel_name="H",
                               room_id=1, room_name="R", check_in_date=FUTURE,
                               check_out_date=FUTURE + dt.timedelta(days=2), nights=2, status=status))
    s.flush()


def _package(s, cust, package_id, status):
    s.add(CustomerPackageBooking(customer_package_booking_id=next(_ids), booking_ref=f"JPP{next(_ids)}",
                                 customer_id=cust.customer_id, package_id=package_id, package_name="P",
                                 package_days=5, departure_id=1, departure_date=FUTURE, status=status))
    s.flush()


# ---- flight -------------------------------------------------------------
def test_flight_review_requires_a_completed_flight_booking(session):
    c = _cust(session)
    assert acct.has_completed_booking_for(session, c, "flight", 1) is False
    _flight(session, c, "confirmed")
    assert acct.has_completed_booking_for(session, c, "flight", 1) is False  # confirmed != completed
    _flight(session, c, "completed")
    assert acct.has_completed_booking_for(session, c, "flight", 1) is True


# ---- hotel --------------------------------------------------------------
def test_hotel_review_requires_a_completed_booking_for_that_hotel(session):
    c = _cust(session)
    _hotel(session, c, hotel_id=7, status="completed")
    assert acct.has_completed_booking_for(session, c, "hotel", 7) is True
    assert acct.has_completed_booking_for(session, c, "hotel", 8) is False  # different hotel


def test_confirmed_hotel_booking_is_not_completion(session):
    c = _cust(session)
    _hotel(session, c, hotel_id=7, status="confirmed")
    assert acct.has_completed_booking_for(session, c, "hotel", 7) is False


# ---- package ------------------------------------------------------------
def test_package_review_requires_a_completed_booking_for_that_package(session):
    c = _cust(session)
    _package(session, c, package_id=3, status="completed")
    assert acct.has_completed_booking_for(session, c, "package", 3) is True
    assert acct.has_completed_booking_for(session, c, "package", 4) is False


# ---- ownership + misc ---------------------------------------------------
def test_another_customers_completed_booking_does_not_count(session):
    mine = _cust(session)
    other = _cust(session)
    _hotel(session, other, hotel_id=7, status="completed")
    assert acct.has_completed_booking_for(session, mine, "hotel", 7) is False


def test_cancelled_booking_is_not_completion(session):
    c = _cust(session)
    _package(session, c, package_id=3, status="cancelled")
    assert acct.has_completed_booking_for(session, c, "package", 3) is False


def test_cruise_and_unknown_types_are_never_eligible(session):
    c = _cust(session)
    _flight(session, c, "completed")
    assert acct.has_completed_booking_for(session, c, "cruise", 1) is False
    assert acct.has_completed_booking_for(session, c, "mystery", 1) is False
