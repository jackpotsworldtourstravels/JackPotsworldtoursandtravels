"""Stage 3 M2.1 — admin sends one in-app notification to one customer.

POST /api/admin/communication/customers/{id}/notify
* authorized admin (b2c.communication.send or super-admin) -> 200, one
  CustomerNotification (type "general") + a durable SUCCESS audit ATOMIC with it,
  storing METADATA ONLY (title + message length, never the full body);
* B2B-only admin (no scope) -> 403 + DENIED audit, nothing created;
* unknown customer -> 404 + FAILURE audit, nothing created;
* invalid title/message (blank / too long) -> 422, nothing created;
* audit table absent (0095 unapplied) -> 503, nothing created.

Same harness as the M1 action tests: a TEMP-FILE SQLite DB (independent
connections, so the readiness probe's inspector never disturbs the request
session), get_db + get_current_admin overridden, and b2c_audit.SessionLocal
monkeypatched so independent FAILURE/DENIED writes land in the test DB. No
PostgreSQL; 0095 stays unapplied (the harness creates the audit table, exactly
as production will once 0095 is applied).
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models_customer import (
    AdminAuditOutcome,
    Base,
    Customer,
    CustomerAdminAuditLog,
    CustomerNotification,
)
from app.models_v2 import User, UserRole
from app.routers import admin_communication
from app.services import b2c_admin_readiness as readiness
from app.services import customer_admin_audit_service as b2c_audit

_ALL = [Customer.__table__, CustomerNotification.__table__, CustomerAdminAuditLog.__table__]
_NO_AUDIT = [Customer.__table__, CustomerNotification.__table__]  # audit table ABSENT
PERM = ["b2c.communication.send"]
URL = "/api/admin/communication/customers/{cid}/notify"

_ENGINES: list = []
_TMPFILES: list = []


@pytest.fixture(autouse=True)
def _reset_readiness():
    readiness.clear_cache()
    yield
    readiness.clear_cache()
    while _ENGINES:
        _ENGINES.pop().dispose()
    while _TMPFILES:
        path = _TMPFILES.pop()
        try:
            os.unlink(path)
        except OSError:
            pass


def _engine(tables=_ALL):
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _TMPFILES.append(path)
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng, tables=tables)
    _ENGINES.append(eng)
    return eng


def _maker(eng):
    return sessionmaker(bind=eng, expire_on_commit=False)


def _seed(eng, *, cid=1, email="person@example.test"):
    with _maker(eng)() as s:
        s.add(Customer(customer_id=cid, customer_code=f"CUST{cid:04d}", full_name="Person",
                       email=email, mobile="9000000000"))
        s.commit()


def _admin(*, perms, role=UserRole.ADMIN):
    return User(user_id=1, role=role, merchant_role=None, permissions=list(perms),
                full_name="Admin", email="admin@example.test")


def _client(eng, admin):
    app = FastAPI()
    app.include_router(admin_communication.router)
    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_admin] = lambda: admin
    return TestClient(app, raise_server_exceptions=False)


# --- success -----------------------------------------------------------------
def test_authorized_admin_sends_and_audits_success():
    eng = _engine()
    _seed(eng, cid=1)
    r = _client(eng, _admin(perms=PERM)).post(
        URL.format(cid=1), json={"title": "Welcome", "message": "Your trip is confirmed."})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == "sent"
    assert body["customer_id"] == 1
    assert body["notification_type"] == "general"
    with _maker(eng)() as s:
        n = s.get(CustomerNotification, body["notification_id"])
        assert n is not None and n.customer_id == 1
        assert n.title == "Welcome" and n.message == "Your trip is confirmed."
        assert n.notification_type == "general"
        assert not n.is_read
        aud = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.notify", outcome=AdminAuditOutcome.SUCCESS).all()
        assert len(aud) == 1
        nv = aud[0].new_value
        # CONTENT-FREE METADATA ONLY — id, type, message length. The title and
        # the body are NOT copied into the audit trail (privacy).
        assert nv["notification_id"] == body["notification_id"]
        assert nv["notification_type"] == "general"
        assert nv["message_length"] == len("Your trip is confirmed.")
        assert "title" not in nv
        assert "Welcome" not in str(nv)                      # title not stored
        assert "Your trip is confirmed." not in str(nv)      # body not stored


def test_super_admin_allowed_without_explicit_scope():
    eng = _engine()
    _seed(eng, cid=1)
    r = _client(eng, _admin(perms=[], role=UserRole.SUPER_ADMIN)).post(
        URL.format(cid=1), json={"title": "Hi", "message": "A message."})
    assert r.status_code == 200, r.text


# --- denied ------------------------------------------------------------------
def test_denied_without_scope_is_403_and_audited_denied(monkeypatch):
    eng = _engine()
    _seed(eng, cid=1)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))  # independent DENIED lands here
    r = _client(eng, _admin(perms=[])).post(
        URL.format(cid=1), json={"title": "Hi", "message": "A message."})
    assert r.status_code == 403
    with _maker(eng)() as s:
        assert s.query(CustomerNotification).count() == 0
        denied = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.notify", outcome=AdminAuditOutcome.DENIED).all()
        assert len(denied) == 1


# --- unknown customer --------------------------------------------------------
def test_unknown_customer_is_404_and_audited_failure(monkeypatch):
    eng = _engine()  # no customer seeded
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    r = _client(eng, _admin(perms=PERM)).post(
        URL.format(cid=999), json={"title": "Hi", "message": "A message."})
    assert r.status_code == 404
    with _maker(eng)() as s:
        assert s.query(CustomerNotification).count() == 0
        fail = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.notify", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(fail) == 1


# --- validation --------------------------------------------------------------
@pytest.mark.parametrize("payload", [
    {"title": "", "message": "A message."},
    {"title": "   ", "message": "A message."},
    {"title": "x" * 151, "message": "A message."},
    {"title": "Hi", "message": ""},
    {"title": "Hi", "message": "m" * 501},
])
def test_invalid_input_is_422_and_creates_nothing(payload):
    eng = _engine()
    _seed(eng, cid=1)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(cid=1), json=payload)
    assert r.status_code == 422, r.text
    with _maker(eng)() as s:
        assert s.query(CustomerNotification).count() == 0


# --- readiness (0095 unapplied) ----------------------------------------------
def test_503_when_audit_table_absent_creates_nothing():
    eng = _engine(tables=_NO_AUDIT)
    _seed(eng, cid=1)
    r = _client(eng, _admin(perms=PERM)).post(
        URL.format(cid=1), json={"title": "Hi", "message": "A message."})
    assert r.status_code == 503, r.text
    with _maker(eng)() as s:
        assert s.query(CustomerNotification).count() == 0


# --- frontend presence (static) ----------------------------------------------
def test_frontend_send_notification_ui_is_wired():
    root = Path(__file__).resolve().parents[2]
    html = (root / "frontend" / "admin" / "index.html").read_text(encoding="utf-8")
    js = (root / "frontend" / "assets" / "js" / "admin-b2c-communication.js").read_text(encoding="utf-8")
    assert 'id="comNotifySend"' in html
    assert "comOpenCompose" in js and "comSubmitNotification" in js
    assert "/api/admin/communication/customers/" in js and "/notify" in js
