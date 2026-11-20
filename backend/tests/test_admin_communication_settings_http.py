"""HTTP-level verification of COMMUNICATION SETTINGS (per-merchant channel switches an Admin controls) and the
in-app NOTIFICATION INBOX every user reads (list / unread count / mark read / mark all read).

``/api/admin/communication-settings/{merchant_id}`` (``notification.send``) and ``/api/notifications`` (``notification.view``).
Nothing is sent: these endpoints only read/write rows, and every external channel raises if reached. SMS / WhatsApp
providers are not configured in this project and are NOT exercised. Real routers/services/RBAC on throw-away SQLite data.
"""
from __future__ import annotations

import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import CommunicationSettings, Merchant, MerchantStatus, MsgLog, SystemLog, UserRole
from app.routers import admin_ops, notifications_v2
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

BASE = "/api/admin/communication-settings"


@pytest.fixture()
def h(monkeypatch):
    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(admin_ops.router, notifications_v2.router)
    db = harness.db()
    for mid in (1501, 1502):
        db.add(Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                        email=f"m{mid}@tt-qa.com", reference_prefix=f"N{mid}", status=MerchantStatus.ACTIVE))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


def _settings(h, mid):
    db = h.db()
    s = db.scalars(select(CommunicationSettings).where(CommunicationSettings.merchant_id == mid)).first()
    db.close()
    return s


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


# ================================================================== settings
def test_get_creates_defaults_for_an_existing_merchant_and_404s_for_a_missing_one(h, admin):
    r = h.client.get(f"{BASE}/1501", headers=admin["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["merchant_id"] == 1501 and set(body) >= {"email_enabled", "sms_enabled", "whatsapp_enabled",
                                                          "otp_enabled", "notification_enabled", "preferred_language"}
    assert _settings(h, 1501) is not None
    assert h.client.get(f"{BASE}/424242", headers=admin["headers"]).status_code == 404
    assert _settings(h, 424242) is None


def test_put_changes_only_the_supplied_fields_and_persists(h, admin):
    before = h.client.get(f"{BASE}/1501", headers=admin["headers"]).json()
    r = h.client.put(f"{BASE}/1501", json={"notification_enabled": not before["notification_enabled"],
                                            "preferred_language": "hi"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    after = _settings(h, 1501)
    assert after.notification_enabled == (not before["notification_enabled"]) and after.preferred_language == "hi"
    assert after.email_enabled == before["email_enabled"] and after.sms_enabled == before["sms_enabled"]
    other = h.client.get(f"{BASE}/1502", headers=admin["headers"]).json()
    assert other["preferred_language"] == before["preferred_language"], "another merchant is untouched"
    empty = h.client.put(f"{BASE}/1501", json={}, headers=admin["headers"])
    assert empty.status_code == 200 and _settings(h, 1501).preferred_language == "hi"


@pytest.mark.parametrize("body", [{"email_enabled": "maybe"}, {"sms_enabled": []}, {"preferred_language": "x" * 11},
                                  {"notification_enabled": {"a": 1}}],
                         ids=["bad-bool", "list-bool", "long-language", "object-bool"])
def test_invalid_settings_are_rejected_and_nothing_changes(h, admin, body):
    before = h.client.get(f"{BASE}/1501", headers=admin["headers"]).json()
    assert h.client.put(f"{BASE}/1501", json=body, headers=admin["headers"]).status_code == 422
    after = h.client.get(f"{BASE}/1501", headers=admin["headers"]).json()
    assert after == before


def test_put_for_a_missing_merchant_is_404_and_creates_nothing(h, admin):
    assert h.client.put(f"{BASE}/424242", json={"email_enabled": False}, headers=admin["headers"]).status_code == 404
    assert _settings(h, 424242) is None


def test_settings_changes_are_audited_without_leaking_values_beyond_the_changed_fields(h, admin):
    """DEFECT-9: switching a merchant's notifications / email off was an unaudited admin action."""
    r = h.client.put(f"{BASE}/1501", json={"email_enabled": False, "notification_enabled": False},
                     headers=admin["headers"])
    assert r.status_code == 200, r.text
    log = _logs(h, "Communication settings updated")
    assert len(log) == 1 and log[0].user_id == admin["id"] and log[0].merchant_id == 1501
    assert set(log[0].extra_data.get("changed_fields", [])) == {"email_enabled", "notification_enabled"}
    rejected = h.client.put(f"{BASE}/1501", json={"email_enabled": "maybe"}, headers=admin["headers"])
    assert rejected.status_code == 422 and len(_logs(h, "Communication settings updated")) == 1


def test_settings_permissions(h, admin):
    for m, body in (("get", None), ("put", {"email_enabled": False})):
        kw = {"json": body} if body is not None else {}
        assert getattr(h.client, m)(f"{BASE}/1501", **kw).status_code == 401
        for who in (h.user(UserRole.MANAGER, name="Mo Manager"), h.user(UserRole.MERCHANT_ADMIN, merchant_id=1501, name="Mer Admin")):
            assert getattr(h.client, m)(f"{BASE}/1501", headers=who["headers"], **kw).status_code == 403
    assert _settings(h, 1501) is None, "refused calls must not even create the defaults row"
    assert _logs(h, "Communication settings updated") == []


# ================================================================== inbox
_T = {"n": 0}


def _notify(h, user_id, title="Hello", read=False):
    import datetime as dt
    db = h.db()
    note = notification_service._new(user_id, "x@tt-qa.com", title, "body text", None)
    note.is_read = read
    _T["n"] += 1
    note.created_at = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=_T["n"])   # distinct, ordered
    db.add(note)
    db.commit()
    nid = note.message_id
    db.close()
    return nid


def test_inbox_lists_only_my_notifications_newest_first_with_unread_filter_and_count(h, admin):
    other = h.user(UserRole.ADMIN, name="Bo Other")
    a = _notify(h, admin["id"], "first")
    b = _notify(h, admin["id"], "second", read=True)
    c = _notify(h, admin["id"], "third")
    _notify(h, other["id"], "not mine")
    r = h.client.get("/api/notifications", headers=admin["headers"])
    assert r.status_code == 200 and r.json()["total"] == 3
    assert [i["id"] for i in r.json()["items"]] == [c, b, a]
    unread = h.client.get("/api/notifications", params={"unread_only": "true"}, headers=admin["headers"]).json()
    assert [i["id"] for i in unread["items"]] == [c, a]
    assert h.client.get("/api/notifications/unread-count", headers=admin["headers"]).json() == {"count": 2}
    page = h.client.get("/api/notifications", params={"page": 2, "page_size": 2}, headers=admin["headers"]).json()
    assert [i["id"] for i in page["items"]] == [a]
    assert h.client.get("/api/notifications", params={"page_size": 101}, headers=admin["headers"]).status_code == 422


def test_mark_read_is_owner_only_and_mark_all_read_touches_only_my_rows(h, admin):
    other = h.user(UserRole.ADMIN, name="Bo Other")
    mine = _notify(h, admin["id"], "mine")
    theirs = _notify(h, other["id"], "theirs")
    assert h.client.patch(f"/api/notifications/{theirs}/read", headers=admin["headers"]).status_code in (403, 404)
    db = h.db()
    assert db.get(MsgLog, theirs).is_read is False, "another user's notification must not change"
    db.close()
    r = h.client.patch(f"/api/notifications/{mine}/read", headers=admin["headers"])
    assert r.status_code == 200 and r.json()["is_read"] is True
    assert h.client.patch("/api/notifications/99999999/read", headers=admin["headers"]).status_code in (403, 404)
    _notify(h, admin["id"], "another")
    assert h.client.post("/api/notifications/read-all", headers=admin["headers"]).json() == {"updated": 1}
    assert h.client.get("/api/notifications/unread-count", headers=admin["headers"]).json() == {"count": 0}
    db = h.db()
    assert db.get(MsgLog, theirs).is_read is False
    db.close()


def test_inbox_requires_authentication(h):
    for m, u in (("get", "/api/notifications"), ("get", "/api/notifications/unread-count"),
                 ("patch", "/api/notifications/1/read"), ("post", "/api/notifications/read-all")):
        assert getattr(h.client, m)(u).status_code == 401, u
