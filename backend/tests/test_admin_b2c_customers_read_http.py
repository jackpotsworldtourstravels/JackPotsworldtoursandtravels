"""HTTP tests for the B2C Customers READ endpoints — ``GET /api/admin/customers``
and ``GET /api/admin/customers/{id}``.

The account ACTIONS (block/unblock/password-reset) are covered exhaustively by
test_b2c_customer_admin_actions.py; this module pins the LIST and DETAIL reads
that the Customer Management screen is built on and that had no HTTP coverage:
search across the four fields, the three sidebar filters, the database `status`
filter, pagination, the per-row booking counts, the detail aggregation, and the
read permission gate (``b2c.customers.view`` OR the legacy ``customer.view``).

Real router, service and RBAC on a throw-away temp-file SQLite database.
"""
from __future__ import annotations

import datetime as dt
import decimal
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base, Customer, CustomerAdminAuditLog, CustomerBooking, CustomerBookingPayment, CustomerHotelBooking,
    CustomerHotelBookingPayment, CustomerPackageBooking, CustomerPackageBookingPayment, CustomerReview,
    CustomerStatus,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import customer_admin
from app.services import activity_service

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)
URL = "/api/admin/customers"
_N = {"n": 940000}
_TABLES = (Customer, CustomerAdminAuditLog, CustomerBooking, CustomerBookingPayment, CustomerHotelBooking,
           CustomerHotelBookingPayment, CustomerPackageBooking, CustomerPackageBookingPayment, CustomerReview)


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        app = FastAPI()
        app.include_router(customer_admin.router)

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


@pytest.fixture(autouse=True)
def _stub_activity_log(monkeypatch):
    # The detail read records a sensitive-access activity row (B2B ActivityLog
    # table, not part of this B2C harness) — stub it; the audit row it also
    # writes lands in CustomerAdminAuditLog, which IS created below.
    monkeypatch.setattr(activity_service, "log_activity", lambda *a, **k: None)


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
    u = User(user_id=_id(), full_name="Customer Reviewer", email=f"u{_N['n']}@tt-qa.com", password_hash="x",
             role=role, status=UserStatus.ACTIVE, permissions=perms or [])
    env.add(u)
    return {"Authorization": f"Bearer {create_access_token(u.user_id)}"}


@pytest.fixture()
def viewer(env):
    return _user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW])


def _customer(env, *, name, email, mobile="9000000000", status=CustomerStatus.ACTIVE, guest=False, age_days=0,
              code=None):
    cid = _id()
    env.add(Customer(customer_id=cid, customer_code=code or f"CUST{cid}", full_name=name, email=email, mobile=mobile,
                     status=status, is_guest=guest, created_at=NOW - dt.timedelta(days=age_days)))
    return cid


def _flight(env, cid):
    bid = _id()
    env.add(CustomerBooking(customer_booking_id=bid, booking_ref=f"JPF{bid}", customer_id=cid, total_amount=D("1500.00"),
                            currency="INR", status="confirmed", created_at=NOW, origin_city="Delhi",
                            destination_city="Goa", flight_number="AI101", travel_date=dt.date.today(),
                            origin_code="DEL", destination_code="GOI"))
    return bid


# ================================================================== list / filters / search
def test_list_is_newest_first_with_counts_and_paging(env, viewer):
    a = _customer(env, name="Aisha Khan", email="aisha@example.test", age_days=3)
    _customer(env, name="Bala Rao", email="bala@example.test", age_days=2)
    _customer(env, name="Chan Lee", email="chan@example.test", age_days=1)
    _flight(env, a)
    _flight(env, a)

    r = env.client.get(URL, headers=viewer)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3 and body["page"] == 1 and body["total_pages"] == 1
    # newest first (Chan created most recently)
    assert [i["full_name"] for i in body["items"]] == ["Chan Lee", "Bala Rao", "Aisha Khan"]
    assert {i["full_name"]: i["total_bookings"] for i in body["items"]}["Aisha Khan"] == 2

    p1 = env.client.get(URL, params={"page": 1, "page_size": 2}, headers=viewer).json()
    p2 = env.client.get(URL, params={"page": 2, "page_size": 2}, headers=viewer).json()
    assert len(p1["items"]) == 2 and len(p2["items"]) == 1
    assert p1["total"] == 3 and p1["total_pages"] == 2 and p2["page"] == 2
    # no row appears on both pages
    assert not ({i["customer_id"] for i in p1["items"]} & {i["customer_id"] for i in p2["items"]})


@pytest.mark.parametrize("term,expected", [
    ("aisha", {"Aisha Khan"}),          # name
    ("BALA@", {"Bala Rao"}),            # email, case-insensitive
    ("98765", {"Chan Lee"}),            # mobile
    ("CUSTVIP", {"Aisha Khan"}),        # customer_code
    ("a", {"Aisha Khan", "Bala Rao", "Chan Lee"}),  # substring hits all
    ("nobody", set()),                  # no match -> empty
])
def test_search_matches_name_email_mobile_and_code(env, viewer, term, expected):
    _customer(env, name="Aisha Khan", email="aisha@example.test", code="CUSTVIP1")
    _customer(env, name="Bala Rao", email="bala@example.test")
    _customer(env, name="Chan Lee", email="chan@example.test", mobile="9876500000")
    body = env.client.get(URL, params={"search": term}, headers=viewer).json()
    assert {i["full_name"] for i in body["items"]} == expected
    assert body["total"] == len(expected)


def test_sidebar_filters_active_blocked_new(env, viewer):
    _customer(env, name="Active One", email="a1@example.test", status=CustomerStatus.ACTIVE, age_days=1)
    _customer(env, name="Blocked One", email="b1@example.test", status=CustomerStatus.BLOCKED, age_days=1)
    _customer(env, name="Old One", email="o1@example.test", status=CustomerStatus.ACTIVE, age_days=90)

    active = env.client.get(URL, params={"filter": "active"}, headers=viewer).json()
    assert {i["full_name"] for i in active["items"]} == {"Active One", "Old One"}
    blocked = env.client.get(URL, params={"filter": "blocked"}, headers=viewer).json()
    assert {i["full_name"] for i in blocked["items"]} == {"Blocked One"}
    new = env.client.get(URL, params={"filter": "new"}, headers=viewer).json()
    assert {i["full_name"] for i in new["items"]} == {"Active One", "Blocked One"}  # within 30 days, any status


def test_unknown_filter_is_400(env, viewer):
    assert env.client.get(URL, params={"filter": "vip"}, headers=viewer).status_code == 400


def test_status_filter_uses_database_vocabulary(env, viewer):
    _customer(env, name="Act", email="act@example.test", status=CustomerStatus.ACTIVE)
    _customer(env, name="Blk", email="blk@example.test", status=CustomerStatus.BLOCKED)
    body = env.client.get(URL, params={"status": "blocked"}, headers=viewer).json()
    assert {i["full_name"] for i in body["items"]} == {"Blk"}


def test_page_size_cap_is_422(env, viewer):
    assert env.client.get(URL, params={"page_size": 201}, headers=viewer).status_code == 422
    assert env.client.get(URL, params={"page": 0}, headers=viewer).status_code == 422


def test_empty_database_is_a_valid_empty_page(env, viewer):
    body = env.client.get(URL, headers=viewer).json()
    assert body == {"items": [], "total": 0, "page": 1, "page_size": 25, "total_pages": 1}


# ================================================================== detail
def test_detail_aggregates_profile_bookings_and_total_spend(env, viewer):
    cid = _customer(env, name="Deepa Nair", email="deepa@example.test")
    _flight(env, cid)
    hb = _id()
    env.add(CustomerHotelBooking(customer_hotel_booking_id=hb, booking_ref=f"JPH{hb}", customer_id=cid, hotel_id=1,
                                 hotel_name="Sea View", room_id=1, room_name="Deluxe",
                                 check_in_date=dt.date.today(), check_out_date=dt.date.today() + dt.timedelta(days=1),
                                 nights=1, total_amount=D("2000.00"), currency="INR", status="confirmed", created_at=NOW))
    env.add(CustomerReview(customer_review_id=_id(), customer_id=cid, item_type="hotel", item_id=1, rating=5,
                           comment="Great", status="approved", created_at=NOW, updated_at=NOW))

    r = env.client.get(f"{URL}/{cid}", headers=viewer)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["customer_id"] == cid and d["full_name"] == "Deepa Nair"
    assert d["total_bookings"] == 2 and d["total_spend"] == "3500.00"
    assert {b["product"] for b in d["bookings"]} == {"flight", "hotel"}
    assert len(d["reviews"]) == 1 and d["reviews"][0]["rating"] == 5
    # no sensitive fields leak into the detail response
    for forbidden in ("password", "password_hash", "token", "otp"):
        assert forbidden not in r.text.lower()


def test_detail_404_for_unknown_customer(env, viewer):
    assert env.client.get(f"{URL}/99999999", headers=viewer).status_code == 404


# ================================================================== access
def test_read_requires_a_view_scope(env):
    assert env.client.get(URL).status_code == 401
    # neither B2C view nor legacy customer.view -> 403
    assert env.client.get(URL, headers=_user(env, UserRole.ADMIN, [P.B2C_REPORTS_VIEW])).status_code == 403
    # legacy customer.view alone still reads (documented fallback)
    assert env.client.get(URL, headers=_user(env, UserRole.ADMIN, [P.CUSTOMER_VIEW])).status_code == 200
    # B2C view
    assert env.client.get(URL, headers=_user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW])).status_code == 200
    # super admin
    assert env.client.get(URL, headers=_user(env, UserRole.SUPER_ADMIN)).status_code == 200
