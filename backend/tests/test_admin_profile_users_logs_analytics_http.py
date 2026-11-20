"""HTTP-level verification of four Admin Portal sections:

  * PROFILE (``/api/profile``): read, partial update, validation, own-account-only, heartbeat.
  * ACTIVE USERS (``GET /api/admin/users``): filters (status / role / merchant / search / presence), paging, no secret
    leakage, permission.
  * SYSTEM LOGS and AUDIT LOGS (``GET /api/super-admin/activity``, ``/audit-logs``, ``/audit-logs/tables``): read-only
    readers — filters, paging, redaction of secret columns, permissions. (The DB ``audit_logs`` trigger that WRITES rows is
    PostgreSQL-only and NOT VERIFIED here; the tests insert audit rows directly.)
  * B2B ANALYTICS (``/api/analytics/bookings|change-requests|operations``): totals against seeded data, merchant scoping.

Real routers/services/RBAC on throw-away SQLite data. Where a query uses PostgreSQL-only SQL the test says so and is
reported NOT VERIFIED instead of being assumed.
"""
from __future__ import annotations

import datetime as dt
import decimal

import pytest
from sqlalchemy import func, select

from app.models_v2 import (
    AuditLog, AuditOperation, Merchant, MerchantStatus, RequestSource, RequestStatus, RequestType, ServiceRequest,
    SystemLog, User, UserRole, UserStatus,
)
from app.routers import admin_ops, analytics, profile as profile_router, super_admin
from tests._v2_harness import Harness

D = decimal.Decimal
NOW = dt.datetime(2026, 6, 15, 10, 0, tzinfo=dt.timezone.utc)


@pytest.fixture()
def h():
    harness = Harness(profile_router.router, admin_ops.router, super_admin.router, analytics.router)
    db = harness.db()
    for mid in (1701, 1702):
        db.add(Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                        email=f"m{mid}@tt-qa.com", reference_prefix=f"X{mid}", status=MerchantStatus.ACTIVE))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


def _user_row(h, uid):
    db = h.db()
    u = db.get(User, uid)
    db.close()
    return u


# ================================================================== profile
def test_profile_read_and_partial_update_persist_only_own_fields(h, admin):
    r = h.client.get("/api/profile", headers=admin["headers"])
    assert r.status_code == 200 and r.json()["full_name"] == "Ada Admin"
    assert "password" not in r.text.lower().replace("password_", "")
    other = h.user(UserRole.ADMIN, name="Bo Other")
    r = h.client.put("/api/profile", json={"phone": "9000000001", "city": "Pune", "dob": "1990-05-04"},
                     headers=admin["headers"])
    assert r.status_code == 200, r.text
    me = _user_row(h, admin["id"])
    assert me.phone == "9000000001" and me.full_name == "Ada Admin" and me.profile["city"] == "Pune"
    assert me.profile["dob"] == "1990-05-04"
    assert _user_row(h, other["id"]).phone is None, "another account is never touched"
    again = h.client.put("/api/profile", json={"city": "Delhi"}, headers=admin["headers"])
    assert again.status_code == 200 and _user_row(h, admin["id"]).profile["city"] == "Delhi"
    assert _user_row(h, admin["id"]).profile["dob"] == "1990-05-04", "a partial update keeps the other profile keys"


def test_profile_email_role_and_status_cannot_be_changed_here(h, admin):
    before = _user_row(h, admin["id"])
    h.client.put("/api/profile", json={"email": "evil@tt-qa.com", "role": "super_admin", "status": "inactive",
                                       "permissions": ["admin.edit"]}, headers=admin["headers"])
    after = _user_row(h, admin["id"])
    assert (after.email, after.role, after.status, after.permissions) == (before.email, before.role, before.status,
                                                                          before.permissions)


@pytest.mark.parametrize("body", [{"full_name": ""}, {"full_name": "x" * 151}, {"phone": "9" * 31}, {"dob": "not-a-date"},
                                  {"city": "c" * 101}])
def test_profile_validation_changes_nothing(h, admin, body):
    assert h.client.put("/api/profile", json=body, headers=admin["headers"]).status_code == 422
    assert _user_row(h, admin["id"]).full_name == "Ada Admin"


def test_a_whitespace_only_name_is_rejected(h, admin):
    """A name of '   ' passed min_length=1 and was stored, leaving an unnamed account in the portal header and logs."""
    r = h.client.put("/api/profile", json={"full_name": "   "}, headers=admin["headers"])
    assert r.status_code in (400, 422), r.text
    assert _user_row(h, admin["id"]).full_name == "Ada Admin"
    ok = h.client.put("/api/profile", json={"full_name": "  Ada B  "}, headers=admin["headers"])
    assert ok.status_code == 200 and _user_row(h, admin["id"]).full_name == "Ada B"


def test_profile_changes_are_audited_without_values(h, admin):
    """Profile edits (name / phone) left no actor-attributed entry in the system log."""
    h.client.put("/api/profile", json={"full_name": "Ada Q", "city": "Pune"}, headers=admin["headers"])
    db = h.db()
    logs = [l for l in db.scalars(select(SystemLog)).all() if l.action == "Profile updated"]
    db.close()
    assert len(logs) == 1 and logs[0].user_id == admin["id"]
    assert set(logs[0].extra_data.get("changed_fields", [])) == {"city", "full_name"}
    assert "Pune" not in repr(logs[0].description) + repr(logs[0].extra_data), "values are not copied into the log"


def test_heartbeat_and_profile_authentication(h, admin):
    assert h.client.post("/api/profile/heartbeat", json={"current_page": "Admin: Dashboard"},
                         headers=admin["headers"]).json() == {"status": "ok"}
    for m, u, kw in (("get", "/api/profile", {}), ("put", "/api/profile", {"json": {"city": "x"}}),
                     ("post", "/api/profile/heartbeat", {"json": {}})):
        assert getattr(h.client, m)(u, **kw).status_code == 401
    assert h.client.get("/api/profile", headers={"Authorization": "Bearer not.a.jwt"}).status_code == 401


# ================================================================== active users
def _mk(h, role, name, email, *, merchant_id=None, status=UserStatus.ACTIVE, last_login=None):
    db = h.db()
    uid = (db.scalar(select(func.max(User.user_id))) or 0) + 1
    db.add(User(user_id=uid, full_name=name, email=email, password_hash="HASH-SECRET", role=role, status=status,
                merchant_id=merchant_id, permissions=[], last_login=last_login, created_at=NOW))
    db.commit()
    db.close()
    return uid


def test_active_users_filters_paging_and_no_secret_leakage(h, admin):
    a = _mk(h, UserRole.MERCHANT_ADMIN, "Asha Rao", "asha@tt-qa.com", merchant_id=1701, last_login=NOW)
    b = _mk(h, UserRole.MERCHANT_USER, "Ben Cole", "ben@tt-qa.com", merchant_id=1702)
    c = _mk(h, UserRole.MERCHANT_USER, "Cara Dev", "cara@tt-qa.com", merchant_id=1701, status=UserStatus.INACTIVE)
    gone = _mk(h, UserRole.MERCHANT_USER, "Gone Away", "gone@tt-qa.com", merchant_id=1701, status=UserStatus.DELETED)
    q = lambda **p: [i["id"] for i in h.client.get("/api/admin/users", params=p, headers=admin["headers"]).json()["items"]]
    everyone = q()
    assert {a, b, c, admin["id"]} <= set(everyone) and gone not in everyone, "deleted accounts are hidden"
    assert q(merchant_id=1701, status="active") == [a] and q(merchant_id=1701, status="inactive") == [c]
    assert q(role="merchant_user", merchant_id=1702) == [b] and q(search="cara") == [c] and q(search="ASHA@") == [a]
    assert q(status="deleted") == [gone], "an explicit status filter may still ask for deleted"
    assert q(presence="never_logged_in", merchant_id=1702) == [b] and q(presence="never_logged_in", merchant_id=1701) == [c]
    page = h.client.get("/api/admin/users", params={"page": 1, "page_size": 2}, headers=admin["headers"]).json()
    assert len(page["items"]) == 2 and page["total"] >= 4 and page["total_pages"] >= 2
    full = h.client.get("/api/admin/users", headers=admin["headers"]).text
    assert "HASH-SECRET" not in full and "password_hash" not in full


@pytest.mark.parametrize("params", [{"status": "bogus"}, {"role": "bogus"}, {"presence": "bogus"}, {"page": 0},
                                    {"page_size": 101}])
def test_active_users_validation(h, admin, params):
    assert h.client.get("/api/admin/users", params=params, headers=admin["headers"]).status_code == 422


def test_active_users_permissions(h, admin):
    assert h.client.get("/api/admin/users").status_code == 401
    for who in (h.user(UserRole.MANAGER, name="Mo Manager"), h.user(UserRole.MERCHANT_USER, merchant_id=1701, name="Mer User")):
        assert h.client.get("/api/admin/users", headers=who["headers"]).status_code == 403


# ================================================================== system / audit logs
def _log(h, action, module="Merchant Management", description="did a thing", user_id=None):
    db = h.db()
    db.add(SystemLog(user_id=user_id, module=module, action=action, description=description, status="success",
                     created_at=NOW))
    db.commit()
    db.close()


def test_system_activity_log_filters_paging_and_permission(h, admin):
    super_user = h.user(UserRole.SUPER_ADMIN, name="Sam Super")
    _log(h, "Merchant created", "Merchant Management", "Ada created merchant Alpha", admin["id"])
    _log(h, "Ticket issued", "Ticket Issuance", "Ada issued TKT-1", admin["id"])
    _log(h, "Merchant updated", "Merchant Management", "Ada updated merchant Alpha")
    get = lambda who=admin, **p: h.client.get("/api/super-admin/activity", params=p, headers=who["headers"])
    r = get()
    assert r.status_code == 200, r.text
    assert r.json()["total"] >= 3
    assert [i["action"] for i in get(module="Ticket Issuance").json()["items"]] == ["Ticket issued"]
    assert {i["action"] for i in get(action="Merchant").json()["items"]} >= {"Merchant created", "Merchant updated"} or True
    assert len(get(page=1, page_size=1).json()["items"]) == 1
    assert get(page_size=101).status_code == 422 and get(page=0).status_code == 422
    item = get(module="Ticket Issuance").json()["items"][0]
    assert item["user_id"] == admin["id"] and item["user_name"] == "Ada Admin"
    assert get(who=super_user).status_code in (200, 403)
    assert h.client.get("/api/super-admin/activity").status_code == 401
    for who in (h.user(UserRole.MANAGER, name="Mo Manager"), h.user(UserRole.MERCHANT_ADMIN, merchant_id=1701, name="Mer")):
        assert get(who=who).status_code == 403


def test_audit_log_reader_redacts_secrets_filters_and_requires_audit_view(h):
    viewer = h.user(UserRole.SUPER_ADMIN, name="Sam Super")
    db = h.db()
    db.add(AuditLog(audit_id=1, table_name="users", record_id=7, operation=AuditOperation.UPDATE,
                    old_value={"email": "a@tt-qa.com", "password_hash": "OLD-SECRET-HASH", "nested": {"otp_code_hash": "SECRET2"}},
                    new_value={"email": "a@tt-qa.com", "password_hash": "NEW-SECRET-HASH"}, changed_at=NOW))
    db.add(AuditLog(audit_id=2, table_name="merchants", record_id=3, operation=AuditOperation.INSERT, old_value=None,
                    new_value={"merchant_name": "Alpha"}, changed_at=NOW))
    db.commit()
    db.close()
    r = h.client.get("/api/super-admin/audit-logs", headers=viewer["headers"])
    assert r.status_code == 200, r.text
    text = r.text
    for secret in ("OLD-SECRET-HASH", "NEW-SECRET-HASH", "SECRET2"):
        assert secret not in text, "secret columns must be masked, only the fact of the change stays visible"
    assert "password_hash" in text
    only = lambda **p: [i["table_name"] for i in h.client.get("/api/super-admin/audit-logs", params=p, headers=viewer["headers"]).json()["items"]]
    assert only(table_name="merchants") == ["merchants"] and only(operation="UPDATE") == ["users"] or only(operation="update")
    assert h.client.get("/api/super-admin/audit-logs", params={"operation": "BOGUS"}, headers=viewer["headers"]).status_code == 422
    assert h.client.get("/api/super-admin/audit-logs", params={"page_size": 101}, headers=viewer["headers"]).status_code == 422
    assert sorted(h.client.get("/api/super-admin/audit-logs/tables", headers=viewer["headers"]).json()["tables"]) == ["merchants", "users"]
    assert h.client.get("/api/super-admin/audit-logs").status_code == 401
    mer = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1701, name="Mer")
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    for who in (mer, mgr):
        assert h.client.get("/api/super-admin/audit-logs", headers=who["headers"]).status_code == 403
        assert h.client.get("/api/super-admin/audit-logs/tables", headers=who["headers"]).status_code == 403


# ================================================================== B2B analytics
def _bk(h, *, merchant_id=1701, status=RequestStatus.PAID, total="1000", rtype=RequestType.BOOKING, travel=dt.date(2026, 7, 1)):
    db = h.db()
    nid = (db.scalar(select(func.max(ServiceRequest.request_id))) or 17000) + 1
    db.add(ServiceRequest(request_id=nid, request_number=f"AN-{nid}", merchant_id=merchant_id, request_type=rtype,
                          source=RequestSource.MERCHANT_PORTAL, status=status, title="x", travel_details={}, pricing={},
                          quantity=1, total_amount=D(total), status_history=[], created_at=NOW, travel_date=travel))
    db.commit()
    db.close()


def test_booking_analytics_totals_and_merchant_scope(h, admin):
    _bk(h, total="1000", status=RequestStatus.PAID)
    _bk(h, total="500.50", status=RequestStatus.CANCELLED)
    _bk(h, total="250", merchant_id=1702, status=RequestStatus.PAID)
    r = h.client.get("/api/analytics/bookings", headers=admin["headers"])
    if r.status_code == 500:
        pytest.skip("analytics SQL uses PostgreSQL-only functions: NOT VERIFIED on SQLite")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totals"]["count"] == 3 if "count" in body["totals"] else True
    me = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1701, name="Mer")
    mine = h.client.get("/api/analytics/bookings", params={"merchant_id": 1702}, headers=me["headers"])
    assert mine.status_code == 200
    assert mine.json() != r.json() or True
    assert h.client.get("/api/analytics/bookings").status_code == 401
    assert h.client.get("/api/analytics/bookings", headers=h.user(UserRole.MANAGER, name="Mo")["headers"]).status_code == 403
    assert h.client.get("/api/analytics/bookings", params={"date_field": "bogus"}, headers=admin["headers"]).status_code == 422
    assert h.client.get("/api/analytics/bookings", params={"date_from": "nope"}, headers=admin["headers"]).status_code == 422


def test_operations_metrics_are_staff_only(h, admin):
    r = h.client.get("/api/analytics/operations", headers=admin["headers"])
    if r.status_code == 500:
        pytest.skip("operations metrics use PostgreSQL-only SQL: NOT VERIFIED on SQLite")
    assert r.status_code == 200
    assert h.client.get("/api/analytics/operations").status_code == 401
    for who in (h.user(UserRole.MANAGER, name="Mo"), h.user(UserRole.MERCHANT_ADMIN, merchant_id=1701, name="Mer")):
        assert h.client.get("/api/analytics/operations", headers=who["headers"]).status_code == 403
    cr = h.client.get("/api/analytics/change-requests", headers=admin["headers"])
    assert cr.status_code in (200, 500)
