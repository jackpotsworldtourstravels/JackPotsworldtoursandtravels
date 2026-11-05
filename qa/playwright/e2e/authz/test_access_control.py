"""Stage 4A.1 — authorization checks (API level).

Storage-state auth (used by the browser smoke) is a SPEED mechanism; it must not
be mistaken for authorization coverage. These tests assert, against the real app,
that protected endpoints refuse: unauthenticated callers, invalid tokens, EXPIRED
sessions, wrong-role staff, and cross-portal (customer<->staff) tokens — and admit
only the right role.

Observed app contract (confirmed live, stable):
  missing Authorization header              -> 403 (FastAPI HTTPBearer)
  invalid / expired token                   -> 401 (handler rejects the token)
  cross-scheme token (customer<->staff)     -> 401 (not valid for that scheme)
  valid staff token, wrong role             -> 403 (authenticated but forbidden)
  correct role                              -> 200

Refusals are asserted as "in (401, 403)" where either is legitimate, and the
invalid/expired paths as exactly 401, so the suite stays meaningful without being
brittle to an RBAC 401<->403 nuance.

Runs under -m e2e + require_server (role_tokens needs the server), so it SKIPS
cleanly without the isolated env.
"""
from __future__ import annotations

import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.authz]

ADMIN_EP = ("GET", "/api/admin/customers")       # staff/admin-only
CUSTOMER_EP = ("GET", "/api/customer/auth/me")   # customer-only


def test_admin_endpoint_unauthenticated_is_refused(api, role_tokens):
    m, p = ADMIN_EP
    assert api.status(m, p, None) in (401, 403)


def test_admin_endpoint_invalid_token_is_401(api, role_tokens):
    m, p = ADMIN_EP
    assert api.status(m, p, role_tokens["invalid"]) == 401


def test_admin_endpoint_expired_session_is_401(api, role_tokens):
    m, p = ADMIN_EP
    assert api.status(m, p, role_tokens["expired"]) == 401


def test_admin_endpoint_rejects_customer_cross_role(api, role_tokens):
    m, p = ADMIN_EP
    assert role_tokens["customer"], role_tokens.get("customer__error")
    assert api.status(m, p, role_tokens["customer"]) in (401, 403)


def test_admin_endpoint_rejects_wrong_staff_roles(api, role_tokens):
    m, p = ADMIN_EP
    for role in ("merchant", "manager"):
        assert role_tokens[role], role_tokens.get(f"{role}__error")
        assert api.status(m, p, role_tokens[role]) in (401, 403), f"{role} reached admin"


def test_admin_endpoint_allows_admin(api, role_tokens):
    m, p = ADMIN_EP
    assert role_tokens["admin"], role_tokens.get("admin__error")
    assert api.status(m, p, role_tokens["admin"]) == 200


def test_customer_endpoint_unauthenticated_is_refused(api, role_tokens):
    m, p = CUSTOMER_EP
    assert api.status(m, p, None) in (401, 403)


def test_customer_endpoint_rejects_staff_cross_role(api, role_tokens):
    m, p = CUSTOMER_EP
    assert api.status(m, p, role_tokens["admin"]) in (401, 403)


def test_customer_endpoint_allows_customer(api, role_tokens):
    m, p = CUSTOMER_EP
    assert role_tokens["customer"], role_tokens.get("customer__error")
    assert api.status(m, p, role_tokens["customer"]) == 200
