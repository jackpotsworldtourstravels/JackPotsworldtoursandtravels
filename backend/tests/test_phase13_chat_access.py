"""Phase 13 — B2C live-chat access, ownership, supervision, WebSocket re-checks and call routing.

Owner decisions under test (ADMIN_PORTAL_IMPLEMENTATION_TRACKER.md, Phase 13 parts 2-3):
  F-12a / X6  the console (REST, /ws-ticket, socket) needs an ACTIVE super admin or explicit ``b2c.chat.manage``;
              any other ``b2c.*`` scope (e.g. ``b2c.customers.view``) is refused, audited DENIED.
  D8          a conversation is read only by its ASSIGNED agent or a super admin (thread, calls, context, files).
  D9          replies, internal notes, status and transfer need ownership; another agent gets 409.
  C4 / D7     an active super admin may read and write any conversation; every non-owner read/write is audited.
  C8          ordinary agents see the customer's NAME only for unassigned rows (no email / mobile / preview).
  X4          transfer targets, /agents and auto-assignment are eligible agents only.
  X5          revoking the scope or suspending the account closes a connected socket with 4403 at the next frame.
  C5          calls: assigned -> the assigned eligible agent + super admins; unassigned -> every eligible agent;
              only someone on that ring list may answer.

Real routers, gateway, chat/call services and in-process broker on a throw-away temp-file SQLite database. The
B2C audit writer, the gateway and the call handlers are pointed at that database; nothing can reach PostgreSQL,
Redis, ``.env`` or ``dev.db``. Multi-worker (Redis) fan-out and WebRTC media are NOT covered.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import datetime as dt
import json
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, select
from sqlalchemy.orm import sessionmaker
from starlette.websockets import WebSocketDisconnect

from app.auth.rate_limit import limiter
from app.auth.rbac import P
from app.auth.security import create_access_token
from app.config import settings
from app.database.session import get_db
from app.models_customer import (
    AdminAuditOutcome, Base, Customer, CustomerAdminAuditLog, CustomerBooking, CustomerCall, CustomerChatAttachment,
    CustomerChatMessage, CustomerConversation, CustomerHotelBooking, CustomerPackageBooking,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_chat, customer_chat
from app.services import activity_service, call_handlers, chat_access, chat_gateway
from app.services import customer_admin_audit_service as b2c_audit_service
from app.services import customer_call_service as calls
from app.services.chat_broker import get_broker, reset_broker_for_tests
from tests._v2_harness import _sqlite_default

API = "/api/admin/chat"
_N = {"n": 860000}
NOW = dt.datetime.now(dt.timezone.utc)


def _id():
    _N["n"] += 1
    return _N["n"]


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", None, raising=False)
    monkeypatch.setattr(limiter, "enabled", False)
    reset_broker_for_tests()
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    md = MetaData()
    for model in (Customer, CustomerConversation, CustomerChatMessage, CustomerChatAttachment, CustomerCall,
                  CustomerAdminAuditLog, CustomerBooking, CustomerHotelBooking, CustomerPackageBooking, User):
        tbl = model.__table__.to_metadata(md)
        for con in list(tbl.constraints):
            if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
                tbl.constraints.discard(con)
        for idx in list(tbl.indexes):
            tbl.indexes.discard(idx)
        for col in tbl.columns:
            col.foreign_keys.clear()
            col.server_default = _sqlite_default(col)
            if not col.primary_key:
                col.nullable = True
        tbl.create(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    for module in (chat_gateway, call_handlers, b2c_audit_service):
        monkeypatch.setattr(module, "SessionLocal", Session)
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(customer_chat.router)
    app.include_router(admin_chat.router)

    def _db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _db

    class E:
        pass

    e = E()
    e.Session = Session
    e.app = app
    monkeypatch.setattr(activity_service, "log_activity", lambda *a, **k: None)
    yield e
    reset_broker_for_tests()
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


@pytest.fixture()
def client(env):
    with TestClient(env.app, raise_server_exceptions=False) as c:
        yield c


# ------------------------------------------------------------------ builders
def _user(env, role=UserRole.ADMIN, perms=(), name="Agent", status=UserStatus.ACTIVE):
    db = env.Session()
    u = User(user_id=_id(), full_name=name, email=f"a{_N['n']}@tt-qa.com", password_hash="x", role=role,
             status=status, permissions=list(perms), created_at=NOW)
    db.add(u)
    db.commit()
    uid = u.user_id
    db.close()
    return {"id": uid, "name": name, "headers": {"Authorization": f"Bearer {create_access_token(uid)}"}}


def _agent(env, name):
    return _user(env, UserRole.ADMIN, [P.B2C_CHAT_MANAGE], name)


def _set_user(env, uid, **fields):
    db = env.Session()
    u = db.get(User, uid)
    for k, v in fields.items():
        setattr(u, k, v)
    db.commit()
    db.close()


def _conversation(env, *, assigned=None, status="waiting", name="Cara Customer", last="my booking JPF1 is late"):
    db = env.Session()
    c = Customer(customer_id=_id(), customer_code=f"C{_N['n']}", full_name=name, email=f"cara{_N['n']}@tt-qa.com",
                 mobile="9123456780")
    db.add(c)
    db.flush()
    conv = CustomerConversation(conversation_id=_id(), customer_id=c.customer_id, status=status,
                                assigned_admin_id=assigned["id"] if assigned else None,
                                assigned_admin_name=assigned["name"] if assigned else None,
                                last_message=last, last_message_at=NOW, admin_unread_count=1,
                                customer_unread_count=0, created_at=NOW, updated_at=NOW)
    db.add(conv)
    db.flush()
    db.add(CustomerChatMessage(message_id=_id(), conversation_id=conv.conversation_id, sender_type="customer",
                               body=last, message_type="text", is_internal=False, created_at=NOW))
    db.commit()
    out = (conv.conversation_id, c.customer_id)
    db.close()
    return out


def _conv(env, cid):
    db = env.Session()
    row = db.get(CustomerConversation, cid)
    db.close()
    return row


def _messages(env, cid):
    db = env.Session()
    rows = db.scalars(select(CustomerChatMessage).where(CustomerChatMessage.conversation_id == cid)).all()
    db.close()
    return [m for m in rows if m.sender_type != "system"]


def _audit(env, action=None, outcome=None):
    db = env.Session()
    rows = db.scalars(select(CustomerAdminAuditLog)).all()
    db.close()
    return [r for r in rows if (action is None or r.action == action) and (outcome is None or r.outcome == outcome)]


# ------------------------------------------------------------------ socket helpers
def _ticket(actor):
    return asyncio.run(get_broker().issue_ticket(actor))


def _recv(ws, timeout=5):
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return json.loads(pool.submit(ws.receive_text).result(timeout=timeout))


def _send(ws, event, data=None):
    ws.send_text(json.dumps({"event": event, "data": data or {}}))


def _next(ws, event):
    for _ in range(20):
        f = _recv(ws)
        if f["event"] == event:
            return f
    raise AssertionError(f"no {event} frame")


def _drain(ws):
    frames = []
    for _ in range(2):
        _send(ws, "ping")
        while True:
            f = _recv(ws)
            if f["event"] == "pong":
                break
            frames.append(f)
    return frames


AWS = API + "/ws"
CWS = "/api/customer/chat/ws"


@pytest.fixture()
def people(env):
    return {
        "a": _agent(env, "Agent Ada"),
        "b": _agent(env, "Agent Bo"),
        "viewer": _user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW], "View Only Vic"),
        "super": _user(env, UserRole.SUPER_ADMIN, [], "Super Sue"),
    }


# ================================================================== console gate (F-12a / X6)
def test_view_only_admin_is_refused_every_console_route_and_the_refusal_is_audited(env, client, people):
    conv, _ = _conversation(env, assigned=people["a"])
    v = people["viewer"]["headers"]
    for method, path in (("get", "/conversations"), ("get", f"/conversations/{conv}"), ("post", "/ws-ticket"),
                         ("get", "/agents"), ("get", "/analytics"), ("get", "/ice"),
                         ("get", f"/conversations/{conv}/calls"), ("get", f"/conversations/{conv}/context"),
                         ("post", f"/conversations/{conv}/claim"),
                         ("post", f"/conversations/{conv}/read?up_to_message_id=1")):
        r = getattr(client, method)(API + path, headers=v)
        assert r.status_code == 403, (path, r.text)
    r = client.post(f"{API}/conversations/{conv}/messages", json={"body": "hi"}, headers=v)
    assert r.status_code == 403
    assert _messages(env, conv)[-1].body != "hi"
    denied = _audit(env, "chat.access", AdminAuditOutcome.DENIED)
    assert denied and all(d.reason == "missing b2c.chat.manage" for d in denied)


def test_ineligible_accounts_cannot_mint_a_ticket(env, client):
    for who in (_user(env, UserRole.ADMIN, [], "Role Default"),
                _user(env, UserRole.MERCHANT_ADMIN, [P.B2C_CHAT_MANAGE], "Merchant With Scope"),
                _user(env, UserRole.ADMIN, [P.B2C_CHAT_MANAGE], "Suspended", status=UserStatus.SUSPENDED)):
        assert client.post(f"{API}/ws-ticket", headers=who["headers"]).status_code in (401, 403), who["name"]
    for who in (_agent(env, "Real Agent"), _user(env, UserRole.SUPER_ADMIN, [], "Super")):
        r = client.post(f"{API}/ws-ticket", headers=who["headers"])
        assert r.status_code == 200 and r.json()["ticket"]


# ================================================================== queue privacy (D8 / C8)
def test_agent_queue_shows_own_and_unassigned_name_only(env, client, people):
    mine, _ = _conversation(env, assigned=people["a"], name="Mine Customer")
    free, _ = _conversation(env, name="Free Customer", last="secret preview text")
    theirs, _ = _conversation(env, assigned=people["b"], name="Their Customer")
    rows = {r["conversation_id"]: r for r in
            client.get(f"{API}/conversations", headers=people["a"]["headers"]).json()["conversations"]}
    assert set(rows) == {mine, free}, "another agent's conversation is not listed"
    assert rows[mine]["customer_email"] and rows[mine]["customer_mobile"] and rows[mine]["last_message"]
    assert rows[free]["customer_name"] == "Free Customer"
    assert rows[free]["customer_email"] is None and rows[free]["customer_mobile"] is None
    assert rows[free]["last_message"] is None
    assert "secret preview text" not in client.get(f"{API}/conversations", headers=people["a"]["headers"]).text


def test_agent_search_cannot_match_unassigned_rows_on_hidden_fields(env, client, people):
    free, cust = _conversation(env, name="Hidden Hannah")
    db = env.Session()
    email = db.get(Customer, cust).email
    db.close()
    hits = client.get(f"{API}/conversations", params={"q": email}, headers=people["a"]["headers"]).json()
    assert hits["conversations"] == [], "searching an email must not reveal whose unassigned chat it is"
    by_name = client.get(f"{API}/conversations", params={"q": "Hidden"}, headers=people["a"]["headers"]).json()
    assert [r["conversation_id"] for r in by_name["conversations"]] == [free]
    sup = client.get(f"{API}/conversations", params={"q": email}, headers=people["super"]["headers"]).json()
    assert [r["conversation_id"] for r in sup["conversations"]] == [free]


def test_super_admin_queue_shows_everything_unmasked(env, client, people):
    a, _ = _conversation(env, assigned=people["a"])
    b, _ = _conversation(env, assigned=people["b"])
    free, _ = _conversation(env)
    rows = {r["conversation_id"]: r for r in
            client.get(f"{API}/conversations", headers=people["super"]["headers"]).json()["conversations"]}
    assert set(rows) == {a, b, free}
    assert all(r["customer_email"] and r["last_message"] for r in rows.values())


# ================================================================== reading (D8, C4)
def test_only_the_owner_or_a_super_admin_may_read_a_thread(env, client, people):
    conv, _ = _conversation(env, assigned=people["a"])
    free, _ = _conversation(env)
    assert client.get(f"{API}/conversations/{conv}", headers=people["a"]["headers"]).status_code == 200
    for path in (f"/conversations/{conv}", f"/conversations/{conv}/calls", f"/conversations/{conv}/context"):
        assert client.get(API + path, headers=people["b"]["headers"]).status_code == 403, path
    r = client.get(f"{API}/conversations/{free}", headers=people["b"]["headers"])
    assert r.status_code == 403 and "Claim" in r.json()["detail"], "an unassigned thread opens only after a claim"
    assert _audit(env, "chat.read", AdminAuditOutcome.DENIED)
    assert client.get(f"{API}/conversations/{conv}", headers=people["super"]["headers"]).status_code == 200
    sup = _audit(env, "chat.supervise_read", AdminAuditOutcome.SUCCESS)
    assert len(sup) == 1 and sup[0].admin_user_id == people["super"]["id"]
    # the owner's own reads are not "supervision"
    client.get(f"{API}/conversations/{conv}", headers=people["a"]["headers"])
    assert len(_audit(env, "chat.supervise_read")) == 1


def test_a_non_owner_cannot_download_a_conversation_file(env, client, people):
    conv, _ = _conversation(env, assigned=people["a"])
    db = env.Session()
    msg = CustomerChatMessage(message_id=_id(), conversation_id=conv, sender_type="customer", body="file",
                              message_type="file", is_internal=False, created_at=NOW)
    db.add(msg)
    db.flush()
    att = CustomerChatAttachment(attachment_id=_id(), message_id=msg.message_id, storage_key="chat/x/ticket.pdf",
                                 file_name="ticket.pdf", mime_type="application/pdf", file_size=10, created_at=NOW)
    db.add(att)
    db.commit()
    att_id = att.attachment_id
    db.close()
    r = client.get(f"{API}/attachments/{att_id}", headers=people["b"]["headers"])
    assert r.status_code == 403, r.text
    assert client.get(f"{API}/attachments/{att_id}", headers=people["viewer"]["headers"]).status_code == 403
    assert len(_audit(env, "document.download", AdminAuditOutcome.DENIED)) == 2
    assert not _audit(env, "document.download", AdminAuditOutcome.SUCCESS)
    # The owner and a super admin get past the ownership check (no 403, no 500 from a missing
    # attribute); the file itself is served by a stub so no storage is touched.
    from fastapi.responses import PlainTextResponse
    from app.services import chat_attachments
    import pytest as _pt
    mp = _pt.MonkeyPatch()
    mp.setattr(chat_attachments, "download", lambda a: PlainTextResponse("file-bytes"))
    try:
        for who in ("a", "super"):
            r = client.get(f"{API}/attachments/{att_id}", headers=people[who]["headers"])
            assert r.status_code == 200 and r.text == "file-bytes", (who, r.text)
    finally:
        mp.undo()
    ok = _audit(env, "document.download", AdminAuditOutcome.SUCCESS)
    assert len(ok) == 2 and {o.new_value["conversation_id"] for o in ok} == {conv}
    assert [o.new_value["as_supervisor"] for o in ok] == [False, True]


# ================================================================== claim / write / transfer (D9, D7, X4)
def test_claim_then_ownership_rules_for_every_write(env, client, people):
    conv, _ = _conversation(env)
    A, B = people["a"]["headers"], people["b"]["headers"]
    # before anyone claims, nobody but a super admin may write
    r = client.post(f"{API}/conversations/{conv}/messages", json={"body": "hello"}, headers=A)
    assert r.status_code == 409 and "Claim" in r.json()["detail"]
    assert client.post(f"{API}/conversations/{conv}/claim", headers=A).status_code == 200
    assert client.post(f"{API}/conversations/{conv}/claim", headers=B).status_code == 409, "B lost the claim"
    assert _conv(env, conv).assigned_admin_id == people["a"]["id"]
    before = len(_messages(env, conv))
    for path, body in (("/messages", {"body": "B reply"}), ("/messages", {"body": "B note", "is_internal": True}),
                       ("/status", {"status": "resolved"}), ("/transfer", {"to_admin_id": people["b"]["id"]})):
        r = client.post(f"{API}/conversations/{conv}{path}", json=body, headers=B)
        assert r.status_code == 409, (path, r.text)
    assert len(_messages(env, conv)) == before, "nothing B sent was stored"
    assert _conv(env, conv).assigned_admin_id == people["a"]["id"] and _conv(env, conv).status != "resolved"
    # the owner may do all of it
    assert client.post(f"{API}/conversations/{conv}/messages", json={"body": "A reply"}, headers=A).status_code == 201
    assert client.post(f"{API}/conversations/{conv}/messages", json={"body": "A note", "is_internal": True},
                       headers=A).status_code == 201
    assert client.post(f"{API}/conversations/{conv}/status", json={"status": "resolved"}, headers=A).status_code == 200
    assert {m.body for m in _messages(env, conv)} >= {"A reply", "A note"}
    assert not _audit(env, "chat.reply_supervisor") and not _audit(env, "chat.note_supervisor")


def test_super_admin_may_write_into_someone_elses_conversation_and_it_is_audited_without_the_text(env, client, people):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    S = people["super"]["headers"]
    assert client.post(f"{API}/conversations/{conv}/messages", json={"body": "Supervisor here"}, headers=S).status_code == 201
    assert client.post(f"{API}/conversations/{conv}/messages", json={"body": "private aside", "is_internal": True},
                       headers=S).status_code == 201
    reply = _audit(env, "chat.reply_supervisor", AdminAuditOutcome.SUCCESS)
    note = _audit(env, "chat.note_supervisor", AdminAuditOutcome.SUCCESS)
    assert len(reply) == 1 and len(note) == 1
    for row in reply + note:
        blob = json.dumps(row.new_value) + json.dumps(row.previous_value or {})
        assert "Supervisor here" not in blob and "private aside" not in blob, "never the message text"
        assert row.new_value["assigned_admin_id"] == people["a"]["id"]
    assert _conv(env, conv).assigned_admin_id == people["a"]["id"], "supervision does not take the conversation"
    r = client.post(f"{API}/conversations/{conv}/status", json={"status": "resolved"}, headers=S)
    assert r.status_code == 200
    st = _audit(env, "chat.set_status", AdminAuditOutcome.SUCCESS)
    assert st and st[-1].new_value["as_supervisor"] is True


def test_transfer_only_to_eligible_agents_and_agents_list_matches(env, client, people):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    A = people["a"]["headers"]
    merchant = _user(env, UserRole.MERCHANT_ADMIN, [P.B2C_CHAT_MANAGE], "Merchant M")
    suspended = _user(env, UserRole.ADMIN, [P.B2C_CHAT_MANAGE], "Suspended S", status=UserStatus.SUSPENDED)
    no_scope = _user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW], "No Scope N")
    for bad in (merchant, suspended, no_scope, people["viewer"]):
        r = client.post(f"{API}/conversations/{conv}/transfer", json={"to_admin_id": bad["id"]}, headers=A)
        assert r.status_code == 400, bad["name"]
    assert client.post(f"{API}/conversations/{conv}/transfer", json={"to_admin_id": 99999999}, headers=A).status_code == 400
    assert _conv(env, conv).assigned_admin_id == people["a"]["id"]
    listed = {r["admin_id"] for r in client.get(f"{API}/agents", headers=A).json()}
    assert listed == {people["a"]["id"], people["b"]["id"], people["super"]["id"]}
    r = client.post(f"{API}/conversations/{conv}/transfer", json={"to_admin_id": people["b"]["id"]}, headers=A)
    assert r.status_code == 200 and _conv(env, conv).assigned_admin_id == people["b"]["id"]
    assert _audit(env, "chat.transfer", AdminAuditOutcome.SUCCESS)
    # A no longer owns it
    assert client.get(f"{API}/conversations/{conv}", headers=A).status_code == 403


def test_auto_assignment_candidates_are_eligible_agents_only(env, people):
    from app.services import chat_assignment

    _user(env, UserRole.ADMIN, [], "Role Default")
    _user(env, UserRole.MERCHANT_ADMIN, [P.B2C_CHAT_MANAGE], "Merchant")
    _user(env, UserRole.ADMIN, [P.B2C_CHAT_MANAGE], "Suspended", status=UserStatus.SUSPENDED)
    db = env.Session()
    ids = {uid for uid, _name in chat_assignment.candidates(db)}
    db.close()
    assert ids == {people["a"]["id"], people["b"]["id"], people["super"]["id"]}


# ================================================================== call routing (C5)
def test_call_ring_list_follows_assignment(env, people):
    unassigned, _ = _conversation(env)
    assigned, _ = _conversation(env, assigned=people["a"])
    ineligible_owner = _user(env, UserRole.ADMIN, [], "Lost Scope")
    orphan, _ = _conversation(env, assigned=ineligible_owner)
    db = env.Session()
    ring = lambda cid: chat_access.call_ring_list(db, db.get(CustomerConversation, cid))   # noqa: E731
    assert set(ring(unassigned)) == {people["a"]["id"], people["b"]["id"], people["super"]["id"]}
    assert ring(assigned) == [people["a"]["id"], people["super"]["id"]]
    assert ring(orphan) == [people["super"]["id"]], "an owner who lost the scope is not rung"
    db.close()


def _ringing_call(env, conv):
    db = env.Session()
    conversation = db.get(CustomerConversation, conv)
    call = calls.start(db, conversation, direction="customer_to_admin")
    call.status = "ringing"
    db.commit()
    public_id = call.public_id
    db.close()
    return public_id


def _session(uid, name):
    sent, failed = [], []

    async def send(event, data):
        sent.append((event, data))

    async def fail(code, message):
        failed.append((code, message))

    return call_handlers.CallSession(kind="admin", actor_id=uid, actor_name=name, send=send, fail=fail), sent, failed


def test_only_the_ring_list_may_answer_a_call(env, people):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    call_id = _ringing_call(env, conv)
    sess_b, sent_b, failed_b = _session(people["b"]["id"], "Agent Bo")
    asyncio.run(sess_b.accept({"call_id": call_id}))
    assert failed_b and failed_b[0][0] == "call_rejected" and "not routed to you" in failed_b[0][1]
    db = env.Session()
    assert calls.get_by_public_id(db, call_id).status == "ringing" and calls.get_by_public_id(db, call_id).admin_id is None
    db.close()
    sess_a, sent_a, failed_a = _session(people["a"]["id"], "Agent Ada")
    asyncio.run(sess_a.accept({"call_id": call_id}))
    assert not failed_a and any(e == "call_status" for e, _ in sent_a)
    db = env.Session()
    assert calls.get_by_public_id(db, call_id).admin_id == people["a"]["id"]
    db.close()


def test_answering_an_unassigned_call_claims_the_conversation_once(env, people):
    conv, _ = _conversation(env)
    call_id = _ringing_call(env, conv)
    sess_b, sent_b, failed_b = _session(people["b"]["id"], "Agent Bo")
    asyncio.run(sess_b.accept({"call_id": call_id}))
    assert not failed_b
    assert _conv(env, conv).assigned_admin_id == people["b"]["id"]
    sess_a, sent_a, failed_a = _session(people["a"]["id"], "Agent Ada")
    asyncio.run(sess_a.accept({"call_id": call_id}))
    # A was on the ring list when it rang, but the conversation is now B's: refused, and nothing changes hands.
    assert failed_a or any(e == "call_taken" for e, _ in sent_a)
    assert _conv(env, conv).assigned_admin_id == people["b"]["id"]


def test_a_super_admin_may_answer_an_assigned_call(env, people):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    call_id = _ringing_call(env, conv)
    sess, sent, failed = _session(people["super"]["id"], "Super Sue")
    asyncio.run(sess.accept({"call_id": call_id}))
    assert not failed and any(e == "call_status" for e, _ in sent)
    assert _conv(env, conv).assigned_admin_id == people["a"]["id"], "answering does not take an assigned chat"
    sup = _audit(env, "chat.call_answer_supervisor", AdminAuditOutcome.SUCCESS)
    assert len(sup) == 1 and sup[0].new_value["assigned_admin_id"] == people["a"]["id"]


def test_an_admin_who_lost_the_scope_cannot_answer_even_their_own_assigned_call(env, people):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    call_id = _ringing_call(env, conv)
    _set_user(env, people["a"]["id"], permissions=[])
    sess, sent, failed = _session(people["a"]["id"], "Agent Ada")
    asyncio.run(sess.accept({"call_id": call_id}))
    assert failed and "not routed to you" in failed[0][1]


# ================================================================== WebSocket (D8, D9, X5)
def test_socket_refuses_a_non_owner_join_write_and_typing(env, client, people):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    with client.websocket_connect(f"{AWS}?ticket={_ticket('admin:%d' % people['b']['id'])}") as ws:
        _send(ws, "join_chat", {"conversation_id": conv})
        assert _next(ws, "error")["data"]["code"] == "not_assigned"
        _send(ws, "send_message", {"conversation_id": conv, "body": "sneaky"})
        assert _next(ws, "error")["data"]["code"] == "not_assigned"
        _send(ws, "send_message", {"conversation_id": conv, "body": "sneaky note", "is_internal": True})
        assert _next(ws, "error")["data"]["code"] == "not_assigned"
        _send(ws, "typing_start", {"conversation_id": conv})
        assert _next(ws, "error")["data"]["code"] == "not_assigned"
        _send(ws, "message_read", {"conversation_id": conv, "up_to_message_id": 1})
        assert _next(ws, "error")["data"]["code"] == "not_assigned"
        _send(ws, "typing_start", {"conversation_id": 99999999})
        assert _next(ws, "error")["data"]["code"] == "not_found"
    assert not any(m.body and "sneaky" in m.body for m in _messages(env, conv))
    assert _audit(env, "chat.socket_read", AdminAuditOutcome.DENIED)
    assert _audit(env, "chat.socket_write", AdminAuditOutcome.DENIED)


def test_socket_owner_flow_and_internal_notes_never_reach_the_customer(env, client, people):
    db = env.Session()
    cust = Customer(customer_id=_id(), customer_code="CW1", full_name="Wendy", email="wendy@tt-qa.com", mobile="9")
    db.add(cust)
    db.commit()
    cid = cust.customer_id
    db.close()
    with client.websocket_connect(f"{CWS}?ticket={_ticket(f'customer:{cid}')}") as cws:
        conv = _next(cws, "joined")["data"]["conversation_id"]
        db = env.Session()
        c = db.get(CustomerConversation, conv)
        c.assigned_admin_id, c.assigned_admin_name, c.status = people["a"]["id"], "Agent Ada", "active"
        db.commit()
        db.close()
        with client.websocket_connect(f"{AWS}?ticket={_ticket('admin:%d' % people['a']['id'])}") as aws:
            _send(aws, "join_chat", {"conversation_id": conv})
            assert _next(aws, "joined")
            _send(aws, "send_message", {"conversation_id": conv, "body": "INTERNAL only", "is_internal": True})
            assert _next(aws, "receive_message")["data"]["body"] == "INTERNAL only"
            frames = _drain(cws)
            assert not any("INTERNAL" in (f["data"].get("body") or "") for f in frames)
            _send(aws, "send_message", {"conversation_id": conv, "body": "visible"})
            while _next(cws, "receive_message")["data"]["body"] != "visible":
                pass
    assert {m.body for m in _messages(env, conv)} == {"INTERNAL only", "visible"}


def test_super_admin_socket_supervision_is_audited(env, client, people):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    with client.websocket_connect(f"{AWS}?ticket={_ticket('admin:%d' % people['super']['id'])}") as ws:
        _send(ws, "join_chat", {"conversation_id": conv})
        assert _next(ws, "joined")
        _send(ws, "send_message", {"conversation_id": conv, "body": "SA socket reply"})
        assert _next(ws, "receive_message")["data"]["body"] == "SA socket reply"
    joins = [r for r in _audit(env, "chat.supervise_read") if r.new_value.get("what") == "live_join"]
    assert len(joins) == 1
    writes = _audit(env, "chat.reply_supervisor", AdminAuditOutcome.SUCCESS)
    assert len(writes) == 1 and writes[0].new_value["via"] == "socket"
    assert "SA socket reply" not in json.dumps(writes[0].new_value)


@pytest.mark.parametrize("revoke", [
    {"permissions": [P.B2C_CUSTOMERS_VIEW]},     # scope withdrawn
    {"status": UserStatus.SUSPENDED},            # account suspended
])
def test_revocation_closes_a_connected_socket_with_4403_at_the_next_frame(env, client, people, revoke):
    conv, _ = _conversation(env, assigned=people["a"], status="active")
    with client.websocket_connect(f"{AWS}?ticket={_ticket('admin:%d' % people['a']['id'])}") as ws:
        _send(ws, "join_chat", {"conversation_id": conv})
        assert _next(ws, "joined")
        _set_user(env, people["a"]["id"], **revoke)
        _send(ws, "send_message", {"conversation_id": conv, "body": "after revocation"})
        with pytest.raises(WebSocketDisconnect) as exc:
            for _ in range(5):
                _recv(ws)
        assert exc.value.code == 4403
    assert not any(m.body == "after revocation" for m in _messages(env, conv))
    rows = _audit(env, "chat.socket_revoked", AdminAuditOutcome.DENIED)
    assert len(rows) == 1 and rows[0].admin_user_id == people["a"]["id"]


def test_a_ticket_minted_before_revocation_cannot_open_the_socket(env, client, people):
    ticket = _ticket("admin:%d" % people["a"]["id"])
    _set_user(env, people["a"]["id"], permissions=[])
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"{AWS}?ticket={ticket}") as ws:
            _recv(ws)
    assert exc.value.code == 4403


def test_a_transferred_conversation_stops_streaming_to_the_previous_owner(env, client, people):
    db = env.Session()
    cust = Customer(customer_id=_id(), customer_code="CT1", full_name="Tina", email="tina@tt-qa.com", mobile="9")
    db.add(cust)
    db.commit()
    cid = cust.customer_id
    db.close()
    with client.websocket_connect(f"{CWS}?ticket={_ticket(f'customer:{cid}')}") as cws:
        conv = _next(cws, "joined")["data"]["conversation_id"]
        db = env.Session()
        c = db.get(CustomerConversation, conv)
        c.assigned_admin_id, c.assigned_admin_name, c.status = people["a"]["id"], "Agent Ada", "active"
        db.commit()
        db.close()
        with client.websocket_connect(f"{AWS}?ticket={_ticket('admin:%d' % people['a']['id'])}") as aws:
            _send(aws, "join_chat", {"conversation_id": conv})
            assert _next(aws, "joined")
            r = client.post(f"{API}/conversations/{conv}/transfer", json={"to_admin_id": people["b"]["id"]},
                            headers=people["super"]["headers"])
            assert r.status_code == 200
            _send(cws, "send_message", {"body": "for the new agent", "client_msg_id": "t-1"})
            _next(cws, "message_ack")
            left = _next(aws, "left")
            assert left["data"]["conversation_id"] == conv and left["data"]["reason"] == "no_longer_assigned"
            frames = _drain(aws)
            assert not any((f["data"].get("body") or "") == "for the new agent" for f in frames)
