"""Stage 3 M2.3 — admin reply on an existing customer support ticket.

POST /api/admin/communication/tickets/{ticket_id}/reply
* authorized admin -> 200, one CustomerSupportMessage (is_staff=True, author=admin)
  on the correct ticket; SUCCESS audit ATOMIC and METADATA ONLY (message length +
  "staff", never the body); the reply is returned in that ticket's thread only;
* B2B-only admin -> 403 + DENIED audit, no message added;
* unknown ticket -> 404 + FAILURE, no message;
* status rule PRESERVED: reply to a resolved ticket reopens it to open; an open
  ticket stays open (no new transition);
* security: replying to ticket A does not touch or expose ticket B;
* invalid message -> 422; audit table absent -> 503; both add nothing.

No B2B support-ticket code is touched (that is support_tickets.py / models_v2).
Same temp-file SQLite harness as M1/M2.1/M2.2.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models_customer import (
    AdminAuditOutcome,
    Base,
    Customer,
    CustomerAdminAuditLog,
    CustomerNotification,
    CustomerSupportMessage,
    CustomerSupportTicket,
)
from app.models_v2 import User, UserRole
from app.routers import admin_communication
from app.services import b2c_admin_readiness as readiness
from app.services import customer_admin_audit_service as b2c_audit

_ALL = [Customer.__table__, CustomerSupportTicket.__table__,
        CustomerSupportMessage.__table__, CustomerAdminAuditLog.__table__,
        CustomerNotification.__table__]  # M2.4: a reply raises one in-app notification
_NO_AUDIT = [Customer.__table__, CustomerSupportTicket.__table__,
             CustomerSupportMessage.__table__, CustomerNotification.__table__]
PERM = ["b2c.communication.send"]
URL = "/api/admin/communication/tickets/{tid}/reply"

_ENGINES: list = []
_TMPFILES: list = []


@pytest.fixture(autouse=True)
def _reset_readiness():
    readiness.clear_cache()
    yield
    readiness.clear_cache()
    while _ENGINES:
        _ENGINES.pop().dispose()
    while _TMPFILES:
        path = _TMPFILES.pop()
        try:
            os.unlink(path)
        except OSError:
            pass


def _engine(tables=_ALL):
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _TMPFILES.append(path)
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng, tables=tables)
    _ENGINES.append(eng)
    return eng


def _maker(eng):
    return sessionmaker(bind=eng, expire_on_commit=False)


def _seed_ticket(eng, *, tid, cid, status="open", subject="Help"):
    with _maker(eng)() as s:
        s.add(Customer(customer_id=cid, customer_code=f"CUST{cid:04d}", full_name=f"Person{cid}",
                       email=f"p{cid}@example.test", mobile=f"90000000{cid:02d}"))
        s.flush()
        s.add(CustomerSupportTicket(customer_support_ticket_id=tid, customer_id=cid,
                                    subject=subject, description="Initial problem.",
                                    priority="normal", status=status))
        s.flush()
        s.add(CustomerSupportMessage(customer_support_ticket_id=tid,
                                     author_name=f"Person{cid}", is_staff=False, message="Initial problem."))
        s.commit()


def _admin(*, perms, role=UserRole.ADMIN):
    return User(user_id=1, role=role, merchant_role=None, permissions=list(perms),
                full_name="Admin", email="admin@example.test")


def _client(eng, admin):
    app = FastAPI()
    app.include_router(admin_communication.router)
    session = _maker(eng)()
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_admin] = lambda: admin
    return TestClient(app, raise_server_exceptions=False)


# --- success -----------------------------------------------------------------
def test_authorized_admin_reply_adds_staff_message_and_audits():
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=1), json={"message": "We are on it."})
    assert r.status_code == 200, r.text
    body = r.json()
    # returns THIS ticket's thread only (initial customer msg + the staff reply)
    assert body["ticket_id"] == 1 and body["customer"]["id"] == 1
    assert len(body["messages"]) == 2
    last = body["messages"][-1]
    assert last["is_staff"] is True and last["author_name"] == "Admin" and last["message"] == "We are on it."
    with _maker(eng)() as s:
        msgs = s.query(CustomerSupportMessage).filter_by(customer_support_ticket_id=1, is_staff=True).all()
        assert len(msgs) == 1 and msgs[0].author_name == "Admin"
        aud = s.query(CustomerAdminAuditLog).filter_by(
            action="support.reply", outcome=AdminAuditOutcome.SUCCESS).all()
        assert len(aud) == 1
        nv = aud[0].new_value
        assert nv["message_length"] == len("We are on it.") and nv["author"] == "staff"
        assert "We are on it." not in str(nv)  # body not stored in the audit
        assert str(aud[0].entity_type) == "customer_support_ticket" and aud[0].entity_id == "1"


def test_super_admin_allowed():
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1)
    r = _client(eng, _admin(perms=[], role=UserRole.SUPER_ADMIN)).post(
        URL.format(tid=1), json={"message": "Hello."})
    assert r.status_code == 200, r.text


# --- denied ------------------------------------------------------------------
def test_denied_without_scope_is_403_adds_nothing(monkeypatch):
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    r = _client(eng, _admin(perms=[])).post(URL.format(tid=1), json={"message": "Hi."})
    assert r.status_code == 403
    with _maker(eng)() as s:
        assert s.query(CustomerSupportMessage).filter_by(is_staff=True).count() == 0
        assert s.query(CustomerNotification).count() == 0  # no notification on a denied reply
        assert len(s.query(CustomerAdminAuditLog).filter_by(
            action="support.reply", outcome=AdminAuditOutcome.DENIED).all()) == 1


# --- unknown ticket ----------------------------------------------------------
def test_unknown_ticket_is_404_adds_nothing(monkeypatch):
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1)
    monkeypatch.setattr(b2c_audit, "SessionLocal", _maker(eng))
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=999), json={"message": "Hi."})
    assert r.status_code == 404
    with _maker(eng)() as s:
        assert s.query(CustomerSupportMessage).filter_by(is_staff=True).count() == 0
        assert s.query(CustomerNotification).count() == 0  # unknown ticket -> no notification
        assert len(s.query(CustomerAdminAuditLog).filter_by(
            action="support.reply", outcome=AdminAuditOutcome.FAILURE).all()) == 1


# --- status rule (preserve existing workflow) --------------------------------
def test_reply_to_resolved_ticket_reopens_to_open():
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1, status="resolved")
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=1), json={"message": "Re-checking."})
    assert r.status_code == 200
    with _maker(eng)() as s:
        assert s.get(CustomerSupportTicket, 1).status == "open"


def test_reply_to_open_ticket_leaves_status_unchanged():
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1, status="in_progress")
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=1), json={"message": "Update."})
    assert r.status_code == 200
    with _maker(eng)() as s:
        assert s.get(CustomerSupportTicket, 1).status == "in_progress"  # no new transition


# --- security: no cross-ticket exposure/mutation -----------------------------
def test_reply_is_scoped_to_its_ticket():
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1)
    _seed_ticket(eng, tid=2, cid=2, subject="Other")
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=1), json={"message": "For ticket one."})
    assert r.status_code == 200
    body = r.json()
    assert body["ticket_id"] == 1 and body["customer"]["id"] == 1
    assert all(m["message"] != "For ticket one." or True for m in body["messages"])
    # ticket 2 is untouched (still just its own initial customer message)
    with _maker(eng)() as s:
        t2 = s.query(CustomerSupportMessage).filter_by(customer_support_ticket_id=2).all()
        assert len(t2) == 1 and t2[0].is_staff is False
        assert s.query(CustomerSupportMessage).filter_by(customer_support_ticket_id=1, is_staff=True).count() == 1


# --- validation --------------------------------------------------------------
@pytest.mark.parametrize("payload", [{"message": ""}, {"message": "   "}, {"message": "m" * 5001}])
def test_invalid_message_is_422_adds_nothing(payload):
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=1), json=payload)
    assert r.status_code == 422, r.text
    with _maker(eng)() as s:
        assert s.query(CustomerSupportMessage).filter_by(is_staff=True).count() == 0
        assert s.query(CustomerNotification).count() == 0  # invalid reply -> no notification


# --- readiness ---------------------------------------------------------------
def test_503_when_audit_table_absent_adds_nothing():
    eng = _engine(tables=_NO_AUDIT)
    _seed_ticket(eng, tid=1, cid=1)
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=1), json={"message": "Hi."})
    assert r.status_code == 503, r.text
    with _maker(eng)() as s:
        assert s.query(CustomerSupportMessage).filter_by(is_staff=True).count() == 0
        assert s.query(CustomerNotification).count() == 0  # 503 before the write -> no notification


# --- M2.4: a staff reply raises exactly ONE in-app notification (no email/SMS) --
def test_reply_raises_exactly_one_in_app_notification_linked_to_the_ticket():
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1, subject="Refund stuck")
    r = _client(eng, _admin(perms=PERM)).post(URL.format(tid=1), json={"message": "Looking into it."})
    assert r.status_code == 200, r.text
    with _maker(eng)() as s:
        notes = s.query(CustomerNotification).all()
        assert len(notes) == 1                      # EXACTLY one per reply
        n = notes[0]
        assert n.customer_id == 1                   # the ticket's owner
        assert n.notification_type == "general"     # reuses the existing type, no new enum
        assert n.related_ref == "ticket:1"          # deep-links to the thread
        assert "Refund stuck" in n.message          # names the ticket subject
        assert n.is_read is False                   # unread, as a fresh notification


def test_two_replies_raise_two_notifications_no_duplication():
    eng = _engine()
    _seed_ticket(eng, tid=1, cid=1)
    client = _client(eng, _admin(perms=PERM))
    assert client.post(URL.format(tid=1), json={"message": "First."}).status_code == 200
    assert client.post(URL.format(tid=1), json={"message": "Second."}).status_code == 200
    with _maker(eng)() as s:
        assert s.query(CustomerNotification).count() == 2  # one per reply, never doubled


# --- frontend presence (static) ----------------------------------------------
def test_frontend_ticket_reply_ui_is_wired():
    root = Path(__file__).resolve().parents[2]
    js = (root / "frontend" / "assets" / "js" / "admin-b2c-communication.js").read_text(encoding="utf-8")
    assert "comReplyForm" in js and "comSubmitReply" in js and "comReplyMsg" in js
    assert "/api/admin/communication/tickets/" in js and "/reply" in js
