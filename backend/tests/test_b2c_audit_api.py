"""Stage 2C — GET /api/admin/b2c-audit read API.

Real router, real rbac, seeded in-memory SQLite. ``get_db`` is overridden to the
seeded session and ``get_current_user`` to stub users; the ``require_scope`` gate
and the query/redaction run for real. The app fixture is NOT named ``app`` so the
pytest-flask plugin (present in some envs) does not hijack it.
"""
from __future__ import annotations

import datetime as dt

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import deps
from app.auth.rbac import P
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome, Base, CustomerAdminAuditLog
from app.models_v2 import User, UserRole
from app.routers import b2c_audit


def _mkuser(role: UserRole, *codes: str) -> User:
    return User(user_id=1, role=role, merchant_role=None, permissions=list(codes))


B2C_ADMIN = _mkuser(UserRole.CUSTOMER, P.B2C_AUDIT_VIEW)   # explicit grant, no B2B role
B2B_ADMIN = _mkuser(UserRole.ADMIN)                        # role default, NO b2c scope
SUPER = _mkuser(UserRole.SUPER_ADMIN)                      # everything (short-circuit)


def _seed(session) -> None:
    # Naive datetimes keep func.date() clean on SQLite; the column is tz-aware on PG.
    session.add_all([
        CustomerAdminAuditLog(
            admin_user_id=7, admin_email="a@x.com", admin_name="A", admin_role="admin",
            environment="b2c", action="refund.execute", entity_type="customer_refund_attempt",
            entity_id="101", outcome=AdminAuditOutcome.SUCCESS, retention_class="financial",
            new_value={"amount_minor": 500, "api_key": "live_should_be_hidden"},
            created_at=dt.datetime(2026, 11, 10, 9, 0),
        ),
        CustomerAdminAuditLog(
            admin_user_id=7, admin_email="a@x.com", admin_role="admin",
            environment="b2c", action="document.download", entity_type="chat_attachment",
            entity_id="55", outcome=AdminAuditOutcome.DENIED, retention_class="security",
            previous_value={"password": "nope", "city": "Pune"},
            created_at=dt.datetime(2026, 11, 11, 10, 0),
        ),
        CustomerAdminAuditLog(
            admin_user_id=9, admin_email="b@x.com", admin_role="manager",
            environment="b2c", action="customer.view_detail", entity_type="customer",
            entity_id="C-1", outcome=AdminAuditOutcome.SUCCESS, retention_class="security",
            created_at=dt.datetime(2026, 11, 12, 11, 0),
        ),
        CustomerAdminAuditLog(
            admin_user_id=9, admin_email="b@x.com", admin_role="manager",
            environment="b2c", action="report.export", entity_type="report",
            entity_id="R-9", outcome=AdminAuditOutcome.PARTIAL, retention_class="financial",
            created_at=dt.datetime(2026, 11, 12, 12, 0),
        ),
        CustomerAdminAuditLog(
            admin_user_id=9, admin_email="b@x.com", admin_role="manager",
            environment="b2c", action="refund.reconcile_finalize", entity_type="customer_refund_attempt",
            entity_id="102", outcome=AdminAuditOutcome.SUCCESS, retention_class="financial",
            created_at=dt.datetime(2026, 11, 12, 13, 0),
        ),
    ])
    session.commit()


@pytest.fixture()
def SessionLocal():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=[CustomerAdminAuditLog.__table__])
    maker = sessionmaker(bind=engine, expire_on_commit=False)
    s = maker()
    _seed(s)
    s.close()
    yield maker
    engine.dispose()


def _client(maker, user) -> TestClient:
    api = FastAPI()
    api.include_router(b2c_audit.router)

    def _db():
        s = maker()
        try:
            yield s
        finally:
            s.close()

    api.dependency_overrides[get_db] = _db
    if user is not None:
        api.dependency_overrides[deps.get_current_user] = lambda: user
    return TestClient(api, raise_server_exceptions=False)


URL = "/api/admin/b2c-audit"


# 1. Authorized B2C administrator ------------------------------------------------
def test_authorized_b2c_admin_sees_the_trail(SessionLocal):
    r = _client(SessionLocal, B2C_ADMIN).get(URL)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 5 and len(body["items"]) == 5
    assert body["items"][0]["action"] == "refund.reconcile_finalize"  # newest first


# 2. Unauthorized B2B administrator ---------------------------------------------
def test_b2b_only_admin_is_forbidden(SessionLocal):
    assert _client(SessionLocal, B2B_ADMIN).get(URL).status_code == 403


# 3. Unauthenticated -------------------------------------------------------------
def test_unauthenticated_is_rejected(SessionLocal):
    assert _client(SessionLocal, None).get(URL).status_code in (401, 403)


# 4. Pagination ------------------------------------------------------------------
def test_pagination(SessionLocal):
    c = _client(SessionLocal, SUPER)
    p1 = c.get(f"{URL}?page=1&page_size=2").json()
    assert p1["total"] == 5 and len(p1["items"]) == 2 and p1["total_pages"] == 3 and p1["page_size"] == 2
    p3 = c.get(f"{URL}?page=3&page_size=2").json()
    assert len(p3["items"]) == 1


# 5. Filters ---------------------------------------------------------------------
def test_filters(SessionLocal):
    c = _client(SessionLocal, SUPER)
    assert {i["action"] for i in c.get(f"{URL}?action=refund.execute").json()["items"]} == {"refund.execute"}
    assert c.get(f"{URL}?actor=9").json()["total"] == 3
    assert c.get(f"{URL}?entity_type=customer_refund_attempt").json()["total"] == 2
    assert c.get(f"{URL}?entity_id=101").json()["total"] == 1
    assert {i["outcome"] for i in c.get(f"{URL}?outcome=success").json()["items"]} == {"success"}


# 6. Date-range (valid filter + validation) -------------------------------------
def test_date_range(SessionLocal):
    c = _client(SessionLocal, SUPER)
    assert c.get(f"{URL}?date_from=2026-11-12&date_to=2026-11-12").json()["total"] == 3
    assert c.get(f"{URL}?date_from=2026-11-11&date_to=2026-11-12").json()["total"] == 4
    assert c.get(f"{URL}?date_from=2026-11-12&date_to=2026-11-10").status_code == 422


# 7. Sensitive-data redaction ----------------------------------------------------
def test_redaction(SessionLocal):
    c = _client(SessionLocal, SUPER)
    denied = c.get(f"{URL}?entity_id=55").json()["items"][0]
    assert denied["previous_value"]["password"] == "[redacted]"
    assert denied["previous_value"]["city"] == "Pune"
    refund = c.get(f"{URL}?entity_id=101").json()["items"][0]
    assert refund["new_value"]["api_key"] == "[redacted]"
    assert refund["new_value"]["amount_minor"] == 500


# 8. Empty results ---------------------------------------------------------------
def test_empty_results(SessionLocal):
    r = _client(SessionLocal, SUPER).get(f"{URL}?action=nothing.matches").json()
    assert r == {"items": [], "total": 0, "page": 1, "page_size": 50, "total_pages": 1}


# 9. Invalid filter values -------------------------------------------------------
def test_invalid_outcome_is_422(SessionLocal):
    assert _client(SessionLocal, SUPER).get(f"{URL}?outcome=bogus").status_code == 422
