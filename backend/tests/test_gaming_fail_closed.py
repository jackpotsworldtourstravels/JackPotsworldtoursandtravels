"""Stage 1A — Gaming Tour Packages are fail-closed.

The enforcement is on the SERVER, not the admin screen hiding a link: a missing,
empty, invalid or explicitly-false configuration leaves Gaming disabled, and
every gaming route (public submission and admin queue) answers 404 while it is.
Only an explicit truthy value turns it on. No real DB is used — the router gate
and the service guard are what we exercise, with the service mocked on the
enabled path (its real create() allocates a Postgres sequence).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import deps
from app.auth.rate_limit import limiter
from app.auth.rbac import P
from app.config import settings
from app.models_v2 import User, UserRole
from app.routers import gaming_tour_enquiries as gaming
from app.services import gaming_tour_enquiry_service as service

VALID_ENQUIRY = {
    "name": "Test User",
    "email": "test@example.com",
    "mobile": "+91 9876543210",
    "from_airport": "HYD",
    "to_airport": "BKK",
    "travel_datetime": "2027-01-01T10:00:00Z",
    "number_of_nights": 3,
    "casino_type": "Poker, Blackjack",
}

DISABLED_VALUES = [None, "", "   ", "false", "FALSE", "False", "0", "no", "off", "banana", "2", "tru"]
ENABLED_VALUES = ["true", "TRUE", "True", " true ", "1", "yes", "on"]

PUBLIC = "/api/customer/gaming-tour-enquiries"
ADMIN_LIST = "/api/admin/gaming-tour-enquiries"
ADMIN_DETAIL = "/api/admin/gaming-tour-enquiries/1"


def _set_flag(monkeypatch, value):
    monkeypatch.setattr(settings, "gaming_tour_packages_enabled", value, raising=False)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(gaming.router)
    # Admin auth always "succeeds" so the ONLY thing that can 404 an admin route
    # is the fail-closed gate, never a missing session. The admin gaming routes
    # now gate on require(P.GAMING_ENQUIRY_MANAGE), which resolves the caller via
    # get_current_user; a super admin short-circuits the permission check, so we
    # override both dependencies to the same super-admin.
    def _su():
        # Holds gaming.enquiry.manage so require() passes and the ONLY thing that
        # can 404 an admin route is the fail-closed gate (SUPER_ADMIN is not
        # all-powerful here, so it would be refused the granular code).
        return User(user_id=1, role=UserRole.ADMIN, merchant_role=None,
                    permissions=[P.GAMING_ENQUIRY_MANAGE])

    app.dependency_overrides[deps.get_current_admin] = _su
    app.dependency_overrides[deps.get_current_user] = _su
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# The fail-closed property in isolation
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("value", DISABLED_VALUES)
def test_property_is_disabled_for_missing_empty_or_invalid(monkeypatch, value):
    _set_flag(monkeypatch, value)
    assert settings.gaming_enabled is False


@pytest.mark.parametrize("value", ENABLED_VALUES)
def test_property_is_enabled_only_for_explicit_truthy(monkeypatch, value):
    _set_flag(monkeypatch, value)
    assert settings.gaming_enabled is True


# ---------------------------------------------------------------------------
# The API gate — disabled
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("value", DISABLED_VALUES)
def test_public_submission_blocked_when_disabled(client, monkeypatch, value):
    _set_flag(monkeypatch, value)
    r = client.post(PUBLIC, json=VALID_ENQUIRY)
    assert r.status_code == 404, r.text


@pytest.mark.parametrize("path", [ADMIN_LIST, ADMIN_DETAIL])
def test_admin_routes_blocked_when_disabled(client, monkeypatch, path):
    _set_flag(monkeypatch, "false")
    assert client.get(path).status_code == 404


def test_direct_url_cannot_bypass_when_disabled(client, monkeypatch):
    # An authenticated admin hitting the detail route directly still gets 404.
    _set_flag(monkeypatch, None)
    assert client.get(ADMIN_DETAIL).status_code == 404
    assert client.patch(ADMIN_DETAIL, json={"status": "ASSIGNED"}).status_code == 404


# ---------------------------------------------------------------------------
# The API gate — enabled (service mocked; no DB)
# ---------------------------------------------------------------------------
def test_public_submission_allowed_when_explicitly_enabled(client, monkeypatch):
    _set_flag(monkeypatch, "true")

    class _Row:
        enquiry_reference = "GT-20270101-000001"

    monkeypatch.setattr(service, "create", lambda db, payload: _Row())
    monkeypatch.setattr(gaming.email_service, "send_gaming_tour_enquiry_email", lambda *a, **k: True)
    r = client.post(PUBLIC, json=VALID_ENQUIRY)
    assert r.status_code == 201, r.text
    assert r.json()["enquiry_reference"] == "GT-20270101-000001"


def test_admin_list_allowed_when_explicitly_enabled(client, monkeypatch):
    _set_flag(monkeypatch, "true")
    monkeypatch.setattr(service, "list_enquiries", lambda *a, **k: ([], 0))
    monkeypatch.setattr(service, "admin_names_for", lambda *a, **k: {})
    assert client.get(ADMIN_LIST).status_code == 200


# ---------------------------------------------------------------------------
# Service-layer guard — blocks indirect creation (jobs, integrations, etc.)
# ---------------------------------------------------------------------------
def test_service_create_refuses_when_disabled(monkeypatch):
    _set_flag(monkeypatch, "false")
    with pytest.raises(service.GamingDisabledError):
        service.create(None, None)


def test_service_counts_are_zero_without_touching_db_when_disabled(monkeypatch):
    _set_flag(monkeypatch, None)
    # db is None on purpose: a disabled feature must not query the table.
    assert service.counts(None) == {"new": 0, "open": 0, "total": 0}


def test_service_assert_enabled_passes_when_enabled(monkeypatch):
    _set_flag(monkeypatch, "true")
    service._assert_enabled()  # must not raise
