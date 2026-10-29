"""Real flight, hotel and package bookings: first / middle / last on the rows that are written.

A traveller is edited as three names; the airline, hotel or operator takes a *given name*. The
join happens in exactly one place -- where the booking's passenger / guest / traveller row is
built -- and these tests run the real ``create_booking`` of each product so the rows can be read
back. Only the price (and the booking reference) is stubbed: it needs a catalogue that is not
the subject here. Synthetic data only.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models_customer as m
from app.integrations.duffel.mapper import passengers_to_order
from app.schemas.customer_booking import PassengerInput
from app.schemas.customer_hotel_booking import GuestInput
from app.schemas.customer_package_booking import TravellerInput
from app.services import customer_booking_service as flights
from app.services import customer_hotel_booking_service as hotels
from app.services import customer_package_booking_service as packages
from tests.conftest import _next_id

_TABLES = (
    m.Customer, m.CustomerTraveller,
    m.CustomerBooking, m.CustomerBookingPassenger, m.CustomerBookingAddon, m.CustomerBookingPayment,
    m.CustomerHotelBooking, m.CustomerHotelBookingRoom, m.CustomerHotelBookingGuest,
    m.CustomerHotelBookingAddon, m.CustomerHotelBookingPayment,
    m.CustomerPackageBooking, m.CustomerPackageBookingTraveller, m.CustomerPackageBookingAddon,
    m.CustomerPackageBookingPayment,
)
FUTURE = dt.date.today() + dt.timedelta(days=60)
LEAD = dict(first_name="Asha", middle_name="Kumari", last_name="Rao", is_contact=True,
            mobile="+919000000001", email="booker@example.com", passport_number="TP000111")
SECOND = dict(first_name="Ravi", last_name="Rao", passport_number="TP000222")


@pytest.fixture()
def world(monkeypatch):
    """A fresh in-memory database with every table a booking of any product touches."""
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    m.Base.metadata.create_all(engine, tables=[t.__table__ for t in _TABLES])

    def assign(mapper, _conn, target):                      # SQLite runs no identity sequences
        key = mapper.get_property_by_column(mapper.primary_key[0]).key
        if getattr(target, key) is None:
            setattr(target, key, _next_id())

    event.listen(m.Base, "before_insert", assign, propagate=True)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    customer = m.Customer(customer_id=_next_id(), customer_code=f"CUST{_next_id()}", full_name="Test Booker",
                          email="booker@example.com", mobile="9000000001")
    db.add(customer)
    db.flush()

    zero = Decimal("0")
    monkeypatch.setattr(flights, "next_booking_ref", lambda _db: "JPB000901")
    monkeypatch.setattr(flights.pricing, "quote", lambda *a, **k: dict(
        base_fare=Decimal("5000"), taxes=Decimal("500"), seat_charges=zero, baggage_total=zero,
        meal_total=zero, service_total=zero, discount=zero, total_amount=Decimal("5500"),
        currency="INR", coupon_code=None, coupon_error=None, priced_seats=[], addon_rows=[]))

    room = SimpleNamespace(hotel=SimpleNamespace(name="Test Hotel", location="Test City"),
                           customer_hotel_room_id=7, name="Deluxe", meal_plan="CP",
                           base_price_per_night=Decimal("4000"))
    monkeypatch.setattr(hotels, "next_booking_ref", lambda _db: "JPH000901")
    monkeypatch.setattr(hotels, "_price_stay", lambda *a, **k: dict(
        room=room, rooms=[room], nights=1, rooms_count=1, room_subtotal=Decimal("4000"),
        taxes=Decimal("480"), addon_total=zero, discount=zero, total_amount=Decimal("4480"),
        currency="INR", coupon_code=None, coupon_error=None, addon_rows=[]))

    package = SimpleNamespace(customer_package_id=5, name="Test Escape", days=4, is_international=False)
    departure = SimpleNamespace(customer_package_departure_id=9, departure_date=FUTURE, seats_left=20)
    monkeypatch.setattr(packages, "next_booking_ref", lambda _db: "JPP000901")
    monkeypatch.setattr(packages, "_price_trip", lambda *a, **k: dict(
        package=package, departure=departure, pax_count=2, base_total=Decimal("20000"),
        taxes=Decimal("1000"), addon_total=zero, discount=zero, total_amount=Decimal("21000"),
        currency="INR", coupon_code=None, coupon_error=None, addon_rows=[]))

    yield SimpleNamespace(db=db, customer=customer)
    event.remove(m.Base, "before_insert", assign)
    db.close()
    engine.dispose()


def _flight(people, **extra):
    return {"flight": dict(flight_key="K1", flight_number="JW101", travel_date=FUTURE,
                           is_international=False, airline="Test Air", origin_code="HYD",
                           destination_code="DEL", cabin_class="economy"),
            "passengers": [PassengerInput(**p).model_dump() for p in people],
            "seats": [], "addons": [], **extra}


def _hotel(people):
    return {"stay": dict(hotel_id=1, check_in=FUTURE, check_out=FUTURE + dt.timedelta(days=1), adults=2),
            "guests": [GuestInput(**{k: v for k, v in p.items() if k != "passport_number"}).model_dump()
                       for p in people], "addons": []}


def _package(people):
    return {"trip": dict(package_id=5, departure_id=9),
            "travellers": [TravellerInput(**p).model_dump() for p in people], "addons": []}


#: product -> (build the payload, run the real service, the child model, the child's order column)
PRODUCTS = {
    "flight": (_flight, flights.create_booking, m.CustomerBookingPassenger, "passenger_index"),
    "hotel": (_hotel, hotels.create_booking, m.CustomerHotelBookingGuest, "guest_index"),
    "package": (_package, packages.create_booking, m.CustomerPackageBookingTraveller, "traveller_index"),
}
ALL = pytest.mark.parametrize("product", sorted(PRODUCTS))


def _book(world, product, people):
    payload_of, create, model, order = PRODUCTS[product]
    create(world.db, world.customer, payload_of(people))
    return list(world.db.execute(select(model).order_by(getattr(model, order))).scalars())


# ---------------------------------------------------------------------------
# The given name is composed here and nowhere earlier
# ---------------------------------------------------------------------------
@ALL
def test_first_and_middle_become_the_given_name_and_last_is_untouched(world, product):
    rows = _book(world, product, [LEAD, SECOND])
    assert (rows[0].first_name, rows[0].last_name) == ("Asha Kumari", "Rao")
    assert (rows[1].first_name, rows[1].last_name) == ("Ravi", "Rao")      # no middle: unchanged


@ALL
def test_a_client_that_already_joined_the_names_is_unchanged(world, product):
    rows = _book(world, product, [dict(LEAD, first_name="Asha Kumari", middle_name=None)])
    assert rows[0].first_name == "Asha Kumari"


@ALL
def test_padding_and_a_blank_middle_name_are_dropped(world, product):
    rows = _book(world, product, [dict(LEAD, first_name="  Asha ", middle_name="   ")])
    assert rows[0].first_name == "Asha"


@ALL
def test_the_booking_row_has_no_middle_name_column_so_nothing_is_stored_twice(world, product):
    model = PRODUCTS[product][2]
    assert not hasattr(model, "middle_name")


@ALL
def test_the_booking_contact_rides_on_the_contact_row_only(world, product):
    rows = _book(world, product, [LEAD, SECOND])
    assert (rows[0].is_contact, rows[0].mobile, rows[0].email) == (True, "+919000000001", "booker@example.com")
    assert (rows[1].is_contact, rows[1].mobile, rows[1].email) == (False, None, None)


def test_the_airline_order_receives_the_composed_given_name(world):
    rows = _book(world, "flight", [LEAD, SECOND])
    order = passengers_to_order(
        [{"first_name": r.first_name, "last_name": r.last_name, "mobile": r.mobile, "email": r.email}
         for r in rows], ["pas_1", "pas_2"])
    assert [(p["given_name"], p["family_name"]) for p in order] == [("Asha Kumari", "Rao"), ("Ravi", "Rao")]


# ---------------------------------------------------------------------------
# Saving travellers from a flight booking: names stay apart, the booker's contact never lands
# ---------------------------------------------------------------------------
def _saved(world):
    rows = world.db.execute(select(m.CustomerTraveller).order_by(m.CustomerTraveller.passport_number)).scalars()
    return list(rows)


def test_saved_travellers_keep_first_middle_last_apart(world):
    flights.create_booking(world.db, world.customer, _flight([LEAD, SECOND], save_travellers=True))
    asha, ravi = _saved(world)
    assert (asha.first_name, asha.middle_name, asha.last_name) == ("Asha", "Kumari", "Rao")
    assert (ravi.first_name, ravi.middle_name, ravi.last_name) == ("Ravi", None, "Rao")


def test_the_bookers_phone_and_email_are_not_copied_onto_the_saved_traveller(world):
    flights.create_booking(world.db, world.customer, _flight([LEAD, SECOND], save_travellers=True))
    asha, ravi = _saved(world)
    assert (asha.mobile, asha.email) == (None, None)
    assert (ravi.mobile, ravi.email) == (None, None)


def test_a_saved_travellers_own_contact_survives_a_booking_with_another_contact(world):
    own = m.CustomerTraveller(customer_id=world.customer.customer_id, first_name="Asha", last_name="Rao",
                              passport_number="TP000111", mobile="+919000000011", email="asha.own@example.com")
    world.db.add(own)
    world.db.flush()

    flights.create_booking(world.db, world.customer, _flight([LEAD], save_travellers=True))

    world.db.refresh(own)
    assert (own.mobile, own.email) == ("+919000000011", "asha.own@example.com")
    assert own.middle_name == "Kumari"                       # what the booking DID know is saved


def test_a_later_booking_with_blanks_does_not_erase_what_was_saved(world):
    flights.create_booking(world.db, world.customer, _flight([LEAD], save_travellers=True))
    blank = dict(first_name="Asha", last_name="Rao", passport_number="TP000111", is_contact=True,
                 mobile="+919000000002", email="other.booker@example.com")
    flights.create_booking(world.db, world.customer, _flight([blank], save_travellers=True,
                                                             idempotency_key="second-booking-0001"))
    (asha,) = [t for t in _saved(world) if t.passport_number == "TP000111"]
    assert (asha.first_name, asha.middle_name, asha.last_name) == ("Asha", "Kumari", "Rao")
    assert len(_saved(world)) == 1                           # merged, not duplicated


def test_nothing_is_saved_unless_the_customer_asked(world):
    flights.create_booking(world.db, world.customer, _flight([LEAD, SECOND]))
    assert _saved(world) == []
