"""HTTP-level tests for the two flight-supplier reconciliation endpoints.

    GET  /api/admin/payment-reconciliation/flight-bookings/held
    POST /api/admin/payment-reconciliation/flight-bookings/{ref}/supplier-reservation

Real FastAPI routing, the real ``require(P.PAYMENT_VERIFY)`` dependency, real
bearer-token decoding and a real ``users`` row; only the database is SQLite and
the activity log is recorded rather than written. Nothing here touches HDFC, a
supplier or any real environment.

A SUPPLIER ORDER ID ENTERED HERE IS AN ADMINISTRATOR ATTESTATION, NOT A
SUPPLIER-VERIFIED RESERVATION. These tests assert that the platform says so in
the response, the customer's audit trail and the activity log, and that it never
calls the supplier.

WHAT SQLITE CANNOT PROVE
``SELECT ... FOR UPDATE`` is ignored by SQLite, so genuinely concurrent
resolution cannot be exercised here. What IS pinned: sequential duplicate
resolution confirms once; a failure after the supplier fields are written rolls
the whole transaction back; and the lock order (payment, then booking) is
asserted from the code, not from a race.
"""

from __future__ import annotations

import datetime as dt
import decimal
import inspect

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.rbac import P, effective_permissions
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base,
    Customer,
    CustomerAuditLog,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerNotification,
    CustomerPaymentStatus,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_reconciliation
from app.services import activity_service
from app.services import flight_supplier_service
from app.services import payment_verification_flight_service as flight_verify
from app.services import supplier_guard as G

BASE = "/api/admin/payment-reconciliation/flight-bookings"
ATTESTED = "Supplier order id recorded by an administrator (attested, not supplier-verified)"
_N = {"n": 120000}


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    """The app, a session factory, and the activity-log recorder."""

    def __init__(self, engine):
        self.engine = engine
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity: list[dict] = []
        app = FastAPI()
        app.include_router(admin_reconciliation.router)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()                  # an uncommitted request rolls back here

        app.dependency_overrides[get_db] = _db
        self.app = app
        self.client = TestClient(app, raise_server_exceptions=False)

    def db(self):
        return self.Session()


@pytest.fixture()
def env(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerBooking.__table__, CustomerBookingPayment.__table__,
        CustomerNotification.__table__, CustomerAuditLog.__table__,
    ])
    # ``users`` carries Postgres-only server defaults, so build a SQLite copy of it
    # on a private MetaData (the real table object is left untouched).
    md = MetaData()
    users = User.__table__.to_metadata(md)
    for con in list(users.constraints):
        if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
            users.constraints.discard(con)
    for idx in list(users.indexes):
        users.indexes.discard(idx)
    for col in users.columns:
        col.foreign_keys.clear()
        col.server_default = None
        if not col.primary_key:
            col.nullable = True
    users.create(engine)

    e = Env(engine)
    monkeypatch.setattr(
        activity_service, "log_activity",
        lambda db, user_id, action, ip=None, **kw: e.activity.append(
            {"user_id": user_id, "action": action, **kw}),
    )

    def _boom(*a, **k):
        raise AssertionError("the supplier was called: an order id is only ATTESTED")

    monkeypatch.setattr(flight_supplier_service, "revalidate_offer", _boom)
    yield e
    engine.dispose()


def _user(env, role, *, permissions=None, name="Reviewer"):
    db = env.db()
    u = User(user_id=_id(), full_name=name, email=f"u{_N['n']}@example.test",
             password_hash="x", role=role, status=UserStatus.ACTIVE,
             permissions=permissions or [])
    db.add(u)
    db.commit()
    token = create_access_token(u.user_id)
    db.close()
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def admin(env):
    return _user(env, UserRole.ADMIN, name="Ada Admin")


def _booking(env, *, ref, held=True, status=CustomerBookingStatus.PENDING.value,
             payment_status=CustomerPaymentStatus.CAPTURED.value, order_id=None):
    db = env.db()
    c = Customer(customer_id=_id(), customer_code=f"CUST{_id()}", full_name="Test Traveller",
                 email=f"t{_id()}@example.test", mobile="9000000000")
    db.add(c)
    db.flush()
    b = CustomerBooking(
        customer_booking_id=_id(), booking_ref=ref, customer_id=c.customer_id,
        total_amount=decimal.Decimal("56.00"), currency="INR", status=status,
        created_at=dt.datetime.now(dt.timezone.utc), supplier="duffel",
        supplier_offer_id="off_1", supplier_total_amount=decimal.Decimal("10.00"),
        supplier_order_id=order_id,
        supplier_status=G.RESERVATION_MISSING if held else None,
    )
    db.add(b)
    db.flush()
    p = CustomerBookingPayment(
        customer_booking_payment_id=_id(), customer_booking_id=b.customer_booking_id,
        method="gateway", amount=decimal.Decimal("56.00"), currency="INR",
        status=payment_status, provider="hdfc", provider_order_id=f"JPORD{ref}",
        provider_payment_id=f"JPORD{ref}", paid_at=dt.datetime.now(dt.timezone.utc),
    )
    db.add(p)
    db.commit()
    ids = (b.customer_booking_id, p.customer_booking_payment_id)
    db.close()
    return ref, ids


def _state(env, ref):
    db = env.db()
    b = db.execute(select(CustomerBooking).where(CustomerBooking.booking_ref == ref)).scalar_one()
    out = {"status": b.status, "order": b.supplier_order_id, "marker": b.supplier_status,
           "pnr": b.pnr}
    db.close()
    return out


def _count(env, model, *where):
    db = env.db()
    n = db.execute(select(func.count()).select_from(model).where(*where)).scalar_one()
    db.close()
    return n


def _confirmations(env):
    return _count(env, CustomerNotification,
                  CustomerNotification.notification_type == "booking_confirmed")


def _attestations(env):
    return _count(env, CustomerAuditLog, CustomerAuditLog.action == ATTESTED)


def _resolve(env, ref, headers, body):
    return env.client.post(f"{BASE}/{ref}/supplier-reservation", headers=headers, json=body)


# ===========================================================================
# Authentication and authorisation
# ===========================================================================
def test_unauthenticated_requests_are_rejected(env):
    ref, _ = _booking(env, ref="JPF700001")
    assert env.client.get(f"{BASE}/held").status_code in (401, 403)
    r = env.client.post(f"{BASE}/{ref}/supplier-reservation", json={"supplier_order_id": "ord_0000111"})
    assert r.status_code in (401, 403)
    assert _state(env, ref)["status"] == CustomerBookingStatus.PENDING.value


def test_a_garbage_token_is_rejected(env):
    r = env.client.get(f"{BASE}/held", headers={"Authorization": "Bearer not.a.jwt"})
    assert r.status_code == 401


def test_an_inactive_user_is_rejected(env):
    db = env.db()
    u = User(user_id=_id(), full_name="Gone", email="gone@example.test", password_hash="x",
             role=UserRole.ADMIN, status=UserStatus.INACTIVE, permissions=[])
    db.add(u)
    db.commit()
    token = create_access_token(u.user_id)
    db.close()
    r = env.client.get(f"{BASE}/held", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


@pytest.mark.parametrize("role", [UserRole.MANAGER, UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER])
def test_users_without_payment_verify_are_refused_everywhere(env, role):
    headers = _user(env, role)
    db = env.db()
    held_user = db.execute(select(User).order_by(User.user_id.desc())).scalars().first()
    assert P.PAYMENT_VERIFY not in effective_permissions(held_user), "premise: role lacks it"
    db.close()

    ref, _ = _booking(env, ref=f"JPF7100{role.value[:2].upper()}")
    assert env.client.get(f"{BASE}/held", headers=headers).status_code == 403
    r = _resolve(env, ref, headers, {"supplier_order_id": "ord_0000111"})
    assert r.status_code == 403
    assert _state(env, ref)["status"] == CustomerBookingStatus.PENDING.value
    assert _state(env, ref)["order"] is None and env.activity == []


def test_the_permission_not_the_role_is_what_counts(env):
    """An explicit payment.verify grant is enough; the role is not."""
    headers = _user(env, UserRole.MERCHANT_USER, permissions=[P.PAYMENT_VERIFY])
    assert env.client.get(f"{BASE}/held", headers=headers).status_code == 200


def test_admin_holds_the_permission(env, admin):
    assert env.client.get(f"{BASE}/held", headers=admin).status_code == 200


# ===========================================================================
# Listing
# ===========================================================================
def test_admin_lists_only_held_bookings_and_no_personal_details(env, admin):
    held, _ = _booking(env, ref="JPF700010")
    _booking(env, ref="JPF700011", held=False)                                    # not held
    _booking(env, ref="JPF700012", payment_status=CustomerPaymentStatus.PENDING.value)  # unpaid
    _booking(env, ref="JPF700013", status=CustomerBookingStatus.CANCELLED.value)  # cancelled
    body = env.client.get(f"{BASE}/held", headers=admin).json()
    assert [i["booking_ref"] for i in body["items"]] == [held]
    item = body["items"][0]
    assert set(item) == {"booking_ref", "payment_id", "provider", "amount", "currency", "paid_at"}
    assert "email" not in str(item).lower() and "Traveller" not in str(item)


# ===========================================================================
# Resolution
# ===========================================================================
def test_an_admin_resolves_a_held_booking_once_and_it_says_attested(env, admin):
    ref, _ = _booking(env, ref="JPF700020")
    r = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111", "pnr": "ABC123"})
    assert r.status_code == 200
    assert r.json() == {
        "booking_ref": ref, "result": "confirmed",
        "attested_by_administrator": True, "supplier_verified": False,
    }
    s = _state(env, ref)
    assert s["status"] == CustomerBookingStatus.CONFIRMED.value
    assert s["order"] == "ord_0000111" and s["pnr"] == "ABC123"
    assert s["marker"] == "confirmed"
    assert _confirmations(env) == 1


def test_resolution_is_audited_as_an_attestation_not_a_verification(env, admin):
    ref, _ = _booking(env, ref="JPF700021")
    _resolve(env, ref, admin, {"supplier_order_id": "ord_0000112"})
    assert _attestations(env) == 1
    db = env.db()
    entry = db.execute(select(CustomerAuditLog).where(CustomerAuditLog.action == ATTESTED)).scalar_one()
    text = entry.description.lower()
    assert "ord_0000112" in text and "attestation" in text and "did not verify" in text
    assert "verified by the supplier" not in text
    assert db.execute(select(func.count()).select_from(CustomerAuditLog).where(
        CustomerAuditLog.action == "Booking confirmed")).scalar_one() == 1
    db.close()
    # and on the staff activity log, exactly once
    assert len(env.activity) == 1
    a = env.activity[0]
    assert a["action"] == "Flight supplier reservation recorded"
    assert "attestation" in a["description"].lower() and "not supplier-verified" in a["description"].lower()
    assert "Ada Admin" in a["description"] and ref in a["description"]


def test_a_duplicate_resolution_does_not_confirm_or_audit_twice(env, admin):
    ref, _ = _booking(env, ref="JPF700022")
    first = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000113"})
    again = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000999"})
    third = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000113"})
    assert first.json()["result"] == "confirmed"
    assert again.status_code == 200 and again.json()["result"] == "already_confirmed"
    assert third.json()["result"] == "already_confirmed"
    s = _state(env, ref)
    assert s["order"] == "ord_0000113"                       # a later id never overwrites
    assert _confirmations(env) == 1 and _attestations(env) == 1
    assert env.client.get(f"{BASE}/held", headers=admin).json()["items"] == []


@pytest.mark.parametrize("bad,expected", [
    ({}, 422),                                               # missing
    ({"supplier_order_id": ""}, 422),
    ({"supplier_order_id": "ab"}, 422),                      # too short (schema)
    ({"supplier_order_id": "x" * 81}, 422),                  # too long (schema)
    ({"supplier_order_id": "has space inside"}, 422),        # shape (guard)
    ({"supplier_order_id": "<script>alert(1)</script>"}, 422),
    ({"supplier_order_id": "ord_0000111", "pnr": "TOOLONGPNR1"}, 422),
    ({"supplier_order_id": None}, 422),
])
def test_invalid_or_missing_order_ids_are_rejected_and_change_nothing(env, admin, bad, expected):
    ref, _ = _booking(env, ref="JPF700030")
    r = _resolve(env, ref, admin, bad)
    assert r.status_code == expected
    s = _state(env, ref)
    assert s["status"] == CustomerBookingStatus.PENDING.value and s["order"] is None
    assert s["marker"] == G.RESERVATION_MISSING
    assert _confirmations(env) == 0 and _attestations(env) == 0 and env.activity == []


# ---- only eligible bookings ------------------------------------------------
def test_unknown_booking_is_404(env, admin):
    assert _resolve(env, "JPF999999", admin, {"supplier_order_id": "ord_0000111"}).status_code == 404


def test_a_booking_that_is_not_held_is_refused(env, admin):
    """Not a way to rewrite any flight booking."""
    ref, _ = _booking(env, ref="JPF700040", held=False)
    r = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111"})
    assert r.status_code == 409
    s = _state(env, ref)
    assert s["order"] is None and s["status"] == CustomerBookingStatus.PENDING.value
    assert _confirmations(env) == 0 and env.activity == []


def test_a_held_marker_without_a_captured_payment_is_refused(env, admin):
    ref, _ = _booking(env, ref="JPF700041", payment_status=CustomerPaymentStatus.PENDING.value)
    r = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111"})
    assert r.status_code == 409
    assert _state(env, ref)["order"] is None and _confirmations(env) == 0


@pytest.mark.parametrize("status", [CustomerBookingStatus.CANCELLED.value,
                                    CustomerBookingStatus.COMPLETED.value])
def test_an_invalid_state_transition_is_refused_and_writes_nothing(env, admin, status):
    ref, _ = _booking(env, ref=f"JPF7005{status[:2].upper()}", status=status)
    r = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111"})
    assert r.status_code == 409
    s = _state(env, ref)
    assert s["status"] == status and s["order"] is None
    assert _confirmations(env) == 0 and _attestations(env) == 0 and env.activity == []


def test_a_cancelled_booking_cannot_be_resolved_after_a_held_one_was_cancelled(env, admin):
    ref, _ = _booking(env, ref="JPF700051")
    db = env.db()
    from app.services import customer_booking_service as flights
    b = db.execute(select(CustomerBooking).where(CustomerBooking.booking_ref == ref)).scalar_one()
    flights.cancel(db, b)
    db.commit()
    db.close()
    assert _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111"}).status_code == 409
    assert _state(env, ref)["order"] is None


# ===========================================================================
# Transaction handling and the supplier is never called
# ===========================================================================
def test_a_failure_after_the_supplier_fields_are_written_rolls_everything_back(env, admin, monkeypatch):
    ref, _ = _booking(env, ref="JPF700060")

    def explode(db, payment, booking):
        # By now the supplier fields and the attestation audit row are flushed.
        raise RuntimeError("confirmation failed mid-transaction")

    monkeypatch.setattr(flight_verify, "confirm_booking", explode)
    r = _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111"})
    assert r.status_code == 500
    s = _state(env, ref)
    assert s["order"] is None and s["status"] == CustomerBookingStatus.PENDING.value
    assert s["marker"] == G.RESERVATION_MISSING                       # still held, still findable
    assert _attestations(env) == 0 and _confirmations(env) == 0 and env.activity == []

    monkeypatch.undo()                                                # the retry then succeeds
    assert _state(env, ref)["status"] == CustomerBookingStatus.PENDING.value


def test_a_rejected_request_leaves_the_session_clean_for_the_next(env, admin):
    ref, _ = _booking(env, ref="JPF700061")
    assert _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111", "pnr": "TOOLONGPNR1"}).status_code == 422
    assert _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111"}).status_code == 200
    assert _confirmations(env) == 1


def test_the_supplier_is_never_asked_to_verify(env, admin):
    """The fixture replaces revalidate_offer with a bomb: any supplier call fails the test."""
    ref, _ = _booking(env, ref="JPF700062")
    assert _resolve(env, ref, admin, {"supplier_order_id": "ord_0000111"}).status_code == 200


def test_lock_order_is_payment_then_booking():
    """The same order as every other payment path, so this cannot deadlock a webhook."""
    src = inspect.getsource(G.complete_reservation)
    pay_lock = src.index("select(CustomerBookingPayment)")
    booking_lock = src.index("select(CustomerBooking)\n        .where(CustomerBooking.customer_booking_id")
    assert src.index("with_for_update", pay_lock) < booking_lock
    assert src.count("with_for_update") == 2


def test_the_endpoint_says_attestation_in_its_own_documentation():
    doc = admin_reconciliation.record_supplier_reservation.__doc__ or ""
    route = next(r for r in admin_reconciliation.router.routes
                 if getattr(r, "path", "").endswith("/supplier-reservation"))
    assert "ATTESTATION" in route.description and "not a supplier-verified" in route.description
    assert "verified automatically" not in route.description.lower()
