"""Gaming Tour enquiry ADMIN authorization (Phase 3 P2-A correction).

The admin gaming-enquiry queue used to accept ANY authenticated admin
(``get_current_admin``). It now requires the granular ``gaming.enquiry.manage``
code. These tests pin, at the HTTP layer with real bearer decoding and the real
``require(P.GAMING_ENQUIRY_MANAGE)`` dependency:

  * feature disabled  → 404 (fail-closed), even for an admin holding the code;
  * enabled + missing the code → 403;
  * enabled + holding the code → 200;
  * anonymous → 401/403.

Gaming is never enabled in production here — the fixture sets the flag on the
shared settings object only, and restores nothing it did not set.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.config import settings
from app.database.session import get_db
from app.models_v2 import GamingTourEnquiry, User, UserRole, UserStatus
from app.routers import gaming_tour_enquiries as gaming

LIST = "/api/admin/gaming-tour-enquiries"
_N = {"n": 700000}


def _id() -> int:
    _N["n"] += 1
    return _N["n"]


def _sqlite_copy(model, md, engine):
    """A SQLite-friendly copy of a model's table (Postgres server defaults/FKs
    stripped), so the real table object is left untouched."""
    t = model.__table__.to_metadata(md)
    for con in list(t.constraints):
        if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
            t.constraints.discard(con)
    for idx in list(t.indexes):
        t.indexes.discard(idx)
    for col in t.columns:
        col.foreign_keys.clear()
        col.server_default = None
        if not col.primary_key:
            col.nullable = True
    t.create(engine)


@pytest.fixture()
def env(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    md = MetaData()
    _sqlite_copy(User, md, engine)
    _sqlite_copy(GamingTourEnquiry, md, engine)

    # Enable the feature for the authorization tests (the fail-closed 404 test
    # re-disables it). The property reads this raw field.
    monkeypatch.setattr(settings, "gaming_tour_packages_enabled", "true")

    Session = sessionmaker(bind=engine, expire_on_commit=False)
    app = FastAPI()
    app.include_router(gaming.router)

    def _db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _db
    client = TestClient(app, raise_server_exceptions=False)

    def _user(role, *, permissions=None):
        s = Session()
        uid = _id()
        s.add(User(user_id=uid, full_name="U", email=f"u{uid}@x.test",
                   password_hash="x", role=role, status=UserStatus.ACTIVE,
                   permissions=permissions or []))
        s.commit()
        s.close()
        return {"Authorization": f"Bearer {create_access_token(uid)}"}

    yield client, _user, monkeypatch
    engine.dispose()


def test_enabled_admin_with_permission_allowed(env):
    client, _user, _ = env
    # ADMIN holds gaming.enquiry.manage via the role default now.
    headers = _user(UserRole.ADMIN)
    r = client.get(LIST, headers=headers)
    assert r.status_code == 200, r.text


def test_enabled_without_permission_refused(env):
    client, _user, _ = env
    headers = _user(UserRole.MANAGER)  # no gaming.enquiry.manage, no grant
    r = client.get(LIST, headers=headers)
    assert r.status_code == 403, r.text


def test_anonymous_refused(env):
    client, _user, _ = env
    r = client.get(LIST)
    assert r.status_code in (401, 403), r.text


def test_disabled_feature_is_404_even_for_authorized_admin(env):
    client, _user, monkeypatch = env
    monkeypatch.setattr(settings, "gaming_tour_packages_enabled", None)
    headers = _user(UserRole.ADMIN)
    r = client.get(LIST, headers=headers)
    assert r.status_code == 404, r.text
