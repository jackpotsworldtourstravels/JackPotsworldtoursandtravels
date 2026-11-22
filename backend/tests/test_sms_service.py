"""Unit tests for the configurable SMS provider adapter (Phase 2 Bug 1).

No database, no network: the http adapter's one real dependency (``requests``)
is monkeypatched. These pin the contract the rest of Bug 1 relies on — send()
NEVER raises, is OFF by default, masks numbers in logs, and fails closed on a
misconfigured or unknown provider.
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.services import sms_service


def test_mask_number_keeps_only_last_two_digits():
    assert sms_service.mask_number("+91 90000 12345") == "**********45"
    assert sms_service.mask_number("") == "(none)"
    assert sms_service.mask_number(None) == "(none)"
    assert sms_service.mask_number("7") == "*"


def test_send_is_suppressed_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", False)
    r = sms_service.send("9000000000", "hi")
    assert r.suppressed is True and r.ok is False


def test_send_suppressed_with_no_recipient(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "console")
    assert sms_service.send("", "hi").suppressed is True
    assert sms_service.send(None, "hi").suppressed is True


def test_console_adapter_reports_ok_and_sends_nothing(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "console")
    r = sms_service.send("9000000000", "Booking JPX1 confirmed.")
    assert r.ok is True and r.suppressed is False and r.provider == "console"


def test_unknown_provider_fails_closed(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "carrier-pigeon")
    r = sms_service.send("9000000000", "hi")
    assert r.ok is False and r.suppressed is False


def test_http_adapter_without_url_fails_closed(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "http")
    monkeypatch.setattr(settings, "sms_http_url", None)
    r = sms_service.send("9000000000", "hi")
    assert r.ok is False and "sms_http_url" in r.detail


def test_http_adapter_posts_and_accepts_2xx(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "http")
    monkeypatch.setattr(settings, "sms_http_url", "https://sms.example.test/send")
    monkeypatch.setattr(settings, "sms_http_api_key", "secret-key-never-logged")

    captured = {}

    class _Resp:
        status_code = 202

    def _fake_post(url, data=None, headers=None, timeout=None):
        captured["url"] = url
        captured["data"] = data
        captured["headers"] = headers
        return _Resp()

    import requests
    monkeypatch.setattr(requests, "post", _fake_post)

    r = sms_service.send("9000000000", "Booking JPX1 confirmed.")
    assert r.ok is True
    assert captured["url"] == "https://sms.example.test/send"
    # The api key rides in the header only, never in the returned detail.
    assert "secret-key-never-logged" not in r.detail
    assert captured["headers"]["Authorization"] == "Bearer secret-key-never-logged"


def test_http_adapter_non_2xx_is_failure_not_exception(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "http")
    monkeypatch.setattr(settings, "sms_http_url", "https://sms.example.test/send")

    class _Resp:
        status_code = 500

    import requests
    monkeypatch.setattr(requests, "post", lambda *a, **k: _Resp())
    r = sms_service.send("9000000000", "hi")
    assert r.ok is False and "500" in r.detail


def test_http_adapter_connection_error_never_raises(monkeypatch):
    monkeypatch.setattr(settings, "sms_enabled", True)
    monkeypatch.setattr(settings, "sms_provider", "http")
    monkeypatch.setattr(settings, "sms_http_url", "https://sms.example.test/send")

    def _boom(*a, **k):
        raise ConnectionError("dns")

    import requests
    monkeypatch.setattr(requests, "post", _boom)
    r = sms_service.send("9000000000", "hi")   # must not raise
    assert r.ok is False and "connection error" in r.detail
