"""Session revocation at the timestamp boundary (customer and B2B).

THE DEFECT (found 2026-11-10 by tests/verify_customer_portal.py, reproduced 4 of 4 over HTTP):
``force_logout_at`` is stored with microseconds, but a token's standard ``iat`` is whole
seconds. A password reset at 12:00:05.700 and a login at 12:00:05.900 therefore produced a
token whose iat (12:00:05) was LESS than the revocation time, so the brand-new session was
refused. Truncating the stored time to whole seconds would have cured that by letting a token
issued at 12:00:05.100 (BEFORE the reset) survive it, which weakens revocation. Tokens now
also carry ``iat_ms``; revocation compares in milliseconds.

A controlled clock drives the real token-creation code, so no test sleeps and none can race.
"""
from __future__ import annotations

import datetime as dt
import types

import pytest
from jose import jwt

import app.auth.security as sec
from app.config import settings
from app.services import auth_service, customer_auth_service

UTC = dt.timezone.utc


class _Clock:
    now = dt.datetime(2026, 11, 10, 12, 0, 5)


@pytest.fixture()
def at(monkeypatch):
    """``at(second, ms)`` moves the clock the token code reads."""
    class _FakeDatetime(dt.datetime):
        @classmethod
        def utcnow(cls):
            return _Clock.now

    monkeypatch.setattr(sec, "datetime", types.SimpleNamespace(
        datetime=_FakeDatetime, timedelta=dt.timedelta, timezone=dt.timezone))

    def move(second, ms=0):
        _Clock.now = dt.datetime(2026, 11, 10, 12, 0, second, ms * 1000)
    return move


def _decode(token):
    # verify_exp=False: these fixtures mint tokens under a FIXED historical clock
    # (_Clock = 2026-11-10) to pin iat/iat_ms, so a token's exp is in the past
    # relative to the real wall clock. This suite tests the REVOCATION boundary, not
    # expiry, so expiry validation is skipped HERE only. Production decode_token still
    # enforces exp — asserted by test_production_decode_token_rejects_an_expired_token.
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm],
                      options={"verify_exp": False})


def _forced(second, ms):
    return dt.datetime(2026, 11, 10, 12, 0, second, ms * 1000, tzinfo=UTC)


def _customer(forced):
    return types.SimpleNamespace(auth=types.SimpleNamespace(force_logout_at=forced))


def _user(forced):
    return types.SimpleNamespace(force_logout_at=forced)


#: (rule, builds the account object, token minter) for the two authentication systems.
SYSTEMS = {
    "customer": (customer_auth_service.is_token_revoked, _customer, sec.create_customer_access_token),
    "b2b": (auth_service.is_token_revoked, _user, sec.create_access_token),
}


@pytest.fixture(params=sorted(SYSTEMS))
def system(request):
    return SYSTEMS[request.param]


# ---------------------------------------------------------------------------
# The boundary: tokens issued BEFORE a reset stay dead, tokens issued AFTER live
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("label, token_at, reset_at, revoked", [
    ("issued in an earlier second, before the reset", (4, 500), (5, 700), True),
    ("issued in the SAME second, BEFORE the reset", (5, 100), (5, 700), True),
    ("issued in the SAME second, AFTER the reset (the defect)", (5, 900), (5, 700), False),
    ("issued in the next second, after the reset", (6, 100), (5, 700), False),
    ("issued one millisecond after the reset", (5, 701), (5, 700), False),
    ("issued one millisecond before the reset", (5, 699), (5, 700), True),
    ("issued in the same millisecond as the reset (safe side: revoked)", (5, 700), (5, 700), True),
])
def test_revocation_boundary(system, at, label, token_at, reset_at, revoked):
    rule, account, mint = system
    at(*token_at)
    payload = _decode(mint(7))
    assert rule(account(_forced(*reset_at)), payload) is revoked, label


def test_a_token_issued_before_a_reset_stays_invalid_for_its_whole_life(system, at):
    rule, account, mint = system
    at(5, 100)
    payload = _decode(mint(7))
    reset = account(_forced(5, 700))
    assert rule(reset, payload) is True
    at(5, 999)                      # the same payload, judged later: still dead
    assert rule(reset, payload) is True


def test_a_second_reset_revokes_the_session_that_survived_the_first(system, at):
    rule, account, mint = system
    at(5, 900)
    session = _decode(mint(7))                      # issued after reset #1 (5.700)
    assert rule(account(_forced(5, 700)), session) is False
    assert rule(account(_forced(6, 200)), session) is True     # reset #2 kills it


def test_no_force_logout_means_never_revoked(system, at):
    rule, account, mint = system
    at(5, 0)
    assert rule(account(None), _decode(mint(7))) is False


# ---------------------------------------------------------------------------
# Tokens issued before this change have no iat_ms: their rule must not move
# ---------------------------------------------------------------------------
def _legacy(second, ms=0):
    ts = int(dt.datetime(2026, 11, 10, 12, 0, second, ms * 1000, tzinfo=UTC).timestamp())
    return {"sub": "7", "type": "access", "iat": ts}


@pytest.mark.parametrize("token_at, reset_at, revoked", [
    ((4, 0), (5, 700), True),       # earlier second: revoked, as before
    ((5, 0), (5, 700), True),       # same second: the old rule still rejects it (the old limitation)
    ((6, 0), (5, 700), False),      # a later second: accepted, as before
])
def test_legacy_tokens_without_iat_ms_keep_the_whole_second_rule(system, token_at, reset_at, revoked):
    rule, account, _ = system
    assert rule(account(_forced(*reset_at)), _legacy(*token_at)) is revoked


def test_a_token_with_no_issue_time_at_all_is_revoked(system):
    rule, account, _ = system
    assert rule(account(_forced(5, 0)), {"sub": "7", "type": "access"}) is True


@pytest.mark.parametrize("bad", [True, False, "1794312005900", 1.5, None])
def test_a_malformed_iat_ms_cannot_be_used_to_dodge_revocation(system, bad):
    # A non-integer iat_ms is ignored, so the whole-second rule applies. (The claim is signed,
    # so this is about a defective issuer, not an attacker.)
    rule, account, _ = system
    payload = dict(_legacy(4, 0), iat_ms=bad)
    assert rule(account(_forced(5, 700)), payload) is True


# ---------------------------------------------------------------------------
# What the issuer writes
# ---------------------------------------------------------------------------
def test_every_token_carries_iat_ms_consistent_with_iat(at):
    at(5, 900)
    for mint in (sec.create_customer_access_token, sec.create_customer_refresh_token,
                 sec.create_access_token, sec.create_refresh_token):
        p = _decode(mint(7))
        assert p["iat"] == int(dt.datetime(2026, 11, 10, 12, 0, 5, tzinfo=UTC).timestamp())
        assert p["iat_ms"] == p["iat"] * 1000 + 900
        assert p["exp"] > p["iat"]


def test_the_standard_iat_claim_is_unchanged_for_other_consumers(at):
    at(5, 900)
    p = _decode(sec.create_customer_access_token(7))
    assert isinstance(p["iat"], int) and p["scope"] == "customer" and p["type"] == "access"


def test_production_decode_token_rejects_an_expired_token():
    """D1 guard: the test `_decode` deliberately skips exp, but PRODUCTION
    `decode_token` must NOT — an expired token decodes to None (its JWTError, of
    which ExpiredSignatureError is a subclass, is swallowed). Uses an explicitly
    past exp so the check is deterministic regardless of the run date."""
    past = dt.datetime.now(UTC) - dt.timedelta(hours=1)
    expired = jwt.encode({"sub": "7", "type": "access", "exp": past},
                         settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    assert sec.decode_token(expired) is None


def test_naive_and_aware_revocation_times_agree():
    naive = dt.datetime(2026, 11, 10, 12, 0, 5, 700000)
    aware = naive.replace(tzinfo=UTC)
    payload = {"iat_ms": sec._epoch_ms(aware) - 1}
    assert sec.is_revoked_by(naive, payload) is sec.is_revoked_by(aware, payload) is True
