"""The HDFC SmartGateway adapter, against HDFC's documented request/response shapes.

No socket is opened: ``requests.request`` is replaced by ``FakeHDFC``. What is
pinned here is everything the adapter decides on its own -- configuration
refusal, the exact headers and body, how each failure is classified, how an
HDFC status maps onto ours, and how a webhook and a return URL are
authenticated. What the SERVICE decides with those answers (amount checks,
capture, booking confirmation, idempotency) is in test_hdfc_flow.py.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from urllib.parse import quote_plus

import pytest
import requests

from app.services import payments as P
from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
from tests.hdfc_fakes import (
    API_KEY,
    BASE,
    MERCHANT,
    RESPONSE_KEY,
    RETURN_URL,
    WEBHOOK_PASS,
    WEBHOOK_USER,
    FakeHDFC,
    FakeResponse,
    basic,
    make_provider,
    order_doc,
    session_doc,
    webhook_body,
)

REF = "JPH000999"
KEY = "mb-JPH000999"


def _order_id():
    return HDFCSmartGatewayProvider.order_id_for(REF, KEY)


def _create(p, **kw):
    args = dict(amount_minor=5600, currency="INR", reference=REF, idempotency_key=KEY,
                customer={"name": "Test Traveller", "email": "traveller@example.test",
                          "contact": "+91 90000 00000"},
                notes={"customer_id": 1001, "product_type": "hotel"})
    args.update(kw)
    return p.create_checkout(**args)


# ===========================================================================
# Provider initialisation and configuration
# ===========================================================================
def test_uat_configuration_initialises():
    p = make_provider()
    assert p.name == "hdfc"
    # HDFC: "For Sandbox use 'hdfcmaster' as your client_id".
    assert p._client_id == "hdfcmaster"
    assert p._reseller_id == "hdfc_reseller"
    # The only value the browser may see is the merchant id.
    assert p.publishable_key == MERCHANT


@pytest.mark.parametrize("missing", [
    "base_url", "merchant_id", "api_key", "return_url", "webhook_username", "webhook_password",
])
def test_missing_credentials_fail_safely(missing):
    with pytest.raises(P.PaymentMisconfigured) as exc:
        make_provider(**{missing: ""})
    message = str(exc.value)
    assert "HDFC_SG_" in message
    # Fails WITHOUT echoing any secret that WAS present.
    for secret in (API_KEY, WEBHOOK_PASS, RESPONSE_KEY):
        assert secret not in message


def test_base_url_must_be_https():
    with pytest.raises(P.PaymentMisconfigured):
        make_provider(base_url="http://smartgateway.hdfcuat.bank.in")


def test_production_host_refused_in_test_environment():
    with pytest.raises(P.PaymentMisconfigured) as exc:
        make_provider(base_url="https://smartgateway.hdfc.bank.in", environment="test")
    assert "PRODUCTION" in str(exc.value)


def test_uat_host_refused_in_live_environment():
    with pytest.raises(P.PaymentMisconfigured):
        make_provider(environment="live")


def test_production_client_id_is_the_merchant_id():
    p = make_provider(base_url="https://smartgateway.hdfc.bank.in", environment="live")
    assert p._client_id == MERCHANT


@pytest.mark.parametrize("bad", [
    "http://tours.example.test/api/payments/hdfc/return",        # not https
    "https://tours.example.test/api/payments/hdfc/return?x=1",   # query string
    "https://10.0.0.5/api/payments/hdfc/return",                 # an IP address
])
def test_return_url_rules_from_hdfc_docs(bad):
    with pytest.raises(P.PaymentMisconfigured):
        make_provider(return_url=bad)


def test_factory_builds_hdfc_from_settings(monkeypatch):
    s = P.app.config.settings
    for k, v in dict(payment_provider="hdfc", payment_environment="test",
                     hdfc_sg_base_url=BASE, hdfc_sg_merchant_id=MERCHANT,
                     hdfc_sg_api_key=API_KEY, hdfc_sg_webhook_username=WEBHOOK_USER,
                     hdfc_sg_webhook_password=WEBHOOK_PASS, hdfc_sg_return_url=None,
                     frontend_base_url="https://tours.example.test").items():
        monkeypatch.setattr(s, k, v)
    P.reset_provider_cache()
    try:
        prov = P.get_provider()
        assert prov.name == "hdfc"
        # Default return URL is derived from FRONTEND_BASE_URL, never a request.
        assert prov._return_url == "https://tours.example.test/api/payments/hdfc/return"
        assert P.get_provider_named("hdfc") is prov
    finally:
        P.reset_provider_cache()


def test_razorpay_selection_is_unchanged_by_hdfc_settings(monkeypatch):
    """HDFC configured but PAYMENT_PROVIDER=razorpay: Razorpay still collects,
    and HDFC is resolvable by NAME only (its webhook/return must still work)."""
    s = P.app.config.settings
    for k, v in dict(payment_provider="razorpay", razorpay_key_id="rzp_test_x",
                     razorpay_key_secret="s", razorpay_webhook_secret="w",
                     hdfc_sg_base_url=BASE, hdfc_sg_merchant_id=MERCHANT,
                     hdfc_sg_api_key=API_KEY, hdfc_sg_webhook_username=WEBHOOK_USER,
                     hdfc_sg_webhook_password=WEBHOOK_PASS,
                     hdfc_sg_return_url=RETURN_URL).items():
        monkeypatch.setattr(s, k, v)
    P.reset_provider_cache()
    try:
        assert P.get_provider().name == "razorpay"
        assert P.get_provider_named("razorpay").name == "razorpay"
        assert P.get_provider_named("hdfc").name == "hdfc"
        assert P.publishable_key() == "rzp_test_x"
    finally:
        P.reset_provider_cache()


def test_hdfc_by_name_without_settings_is_not_configured(monkeypatch):
    s = P.app.config.settings
    monkeypatch.setattr(s, "payment_provider", "none")
    monkeypatch.setattr(s, "hdfc_sg_base_url", None)
    P.reset_provider_cache()
    try:
        with pytest.raises(P.PaymentNotConfigured):
            P.get_provider_named("hdfc")
    finally:
        P.reset_provider_cache()


# ===========================================================================
# Authentication headers
# ===========================================================================
def test_authentication_headers_are_exactly_as_documented(monkeypatch):
    oid = _order_id()
    fake = FakeHDFC(monkeypatch, {"POST /session": FakeResponse(200, session_doc(oid))})
    _create(make_provider())
    h = fake.calls[0]["headers"]
    # "Base64 Encoded API Key ... sent in the Authorization header as: Basic MTIzNA=="
    assert h["Authorization"] == "Basic " + base64.b64encode(API_KEY.encode()).decode()
    assert h["x-merchantid"] == MERCHANT
    assert h["x-customerid"] == "JPC1001"
    assert h["x-resellerid"] == "hdfc_reseller"
    assert h["Content-Type"] == "application/json"
    assert fake.calls[0]["timeout"] == 5


def test_documented_example_key_encoding():
    """HDFC's own worked example: key 1234 -> 'Basic MTIzNA=='."""
    p = make_provider(api_key="1234")
    assert p._headers("c", "application/json")["Authorization"] == "Basic MTIzNA=="


# ===========================================================================
# Create payment
# ===========================================================================
def test_valid_payment_sends_documented_fields(monkeypatch):
    oid = _order_id()
    fake = FakeHDFC(monkeypatch, {"POST /session": FakeResponse(200, session_doc(oid))})
    session = _create(make_provider())

    body = fake.calls[0]["json"]
    assert body["order_id"] == oid
    assert len(oid) <= 20 and oid.isalnum()               # "less than 21", no specials
    assert body["amount"] == "56.00"                        # rupees, two decimals
    assert body["currency"] == "INR"
    assert body["customer_id"] == "JPC1001"
    assert body["customer_email"] == "traveller@example.test"
    assert body["customer_phone"] == "9000000000"           # "without including +91"
    assert body["payment_page_client_id"] == "hdfcmaster"
    assert body["action"] == "paymentPage"
    assert body["return_url"] == RETURN_URL
    assert body["first_name"] == "Test" and body["last_name"] == "Traveller"
    assert body["udf1"] == REF

    assert session.provider == "hdfc"
    assert session.order_id == oid
    assert session.amount_minor == 5600 and session.currency == "INR"
    assert session.redirect_url.startswith(BASE + "/orders/")
    assert session.publishable_key == MERCHANT
    # The SDK's clientAuthToken is never handed upward toward a browser.
    assert "tkn_" not in repr(session)


def test_amount_conversion_is_exact_for_awkward_figures(monkeypatch):
    oid = _order_id()
    fake = FakeHDFC(monkeypatch, {
        "POST /session": FakeResponse(200, session_doc(oid, amount="112999.99")),
    })
    session = _create(make_provider(), amount_minor=11299999)
    assert fake.calls[0]["json"]["amount"] == "112999.99"
    assert session.amount_minor == 11299999


def test_same_booking_and_key_always_gives_the_same_order_id():
    a = HDFCSmartGatewayProvider.order_id_for(REF, KEY)
    assert a == HDFCSmartGatewayProvider.order_id_for(REF.lower(), KEY)
    assert a != HDFCSmartGatewayProvider.order_id_for(REF, KEY + "x")
    assert a != HDFCSmartGatewayProvider.order_id_for("JPH001000", KEY)


@pytest.mark.parametrize("amount", [0, -100])
def test_invalid_amount_is_refused_before_any_call(monkeypatch, amount):
    fake = FakeHDFC(monkeypatch)
    with pytest.raises(P.PaymentFailed) as exc:
        _create(make_provider(), amount_minor=amount)
    assert exc.value.code == "invalid_amount"
    assert fake.calls == []


def test_invalid_currency_is_refused_before_any_call(monkeypatch):
    fake = FakeHDFC(monkeypatch)
    with pytest.raises(P.PaymentFailed) as exc:
        _create(make_provider(), currency="USD")
    assert exc.value.code == "invalid_currency"
    assert fake.calls == []


def test_provider_error_400_is_a_refusal_and_is_not_leaked(monkeypatch, caplog):
    FakeHDFC(monkeypatch, {"POST /session": FakeResponse(400, {
        "status": "Bad Request", "error_code": "Mandatory fields are missing",
        "error_message": "customer_email"})})
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(P.PaymentFailed) as exc:
            _create(make_provider())
    # The customer sees the generic sentence, never HDFC's developer message.
    assert "customer_email" not in exc.value.customer_message
    assert API_KEY not in caplog.text


def test_invalid_authentication_is_misconfiguration(monkeypatch):
    FakeHDFC(monkeypatch, {"POST /session": FakeResponse(401, {
        "status": "error", "error_code": "access_denied"})})
    with pytest.raises(P.PaymentMisconfigured):
        _create(make_provider())


@pytest.mark.parametrize("answer", [
    requests.Timeout("slow"),
    requests.ConnectionError("reset"),
    FakeResponse(500, {"status": "error", "error_code": "Internal server Error"}),
    FakeResponse(503, "Service Unavailable"),
])
def test_timeout_and_provider_unavailable_are_unknown_not_failed(monkeypatch, answer):
    FakeHDFC(monkeypatch, {"POST /session": answer})
    with pytest.raises(P.PaymentTimeout):
        _create(make_provider())


def test_malformed_response_is_refused(monkeypatch):
    FakeHDFC(monkeypatch, {"POST /session": FakeResponse(200, "<html>not json</html>")})
    with pytest.raises(P.PaymentFailed) as exc:
        _create(make_provider())
    assert exc.value.code == "malformed_response"


def test_response_without_payment_link_is_refused(monkeypatch):
    oid = _order_id()
    doc = session_doc(oid)
    doc.pop("payment_links")
    FakeHDFC(monkeypatch, {"POST /session": FakeResponse(200, doc)})
    with pytest.raises(P.PaymentFailed):
        _create(make_provider())


@pytest.mark.parametrize("link", [
    "https://evil.example.com/pay",
    "http://smartgateway.hdfcuat.bank.in/orders/x/payment-page",
    "javascript:alert(1)",
])
def test_payment_link_must_be_hdfc_over_https(monkeypatch, link):
    oid = _order_id()
    FakeHDFC(monkeypatch, {"POST /session": FakeResponse(200, session_doc(oid, link=link))})
    with pytest.raises(P.PaymentFailed) as exc:
        _create(make_provider())
    assert exc.value.code in ("unsafe_redirect", "malformed_response")


def test_session_for_a_different_order_is_refused(monkeypatch):
    FakeHDFC(monkeypatch, {"POST /session": FakeResponse(200, session_doc("JPsomethingelse"))})
    with pytest.raises(P.PaymentFailed) as exc:
        _create(make_provider())
    assert exc.value.code == "order_mismatch"


def test_retry_after_timeout_reuses_the_existing_order(monkeypatch):
    """may_exist: look first, and never POST /session for an order HDFC has."""
    oid = _order_id()
    fake = FakeHDFC(monkeypatch, {
        f"GET /orders/{oid}": FakeResponse(200, order_doc(oid, status="NEW")),
    })
    session = _create(make_provider(), may_exist=True)
    assert fake.count("POST", "/session") == 0
    assert session.order_id == oid and session.amount_minor == 5600
    assert session.redirect_url.startswith(BASE)


def test_duplicate_create_refused_by_hdfc_falls_back_to_the_existing_order(monkeypatch):
    oid = _order_id()
    fake = FakeHDFC(monkeypatch, {
        "POST /session": FakeResponse(400, {"status": "error", "error_code": "duplicate"}),
        f"GET /orders/{oid}": FakeResponse(200, order_doc(oid, status="NEW")),
    })
    session = _create(make_provider())
    assert session.order_id == oid
    assert fake.count("POST", "/session") == 1


def test_timeout_during_lookup_does_not_create(monkeypatch):
    oid = _order_id()
    fake = FakeHDFC(monkeypatch, {f"GET /orders/{oid}": requests.Timeout("slow")})
    with pytest.raises(P.PaymentTimeout):
        _create(make_provider(), may_exist=True)
    assert fake.count("POST", "/session") == 0


def test_api_key_never_appears_in_logs(monkeypatch, caplog):
    oid = _order_id()
    FakeHDFC(monkeypatch, {"POST /session": FakeResponse(200, session_doc(oid)),
                           f"GET /orders/{oid}": FakeResponse(401, {})})
    with caplog.at_level(logging.DEBUG):
        p = make_provider()
        _create(p)
        with pytest.raises(P.PaymentMisconfigured):
            p.fetch_order(oid)
    encoded = base64.b64encode(API_KEY.encode()).decode()
    for secret in (API_KEY, encoded, WEBHOOK_PASS, RESPONSE_KEY):
        assert secret not in caplog.text


# ===========================================================================
# Status
# ===========================================================================
@pytest.mark.parametrize("hdfc, ours", [
    ("NEW", P.PENDING),
    ("PENDING_VBV", P.PROCESSING),
    ("AUTHORIZING", P.PROCESSING),
    ("STARTED", P.PROCESSING),
    ("CHARGED", P.CAPTURED),
    ("AUTHORIZED", P.AUTHORIZED),
    ("JUSPAY_DECLINED", P.FAILED),
    ("AUTHENTICATION_FAILED", P.FAILED),
    ("AUTHORIZATION_FAILED", P.FAILED),
    ("AUTO_REFUNDED", P.REFUNDED),
    ("VOIDED", P.CANCELLED),
    ("CAPTURE_FAILED", P.FAILED),
])
def test_status_mapping(monkeypatch, hdfc, ours):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid, status=hdfc))})
    remote = make_provider().fetch_order(oid)
    assert remote.status == ours
    assert remote.provider_status == hdfc.lower()


def test_success_status_reports_what_the_verifier_compares(monkeypatch):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid))})
    remote = make_provider().fetch_order(oid)
    assert remote.status == P.CAPTURED
    assert remote.provider_order_id == oid
    assert remote.provider_payment_id == oid         # the payment IS the order
    assert remote.amount_minor == 5600 and remote.currency == "INR"
    assert remote.method == "card"
    assert remote.paid_at is not None
    # Card data and contact details are stripped before anything is stored.
    assert remote.raw["card"] == "<redacted>"
    assert remote.raw["customer_email"] == "<redacted>"


def test_pending_order_has_no_payment_id_yet(monkeypatch):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid, status="NEW"))})
    remote = make_provider().fetch_order(oid)
    assert remote.status == P.PENDING and remote.provider_payment_id is None


def test_failure_carries_the_bank_reason(monkeypatch):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(
        oid, status="AUTHORIZATION_FAILED", bank_error_message="Insufficient funds"))})
    remote = make_provider().fetch_order(oid)
    assert remote.status == P.FAILED and remote.failure_reason == "Insufficient funds"


def test_unknown_provider_status_is_never_success(monkeypatch):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(
        oid, status="SOMETHING_NEW"))})
    remote = make_provider().fetch_order(oid)
    assert remote.status == P.PENDING
    assert remote.provider_status == "something_new"


def test_charged_but_fully_refunded_is_refunded(monkeypatch):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(
        oid, refunded=True, amount_refunded=56))})
    assert make_provider().fetch_order(oid).status == P.REFUNDED


def test_rupee_amount_is_parsed_without_float(monkeypatch):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(
        200, '{"order_id": "%s", "status": "CHARGED", "amount": 100.15, '
             '"currency": "INR", "txn_id": "t"}' % oid)})
    assert make_provider().fetch_order(oid).amount_minor == 10015


def test_lower_effective_amount_is_what_is_reported(monkeypatch):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(
        oid, amount=56, effective_amount=50))})
    assert make_provider().fetch_order(oid).amount_minor == 5000


@pytest.mark.parametrize("answer, exc_type", [
    (FakeResponse(500, {}), P.PaymentTimeout),
    (requests.Timeout("slow"), P.PaymentTimeout),
    (FakeResponse(200, "garbage"), P.PaymentFailed),
    (FakeResponse(401, {}), P.PaymentMisconfigured),
])
def test_status_api_errors(monkeypatch, answer, exc_type):
    oid = _order_id()
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": answer})
    with pytest.raises(exc_type):
        make_provider().fetch_order(oid)


@pytest.mark.parametrize("bad", ["../orders/x", "JP 1", "a" * 21, "", "JP;DROP"])
def test_order_id_is_validated_before_it_reaches_a_url(monkeypatch, bad):
    fake = FakeHDFC(monkeypatch)
    with pytest.raises(P.PaymentFailed):
        make_provider().fetch_order(bad)
    assert fake.calls == []


def test_fetch_payment_is_the_order_read(monkeypatch):
    oid = _order_id()
    fake = FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid))})
    assert make_provider().fetch_payment(oid).status == P.CAPTURED
    assert fake.count("GET", f"/orders/{oid}") == 1


def test_capture_is_not_silently_pretended():
    with pytest.raises(P.PaymentProviderError) as exc:
        make_provider().capture(provider_payment_id="JP1", amount_minor=100, currency="INR")
    assert exc.value.code == "capture_unsupported"


# ===========================================================================
# Refund
# ===========================================================================
def test_refund_uses_documented_form_fields_and_is_idempotent(monkeypatch):
    oid = _order_id()
    seen = []

    def answer(call):
        seen.append(call["data"])
        doc = order_doc(oid)
        doc["refunds"] = [{"unique_request_id": call["data"]["unique_request_id"],
                           "status": "PENDING", "amount": 56, "id": "rf1"}]
        return FakeResponse(200, doc)

    fake = FakeHDFC(monkeypatch, {f"POST /orders/{oid}/refunds": answer})
    p = make_provider()
    r1 = p.refund(provider_payment_id=oid, amount_minor=5600, idempotency_key="cancel-1")
    r2 = p.refund(provider_payment_id=oid, amount_minor=5600, idempotency_key="cancel-1")
    assert seen[0] == seen[1]                       # same unique_request_id both times
    assert seen[0]["amount"] == "56.00"
    assert len(seen[0]["unique_request_id"]) <= 20
    assert fake.calls[0]["headers"]["Content-Type"] == "application/x-www-form-urlencoded"
    assert r1.status == P.PROCESSING and r2.provider_refund_id == "rf1"


# ===========================================================================
# Webhook authentication
# ===========================================================================
def test_webhook_valid_credentials_parse(monkeypatch):
    oid = _order_id()
    event = make_provider().verify_webhook(
        webhook_body(oid), {"Authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)})
    assert event.event_id.startswith("evt_V2_")
    assert event.event_type == "ORDER_SUCCEEDED" and event.supported
    assert event.payment.status == P.CAPTURED
    assert event.payment.provider_order_id == oid
    assert event.raw["content"]["order"]["card"] == "<redacted>"


@pytest.mark.parametrize("header", [
    None,
    basic(WEBHOOK_USER, "wrong"),
    basic("someone", WEBHOOK_PASS),
    "Bearer " + WEBHOOK_PASS,
    "Basic not-base64!!",
])
def test_webhook_bad_credentials_are_refused(header):
    headers = {"Authorization": header} if header else {}
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_webhook(webhook_body(_order_id()), headers)


def test_webhook_without_event_id_is_refused():
    body = webhook_body(_order_id(), event_id="")
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_webhook(body, {"authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)})


def test_webhook_unreadable_body_is_refused():
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_webhook(b"{not json", {
            "Authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)})


@pytest.mark.parametrize("name", ["MANDATE_CREATED", "ORDER_CREATED",
                                  "REFUND_MANUAL_REVIEW_NEEDED", "SOMETHING_ELSE"])
def test_unsupported_events_are_parsed_but_flagged(name):
    event = make_provider().verify_webhook(
        webhook_body(_order_id(), event_name=name),
        {"Authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)})
    assert event.supported is False


# ===========================================================================
# Return URL signature
# ===========================================================================
def _php_style_signature(params, key):
    """An INDEPENDENT rendering of HDFC's PHP sample (urlencode, ksort, join,
    urlencode, base64 HMAC-SHA256), so the adapter is checked against a
    second reading of the docs rather than against itself."""
    enc = {quote_plus(k): quote_plus(v) for k, v in params.items()
           if k not in ("signature", "signature_algorithm")}
    serialized = "&".join(f"{k}={enc[k]}" for k in sorted(enc))
    return base64.b64encode(hmac.new(key.encode(), quote_plus(serialized).encode(),
                                     hashlib.sha256).digest()).decode()


def _signed(order_id, **extra):
    params = {"order_id": order_id, "status": "CHARGED", "status_id": "21", **extra}
    params["signature"] = _php_style_signature(params, RESPONSE_KEY)
    params["signature_algorithm"] = "HMAC-SHA256"
    return params


def test_valid_return_signature():
    oid = _order_id()
    assert make_provider().verify_return(_signed(oid)) == oid


def test_percent_encoded_signature_is_accepted():
    oid = _order_id()
    params = _signed(oid)
    params["signature"] = quote_plus(params["signature"])
    assert make_provider().verify_return(params) == oid


def test_invalid_return_signature():
    params = _signed(_order_id())
    params["signature"] = base64.b64encode(b"x" * 32).decode()
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_return(params)


def test_missing_return_signature():
    params = _signed(_order_id())
    params.pop("signature")
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_return(params)


def test_unknown_signature_algorithm():
    params = _signed(_order_id())
    params["signature_algorithm"] = "HMAC-MD5"
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_return(params)


def test_tampered_order_id():
    params = _signed(_order_id())
    params["order_id"] = HDFCSmartGatewayProvider.order_id_for("JPH001000", KEY)
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_return(params)


def test_tampered_status_or_amount_parameter():
    params = _signed(_order_id(), amount="56.00")
    params["amount"] = "1.00"
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_return(params)
    params = _signed(_order_id())
    params["status"] = "CHARGED" if params["status"] != "CHARGED" else "PENDING_VBV"
    with pytest.raises(P.WebhookVerificationError):
        make_provider().verify_return(params)


def test_unsigned_return_only_names_an_order_when_no_key_configured():
    p = make_provider(response_key=None)
    oid = _order_id()
    assert p.verify_return({"order_id": oid, "status": "CHARGED"}) == oid
    with pytest.raises(P.WebhookVerificationError):
        p.verify_return({"order_id": "../../etc"})
