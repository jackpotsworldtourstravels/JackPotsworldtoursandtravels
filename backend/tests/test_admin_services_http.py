"""HTTP-level tests for Phase 1 Service Management.

Covers, on an isolated temp-file SQLite stack with the real routers, services
and RBAC dependency:

  * admin desk access control: 401 anon, 403 without a services scope (incl. a
    role=admin holding only other B2C scopes), 200 for an explicit view/manage
    grant and for a super admin;
  * PATCH is write-gated: view-only is 403, manage succeeds, and a successful
    write lands a B2C admin-audit row atomically with the change;
  * ``code`` is immutable and unknown fields are rejected (schema extra=forbid);
  * the PUBLIC feed (`GET /api/services`) shows only enabled + nav-visible
    services, in order, and never leaks admin-only columns;
  * the enforcement dependency used by search / new-booking endpoints: enabled
    → 200, disabled → 403, maintenance → 503, and a service with NO registry
    row fails OPEN (existing production flow preserved).
"""
from __future__ import annotations

import os
import tempfile

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.auth import deps as auth_deps
from app.auth.rbac import P
from app.database.session import get_db
from app.models_customer import Base, CustomerAdminAuditLog, ServiceRegistry
from app.models_v2 import User, UserRole
from app.routers import admin_services, public
from app.services import service_registry_service as registry

_TABLES = [ServiceRegistry.__table__, CustomerAdminAuditLog.__table__]
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


def _seed(eng, rows):
    with _maker(eng)() as s:
        for i, (code, kw) in enumerate(rows):
            s.add(ServiceRegistry(
                service_registry_id=100 + i,
                code=code,
                name=kw.get("name", code.title()),
                href=kw.get("href", f"/{code}"),
                icon=kw.get("icon", code),
                enabled=kw.get("enabled", True),
                nav_visible=kw.get("nav_visible", True),
                home_visible=kw.get("home_visible", False),
                nav_order=kw.get("nav_order", (i + 1) * 10),
                maintenance_mode=kw.get("maintenance_mode", False),
                maintenance_message=kw.get("maintenance_message"),
                integration_status=kw.get("integration_status", "preview"),
                provider=kw.get("provider"),
            ))
        s.commit()


def _user(*, perms, role=UserRole.ADMIN):
    return User(user_id=1, role=role, merchant_role=None, permissions=list(perms),
                full_name="Admin", email="admin@example.test")


def _admin_client(eng, user):
    app = FastAPI()
    app.include_router(admin_services.router)
    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[auth_deps.get_current_user] = lambda: user
    return TestClient(app, raise_server_exceptions=False)


def _anon_client(eng):
    app = FastAPI()
    app.include_router(admin_services.router)
    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    return TestClient(app, raise_server_exceptions=False)


def _public_client(eng):
    app = FastAPI()
    app.include_router(public.router)
    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    return TestClient(app, raise_server_exceptions=False)


def _audit_count(eng):
    with _maker(eng)() as s:
        return s.scalar(select(func.count()).select_from(CustomerAdminAuditLog)) or 0


# ------------------------------------------------------------- admin access
def test_list_requires_auth():
    eng = _engine()
    _seed(eng, [("flights", {})])
    r = _anon_client(eng).get("/api/admin/services", headers={"Authorization": "Bearer bogus"})
    assert r.status_code == 401


def test_list_forbidden_without_services_scope():
    eng = _engine()
    _seed(eng, [("flights", {})])
    # role=admin, but only an unrelated B2C scope → no services access.
    r = _admin_client(eng, _user(perms=[P.B2C_CUSTOMERS_VIEW])).get("/api/admin/services")
    assert r.status_code == 403


@pytest.mark.parametrize("perms,role", [
    ([P.B2C_SERVICES_VIEW], UserRole.ADMIN),
    ([P.B2C_SERVICES_MANAGE], UserRole.ADMIN),
    ([], UserRole.SUPER_ADMIN),
])
def test_list_allowed(perms, role):
    eng = _engine()
    _seed(eng, [("flights", {"nav_order": 10}), ("hotels", {"nav_order": 20})])
    r = _admin_client(eng, _user(perms=perms, role=role)).get("/api/admin/services")
    assert r.status_code == 200
    assert [s["code"] for s in r.json()] == ["flights", "hotels"]


# ------------------------------------------------------------- admin writes
def test_patch_forbidden_for_view_only():
    eng = _engine()
    _seed(eng, [("flights", {})])
    r = _admin_client(eng, _user(perms=[P.B2C_SERVICES_VIEW])).patch(
        "/api/admin/services/flights", json={"enabled": False})
    assert r.status_code == 403
    assert _audit_count(eng) == 0


def test_patch_disables_and_writes_audit():
    eng = _engine()
    _seed(eng, [("flights", {"enabled": True})])
    client = _admin_client(eng, _user(perms=[P.B2C_SERVICES_MANAGE]))
    r = client.patch("/api/admin/services/flights", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    # The change persisted and is audited.
    with _maker(eng)() as s:
        assert s.scalar(select(ServiceRegistry.enabled).where(ServiceRegistry.code == "flights")) in (False, 0)
    assert _audit_count(eng) == 1


def test_patch_code_is_immutable_rejected():
    eng = _engine()
    _seed(eng, [("flights", {})])
    r = _admin_client(eng, _user(perms=[P.B2C_SERVICES_MANAGE])).patch(
        "/api/admin/services/flights", json={"code": "hacked"})
    assert r.status_code == 422  # extra="forbid"


def test_patch_unknown_integration_status_rejected():
    eng = _engine()
    _seed(eng, [("flights", {})])
    r = _admin_client(eng, _user(perms=[P.B2C_SERVICES_MANAGE])).patch(
        "/api/admin/services/flights", json={"integration_status": "totally-live"})
    assert r.status_code == 422


def test_patch_empty_body_is_400():
    eng = _engine()
    _seed(eng, [("flights", {})])
    r = _admin_client(eng, _user(perms=[P.B2C_SERVICES_MANAGE])).patch(
        "/api/admin/services/flights", json={})
    assert r.status_code == 400


def test_patch_unknown_service_is_404():
    eng = _engine()
    _seed(eng, [("flights", {})])
    r = _admin_client(eng, _user(perms=[P.B2C_SERVICES_MANAGE])).patch(
        "/api/admin/services/nope", json={"enabled": False})
    assert r.status_code == 404


def test_reorder_sets_order():
    eng = _engine()
    _seed(eng, [("flights", {"nav_order": 10}), ("hotels", {"nav_order": 20}), ("visa", {"nav_order": 30})])
    client = _admin_client(eng, _user(perms=[P.B2C_SERVICES_MANAGE]))
    r = client.post("/api/admin/services/reorder", json={"codes": ["visa", "flights", "hotels"]})
    assert r.status_code == 200
    assert [s["code"] for s in r.json()] == ["visa", "flights", "hotels"]


# --------------------------------------------------------------- public feed
def test_public_feed_filters_and_orders():
    eng = _engine()
    _seed(eng, [
        ("flights", {"nav_order": 10}),
        ("hotels", {"nav_order": 20, "enabled": False}),      # hidden
        ("buses", {"nav_order": 30, "nav_visible": False}),    # hidden
        ("visa", {"nav_order": 40, "maintenance_mode": True}), # shown, flagged
    ])
    r = _public_client(eng).get("/api/services")
    assert r.status_code == 200
    body = r.json()
    assert [s["code"] for s in body] == ["flights", "visa"]
    assert body[1]["maintenance_mode"] is True
    assert "enabled" not in body[0]  # admin-only column not leaked


# --------------------------------------------------------------- enforcement
def _gate_client(eng):
    """A minimal app wearing the real search/booking gate for 'flights'."""
    app = FastAPI()

    @app.get("/flights/search", dependencies=[Depends(registry.require_service_available("flights"))])
    def _search():
        return {"ok": True}

    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    return TestClient(app, raise_server_exceptions=False)


def test_gate_allows_enabled_service():
    eng = _engine()
    _seed(eng, [("flights", {"enabled": True})])
    assert _gate_client(eng).get("/flights/search").status_code == 200


def test_gate_blocks_disabled_service():
    eng = _engine()
    _seed(eng, [("flights", {"enabled": False})])
    assert _gate_client(eng).get("/flights/search").status_code == 403


def test_gate_blocks_service_in_maintenance():
    eng = _engine()
    _seed(eng, [("flights", {"maintenance_mode": True})])
    assert _gate_client(eng).get("/flights/search").status_code == 503


def test_gate_fails_open_when_service_row_absent():
    eng = _engine()
    _seed(eng, [("hotels", {})])  # no 'flights' row at all
    assert _gate_client(eng).get("/flights/search").status_code == 200
