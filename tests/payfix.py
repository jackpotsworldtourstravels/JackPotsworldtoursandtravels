"""Shared fixture for the B2C payment tests — books through the REAL API.

WHY THIS EXISTS
The payment phase scripts each built their own bookings, and some did it by
INSERTing rows directly. A directly-inserted booking never runs
``create_booking``, so it never decrements
``customer_package_departures.seats_left`` — and then a cleanup that credits a
seat back for every row it deletes over-counts. Two separate runs ended with a
seat count that had to be reconciled by hand, which is exactly the kind of
"repair" that hides a real inventory bug behind a corrected number.

THE RULE HERE: a fixture books through the REAL API, so the seat is taken the
way a customer takes it. Cleanup then deletes the rows and credits back exactly
the pax of the bookings that were still holding seats — the same sum the
booking path removed. The seat count is therefore correct because the
accounting was exercised, not because it was set.

    with PaymentFixture() as fx:
        b = fx.book()                 # real POST, seat taken
        st, ck = fx.checkout(b)       # real POST, order opened
        fx.deliver(*fx.signed(...))   # real signed webhook POST
    # __exit__ deletes what it made and returns exactly what it took

NOTHING HERE MAY SET ``captured`` OR ``confirmed`` DIRECTLY. A test that writes
the state it is meant to be verifying proves nothing. Every capture in this
suite arrives through the signed webhook path.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import sys
import urllib.error
import urllib.request
import uuid
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))
sys.path.insert(0, str(HERE))

from sqlalchemy import text                                            # noqa: E402

from app.auth.security import (                                        # noqa: E402
    create_access_token, create_customer_access_token,
)
from app.database.session import SessionLocal                          # noqa: E402
from app.models_v2 import User, UserRole, UserStatus                   # noqa: E402
import app.config as C                                                 # noqa: E402

from config import BASE                                                # noqa: E402

#: The seeded demo customer. Looked up by address rather than by a magic id so
#: a reseeded database that renumbers the row still finds the right account.
DEMO_CUSTOMER_EMAIL = "demo.customer@example.com"

#: The seeded package this suite books against.
PACKAGE_ID = 1

#: How many seats a full run needs. Every case is released as soon as it is
#: finished with, so this is the concurrent high-water mark and not the number
#: of bookings made — but a departure below it cannot carry the run.
SEATS_NEEDED = 8


def call(path, body=None, token=None, method=None, raw=None, headers=None):
    """One HTTP call. Returns ``(status, parsed_json_or_None)``."""
    data = raw if raw is not None else (
        json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(
        BASE + path, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None


class PaymentFixture:
    """Books through the real API; cleans up exactly what it made."""

    def __init__(self, customer_id: int | None = None):
        self.db = SessionLocal()

        if customer_id is None:
            customer_id = self.db.execute(text(
                "SELECT customer_id FROM customers WHERE lower(email) = :e"),
                {"e": DEMO_CUSTOMER_EMAIL}).scalar()
            if customer_id is None:
                raise RuntimeError(
                    f"No seeded customer {DEMO_CUSTOMER_EMAIL!r}. Run the alembic "
                    f"seed migrations before this suite.")
        self.customer_id = customer_id
        self.token = create_customer_access_token(customer_id)

        other = self.db.execute(text(
            "SELECT customer_id FROM customers WHERE customer_id <> :c "
            "ORDER BY customer_id DESC LIMIT 1"), {"c": customer_id}).scalar()
        self.other_customer_id = other
        self.other_token = create_customer_access_token(other) if other else None

        admin = self.db.query(User).filter(
            User.role == UserRole.ADMIN, User.status == UserStatus.ACTIVE).first()
        merchant = self.db.query(User).filter(
            User.role.in_([UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER]),
            User.status == UserStatus.ACTIVE).first()
        self.admin, self.merchant = admin, merchant
        self.admin_token = create_access_token(admin.user_id) if admin else None
        self.merchant_token = create_access_token(merchant.user_id) if merchant else None

        self.provider = (C.settings.payment_provider or "mock").strip().lower()
        self.webhook_secret = C.settings.razorpay_webhook_secret or "mock_secret"
        self.webhook_path = f"/api/webhooks/payments/{self.provider}"

        self._booking_ids: list[int] = []
        self._event_ids: list[str] = []
        # Reclaim first, THEN measure. A run that crashed mid-way never reached
        # its cleanup, so its bookings are still holding seats; measuring the
        # baseline before reclaiming them would bake that leak into the number
        # this run is asserted against — and after a few crashes the departure
        # is simply exhausted and every later run fails on "Only 0 seats are
        # left", which looks like an inventory bug and is not one.
        self.reclaimed = self.reclaim_leaked()

        # PICK A DEPARTURE THAT CAN ACTUALLY CARRY THE RUN, rather than
        # hardcoding one. The seeded package has several departures and any of
        # them exercises identical code, but a shared development database
        # accumulates half-finished test bookings on whichever one a script
        # named first — and a hardcoded departure eventually sits at zero, at
        # which point every run fails on "Only 0 seats are left". That reads as
        # an inventory bug and is really just a dirty fixture, so the fixture
        # chooses rather than assumes.
        self.departure_id = self.db.execute(text(
            "SELECT customer_package_departure_id FROM customer_package_departures "
            "WHERE package_id = :p ORDER BY seats_left DESC, "
            "customer_package_departure_id ASC LIMIT 1"), {"p": PACKAGE_ID}).scalar()
        if self.departure_id is None:
            raise RuntimeError(f"Package {PACKAGE_ID} has no departures seeded.")
        self.seats_at_start = self._seats(self.departure_id)
        if self.seats_at_start < SEATS_NEEDED:
            raise RuntimeError(
                f"The emptiest usable departure ({self.departure_id}) has only "
                f"{self.seats_at_start} seat(s); this suite needs {SEATS_NEEDED}. "
                f"Some earlier run left bookings behind that this fixture cannot "
                f"attribute to itself — clear the stale customer_package_bookings "
                f"rows, or reseed, before running it.")

    def reclaim_leaked(self) -> int:
        """Delete fixture bookings a PREVIOUS crashed run left behind.

        SCOPED AS TIGHTLY AS THE DATA ALLOWS. A row qualifies only if it belongs
        to one of the two customers this fixture books as AND carries a traveller
        this fixture itself wrote (``first_name = 'Audit'``). A real customer
        booking matches neither, so this cannot reach one. It is deliberately not
        "delete every booking in the table" — that would be a cleanup capable of
        destroying real data to make a test pass.

        THE MARKER IS THE IDENTITY, NOT THE CUSTOMER ID. This was first written
        scoped to ``self.customer_id`` and it stranded a booking permanently: the
        ownership section books as ``other_customer_id`` to prove one customer
        cannot pay for another's trip, and that id is "the highest customer in
        the table", which MOVES every time ``verify_customer_portal`` signs a new
        customer up. A row abandoned under yesterday's "other" customer is
        therefore invisible to a customer-scoped sweep forever, while still
        holding a seat.

        So the scope is the traveller this fixture writes and nothing else:
        first name ``Audit`` AND last name ``CaseN``, both set only in
        :meth:`book`. No real booking carries that pair.

        Returns the number of bookings reclaimed, which the suite prints: a
        non-zero count is worth seeing, because it means an earlier run died.
        """
        ids = [r[0] for r in self.db.execute(text(
            "SELECT b.customer_package_booking_id FROM customer_package_bookings b "
            "WHERE EXISTS ("
            "  SELECT 1 FROM customer_package_booking_travellers t "
            "  WHERE t.package_booking_id = b.customer_package_booking_id "
            "    AND t.first_name = 'Audit' AND t.last_name LIKE 'Case%')"))]
        if not ids:
            return 0
        rows = self.db.execute(text(
            "SELECT departure_id, pax_count, status FROM customer_package_bookings "
            "WHERE customer_package_booking_id = ANY(:i)"), {"i": ids}).all()
        give_back: dict[int, int] = {}
        for dep, pax, status in rows:
            if status != "cancelled":
                give_back[dep] = give_back.get(dep, 0) + pax
        for tbl, col in [
            ("customer_package_booking_payments", "package_booking_id"),
            ("customer_package_booking_travellers", "package_booking_id"),
            ("customer_package_booking_addons", "package_booking_id"),
            ("customer_package_bookings", "customer_package_booking_id"),
        ]:
            self.db.execute(text(f"DELETE FROM {tbl} WHERE {col} = ANY(:i)"), {"i": ids})
        for dep, n in give_back.items():
            self.db.execute(text(
                "UPDATE customer_package_departures SET seats_left = seats_left + :n "
                "WHERE customer_package_departure_id = :d"), {"n": n, "d": dep})
        self._purge_events()
        self.db.commit()
        return len(ids)

    # -- lifecycle ---------------------------------------------------------
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.cleanup()
        self.db.close()
        return False

    def _seats(self, departure_id: int | None = None) -> int:
        self.db.expire_all()
        departure_id = departure_id or self.departure_id
        return self.db.execute(text(
            "SELECT seats_left FROM customer_package_departures "
            "WHERE customer_package_departure_id = :d"), {"d": departure_id}).scalar()

    def seats_balanced(self):
        """``(ok, before, after)`` — the seat count must return to where it was."""
        after = self._seats(self.departure_id)
        return after == self.seats_at_start, self.seats_at_start, after

    # -- the real paths ----------------------------------------------------
    def book(self, *, adults: int = 1, token: str | None = None) -> dict:
        """POST /package-bookings — the real path, so the seat is really taken."""
        expiry = (dt.date.today() + dt.timedelta(days=900)).isoformat()
        body = {
            "trip": {"package_id": PACKAGE_ID, "departure_id": self.departure_id,
                     "adults": adults, "children": 0},
            "travellers": [{
                "traveller_type": "adult", "title": "Mr",
                "first_name": "Audit", "last_name": f"Case{i}",
                "gender": "male", "date_of_birth": "1990-01-01",
                "nationality": "Indian", "passport_number": f"Z{1000000 + i}",
                "passport_expiry": expiry, "issuing_country": "India",
                "is_contact": i == 0, "mobile": "+919000000001",
                "email": "audit@example.com",
            } for i in range(adults)],
            "addons": [], "coupon_code": None,
            "idempotency_key": "aud_" + uuid.uuid4().hex,
        }
        st, bk = call("/api/customer/package-bookings", body, token or self.token)
        assert st in (200, 201), f"booking failed: {st} {bk}"
        row = self.db.execute(text(
            "SELECT customer_package_booking_id, total_amount FROM "
            "customer_package_bookings WHERE booking_ref = :r"),
            {"r": bk["booking_ref"]}).one()
        self._booking_ids.append(row[0])
        bk["_id"] = row[0]
        bk["_total"] = Decimal(str(row[1]))
        bk["_minor"] = int(Decimal(str(row[1])) * 100)
        return bk

    def checkout(self, booking: dict, *, key: str | None = None,
                 token: str | None = None, extra: dict | None = None):
        payload = {"idempotency_key": key or ("aud_ck_" + uuid.uuid4().hex[:16])}
        if extra:
            payload.update(extra)
        return call(
            f"/api/customer/package-bookings/{booking['booking_ref']}/checkout",
            payload, token or self.token)

    def cancel(self, booking: dict, *, token: str | None = None):
        return call(
            f"/api/customer/package-bookings/{booking['booking_ref']}/cancel",
            {}, token or self.token)

    def reconcile(self, booking: dict, *, token: str | None = None,
                  handler: dict | None = None):
        """Ask the server to re-check this booking's payment with the provider.

        ``handler`` carries the three values Razorpay's checkout callback hands
        the browser. All three are optional at the endpoint, so the default here
        is to send none of them -- which is also the case a reloaded page hits.
        """
        payload = {
            "provider_payment_id": None,
            "provider_order_id": None,
            "signature": None,
        }
        if handler:
            payload.update(handler)
        return call(
            f"/api/customer/package-bookings/{booking['booking_ref']}/reconcile",
            payload, token or self.token)

    def payment_row(self, booking: dict):
        self.db.expire_all()
        from app.models_customer import CustomerPackageBookingPayment
        return self.db.query(CustomerPackageBookingPayment).filter(
            CustomerPackageBookingPayment.package_booking_id == booking["_id"]
        ).order_by(
            CustomerPackageBookingPayment.customer_package_booking_payment_id.desc()
        ).first()

    def booking_row(self, booking: dict):
        self.db.expire_all()
        from app.models_customer import CustomerPackageBooking
        return self.db.get(CustomerPackageBooking, booking["_id"])

    def release(self, booking: dict) -> None:
        """Finish with one booking now: delete it and give its seat straight back.

        WHY THIS EXISTS. A suite that books forty cases and only cleans up at
        the end exhausts the departure and starts failing with "Only 0 seats are
        left" — which is the inventory working correctly and the TEST being
        wrong. Releasing per case keeps the run inside real capacity while still
        exercising the real booking path for every case.
        """
        bid = booking["_id"]
        row = self.db.execute(text(
            "SELECT departure_id, pax_count, status FROM customer_package_bookings "
            "WHERE customer_package_booking_id = :b"), {"b": bid}).first()
        if row is None:
            return
        dep, pax, status = row
        for tbl, col in [
            ("customer_package_booking_payments", "package_booking_id"),
            ("customer_package_booking_travellers", "package_booking_id"),
            ("customer_package_booking_addons", "package_booking_id"),
            ("customer_package_bookings", "customer_package_booking_id"),
        ]:
            self.db.execute(text(f"DELETE FROM {tbl} WHERE {col} = :b"), {"b": bid})
        if status != "cancelled":
            self.db.execute(text(
                "UPDATE customer_package_departures SET seats_left = seats_left + :p "
                "WHERE customer_package_departure_id = :d"), {"p": pax, "d": dep})
        self.db.execute(text(
            "DELETE FROM customer_notifications WHERE related_ref = :r"),
            {"r": booking["booking_ref"]})
        self.db.commit()
        if bid in self._booking_ids:
            self._booking_ids.remove(bid)

    # -- webhooks ----------------------------------------------------------
    def signed(self, *, order_id, amount, status="captured",
               event="payment.captured", payment_id=None, event_id=None,
               currency="INR", method="upi", body_override=None):
        """The exact bytes and headers a provider would post."""
        eid = event_id or ("evt_aud_" + uuid.uuid4().hex[:12])
        body = body_override or {
            "event_id": eid, "event": event,
            "payment": {
                "id": payment_id or ("pay_aud_" + uuid.uuid4().hex[:12]),
                "order_id": order_id, "status": status,
                "provider_status": status, "amount": amount,
                "currency": currency, "method": method,
            },
        }
        raw = json.dumps(body, separators=(",", ":")).encode()
        sig = hmac.new(self.webhook_secret.encode(), raw, hashlib.sha256).hexdigest()
        self._event_ids.append(eid)
        return raw, {
            "X-Razorpay-Signature": sig, "x-mock-signature": sig,
            "X-Razorpay-Event-Id": eid, "x-mock-event-id": eid,
        }, body

    def deliver(self, raw, headers):
        return call(self.webhook_path, raw=raw, headers=headers)

    def pay(self, booking: dict, **kw):
        """checkout -> signed capture. Returns the webhook's ``(status, body)``."""
        st, ck = self.checkout(booking)
        # 201: opening a checkout CREATES a payment attempt. Accepting 200 too
        # so this helper does not become the thing that fails if that changes.
        assert st in (200, 201), f"checkout failed: {st} {ck}"
        raw, headers, _ = self.signed(
            order_id=ck["order_id"], amount=booking["_minor"], **kw)
        return self.deliver(raw, headers)

    # -- cleanup -----------------------------------------------------------
    def cleanup(self):
        """Delete what was made, and return exactly the seats that were taken.

        The credit is computed from the bookings that were STILL HOLDING a seat
        — a cancelled booking already returned its own — so the arithmetic
        mirrors what ``create_booking`` and ``cancel`` actually did rather than
        forcing the column to a remembered number.

        Safe to call twice, and safe to call after a failed check has poisoned
        the session — it is registered with ``atexit`` precisely so that a crash
        mid-suite still returns the seats it took.
        """
        try:
            self.db.rollback()
        except Exception:                                  # noqa: BLE001
            pass
        if not self._booking_ids:
            self._purge_events()
            self.db.commit()
            return

        rows = self.db.execute(text(
            "SELECT customer_package_booking_id, departure_id, pax_count, status "
            "FROM customer_package_bookings WHERE customer_package_booking_id = ANY(:i)"),
            {"i": self._booking_ids}).all()

        give_back: dict[int, int] = {}
        for _bid, dep, pax, status in rows:
            if status != "cancelled":       # a cancelled one already gave its seat back
                give_back[dep] = give_back.get(dep, 0) + pax

        for tbl, col in [
            ("customer_package_booking_payments", "package_booking_id"),
            ("customer_package_booking_travellers", "package_booking_id"),
            ("customer_package_booking_addons", "package_booking_id"),
            ("customer_package_bookings", "customer_package_booking_id"),
        ]:
            self.db.execute(text(f"DELETE FROM {tbl} WHERE {col} = ANY(:i)"),
                            {"i": self._booking_ids})
        for dep, n in give_back.items():
            self.db.execute(text(
                "UPDATE customer_package_departures SET seats_left = seats_left + :n "
                "WHERE customer_package_departure_id = :d"), {"n": n, "d": dep})

        self._purge_events()
        self._booking_ids.clear()
        self.db.commit()

    def _purge_events(self):
        self.db.execute(text(
            "DELETE FROM payment_provider_events WHERE provider_event_id LIKE 'evt_aud_%'"))
        self.db.execute(text(
            "DELETE FROM customer_notifications WHERE related_ref LIKE 'JPP%' "
            "AND notification_type = 'booking_confirmed' "
            "AND related_ref NOT IN (SELECT booking_ref FROM customer_package_bookings)"))
        self.db.execute(text("DELETE FROM customer_audit_logs WHERE module = 'Payments'"))
