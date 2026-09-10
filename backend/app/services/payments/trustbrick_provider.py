"""TrustBrick Partner API — collecting through TrustBrick's Razorpay merchant account.

WHY THIS ADAPTER EXISTS
TrustBrick holds the Razorpay MID. Jackpotsworld does not and cannot, so a
booking here is paid for by asking TrustBrick to open an order on its account.
This adapter is the whole of that arrangement: everything above it — the Pay Now
endpoint, the checkout screen, the webhook route, the verifier — is unchanged
and does not know TrustBrick exists.

WHAT IS DIFFERENT FROM ``razorpay_provider``
That adapter talks to Razorpay. This one talks to TrustBrick, which talks to
Razorpay. Three consequences shape everything below:

1.  WE HOLD NO RAZORPAY CREDENTIAL. Not the key secret, not the webhook secret.
    The publishable key arrives in TrustBrick's create response because the
    browser's Razorpay widget needs it; nothing else does.

2.  THE ORDER ID IS STILL RAZORPAY'S. ``CheckoutSession.order_id`` must be the
    Razorpay order id, because ``payment-screen.js`` hands it straight to
    ``new Razorpay({order_id})``. TrustBrick's own ``payment_reference`` rides
    along in ``options`` for operators and for support, and is never needed to
    open a checkout.

3.  THE WEBHOOK IS NOT RAZORPAY'S. Razorpay signs its deliveries to TrustBrick.
    TrustBrick verifies those against the Razorpay API and then signs its OWN
    callback to us, with its own secret and its own event id. So
    :meth:`verify_webhook` below verifies a TrustBrick signature, not a Razorpay
    one, and the ``X-TB-Event-Id`` header is what makes a redelivery collide in
    ``payment_provider_events``.

IDEMPOTENCY IS THE SERVER'S, AND IT IS REAL
Razorpay has no idempotency header and its ``receipt`` is not one, which is why
``razorpay_provider`` has to look an order up before creating one. TrustBrick
does: ``idempotency_key`` is a unique index on ``(partner_key_id,
idempotency_key)``, and a repeated create returns the order already opened with
``created: false``. So ``may_exist`` needs no special handling here — the
retry-safe path is the only path.

VERIFICATION IS STILL OURS TO DO
TrustBrick verifies against Razorpay before it will say ``CAPTURED``. That does
not excuse us from checking: ``payment_verification_service`` compares the
amount and currency this adapter reports against the booking row, exactly as it
does for direct Razorpay. Two independent checks of the same fact is the point —
a bug or a compromise on one side does not confirm a booking on the other.

NOTHING SECRET IS EVER LOGGED
Not the shared secret, not the callback secret, not a signature, not a nonce,
not a request body. Log lines carry the key id, the booking reference, the HTTP
status and TrustBrick's own outcome code — enough to diagnose, nothing that
would let a reader forge a request.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import logging
import secrets
import time
from typing import Any, Mapping

import requests

from app.services.payments.base import (
    AUTHORIZED,
    CANCELLED,
    CAPTURED,
    EXPIRED,
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
)

logger = logging.getLogger(__name__)

#: Signature scheme version. Part of the signed string on both sides, so a
#: future scheme cannot be made to look like this one.
SIGNATURE_VERSION = "v1"

HEADER_KEY_ID = "X-TB-Key-Id"
HEADER_TIMESTAMP = "X-TB-Timestamp"
HEADER_NONCE = "X-TB-Nonce"
HEADER_SIGNATURE = "X-TB-Signature"
HEADER_EVENT_ID = "X-TB-Event-Id"

#: How far a TrustBrick callback's timestamp may be from our clock. The same
#: 300s TrustBrick applies to our requests, for the same reason: wide enough to
#: absorb NTP drift between two hosts, narrow enough that a captured delivery
#: stops being replayable quickly.
TIMESTAMP_TOLERANCE_SECONDS = 300

#: The path TrustBrick signs when it calls us. It signs METHOD and TARGET, and
#: this adapter cannot see the path it was reached on — ``verify_webhook``
#: receives only the body and the headers — so the value has to be agreed. It
#: MUST equal the path in TrustBrick's PARTNER_<SLUG>_CALLBACK_URL.
CALLBACK_PATH = "/api/webhooks/payments/trustbrick"

#: TrustBrick's payment states -> ours. TrustBrick reuses its own commerce
#: vocabulary (``PaymentStatus``), which is not our vocabulary, and this is the
#: only place the two meet.
_STATUS_MAP = {
    "INITIATED": PENDING,
    "AUTHORISED": AUTHORIZED,
    "AUTHORIZED": AUTHORIZED,
    "CAPTURED": CAPTURED,
    "FAILED": FAILED,
    "REFUNDED": REFUNDED,
    "CANCELLED": CANCELLED,
    "EXPIRED": EXPIRED,
    "PROCESSING": PROCESSING,
}

#: Callback event types this adapter understands. Anything else is parsed and
#: reported as ``supported=False`` so the event service records it and does not
#: route it into the capture path — see ``ProviderEvent.supported``.
_SUPPORTED_EVENTS = frozenset({
    "payment.captured", "payment.failed", "payment.refunded",
})

#: Product type sent to TrustBrick. Phase A is packages only; the caller may
#: override through ``notes`` when flights and hotels are wired.
DEFAULT_PRODUCT_TYPE = "package"
_PRODUCT_TYPES = frozenset({"flight", "hotel", "cruise", "package"})


class TrustBrickProvider:
    """Adapter for TrustBrick's partner payment API. Synchronous, bounded."""

    name = "trustbrick"

    def __init__(
        self,
        *,
        base_url: str,
        key_id: str,
        secret: str,
        callback_secret: str,
        timeout_seconds: float = 20.0,
        publishable_key: str = "",
        callback_path: str = CALLBACK_PATH,
    ) -> None:
        missing = [
            label for label, value in (
                ("TRUSTBRICK_BASE_URL", base_url),
                ("TRUSTBRICK_KEY_ID", key_id),
                ("TRUSTBRICK_SECRET", secret),
                ("TRUSTBRICK_CALLBACK_SECRET", callback_secret),
            ) if not (value or "").strip()
        ]
        if missing:
            raise PaymentMisconfigured(
                "PAYMENT_PROVIDER=trustbrick needs " + ", ".join(missing) + ". "
                "The base URL is TrustBrick's origin; the key id and secret are "
                "issued by TrustBrick for this partner; the callback secret is "
                "the one set on TrustBrick's PARTNER_<SLUG>_CALLBACK_SECRET."
            )

        self._base_url = base_url.rstrip("/")
        self._key_id = key_id.strip()
        self._secret = secret.strip()
        self._callback_secret = callback_secret.strip()
        self._timeout = float(timeout_seconds or 20.0)
        self._callback_path = callback_path or CALLBACK_PATH
        #: Razorpay's publishable key, learned from TrustBrick's create
        #: response and remembered so a rebuilt session (a customer who
        #: reloaded) still has one. The configured value is the deterministic
        #: fallback for a process that has not opened a checkout yet.
        self._publishable_key = (publishable_key or "").strip()

        logger.info(
            "TrustBrick adapter ready: base_url=%s key_id=%s callback_path=%s",
            self._base_url, self._key_id, self._callback_path,
        )

    # -- the browser-safe key ---------------------------------------------
    @property
    def publishable_key(self) -> str:
        """Razorpay's publishable key, as TrustBrick reports it. Never a secret."""
        return self._publishable_key

    # ------------------------------------------------------------------
    # Signing
    # ------------------------------------------------------------------
    @staticmethod
    def canonical_string(method: str, target: str, timestamp: str, nonce: str,
                         body: bytes) -> str:
        """The exact string both sides sign.

        Every line is load-bearing. METHOD and TARGET stop a signature being
        lifted onto another endpoint; the timestamp bounds how long a captured
        request is useful; the nonce makes each one single-use inside that
        window; the body is hashed rather than embedded so the string stays a
        fixed size.
        """
        return "\n".join([
            SIGNATURE_VERSION,
            (method or "").upper(),
            target or "/",
            str(timestamp),
            nonce or "",
            hashlib.sha256(body or b"").hexdigest(),
        ])

    @classmethod
    def compute_signature(cls, secret: str, method: str, target: str,
                          timestamp: str, nonce: str, body: bytes) -> str:
        message = cls.canonical_string(method, target, timestamp, nonce, body)
        return hmac.new(
            secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _headers(self, method: str, target: str, body: bytes) -> dict[str, str]:
        """Signed headers for one outbound request. A FRESH NONCE EVERY TIME.

        Reusing a nonce inside the tolerance window would be refused by
        TrustBrick as a replay, which is the correct behaviour and would look
        like an intermittent authentication failure. There is deliberately no
        code path here that can reuse one.
        """
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        return {
            HEADER_KEY_ID: self._key_id,
            HEADER_TIMESTAMP: timestamp,
            HEADER_NONCE: nonce,
            HEADER_SIGNATURE: self.compute_signature(
                self._secret, method, target, timestamp, nonce, body
            ),
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------
    def _call(self, method: str, path: str, payload: dict | None = None) -> dict:
        """One TrustBrick call. Signed, bounded, and never leaks a secret.

        A timeout raises :class:`PaymentTimeout` rather than
        :class:`PaymentFailed`, because after one we do not know whether the
        order exists — and the caller must retry with the SAME idempotency key
        rather than opening a second.
        """
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        target = path if path.startswith("/") else f"/{path}"
        url = f"{self._base_url}{target}"

        try:
            response = requests.request(
                method.upper(), url,
                data=body if payload is not None else None,
                headers=self._headers(method, target, body),
                timeout=self._timeout,
            )
        except requests.Timeout as exc:
            logger.warning("TrustBrick timed out: %s %s", method.upper(), target)
            raise PaymentTimeout(
                f"TrustBrick did not answer {method.upper()} {target} in "
                f"{self._timeout}s."
            ) from exc
        except requests.RequestException as exc:
            # RETRYABLE, NOT FAILED. A connection reset, a truncated response or
            # a DNS blip can all happen AFTER the request left this host, so
            # TrustBrick may already have opened the order. "We do not know"
            # must never be recorded as "it failed" — that is the same rule the
            # 5xx branch below follows, and the reason PaymentTimeout is a
            # separate exception from PaymentFailed at all.
            #
            # Retrying is safe: TrustBrick's idempotency is a unique index on
            # (partner_key_id, idempotency_key), so the same key returns the
            # order already opened rather than creating a second.
            logger.warning("TrustBrick unreachable: %s %s (%s)",
                           method.upper(), target, type(exc).__name__)
            raise PaymentTimeout(
                f"TrustBrick could not be reached for {method.upper()} {target}; "
                "the outcome is unknown."
            ) from exc

        status = response.status_code
        try:
            parsed = response.json()
        except ValueError:
            parsed = {}

        if status in (401, 403):
            # Never retried and never softened: this is a configuration or a
            # clock problem, and pretending it is transient would hide it.
            logger.error(
                "TrustBrick refused our credentials on %s %s (HTTP %s). Check "
                "TRUSTBRICK_KEY_ID/SECRET and this host's clock.",
                method.upper(), target, status,
            )
            raise PaymentMisconfigured(
                "TrustBrick rejected this deployment's partner credentials."
            )
        if status == 404:
            raise PaymentFailed("TrustBrick has no such payment.", code="not_found")
        if status == 429:
            # RATE LIMITED, WHICH IS TRANSIENT BY DEFINITION. TrustBrick's
            # partner API is capped (PARTNER_RATE_LIMIT), and a reconcile poll
            # arriving alongside a callback and a retry can reach it. Recording
            # that as a failed payment would turn a busy minute into a customer
            # who paid and was never confirmed.
            #
            # Deliberately checked BEFORE the generic 4xx branch: 429 is the one
            # client error that says "ask again", not "you asked wrongly".
            logger.warning("TrustBrick rate-limited %s %s (HTTP 429)",
                           method.upper(), target)
            raise PaymentTimeout(
                "TrustBrick is rate-limiting this deployment; the outcome is "
                "unknown and the request should be retried."
            )
        if status >= 500:
            logger.warning("TrustBrick server error on %s %s: HTTP %s",
                           method.upper(), target, status)
            raise PaymentTimeout(
                f"TrustBrick returned HTTP {status}; the outcome is unknown."
            )
        if status >= 400 or not parsed.get("ok", False):
            # TrustBrick's own words are logged for an operator and never
            # forwarded to a customer: they are written for developers.
            detail = str(parsed.get("error") or f"HTTP {status}")
            logger.warning("TrustBrick refused %s %s: %s",
                           method.upper(), target, detail)
            raise PaymentFailed(f"TrustBrick refused the request: {detail}")

        data = parsed.get("data")
        return data if isinstance(data, dict) else {}

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
        """Ask TrustBrick to open a Razorpay order for an amount WE computed.

        ``may_exist`` is accepted and ignored, deliberately. It exists for
        providers whose idempotency is not real; TrustBrick's is a unique index,
        so a repeated create returns the order already opened rather than a
        second one. There is nothing for this adapter to look up first.
        """
        if (currency or "").upper() != INR:
            raise PaymentMisconfigured(
                f"TrustBrick collects {INR} only; asked for {currency!r}."
            )

        notes = dict(notes or {})
        product_type = str(notes.get("product_type") or DEFAULT_PRODUCT_TYPE).lower()
        if product_type not in _PRODUCT_TYPES:
            raise PaymentMisconfigured(
                f"product_type {product_type!r} is not one TrustBrick accepts."
            )

        customer = dict(customer or {})
        payload = {
            "idempotency_key": idempotency_key,
            "booking_ref": reference,
            "product_type": product_type,
            # INTEGER PAISE, computed by the caller from the booking row. There
            # is no path by which a request could supply this.
            "amount_paise": int(amount_minor),
            "currency": INR,
            "customer": {
                "name": customer.get("name") or "",
                "email": customer.get("email") or "",
                # TrustBrick calls it "phone"; our callers say "contact".
                "phone": customer.get("contact") or customer.get("phone") or "",
            },
        }

        data = self._call("POST", "/api/partner/v1/payments", payload)

        order_id = str(data.get("provider_order_id") or "")
        if not order_id:
            raise PaymentFailed(
                "TrustBrick opened a payment but reported no provider order id."
            )

        key_id = str(data.get("key_id") or "")
        if key_id:
            # Remembered so a rebuilt session for a returning customer still
            # has a key. Publishable by definition — this is the value Razorpay
            # expects in the browser.
            self._publishable_key = key_id

        payment_reference = str(data.get("payment_reference") or "")
        logger.info(
            "TrustBrick opened %s for booking %s (order %s, created=%s)",
            payment_reference, reference, order_id, data.get("created"),
        )

        return CheckoutSession(
            order_id=order_id,
            amount_minor=int(data.get("amount_paise") or 0),
            currency=str(data.get("currency") or INR).upper(),
            publishable_key=self._publishable_key,
            provider=self.name,
            redirect_url=None,
            options={
                # For operators and support. Not needed to open a checkout, and
                # not a secret — it is an opaque handle to a row TrustBrick
                # will only disclose to this partner.
                "trustbrick_payment_reference": payment_reference,
            },
        )

    # ------------------------------------------------------------------
    # Contract: asking what happened
    # ------------------------------------------------------------------
    def _payment_from(self, data: Mapping[str, Any]) -> ProviderPayment:
        """Map one TrustBrick payment document onto our vocabulary."""
        raw_status = str(data.get("status") or "").upper()
        paid_at = _parse_time(data.get("paid_at"))
        return ProviderPayment(
            status=_STATUS_MAP.get(raw_status, PENDING),
            provider_status=raw_status.lower(),
            provider_payment_id=str(data.get("provider_payment_id") or "") or None,
            provider_order_id=str(data.get("provider_order_id") or "") or None,
            amount_minor=(int(data["amount_paise"])
                          if data.get("amount_paise") is not None else None),
            currency=str(data.get("currency") or "").upper() or None,
            method=str(data.get("method") or "").lower() or None,
            failure_reason=str(data.get("failure_reason") or "") or None,
            paid_at=paid_at,
            raw=dict(data),
        )

    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment:
        """What TrustBrick says about this payment, over an authenticated call.

        TrustBrick resolves the identifier three ways — its own reference, the
        provider order id, or the provider payment id — so this works whether
        the caller holds a Razorpay payment id or an order id.
        """
        data = self._call(
            "GET", f"/api/partner/v1/payments/{provider_payment_id}"
        )
        return self._payment_from(data)

    def fetch_order(self, provider_order_id: str) -> ProviderPayment:
        """Ask about an order when no payment id is known yet."""
        data = self._call("GET", f"/api/partner/v1/payments/{provider_order_id}")
        return self._payment_from(data)

    # ------------------------------------------------------------------
    # Contract: capture
    # ------------------------------------------------------------------
    def capture(
        self, *, provider_payment_id: str, amount_minor: int, currency: str
    ) -> ProviderPayment:
        """Ask TrustBrick to settle this payment, then report what it says.

        TrustBrick does not offer a bare "capture": its reconcile endpoint
        re-reads the payment from Razorpay over an authenticated channel,
        compares the amount, currency and order against the figures the partner
        originally asked for, and captures only if all of them agree. That is
        strictly more than a capture, and it is idempotent — a settled payment
        is answered from TrustBrick's own row without a Razorpay round trip.

        ``amount_minor`` is not sent. TrustBrick already holds the amount WE
        asked it to collect and compares against that; a figure supplied here
        could only ever disagree with it, and the caller checks the returned
        amount anyway.
        """
        data = self._call(
            "POST",
            f"/api/partner/v1/payments/{provider_payment_id}/reconcile",
            {},
        )
        payment = data.get("payment")
        if not isinstance(payment, dict):
            raise PaymentFailed("TrustBrick reconcile returned no payment.")
        result = self._payment_from(payment)
        logger.info(
            "TrustBrick reconcile for %s: code=%s captured=%s",
            provider_payment_id, data.get("code"), data.get("captured"),
        )
        return result

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
        """Not available. TrustBrick's partner API exposes no refund endpoint.

        Raised rather than silently reported as successful: a refund that this
        platform believed it had issued, and TrustBrick had never heard of,
        would be a customer owed money by a system that thinks it paid them.
        Refunds for partner payments are an operator action on TrustBrick's
        side until that endpoint exists.
        """
        raise PaymentProviderError(
            "TrustBrick's partner API has no refund endpoint. Refund this "
            "payment from TrustBrick directly.",
            code="refund_unsupported",
        )

    # ------------------------------------------------------------------
    # Contract: the callback
    # ------------------------------------------------------------------
    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        """Verify TrustBrick's signature over the RAW BYTES, then parse.

        NOT A RAZORPAY WEBHOOK. Razorpay signs its deliveries to TrustBrick;
        TrustBrick verifies those against the Razorpay API, decides the payment
        is settled, and then signs its own callback to us. This verifies that
        second signature.

        The order is fixed: bytes in, signature checked, only then parsed. A
        body that has not verified is a string somebody posted at us, and
        parsing it first would mean acting on it.
        """
        lookup = {str(k).lower(): v for k, v in dict(headers or {}).items()}

        def header(name: str) -> str:
            return str(lookup.get(name.lower()) or "").strip()

        key_id = header(HEADER_KEY_ID)
        timestamp = header(HEADER_TIMESTAMP)
        nonce = header(HEADER_NONCE)
        signature = header(HEADER_SIGNATURE)
        event_id = header(HEADER_EVENT_ID)

        if not (timestamp and nonce and signature):
            raise WebhookVerificationError(
                "TrustBrick callback is missing its signature headers."
            )

        # The timestamp is checked BEFORE the comparison, so a replay held for
        # hours is refused without spending the HMAC.
        try:
            sent_at = int(timestamp)
        except (TypeError, ValueError):
            raise WebhookVerificationError("TrustBrick callback timestamp is unreadable.")
        skew = abs(int(time.time()) - sent_at)
        if skew > TIMESTAMP_TOLERANCE_SECONDS:
            raise WebhookVerificationError(
                f"TrustBrick callback timestamp is {skew}s out; tolerance is "
                f"{TIMESTAMP_TOLERANCE_SECONDS}s."
            )

        expected = self.compute_signature(
            self._callback_secret, "POST", self._callback_path,
            timestamp, nonce, raw_body or b"",
        )
        if not hmac.compare_digest(expected, signature):
            # The key id is logged so an operator can see WHICH partner identity
            # the caller claimed. The signature itself never is.
            logger.warning(
                "TrustBrick callback signature did not match (key_id=%s).",
                key_id or "-",
            )
            raise WebhookVerificationError("TrustBrick callback signature did not match.")

        # ---- verified; only now is the body read ------------------------
        try:
            body = json.loads((raw_body or b"").decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise WebhookVerificationError(
                "TrustBrick callback body is not readable JSON."
            ) from exc
        if not isinstance(body, dict):
            raise WebhookVerificationError("TrustBrick callback body is not an object.")

        if not event_id:
            # REQUIRED, AND NEVER INVENTED. It is half of the unique key that
            # makes a redelivery collide in payment_provider_events; a
            # synthesised id would differ on every delivery and defeat the
            # guarantee entirely. Falls back to the body's own event_id, which
            # TrustBrick sets to the same value.
            event_id = str(body.get("event_id") or "").strip()
        if not event_id:
            raise WebhookVerificationError(
                "TrustBrick callback carries no event id; it cannot be de-duplicated."
            )

        event_type = str(body.get("event") or "").strip() or "unknown"
        return ProviderEvent(
            event_id=event_id,
            event_type=event_type,
            payment=self._payment_from(body),
            supported=event_type in _SUPPORTED_EVENTS,
            raw=body,
        )


def _parse_time(value: Any) -> dt.datetime | None:
    """TrustBrick's ISO-8601 with a trailing Z, or None."""
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(text)
    except ValueError:
        return None
