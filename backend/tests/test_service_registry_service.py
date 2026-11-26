"""Unit tests for the customer-facing service registry service layer and its
enforcement helpers (``app/services/service_registry_service.py``).

In-memory SQLite with only the ``service_registry`` table — these exercise the
pure read/write/enforcement logic, no HTTP, no auth. The HTTP surface (RBAC,
audit, the public feed and the booking gate) is covered in
``test_admin_services_http.py``.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models_customer import Base, ServiceRegistry
from app.services import service_registry_service as registry


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[ServiceRegistry.__table__])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _svc(db, code, **kw):
    row = ServiceRegistry(
        code=code,
        name=kw.get("name", code.title()),
        href=kw.get("href", f"/{code}"),
        icon=kw.get("icon", code),
        enabled=kw.get("enabled", True),
        nav_visible=kw.get("nav_visible", True),
        home_visible=kw.get("home_visible", False),
        nav_order=kw.get("nav_order", 10),
        maintenance_mode=kw.get("maintenance_mode", False),
        maintenance_message=kw.get("maintenance_message"),
        integration_status=kw.get("integration_status", "preview"),
        provider=kw.get("provider"),
    )
    db.add(row)
    db.flush()
    return row


# ------------------------------------------------------------------ reads
def test_list_all_ordered_by_nav_order(db):
    _svc(db, "hotels", nav_order=20)
    _svc(db, "flights", nav_order=10)
    _svc(db, "visa", nav_order=30)
    codes = [r.code for r in registry.list_all(db)]
    assert codes == ["flights", "hotels", "visa"]


def test_get_by_code_is_case_insensitive_and_trims(db):
    _svc(db, "flights")
    assert registry.get_by_code(db, "  FLIGHTS ") is not None
    assert registry.get_by_code(db, "nope") is None


# -------------------------------------------------------------- public feed
def test_public_services_hides_disabled_and_nav_hidden(db):
    _svc(db, "flights", nav_order=10)
    _svc(db, "hotels", nav_order=20, enabled=False)          # disabled → omitted
    _svc(db, "buses", nav_order=30, nav_visible=False)        # not in nav → omitted
    _svc(db, "visa", nav_order=40, maintenance_mode=True)     # maintenance → still listed
    codes = [s["code"] for s in registry.public_services(db)]
    assert codes == ["flights", "visa"]


def test_public_services_payload_shape(db):
    _svc(db, "flights", maintenance_mode=True, maintenance_message="Back soon", integration_status="live")
    row = registry.public_services(db)[0]
    assert row["code"] == "flights"
    assert row["maintenance_mode"] is True
    assert row["maintenance_message"] == "Back soon"
    assert row["integration_status"] == "live"
    # The public feed must not leak admin-only columns.
    assert "enabled" not in row and "provider" not in row


# -------------------------------------------------------------- enforcement
def test_availability_available(db):
    _svc(db, "flights")
    assert registry.availability(db, "flights") == (registry.AVAILABLE, None)


def test_availability_disabled(db):
    _svc(db, "flights", enabled=False)
    state, msg = registry.availability(db, "flights")
    assert state == registry.DISABLED and msg


def test_availability_maintenance_uses_custom_message(db):
    _svc(db, "flights", maintenance_mode=True, maintenance_message="Scheduled upgrade")
    state, msg = registry.availability(db, "flights")
    assert state == registry.MAINTENANCE and msg == "Scheduled upgrade"


def test_availability_missing_row_fails_open(db):
    # No row for this service at all → never take a working flow down.
    assert registry.availability(db, "flights") == (registry.AVAILABLE, None)


def test_assert_available_raises_403_when_disabled(db):
    _svc(db, "flights", enabled=False)
    with pytest.raises(HTTPException) as exc:
        registry.assert_available(db, "flights")
    assert exc.value.status_code == 403


def test_assert_available_raises_503_when_maintenance(db):
    _svc(db, "flights", maintenance_mode=True)
    with pytest.raises(HTTPException) as exc:
        registry.assert_available(db, "flights")
    assert exc.value.status_code == 503


def test_assert_available_passes_when_enabled(db):
    _svc(db, "flights")
    registry.assert_available(db, "flights")  # no raise


# ----------------------------------------------------------------- writes
def test_update_service_partial_and_immutable_code(db):
    _svc(db, "flights", name="Flights")
    row = registry.update_service(db, "flights", {"name": "Air Travel", "enabled": False, "code": "hacked"})
    assert row.name == "Air Travel"
    assert row.enabled is False
    assert row.code == "flights"  # code is not in the updatable set


def test_update_service_unknown_code_returns_none(db):
    assert registry.update_service(db, "nope", {"name": "X"}) is None


def test_set_order_renumbers_by_position(db):
    _svc(db, "flights", nav_order=10)
    _svc(db, "hotels", nav_order=20)
    _svc(db, "visa", nav_order=30)
    registry.set_order(db, ["visa", "flights", "hotels"])
    by_code = {r.code: r.nav_order for r in registry.list_all(db)}
    assert by_code["visa"] == 10
    assert by_code["flights"] == 20
    assert by_code["hotels"] == 30
    assert [r.code for r in registry.list_all(db)] == ["visa", "flights", "hotels"]
