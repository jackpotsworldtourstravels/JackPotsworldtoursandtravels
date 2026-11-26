"""DB-level tests for the held-TBO-booking resolver (Phase 2, item 4 wiring).

Reuses the flight-supplier-guard harness: a real in-memory DB, a TBO booking that
HOLDS after payment capture (reservation_missing), then the resolver reserves +
tickets it with a mocked TBO client and confirms it through the same
``complete_reservation`` every held booking uses. No network, no TBO credentials.

Proves: confirmed on a genuine ticket; FAIL CLOSED when TBO is unconfigured;
stays held when TBO does not ticket; idempotent on re-run; supplier errors leave
the booking held (money safe); the demo path is not a TBO booking.
"""
from __future__ import annotations

import datetime as dt
import decimal
from types import SimpleNamespace

import pytest

import app.config
from app.integrations.tbo.exceptions import TBOError
from app.models_customer import CustomerBooking, CustomerBookingPassenger, CustomerBookingStatus
from app.services import flight_supplier_service as flight_supplier
from app.services import payments as P
from app.services import tbo_reservation_service as resolver
from tests.test_flight_supplier_guard import _flight, _pay, _reload
from tests.test_hdfc_products import pdb, provider  # noqa: F401  (fixtures by name)
from tests.test_tbo_flight_booking_service import FakeTBOClient, _itin, _quote


@pytest.fixture(autouse=True)
def _demo_defaults(monkeypatch):
    s = app.config.settings
    monkeypatch.setattr(s, "flight_supplier", "demo")
    monkeypatch.setattr(s, "payment_environment", "test")
    monkeypatch.setattr(s, "deployed", False)
    monkeypatch.setattr(s, "payment_provider", "hdfc")
    P.reset_provider_cache()
    yield
    P.reset_provider_cache()


def _held_tbo_booking(pdb, monkeypatch, provider, *, ref):
    """A TBO booking that is captured-but-held (reservation_missing)."""
    # The shared pdb fixture omits the passenger table; the resolver reads
    # booking.passengers, so create just that one table on this engine.
    CustomerBookingPassenger.__table__.create(pdb.get_bind(), checkfirst=True)
    c, b, pay, oid = _flight(pdb, supplier="tbo", offer_id="TRACE123|RESULT7",
                             supplier_total=decimal.Decimal("56.00"), ref=ref)
    # Passenger mapping is unit-tested separately (test_passenger_dicts_maps_rows);
    # the shared pdb fixture has no passenger table, and the mock client does not
    # read passengers, so the resolver's confirm/hold logic is what these exercise.
    _pay(monkeypatch, pdb, provider, oid)   # capture → confirm_booking holds it
    b, pay = _reload(pdb, b, pay)
    assert b.status == CustomerBookingStatus.PENDING.value
    assert b.supplier_status == "reservation_missing"
    return b


def test_resolver_confirms_a_genuinely_ticketed_booking(pdb, monkeypatch, provider):
    monkeypatch.setattr(flight_supplier, "tbo_available", lambda: True)
    b = _held_tbo_booking(pdb, monkeypatch, provider, ref="JPF000910")
    code = resolver.resolve_reservation(pdb, b, client=FakeTBOClient(fare_quote=_quote(offered=56.0)))
    pdb.commit()
    pdb.expire_all()
    b = pdb.get(CustomerBooking, b.customer_booking_id)
    assert code == "confirmed"
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert b.supplier_order_id == "98765"
    assert b.pnr == "ABCDEF"


def test_resolver_fails_closed_when_tbo_not_configured(pdb, monkeypatch, provider):
    monkeypatch.setattr(flight_supplier, "tbo_available", lambda: False)
    b = _held_tbo_booking(pdb, monkeypatch, provider, ref="JPF000911")
    code = resolver.resolve_reservation(pdb, b, client=FakeTBOClient())
    pdb.commit()
    pdb.expire_all()
    b = pdb.get(CustomerBooking, b.customer_booking_id)
    assert code == "not_configured"
    assert b.status == CustomerBookingStatus.PENDING.value           # still held
    assert b.supplier_order_id is None


def test_resolver_stays_held_when_tbo_does_not_ticket(pdb, monkeypatch, provider):
    monkeypatch.setattr(flight_supplier, "tbo_available", lambda: True)
    b = _held_tbo_booking(pdb, monkeypatch, provider, ref="JPF000912")
    not_ticketed = FakeTBOClient(fare_quote=_quote(offered=56.0),
                                 ticket_lcc=_itin(status=0, ticketed=False),
                                 get_booking_details=_itin(status=0, ticketed=False))
    code = resolver.resolve_reservation(pdb, b, client=not_ticketed)
    pdb.commit()
    pdb.expire_all()
    b = pdb.get(CustomerBooking, b.customer_booking_id)
    assert code == "held"
    assert b.status == CustomerBookingStatus.PENDING.value


def test_resolver_supplier_error_leaves_booking_held(pdb, monkeypatch, provider):
    monkeypatch.setattr(flight_supplier, "tbo_available", lambda: True)
    b = _held_tbo_booking(pdb, monkeypatch, provider, ref="JPF000913")

    class Boom(FakeTBOClient):
        def fare_quote(self, t, r):
            raise TBOError("supplier down")

    code = resolver.resolve_reservation(pdb, b, client=Boom())
    pdb.commit()
    pdb.expire_all()
    b = pdb.get(CustomerBooking, b.customer_booking_id)
    assert code == "supplier_error"
    assert b.status == CustomerBookingStatus.PENDING.value


def test_resolver_is_idempotent_on_a_confirmed_booking(pdb, monkeypatch, provider):
    monkeypatch.setattr(flight_supplier, "tbo_available", lambda: True)
    b = _held_tbo_booking(pdb, monkeypatch, provider, ref="JPF000914")
    assert resolver.resolve_reservation(pdb, b, client=FakeTBOClient(fare_quote=_quote(offered=56.0))) == "confirmed"
    pdb.commit()
    pdb.expire_all()
    b = pdb.get(CustomerBooking, b.customer_booking_id)
    # Re-run: already has an order id → reserve reconciles, complete_reservation
    # reports already_confirmed → resolver maps to "confirmed", no second booking.
    code = resolver.resolve_reservation(pdb, b, client=FakeTBOClient(fare_quote=_quote(offered=56.0)))
    assert code == "confirmed"
    assert b.status == CustomerBookingStatus.CONFIRMED.value


def test_demo_booking_is_not_a_tbo_reservation(pdb, monkeypatch, provider):
    monkeypatch.setattr(flight_supplier, "tbo_available", lambda: True)
    _, b, _, _ = _flight(pdb, ref="JPF000915")   # no supplier → demo
    assert resolver.resolve_reservation(pdb, b, client=FakeTBOClient()) == "not_live_supplier"


def test_passenger_dicts_maps_rows():
    booking = SimpleNamespace(passengers=[
        SimpleNamespace(passenger_index=1, title="Ms", first_name="Ravi", last_name="Rao",
                        traveller_type="child", gender="male", date_of_birth=dt.date(2016, 5, 1),
                        nationality="Indian", passport_number="TP222", passport_expiry=dt.date(2030, 1, 1),
                        mobile=None, email=None, is_contact=False),
        SimpleNamespace(passenger_index=0, title="Mr", first_name="Asha", last_name="Rao",
                        traveller_type="adult", gender="female", date_of_birth=None,
                        nationality="Indian", passport_number=None, passport_expiry=None,
                        mobile="+919000000001", email="a@example.com", is_contact=True),
    ])
    out = resolver._passenger_dicts(booking)
    # Ordered by passenger_index; the contact passenger is the lead.
    assert [p["first_name"] for p in out] == ["Asha", "Ravi"]
    assert out[0]["is_lead"] is True and out[1]["is_lead"] is False
    assert out[0]["type"] == "adult" and out[1]["type"] == "child"
    assert out[1]["passport_no"] == "TP222" and out[1]["date_of_birth"] == "2016-05-01"
