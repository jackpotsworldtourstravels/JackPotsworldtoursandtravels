"""HDFC SmartGateway — API integration, Basic Auth, hosted payment page.

EVERY ENDPOINT, FIELD AND HEADER BELOW IS FROM HDFC'S OWN DOCUMENTATION
SmartGateway API Reference (Basic Auth):
https://smartgateway.hdfc.bank.in/docs/smartgateway-api-ref-basicauth/docs/overview/integration-architecture

Read verbatim (the ``.md`` exports of each page) on 2026-09-24. Where the
documentation is silent or contradicts itself, the choice made is marked
``NOT VERIFIED`` at the line that makes it, so it can be settled with HDFC
rather than rediscovered.

THE THREE ENDPOINTS, AND NOTHING ELSE
    POST {base}/session                    create the order; returns payment_links.web
    GET  {base}/orders/{order_id}          Order Status — the authoritative read
    POST {base}/orders/{order_id}/refunds  refund a CHARGED order

``{base}`` is ``HDFC_SG_BASE_URL``. UAT is ``https://smartgateway.hdfcuat.bank.in``
per the docs. There is no default and no production URL in this file: pointing
this adapter at production is a deliberate configuration change.

AUTHENTICATION IS ONE API KEY, NOT A USERNAME AND PASSWORD
"The API key must be sent in the Authorization header as: Basic MTIzNA==",
where ``MTIzNA==`` is the base64 of the key ``1234`` — the key ALONE, with no
``user:password`` pair. Every call also carries ``x-merchantid``,
``x-customerid`` and ``x-resellerid``, which the docs list as required.

The API key is generated on the SmartGateway dashboard and "must be securely
kept ... The API key should never be exposed in client side of application."
It is used in exactly one place — :meth:`_headers` — and never logged, returned
or placed in an exception message.

HOW THE CUSTOMER PAYS: A FULL-PAGE REDIRECT
``/session`` returns ``payment_links.web``, "Https link using which user can
open the Hypercheckout screen". The browser is sent there. The docs say
"Iframe Integration is not supported", so the page is never embedded. The
``sdk_payload`` in the same response carries a ``clientAuthToken`` for HDFC's
mobile SDK; it is NOT forwarded to the browser, because nothing here uses the
SDK and a token is not something to hand out for no reason.

HOW WE FIND OUT WHAT HAPPENED: NEVER FROM THE BROWSER
After paying, HDFC redirects the customer to ``return_url`` with ``order_id``,
``status``, ``status_id`` and — if "Use signed response" is on — an HMAC
``signature``. The docs are explicit that this is not enough: "it is mandatory
to do a Server-to-Server Order Status API call to determine the final payment
status. Please ensure that you verify the order ID and amount". So
:meth:`verify_return` only decides WHICH order to ask about; the answer comes
from :meth:`fetch_order`, and the amount is compared against the booking by
the same verifier every other provider goes through.

Webhooks are separate: HDFC authenticates them with a dashboard-configured
username and password, sent as ``Authorization: Basic base64(user:pass)``. See
:meth:`verify_webhook`.

ONE HDFC ORDER PER (BOOKING, IDEMPOTENCY KEY) — BY CONSTRUCTION
HDFC's ``order_id`` is OURS to choose ("less than 21 characters", "should not
contain any special characters", "should be non-sequential"). It is derived
deterministically from the booking reference and the idempotency key, so a
retry after a timeout sends the SAME order id rather than opening a second
order. That is stronger than Razorpay's position (see ``razorpay_provider``),
where a retry inside the listing lag opens an orphan order.

THE PAYMENT IS THE ORDER
Order Status and Refund are both addressed by ``order_id``; HDFC documents no
per-attempt lookup. So ``provider_payment_id`` on our row is the HDFC order id
too, set once a transaction has been attempted. HDFC's per-attempt ``txn_id``
("will be present in reconciliation report") goes to the row's existing,
generic ``provider_reference`` column via ``ProviderPayment.provider_reference``.
"""
from __future__ import annotations

import base64
import binascii
import datetime as dt
import hashlib
import hmac
import json
import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping
from urllib.parse import quote_plus, unquote, urlsplit

from app.services.payments.base import (
    AUTHORIZED,
    CANCELLED,
    CAPTURED,
    FAILED,
    INR,
    PENDING,
    PROCESSING,
    REFUNDED,
    CheckoutSession,
    PaymentFailed,
    PaymentMisconfigured,
    PaymentProviderError,
    PaymentTimeout,
    ProviderEvent,
    ProviderPayment,
    ProviderRefund,
    WebhookVerificationError,
    from_minor,
    to_minor,
)

logger = logging.getLogger(__name__)

#: The UAT and production hosts, as the docs name them. NOT used to build a
#: request — the base URL always comes from configuration. They exist only so a
#: test deployment cannot be pointed at production (or a live one at UAT) by a
#: pasted URL, and so the documented UAT client id can be defaulted.
UAT_HOST = "smartgateway.hdfcuat.bank.in"
PRODUCTION_HOST = "smartgateway.hdfc.bank.in"

#: "For Sandbox use 'hdfcmaster' as your client_id and for Production use
#: merchant id as client id." — Session API, payment_page_client_id.
UAT_CLIENT_ID = "hdfcmaster"

#: "Reseller ID provided by bank — Value: hdfc_reseller". Configurable in case
#: the bank issues a different one.
DEFAULT_RESELLER_ID = "hdfc_reseller"

#: order_id: "less than 21 Characters", no special characters.
ORDER_ID_MAX = 20
#: Refund ``unique_request_id``: "should be less than 21 characters".
REFUND_ID_MAX = 20

#: "Signature algorithm used by HDFC SmartGateway is HMAC-SHA256." The only one
#: accepted; "Newer or more secure algorithms might be introduced in the future"
#: and an unknown one is refused rather than guessed at.
SIGNATURE_ALGORITHM = "HMAC-SHA256"

_ORDER_ID_RE = re.compile(r"^[A-Za-z0-9]{1,%d}$" % ORDER_ID_MAX)

#: HDFC ORDER statuses -> ours. Source: Resources -> Transaction Status, which
#: is the table for both the Order Status API and webhooks.
#:
#: Nothing maps to CAPTURED except CHARGED ("Successful transaction ...
#: fulfill the order"), and even that is only ever APPLIED by the verifier,
#: after it has compared the order id, amount and currency with the booking.
_STATUS_MAP = {
    "NEW": PENDING,                        # 10  order created, no transaction yet
    "PENDING_VBV": PROCESSING,             # 23  authentication in progress
    "AUTHORIZING": PROCESSING,             # 28  pending from bank
    "STARTED": PROCESSING,                 # 20  "integration error" per the docs; not terminal
    "CHARGED": CAPTURED,                   # 21  successful transaction
    "AUTHORIZED": AUTHORIZED,              # 25  pre-auth only; this integration auto-captures
    "JUSPAY_DECLINED": FAILED,             # 22
    "AUTHENTICATION_FAILED": FAILED,       # 26  customer did not complete authentication
    "AUTHORIZATION_FAILED": FAILED,        # 27  bank refused
    "AUTO_REFUNDED": REFUNDED,             # 36  money returned by the gateway
    "VOIDED": CANCELLED,                   # 31  pre-auth only
    "VOID_INITIATED": PROCESSING,          # 32  pre-auth only
    "VOID_FAILED": PROCESSING,             # 35  pre-auth only
    "CAPTURE_INITIATED": PROCESSING,       # 33  pre-auth only
    "CAPTURE_FAILED": FAILED,              # 34  pre-auth only
}

#: Webhook ``event_name`` values this adapter acts on. Taken from the "Webhook
#: Events and Sample Payloads" page (Order, Transaction and Autorefund
#: categories). What an event MEANS is read from ``content.order.status``,
#: which the same page says is "Complete order data as obtained from
#: /order/:order_id API" — so one mapping serves the webhook and the status
#: API, and the two cannot disagree.
#:
#: Deliberately absent, and therefore recorded and ignored: ORDER_CREATED
#: (nothing to verify), ORDER_REFUND_FAILED, AUTO_REFUND_FAILED and
#: REFUND_MANUAL_REVIEW_NEEDED (operator matters, never an automatic status
#: change), and every Mandate and Notification event (not used here).
_SUPPORTED_EVENTS = frozenset({
    "ORDER_SUCCEEDED",
    "ORDER_FAILED",
    "ORDER_AUTHORIZED",
    "ORDER_REFUNDED",
    "TXN_CREATED",
    "TXN_CHARGED",
    "TXN_FAILED",
    "AUTO_REFUND_SUCCEEDED",
})

#: Keys stripped from anything this adapter hands upward as ``raw``. The event
#: log stores a webhook body permanently and staff read it. HDFC already
#: FILTERs some of these in webhooks; the Order Status response does not.
_REDACT = frozenset({
    "card", "customer_email", "customer_phone", "payer_vpa", "upi",
    "merchant_payload", "payment_page_sdk_payload", "sdk_payload",
    "clientauthtoken", "mandate", "mandatetoken", "gateway_response",
})

#: HDFC refund statuses -> ours. "Values can be SUCCESS, FAILURE, PENDING,
#: MANUAL_REVIEW" — Order Status API, refunds block.
_REFUND_STATUS = {
    "SUCCESS": REFUNDED,
    "PENDING": PROCESSING,
    "MANUAL_REVIEW": PROCESSING,
    "FAILURE": FAILED,
}


def _redact(value: str | None) -> str:
    """What a secret looks like in a log line. Never the secret."""
    if not value:
        return "<unset>"
    return f"<set:{len(value)} chars>"


def _redacted(node: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "<truncated>"
    if isinstance(node, dict):
        return {
            k: ("<redacted>" if str(k).lower() in _REDACT else _redacted(v, depth + 1))
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [_redacted(v, depth + 1) for v in node[:50]]
    if isinstance(node, Decimal):
        # JSON-safe for the event log; the exact figure is re-read from HDFC
        # by the verifier, never from a stored payload.
        return str(node)
    return node


def _loads(text: str) -> Any:
    """JSON with every non-integer number as ``Decimal``, never ``float``.

    HDFC reports ``amount`` in RUPEES as a double ("Tags: Double"). A float
    rupee that has been through ``* 100`` is how a customer is charged a paisa
    less than agreed; see ``base.to_minor``.
    """
    return json.loads(text, parse_float=Decimal)


def _alnum(value: Any, limit: int) -> str:
    return "".join(c for c in str(value or "") if c.isalnum())[:limit]


def _name_part(value: str) -> str:
    """first_name/last_name allow "alphanumeric characters and ... ().-_"."""
    return "".join(c for c in value if c.isalnum() or c in "().-_")[:60]


class HDFCSmartGatewayProvider:
    """HDFC SmartGateway adapter. Synchronous, bounded by its own timeout."""

    name = "hdfc"

    def __init__(
        self,
        *,
        base_url: str | None,
        merchant_id: str | None,
        api_key: str | None,
        return_url: str | None,
        webhook_username: str | None,
        webhook_password: str | None,
        client_id: str | None = None,
        reseller_id: str | None = None,
        response_key: str | None = None,
        environment: str = "test",
        timeout_seconds: float = 20.0,
    ) -> None:
        # REFUSE AT CONSTRUCTION, NOT ON THE FIRST PAYMENT — same rule as the
        # Razorpay adapter. The webhook credentials are required because the
        # docs call configuring webhooks "mandatory", and an adapter that could
        # not authenticate them would reject every delivery.
        missing = [
            label for label, value in (
                ("HDFC_SG_BASE_URL", base_url),
                ("HDFC_SG_MERCHANT_ID", merchant_id),
                ("HDFC_SG_API_KEY", api_key),
                ("HDFC_SG_RETURN_URL", return_url),
                ("HDFC_SG_WEBHOOK_USERNAME", webhook_username),
                ("HDFC_SG_WEBHOOK_PASSWORD", webhook_password),
            ) if not (value or "").strip()
        ]
        if missing:
            raise PaymentMisconfigured(
                "PAYMENT_PROVIDER=hdfc needs " + ", ".join(missing) + ". The "
                "merchant id is issued by the bank; the API key is generated on "
                "the SmartGateway dashboard (Settings -> Security -> API Keys); "
                "the webhook username and password are the ones you set on the "
                "dashboard's Webhook tab."
            )

        base = base_url.strip().rstrip("/")            # type: ignore[union-attr]
        parts = urlsplit(base)
        if parts.scheme != "https" or not parts.hostname or parts.query:
            raise PaymentMisconfigured(
                "HDFC_SG_BASE_URL must be an https:// origin, e.g. "
                f"https://{UAT_HOST} for UAT."
            )
        host = parts.hostname.lower()
        env = (environment or "test").strip().lower()
        if env in ("test", "sandbox", "local") and host == PRODUCTION_HOST:
            raise PaymentMisconfigured(
                f"PAYMENT_ENVIRONMENT={env} but HDFC_SG_BASE_URL is HDFC's "
                "PRODUCTION host. Use the UAT host for testing, or set "
                "PAYMENT_ENVIRONMENT=live deliberately."
            )
        if env in ("live", "production") and host == UAT_HOST:
            raise PaymentMisconfigured(
                f"PAYMENT_ENVIRONMENT={env} but HDFC_SG_BASE_URL is the UAT "
                "host. UAT takes no real money; a live deployment must not "
                "silently collect nothing."
            )

        ret = return_url.strip()                       # type: ignore[union-attr]
        rparts = urlsplit(ret)
        # "URL shouldn't contain any query parameters or Ip address", "should
        # be a valid HTTPS endpoint" — Session API, return_url.
        if rparts.scheme != "https" or not rparts.hostname or rparts.query or rparts.fragment:
            raise PaymentMisconfigured(
                "HDFC_SG_RETURN_URL must be an https:// URL with no query string "
                "(HDFC's rule), e.g. https://your-domain/api/payments/hdfc/return."
            )
        if re.fullmatch(r"[0-9.]+|\[?[0-9a-fA-F:]+\]?", rparts.hostname or ""):
            raise PaymentMisconfigured(
                "HDFC_SG_RETURN_URL must use a domain name; HDFC does not allow "
                "an IP address."
            )

        self._base = base
        self._host = host
        self._merchant_id = merchant_id.strip()        # type: ignore[union-attr]
        self._api_key = api_key.strip()                # type: ignore[union-attr]
        self._return_url = ret
        self._webhook_username = webhook_username.strip()   # type: ignore[union-attr]
        self._webhook_password = webhook_password.strip()   # type: ignore[union-attr]
        self._response_key = (response_key or "").strip()
        self._reseller_id = (reseller_id or "").strip() or DEFAULT_RESELLER_ID
        self._client_id = (client_id or "").strip() or (
            UAT_CLIENT_ID if host == UAT_HOST else self._merchant_id
        )
        self._timeout = float(timeout_seconds or 20.0)

        logger.info(
            "HDFC SmartGateway adapter ready: base=%s merchant_id=%s client_id=%s "
            "api_key=%s webhook_auth=%s response_key=%s",
            self._base, self._merchant_id, self._client_id,
            _redact(self._api_key), _redact(self._webhook_password),
            _redact(self._response_key),
        )

    # -- the browser-safe identifier ---------------------------------------
    @property
    def publishable_key(self) -> str:
        """The MERCHANT ID. Public by HDFC's own design, never the API key.

        HDFC has no publishable key; the checkout is a redirect, not a script.
        The merchant id is what fills this slot because HDFC itself sends it to
        the frontend — it is inside ``sdk_payload``, which the Session API says
        "is supposed to be passed to your frontend application" — and because
        the checkout screens gate Pay Now on this field being non-empty.
        """
        return self._merchant_id

    # ------------------------------------------------------------------
    # Identifiers
    # ------------------------------------------------------------------
    @staticmethod
    def order_id_for(reference: str, idempotency_key: str) -> str:
        """The HDFC ``order_id`` for one (booking, idempotency key). Deterministic.

        "JP" + 18 hex characters of SHA-256 = 20 characters: under HDFC's
        21-character limit, alphanumeric, and non-sequential as required. The
        SAME inputs always give the SAME id, which is what makes a retry after
        a timeout land on the order it may already have opened.
        """
        key = (idempotency_key or "").strip()
        if not key:
            raise PaymentFailed("An idempotency key is required to open an order.")
        digest = hashlib.sha256(f"{(reference or '').strip().upper()}|{key}".encode("utf-8"))
        return "JP" + digest.hexdigest()[: ORDER_ID_MAX - 2]

    @staticmethod
    def _checked_order_id(order_id: str) -> str:
        """Refuse anything that is not an HDFC-shaped order id before it
        reaches a URL path."""
        value = (order_id or "").strip()
        if not _ORDER_ID_RE.match(value):
            raise PaymentFailed("Not a usable HDFC order id.", code="invalid_order_id")
        return value

    def _customer_ref(self, notes: Mapping[str, Any], customer: Mapping[str, Any]) -> str:
        """Our stable customer identifier, as HDFC's ``customer_id``."""
        cid = _alnum(notes.get("customer_id") or customer.get("id"), 40)
        if cid:
            return f"JPC{cid}"
        # No internal id was passed. A hash of the email is stable per customer
        # and carries no personal data in the clear.
        email = str(customer.get("email") or "").strip().lower()
        return "JPC" + hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------
    def _headers(self, customer_ref: str, content_type: str) -> dict[str, str]:
        # "Basic MTIzNA==" for the key 1234: base64 of the key alone.
        token = base64.b64encode(self._api_key.encode("utf-8")).decode("ascii")
        return {
            "Authorization": f"Basic {token}",
            "x-merchantid": self._merchant_id,
            # NOT VERIFIED — requires HDFC confirmation: the Order Status and
            # Refund APIs list x-customerid as mandatory but take no customer
            # in the request. Status reads do not know the customer, so the
            # merchant id is sent there (see _server_customer_ref).
            "x-customerid": customer_ref,
            "x-resellerid": self._reseller_id,
            "Content-Type": content_type,
            "Accept": "application/json",
        }

    @property
    def _server_customer_ref(self) -> str:
        return self._merchant_id

    def _request(
        self,
        method: str,
        path: str,
        *,
        customer_ref: str,
        json_body: Mapping[str, Any] | None = None,
        form: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        """One SmartGateway call. Bounded, and never leaks the API key.

        CLASSIFICATION, WHICH IS THE WHOLE POINT OF THIS METHOD
          * timeout, connection failure, 429, 5xx -> :class:`PaymentTimeout`.
            The outcome is UNKNOWN: the order may exist. Because ``order_id``
            is deterministic, the caller's retry cannot open a second one.
          * 401/403 -> :class:`PaymentMisconfigured`. A wrong key or merchant
            id; never retried and never softened into "try again".
          * 404 -> :class:`PaymentFailed` with code ``not_found``.
          * any other 4xx, or a 2xx that is not a JSON object ->
            :class:`PaymentFailed`. HDFC's own ``error_message`` is logged
            for an operator and never forwarded to a customer.
        """
        import requests  # local, matching the other adapters' convention

        url = f"{self._base}{path}"
        content_type = (
            "application/x-www-form-urlencoded" if form is not None else "application/json"
        )
        try:
            response = requests.request(
                method.upper(),
                url,
                headers=self._headers(customer_ref, content_type),
                json=dict(json_body) if json_body is not None else None,
                data=dict(form) if form is not None else None,
                timeout=self._timeout,
            )
        except requests.Timeout as exc:
            logger.warning("HDFC timed out: %s %s", method.upper(), path)
            raise PaymentTimeout(
                f"HDFC SmartGateway did not answer {method.upper()} {path} within "
                f"{self._timeout:g}s; the outcome is unknown."
            ) from exc
        except requests.RequestException as exc:
            # Unknown, not failed: the request may have left this host.
            logger.warning("HDFC unreachable: %s %s (%s)",
                           method.upper(), path, type(exc).__name__)
            raise PaymentTimeout(
                f"HDFC SmartGateway could not be reached for {method.upper()} "
                f"{path}; the outcome is unknown."
            ) from exc

        status = response.status_code
        try:
            parsed = _loads(response.text or "")
        except ValueError:
            parsed = None
        err = parsed if isinstance(parsed, dict) else {}
        detail = str(err.get("error_message") or err.get("error_code")
                     or err.get("status") or f"HTTP {status}")[:200]

        if status in (401, 403):
            logger.error(
                "HDFC refused our credentials on %s %s (HTTP %s). Check "
                "HDFC_SG_API_KEY and HDFC_SG_MERCHANT_ID.",
                method.upper(), path, status,
            )
            raise PaymentMisconfigured(
                "HDFC SmartGateway rejected this deployment's API key or merchant id."
            )
        if status == 404:
            raise PaymentFailed(f"HDFC has no such order ({detail}).", code="not_found")
        if status == 429 or status >= 500:
            logger.warning("HDFC transient failure on %s %s: HTTP %s",
                           method.upper(), path, status)
            raise PaymentTimeout(
                f"HDFC SmartGateway returned HTTP {status}; the outcome is unknown."
            )
        if status >= 400:
            logger.warning("HDFC refused %s %s: HTTP %s %s",
                           method.upper(), path, status, detail)
            raise PaymentFailed(
                f"HDFC SmartGateway refused the request (HTTP {status}): {detail}"
            )
        if not isinstance(parsed, dict):
            logger.warning("HDFC returned an unreadable body for %s %s (HTTP %s).",
                           method.upper(), path, status)
            raise PaymentFailed(
                f"HDFC SmartGateway returned an unreadable response for "
                f"{method.upper()} {path}.",
                code="malformed_response",
            )
        return parsed

    # ------------------------------------------------------------------
    # Contract: opening a checkout
    # ------------------------------------------------------------------
    def create_checkout(
        self,
        *,
        amount_minor: int,
        currency: str,
        reference: str,
        idempotency_key: str,
        customer: Mapping[str, Any] | None = None,
        notes: Mapping[str, Any] | None = None,
        may_exist: bool = False,
    ) -> CheckoutSession:
        """POST /session — open an HDFC order for an amount the CALLER computed.

        ``may_exist``: look the deterministic order id up FIRST, and reuse it if
        HDFC already has it. On a first attempt it is False and this is one call.
        """
        if (currency or "").upper() != INR:
            raise PaymentFailed(
                f"This integration collects {INR} only, not {currency!r}.",
                code="invalid_currency",
            )
        try:
            minor = int(amount_minor)
        except (TypeError, ValueError):
            raise PaymentFailed(f"Not a usable amount: {amount_minor!r}.",
                                code="invalid_amount") from None
        if minor <= 0 or minor != amount_minor:
            raise PaymentFailed("A payment must be for a positive whole number of paise.",
                                code="invalid_amount")

        notes = dict(notes or {})
        customer = dict(customer or {})
        order_id = self.order_id_for(reference, idempotency_key)
        customer_ref = self._customer_ref(notes, customer)

        if may_exist:
            existing = self._existing_order(order_id)
            if existing is not None:
                logger.info(
                    "HDFC order %s already exists for %s; reusing it rather than "
                    "opening another.", order_id, reference,
                )
                return self._session_from_order(existing, order_id)

        body: dict[str, Any] = {
            "order_id": order_id,
            # "stringified double ... with upto two decimal places". from_minor
            # quantises to exactly two, from integer paise, with no float.
            "amount": str(from_minor(minor, INR)),
            "currency": INR,
            "customer_id": customer_ref,
            "customer_email": str(customer.get("email") or "")[:120],
            "customer_phone": self._phone(customer.get("contact") or customer.get("phone")),
            "payment_page_client_id": self._client_id,
            "action": "paymentPage",
            "return_url": self._return_url,
            "description": f"Payment for booking {_alnum(reference, 20)}",
            # udf1-5: "No special characters supported". Shown on the
            # dashboard under each order, which is where support looks.
            "udf1": _alnum(reference, 40),
            "udf2": _alnum(notes.get("product_type") or "package", 20),
        }
        first, last = self._names(customer.get("name"))
        if first:
            body["first_name"] = first
        if last:
            body["last_name"] = last

        try:
            data = self._request("POST", "/session", customer_ref=customer_ref,
                                 json_body=body)
        except PaymentFailed as exc:
            # NOT VERIFIED — requires HDFC confirmation: what /session answers
            # for an order_id that already exists. If it refuses, the order is
            # fetched and reused; if the lookup finds nothing, the original
            # refusal stands. Either way no second order can exist, because
            # the id is the same.
            existing = self._existing_order(order_id)
            if existing is None:
                raise
            logger.info("HDFC refused to recreate %s (%s); reusing the existing order.",
                        order_id, exc)
            return self._session_from_order(existing, order_id)

        returned = str(data.get("order_id") or "").strip()
        if returned and returned != order_id:
            # Reference substitution: the order HDFC describes is not the one
            # we asked it to open. Nothing is shown to the customer.
            logger.error("HDFC /session answered for order %r; we asked for %r.",
                         returned, order_id)
            raise PaymentFailed("HDFC opened a different order than requested.",
                                code="order_mismatch")

        link = self._payment_link(data)
        echoed_minor, echoed_currency = self._echoed_amount(data)
        if echoed_minor is None:
            # The Session API documents no top-level amount; the SDK payload
            # usually carries one. Absent it, the figure is still checked
            # server-side at verification, against the booking.
            echoed_minor, echoed_currency = minor, INR

        logger.info("HDFC opened order %s for booking %s (status=%s).",
                    order_id, reference, data.get("status"))
        return CheckoutSession(
            order_id=order_id,
            amount_minor=echoed_minor,
            currency=echoed_currency,
            publishable_key=self.publishable_key,
            provider=self.name,
            redirect_url=link,
            options={"payment_link_expiry": self._link_expiry(data)},
        )

    def checkout_redirect(self, provider_order_id: str) -> str:
        """The hosted-page link for an order that already exists.

        For a customer who comes back to pay an order opened earlier: the link
        is re-read from Order Status (``payment_links.web``) rather than stored,
        so a returning customer is never sent to a URL the server did not just
        receive from HDFC.
        """
        order = self._request(
            "GET", f"/orders/{self._checked_order_id(provider_order_id)}",
            customer_ref=self._server_customer_ref,
        )
        return self._payment_link(order)

    def _existing_order(self, order_id: str) -> dict[str, Any] | None:
        """The order under this id, or None if HDFC says it does not exist.

        A timeout is RE-RAISED, not read as "absent": after one we do not know,
        and treating it as absent is how a second order would be created.
        """
        try:
            return self._request("GET", f"/orders/{self._checked_order_id(order_id)}",
                                 customer_ref=self._server_customer_ref)
        except PaymentFailed as exc:
            if exc.code == "not_found":
                return None
            # NOT VERIFIED — requires HDFC confirmation: the Order Status docs
            # list 400/401/500 but not 404 for an unknown order. A 400 here is
            # treated as "not found" only for the purpose of deciding to
            # create; creating is safe because the order id is deterministic.
            return None

    def _session_from_order(self, order: Mapping[str, Any], order_id: str) -> CheckoutSession:
        returned = str(order.get("order_id") or "").strip()
        if returned and returned != order_id:
            raise PaymentFailed("HDFC reported a different order than requested.",
                                code="order_mismatch")
        payment = self._payment_from(order)
        if payment.amount_minor is None:
            raise PaymentFailed("HDFC reported no usable amount for an existing order.",
                                code="malformed_response")
        return CheckoutSession(
            order_id=order_id,
            amount_minor=payment.amount_minor,
            currency=payment.currency or INR,
            publishable_key=self.publishable_key,
            provider=self.name,
            redirect_url=self._payment_link(order),
            options={},
        )

    def _payment_link(self, data: Mapping[str, Any]) -> str:
        """``payment_links.web``, and only if it points at HDFC over HTTPS.

        The browser is sent wherever this says. It came from HDFC over TLS, but
        checking that it stays on HDFC's own domain costs nothing and means no
        response — mis-parsed, proxied or otherwise — can turn Pay Now into a
        redirect somewhere else.
        """
        links = data.get("payment_links")
        link = str((links or {}).get("web") or "").strip() if isinstance(links, dict) else ""
        if not link:
            raise PaymentFailed("HDFC returned no payment link.", code="malformed_response")
        parts = urlsplit(link)
        host = (parts.hostname or "").lower()
        # The base host, or a sibling under the same parent domain
        # (smartgateway.hdfcuat.bank.in -> *.hdfcuat.bank.in).
        parent = self._host.split(".", 1)[1] if "." in self._host else self._host
        if parts.scheme != "https" or not (host == self._host or host.endswith("." + parent)):
            logger.error("HDFC payment link is not on %s over https: %s://%s",
                         self._host, parts.scheme, host)
            raise PaymentFailed("HDFC returned an unexpected payment link.",
                                code="unsafe_redirect")
        return link

    @staticmethod
    def _link_expiry(data: Mapping[str, Any]) -> str | None:
        links = data.get("payment_links")
        if isinstance(links, dict) and links.get("expiry"):
            return str(links.get("expiry"))
        return None

    @staticmethod
    def _echoed_amount(data: Mapping[str, Any]) -> tuple[int | None, str]:
        sdk = data.get("sdk_payload")
        payload = sdk.get("payload") if isinstance(sdk, dict) else None
        if not isinstance(payload, dict) or payload.get("amount") in (None, ""):
            return None, INR
        currency = str(payload.get("currency") or INR).upper()
        try:
            return to_minor(Decimal(str(payload.get("amount"))), currency), currency
        except PaymentProviderError:
            raise PaymentFailed("HDFC echoed an unusable amount.",
                                code="malformed_response") from None

    @staticmethod
    def _phone(value: Any) -> str:
        """"We recommend passing a 10-digit number without including the '+91'"."""
        digits = "".join(c for c in str(value or "") if c.isdigit())
        if len(digits) == 12 and digits.startswith("91"):
            digits = digits[2:]
        elif len(digits) == 11 and digits.startswith("0"):
            digits = digits[1:]
        return digits[:15]

    @staticmethod
    def _names(full_name: Any) -> tuple[str, str]:
        parts = [p for p in str(full_name or "").split() if p]
        if not parts:
            return "", ""
        first = _name_part(parts[0])
        last = _name_part(parts[-1]) if len(parts) > 1 else ""
        return first, last

    # ------------------------------------------------------------------
    # Contract: asking what happened
    # ------------------------------------------------------------------
    def fetch_order(self, provider_order_id: str) -> ProviderPayment:
        """GET /orders/{order_id} — Order Status, the authoritative read.

        "Since this is an authenticated call, done from the server side,
        signature verification is not required." This is what the verifier
        compares against the booking, for the return URL, the webhook, the
        reconcile endpoint and the deferred sweep alike.
        """
        order = self._request(
            "GET", f"/orders/{self._checked_order_id(provider_order_id)}",
            customer_ref=self._server_customer_ref,
        )
        return self._payment_from(order)

    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment:
        """The same read as :meth:`fetch_order` — the payment IS the order here.

        HDFC documents no per-transaction lookup, and this adapter stores the
        order id as the payment id (see the module docstring), so there is no
        other identifier this could be asked about.
        """
        return self.fetch_order(provider_payment_id)

    def _payment_from(self, order: Mapping[str, Any]) -> ProviderPayment:
        """One HDFC order object, normalised. Used by BOTH the webhook and the
        status API, so a status cannot be read two ways."""
        raw_status = str(order.get("status") or "").strip().upper()
        status = _STATUS_MAP.get(raw_status)
        if status is None:
            # AN UNKNOWN STATUS IS NEVER A SUCCESS. Pending keeps the verifier
            # asking; the raw word is kept for an operator.
            logger.warning("HDFC reported an unmapped order status %r for %s.",
                           raw_status, order.get("order_id"))
            status = PENDING
        if status == CAPTURED and order.get("refunded") is True:
            # "true if the order has been completely refunded" — money that
            # arrived and went back is not a capture.
            status = REFUNDED

        currency = str(order.get("currency") or INR).strip().upper() or INR
        amount_minor = self._minor(order.get("amount"), currency)
        effective = self._minor(order.get("effective_amount"), currency)
        if effective is not None and amount_minor is not None and effective != amount_minor:
            # NOT VERIFIED — requires HDFC confirmation: effective_amount is not
            # in the Order Status field list, but appears in every sample. If it
            # ever differs from the order amount (an offer, a discount), the
            # lower figure is what the customer paid — and it will not match
            # the booking, so the verifier refuses and a human looks.
            amount_minor = effective

        txn = order.get("txn_detail") if isinstance(order.get("txn_detail"), dict) else {}
        pg = (order.get("payment_gateway_response")
              if isinstance(order.get("payment_gateway_response"), dict) else {})
        order_id = str(order.get("order_id") or "").strip() or None
        # NEW is "the status if transaction is not triggered for an order";
        # anything past it means a payment was attempted.
        attempted = raw_status not in ("", "NEW")

        failure = None
        if status == FAILED:
            failure = (order.get("bank_error_message") or txn.get("error_message")
                       or order.get("bank_error_code") or txn.get("error_code") or raw_status)
            failure = str(failure)[:255] if failure else None

        paid_at = None
        if status == CAPTURED:
            paid_at = _parse_time(pg.get("created")) or _parse_time(txn.get("created"))

        method = str(order.get("payment_method_type") or "").strip().lower() or None
        return ProviderPayment(
            status=status,
            provider_status=raw_status.lower()[:60],
            provider_payment_id=order_id if attempted else None,
            provider_order_id=order_id,
            amount_minor=amount_minor,
            currency=currency,
            method=method,
            failure_reason=failure,
            paid_at=paid_at,
            raw=_redacted(dict(order)),
            # "Transaction ID for the payment attempt ... will be present in
            # reconciliation report." The attempt that decided the order.
            provider_reference=(str(order.get("txn_id") or txn.get("txn_id") or "").strip()
                                or None) if attempted else None,
        )

    @staticmethod
    def _minor(value: Any, currency: str) -> int | None:
        if value is None or value == "":
            return None
        try:
            return to_minor(Decimal(str(value)), currency)
        except (PaymentProviderError, InvalidOperation, ValueError):
            return None

    # ------------------------------------------------------------------
    # Contract: capture — not part of this integration
    # ------------------------------------------------------------------
    def capture(
        self, *, provider_payment_id: str, amount_minor: int, currency: str
    ) -> ProviderPayment:
        """Not used. This integration never asks for pre-auth.

        Pre-auth needs ``metadata.txns.auto_capture: "false"`` on the session,
        which is never sent, so a CHARGED order is already captured. An order
        reported AUTHORIZED would be unexpected; raising leaves the verifier's
        answer RETRYABLE (``capture_refused``) and visible, rather than
        pretending to capture through an API this adapter does not call.
        """
        raise PaymentProviderError(
            "HDFC orders are auto-captured in this integration; an AUTHORIZED "
            "order needs an operator (SmartGateway Capture API is not wired).",
            code="capture_unsupported",
        )

    # ------------------------------------------------------------------
    # Contract: refunds
    # ------------------------------------------------------------------
    def refund(
        self,
        *,
        provider_payment_id: str,
        amount_minor: int,
        idempotency_key: str,
        notes: Mapping[str, Any] | None = None,
    ) -> ProviderRefund:
        """POST /orders/{order_id}/refunds — "Refunds can be initiated only for
        transactions that are CHARGED."

        ``unique_request_id`` IS THE IDEMPOTENCY KEY: "You cannot reuse the
        value for two different refund requests. This is to avoid processing
        duplicate refund requests." Derived deterministically from the caller's
        key, so a retried refund cannot pay the customer back twice.

        Sent form-encoded, as in the documented request (``--data-urlencode``).
        """
        if int(amount_minor) <= 0:
            raise PaymentFailed("A refund must be for a positive amount.")
        order_id = self._checked_order_id(provider_payment_id)
        key = (idempotency_key or "").strip()
        if not key:
            raise PaymentFailed("An idempotency key is required to refund.")
        request_id = "RF" + hashlib.sha256(key.encode("utf-8")).hexdigest()[: REFUND_ID_MAX - 2]

        order = self._request(
            "POST", f"/orders/{order_id}/refunds",
            customer_ref=self._server_customer_ref,
            form={
                "unique_request_id": request_id,
                "amount": str(from_minor(int(amount_minor), INR)),
            },
        )
        refunds = order.get("refunds") if isinstance(order.get("refunds"), list) else []
        mine = next((r for r in refunds if isinstance(r, dict)
                     and str(r.get("unique_request_id") or "") == request_id), None)
        if mine is None:
            raise PaymentFailed("HDFC accepted the refund but did not report it.",
                                code="malformed_response")
        vendor = str(mine.get("status") or "").upper()
        return ProviderRefund(
            provider_refund_id=str(mine.get("id") or mine.get("ref") or request_id),
            status=_REFUND_STATUS.get(vendor, PROCESSING),
            provider_status=vendor.lower(),
            amount_minor=self._minor(mine.get("amount"), INR) or int(amount_minor),
            currency=INR,
            raw=_redacted(dict(mine)),
        )

    # ------------------------------------------------------------------
    # Contract: the webhook
    # ------------------------------------------------------------------
    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        """Authenticate the delivery, THEN parse.

        HDFC's scheme (Handling Payment Response -> Webhooks): the dashboard
        username and password arrive as ``Authorization: Basic
        base64(username:password)``; "Accept the webhook only if Username and
        Password matches with the one configured in Dashboard."

        NOT AN HMAC OVER THE BODY. HDFC documents none for webhooks, so a
        delivery proves who sent it but not that the body is unaltered in
        transit beyond what TLS gives. That is acceptable here for the same
        reason it is for every provider: the webhook never decides anything
        about money. A money-moving event is handed to the verifier, which
        re-reads the order from HDFC over an authenticated call.
        """
        lowered = {str(k).lower(): v for k, v in dict(headers or {}).items()}
        supplied = str(lowered.get("authorization") or "").strip()
        if not supplied.lower().startswith("basic "):
            raise WebhookVerificationError(
                "HDFC webhook carries no Basic Authorization header."
            )
        try:
            decoded = base64.b64decode(supplied[6:].strip(), validate=True).decode("utf-8")
        except (binascii.Error, ValueError, UnicodeDecodeError):
            raise WebhookVerificationError("HDFC webhook Authorization is not valid base64.")

        expected = f"{self._webhook_username}:{self._webhook_password}"
        # The whole pair in one constant-time comparison: comparing the two
        # halves separately would say which half was wrong.
        if not hmac.compare_digest(decoded.encode("utf-8"), expected.encode("utf-8")):
            logger.warning("HDFC webhook credentials did not match.")
            raise WebhookVerificationError("HDFC webhook credentials did not match.")

        # ---- authenticated; only now is the body read -------------------
        try:
            body = _loads((raw_body or b"").decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise WebhookVerificationError("HDFC webhook body is not readable JSON.") from exc
        if not isinstance(body, dict):
            raise WebhookVerificationError("HDFC webhook body is not a JSON object.")

        event_id = str(body.get("id") or "").strip()
        if not event_id:
            # REQUIRED, NEVER INVENTED — the redelivery guarantee depends on it.
            raise WebhookVerificationError(
                "HDFC webhook carries no event id; it cannot be de-duplicated."
            )

        event_type = str(body.get("event_name") or "").strip().upper() or "unknown"
        content = body.get("content") if isinstance(body.get("content"), dict) else {}
        order = content.get("order") if isinstance(content.get("order"), dict) else None
        payment = self._payment_from(order) if order is not None else None

        return ProviderEvent(
            event_id=event_id[:120],
            event_type=event_type[:80],
            payment=payment,
            supported=event_type in _SUPPORTED_EVENTS,
            raw=_redacted(body),
        )

    # ------------------------------------------------------------------
    # The return URL
    # ------------------------------------------------------------------
    @staticmethod
    def return_signature(params: Mapping[str, str], key: str) -> str:
        """HMAC-SHA256 of the return parameters, base64 — HDFC's algorithm.

        From "HMAC Signature verification for return URL": every parameter
        except ``signature`` and ``signature_algorithm``; percent-encode each
        key and value; sort by encoded key; join as ``k=v`` with ``&``;
        percent-encode the whole string; HMAC it with the Response Key. The
        documented Python sample uses ``quote_plus`` at both steps, as here.
        """
        pairs = sorted(
            (quote_plus(str(k)), quote_plus(str(v)))
            for k, v in params.items()
            if k not in ("signature", "signature_algorithm")
        )
        message = quote_plus("&".join(f"{k}={v}" for k, v in pairs))
        digest = hmac.new(key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest()
        return base64.b64encode(digest).decode("ascii")

    def verify_return(self, params: Mapping[str, str]) -> str:
        """Which order the customer came back from. NOT whether it was paid.

        With a Response Key configured (``HDFC_SG_RESPONSE_KEY``, and "Use
        signed response" on in the dashboard), the signature is REQUIRED and
        checked; a missing or wrong one raises :class:`WebhookVerificationError`
        and the order id is not believed. Without one, the order id is
        unauthenticated — which is harmless, because all it does is choose an
        order to re-read from HDFC server-side, and that read is what decides.
        """
        order_id = str(params.get("order_id") or "").strip()
        if not _ORDER_ID_RE.match(order_id):
            raise WebhookVerificationError("HDFC return carries no usable order_id.")

        if not self._response_key:
            logger.info("HDFC return for %s is unsigned (no HDFC_SG_RESPONSE_KEY); "
                        "the order will be verified server-side.", order_id)
            return order_id

        supplied = str(params.get("signature") or "")
        algorithm = str(params.get("signature_algorithm") or "").strip().upper()
        if not supplied:
            raise WebhookVerificationError("HDFC return is missing its signature.")
        if algorithm != SIGNATURE_ALGORITHM:
            raise WebhookVerificationError(
                f"HDFC return uses an unsupported signature algorithm {algorithm!r}."
            )

        expected = self.return_signature(params, self._response_key)
        # "the signature should percentage decoded once before comparing". The
        # framework has already decoded the query string once, and HDFC's
        # samples disagree about whether the value is then plain base64 or
        # percent-encoded base64, so both encodings of the SAME digest are
        # accepted. A '+' turned into a space by form decoding is restored.
        candidates = {supplied, unquote(supplied), supplied.replace(" ", "+")}
        if not any(hmac.compare_digest(c.encode("utf-8"), expected.encode("utf-8"))
                   for c in candidates):
            logger.warning("HDFC return signature did not match for order %s.", order_id)
            raise WebhookVerificationError("HDFC return signature did not match.")
        return order_id


def _parse_time(value: Any) -> dt.datetime | None:
    """HDFC's ISO-8601 with a trailing Z, or None."""
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(text)
    except ValueError:
        return None
