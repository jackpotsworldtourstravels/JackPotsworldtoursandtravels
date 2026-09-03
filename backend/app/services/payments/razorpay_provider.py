"""Razorpay Payment Gateway — INR, UPI Intent and UPI QR.

WHY THERE IS NO ``import razorpay`` HERE
The four calls this platform makes are plain REST with HTTP Basic auth. Adding
the vendor SDK would pull a dependency, a release cadence and a second set of
exception types into a backend whose only other outbound HTTP call
(``passport_ocr/azure_provider.py``) is written the same way, with ``requests``.
Nothing below is a private or undocumented endpoint; every one is cited on the
method that calls it.

THE FOUR ENDPOINTS, AND NOTHING ELSE
    POST /v1/orders                     open an order for a server-computed amount
    GET  /v1/orders?receipt=…           find the order a duplicate receipt refers to
    GET  /v1/orders/{id}/payments       what has been attempted against an order
    GET  /v1/payments/{id}              what actually happened to one payment
    POST /v1/payments/{id}/refund       give money back

RAZORPAY HAS NO IDEMPOTENCY HEADER, AND ITS RECEIPT IS NOT ONE EITHER
There is no ``X-Razorpay-Idempotency-Key``. The ``receipt`` field is often
described as Razorpay's idempotency handle, and on this platform it is NOT:

  * Receipt uniqueness is an OPT-IN account setting. With it off — the default
    — three creates with one receipt produce three separate orders. Verified
    against a live test account on 2026-09-02.
  * ``GET /v1/orders?receipt=<value>`` DOES NOT FILTER. It returns an unfiltered
    page, and matching it against the receipt asked for yields nothing, even
    though the order exists and stores that exact receipt. Also verified live.

So neither half of "Razorpay rejects a duplicate and we fetch the original"
holds by itself, and code that assumes it silently opens second orders. What
this adapter does instead:

  * :meth:`_order_by_receipt` LISTS recent orders and matches the receipt
    CLIENT-SIDE, which is what actually works;
  * :meth:`create_checkout` accepts ``may_exist``. When the caller knows a
    previous attempt for this key may already have opened an order — it claimed
    the key and then failed before recording an id — the lookup runs BEFORE the
    create rather than after a refusal that never comes.
  * the duplicate-refusal path is kept, for an account that DOES enforce unique
    receipts. Both paths now converge on the same working lookup.

The happy path is still one call: ``may_exist`` defaults to False.

AND ONE HONEST LIMIT: the listing is EVENTUALLY CONSISTENT, ~30s on the account
measured. A retry inside that window still opens a second order — see
``RECOVERY_BLIND_SECONDS`` for why that order is an unchargeable orphan rather
than a second way to take money, and what the lookup does buy. This adapter
cannot close that window; no Razorpay endpoint offers a read-your-writes lookup
by receipt. The guarantee that a customer is not charged twice comes from the
unique index on ``(package_booking_id, idempotency_key)`` in our own database,
not from anything here.

UPI COLLECT IS NOT REQUESTED AND CANNOT BE
NPCI discontinued UPI Collect for merchant payments on 28 February 2026. This
adapter never sends a VPA and never asks for a collect flow; Razorpay's checkout
decides between UPI Intent (mobile) and UPI QR (desktop) from the device, which
is the only compliant behaviour and is also why the method list is not
hard-coded on our side.

WHAT NEVER LEAVES THIS MODULE
``key_secret`` and ``webhook_secret``. They are used to sign and verify, they
are never returned by a method, never placed in a :class:`CheckoutSession`,
never included in an exception message, and never logged — see ``_redact``.
Only ``key_id`` is published, because Razorpay's own browser script needs it.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import logging
from typing import Any, Mapping

from app.services.payments.base import (
    AUTHORIZED,
    CAPTURED,
    CheckoutSession,
    FAILED,
    INR,
    PENDING,
    PROCESSING,
    PaymentFailed,
    PaymentMisconfigured,
    PaymentTimeout,
    ProviderEvent,
    ProviderPayment,
    ProviderRefund,
    REFUNDED,
    WebhookVerificationError,
)

logger = logging.getLogger(__name__)

API_BASE = "https://api.razorpay.com/v1"

#: Razorpay's webhook headers. Both are required: the first is the signature,
#: the second is the only stable identity a delivery has.
SIGNATURE_HEADER = "x-razorpay-signature"
EVENT_ID_HEADER = "x-razorpay-event-id"

#: ``receipt`` is capped at 40 characters, ASCII only.
#: https://razorpay.com/docs/api/orders/create/
RECEIPT_MAX = 40

#: Razorpay refuses an order below 100 minor units (₹1.00).
MIN_AMOUNT_MINOR = 100

#: How far back a recovery lookup looks, and how much of it it will read.
#:
#: ONE PAGE IS USUALLY ENOUGH AND TWO IS THE CAP. The listing is newest-first
#: and the order being recovered was opened seconds to minutes ago, so it is at
#: the front or it is not visible at all (see RECOVERY_BLIND_SECONDS). Paging
#: deeper would add seconds of latency to a customer-facing retry to search a
#: region the answer is not in.
RECOVERY_WINDOW_SECONDS = 24 * 3600
RECOVERY_PAGE = 100
RECOVERY_MAX_PAGES = 2

#: THE LIMIT OF THIS RECOVERY, MEASURED RATHER THAN ASSUMED.
#: Razorpay's order LIST is eventually consistent: an order fetched by id
#: immediately after creation, carrying the right receipt, took ~30s to appear
#: in ``GET /v1/orders`` on 2026-09-02. So a retry inside that window cannot
#: find its predecessor and will open another order.
#:
#: WHY THAT IS SAFE, AND WHY THIS IS STILL WORTH DOING.
#: An order whose id never reached the browser cannot be paid — paying requires
#: the id in the checkout — so the order left behind by a timed-out create is an
#: unchargeable orphan, not a second way to take money. What the lookup buys is
#: the retry that arrives after the lag (a customer who comes back, a background
#: retry) and any account that DOES enforce unique receipts, where the create is
#: refused and this is the only way to recover the original.
RECOVERY_BLIND_SECONDS = 30

#: Razorpay PAYMENT statuses -> ours. Source: the payment entity documentation.
#: ``created`` means an attempt exists but nothing has been authorised.
_PAYMENT_STATUS = {
    "created": PROCESSING,
    "authorized": AUTHORIZED,
    "captured": CAPTURED,
    "refunded": REFUNDED,
    "failed": FAILED,
}

#: Razorpay ORDER statuses -> ours. An order is not a payment: ``attempted``
#: means somebody tried, not that anything was authorised, so it maps to
#: PROCESSING rather than to AUTHORIZED.
_ORDER_STATUS = {
    "created": PENDING,
    "attempted": PROCESSING,
    "paid": CAPTURED,
}

#: Webhook event -> the status that event asserts. Events not listed are
#: recorded and ignored rather than dropped, so an unexpected subscription in
#: the Dashboard cannot silently change a payment.
#:
#: ``payment.authorized`` MAY ARRIVE AFTER ``payment.captured`` — Razorpay
#: documents at-least-once, out-of-order delivery. The status ranking in
#: ``base.is_forward`` is what makes that harmless; this map only says what an
#: event means, never whether to apply it.
_EVENT_STATUS = {
    "payment.authorized": AUTHORIZED,
    "payment.captured": CAPTURED,
    "payment.failed": FAILED,
    "order.paid": CAPTURED,
    "refund.created": REFUNDED,
    "refund.processed": REFUNDED,
}

#: Razorpay's error code for a receipt that has already been used.
_DUPLICATE_CODE = "BAD_REQUEST_ERROR"
_DUPLICATE_HINTS = ("duplicate receipt", "already exists", "duplicate request")


def _redact(value: str | None) -> str:
    """What a secret looks like in a log line. Never the secret."""
    if not value:
        return "<unset>"
    return f"<set:{len(value)} chars>"


class RazorpayProvider:
    """Razorpay adapter. Synchronous, bounded by its own timeout."""

    name = "razorpay"

    def __init__(
        self,
        key_id: str | None,
        key_secret: str | None,
        webhook_secret: str | None,
        *,
        timeout_seconds: float = 20.0,
        api_base: str = API_BASE,
    ) -> None:
        # REFUSE AT CONSTRUCTION, NOT ON THE FIRST PAYMENT. A missing key found
        # when a customer presses Pay Now is a customer-visible failure; found
        # at startup it is a log line an operator can act on before anyone tries.
        missing = [
            n for n, v in (
                ("RAZORPAY_KEY_ID", key_id),
                ("RAZORPAY_KEY_SECRET", key_secret),
                ("RAZORPAY_WEBHOOK_SECRET", webhook_secret),
            ) if not (v or "").strip()
        ]
        if missing:
            raise PaymentMisconfigured(
                "PAYMENT_PROVIDER=razorpay needs " + ", ".join(missing) + ". "
                "Test keys start rzp_test_; the webhook secret is the value you "
                "set on the webhook in the Razorpay Dashboard."
            )

        self.publishable_key = key_id.strip()          # type: ignore[union-attr]
        self._key_id = key_id.strip()                  # type: ignore[union-attr]
        self._key_secret = key_secret.strip()          # type: ignore[union-attr]
        self._webhook_secret = webhook_secret.strip()  # type: ignore[union-attr]
        self._timeout = float(timeout_seconds)
        self._base = api_base.rstrip("/")

        logger.info(
            "Razorpay adapter ready: key_id=%s key_secret=%s webhook_secret=%s",
            self._key_id, _redact(self._key_secret), _redact(self._webhook_secret),
        )

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------
    def _request(
        self, method: str, path: str, *,
        json_body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """One Razorpay call. Basic auth, bounded, and never leaks a secret.

        AUTHENTICATION IS HTTP BASIC, ``key_id:key_secret``, exactly as
        Razorpay documents. ``requests`` builds the Authorization header from
        the tuple, so the credential is never interpolated into a string that
        could end up in a log or a traceback.
        """
        import requests  # local, matching azure_provider.py's convention

        url = f"{self._base}{path}"
        try:
            response = requests.request(
                method,
                url,
                auth=(self._key_id, self._key_secret),
                json=dict(json_body) if json_body is not None else None,
                params=dict(params) if params is not None else None,
                timeout=self._timeout,
                headers={"Content-Type": "application/json"},
            )
        except requests.Timeout as exc:
            # DISTINCT FROM A REFUSAL ON PURPOSE. After a timeout we do not know
            # whether Razorpay created the order, so the caller must retry with
            # the SAME receipt — which is what turns the unknown into a lookup.
            raise PaymentTimeout(
                f"Razorpay did not answer within {self._timeout:g}s ({method} {path})."
            ) from exc
        except requests.RequestException as exc:
            raise PaymentFailed(f"Could not reach Razorpay ({method} {path}): {exc}") from exc

        if response.status_code >= 400:
            raise self._error_for(response)

        try:
            return response.json()
        except ValueError as exc:
            raise PaymentFailed(
                f"Razorpay returned a non-JSON body for {method} {path} "
                f"(HTTP {response.status_code})."
            ) from exc

    def _error_for(self, response: Any) -> PaymentFailed:
        """Turn a Razorpay error body into our exception, without echoing it raw.

        Razorpay's ``description`` is written for developers and can name
        internal fields. It is logged and attached for staff, while
        ``customer_message`` stays the generic sentence the customer sees.
        """
        code = description = ""
        try:
            err = (response.json() or {}).get("error") or {}
            code = str(err.get("code") or "")
            description = str(err.get("description") or "")
        except ValueError:
            description = (response.text or "")[:200]

        logger.warning(
            "Razorpay refused a request: HTTP %s code=%s description=%s",
            response.status_code, code, description,
        )
        exc = PaymentFailed(
            f"Razorpay refused the request (HTTP {response.status_code} {code}): {description}"
        )
        if self._looks_duplicate(code, description):
            exc.code = "duplicate_receipt"
        return exc

    @staticmethod
    def _looks_duplicate(code: str, description: str) -> bool:
        text = f"{code} {description}".lower()
        return any(hint in text for hint in _DUPLICATE_HINTS)

    # ------------------------------------------------------------------
    # Order creation
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
        """POST /v1/orders — https://razorpay.com/docs/api/orders/create/

        ``amount_minor`` was computed by the caller from the database. This
        method never reads a price, never applies a discount and never adjusts
        a figure; it passes on what it was handed.

        ``may_exist`` says the caller has reason to believe an order for this
        key may ALREADY exist — typically because a previous attempt claimed the
        key and then failed before it could record an order id. Passing it makes
        the receipt lookup run FIRST, which is the only ordering that cannot
        duplicate: after a timeout nobody knows whether Razorpay created the
        order, and creating one to find out is how a booking ends up with two.

        It defaults to False so the ordinary first attempt stays a single call.
        See the module docstring for why the receipt alone does not carry this.
        """
        if amount_minor < MIN_AMOUNT_MINOR:
            raise PaymentFailed(
                f"Razorpay will not take less than {MIN_AMOUNT_MINOR} minor units "
                f"(₹1.00); this booking is {amount_minor}."
            )
        if (currency or "").upper() != INR:
            # Guarded rather than passed through: the account is INR-only, and a
            # foreign currency would be refused by Razorpay with a message the
            # customer should never see.
            raise PaymentFailed(
                f"This Razorpay account collects {INR} only, not {currency!r}."
            )

        receipt = self._receipt(idempotency_key)

        # THE RECOVERY PATH, BEFORE THE CREATE RATHER THAN AFTER IT.
        # Only when the caller says a previous attempt may have got there first;
        # an ordinary Pay Now skips this entirely and costs one call as before.
        if may_exist:
            existing = self._order_by_receipt(receipt)
            if existing is not None and existing.get("id"):
                logger.info(
                    "Reusing order %s for receipt %s rather than opening a "
                    "second one; a previous attempt had already created it.",
                    existing.get("id"), receipt,
                )
                return self._session_from_order(existing, reference, customer)

        body: dict[str, Any] = {
            "amount": int(amount_minor),
            "currency": INR,
            "receipt": receipt,
            "notes": self._notes({"booking_ref": reference, **(notes or {})}),
        }

        try:
            order = self._request("POST", "/orders", json_body=body)
        except PaymentFailed as exc:
            # The idempotent path. Razorpay rejects a repeated receipt instead
            # of returning the original, so the original has to be fetched.
            if getattr(exc, "code", "") != "duplicate_receipt":
                raise
            order = self._order_by_receipt(receipt)
            if order is None:
                raise
            logger.info(
                "Razorpay reported receipt %s as already used; reusing order %s "
                "rather than opening a second one.", receipt, order.get("id"),
            )

        if not order.get("id"):
            raise PaymentFailed("Razorpay created an order with no id.")
        return self._session_from_order(order, reference, customer)

    def _session_from_order(
        self,
        order: Mapping[str, Any],
        reference: str,
        customer: Mapping[str, Any] | None,
    ) -> CheckoutSession:
        """One order entity -> the session the browser is handed.

        Shared by the create path and the recovery path deliberately: a reused
        order must reach the customer as exactly the same thing a fresh one
        does, or "we recovered your order" becomes a visibly different checkout.
        """
        return CheckoutSession(
            order_id=str(order.get("id")),
            # The provider's figure, not ours. If Razorpay ever echoed back a
            # different amount, the caller compares it against the booking and
            # refuses — which it could not do if we echoed our own number here.
            # This matters more on the recovery path: the order being reused was
            # opened by an earlier attempt, and the caller re-checks that it is
            # still for what this booking costs.
            amount_minor=int(order.get("amount") or 0),
            currency=str(order.get("currency") or INR),
            publishable_key=self.publishable_key,
            provider=self.name,
            # None: this is a DROP-IN integration. Razorpay's Hosted Checkout
            # does not support UPI Intent, and with Collect withdrawn that would
            # leave a mobile customer with a QR code they cannot scan on the
            # device displaying it.
            redirect_url=None,
            options={
                "name": "JackPots World Tours & Travels",
                "description": reference,
                "prefill": self._prefill(customer),
                # NOT a list of methods. Razorpay decides what to offer from the
                # device and from what is enabled on the account, which is what
                # keeps the UI honest about UPI Intent versus QR.
            },
        )

    @staticmethod
    def _receipt(idempotency_key: str) -> str:
        """Razorpay's idempotency handle: unique per account, ≤40 ASCII chars."""
        cleaned = "".join(c for c in (idempotency_key or "") if c.isalnum() or c in "-_")
        if not cleaned:
            raise PaymentFailed("An idempotency key is required to open an order.")
        return cleaned[:RECEIPT_MAX]

    @staticmethod
    def _notes(values: Mapping[str, Any]) -> dict[str, str]:
        """At most 15 pairs, 256 characters each — Razorpay's documented cap.

        Trimmed here rather than risking a rejection at the provider, and
        stringified because ``notes`` is a string map.
        """
        out: dict[str, str] = {}
        for key, value in values.items():
            if value is None or len(out) >= 15:
                continue
            out[str(key)[:256]] = str(value)[:256]
        return out

    @staticmethod
    def _prefill(customer: Mapping[str, Any] | None) -> dict[str, str]:
        """Name, email and contact for the checkout form. Nothing sensitive.

        Convenience only — the customer can change any of it, and none of it is
        used for verification. There is no passport, no address and no document
        detail here, and there must never be.
        """
        if not customer:
            return {}
        out = {}
        for ours, theirs in (("name", "name"), ("email", "email"), ("contact", "contact")):
            value = customer.get(ours)
            if value:
                out[theirs] = str(value)[:120]
        return out

    def _order_by_receipt(self, receipt: str) -> dict[str, Any] | None:
        """The order already opened under this receipt, or None.

        WHY THIS LISTS AND FILTERS LOCALLY INSTEAD OF QUERYING BY RECEIPT
        ``GET /v1/orders?receipt=<value>`` is documented as a filter and does
        not behave as one here: it returns an ordinary unfiltered page, so
        matching it yields nothing even when the order exists and stores that
        exact receipt. Verified live on 2026-09-02 — the order was fetched by
        id, its ``receipt`` was the value asked for, and the filtered query
        returned zero. Filtering client-side is therefore not a workaround for
        a slow endpoint; it is the only thing that finds the order at all.

        BOUNDED ON PURPOSE. A recovery lookup runs when a previous attempt may
        have opened an order moments ago, so a recent window is where the answer
        is. Scanning the whole account would turn a retry into an unbounded walk
        of every order ever created.

        WHEN SEVERAL ORDERS SHARE THE RECEIPT — which this account permits — the
        most advanced one wins, by the same ranking :meth:`fetch_order` uses. If
        a customer paid one of a set of duplicates, that is the one that must be
        reused; reusing a merely-``created`` sibling would ask them to pay again.
        """
        found: list[dict[str, Any]] = []
        for page in range(RECOVERY_MAX_PAGES):
            try:
                batch = self._request("GET", "/orders", params={
                    "count": RECOVERY_PAGE,
                    "skip": page * RECOVERY_PAGE,
                    "from": int(dt.datetime.now(dt.timezone.utc).timestamp())
                            - RECOVERY_WINDOW_SECONDS,
                })
            except PaymentFailed:
                # A failed lookup must not be reported as "no order exists" with
                # any more confidence than that — the caller treats None as
                # "not found", and creating a second order is the cost. Logged
                # so that cost is visible rather than silent.
                logger.warning(
                    "Could not list orders while recovering receipt %s; "
                    "a duplicate order may be opened.", receipt,
                )
                return None

            items = batch.get("items") or []
            found.extend(i for i in items if (i.get("receipt") or "") == receipt)
            if len(items) < RECOVERY_PAGE:
                break                      # last page

        if not found:
            return None
        return max(found, key=lambda o: _rank_for(
            _ORDER_STATUS.get(str(o.get("status", "")), PENDING)))

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------
    def fetch_payment(self, provider_payment_id: str) -> ProviderPayment:
        """GET /v1/payments/{id} — the authoritative read.

        Used by reconciliation, by the return page, and any time a webhook is
        late or missing. This is what makes the browser's claim irrelevant: the
        answer always comes from Razorpay, over an authenticated channel.
        """
        return self._payment_from(self._request("GET", f"/payments/{provider_payment_id}"))

    def fetch_order(self, provider_order_id: str) -> ProviderPayment:
        """GET /v1/orders/{id} plus its payments, when no payment id is known."""
        order = self._request("GET", f"/orders/{provider_order_id}")
        attempts = self._request("GET", f"/orders/{provider_order_id}/payments")
        items = attempts.get("items") or []

        # The most advanced attempt is what the order's state actually is: a
        # captured payment alongside three failed ones is a paid order.
        best: ProviderPayment | None = None
        for item in items:
            candidate = self._payment_from(item)
            if best is None or _rank_for(candidate.status) > _rank_for(best.status):
                best = candidate
        if best is not None:
            return best

        return ProviderPayment(
            status=_ORDER_STATUS.get(str(order.get("status", "")), PENDING),
            provider_status=str(order.get("status", "")),
            provider_order_id=str(order.get("id", provider_order_id)),
            amount_minor=order.get("amount"),
            currency=order.get("currency"),
            raw=order,
        )

    def _payment_from(self, entity: Mapping[str, Any]) -> ProviderPayment:
        """One Razorpay payment entity, normalised. Used by BOTH paths.

        The webhook handler and the status API go through this same function on
        purpose: a status the webhook read one way and reconciliation read
        another would produce two answers for one payment.
        """
        vendor_status = str(entity.get("status", ""))
        captured_at = entity.get("created_at")
        paid_at = None
        if vendor_status == "captured" and captured_at:
            try:
                paid_at = dt.datetime.fromtimestamp(int(captured_at), dt.timezone.utc)
            except (TypeError, ValueError, OSError):
                paid_at = None

        return ProviderPayment(
            status=_PAYMENT_STATUS.get(vendor_status, PROCESSING),
            provider_status=vendor_status,
            provider_payment_id=str(entity.get("id")) if entity.get("id") else None,
            provider_order_id=str(entity.get("order_id")) if entity.get("order_id") else None,
            amount_minor=entity.get("amount"),
            currency=entity.get("currency"),
            method=(str(entity.get("method")).lower() if entity.get("method") else None),
            failure_reason=entity.get("error_description") or entity.get("error_reason"),
            paid_at=paid_at,
            raw=dict(entity),
        )

    # ------------------------------------------------------------------
    # Webhooks
    # ------------------------------------------------------------------
    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        """HMAC-SHA256 over the RAW BYTES, then parse.

        https://razorpay.com/docs/webhooks/validate-test/ — "Do not parse or
        cast the webhook request body" before computing the signature. JSON
        round-tripping reorders keys and changes whitespace, and the digest is
        over bytes, so a re-serialised body never matches.

        Compared with ``hmac.compare_digest``: an ordinary ``==`` on a hex
        digest returns early on the first differing byte, which leaks the
        correct prefix to anyone able to time the response.
        """
        lowered = {k.lower(): v for k, v in headers.items()}
        supplied = (lowered.get(SIGNATURE_HEADER) or "").strip()
        if not supplied:
            raise WebhookVerificationError(
                "No X-Razorpay-Signature header — the delivery is not verifiable "
                "and is discarded without being read."
            )

        expected = hmac.new(
            self._webhook_secret.encode("utf-8"), raw_body, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(supplied, expected):
            # Deliberately says nothing about the expected value.
            raise WebhookVerificationError(
                "X-Razorpay-Signature does not match the request body."
            )

        # Only now is the body read at all.
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WebhookVerificationError(
                f"A correctly signed delivery was not valid JSON: {exc}"
            ) from exc
        if not isinstance(body, dict):
            raise WebhookVerificationError("A signed delivery was not a JSON object.")

        event_id = (lowered.get(EVENT_ID_HEADER) or "").strip()
        if not event_id:
            # NOT SYNTHESISED. A hash of the body or a uuid would differ on
            # every redelivery and would defeat the duplicate guarantee
            # entirely — the one thing this id exists for.
            raise WebhookVerificationError(
                "No X-Razorpay-Event-Id header. Razorpay delivers at least once, "
                "so an event with no stable id cannot be de-duplicated and is "
                "refused rather than processed on every retry."
            )

        event_type = str(body.get("event") or "")
        entity = self._entity_from(body)
        payment = self._payment_from(entity) if entity else None

        # The EVENT says what happened; the entity says what the payment looks
        # like. They can disagree — order.paid carries an order, not a payment —
        # so the event's assertion wins where it has one.
        asserted = _EVENT_STATUS.get(event_type)
        if payment is not None and asserted:
            payment = ProviderPayment(
                status=asserted,
                provider_status=payment.provider_status or event_type,
                provider_payment_id=payment.provider_payment_id,
                provider_order_id=payment.provider_order_id,
                amount_minor=payment.amount_minor,
                currency=payment.currency,
                method=payment.method,
                failure_reason=payment.failure_reason,
                paid_at=payment.paid_at,
                raw=payment.raw,
            )

        return ProviderEvent(
            event_id=event_id,
            event_type=event_type or "unknown",
            payment=payment,
            # _EVENT_STATUS is the whole list of types this adapter maps.
            # Anything else is parsed and identified so it can be recorded, and
            # flagged unsupported so nothing downstream acts on it.
            supported=event_type in _EVENT_STATUS,
            raw=body,
        )

    @staticmethod
    def _entity_from(body: Mapping[str, Any]) -> dict[str, Any] | None:
        """Dig the payment out of ``payload.<entity>.entity``.

        Razorpay nests differently per event: a payment event carries
        ``payload.payment.entity``; ``order.paid`` carries both
        ``payload.order.entity`` and ``payload.payment.entity``; a refund event
        carries ``payload.refund.entity``. Payment first, because it is the one
        that names both ids we need.
        """
        payload = body.get("payload") or {}
        if not isinstance(payload, dict):
            return None
        for key in ("payment", "refund", "order"):
            section = payload.get(key)
            if isinstance(section, dict):
                entity = section.get("entity")
                if isinstance(entity, dict):
                    return entity
        return None

    # ------------------------------------------------------------------
    # The checkout handler's signature — a SECOND check, never the first
    # ------------------------------------------------------------------
    def verify_checkout_signature(
        self, *, order_id: str, payment_id: str, signature: str
    ) -> bool:
        """``hmac_sha256(order_id + "|" + payment_id, key_secret)``.

        https://razorpay.com/docs/payments/payment-gateway/quick-integration/

        THIS IS NOT WHAT CONFIRMS A BOOKING. It proves the browser's handler
        response came from Razorpay and was not edited in the page — useful for
        showing the customer an immediate result — but the browser can be closed
        before it ever runs, so the webhook remains the authority. Razorpay's own
        documentation adds the rule this signature depends on: build it from the
        order id held on YOUR server, never from the one the checkout returned,
        or an attacker supplies both halves and the check proves nothing. The
        caller passes the stored id; this method never reads one from a request.
        """
        if not (order_id and payment_id and signature):
            return False
        expected = hmac.new(
            self._key_secret.encode("utf-8"),
            f"{order_id}|{payment_id}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(signature.strip(), expected)

    # ------------------------------------------------------------------
    # Capture
    # ------------------------------------------------------------------
    def capture(
        self, *, provider_payment_id: str, amount_minor: int, currency: str
    ) -> ProviderPayment:
        """POST /v1/payments/{id}/capture — https://razorpay.com/docs/api/payments/capture/

        WHY THIS EXISTS EVEN THOUGH RAZORPAY AUTO-CAPTURES BY DEFAULT
        Razorpay's documented default moves a completed payment straight to
        ``captured``, so the common path never reaches here. But an authorised
        payment that is NOT captured is **auto-refunded after five days**, and
        late authorisation (Razorpay polling a bank for up to five days after a
        network failure) lands a payment in ``authorized`` days later. Without
        this call those payments quietly refund themselves and a traveller who
        paid ends up with no booking and no money taken.

        WHAT IT MUST NOT BE USED FOR
        A payment the provider already reports as ``captured``. Razorpay refuses
        that with "the order is already paid", which would turn a healthy
        reconciliation into a spurious failure. The caller checks first.
        """
        if amount_minor <= 0:
            raise PaymentFailed("A capture must be for a positive amount.")
        result = self._request(
            "POST",
            f"/payments/{provider_payment_id}/capture",
            # Razorpay requires BOTH, and requires the amount to equal what was
            # authorised. We send the figure computed from our own booking row,
            # so a disagreement is refused by the provider as well as by us.
            json_body={"amount": int(amount_minor), "currency": (currency or INR).upper()},
        )
        return self._payment_from(result)

    # ------------------------------------------------------------------
    # Refunds
    # ------------------------------------------------------------------
    def refund(
        self,
        *,
        provider_payment_id: str,
        amount_minor: int,
        idempotency_key: str,
        notes: Mapping[str, Any] | None = None,
    ) -> ProviderRefund:
        """POST /v1/payments/{id}/refund — https://razorpay.com/docs/api/refunds/

        ``receipt`` IS THE IDEMPOTENCY KEY here too. Razorpay's refund
        documentation states it plainly, and a repeat returns
        "Duplicate receipt found for this refund request" rather than issuing a
        second refund — which is the behaviour that matters, because the failure
        mode being guarded against is paying a customer back twice.
        """
        if amount_minor <= 0:
            raise PaymentFailed("A refund must be for a positive amount.")

        body: dict[str, Any] = {
            "amount": int(amount_minor),
            "receipt": self._receipt(idempotency_key),
            "notes": self._notes(notes or {}),
        }
        result = self._request(
            "POST", f"/payments/{provider_payment_id}/refund", json_body=body
        )

        vendor_status = str(result.get("status", ""))
        return ProviderRefund(
            provider_refund_id=str(result.get("id", "")),
            # "pending" here means Razorpay is still working on it, NOT that
            # nothing happened. It is reported as our REFUNDED only once the
            # provider says processed; anything else stays PROCESSING so no
            # screen claims the money is back before it is.
            status=REFUNDED if vendor_status == "processed" else PROCESSING,
            provider_status=vendor_status,
            amount_minor=int(result.get("amount", amount_minor)),
            currency=str(result.get("currency", INR)),
            raw=result,
        )


def _rank_for(status: str) -> int:
    from app.services.payments.base import rank

    return rank(status)
