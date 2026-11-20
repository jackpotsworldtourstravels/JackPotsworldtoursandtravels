"""Stage 3 M2.2 — admin sends one email to one customer.

POST /api/admin/communication/customers/{id}/email
* authorized admin + verified email -> 200 delivered, SUCCESS audit ATOMIC with
  the send decision, METADATA ONLY (channel + subject/message LENGTHS, never the
  subject text or body); email sent to the customer's OWN verified address;
* B2B-only admin (no scope) -> 403 + DENIED audit, nothing sent;
* unknown customer -> 404 + FAILURE, nothing sent;
* no verified email -> 422 + FAILURE, nothing sent;
* SMTP failure (_send/helper returns False) -> 502 + FAILURE audit;
* email sent but SUCCESS-audit commit fails -> 500 + independent FAILURE anomaly,
  email NOT falsely claimed unsent;
* invalid subject/message -> 422, nothing sent;
* audit table absent (0095 unapplied) -> 503, nothing sent.

Same temp-file SQLite harness as M1/M2.1; email_service.send_admin_customer_email
is monkeypatched (no real SMTP), and b2c_audit.SessionLocal is pointed at the
test DB so independent FAILURE/DENIED writes are assertable.
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
from app.models_customer import AdminAuditOutcome, Base, Customer, CustomerAdminAuditLog
from app.models_v2 import User, UserRole
from app.routers import admin_communication
from app.services import b2c_admin_readiness as readiness
from app.services import customer_admin_audit_service as b2c_audit
from app.services import email_service

_ALL = [Customer.__table__, CustomerAdminAuditLog.__table__]
_NO_AUDIT = [Customer.__table__]
PERM = ["b2c.communication.send"]
URL = "/api/admin/communication/customers/{cid}/email"
BODY = {"subject": "Trip update", "message": "Your departure time has changed."}

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


def _seed(eng, *, cid=1, email="person@example.test", email_verified=True):
    with _maker(eng)() as s:
        s.add(Customer(customer_id=cid, customer_code=f"CUST{cid:04d}", full_name="Person",
                       email=email, mobile="9000000000", email_verified=email_verified))
        s.commit()


def _admin(*, perms, role=UserRole.ADMIN):
    return User(user_id=1, role=role, merchant_role=None, permissions=list(perms),
                full_name="Admin", email="admin@example.test")


def _client(eng, admin, *, session=None):
    app = FastAPI()
    app.include_router(admin_communication.router)
    session = session if session is not None else _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_admin] = lambda: admin
    return TestClient(app, raise_server_exceptions=False)


def _capture_email(monkeypatch, *, returns=True):
    """Patch the SMTP helper; record calls so we can assert it was / wasn't used."""
    calls = []

    def _fake(to_email, subject, body):
        calls.append((to_email, subject, body))
        return returns

    monkeypatch.setattr(email_service, "send_admin_customer_email", _fake)
    return calls


# --- success -----------------------------------------------------------------
def test_authorized_admin_emails_and_audits_success(monkeypatch):
    eng = _engine()
    _seed(eng, cid=1, email="person@example.test", email_verified=True)
    calls = _capture_email(monkeypatch, returns=True)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(cid=1), json=BODY)
    assert r.status_code == 200, r.text
    assert r.json() == {"outcome": "sent", "customer_id": 1, "delivered": True}
    # sent to the customer's OWN verified address, with the admin subject/body
    assert calls == [("person@example.test", "Trip update", "Your departure time has changed.")]
    with _maker(eng)() as s:
        aud = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.email", outcome=AdminAuditOutcome.SUCCESS).all()
        assert len(aud) == 1
        nv = aud[0].new_value
        assert nv["channel"] == "email"
        assert nv["subject_length"] == len("Trip update")
        assert nv["message_length"] == len("Your departure time has changed.")
        # METADATA ONLY — neither the subject text nor the body is stored.
        assert "Trip update" not in str(nv)
        assert "Your departure time has changed." not in str(nv)


def test_super_admin_allowed(monkeypatch):
    eng = _engine()
    _seed(eng, cid=1)
    _capture_email(monkeypatch, returns=True)
    r = _client(eng, _admin(perms=[], role=UserRole.SUPER_ADMIN)).post(URL.format(cid=1), json=BODY)
    assert r.status_code == 200, r.text


# --- denied ------------------------------------------------------------------
def test_denied_without_scope_is_403_sends_nothing(monkeypatch):
    eng = _engine()
    _seed(eng, cid=1)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    calls = _capture_email(monkeypatch, returns=True)
    r = _client(eng, _admin(perms=[])).post(URL.format(cid=1), json=BODY)
    assert r.status_code == 403
    assert calls == []  # nothing sent
    with _maker(eng)() as s:
        assert len(s.query(CustomerAdminAuditLog).filter_by(
            action="customer.email", outcome=AdminAuditOutcome.DENIED).all()) == 1


# --- unknown customer --------------------------------------------------------
def test_unknown_customer_is_404_sends_nothing(monkeypatch):
    eng = _engine()
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    calls = _capture_email(monkeypatch, returns=True)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(cid=999), json=BODY)
    assert r.status_code == 404
    assert calls == []
    with _maker(eng)() as s:
        assert len(s.query(CustomerAdminAuditLog).filter_by(
            action="customer.email", outcome=AdminAuditOutcome.FAILURE).all()) == 1


# --- no verified email -------------------------------------------------------
def test_unverified_email_is_422_sends_nothing(monkeypatch):
    eng = _engine()
    _seed(eng, cid=1, email="person@example.test", email_verified=False)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    calls = _capture_email(monkeypatch, returns=True)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(cid=1), json=BODY)
    assert r.status_code == 422
    assert calls == []  # nothing sent, no token/email
    with _maker(eng)() as s:
        assert len(s.query(CustomerAdminAuditLog).filter_by(
            action="customer.email", outcome=AdminAuditOutcome.FAILURE).all()) == 1


# --- SMTP failure ------------------------------------------------------------
def test_smtp_failure_is_502_and_audits_failure(monkeypatch):
    eng = _engine()
    _seed(eng, cid=1)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    calls = _capture_email(monkeypatch, returns=False)  # delivery fails
    r = _client(eng, _admin(perms=PERM)).post(URL.format(cid=1), json=BODY)
    assert r.status_code == 502
    assert len(calls) == 1  # send was attempted
    with _maker(eng)() as s:
        fail = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.email", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(fail) == 1
        assert fail[0].reason == "email delivery failed"


# --- email sent but SUCCESS audit commit fails -------------------------------
def test_email_sent_but_audit_commit_fails_is_500_not_false_unsent(monkeypatch):
    eng = _engine()
    _seed(eng, cid=1)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))  # independent anomaly lands here
    calls = _capture_email(monkeypatch, returns=True)            # email IS sent
    session = _maker(eng)()

    def _boom():
        raise RuntimeError("commit failed")

    monkeypatch.setattr(session, "commit", _boom)  # the SUCCESS-audit commit fails
    r = _client(eng, _admin(perms=PERM), session=session).post(URL.format(cid=1), json=BODY)
    assert r.status_code == 500
    assert len(calls) == 1                     # the email WAS sent (not recalled)
    assert "unsent" not in r.text.lower()      # never falsely claims it was not sent
    with _maker(eng)() as s:
        anomaly = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.email", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(anomaly) == 1
        assert "success audit" in anomaly[0].reason.lower()
        # No SUCCESS row (its commit was rolled back)
        assert s.query(CustomerAdminAuditLog).filter_by(
            action="customer.email", outcome=AdminAuditOutcome.SUCCESS).count() == 0


# --- validation --------------------------------------------------------------
@pytest.mark.parametrize("payload", [
    {"subject": "", "message": "Body."},
    {"subject": "   ", "message": "Body."},
    {"subject": "s" * 201, "message": "Body."},
    {"subject": "Hi", "message": ""},
    {"subject": "Hi", "message": "m" * 5001},
])
def test_invalid_input_is_422_sends_nothing(monkeypatch, payload):
    eng = _engine()
    _seed(eng, cid=1)
    calls = _capture_email(monkeypatch, returns=True)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(cid=1), json=payload)
    assert r.status_code == 422, r.text
    assert calls == []


# --- readiness (0095 unapplied) ----------------------------------------------
def test_503_when_audit_table_absent_sends_nothing(monkeypatch):
    eng = _engine(tables=_NO_AUDIT)
    _seed(eng, cid=1)
    calls = _capture_email(monkeypatch, returns=True)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(cid=1), json=BODY)
    assert r.status_code == 503, r.text
    assert calls == []  # gate refuses before the handler; nothing sent


# --- frontend presence (static) ----------------------------------------------
def test_frontend_send_email_ui_is_wired():
    root = Path(__file__).resolve().parents[2]
    html = (root / "frontend" / "admin" / "index.html").read_text(encoding="utf-8")
    js = (root / "frontend" / "assets" / "js" / "admin-b2c-communication.js").read_text(encoding="utf-8")
    assert 'id="comEmailSend"' in html
    assert "comOpenEmail" in js and "comSubmitEmail" in js
    assert "/api/admin/communication/customers/" in js and "/email" in js
