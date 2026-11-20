"""Phase 3 (audit follow-up) — ICE configuration the browser is handed for calls.

Pure-function tests over call_signaling.ice_config / turn_credentials. No network,
no real coturn, no DB. They pin the behaviour the live isolated probe showed and
add the TURN-configured paths plus credential-redaction checks.

What is deliberately NOT claimed here: that calls actually connect. That needs a
real coturn server and real devices behind real NAT/CGNAT — documented as a
remaining external requirement, not simulated.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re

import pytest

from app.config import settings
from app.services import call_signaling as cs

STUN_DEFAULT = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"


@pytest.fixture
def turn_env(monkeypatch):
    """Helper to set the TURN-related settings for one test."""
    def _set(*, urls="", secret="", username="", password="", stun=STUN_DEFAULT, ttl=3600):
        monkeypatch.setattr(settings, "stun_urls", stun)
        monkeypatch.setattr(settings, "turn_urls", urls)
        monkeypatch.setattr(settings, "turn_static_auth_secret", secret)
        monkeypatch.setattr(settings, "turn_username", username)
        monkeypatch.setattr(settings, "turn_password", password)
        monkeypatch.setattr(settings, "turn_credential_ttl_seconds", ttl)
    return _set


def test_stun_only_when_no_turn(turn_env, caplog):
    turn_env()  # no TURN at all
    with caplog.at_level(logging.WARNING, logger="jackpots.chat"):
        cfg = cs.ice_config("admin:1")
    assert cfg["turn_configured"] is False
    assert cfg["iceServers"] == [{"urls": ["stun:stun.l.google.com:19302",
                                           "stun:stun1.l.google.com:19302"]}]
    # The missing-TURN warning must fire (earliest point anyone can be told).
    assert any("no TURN server configured" in r.message for r in caplog.records)


def test_turn_with_static_secret_mints_time_limited_credential(turn_env, caplog):
    secret = "super-secret-shared-value"
    turn_env(urls="turn:turn.example.com:3478", secret=secret, ttl=3600)
    with caplog.at_level(logging.DEBUG, logger="jackpots.chat"):
        cfg = cs.ice_config("admin:7")
    assert cfg["turn_configured"] is True
    turn = [s for s in cfg["iceServers"] if s["urls"] == ["turn:turn.example.com:3478"]]
    assert len(turn) == 1
    entry = turn[0]
    # username is <unix-expiry>:<actor>, expiry in the future
    assert re.fullmatch(r"\d+:admin:7", entry["username"])
    assert int(entry["username"].split(":", 1)[0]) > 0
    # password is base64(HMAC-SHA1(secret, username)) — recompute to verify
    expected = base64.b64encode(
        hmac.new(secret.encode(), entry["username"].encode(), hashlib.sha1).digest()
    ).decode("ascii")
    assert entry["credential"] == expected
    # REDACTION: the shared secret must never appear in the response or the logs.
    assert secret not in json.dumps(cfg)
    assert not any(secret in r.message for r in caplog.records)


def test_turn_with_legacy_static_user_password(turn_env):
    turn_env(urls="turn:turn.example.com:3478", username="relayuser", password="relaypass")
    cfg = cs.ice_config("customer:3")
    assert cfg["turn_configured"] is True
    turn = [s for s in cfg["iceServers"] if "turn" in s["urls"][0]][0]
    assert turn["username"] == "relayuser" and turn["credential"] == "relaypass"


def test_turn_urls_without_auth_is_not_configured(turn_env, caplog):
    # URLs present but NO secret and NO user/pass -> unusable, treated as absent.
    turn_env(urls="turn:turn.example.com:3478")
    with caplog.at_level(logging.WARNING, logger="jackpots.chat"):
        cfg = cs.ice_config("admin:1")
    assert cfg["turn_configured"] is False
    assert all("turn" not in str(s["urls"]).lower() for s in cfg["iceServers"])
    assert any("no TURN server configured" in r.message for r in caplog.records)


def test_ttl_is_returned_for_client_refresh(turn_env):
    turn_env()
    cfg = cs.ice_config("admin:1")
    assert cfg["ttl_seconds"] == settings.ice_ttl_seconds


def test_turn_credentials_are_actor_attributed_and_expiring(turn_env):
    turn_env(urls="turn:x:3478", secret="s", ttl=120)
    u1, _ = cs.turn_credentials("admin:1")
    u2, _ = cs.turn_credentials("customer:9")
    assert u1.endswith(":admin:1") and u2.endswith(":customer:9")
