"""Who may read the audit trail and the system configuration, and what they get.

QA finding (2026-11-09): Admin accounts can read ``/api/super-admin/audit-logs`` and
``/api/super-admin/system-info``. Reviewed outcome:

* **INTENTIONAL, kept.** ``rbac.py`` grants ``audit.view`` and ``system.activity.view`` to
  BOTH Super Admin and Admin by name, and the Admin portal's "Logs" screen
  (``frontend/admin/index.html`` + ``admin-logs.js``) calls these endpoints. The
  ``/api/super-admin`` URL prefix is historical; the permission code, not the path,
  is the gate. Manager, every merchant role and customers hold neither code.
* **FIXED.** The audit rows are whole-row copies, and a ``users`` row carries
  ``password_hash``, ``otp_code_hash`` and ``reset_token_hash``. They were returned
  unmasked, and a SHA-256 of a six-digit code is recoverable by brute force, so an
  administrator could have read a live sign-in code for any account. The API now masks
  those values (the stored rows are unchanged).

Real routing and the real ``require()`` dependency. ``get_current_user`` is replaced by a
stub user (token decoding and the user lookup are covered elsewhere); the data services
are replaced by canned results, so no database is touched.
"""
from __future__ import annotations

import datetime as dt
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import deps
from app.auth.rbac import P, effective_permissions
from app.database.session import get_db
from app.models_v2 import AuditOperation, MerchantRole, UserRole
from app.routers import messages, super_admin
from app.services import audit_service

AUDIT = "/api/super-admin/audit-logs"
AUDIT_TABLES = "/api/super-admin/audit-logs/tables"
SYSINFO = "/api/super-admin/system-info"
FAILED_MSGS = "/api/admin/messages/failed"

SECRET_VALUES = {
    "password_hash": "$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012",
    "otp_code_hash": "a" * 64,
    "reset_token_hash": "b" * 64,
}


def _user(role, merchant_role=None, permissions=None):
    return types.SimpleNamespace(
        user_id=1, role=role, merchant_role=merchant_role, permissions=permissions or [],
    )


ROLES = {
    "super_admin": _user(UserRole.SUPER_ADMIN),
    "admin": _user(UserRole.ADMIN),
    "manager": _user(UserRole.MANAGER),
    "merchant_admin": _user(UserRole.MERCHANT_ADMIN),
    **{f"merchant_{m.value}": _user(UserRole.MERCHANT_USER, m) for m in MerchantRole},
    "merchant_no_subrole": _user(UserRole.MERCHANT_USER),
    "customer": _user(UserRole.CUSTOMER),
}
ALLOWED_AUDIT = {"super_admin", "admin"}
ALLOWED_SYSINFO = {"super_admin", "admin"}


def _audit_row():
    log = types.SimpleNamespace(
        audit_id=9, table_name="users", record_id=5, operation=AuditOperation.UPDATE,
        old_value=dict(SECRET_VALUES, full_name="Old Name", status="active"),
        new_value=dict(SECRET_VALUES, full_name="New Name", status="active",
                       otp_code_hash="c" * 64),
        changed_by=1, changed_at=dt.datetime(2026, 11, 9, 10, 0, tzinfo=dt.timezone.utc),
    )
    return (log, "Some Admin", "admin@example.com")


@pytest.fixture()
def client_for(monkeypatch):
    """A client acting as the named role, or anonymous when ``role`` is None."""
    monkeypatch.setattr(super_admin.audit_service, "list_audit_logs",
                        lambda *a, **k: ([_audit_row()], 1))
    monkeypatch.setattr(super_admin.audit_service, "list_audited_tables", lambda db: ["users"])
    monkeypatch.setattr(super_admin.system_info_service, "get_system_info", lambda db: {
        "schema_version": "0093_traveller_middle_name",
        "cors_origins": ["https://example.com"], "debug_mode": False,
        "auth": {"jwt_algorithm": "HS256", "access_token_expire_minutes": 30,
                 "refresh_token_expire_days": 7, "reset_token_expire_minutes": 30,
                 "otp_ttl_minutes": 5, "otp_max_verify_attempts": 5,
                 "otp_max_requests_per_hour": 5},
        "communication": {"otp_delivery_mode": "email", "smtp_configured": True,
                          "smtp_host": "smtp.example.com", "smtp_from_name": "JackPots",
                          "frontend_base_url": "https://example.com"},
    })
    monkeypatch.setattr(messages.delivery_service, "failed_messages", lambda *a, **k: ([], 0))

    def make(role):
        app = FastAPI()
        app.include_router(super_admin.router)
        app.include_router(messages.router)
        app.dependency_overrides[get_db] = lambda: None
        if role is not None:
            app.dependency_overrides[deps.get_current_user] = lambda: ROLES[role]
        return TestClient(app, raise_server_exceptions=False)

    return make


# ---------------------------------------------------------------------------
# 1. The matrix itself (who SHOULD hold the codes)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("role", sorted(ROLES))
def test_audit_view_is_held_only_by_super_admin_and_admin(role):
    held = effective_permissions(ROLES[role])
    assert (P.AUDIT_VIEW in held) == (role in ALLOWED_AUDIT)


@pytest.mark.parametrize("role", sorted(ROLES))
def test_system_activity_view_is_held_only_by_super_admin_and_admin(role):
    held = effective_permissions(ROLES[role])
    assert (P.SYSTEM_ACTIVITY_VIEW in held) == (role in ALLOWED_SYSINFO)


def test_delivery_failures_are_admin_only_not_super_admin():
    # notification.send: Admin alone (the Super Admin's remit is account administration).
    assert P.NOTIFICATION_SEND in effective_permissions(ROLES["admin"])
    for role in sorted(set(ROLES) - {"admin"}):
        assert P.NOTIFICATION_SEND not in effective_permissions(ROLES[role]), role


# ---------------------------------------------------------------------------
# 2. API-level authorization
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("path", [AUDIT, AUDIT_TABLES, SYSINFO, FAILED_MSGS])
def test_anonymous_callers_are_refused(client_for, path):
    r = client_for(None).get(path)
    assert r.status_code in (401, 403), r.text


@pytest.mark.parametrize("role", sorted(set(ROLES) - ALLOWED_AUDIT))
@pytest.mark.parametrize("path", [AUDIT, AUDIT_TABLES])
def test_audit_logs_refuse_roles_without_audit_view(client_for, role, path):
    r = client_for(role).get(path)
    assert r.status_code == 403
    assert "audit.view" in r.json()["detail"]


@pytest.mark.parametrize("role", sorted(set(ROLES) - ALLOWED_SYSINFO))
def test_system_info_refuses_roles_without_the_permission(client_for, role):
    r = client_for(role).get(SYSINFO)
    assert r.status_code == 403
    assert "system.activity.view" in r.json()["detail"]


@pytest.mark.parametrize("role", sorted(ALLOWED_AUDIT))
def test_audit_logs_open_to_the_two_intended_roles(client_for, role):
    assert client_for(role).get(AUDIT).status_code == 200
    assert client_for(role).get(AUDIT_TABLES).status_code == 200


@pytest.mark.parametrize("role", sorted(ALLOWED_SYSINFO))
def test_system_info_open_to_the_two_intended_roles(client_for, role):
    assert client_for(role).get(SYSINFO).status_code == 200


@pytest.mark.parametrize("role", sorted(set(ROLES) - {"admin"}))
def test_failed_messages_refuse_everyone_but_admin(client_for, role):
    assert client_for(role).get(FAILED_MSGS).status_code == 403


def test_a_per_user_grant_is_the_only_way_round_the_matrix():
    # Explicit grants on the row are honoured by design; the role alone is not enough.
    with_grant = _user(UserRole.MANAGER, permissions=[P.AUDIT_VIEW])
    assert P.AUDIT_VIEW in effective_permissions(with_grant)
    assert P.AUDIT_VIEW not in effective_permissions(ROLES["manager"])


# ---------------------------------------------------------------------------
# 3. What the allowed roles get back
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("role", sorted(ALLOWED_AUDIT))
def test_audit_logs_never_return_password_or_code_hashes(client_for, role):
    body = client_for(role).get(AUDIT).text
    for name, value in SECRET_VALUES.items():
        assert value not in body, f"{name} leaked"
    assert "c" * 64 not in body            # the new_value otp hash too
    item = client_for(role).get(AUDIT).json()["items"][0]
    # the key stays visible, so an auditor can see THAT it changed...
    assert item["new_value"]["otp_code_hash"] == audit_service.REDACTED
    assert item["old_value"]["password_hash"] == audit_service.REDACTED
    # ...and ordinary columns are untouched.
    assert item["new_value"]["full_name"] == "New Name"
    assert item["old_value"]["status"] == "active"


def test_system_info_carries_no_secret_field_names(client_for):
    body = client_for("super_admin").get(SYSINFO).text.lower()
    for forbidden in ("password", "secret", "api_key", "smtp_password", "jwt_secret", "database_url"):
        assert forbidden not in body


# ---------------------------------------------------------------------------
# 4. The redaction helper on its own
# ---------------------------------------------------------------------------
def test_redact_values_masks_nested_and_list_values_and_keeps_none():
    value = {"password_hash": "x", "token": "y", "api_key": "k", "reset_token_hash": None,
             "nested": {"otp_code_hash": "z", "name": "n"}, "rows": [{"secret_note": "s"}]}
    out = audit_service.redact_values(value)
    assert out["password_hash"] == out["token"] == out["api_key"] == audit_service.REDACTED
    assert out["reset_token_hash"] is None          # nothing to hide, and it shows "unset"
    assert out["nested"] == {"otp_code_hash": audit_service.REDACTED, "name": "n"}
    assert out["rows"] == [{"secret_note": audit_service.REDACTED}]
    assert audit_service.redact_values(None) is None
    assert value["password_hash"] == "x"            # the input is not mutated
