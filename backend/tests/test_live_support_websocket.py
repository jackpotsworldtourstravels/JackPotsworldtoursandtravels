"""Verification of the LIVE SUPPORT WebSocket gateway (customer socket ``/api/customer/chat/ws`` and agent socket
``/api/admin/chat/ws``) against a local, isolated environment: the REAL gateway code, the REAL in-process broker (no Redis),
a throw-away temp-file SQLite database and ticket authentication. No real customer, network service or notification provider is
involved and nothing leaves the process.

Covered: one-time-ticket authentication (missing / garbage / reused / wrong actor type), the customer join + message flow
(persistence, ack, idempotent ``client_msg_id``, validation, rate limiting), agent join + reply delivery, INTERNAL NOTES never reaching the
customer, customer-to-customer and agent-not-joined isolation, disconnect + reconnection (history survives, presence flips,
tickets cannot be replayed), and malformed frames.

NOT covered and NOT claimed: Redis fan-out across workers (multi-worker delivery), WebRTC / calling / Wi-Fi calling media, attachments over
the socket, the browser client, and production proxy behaviour.

A frame that must NOT arrive is proven by ordering: the listener is pinged afterwards and the next frame must be the pong.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, select
from sqlalchemy.orm import sessionmaker
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.models_customer import (
    Base, Customer, CustomerAdminAuditLog, CustomerCall, CustomerChatAttachment, CustomerChatMessage, CustomerConversation,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_chat, customer_chat
from app.services import activity_service, chat_gateway
from app.services.chat_broker import get_broker, reset_broker_for_tests
from tests._v2_harness import _sqlite_default

_N = {"n": 900000}


def _id():
    _N["n"] += 1
    return _N["n"]


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", None, raising=False)
    reset_broker_for_tests()
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    md = MetaData()
    # Clone each table with its PostgreSQL-only defaults/constraints stripped (literal defaults kept).
    for model in (Customer, CustomerConversation, CustomerChatMessage, CustomerChatAttachment, CustomerCall,
                  CustomerAdminAuditLog, User):
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
    monkeypatch.setattr(chat_gateway, "SessionLocal", Session)
    # Phase 13: the agent socket audits refusals/supervision — keep those writes in this test database.
    from app.services import customer_admin_audit_service as b2c_audit
    monkeypatch.setattr(b2c_audit, "SessionLocal", Session)
    app = FastAPI()
    app.include_router(customer_chat.router)
    app.include_router(admin_chat.router)

    class E:
        pass

    e = E()
    e.Session = Session
    e.app = app
    e.activity = []
    monkeypatch.setattr(activity_service, "log_activity", lambda *a, **k: e.activity.append((a, k)))
    yield e
    reset_broker_for_tests()
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


CUST_WS = "/api/customer/chat/ws"
ADMIN_WS = "/api/admin/chat/ws"


def _customer(env, name="Test Traveller"):
    db = env.Session()
    c = Customer(customer_id=_id(), customer_code=f"C{_N['n']}", full_name=name, email=f"c{_N['n']}@tt-qa.com", mobile="9000000000")
    db.add(c)
    db.commit()
    cid = c.customer_id
    db.close()
    return cid


def _admin(env, name="Agent Ada"):
    db = env.Session()
    # Phase 13 (F-12a): a live-chat agent holds b2c.chat.manage explicitly.
    u = User(user_id=_id(), full_name=name, email=f"a{_N['n']}@tt-qa.com", password_hash="x", role=UserRole.ADMIN,
             status=UserStatus.ACTIVE, permissions=["b2c.chat.manage"])
    db.add(u)
    db.commit()
    uid = u.user_id
    db.close()
    return uid


def _assign(env, conversation_id, admin_id):
    """Phase 13 (D8): only the ASSIGNED agent (or a super admin) may join a conversation's live stream."""
    db = env.Session()
    c = db.get(CustomerConversation, conversation_id)
    c.assigned_admin_id, c.assigned_admin_name = admin_id, "Agent Ada"
    db.commit()
    db.close()


def _ticket(actor):
    return asyncio.run(get_broker().issue_ticket(actor))


def _recv(ws, timeout=5):
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return json.loads(pool.submit(ws.receive_text).result(timeout=timeout))


def _send(ws, event, data=None):
    ws.send_text(json.dumps({"event": event, "data": data or {}}))


def _expect(ws, event):
    frame = _recv(ws)
    assert frame["event"] == event, frame
    return frame["data"]


def _recv_event(ws, event):
    """The next frame of this event type (skipping benign status frames such as conversation_assigned)."""
    for _ in range(20):
        f = _recv(ws)
        if f["event"] == event:
            return f
    raise AssertionError(f"no {event} frame arrived")


def _drain(ws):
    """Ping until the pong comes back and return everything delivered before it. Frames already routed to this socket
    are delivered before the pongs, so this is how 'it must NOT have received X' is proven without timing sleeps."""
    frames = []
    for _ in range(2):
        _send(ws, "ping")
        while True:
            f = _recv(ws)
            if f["event"] == "pong":
                break
            frames.append(f)
    return frames


def _bodies(frames):
    return [f["data"].get("body") for f in frames if f["event"] == "receive_message"]


def _messages(env, conversation_id=None):
    db = env.Session()
    q = select(CustomerChatMessage)
    if conversation_id:
        q = q.where(CustomerChatMessage.conversation_id == conversation_id)
    rows = [m for m in db.scalars(q).all() if not (m.body or "").startswith("Chat assigned")]   # drop auto-assign system lines
    db.close()
    return rows


@pytest.fixture()
def client(env):
    with TestClient(env.app) as c:
        yield c


def _ws_paths(env):
    return customer_chat.router.prefix + "/ws", admin_chat.router.prefix + "/ws"


# ================================================================== authentication
def test_missing_garbage_and_replayed_tickets_are_refused_with_4401(env, client):
    cust, adm = _ws_paths(env)
    for path in (cust, adm):
        for url in (path, f"{path}?ticket=", f"{path}?ticket=garbage"):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect(url):
                    pass
            assert exc.value.code == 4401, url
    cid = _customer(env)
    t = _ticket(f"customer:{cid}")
    with client.websocket_connect(f"{cust}?ticket={t}") as ws:
        assert _expect(ws, "joined")["conversation_id"]
    with pytest.raises(WebSocketDisconnect) as exc:        # single use: the same ticket cannot be replayed
        with client.websocket_connect(f"{cust}?ticket={t}"):
            pass
    assert exc.value.code == 4401


def test_a_customer_ticket_cannot_open_the_agent_socket_and_vice_versa(env, client):
    cust, adm = _ws_paths(env)
    cid, aid = _customer(env), _admin(env)
    # Both tables number from 1, so the ticket carries the actor TYPE; the ids here deliberately collide.
    for ticket, path in ((_ticket(f"customer:{aid}"), adm), (_ticket(f"admin:{cid}"), cust), (_ticket("customer:notanumber"), cust)):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"{path}?ticket={ticket}"):
                pass
        assert exc.value.code == 4401
    assert _messages(env) == []


# ================================================================== customer flow
def test_customer_joins_sends_gets_an_ack_and_the_message_is_persisted_once(env, client):
    cust, _ = _ws_paths(env)
    cid = _customer(env)
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{cid}')}") as ws:
        joined = _expect(ws, "joined")
        conv = joined["conversation_id"]
        _send(ws, "send_message", {"body": "Hello, my wallet top-up is stuck", "client_msg_id": "m-1"})
        got = {}
        for _ in range(2):          # the ack and the echoed receive_message, in either order
            f = _recv(ws)
            got[f["event"]] = f["data"]
        assert got["message_ack"]["client_msg_id"] == "m-1" and got["message_ack"]["created"] is True
        assert got["receive_message"]["body"] == "Hello, my wallet top-up is stuck"
        _send(ws, "send_message", {"body": "Hello, my wallet top-up is stuck", "client_msg_id": "m-1"})
        again = _expect(ws, "message_ack")
        assert again["created"] is False and again["message_id"] == got["message_ack"]["message_id"], "idempotent on client_msg_id"
    rows = _messages(env, conv)
    assert len(rows) == 1 and rows[0].body == "Hello, my wallet top-up is stuck"


def test_malformed_unknown_oversize_and_flooded_frames_are_handled_without_dropping_the_socket(env, client, monkeypatch):
    cust, _ = _ws_paths(env)
    cid = _customer(env)
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{cid}')}") as ws:
        conv = _expect(ws, "joined")["conversation_id"]
        ws.send_text("this is not json")
        assert _expect(ws, "error")["code"] == "bad_frame"
        _send(ws, "launch_missiles")
        assert _expect(ws, "error")["code"] == "unknown_event"
        _send(ws, "send_message", {"body": "x" * 100000})
        assert _expect(ws, "error")["code"] == "too_long"
        _send(ws, "send_message", {"body": "   "})
        assert _expect(ws, "error")["code"] == "rejected"
        _send(ws, "message_read", {"up_to_message_id": "seven"})
        assert _expect(ws, "error")["code"] == "bad_frame"
        _send(ws, "ping")
        assert _expect(ws, "pong")
        assert _messages(env, conv) == [], "no rejected frame may create a message"
        for i in range(settings.chat_rate_burst):
            _send(ws, "typing_start")
        for i in range(settings.chat_rate_burst + 5):
            _send(ws, "send_message", {"body": f"flood {i}", "client_msg_id": f"f-{i}"})
        codes = []
        for _ in range(settings.chat_rate_burst + 5):
            frames = []
            while True:
                f = _recv(ws)
                frames.append(f)
                if f["event"] == "message_ack" or (f["event"] == "error" and f["data"]["code"] == "rate_limited"):
                    break
            codes.append(frames[-1]["event"] + ":" + frames[-1].get("data", {}).get("code", ""))
        assert any(c.endswith("rate_limited") for c in codes), "a socket cannot write without limit"
        assert sum(1 for c in codes if c.startswith("message_ack")) <= settings.chat_rate_burst


# ================================================================== agent flow, isolation, internal notes
def test_agent_receives_customer_messages_and_customer_receives_agent_replies(env, client):
    cust, adm = _ws_paths(env)
    cid, aid = _customer(env, "Cara Customer"), _admin(env)
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{cid}')}") as cws:
        conv = _expect(cws, "joined")["conversation_id"]
        _assign(env, conv, aid)
        with client.websocket_connect(f"{adm}?ticket={_ticket(f'admin:{aid}')}") as aws:
            _send(aws, "join_chat", {"conversation_id": conv})
            assert _expect(aws, "joined")["conversation_id"] == conv
            _send(cws, "send_message", {"body": "Need help", "client_msg_id": "c-1"})
            _expect(cws, "message_ack")
            assert _recv_event(aws, "receive_message")["data"]["body"] == "Need help"
            _send(aws, "send_message", {"conversation_id": conv, "body": "How can I help?"})
            while True:
                f = _recv_event(cws, "receive_message")
                if f["data"]["body"] == "How can I help?":
                    break
    rows = {m.body: m for m in _messages(env, conv)}
    assert set(rows) == {"Need help", "How can I help?"}


def test_internal_notes_reach_agents_but_never_the_customer(env, client):
    cust, adm = _ws_paths(env)
    cid, aid = _customer(env), _admin(env)
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{cid}')}") as cws:
        conv = _expect(cws, "joined")["conversation_id"]
        _assign(env, conv, aid)
        with client.websocket_connect(f"{adm}?ticket={_ticket(f'admin:{aid}')}") as aws:
            _send(aws, "join_chat", {"conversation_id": conv})
            _expect(aws, "joined")
            _send(aws, "send_message", {"conversation_id": conv, "body": "INTERNAL: customer seems upset", "is_internal": True})
            note = _recv_event(aws, "receive_message")
            assert note["data"]["body"].startswith("INTERNAL") and note["internal"] is True
            assert not any("INTERNAL" in (b or "") for b in _bodies(_drain(cws))), "the customer must never receive an internal note"
            _send(aws, "send_message", {"conversation_id": conv, "body": "visible reply"})
            f = _recv_event(cws, "receive_message")
            assert f["data"]["body"] == "visible reply"
    assert any(m.is_internal and m.body.startswith("INTERNAL") for m in _messages(env, conv))


def test_customers_are_isolated_from_each_other_and_an_agent_only_hears_threads_it_joined(env, client):
    cust, adm = _ws_paths(env)
    a, b, aid = _customer(env, "Alice"), _customer(env, "Bob"), _admin(env)
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{a}')}") as wa, \
         client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{b}')}") as wb:
        conv_a, conv_b = _expect(wa, "joined")["conversation_id"], _expect(wb, "joined")["conversation_id"]
        assert conv_a != conv_b
        _assign(env, conv_a, aid)
        with client.websocket_connect(f"{adm}?ticket={_ticket(f'admin:{aid}')}") as aws:
            _send(aws, "join_chat", {"conversation_id": conv_a})
            _expect(aws, "joined")
            _send(wa, "send_message", {"body": "alice secret", "client_msg_id": "a1"})
            _expect(wa, "message_ack")
            assert _recv_event(aws, "receive_message")["data"]["body"] == "alice secret"
            assert "alice secret" not in _bodies(_drain(wb)), "Bob must not hear Alice's thread"
            _send(wb, "send_message", {"body": "bob secret", "client_msg_id": "b1"})
            _expect(wb, "message_ack")
            assert "bob secret" not in _bodies(_drain(aws)), "the agent never joined Bob's thread, so never hears it"
            assert "bob secret" not in _bodies(_drain(wa))
            _send(aws, "join_chat", {"conversation_id": 99999999})
            assert _expect(aws, "error")["code"] == "not_found"
    assert {m.body for m in _messages(env, conv_a)} == {"alice secret"} and {m.body for m in _messages(env, conv_b)} == {"bob secret"}


# ================================================================== disconnect / reconnection
def test_disconnect_flips_presence_and_reconnection_resumes_the_same_conversation_with_a_new_ticket(env, client):
    cust, _ = _ws_paths(env)
    cid = _customer(env)
    broker = get_broker()
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{cid}')}") as ws:
        conv = _expect(ws, "joined")["conversation_id"]
        _send(ws, "send_message", {"body": "before the drop", "client_msg_id": "r-1"})
        _recv(ws)
        _recv(ws)
        assert asyncio.run(broker.is_online(f"customer:{cid}")) is True
    # the socket is closed: presence is cleared, the message and conversation survive
    assert asyncio.run(broker.is_online(f"customer:{cid}")) is False
    assert [m.body for m in _messages(env, conv)] == ["before the drop"]
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{cid}')}") as ws2:
        again = _expect(ws2, "joined")
        assert again["conversation_id"] == conv, "reconnecting lands in the same live conversation, not a second one"
        _send(ws2, "send_message", {"body": "after the drop", "client_msg_id": "r-2"})
        _recv(ws2)
        _recv(ws2)
    db = env.Session()
    assert len(db.scalars(select(CustomerConversation).where(CustomerConversation.customer_id == cid)).all()) == 1
    db.close()
    assert [m.body for m in _messages(env, conv)] == ["before the drop", "after the drop"]


def test_an_abrupt_agent_disconnect_does_not_break_the_conversation(env, client):
    cust, adm = _ws_paths(env)
    cid, aid = _customer(env), _admin(env)
    with client.websocket_connect(f"{cust}?ticket={_ticket(f'customer:{cid}')}") as cws:
        conv = _expect(cws, "joined")["conversation_id"]
        _assign(env, conv, aid)
        with client.websocket_connect(f"{adm}?ticket={_ticket(f'admin:{aid}')}") as aws:
            _send(aws, "join_chat", {"conversation_id": conv})
            _expect(aws, "joined")
        assert asyncio.run(get_broker().is_online(f"admin:{aid}")) is False
        _send(cws, "send_message", {"body": "anyone there?", "client_msg_id": "x-1"})
        _recv_event(cws, "message_ack")
        _drain(cws)
    assert [m.body for m in _messages(env, conv)] == ["anyone there?"]
