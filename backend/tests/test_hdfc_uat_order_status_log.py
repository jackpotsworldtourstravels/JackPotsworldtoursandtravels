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
    API_KEY, FakeHDFC, FakeResponse, RESPONSE_KEY, WEBHOOK_PASS, WEBHOOK_USER,
    basic, make_provider, order_doc, session_doc, webhook_body,
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
    # udf1/udf2 are now kept for the bank's evidence (see the dedicated tests
    # below); udf3-5 and any other udf* are still redacted.
    "udf10", "udf_note", "udf3", "UDF5",
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


# ---------------------------------------------------------------------------
# UDF fields: kept ONLY when they hold the values we actually send
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("ref", ["JPH000999", "JPB000123", "DE000123", "ABCDEFGH123456"])
def test_a_valid_booking_reference_in_udf1_is_kept(ref):
    """A well-formed booking ref (2-8 letters + 6 digits) is shown to HDFC."""
    out = json.loads(H._sanitized_for_log({"udf1": ref, "order_id": OID}))
    assert out["udf1"] == ref


@pytest.mark.parametrize("bad", [
    "9876543210",                       # a bare phone number — the handle scrubber misses it
    "+91 98765 43210",                  # a formatted phone number
    "leaky.person@example.test",        # an e-mail address
    "asha@okbank",                      # a UPI handle
    "Asha Traveller",                   # a customer name
    "4012001037141112",                 # a PAN-shaped number
    "JPB12345",                         # ref-like but only 5 digits
    "JPB0001234",                       # ref-like but 7 digits
    "TOOLONGPREFIX000123",              # prefix longer than 8 letters
    "JP000123 and more",                # a valid ref with trailing text
    "",                                 # empty
])
def test_a_non_reference_udf1_value_is_redacted(bad):
    """udf1 is echoed from HDFC's store: anything that is not exactly a booking
    reference is treated as the PII it might be, and redacted."""
    out = json.loads(H._sanitized_for_log({"udf1": bad, "order_id": OID}))
    assert out["udf1"] == "<redacted>"
    assert bad == "" or bad not in json.dumps(out)   # the raw value never leaks


def test_udf2_null_survives_the_sanitiser_as_json_null(monkeypatch, caplog):
    """HDFC asked for the Order Status log with UDF2 visible as null."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    doc = order_doc(OID, udf1="JPB000123", udf2=None)
    _fetch(monkeypatch, doc)
    line = _lines(caplog)[0]
    body = _body_of(line)
    assert body["udf1"] == "JPB000123"          # booking reference, preserved
    assert "udf2" in body and body["udf2"] is None   # present, and JSON null
    assert '"udf2": null' in line               # visible as null on the log line


@pytest.mark.parametrize("bad", ["package", "flight", "hotel", "9876543210", "x@y.test"])
def test_a_non_null_udf2_is_redacted(bad):
    """udf2 must only ever be null; a non-null echo is redacted, not trusted."""
    out = json.loads(H._sanitized_for_log({"udf2": bad, "order_id": OID}))
    assert out["udf2"] == "<redacted>"
    assert bad not in json.dumps(out)


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
        # udf1 holds a well-formed booking reference and udf2 is null: both are
        # shown to the bank. A PII-shaped udf1 is covered by the dedicated tests
        # above (it is redacted, not shown).
        udf1="JPB000123",
        udf2=None,
    )
    _fetch(monkeypatch, doc)
    out = _all(caplog)
    assert MARK in out
    assert "JPB000123" in out                    # valid booking ref IS shown to the bank
    assert '"udf2": null' in out                 # udf2 IS shown, as null
    for leaked in (
        "traveller@example.test", "leaky.person@example.test", "9000000000",
        "JPC1001", "Asha Traveller", "12 Secret Street", "1097", "401200",
        "ASHA T", "asha@okbank", "tkn_SECRET",
        API_KEY, WEBHOOK_PASS, RESPONSE_KEY,
    ):
        assert leaked not in out, leaked


def test_end_to_end_a_phone_number_in_udf1_does_not_leak(monkeypatch, caplog):
    """The regression the earlier change lost: a phone number echoed in udf1
    must not reach the log, even though udf1 is otherwise shown to the bank."""
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    doc = order_doc(OID, udf1="9876543210", udf2=None)
    _fetch(monkeypatch, doc)
    out = _all(caplog)
    assert MARK in out
    assert "9876543210" not in out               # the phone number is redacted
    assert "<redacted>" in out
    assert '"udf2": null' in out


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
    # customer_id is still not in _REDACT; card still is. udf1 "x" is no longer
    # kept verbatim — it is not a booking reference (see the _redacted udf tests).
    assert H._redacted({"customer_id": "JPC1001", "card": {}, "udf1": "x"}) == {
        "customer_id": "JPC1001", "card": "<redacted>", "udf1": "<redacted>"}


# ---------------------------------------------------------------------------
# The STORED `raw` (event log / refund row) is sanitised the same way — this is
# the persisted path, not the UAT log. _redacted() feeds every raw= sink:
# fetch_order (Order Status), parse_refund, and parse_webhook.
# ---------------------------------------------------------------------------
def test_stored_raw_keeps_a_valid_booking_reference_and_null_udf2():
    out = H._redacted({"order_id": OID, "udf1": "JPB000123", "udf2": None})
    assert out["udf1"] == "JPB000123"
    assert out["udf2"] is None


@pytest.mark.parametrize("bad", [
    "9876543210", "+91 98765 43210", "leaky.person@example.test", "asha@okbank",
    "Asha Traveller", "JPB12345", "JPB0001234", "package", "",
])
def test_stored_raw_redacts_a_non_reference_udf1(bad):
    out = H._redacted({"order_id": OID, "udf1": bad})
    assert out["udf1"] == "<redacted>"
    assert bad == "" or bad not in json.dumps(out)


@pytest.mark.parametrize("bad", ["package", "flight", "hotel", "9876543210", "x@y.test"])
def test_stored_raw_redacts_a_non_null_udf2(bad):
    out = H._redacted({"order_id": OID, "udf2": bad})
    assert out["udf2"] == "<redacted>"
    assert bad not in json.dumps(out)


@pytest.mark.parametrize("key", ["udf3", "UDF4", "udf5", "udf10", "udf_note"])
def test_stored_raw_always_redacts_udf3_to_5_and_other_udf(key):
    out = H._redacted({"order_id": OID, key: "9876543210"})
    assert out[key] == "<redacted>"
    assert "9876543210" not in json.dumps(out)


def test_stored_raw_still_redacts_card_and_pii_and_recurses():
    out = H._redacted({
        "order_id": OID,
        "card": {"last_four_digits": "1097"},
        "customer_email": "x@y.test", "customer_phone": "9000000000",
        "payer_vpa": "asha@okbank",
        "txn_detail": {"udf1": "9876543210", "udf2": None, "txn_id": "T1"},
    })
    assert out["card"] == "<redacted>"
    assert out["customer_email"] == "<redacted>"
    assert out["customer_phone"] == "<redacted>"
    assert out["payer_vpa"] == "<redacted>"
    # udf sanitisation reaches nested objects too (webhook content.order.*).
    assert out["txn_detail"]["udf1"] == "<redacted>"
    assert out["txn_detail"]["udf2"] is None
    assert out["txn_detail"]["txn_id"] == "T1"
    assert "9876543210" not in json.dumps(out)


def test_verify_webhook_raw_sanitises_untrusted_udf_before_storage():
    """The real webhook storage path: verify_webhook builds raw via _redacted,
    which record_event persists as PaymentProviderEvent.payload. A phone number
    echoed in udf1 (and anything in udf3) must not reach that stored payload."""
    provider = make_provider()
    raw_body = webhook_body(OID, udf1="9876543210", udf2=None, udf3="secret note")
    event = provider.verify_webhook(raw_body=raw_body,
                                    headers={"Authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)})
    stored = json.dumps(event.raw)
    assert "9876543210" not in stored          # phone in udf1 never persisted
    assert "secret note" not in stored         # udf3 never persisted
    # A real booking reference in udf1, and a null udf2, DO survive.
    good = webhook_body(OID, udf1="JPH000999", udf2=None)
    event2 = provider.verify_webhook(raw_body=good,
                                     headers={"Authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)})
    stored2 = json.dumps(event2.raw)
    assert "JPH000999" in stored2
    assert '"udf2": null' in stored2
