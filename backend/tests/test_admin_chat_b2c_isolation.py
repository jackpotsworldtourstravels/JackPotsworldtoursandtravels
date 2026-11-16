"""Stage 1 closure — B2C isolation of the live-chat / WiFi-calling admin console.

The agent WebSocket (`/api/admin/chat/ws`) admits only a one-time ticket, and
that ticket is minted by `POST /api/admin/chat/ws-ticket`, which — like every
HTTP route on this router — is gated by `get_current_b2c_admin` (admin role +
B2C environment). So:

  * a B2C support admin / super admin can mint a ticket (keeps live chat + calls);
  * a role-default B2B admin cannot, so it can never obtain a valid socket ticket;
  * an unauthorized socket connection (no/garbage ticket) is closed before accept.

None of the socket handshake, ticket broker, heartbeat, call-signalling or
transfer logic is touched — only who may obtain a ticket.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Header
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.auth import deps
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_v2 import User, UserRole
from app.routers import admin_chat
from app.services import chat_gateway
from app.services.chat_broker import InProcessBroker


def _mkuser(role: UserRole, *codes: str) -> User:
    return User(user_id=1, role=role, merchant_role=None, permissions=list(codes), full_name="A")


USERS = {
    "super_admin": _mkuser(UserRole.SUPER_ADMIN),
    "b2c_support": _mkuser(UserRole.ADMIN, "b2c.chat.manage"),
    "b2b_only": _mkuser(UserRole.ADMIN),            # role-default admin, no b2c.* scope
    "non_admin": _mkuser(UserRole.CUSTOMER, "b2c.chat.manage"),  # scope but not an admin role
}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)
    broker = InProcessBroker()
    monkeypatch.setattr(admin_chat, "get_broker", lambda: broker)
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(admin_chat.router)

    def _user(x_test_user: str = Header(...)):
        return USERS[x_test_user]

    app.dependency_overrides[deps.get_current_user] = _user
    app.dependency_overrides[get_db] = lambda: None
    return TestClient(app, raise_server_exceptions=False)


def _ticket(client, who):
    return client.post("/api/admin/chat/ws-ticket", headers={"x-test-user": who})


# --- who may obtain a socket ticket (the WS authorization boundary) ----------
def test_b2c_support_admin_can_mint_ticket(client):
    r = _ticket(client, "b2c_support")
    assert r.status_code == 200, r.text
    assert r.json()["ticket"]


def test_super_admin_can_mint_ticket(client):
    assert _ticket(client, "super_admin").status_code == 200


def test_b2b_only_admin_cannot_mint_ticket(client):
    assert _ticket(client, "b2b_only").status_code == 403


def test_non_admin_with_scope_still_cannot_mint_ticket(client):
    # The admin role gate is preserved: a non-admin holding a b2c scope is still refused.
    assert _ticket(client, "non_admin").status_code == 403


# --- the socket itself rejects an unauthorized (invalid-ticket) connection ----
def test_unauthorized_websocket_is_rejected(monkeypatch):
    broker = InProcessBroker()  # empty: no ticket was ever issued
    monkeypatch.setattr(chat_gateway, "get_broker", lambda: broker)
    app = FastAPI()
    app.include_router(admin_chat.router)
    client = TestClient(app, raise_server_exceptions=False)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/admin/chat/ws?ticket=garbage"):
            pass


def test_websocket_with_no_ticket_is_rejected(monkeypatch):
    broker = InProcessBroker()
    monkeypatch.setattr(chat_gateway, "get_broker", lambda: broker)
    app = FastAPI()
    app.include_router(admin_chat.router)
    client = TestClient(app, raise_server_exceptions=False)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/admin/chat/ws"):
            pass
