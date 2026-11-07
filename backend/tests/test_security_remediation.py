"""Regression tests for the 2026-10-18 security audit findings JP-01..JP-03.

JP-02  DEBUG=true must never put a password-reset link in an API response on a
       deployed host (it did, and DEPLOYED did not stop it).
JP-03  A B2B password reset must end every session opened before it (customers
       already did; merchants, admins and managers did not).
JP-01  Flight fares must not depend on anything the browser can choose: the
       duration comes from the server's own schedule and an unknown flight is
       refused. See the class at the bottom.
"""
from __future__ import annotations

import datetime as dt
import re
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import get_db
from app.main import app
from app.services import auth_service, customer_auth_service, email_service


# --------------------------------------------------------------------------- #
# JP-02
# --------------------------------------------------------------------------- #

@pytest.fixture()
def client(monkeypatch):
    limiter.reset()
    app.dependency_overrides[get_db] = lambda: iter([object()])
    monkeypatch.setattr(auth_service, "start_password_reset", lambda db, email: "RAWTOKEN")
    monkeypatch.setattr(customer_auth_service, "start_password_reset", lambda db, email, **kw: "RAWTOKEN")
    monkeypatch.setattr(email_service, "send_password_reset_email", lambda *a, **k: True)
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    limiter.reset()


FORGOT = ("/api/auth/forgot-password", "/api/customer/auth/forgot-password")


@pytest.mark.parametrize("path", FORGOT)
def test_reset_link_never_returned_when_debug_is_off(client, monkeypatch, path):
    monkeypatch.setattr(settings, "debug", False)
    monkeypatch.setattr(settings, "deployed", False)
    r = client.post(path, json={"email": "someone@example.com"})
    assert r.status_code == 200
    assert "RAWTOKEN" not in r.text and not r.json().get("reset_link")


@pytest.mark.parametrize("path", FORGOT)
def test_reset_link_never_returned_on_a_deployed_host_even_with_debug(client, monkeypatch, path):
    """The audit's exploit: DEBUG=true copied to a server."""
    monkeypatch.setattr(settings, "debug", True)
    monkeypatch.setattr(settings, "deployed", True)
    r = client.post(path, json={"email": "someone@example.com"})
    assert r.status_code == 200
    assert "RAWTOKEN" not in r.text and not r.json().get("reset_link")


@pytest.mark.parametrize("path", FORGOT)
def test_local_debug_convenience_is_kept(client, monkeypatch, path):
    """Local development without SMTP still gets the link."""
    monkeypatch.setattr(settings, "debug", True)
    monkeypatch.setattr(settings, "deployed", False)
    r = client.post(path, json={"email": "someone@example.com"})
    assert r.json().get("reset_link", "").endswith("token=RAWTOKEN")


def test_deploy_configs_force_debug_off():
    root = Path(__file__).resolve().parents[2]
    compose = (root / "deploy" / "docker-compose.yml").read_text(encoding="utf-8")
    render = (root / "render.yaml").read_text(encoding="utf-8")
    assert re.search(r'^\s*DEBUG:\s*"false"', compose, re.M)
    assert re.search(r'key:\s*DEBUG\s*\n\s*value:\s*"false"', render)


# --------------------------------------------------------------------------- #
# JP-03
# --------------------------------------------------------------------------- #

class _FakeDb:
    def __init__(self, user):
        self._user = user
        self.commits = 0

    def scalar(self, _stmt):
        return self._user

    def commit(self):
        self.commits += 1


def _user_with_reset_pending():
    raw, hashed = auth_service.generate_reset_token()
    user = types.SimpleNamespace(
        password_hash="old-hash",
        reset_token_hash=hashed,
        reset_token_expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30),
        force_logout_at=None,
    )
    return raw, user


def test_b2b_password_reset_revokes_sessions_opened_before_it():
    raw, user = _user_with_reset_pending()
    opened_before = {"iat": int((dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)).timestamp())}
    assert auth_service.is_token_revoked(user, opened_before) is False      # live before the reset

    db = _FakeDb(user)
    auth_service.complete_password_reset(db, raw, "A-new-Passw0rd!")

    assert db.commits == 1
    assert user.password_hash != "old-hash"
    assert user.reset_token_hash is None                                    # single use
    assert user.force_logout_at is not None
    assert auth_service.is_token_revoked(user, opened_before) is True       # old access/refresh token now dead


def test_b2b_token_issued_after_the_reset_is_not_revoked():
    raw, user = _user_with_reset_pending()
    auth_service.complete_password_reset(_FakeDb(user), raw, "A-new-Passw0rd!")
    issued_later = {"iat": int((dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)).timestamp())}
    assert auth_service.is_token_revoked(user, issued_later) is False


# --------------------------------------------------------------------------- #
# JP-01
# --------------------------------------------------------------------------- #

from app.services import customer_pricing_service as pricing  # noqa: E402
from app.services import demo_flight_board as board  # noqa: E402

TRAVEL_DATA = Path(__file__).resolve().parents[2] / "frontend" / "assets" / "js" / "travel-data.js"


def _quote(flight_number, minutes):
    return pricing.quote(
        None, flight_key="K", flight_number=flight_number, duration_minutes=minutes,
        cabin="economy", passenger_types=["adult"],
    )


@pytest.mark.parametrize("flight", ["QP 1405", "QP1405", "6e 1509", "IX 939"])
def test_client_duration_cannot_move_the_fare(flight):
    """The audit's exploit: one flight, duration 1 / 140 / 3000, three prices."""
    totals = {_quote(flight, m)["total_amount"] for m in (None, 0, 1, 140, 3000)}
    assert len(totals) == 1, totals


def test_fare_uses_the_servers_duration():
    # QP1405 departs 06:00 and lands 08:15 IST = 135 minutes -> the advertised fare.
    assert board.lookup("QP 1405") == (True, 135)
    assert pricing.flight_fare("QP1405", 3000) == pricing.flight_fare("QP1405", 135)


@pytest.mark.parametrize("flight", ["AI 101", "ZZ9999", "", "EK525"])
def test_a_flight_not_on_the_schedule_is_refused(flight):
    with pytest.raises(pricing.PricingError):
        _quote(flight, 120)


def test_spelling_of_a_known_flight_does_not_matter():
    assert _quote("6E815", None)["total_amount"] == _quote("6e 815", 999)["total_amount"]


def test_server_board_matches_the_browsers_board():
    """Drift guard: every SAMPLE_FLIGHTS row in travel-data.js is on the server board."""
    src = TRAVEL_DATA.read_text(encoding="utf-8")
    block = src[src.index("const SAMPLE_FLIGHTS"): src.index("];", src.index("const SAMPLE_FLIGHTS"))]
    rows = re.findall(
        r"no:\s*'([^']+)'.*?to:\s*'([A-Z]{3})',\s*dep:\s*'([\d:]+)',\s*arr:\s*(null|'[\d:]+')", block)
    assert len(rows) >= 20
    browser = {no: (to, dep, None if arr == "null" else arr.strip("'")) for no, to, dep, arr in rows}
    assert board.BOARD == browser


# --------------------------------------------------------------------------- #
# JP-04  public endpoints are rate limited
# --------------------------------------------------------------------------- #

from app.auth import public_rate_limit as pl  # noqa: E402


@pytest.fixture()
def fresh_limits():
    pl.reset()
    limiter.reset()
    yield
    pl.reset()
    limiter.reset()


def test_coupon_validation_is_throttled_per_ip(fresh_limits):
    c = TestClient(app)
    codes = [c.post("/api/customer/coupons/validate", json={}).status_code for _ in range(25)]
    assert 429 not in codes[:20]                      # the first 20 reach the handler (422: empty body)
    assert codes[20:] == [429] * 5
    r = c.post("/api/customer/coupons/validate", json={})
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1


def test_limits_are_per_client_and_per_group(fresh_limits):
    for _ in range(20):
        assert pl.check("POST", "/api/customer/coupons/validate", "1.1.1.1")[0]
    assert not pl.check("POST", "/api/customer/coupons/validate", "1.1.1.1")[0]
    assert pl.check("POST", "/api/customer/coupons/validate", "2.2.2.2")[0]       # someone else
    assert pl.check("GET", "/api/customer/destinations", "1.1.1.1")[0]            # another group


def test_catalogue_reads_get_a_generous_ceiling(fresh_limits):
    results = [pl.check("GET", "/api/customer/hotels/42", "9.9.9.9")[0] for _ in range(181)]
    assert all(results[:180]) and results[180] is False


def test_health_and_unlisted_paths_are_not_limited(fresh_limits):
    for _ in range(500):
        assert pl.check("GET", "/api/health", "3.3.3.3")[0]
        assert pl.check("GET", "/api/customer/profile", "3.3.3.3")[0]            # authenticated: not this module's job


def _public_api_routes():
    """Every route with no authentication dependency, as (method, path, handler key)."""
    def authed(dep):
        if dep is None:
            return False
        for d in dep.dependencies:
            name = getattr(d.call, "__name__", "")
            if name.startswith("get_current") or name in ("_dependency", "_merchant_only", "require_role"):
                return True
            if authed(d):
                return True
        return False

    out = []
    for r in app.routes:
        if type(r).__name__ != "_IncludedRouter":
            continue
        for c in r.effective_route_contexts():
            if c.endpoint is None or not c.path.startswith("/api/") or authed(c.dependant):
                continue
            key = f"{c.endpoint.__module__}.{c.endpoint.__name__}"
            for m in (c.methods or set()) - {"HEAD", "OPTIONS"}:
                out.append((m, re.sub(r"\{[^}]+\}", "x", c.path), key))
    return out


def test_every_public_api_route_is_rate_limited():
    """Drift guard: a new public endpoint must be decorated or listed in public_rate_limit.RULES."""
    decorated = set(limiter._route_limits)
    routes = _public_api_routes()
    assert len(routes) > 40, "route discovery found too few routes; the guard would be vacuous"
    unprotected = [
        f"{m} {p}" for m, p, key in routes
        if key not in decorated and pl.group_for(m, p) is None and p not in pl.EXEMPT_PATHS
    ]
    assert unprotected == []


# --------------------------------------------------------------------------- #
# JP-05  interactive docs are off on a deployed host
# --------------------------------------------------------------------------- #

from app.main import docs_urls  # noqa: E402


def test_docs_are_disabled_on_a_deployed_host():
    assert docs_urls(True) == {"docs_url": None, "redoc_url": None, "openapi_url": None}


def test_docs_stay_available_locally():
    assert docs_urls(False)["openapi_url"] == "/openapi.json"
    assert TestClient(app).get("/openapi.json").status_code == 200       # test runs with DEPLOYED unset


def test_a_deployed_app_really_serves_no_docs():
    from fastapi import FastAPI
    deployed = FastAPI(**docs_urls(True))
    c = TestClient(deployed)
    assert [c.get(p).status_code for p in ("/docs", "/redoc", "/openapi.json")] == [404, 404, 404]
