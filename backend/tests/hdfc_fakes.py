"""A stand-in for HDFC SmartGateway's HTTP API, for the HDFC tests.

It replaces ``requests.request`` — the one call the adapter makes — so every
test exercises the adapter's real headers, body, error classification and
parsing. Nothing here opens a socket.

The response shapes are HDFC's own documented samples, trimmed to the fields
the adapter reads (Session API, Order Status API, Refund Order API).
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

import requests

from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider

BASE = "https://smartgateway.hdfcuat.bank.in"
MERCHANT = "JPTESTMID"
API_KEY = "uat-api-key-DO-NOT-LOG-1234567890"
WEBHOOK_USER = "jpwebhook"
WEBHOOK_PASS = "wh-pass-DO-NOT-LOG-987"
RESPONSE_KEY = "response-key-DO-NOT-LOG-555"
RETURN_URL = "https://tours.example.test/api/payments/hdfc/return"


def make_provider(**overrides) -> HDFCSmartGatewayProvider:
    kwargs = dict(
        base_url=BASE,
        merchant_id=MERCHANT,
        api_key=API_KEY,
        return_url=RETURN_URL,
        webhook_username=WEBHOOK_USER,
        webhook_password=WEBHOOK_PASS,
        response_key=RESPONSE_KEY,
        environment="test",
        timeout_seconds=5,
    )
    kwargs.update(overrides)
    return HDFCSmartGatewayProvider(**kwargs)


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


class FakeResponse:
    def __init__(self, status: int, body: Any):
        self.status_code = status
        if isinstance(body, (dict, list)):
            self.text = json.dumps(body, default=str)
        else:
            self.text = str(body)


def order_doc(order_id: str, *, status: str = "CHARGED", amount: Any = 56,
              currency: str = "INR", refunded: bool = False, **extra) -> dict:
    """An Order Status response, per HDFC's Card sample."""
    doc = {
        "customer_email": "traveller@example.test",
        "customer_phone": "9000000000",
        "customer_id": "JPC1001",
        "status_id": 21,
        "status": status,
        "id": "ordeh_57dfd768bb7d4896bc042y0b90bc9ad77",
        "merchant_id": MERCHANT,
        "amount": amount,
        "currency": currency,
        "order_id": order_id,
        "date_created": "2026-09-24T10:19:55Z",
        "payment_links": {
            "web": f"{BASE}/merchant/ipay/ordeh_57dfd768bb7d4896bc042y0b90bc9ad77",
        },
        "txn_id": f"{MERCHANT}-{order_id}-1" if status != "NEW" else "",
        "payment_method_type": "CARD" if status != "NEW" else "",
        "refunded": refunded,
        "amount_refunded": 0,
        "card": {"last_four_digits": "1097", "card_isin": "401200"},
        "txn_detail": {
            "txn_id": f"{MERCHANT}-{order_id}-1",
            "order_id": order_id,
            "status": status,
            "created": "2026-09-24T10:20:52Z",
            "error_message": "",
        },
        "payment_gateway_response": {"created": "2026-09-24T10:21:11Z", "rrn": "156555"},
        "bank_error_message": "",
    }
    doc.update(extra)
    return doc


def session_doc(order_id: str, *, amount: str = "56.00", link: str | None = None) -> dict:
    """A Session API response, per HDFC's sample."""
    return {
        "status": "NEW",
        "id": "ordeh_3b0bf151fb4944221ab0f",
        "order_id": order_id,
        "payment_links": {
            "web": link or f"{BASE}/orders/ordeh_3b0bf151fb49442085b2157e3121ab0f/payment-page",
            "expiry": "2026-09-24T11:22:02Z",
        },
        "sdk_payload": {
            "requestId": "67ad5d66fcdb4c208114ac1248836730",
            "service": "in.juspay.hyperpay",
            "payload": {
                "clientId": "hdfcmaster",
                "amount": amount,
                "merchantId": MERCHANT,
                "clientAuthToken": "tkn_SHOULD_NEVER_REACH_A_BROWSER",
                "currency": "INR",
                "orderId": order_id,
            },
        },
    }


class FakeHDFC:
    """Routes ``requests.request`` to canned answers and records every call.

    ``routes`` maps ``"METHOD /path"`` to a FakeResponse, an exception to raise,
    or a callable ``(call) -> FakeResponse``.
    """

    def __init__(self, monkeypatch, routes: dict | None = None):
        self.routes: dict[str, Any] = dict(routes or {})
        self.calls: list[dict] = []
        monkeypatch.setattr(requests, "request", self)

    def __call__(self, method, url, headers=None, json=None, data=None, timeout=None, **kw):
        assert url.startswith(BASE), url
        path = url[len(BASE):]
        call = {"method": method, "path": path, "headers": dict(headers or {}),
                "json": json, "data": data, "timeout": timeout}
        self.calls.append(call)
        answer = self.routes.get(f"{method} {path}")
        if answer is None:
            return FakeResponse(404, {"status": "error", "error_code": "not_found"})
        if isinstance(answer, BaseException):
            raise answer
        if callable(answer) and not isinstance(answer, FakeResponse):
            return answer(call)
        return answer

    def count(self, method: str, path: str) -> int:
        return sum(1 for c in self.calls if c["method"] == method and c["path"] == path)


def webhook_body(order_id: str, *, event_id: str = "evt_V2_b737837102414514ae0e9717a9f2664d",
                 event_name: str = "ORDER_SUCCEEDED", **order_kw) -> bytes:
    """A webhook delivery, per HDFC's 'Standard Structure of Webhook Payload'."""
    return json.dumps({
        "id": event_id,
        "event_name": event_name,
        "date_created": "2026-09-24T07:00:48Z",
        "content": {"order": order_doc(order_id, **order_kw)},
    }, default=str).encode("utf-8")


def D(value: str) -> Decimal:
    return Decimal(value)
