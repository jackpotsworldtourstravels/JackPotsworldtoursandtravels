"""Stage 3 M1 — B2C customer account actions: block / unblock / password-reset.

Covers §3-§4 and §9 of docs/STAGE_3_PLAN.md:
* block sets status=blocked + force_logout_at, audited SUCCESS, idempotent;
* unblock restores active without reviving old sessions, audited;
* admin-initiated password reset uses the email-link flow only — never returns
  a token/link; with a verified email -> link sent + SUCCESS audit; WITHOUT a
  verified email -> 422, NO token generated, FAILURE audit; SMTP failure -> 502
  + FAILURE audit;
* authorization: b2c.customers.manage required (super-admin or explicit grant);
  a B2B-only admin is 403 and the denial is audited DENIED;
* readiness: audit table absent -> 503 and the customer is not mutated.

No PostgreSQL; migration 0095 remains unapplied (the SQLite harness creates the
audit table, exactly as production will once 0095 is applied).
"""
from __future__ import annotations

import os
import tempfile

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
    CustomerAuth,
    CustomerPasswordReset,
    CustomerStatus,
)
from app.models_v2 import User, UserRole
from app.routers import customer_admin
from app.services import b2c_admin_readiness as readiness
from app.services import customer_admin_audit_service as b2c_audit

_ALL = [Customer.__table__, CustomerAuth.__table__,
        CustomerPasswordReset.__table__, CustomerAdminAuditLog.__table__]


_ENGINES: list = []
_TMPFILES: list = []


@pytest.fixture(autouse=True)
def _reset_readiness():
    saved = readiness.READY_TTL_SECONDS
    readiness.clear_cache()
    yield
    readiness.clear_cache()
    readiness.READY_TTL_SECONDS = saved
    while _ENGINES:
        _ENGINES.pop().dispose()
    while _TMPFILES:
        path = _TMPFILES.pop()
        try:
            os.unlink(path)
        except OSError:
            pass


def _engine(tables=_ALL):
    # A TEMP-FILE SQLite DB (not StaticPool in-memory): each connection is
    # independent, so the readiness probe's `inspect(engine)` gets its OWN
    # connection and never disturbs the request session's transaction — exactly
    # as a real pooled Postgres engine behaves in production. A StaticPool
    # in-memory DB would instead share one connection, and the inspector closing
    # it would roll back the session's pending write.
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _TMPFILES.append(path)
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng, tables=tables)
    _ENGINES.append(eng)
    return eng


def _maker(eng):
    return sessionmaker(bind=eng, expire_on_commit=False)


def _seed(eng, *, cid, status=CustomerStatus.ACTIVE, with_auth=True,
          email="person@example.test", email_verified=True, force_logout_at=None):
    with _maker(eng)() as s:
        c = Customer(customer_id=cid, customer_code=f"CUST{cid:04d}", full_name="Person",
                     email=email, mobile="9000000000", status=status, email_verified=email_verified)
        s.add(c)
        s.flush()
        if with_auth:
            s.add(CustomerAuth(customer_auth_id=cid, customer_id=cid,
                               password_hash="x", force_logout_at=force_logout_at))
        s.commit()


def _admin(*, perms, role=UserRole.ADMIN):
    return User(user_id=1, role=role, merchant_role=None,
                permissions=list(perms), full_name="Admin", email="admin@example.test")


def _client(eng, admin, *, session=None):
    app = FastAPI()
    app.include_router(customer_admin.router)
    session = session if session is not None else _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_admin] = lambda: admin
    return TestClient(app, raise_server_exceptions=False)


# --- block / unblock ---------------------------------------------------------
def test_block_sets_blocked_force_logout_and_audits_success():
    eng = _engine()
    _seed(eng, cid=1, status=CustomerStatus.ACTIVE, with_auth=True)
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/1/block", json={"reason": "chargeback fraud"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["status"], body["from_status"], body["to_status"]) == ("blocked", "active", "blocked")
    with _maker(eng)() as s:
        c = s.get(Customer, 1)
        assert c.status is CustomerStatus.BLOCKED
        assert c.auth.force_logout_at is not None       # live sessions invalidated
        rows = s.query(CustomerAdminAuditLog).filter_by(action="customer.block").all()
        assert len(rows) == 1 and rows[0].outcome is AdminAuditOutcome.SUCCESS


def test_block_is_idempotent():
    eng = _engine()
    _seed(eng, cid=2, status=CustomerStatus.BLOCKED, with_auth=True)
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/2/block", json={"reason": "again"})
    assert r.status_code == 200, r.text
    assert r.json()["from_status"] == "blocked" and r.json()["to_status"] == "blocked"


def test_block_requires_a_reason():
    eng = _engine()
    _seed(eng, cid=3, with_auth=True)
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/3/block", json={})
    assert r.status_code == 422   # reason is required by the schema


def test_unblock_restores_active_and_audits():
    eng = _engine()
    _seed(eng, cid=4, status=CustomerStatus.BLOCKED, with_auth=True, force_logout_at=None)
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/4/unblock", json={})
    assert r.status_code == 200, r.text
    assert (r.json()["from_status"], r.json()["to_status"]) == ("blocked", "active")
    with _maker(eng)() as s:
        assert s.get(Customer, 4).status is CustomerStatus.ACTIVE
        rows = s.query(CustomerAdminAuditLog).filter_by(action="customer.unblock").all()
        assert len(rows) == 1 and rows[0].outcome is AdminAuditOutcome.SUCCESS


def test_block_404_for_unknown_customer():
    eng = _engine()
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/999/block", json={"reason": "x"})
    assert r.status_code == 404


# --- password reset ----------------------------------------------------------
def test_password_reset_with_verified_email_sends_link_and_audits(monkeypatch):
    eng = _engine()
    _seed(eng, cid=5, email="verified@example.test", email_verified=True, with_auth=True)
    sent = []
    monkeypatch.setattr(customer_admin.email_service, "send_password_reset_email",
                        lambda *a, **k: sent.append(a))
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/5/password-reset", json={})
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "reset email sent"}
    # The admin response NEVER carries a token or link.
    assert "token" not in r.text.lower() and "reset-password.html" not in r.text
    assert len(sent) == 1                               # the standard email was sent
    with _maker(eng)() as s:
        assert s.query(CustomerPasswordReset).filter_by(customer_id=5).count() == 1
        rows = s.query(CustomerAdminAuditLog).filter_by(action="customer.reset_password_initiated").all()
        assert len(rows) == 1 and rows[0].outcome is AdminAuditOutcome.SUCCESS
        # Audit records the channel only — never the token.
        assert rows[0].new_value == {"channel": "email", "force_logout": False}


def test_password_reset_without_verified_email_is_422_no_token_audited_failure(monkeypatch):
    eng = _engine()
    _seed(eng, cid=6, email="unverified@example.test", email_verified=False, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))     # independent FAILURE lands here
    reset_called = []
    monkeypatch.setattr(customer_admin.customer_auth_service, "start_password_reset",
                        lambda *a, **k: reset_called.append(a))
    monkeypatch.setattr(customer_admin.email_service, "send_password_reset_email",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not email")))
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/6/password-reset", json={})
    assert r.status_code == 422, r.text
    assert reset_called == []                            # NO token generated
    with _maker(eng)() as s:
        assert s.query(CustomerPasswordReset).count() == 0
        rows = s.query(CustomerAdminAuditLog).filter_by(action="customer.reset_password_initiated").all()
        assert len(rows) == 1 and rows[0].outcome is AdminAuditOutcome.FAILURE


def test_password_reset_email_failure_is_502_invalidates_token_and_audits_failure(monkeypatch):
    eng = _engine()
    _seed(eng, cid=7, email="ok@example.test", email_verified=True, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    monkeypatch.setattr(customer_admin.email_service, "send_password_reset_email",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp down")))
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/7/password-reset", json={})
    assert r.status_code == 502, r.text
    assert "token" not in r.text.lower() and "reset-password.html" not in r.text   # no leak
    with _maker(eng)() as s:
        # The token the email would have carried is INVALIDATED (spent), so an
        # SMTP failure leaves no usable reset credential.
        resets = s.query(CustomerPasswordReset).filter_by(customer_id=7).all()
        assert len(resets) == 1 and resets[0].used_at is not None
        rows = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.reset_password_initiated", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(rows) == 1


def test_password_reset_audit_commit_failure_after_email_is_500_not_success(monkeypatch):
    # The email is sent, but the SUCCESS audit cannot be committed. External side
    # effect: the email cannot be un-sent. We must NOT report success (500, no
    # token leak), the SUCCESS audit must be absent, and the anomaly recorded.
    eng = _engine()
    _seed(eng, cid=24, email="v24@example.test", email_verified=True, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    monkeypatch.setattr(customer_admin.email_service, "send_password_reset_email", lambda *a, **k: None)

    sess = _maker(eng)()
    real_commit = sess.commit
    calls = {"n": 0}

    def failing_commit():
        calls["n"] += 1
        if calls["n"] >= 2:                              # 1 = token persist (ok); 2 = SUCCESS audit (fail)
            raise RuntimeError("audit db lost mid-request")
        return real_commit()

    sess.commit = failing_commit
    r = _client(eng, _admin(perms=["b2c.customers.manage"]), session=sess).post(
        "/api/admin/customers/24/password-reset", json={})
    assert r.status_code == 500, r.text
    assert "token" not in r.text.lower() and "reset-password.html" not in r.text
    with _maker(eng)() as s:
        assert s.query(CustomerPasswordReset).filter_by(customer_id=24).count() == 1   # email went out
        succ = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.reset_password_initiated", outcome=AdminAuditOutcome.SUCCESS).all()
        assert succ == []                                 # never a success-without-audit
        fail = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.reset_password_initiated", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(fail) == 1 and "success audit" in (fail[0].reason or "")


def test_password_reset_force_logout_sets_force_logout_at(monkeypatch):
    eng = _engine()
    _seed(eng, cid=8, email="fl@example.test", email_verified=True, with_auth=True, force_logout_at=None)
    monkeypatch.setattr(customer_admin.email_service, "send_password_reset_email", lambda *a, **k: None)
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/8/password-reset", json={"force_logout": True})
    assert r.status_code == 200, r.text
    with _maker(eng)() as s:
        assert s.get(Customer, 8).auth.force_logout_at is not None


# --- authorization -----------------------------------------------------------
def test_action_denied_without_scope_is_403_and_audited_denied(monkeypatch):
    eng = _engine()
    _seed(eng, cid=9, status=CustomerStatus.ACTIVE, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))     # independent DENIED lands here
    r = _client(eng, _admin(perms=[])).post(                        # B2B-only admin, no b2c scope
        "/api/admin/customers/9/block", json={"reason": "x"})
    assert r.status_code == 403, r.text
    with _maker(eng)() as s:
        assert s.get(Customer, 9).status is CustomerStatus.ACTIVE   # not mutated
        denied = s.query(CustomerAdminAuditLog).filter_by(outcome=AdminAuditOutcome.DENIED).all()
        assert len(denied) == 1 and denied[0].action == "customer.block"


def test_super_admin_allowed_without_explicit_scope():
    eng = _engine()
    _seed(eng, cid=10, status=CustomerStatus.ACTIVE, with_auth=True)
    r = _client(eng, _admin(perms=[], role=UserRole.SUPER_ADMIN)).post(
        "/api/admin/customers/10/block", json={"reason": "x"})
    assert r.status_code == 200, r.text


def test_password_reset_smtp_and_invalidation_double_failure_is_honest(monkeypatch):
    # SMTP fails AND invalidate_reset_token() ALSO fails. The endpoint must not
    # imply the token was invalidated, must leak no token/link, must record the
    # true state, and must not falsely spend the token.
    eng = _engine()
    _seed(eng, cid=25, email="d25@example.test", email_verified=True, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    monkeypatch.setattr(customer_admin.email_service, "send_password_reset_email",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp down")))
    monkeypatch.setattr(customer_admin.customer_auth_service, "invalidate_reset_token",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db lost during cleanup")))
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/25/password-reset", json={})
    assert r.status_code == 502, r.text
    # No token/link leak, and no false claim of invalidation in the response body.
    low = r.text.lower()
    assert "token" not in low and "reset-password.html" not in r.text and "invalidat" not in low
    with _maker(eng)() as s:
        fail = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.reset_password_initiated", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(fail) == 1 and "still live" in (fail[0].reason or "")
        # The token was NOT falsely marked spent (invalidation genuinely failed).
        resets = s.query(CustomerPasswordReset).filter_by(customer_id=25).all()
        assert len(resets) == 1 and resets[0].used_at is None


# --- status preservation (M1 correction) -------------------------------------
@pytest.mark.parametrize("status", [CustomerStatus.INACTIVE, CustomerStatus.SUSPENDED])
def test_block_refused_for_non_active_status_leaves_it_unchanged(monkeypatch, status):
    eng = _engine()
    _seed(eng, cid=20, status=status, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/20/block", json={"reason": "x"})
    assert r.status_code == 409, r.text
    with _maker(eng)() as s:
        assert s.get(Customer, 20).status is status      # NOT overwritten to blocked
        fail = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.block", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(fail) == 1


@pytest.mark.parametrize("status", [CustomerStatus.INACTIVE, CustomerStatus.SUSPENDED])
def test_unblock_cannot_reactivate_non_blocked_status(monkeypatch, status):
    eng = _engine()
    _seed(eng, cid=21, status=status, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/21/unblock", json={})
    assert r.status_code == 409, r.text
    with _maker(eng)() as s:
        assert s.get(Customer, 21).status is status      # NOT reactivated to active
        fail = s.query(CustomerAdminAuditLog).filter_by(
            action="customer.unblock", outcome=AdminAuditOutcome.FAILURE).all()
        assert len(fail) == 1


@pytest.mark.parametrize("status", [CustomerStatus.INACTIVE, CustomerStatus.SUSPENDED])
def test_block_then_unblock_cannot_reactivate_a_non_active_customer(monkeypatch, status):
    eng = _engine()
    _seed(eng, cid=22, status=status, with_auth=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    c = _client(eng, _admin(perms=["b2c.customers.manage"]))
    assert c.post("/api/admin/customers/22/block", json={"reason": "x"}).status_code == 409
    assert c.post("/api/admin/customers/22/unblock", json={}).status_code == 409
    with _maker(eng)() as s:
        assert s.get(Customer, 22).status is status      # end state == start state


def test_unblock_active_customer_is_idempotent_noop():
    eng = _engine()
    _seed(eng, cid=23, status=CustomerStatus.ACTIVE, with_auth=True)
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/23/unblock", json={})
    assert r.status_code == 200, r.text
    assert (r.json()["from_status"], r.json()["to_status"]) == ("active", "active")


# --- readiness gate ----------------------------------------------------------
def test_block_returns_503_when_audit_table_absent():
    eng = _engine(tables=[Customer.__table__, CustomerAuth.__table__])   # NO audit table (0095 unapplied)
    _seed(eng, cid=11, status=CustomerStatus.ACTIVE, with_auth=True)
    r = _client(eng, _admin(perms=["b2c.customers.manage"])).post(
        "/api/admin/customers/11/block", json={"reason": "x"})
    assert r.status_code == 503, r.text
    with _maker(eng)() as s:
        assert s.get(Customer, 11).status is CustomerStatus.ACTIVE       # not mutated
