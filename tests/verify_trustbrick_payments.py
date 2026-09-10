"""The TrustBrick partner payment adapter — signing, callbacks, selection.

Run with::

    python tests/verify_trustbrick_payments.py

NEEDS NO SERVER, NO DATABASE AND NO NETWORK. TrustBrick is replaced by a stub
that verifies our signature exactly as the real service does, so a signing bug
fails here rather than as an integration that mysteriously 401s. Nothing in
this file opens a Razorpay order or moves money.

WHAT THIS PROTECTS

1. **The signature is over a canonical string, not the body alone.** Version,
   method, request target, timestamp, nonce and a digest of the body. A
   signature lifted onto another endpoint, or onto another verb, does not
   verify.

2. **A fresh nonce every request.** Reusing one inside the tolerance window is
   a replay, and TrustBrick refuses it. There is no code path that can reuse.

3. **The callback is verified before it is parsed.** Bad signature, stale
   timestamp and missing headers are all refused, and none of them reaches
   ``json.loads``.

4. **A duplicate callback is the same event.** ``X-TB-Event-Id`` is carried
   through unchanged, which is what makes a redelivery collide on the unique
   index in ``payment_provider_events`` rather than being processed twice.

5. **Amount and currency are compared, never accepted.** The adapter reports
   what TrustBrick says; the service above compares it against the booking.
   Both figures are integer paise.

6. **Refunds are refused, loudly.** TrustBrick's partner API has no refund
   endpoint, and a refund this platform believed it had issued would be a
   customer owed money by a system that thinks it paid them.

7. **The live Razorpay package flow is unchanged.** With no pilot booking
   configured, provider selection returns exactly what it returned before.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(HERE))

from app.services.payments.base import (  # noqa: E402
    AUTHORIZED,
    CAPTURED,
    FAILED,
    PENDING,
    PaymentFailed,
    PaymentMisconfigured,
    PaymentProviderError,
    PaymentTimeout,
    WebhookVerificationError,
)
from app.services.payments.trustbrick_provider import (  # noqa: E402
    CALLBACK_PATH,
    TrustBrickProvider,
)

BASE_URL = "https://trustbrick.test"
KEY_ID = "tb_live_jw_01"
SECRET = "s" * 48
CALLBACK_SECRET = "c" * 48

results = {"pass": 0, "fail": 0}
failures: list[str] = []


def ok(label: str, condition: bool, detail: str = "") -> bool:
    if condition:
        results["pass"] += 1
        print(f"  PASS  {label}")
    else:
        results["fail"] += 1
        failures.append(f"{label} {detail}".strip())
        print(f"  FAIL  {label} {detail}")
    return bool(condition)


# ===========================================================================
# A stub TrustBrick that authenticates us the way the real one does
# ===========================================================================
class StubTrustBrick:
    """Stands in for the TrustBrick partner API.

    Verifies our HMAC with the same construction the real service uses, so an
    outbound signing bug is a failed assertion here rather than a 401 in
    production. Records every nonce it sees, which is how the "fresh nonce"
    guarantee is asserted.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.nonces: list[str] = []
        self.signature_ok: list[bool] = []
        self.payments: dict[str, dict] = {}
        self.order_seq = 0
        #: Set to raise instead of answering, for the timeout path.
        self.raise_with: Exception | None = None
        self.next_status: int | None = None

    # -- the transport seam ------------------------------------------------
    def request(self, method, url, data=None, headers=None, timeout=None):
        if self.raise_with is not None:
            raise self.raise_with

        headers = headers or {}
        target = url[len(BASE_URL):]
        body = data or b""

        expected = TrustBrickProvider.compute_signature(
            SECRET, method, target,
            headers.get("X-TB-Timestamp", ""),
            headers.get("X-TB-Nonce", ""),
            body,
        )
        self.signature_ok.append(
            hmac.compare_digest(expected, headers.get("X-TB-Signature", ""))
        )
        self.nonces.append(headers.get("X-TB-Nonce", ""))
        self.calls.append({
            "method": method, "target": target, "body": body,
            "headers": dict(headers),
        })

        status = self.next_status
        self.next_status = None
        if status is not None:
            return _Response(status, {"ok": False, "error": "refused"})

        payload = json.loads(body.decode()) if body else {}
        if method == "POST" and target == "/api/partner/v1/payments":
            return _Response(201, {"ok": True, "data": self._create(payload)})
        if method == "GET" and target.startswith("/api/partner/v1/payments/"):
            handle = target.rsplit("/", 1)[-1]
            found = self._resolve(handle)
            if found is None:
                return _Response(404, {"ok": False, "error": "Payment not found."})
            return _Response(200, {"ok": True, "data": found})
        if method == "POST" and target.endswith("/reconcile"):
            handle = target.split("/")[-2]
            found = self._resolve(handle)
            if found is None:
                return _Response(404, {"ok": False, "error": "Payment not found."})
            return _Response(200, {"ok": True, "data": {
                "code": "captured", "captured": True, "retryable": False,
                "detail": "Payment verified and captured.", "payment": found,
            }})
        return _Response(404, {"ok": False, "error": "no such route"})

    # -- state -------------------------------------------------------------
    def _create(self, payload):
        key = payload.get("idempotency_key")
        for row in self.payments.values():
            if row["_idem"] == key:
                return {**row, "created": False, "key_id": "rzp_live_stub"}
        self.order_seq += 1
        row = {
            "_idem": key,
            "payment_reference": f"TBP-260910-{self.order_seq:06X}",
            "partner_booking_ref": payload.get("booking_ref"),
            "product_type": payload.get("product_type"),
            "amount_paise": payload.get("amount_paise"),
            "currency": payload.get("currency"),
            "status": "INITIATED",
            "provider": "razorpay",
            "provider_order_id": f"order_STUB{self.order_seq:04d}",
            "provider_payment_id": None,
            "method": "",
            "paid_at": None,
            "verified_at": None,
        }
        self.payments[row["payment_reference"]] = row
        return {**row, "created": True, "key_id": "rzp_live_stub"}

    def _resolve(self, handle):
        """The three-way lookup the real service performs."""
        for row in self.payments.values():
            if handle in (row["payment_reference"], row["provider_order_id"],
                          row.get("provider_payment_id")):
                return {k: v for k, v in row.items() if not k.startswith("_")}
        return None

    def settle(self, reference, *, status="CAPTURED", payment_id="pay_STUB0001",
               amount=None, currency=None):
        row = self.payments[reference]
        row["status"] = status
        row["provider_payment_id"] = payment_id
        row["method"] = "upi"
        row["paid_at"] = "2026-09-10T12:00:00Z"
        if amount is not None:
            row["amount_paise"] = amount
        if currency is not None:
            row["currency"] = currency
        return row


class _Response:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


def build(stub, adapter_module):
    """An adapter whose transport is the stub.

    Replaces the ``requests`` reference INSIDE the adapter's own namespace, not
    the real module — patching ``requests.request`` itself would leak into
    every other import in the process and quietly break unrelated tests.
    """
    import requests as real_requests

    class _Transport:
        # The adapter catches these by identity, so they must be the real ones.
        Timeout = real_requests.Timeout
        RequestException = real_requests.RequestException
        request = staticmethod(stub.request)

    adapter_module.requests = _Transport
    return TrustBrickProvider(
        base_url=BASE_URL, key_id=KEY_ID, secret=SECRET,
        callback_secret=CALLBACK_SECRET, timeout_seconds=5,
    )


def sign_callback(body: bytes, *, secret=CALLBACK_SECRET, timestamp=None,
                  event_id="tbev_abc123", path=CALLBACK_PATH):
    timestamp = timestamp or str(int(time.time()))
    nonce = "n" * 32
    return {
        "X-TB-Key-Id": KEY_ID,
        "X-TB-Timestamp": timestamp,
        "X-TB-Nonce": nonce,
        "X-TB-Signature": TrustBrickProvider.compute_signature(
            secret, "POST", path, timestamp, nonce, body
        ),
        "X-TB-Event-Id": event_id,
    }


CALLBACK_BODY = {
    "event_id": "tbev_abc123",
    "event": "payment.captured",
    "payment_reference": "TBP-260910-000001",
    "booking_ref": "JPP000123",
    "product_type": "package",
    "amount_paise": 500000,
    "currency": "INR",
    "status": "CAPTURED",
    "provider": "razorpay",
    "provider_order_id": "order_STUB0001",
    "provider_payment_id": "pay_STUB0001",
    "method": "upi",
    "paid_at": "2026-09-10T12:00:00Z",
}


# ===========================================================================
# 1. Signing
# ===========================================================================
def test_signing():
    print("\nHMAC signing")

    # The agreed vector, computed independently here rather than by calling the
    # function under test with itself.
    body = b'{"idempotency_key":"BOOK123-attempt-1"}'
    ts, nonce = "1789000000", "3f0a1c9e77b24d5188aa02e4b7c61d93"
    target = "/api/partner/v1/payments"
    expected_canonical = (
        "v1\nPOST\n/api/partner/v1/payments\n1789000000\n"
        "3f0a1c9e77b24d5188aa02e4b7c61d93\n" + hashlib.sha256(body).hexdigest()
    )
    ok("canonical string matches the agreed scheme",
       TrustBrickProvider.canonical_string("POST", target, ts, nonce, body)
       == expected_canonical)

    expected_sig = hmac.new(
        SECRET.encode(), expected_canonical.encode(), hashlib.sha256
    ).hexdigest()
    ok("signature matches an independent HMAC",
       TrustBrickProvider.compute_signature(SECRET, "POST", target, ts, nonce, body)
       == expected_sig)

    # Each component must actually change the signature.
    base = TrustBrickProvider.compute_signature(SECRET, "POST", target, ts, nonce, body)
    variants = {
        "method": TrustBrickProvider.compute_signature(SECRET, "GET", target, ts, nonce, body),
        "target": TrustBrickProvider.compute_signature(SECRET, "POST", "/other", ts, nonce, body),
        "timestamp": TrustBrickProvider.compute_signature(SECRET, "POST", target, "1", nonce, body),
        "nonce": TrustBrickProvider.compute_signature(SECRET, "POST", target, ts, "x" * 32, body),
        "body": TrustBrickProvider.compute_signature(SECRET, "POST", target, ts, nonce, b"{}"),
        "secret": TrustBrickProvider.compute_signature("other" * 10, "POST", target, ts, nonce, body),
    }
    for field, value in variants.items():
        ok(f"signature is bound to {field}", value != base)


def test_fresh_nonce(stub, provider):
    print("\nFresh nonce per request")
    for _ in range(4):
        provider.create_checkout(
            amount_minor=500000, currency="INR", reference="JPP000123",
            idempotency_key=f"key-{_}-aaaaaaaa",
        )
    ok("every outbound request signed correctly", all(stub.signature_ok),
       f"{stub.signature_ok.count(False)} bad")
    ok("a fresh nonce every request",
       len(set(stub.nonces)) == len(stub.nonces),
       f"{len(stub.nonces) - len(set(stub.nonces))} reused")
    ok("nonces are long enough", all(len(n) >= 16 for n in stub.nonces))


# ===========================================================================
# 2. Creating a checkout
# ===========================================================================
def test_create_checkout(stub, provider):
    print("\ncreate_checkout")
    session = provider.create_checkout(
        amount_minor=500000, currency="INR", reference="JPP000123",
        idempotency_key="JPP000123-attempt-1",
        customer={"name": "A Traveller", "email": "t@example.test", "contact": "+91"},
        notes={"booking_ref": "JPP000123"},
    )
    ok("order_id is the RAZORPAY order, for the widget",
       session.order_id.startswith("order_"), session.order_id)
    ok("amount echoed in minor units", session.amount_minor == 500000)
    ok("currency is INR", session.currency == "INR")
    ok("publishable key returned", session.publishable_key == "rzp_live_stub")
    ok("provider names itself trustbrick", session.provider == "trustbrick")
    ok("trustbrick reference carried in options",
       str(session.options.get("trustbrick_payment_reference")).startswith("TBP-"))

    sent = json.loads(stub.calls[-1]["body"].decode())
    ok("amount sent as integer paise", sent["amount_paise"] == 500000
       and isinstance(sent["amount_paise"], int))
    ok("product_type defaults to package", sent["product_type"] == "package")
    ok("booking ref sent as booking_ref", sent["booking_ref"] == "JPP000123")
    ok("no secret in the request body",
       SECRET not in stub.calls[-1]["body"].decode()
       and CALLBACK_SECRET not in stub.calls[-1]["body"].decode())

    # Idempotency is TrustBrick's, and it is real.
    again = provider.create_checkout(
        amount_minor=500000, currency="INR", reference="JPP000123",
        idempotency_key="JPP000123-attempt-1",
    )
    ok("same idempotency key returns the same order",
       again.order_id == session.order_id)

    # Currency is refused, not converted.
    try:
        provider.create_checkout(amount_minor=100, currency="USD",
                                 reference="JPP000123", idempotency_key="k-usd-1234")
        ok("non-INR refused", False, "no exception")
    except PaymentMisconfigured:
        ok("non-INR refused", True)


def test_error_classification(stub, provider):
    """Every failure mode, sorted into retryable and terminal.

    THE RULE THIS ASSERTS: "we do not know" is never recorded as "it failed".
    A payment is terminal only when TrustBrick has told us something final.
    Everything else — a timeout, a dropped connection, a 5xx, a rate limit —
    leaves the outcome unknown and must be retryable, because TrustBrick may
    already have opened the order. Retrying is safe: its idempotency is a
    unique index, so the same key returns the same order rather than a second.
    """
    print("\nError classification")
    import requests as _requests

    seq = [0]

    def attempt(*, raise_with=None, status=None):
        """One create call, returning the exception it raised (or None)."""
        seq[0] += 1
        stub.raise_with = raise_with
        stub.next_status = status
        try:
            provider.create_checkout(
                amount_minor=500000, currency="INR", reference="JPP000123",
                idempotency_key=f"k-class-{seq[0]:04d}",
            )
            return None
        except PaymentProviderError as exc:
            return exc
        finally:
            stub.raise_with = None
            stub.next_status = None

    def classifies(label, expected, **kw):
        exc = attempt(**kw)
        got = type(exc).__name__ if exc is not None else "no exception"
        ok(label, isinstance(exc, expected), f"got {got}")
        return exc

    # ---- retryable: the outcome is unknown ------------------------------
    classifies("a read timeout is retryable (PaymentTimeout)", PaymentTimeout,
               raise_with=_requests.Timeout("read timed out"))
    classifies("a ConnectionError is retryable — the order may exist",
               PaymentTimeout,
               raise_with=_requests.ConnectionError("connection reset by peer"))
    classifies("a ChunkedEncodingError is retryable", PaymentTimeout,
               raise_with=_requests.exceptions.ChunkedEncodingError("truncated"))
    classifies("HTTP 429 is retryable — rate limiting says 'ask again'",
               PaymentTimeout, status=429)
    for code in (500, 502, 503):
        classifies(f"HTTP {code} is retryable", PaymentTimeout, status=code)

    # A retryable outcome must NOT also read as terminal: the two are siblings,
    # and a caller branching on PaymentFailed must not catch these.
    exc = attempt(status=429)
    ok("a retryable error is not a PaymentFailed",
       not isinstance(exc, PaymentFailed), type(exc).__name__)

    # ---- terminal: TrustBrick told us something final -------------------
    for code in (401, 403):
        classifies(f"HTTP {code} is PaymentMisconfigured, never retried",
                   PaymentMisconfigured, status=code)
    exc = classifies("HTTP 404 is a terminal PaymentFailed", PaymentFailed,
                     status=404)
    ok("404 carries the not_found code",
       getattr(exc, "code", None) == "not_found", getattr(exc, "code", None))
    classifies("HTTP 422 (validation) is terminal", PaymentFailed, status=422)

    # A credential rejection must not be mistaken for something to retry.
    exc = attempt(status=401)
    ok("a credential rejection is not retryable",
       not isinstance(exc, PaymentTimeout), type(exc).__name__)

    # ---- and the happy path still works after all that ------------------
    ok("a normal call still succeeds", attempt() is None)


# ===========================================================================
# 3. Reading back and reconciling
# ===========================================================================
def test_fetch_and_reconcile(stub, provider):
    print("\nfetch / reconcile")
    session = provider.create_checkout(
        amount_minor=500000, currency="INR", reference="JPP000200",
        idempotency_key="JPP000200-attempt-1",
    )
    reference = session.options["trustbrick_payment_reference"]

    pending = provider.fetch_order(session.order_id)
    ok("an unpaid order reads as pending", pending.status == PENDING, pending.status)

    stub.settle(reference)
    captured = provider.fetch_payment("pay_STUB0001")
    ok("a settled payment reads as captured", captured.status == CAPTURED,
       captured.status)
    ok("provider status kept verbatim", captured.provider_status == "captured")
    ok("amount reported in minor units", captured.amount_minor == 500000)
    ok("currency reported", captured.currency == "INR")
    ok("razorpay payment id reported",
       captured.provider_payment_id == "pay_STUB0001")
    ok("paid_at parsed to a datetime", captured.paid_at is not None)

    # fetch by ORDER id must work too — TrustBrick resolves three ways.
    by_order = provider.fetch_payment(session.order_id)
    ok("lookup by order id resolves the same payment",
       by_order.provider_payment_id == "pay_STUB0001")

    settled = provider.capture(provider_payment_id=reference,
                               amount_minor=500000, currency="INR")
    ok("capture goes through reconcile", settled.status == CAPTURED)
    ok("reconcile was a POST to /reconcile",
       stub.calls[-1]["target"].endswith("/reconcile")
       and stub.calls[-1]["method"] == "POST")

    # Status mapping for the unhappy paths.
    stub.settle(reference, status="FAILED")
    ok("FAILED maps to our failed", provider.fetch_payment(reference).status == FAILED)
    stub.settle(reference, status="AUTHORISED")
    ok("AUTHORISED maps to our authorized",
       provider.fetch_payment(reference).status == AUTHORIZED)


def test_refund_refused(provider):
    print("\nRefunds")
    try:
        provider.refund(provider_payment_id="pay_STUB0001", amount_minor=1,
                        idempotency_key="r-1")
        ok("refund is refused", False, "no exception")
    except PaymentProviderError as exc:
        ok("refund is refused", True)
        ok("refund refusal carries refund_unsupported",
           exc.code == "refund_unsupported", exc.code)


# ===========================================================================
# 4. The callback
# ===========================================================================
def test_callback(provider):
    print("\nCallback verification")
    body = json.dumps(CALLBACK_BODY).encode()

    event = provider.verify_webhook(body, sign_callback(body))
    ok("a correctly signed callback verifies", event.event_id == "tbev_abc123")
    ok("event type carried through", event.event_type == "payment.captured")
    ok("payment.captured is a supported event", event.supported is True)
    ok("callback payment reads as captured", event.payment.status == CAPTURED)
    ok("callback amount is minor units", event.payment.amount_minor == 500000)
    ok("callback currency read", event.payment.currency == "INR")

    # --- a duplicate is the SAME event id ------------------------------
    again = provider.verify_webhook(body, sign_callback(body))
    ok("a redelivery carries the same event id — dedupe works upstream",
       again.event_id == event.event_id)

    # --- refusals -------------------------------------------------------
    def refused(label, headers, payload=body):
        try:
            provider.verify_webhook(payload, headers)
            ok(label, False, "accepted")
        except WebhookVerificationError:
            ok(label, True)

    bad = sign_callback(body)
    bad["X-TB-Signature"] = "00" * 32
    refused("a bad signature is refused", bad)

    refused("a callback signed with the WRONG secret is refused",
            sign_callback(body, secret="x" * 48))

    refused("a stale timestamp is refused",
            sign_callback(body, timestamp=str(int(time.time()) - 3600)))
    refused("a future timestamp is refused",
            sign_callback(body, timestamp=str(int(time.time()) + 3600)))

    refused("a signature for another path is refused",
            sign_callback(body, path="/api/webhooks/payments/razorpay"))

    missing = sign_callback(body)
    del missing["X-TB-Signature"]
    refused("a callback with no signature is refused", missing)

    # A tampered body: signature computed over the original, a different body sent.
    tampered = json.dumps({**CALLBACK_BODY, "amount_paise": 1}).encode()
    refused("a tampered body is refused", sign_callback(body), tampered)

    # Event id is required and never invented.
    no_id = sign_callback(body, event_id="")
    stripped = json.dumps({k: v for k, v in CALLBACK_BODY.items()
                           if k != "event_id"}).encode()
    no_id_hdr = sign_callback(stripped, event_id="")
    del no_id_hdr["X-TB-Event-Id"]
    refused("a callback with no event id at all is refused", no_id_hdr, stripped)

    # An unsubscribed event type parses but is not claimed as supported.
    other = json.dumps({**CALLBACK_BODY, "event": "payment.disputed"}).encode()
    ev = provider.verify_webhook(other, sign_callback(other))
    ok("an unknown event type is parsed but not supported", ev.supported is False)


# ===========================================================================
# 5. Provider selection — the live Razorpay flow must be untouched
# ===========================================================================
def test_provider_selection():
    print("\nProvider selection")
    import app.config as app_config
    from app.services import payments as payment_providers

    settings = app_config.settings
    saved = {
        "provider": settings.payment_provider,
        "env": settings.payment_environment,
        "pilot": getattr(settings, "trustbrick_pilot_booking_refs", ""),
        "base": getattr(settings, "trustbrick_base_url", None),
        "key": getattr(settings, "trustbrick_key_id", None),
        "secret": getattr(settings, "trustbrick_secret", None),
        "cb": getattr(settings, "trustbrick_callback_secret", None),
    }
    try:
        settings.payment_provider = "mock"
        settings.payment_environment = "test"
        settings.trustbrick_base_url = BASE_URL
        settings.trustbrick_key_id = KEY_ID
        settings.trustbrick_secret = SECRET
        settings.trustbrick_callback_secret = CALLBACK_SECRET
        settings.trustbrick_pilot_booking_refs = ""
        payment_providers.reset_provider_cache()

        # --- no pilot: nothing changes -------------------------------------
        ok("with no pilot, selection returns the configured provider",
           payment_providers.get_provider_for_booking("JPP000123").name == "mock")
        ok("with no pilot, an unrelated booking is unaffected",
           payment_providers.get_provider_for_booking("JPP999999").name == "mock")

        # --- TrustBrick resolvable by name regardless ----------------------
        ok("trustbrick resolves by name while another provider is configured",
           payment_providers.get_provider_named("trustbrick").name == "trustbrick")
        ok("the configured provider still resolves by its own name",
           payment_providers.get_provider_named("mock").name == "mock")

        # --- one pilot booking ---------------------------------------------
        settings.trustbrick_pilot_booking_refs = "JPP000123"
        payment_providers.reset_provider_cache()
        ok("a pilot booking routes to trustbrick",
           payment_providers.get_provider_for_booking("JPP000123").name == "trustbrick")
        ok("every other booking still uses the configured provider",
           payment_providers.get_provider_for_booking("JPP000999").name == "mock")
        ok("pilot matching is case-insensitive",
           payment_providers.get_provider_for_booking("jpp000123").name == "trustbrick")

        # --- a pilot ref with TrustBrick unconfigured falls back ------------
        settings.trustbrick_secret = None
        payment_providers.reset_provider_cache()
        ok("a pilot booking falls back when trustbrick is unusable",
           payment_providers.get_provider_for_booking("JPP000123").name == "mock")
    finally:
        settings.payment_provider = saved["provider"]
        settings.payment_environment = saved["env"]
        settings.trustbrick_pilot_booking_refs = saved["pilot"]
        settings.trustbrick_base_url = saved["base"]
        settings.trustbrick_key_id = saved["key"]
        settings.trustbrick_secret = saved["secret"]
        settings.trustbrick_callback_secret = saved["cb"]
        payment_providers.reset_provider_cache()


def test_razorpay_path_untouched():
    """The existing Razorpay adapter and its selection must be unchanged."""
    print("\nExisting Razorpay flow")
    import app.config as app_config
    from app.services import payments as payment_providers

    settings = app_config.settings
    saved = (settings.payment_provider, settings.payment_environment,
             getattr(settings, "trustbrick_pilot_booking_refs", ""))
    try:
        settings.payment_provider = "mock"
        settings.payment_environment = "test"
        settings.trustbrick_pilot_booking_refs = ""
        payment_providers.reset_provider_cache()
        primary = payment_providers.get_provider()
        ok("get_provider() still returns the configured provider",
           primary.name == "mock", primary.name)
        ok("get_provider_for_booking agrees with get_provider by default",
           payment_providers.get_provider_for_booking("JPP000123").name == primary.name)
        ok("an unknown provider name is still refused",
           _raises(payment_providers.get_provider_named, "cashfree"))
    finally:
        (settings.payment_provider, settings.payment_environment,
         settings.trustbrick_pilot_booking_refs) = saved
        payment_providers.reset_provider_cache()

    # The Razorpay adapter itself must not have been edited into this work.
    source = (ROOT / "backend/app/services/payments/razorpay_provider.py").read_text(
        encoding="utf-8"
    )
    ok("razorpay_provider.py contains no trustbrick reference",
       "trustbrick" not in source.lower())


def _raises(fn, *args) -> bool:
    try:
        fn(*args)
        return False
    except PaymentProviderError:
        return True


# ===========================================================================
# 6. The payment-config endpoint, asked about ONE booking
# ===========================================================================
def test_payment_config_is_booking_aware():
    """GET /api/customer/payments/config, with and without a booking.

    THE GAP THIS CLOSES. The endpoint answered "can any booking be paid?" and
    the checkout screen was asking "can THIS booking be paid?". With
    PAYMENT_PROVIDER unset those differ for exactly one case - a pilot booking -
    and the screen was hiding a Pay Now that would have worked.

    WHAT MUST NOT CHANGE. Without ``booking_ref`` the answer is what it has
    always been, and a booking with no special routing gets that same answer.
    TrustBrick never becomes globally available.
    """
    print("\nPayment config, booking-aware")
    import app.config as app_config
    from fastapi.testclient import TestClient

    from app.main import app as fastapi_app
    from app.services import payments as payment_providers

    settings = app_config.settings
    saved = {k: getattr(settings, k, None) for k in (
        "payment_provider", "payment_environment", "trustbrick_pilot_booking_refs",
        "trustbrick_base_url", "trustbrick_key_id", "trustbrick_secret",
        "trustbrick_callback_secret", "trustbrick_publishable_key",
    )}
    # Not used as a context manager on purpose: that would run the application's
    # lifespan, which starts the payment sweep and touches the database. This
    # endpoint takes no db dependency, so the plain client exercises it alone.
    client = TestClient(fastapi_app)
    PATH = "/api/customer/payments/config"

    def configure(*, provider, pilot="", trustbrick=True):
        settings.payment_provider = provider
        settings.payment_environment = "test"
        settings.trustbrick_pilot_booking_refs = pilot
        settings.trustbrick_base_url = BASE_URL if trustbrick else None
        settings.trustbrick_key_id = KEY_ID if trustbrick else None
        settings.trustbrick_secret = SECRET if trustbrick else None
        settings.trustbrick_callback_secret = CALLBACK_SECRET if trustbrick else None
        settings.trustbrick_publishable_key = "rzp_live_fromtrustbrick"
        payment_providers.reset_provider_cache()

    def ask(booking_ref=None):
        params = {"booking_ref": booking_ref} if booking_ref else None
        response = client.get(PATH, params=params)
        return response.status_code, response.json(), response.text

    try:
        # ---- production's current shape: payments off, no pilot -----------
        configure(provider="none", pilot="")
        status, body, _ = ask()
        ok("payments off: no booking_ref reports unconfigured",
           status == 200 and body["configured"] is False, f"{status} {body}")
        ok("payments off: provider is null", body["provider"] is None)
        ok("payments off: key_id is null", body["key_id"] is None)
        ok("payments off: currency still reported", body["currency"] == "INR")

        status, body, _ = ask("JPP000123")
        ok("payments off: a NON-pilot booking stays disabled",
           body["configured"] is False, str(body))

        # ---- one pilot booking, payments still off globally ---------------
        configure(provider="none", pilot="JPP000123")

        status, body, _ = ask()
        ok("pilot set: the GLOBAL answer is still unconfigured",
           body["configured"] is False, str(body))
        ok("pilot set: trustbrick is NOT globally available",
           body["provider"] is None, str(body["provider"]))

        status, body, raw = ask("JPP000123")
        ok("pilot booking reports configured", body["configured"] is True, str(body))
        ok("pilot booking names trustbrick", body["provider"] == "trustbrick",
           str(body["provider"]))
        ok("pilot booking returns the publishable key",
           body["key_id"] == "rzp_live_fromtrustbrick", str(body["key_id"]))

        # THE SECURITY ASSERTION. Checked against the raw response text, not the
        # parsed body, so a secret nested anywhere would still be caught.
        leaked = [name for name, value in (
            ("TRUSTBRICK_SECRET", SECRET),
            ("TRUSTBRICK_CALLBACK_SECRET", CALLBACK_SECRET),
        ) if value in raw]
        ok("no secret in the pilot response", not leaked, f"leaked {leaked}")
        ok("response carries only the four public fields",
           set(body) == {"configured", "provider", "key_id", "currency"}, str(set(body)))

        status, body, _ = ask("JPP999999")
        ok("a different booking is unaffected by the pilot",
           body["configured"] is False, str(body))
        ok("pilot matching is case-insensitive here too",
           ask("jpp000123")[1]["configured"] is True)

        # ---- a pilot ref with TrustBrick unconfigured ---------------------
        configure(provider="none", pilot="JPP000123", trustbrick=False)
        status, body, _ = ask("JPP000123")
        ok("pilot booking with trustbrick unconfigured stays disabled",
           body["configured"] is False, str(body))

        # ---- existing behaviour, unchanged --------------------------------
        configure(provider="mock", pilot="")
        status, body, raw = ask()
        ok("provider configured: unchanged without booking_ref",
           body["configured"] is True and body["provider"] == "mock", str(body))
        status, body2, _ = ask("JPP000123")
        ok("provider configured: a booking_ref changes nothing",
           body2 == body, f"{body2} vs {body}")

        # A pilot booking still overrides, even with another provider live.
        configure(provider="mock", pilot="JPP000123")
        ok("pilot overrides even when another provider is configured",
           ask("JPP000123")[1]["provider"] == "trustbrick")
        ok("...and every other booking keeps the configured provider",
           ask("JPP000999")[1]["provider"] == "mock")
    finally:
        for key, value in saved.items():
            setattr(settings, key, value)
        payment_providers.reset_provider_cache()


# ===========================================================================
def main() -> int:
    print("=" * 72)
    print("TrustBrick partner payment adapter")
    print("=" * 72)

    import app.services.payments.trustbrick_provider as adapter_module

    test_signing()

    for test in (test_fresh_nonce, test_create_checkout, test_error_classification,
                 test_fetch_and_reconcile):
        stub = StubTrustBrick()
        provider = build(stub, adapter_module)
        try:
            test(stub, provider)
        except Exception as exc:                            # noqa: BLE001
            results["fail"] += 1
            failures.append(f"{test.__name__} raised {type(exc).__name__}: {exc}")
            print(f"  ERROR {test.__name__}: {type(exc).__name__}: {exc}")
            import traceback
            traceback.print_exc()

    stub = StubTrustBrick()
    provider = build(stub, adapter_module)
    for test in (test_refund_refused, test_callback):
        try:
            test(provider)
        except Exception as exc:                            # noqa: BLE001
            results["fail"] += 1
            failures.append(f"{test.__name__} raised {type(exc).__name__}: {exc}")
            print(f"  ERROR {test.__name__}: {type(exc).__name__}: {exc}")
            import traceback
            traceback.print_exc()

    for test in (test_provider_selection, test_razorpay_path_untouched,
                 test_payment_config_is_booking_aware):
        try:
            test()
        except Exception as exc:                            # noqa: BLE001
            results["fail"] += 1
            failures.append(f"{test.__name__} raised {type(exc).__name__}: {exc}")
            print(f"  ERROR {test.__name__}: {type(exc).__name__}: {exc}")
            import traceback
            traceback.print_exc()

    print("\n" + "=" * 72)
    total = results["pass"] + results["fail"]
    print(f"{results['pass']}/{total} checks passed")
    if failures:
        print(f"\n{len(failures)} failure(s):")
        for line in failures:
            print(f"  - {line}")
    print("=" * 72)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
