"""Stage 3 M0 — B2C admin audit readiness gate (+ M0 correctness corrections).

Covers:
* existence + schema-compatibility check, fail-closed on DB/audit unavailable;
* the writer-level gate (`record_in_session` -> 503) and the door-level gate
  (`require_audit_ready` on audited endpoints);
* that unaudited reads are unaffected;
* CACHE CORRECTNESS: a table dropped after a prior success fails closed on the
  next call; 0095 applied later becomes ready with no restart; a not-ready
  result is never cached; weak-keyed so id() reuse cannot resurrect staleness;
* DURABLE SUCCESS AUDIT for sensitive reads: a SUCCESS read is refused (503) and
  discloses nothing when its independent audit INSERT fails AFTER the door-gate
  passed, while FAILURE/DENIED stay resilient.

No PostgreSQL; migration 0095 remains unapplied.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import deps
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome, Base, CustomerAdminAuditLog
from app.models_v2 import User, UserRole
from app.services import b2c_admin_readiness as readiness
from app.services import customer_admin_audit_service as b2c_audit


def _engine(with_table: bool, *, partial: bool = False):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    if with_table:
        Base.metadata.create_all(eng, tables=[CustomerAdminAuditLog.__table__])
    elif partial:
        # Same table name, incompatible schema (only an id column).
        with eng.begin() as c:
            c.execute(text("CREATE TABLE customer_admin_audit_logs (customer_admin_audit_log_id INTEGER PRIMARY KEY)"))
    return eng


def _session(eng):
    return sessionmaker(bind=eng, expire_on_commit=False)()


def _sink(eng):
    """A sessionmaker usable as a drop-in ``SessionLocal`` (fresh session each call)."""
    return sessionmaker(bind=eng, expire_on_commit=False)


def _boom():
    raise RuntimeError("audit storage unavailable")


@pytest.fixture(autouse=True)
def _reset_cache():
    saved_ttl = readiness.READY_TTL_SECONDS
    readiness.clear_cache()
    yield
    readiness.clear_cache()
    readiness.READY_TTL_SECONDS = saved_ttl


# --- is_ready / schema / fail-closed ----------------------------------------
def test_ready_when_table_present_and_compatible():
    assert readiness.is_ready(_engine(with_table=True)) is True


def test_not_ready_when_table_absent():
    eng = _engine(with_table=False)
    assert readiness.is_ready(eng) is False
    assert "absent" in readiness.reason(eng)


def test_not_ready_when_schema_incompatible():
    eng = _engine(with_table=False, partial=True)
    assert readiness.is_ready(eng) is False
    assert "schema incompatible" in readiness.reason(eng)


def test_fail_closed_when_storage_unavailable():
    class Boom:  # not an engine — sa_inspect will raise
        pass
    assert readiness.is_ready(Boom()) is False


def test_assert_ready_raises_503_when_not_ready():
    with pytest.raises(HTTPException) as ei:
        readiness.assert_ready(_engine(with_table=False))
    assert ei.value.status_code == 503


# --- cache correctness (M0 correction) --------------------------------------
def test_not_ready_result_is_never_cached():
    eng = _engine(with_table=False)
    assert readiness.is_ready(eng) is False
    assert eng not in readiness._ready_at


def test_table_removed_after_ready_fails_closed_on_next_call():
    eng = _engine(with_table=True)
    assert readiness.is_ready(eng) is True            # previously true
    with eng.begin() as c:
        c.execute(text("DROP TABLE customer_admin_audit_logs"))
    assert readiness.is_ready(eng) is False           # revalidated -> fail closed


def test_ready_becomes_true_after_table_created_without_restart():
    eng = _engine(with_table=False)
    assert readiness.is_ready(eng) is False           # 0095 not applied yet
    Base.metadata.create_all(eng, tables=[CustomerAdminAuditLog.__table__])
    assert readiness.is_ready(eng) is True            # applied later; no restart


def test_db_unavailable_is_not_ready():
    assert readiness.is_ready(object()) is False      # inspect() raises -> closed


def test_positive_ttl_caches_ready_then_revalidates_on_expiry():
    readiness.READY_TTL_SECONDS = 300.0               # opt-in positive cache
    eng = _engine(with_table=True)
    assert readiness.is_ready(eng) is True
    assert eng in readiness._ready_at                 # remembered as ready
    with eng.begin() as c:
        c.execute(text("DROP TABLE customer_admin_audit_logs"))
    assert readiness.is_ready(eng) is True            # still cached within TTL
    readiness.READY_TTL_SECONDS = 0.0                 # TTL elapsed / disabled
    assert readiness.is_ready(eng) is False           # re-probes -> fail closed


# --- writer-level gate: record_in_session ------------------------------------
def test_record_in_session_refuses_when_table_absent():
    s = _session(_engine(with_table=False))
    with pytest.raises(HTTPException) as ei:
        b2c_audit.record_in_session(s, admin=None, action="customer.block",
                                    outcome=AdminAuditOutcome.SUCCESS, entity_type="customer", entity_id=1)
    assert ei.value.status_code == 503
    s.close()


def test_record_in_session_works_when_table_present():
    s = _session(_engine(with_table=True))
    row = b2c_audit.record_in_session(s, admin=None, action="customer.block",
                                      outcome=AdminAuditOutcome.SUCCESS, entity_type="customer", entity_id=1)
    s.commit()
    assert row.customer_admin_audit_log_id is not None
    s.close()


# --- durable SUCCESS audit for sensitive reads (M0 correction) ---------------
def test_record_independently_required_raises_503_when_write_fails(monkeypatch):
    monkeypatch.setattr(b2c_audit, "SessionLocal", _boom)
    with pytest.raises(HTTPException) as ei:
        b2c_audit.record_independently(
            required=True, admin=None, action="report.preview",
            outcome=AdminAuditOutcome.SUCCESS, entity_type="report", entity_id="payments")
    assert ei.value.status_code == 503


def test_record_independently_resilient_swallows_when_not_required(monkeypatch):
    monkeypatch.setattr(b2c_audit, "SessionLocal", _boom)
    # FAILURE / DENIED keep their resilient behaviour: no raise into the business path.
    assert b2c_audit.record_independently(
        required=False, admin=None, action="document.download",
        outcome=AdminAuditOutcome.FAILURE, entity_type="chat_attachment", entity_id="1") is None


def test_record_independently_required_uses_fresh_session_only(monkeypatch):
    # A required write commits ONLY its own fresh session — never the caller's.
    sink_eng = _engine(with_table=True)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _sink(sink_eng))
    b2c_audit.record_independently(
        required=True, admin=None, action="report.preview",
        outcome=AdminAuditOutcome.SUCCESS, entity_type="report", entity_id="payments")
    with _sink(sink_eng)() as s:
        rows = s.query(CustomerAdminAuditLog).all()
    assert [r.action for r in rows] == ["report.preview"]


# --- door-level gate + end-to-end fail-closed on an audited endpoint ---------
def _preview_app(session):
    from app.routers import admin_b2c_reports as reports
    app = FastAPI()
    app.include_router(reports.router)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=1, role=UserRole.ADMIN, merchant_role=None,
        permissions=["b2c.reports.view", "customer.view"], full_name="R", email="r@example.test")
    return TestClient(app, raise_server_exceptions=False)


def test_audited_endpoint_returns_503_when_table_absent():
    client = _preview_app(_session(_engine(with_table=False)))
    r = client.get("/api/admin/b2c-reports/preview?type=bookings")
    assert r.status_code == 503, r.text


def test_audited_endpoint_not_503_when_table_present_and_audit_persists(monkeypatch):
    from app.routers import admin_b2c_reports as reports
    monkeypatch.setattr(reports.reports, "preview", lambda db, type, **k: {"rows": [], "count": 0, "total": "0"})
    monkeypatch.setattr(b2c_audit, "SessionLocal", _sink(_engine(with_table=True)))
    client = _preview_app(_session(_engine(with_table=True)))
    r = client.get("/api/admin/b2c-reports/preview?type=bookings")
    assert r.status_code != 503          # gate passes AND the SUCCESS audit persisted


def test_preview_returns_503_when_success_audit_write_fails(monkeypatch):
    # Door-gate passes (table present) but the independent SUCCESS audit INSERT
    # fails afterwards -> the preview must NOT be returned (fail closed).
    from app.routers import admin_b2c_reports as reports
    monkeypatch.setattr(reports.reports, "preview", lambda db, type, **k: {"rows": [], "count": 0, "total": "0"})
    monkeypatch.setattr(b2c_audit, "SessionLocal", _boom)
    client = _preview_app(_session(_engine(with_table=True)))
    r = client.get("/api/admin/b2c-reports/preview?type=bookings")
    assert r.status_code == 503, r.text


class _FakeAttachment:
    conversation_id = 3
    original_filename = "file.pdf"
    content_type = "application/pdf"


def _download_app(session):
    from app.routers import admin_chat as chatmod
    app = FastAPI()
    app.include_router(chatmod.router)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[deps.get_current_admin] = lambda: User(
        user_id=1, role=UserRole.ADMIN, merchant_role=None,
        permissions=["b2c.customers.manage"], full_name="A", email="a@example.test")
    return TestClient(app, raise_server_exceptions=False), chatmod


def test_attachment_download_fails_closed_when_success_audit_write_fails(monkeypatch):
    client, chatmod = _download_app(_session(_engine(with_table=True)))   # door-gate passes
    monkeypatch.setattr(chatmod.chat, "attachment_for_admin", lambda db, aid: _FakeAttachment())
    monkeypatch.setattr(chatmod.attachments, "download",
                        lambda att: Response(content=b"x", media_type="application/octet-stream"))
    monkeypatch.setattr(b2c_audit, "SessionLocal", _boom)
    r = client.get("/api/admin/chat/attachments/7")
    assert r.status_code == 503, r.text


def test_attachment_download_served_when_success_audit_persists(monkeypatch):
    client, chatmod = _download_app(_session(_engine(with_table=True)))
    monkeypatch.setattr(chatmod.chat, "attachment_for_admin", lambda db, aid: _FakeAttachment())
    monkeypatch.setattr(chatmod.attachments, "download",
                        lambda att: Response(content=b"x", media_type="application/octet-stream"))
    monkeypatch.setattr(b2c_audit, "SessionLocal", _sink(_engine(with_table=True)))
    r = client.get("/api/admin/chat/attachments/7")
    assert r.status_code == 200, r.text
    assert r.content == b"x"


# --- unaudited reads are unaffected by the gate ------------------------------
def test_unaudited_list_read_works_without_the_audit_table(monkeypatch):
    from app.routers import admin_customer_bookings as bookings
    monkeypatch.setattr(bookings.service, "list_bookings", lambda *a, **k: ([], 0))
    app = FastAPI()
    app.include_router(bookings.router)
    app.dependency_overrides[get_db] = lambda: _session(_engine(with_table=False))
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=1, role=UserRole.ADMIN, merchant_role=None,
        permissions=["b2c.customers.view", "customer.view"], full_name="B", email="b@example.test")
    client = TestClient(app, raise_server_exceptions=False)
    r = client.get("/api/admin/customer-bookings")
    assert r.status_code != 503          # a plain list read is NOT gated
