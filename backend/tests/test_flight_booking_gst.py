"""Phase 2 (Flights) — GST business-invoice details on a flight booking.

Optional GST details (GSTIN + company) persist on ``customer_bookings`` and
surface on the booking response, for one-way and multi-segment bookings. Maps to
the TBO Book request's GST fields. Runs the REAL ``customer_booking_service``
against an in-memory SQLite ORM database, like ``test_multi_segment_booking``.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models_customer as m
from app.schemas.customer_booking import BookingCreate, BookingResponse, GstInput, PassengerInput
from app.services import customer_booking_service as flights
from tests.conftest import _next_id

_TABLES = (
    m.Customer, m.CustomerTraveller,
    m.CustomerBooking, m.CustomerBookingPassenger, m.CustomerBookingAddon,
    m.CustomerBookingPayment, m.CustomerBookingSegment,
)
FUTURE = dt.date.today() + dt.timedelta(days=60)
LEAD = dict(first_name="Asha", last_name="Rao", is_contact=True,
            mobile="+919000000001", email="booker@example.com", passport_number="TP000111")
VALID_GSTIN = "29ABCDE1234F1Z5"
LEG_QUOTE = dict(
    base_fare=Decimal("5000"), taxes=Decimal("500"), seat_charges=Decimal("0"),
    baggage_total=Decimal("0"), meal_total=Decimal("0"), service_total=Decimal("0"),
    discount=Decimal("0"), total_amount=Decimal("5500"), currency="INR",
    coupon_code=None, coupon_error=None, priced_seats=[], addon_rows=[],
)


@pytest.fixture()
def world(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    m.Base.metadata.create_all(engine, tables=[t.__table__ for t in _TABLES])

    def assign(mapper, _conn, target):
        key = mapper.get_property_by_column(mapper.primary_key[0]).key
        if getattr(target, key) is None:
            setattr(target, key, _next_id())

    event.listen(m.Base, "before_insert", assign, propagate=True)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    customer = m.Customer(customer_id=_next_id(), customer_code=f"CUST{_next_id()}",
                          full_name="Test Booker", email="booker@example.com", mobile="9000000001")
    db.add(customer)
    db.flush()
    refs = iter(f"JPB{700 + i:06d}" for i in range(1, 50))
    monkeypatch.setattr(flights, "next_booking_ref", lambda _db: next(refs))
    monkeypatch.setattr(flights.pricing, "quote", lambda *a, **k: dict(LEG_QUOTE))
    yield SimpleNamespace(db=db, customer=customer)
    event.remove(m.Base, "before_insert", assign)
    db.close()
    engine.dispose()


def _flight():
    return dict(flight_key="K1", flight_number="JW101", travel_date=FUTURE, is_international=False,
                airline="Test Air", origin_code="HYD", destination_code="DEL", cabin_class="economy")


def _gst_payload():
    return {"gst_number": VALID_GSTIN, "company_name": "Acme Travels Pvt Ltd",
            "company_address": "1 MG Road, Hyderabad", "company_email": "accounts@acmetravels.com",
            "company_contact": "+919000000002"}


# ---------------------------------------------------------------- persistence
def test_gst_persists_on_one_way_booking(world):
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(), "passengers": [PassengerInput(**LEAD).model_dump()],
        "seats": [], "addons": [], "gst": _gst_payload(),
    })
    assert booking.gst_number == VALID_GSTIN
    assert booking.gst_company_name == "Acme Travels Pvt Ltd"
    assert booking.gst_company_address == "1 MG Road, Hyderabad"
    assert booking.gst_company_email == "accounts@acmetravels.com"
    assert booking.gst_company_contact == "+919000000002"


def test_gst_property_builds_nested_block(world):
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(), "passengers": [PassengerInput(**LEAD).model_dump()],
        "seats": [], "addons": [], "gst": _gst_payload(),
    })
    assert booking.gst == {
        "gst_number": VALID_GSTIN, "company_name": "Acme Travels Pvt Ltd",
        "company_address": "1 MG Road, Hyderabad", "company_email": "accounts@acmetravels.com",
        "company_contact": "+919000000002",
    }


def test_no_gst_leaves_columns_null_and_block_none(world):
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(), "passengers": [PassengerInput(**LEAD).model_dump()],
        "seats": [], "addons": [],
    })
    assert booking.gst_number is None
    assert booking.gst is None


def test_gst_response_serialises_block(world):
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(), "passengers": [PassengerInput(**LEAD).model_dump()],
        "seats": [], "addons": [], "gst": _gst_payload(),
    })
    out = BookingResponse.model_validate(booking)
    assert out.gst is not None
    assert out.gst.gst_number == VALID_GSTIN
    assert out.gst.company_name == "Acme Travels Pvt Ltd"


def test_gst_persists_on_multi_segment_booking(world):
    booking = flights.create_multi_segment_booking(world.db, world.customer, {
        "segments": [{"flight": _flight(), "seats": [], "addons": []},
                     {"flight": _flight(), "seats": [], "addons": []}],
        "passengers": [PassengerInput(**LEAD).model_dump()],
        "gst": _gst_payload(),
    })
    assert booking.journey_type == "round_trip"
    assert booking.gst_number == VALID_GSTIN


# ------------------------------------------------------------------ schema
def test_gstin_validation_rejects_bad_format():
    with pytest.raises(ValidationError):
        GstInput(gst_number="NOTAGSTIN123456", company_name="X")


def test_gstin_normalised_uppercase():
    g = GstInput(gst_number="29abcde1234f1z5", company_name="Acme")
    assert g.gst_number == VALID_GSTIN


def test_gst_requires_company_name():
    with pytest.raises(ValidationError):
        GstInput(gst_number=VALID_GSTIN, company_name="")


def test_booking_create_accepts_optional_gst():
    payload = {"flight": _flight(), "passengers": [LEAD], "gst": _gst_payload()}
    model = BookingCreate.model_validate(payload)
    assert model.gst is not None and model.gst.gst_number == VALID_GSTIN
    # And it is genuinely optional.
    assert BookingCreate.model_validate({"flight": _flight(), "passengers": [LEAD]}).gst is None
