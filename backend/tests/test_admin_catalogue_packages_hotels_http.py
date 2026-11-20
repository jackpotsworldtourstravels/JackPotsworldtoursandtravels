"""HTTP-level verification of the B2C PACKAGE catalogue (create / edit / itinerary / departures) and the HOTEL + ROOM edit
persistence that Phase 10 could not test, plus the read-only FLIGHT catalogue status endpoint.

THE SQLITE ARRAY SHIM (test-only, scoped to these tests by ``monkeypatch``): these tables use PostgreSQL ``ARRAY`` columns
(highlights, amenities, perks, ...), which SQLite cannot bind. Here the ARRAY type is taught to store a JSON string. That proves
the APPLICATION logic (validation, rules, persistence of the values the app sends, audit); it does NOT prove PostgreSQL ARRAY
semantics — those stay NOT VERIFIED. Gaming is untouched: packages created here are always ``holiday`` and the category cannot
be changed by an admin edit.
"""
from __future__ import annotations

import datetime as dt
import decimal
import json
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base, CustomerAdminAuditLog, CustomerDestination, CustomerHotel, CustomerHotelRoom, CustomerLocation, CustomerPackage,
    CustomerPackageDeparture, CustomerPackageItineraryDay,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_catalogue, admin_catalogue_hotels, admin_catalogue_packages
from app.services import activity_service

D = decimal.Decimal
PK = "/api/admin/catalogue/packages"
HT = "/api/admin/catalogue/hotels"
_N = {"n": 800000}
FUTURE = (dt.date.today() + dt.timedelta(days=60)).isoformat()


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity = []
        app = FastAPI()
        for r in (admin_catalogue.router, admin_catalogue_packages.router, admin_catalogue_hotels.router):
            app.include_router(r)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=bool(os.environ.get("RAISE_SERVER")))

    def db(self):
        return self.Session()


@pytest.fixture()
def env(monkeypatch):
    def _bind(self, dialect):
        if dialect.name == "sqlite":
            return lambda v: None if v is None else json.dumps(list(v))
        return None

    def _result(self, dialect, coltype):
        if dialect.name == "sqlite":
            return lambda v: None if v is None else json.loads(v)
        return None

    monkeypatch.setattr(ARRAY, "bind_processor", _bind)
    monkeypatch.setattr(ARRAY, "result_processor", _result)
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[m.__table__ for m in (
        CustomerAdminAuditLog, CustomerDestination, CustomerLocation, CustomerHotel, CustomerHotelRoom, CustomerPackage,
        CustomerPackageItineraryDay, CustomerPackageDeparture)])
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
    e = Env(engine)
    monkeypatch.setattr(activity_service, "log_activity",
                        lambda db, user_id, action, ip=None, **kw: e.activity.append({"user_id": user_id, "action": action, **kw}))
    yield e
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


def _user(env, role, perms=None, name="Reviewer"):
    db = env.db()
    u = User(user_id=_id(), full_name=name, email=f"u{_N['n']}@tt-qa.com", password_hash="x", role=role,
             status=UserStatus.ACTIVE, permissions=perms or [])
    db.add(u)
    db.commit()
    out = {"headers": {"Authorization": f"Bearer {create_access_token(u.user_id)}"}, "id": u.user_id}
    db.close()
    return out


@pytest.fixture()
def admin(env):
    return _user(env, UserRole.ADMIN, [P.B2C_CATALOGUE_MANAGE, P.CATALOG_MANAGE], "Ada Admin")


def _pkg_body(**over):
    b = {"name": "Goa Getaway", "blurb": "Sun and sand", "trip_type": "domestic", "days": 4, "price_from": "15000.00",
         "highlights": ["Beach", "Fort"], "inclusions": ["Hotel"], "exclusions": ["Flights"]}
    b.update(over)
    return b


def _mkpkg(env, admin, **over):
    r = env.client.post(PK, json=_pkg_body(**over), headers=admin["headers"])
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _acts(env, action):
    return [a for a in env.activity if a["action"] == action]


def _audit(env, action):
    db = env.db()
    rows = [r for r in db.scalars(select(CustomerAdminAuditLog)).all() if r.action == action]
    db.close()
    return rows


# ================================================================== package create / edit
def test_create_package_starts_disabled_as_holiday_with_arrays_persisted_and_audited(env, admin):
    r = env.client.post(PK, json=_pkg_body(), headers=admin["headers"])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["is_active"] is False and body["category"] == "holiday" and body["highlights"] == ["Beach", "Fort"]
    db = env.db()
    row = db.get(CustomerPackage, body["id"])
    assert (row.name, row.days, row.nights, row.category, row.is_active) == ("Goa Getaway", 4, 3, "holiday", False)
    assert row.price_from == D("15000.00") and row.inclusions == ["Hotel"]
    db.close()
    assert len(_acts(env, "Package created")) == 1 and _acts(env, "Package created")[0]["user_id"] == admin["id"]
    assert len(_audit(env, "catalogue.create")) == 1


def test_a_package_cannot_be_made_a_gaming_package(env, admin):
    """Gaming trips are enquiry-based: the category is not part of the create or edit contract and cannot be set."""
    assert env.client.post(PK, json=_pkg_body(category="gaming"), headers=admin["headers"]).status_code == 422
    pid = _mkpkg(env, admin)
    assert env.client.patch(f"{PK}/{pid}", json={"category": "gaming"}, headers=admin["headers"]).status_code == 422
    db = env.db()
    assert db.get(CustomerPackage, pid).category == "holiday"
    db.close()


@pytest.mark.parametrize("over", [
    {"name": ""}, {"name": "x" * 151}, {"blurb": ""}, {"trip_type": "space"}, {"days": 0}, {"days": 61}, {"nights": 61},
    {"price_from": "0"}, {"price_from": "-1"}, {"price_from": "10.123"}, {"hotel_category": 2}, {"highlights": ["h"] * 11},
    {"inclusions": ["i"] * 31}, {"image_key": "k" * 61}, {"bogus": 1}])
def test_package_validation_stores_nothing(env, admin, over):
    assert env.client.post(PK, json=_pkg_body(**over), headers=admin["headers"]).status_code == 422
    db = env.db()
    assert db.scalars(select(CustomerPackage)).all() == []
    db.close()


def test_whitespace_only_package_name_is_rejected(env, admin):
    r = env.client.post(PK, json=_pkg_body(name="   "), headers=admin["headers"])
    assert r.status_code in (400, 422), r.text
    db = env.db()
    assert db.scalars(select(CustomerPackage)).all() == []
    db.close()


def test_edit_package_partial_visibility_itinerary_rule_and_404(env, admin):
    pid = _mkpkg(env, admin)
    r = env.client.patch(f"{PK}/{pid}", json={"price_from": "17500.00", "is_active": True}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    db = env.db()
    row = db.get(CustomerPackage, pid)
    assert row.price_from == D("17500.00") and row.is_active is True and row.name == "Goa Getaway"
    db.close()
    assert len(_acts(env, "Package updated")) == 1 and len(_audit(env, "catalogue.update")) == 1
    assert env.client.patch(f"{PK}/99999999", json={"name": "Zz"}, headers=admin["headers"]).status_code == 404
    for bad in ({"price_from": "0"}, {"days": 0}, {"name": ""}, {"slug": "x"}):
        assert env.client.patch(f"{PK}/{pid}", json=bad, headers=admin["headers"]).status_code == 422
    env.client.put(f"{PK}/{pid}/itinerary", json={"days": [{"day_number": 1, "title": "Arrive"}, {"day_number": 4, "title": "Leave"}]},
                   headers=admin["headers"])
    short = env.client.patch(f"{PK}/{pid}", json={"days": 2}, headers=admin["headers"])
    assert short.status_code == 409, "cannot shorten below the itinerary's last day"
    db = env.db()
    assert db.get(CustomerPackage, pid).days == 4
    db.close()


# ================================================================== itinerary
def test_itinerary_replace_updates_adds_removes_and_validates(env, admin):
    pid = _mkpkg(env, admin)
    put = lambda days: env.client.put(f"{PK}/{pid}/itinerary", json={"days": days}, headers=admin["headers"])
    assert put([{"day_number": 1, "title": "Arrive", "meals": ["dinner"]}, {"day_number": 2, "title": "Beach", "location": "Calangute"}]).status_code == 200
    assert put([{"day_number": 2, "title": "Beach day", "meals": ["breakfast", "lunch"]}, {"day_number": 3, "title": "Fort"}]).status_code == 200
    db = env.db()
    days = {d.day_number: d for d in db.scalars(select(CustomerPackageItineraryDay).where(CustomerPackageItineraryDay.package_id == pid)).all()}
    db.close()
    assert sorted(days) == [2, 3] and days[2].title == "Beach day" and days[2].meals == ["breakfast", "lunch"]
    assert len(_acts(env, "Package itinerary updated")) == 2
    assert put([]).status_code == 200, "an empty list clears the itinerary"
    for bad in ([{"day_number": 0, "title": "x"}], [{"day_number": 61, "title": "x"}], [{"day_number": 1, "title": ""}],
                [{"day_number": 1, "title": "a"}, {"day_number": 1, "title": "dup"}], [{"day_number": 1, "title": "a", "meals": ["brunch"]}],
                [{"day_number": 1, "title": "a", "bogus": 1}]):
        assert put(bad).status_code in (400, 409, 422), bad
    assert env.client.put(f"{PK}/99999999/itinerary", json={"days": []}, headers=admin["headers"]).status_code == 404


# ================================================================== departures
def test_departures_add_edit_disable_duplicates_and_past_dates(env, admin):
    pid = _mkpkg(env, admin)
    add = lambda **b: env.client.post(f"{PK}/{pid}/departures", json={"departure_date": FUTURE, "price_per_person": "16000.00", **b},
                                      headers=admin["headers"])
    r = add(seats_left=10)
    assert r.status_code == 201, r.text
    dep_id = r.json()["departures"][0]["id"]
    assert add().status_code == 409, "one departure per date"
    past = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    assert env.client.post(f"{PK}/{pid}/departures", json={"departure_date": past, "price_per_person": "1"}, headers=admin["headers"]).status_code in (400, 422)
    for bad in ({"price_per_person": "0"}, {"price_per_person": "-5"}, {"price_per_person": "1.234"}, {"seats_left": -1}, {"seats_left": 501}, {"departure_date": "nope"}):
        body = {"departure_date": (dt.date.today() + dt.timedelta(days=90)).isoformat(), "price_per_person": "100", **bad}
        assert env.client.post(f"{PK}/{pid}/departures", json=body, headers=admin["headers"]).status_code == 422, bad
    upd = env.client.patch(f"{PK}/{pid}/departures/{dep_id}", json={"price_per_person": "16500.00", "seats_left": 8, "is_active": False},
                           headers=admin["headers"])
    assert upd.status_code == 200, upd.text
    db = env.db()
    d = db.get(CustomerPackageDeparture, dep_id)
    assert (d.price_per_person, d.seats_left, d.is_active, d.departure_date.isoformat()) == (D("16500.00"), 8, False, FUTURE)
    assert len(db.scalars(select(CustomerPackageDeparture)).all()) == 1, "departures are disabled, never duplicated"
    db.close()
    assert env.client.patch(f"{PK}/{pid}/departures/{dep_id}", json={"departure_date": FUTURE}, headers=admin["headers"]).status_code == 422
    assert env.client.patch(f"{PK}/{pid}/departures/{dep_id}", json={"price_per_person": None}, headers=admin["headers"]).status_code in (400, 422)
    other = _mkpkg(env, admin, name="Kerala")
    assert env.client.patch(f"{PK}/{other}/departures/{dep_id}", json={"seats_left": 1}, headers=admin["headers"]).status_code == 404
    assert env.client.delete(f"{PK}/{pid}/departures/{dep_id}", headers=admin["headers"]).status_code in (404, 405)
    assert env.client.post(f"{PK}/99999999/departures", json={"departure_date": FUTURE, "price_per_person": "1"}, headers=admin["headers"]).status_code == 404
    assert len(_acts(env, "Package departure added")) == 1 and len(_audit(env, "catalogue.update")) >= 1


# ================================================================== hotels + rooms (edit persistence)
def _hotel(env, **over):
    db = env.db()
    h = CustomerHotel(customer_hotel_id=_id(), name=over.get("name", "Sea View"), star_rating=4, location="Calangute",
                      price_per_night=D("0"), amenities=["Wifi"], images=[], is_active=True)
    db.add(h)
    db.commit()
    hid = h.customer_hotel_id
    db.close()
    return hid


def test_hotel_and_room_edit_persist_and_audit(env, admin):
    hid = _hotel(env)
    r = env.client.patch(f"{HT}/{hid}", json={"name": "Sea View Resort", "star_rating": 5, "amenities": ["Wifi", "Pool"], "is_active": False},
                         headers=admin["headers"])
    assert r.status_code == 200, r.text
    db = env.db()
    h = db.get(CustomerHotel, hid)
    assert (h.name, h.star_rating, h.amenities, h.is_active) == ("Sea View Resort", 5, ["Wifi", "Pool"], False)
    db.close()
    room = env.client.post(f"{HT}/{hid}/rooms", json={"code": "DLX", "name": "Deluxe", "base_price_per_night": "4500.00", "perks": ["Breakfast"]},
                           headers=admin["headers"])
    assert room.status_code == 201, room.text
    assert env.client.post(f"{HT}/{hid}/rooms", json={"code": "DLX", "name": "Dup", "base_price_per_night": "1"},
                           headers=admin["headers"]).status_code == 409, "room code is unique per hotel"
    rid = room.json()["id"]
    up = env.client.patch(f"{HT}/{hid}/rooms/{rid}", json={"base_price_per_night": "4800.00", "is_active": False}, headers=admin["headers"])
    assert up.status_code == 200, up.text
    db = env.db()
    rm = db.get(CustomerHotelRoom, rid)
    assert rm.base_price_per_night == D("4800.00") and rm.is_active is False and rm.perks == ["Breakfast"]
    db.close()
    assert len(_acts(env, "Hotel updated")) == 1 and len(_acts(env, "Hotel room added")) == 1 and len(_acts(env, "Hotel room updated")) == 1
    assert env.client.patch(f"{HT}/{hid}/rooms/99999999", json={"name": "Zz"}, headers=admin["headers"]).status_code == 404


# ================================================================== flights (read-only status) + permissions
def test_flight_catalogue_is_a_read_only_status_endpoint(env, admin):
    r = env.client.get("/api/admin/catalogue/flights/supplier", headers=admin["headers"])
    assert r.status_code == 200, r.text
    def keys(o):
        if isinstance(o, dict):
            for k, v in o.items():
                yield str(k).lower()
                yield from keys(v)
        elif isinstance(o, list):
            for v in o:
                yield from keys(v)
    for k in keys(r.json()):
        assert not any(w in k for w in ("secret", "token", "password", "api_key", "apikey")), f"credential-like field: {k}"
    for m in ("post", "put", "patch", "delete"):
        assert getattr(env.client, m)("/api/admin/catalogue/flights/supplier", headers=admin["headers"]).status_code in (404, 405)


def test_package_and_hotel_permissions(env, admin):
    pid = _mkpkg(env, admin)
    calls = [("get", PK, None), ("post", PK, _pkg_body()), ("patch", f"{PK}/{pid}", {"name": "Zz"}),
             ("put", f"{PK}/{pid}/itinerary", {"days": []}), ("post", f"{PK}/{pid}/departures", {"departure_date": FUTURE, "price_per_person": "1"}),
             ("get", HT, None), ("get", "/api/admin/catalogue/flights/supplier", None)]
    for m, u, b in calls:
        kw = {"json": b} if b is not None else {}
        assert getattr(env.client, m)(u, **kw).status_code in (401, 403), u
    for who in (_user(env, UserRole.ADMIN, [], "Bare"), _user(env, UserRole.MANAGER, [], "Mo"), _user(env, UserRole.MERCHANT_ADMIN, [], "Mer")):
        for m, u, b in calls:
            kw = {"json": b} if b is not None else {}
            assert getattr(env.client, m)(u, headers=who["headers"], **kw).status_code == 403, (who, u)
    db = env.db()
    assert [p.name for p in db.scalars(select(CustomerPackage)).all()] == ["Goa Getaway"]
    db.close()
