"""The guard that keeps the B2C payment fixtures off anything real.

Two conditions, both required: a loopback target and the mock provider. The
table below is the whole contract, and the last two tests are the ones that
matter most -- a guard that refuses correctly but only AFTER opening a
connection or writing a row has not prevented anything.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parents[2] / "tests"
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import payment_safety as S  # noqa: E402

LOCAL = "http://127.0.0.1:8000"
PROD = "https://jackpotsworldtours.com"


# ---------------------------------------------------------------------------
# The four combinations
# ---------------------------------------------------------------------------
def test_localhost_and_mock_is_allowed():
    S.enforce(base=LOCAL, provider="mock")          # must not raise
    assert S.problems(LOCAL, "mock") == []


def test_localhost_and_trustbrick_is_refused():
    """Loopback is not enough: the provider decides whose money moves."""
    with pytest.raises(S.UnsafePaymentEnvironment) as exc:
        S.enforce(base=LOCAL, provider="trustbrick")
    assert "PAYMENT_PROVIDER" in str(exc.value)


def test_production_url_and_mock_is_refused():
    """The mock is not enough: real bookings still hold real inventory."""
    with pytest.raises(S.UnsafePaymentEnvironment) as exc:
        S.enforce(base=PROD, provider="mock")
    assert "loopback" in str(exc.value)


def test_production_url_and_trustbrick_is_refused():
    with pytest.raises(S.UnsafePaymentEnvironment) as exc:
        S.enforce(base=PROD, provider="trustbrick")
    message = str(exc.value)
    # BOTH reasons, not just the first -- somebody fixing one must not be
    # surprised by the other on the next run.
    assert "loopback" in message and "PAYMENT_PROVIDER" in message


# ---------------------------------------------------------------------------
# Refusal happens before anything can act
# ---------------------------------------------------------------------------
def test_refusal_happens_before_any_network_activity(monkeypatch):
    """Nothing may be opened on the way to deciding not to proceed."""
    import socket
    import urllib.request

    def explode(*a, **k):
        raise AssertionError("the guard touched the network before refusing")

    monkeypatch.setattr(urllib.request, "urlopen", explode)
    monkeypatch.setattr(socket, "create_connection", explode)
    monkeypatch.setattr(socket.socket, "connect", explode)

    with pytest.raises(S.UnsafePaymentEnvironment):
        S.enforce(base=PROD, provider="trustbrick")


def test_refusal_happens_before_any_database_mutation(monkeypatch):
    """No session, no connection, no statement."""
    from app.database import session as dbsession

    def explode(*a, **k):
        raise AssertionError("the guard touched the database before refusing")

    monkeypatch.setattr(dbsession, "SessionLocal", explode)
    if hasattr(dbsession, "engine"):
        monkeypatch.setattr(dbsession.engine, "connect", explode, raising=False)

    with pytest.raises(S.UnsafePaymentEnvironment):
        S.enforce(base=PROD, provider="trustbrick")


# ---------------------------------------------------------------------------
# The host test is about the HOST, not the string
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("base,local", [
    ("http://127.0.0.1:8000", True),
    ("http://localhost:8000", True),
    ("http://[::1]:8000", True),
    ("http://app.test", True),
    ("http://api.localhost", True),
    ("https://jackpotsworldtours.com", False),
    ("https://api.trustbrick.org", False),
    # The one a substring check gets wrong.
    ("http://localhost.evil.com", False),
    ("https://not-localhost.example.com", False),
])
def test_host_classification(base, local):
    assert S.is_local(base) is local


# ---------------------------------------------------------------------------
# There is no way out
# ---------------------------------------------------------------------------
def test_there_is_no_override(monkeypatch):
    """No environment variable may turn the guard off.

    Anything plausible somebody might reach for in a hurry. If one of these ever
    starts working, this test is how you find out.
    """
    for name in ("JPW_ALLOW_PRODUCTION", "ALLOW_PRODUCTION", "SKIP_SAFETY",
                 "FORCE", "PAYMENT_SAFETY_OFF", "I_KNOW_WHAT_IM_DOING",
                 "CI", "DEBUG"):
        monkeypatch.setenv(name, "1")
    with pytest.raises(S.UnsafePaymentEnvironment):
        S.enforce(base=PROD, provider="trustbrick")


@pytest.mark.parametrize("provider", [None, "", "   ", "Mock ", "MOCK"])
def test_provider_values_that_are_not_exactly_mock(provider):
    """Absent configuration is not permission -- and case/space still count.

    ``None`` is passed explicitly here, which the sentinel in enforce() keeps
    distinct from "not supplied". That distinction is the point: an unset
    provider is the unsafe case, not a request to go and read one.
    """
    normalised = (provider or "").strip().lower()
    if normalised == "mock":
        S.enforce(base=LOCAL, provider=provider)        # tolerated, harmless
        return
    with pytest.raises(S.UnsafePaymentEnvironment):
        S.enforce(base=LOCAL, provider=provider)
