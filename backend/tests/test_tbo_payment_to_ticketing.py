"""Phase 2 items 6 & 7 — payment→ticketing lifecycle and all journey types.

Item 6: trace the complete transition on the REAL payment path — PENDING →
(HDFC capture) → held (PENDING + reservation_missing, money CAPTURED) →
(TBO reserve+ticket) → CONFIRMED with a supplier order id + PNR — and prove the
payment stays CAPTURED throughout, so money is never lost at any step.

Item 7: the same path confirms a one-way, a round-trip and a multi-city booking.
A TBO return/multi-stop search returns the whole journey as ONE result (one
ResultIndex → one offer handle → one PNR), so the resolver — which books the
booking's single supplier offer handle — covers every journey type identically.

Mock TBO client; real DB + real HDFC capture via the guard harness. No network,
no credentials. Not TBO-verified.
"""
from __future__ import annotations

import decimal

import pytest

import app.config
from app.models_customer import (
    CustomerBooking, CustomerBookingPassenger, CustomerBookingStatus, CustomerPaymentStatus,
)
from app.services import flight_supplier_service as flight_supplier
from app.services import payments as P
from app.services import tbo_reservation_service as resolver
from tests.test_flight_supplier_guard import _flight, _pay, _reload
from tests.test_hdfc_products import pdb, provider  # noqa: F401  (fixtures by name)
from tests.test_tbo_flight_booking_service import FakeTBOClient, _quote


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    s = app.config.settings
    monkeypatch.setattr(s, "flight_supplier", "demo")
    monkeypatch.setattr(s, "payment_environment", "test")
    monkeypatch.setattr(s, "deployed", False)
    monkeypatch.setattr(s, "payment_provider", "hdfc")
    monkeypatch.setattr(flight_supplier, "tbo_available", lambda: True)
    P.reset_provider_cache()
    yield
    P.reset_provider_cache()


def _tbo_booking(pdb, monkeypatch, provider, *, ref, journey_type="one_way"):
    CustomerBookingPassenger.__table__.create(pdb.get_bind(), checkfirst=True)
    c, b, pay, oid = _flight(pdb, supplier="tbo", offer_id="TRACE123|RESULT7",
                             supplier_total=decimal.Decimal("56.00"), ref=ref)
    if journey_type != "one_way":
        b.journey_type = journey_type
        pdb.commit()
    return b, pay, oid


def test_full_payment_to_ticketing_transition_and_money_safety(pdb, monkeypatch, provider):
    b, pay, oid = _tbo_booking(pdb, monkeypatch, provider, ref="JPF000930")

    # 1. Before payment: PENDING, nothing captured.
    assert b.status == CustomerBookingStatus.PENDING.value

    # 2. Capture via the real HDFC path → booking HOLDS (live supplier, no order id).
    _pay(monkeypatch, pdb, provider, oid)
    b, pay = _reload(pdb, b, pay)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value          # money in
    assert b.status == CustomerBookingStatus.PENDING.value             # not confirmed
    assert b.supplier_status == "reservation_missing"                   # held
    assert b.supplier_order_id is None

    # 3. Reserve+ticket with TBO → CONFIRMED. Payment UNCHANGED (still captured).
    code = resolver.resolve_reservation(pdb, b, client=FakeTBOClient(fare_quote=_quote(offered=56.0)))
    pdb.commit(); pdb.expire_all()
    b, pay = _reload(pdb, b, pay)
    assert code == "confirmed"
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert b.supplier_order_id == "98765" and b.pnr == "ABCDEF"
    assert pay.status == CustomerPaymentStatus.CAPTURED.value          # money never moved


@pytest.mark.parametrize("journey_type,ref", [
    ("one_way", "JPF000931"),
    ("round_trip", "JPF000932"),
    ("multi_city", "JPF000933"),
])
def test_every_journey_type_reaches_ticketed(pdb, monkeypatch, provider, journey_type, ref):
    b, pay, oid = _tbo_booking(pdb, monkeypatch, provider, ref=ref, journey_type=journey_type)
    _pay(monkeypatch, pdb, provider, oid)
    b, pay = _reload(pdb, b, pay)
    assert b.supplier_status == "reservation_missing"
    code = resolver.resolve_reservation(pdb, b, client=FakeTBOClient(fare_quote=_quote(offered=56.0)))
    pdb.commit(); pdb.expire_all()
    b = pdb.get(CustomerBooking, b.customer_booking_id)
    assert code == "confirmed"
    assert b.journey_type == journey_type
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert b.supplier_order_id == "98765"
