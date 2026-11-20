"""Phase 13 — B2C booking status changes and cancellation-request decisions, over HTTP.

Owner decisions under test (ADMIN_PORTAL_IMPLEMENTATION_TRACKER.md, Phase 13 parts 2-3):
  D1   PATCH /api/admin/customer-bookings/{ref}/status needs ``b2c.customers.manage`` (super admin passes);
       view scopes and an explicit ``customer.view`` do not; refusals are audited DENIED.
  D3   pending -> confirmed ONLY through the product's ``confirm_booking`` (captured payment == total);
       no captured payment / amount mismatch / held flight -> 409, nothing written.
  C3   confirmed -> completed is BLOCKED (409). Any -> pending refused. cancelled / completed are terminal.
  D5   admin cancel runs the product's own ``cancel()`` (cancelled_at, package seats, refund-owed flag)
       plus ONE in-app ``booking_cancelled`` notification; no email/SMS/push.
  D6   cancelling a PAID hotel writes a refund-owed customer-audit entry with amount + currency; no refund.
  X1   approving a cancellation request uses the same path; an already-cancelled booking is not cancelled
       twice; C6 a completed booking is refused; C7 approve/reject need ``b2c.customers.manage``.
  G    status change + side effects + both audit rows commit together (a failing audit write rolls it back).

Real routers / services / RBAC on a throw-away temp-file SQLite database. ``record_independently`` is pointed at
the same test database, ``activity_service.log_activity`` is captured in memory, and every external channel
(SMTP, the payment provider's refund call) raises if reached. Nothing here can reach PostgreSQL, ``.env`` or
``dev.db``. PostgreSQL row locking is NOT proven here (see test_phase12_postgres_integration.py).
"""
from __future__ import annotations

import datetime as dt
import decimal
import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, select
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    AdminAuditOutcome, Customer, CustomerAdminAuditLog, CustomerAuditLog, CustomerBooking, CustomerBookingPassenger,
    CustomerBookingPayment, CustomerCancellationRequest, CustomerHotelBooking, CustomerHotelBookingGuest,
    CustomerHotelBookingPayment, CustomerNotification, CustomerPackage, CustomerPackageBooking,
    CustomerPackageBookingPayment, CustomerPackageBookingTraveller, CustomerPackageDeparture, CustomerRefundAttempt,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_cancellations, admin_customer_bookings
from app.services import activity_service
from app.services import customer_admin_audit_service as b2c_audit_service
from tests._v2_harness import _sqlite_default

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)
BK = "/api/admin/customer-bookings"
CX = "/api/admin/cancellations"
_N = {"n": 830000}

_MODELS = (
    Customer, CustomerAdminAuditLog, CustomerAuditLog, CustomerNotification, CustomerBooking, CustomerBookingPassenger,
    CustomerBookingPayment, CustomerHotelBooking, CustomerHotelBookingGuest, CustomerHotelBookingPayment,
    CustomerPackageDeparture, CustomerPackageBooking, CustomerPackageBookingTraveller,
    CustomerPackageBookingPayment, CustomerCancellationRequest, CustomerRefundAttempt, User,
)


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.engine = engine
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity = []
        app = FastAPI()
        app.include_router(admin_customer_bookings.router)
        app.include_router(admin_cancellations.router)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=False)

    def db(self):
        return self.Session()


@pytest.fixture()
def env(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    md = MetaData()
    for model in _MODELS:
        tbl = model.__table__.to_metadata(md)
        for con in list(tbl.constraints):
            if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
                tbl.constraints.discard(con)
        for idx in list(tbl.indexes):
            tbl.indexes.discard(idx)
        for col in tbl.columns:
            col.foreign_keys.clear()
            col.server_default = _sqlite_default(col)
            if not col.primary_key:
                col.nullable = True
        tbl.create(engine)
    e = Env(engine)
    monkeypatch.setattr(activity_service, "log_activity",
                        lambda db, user_id, action, ip=None, **kw: e.activity.append({"user_id": user_id, "action": action}))
    monkeypatch.setattr(b2c_audit_service, "SessionLocal", e.Session)

    # No external channel may be reached by anything in this module.
    import smtplib
    from app.services import payments as payment_providers

    def _boom(*a, **k):
        raise AssertionError("an external channel was reached")

    monkeypatch.setattr(smtplib, "SMTP", _boom)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _boom)
    for name in ("refund", "create_refund", "issue_refund"):
        if hasattr(payment_providers, name):
            monkeypatch.setattr(payment_providers, name, _boom)
    yield e
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


# ------------------------------------------------------------------ builders
def _user(env, role, perms=None, name="Desk User", status=UserStatus.ACTIVE):
    db = env.db()
    u = User(user_id=_id(), full_name=name, email=f"u{_N['n']}@tt-qa.com", password_hash="x", role=role,
             status=status, permissions=list(perms or []), created_at=NOW)
    db.add(u)
    db.commit()
    out = {"headers": {"Authorization": f"Bearer {create_access_token(u.user_id)}"}, "id": u.user_id}
    db.close()
    return out


def _customer(env):
    db = env.db()
    c = Customer(customer_id=_id(), customer_code=f"C{_N['n']}", full_name=f"Traveller {_N['n']}",
                 email=f"c{_N['n']}@tt-qa.com", mobile="9000000000")
    db.add(c)
    db.commit()
    cid = c.customer_id
    db.close()
    return cid


def _flight(env, ref, *, status="pending", total="560.00", pay=None, supplier_status=None):
    db = env.db()
    cid = _customer(env)
    b = CustomerBooking(customer_booking_id=_id(), booking_ref=ref, customer_id=cid, total_amount=D(total),
                        currency="INR", status=status, created_at=NOW, origin_city="Delhi", destination_city="Goa",
                        flight_number="AI101", travel_date=dt.date.today() + dt.timedelta(days=10),
                        supplier_status=supplier_status)
    db.add(b)
    db.flush()
    if pay:
        db.add(CustomerBookingPayment(customer_booking_payment_id=_id(), customer_booking_id=b.customer_booking_id,
                                      method="gateway", amount=D(pay[1]), currency="INR", status=pay[0],
                                      provider="hdfc", provider_order_id=f"O{ref}", provider_payment_id=f"P{ref}",
                                      created_at=NOW))
    db.commit()
    db.close()
    return ref


def _hotel(env, ref, *, status="pending", total="900.00", pay=None):
    db = env.db()
    cid = _customer(env)
    h = CustomerHotelBooking(customer_hotel_booking_id=_id(), booking_ref=ref, customer_id=cid, hotel_id=1,
                             hotel_name="Sea View", room_id=1, room_name="Deluxe",
                             check_in_date=dt.date.today() + dt.timedelta(days=5),
                             check_out_date=dt.date.today() + dt.timedelta(days=6), nights=1,
                             total_amount=D(total), currency="INR", status=status, created_at=NOW)
    db.add(h)
    db.flush()
    if pay:
        db.add(CustomerHotelBookingPayment(customer_hotel_booking_payment_id=_id(),
                                           hotel_booking_id=h.customer_hotel_booking_id, method="gateway",
                                           amount=D(pay[1]), currency="INR", status=pay[0], provider="hdfc",
                                           provider_order_id=f"O{ref}", provider_payment_id=f"P{ref}",
                                           created_at=NOW))
    db.commit()
    db.close()
    return ref


def _package(env, ref, *, status="pending", pax=2, seats=5, pay=None, total="20000.00"):
    db = env.db()
    cid = _customer(env)
    pkg_id, dep_id = _id(), _id()
    # No CustomerPackage row: cancel()/confirm read only the departure, and the
    # package's ARRAY columns cannot be bound by SQLite.
    db.add(CustomerPackageDeparture(customer_package_departure_id=dep_id, package_id=pkg_id,
                                    departure_date=dt.date.today() + dt.timedelta(days=30),
                                    price_per_person=D("10000.00"), seats_left=seats, is_active=True))
    p = CustomerPackageBooking(customer_package_booking_id=_id(), booking_ref=ref, customer_id=cid, status=status,
                               package_id=pkg_id, package_name="Kerala Escape", package_days=4,
                               is_international=False, departure_id=dep_id,
                               departure_date=dt.date.today() + dt.timedelta(days=30), pax_count=pax,
                               total_amount=D(total), currency="INR", created_at=NOW)
    db.add(p)
    db.flush()
    if pay:
        db.add(CustomerPackageBookingPayment(customer_package_booking_payment_id=_id(),
                                             package_booking_id=p.customer_package_booking_id, method="gateway",
                                             amount=D(pay[1]), currency="INR", status=pay[0], provider="hdfc",
                                             provider_order_id=f"O{ref}", provider_payment_id=f"P{ref}",
                                             created_at=NOW))
    db.commit()
    db.close()
    return ref, dep_id


def _request(env, booking_ref, product, status="requested"):
    db = env.db()
    booking = None
    for model in (CustomerBooking, CustomerHotelBooking, CustomerPackageBooking):
        booking = db.scalars(select(model).where(model.booking_ref == booking_ref)).first()
        if booking:
            break
    ref = f"CXL{_id()}"
    db.add(CustomerCancellationRequest(cancellation_id=_id(), cancellation_ref=ref, customer_id=booking.customer_id,
                                       product=product, booking_ref=booking_ref, reason="plans changed",
                                       status=status, created_at=NOW, updated_at=NOW))
    db.commit()
    db.close()
    return ref


def _booking(env, ref):
    db = env.db()
    for model in (CustomerBooking, CustomerHotelBooking, CustomerPackageBooking):
        row = db.scalars(select(model).where(model.booking_ref == ref)).first()
        if row:
            db.close()
            return row
    db.close()
    raise AssertionError(ref)


def _rows(env, model, **where):
    db = env.db()
    rows = [r for r in db.scalars(select(model)).all() if all(getattr(r, k) == v for k, v in where.items())]
    db.close()
    return rows


def _b2c_audit(env, action, outcome=None):
    return [r for r in _rows(env, CustomerAdminAuditLog, action=action) if outcome is None or r.outcome == outcome]


def _refund_owed(env):
    return [r for r in _rows(env, CustomerAuditLog) if "refund owed" in (r.action or "").lower()]


def _patch(env, ref, status, who):
    return env.client.patch(f"{BK}/{ref}/status", json={"status": status}, headers=who["headers"])


@pytest.fixture()
def manager(env):
    return _user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW, P.B2C_CUSTOMERS_MANAGE], "Manny Manager")


@pytest.fixture()
def viewer(env):
    return _user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW], "Vera Viewer")


@pytest.fixture()
def superadmin(env):
    return _user(env, UserRole.SUPER_ADMIN, [], "Sam Super")


# ================================================================== D1 permission
def test_view_scopes_cannot_change_status_and_the_refusal_is_audited(env, viewer):
    _flight(env, "JPF100", status="pending")
    only_customer_view = _user(env, UserRole.ADMIN, [P.CUSTOMER_VIEW], "Legacy Viewer")
    for who in (viewer, only_customer_view):
        r = _patch(env, "JPF100", "cancelled", who)
        assert r.status_code == 403, r.text
        assert "b2c.customers.manage" in r.json()["detail"]
    assert _booking(env, "JPF100").status == "pending" and _booking(env, "JPF100").cancelled_at is None
    denied = _b2c_audit(env, "booking.update", AdminAuditOutcome.DENIED)
    assert len(denied) == 2 and all(d.reason == "missing b2c.customers.manage" for d in denied)
    assert not _b2c_audit(env, "booking.update", AdminAuditOutcome.SUCCESS)
    assert _rows(env, CustomerNotification) == [] and env.activity == []
    # the reads keep working for a viewer
    assert env.client.get(f"{BK}/JPF100", headers=viewer["headers"]).status_code == 200


def test_manage_scope_and_super_admin_can_change_status(env, manager, superadmin):
    _flight(env, "JPF101", status="pending")
    _flight(env, "JPF102", status="confirmed")
    assert _patch(env, "JPF101", "cancelled", manager).status_code == 200
    assert _patch(env, "JPF102", "cancelled", superadmin).status_code == 200
    assert _booking(env, "JPF101").status == "cancelled" and _booking(env, "JPF102").status == "cancelled"


def test_merchant_account_cannot_read_or_change_b2c_bookings(env):
    """A merchant account (no b2c.* grant) is refused on the PATCH and on the reads."""
    _flight(env, "JPF103")
    merchant = _user(env, UserRole.MERCHANT_ADMIN, [], "Mer Chant")
    assert _patch(env, "JPF103", "cancelled", merchant).status_code == 403
    assert env.client.get(f"{BK}/JPF103", headers=merchant["headers"]).status_code == 403
    assert _booking(env, "JPF103").status == "pending"


# ================================================================== transition matrix
@pytest.mark.parametrize("start,target", [
    ("confirmed", "completed"),   # C3: blocked until a completion-evidence workflow exists
    ("pending", "completed"),
    ("confirmed", "pending"),
    ("cancelled", "confirmed"),   # cancelled is terminal
    ("cancelled", "pending"),
    ("cancelled", "completed"),
    ("completed", "confirmed"),   # completed is terminal
    ("completed", "cancelled"),
    ("completed", "pending"),
])
def test_refused_transitions_are_409_with_no_write_and_a_failure_audit(env, manager, start, target):
    ref = _hotel(env, f"JPH{_id()}", status=start, pay=("captured", "900.00"))
    r = _patch(env, ref, target, manager)
    assert r.status_code == 409, r.text
    assert isinstance(r.json()["detail"], str) and r.json()["detail"]
    row = _booking(env, ref)
    assert row.status == start, "a refused transition writes nothing"
    assert _refund_owed(env) == [] and _rows(env, CustomerNotification) == []
    assert not _b2c_audit(env, "booking.update", AdminAuditOutcome.SUCCESS)
    assert len(_b2c_audit(env, "booking.update", AdminAuditOutcome.FAILURE)) == 1
    assert env.activity == []


def test_confirmed_to_completed_names_the_missing_workflow(env, manager):
    _flight(env, "JPF110", status="confirmed", pay=("captured", "560.00"))
    r = _patch(env, "JPF110", "completed", manager)
    assert r.status_code == 409 and "completion-evidence" in r.json()["detail"]
    assert _booking(env, "JPF110").status == "confirmed"


def test_same_status_is_a_200_no_op_with_no_audit(env, manager):
    _flight(env, "JPF111", status="pending")
    r = _patch(env, "JPF111", "PENDING", manager)
    assert r.status_code == 200 and r.json()["booking_status"] == "PENDING"
    assert _b2c_audit(env, "booking.update") == [] and env.activity == []


def test_unknown_status_and_unknown_booking(env, manager):
    _flight(env, "JPF112")
    for bad in ("refunded", "paid", ""):
        assert _patch(env, "JPF112", bad, manager).status_code in (400, 422), bad
    assert _patch(env, "NOPE404", "cancelled", manager).status_code == 404
    assert _booking(env, "JPF112").status == "pending"


# ================================================================== D3 confirmation via payment verification
def test_pending_to_confirmed_without_a_captured_payment_is_refused(env, manager):
    _hotel(env, "JPH120", status="pending")                                   # no payment at all
    _hotel(env, "JPH121", status="pending", pay=("pending", "900.00"))        # an attempt, not captured
    for ref in ("JPH120", "JPH121"):
        r = _patch(env, ref, "confirmed", manager)
        assert r.status_code == 409 and "no captured payment" in r.json()["detail"], r.text
        assert _booking(env, ref).status == "pending"
    assert _rows(env, CustomerNotification) == []


def test_pending_to_confirmed_with_an_amount_mismatch_is_refused(env, manager):
    _hotel(env, "JPH122", status="pending", total="900.00", pay=("captured", "899.00"))
    r = _patch(env, "JPH122", "confirmed", manager)
    assert r.status_code == 409, r.text
    assert _booking(env, "JPH122").status == "pending"
    assert _rows(env, CustomerNotification) == []


def test_pending_to_confirmed_with_a_matching_captured_payment_confirms_once(env, manager):
    _hotel(env, "JPH123", status="pending", total="900.00", pay=("captured", "900.00"))
    r = _patch(env, "JPH123", "confirmed", manager)
    assert r.status_code == 200, r.text
    assert r.json()["booking_status"] == "CONFIRMED" and r.json()["payment"]["status"] == "CAPTURED"
    assert _booking(env, "JPH123").status == "confirmed"
    notes = _rows(env, CustomerNotification)
    assert len(notes) == 1, "confirm_booking sends the existing confirmation once"
    ok = _b2c_audit(env, "booking.update", AdminAuditOutcome.SUCCESS)
    assert len(ok) == 1 and ok[0].previous_value == {"status": "pending"} and ok[0].new_value == {"status": "confirmed"}
    # a second PATCH to the same status is a no-op: no second notification or audit
    assert _patch(env, "JPH123", "confirmed", manager).status_code == 200
    assert len(_rows(env, CustomerNotification)) == 1 and len(_b2c_audit(env, "booking.update", AdminAuditOutcome.SUCCESS)) == 1


def test_package_pending_to_confirmed_uses_payment_verification(env, manager):
    ref, _dep = _package(env, "JPP124", total="20000.00", pay=("captured", "20000.00"))
    assert _patch(env, ref, "confirmed", manager).status_code == 200
    assert _booking(env, ref).status == "confirmed"


def test_held_flight_is_sent_to_the_reconciliation_desk(env, manager):
    _flight(env, "JPF125", status="pending", pay=("captured", "560.00"), supplier_status="reservation_missing")
    r = _patch(env, "JPF125", "confirmed", manager)
    assert r.status_code == 409 and "Reconciliation" in r.json()["detail"]
    assert _booking(env, "JPF125").status == "pending"


# ================================================================== D5 / D6 cancellation through the product path
def test_admin_cancel_runs_the_product_cancel_and_notifies_in_app_once(env, manager):
    _flight(env, "JPF130", status="confirmed")
    r = _patch(env, "JPF130", "cancelled", manager)
    assert r.status_code == 200, r.text
    row = _booking(env, "JPF130")
    assert row.status == "cancelled" and row.cancelled_at is not None, "product cancel() stamps cancelled_at"
    notes = _rows(env, CustomerNotification)
    assert len(notes) == 1 and notes[0].notification_type == "booking_cancelled" and notes[0].related_ref == "JPF130"
    assert any(a.action == "Booking cancelled by support" for a in _rows(env, CustomerAuditLog))
    assert _refund_owed(env) == [], "an unpaid flight owes nothing"
    ok = _b2c_audit(env, "booking.update", AdminAuditOutcome.SUCCESS)
    assert len(ok) == 1 and ok[0].previous_value == {"status": "confirmed"} and ok[0].new_value == {"status": "cancelled"}
    assert [a["action"] for a in env.activity] == ["Customer booking status changed"]


def test_paid_flight_cancel_flags_refund_only_when_the_reservation_is_missing(env, manager):
    _flight(env, "JPF131", status="confirmed", pay=("captured", "560.00"))
    _flight(env, "JPF132", status="pending", pay=("captured", "560.00"), supplier_status="reservation_missing")
    assert _patch(env, "JPF131", "cancelled", manager).status_code == 200
    assert _refund_owed(env) == [], "flight rule unchanged: flag only when the supplier reservation is missing"
    assert _patch(env, "JPF132", "cancelled", manager).status_code == 200
    assert len(_refund_owed(env)) == 1


def test_paid_hotel_admin_cancel_records_refund_owed_with_amount_and_currency(env, manager):
    _hotel(env, "JPH133", status="confirmed", total="900.00", pay=("captured", "900.00"))
    assert _patch(env, "JPH133", "cancelled", manager).status_code == 200
    owed = _refund_owed(env)
    assert len(owed) == 1
    assert "900" in owed[0].description and "INR" in owed[0].description and "No refund has been issued" in owed[0].description
    assert str(owed[0].status).lower().endswith("failed")
    # No refund row was created and no payment changed state.
    assert _rows(env, CustomerRefundAttempt) == []
    assert [p.status for p in _rows(env, CustomerHotelBookingPayment)] == ["captured"]


def test_unpaid_hotel_cancel_records_no_refund_owed(env, manager):
    _hotel(env, "JPH134", status="pending")
    assert _patch(env, "JPH134", "cancelled", manager).status_code == 200
    assert _refund_owed(env) == []


def test_customer_side_hotel_cancel_also_records_refund_owed(env):
    """X2 is in the product cancel(), which the customer's own Cancel button calls too."""
    from app.services import customer_hotel_booking_service as hotels

    _hotel(env, "JPH135", status="confirmed", pay=("captured", "900.00"))
    db = env.db()
    booking = db.scalars(select(CustomerHotelBooking).where(CustomerHotelBooking.booking_ref == "JPH135")).one()
    hotels.cancel(db, booking)
    db.commit()
    db.close()
    assert len(_refund_owed(env)) == 1 and _booking(env, "JPH135").status == "cancelled"


def test_package_admin_cancel_releases_seats_and_flags_a_captured_payment(env, manager):
    ref, dep = _package(env, "JPP136", status="confirmed", pax=2, seats=5, pay=("captured", "20000.00"))
    assert _patch(env, ref, "cancelled", manager).status_code == 200
    db = env.db()
    assert db.get(CustomerPackageDeparture, dep).seats_left == 7, "the 2 seats go back on sale"
    db.close()
    assert len(_refund_owed(env)) == 1


def test_a_failing_audit_write_rolls_the_whole_status_change_back(env, manager, monkeypatch):
    _hotel(env, "JPH140", status="confirmed", pay=("captured", "900.00"))

    def _fail(*a, **k):
        raise RuntimeError("audit store down")

    monkeypatch.setattr(admin_customer_bookings.b2c_audit, "record_in_session", _fail)
    r = _patch(env, "JPH140", "cancelled", manager)
    assert r.status_code == 500
    row = _booking(env, "JPH140")
    assert row.status == "confirmed" and row.cancelled_at is None
    assert _refund_owed(env) == [] and _rows(env, CustomerNotification) == [], "side effects roll back with it"


# ================================================================== X1 / C6 / C7 cancellation requests
def _decide(env, ref, action, who, **extra):
    return env.client.patch(f"{CX}/{ref}", json={"action": action, **extra}, headers=who["headers"])


@pytest.fixture()
def desk(env):
    """A cancellations-desk admin with the booking-management scope (C7)."""
    return _user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW, P.B2C_CUSTOMERS_MANAGE], "Desk Dana")


def test_approve_and_reject_require_customers_manage(env, viewer):
    _flight(env, "JPF150", status="confirmed")
    ref = _request(env, "JPF150", "flight")
    for action in ("approve", "reject"):
        r = _decide(env, ref, action, viewer)
        assert r.status_code == 403 and "b2c.customers.manage" in r.json()["detail"], r.text
    assert _rows(env, CustomerCancellationRequest)[0].status == "requested"
    assert _booking(env, "JPF150").status == "confirmed"
    assert len(_b2c_audit(env, "cancellation.approve", AdminAuditOutcome.DENIED)) == 1
    assert len(_b2c_audit(env, "cancellation.reject", AdminAuditOutcome.DENIED)) == 1


def test_approve_cancels_through_the_product_path(env, desk):
    _hotel(env, "JPH151", status="confirmed", pay=("captured", "900.00"))
    ref = _request(env, "JPH151", "hotel")
    r = _decide(env, ref, "approve", desk)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    row = _booking(env, "JPH151")
    assert row.status == "cancelled" and row.cancelled_at is not None
    assert len(_refund_owed(env)) == 1, "paid hotel -> refund-owed record (no refund issued)"
    notes = _rows(env, CustomerNotification)
    assert len(notes) == 1 and notes[0].notification_type == "booking_cancelled"
    assert _rows(env, CustomerRefundAttempt) == []


def test_super_admin_is_refused_by_the_unchanged_desk_gate(env, superadmin):
    """PINNED CURRENT BEHAVIOUR (open owner decision, see tracker): the cancellations desk routes keep their
    pre-existing ``customer.view`` gate, which the Super Admin role does not hold, so a super admin cannot
    approve here even though ``has_b2c_scope`` would pass. Nothing changes."""
    _flight(env, "JPF152", status="pending")
    ref = _request(env, "JPF152", "flight")
    r = _decide(env, ref, "approve", superadmin)
    assert r.status_code == 403 and "customer.view" in r.json()["detail"]
    assert _booking(env, "JPF152").status == "pending"
    # ...while an explicit customer.view grant (no b2c.customers.manage needed for a super admin) lets it through
    sa_with_view = _user(env, UserRole.SUPER_ADMIN, [P.CUSTOMER_VIEW], "Sam With View")
    assert _decide(env, ref, "approve", sa_with_view).status_code == 200
    assert _booking(env, "JPF152").status == "cancelled"


def test_approving_an_already_cancelled_booking_does_not_cancel_or_flag_twice(env, desk):
    _hotel(env, "JPH153", status="confirmed", pay=("captured", "900.00"))
    ref = _request(env, "JPH153", "hotel")
    from app.services import customer_hotel_booking_service as hotels
    db = env.db()
    hotels.cancel(db, db.scalars(select(CustomerHotelBooking).where(CustomerHotelBooking.booking_ref == "JPH153")).one())
    db.commit()
    db.close()
    first_cancelled_at = _booking(env, "JPH153").cancelled_at
    assert len(_refund_owed(env)) == 1
    r = _decide(env, ref, "approve", desk)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert len(_refund_owed(env)) == 1, "no second refund-owed record"
    assert _booking(env, "JPH153").cancelled_at == first_cancelled_at
    assert _rows(env, CustomerNotification) == [], "the customer's own cancel route notifies; approval adds none"


def test_approving_a_completed_booking_is_refused_and_changes_nothing(env, desk):
    _flight(env, "JPF154", status="completed", pay=("captured", "560.00"))
    ref = _request(env, "JPF154", "flight")
    r = _decide(env, ref, "approve", desk)
    assert r.status_code == 409 and "completed" in r.json()["detail"]
    assert _booking(env, "JPF154").status == "completed"
    assert _rows(env, CustomerCancellationRequest)[0].status == "requested"
    assert _refund_owed(env) == [] and _rows(env, CustomerNotification) == []


def test_reject_leaves_the_booking_alone(env, desk):
    _flight(env, "JPF155", status="confirmed")
    ref = _request(env, "JPF155", "flight")
    r = _decide(env, ref, "reject", desk)
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert _booking(env, "JPF155").status == "confirmed"


def test_decisions_only_from_requested(env, desk):
    _flight(env, "JPF156", status="confirmed")
    ref = _request(env, "JPF156", "flight", status="approved")
    assert _decide(env, ref, "approve", desk).status_code == 400
    assert _decide(env, ref, "reject", desk).status_code == 400
    assert _booking(env, "JPF156").status == "confirmed"


def test_refund_actions_are_not_widened_by_customers_manage(env, desk):
    """C7 authorises booking decisions only: start_refund keeps its own refund.execute check."""
    _flight(env, "JPF157", status="cancelled", pay=("captured", "560.00"))
    ref = _request(env, "JPF157", "flight", status="approved")
    holder = _user(env, UserRole.MANAGER, [P.B2C_CUSTOMERS_MANAGE], "Mgr Manage")
    r = _decide(env, ref, "start_refund", holder, refund_amount="560.00")
    assert r.status_code == 403
    assert _rows(env, CustomerRefundAttempt) == []


# ================================================================== RBAC unit checks (D2 new code, has_b2c_scope)
def test_customers_export_code_is_a_b2c_scope_held_by_no_role_default():
    from app.auth import rbac

    assert P.B2C_CUSTOMERS_EXPORT == "b2c.customers.export"
    assert P.B2C_CUSTOMERS_EXPORT in rbac.B2C_SCOPES and P.B2C_CUSTOMERS_EXPORT in rbac.ALL_PERMISSION_CODES
    for role, codes in rbac.ROLE_PERMISSIONS.items():
        assert not (codes & rbac.B2C_SCOPES), role
    for mrole, codes in rbac.MERCHANT_ROLE_PERMISSIONS.items():
        assert not (codes & rbac.B2C_SCOPES), mrole


def test_has_b2c_scope_ignores_role_defaults():
    from app.auth.rbac import has_b2c_scope

    sa = User(user_id=1, role=UserRole.SUPER_ADMIN, permissions=[])
    granted = User(user_id=2, role=UserRole.ADMIN, permissions=[P.B2C_CUSTOMERS_MANAGE])
    legacy = User(user_id=3, role=UserRole.ADMIN, permissions=[P.CUSTOMER_VIEW])
    assert has_b2c_scope(sa, P.B2C_CUSTOMERS_EXPORT) is True
    assert has_b2c_scope(granted, P.B2C_CUSTOMERS_MANAGE) is True
    assert has_b2c_scope(granted, P.B2C_CUSTOMERS_EXPORT) is False
    assert has_b2c_scope(legacy, P.B2C_CUSTOMERS_MANAGE) is False
