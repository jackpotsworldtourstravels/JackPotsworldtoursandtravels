"""Phase 1 (audit follow-up) — review MODERATION requires its own write scope.

PATCH /api/admin/reviews/{id} (approve / reject / publish the admin reply) now
requires ``b2c.reviews.moderate``. The read endpoints (list, detail, analytics)
stay on ``b2c.customers.view``. Before this change the PATCH shared the view
scope, so a view-only operator could approve reviews and post public replies.

Isolated temp-file SQLite harness — no real database is touched. The one
endpoint whose SQL is Postgres-only (``/analytics`` uses ``to_char`` /
``date_trunc``) is exercised only for its PERMISSION gate, which runs before any
query; its allowed/200 path needs Postgres and is out of scope for this harness.
"""
from __future__ import annotations

import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth import deps as auth_deps
from app.auth.rbac import P
from app.database.session import get_db
from app.models_customer import (
    AdminAuditOutcome,
    Base,
    Customer,
    CustomerAdminAuditLog,
    CustomerReview,
)
from app.models_v2 import User, UserRole
from app.routers import admin_reviews

VIEW = P.B2C_CUSTOMERS_VIEW        # "b2c.customers.view"
MODERATE = P.B2C_REVIEWS_MODERATE  # "b2c.reviews.moderate"
URL = "/api/admin/reviews/{rid}"
LIST_URL = "/api/admin/reviews"
ANALYTICS_URL = "/api/admin/reviews/analytics"

_TABLES = [Customer.__table__, CustomerReview.__table__, CustomerAdminAuditLog.__table__]
_ENGINES: list = []
_TMPFILES: list = []


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    while _ENGINES:
        _ENGINES.pop().dispose()
    while _TMPFILES:
        path = _TMPFILES.pop()
        try:
            os.unlink(path)
        except OSError:
            pass


def _engine():
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _TMPFILES.append(path)
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng, tables=_TABLES)
    _ENGINES.append(eng)
    return eng


def _maker(eng):
    return sessionmaker(bind=eng, expire_on_commit=False)


def _seed_review(eng, *, rid=1, cid=1, status="pending", reply=None):
    with _maker(eng)() as s:
        s.add(Customer(customer_id=cid, customer_code=f"CUST{cid:04d}", full_name=f"Person{cid}",
                       email=f"p{cid}@example.test", mobile=f"90000000{cid:02d}"))
        s.flush()
        s.add(CustomerReview(customer_review_id=rid, customer_id=cid, item_type="flight",
                             item_id=100 + rid, rating=5, comment="Great trip.",
                             status=status, admin_reply=reply))
        s.commit()


def _user(*, perms, role=UserRole.ADMIN):
    return User(user_id=1, role=role, merchant_role=None, permissions=list(perms),
                full_name="Admin", email="admin@example.test")


def _client(eng, user):
    """A client whose caller is `user` (a stub returned by the overridden
    get_current_user, the same dependency require_scope resolves)."""
    app = FastAPI()
    app.include_router(admin_reviews.router)
    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[auth_deps.get_current_user] = lambda: user
    return TestClient(app, raise_server_exceptions=False)


def _anon_client(eng):
    """No get_current_user override: the REAL dependency runs, so a bogus bearer
    token exercises the genuine unauthenticated path (decode fails -> 401)."""
    app = FastAPI()
    app.include_router(admin_reviews.router)
    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    return TestClient(app, raise_server_exceptions=False)


def _status_of(eng, rid):
    with _maker(eng)() as s:
        r = s.get(CustomerReview, rid)
        return (r.status, r.admin_reply)


# --- the matrix: PATCH moderation -------------------------------------------
def test_view_only_is_denied_on_patch_and_changes_nothing():
    eng = _engine()
    _seed_review(eng, rid=1, status="pending", reply=None)
    r = _client(eng, _user(perms=[VIEW])).patch(URL.format(rid=1),
                                                 json={"status": "approved", "admin_reply": "Thanks!"})
    assert r.status_code == 403, r.text
    # unauthorized PATCH left status AND reply untouched
    assert _status_of(eng, 1) == ("pending", None)
    with _maker(eng)() as s:
        assert s.query(CustomerAdminAuditLog).filter_by(
            action="review.moderate", outcome=AdminAuditOutcome.SUCCESS).count() == 0


def test_moderate_scope_is_allowed_on_patch_and_audits(monkeypatch):
    eng = _engine()
    _seed_review(eng, rid=1, status="pending")
    # The general activity log is covered by its own tests; keep the SECURITY
    # audit (b2c_audit -> CustomerAdminAuditLog) real and assert on it.
    monkeypatch.setattr(admin_reviews, "log_change", lambda *a, **k: None)
    r = _client(eng, _user(perms=[MODERATE])).patch(URL.format(rid=1), json={"status": "approved"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    assert _status_of(eng, 1) == ("approved", None)
    with _maker(eng)() as s:
        aud = s.query(CustomerAdminAuditLog).filter_by(
            action="review.moderate", outcome=AdminAuditOutcome.SUCCESS).all()
        assert len(aud) == 1
        assert aud[0].new_value["status"] == "approved" and "status" in aud[0].new_value["changed"]


def test_super_admin_is_allowed_on_patch(monkeypatch):
    eng = _engine()
    _seed_review(eng, rid=1, status="pending")
    monkeypatch.setattr(admin_reviews, "log_change", lambda *a, **k: None)
    r = _client(eng, _user(perms=[], role=UserRole.SUPER_ADMIN)).patch(
        URL.format(rid=1), json={"status": "approved"})
    assert r.status_code == 200, r.text
    assert _status_of(eng, 1)[0] == "approved"


def test_no_relevant_permission_is_denied_on_patch():
    eng = _engine()
    _seed_review(eng, rid=1)
    r = _client(eng, _user(perms=[])).patch(URL.format(rid=1), json={"status": "approved"})
    assert r.status_code == 403, r.text
    assert _status_of(eng, 1)[0] == "pending"


def test_unauthenticated_patch_is_401():
    eng = _engine()
    _seed_review(eng, rid=1)
    r = _anon_client(eng).patch(URL.format(rid=1), json={"status": "approved"},
                                headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401, r.text
    assert _status_of(eng, 1)[0] == "pending"


# --- approve / reject / reply all work under the moderate scope -------------
def test_approve_reject_and_reply_under_moderate_scope(monkeypatch):
    eng = _engine()
    _seed_review(eng, rid=1, status="pending", reply=None)
    monkeypatch.setattr(admin_reviews, "log_change", lambda *a, **k: None)
    client = _client(eng, _user(perms=[MODERATE]))

    assert client.patch(URL.format(rid=1), json={"status": "approved"}).json()["status"] == "approved"
    assert client.patch(URL.format(rid=1), json={"status": "rejected"}).json()["status"] == "rejected"
    body = client.patch(URL.format(rid=1), json={"admin_reply": "Thanks for the feedback."}).json()
    assert body["admin_reply"] == "Thanks for the feedback." and body["replied_at"] is not None
    assert _status_of(eng, 1) == ("rejected", "Thanks for the feedback.")


# --- the matrix: GET reads stay on the view scope ---------------------------
def test_view_only_can_read_list_and_detail():
    eng = _engine()
    _seed_review(eng, rid=1, status="approved")
    client = _client(eng, _user(perms=[VIEW]))
    assert client.get(LIST_URL).status_code == 200
    assert client.get(URL.format(rid=1)).status_code == 200


def test_moderate_without_view_cannot_read():
    """Matrix: a moderate-only operator may act (PATCH) but not browse (GET),
    because reads require the view scope — unchanged by this fix."""
    eng = _engine()
    _seed_review(eng, rid=1)
    client = _client(eng, _user(perms=[MODERATE]))
    assert client.get(LIST_URL).status_code == 403
    assert client.get(URL.format(rid=1)).status_code == 403


def test_view_plus_moderate_can_both_read_and_moderate(monkeypatch):
    eng = _engine()
    _seed_review(eng, rid=1, status="pending")
    monkeypatch.setattr(admin_reviews, "log_change", lambda *a, **k: None)
    client = _client(eng, _user(perms=[VIEW, MODERATE]))
    assert client.get(LIST_URL).status_code == 200
    assert client.patch(URL.format(rid=1), json={"status": "approved"}).status_code == 200


def test_reads_denied_without_view_and_unauth():
    eng = _engine()
    _seed_review(eng, rid=1)
    # no perms -> 403 on every read (analytics gate rejects before its query)
    noperm = _client(eng, _user(perms=[]))
    assert noperm.get(LIST_URL).status_code == 403
    assert noperm.get(URL.format(rid=1)).status_code == 403
    assert noperm.get(ANALYTICS_URL).status_code == 403
    # unauthenticated -> 401
    anon = _anon_client(eng)
    assert anon.get(LIST_URL, headers={"Authorization": "Bearer nope"}).status_code == 401
