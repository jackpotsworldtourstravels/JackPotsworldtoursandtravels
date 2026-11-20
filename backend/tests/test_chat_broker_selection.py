"""Phase 2 (audit follow-up) — the chat fan-out broker is selected correctly.

This is the logic render.yaml's new Redis service exists to satisfy: with a
REDIS_URL the app must use the cross-worker RedisBroker; without one it falls
back to the in-process broker, which is correct for a SINGLE worker only and
must say so loudly — and must escalate to an ERROR when WEB_CONCURRENCY>1, the
silent half-delivery combination.

No network: RedisBroker.__init__ builds a lazy client (redis.asyncio.from_url
does not connect), and these tests never publish/subscribe. No real DB either.
"""
from __future__ import annotations

import logging

import pytest

from app.config import settings
from app.services import chat_broker
from app.services.chat_broker import InProcessBroker, RedisBroker, get_broker, reset_broker_for_tests


@pytest.fixture(autouse=True)
def _reset():
    reset_broker_for_tests()
    yield
    reset_broker_for_tests()


def test_redis_url_selects_the_cross_worker_broker(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "redis://default:s3cret@cache.internal:6379/0")
    broker = get_broker()
    assert isinstance(broker, RedisBroker)
    # describe() is what a health endpoint surfaces; it names the backend with
    # any credentials stripped (split on '@'), so the password never leaks.
    assert broker.describe() == "redis(cache.internal:6379/0)"
    assert "s3cret" not in broker.describe()


def test_no_redis_single_worker_falls_back_and_warns(monkeypatch, caplog):
    monkeypatch.setattr(settings, "redis_url", None)
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    with caplog.at_level(logging.WARNING, logger="jackpots.chat"):
        broker = get_broker()
    assert isinstance(broker, InProcessBroker)
    assert broker.describe() == "in-process(single worker only)"
    # The fallback announces itself (not silent), but there is no ERROR for one worker.
    assert any("in-process broker" in r.message for r in caplog.records)
    assert not any(r.levelno >= logging.ERROR for r in caplog.records)


def test_no_redis_multi_worker_is_an_error(monkeypatch, caplog):
    monkeypatch.setattr(settings, "redis_url", None)
    monkeypatch.setenv("WEB_CONCURRENCY", "2")
    with caplog.at_level(logging.DEBUG, logger="jackpots.chat"):
        broker = get_broker()
    assert isinstance(broker, InProcessBroker)
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors, "WEB_CONCURRENCY=2 with no REDIS_URL must log an ERROR"
    assert any("REDIS_URL" in r.message and "2" in r.message for r in errors)


def test_broker_is_built_once(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", None)
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    assert get_broker() is get_broker()  # cached process-wide
