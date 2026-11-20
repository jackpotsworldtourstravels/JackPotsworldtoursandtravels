"""Focused tests for B2B notification-broadcast AUDIT coverage (Phase 3 fix).

``POST /api/admin/notifications/broadcast`` is a sensitive mass action. Before
this fix it recorded nothing about WHO sent it. These tests pin, at the HTTP
layer with the REAL ``require(P.NOTIFICATION_SEND)`` dependency and real bearer
decoding:

  * actor attribution — the authenticated admin's ``user_id``, the ``action``
    and the ``module`` reach ``activity_service.log_activity`` exactly once;
  * recipient scope + result — all-vs-selected and the ``(sent, skipped)``
    counts are recorded in the audit ``details``;
  * content safety — the notification TITLE and MESSAGE BODY never reach the
    audit record (only their lengths do);
  * authorization — a caller without ``notification.send`` is refused and
    NOTHING is logged or broadcast;
  * behaviour preserved — the real title/message still reach
    ``communication_service.broadcast``.

``communication_service.broadcast`` is stubbed so no real notification or email
delivery happens, and ``activity_service.log_activity`` is captured rather than
written. SQLite ``users`` table; nothing here touches a real environment.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_ops
from app.services import activity_service, communication_service

BROADCAST = "/api/admin/notifications/broadcast"
_N = {"n": 500000}


def _id() -> int:
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.engine = engine
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity: list[dict] = []
        self.broadcast_calls: list[dict] = []
        app = FastAPI()
        app.include_router(admin_ops.router)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.app = app
        self.client = TestClient(app, raise_server_exceptions=False)

    def db(self):
        return self.Session()


@pytest.fixture()
def env(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    # ``users`` carries Postgres-only server defaults/FKs; build a SQLite copy on a
    # private MetaData so the real table object is untouched.
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

    # Capture the audit call instead of writing a SystemLog row — the unit under
    # test is the ROUTER's attribution, not log_activity itself.
    monkeypatch.setattr(
        activity_service, "log_activity",
        lambda db, user_id, action, ip=None, **kw: e.activity.append(
            {"user_id": user_id, "action": action, "ip": ip, **kw}),
    )

    # Stub the delivery so no real notification/email is sent; record what the
    # router passed so "behaviour preserved" can be asserted.
    def _broadcast(db, send_to_all, merchant_ids, title, message):
        e.broadcast_calls.append(
            {"send_to_all": send_to_all, "merchant_ids": merchant_ids,
             "title": title, "message": message})
        return (5, 2, 0)

    monkeypatch.setattr(communication_service, "broadcast", _broadcast)
    yield e
    engine.dispose()


def _user(env, role, *, permissions=None, name="User"):
    db = env.db()
    uid = _id()
    u = User(user_id=uid, full_name=name, email=f"u{uid}@example.test",
             password_hash="x", role=role, status=UserStatus.ACTIVE,
             permissions=permissions or [])
    db.add(u)
    db.commit()
    token = create_access_token(uid)
    db.close()
    return {"headers": {"Authorization": f"Bearer {token}"}, "user_id": uid}


@pytest.fixture()
def admin(env):
    # Explicit grant so the test is robust to role-default changes; production
    # gate (require(P.NOTIFICATION_SEND)) is unchanged.
    return _user(env, UserRole.ADMIN, permissions=[P.NOTIFICATION_SEND], name="Ada Admin")


@pytest.fixture()
def nonadmin(env):
    # A role that does NOT hold notification.send and no explicit grant.
    return _user(env, UserRole.MANAGER, name="Mo Manager")


def test_broadcast_records_actor_scope_and_result(env, admin):
    r = env.client.post(
        BROADCAST, json={"send_to_all": True, "title": "Hi", "message": "Body"},
        headers=admin["headers"],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sent"] == 5 and body["skipped"] == 2 and body["failed"] == 0

    assert len(env.activity) == 1, "exactly one audit entry per broadcast"
    log = env.activity[0]
    assert log["user_id"] == admin["user_id"]
    assert log["action"] == "Notification broadcast"
    assert log["module"] == "Notifications"
    d = log["details"]
    assert d["recipient_scope"] == "all"
    assert d["merchant_count"] is None
    assert d["sent"] == 5
    assert d["skipped"] == 2
    assert d["failed"] == 0


def test_broadcast_partial_failure_is_recorded(env, admin, monkeypatch):
    # A broadcast that could not reach every recipient must surface the failure
    # and record it, not drop it silently.
    monkeypatch.setattr(communication_service, "broadcast", lambda *a, **k: (5, 2, 3))
    r = env.client.post(
        BROADCAST, json={"send_to_all": True, "title": "T", "message": "M"},
        headers=admin["headers"],
    )
    assert r.status_code == 200, r.text
    assert r.json()["failed"] == 3
    assert env.activity[0]["details"]["failed"] == 3


def test_broadcast_records_selected_scope(env, admin):
    r = env.client.post(
        BROADCAST, json={"send_to_all": False, "merchant_ids": [1, 2, 3], "title": "T", "message": "M"},
        headers=admin["headers"],
    )
    assert r.status_code == 200, r.text
    d = env.activity[0]["details"]
    assert d["recipient_scope"] == "selected"
    assert d["merchant_count"] == 3


def test_broadcast_audit_is_content_free(env, admin):
    secret_title = "SECRET-TITLE-ab12"
    secret_body = "SECRET-BODY-cd34 do not log this anywhere"
    r = env.client.post(
        BROADCAST, json={"send_to_all": True, "title": secret_title, "message": secret_body},
        headers=admin["headers"],
    )
    assert r.status_code == 200, r.text

    blob = json.dumps(env.activity[0], default=str)
    assert secret_title not in blob, "title must never reach the audit record"
    assert secret_body not in blob, "message body must never reach the audit record"

    d = env.activity[0]["details"]
    assert d["title_length"] == len(secret_title)
    assert d["message_length"] == len(secret_body)

    # Behaviour preserved: the real content still reached the delivery service.
    assert env.broadcast_calls[-1]["title"] == secret_title
    assert env.broadcast_calls[-1]["message"] == secret_body


def test_broadcast_refused_without_permission_logs_nothing(env, nonadmin):
    r = env.client.post(
        BROADCAST, json={"send_to_all": True, "title": "T", "message": "M"},
        headers=nonadmin["headers"],
    )
    assert r.status_code == 403, r.text
    assert env.activity == [], "a refused caller must not produce an audit entry"
    assert env.broadcast_calls == [], "a refused caller must not broadcast anything"


def test_broadcast_refused_anonymous(env):
    r = env.client.post(
        BROADCAST, json={"send_to_all": True, "title": "T", "message": "M"},
    )
    assert r.status_code in (401, 403), r.text
    assert env.activity == []
    assert env.broadcast_calls == []
