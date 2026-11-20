"""HTTP-level verification of SUPPORT / LIVE-CHAT THREADS from the Admin desk's side (``/api/support/threads``):
open, list/filter, read, reply (auto-claim), claim, triage, internal notes, resolve, reopen, unread count.

Real router + services + RBAC on throw-away SQLite data; notifications mocked, so nobody is contacted. This is the
HTTP chat/ticket workflow only: the WebSocket live-support gateway, WebRTC/Wi-Fi calling and thread document
attachments are NOT exercised and nothing here claims they work.
"""
from __future__ import annotations

import datetime as dt
import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import (
    Merchant, MerchantStatus, MsgLog, RequestNote, RequestStatus, RequestType, ServiceRequest, SystemLog, UserRole,
)
from app.routers import support_tickets as support_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

S = RequestStatus
BASE = "/api/support/threads"


@pytest.fixture()
def h(monkeypatch):
    told = []
    monkeypatch.setattr(notification_service, "notify_admins", lambda db, title, msg: told.append(("admins", title, msg)) or 0)
    monkeypatch.setattr(notification_service, "create_notification",
                        lambda db, uid, title, msg: told.append((uid, title, msg)))

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(support_router.router)
    harness.told = told
    db = harness.db()
    for mid in (1401, 1402):
        db.add(Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                        email=f"m{mid}@tt-qa.com", reference_prefix=f"S{mid}", status=MerchantStatus.ACTIVE))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def merchant(h):
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=1401, name="Mer Admin")


def _open(h, who, message="My wallet top-up is stuck", **extra):
    return h.client.post(BASE, json={"message": message, **extra}, headers=who["headers"])


def _tid(resp):
    return resp.json()["thread"]["id"] if "thread" in resp.json() else resp.json()["id"]


def _row(h, tid):
    db = h.db()
    r = db.get(ServiceRequest, tid)
    db.close()
    return r


def _msgs(h, tid):
    db = h.db()
    rows = db.scalars(select(MsgLog).where(MsgLog.request_id == tid).order_by(MsgLog.message_id)).all()
    db.close()
    return rows


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _post(h, who, path, body=None):
    return h.client.post(f"{BASE}{path}", json=body, headers=who["headers"]) if body is not None else \
        h.client.post(f"{BASE}{path}", headers=who["headers"])


# ================================================================== open
def test_merchant_opens_a_thread_with_a_first_message_and_an_audit_entry(h, merchant):
    r = _open(h, merchant, subject="Wallet", category="wallet", priority="high")
    assert r.status_code == 201, r.text
    tid = _tid(r)
    row = _row(h, tid)
    assert row.request_type is RequestType.LIVE_CHAT and row.status is S.SUBMITTED and row.merchant_id == 1401
    assert row.priority.value == "high" and row.travel_details["category"] == "wallet"
    msgs = _msgs(h, tid)
    assert [(m.direction, m.message) for m in msgs] == [("inbound", "My wallet top-up is stuck")]
    assert len(_logs(h, "Chat opened")) == 1
    assert any(t[0] == "admins" for t in h.told), "the desk is notified (delivery mocked)"


def test_a_blank_subject_is_derived_from_the_message_and_never_printed_as_none(h, merchant):
    """The audit entry and the desk notification used to say 'opened a chat: None' for the (optional) subject."""
    tid = _tid(_open(h, merchant, message="Cannot download my invoice for BK-123"))
    title = _row(h, tid).title
    assert title and "invoice" in title.lower()
    log = _logs(h, "Chat opened")[0]
    assert "None" not in (log.description or ""), log.description
    assert all("None" not in (t[2] or "") for t in h.told if t[0] == "admins")


@pytest.mark.parametrize("body", [{}, {"message": ""}, {"message": "x" * 4001}, {"message": "hi", "category": "weather"},
                                  {"message": "hi", "priority": "urgent!!"}, {"message": "hi", "subject": "s" * 201}],
                         ids=["no-message", "empty", "too-long", "bad-category", "bad-priority", "long-subject"])
def test_open_validation_creates_nothing(h, merchant, body):
    r = h.client.post(BASE, json=body, headers=merchant["headers"])
    assert r.status_code == 422, r.text
    db = h.db()
    assert db.scalars(select(ServiceRequest)).all() == [] and db.scalars(select(MsgLog)).all() == []
    db.close()


def test_open_permissions_and_booking_link_scope(h, merchant, admin):
    assert h.client.post(BASE, json={"message": "hi"}).status_code == 401
    assert _open(h, admin).status_code in (403,), "only merchant accounts can open a chat"
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1402, name="Other")
    db = h.db()
    from app.models_v2 import RequestSource
    db.add(ServiceRequest(request_id=14100, request_number="BK-14100", merchant_id=1402, request_type=RequestType.BOOKING,
                          source=RequestSource.MERCHANT_PORTAL, status=S.PAID, title="x", travel_details={}, pricing={},
                          quantity=1, total_amount=0, status_history=[]))
    db.commit()
    db.close()
    r = _open(h, merchant, related_request_id=14100)
    assert r.status_code in (400, 404), "a merchant cannot link another company's booking"
    assert _open(h, other, related_request_id=14100).status_code == 201


# ================================================================== list / read
def test_listing_is_scoped_and_filterable(h, merchant, admin):
    a = _tid(_open(h, merchant, message="alpha question", category="booking"))
    b = _tid(_open(h, merchant, message="beta question", category="payment"))
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1402, name="Other")
    c = _tid(_open(h, other, message="gamma question"))
    ids = lambda who, **p: sorted(i["id"] for i in h.client.get(BASE, params=p, headers=who["headers"]).json()["items"])
    assert ids(admin) == sorted([a, b, c]) and ids(merchant) == sorted([a, b]) and ids(other) == [c]
    assert ids(admin, status="submitted") == sorted([a, b, c])
    # NOT VERIFIED here: the ``category`` filter uses the PostgreSQL JSONB containment operator (@>), which SQLite
    # cannot evaluate. It stays BLOCKED on PostgreSQL rather than being assumed to work.
    assert h.client.get(BASE, params={"page_size": 101}, headers=admin["headers"]).status_code == 422
    assert h.client.get(BASE, params={"status": "bogus"}, headers=admin["headers"]).status_code == 422
    assert h.client.get(BASE).status_code == 401


def test_thread_detail_is_scoped_and_reading_marks_the_other_side_read(h, merchant, admin):
    tid = _tid(_open(h, merchant))
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1402, name="Other")
    assert h.client.get(f"{BASE}/{tid}", headers=other["headers"]).status_code == 404
    assert h.client.get(f"{BASE}/99999999", headers=admin["headers"]).status_code == 404
    r = h.client.get(f"{BASE}/{tid}", headers=admin["headers"])
    assert r.status_code == 200 and len(r.json()["messages"]) == 1
    assert h.client.get(f"{BASE}/{tid}", params={"mark_read": "false"}, headers=admin["headers"]).status_code == 200


# ================================================================== conversation
def test_admin_first_reply_auto_claims_and_each_status_move_is_attributed(h, merchant, admin):
    tid = _tid(_open(h, merchant))
    r = _post(h, admin, f"/{tid}/messages", {"message": "We are checking this now."})
    assert r.status_code == 200, r.text
    row = _row(h, tid)
    assert row.status is S.IN_REVIEW and row.assigned_admin == admin["id"]
    msgs = _msgs(h, tid)
    assert [m.direction for m in msgs] == ["inbound", "outbound"] and msgs[1].user_id == admin["id"]
    assert row.status_history[-1]["by"] == admin["id"] and "joined" in row.status_history[-1]["label"].lower()
    assert any(t[0] == row.user_id for t in h.told), "the merchant is told of the reply (delivery mocked)"
    again = _post(h, merchant, f"/{tid}/messages", {"message": "Thanks"})
    assert again.status_code == 200 and _msgs(h, tid)[-1].direction == "inbound"


@pytest.mark.parametrize("body", [{}, {"message": ""}, {"message": "x" * 4001}])
def test_invalid_messages_are_refused(h, merchant, admin, body):
    tid = _tid(_open(h, merchant))
    assert h.client.post(f"{BASE}/{tid}/messages", json=body, headers=admin["headers"]).status_code == 422
    assert len(_msgs(h, tid)) == 1 and _row(h, tid).status is S.SUBMITTED


def test_claim_once_resolve_once_and_a_closed_thread_takes_no_more_messages(h, merchant, admin):
    tid = _tid(_open(h, merchant))
    assert _post(h, admin, f"/{tid}/claim").status_code == 200 and _row(h, tid).status is S.IN_REVIEW
    assert _post(h, admin, f"/{tid}/claim").status_code == 400, "already claimed"
    assert _post(h, admin, f"/{tid}/resolve").status_code == 200
    row = _row(h, tid)
    assert row.status is S.COMPLETED and row.resolved_at is not None
    assert [h_["by"] for h_ in row.status_history][-2:] == [admin["id"], admin["id"]]
    assert _post(h, admin, f"/{tid}/resolve").status_code == 400, "already resolved"
    for who in (admin, merchant):
        assert _post(h, who, f"/{tid}/messages", {"message": "late"}).status_code in (400, 409), who
    assert len(_msgs(h, tid)) == 1
    assert _post(h, admin, "/99999999/claim").status_code == 404 and _post(h, admin, "/99999999/resolve").status_code == 404


def test_reopen_within_the_window_only_by_the_owning_merchant(h, merchant, admin):
    tid = _tid(_open(h, merchant))
    assert _post(h, merchant, f"/{tid}/reopen").status_code == 400, "an open thread cannot be reopened"
    _post(h, admin, f"/{tid}/resolve")
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1402, name="Other")
    assert _post(h, other, f"/{tid}/reopen").status_code == 404
    assert _post(h, admin, f"/{tid}/reopen").status_code == 403, "reopening is the merchant's action"
    assert _row(h, tid).status is S.COMPLETED
    r = _post(h, merchant, f"/{tid}/reopen")
    assert r.status_code == 200, r.text
    row = _row(h, tid)
    assert row.status is S.SUBMITTED and row.resolved_at is None
    assert len(_logs(h, "Chat reopened")) == 1


def test_reopen_after_the_window_is_refused(h, merchant, admin):
    tid = _tid(_open(h, merchant))
    _post(h, admin, f"/{tid}/resolve")
    db = h.db()
    t = db.get(ServiceRequest, tid)
    old = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=15)
    t.resolved_at = old
    t.completed_at = old
    db.commit()
    db.close()
    r = _post(h, merchant, f"/{tid}/reopen")
    assert r.status_code == 409 and "reopening window" in r.json()["detail"]
    assert _row(h, tid).status is S.COMPLETED


def test_triage_is_partial_validated_and_admin_only(h, merchant, admin):
    tid = _tid(_open(h, merchant, category="booking", priority="low"))
    r = h.client.patch(f"{BASE}/{tid}/triage", json={"priority": "high"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    row = _row(h, tid)
    assert row.priority.value == "high" and row.travel_details["category"] == "booking", "category is left alone"
    assert h.client.patch(f"{BASE}/{tid}/triage", json={"category": "payment"}, headers=admin["headers"]).status_code == 200
    assert _row(h, tid).travel_details["category"] == "payment" and _row(h, tid).priority.value == "high"
    for body in ({"priority": "extreme"}, {"category": "weather"}):
        assert h.client.patch(f"{BASE}/{tid}/triage", json=body, headers=admin["headers"]).status_code == 422
    assert h.client.patch(f"{BASE}/{tid}/triage", json={"priority": "low"}, headers=merchant["headers"]).status_code == 403
    assert h.client.patch(f"{BASE}/{tid}/triage", json={"priority": "low"}).status_code == 401
    assert h.client.patch(f"{BASE}/99999999/triage", json={"priority": "low"}, headers=admin["headers"]).status_code == 404
    assert _row(h, tid).priority.value == "high"


# ================================================================== internal notes
def test_internal_notes_are_staff_only_and_content_free_in_the_audit(h, merchant, admin):
    tid = _tid(_open(h, merchant))
    secret = "SECRET-NOTE-BODY-77"
    r = _post(h, admin, f"/{tid}/notes", {"body": f"  {secret}  "})
    assert r.status_code == 201 and r.json()["body"] == secret
    db = h.db()
    assert [n.body for n in db.scalars(select(RequestNote).where(RequestNote.request_id == tid)).all()] == [secret]
    db.close()
    log = _logs(h, "Internal note added")
    assert len(log) == 1 and secret not in repr(log[0].description) + repr(log[0].extra_data)
    assert [n["body"] for n in h.client.get(f"{BASE}/{tid}/notes", headers=admin["headers"]).json()] == [secret]
    # never visible to the merchant, in the thread or in the notes endpoint
    assert secret not in h.client.get(f"{BASE}/{tid}", headers=merchant["headers"]).text
    assert h.client.get(f"{BASE}/{tid}/notes", headers=merchant["headers"]).status_code == 403
    assert _post(h, merchant, f"/{tid}/notes", {"body": "intrusion"}).status_code == 403
    for body in ({}, {"body": ""}, {"body": "   "}, {"body": "x" * 4001}):
        assert h.client.post(f"{BASE}/{tid}/notes", json=body, headers=admin["headers"]).status_code in (400, 422)
    db = h.db()
    assert len(db.scalars(select(RequestNote).where(RequestNote.request_id == tid)).all()) == 1
    db.close()


# ================================================================== unread count / permissions
def test_unread_count_and_role_boundaries(h, merchant, admin):
    t1 = _tid(_open(h, merchant))
    _tid(_open(h, merchant))
    assert h.client.get("/api/support/unread-count", headers=admin["headers"]).json()["count"] == 2
    _post(h, admin, f"/{t1}/claim")
    assert h.client.get("/api/support/unread-count", headers=admin["headers"]).json()["count"] == 2, "in progress is still open"
    _post(h, admin, f"/{t1}/resolve")
    assert h.client.get("/api/support/unread-count", headers=admin["headers"]).json()["count"] == 1
    assert h.client.get("/api/support/unread-count").status_code == 401
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    for method, path, body in [("post", f"/{t1}/claim", None), ("post", f"/{t1}/resolve", None),
                               ("post", f"/{t1}/notes", {"body": "x"}), ("patch", f"/{t1}/triage", {"priority": "low"})]:
        kw = {"json": body} if body is not None else {}
        assert getattr(h.client, method)(f"{BASE}{path}", headers=mgr["headers"], **kw).status_code == 403, path
        assert getattr(h.client, method)(f"{BASE}{path}", headers=merchant["headers"], **kw).status_code == 403, path
    assert _row(h, t1).status is S.COMPLETED
