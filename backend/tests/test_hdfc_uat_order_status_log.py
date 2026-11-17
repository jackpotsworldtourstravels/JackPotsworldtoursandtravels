"""UAT-only logging of the real Order Status response (GET /orders/{id}).

Nothing here opens a socket: ``requests.request`` is replaced. The bodies are
the test suite's own canned documents (``hdfc_fakes.order_doc``) — they are NOT
HDFC output and prove only that the adapter logs what it receives, sanitised.
"""

from __future__ import annotations

import base64
import json
import logging

import pytest
import requests

from app.services.payments import hdfc_provider as H
from tests.hdfc_fakes import (
    API_KEY, FakeHDFC, FakeResponse, RESPONSE_KEY, WEBHOOK_PASS,
    make_provider, order_doc, session_doc,
)

LOGGER = "app.services.payments.hdfc_provider"
PROD_BASE = "https://smartgateway.hdfc.bank.in"
OID = "JP20260001"
MARK = "UAT order-status"


def _all(caplog) -> str:
    return "\n".join(r.getMessage() for r in caplog.records)


def _lines(caplog):
    return [r.getMessage() for r in caplog.records if MARK in r.getMessage()]


def _body_of(line: str):
    return json.loads(line.split(" body=", 1)[1])


def _fetch(monkeypatch, doc=None, status=200):
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(status, doc or order_doc(OID))})
    return make_provider().fetch_order(OID)


# ---------------------------------------------------------------------------
# What is logged
# ---------------------------------------------------------------------------
def test_uat_order_status_response_is_logged(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    _fetch(monkeypatch)
    lines = _lines(caplog)
    assert len(lines) == 1
    line = lines[0]
    assert "http_status=200" in line
    assert f"order_id={OID}" in line
    assert "ts=20" in line                      # ISO timestamp
    body = _body_of(line)
    assert body["status"] == "CHARGED"
    assert body["order_id"] == OID


def test_troubleshooting_references_are_preserved(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    doc = order_doc(OID, payment_gateway_response={
        "rrn": "156555", "epg_txn_id": "EPG123", "auth_id_code": "A1",
        "created": "2026-09-24T10:21:11Z"})
    _fetch(monkeypatch, doc)
    body = _body_of(_lines(caplog)[0])
    assert body["txn_id"] and body["id"]
    assert body["merchant_id"] and body["amount"] == 56
    assert body["payment_gateway_response"] == {
        "rrn": "156555", "epg_txn_id": "EPG123", "auth_id_code": "A1",
        "created": "2026-09-24T10:21:11Z"}
    assert body["txn_detail"]["txn_id"]


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("key", [
    # the findings from the review
    "client_auth_token", "Client-Auth-Token", "clientAuthToken", "CLIENT_AUTH_TOKEN",
    "card_details", "cardDetails", "card", "Card", "card_isin", "name_on_card",
    "udf1", "UDF2", "udf10", "udf_note",
    # vpa / upi
    "payer_vpa", "payerVPA", "vpa", "upi", "upi_id",
    # email / phone / contact
    "customer_email", "email", "Customer-Phone", "phone", "mobile_number", "contact",
    # addresses
    "billing_address", "shippingAddress", "address", "address_line1",
    # names
    "customer_name", "first_name", "lastName", "full_name", "card_holder",
    # secrets
    "password", "Password", "api_key", "apiKey", "secret", "client_secret",
    "authorization", "Authorization", "bearer_token", "access-token", "signature",
    "webhook_password",
    # existing exact set, still honoured
    "gateway_response", "sdk_payload", "merchant_payload", "payment_page_sdk_payload",
    "mandate", "payment_links",
    # unknown but obviously sensitive: fails closed
    "payerVpaHandle", "card_holder_dob", "customer_id", "bank_account_number",
])
def test_sensitive_keys_are_redacted(key):
    out = json.loads(H._sanitized_for_log({key: "SENSITIVE-VALUE", "order_id": OID}))
    assert out[key] == "<redacted>"
    assert out["order_id"] == OID


@pytest.mark.parametrize("key", [
    "order_id", "status", "status_id", "id", "txn_id", "txn_uuid", "rrn",
    "epg_txn_id", "auth_id_code", "merchant_id", "amount", "currency",
    "payment_method_type", "bank_error_message", "refunded", "date_created",
])
def test_troubleshooting_keys_are_not_redacted(key):
    out = json.loads(H._sanitized_for_log({key: "KEEP-ME"}))
    assert out[key] == "KEEP-ME"


def test_nested_sensitive_fields_in_dicts_and_lists_are_redacted():
    doc = {
        "order_id": OID,
        "refunds": [{"unique_request_id": "r1", "customer_email": "x@y.test",
                     "deep": [{"deeper": {"Client-Auth-Token": "T", "ok": 1}}]}],
        "txn_detail": {"payer_vpa": "asha@okbank", "txn_id": "T1",
                       "inner": {"udf3": "free text", "keep": "yes"}},
    }
    out = json.loads(H._sanitized_for_log(doc))
    assert out["refunds"][0]["customer_email"] == "<redacted>"
    assert out["refunds"][0]["deep"][0]["deeper"] == {
        "Client-Auth-Token": "<redacted>", "ok": 1}
    assert out["txn_detail"]["payer_vpa"] == "<redacted>"
    assert out["txn_detail"]["inner"] == {"udf3": "<redacted>", "keep": "yes"}
    assert out["txn_detail"]["txn_id"] == "T1"


def test_handles_hidden_in_free_text_values_are_scrubbed():
    out = H._sanitized_for_log({
        "note": "mail leaky.person@example.test or pay asha@okbank now",
        "list": ["a@b.co"]})
    assert "leaky.person" not in out and "asha@okbank" not in out and "a@b.co" not in out
    assert "<handle>" in out


def test_end_to_end_log_has_no_sensitive_values(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    doc = order_doc(
        OID,
        customer_name="Asha Traveller",
        billing_address={"line1": "12 Secret Street"},
        notes="mail me at leaky.person@example.test please",
        card={"last_four_digits": "1097", "card_isin": "401200",
              "name_on_card": "ASHA T"},
        card_details={"last_four_digits": "1097"},
        payer_vpa="asha@okbank",
        client_auth_token="tkn_SECRET",
        udf1="phone 9876543210",
    )
    _fetch(monkeypatch, doc)
    out = _all(caplog)
    assert MARK in out
    for leaked in (
        "traveller@example.test", "leaky.person@example.test", "9000000000",
        "JPC1001", "Asha Traveller", "12 Secret Street", "1097", "401200",
        "ASHA T", "asha@okbank", "tkn_SECRET", "9876543210",
        API_KEY, WEBHOOK_PASS, RESPONSE_KEY,
    ):
        assert leaked not in out, leaked


def test_request_credentials_never_appear(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    fake = FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(200, order_doc(OID))})
    make_provider().fetch_order(OID)
    assert fake.calls[0]["headers"]          # the call really was authenticated
    out = _all(caplog)
    assert base64.b64encode(f"{API_KEY}:".encode()).decode() not in out
    assert API_KEY not in out


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------
def test_deep_nesting_is_cut_off():
    deep: dict = {}
    cur = deep
    for _ in range(30):
        cur["k"] = {}
        cur = cur["k"]
    cur["customer_email"] = "buried@example.test"
    text = H._sanitized_for_log(deep)
    assert "<max-depth>" in text
    assert "buried@example.test" not in text
    assert text.count('"k"') <= H._LOG_MAX_DEPTH + 2


def test_sensitive_data_below_the_depth_limit_cannot_leak():
    deep: dict = {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": {"j": "leak@x.test"}}}}}}}}}}
    assert "leak@x.test" not in H._sanitized_for_log(deep)


def test_long_lists_are_capped():
    out = json.loads(H._sanitized_for_log({"items": list(range(500))}))
    assert len(out["items"]) == H._LOG_MAX_ITEMS


def test_oversized_body_is_truncated_with_a_visible_marker():
    text = H._sanitized_for_log({"order_id": OID, "blob": "x" * 50_000})
    assert len(text) == H._LOG_MAX_CHARS
    assert text.endswith(H._LOG_TRUNCATED)


def test_truncation_happens_after_redaction():
    text = H._sanitized_for_log({"a_big": "y" * 20_000, "zz_email": "leak@x.test"})
    assert "leak@x.test" not in text


def test_a_normal_body_is_not_truncated():
    text = H._sanitized_for_log(order_doc(OID))
    assert not text.endswith(H._LOG_TRUNCATED)
    json.loads(text)                          # still valid JSON


# ---------------------------------------------------------------------------
# Fail-safe
# ---------------------------------------------------------------------------
def test_a_sanitiser_failure_does_not_interrupt_fetch_order(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)

    def boom(_body):
        raise RuntimeError("SECRET-IN-EXCEPTION customer_email=a@b.test")

    monkeypatch.setattr(H, "_sanitized_for_log", boom)
    got = _fetch(monkeypatch)
    assert got.provider_order_id == OID
    assert got.provider_status == "charged"
    out = _all(caplog)
    assert "logging skipped" in out
    assert "SECRET-IN-EXCEPTION" not in out and "a@b.test" not in out
    assert all(r.exc_info is None for r in caplog.records)


def test_a_logger_failure_does_not_interrupt_fetch_order(monkeypatch):
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(200, order_doc(OID))})
    provider = make_provider()                  # built first: its own startup log is unrelated

    def explode(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(H.logger, "info", explode)
    assert provider.fetch_order(OID).provider_order_id == OID


def test_fetch_order_survives_both_info_and_warning_logging_failing(monkeypatch):
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(200, order_doc(OID))})
    provider = make_provider()                  # built first: its own startup log is unrelated

    def explode(*a, **k):
        raise OSError("logging backend down")

    monkeypatch.setattr(H.logger, "info", explode)
    monkeypatch.setattr(H.logger, "warning", explode)
    got = provider.fetch_order(OID)
    assert got.provider_order_id == OID
    assert got.provider_status == "charged"
    assert got.amount_minor == 5600
    assert got.currency == "INR"


# ---------------------------------------------------------------------------
# Scope: UAT + Order Status GET only
# ---------------------------------------------------------------------------
def test_production_response_bodies_are_not_logged(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)

    def fake(method, url, **kw):
        assert url.startswith(PROD_BASE)        # no real call: this is a stub
        return FakeResponse(200, order_doc(OID))

    monkeypatch.setattr(requests, "request", fake)
    p = make_provider(base_url=PROD_BASE, environment="live",
                      client_id="JPLIVEMID", webhook_password="a-long-live-webhook-secret-42")
    got = p.fetch_order(OID)
    assert got.provider_order_id == OID         # the call itself still works
    out = _all(caplog)
    assert MARK not in out
    assert "CHARGED" not in out
    assert "traveller@example.test" not in out


def test_unrelated_endpoints_are_not_logged(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    FakeHDFC(monkeypatch, {
        "POST /session": FakeResponse(200, session_doc(OID)),
        f"POST /orders/{OID}/refunds": FakeResponse(200, order_doc(OID, refunds=[])),
        f"GET /orders/{OID}/refunds": FakeResponse(200, {"status": "x"}),
        f"POST /orders/{OID}": FakeResponse(200, order_doc(OID)),
    })
    p = make_provider()
    for method, path, kw in (
        ("POST", "/session", {"json_body": {"order_id": OID}}),
        ("POST", f"/orders/{OID}/refunds", {"json_body": {"unique_request_id": "r1"}}),
        ("GET", f"/orders/{OID}/refunds", {}),
        ("POST", f"/orders/{OID}", {"json_body": {}}),
    ):
        p._request(method, path, customer_ref="c", **kw)
    out = _all(caplog)
    assert MARK not in out
    assert "tkn_SHOULD_NEVER_REACH_A_BROWSER" not in out


def test_a_trailing_newline_path_is_not_treated_as_order_status():
    assert not H._ORDER_STATUS_PATH.fullmatch(f"/orders/{OID}\n")
    assert H._ORDER_STATUS_PATH.fullmatch(f"/orders/{OID}")


def test_error_responses_are_not_body_logged(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(404, {"error_message": "nope"})})
    with pytest.raises(Exception):
        make_provider().fetch_order(OID)
    assert MARK not in _all(caplog)


# ---------------------------------------------------------------------------
# Behaviour unchanged
# ---------------------------------------------------------------------------
def test_logging_does_not_change_the_result_or_the_stored_raw(monkeypatch):
    got = _fetch(monkeypatch)
    assert got.provider_order_id == OID
    assert got.provider_status == "charged"
    assert got.amount_minor == 5600
    assert got.currency == "INR"
    # `raw` is still built by the ORIGINAL _redacted(): the log sanitiser's
    # stricter rules must not leak into what is stored.
    assert got.raw["customer_id"] == "JPC1001"      # the log redacts this; `raw` never did
    assert got.raw["card"] == "<redacted>"
    assert got.raw == H._redacted(order_doc(OID))


def test_the_original_redaction_set_is_unchanged():
    assert H._redacted({"customer_id": "JPC1001", "card": {}, "udf1": "x"}) == {
        "customer_id": "JPC1001", "card": "<redacted>", "udf1": "x"}
