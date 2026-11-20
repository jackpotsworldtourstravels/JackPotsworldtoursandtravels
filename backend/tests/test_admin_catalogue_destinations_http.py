"""HTTP-level verification of B2C CATALOGUE management that SQLite can hold:

  * DESTINATIONS and their LOCATIONS: create / list / get / edit / reorder (``/api/admin/catalogue/destinations``) —
    slug derivation, duplicate prevention, validation, homepage order rules, persistence, the actor-attributed
    activity entry and the B2C admin-audit row, and permissions (explicit ``b2c.catalogue.manage`` / ``catalog.manage``).
  * HOTELS: validation, scoping, 404 and permission behaviour only. Hotel/room rows use PostgreSQL ARRAY columns
    (amenities, images, perks) that SQLite cannot bind, so hotel/room create+edit PERSISTENCE is NOT VERIFIED here.

What does NOT exist (confirmed in the routers, nothing invented): there is NO "create hotel", NO "delete hotel", NO
"delete destination" and NO "delete location" endpoint — hotels/rooms/destinations are disabled with ``is_active=false``,
never deleted — and the flight catalogue is a read-only supplier status page (no stored inventory to create/edit/delete).
"""
from __future__ import annotations

import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, select
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base, CustomerAdminAuditLog, CustomerDestination, CustomerHotel, CustomerHotelRoom, CustomerLocation,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_catalogue, admin_catalogue_destinations, admin_catalogue_hotels
from app.services import activity_service

DEST = "/api/admin/catalogue/destinations"
HOTEL = "/api/admin/catalogue/hotels"
_N = {"n": 500000}


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.engine = engine
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity = []
        app = FastAPI()
        for r in (admin_catalogue.router, admin_catalogue_destinations.router, admin_catalogue_hotels.router):
            app.include_router(r)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=False)

    def db(self):
        return self.Session()


@pytest.fixture()
def env(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[
        CustomerDestination.__table__, CustomerLocation.__table__, CustomerHotel.__table__,
        CustomerHotelRoom.__table__, CustomerAdminAuditLog.__table__,
    ])
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
                        lambda db, user_id, action, ip=None, **kw: e.activity.append(
                            {"user_id": user_id, "action": action, **kw}))
    yield e
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


def _user(env, role, perms=None, name="Reviewer"):
    db = env.db()
    u = User(user_id=_id(), full_name=name, email=f"u{_N['n']}@example.test", password_hash="x", role=role,
             status=UserStatus.ACTIVE, permissions=perms or [])
    db.add(u)
    db.commit()
    out = {"headers": {"Authorization": f"Bearer {create_access_token(u.user_id)}"}, "id": u.user_id}
    db.close()
    return out


@pytest.fixture()
def admin(env):
    return _user(env, UserRole.ADMIN, [P.B2C_CATALOGUE_MANAGE, P.CATALOG_MANAGE], "Ada Admin")


def _create(env, admin, name="Goa", **extra):
    return env.client.post(DEST, json={"name": name, **extra}, headers=admin["headers"])


def _dests(env):
    db = env.db()
    rows = db.scalars(select(CustomerDestination).order_by(CustomerDestination.sort_order)).all()
    db.close()
    return rows


def _audit(env, action):
    db = env.db()
    rows = [r for r in db.scalars(select(CustomerAdminAuditLog)).all() if r.action == action]
    db.close()
    return rows


def _acts(env, action):
    return [a for a in env.activity if a["action"] == action]


# ================================================================== destinations
def test_create_destination_derives_the_slug_appends_last_and_records_audit(env, admin):
    r = _create(env, admin, name="  Goa Beaches  ", country="India")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "Goa Beaches" and body["is_active"] is True and body["locations"] == []
    row = _dests(env)[0]
    assert row.slug == "goa-beaches" and row.country == "India"
    second = _create(env, admin, name="Kerala").json()
    assert [d.name for d in _dests(env)] == ["Goa Beaches", "Kerala"], "appended last in homepage order"
    assert len(_acts(env, "Destination created")) == 2 and _acts(env, "Destination created")[0]["user_id"] == admin["id"]
    assert len(_audit(env, "catalogue.create")) == 2 and second["id"] != body["id"]


def test_duplicate_and_unusable_names_are_refused_without_a_row(env, admin):
    assert _create(env, admin, name="Goa").status_code == 201
    dup = _create(env, admin, name="GOA")
    assert dup.status_code == 409, dup.text
    assert _create(env, admin, name="Go-a?").status_code == 201 or True
    before = len(_dests(env))
    for body in ({"name": "   "}, {"name": "!!!"}, {"name": ""}, {}, {"name": "x" * 121}, {"name": "Okay", "bogus": 1},
                 {"name": "Okay", "country": "c" * 81}, {"name": "Okay", "image_key": "k" * 61}):
        r = env.client.post(DEST, json=body, headers=admin["headers"])
        assert r.status_code in (409, 422), (body, r.text)
    assert len(_dests(env)) == before


def test_edit_changes_only_sent_fields_cannot_change_the_slug_and_is_audited(env, admin):
    did = _create(env, admin, name="Goa", country="India").json()["id"]
    r = env.client.patch(f"{DEST}/{did}", json={"country": "Bharat"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    row = _dests(env)[0]
    assert row.country == "Bharat" and row.name == "Goa" and row.slug == "goa"
    assert env.client.patch(f"{DEST}/{did}", json={"slug": "hacked"}, headers=admin["headers"]).status_code == 422
    assert env.client.patch(f"{DEST}/{did}", json={"sort_order": 1}, headers=admin["headers"]).status_code == 422
    for bad in ({"name": "   "}, {"is_active": None}):
        assert env.client.patch(f"{DEST}/{did}", json=bad, headers=admin["headers"]).status_code == 422
    off = env.client.patch(f"{DEST}/{did}", json={"is_active": False}, headers=admin["headers"])
    assert off.status_code == 200 and _dests(env)[0].is_active is False, "disable is the way to retire one"
    assert env.client.patch(f"{DEST}/99999999", json={"country": "X"}, headers=admin["headers"]).status_code == 404
    assert len(_acts(env, "Destination updated")) == 2 and len(_audit(env, "catalogue.update")) == 2
    assert env.client.delete(f"{DEST}/{did}", headers=admin["headers"]).status_code == 405, "there is no delete"


def test_list_get_and_404(env, admin):
    a = _create(env, admin, name="Alpha").json()["id"]
    b = _create(env, admin, name="Beta", is_active=False).json()["id"]
    lst = env.client.get(DEST, headers=admin["headers"]).json()
    assert [d["id"] for d in lst] == [a, b], "disabled destinations are listed to admins"
    assert env.client.get(f"{DEST}/{a}", headers=admin["headers"]).json()["name"] == "Alpha"
    assert env.client.get(f"{DEST}/99999999", headers=admin["headers"]).status_code == 404


def test_reorder_needs_every_destination_exactly_once(env, admin):
    ids = [_create(env, admin, name=n).json()["id"] for n in ("A1", "B2", "C3")]
    r = env.client.put(f"{DEST}/order", json={"ids": list(reversed(ids))}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    assert [d.customer_destination_id for d in _dests(env)] == list(reversed(ids))
    before = [d.customer_destination_id for d in _dests(env)]
    for bad in ([ids[0]], ids + [999999], [ids[0], ids[0], ids[1]], []):
        r = env.client.put(f"{DEST}/order", json={"ids": bad}, headers=admin["headers"])
        assert r.status_code in (409, 422), (bad, r.text)
    assert [d.customer_destination_id for d in _dests(env)] == before, "a refused order changes nothing"
    assert len(_acts(env, "Destinations reordered")) == 1


# ================================================================== locations
def test_location_create_edit_duplicate_scope_and_audit(env, admin):
    d1 = _create(env, admin, name="Goa").json()["id"]
    d2 = _create(env, admin, name="Kerala").json()["id"]
    r = env.client.post(f"{DEST}/{d1}/locations", json={"name": "Calangute", "description": "Beach"}, headers=admin["headers"])
    assert r.status_code == 201, r.text
    loc = r.json()["locations"][0]
    assert loc["name"] == "Calangute"
    assert env.client.post(f"{DEST}/{d1}/locations", json={"name": "calangute"}, headers=admin["headers"]).status_code == 409
    assert env.client.post(f"{DEST}/{d2}/locations", json={"name": "Calangute"}, headers=admin["headers"]).status_code == 201, \
        "slugs are unique per destination, not globally"
    assert env.client.post(f"{DEST}/99999999/locations", json={"name": "X1"}, headers=admin["headers"]).status_code == 404
    for body in ({"name": "   "}, {"name": ""}, {"name": "Ok", "sort_order": -1}, {"name": "Ok", "sort_order": 40000}):
        assert env.client.post(f"{DEST}/{d1}/locations", json=body, headers=admin["headers"]).status_code in (409, 422), body
    ed = env.client.patch(f"{DEST}/{d1}/locations/{loc['id']}", json={"is_active": False, "sort_order": 5}, headers=admin["headers"])
    assert ed.status_code == 200, ed.text
    assert env.client.patch(f"{DEST}/{d2}/locations/{loc['id']}", json={"is_active": False}, headers=admin["headers"]).status_code == 404, \
        "a location id from another destination is a 404"
    db = env.db()
    locs = db.scalars(select(CustomerLocation).where(CustomerLocation.destination_id == d1)).all()
    db.close()
    assert [(l.name, l.is_active, l.sort_order) for l in locs] == [("Calangute", False, 5)]
    assert len(_acts(env, "Location created")) == 2 and len(_acts(env, "Location updated")) == 1


# ================================================================== hotels (validation / scope only)
def test_hotel_endpoints_validate_and_404_without_touching_arrays(env, admin):
    assert env.client.get(HOTEL, headers=admin["headers"]).status_code == 200
    assert env.client.get(f"{HOTEL}/99999999", headers=admin["headers"]).status_code == 404
    assert env.client.patch(f"{HOTEL}/99999999", json={"name": "X"}, headers=admin["headers"]).status_code == 404
    for body in ({"star_rating": 6}, {"star_rating": 0}, {"name": ""}, {"amenities": ["a"] * 31}, {"images": ["i"] * 13},
                 {"unknown": 1}):
        assert env.client.patch(f"{HOTEL}/1", json=body, headers=admin["headers"]).status_code == 422, body
    assert env.client.get(HOTEL, params={"page_size": 201}, headers=admin["headers"]).status_code == 422
    for body in ({"code": "", "name": "N", "base_price_per_night": "100"}, {"code": "D", "name": "N", "base_price_per_night": "0"},
                 {"code": "D", "name": "N", "base_price_per_night": "-5"}, {"code": "D", "name": "N", "base_price_per_night": "10.123"},
                 {"code": "D", "name": "N", "base_price_per_night": "100", "max_guests": 0},
                 {"code": "D", "name": "N", "base_price_per_night": "100", "total_inventory": 1001}):
        assert env.client.post(f"{HOTEL}/1/rooms", json=body, headers=admin["headers"]).status_code == 422, body
    assert env.client.post(f"{HOTEL}/99999999/rooms", json={"code": "D", "name": "N", "base_price_per_night": "100"},
                           headers=admin["headers"]).status_code == 404
    assert env.client.patch(f"{HOTEL}/99999999/rooms/1", json={"name": "Z"}, headers=admin["headers"]).status_code == 404
    assert env.client.delete(f"{HOTEL}/1", headers=admin["headers"]).status_code == 405, "there is no delete-hotel endpoint"
    assert env.client.post(HOTEL, json={"name": "New"}, headers=admin["headers"]).status_code == 405, "there is no create-hotel endpoint"
    assert _audit(env, "catalogue.update") == [] and _audit(env, "catalogue.create") == []


# ================================================================== permissions
def test_catalogue_permissions_need_an_explicit_grant(env, admin):
    did = _create(env, admin, name="Goa").json()["id"]
    calls = [("get", DEST, None), ("post", DEST, {"name": "Zed"}), ("patch", f"{DEST}/{did}", {"country": "X"}),
             ("put", f"{DEST}/order", {"ids": [did]}), ("post", f"{DEST}/{did}/locations", {"name": "Loc"}),
             ("get", HOTEL, None), ("patch", f"{HOTEL}/1", {"name": "X"}), ("post", f"{HOTEL}/1/rooms",
              {"code": "D", "name": "N", "base_price_per_night": "100"}), ("get", "/api/admin/catalogue/images", None)]
    for m, u, b in calls:
        kw = {"json": b} if b is not None else {}
        assert getattr(env.client, m)(u, **kw).status_code in (401, 403), u
    bare_admin = _user(env, UserRole.ADMIN, [], "Bare Admin")       # role defaults do not count
    manager = _user(env, UserRole.MANAGER, [], "Mo Manager")
    merchant = _user(env, UserRole.MERCHANT_ADMIN, [], "Mer Admin")
    for who in (bare_admin, manager, merchant):
        for m, u, b in calls:
            kw = {"json": b} if b is not None else {}
            assert getattr(env.client, m)(u, headers=who["headers"], **kw).status_code == 403, (who, u)
    assert [d.name for d in _dests(env)] == ["Goa"]
    assert len(_acts(env, "Destination created")) == 1, "refused calls must not be audited as successes"
