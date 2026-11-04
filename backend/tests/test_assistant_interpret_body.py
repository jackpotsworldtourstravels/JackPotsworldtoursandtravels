"""Regression: POST /api/assistant/interpret must read its JSON BODY.

THE BUG (Stage-3 Finding A2). `routers/assistant.py` carries
``from __future__ import annotations``, so ``payload: InterpretRequest`` is the
*string* ``"InterpretRequest"``. Under the slowapi ``@limiter.limit`` wrapper
FastAPI could not resolve that string to the Pydantic model and mis-classified
``payload`` as a REQUIRED QUERY parameter — so every JSON-body POST got
``422 {"loc":["query","payload"]}`` and the merchant assistant was unusable.

THE FIX pins the parameter to the body with ``= Body(...)``. These tests drive
the endpoint over HTTP (TestClient) and assert the body is actually parsed, that
validation errors are BODY-scoped, that auth is still required, and that the
rate limiter is still active.

Auth note: these tests DO NOT change A1 behaviour. The unauthenticated case only
asserts the request is *rejected* (401 or 403), whichever the app already uses.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers import assistant as router_mod

URL = "/api/assistant/interpret"


@pytest.fixture(autouse=True)
def _isolate_limiter():
    # Clear per-IP counters so one test never spends another's budget.
    router_mod.limiter.reset()
    yield
    router_mod.limiter.reset()


@pytest.fixture()
def spy_classify(monkeypatch):
    """Record what reached the service, while still returning a real result."""
    captured: dict = {}
    original = router_mod.assistant.classify

    def spy(message, *, page=None, history=None):
        captured["message"] = message
        captured["page"] = page
        captured["history"] = history
        return original(message, page=page, history=history)

    monkeypatch.setattr(router_mod.assistant, "classify", spy)
    return captured


@pytest.fixture()
def auth_client(monkeypatch):
    # Bypass ONLY the auth gate (not the body parsing or the limiter) so these
    # tests are about the request body. A plain object stands in for the merchant
    # User; the handler never reads its attributes.
    monkeypatch.setattr(settings, "assistant_rate_per_minute", 1000)  # don't 429 by accident
    app.dependency_overrides[router_mod._merchant_only] = lambda: object()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(router_mod._merchant_only, None)


# --- the fix: a JSON body is accepted and actually reaches the model ---------
def test_valid_json_body_is_accepted(auth_client, spy_classify):
    r = auth_client.post(URL, json={"message": "what is my wallet balance",
                                    "page": None, "history": []})
    assert r.status_code == 200, r.text
    body = r.json()
    # The response is a well-formed InterpretResponse -> the body was parsed.
    assert "intent" in body and "model_backed" in body
    # And the body's message actually flowed into the service (req 6).
    assert spy_classify["message"] == "what is my wallet balance"


def test_body_is_not_treated_as_a_query_param(auth_client):
    """The exact regression: a body POST must NOT 422 asking for `payload` in query."""
    r = auth_client.post(URL, json={"message": "hello"})
    assert r.status_code != 422, r.text
    assert '"query","payload"' not in r.text.replace(" ", "")


# --- validation errors are BODY-scoped ---------------------------------------
def test_missing_required_field_is_422_in_body(auth_client):
    r = auth_client.post(URL, json={})  # `message` is required
    assert r.status_code == 422, r.text
    locs = [tuple(e.get("loc", [])) for e in r.json()["detail"]]
    assert any(loc[:1] == ("body",) and "message" in loc for loc in locs), locs


@pytest.mark.parametrize("bad_body", [
    {"message": ""},                       # min_length=1
    {"message": "x" * 601},                # max_length=600
    {"message": 123},                      # wrong type
    {"message": "ok", "history": "nope"},  # history must be a list
])
def test_invalid_payload_is_422(auth_client, bad_body):
    r = auth_client.post(URL, json=bad_body)
    assert r.status_code == 422, f"{bad_body} -> {r.status_code} {r.text}"


# --- auth still required (A1 behaviour preserved, not changed) ---------------
def test_unauthenticated_is_rejected():
    client = TestClient(app)
    r = client.post(URL, json={"message": "hello"})
    assert r.status_code in (401, 403), r.text        # whichever the app uses
    assert r.status_code != 200


# --- rate limiter still active ------------------------------------------------
def test_rate_limit_is_enforced(monkeypatch, spy_classify):
    monkeypatch.setattr(settings, "assistant_rate_per_minute", 2)
    router_mod.limiter.reset()
    app.dependency_overrides[router_mod._merchant_only] = lambda: object()
    try:
        client = TestClient(app)
        statuses = [client.post(URL, json={"message": "hi"}).status_code
                    for _ in range(4)]
    finally:
        app.dependency_overrides.pop(router_mod._merchant_only, None)
    assert statuses[:2] == [200, 200], statuses   # within budget
    assert 429 in statuses, statuses               # limiter fired
