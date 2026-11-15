"""Stage 2E — newly wired B2C admin audit events.

Covers the two write modes and a representative router end-to-end:
* ``record_in_session`` rides the caller's commit (atomic) and is the mode used
  by the wired state-changing + sensitive-read endpoints (catalogue, bookings,
  reviews, reports export, payment verify, customer/payment detail reads, chat
  claim/transfer/status).
* ``record_independently`` persists on its own session (used for FAILURE/DENIED
  and the sensitive reads that open no business txn).
Redaction and the four-outcome taxonomy are asserted directly.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import deps
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome, Base, CustomerAdminAuditLog
from app.models_v2 import User, UserRole
from app.services import customer_admin_audit_service as b2c_audit


def _sqlite_session(threadsafe: bool = False):
    # threadsafe=True for sessions a TestClient request thread will touch.
    kw = dict(connect_args={"check_same_thread": False}, poolclass=StaticPool) if threadsafe else {}
    engine = create_engine("sqlite://", **kw)
    Base.metadata.create_all(engine, tables=[CustomerAdminAuditLog.__table__])
    return sessionmaker(bind=engine, expire_on_commit=False)()


@pytest.fixture()
def session():
    s = _sqlite_session()
    try:
        yield s
    finally:
        s.close()


def _rows(session):
    return list(session.scalars(select(CustomerAdminAuditLog)).all())


# --- write modes -------------------------------------------------------------
def test_record_in_session_is_persisted_by_the_callers_commit(session):
    b2c_audit.record_in_session(
        session, admin=None, action="catalogue.update", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_hotel", entity_id=5,
    )
    session.commit()
    rows = _rows(session)
    assert len(rows) == 1 and rows[0].action == "catalogue.update"
    assert rows[0].outcome is AdminAuditOutcome.SUCCESS and rows[0].entity_id == "5"


def test_record_in_session_rolls_back_with_the_caller(session):
    # Atomicity: if the caller's transaction rolls back, the audit row goes too.
    b2c_audit.record_in_session(
        session, admin=None, action="catalogue.update", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_hotel", entity_id=7,
    )
    session.rollback()
    assert _rows(session) == []


def test_record_independently_persists_and_redacts(monkeypatch):
    maker_session = _sqlite_session()
    monkeypatch.setattr(b2c_audit, "SessionLocal", lambda: maker_session)
    # never-closed fake so we can read it back:
    monkeypatch.setattr(maker_session, "close", lambda: None)
    b2c_audit.record_independently(
        admin=None, action="report.preview", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="report", entity_id="payments",
        new={"password": "hunter2", "token": "abc", "rows": 5},
    )
    rows = _rows(maker_session)
    assert len(rows) == 1
    assert rows[0].new_value["password"] == "[redacted]"
    assert rows[0].new_value["token"] == "[redacted]"
    assert rows[0].new_value["rows"] == 5           # ordinary field kept


def test_four_outcomes_round_trip(session):
    for oc in (AdminAuditOutcome.SUCCESS, AdminAuditOutcome.FAILURE,
               AdminAuditOutcome.DENIED, AdminAuditOutcome.PARTIAL):
        b2c_audit.record_in_session(session, admin=None, action="payment.reconcile",
                                    outcome=oc, entity_type="payment", entity_id=str(oc.value))
    session.commit()
    assert {r.outcome for r in _rows(session)} == set(AdminAuditOutcome)


def test_actor_snapshot_is_captured_without_a_foreign_key(session):
    admin = User(user_id=42, role=UserRole.ADMIN, merchant_role=None,
                 permissions=[], full_name="Ops Admin", email="ops@example.test")
    b2c_audit.record_in_session(session, admin=admin, action="review.moderate",
                                outcome=AdminAuditOutcome.SUCCESS, entity_type="customer_review", entity_id=9)
    session.commit()
    row = _rows(session)[0]
    assert row.admin_user_id == 42 and row.admin_email == "ops@example.test"
    assert row.admin_role == "admin"                # enum value snapshot, not an FK


# --- representative router end-to-end (record_in_session before commit) ------
def test_catalogue_hotel_update_writes_an_audit_row(monkeypatch):
    from app.routers import admin_catalogue_hotels as hotels

    session = _sqlite_session(threadsafe=True)
    monkeypatch.setattr(hotels, "log_change", lambda *a, **k: None)   # skip the B2B system_logs write
    monkeypatch.setattr(hotels.service, "update_hotel",
                        lambda db, hotel_id, data: ({"name": "Test Hotel"}, ["city"]))

    app = FastAPI()
    app.include_router(hotels.router)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=1, role=UserRole.ADMIN, merchant_role=None,
        permissions=["b2c.catalogue.manage"], full_name="Cat Admin", email="cat@example.test",
    )
    client = TestClient(app, raise_server_exceptions=False)

    client.patch("/api/admin/catalogue/hotels/5", json={"city": "Goa"})
    # The audit row is written in the handler (record_in_session → db.commit)
    # BEFORE response serialization, so it is present even though the stubbed
    # detail does not satisfy the HotelDetail response_model. Its presence proves
    # the audit fired and committed (an audit-insert failure would leave no row).
    rows = _rows(session)
    assert len(rows) == 1
    assert rows[0].action == "catalogue.update" and rows[0].entity_type == "customer_hotel"
    assert rows[0].entity_id == "5" and rows[0].outcome is AdminAuditOutcome.SUCCESS


def test_chat_attachment_send_denied_records_a_denied_event(monkeypatch):
    from app.routers import admin_chat
    from app.auth.rate_limit import limiter

    audit_sink = _sqlite_session(threadsafe=True)
    monkeypatch.setattr(audit_sink, "close", lambda: None)
    monkeypatch.setattr(b2c_audit, "SessionLocal", lambda: audit_sink)  # independent writes land here
    monkeypatch.setattr(limiter, "enabled", False)

    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(admin_chat.router)
    app.dependency_overrides[get_db] = lambda: _sqlite_session(threadsafe=True)
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=3, role=UserRole.ADMIN, merchant_role=None,
        permissions=[], full_name="B2B Only", email="b2b@example.test",   # no b2c.*
    )
    client = TestClient(app, raise_server_exceptions=False)
    r = client.post("/api/admin/chat/conversations/9/attachments",
                    files={"file": ("x.png", b"\x89PNG", "image/png")})
    assert r.status_code == 403
    rows = _rows(audit_sink)
    assert len(rows) == 1 and rows[0].action == "chat.attachment_send"
    assert rows[0].outcome is AdminAuditOutcome.DENIED and rows[0].entity_id == "9"


# --- Task 3: writer-failure / atomicity guarantees --------------------------
def test_failed_success_audit_propagates_so_the_business_commit_cannot_proceed(session, monkeypatch):
    # record_in_session MUST NOT swallow: a failed audit insert raises, so the
    # endpoint never reaches its db.commit() and the business change is not saved.
    session.add(CustomerAdminAuditLog(action="business.row", outcome=AdminAuditOutcome.SUCCESS,
                                      entity_type="x", environment="b2c"))
    monkeypatch.setattr(b2c_audit, "build_entry", lambda **k: (_ for _ in ()).throw(RuntimeError("audit boom")))
    with pytest.raises(RuntimeError):
        b2c_audit.record_in_session(session, admin=None, action="catalogue.update",
                                    outcome=AdminAuditOutcome.SUCCESS, entity_type="customer_hotel", entity_id=1)
    session.rollback()                       # the real endpoint's commit is never reached
    assert _rows(session) == []              # neither the business row nor an audit row survived


def test_independent_write_does_not_commit_the_callers_pending_change(session, monkeypatch):
    sink = _sqlite_session()
    monkeypatch.setattr(sink, "close", lambda: None)
    monkeypatch.setattr(b2c_audit, "SessionLocal", lambda: sink)
    # The caller's session has an uncommitted business row.
    session.add(CustomerAdminAuditLog(action="pending.business", outcome=AdminAuditOutcome.SUCCESS,
                                      entity_type="x", environment="b2c"))
    b2c_audit.record_independently(admin=None, action="report.preview",
                                   outcome=AdminAuditOutcome.SUCCESS, entity_type="report", entity_id="p")
    # The independent write committed ONLY its own row on its own session…
    assert [r.action for r in _rows(sink)] == ["report.preview"]
    # …and did not reach into or commit the caller's pending change.
    session.rollback()
    assert _rows(session) == []


def test_record_independently_never_raises_into_the_business_path(monkeypatch):
    # FAILURE/DENIED writes must not break the response if the audit DB is down.
    def _boom():
        raise RuntimeError("audit db unreachable")
    monkeypatch.setattr(b2c_audit, "SessionLocal", _boom)
    # Must return None without raising (logged + swallowed).
    assert b2c_audit.record_independently(
        admin=None, action="document.download", outcome=AdminAuditOutcome.FAILURE,
        entity_type="chat_attachment", entity_id="1") is None


def test_request_id_flows_from_contextvar_into_the_audit_row(session):
    from app.services import activity_service
    activity_service.bind_request({"request_id": "req-abc-123", "ip_address": "1.2.3.4",
                                   "browser": "Chrome", "device": "desktop"})
    try:
        b2c_audit.record_in_session(session, admin=None, action="customer.view_detail",
                                    outcome=AdminAuditOutcome.SUCCESS, entity_type="customer", entity_id=5)
        session.commit()
    finally:
        activity_service.bind_request(None)
    row = _rows(session)[0]
    assert row.request_id == "req-abc-123" and row.ip_address == "1.2.3.4"


def test_system_logs_dual_write_is_preserved(monkeypatch):
    # The existing log_change (system_logs) call must still fire alongside the new audit.
    from app.routers import admin_catalogue_hotels as hotels

    session = _sqlite_session(threadsafe=True)
    calls = {"log_change": 0}
    monkeypatch.setattr(hotels, "log_change", lambda *a, **k: calls.__setitem__("log_change", calls["log_change"] + 1))
    monkeypatch.setattr(hotels.service, "update_hotel", lambda db, hotel_id, data: ({"name": "H"}, ["city"]))
    app = FastAPI()
    app.include_router(hotels.router)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=1, role=UserRole.ADMIN, merchant_role=None,
        permissions=["b2c.catalogue.manage"], full_name="Cat", email="cat@example.test")
    TestClient(app, raise_server_exceptions=False).patch("/api/admin/catalogue/hotels/5", json={"city": "Goa"})
    assert calls["log_change"] == 1          # system_logs dual-write intact
    assert len(_rows(session)) == 1          # and the new B2C audit row written


def test_catalogue_update_is_denied_without_the_b2c_scope():
    from app.routers import admin_catalogue_hotels as hotels

    session = _sqlite_session(threadsafe=True)
    app = FastAPI()
    app.include_router(hotels.router)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=2, role=UserRole.ADMIN, merchant_role=None,
        permissions=[], full_name="B2B Only", email="b2b@example.test",   # no b2c.*
    )
    client = TestClient(app, raise_server_exceptions=False)
    r = client.patch("/api/admin/catalogue/hotels/5", json={"city": "Goa"})
    assert r.status_code == 403            # require_scope refuses; no row written
    assert _rows(session) == []
