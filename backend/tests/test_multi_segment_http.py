"""The flight booking journeys over REAL HTTP (FastAPI TestClient).

This is the Phase 2 end-to-end evidence for Bugs 2 (multi-city) and 5 (round-trip):
each journey is driven through the actual API routes, not by calling services, so
authentication, request validation, JSON persistence, the server-side price and the
payment-confirmation guard are all exercised the way a browser would hit them.

  one-way     POST /api/customer/bookings
  round-trip  POST /api/customer/bookings/multi-segment   (2 segments)
  multi-city  POST /api/customer/bookings/multi-segment   (N segments)

Payment is driven through the authoritative POST /bookings/{ref}/reconcile route
with a MOCKED provider (no money, no network): the provider reports a captured
amount, and the real verifier confirms the booking ONLY when that amount equals
the server-computed total across every segment. Synthetic data; prices stubbed.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models_customer as m
from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.main import app
from app.services import customer_booking_service as flights
from app.services import payment_verification_flight_service as verify_flight
from app.services import payments as payment_providers
from tests.conftest import FakeProvider, FakeRemote, _next_id

FUTURE = dt.date.today() + dt.timedelta(days=40)
BASE = "/api/customer"

_TABLES = (
    m.Customer, m.CustomerTraveller,
    m.CustomerBooking, m.CustomerBookingPassenger, m.CustomerBookingAddon,
    m.CustomerBookingPayment, m.CustomerBookingSegment,
    m.CustomerAuditLog, m.CustomerNotification,
)

#: One leg's stubbed server price. Every leg prices to this, so an N-leg journey
#: totals N * 5500 — the figure the payment must match to confirm.
LEG = dict(
    base_fare=Decimal("5000"), taxes=Decimal("500"), seat_charges=Decimal("0"),
    baggage_total=Decimal("0"), meal_total=Decimal("0"), service_total=Decimal("0"),
    discount=Decimal("0"), total_amount=Decimal("5500"), currency="INR",
    coupon_code=None, coupon_error=None, priced_seats=[], addon_rows=[],
)
PASSENGER = dict(first_name="Asha", middle_name="Kumari", last_name="Rao", is_contact=True,
                 mobile="+919000000001", email="booker@example.com")


@pytest.fixture()
def http(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    m.Base.metadata.create_all(engine, tables=[t.__table__ for t in _TABLES])

    def assign(mapper, _conn, target):
        key = mapper.get_property_by_column(mapper.primary_key[0]).key
        if getattr(target, key) is None:
            setattr(target, key, _next_id())

    event.listen(m.Base, "before_insert", assign, propagate=True)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    setup = Session()
    people = {}
    for name in ("a", "b"):
        c = m.Customer(customer_id=_next_id(), customer_code=f"CUST{_next_id()}",
                       full_name=f"Customer {name}", email=f"{name}@example.com",
                       mobile="9000000000")
        setup.add(c)
        people[name] = c
    setup.commit()

    def _db():
        with Session() as s:
            yield s

    def _current(request: Request):
        who = request.headers.get("x-test-customer")
        if who not in people:
            raise HTTPException(status_code=401, detail="not signed in")
        return people[who]

    # No catalogue in this in-memory DB: the server still owns pricing, we only
    # stub the figure it would compute. The booking reference needs a value SQLite
    # will not sequence for us.
    refs = iter(f"JPB{900 + i:06d}" for i in range(1, 99))
    monkeypatch.setattr(flights, "next_booking_ref", lambda _db: next(refs))
    monkeypatch.setattr(flights.pricing, "quote", lambda *a, **k: dict(LEG))

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_customer] = _current
    client = TestClient(app, raise_server_exceptions=True)
    client.as_ = lambda who="a": {"x-test-customer": who}
    client.Session = Session
    client.people = people
    yield client
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_customer, None)
    event.remove(m.Base, "before_insert", assign)
    setup.close()
    engine.dispose()


def _leg(n: int, *, intl: bool = False, date: dt.date | None = None) -> dict:
    airports = ["HYD", "DEL", "BOM", "GOA"]
    return dict(flight_key=f"K{n}", flight_number=f"JW{100 + n}",
                travel_date=(date or FUTURE).isoformat(), is_international=intl,
                airline="Test Air", origin_code=airports[n % 4],
                destination_code=airports[(n + 1) % 4], cabin_class="economy")


def _one_way_body(**extra):
    return {"flight": _leg(1), "passengers": [PASSENGER], "seats": [], "addons": [], **extra}


def _multi_body(n_legs, **extra):
    return {
        "segments": [
            {"flight": _leg(i, date=FUTURE + dt.timedelta(days=3 * i)), "seats": [], "addons": []}
            for i in range(n_legs)
        ],
        "passengers": [PASSENGER],
        **extra,
    }


# ===========================================================================
# One-way over HTTP (closing the gap)
# ===========================================================================
def test_one_way_http_creates_booking_with_exactly_one_segment(http):
    r = http.post(f"{BASE}/bookings", json=_one_way_body(), headers=http.as_())
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["journey_type"] == "one_way"
    assert body["status"] == "pending"
    assert len(body["segments"]) == 1
    assert body["segments"][0]["segment_index"] == 0
    assert Decimal(body["total_amount"]) == Decimal("5500.00")      # server-priced
    assert Decimal(body["segments"][0]["total_amount"]) == Decimal(body["total_amount"])


def test_booking_requires_authentication(http):
    r = http.post(f"{BASE}/bookings", json=_one_way_body())        # no X-Test-Customer
    assert r.status_code == 401


def test_booking_rejects_an_invalid_body(http):
    r = http.post(f"{BASE}/bookings", json={"flight": _leg(1), "passengers": []},
                  headers=http.as_())
    assert r.status_code == 422


# ===========================================================================
# Round-trip and multi-city over HTTP
# ===========================================================================
def test_round_trip_http_has_two_ordered_segments(http):
    r = http.post(f"{BASE}/bookings/multi-segment", json=_multi_body(2), headers=http.as_())
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["journey_type"] == "round_trip"
    assert [s["segment_index"] for s in body["segments"]] == [0, 1]
    assert Decimal(body["total_amount"]) == Decimal("11000.00")


def test_multi_city_http_has_n_ordered_segments_and_summed_total(http):
    r = http.post(f"{BASE}/bookings/multi-segment", json=_multi_body(3), headers=http.as_())
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["journey_type"] == "multi_city"
    assert [s["segment_index"] for s in body["segments"]] == [0, 1, 2]
    assert Decimal(body["total_amount"]) == Decimal("16500.00")     # 3 * 5500
    assert Decimal(body["total_amount"]) == sum(
        (Decimal(s["total_amount"]) for s in body["segments"]), Decimal("0"))


def test_multi_segment_endpoint_accepts_a_single_segment(http):
    r = http.post(f"{BASE}/bookings/multi-segment", json=_multi_body(1), headers=http.as_())
    assert r.status_code in (200, 201), r.text
    assert r.json()["journey_type"] == "one_way"


def test_declared_journey_type_must_match_leg_count(http):
    r = http.post(f"{BASE}/bookings/multi-segment",
                  json=_multi_body(3, journey_type="round_trip"), headers=http.as_())
    assert r.status_code == 422


def test_segments_out_of_time_order_are_rejected(http):
    body = _multi_body(2)
    body["segments"][1]["flight"]["travel_date"] = (FUTURE - dt.timedelta(days=5)).isoformat()
    r = http.post(f"{BASE}/bookings/multi-segment", json=body, headers=http.as_())
    assert r.status_code == 422


# ===========================================================================
# Payment confirms only on the exact total across ALL segments (HTTP /reconcile)
# ===========================================================================
def _open_pending_payment(http, booking_ref, *, pay_id="pay_ok", order="order_TEST"):
    """Stand in for what POST /checkout records: a pending payment row carrying
    the provider references the reconcile route verifies against."""
    with http.Session() as s:
        booking = s.execute(select(m.CustomerBooking).where(
            m.CustomerBooking.booking_ref == booking_ref)).scalar_one()
        pay = m.CustomerBookingPayment(
            customer_booking_id=booking.customer_booking_id, method="card",
            status=m.CustomerPaymentStatus.PENDING.value, amount=booking.total_amount,
            currency=booking.currency, provider="trustbrick",
            provider_order_id=order, provider_payment_id=pay_id,
        )
        s.add(pay)
        s.commit()
        return booking.total_amount


def _mock_provider(monkeypatch, *, amount_minor, pay_id="pay_ok", order="order_TEST"):
    remote = FakeRemote(status=payment_providers.CAPTURED, payment_id=pay_id,
                        order_id=order, amount_minor=amount_minor, currency="INR")
    # The local capture path stamps the booking with the provider's paid-at time;
    # the shared FakeRemote does not carry one, so supply it here.
    remote.paid_at = dt.datetime.now(dt.timezone.utc)
    provider = FakeProvider(known={pay_id: remote}, order=remote)
    monkeypatch.setattr(verify_flight.payment_providers, "get_provider_named",
                        lambda *a, **k: provider)


def test_exact_full_payment_confirms_a_multi_city_booking_over_http(http, monkeypatch):
    ref = http.post(f"{BASE}/bookings/multi-segment", json=_multi_body(3),
                    headers=http.as_()).json()["booking_ref"]
    total = _open_pending_payment(http, ref)                       # 16500.00
    _mock_provider(monkeypatch, amount_minor=payment_providers.to_minor(total, "INR"))

    r = http.post(f"{BASE}/bookings/{ref}/reconcile", json={}, headers=http.as_())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["captured"] is True
    assert body["booking_status"] == "confirmed"
    assert Decimal(str(body["amount"])) == total


def test_under_payment_of_one_leg_does_not_confirm_multi_city_over_http(http, monkeypatch):
    create = http.post(f"{BASE}/bookings/multi-segment", json=_multi_body(3),
                       headers=http.as_()).json()
    one_leg = Decimal(create["segments"][0]["total_amount"])       # 5500 < 16500
    ref = create["booking_ref"]
    _open_pending_payment(http, ref)
    _mock_provider(monkeypatch, amount_minor=payment_providers.to_minor(one_leg, "INR"))

    r = http.post(f"{BASE}/bookings/{ref}/reconcile", json={}, headers=http.as_())
    assert r.status_code == 200, r.text
    assert r.json()["captured"] is False
    # And the booking is still pending, read back over HTTP.
    got = http.get(f"{BASE}/bookings/{ref}", headers=http.as_()).json()
    assert got["status"] == "pending"


# ===========================================================================
# My Bookings shows every segment; ownership is enforced
# ===========================================================================
def test_my_bookings_lists_all_segments_not_just_the_first(http):
    http.post(f"{BASE}/bookings/multi-segment", json=_multi_body(3), headers=http.as_())
    listed = http.get(f"{BASE}/bookings", headers=http.as_()).json()
    assert len(listed) == 1
    assert [s["segment_index"] for s in listed[0]["segments"]] == [0, 1, 2]
    assert listed[0]["origin_code"] == listed[0]["segments"][0]["origin_code"]
    assert listed[0]["destination_code"] == listed[0]["segments"][-1]["destination_code"]


def test_one_customer_cannot_read_anothers_multi_segment_booking(http):
    ref = http.post(f"{BASE}/bookings/multi-segment", json=_multi_body(2),
                    headers=http.as_("a")).json()["booking_ref"]
    assert http.get(f"{BASE}/bookings/{ref}", headers=http.as_("b")).status_code == 404


# ===========================================================================
# Legacy compatibility: a booking that predates segments (no segment row)
# ===========================================================================
def _legacy_booking(http, who="a"):
    """A one-way booking row with NO segment, as every booking looked before
    migration 0096 — inserted directly, not through the segment-writing service."""
    with http.Session() as s:
        cust = s.get(m.Customer, http.people[who].customer_id)
        b = m.CustomerBooking(
            booking_ref="JPBLEGACY1", customer_id=cust.customer_id, product_type="flight",
            status=m.CustomerBookingStatus.PENDING.value, airline="Old Air",
            flight_number="OA1", origin_code="HYD", destination_code="DEL",
            travel_date=FUTURE, stops=0, is_international=False,
            base_fare=Decimal("5000"), taxes=Decimal("500"), seat_charges=Decimal("0"),
            baggage_total=Decimal("0"), meal_total=Decimal("0"), service_total=Decimal("0"),
            discount=Decimal("0"), total_amount=Decimal("5500"), currency="INR",
        )
        s.add(b)
        s.commit()
    return "JPBLEGACY1"


def test_legacy_booking_without_a_segment_row_still_reads_over_http(http):
    ref = _legacy_booking(http)
    got = http.get(f"{BASE}/bookings/{ref}", headers=http.as_()).json()
    assert got["booking_ref"] == ref
    assert got["journey_type"] == "one_way"       # column default
    assert got["segments"] == []                   # none, and that is fine
    assert Decimal(got["total_amount"]) == Decimal("5500.00")


def test_legacy_booking_without_a_segment_row_still_cancels_over_http(http):
    ref = _legacy_booking(http)
    r = http.post(f"{BASE}/bookings/{ref}/cancel", json={}, headers=http.as_())
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"
