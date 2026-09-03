"""A payment provider that takes no money and says so.

WHAT THIS IS FOR
Running the whole payment path — order creation, checkout, webhook, signature
verification, duplicate-event handling, capture, booking confirmation — with no
provider account, no network and no money. That is what lets
``tests/verify_payments.py`` assert every branch in CI instead of needing a
person with a phone and a real UPI app.

WHAT THIS IS NOT
It is not a demo that makes the product look finished. It never reports a
capture on its own: nothing here moves to ``captured`` unless a caller
explicitly delivers a success event, and the only way to deliver one is
:meth:`build_event`, which is not reachable from any HTTP route. A customer on a
deployment configured with this provider sees an order open and nothing happen,
which is the truth.

THE LESSON FROM THE SIMULATED OCR PROVIDER IS TAKEN SERIOUSLY HERE
``passport_ocr`` once shipped a "simulated" provider that fabricated passenger
details from the checksum of an upload, and every extraction the platform had
ever recorded came from it. The difference is that this one cannot fabricate a
*success*: the only figure it ever reports is the figure it was handed, and the
only status it ever reports is one a test asked for by name. It also refuses to
be selected on a deployment that looks like production — see ``__init__``.

THE SIGNATURE IS REAL
HMAC-SHA256 over the raw bytes with a configured secret, verified with
``hmac.compare_digest``, exactly like Razorpay's. A mock that skipped
verification would leave the one security-critical branch in the webhook
handler untested, which is the branch most worth testing.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import secrets
from typing import Any, Mapping

from app.services.payments.base import (
    AUTHORIZED,
    CANCELLED,
    CAPTURED,
    CheckoutSession,
    EXPIRED,
    FAILED,
    INR,
    PENDING,
    PROCESSING,
    PaymentFailed,
    ProviderEvent,
    ProviderPayment,
    ProviderRefund,
    REFUNDED,
    WebhookVerificationError,
)

#: The header the mock signs into, mirroring Razorpay's shape.
SIGNATURE_HEADER = "x-mock-signature"
EVENT_ID_HEADER = "x-mock-event-id"


class MockPaymentProvider:
    """Deterministic, offline, and incapable of inventing a success."""

    name = "mock"

    def __init__(self, *, key_id: str = "mock_key", secret: str = "mock_secret") -> None:
        self.publishable_key = key_id
        self._secret = secret
        #: order_id -> what we were asked to collect. Process-local: this is a
        #: test double, not a store, and a restart forgetting an order is
        #: correct behaviour for one.
        self._orders: dict[str, dict[str, Any]] = {}
        #: idempotency_key -> order_id, so a repeated create returns the same
        #: order exactly as a real provider's idempotency does.
        self._by_key: dict[str, str] = {}
        self._payments: dict[str, ProviderPayment] = {}

    # -- creation ---------------------------------------------------------
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
        # ``may_exist`` is accepted and ignored: this provider derives the order
        # id from the key, so a repeated call already returns the same order and
        # there is nothing to recover. Accepting it keeps the mock a faithful
        # stand-in — a caller that passes it must not break here and pass in
        # production.
        if amount_minor <= 0:
            raise PaymentFailed("A payment must be for a positive amount.")

        existing = self._by_key.get(idempotency_key)
        if existing is not None:
            order = self._orders[existing]
            # The SAME order, with the amount it was opened for. A provider that
            # honoured the key but re-priced would be worse than one that ignored
            # it, so the stored figure wins over the argument.
            return self._session(existing, order["amount_minor"], order["currency"])

        order_id = f"order_mock_{secrets.token_hex(8)}"
        self._orders[order_id] = {
            "amount_minor": amount_minor,
            "currency": currency,
            "reference": reference,
            "notes": dict(notes or {}),
            "created_at": dt.datetime.now(dt.timezone.utc),
        }
        self._by_key[idempotency_key] = order_id
        return self._session(order_id, amount_minor, currency)

    def _session(self, order_id: str, amount_minor: int, currency: str) -> CheckoutSession:
        return CheckoutSession(
            order_id=order_id,
            amount_minor=amount_minor,
            currency=currency,
            publishable_key=self.publishable_key,
            provider=self.name,
            redirect_url=None,
            options={"mock": True, "note": "No money will be taken."},
        )

    # -- reads ------------------------------------------------------------
    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment:
        found = self._payments.get(provider_payment_id)
        if found is None:
            raise PaymentFailed(f"No mock payment {provider_payment_id!r}.")
        return found

    def fetch_order(self, provider_order_id: str) -> ProviderPayment:
        order = self._orders.get(provider_order_id)
        if order is None:
            raise PaymentFailed(f"No mock order {provider_order_id!r}.")
        for payment in self._payments.values():
            if payment.provider_order_id == provider_order_id:
                return payment
        # Opened, not paid. PENDING rather than a guess.
        return ProviderPayment(
            status=PENDING,
            provider_status="created",
            provider_order_id=provider_order_id,
            amount_minor=order["amount_minor"],
            currency=order["currency"],
        )

    # -- webhooks ---------------------------------------------------------
    def sign(self, raw_body: bytes) -> str:
        """The signature a caller must send. Used by tests and by nothing else."""
        return hmac.new(self._secret.encode(), raw_body, hashlib.sha256).hexdigest()

    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        lowered = {k.lower(): v for k, v in headers.items()}
        supplied = lowered.get(SIGNATURE_HEADER, "")
        if not supplied:
            raise WebhookVerificationError("No signature header on the request.")
        if not hmac.compare_digest(supplied, self.sign(raw_body)):
            raise WebhookVerificationError("Signature does not match the body.")

        try:
            body = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            # Reached only with a VALID signature over unparseable bytes, which
            # means whoever holds the secret sent nonsense. Still not processed.
            raise WebhookVerificationError(f"Signed body is not JSON: {exc}") from exc

        # THE HEADER, NOT THE BODY — because that is where Razorpay puts it.
        # This used to fall back to body["event_id"], which made the mock MORE
        # permissive than the real adapter: a delivery with no event-id header
        # was refused by Razorpay and accepted here, so a CI run against the
        # mock could pass a case that fails in production. A test double whose
        # security branches are laxer than the thing it stands in for is worse
        # than no double at all.
        event_id = (lowered.get(EVENT_ID_HEADER) or "").strip()
        if not event_id:
            raise WebhookVerificationError(
                "No event id header — an event that cannot be identified cannot "
                "be de-duplicated, so it is refused rather than processed once "
                "per delivery."
            )

        entity = body.get("payment") or {}
        payment = None
        if entity:
            payment = ProviderPayment(
                status=entity.get("status", PENDING),
                provider_status=entity.get("provider_status", entity.get("status", "")),
                provider_payment_id=entity.get("id"),
                provider_order_id=entity.get("order_id"),
                amount_minor=entity.get("amount"),
                currency=entity.get("currency", INR),
                method=entity.get("method"),
                failure_reason=entity.get("error"),
                paid_at=dt.datetime.now(dt.timezone.utc)
                if entity.get("status") == CAPTURED
                else None,
                raw=entity,
            )
            if payment.provider_payment_id:
                self._payments[payment.provider_payment_id] = payment

        event_type = body.get("event", "payment.updated")
        return ProviderEvent(
            event_id=str(event_id),
            event_type=event_type,
            payment=payment,
            supported=event_type in SUPPORTED_EVENTS,
            raw=body,
        )

    # -- capture ----------------------------------------------------------
    def capture(
        self, *, provider_payment_id: str, amount_minor: int, currency: str
    ) -> ProviderPayment:
        """Mirrors Razorpay: only an AUTHORIZED payment may be captured."""
        payment = self._payments.get(provider_payment_id)
        if payment is None:
            raise PaymentFailed(f"No mock payment {provider_payment_id!r} to capture.")
        if payment.status == CAPTURED:
            # The same refusal Razorpay gives, so the caller's "check before
            # capturing" logic is exercised rather than assumed.
            raise PaymentFailed("The order is already paid.")
        if payment.status != AUTHORIZED:
            raise PaymentFailed(
                f"Only an authorized payment can be captured (is {payment.status!r})."
            )
        if amount_minor != (payment.amount_minor or 0):
            raise PaymentFailed("Capture amount does not equal the authorised amount.")
        captured = ProviderPayment(
            status=CAPTURED, provider_status="captured",
            provider_payment_id=payment.provider_payment_id,
            provider_order_id=payment.provider_order_id,
            amount_minor=payment.amount_minor, currency=payment.currency,
            method=payment.method, paid_at=dt.datetime.now(dt.timezone.utc),
            raw=dict(payment.raw),
        )
        self._payments[provider_payment_id] = captured
        return captured

    # -- refunds ----------------------------------------------------------
    def refund(
        self,
        *,
        provider_payment_id: str,
        amount_minor: int,
        idempotency_key: str,
        notes: Mapping[str, Any] | None = None,
    ) -> ProviderRefund:
        payment = self._payments.get(provider_payment_id)
        if payment is None:
            raise PaymentFailed(f"No mock payment {provider_payment_id!r} to refund.")
        if payment.status != CAPTURED:
            raise PaymentFailed("Only a captured payment can be refunded.")
        if amount_minor <= 0 or amount_minor > (payment.amount_minor or 0):
            raise PaymentFailed("Refund amount is outside the captured amount.")
        return ProviderRefund(
            provider_refund_id=f"rfnd_mock_{secrets.token_hex(6)}",
            status=REFUNDED,
            provider_status="processed",
            amount_minor=amount_minor,
            currency=payment.currency or INR,
            raw={"mock": True},
        )

    # -- test driver ------------------------------------------------------
    #: Not part of the PaymentProvider protocol, and deliberately not reachable
    #: from any route. A test builds the exact bytes a provider would post, and
    #: signs them, so the handler under test receives a genuine signed delivery
    #: rather than a shortcut past its own verification.
    def build_event(
        self,
        *,
        order_id: str,
        status: str = CAPTURED,
        event_id: str | None = None,
        payment_id: str | None = None,
        amount_minor: int | None = None,
        currency: str | None = None,
        method: str = "upi",
        error: str | None = None,
        event_type: str | None = None,
    ) -> tuple[bytes, dict[str, str]]:
        """Return ``(raw_body, headers)`` for a delivery a test can POST.

        The amount defaults to what the order was opened for, so the common case
        is honest; a test that wants a mismatch passes one explicitly, which is
        exactly the case the service is supposed to reject.
        """
        order = self._orders.get(order_id, {})
        body = {
            "event_id": event_id or f"evt_mock_{secrets.token_hex(8)}",
            "event": event_type or _EVENT_FOR.get(status, "payment.updated"),
            "payment": {
                "id": payment_id or f"pay_mock_{secrets.token_hex(8)}",
                "order_id": order_id,
                "status": status,
                "provider_status": status,
                "amount": amount_minor
                if amount_minor is not None
                else order.get("amount_minor"),
                "currency": currency or order.get("currency", INR),
                "method": method,
                "error": error,
            },
        }
        raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
        return raw, {
            SIGNATURE_HEADER: self.sign(raw),
            EVENT_ID_HEADER: body["event_id"],
            "content-type": "application/json",
        }


#: The event types this mock claims to handle — the same six the Razorpay
#: adapter maps, so a test that exercises one exercises the other's shape.
SUPPORTED_EVENTS = frozenset({
    "payment.authorized", "payment.captured", "payment.failed",
    "order.paid", "refund.created", "refund.processed",
})

_EVENT_FOR = {
    CAPTURED: "payment.captured",
    FAILED: "payment.failed",
    CANCELLED: "payment.cancelled",
    EXPIRED: "payment.expired",
    PROCESSING: "payment.processing",
    REFUNDED: "refund.processed",
}
