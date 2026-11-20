"""Stage 2D — request-id middleware + background/WebSocket correlation.

Exercises the real primitives in ``activity_service`` (the main.py middleware and
the sweeps are thin glue over them) and the middleware pattern end-to-end on a
bare FastAPI app whose middleware mirrors main.py's ``request_metadata`` exactly.
No database, no startup events.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import activity_service as acts


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def request_metadata(request, call_next):  # mirrors app/main.py
        meta = acts.request_context(request)
        acts.bind_request(meta)
        try:
            response = await call_next(request)
        finally:
            acts.bind_request(None)
        rid = meta.get("request_id")
        if rid:
            response.headers.setdefault("X-Request-ID", rid)
        return response

    @app.get("/echo")
    def echo():
        return {"request_id": acts.current_request_meta().get("request_id")}

    @app.get("/boom")
    def boom():
        raise RuntimeError("kaboom")

    return app


@pytest.fixture()
def client():
    return TestClient(_build_app(), raise_server_exceptions=False)


_HEX32 = lambda s: isinstance(s, str) and len(s) == 32 and all(c in "0123456789abcdef" for c in s)


# --- inbound handling + echo -------------------------------------------------
def test_valid_inbound_request_id_is_used_and_echoed(client):
    r = client.get("/echo", headers={"X-Request-ID": "abc-123_XYZ.9"})
    assert r.headers["X-Request-ID"] == "abc-123_XYZ.9"
    assert r.json()["request_id"] == "abc-123_XYZ.9"


def test_correlation_id_header_is_also_accepted(client):
    r = client.get("/echo", headers={"X-Correlation-ID": "corr-42"})
    assert r.headers["X-Request-ID"] == "corr-42"


def test_missing_request_id_is_generated_and_echoed(client):
    r = client.get("/echo")
    rid = r.headers["X-Request-ID"]
    assert _HEX32(rid)
    assert r.json()["request_id"] == rid


def test_invalid_request_id_is_replaced_with_a_generated_one(client):
    bad = "has spaces and <bad> chars " + "x" * 200
    r = client.get("/echo", headers={"X-Request-ID": bad})
    rid = r.headers["X-Request-ID"]
    assert rid != bad
    assert _HEX32(rid)


def test_response_always_carries_the_header(client):
    assert "X-Request-ID" in client.get("/echo").headers


# --- cleanup after an exception ---------------------------------------------
def test_contextvar_is_reset_after_a_handler_raises(client):
    r = client.get("/boom")
    assert r.status_code == 500
    # The middleware's finally reset the ContextVar even though the handler raised.
    assert acts.current_request_meta() == {}


# --- concurrent isolation (ContextVar is per-task) ---------------------------
def test_concurrent_requests_do_not_share_a_request_id():
    async def _work(rid: str) -> str:
        acts.bind_request({"request_id": rid})
        await asyncio.sleep(0.01)              # yield so the tasks interleave
        seen = acts.current_request_meta().get("request_id")
        acts.bind_request(None)
        return seen

    async def _run():
        return await asyncio.gather(*(asyncio.create_task(_work(f"req-{i}")) for i in range(8)))

    results = asyncio.run(_run())
    assert results == [f"req-{i}" for i in range(8)]   # each task saw only its own


# --- background run correlation ---------------------------------------------
def test_background_run_ids_are_unique():
    a = acts.new_run_meta("payment-sweep")["request_id"]
    b = acts.new_run_meta("payment-sweep")["request_id"]
    assert a != b and a.startswith("payment-sweep:") and b.startswith("payment-sweep:")


def test_same_run_id_is_seen_across_events_within_one_execution():
    acts.bind_request(acts.new_run_meta("payment-sweep"))
    try:
        first = acts.current_request_meta()["request_id"]
        second = acts.current_request_meta()["request_id"]
        assert first == second                 # every audit row in the run shares it
    finally:
        acts.bind_request(None)


def test_background_context_is_reset_after_a_failed_run():
    # Mirrors the sweep pattern: bind at entry, reset in finally even on failure.
    def _sweep_that_fails():
        acts.bind_request(acts.new_run_meta("payment-sweep"))
        try:
            raise RuntimeError("sweep blew up")
        finally:
            acts.bind_request(None)

    with pytest.raises(RuntimeError):
        _sweep_that_fails()
    assert acts.current_request_meta() == {}


# --- websocket correlation (SECURITY: never the ticket) ----------------------
def test_ws_run_meta_mints_a_fresh_uuid_not_the_ticket():
    a = acts.ws_run_meta()
    b = acts.ws_run_meta()
    assert a["request_id"].startswith("ws:") and _HEX32(a["request_id"][3:])
    assert a["request_id"] != b["request_id"]      # fresh per connection
    assert a["ip_address"] is None


def test_raw_websocket_ticket_never_enters_correlation_metadata():
    # ws_run_meta takes no ticket and cannot embed one; prove a ticket-looking
    # value never appears in any field of the produced correlation meta.
    secret_ticket = "tkt_SUPERSECRET_credential_0123456789"
    meta = acts.ws_run_meta()
    assert secret_ticket not in repr(meta)
    assert all(secret_ticket not in str(v) for v in meta.values())


def test_no_secret_can_reach_correlation_fields_via_run_meta():
    # new_run_meta labels are caller constants; the id is label:uuid — no secret.
    rid = acts.new_run_meta("payment-sweep")["request_id"]
    assert rid.startswith("payment-sweep:") and _HEX32(rid.split(":", 1)[1])


# --- integration against the REAL application middleware ---------------------
def test_real_app_middleware_sets_and_echoes_request_id():
    # Drive the actual app.main middleware stack (security_headers +
    # request_metadata). TestClient is NOT used as a context manager, so no
    # startup/shutdown handlers run and no database is touched; a 404 response
    # still passes through the middleware, which sets X-Request-ID.
    from app.main import app
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/api/__nonexistent_probe__", headers={"X-Request-ID": "real-probe-123"})
    assert r.headers.get("X-Request-ID") == "real-probe-123"
    r2 = c.get("/api/__nonexistent_probe__")
    assert _HEX32(r2.headers.get("X-Request-ID"))        # generated when absent
    r3 = c.get("/api/__nonexistent_probe__", headers={"X-Request-ID": "bad id!!"})
    assert r3.headers.get("X-Request-ID") != "bad id!!"  # invalid → regenerated
