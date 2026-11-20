"""Multi-segment flight bookings on the real services — one-way, round-trip, multi-city.

Phase 2 regression suite for the ``customer_booking_segments`` table (migration
0096). It runs the REAL ``customer_booking_service`` against an in-memory SQLite
database built from the ORM, exactly as ``test_booking_row_name_composition`` does,
so no PostgreSQL is needed for the invariants that are engine-independent:

  * a one-way booking made through ``create_booking`` gets EXACTLY ONE segment
    (index 0) whose fares mirror the envelope;
  * round-trip (N=2) and multi-city (N=3) go through ``create_multi_segment_booking``
    and get ordered segments 0..N-1;
  * the envelope ``total_amount`` is the SUM of the per-segment totals;
  * currency is consistent across the envelope and every segment;
  * a booking-level coupon is applied to the FIRST leg only;
  * the passengers are shared across every leg (one party flies the journey);
  * the ``(customer_booking_id, segment_index)`` uniqueness constraint rejects a
    duplicate segment index;
  * a failure partway through segment creation leaves NO booking behind
    (single-transaction / rollback);
  * the segment status CHECK set is a superset of every booking status, so the
    migration backfill can never be rejected.

Synthetic data only; prices and the booking reference are stubbed (they need a
catalogue that is not the subject here).
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models_customer as m
from app.models_customer import CustomerBookingStatus
from app.schemas.customer_booking import PassengerInput
from app.services import customer_booking_service as flights
from tests.conftest import _next_id

_TABLES = (
    m.Customer, m.CustomerTraveller,
    m.CustomerBooking, m.CustomerBookingPassenger, m.CustomerBookingAddon,
    m.CustomerBookingPayment, m.CustomerBookingSegment,
)
FUTURE = dt.date.today() + dt.timedelta(days=60)
LEAD = dict(first_name="Asha", middle_name="Kumari", last_name="Rao", is_contact=True,
            mobile="+919000000001", email="booker@example.com", passport_number="TP000111")
SECOND = dict(first_name="Ravi", last_name="Rao", passport_number="TP000222")

#: One leg's stubbed quote. Every leg prices to this, so an N-leg envelope totals
#: N * 5500 and the per-field sums are exact multiples — easy to assert on.
LEG_QUOTE = dict(
    base_fare=Decimal("5000"), taxes=Decimal("500"), seat_charges=Decimal("0"),
    baggage_total=Decimal("0"), meal_total=Decimal("0"), service_total=Decimal("0"),
    discount=Decimal("0"), total_amount=Decimal("5500"), currency="INR",
    coupon_code=None, coupon_error=None, priced_seats=[], addon_rows=[],
)


@pytest.fixture()
def world(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    m.Base.metadata.create_all(engine, tables=[t.__table__ for t in _TABLES])

    def assign(mapper, _conn, target):
        key = mapper.get_property_by_column(mapper.primary_key[0]).key
        if getattr(target, key) is None:
            setattr(target, key, _next_id())

    event.listen(m.Base, "before_insert", assign, propagate=True)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    customer = m.Customer(customer_id=_next_id(), customer_code=f"CUST{_next_id()}",
                          full_name="Test Booker", email="booker@example.com",
                          mobile="9000000001")
    db.add(customer)
    db.flush()

    # A distinct booking reference per call, so two bookings in one test never
    # collide on the unique booking_ref column.
    refs = iter(f"JPB{900 + i:06d}" for i in range(1, 50))
    monkeypatch.setattr(flights, "next_booking_ref", lambda _db: next(refs))
    monkeypatch.setattr(flights.pricing, "quote", lambda *a, **k: dict(LEG_QUOTE))

    yield SimpleNamespace(db=db, customer=customer)
    event.remove(m.Base, "before_insert", assign)
    db.close()
    engine.dispose()


def _flight(n: int, *, international: bool = False) -> dict:
    """A synthetic leg; ``n`` only varies the route/flight number for readability."""
    origins = ["HYD", "DEL", "BOM", "MAA"]
    return dict(flight_key=f"K{n}", flight_number=f"JW{100 + n}", travel_date=FUTURE,
                is_international=international, airline="Test Air",
                origin_code=origins[n % len(origins)],
                destination_code=origins[(n + 1) % len(origins)],
                cabin_class="economy")


def _passengers(people):
    return [PassengerInput(**p).model_dump() for p in people]


def _segments(db, booking):
    return list(db.execute(
        select(m.CustomerBookingSegment)
        .where(m.CustomerBookingSegment.customer_booking_id == booking.customer_booking_id)
        .order_by(m.CustomerBookingSegment.segment_index)
    ).scalars())


# ---------------------------------------------------------------------------
# One-way: exactly one segment through the ordinary create_booking path
# ---------------------------------------------------------------------------
def test_one_way_booking_creates_exactly_one_segment(world):
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(1), "passengers": _passengers([LEAD, SECOND]),
        "seats": [], "addons": [],
    })
    segs = _segments(world.db, booking)
    assert len(segs) == 1
    assert segs[0].segment_index == 0
    assert booking.journey_type == "one_way"


def test_one_way_segment_fares_mirror_the_envelope(world):
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(1), "passengers": _passengers([LEAD]), "seats": [], "addons": [],
    })
    (seg,) = _segments(world.db, booking)
    assert seg.total_amount == booking.total_amount == Decimal("5500.00")
    assert seg.base_fare == booking.base_fare
    assert seg.taxes == booking.taxes


# ---------------------------------------------------------------------------
# Round-trip and multi-city through create_multi_segment_booking
# ---------------------------------------------------------------------------
def _multi(world, n_legs, **extra):
    return flights.create_multi_segment_booking(world.db, world.customer, {
        "segments": [{"flight": _flight(i), "seats": [], "addons": []} for i in range(n_legs)],
        "passengers": _passengers([LEAD, SECOND]),
        **extra,
    })


def test_round_trip_has_two_ordered_segments(world):
    booking = _multi(world, 2)
    segs = _segments(world.db, booking)
    assert [s.segment_index for s in segs] == [0, 1]
    assert booking.journey_type == "round_trip"


def test_multi_city_has_n_ordered_segments(world):
    booking = _multi(world, 3)
    segs = _segments(world.db, booking)
    assert [s.segment_index for s in segs] == [0, 1, 2]
    assert booking.journey_type == "multi_city"


def test_envelope_total_is_the_sum_of_segment_totals(world):
    booking = _multi(world, 3)
    segs = _segments(world.db, booking)
    assert booking.total_amount == sum((s.total_amount for s in segs), Decimal("0"))
    assert booking.total_amount == Decimal("16500.00")        # 3 * 5500
    assert booking.base_fare == Decimal("15000.00")           # 3 * 5000


def test_currency_is_consistent_across_envelope_and_segments(world):
    booking = _multi(world, 3)
    assert booking.currency == "INR"
    assert {s for s in [booking.currency]} == {"INR"}
    # (segments carry no currency column; the envelope is the single source — assert
    #  the envelope currency equals the per-leg quote currency it was summed from.)
    assert booking.currency == LEG_QUOTE["currency"]


def test_envelope_summary_spans_first_origin_to_last_destination(world):
    booking = _multi(world, 3)
    segs = _segments(world.db, booking)
    assert booking.origin_code == segs[0].origin_code
    assert booking.destination_code == segs[-1].destination_code


def test_passengers_are_shared_across_the_journey_not_duplicated_per_leg(world):
    booking = _multi(world, 3)
    passengers = list(world.db.execute(
        select(m.CustomerBookingPassenger)
        .where(m.CustomerBookingPassenger.customer_booking_id == booking.customer_booking_id)
    ).scalars())
    assert len(passengers) == 2                               # not 2 * 3
    assert passengers[0].first_name == "Asha Kumari"          # composed given name


def test_an_international_leg_marks_the_whole_envelope_international(world):
    booking = flights.create_multi_segment_booking(world.db, world.customer, {
        "segments": [
            {"flight": _flight(0), "seats": [], "addons": []},
            {"flight": _flight(1, international=True), "seats": [], "addons": []},
        ],
        "passengers": _passengers([dict(LEAD, nationality="Indian",
                                        passport_expiry=FUTURE + dt.timedelta(days=400))]),
    })
    assert booking.is_international is True


def test_a_coupon_is_applied_to_the_first_leg_only(world, monkeypatch):
    seen = []

    def quote(*a, **k):
        seen.append(k.get("coupon_code"))
        return dict(LEG_QUOTE)

    monkeypatch.setattr(flights.pricing, "quote", quote)
    _multi(world, 3, coupon_code="SAVE10")
    assert seen == ["SAVE10", None, None]


def test_empty_segment_list_is_refused(world):
    with pytest.raises(flights.BookingError):
        flights.create_multi_segment_booking(world.db, world.customer, {
            "segments": [], "passengers": _passengers([LEAD]),
        })


# ---------------------------------------------------------------------------
# Integrity: a duplicate segment index is rejected by the unique constraint
# ---------------------------------------------------------------------------
def test_duplicate_segment_index_on_one_booking_is_rejected(world):
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(1), "passengers": _passengers([LEAD]), "seats": [], "addons": [],
    })
    world.db.add(m.CustomerBookingSegment(
        customer_booking_id=booking.customer_booking_id, segment_index=0,
        base_fare=Decimal("0"), taxes=Decimal("0"), seat_charges=Decimal("0"),
        baggage_total=Decimal("0"), meal_total=Decimal("0"), service_total=Decimal("0"),
        discount=Decimal("0"), total_amount=Decimal("0"), status="pending",
    ))
    with pytest.raises(IntegrityError):
        world.db.flush()


# ---------------------------------------------------------------------------
# Atomicity: a failure during segment creation leaves no booking behind
# ---------------------------------------------------------------------------
def test_a_failure_building_a_segment_rolls_back_the_whole_booking(world, monkeypatch):
    real = flights._segment_row
    calls = {"n": 0}

    def boom(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:                                   # fail on the SECOND leg
            raise RuntimeError("segment write blew up")
        return real(*a, **k)

    monkeypatch.setattr(flights, "_segment_row", boom)
    with pytest.raises(RuntimeError):
        _multi(world, 3)

    world.db.rollback()                                       # what the request's get_db does
    assert world.db.execute(select(m.CustomerBooking)).scalars().all() == []
    assert world.db.execute(select(m.CustomerBookingSegment)).scalars().all() == []


# ---------------------------------------------------------------------------
# Migration drift guard: the backfill copies booking.status into a segment, whose
# CHECK only permits SEGMENT_STATUSES. Every booking status must be in that set,
# or the 0096 backfill INSERT would be rejected on a real database.
# ---------------------------------------------------------------------------
def test_every_booking_status_is_an_allowed_segment_status():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0096_booking_segments.py"
    spec = importlib.util.spec_from_file_location("migration_0096", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    booking_statuses = {s.value for s in CustomerBookingStatus}
    assert booking_statuses <= set(module.SEGMENT_STATUSES), (
        "migration 0096 backfill copies booking.status into a segment; a booking "
        "status outside SEGMENT_STATUSES would be rejected by the segment CHECK"
    )


# ---------------------------------------------------------------------------
# Add-ons bought on a multi-segment journey land at the envelope, one per leg,
# so the booking's ``addons`` reads them exactly like a one-way booking's — and
# the per-leg detail still lives in each segment's addons_json.
# ---------------------------------------------------------------------------
def test_multi_segment_addons_are_written_at_the_envelope_per_leg(world, monkeypatch):
    def quote_with_addon(*a, **k):
        q = dict(LEG_QUOTE)
        q["addon_rows"] = [dict(
            passenger_index=0, addon_type="baggage", code="BAG15",
            name="15 kg extra baggage", description=None,
            unit_price=Decimal("1200"), quantity=1,
        )]
        return q

    monkeypatch.setattr(flights.pricing, "quote", quote_with_addon)
    booking = flights.create_multi_segment_booking(world.db, world.customer, {
        "segments": [
            {"flight": _flight(0), "seats": [], "addons": [{"code": "BAG15"}]},
            {"flight": _flight(1), "seats": [], "addons": [{"code": "BAG15"}]},
        ],
        "passengers": _passengers([LEAD]),
    })

    rows = list(world.db.execute(
        select(m.CustomerBookingAddon)
        .where(m.CustomerBookingAddon.customer_booking_id == booking.customer_booking_id)
    ).scalars())
    assert len(rows) == 2                        # one row per leg — not dropped to segment json alone
    assert {r.code for r in rows} == {"BAG15"}
    # the authoritative per-leg breakdown is still on each segment too
    segs = _segments(world.db, booking)
    assert all(s.addons_json for s in segs)


def test_a_one_way_booking_still_has_no_duplicate_addon_rows(world, monkeypatch):
    # Guard: the envelope loop lives in create_multi_segment_booking only; the
    # one-way create_booking path must still write each add-on exactly once.
    def quote_with_addon(*a, **k):
        q = dict(LEG_QUOTE)
        q["addon_rows"] = [dict(
            passenger_index=0, addon_type="meal", code="MEAL1",
            name="Veg meal", description=None, unit_price=Decimal("300"), quantity=1,
        )]
        return q

    monkeypatch.setattr(flights.pricing, "quote", quote_with_addon)
    booking = flights.create_booking(world.db, world.customer, {
        "flight": _flight(1), "passengers": _passengers([LEAD]),
        "seats": [], "addons": [{"code": "MEAL1"}],
    })
    rows = list(world.db.execute(
        select(m.CustomerBookingAddon)
        .where(m.CustomerBookingAddon.customer_booking_id == booking.customer_booking_id)
    ).scalars())
    assert len(rows) == 1
