"""Stage 1B — B2B / B2C administrative permission isolation, enforced server-side.

The rule: a B2B-only administrator must not reach a protected B2C endpoint, and a
B2C-only administrator must not reach a protected B2B endpoint — regardless of
what the admin UI shows. The ``b2c.*`` scopes live in NO role default, so
``require_scope`` (which consults explicit grants via ``User.has_permission``,
never the role matrix) blocks a role=admin user who was never explicitly granted
them. B2B endpoints keep their existing ``require(...)`` / role gates.

Real dependencies, no DB: ``get_current_user`` is overridden with stub users.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI, Header
from fastapi.testclient import TestClient

from app.auth import deps, rbac
from app.auth.rbac import P
from app.models_v2 import User, UserRole


def _mkuser(role: UserRole, *codes: str) -> User:
    return User(user_id=1, role=role, merchant_role=None, permissions=list(codes))


# The four operators the brief distinguishes.
USERS = {
    "super_admin": _mkuser(UserRole.SUPER_ADMIN),                 # everything (short-circuit)
    "b2b_only": _mkuser(UserRole.ADMIN),                          # B2B via role default, no b2c.*
    "b2c_only": _mkuser(UserRole.CUSTOMER, P.B2C_CUSTOMERS_VIEW), # explicit b2c only, no B2B role/codes
    "both": _mkuser(UserRole.ADMIN, P.B2C_CUSTOMERS_VIEW),        # B2B via role + explicit b2c
}


# NB: fixture is NOT named ``app`` on purpose — the pytest-flask plugin (present
# in some environments) auto-hooks any ``app`` fixture as a Flask app and calls
# ``app.response_class``, which a FastAPI instance does not have. A distinct name
# keeps this FastAPI-only test independent of whatever plugins are installed.
@pytest.fixture()
def api_app():
    api = FastAPI()

    @api.get("/b2c", dependencies=[Depends(rbac.require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW))])
    def b2c_endpoint():
        return {"domain": "b2c"}

    @api.get("/b2b", dependencies=[Depends(rbac.require(P.MERCHANT_VIEW))])
    def b2b_endpoint():
        return {"domain": "b2b"}

    @api.get("/b2b-admin")
    def b2b_admin_endpoint(_: User = Depends(deps.get_current_admin)):
        return {"domain": "b2b-admin"}

    return api


@pytest.fixture()
def client(api_app):
    def _user(x_test_user: str = Header(...)):
        return USERS[x_test_user]

    api_app.dependency_overrides[deps.get_current_user] = _user
    return TestClient(api_app, raise_server_exceptions=False)


def _get(client, who, path):
    return client.get(path, headers={"x-test-user": who})


# ---------------------------------------------------------------------------
# B2B-only administrator
# ---------------------------------------------------------------------------
def test_b2b_only_admin_reaches_b2b(client):
    assert _get(client, "b2b_only", "/b2b").status_code == 200
    assert _get(client, "b2b_only", "/b2b-admin").status_code == 200


def test_b2b_only_admin_is_forbidden_from_b2c(client):
    r = _get(client, "b2b_only", "/b2c")
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# B2C-only administrator
# ---------------------------------------------------------------------------
def test_b2c_only_admin_reaches_b2c(client):
    assert _get(client, "b2c_only", "/b2c").status_code == 200


def test_b2c_only_admin_is_forbidden_from_b2b(client):
    assert _get(client, "b2c_only", "/b2b").status_code == 403
    assert _get(client, "b2c_only", "/b2b-admin").status_code == 403


# ---------------------------------------------------------------------------
# Dual-domain and super admin
# ---------------------------------------------------------------------------
def test_dual_domain_admin_reaches_both(client):
    assert _get(client, "both", "/b2c").status_code == 200
    assert _get(client, "both", "/b2b").status_code == 200


def test_super_admin_reaches_everything(client):
    assert _get(client, "super_admin", "/b2c").status_code == 200
    assert _get(client, "super_admin", "/b2b").status_code == 200
    assert _get(client, "super_admin", "/b2b-admin").status_code == 200


# ---------------------------------------------------------------------------
# Unauthenticated
# ---------------------------------------------------------------------------
def test_unauthenticated_is_rejected(api_app):
    # No get_current_user override: the real bearer dependency runs, and with no
    # Authorization header the request is rejected (401/403), never served.
    client = TestClient(api_app, raise_server_exceptions=False)
    assert client.get("/b2c").status_code in (401, 403)
    assert client.get("/b2b").status_code in (401, 403)
    assert client.get("/b2b-admin").status_code in (401, 403)
