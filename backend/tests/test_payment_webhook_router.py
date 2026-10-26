"""Router-level guards on the payment webhook endpoint.

WHY THIS FILE EXISTS
``/api/webhooks/payments/{provider}`` is the only unauthenticated write surface
in the application (see routers/payment_webhooks.py). Its adapter-level
behaviour — a verified delivery confirms once, a duplicate changes nothing, a
bad signature is refused — is covered thoroughly in test_hdfc_flow.py. What was
NOT covered is the three guards the router applies *before* it ever reaches an
adapter or records anything:

    1. an empty body             -> 400, nothing recorded
    2. a body over MAX_BODY_BYTES -> 400, nothing recorded (checked before the
                                    provider is even looked up, so a flood of
                                    large posts cannot be used to force work)
    3. a provider we do not have  -> 400, nothing recorded, and WITHOUT naming
                                    the providers we DO have (an unauthenticated
                                    endpoint that enumerates a deployment's
                                    providers is a gift to someone mapping it)

These run on every request to the money endpoint, so a regression in any of
them is exactly the kind of thing that must fail a test rather than a pentest.

"NOTHING RECORDED" is asserted at the seam that records: ``events.handle`` is
the one call that writes a provider event, and every guard here must return
before reaching it. Spying on that call proves the guarantee directly and needs
neither a configured provider nor the Postgres-only event-log table (whose
``'{}'::jsonb`` default SQLite cannot create — which is why the shared ``db``
fixture omits it).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.routers import payment_webhooks
from app.routers.payment_webhooks import MAX_BODY_BYTES


@pytest.fixture()
def client(db, monkeypatch):
    # The endpoint is rate-limited; the limiter is not what is under test here.
    monkeypatch.setattr(limiter, "enabled", False)

    # Spy on the one call that records a provider event. A guard that returns
    # early must never reach it; if one ever does, these lists make it visible.
    recorded = []
    monkeypatch.setattr(
        payment_webhooks.events, "handle",
        lambda *a, **k: (recorded.append((a, k)) or ("processed", "")),
    )

    api = FastAPI()
    api.state.limiter = limiter
    api.include_router(payment_webhooks.router)

    def _db():
        yield db

    api.dependency_overrides[get_db] = _db
    c = TestClient(api)
    c.recorded = recorded
    return c


def test_empty_body_is_refused_and_nothing_recorded(client):
    r = client.post("/api/webhooks/payments/hdfc", content=b"")
    assert r.status_code == 400
    assert r.json()["detail"] == "empty body"
    assert client.recorded == []


def test_oversized_body_is_refused_and_nothing_recorded(client):
    # One byte over the ceiling. The signature is never even checked: the point
    # is that an oversized body is rejected before any work is done on it.
    r = client.post(
        "/api/webhooks/payments/hdfc",
        content=b"x" * (MAX_BODY_BYTES + 1),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "body too large"
    assert client.recorded == []


def test_a_body_exactly_at_the_limit_passes_the_size_gate(client):
    # The boundary: MAX_BODY_BYTES itself is allowed through the size gate,
    # proving the comparison is strict ( > ), not off-by-one ( >= ). It still
    # fails afterwards (no valid signature for a real adapter / unknown
    # provider), but NOT as "body too large".
    r = client.post(
        "/api/webhooks/payments/hdfc",
        content=b"x" * MAX_BODY_BYTES,
    )
    assert r.json().get("detail") != "body too large"


def test_unknown_provider_is_refused_without_enumerating_providers(client):
    r = client.post("/api/webhooks/payments/paypal", content=b'{"x":1}')
    assert r.status_code == 400
    assert r.json()["detail"] == "unknown provider"
    # The refusal must not leak which providers ARE configured.
    body = r.text.lower()
    for real in ("hdfc", "razorpay", "trustbrick", "mock"):
        assert real not in body
    assert client.recorded == []
