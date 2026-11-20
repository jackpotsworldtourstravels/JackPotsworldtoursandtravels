"""HTTP-level verification of the Admin Portal's MERCHANT MANAGEMENT workflows.

Real router + real services + real mapped models, on throw-away SQLite data
(``tests/_v2_harness.py``). Delivery is mocked, so no email/SMS/push can leave the process.
Covered: create (+ first login, one-time password, defaults), validation, duplicate email,
list/search/filter/pagination, edit, status (suspend/reactivate), soft delete, merchant-user
create/reset/status/delete, permission enforcement (401/403) and the actor-attributed audit
(``system_logs``) trail. PostgreSQL-only behaviour (partial unique index on merchants.email,
triggers, enums) is NOT exercised here — see the tracker.
"""
from __future__ import annotations

import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import Merchant, MerchantStatus, SystemLog, User, UserRole, UserStatus
from app.routers import merchants as merchants_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

BASE = "/api/admin/merchants"


@pytest.fixture()
def h(monkeypatch):
    # No delivery channel may be reachable.
    sent = []
    monkeypatch.setattr(notification_service, "create_notification",
                        lambda db, uid, title, msg: sent.append((uid, title)))

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)
    harness = Harness(merchants_router.router)
    harness.notifications = sent
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


def _payload(**over):
    body = {
        "company_name": "Test Travels Pvt Ltd", "merchant_name": "Test Travels",
        "email": "ops@testtravels.qa-mail.com", "phone": "9000000000",
        "contact_person": "Pat Owner", "contact_email": "pat@testtravels.qa-mail.com",
        "country": "India", "country_code": "IN", "city": "Pune",
    }
    body.update(over)
    return body


def _create(h, admin, **over):
    return h.client.post(BASE, json=_payload(**over), headers=admin["headers"])


def _logs(h, action=None):
    db = h.db()
    q = select(SystemLog)
    rows = db.scalars(q).all()
    db.close()
    return [r for r in rows if action is None or r.action == action]


def _merchant(h, mid):
    db = h.db()
    m = db.get(Merchant, mid)
    db.close()
    return m


# ------------------------------------------------------------------ create
def test_create_merchant_persists_first_login_and_audit(h, admin):
    r = _create(h, admin)
    assert r.status_code == 201, r.text
    body = r.json()
    mid = body["merchant"]["id"]
    assert body["merchant"]["status"] == "active"
    assert body["first_user"]["role"] == "merchant_admin"
    temp = body["temporary_password"]
    assert temp and len(temp) >= 8

    db = h.db()
    m = db.get(Merchant, mid)
    assert m.status is MerchantStatus.ACTIVE and m.created_by == admin["id"]
    assert m.merchant_code and m.reference_prefix
    first = db.scalars(select(User).where(User.merchant_id == mid)).one()
    assert first.role is UserRole.MERCHANT_ADMIN
    assert first.password_hash and first.password_hash != temp, "password must be stored hashed"
    db.close()

    logs = _logs(h, "Merchant created")
    assert len(logs) == 1 and logs[0].user_id == admin["id"] and logs[0].merchant_id == mid


def test_one_time_password_is_not_returned_by_later_reads(h, admin):
    mid = _create(h, admin).json()["merchant"]["id"]
    got = h.client.get(f"{BASE}/{mid}", headers=admin["headers"])
    assert got.status_code == 200
    assert "temporary_password" not in got.text and "password" not in got.text.lower().replace("password_", "")


def test_duplicate_email_rejected_without_a_second_row(h, admin):
    assert _create(h, admin).status_code == 201
    r = _create(h, admin, company_name="Other Co", contact_email="x@testtravels.qa-mail.com")
    assert r.status_code == 400 and "already exists" in r.json()["detail"]
    db = h.db()
    assert len(db.scalars(select(Merchant)).all()) == 1
    db.close()


@pytest.mark.parametrize("over", [
    {"company_name": ""}, {"merchant_name": ""}, {"email": "not-an-email"},
    {"contact_email": "nope"}, {"contact_person": ""}, {"credit_limit": -1},
    {"country_code": "IND"}, {"company_type": "nonsense"},
], ids=["no-company", "no-merchant-name", "bad-email", "bad-contact-email", "no-contact",
        "negative-credit", "country-code-3", "bad-type"])
def test_create_validation_rejects_bad_input(h, admin, over):
    r = _create(h, admin, **over)
    assert r.status_code == 422, r.text
    db = h.db()
    assert db.scalars(select(Merchant)).all() == []
    db.close()
    assert _logs(h, "Merchant created") == []


# --------------------------------------------------------------- permissions
def test_anonymous_cannot_write_or_read(h):
    for method, url in [("post", BASE), ("get", BASE), ("put", f"{BASE}/1"), ("delete", f"{BASE}/1"),
                        ("patch", f"{BASE}/1/status")]:
        r = getattr(h.client, method)(url, **({"json": {}} if method != "get" and method != "delete" else {}))
        assert r.status_code == 401, (method, url, r.status_code)


def test_super_admin_can_view_but_not_create(h):
    sa = h.user(UserRole.SUPER_ADMIN, name="Sam Super")
    assert h.client.get(BASE, headers=sa["headers"]).status_code == 200
    r = h.client.post(BASE, json=_payload(), headers=sa["headers"])
    assert r.status_code == 403, r.text
    db = h.db()
    assert db.scalars(select(Merchant)).all() == []
    db.close()


def test_role_without_merchant_permissions_is_refused_everywhere(h, admin):
    mid = _create(h, admin).json()["merchant"]["id"]
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    calls = [
        ("get", BASE, None), ("get", f"{BASE}/{mid}", None),
        ("put", f"{BASE}/{mid}", {"city": "X"}),
        ("patch", f"{BASE}/{mid}/status", {"status": "suspended"}),
        ("patch", f"{BASE}/{mid}/service-access", {"hotels": False}),
        ("delete", f"{BASE}/{mid}", None),
        ("get", f"{BASE}/{mid}/users", None),
        ("post", f"{BASE}/{mid}/users", {"full_name": "A", "email": "a@x.qa-mail.com"}),
    ]
    for method, url, body in calls:
        kw = {"json": body} if body is not None else {}
        r = getattr(h.client, method)(url, headers=mgr["headers"], **kw)
        assert r.status_code == 403, (method, url, r.status_code, r.text)
    m = _merchant(h, mid)
    assert m.status is MerchantStatus.ACTIVE and m.city == "Pune", "a refused call must change nothing"


# ---------------------------------------------------------------------- list
def test_list_search_filter_pagination_and_deleted_hidden(h, admin):
    ids = []
    for i in range(3):
        ids.append(_create(h, admin, company_name=f"Alpha{i} Co", merchant_name=f"Alpha{i}",
                           email=f"a{i}@t.qa-mail.com", contact_email=f"c{i}@t.qa-mail.com"
                           ).json()["merchant"]["id"])
    _create(h, admin, company_name="Zed Holidays", merchant_name="Zed", email="z@t.qa-mail.com",
            contact_email="zc@t.qa-mail.com")
    r = h.client.get(BASE, params={"search": "alpha"}, headers=admin["headers"]).json()
    assert r["total"] == 3
    r = h.client.get(BASE, params={"page": 2, "page_size": 3}, headers=admin["headers"]).json()
    assert r["total"] == 4 and len(r["items"]) == 1 and r["total_pages"] == 2
    assert h.client.get(BASE, params={"page_size": 101}, headers=admin["headers"]).status_code == 422
    assert h.client.patch(f"{BASE}/{ids[0]}/status", json={"status": "suspended"},
                          headers=admin["headers"]).status_code == 200
    only = h.client.get(BASE, params={"status": "suspended"}, headers=admin["headers"]).json()
    assert [m["id"] for m in only["items"]] == [ids[0]]
    assert h.client.delete(f"{BASE}/{ids[1]}", headers=admin["headers"]).status_code == 204
    assert ids[1] not in [m["id"] for m in h.client.get(BASE, headers=admin["headers"]).json()["items"]]


def test_get_missing_merchant_is_404(h, admin):
    assert h.client.get(f"{BASE}/424242", headers=admin["headers"]).status_code == 404


# --------------------------------------------------------------------- edit
def test_edit_changes_only_supplied_fields_and_is_audited(h, admin):
    mid = _create(h, admin).json()["merchant"]["id"]
    r = h.client.put(f"{BASE}/{mid}", json={"city": "Mumbai"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    m = _merchant(h, mid)
    assert m.city == "Mumbai" and m.company_name == "Test Travels Pvt Ltd"
    assert len(_logs(h, "Merchant updated")) == 1


def test_edit_email_clash_is_400_but_resaving_own_email_is_fine(h, admin):
    a = _create(h, admin).json()["merchant"]
    b = _create(h, admin, company_name="B Co", merchant_name="B", email="b@t.qa-mail.com",
                contact_email="bc@t.qa-mail.com").json()["merchant"]
    clash = h.client.put(f"{BASE}/{b['id']}", json={"email": a["email"]}, headers=admin["headers"])
    assert clash.status_code == 400
    own = h.client.put(f"{BASE}/{b['id']}", json={"email": b["email"]}, headers=admin["headers"])
    assert own.status_code == 200


def test_edit_missing_merchant_is_404(h, admin):
    assert h.client.put(f"{BASE}/424242", json={"city": "X"}, headers=admin["headers"]).status_code == 404


# ------------------------------------------------------------------- status
def test_suspend_and_reactivate_persist_and_audit(h, admin):
    mid = _create(h, admin).json()["merchant"]["id"]
    r = h.client.patch(f"{BASE}/{mid}/status", json={"status": "suspended"}, headers=admin["headers"])
    assert r.status_code == 200 and r.json()["status"] == "suspended"
    assert _merchant(h, mid).status is MerchantStatus.SUSPENDED
    assert h.notifications, "the merchant's users are told (delivery mocked)"
    r = h.client.patch(f"{BASE}/{mid}/status", json={"status": "active"}, headers=admin["headers"])
    assert r.status_code == 200 and _merchant(h, mid).status is MerchantStatus.ACTIVE
    actions = [l.action for l in _logs(h)]
    assert "Merchant suspended" in actions and "Merchant active" in actions
    assert actions.index("Merchant suspended") < actions.index("Merchant active")


@pytest.mark.parametrize("bad", ["deleted", "pending_approval", "bogus", ""])
def test_status_values_nobody_may_select_are_refused(h, admin, bad):
    mid = _create(h, admin).json()["merchant"]["id"]
    r = h.client.patch(f"{BASE}/{mid}/status", json={"status": bad}, headers=admin["headers"])
    assert r.status_code in (400, 422), r.text
    assert _merchant(h, mid).status is MerchantStatus.ACTIVE


# ------------------------------------------------------------------- delete
def test_delete_is_a_soft_delete_of_merchant_and_all_users(h, admin):
    mid = _create(h, admin).json()["merchant"]["id"]
    assert h.client.delete(f"{BASE}/{mid}", headers=admin["headers"]).status_code == 204
    db = h.db()
    assert db.get(Merchant, mid).status is MerchantStatus.DELETED
    assert {u.status for u in db.scalars(select(User).where(User.merchant_id == mid)).all()} == {UserStatus.DELETED}
    db.close()
    assert len(_logs(h, "Merchant deleted")) == 1
    again = h.client.delete(f"{BASE}/{mid}", headers=admin["headers"])
    assert again.status_code == 400 and "already deleted" in again.json()["detail"]


def test_a_deleted_merchant_cannot_be_reactivated_or_edited(h, admin):
    """Deleted is terminal (see SETTABLE_STATUSES). Regression for DEFECT-2: PATCH /status used to
    flip a deleted merchant back to ACTIVE while its users stayed deleted."""
    mid = _create(h, admin).json()["merchant"]["id"]
    assert h.client.delete(f"{BASE}/{mid}", headers=admin["headers"]).status_code == 204
    r = h.client.patch(f"{BASE}/{mid}/status", json={"status": "active"}, headers=admin["headers"])
    assert r.status_code in (400, 404, 409), r.text
    assert _merchant(h, mid).status is MerchantStatus.DELETED
    r = h.client.put(f"{BASE}/{mid}", json={"city": "Ghost"}, headers=admin["headers"])
    assert r.status_code in (400, 404, 409), r.text
    assert _merchant(h, mid).city == "Pune"
    assert [l for l in _logs(h) if l.action in ("Merchant active", "Merchant updated")] == [], \
        "a refused change must not be audited as a success"


# -------------------------------------------------------------- merchant users
def _new_user(h, admin, mid, email="staff@t.qa-mail.com", **over):
    body = {"full_name": "Sam Staff", "email": email, **over}
    return h.client.post(f"{BASE}/{mid}/users", json=body, headers=admin["headers"])


def test_merchant_user_lifecycle(h, admin):
    mid = _create(h, admin).json()["merchant"]["id"]
    r = _new_user(h, admin, mid)
    assert r.status_code == 201, r.text
    uid = r.json()["account"]["id"]
    assert r.json()["temporary_password"]
    db = h.db()
    u = db.get(User, uid)
    assert u.merchant_id == mid and u.role in (UserRole.MERCHANT_USER, UserRole.MERCHANT_ADMIN)
    old_hash = u.password_hash
    db.close()

    assert _new_user(h, admin, mid).status_code in (400, 409), "duplicate email"
    lst = h.client.get(f"{BASE}/{mid}/users", headers=admin["headers"]).json()
    assert lst["total"] == 2

    r = h.client.post(f"{BASE}/{mid}/users/{uid}/reset-password", headers=admin["headers"])
    assert r.status_code == 200 and r.json()["temporary_password"]
    db = h.db()
    assert db.get(User, uid).password_hash != old_hash
    db.close()

    r = h.client.patch(f"{BASE}/{mid}/users/{uid}/status", json={"status": "inactive"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    db = h.db()
    assert db.get(User, uid).status is UserStatus.INACTIVE
    db.close()

    assert h.client.delete(f"{BASE}/{mid}/users/{uid}", headers=admin["headers"]).status_code == 204
    db = h.db()
    assert db.get(User, uid).status is UserStatus.DELETED
    db.close()


def test_user_under_missing_merchant_is_404_and_bad_input_is_422(h, admin):
    assert _new_user(h, admin, 424242).status_code == 404
    mid = _create(h, admin).json()["merchant"]["id"]
    assert _new_user(h, admin, mid, email="bad").status_code == 422
    assert h.client.post(f"{BASE}/{mid}/users", json={"email": "a@t.qa-mail.com"},
                         headers=admin["headers"]).status_code == 422


def test_user_of_another_merchant_cannot_be_touched_through_this_one(h, admin):
    a = _create(h, admin).json()["merchant"]["id"]
    b = _create(h, admin, company_name="B Co", merchant_name="B", email="b@t.qa-mail.com",
                contact_email="bc@t.qa-mail.com").json()["merchant"]["id"]
    uid = _new_user(h, admin, b).json()["account"]["id"]
    r = h.client.patch(f"{BASE}/{a}/users/{uid}/status", json={"status": "inactive"}, headers=admin["headers"])
    assert r.status_code in (400, 403, 404), r.text
    db = h.db()
    assert db.get(User, uid).status is UserStatus.ACTIVE
    db.close()


def test_service_access_and_new_users_on_a_deleted_merchant_are_refused(h, admin):
    """Same 'deleted is terminal' rule for the other writes (DEFECT-2, second half): these used to
    return 200/201 — a new ACTIVE user with a one-time password under a deleted company."""
    mid = _create(h, admin).json()["merchant"]["id"]
    assert h.client.delete(f"{BASE}/{mid}", headers=admin["headers"]).status_code == 204
    r1 = h.client.patch(f"{BASE}/{mid}/service-access", json={"hotels": False}, headers=admin["headers"])
    r2 = _new_user(h, admin, mid, email="late@t.qa-mail.com")
    assert r1.status_code == 400 and r2.status_code == 400, (r1.text, r2.text)
    db = h.db()
    assert db.scalars(select(User).where(User.email == "late@t.qa-mail.com")).first() is None
    db.close()
