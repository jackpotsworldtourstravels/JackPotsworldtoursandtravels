"""Calculation tests for B2C Analytics, ``GET /api/admin/b2c-analytics/overview``.

WHAT THIS DOES AND DOES NOT PROVE — READ BEFORE CITING IT.
The service buckets months with PostgreSQL's ``to_char(timezone('Asia/Kolkata',
ts), 'YYYY-MM')``. SQLite has neither function, which is why the older check
in test_admin_b2c_bookings_activity_reports_http.py skips. Here the two are
REGISTERED ON THE SQLITE CONNECTION as stand-ins:

* ``timezone(zone, ts)`` -> ``ts`` unchanged. Every row below is written with
  an India-time (IST) timestamp, and SQLite stores the wall clock as written,
  so the stored value already IS the IST wall clock the real function yields.
* ``to_char(ts, 'YYYY-MM')`` -> the first seven characters of the stored text.

So this runs the REAL router, service, aggregation, NULL handling, status rules
and money arithmetic against hand-seeded rows with known answers. It does NOT
verify PostgreSQL's own time-zone conversion or month bucketing at a month
boundary — that needs a PostgreSQL run and is reported as NOT VERIFIED here.
All seeded rows sit mid-month, away from any boundary.
"""
from __future__ import annotations

import datetime as dt
import decimal
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base, Customer, CustomerBooking, CustomerBookingPayment, CustomerCancellationRequest, CustomerHotelBooking,
    CustomerHotelBookingPayment, CustomerPackageBooking, CustomerPackageBookingPayment, CustomerRefundAttempt,
    CustomerReview,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_b2c_reports
from app.services import customer_analytics_admin_service as analytics
from app.services.customer_report_service import IST

D = decimal.Decimal
URL = "/api/admin/b2c-analytics/overview"
_N = {"n": 930000}
_TABLES = (Customer, CustomerBooking, CustomerBookingPayment, CustomerHotelBooking, CustomerHotelBookingPayment,
           CustomerPackageBooking, CustomerPackageBookingPayment, CustomerCancellationRequest, CustomerRefundAttempt,
           CustomerReview)

FRAME = analytics.month_frame(6)
M0, M2 = FRAME[-1], FRAME[-3]          # this month, two months ago


def _mid(month: str) -> dt.datetime:
    y, m = map(int, month.split("-"))
    return dt.datetime(y, m, 15, 12, 0, tzinfo=IST)


T0, T2 = _mid(M0), _mid(M2)
OLD = T0 - dt.timedelta(days=30 * 30)  # well outside any window


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        app = FastAPI()
        app.include_router(admin_b2c_reports.analytics_router)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=True)

    def add(self, *rows):
        db = self.Session()
        for r in rows:
            db.add(r)
            db.flush()
        db.commit()
        db.close()


@pytest.fixture()
def env():
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _pg_stand_ins(dbapi_conn, _record):
        dbapi_conn.create_function("timezone", 2, lambda zone, ts: ts)
        dbapi_conn.create_function("to_char", 2,
                                   lambda ts, fmt: (ts[:7] if fmt == "YYYY-MM" else None) if ts else None)

    Base.metadata.create_all(engine, tables=[m.__table__ for m in _TABLES])
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
    yield Env(engine)
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


def _user(env, role, perms=None):
    u = User(user_id=_id(), full_name="Analytics Reviewer", email=f"u{_N['n']}@tt-qa.com", password_hash="x",
             role=role, status=UserStatus.ACTIVE, permissions=perms or [])
    env.add(u)
    return {"Authorization": f"Bearer {create_access_token(u.user_id)}"}


@pytest.fixture()
def viewer(env):
    return _user(env, UserRole.ADMIN, [P.B2C_REPORTS_VIEW])


# ------------------------------------------------------------------ seeding
def _customer(env, at, guest=False):
    cid = _id()
    env.add(Customer(customer_id=cid, customer_code=f"C{cid}", full_name=f"Cust {cid}", email=f"c{cid}@tt-qa.com",
                     mobile="9000000000", is_guest=guest, created_at=at))
    return cid


def _pay(model, fk, bid, amount, status, at, provider="hdfc"):
    pk = {CustomerBookingPayment: "customer_booking_payment_id",
          CustomerHotelBookingPayment: "customer_hotel_booking_payment_id",
          CustomerPackageBookingPayment: "customer_package_booking_payment_id"}[model]
    pid = _id()
    return model(**{pk: pid, fk: bid}, method="gateway", amount=D(amount), currency="INR", status=status,
                 provider=provider, created_at=at), pid


def _flight(env, cid, status, total, at, pays=()):
    bid = _id()
    rows = [CustomerBooking(customer_booking_id=bid, booking_ref=f"JPF{bid}", customer_id=cid, total_amount=D(total),
                            currency="INR", status=status, created_at=at, origin_city="Delhi",
                            destination_city="Goa", flight_number="AI101", travel_date=dt.date.today())]
    ids = []
    for amount, st, prov in pays:
        row, pid = _pay(CustomerBookingPayment, "customer_booking_id", bid, amount, st, at, prov)
        rows.append(row)
        ids.append(pid)
    env.add(*rows)
    return f"JPF{bid}", ids


def _hotel(env, cid, status, total, at, pays=()):
    bid = _id()
    rows = [CustomerHotelBooking(customer_hotel_booking_id=bid, booking_ref=f"JPH{bid}", customer_id=cid, hotel_id=1,
                                 hotel_name="Sea View", room_id=1, room_name="Deluxe", check_in_date=dt.date.today(),
                                 check_out_date=dt.date.today() + dt.timedelta(days=1), nights=1,
                                 total_amount=D(total), currency="INR", status=status, created_at=at)]
    rows += [_pay(CustomerHotelBookingPayment, "hotel_booking_id", bid, a, s, at, p)[0] for a, s, p in pays]
    env.add(*rows)


def _package(env, cid, status, total, at, pays=(), name="Goa Escape"):
    bid = _id()
    rows = [CustomerPackageBooking(customer_package_booking_id=bid, booking_ref=f"JPP{bid}", customer_id=cid,
                                   package_id=1, package_name=name, package_days=4, departure_id=1,
                                   departure_date=dt.date.today(), pax_count=2, total_amount=D(total),
                                   currency="INR", status=status, created_at=at)]
    rows += [_pay(CustomerPackageBookingPayment, "package_booking_id", bid, a, s, at, p)[0] for a, s, p in pays]
    env.add(*rows)


def _cancellation(env, cid, booking_ref, status, refund_amount, at):
    ref = f"CXL{_id()}"
    env.add(CustomerCancellationRequest(cancellation_id=_N["n"], cancellation_ref=ref, customer_id=cid,
                                        product="flight", booking_ref=booking_ref, status=status,
                                        refund_amount=D(refund_amount) if refund_amount is not None else None,
                                        created_at=at, updated_at=at))
    return ref


def _attempt(env, cxl_ref, n, payment_id, minor, status, at):
    env.add(CustomerRefundAttempt(refund_attempt_id=_id(), cancellation_ref=cxl_ref, attempt_number=n,
                                  payment_table="customer_booking_payments", payment_row_id=payment_id,
                                  provider="hdfc", idempotency_key=f"idem-{_N['n']}", amount_minor=minor,
                                  currency="INR", status=status, created_at=at, updated_at=at))


def _review(env, cid, status, rating, item):
    env.add(CustomerReview(customer_review_id=_id(), customer_id=cid, item_type="hotel", item_id=item, rating=rating,
                           status=status, created_at=T0, updated_at=T0))


def _seed(env):
    c1, c2 = _customer(env, T0), _customer(env, T0)
    g1 = _customer(env, T2, guest=True)
    old = _customer(env, OLD)

    _flight(env, c1, "pending", "1000.00", T0)                                            # unpaid
    _flight(env, c1, "confirmed", "2500.50", T0, [("2500.50", "captured", "hdfc")])
    f3, (f3_pay,) = _flight(env, c2, "cancelled", "4100.00", T2, [("4100.00", "refunded", "hdfc")])  # refunded in full
    _flight(env, old, "completed", "9999.00", OLD, [("9999.00", "captured", "hdfc")])      # outside window
    _hotel(env, c1, "confirmed", "900.00", T0, [("900.00", "failed", "razorpay"), ("900.00", "captured", "razorpay")])
    _package(env, g1, "completed", "8000.25", T2, [("8000.25", "captured", "hdfc")])
    _package(env, c2, "pending", "3000.00", T0, [("3000.00", "failed", "hdfc")])

    cr1 = _cancellation(env, c2, f3, "refunded", "4100.00", T2)
    _attempt(env, cr1, 1, f3_pay, 410000, "succeeded", T2)
    _cancellation(env, c1, "JPFX", "requested", None, T0)                                  # NULL refund_amount
    cr3 = _cancellation(env, c1, "JPFY", "approved", "1500.00", T0)
    _attempt(env, cr3, 1, f3_pay, 150000, "failed", T0)                                    # not money returned
    _attempt(env, cr3, 2, f3_pay, 150000, "processing", T0)                                # not yet returned
    cr_old = _cancellation(env, old, "JPFZ", "refunded", "500.00", OLD)
    _attempt(env, cr_old, 1, f3_pay, 50000, "succeeded", OLD)                              # outside window

    _review(env, c1, "approved", 5, 1)
    _review(env, c2, "approved", 4, 2)
    _review(env, g1, "pending", 1, 3)
    _review(env, old, "rejected", 1, 4)


# ================================================================== calculations
def test_empty_database_returns_zeroes_and_a_full_frame(env, viewer):
    r = env.client.get(URL, headers=viewer)
    assert r.status_code == 200, r.text
    o = r.json()
    assert o["months"] == 6 and o["frame"] == FRAME and o["since"] == FRAME[0]
    assert o["customers"] == {"total": 0, "guests": 0, "registered": 0, "new_in_period": 0,
                              "by_month": [{"month": m, "count": 0} for m in FRAME]}
    b = o["bookings"]
    assert (b["created"], b["cancelled"], b["booked_value"], b["confirmed_value"], b["non_inr_bookings"]) == \
        (0, 0, "0.00", "0.00", 0)
    assert all(m["count"] == 0 and m["value"] == "0.00" for s in b["monthly"] for m in s["series"])
    assert o["payments"] == {"collected": "0.00", "captured_count": 0, "by_status": [], "by_provider": []}
    assert o["refunds"] == {"requests": 0, "refunded": "0.00", "by_status": []}
    assert [f["count"] for f in o["funnel"]] == [0, 0, 0]
    assert o["top"] == {"packages": [], "hotels": [], "flight_routes": []}
    assert o["reviews"] == {"approved": 0, "pending": 0, "average": None}


def test_every_figure_matches_a_hand_seeded_data_set(env, viewer):
    _seed(env)
    r = env.client.get(URL, headers=viewer)
    assert r.status_code == 200, r.text
    o = r.json()

    c = o["customers"]
    assert (c["total"], c["guests"], c["registered"], c["new_in_period"]) == (4, 1, 3, 3)
    by_m = {x["month"]: x["count"] for x in c["by_month"]}
    assert by_m[M0] == 2 and by_m[M2] == 1 and sum(by_m.values()) == 3

    b = o["bookings"]
    assert b["created"] == 6 and b["cancelled"] == 1 and b["non_inr_bookings"] == 0
    # not cancelled: 1000 + 2500.50 + 900 + 8000.25 + 3000
    assert b["booked_value"] == "15400.75"
    # confirmed/completed: 2500.50 + 900 + 8000.25
    assert b["confirmed_value"] == "11400.75"
    assert {s["status"]: (s["count"], s["value"]) for s in b["by_status"]} == {
        "pending": (2, "4000.00"), "confirmed": (2, "3400.50"), "cancelled": (1, "4100.00"),
        "completed": (1, "8000.25")}
    assert {p["product"]: (p["bookings"], p["cancelled"], p["booked_value"], p["confirmed_value"])
            for p in b["by_product"]} == {
        "flight": (3, 1, "3500.50", "2500.50"), "hotel": (1, 0, "900.00", "900.00"),
        "package": (2, 0, "11000.25", "8000.25")}

    monthly = {s["product"]: {m["month"]: (m["count"], m["value"]) for m in s["series"]} for s in b["monthly"]}
    assert monthly["flight"][M0] == (2, "3500.50")
    assert monthly["flight"][M2] == (1, "0.00"), "a cancelled booking is created, but adds no booked value"
    assert monthly["package"][M2] == (1, "8000.25") and monthly["package"][M0] == (1, "3000.00")
    total_monthly = sum(D(m["value"]) for s in b["monthly"] for m in s["series"])
    assert total_monthly == D(b["booked_value"]), "monthly booked-value bars must add up to the tile"

    p = o["payments"]
    # captured 2500.50 + 900 + 8000.25, plus the payment refunded in full (4100) — it was collected
    assert p["collected"] == "15500.75" and p["captured_count"] == 4
    assert {s["status"]: (s["count"], s["amount"]) for s in p["by_status"]} == {
        "captured": (3, "11400.75"), "failed": (2, "3900.00"), "refunded": (1, "4100.00")}
    assert {x["provider"]: (x["count"], x["amount"]) for x in p["by_provider"]} == {
        "hdfc": (3, "14600.75"), "razorpay": (1, "900.00")}

    f = o["refunds"]
    assert f["requests"] == 3
    # money actually returned: succeeded attempts in the window only (not failed/processing, not the old one)
    assert f["refunded"] == "4100.00"
    assert {s["status"]: (s["count"], s["amount"]) for s in f["by_status"]} == {
        "approved": (1, "1500.00"), "refunded": (1, "4100.00"), "requested": (1, "0.00")}

    # created / any payment attempt / payment captured (refunded-in-full still reached capture)
    assert [s["count"] for s in o["funnel"]] == [6, 5, 4]

    t = o["top"]
    assert t["packages"] == [{"name": "Goa Escape", "bookings": 2, "value": "11000.25"}]
    assert t["hotels"] == [{"name": "Sea View", "bookings": 1, "value": "900.00"}]
    assert t["flight_routes"] == [{"name": "Delhi → Goa", "bookings": 2, "value": "3500.50"}]

    assert o["reviews"] == {"approved": 2, "pending": 1, "average": "4.50"}


def test_window_narrows_with_months(env, viewer):
    _seed(env)
    o = env.client.get(URL, params={"months": 1}, headers=viewer).json()
    assert o["frame"] == [M0]
    assert o["bookings"]["created"] == 4 and o["bookings"]["cancelled"] == 0
    assert o["bookings"]["booked_value"] == "7400.50"
    assert o["payments"]["collected"] == "3400.50"
    assert o["refunds"]["refunded"] == "0.00" and o["refunds"]["requests"] == 2
    assert o["customers"]["new_in_period"] == 2 and o["customers"]["total"] == 4


def test_non_inr_bookings_are_flagged(env, viewer):
    cid = _customer(env, T0)
    _flight(env, cid, "pending", "100.00", T0)
    db = env.Session()
    row = db.query(CustomerBooking).one()
    row.currency = "USD"
    db.commit()
    db.close()
    assert env.client.get(URL, headers=viewer).json()["bookings"]["non_inr_bookings"] == 1


# ================================================================== access + validation
def test_access_rules(env, viewer):
    assert env.client.get(URL).status_code == 401
    for perms in ([], [P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW], [P.REPORT_VIEW], [P.B2C_REPORTS_EXPORT]):
        assert env.client.get(URL, headers=_user(env, UserRole.ADMIN, perms)).status_code == 403, perms
    assert env.client.get(URL, headers=viewer).status_code == 200
    assert env.client.get(URL, headers=_user(env, UserRole.SUPER_ADMIN)).status_code == 200


@pytest.mark.parametrize("months,code", [(0, 422), (25, 422), ("x", 422), (1, 200), (24, 200)])
def test_months_bounds(env, viewer, months, code):
    assert env.client.get(URL, params={"months": months}, headers=viewer).status_code == code


def test_month_frame_crosses_a_year():
    assert analytics.month_frame(3, dt.date(2026, 2, 10)) == ["2025-12", "2026-01", "2026-02"]
    assert analytics.month_frame(1, dt.date(2026, 1, 1)) == ["2026-01"]
    assert len(analytics.month_frame(24, dt.date(2026, 11, 18))) == 24


# ================================================================== payment reporting date
def _month_start(month: str) -> dt.datetime:
    y, m = map(int, month.split("-"))
    return dt.datetime(y, m, 1, tzinfo=IST)


def _consistent(p):
    """captured + refunded rows of by_status, and every provider row, sum to collected."""
    st = {s["status"]: D(s["amount"]) for s in p["by_status"]}
    assert st.get("captured", D(0)) + st.get("refunded", D(0)) == D(p["collected"])
    assert sum(D(x["amount"]) for x in p["by_provider"]) == D(p["collected"])
    assert sum(x["count"] for x in p["by_provider"]) == p["captured_count"]


def test_payment_started_last_month_and_captured_this_month_is_this_months_money(env, viewer):
    """Regression: collected was filtered on the payment ATTEMPT's created_at, so money that arrived this month
    from a checkout started late last month was missing from this month (and counted in last month's window)."""
    boundary = _month_start(M0)
    started = boundary - dt.timedelta(hours=1)        # last month, 23:00 IST
    arrived = boundary + dt.timedelta(hours=1)        # this month, 01:00 IST
    cid = _customer(env, started)
    bid = _id()
    env.add(
        CustomerBooking(customer_booking_id=bid, booking_ref=f"JPF{bid}", customer_id=cid, total_amount=D("5000.00"),
                        currency="INR", status="confirmed", created_at=started, origin_city="Delhi",
                        destination_city="Goa", flight_number="AI101", travel_date=dt.date.today()),
        CustomerBookingPayment(customer_booking_payment_id=_id(), customer_booking_id=bid, method="gateway",
                               amount=D("5000.00"), currency="INR", status="captured", provider="hdfc",
                               created_at=started, paid_at=arrived),
        # a failed attempt from the same moment has no arrival time: it stays in LAST month
        CustomerBookingPayment(customer_booking_payment_id=_id(), customer_booking_id=bid, method="gateway",
                               amount=D("5000.00"), currency="INR", status="failed", provider="hdfc",
                               created_at=started),
        # captured last month, refunded in full later: still last month's money (paid_at is never moved)
        CustomerBookingPayment(customer_booking_payment_id=_id(), customer_booking_id=bid, method="gateway",
                               amount=D("700.00"), currency="INR", status="refunded", provider="razorpay",
                               created_at=started - dt.timedelta(hours=2), paid_at=started),
    )

    this_month = env.client.get(URL, params={"months": 1}, headers=viewer).json()["payments"]
    assert this_month["collected"] == "5000.00" and this_month["captured_count"] == 1
    assert {s["status"]: (s["count"], s["amount"]) for s in this_month["by_status"]} == {"captured": (1, "5000.00")}
    assert this_month["by_provider"] == [{"provider": "hdfc", "count": 1, "amount": "5000.00"}]
    _consistent(this_month)

    two_months = env.client.get(URL, params={"months": 2}, headers=viewer).json()
    p2 = two_months["payments"]
    assert p2["collected"] == "5700.00" and p2["captured_count"] == 2
    assert {s["status"]: (s["count"], s["amount"]) for s in p2["by_status"]} == {
        "captured": (1, "5000.00"), "failed": (1, "5000.00"), "refunded": (1, "700.00")}
    _consistent(p2)
    # the booking itself was created last month: it belongs to last month's booking figures
    assert two_months["bookings"]["created"] == 1
    assert env.client.get(URL, params={"months": 1}, headers=viewer).json()["bookings"]["created"] == 0


def test_captured_payment_without_paid_at_falls_back_to_created_at(env, viewer):
    """Rows captured before migration 0062 added paid_at have it NULL; they are dated by created_at."""
    cid = _customer(env, T0)
    bid = _id()
    env.add(
        CustomerHotelBooking(customer_hotel_booking_id=bid, booking_ref=f"JPH{bid}", customer_id=cid, hotel_id=1,
                             hotel_name="Sea View", room_id=1, room_name="Deluxe", check_in_date=dt.date.today(),
                             check_out_date=dt.date.today() + dt.timedelta(days=1), nights=1,
                             total_amount=D("1200.00"), currency="INR", status="confirmed", created_at=T0),
        CustomerHotelBookingPayment(customer_hotel_booking_payment_id=_id(), hotel_booking_id=bid, method="gateway",
                                    amount=D("1200.00"), currency="INR", status="captured", provider=None,
                                    created_at=T0, paid_at=None),
        CustomerHotelBookingPayment(customer_hotel_booking_payment_id=_id(), hotel_booking_id=bid, method="gateway",
                                    amount=D("300.00"), currency="INR", status="captured", provider="hdfc",
                                    created_at=OLD, paid_at=None),     # old, NULL paid_at: outside the window
    )
    p = env.client.get(URL, headers=viewer).json()["payments"]
    assert p["collected"] == "1200.00" and p["captured_count"] == 1
    assert p["by_provider"] == [{"provider": "unknown", "count": 1, "amount": "1200.00"}]
    _consistent(p)


def test_seeded_payments_stay_internally_consistent(env, viewer):
    _seed(env)
    for months in (1, 6, 24):
        _consistent(env.client.get(URL, params={"months": months}, headers=viewer).json()["payments"])
