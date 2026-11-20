"""Unified customer payment history across all three products (Bug 10).

REGRESSION GUARD. Before this fix `list_payments_for_customer` joined only the
FLIGHT payment table, so a customer who paid for a hotel or a package saw those
payments vanish from Payment History — a financial-completeness defect. These
tests build a customer with a payment in each of the three products and assert
all three come back, correctly tagged; and they build a second customer and
assert no payment ever crosses between them.

NO REAL PROVIDER, NO NETWORK, NO MONEY. SQLite in memory, the same columns the
migrations define.
"""
from __future__ import annotations

import datetime as dt
import decimal

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models_customer as m
from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.main import app
from app.models_customer import CustomerPaymentStatus
from app.services import customer_account_service as acct
from tests.conftest import _next_id

UTC = dt.timezone.utc

_TABLES = [
    m.Customer.__table__,
    m.CustomerBooking.__table__, m.CustomerBookingPayment.__table__,
    m.CustomerHotelBooking.__table__, m.CustomerHotelBookingPayment.__table__,
    m.CustomerPackageBooking.__table__, m.CustomerPackageBookingPayment.__table__,
]


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------
def _customer(db, *, name="A"):
    c = m.Customer(
        customer_id=_next_id(), customer_code=f"CUST{_next_id()}",
        full_name=f"Customer {name}", email=f"{name.lower()}@example.test",
        mobile="9000000000",
    )
    db.add(c)
    db.flush()
    return c


def _flight_payment(db, customer, *, ref, amount="100.00", currency="INR",
                    status=CustomerPaymentStatus.CAPTURED.value, method="gateway",
                    txn="pay_FL", created_at=None):
    b = m.CustomerBooking(
        customer_booking_id=_next_id(), booking_ref=ref,
        customer_id=customer.customer_id, product_type="flight",
    )
    db.add(b)
    db.flush()
    p = m.CustomerBookingPayment(
        customer_booking_payment_id=_next_id(),
        customer_booking_id=b.customer_booking_id,
        method=method, amount=decimal.Decimal(amount), currency=currency,
        status=status, provider="trustbrick", provider_reference=txn,
        created_at=created_at or dt.datetime.now(UTC),
    )
    db.add(p)
    db.flush()
    return p


def _hotel_payment(db, customer, *, ref, amount="200.00", currency="INR",
                   status=CustomerPaymentStatus.CAPTURED.value, method="upi",
                   txn="pay_HO", created_at=None):
    b = m.CustomerHotelBooking(
        customer_hotel_booking_id=_next_id(), booking_ref=ref,
        customer_id=customer.customer_id, hotel_id=1, hotel_name="TEST HOTEL",
        room_id=1, room_name="Room", check_in_date=dt.date(2026, 9, 12),
        check_out_date=dt.date(2026, 9, 13), nights=1,
        total_amount=decimal.Decimal(amount), currency=currency, status="pending",
    )
    db.add(b)
    db.flush()
    p = m.CustomerHotelBookingPayment(
        customer_hotel_booking_payment_id=_next_id(),
        hotel_booking_id=b.customer_hotel_booking_id,
        method=method, amount=decimal.Decimal(amount), currency=currency,
        status=status, provider="trustbrick", provider_reference=txn,
        created_at=created_at or dt.datetime.now(UTC),
    )
    db.add(p)
    db.flush()
    return p


def _package_payment(db, customer, *, ref, amount="300.00", currency="INR",
                     status=CustomerPaymentStatus.CAPTURED.value, method="card",
                     txn="pay_PK", created_at=None):
    b = m.CustomerPackageBooking(
        customer_package_booking_id=_next_id(), booking_ref=ref,
        customer_id=customer.customer_id, package_id=1, package_name="TEST PACKAGE",
        package_days=5, departure_id=1, departure_date=dt.date(2026, 10, 1),
        total_amount=decimal.Decimal(amount), currency=currency,
    )
    db.add(b)
    db.flush()
    p = m.CustomerPackageBookingPayment(
        customer_package_booking_payment_id=_next_id(),
        package_booking_id=b.customer_package_booking_id,
        method=method, amount=decimal.Decimal(amount), currency=currency,
        status=status, provider="trustbrick", provider_reference=txn,
        created_at=created_at or dt.datetime.now(UTC),
    )
    db.add(p)
    db.flush()
    return p


# ---------------------------------------------------------------------------
# Service-level fixture
# ---------------------------------------------------------------------------
@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    m.Base.metadata.create_all(engine, tables=_TABLES)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


# ---------------------------------------------------------------------------
# Service-level tests
# ---------------------------------------------------------------------------
def test_history_includes_flight_hotel_and_package(db):
    c = _customer(db)
    _flight_payment(db, c, ref="JPF000001", created_at=dt.datetime(2026, 1, 1, tzinfo=UTC))
    _hotel_payment(db, c, ref="JPH000001", created_at=dt.datetime(2026, 2, 1, tzinfo=UTC))
    _package_payment(db, c, ref="JPP000001", created_at=dt.datetime(2026, 3, 1, tzinfo=UTC))

    result = acct.list_payments_for_customer(db, c)

    assert result["total"] == 3
    services = {row["service_type"] for row in result["items"]}
    assert services == {"flight", "hotel", "package"}
    # Every row carries the full unified shape.
    for row in result["items"]:
        assert set(row) >= {
            "service_type", "booking_ref", "created_at", "amount", "currency",
            "method", "status", "transaction_ref", "refund_status",
        }


def test_history_sorted_newest_first(db):
    c = _customer(db)
    _flight_payment(db, c, ref="JPF000001", created_at=dt.datetime(2026, 1, 1, tzinfo=UTC))
    _package_payment(db, c, ref="JPP000001", created_at=dt.datetime(2026, 3, 1, tzinfo=UTC))
    _hotel_payment(db, c, ref="JPH000001", created_at=dt.datetime(2026, 2, 1, tzinfo=UTC))

    items = acct.list_payments_for_customer(db, c)["items"]
    refs = [r["booking_ref"] for r in items]
    assert refs == ["JPP000001", "JPH000001", "JPF000001"]  # Mar, Feb, Jan


def test_one_customer_never_sees_anothers_payments(db):
    a = _customer(db, name="A")
    b = _customer(db, name="B")
    _flight_payment(db, a, ref="JPF-A", txn="pay_A_flight")
    _hotel_payment(db, b, ref="JPH-B", txn="pay_B_hotel")
    _package_payment(db, b, ref="JPP-B", txn="pay_B_pkg")

    a_rows = acct.list_payments_for_customer(db, a)
    b_rows = acct.list_payments_for_customer(db, b)

    assert a_rows["total"] == 1
    assert {r["booking_ref"] for r in a_rows["items"]} == {"JPF-A"}
    assert b_rows["total"] == 2
    assert {r["booking_ref"] for r in b_rows["items"]} == {"JPH-B", "JPP-B"}
    # The decisive assertion: none of B's transaction refs reach A.
    a_txns = {r["transaction_ref"] for r in a_rows["items"]}
    assert "pay_B_hotel" not in a_txns and "pay_B_pkg" not in a_txns


def test_refund_status_derived_from_payment_status(db):
    c = _customer(db)
    _flight_payment(db, c, ref="JPF-OK", status=CustomerPaymentStatus.CAPTURED.value)
    _hotel_payment(db, c, ref="JPH-RF", status=CustomerPaymentStatus.REFUNDED.value)

    by_ref = {r["booking_ref"]: r for r in acct.list_payments_for_customer(db, c)["items"]}
    assert by_ref["JPF-OK"]["refund_status"] is None
    assert by_ref["JPH-RF"]["refund_status"] == "refunded"


def test_pagination_slices_and_reports_total(db):
    c = _customer(db)
    # 5 payments across the three products, dated so the order is deterministic.
    for i in range(5):
        _flight_payment(db, c, ref=f"JPF{i}", txn=f"t{i}",
                        created_at=dt.datetime(2026, 1, i + 1, tzinfo=UTC))

    page1 = acct.list_payments_for_customer(db, c, page=1, page_size=2)
    page2 = acct.list_payments_for_customer(db, c, page=2, page_size=2)
    page3 = acct.list_payments_for_customer(db, c, page=3, page_size=2)

    assert page1["total"] == page2["total"] == page3["total"] == 5
    assert len(page1["items"]) == 2
    assert len(page2["items"]) == 2
    assert len(page3["items"]) == 1
    # No row appears on two pages.
    seen = [r["booking_ref"] for p in (page1, page2, page3) for r in p["items"]]
    assert len(seen) == len(set(seen)) == 5


def test_pagination_bounds_are_safe(db):
    c = _customer(db)
    _flight_payment(db, c, ref="JPF-1")
    # page_size over the max is clamped, not honoured as-is; page below 1 floors.
    big = acct.list_payments_for_customer(db, c, page=0, page_size=10_000)
    assert big["page"] == 1
    assert big["page_size"] == acct.PAYMENT_PAGE_SIZE_MAX
    # A page past the end is empty, not an error.
    empty = acct.list_payments_for_customer(db, c, page=99, page_size=20)
    assert empty["items"] == [] and empty["total"] == 1


def test_empty_history_is_a_valid_empty_page(db):
    c = _customer(db)
    result = acct.list_payments_for_customer(db, c)
    assert result == {"items": [], "total": 0, "page": 1, "page_size": acct.PAYMENT_PAGE_SIZE_DEFAULT}


# ---------------------------------------------------------------------------
# HTTP-level test — the full stack, including the response envelope and auth
# ---------------------------------------------------------------------------
@pytest.fixture()
def http():
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False},
    )
    m.Base.metadata.create_all(engine, tables=_TABLES)

    def assign(mapper, _conn, target):  # SQLite runs no identity sequences
        key = mapper.get_property_by_column(mapper.primary_key[0]).key
        if getattr(target, key) is None:
            setattr(target, key, _next_id())

    event.listen(m.Base, "before_insert", assign, propagate=True)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    setup = Session()
    people = {}
    for name in ("a", "b"):
        people[name] = _customer(setup, name=name.upper())
    # Customer A: one of each product. Customer B: a single hotel payment.
    _flight_payment(setup, people["a"], ref="JPF-A", txn="pay_A_flight",
                    created_at=dt.datetime(2026, 1, 1, tzinfo=UTC))
    _hotel_payment(setup, people["a"], ref="JPH-A", txn="pay_A_hotel",
                   created_at=dt.datetime(2026, 2, 1, tzinfo=UTC))
    _package_payment(setup, people["a"], ref="JPP-A", txn="pay_A_pkg",
                     created_at=dt.datetime(2026, 3, 1, tzinfo=UTC))
    _hotel_payment(setup, people["b"], ref="JPH-B", txn="pay_B_hotel")
    setup.commit()

    def _db():
        with Session() as s:
            yield s

    def _current(request: Request):
        who = request.headers.get("x-test-customer")
        if who not in people:
            raise HTTPException(status_code=401, detail="not signed in")
        return people[who]

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_customer] = _current
    client = TestClient(app, raise_server_exceptions=True)
    client.as_ = lambda who: {"x-test-customer": who}
    yield client
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_customer, None)
    event.remove(m.Base, "before_insert", assign)
    setup.close()
    engine.dispose()


def test_http_returns_all_three_services_newest_first(http):
    r = http.get("/api/customer/payments/history", headers=http.as_("a"))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert [row["service_type"] for row in body["items"]] == ["package", "hotel", "flight"]
    assert {row["booking_ref"] for row in body["items"]} == {"JPF-A", "JPH-A", "JPP-A"}


def test_http_customer_b_cannot_see_customer_a(http):
    r = http.get("/api/customer/payments/history", headers=http.as_("b"))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    txns = {row["transaction_ref"] for row in body["items"]}
    assert txns == {"pay_B_hotel"}
    assert "pay_A_flight" not in txns and "pay_A_hotel" not in txns and "pay_A_pkg" not in txns


def test_http_pagination_envelope(http):
    r = http.get("/api/customer/payments/history",
                 params={"page": 1, "page_size": 2}, headers=http.as_("a"))
    body = r.json()
    assert body["page"] == 1 and body["page_size"] == 2 and body["total"] == 3
    assert len(body["items"]) == 2

    r2 = http.get("/api/customer/payments/history",
                  params={"page": 2, "page_size": 2}, headers=http.as_("a"))
    assert len(r2.json()["items"]) == 1


def test_http_rejects_bad_pagination(http):
    # page_size over the documented max is a 422 at the edge, not a silent clamp.
    r = http.get("/api/customer/payments/history",
                 params={"page_size": 9999}, headers=http.as_("a"))
    assert r.status_code == 422


def test_http_requires_a_session(http):
    assert http.get("/api/customer/payments/history").status_code == 401
