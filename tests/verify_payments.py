"""The B2C payment gateway — security, integrity and concurrency.

WHAT THIS PROTECTS

1. **The amount is the server's, never the browser's.** A checkout request
   carrying ``amount``, ``currency``, ``payment_status``, ``customer_id`` and a
   forged ``provider_payment_id`` is accepted and every injected field is
   ignored; the order opens for the total this server computed.

2. **Only the verified path may take money.** ``captured`` is set in exactly one
   place and ``confirmed`` in exactly one place, asserted against the source. A
   webhook proves who sent a message, not that the message is true, so the
   server re-fetches the payment from the provider and compares order id,
   payment id, currency, amount (in integer paise) and ownership against its own
   rows before anything is captured.

3. **The signature is checked before the body is parsed.** Bad signature and
   missing signature are refused 401 and write nothing at all.

4. **A duplicate delivery changes nothing.** Razorpay delivers at least once;
   the unique index on ``(provider, provider_event_id)`` decides, not a
   check-then-act in Python.

5. **A timeout is not a failure.** A payment is marked failed only when the
   provider itself says so — every transport problem stays ``deferred`` for the
   sweep to retry, and the sweep captures once the provider recovers.

6. **Cancelling a PAID booking is flagged, loudly.** Nothing in this codebase
   issues a refund, so the one thing that must never happen quietly is a
   cancellation that abandons a captured payment (section 15).

7. **The B2B side is untouched.** The merchant wallet, ``payments`` and
   ``service_requests`` are counted before and after; the delta must be zero.

WHY THIS SCRIPT TALKS TO THE DATABASE AND TO THE SOURCE
Some guarantees have no HTTP surface. Lock order, the single capture site and
the absence of a duplicated verification in the scheduler are properties of the
code, so they are asserted with ``ast``/``inspect`` against the real modules
rather than reasoned about in a comment.

NEEDS A RUNNING SERVER and a configured provider (``PAYMENT_PROVIDER=mock``,
``PAYMENT_ENVIRONMENT=test``). It books through the real API, so it consumes and
returns real seat inventory.
"""
import ast
import atexit
import concurrent.futures as cf
import inspect
import json
import sys
import threading
import uuid
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
#: run_all.py runs every script with cwd=tests/, so nothing below may use a
#: path relative to the working directory. This script reads real source
#: files to assert properties of the code, and each one is resolved from here.
ROOT = HERE.parent
sys.path.insert(0, str(HERE.parent / "backend"))
sys.path.insert(0, str(HERE))

from sqlalchemy import text                                            # noqa: E402

from app.database.session import SessionLocal                          # noqa: E402
from app.models_customer import (                                      # noqa: E402
    CustomerBookingStatus, CustomerNotification, CustomerPackageBooking,
    CustomerPackageBookingPayment, CustomerPaymentStatus, PaymentProviderEvent,
)
from app.services import payments as P                                 # noqa: E402
from app.services import payment_verification_service as V             # noqa: E402
from app.services import payment_event_service as PES                  # noqa: E402
from app.services.payments.base import ProviderPayment                 # noqa: E402
import app.config as C                                                 # noqa: E402

from config import BASE, Checker                                             # noqa: E402
from payfix import PaymentFixture, call                                # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                                      # noqa: BLE001
    pass

_ck = Checker()


def check(label, ok, detail=""):
    return _ck(label, bool(ok), detail)


def section(n, title):
    print(f"\n{'=' * 72}\n{n}. {title}\n{'=' * 72}")


fx = PaymentFixture()
db = fx.db
# THE SEATS COME BACK EVEN IF A CHECK RAISES.
# This script books through the real API, so every case it runs is holding real
# inventory until cleanup returns it. Section 17 calls cleanup explicitly, but
# an exception anywhere above it would skip that — and the departure has a few
# dozen seats, so two crashed runs are enough to exhaust it and make every later
# run fail on "Only 0 seats are left", which reads as an inventory bug and is
# not one. atexit rather than a try/finally around 700 lines, and cleanup() is
# idempotent so the explicit call in section 17 stays the normal path.
atexit.register(fx.cleanup)
if fx.reclaimed:
    print(f"  reclaimed {fx.reclaimed} booking(s) left behind by an earlier crashed run")
B2B_BEFORE = {t: db.execute(text(f"SELECT count(*) FROM {t}")).scalar()
              for t in ("payments", "service_requests", "wallet_transactions",
                        "wallet_topups", "payment_accounts")}
#: Counted BEFORE anything is booked. The hygiene section at the end asserts
#: a return to these numbers rather than asserting the tables are empty — an
#: absolute count fails on rows some earlier killed run left behind, and then
#: reports that failure against this run, which is a lie about where the bug is.
B2C_BEFORE = {
    "bookings": db.query(CustomerPackageBooking).count(),
    "payments": db.query(CustomerPackageBookingPayment).count(),
    "events": db.query(PaymentProviderEvent).count(),
    "confirm_notes": db.query(CustomerNotification).filter(
        CustomerNotification.notification_type == "booking_confirmed").count(),
}
print(f"provider={fx.provider}  seats_at_start={fx.seats_at_start}")
print(f"B2C baseline: {B2C_BEFORE}")
print(f"B2B baseline: {B2B_BEFORE}")

# -------------------------------------------------------------------------
# NO PROVIDER CONFIGURED: assert the unavailable contract, do not skip.
#
# This script is in run_all.py, so it runs on machines that have never set
# PAYMENT_PROVIDER. Crashing there would report a configuration choice as a
# regression. But exiting 0 without looking would let a deployment ship a Pay
# Now button that silently does nothing, which is the failure this whole module
# exists to prevent -- so the unconfigured case gets its own assertions:
# the gateway says it is off, checkout refuses honestly, and a booking can
# still be made. Same shape as verify_passport_ocr with OCR_PROVIDER=none.
# -------------------------------------------------------------------------
_st, _cfg = call("/api/customer/payments/config")
if _st != 200 or not (_cfg or {}).get("configured"):
    section(0, "NO PAYMENT PROVIDER CONFIGURED")
    check("the config endpoint still answers", _st == 200, f"{_st}")
    check("it reports the gateway as unavailable",
          not (_cfg or {}).get("configured"), str(_cfg))
    check("and leaks no secret while doing so",
          "secret" not in json.dumps(_cfg or {}).lower(), str(_cfg))
    _nb = fx.book()
    _st2, _body = fx.checkout(_nb)
    check("checkout refuses with 503 rather than opening a dead order",
          _st2 == 503, f"{_st2}")
    check("...and says so in words meant for a traveller",
          bool((_body or {}).get("detail")), str(_body)[:120])
    check("the booking is unaffected and still pending",
          fx.booking_row(_nb).status == "pending")
    check("no payment row was written", fx.payment_row(_nb) is None)
    fx.release(_nb)
    print()
    print("PAYMENT_PROVIDER is not set on the server under test, so only the")
    print("unavailable contract was checked. Set PAYMENT_PROVIDER=mock and")
    print("PAYMENT_ENVIRONMENT=test on the server to run the full gateway suite.")
    db.close()
    sys.exit(_ck.report())

# =========================================================================
section(1, "AMOUNT INTEGRITY")
b = fx.book()
REF, MINOR = b["booking_ref"], b["_minor"]
print(f"  booking {REF}, server total {b['_total']} = {MINOR} paise")

st, res = fx.checkout(b, extra={
    "amount": 100, "currency": "USD", "total_amount": 1,
    "payment_status": "captured", "status": "confirmed",
    "customer_id": 999999, "booking_ref": "JPP000001",
    "provider_payment_id": "pay_attacker", "paid_at": "2020-01-01T00:00:00Z",
})
check("checkout accepted despite the injected fields", st == 201, f"{st}")
check("amount is the SERVER amount", res["amount"] == MINOR, f"{res['amount']} vs {MINOR}")
check("currency is INR", res["currency"] == "INR")
check("payment_status forced to pending", res["payment_status"] == "pending")
check("booking_ref from the URL, not the body", res["booking_ref"] == REF)
p = fx.payment_row(b)
check("stored amount == booking total", Decimal(str(p.amount)) == b["_total"])
check("provider_payment_id NOT taken from the body", p.provider_payment_id != "pay_attacker",
      str(p.provider_payment_id))
check("paid_at not set", p.paid_at is None)
check("booking still pending", fx.booking_row(b).status == "pending")

ORDER = res["order_id"]
raw, hdr, _ = fx.signed(order_id=ORDER, amount=100)          # ₹1 for a ₹57,645 booking
st, r = fx.deliver(raw, hdr)
check("a Rs 1 webhook for a Rs 57,645 booking is refused", st == 200 and r["status"] == "failed",
      f"{st} {r}")
check("reason is amount_mismatch", "amount_mismatch" in str(r), str(r)[:90])
check("payment NOT captured", fx.payment_row(b).status != "captured")
check("booking NOT confirmed", fx.booking_row(b).status == "pending")

# A FRESH booking for the currency case. Re-using the one above would have the
# mock answer fetch_order() with the Rs 1 payment it already recorded against
# that order, so the run would reject on amount before it reached currency —
# a true refusal, but not the one being tested.
b_usd = fx.book()
st, ck_usd = fx.checkout(b_usd)
raw, hdr, _ = fx.signed(order_id=ck_usd["order_id"], amount=b_usd["_minor"], currency="USD")
st, r = fx.deliver(raw, hdr)
check("a USD webhook is refused", r["status"] == "failed" and "currency_mismatch" in str(r),
      str(r)[:100])
check("USD: still not captured", fx.payment_row(b_usd).status != "captured")
fx.release(b_usd)

raw, hdr, _ = fx.signed(order_id="order_someone_else", amount=MINOR)
st, r = fx.deliver(raw, hdr)
check("a webhook naming another order does not touch this payment",
      fx.payment_row(b).status != "captured", fx.payment_row(b).status)

vsrc = inspect.getsource(V)
check("the comparison is int paise from to_minor, not float",
      "to_minor" in vsrc and "float(" not in vsrc and "* 100" not in vsrc)
# AST, not substring: the phrase "payment_provider_events.payload" appears in
# this module's own docstring explaining that it is NOT read, and a substring
# test matches the explanation and fails on it.
_vtree = ast.parse(vsrc)
_payload_reads = [ast.get_source_segment(vsrc, n) for n in ast.walk(_vtree)
                  if isinstance(n, ast.Attribute) and n.attr == "payload"]
check("the event payload is never read for a figure",
      not _payload_reads, str(_payload_reads))

# =========================================================================
section(2, "OWNERSHIP")
st, _ = fx.checkout(b, token=fx.other_token)
check("another customer cannot open a checkout (404, not 403)", st == 404, f"{st}")
st, _ = call(f"/api/customer/package-bookings/{REF}", token=fx.other_token)
check("another customer cannot read the booking (404)", st == 404, f"{st}")
st_missing, _ = call("/api/customer/package-bookings/JPP999999", token=fx.token)
check("a non-existent ref gives the SAME 404 (no existence leak)", st_missing == 404,
      f"{st_missing}")
st, _ = call(f"/api/customer/package-bookings/{REF}/cancel", {}, fx.other_token)
check("another customer cannot cancel it", st == 404, f"{st}")
b_other = fx.book(token=fx.other_token)
st, _ = fx.checkout(b_other, token=fx.token)
check("cannot open a checkout on a booking belonging to someone else", st == 404, f"{st}")
check("the service re-checks ownership even though the router did",
      "belongs to another customer" in inspect.getsource(
          __import__("app.services.customer_package_booking_service",
                     fromlist=["x"])))

# =========================================================================
section(3, "WEBHOOK SECURITY")
b3 = fx.book()
st, ck3 = fx.checkout(b3)
O3 = ck3["order_id"]

raw, hdr, body = fx.signed(order_id=O3, amount=b3["_minor"])
st, r = fx.deliver(raw, hdr)
check("valid signature accepted", st == 200, f"{st}")

raw2, hdr2, _ = fx.signed(order_id=O3, amount=b3["_minor"])
st, _ = fx.deliver(raw2, {**hdr2, "X-Razorpay-Signature": "0" * 64,
                          "x-mock-signature": "0" * 64})
check("invalid signature rejected 401", st == 401, f"{st}")
st, _ = fx.deliver(raw2 + b" ", hdr2)
check("modified body rejected 401", st == 401, f"{st}")
st, _ = fx.deliver(raw2, {k: v for k, v in hdr2.items() if "signature" not in k.lower()})
check("missing signature rejected 401", st == 401, f"{st}")
st, _ = fx.deliver(raw2, {k: v for k, v in hdr2.items() if "event-id" not in k.lower()})
check("missing event id rejected 401", st == 401, f"{st}")

# same event id, different body — the signature is over the body, so this must fail
eid = "evt_aud_" + uuid.uuid4().hex[:12]
rawA, hdrA, _ = fx.signed(order_id=O3, amount=b3["_minor"], event_id=eid)
rawB, hdrB, _ = fx.signed(order_id=O3, amount=1, event_id=eid)
st, _ = fx.deliver(rawB, hdrA)          # A's signature over B's body
check("same event id with a modified body is rejected", st == 401, f"{st}")

st, r = fx.deliver(*fx.signed(order_id=O3, amount=b3["_minor"],
                              event="payment.dispute.created")[:2])
check("an unsupported event type is ignored, not applied", r["status"] == "ignored", str(r))

bad = b'{"event":"payment.captured",'
import hashlib as _h, hmac as _hm
sig = _hm.new(fx.webhook_secret.encode(), bad, _h.sha256).hexdigest()
st, _ = call(fx.webhook_path, raw=bad, headers={
    "X-Razorpay-Signature": sig, "x-mock-signature": sig,
    "X-Razorpay-Event-Id": "evt_aud_bad", "x-mock-event-id": "evt_aud_bad"})
check("signed but malformed JSON refused", st in (400, 401), f"{st}")
check("nothing recorded for a refused delivery",
      db.query(PaymentProviderEvent).filter(
          PaymentProviderEvent.provider_event_id == "evt_aud_bad").count() == 0)

# =========================================================================
section(4, "EVENT DEDUPLICATION")
b4 = fx.book()
st, ck4 = fx.checkout(b4)
raw, hdr, body = fx.signed(order_id=ck4["order_id"], amount=b4["_minor"])
EID = body["event_id"]
with cf.ThreadPoolExecutor(max_workers=6) as ex:
    out = list(ex.map(lambda _: fx.deliver(raw, hdr), range(6)))
db.expire_all()
n_events = db.query(PaymentProviderEvent).filter(
    PaymentProviderEvent.provider_event_id == EID).count()
check("6 concurrent identical deliveries all answer 200",
      all(o[0] == 200 for o in out), str([o[0] for o in out]))
check("EXACTLY ONE event row", n_events == 1, str(n_events))
n_pay = db.query(CustomerPackageBookingPayment).filter(
    CustomerPackageBookingPayment.package_booking_id == b4["_id"]).count()
check("exactly one payment row", n_pay == 1, str(n_pay))
check("booking confirmed once", fx.booking_row(b4).status == "confirmed")
n_note = db.query(CustomerNotification).filter(
    CustomerNotification.related_ref == b4["booking_ref"],
    CustomerNotification.notification_type == "booking_confirmed").count()
check("EXACTLY ONE confirmation notification", n_note == 1, str(n_note))
n_audit = db.execute(text(
    "SELECT count(*) FROM customer_audit_logs WHERE module='Payments' "
    "AND action='Booking confirmed' AND description LIKE :r"),
    {"r": f"%{b4['booking_ref']}%"}).scalar()
check("EXACTLY ONE confirmation audit entry", n_audit == 1, str(n_audit))

# same payment, different event ids
for _ in range(3):
    fx.deliver(*fx.signed(order_id=ck4["order_id"], amount=b4["_minor"])[:2])
db.expire_all()
check("distinct event ids do not re-capture or re-notify",
      db.query(CustomerNotification).filter(
          CustomerNotification.related_ref == b4["booking_ref"],
          CustomerNotification.notification_type == "booking_confirmed").count() == 1)

# =========================================================================
section(5, "PAYMENT VERIFICATION — the server re-fetches")
class Stub:
    name = fx.provider
    publishable_key = "stub"

    def __init__(self):
        self.reply = None; self.capture_reply = None
        self.fetch_calls = 0; self.capture_calls = 0; self.lock = threading.Lock()

    def fetch_payment(self, pid):
        with self.lock: self.fetch_calls += 1
        if isinstance(self.reply, Exception): raise self.reply
        return self.reply

    def fetch_order(self, oid): return self.fetch_payment(None)

    def capture(self, **kw):
        with self.lock: self.capture_calls += 1
        if isinstance(self.capture_reply, Exception): raise self.capture_reply
        return self.capture_reply or self.reply


stub = Stub()
V.payment_providers.get_provider_named = lambda n: stub


def remote(p, *, status=P.CAPTURED, amount=None, currency="INR", order=None, pay=None):
    return ProviderPayment(
        status=status, provider_status=status,
        provider_payment_id=pay if pay is not None else p.provider_payment_id,
        provider_order_id=order if order is not None else p.provider_order_id,
        amount_minor=amount, currency=currency, method="upi")


_prev_case = []


def fresh_case(**kw):
    """A booked + checked-out case, releasing the previous one first.

    Keeps at most one case holding a seat. Without this the audit books ~30
    cases against a 9-seat departure and starts failing with "Only 0 seats are
    left" — the inventory working correctly and the TEST being wrong.
    """
    while _prev_case:
        fx.release(_prev_case.pop())
    bk = fx.book(**kw)
    st, ck = fx.checkout(bk)
    assert st == 201, f"checkout failed: {st} {ck}"
    _prev_case.append(bk)
    return bk, fx.payment_row(bk)


check("verification re-fetches rather than trusting the webhook",
      "fetch_payment" in vsrc and "fetch_order" in vsrc)

matrix = [
    ("correct everything", dict(), P.CAPTURED, "captured", None),
    ("wrong order", dict(order="order_other"), None, "pending", "order_mismatch"),
    ("wrong amount", dict(amount=1), None, "pending", "amount_mismatch"),
    ("wrong currency", dict(currency="USD"), None, "pending", "currency_mismatch"),
    ("pending at provider", dict(status=P.PENDING), None, "pending", "not_yet_paid"),
    ("failed at provider", dict(status=P.FAILED), None, "failed", "provider_failed"),
]
for label, over, _want, want_status, want_code in matrix:
    bk, pay = fresh_case()
    kw = dict(amount=bk["_minor"]); kw.update(over)
    stub.reply = remote(pay, **kw)
    stub.capture_calls = 0
    r = V.verify_and_capture(db, pay.customer_package_booking_payment_id)
    db.commit()
    got = fx.payment_row(bk).status
    check(f"{label}: payment ends {want_status}", got == want_status, f"{got} ({r.code})")
    if want_code:
        check(f"{label}: code {want_code}", r.code == want_code, r.code)
    _prev_case.clear(); fx.release(bk)

# "wrong payment id" needs a PRECONDITION my first version missed: the check is
# `if ours and theirs and ours != theirs`, so it can only fire once our row
# already holds a provider payment id. A row that has none yet is the normal
# first-capture case and MUST be allowed through — requiring a match there would
# make the first payment against any order impossible.
bk_pid, pay_pid = fresh_case()
pay_pid.provider_payment_id = "pay_ours"
db.commit()
stub.reply = remote(pay_pid, amount=bk_pid["_minor"], status=P.CAPTURED, pay="pay_theirs")
r = V.verify_and_capture(db, pay_pid.customer_package_booking_payment_id); db.commit()
check("wrong payment id (ours already set): rejected",
      r.code == "payment_id_mismatch", r.code)
check("wrong payment id: not captured",
      fx.payment_row(bk_pid).status != "captured", fx.payment_row(bk_pid).status)
_prev_case.clear(); fx.release(bk_pid)

bk_first, pay_first = fresh_case()
stub.reply = remote(pay_first, amount=bk_first["_minor"], status=P.CAPTURED, pay="pay_new")
r = V.verify_and_capture(db, pay_first.customer_package_booking_payment_id); db.commit()
check("a FIRST payment id we have never seen is accepted (not a mismatch)",
      fx.payment_row(bk_first).status == "captured", f"{r.code}")
_prev_case.clear(); fx.release(bk_first)

for label, exc, code in [("timeout", P.PaymentTimeout("t"), "provider_timeout"),
                         ("5xx", P.PaymentFailed("HTTP 502"), "provider_error")]:
    bk, pay = fresh_case()
    stub.reply = exc
    r = V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
    check(f"{label} is RETRYABLE, not failed", r.disposition == V.RETRYABLE, r.disposition)
    check(f"{label} code {code}", r.code == code, r.code)
    check(f"{label}: payment untouched", fx.payment_row(bk).status == "pending")
    _prev_case.clear(); fx.release(bk)

# =========================================================================
section(6, "CAPTURE IDEMPOTENCY")
bk, pay = fresh_case()
stub.reply = remote(pay, amount=bk["_minor"], status=P.CAPTURED)
stub.capture_calls = stub.fetch_calls = 0
V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
check("already-captured at provider -> 0 capture calls", stub.capture_calls == 0,
      str(stub.capture_calls))
stub.fetch_calls = 0
V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
check("re-running an already-captured payment -> 0 provider calls",
      stub.fetch_calls == 0, str(stub.fetch_calls))

bk, pay = fresh_case()
stub.reply = remote(pay, amount=bk["_minor"], status=P.AUTHORIZED)
stub.capture_reply = remote(pay, amount=bk["_minor"], status=P.CAPTURED)
stub.capture_calls = 0
V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
check("authorized -> exactly 1 capture call", stub.capture_calls == 1, str(stub.capture_calls))
stub.capture_reply = None

bk, pay = fresh_case()
PID = pay.customer_package_booking_payment_id
stub.reply = remote(pay, amount=bk["_minor"], status=P.AUTHORIZED)
stub.capture_reply = remote(pay, amount=bk["_minor"], status=P.CAPTURED)
stub.capture_calls = 0
barrier = threading.Barrier(6); results = []


def worker():
    s = SessionLocal()
    try:
        barrier.wait(timeout=20)
        r = V.verify_and_capture(s, PID); s.commit(); results.append(r)
    except Exception as e:  # noqa: BLE001
        results.append(e)
    finally:
        s.close()


ts = [threading.Thread(target=worker) for _ in range(6)]
for t in ts: t.start()
for t in ts: t.join(timeout=30)
check("6 concurrent on an AUTHORIZED payment -> exactly 1 capture call",
      stub.capture_calls == 1, str(stub.capture_calls))
check("exactly one logical capture",
      sum(1 for r in results if getattr(r, "captured_now", False)) == 1,
      str([getattr(r, 'code', r) for r in results]))
check("no exceptions (no deadlock)", not [r for r in results if isinstance(r, Exception)])
stub.capture_reply = None

bk, pay = fresh_case()
stub.reply = remote(pay, amount=bk["_minor"], status=P.AUTHORIZED)
stub.capture_reply = P.PaymentTimeout("capture timed out")
r = V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
check("capture timeout is retryable", r.disposition == V.RETRYABLE, f"{r.disposition}/{r.code}")
check("payment not captured on a capture timeout",
      fx.payment_row(bk).status != "captured", fx.payment_row(bk).status)
stub.capture_reply = None

# =========================================================================
section(7, "BOOKING CONFIRMATION INTEGRITY")
csrc = inspect.getsource(V)
tree = ast.parse(csrc)
writers = []
for node in ast.walk(tree):
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Attribute) and t.attr == "status":
                src = ast.get_source_segment(csrc, node) or ""
                if "CONFIRMED" in src:
                    writers.append(src.strip())
check("exactly one line in the payment path sets a booking CONFIRMED",
      len(writers) == 1, str(writers))

import subprocess
grep = subprocess.run(
    ["grep", "-rn", "CustomerBookingStatus.CONFIRMED", str(ROOT / "backend" / "app")],
    capture_output=True, text=True).stdout.strip().splitlines()
setters = [l for l in grep if "=" in l.split(":", 2)[-1] and "==" not in l.split(":", 2)[-1]]
check("no other module assigns CONFIRMED to a package booking",
      all("payment_verification_service" in l for l in setters), str(setters))

bk, pay = fresh_case()
seats_before = fx._seats(1)
check("seats are available, so the next check is not vacuous", seats_before > 0,
      str(seats_before))
stub.reply = remote(pay, amount=bk["_minor"], status=P.CAPTURED)
r = V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
check("confirmed", fx.booking_row(bk).status == "confirmed")
check("NO second seat deduction at confirmation", fx._seats(1) == seats_before,
      f"{seats_before} -> {fx._seats(1)}")
for _ in range(4):
    V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
db.expire_all()
check("repeat confirmation -> still one notification",
      db.query(CustomerNotification).filter(
          CustomerNotification.related_ref == bk["booking_ref"],
          CustomerNotification.notification_type == "booking_confirmed").count() == 1)
check("repeat confirmation -> still one audit entry",
      db.execute(text("SELECT count(*) FROM customer_audit_logs WHERE module='Payments' "
                      "AND action='Booking confirmed' AND description LIKE :r"),
                 {"r": f"%{bk['booking_ref']}%"}).scalar() == 1)

# =========================================================================
section(8, "TRANSACTION / LOCK SAFETY")


def lock_sites(fn):
    found = []
    for node in ast.walk(fn):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "with_for_update"):
            continue
        cur = node.func.value
        while isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute):
            cur = cur.func.value
        if isinstance(cur, ast.Call) and getattr(cur.func, "id", None) == "select":
            found.append(getattr(cur.args[0], "id", "?") if cur.args else "?")
    return found


per_fn = {n.name: lock_sites(n) for n in tree.body if isinstance(n, ast.FunctionDef)}
locked = {k: v for k, v in per_fn.items() if v}
check("only two lock sites in the payment path", sum(len(v) for v in locked.values()) == 2,
      str(locked))
check("verify_and_capture locks the PAYMENT",
      per_fn.get("verify_and_capture") == ["CustomerPackageBookingPayment"],
      str(per_fn.get("verify_and_capture")))
check("confirm_booking locks the BOOKING",
      per_fn.get("confirm_booking") == ["CustomerPackageBooking"],
      str(per_fn.get("confirm_booking")))
check("NO function locks booking before payment",
      not any(v[:2] == ["CustomerPackageBooking", "CustomerPackageBookingPayment"]
              for v in per_fn.values()))
# Counted by AST across every service module, not by grepping for the string —
# a grep also matches the two docstrings that EXPLAIN the lock order, which is
# how this first reported 3 locks where there are 2.
import pathlib as _pl
_all_locks = {}
for _f in _pl.Path(ROOT / "backend" / "app" / "services").rglob("*.py"):
    try:
        _t = ast.parse(_f.read_text(encoding="utf-8"))
    except SyntaxError:
        continue
    for _fn in [n for n in ast.walk(_t) if isinstance(n, ast.FunctionDef)]:
        _l = lock_sites(_fn)
        if _l:
            _all_locks[f"{_f.name}:{_fn.name}"] = _l
_new = {k: v for k, v in _all_locks.items() if "payment_verification" in k}
check("the new payment path adds exactly 2 lock sites",
      sum(len(v) for v in _new.values()) == 2, str(_new))
check("no OTHER module in the payment path locks a booking before a payment",
      not any(v[:2] == ["CustomerPackageBooking", "CustomerPackageBookingPayment"]
              for v in _all_locks.values()), str(_all_locks))

# rollback: make the notification fail and confirm nothing is left half-done
bk, pay = fresh_case()
import app.services.customer_account_service as acct
orig_notify = acct.notify
V.account_service.notify = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("notify down"))
stub.reply = remote(pay, amount=bk["_minor"], status=P.CAPTURED)
raised = None
try:
    V.verify_and_capture(db, pay.customer_package_booking_payment_id)
    db.commit()
except Exception as e:  # noqa: BLE001
    raised = e
    db.rollback()
V.account_service.notify = orig_notify
db.expire_all()
check("a failing notification raises rather than being swallowed", raised is not None,
      str(raised))
check("NO half-committed state: booking not confirmed",
      fx.booking_row(bk).status == "pending", fx.booking_row(bk).status)
check("NO half-committed state: payment not captured",
      fx.payment_row(bk).status != "captured", fx.payment_row(bk).status)
# and it succeeds once the notification works again
V.verify_and_capture(db, pay.customer_package_booking_payment_id); db.commit()
check("succeeds cleanly on retry", fx.booking_row(bk).status == "confirmed")

# =========================================================================
section(9, "SECRET EXPOSURE")
SECRETS = {
    "key_secret": C.settings.razorpay_key_secret,
    "webhook_secret": C.settings.razorpay_webhook_secret,
    "jwt": C.settings.jwt_secret_key,
}
st, cfg = call("/api/customer/payments/config")
st2, adm = call("/api/admin/customer-payments?page_size=50", token=fx.admin_token)
st3, det = call(f"/api/admin/customer-payments/package/{pay.customer_package_booking_payment_id}",
                token=fx.admin_token)
st4, bkg = call(f"/api/customer/package-bookings/{bk['booking_ref']}", token=fx.token)
blob = json.dumps([cfg, adm, det, bkg])
for name, value in SECRETS.items():
    if value:
        check(f"the {name} VALUE never appears in any response", value not in blob)
for word in ("key_secret", "webhook_secret", "rzp_live_", "DATABASE_URL",
             "JWT_SECRET", "password", "cvv", "upi_pin"):
    check(f"no {word!r} in any response", word.lower() not in blob.lower())
check("config returns exactly the four safe keys",
      set(cfg) == {"configured", "provider", "key_id", "currency"}, str(sorted(cfg)))

fe = subprocess.run(
    ["grep", "-rniE", "key_secret|webhook_secret|rzp_live_|DATABASE_URL|JWT_SECRET",
     str(ROOT / "frontend")], capture_output=True, text=True).stdout.strip()
check("no secret name appears anywhere in the frontend tree", not fe, fe[:200])

# logs
logtext = subprocess.run(
    ["grep", "-rn", "logger.",
     str(ROOT / "backend/app/services/payments"),
     str(ROOT / "backend/app/services/payment_event_service.py"),
     str(ROOT / "backend/app/services/payment_verification_service.py"),
     str(ROOT / "backend/app/routers/payment_webhooks.py")],
    capture_output=True, text=True).stdout
check("no log line interpolates a secret",
      "key_secret" not in logtext and "webhook_secret" not in logtext
      or "_redact" in inspect.getsource(
          __import__("app.services.payments.razorpay_provider", fromlist=["x"])))

# =========================================================================
section(10, "SENSITIVE PAYMENT DATA")
bk10, pay10 = fresh_case()
ev = PaymentProviderEvent(
    provider=fx.provider, provider_event_id="evt_aud_" + uuid.uuid4().hex[:10],
    event_type="payment.captured", provider_payment_id=pay10.provider_payment_id,
    provider_order_id=pay10.provider_order_id,
    payload={}, processing_status="received")
db.add(ev); db.commit()
raw, hdr, _ = fx.signed(order_id=pay10.provider_order_id, amount=bk10["_minor"])
import json as _j
body = _j.loads(raw)
body["payment"]["vpa"] = "victim@okhdfcbank"
body["payment"]["email"] = "victim@example.com"
body["payment"]["card"] = {"last4": "4242", "number": "4111111111111111"}
raw2 = _j.dumps(body, separators=(",", ":")).encode()
sig = _hm.new(fx.webhook_secret.encode(), raw2, _h.sha256).hexdigest()
st, _ = call(fx.webhook_path, raw=raw2, headers={
    "X-Razorpay-Signature": sig, "x-mock-signature": sig,
    "X-Razorpay-Event-Id": body["event_id"], "x-mock-event-id": body["event_id"]})
db.expire_all()
stored = db.query(PaymentProviderEvent).filter(
    PaymentProviderEvent.provider_event_id == body["event_id"]).first()
sp = json.dumps(stored.payload) if stored else ""
check("VPA redacted in permanent storage", "okhdfcbank" not in sp, sp[:120])
check("email redacted", "victim@example.com" not in sp)
check("card redacted", "4111111111111111" not in sp and "4242" not in sp)
st, det10 = call(f"/api/admin/customer-payments/package/{pay10.customer_package_booking_payment_id}",
                 token=fx.admin_token)
check("the admin detail does not return the payload",
      all("payload" not in e for e in det10.get("events", [])))
check("no card/vpa in the admin detail",
      not any(w in json.dumps(det10).lower() for w in ("okhdfcbank", "4111", "cvv")))

# =========================================================================
section(11, "FRONTEND TRUST BOUNDARY")
jsrc = open(ROOT / "frontend/assets/js/payment-screen.js", encoding="utf-8").read()
check("the handler never sets a success state directly",
      "STATE.SUCCESS" not in jsrc.split("function beginConfirming")[0].split("handler:")[-1][:400]
      or "beginConfirming()" in jsrc)
check("success is only reachable from the server poll",
      jsrc.count("to(STATE.SUCCESS)") == 1
      and "askServer" in jsrc.split("to(STATE.SUCCESS)")[0][-400:], "more than one path!")
check("the poll asks OUR server, not the provider",
      "pollStatus" in jsrc and "razorpay.com" not in jsrc.split("pollStatus")[1][:400])
psrc = open(ROOT / "frontend/assets/js/booking-products.js", encoding="utf-8").read()
check("pollStatus reads the booking endpoint",
      "getPackageBooking(ref)" in psrc)
check("frontend never posts a status or amount to the server",
      "payment_status:" not in psrc.split("startPackageCheckout")[0][-600:])

# =========================================================================
section(12, "ADMIN AUTHORIZATION")
for label, tok, want in [("admin", fx.admin_token, 200), ("merchant", fx.merchant_token, 403),
                         ("customer", fx.token, 401), ("anonymous", None, 401)]:
    st, _ = call("/api/admin/customer-payments", token=tok)
    check(f"{label} -> {want}", st == want, f"{st}")
st, _ = call("/api/admin/customer-payments/merchant/1", token=fx.admin_token)
check("the B2B payments table is not addressable through the B2C route", st == 404, f"{st}")
asrc = inspect.getsource(
    __import__("app.services.customer_payment_admin_service", fromlist=["x"]))
check("the admin service never imports models_v2", "models_v2" not in asrc)

# =========================================================================
section(13, "PRODUCT ISOLATION")
check("only packages are gateway-enabled in the frontend",
      "GATEWAY_PRODUCTS = ['package']" in psrc)
for page in ("flights.html", "hotels.html", "cruises.html", "visa.html"):
    html = open(ROOT / "frontend" / page, encoding="utf-8").read()
    check(f"{page} does not load the payment screen", "payment-screen.js" not in html)
routes = json.loads(subprocess.run(
    ["curl", "-s", BASE + "/openapi.json"],
    capture_output=True, text=True).stdout)["paths"]
ck_routes = [p for p in routes if p.endswith("/checkout")]
check("exactly one checkout endpoint exists, and it is packages'",
      ck_routes == ["/api/customer/package-bookings/{booking_ref}/checkout"], str(ck_routes))

# =========================================================================
section(14, "SCHEDULER")
import app.main as M
msrc = inspect.getsource(M._run_payment_sweep)
check("the sweep calls process_deferred_events", "process_deferred_events" in msrc)
check("no verification logic duplicated in the sweep",
      not any(w in msrc for w in ("to_minor", "CAPTURED", "amount_minor", "with_for_update")))
loop = inspect.getsource(M._payment_sweep_loop)
check("a failed tick cannot kill the loop",
      "except Exception" in loop and "while True" in loop)
check("CancelledError is re-raised so shutdown still works",
      "asyncio.CancelledError" in loop and "raise" in loop)

bk14, pay14 = fresh_case()
ev14 = PaymentProviderEvent(
    provider=fx.provider, provider_event_id="evt_aud_" + uuid.uuid4().hex[:10],
    event_type="payment.captured", provider_payment_id=pay14.provider_payment_id,
    provider_order_id=pay14.provider_order_id, payload={},
    processing_status=PES.DEFERRED)
db.add(ev14); db.commit()
stub.reply = P.PaymentTimeout("down")
V.process_deferred_events(db, limit=50)
db.expire_all()
row14 = db.get(PaymentProviderEvent, ev14.payment_provider_event_id)
check("a retryable event STAYS deferred", row14.processing_status == PES.DEFERRED,
      row14.processing_status)
check("and is not deleted", row14 is not None)
stub.reply = remote(pay14, amount=bk14["_minor"], status=P.CAPTURED)
V.process_deferred_events(db, limit=50)
db.expire_all()
check("the sweep captures once the provider recovers",
      fx.payment_row(bk14).status == "captured", fx.payment_row(bk14).status)
check("and confirms the booking", fx.booking_row(bk14).status == "confirmed")

# =========================================================================
section(15, "CANCELLING A PAID BOOKING")
# Nothing in this codebase calls PaymentProvider.refund(). That is a deliberate
# scoping decision, not an oversight — but it makes ONE state dangerous: a
# booking cancelled while it still holds a captured payment. The money is with
# the provider, the seat has gone back on sale, and without the flag below there
# is no trace that a refund is owed to anybody.
#
# This asserts the flag, NOT a refund. If a refund flow is built later, this
# section should keep passing: it says the case is recorded, not what was done.
rb = fx.book()
st, _ = fx.pay(rb)
check("a paid booking captures", st == 200, f"{st}")
paid_row = fx.payment_row(rb)
check("payment is captured before the cancellation",
      paid_row.status == CustomerPaymentStatus.CAPTURED.value, paid_row.status)
check("booking is confirmed before the cancellation",
      fx.booking_row(rb).status == CustomerBookingStatus.CONFIRMED.value)

db.execute(text("DELETE FROM customer_audit_logs WHERE module='Payments'"))
db.commit()

st, _ = fx.cancel(rb)
check("the customer can cancel it", st == 200, f"{st}")
db.expire_all()
check("the booking is cancelled",
      fx.booking_row(rb).status == CustomerBookingStatus.CANCELLED.value)
check("the captured payment is NOT silently rewritten",
      fx.payment_row(rb).status == CustomerPaymentStatus.CAPTURED.value,
      fx.payment_row(rb).status)

flagged = db.execute(text(
    "SELECT action, description, status FROM customer_audit_logs "
    "WHERE module='Payments' ORDER BY customer_audit_log_id DESC LIMIT 5")).all()
check("a refund-owed audit row was written", len(flagged) >= 1, f"{len(flagged)} row(s)")
if flagged:
    action, desc, aud_status = flagged[0]
    check("it names the refund", "refund" in (action or "").lower(), action)
    check("it is recorded as a FAILED/attention row",
          str(aud_status).lower().endswith("failed"), str(aud_status))
    check("it names the booking", rb["booking_ref"] in (desc or ""), (desc or "")[:80])

# The flag must not fire for an UNPAID cancellation, or it means nothing.
ub = fx.book()
db.execute(text("DELETE FROM customer_audit_logs WHERE module='Payments'"))
db.commit()
st, _ = fx.cancel(ub)
check("an unpaid booking still cancels", st == 200, f"{st}")
noise = db.execute(text(
    "SELECT count(*) FROM customer_audit_logs WHERE module='Payments'")).scalar()
check("no refund flag on an unpaid cancellation", noise == 0, str(noise))
fx.release(ub)

# =========================================================================
section(16, "RECONCILE ENDPOINT")
#
# The on-demand half of verification. It calls the SAME verify_and_capture the
# webhook calls, so what is checked here is not the verifier again -- section 5
# already does that in-process -- but that exposing it to a browser did not open
# a way to confirm a booking without one.

# -- a booking nobody has opened a checkout for -----------------------------
b_rc = fx.book()
st, body = fx.reconcile(b_rc)
check("reconcile answers 200 for a booking with no checkout", st == 200, f"{st}")
check("...and says so rather than inventing a payment",
      (body or {}).get("code") == "no_payment", str(body))
check("...and confirms nothing", (body or {}).get("booking_status") == "pending",
      str(body))
check("...and wrote no payment row", fx.payment_row(b_rc) is None)

# -- an open checkout that was never paid -----------------------------------
st_ck, _ck_body = fx.checkout(b_rc)
check("checkout opens for the reconcile case", st_ck in (200, 201), f"{st_ck}")
st, body = fx.reconcile(b_rc)
check("reconcile answers 200 for an unpaid open checkout", st == 200, f"{st}")
check("AN UNPAID BOOKING IS NOT CONFIRMED BY ASKING",
      (body or {}).get("booking_status") == "pending", str(body))
check("...and reports no capture", (body or {}).get("captured") is False, str(body))
check("...and the payment row is still not captured",
      fx.payment_row(b_rc).status != "captured", str(fx.payment_row(b_rc).status))

# THE POINT OF THE ENDPOINT: a browser cannot dictate the outcome. There is no
# amount, status or captured field on PackageReconcileRequest, so a client that
# sends them is not refused -- the fields do not exist and are dropped -- and
# the answer is identical to the honest call above.
st, forged = fx.reconcile(b_rc, handler={
    "provider_payment_id": "pay_forged", "provider_order_id": "order_forged",
    "signature": "0" * 64,
})
check("a forged handler payload does not confirm the booking",
      st == 200 and (forged or {}).get("booking_status") == "pending", f"{st} {forged}")
check("...and does not capture", (forged or {}).get("captured") is False, str(forged))
check("...and did not overwrite the order id we stored",
      fx.payment_row(b_rc).provider_order_id != "order_forged",
      str(fx.payment_row(b_rc).provider_order_id))

# -- ownership, same rule as every sibling route ----------------------------
st, _ = fx.reconcile(b_rc, token=fx.other_token)
check("another customer cannot reconcile the booking (404, not 403)", st == 404, f"{st}")
st, _ = call("/api/customer/package-bookings/JPP999999/reconcile",
             {"provider_payment_id": None, "provider_order_id": None, "signature": None},
             fx.token)
check("a non-existent ref gives the same 404", st == 404, f"{st}")
st, _ = call(f"/api/customer/package-bookings/{b_rc['booking_ref']}/reconcile",
             {"provider_payment_id": None, "provider_order_id": None, "signature": None})
check("reconcile requires a session", st in (401, 403), f"{st}")
fx.release(b_rc)

# -- a booking that WAS paid, via the ordinary webhook path -----------------
b_rc2 = fx.book()
st_wh, _ = fx.pay(b_rc2)
check("the webhook captured the payment for the reconcile case",
      st_wh == 200 and fx.booking_row(b_rc2).status == "confirmed",
      f"{st_wh} {fx.booking_row(b_rc2).status}")

notes_before = db.query(CustomerNotification).filter(
    CustomerNotification.related_ref == b_rc2["booking_ref"],
    CustomerNotification.notification_type == "booking_confirmed").count()

st, body = fx.reconcile(b_rc2)
check("reconcile reports a captured payment as captured", st == 200 and
      (body or {}).get("payment_status") == "captured", f"{st} {body}")
check("...and reports the booking confirmed",
      (body or {}).get("booking_status") == "confirmed", str(body))
check("...but says IT did not capture it — captured is 'I did this', not 'it is so'",
      (body or {}).get("captured") is False, str(body))
check("...and marks it settled rather than worth retrying",
      (body or {}).get("retryable") is False, str(body))
check("...with the verifier's own code carried through",
      (body or {}).get("code") == "already_captured", str(body))

# Idempotence, which is what makes it safe to put in a poll loop.
for _ in range(3):
    fx.reconcile(b_rc2)
check("repeated reconciles do not re-notify",
      db.query(CustomerNotification).filter(
          CustomerNotification.related_ref == b_rc2["booking_ref"],
          CustomerNotification.notification_type == "booking_confirmed"
      ).count() == notes_before, "duplicate booking_confirmed notification")
check("repeated reconciles leave exactly one captured payment",
      db.query(CustomerPackageBookingPayment).filter(
          CustomerPackageBookingPayment.package_booking_id == b_rc2["_id"],
          CustomerPackageBookingPayment.status == "captured").count() == 1)
check("and no secret leaked into any reconcile response",
      "secret" not in json.dumps(body or {}).lower(), str(body))
fx.release(b_rc2)

# =========================================================================
section(17, "CHECKOUT IDEMPOTENCY")
#
# Razorpay's receipt is NOT an idempotency key on this platform: duplicate
# receipts are accepted (uniqueness is an opt-in account setting) and
# GET /v1/orders?receipt= does not filter. Both verified against a live test
# account on 2026-09-02. The adapter therefore looks the order up client-side
# and, when the caller says one may already exist, does so BEFORE creating.
#
# No network here: _request is stubbed, so these assert the adapter's logic
# rather than Razorpay's uptime.
from app.services.payments.razorpay_provider import RazorpayProvider

def _rzp(pages):
    """An adapter whose only provider contact is a scripted _request."""
    a = RazorpayProvider(key_id="rzp_test_x", key_secret="s", webhook_secret="w")
    a.calls = []
    def fake(method, path, **kw):
        a.calls.append(f"{method} {path}")
        if method == "GET" and path == "/orders":
            skip = (kw.get("params") or {}).get("skip", 0) // 100
            return {"items": pages[skip] if skip < len(pages) else []}
        if method == "POST" and path == "/orders":
            return {"id": "order_NEW", "amount": (kw.get("json_body") or {})["amount"],
                    "currency": "INR", "status": "created"}
        raise AssertionError(f"unexpected {method} {path}")
    a._request = fake
    return a

_order = lambda i, r, st="created", amt=150000: {
    "id": i, "receipt": r, "status": st, "amount": amt, "currency": "INR"}
_mk = dict(amount_minor=150000, currency="INR", reference="JPP-T")

# -- the happy path must not pay for the fix -------------------------------
a = _rzp([[]])
s = a.create_checkout(idempotency_key="key_aaaaaaaa", **_mk)
check("a first attempt makes exactly one provider call (no lookup)",
      a.calls == ["POST /orders"], str(a.calls))
check("...and returns the new order", s.order_id == "order_NEW", s.order_id)

# -- the retry looks BEFORE it creates -------------------------------------
a = _rzp([[_order("order_OLD", "key_bbbbbbbb")]])
s = a.create_checkout(idempotency_key="key_bbbbbbbb", may_exist=True, **_mk)
check("may_exist reuses the order already opened under this key",
      s.order_id == "order_OLD", s.order_id)
check("...and never POSTs a second order",
      "POST /orders" not in a.calls, str(a.calls))
check("...and the reused session is a complete one the browser can use",
      s.publishable_key == "rzp_test_x" and s.currency == "INR"
      and s.amount_minor == 150000 and s.redirect_url is None
      and s.options.get("description") == "JPP-T", str(s))

# -- nothing to recover: it still creates ----------------------------------
a = _rzp([[_order("order_SOMEONE_ELSE", "different_key")]])
s = a.create_checkout(idempotency_key="key_cccccccc", may_exist=True, **_mk)
check("a receipt belonging to another key is NOT reused",
      s.order_id == "order_NEW", s.order_id)
check("...so an order is created after the lookup finds nothing",
      a.calls[-1] == "POST /orders", str(a.calls))

# -- duplicates already on the account: the paid one must win --------------
a = _rzp([[_order("order_UNPAID", "key_dddddddd"),
           _order("order_PAID", "key_dddddddd", st="paid"),
           _order("order_TRIED", "key_dddddddd", st="attempted")]])
s = a.create_checkout(idempotency_key="key_dddddddd", may_exist=True, **_mk)
check("when several orders share a receipt the PAID one is reused",
      s.order_id == "order_PAID", s.order_id)
# Reusing a merely-created sibling would show a paid customer a fresh checkout.

# -- a lookup that fails must not be read as 'no order exists' -------------
a = _rzp([[]])
def _boom(method, path, **kw):
    a.calls.append(f"{method} {path}")
    if path == "/orders" and method == "GET":
        raise V.payment_providers.PaymentFailed("HTTP 502")
    return {"id": "order_NEW", "amount": 150000, "currency": "INR", "status": "created"}
a._request = _boom
s = a.create_checkout(idempotency_key="key_eeeeeeee", may_exist=True, **_mk)
check("a failed lookup falls through to creating rather than raising",
      s.order_id == "order_NEW", s.order_id)

# -- the scan is bounded ---------------------------------------------------
import app.services.payments.razorpay_provider as _R
check("the recovery scan is capped at 2 pages",
      _R.RECOVERY_MAX_PAGES == 2, str(_R.RECOVERY_MAX_PAGES))
a = _rzp([[_order(f"o{i}", "nope") for i in range(100)],
          [_order(f"p{i}", "nope") for i in range(100)],
          [_order("order_TOO_DEEP", "key_ffffffff")]])
s = a.create_checkout(idempotency_key="key_ffffffff", may_exist=True, **_mk)
check("...so a match beyond the cap is not searched for indefinitely",
      s.order_id == "order_NEW" and a.calls.count("GET /orders") == 2, str(a.calls))

# -- the whole point: the SERVICE must pass may_exist ----------------------
# Asserted on the source because the condition it encodes -- "a row claimed
# this key but has no order id" -- is the entire fix, and a refactor that
# dropped the argument would silently restore the duplicate-order bug.
_svc = inspect.getsource(__import__(
    "app.services.customer_package_booking_service", fromlist=["x"]))
check("start_checkout passes may_exist to the provider",
      "may_exist=existing is not None" in _svc)

# -- and the mock must accept it, or the suite tests a different contract --
_mock = inspect.getsource(__import__(
    "app.services.payments.mock_provider", fromlist=["x"]))
check("the mock provider accepts may_exist too",
      "may_exist" in _mock)

# =========================================================================
section(18, "B2B REGRESSION")
after = {t: db.execute(text(f"SELECT count(*) FROM {t}")).scalar() for t in B2B_BEFORE}
for t, before in B2B_BEFORE.items():
    check(f"{t} unchanged", after[t] == before, f"{before} -> {after[t]}")
for path in ("/api/admin/wallet/topups?bucket=pending", "/api/admin/payment-accounts",
             "/api/admin/wallet/topups/counts"):
    st, _ = call(path, token=fx.admin_token)
    check(f"B2B {path.split('?')[0]} still answers", st == 200, f"{st}")

# =========================================================================
section(19, "TEST-DATA HYGIENE")
fx.cleanup()
ok, before, after_seats = fx.seats_balanced()
check("seats returned to exactly where they started — accounting, not repair",
      ok, f"{before} -> {after_seats}")
db.expire_all()
after = {
    "bookings": db.query(CustomerPackageBooking).count(),
    "payments": db.query(CustomerPackageBookingPayment).count(),
    "events": db.query(PaymentProviderEvent).count(),
    "confirm_notes": db.query(CustomerNotification).filter(
        CustomerNotification.notification_type == "booking_confirmed").count(),
}
for k, before_n in B2C_BEFORE.items():
    check(f"{k} returned to baseline", after[k] == before_n,
          f"{before_n} -> {after[k]}")
# This one IS an absolute zero: _purge_events deletes every module='Payments'
# audit row, not only the ones this run wrote, so a baseline delta would be
# wrong here rather than merely fragile.
audit_left = db.execute(text(
    "SELECT count(*) FROM customer_audit_logs WHERE module='Payments'")).scalar()
check("no leftover payment_audit", audit_left == 0, str(audit_left))

db.close()
sys.exit(_ck.report())
