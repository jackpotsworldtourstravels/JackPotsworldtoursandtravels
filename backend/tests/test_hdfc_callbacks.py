"""HDFC callbacks: the restricted tunnel proxy, the webhook route and the return route.

EVERYTHING HERE IS MOCKED. HDFC's API is ``FakeHDFC``; the "upstream app" in the proxy
tests is a stub on an ephemeral localhost port; the database is SQLite. Nothing here is
evidence that HDFC itself delivered a webhook or sent a browser back: that can only be
shown by a real UAT transaction (see docs/HDFC_SMARTGATEWAY.md, "Testing UAT locally").

WHY THESE EXIST. On the first UAT payment (2026-11-09) the payment was recovered by the
sweep while HDFC's own webhook and return redirect never reached the app, and the
browser ended up on a different local server. The app's return route, redirect target,
authentication and idempotency were not at fault (they are pinned here); the proxy that
makes a local app reachable by HDFC is now a tested repo tool rather than a scratch file.
"""

from __future__ import annotations

import http.client
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from sqlalchemy import func, select

import app.config
from app.models_customer import (
    CustomerAuditLog,
    CustomerBookingStatus,
    CustomerNotification,
    CustomerPaymentStatus,
    PaymentProviderEvent,
)
from app.services import payment_event_service as events
from app.services.payments import hdfc_readiness
from scripts import uat_callback_proxy as proxy_mod
from tests.hdfc_fakes import FakeHDFC, FakeResponse, order_doc, webhook_body
from tests.test_hdfc_flow import (  # noqa: F401  (fixtures are used by name)
    AUTH,
    FRONTEND,
    OID,
    REF,
    _confirmations,
    _reload,
    _signed_return,
    _status_api,
    booking,
    client,
    hdb,
    provider,
)

WEBHOOK = "/api/webhooks/payments/hdfc"
RETURN = "/api/payments/hdfc/return"


# ===========================================================================
# 1. The restricted proxy: ONLY the two callback routes
# ===========================================================================
class _Upstream(BaseHTTPRequestHandler):
    """Stands in for the app: records exactly what reached it."""

    seen: list = []

    def log_message(self, *a):
        pass

    def _go(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        type(self).seen.append({"method": self.command, "path": self.path,
                                "auth": self.headers.get("Authorization"), "body": body})
        if self.path.startswith(RETURN):
            self.send_response(303)
            self.send_header("Location", "http://localhost:8099/my-bookings.html?payment_return=hdfc")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        out = b'{"status":"processed"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_DELETE = _go


@pytest.fixture()
def tunnel():
    """(request-through-the-proxy function, the list of what reached the app)."""
    _Upstream.seen = []
    app_srv = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
    px = proxy_mod.make_server(("127.0.0.1", 0), ("127.0.0.1", app_srv.server_address[1]), log=None)
    for srv in (app_srv, px):
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    def call(method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", px.server_address[1], timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        return r.status, dict(r.getheaders()), r.read()

    yield call, _Upstream.seen
    px.shutdown(); app_srv.shutdown(); px.server_close(); app_srv.server_close()


def test_the_webhook_passes_with_its_method_path_authorization_and_body_intact(tunnel):
    call, seen = tunnel
    body = b'{"id":"evt_1","event_name":"ORDER_SUCCEEDED"}'
    status, _, out = call("POST", WEBHOOK, body, {"Authorization": "Basic dXNlcjpwYXNz",
                                                  "Content-Type": "application/json"})
    assert status == 200 and out == b'{"status":"processed"}'
    assert seen == [{"method": "POST", "path": WEBHOOK, "auth": "Basic dXNlcjpwYXNz", "body": body}]


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_the_return_route_passes_with_its_query_and_the_303_is_not_followed(tunnel, method):
    call, seen = tunnel
    status, headers, _ = call(method, RETURN + "?order_id=JPABC&status=CHARGED")
    assert status == 303
    assert headers["Location"] == "http://localhost:8099/my-bookings.html?payment_return=hdfc"
    assert [(s["method"], s["path"]) for s in seen] == [(method, RETURN + "?order_id=JPABC&status=CHARGED")]


@pytest.mark.parametrize("method,path", [
    ("GET", "/"), ("GET", "/index.html"), ("GET", "/docs"), ("GET", "/openapi.json"),
    ("GET", "/api/health"), ("GET", "/api/customer/payments/config"),
    ("GET", "/api/admin/payment-reconciliation"),
    ("GET", "/api/admin/payment-reconciliation/flight-bookings/held"),
    ("POST", "/api/admin/payment-reconciliation/flight-bookings/X/supplier-reservation"),
    ("POST", "/api/customer/auth/verify-otp"),
    ("GET", WEBHOOK),                                   # wrong method
    ("PUT", WEBHOOK), ("DELETE", WEBHOOK),
    ("POST", WEBHOOK + "?x=1"),                         # the webhook takes no query string
    ("POST", "/api/webhooks/payments/razorpay"),        # another provider is not HDFC's door
    ("GET", "/api/payments/razorpay/return"),
    ("GET", RETURN + "/extra"), ("GET", "/API/PAYMENTS/HDFC/RETURN"),
])
def test_everything_else_is_refused_before_it_reaches_the_app(tunnel, method, path):
    call, seen = tunnel
    status, _, _ = call(method, path, b"{}" if method in ("POST", "PUT") else None)
    assert status == 404
    assert seen == []


def test_a_double_slash_path_is_canonicalised_to_the_real_route_not_a_new_one(tunnel):
    """Python's HTTP server collapses a leading '//'. What reaches the app is the
    canonical allowed route, never a different path."""
    call, seen = tunnel
    status, _, _ = call("POST", "//api/webhooks/payments/hdfc", b"{}", {"Authorization": "Basic x"})
    assert status == 200
    assert [s["path"] for s in seen] == [WEBHOOK]


def test_an_oversized_body_is_refused_without_reading_it_into_the_app(tunnel):
    call, seen = tunnel
    try:
        status, _, _ = call("POST", WEBHOOK, b"x" * (proxy_mod.MAX_BODY + 1), {"Authorization": "Basic x"})
    except (ConnectionError, OSError):
        # The proxy answers without buffering the upload; on Windows the client can see
        # the connection reset while it is still sending. Refused either way.
        status = 413
    assert status == 413 and seen == []


def test_an_unreachable_app_is_a_502_not_a_hang():
    px = proxy_mod.make_server(("127.0.0.1", 0), ("127.0.0.1", 9), log=None)     # nothing on :9
    threading.Thread(target=px.serve_forever, daemon=True).start()
    try:
        c = http.client.HTTPConnection("127.0.0.1", px.server_address[1], timeout=10)
        c.request("POST", WEBHOOK, b"{}", {"Authorization": "Basic x"})
        assert c.getresponse().status == 502
    finally:
        px.shutdown(); px.server_close()


def test_the_proxy_refuses_to_listen_on_a_public_interface(monkeypatch):
    monkeypatch.setattr("sys.argv", ["uat_callback_proxy.py", "--listen", "0.0.0.0:8098"])
    with pytest.raises(SystemExit) as exc:
        proxy_mod.main()
    assert "non-loopback" in str(exc.value)


def test_the_proxy_never_logs_a_header_or_a_body(tunnel, capsys):
    import io
    buf = io.StringIO()
    _Upstream.seen = []
    app_srv = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
    px = proxy_mod.make_server(("127.0.0.1", 0), ("127.0.0.1", app_srv.server_address[1]), log=buf)
    for srv in (app_srv, px):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = http.client.HTTPConnection("127.0.0.1", px.server_address[1], timeout=10)
        c.request("POST", WEBHOOK, b'{"card":"4111"}', {"Authorization": "Basic c2VjcmV0cGFzcw=="})
        c.getresponse().read()
    finally:
        px.shutdown(); app_srv.shutdown(); px.server_close(); app_srv.server_close()
    logged = buf.getvalue()
    assert "POST /api/webhooks/payments/hdfc" in logged
    assert "c2VjcmV0cGFzcw" not in logged and "4111" not in logged


# ===========================================================================
# 2. The return route: where the browser is sent, and what it can and cannot cause
# ===========================================================================
@pytest.mark.parametrize("frontend", ["http://localhost:8099", "http://localhost:8420",
                                       "https://tours.example.test"])
def test_the_browser_is_sent_to_the_configured_frontend_and_nowhere_else(
        client, hdb, booking, monkeypatch, frontend):
    """The destination is FRONTEND_BASE_URL -- not the HDFC return URL, not the tunnel,
    and not a default such as :8000."""
    monkeypatch.setattr(app.config.settings, "frontend_base_url", frontend)
    _status_api(monkeypatch)
    r = client.get(RETURN, params=_signed_return())
    assert r.status_code == 303
    assert r.headers["location"].startswith(f"{frontend}/my-bookings.html?")
    assert "trycloudflare" not in r.headers["location"] and ":8000" not in r.headers["location"]


def test_no_code_default_points_a_customer_at_port_8000():
    from app.config import Settings
    default = Settings.model_fields["frontend_base_url"].default
    assert ":8000" not in str(default)


def test_a_failed_payment_still_lands_on_my_trips_and_confirms_nothing(client, hdb, booking, monkeypatch):
    _status_api(monkeypatch, status="AUTHORIZATION_FAILED")
    r = client.get(RETURN, params=_signed_return(status="AUTHORIZATION_FAILED"))
    assert r.status_code == 303 and f"ref={REF}" in r.headers["location"]
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.FAILED.value
    assert b.status == CustomerBookingStatus.PENDING.value and _confirmations(hdb) == 0


def test_a_browser_that_claims_failure_cannot_undo_a_charge_hdfc_reports(client, hdb, booking, monkeypatch):
    """The query string is never read: HDFC's Order Status decides, both ways."""
    _status_api(monkeypatch)                                            # HDFC: CHARGED
    client.get(RETURN, params=_signed_return(status="AUTHENTICATION_FAILED"))
    b, p = _reload(hdb, booking)
    assert p.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value


def _fingerprint(hdb, booking):
    b, p = _reload(hdb, booking)
    return (
        b.status, p.status, str(p.amount), p.provider_payment_id, p.provider_reference,
        p.provider_status, str(p.paid_at), str(p.updated_at),
        hdb.execute(select(func.count()).select_from(PaymentProviderEvent)).scalar_one(),
        hdb.execute(select(func.count()).select_from(CustomerNotification)).scalar_one(),
        hdb.execute(select(func.count()).select_from(CustomerAuditLog)).scalar_one(),
    )


def test_a_return_replayed_for_a_captured_confirmed_booking_changes_nothing(client, hdb, booking, monkeypatch):
    """The exact situation of JPH000001 after its payment was recovered by the sweep."""
    api = _status_api(monkeypatch)
    client.get(RETURN, params=_signed_return())                         # first return captures + confirms
    before = _fingerprint(hdb, booking)
    calls = len(api.calls)
    for _ in range(3):
        r = client.get(RETURN, params=_signed_return())
        assert r.status_code == 303 and r.headers["location"].startswith(f"{FRONTEND}/my-bookings.html?")
    assert _fingerprint(hdb, booking) == before                          # no row, no audit, no notification
    assert len(api.calls) == calls                                       # and HDFC is not asked again
    assert _confirmations(hdb) == 1


def test_a_new_webhook_event_for_a_captured_confirmed_booking_changes_nothing(client, hdb, booking, monkeypatch):
    _status_api(monkeypatch)
    assert client.post(WEBHOOK, content=webhook_body(OID, event_id="evt_first"), headers=AUTH).status_code == 200
    before = _fingerprint(hdb, booking)[:8]
    r = client.post(WEBHOOK, content=webhook_body(OID, event_id="evt_second", event_name="TXN_CHARGED"), headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == events.PROCESSED
    assert _fingerprint(hdb, booking)[:8] == before                      # the booking and payment are untouched
    assert _confirmations(hdb) == 1
    # The late event IS recorded (an operator can see it) -- recording is not acting.
    assert hdb.execute(select(func.count()).select_from(PaymentProviderEvent)).scalar_one() == 2


# ===========================================================================
# 3. The webhook route: path, method, authentication
# ===========================================================================
def test_the_webhook_route_exists_exactly_where_hdfc_is_told_to_call(client):
    r = client.post(WEBHOOK, content=b"{}", headers={"Authorization": "Basic !!"})
    assert r.status_code == 401                                          # routed and authenticated, not 404


@pytest.mark.parametrize("method", ["get", "put", "delete", "patch"])
def test_only_post_reaches_the_webhook(client, method):
    assert getattr(client, method)(WEBHOOK).status_code == 405


def test_an_unknown_provider_is_a_400_and_names_nothing(client):
    r = client.post("/api/webhooks/payments/nonesuch", content=b"{}", headers=AUTH)
    assert r.status_code == 400 and "hdfc" not in r.text.lower()


def test_missing_wrong_and_malformed_authorization_are_all_401_and_record_nothing(client, hdb, booking, monkeypatch):
    api = _status_api(monkeypatch)
    for headers in ({}, {"Authorization": "Basic d3Jvbmc6d3Jvbmc="}, {"Authorization": "Basic !!"},
                    {"Authorization": "Bearer abc"}, {"authorization": ""}):
        r = client.post(WEBHOOK, content=webhook_body(OID), headers=headers)
        assert r.status_code == 401 and r.json() == {"status": "rejected"}
    assert hdb.execute(select(func.count()).select_from(PaymentProviderEvent)).scalar_one() == 0
    assert api.calls == [] and _confirmations(hdb) == 0


def test_a_webhook_attempt_is_logged_even_before_it_is_judged(client, booking, monkeypatch, caplog):
    _status_api(monkeypatch)
    with caplog.at_level("INFO"):
        client.post(WEBHOOK, content=b"{}", headers={"Authorization": "Basic d3Jvbmc6d3Jvbmc="})
    text = caplog.text
    assert "Payment webhook received: provider='hdfc'" in text
    assert "d3Jvbmc6d3Jvbmc" not in text                                 # never a credential


# ===========================================================================
# 4. A wrong URL is caught before a customer pays
# ===========================================================================
def test_a_webhook_url_pasted_into_frontend_base_url_is_flagged(monkeypatch):
    """The 2026-11-09 mistake: FRONTEND_BASE_URL carried the webhook path, so the derived
    return URL became .../api/webhooks/payments/hdfc/api/payments/hdfc/return."""
    s = app.config.settings
    for k, v in dict(payment_provider="hdfc", payment_environment="test", payment_mode="real",
                     deployed=False, hdfc_sg_return_url=None, flight_supplier="demo",
                     frontend_base_url="https://x.example.com/api/webhooks/payments/hdfc",
                     hdfc_sg_base_url="https://smartgateway.hdfcuat.bank.in", hdfc_sg_merchant_id="MID",
                     hdfc_sg_api_key="k" * 20, hdfc_sg_webhook_username="user",
                     hdfc_sg_webhook_password="p" * 20).items():
        monkeypatch.setattr(s, k, v)
    levels = {c.name: c.level for c in hdfc_readiness.evaluate()}
    assert levels["return URL path"] == hdfc_readiness.WARN
