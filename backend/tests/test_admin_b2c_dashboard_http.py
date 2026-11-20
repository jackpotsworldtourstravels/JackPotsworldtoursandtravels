"""HTTP-level regression tests for the B2C Admin Portal dashboard,
``GET /api/admin/b2c-dashboard/summary``.

Real router, service and RBAC dependency on a throw-away temp-file SQLite
database. The dashboard service deliberately uses only COUNT / SUM (no
PostgreSQL-only date functions), so — unlike the analytics overview — every
figure here is genuinely exercised on SQLite, not skipped.

Pinned:
  * the response shape (schema keys) and zero state on an empty database;
  * every figure against a hand-seeded data set with a known answer;
  * booked value excludes cancelled bookings; collected counts only CAPTURED;
  * the support queue counts only waiting/active conversations;
  * access: 401 without a token, 403 without ``b2c.reports.view`` (including a
    role=admin with B2C customer scopes), 200 for an explicit grant and for a
    super admin;
  * the endpoint is read-only (row counts unchanged) and carries no PII;
  * the router is registered in the real application.
"""
from __future__ import annotations

import datetime as dt
import decimal
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base, Customer, CustomerBooking, CustomerBookingPayment, CustomerConversation, CustomerHotelBooking,
    CustomerHotelBookingPayment, CustomerPackageBooking, CustomerPackageBookingPayment, CustomerReview,
    CustomerStatus,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_b2c_dashboard

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)
URL = "/api/admin/b2c-dashboard/summary"
_N = {"n": 910000}
_TABLES = (Customer, CustomerBooking, CustomerBookingPayment, CustomerHotelBooking, CustomerHotelBookingPayment,
           CustomerPackageBooking, CustomerPackageBookingPayment, CustomerReview, CustomerConversation)


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        app = FastAPI()
        app.include_router(admin_b2c_dashboard.router)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=bool(os.environ.get("RAISE_SERVER")))

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
    u = User(user_id=_id(), full_name="Dash Reviewer", email=f"u{_N['n']}@tt-qa.com", password_hash="x", role=role,
             status=UserStatus.ACTIVE, permissions=perms or [])
    env.add(u)
    return {"Authorization": f"Bearer {create_access_token(u.user_id)}"}


@pytest.fixture()
def viewer(env):
    return _user(env, UserRole.ADMIN, [P.B2C_REPORTS_VIEW])


def _customer(env, *, guest=False, blocked=False, age_days=0):
    cid = _id()
    env.add(Customer(customer_id=cid, customer_code=f"C{cid}", full_name=f"Cust {cid}", email=f"c{cid}@tt-qa.com",
                     mobile="9000000000", is_guest=guest,
                     status=CustomerStatus.BLOCKED if blocked else CustomerStatus.ACTIVE,
                     created_at=NOW - dt.timedelta(days=age_days)))
    return cid


def _flight(env, cid, status, total, pay=None):
    bid = _id()
    rows = [CustomerBooking(customer_booking_id=bid, booking_ref=f"JPF{bid}", customer_id=cid, total_amount=D(total),
                            currency="INR", status=status, created_at=NOW, origin_city="Delhi",
                            destination_city="Goa", flight_number="AI101",
                            travel_date=dt.date.today() + dt.timedelta(days=10))]
    if pay:
        rows.append(CustomerBookingPayment(customer_booking_payment_id=_id(), customer_booking_id=bid, method="gateway",
                                           amount=D(total), currency="INR", status=pay, provider="hdfc", created_at=NOW))
    env.add(*rows)


def _hotel(env, cid, status, total, pay=None):
    bid = _id()
    rows = [CustomerHotelBooking(customer_hotel_booking_id=bid, booking_ref=f"JPH{bid}", customer_id=cid, hotel_id=1,
                                 hotel_name="Sea View", room_id=1, room_name="Deluxe",
                                 check_in_date=dt.date.today() + dt.timedelta(days=5),
                                 check_out_date=dt.date.today() + dt.timedelta(days=6), nights=1,
                                 total_amount=D(total), currency="INR", status=status, created_at=NOW)]
    if pay:
        rows.append(CustomerHotelBookingPayment(customer_hotel_booking_payment_id=_id(), hotel_booking_id=bid,
                                                method="gateway", amount=D(total), currency="INR", status=pay,
                                                provider="hdfc", created_at=NOW))
    env.add(*rows)


def _package(env, cid, status, total, pay=None):
    bid = _id()
    rows = [CustomerPackageBooking(customer_package_booking_id=bid, booking_ref=f"JPP{bid}", customer_id=cid,
                                   package_id=1, package_name="Goa Escape", package_days=4, departure_id=1,
                                   departure_date=dt.date.today() + dt.timedelta(days=20), pax_count=2,
                                   total_amount=D(total), currency="INR", status=status, created_at=NOW)]
    if pay:
        rows.append(CustomerPackageBookingPayment(customer_package_booking_payment_id=_id(),
                                                  package_booking_id=bid, method="gateway", amount=D(total),
                                                  currency="INR", status=pay, provider="hdfc", created_at=NOW))
    env.add(*rows)


def _review(env, cid, status, item_id):
    env.add(CustomerReview(customer_review_id=_id(), customer_id=cid, item_type="hotel", item_id=item_id, rating=4,
                           status=status, created_at=NOW, updated_at=NOW))


def _conversation(env, cid, status, *, assigned=None, unread=0):
    env.add(CustomerConversation(conversation_id=_id(), customer_id=cid, status=status, assigned_admin_id=assigned,
                                 admin_unread_count=unread, customer_unread_count=0, created_at=NOW))


# ================================================================== shape / zero state
def test_empty_database_returns_complete_zero_snapshot(env, viewer):
    r = env.client.get(URL, headers=viewer)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"generated_at", "customers", "bookings", "reviews", "support"}
    assert body["customers"] == {"total": 0, "blocked": 0, "guests": 0, "registered": 0, "new_30d": 0}
    assert body["bookings"] == {
        "total": 0, "by_status": {"pending": 0, "confirmed": 0, "cancelled": 0, "completed": 0},
        "booked_value": "0.00", "collected": "0.00",
    }
    assert body["reviews"] == {"pending": 0, "approved": 0}
    assert body["support"] == {"open_conversations": 0, "waiting_unassigned": 0, "admin_unread": 0}
    # generated_at is an ISO timestamp on the IST clock
    stamp = dt.datetime.fromisoformat(body["generated_at"])
    assert stamp.utcoffset() == dt.timedelta(hours=5, minutes=30)


# ================================================================== figures
def test_figures_match_a_hand_seeded_data_set(env, viewer):
    # customers: 2 registered new, 1 registered blocked + old (60d), 1 guest new
    c1 = _customer(env)
    c2 = _customer(env)
    c3 = _customer(env, blocked=True, age_days=60)
    g1 = _customer(env, guest=True)

    # bookings — flights
    _flight(env, c1, "pending", "1000.00")                       # unpaid
    _flight(env, c1, "confirmed", "2500.50", pay="captured")     # collected
    _flight(env, c2, "cancelled", "4000.00", pay="refunded")     # excluded from both
    _flight(env, c2, "completed", "1200.00", pay="captured")     # collected
    _flight(env, g1, "pending", "300.00", pay="failed")          # failed payment not collected
    # hotels
    _hotel(env, c1, "confirmed", "900.00", pay="captured")
    _hotel(env, c3, "cancelled", "700.00")
    # packages
    _package(env, c2, "confirmed", "15000.00", pay="authorized")  # authorised ≠ collected
    _package(env, g1, "completed", "8000.25", pay="captured")

    # reviews: 2 pending, 1 approved, 1 rejected (rejected is in neither figure)
    _review(env, c1, "pending", 1)
    _review(env, c2, "pending", 2)
    _review(env, c3, "approved", 3)
    _review(env, g1, "rejected", 4)

    # conversations
    _conversation(env, c1, "waiting", unread=3)                  # open, unassigned
    _conversation(env, c2, "waiting", assigned=42, unread=1)     # open, assigned
    _conversation(env, c3, "active", assigned=42, unread=2)      # open
    _conversation(env, g1, "resolved", unread=9)                 # NOT open; unread excluded

    r = env.client.get(URL, headers=viewer)
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["customers"] == {"total": 4, "blocked": 1, "guests": 1, "registered": 3, "new_30d": 3}

    b = body["bookings"]
    assert b["total"] == 9
    assert b["by_status"] == {"pending": 2, "confirmed": 3, "cancelled": 2, "completed": 2}
    # not cancelled: 1000 + 2500.50 + 1200 + 300 + 900 + 15000 + 8000.25
    assert b["booked_value"] == "28900.75"
    # captured, plus the payment refunded in full (it was collected): 2500.50 + 4000 + 1200 + 900 + 8000.25
    assert b["collected"] == "16600.75"

    assert body["reviews"] == {"pending": 2, "approved": 1}
    assert body["support"] == {"open_conversations": 3, "waiting_unassigned": 1, "admin_unread": 6}


def test_collected_keeps_a_payment_that_was_later_refunded_in_full(env, viewer):
    """Regression: customer_refund_service moves a fully refunded payment from
    ``captured`` to ``refunded``. That money was still collected; counting only
    ``captured`` made "collected" shrink whenever a refund was paid."""
    c1 = _customer(env)
    _flight(env, c1, "cancelled", "4000.00", pay="refunded")
    _hotel(env, c1, "confirmed", "900.00", pay="captured")
    _package(env, c1, "pending", "500.00", pay="failed")
    body = env.client.get(URL, headers=viewer).json()
    assert body["bookings"]["collected"] == "4900.00"
    assert body["bookings"]["booked_value"] == "1400.00"


def test_endpoint_is_read_only_and_carries_no_pii(env, viewer):
    c1 = _customer(env)
    _flight(env, c1, "pending", "100.00", pay="captured")
    _conversation(env, c1, "waiting", unread=1)

    def counts():
        db = env.Session()
        try:
            return {m.__tablename__: db.scalar(select(func.count()).select_from(m)) for m in _TABLES}
        finally:
            db.close()

    before = counts()
    r = env.client.get(URL, headers=viewer)
    assert r.status_code == 200, r.text
    assert counts() == before
    text = r.text
    for pii in (f"c{c1}@tt-qa.com", f"Cust {c1}", "9000000000", f"C{c1}"):
        assert pii not in text


# ================================================================== access
def test_requires_authentication(env):
    assert env.client.get(URL).status_code == 401


@pytest.mark.parametrize("perms", [
    [],
    [P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW, P.B2C_CUSTOMERS_MANAGE],  # B2C customer desk, but no reports grant
    [P.B2C_REPORTS_EXPORT],                                          # export alone is not view
])
def test_admin_without_reports_view_is_forbidden(env, perms):
    headers = _user(env, UserRole.ADMIN, perms)
    r = env.client.get(URL, headers=headers)
    assert r.status_code == 403, r.text


def test_explicit_grant_and_super_admin_are_allowed(env, viewer):
    assert env.client.get(URL, headers=viewer).status_code == 200
    assert env.client.get(URL, headers=_user(env, UserRole.SUPER_ADMIN)).status_code == 200


def test_only_get_is_exposed(env, viewer):
    for method in ("post", "put", "patch", "delete"):
        assert getattr(env.client, method)(URL, headers=viewer).status_code == 405


# ================================================================== registration
def test_router_is_registered_in_the_real_application():
    from app.main import app

    ops = app.openapi()["paths"].get(URL)
    assert ops is not None, "b2c-dashboard router is not included in app.main"
    assert set(ops) == {"get"}
