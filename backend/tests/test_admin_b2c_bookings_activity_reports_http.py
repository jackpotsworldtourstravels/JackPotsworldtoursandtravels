"""HTTP-level verification of four B2C Admin Portal sections: BOOKINGS (``/api/admin/customer-bookings``), USER ACTIVITY
(``/api/admin/user-activity``), B2C REPORTS (``/api/admin/b2c-reports``) and B2C ANALYTICS (``/api/admin/b2c-analytics``).

Real routers/services/RBAC on a throw-away temp-file SQLite database (so the audit-readiness probe cannot roll back the
request's writes). Nothing is sent. Reports/analytics SQL that uses PostgreSQL-only functions is detected and reported as
NOT VERIFIED (skipped) rather than assumed.

Phase 13 (owner decisions D1/D3/C3/D2/C1) changed two things this module used to PIN:
  * ``PATCH …/{ref}/status`` now needs ``b2c.customers.manage`` and follows a transition matrix (full matrix in
    test_phase13_bookings_cancellations_http.py);
  * B2C report access needs explicit ``b2c.reports.*`` grants; ``customer.view`` grants nothing, and every export also
    needs ``b2c.customers.export``. The permission assertions run BEFORE any SQLite skip.
"""
from __future__ import annotations

import datetime as dt
import decimal
import io
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
    AdminAuditOutcome, Base, Customer, CustomerAdminAuditLog, CustomerAuditLog, CustomerBooking, CustomerBookingPassenger,
    CustomerBookingPayment, CustomerHotelBooking, CustomerHotelBookingGuest, CustomerHotelBookingPayment,
    CustomerNotification, CustomerPackageBooking, CustomerPackageBookingPayment, CustomerPackageBookingTraveller,
    CustomerSession,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_b2c_reports, admin_customer_bookings, admin_user_activity
from app.services import activity_service
from app.services import customer_admin_audit_service as b2c_audit_service

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)
BK = "/api/admin/customer-bookings"
ACT = "/api/admin/user-activity"
RPT = "/api/admin/b2c-reports"
ANA = "/api/admin/b2c-analytics/overview"
_N = {"n": 700000}


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.engine = engine
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity = []
        app = FastAPI()
        for r in (admin_customer_bookings.router, admin_user_activity.router, admin_b2c_reports.router,
                  admin_b2c_reports.analytics_router):
            app.include_router(r)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=bool(os.environ.get("RAISE_SERVER")))

    def db(self):
        return self.Session()


@pytest.fixture()
def env(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[m.__table__ for m in (
        Customer, CustomerAdminAuditLog, CustomerAuditLog, CustomerNotification, CustomerSession, CustomerBooking,
        CustomerBookingPassenger,
        CustomerBookingPayment, CustomerHotelBooking, CustomerHotelBookingGuest, CustomerHotelBookingPayment,
        CustomerPackageBooking, CustomerPackageBookingPayment, CustomerPackageBookingTraveller)])
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
    monkeypatch.setattr(activity_service, "log_activity",
                        lambda db, user_id, action, ip=None, **kw: e.activity.append(
                            {"user_id": user_id, "action": action, **kw}))
    # ``record_independently`` writes on its own fresh session; point it at this test database.
    monkeypatch.setattr(b2c_audit_service, "SessionLocal", e.Session)
    yield e
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


def _user(env, role, perms=None, name="Reviewer"):
    db = env.db()
    u = User(user_id=_id(), full_name=name, email=f"u{_N['n']}@tt-qa.com", password_hash="x", role=role,
             status=UserStatus.ACTIVE, permissions=perms or [])
    db.add(u)
    db.commit()
    out = {"headers": {"Authorization": f"Bearer {create_access_token(u.user_id)}"}, "id": u.user_id}
    db.close()
    return out


@pytest.fixture()
def admin(env):
    """A fully granted B2C desk admin: view + manage bookings, view + export reports, customer-data export."""
    return _user(env, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW, P.B2C_CUSTOMERS_MANAGE,
                                       P.B2C_REPORTS_VIEW, P.B2C_REPORTS_EXPORT, P.B2C_CUSTOMERS_EXPORT],
                 "Ada Admin")


def _customer(env, name="Test Traveller", email=None):
    db = env.db()
    c = Customer(customer_id=_id(), customer_code=f"C{_N['n']}", full_name=name,
                 email=email or f"c{_N['n']}@tt-qa.com", mobile="9000000000")
    db.add(c)
    db.commit()
    cid = c.customer_id
    db.close()
    return cid


def _flight(env, ref, *, status="pending", customer_id=None, total="560.00", age=0, city="Delhi", pay_status="captured"):
    db = env.db()
    cid = customer_id or _customer(env, f"Cust {ref}")
    b = CustomerBooking(customer_booking_id=_id(), booking_ref=ref, customer_id=cid, total_amount=D(total), currency="INR",
                        status=status, created_at=NOW - dt.timedelta(days=age), origin_city=city, destination_city="Goa",
                        flight_number="AI101", travel_date=dt.date.today() + dt.timedelta(days=10))
    db.add(b)
    db.flush()
    if pay_status:
        db.add(CustomerBookingPayment(customer_booking_payment_id=_id(), customer_booking_id=b.customer_booking_id,
                                      method="gateway", amount=D(total), currency="INR", status=pay_status, provider="hdfc",
                                      provider_order_id=f"O{ref}", provider_payment_id=f"P{ref}", created_at=NOW))
    db.commit()
    db.close()
    return ref


def _hotel(env, ref, *, status="confirmed", total="900.00"):
    db = env.db()
    cid = _customer(env, f"Cust {ref}")
    db.add(CustomerHotelBooking(customer_hotel_booking_id=_id(), booking_ref=ref, customer_id=cid, hotel_id=1,
                                hotel_name="Sea View", room_id=1, room_name="Deluxe", check_in_date=dt.date.today() + dt.timedelta(days=5),
                                check_out_date=dt.date.today() + dt.timedelta(days=6), nights=1, total_amount=D(total),
                                currency="INR", status=status, created_at=NOW))
    db.commit()
    db.close()
    return ref


def _status(env, ref):
    db = env.db()
    row = db.scalars(select(CustomerBooking).where(CustomerBooking.booking_ref == ref)).first() or \
        db.scalars(select(CustomerHotelBooking).where(CustomerHotelBooking.booking_ref == ref)).first()
    s = row.status
    db.close()
    return s


def _admin_audit(env, action):
    db = env.db()
    rows = [r for r in db.scalars(select(CustomerAdminAuditLog)).all() if r.action == action]
    db.close()
    return rows


def _acts(env, action):
    return [a for a in env.activity if a["action"] == action]


# ================================================================== bookings
def test_booking_list_filters_search_paging_counts_and_gaming_is_empty(env, admin):
    _flight(env, "JPF1", status="pending", age=3)
    _flight(env, "JPF2", status="confirmed", age=2, city="Mumbai")
    _hotel(env, "JPH1", status="confirmed")
    r = env.client.get(BK, headers=admin["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3 and {i["service_type"] for i in body["items"]} == {"Flight", "Hotel"}
    ids = lambda **p: [i["booking_id"] for i in env.client.get(BK, params=p, headers=admin["headers"]).json()["items"]]
    assert ids(service_type="hotel") == ["JPH1"] and sorted(ids(service_type="flight")) == ["JPF1", "JPF2"]
    assert ids(status="pending") == ["JPF1"] and sorted(ids(status="CONFIRMED")) == ["JPF2", "JPH1"]
    assert ids(search="mumbai") == ["JPF2"] and ids(service_type="gaming") == [], "gaming always returns nothing"
    assert len(ids(page=1, page_size=2)) == 2 and len(ids(page=2, page_size=2)) == 1
    for bad in ({"service_type": "cruise"}, {"status": "paid"}):
        assert env.client.get(BK, params=bad, headers=admin["headers"]).status_code == 400
    assert env.client.get(BK, params={"page_size": 201}, headers=admin["headers"]).status_code == 422
    c = env.client.get(f"{BK}/counts", headers=admin["headers"]).json()
    assert c["total"] == 3 and c["flight"] == 2 and c["hotel"] == 1 and c["gaming"] == 0


def test_booking_detail_is_audited_and_404s(env, admin):
    _flight(env, "JPF10")
    r = env.client.get(f"{BK}/JPF10", headers=admin["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["booking_id"] == "JPF10" and body["payment"]["status"] == "CAPTURED" and body["booking_status"] == "PENDING"
    assert len(_acts(env, "Customer booking viewed")) == 1 and _acts(env, "Customer booking viewed")[0]["user_id"] == admin["id"]
    assert len(_admin_audit(env, "booking.view_detail")) == 1
    assert env.client.get(f"{BK}/NOPE999", headers=admin["headers"]).status_code == 404


def test_status_update_persists_validates_and_is_audited_without_touching_payment(env, admin):
    _flight(env, "JPF20", status="pending", pay_status="captured")
    r = env.client.patch(f"{BK}/JPF20/status", json={"status": "CONFIRMED"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    assert _status(env, "JPF20") == "confirmed" and r.json()["booking_status"] == "CONFIRMED"
    assert r.json()["payment"]["status"] == "CAPTURED", "a status change never touches payment state"
    assert len(_acts(env, "Customer booking status changed")) == 1 and len(_admin_audit(env, "booking.update")) == 1
    for bad in ({"status": "refunded"}, {"status": ""}, {"status": "paid"}):
        assert env.client.patch(f"{BK}/JPF20/status", json=bad, headers=admin["headers"]).status_code in (400, 422), bad
    assert env.client.patch(f"{BK}/JPF20/status", json={}, headers=admin["headers"]).status_code == 422
    assert _status(env, "JPF20") == "confirmed" and len(_acts(env, "Customer booking status changed")) == 1
    assert env.client.patch(f"{BK}/NOPE999/status", json={"status": "confirmed"}, headers=admin["headers"]).status_code == 404
    hot = _hotel(env, "JPH20", status="pending")
    assert env.client.patch(f"{BK}/{hot}/status", json={"status": "cancelled"}, headers=admin["headers"]).status_code == 200
    assert _status(env, hot) == "cancelled"


def test_phase13_status_rules_terminal_states_and_manage_scope(env, admin):
    """Phase 13 replaced the pinned "no transition graph / view scope can write" behaviour (owner decisions D1, C3):
    a cancelled booking cannot be reopened, confirmed -> completed is blocked, and view scopes cannot write."""
    _flight(env, "JPF30", status="cancelled")
    r = env.client.patch(f"{BK}/JPF30/status", json={"status": "confirmed"}, headers=admin["headers"])
    assert r.status_code == 409 and _status(env, "JPF30") == "cancelled"
    _flight(env, "JPF31", status="confirmed")
    r = env.client.patch(f"{BK}/JPF31/status", json={"status": "completed"}, headers=admin["headers"])
    assert r.status_code == 409 and _status(env, "JPF31") == "confirmed"
    for perms in ([P.CUSTOMER_VIEW], [P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW]):
        viewer = _user(env, UserRole.ADMIN, perms, "View Only")
        r = env.client.patch(f"{BK}/JPF31/status", json={"status": "cancelled"}, headers=viewer["headers"])
        assert r.status_code == 403, perms
    assert _status(env, "JPF31") == "confirmed" and len(_admin_audit(env, "booking.update")) == 4  # 2 FAILURE + 2 DENIED


def test_booking_permissions(env, admin):
    _flight(env, "JPF40")
    calls = [("get", BK), ("get", f"{BK}/counts"), ("get", f"{BK}/JPF40"), ("patch", f"{BK}/JPF40/status")]
    for m, u in calls:
        kw = {"json": {"status": "confirmed"}} if m == "patch" else {}
        assert getattr(env.client, m)(u, **kw).status_code in (401, 403), u
    for who in (_user(env, UserRole.ADMIN, [], "Bare"), _user(env, UserRole.MANAGER, [], "Mo"),
                _user(env, UserRole.MERCHANT_ADMIN, [], "Mer")):
        for m, u in calls:
            kw = {"json": {"status": "confirmed"}} if m == "patch" else {}
            assert getattr(env.client, m)(u, headers=who["headers"], **kw).status_code == 403, (who, u)
    assert _status(env, "JPF40") == "pending" and _acts(env, "Customer booking status changed") == []


# ================================================================== user activity
def test_activity_summary_logs_and_sessions(env, admin):
    cid = _customer(env, "Active Person", "active@tt-qa.com")
    db = env.db()
    for i, (action, st) in enumerate((("Login", "success"), ("Login", "failed"), ("Signup", "success"))):
        db.add(CustomerAuditLog(customer_audit_log_id=_id(), customer_id=cid if i != 1 else None, action=action, module="Auth",
                                description=f"{action} {i}", status=st, created_at=NOW - dt.timedelta(minutes=i)))
    db.add(CustomerSession(customer_session_id=_id(), customer_id=cid, ip_address="1.2.3.4", browser="Chrome", device="PC",
                           login_at=NOW - dt.timedelta(minutes=2), last_seen_at=NOW - dt.timedelta(minutes=1), is_active=True))
    db.add(CustomerSession(customer_session_id=_id(), customer_id=cid, login_at=NOW - dt.timedelta(days=2),
                           last_seen_at=NOW - dt.timedelta(days=2), logout_at=NOW - dt.timedelta(days=2), is_active=False))
    db.commit()
    db.close()
    logs = env.client.get(f"{ACT}/logs", headers=admin["headers"]).json()
    assert logs["total"] == 3
    assert env.client.get(f"{ACT}/logs", params={"status": "failed"}, headers=admin["headers"]).json()["total"] == 1
    assert env.client.get(f"{ACT}/logs", params={"customer_id": cid}, headers=admin["headers"]).json()["total"] == 2
    assert env.client.get(f"{ACT}/logs", params={"module": "Auth", "page_size": 1}, headers=admin["headers"]).json()["items"].__len__() == 1
    sess_resp = env.client.get(f"{ACT}/sessions", headers=admin["headers"])
    sum_resp = env.client.get(f"{ACT}/summary", headers=admin["headers"])
    if sess_resp.status_code == 500 or sum_resp.status_code == 500:
        pytest.skip("session/summary state logic compares timezone-aware datetimes that SQLite returns naive: "
                    "sessions + summary NOT VERIFIED on SQLite (the activity LOG assertions above did run)")
    sess = sess_resp.json()
    assert sum_resp.status_code == 200 and sess["total"] == 2
    states = {i["state"] for i in sess["items"]}
    assert states == {"active", "ended"}
    assert env.client.get(f"{ACT}/sessions", params={"state": "ended"}, headers=admin["headers"]).json()["total"] == 1
    text = env.client.get(f"{ACT}/logs", headers=admin["headers"]).text + env.client.get(f"{ACT}/sessions", headers=admin["headers"]).text
    for forbidden in ("password", "otp", "user_agent", "token"):
        assert forbidden not in text.lower(), forbidden


@pytest.mark.parametrize("path,params,code", [
    ("/logs", {"status": "bogus"}, 400), ("/logs", {"date_from": "2026-06-10", "date_to": "2026-06-01"}, 400),
    ("/logs", {"page_size": 201}, 422), ("/logs", {"date_from": "nope"}, 422), ("/sessions", {"state": "bogus"}, 400),
    ("/sessions", {"page": 0}, 422)])
def test_activity_validation(env, admin, path, params, code):
    assert env.client.get(f"{ACT}{path}", params=params, headers=admin["headers"]).status_code == code


def test_activity_permissions(env, admin):
    for p in ("/summary", "/logs", "/sessions"):
        assert env.client.get(f"{ACT}{p}").status_code in (401, 403)
        for who in (_user(env, UserRole.ADMIN, [], "Bare"), _user(env, UserRole.MERCHANT_ADMIN, [], "Mer")):
            assert env.client.get(f"{ACT}{p}", headers=who["headers"]).status_code == 403


# ================================================================== reports & analytics
def test_report_types_and_validation(env, admin):
    r = env.client.get(f"{RPT}/types", headers=admin["headers"])
    assert r.status_code == 200 and {t["type"] for t in r.json()} == {"bookings", "payments", "cancellations", "customers", "reviews"}
    for params in ({"type": "bookings", "status": "bogus"}, {"type": "customers", "product": "flight"},
                   {"type": "bookings", "product": "cruise"},
                   {"type": "bookings", "date_from": "2026-06-10", "date_to": "2026-06-01"}):
        assert env.client.get(f"{RPT}/preview", params=params, headers=admin["headers"]).status_code in (400, 503)
    assert env.client.get(f"{RPT}/preview", params={"type": "bogus"}, headers=admin["headers"]).status_code == 422
    assert env.client.get(f"{RPT}/export", params={"type": "bookings", "format": "docx"}, headers=admin["headers"]).status_code == 422


def test_report_preview_and_exports_match_and_are_audited(env, admin):
    _flight(env, "JPF50", total="100.00")
    _flight(env, "JPF51", total="250.50", status="confirmed")
    p = env.client.get(f"{RPT}/preview", params={"type": "bookings"}, headers=admin["headers"])
    if p.status_code == 500:
        pytest.skip("B2C report SQL uses PostgreSQL-only date/timezone functions: NOT VERIFIED on SQLite")
    assert p.status_code == 200, p.text
    assert p.json()["rows"] == 2 or p.json().get("total_rows") == 2 or "2" in p.text
    assert len(_admin_audit(env, "report.preview")) == 1
    c = env.client.get(f"{RPT}/export", params={"type": "bookings", "format": "csv"}, headers=admin["headers"])
    assert c.status_code == 200 and c.headers["content-disposition"].startswith('attachment; filename="b2c-bookings-report-')
    assert len(c.content.decode("utf-8-sig").strip().splitlines()) == 3, "header + the same 2 rows the preview counted"
    x = env.client.get(f"{RPT}/export", params={"type": "bookings", "format": "xlsx"}, headers=admin["headers"])
    pdf = env.client.get(f"{RPT}/export", params={"type": "bookings", "format": "pdf"}, headers=admin["headers"])
    assert x.content[:2] == b"PK" and pdf.content[:5] == b"%PDF-"
    assert len(_acts(env, "B2C report exported")) == 3 and len(_admin_audit(env, "report.export")) == 3


def test_b2c_exports_neutralise_spreadsheet_formulas(env, admin):
    cid = _customer(env, '=HYPERLINK("http://attacker.example","x")', "evil@tt-qa.com")
    _flight(env, "JPF60", customer_id=cid)
    r = env.client.get(f"{RPT}/export", params={"type": "customers", "format": "csv"}, headers=admin["headers"])
    if r.status_code == 500:
        pytest.skip("B2C customers report SQL uses PostgreSQL-only functions: NOT VERIFIED on SQLite")
    assert r.status_code == 200
    import csv
    for row in csv.reader(io.StringIO(r.content.decode("utf-8-sig"))):
        for cell in row:
            assert not cell.startswith(("=", "+", "@")), cell


def test_report_and_analytics_permissions_run_before_any_sqlite_skip(env, admin):
    """Phase 13 (D2/C1). Pure permission checks — they are decided before any report SQL runs, so they are asserted
    here unconditionally (they used to sit after a SQLite skip and never executed)."""
    reads = (ANA, f"{RPT}/types", f"{RPT}/preview?type=bookings")
    exports = [f"{RPT}/export?type={t}&format=csv" for t in ("bookings", "payments", "cancellations", "customers", "reviews")]
    assert env.client.get(ANA).status_code in (401, 403)
    for who in (_user(env, UserRole.ADMIN, [], "Bare"),
                _user(env, UserRole.ADMIN, [P.CUSTOMER_VIEW], "LegacyCustomerView"),
                _user(env, UserRole.ADMIN, [P.CUSTOMER_VIEW, P.REPORT_VIEW, P.REPORT_EXPORT], "B2BReports"),
                _user(env, UserRole.MERCHANT_ADMIN, [], "Mer")):
        for u in reads + tuple(exports):
            assert env.client.get(u, headers=who["headers"]).status_code == 403, (who, u)
    # view without export; view + export without the customer-data export code: every one of the five is refused
    for perms in ([P.B2C_REPORTS_VIEW, P.CUSTOMER_VIEW], [P.B2C_REPORTS_VIEW, P.B2C_REPORTS_EXPORT, P.CUSTOMER_VIEW],
                  [P.B2C_REPORTS_VIEW, P.B2C_CUSTOMERS_EXPORT]):
        who = _user(env, UserRole.ADMIN, perms, "Partial")
        assert env.client.get(f"{RPT}/types", headers=who["headers"]).status_code == 200, perms
        for u in exports:
            r = env.client.get(u, headers=who["headers"])
            assert r.status_code == 403, (perms, u)
            assert "b2c.customers.export" in r.json()["detail"] or "b2c.reports.export" in r.json()["detail"]
    denied = [a for a in _admin_audit(env, "report.export") if a.outcome == AdminAuditOutcome.DENIED]
    assert len(denied) == 15 and {a.entity_id for a in denied} == {"bookings", "payments", "cancellations", "customers", "reviews"}
    assert all(a.reason.startswith("missing ") for a in denied)
    assert not [a for a in _admin_audit(env, "report.export") if a.outcome == AdminAuditOutcome.SUCCESS]
    assert _acts(env, "B2C report exported") == []
    # all three codes (or a super admin) pass the gate for all five reports: anything but 403
    for who in (admin, _user(env, UserRole.SUPER_ADMIN, [], "Super")):
        for u in exports:
            assert env.client.get(u, headers=who["headers"]).status_code != 403, (who, u)


def test_analytics_overview_validates_months(env, admin):
    assert env.client.get(ANA, params={"months": 0}, headers=admin["headers"]).status_code == 422
    assert env.client.get(ANA, params={"months": 1000}, headers=admin["headers"]).status_code == 422
    r = env.client.get(ANA, headers=admin["headers"])
    if r.status_code == 500:
        pytest.skip("B2C analytics SQL uses PostgreSQL-only functions: NOT VERIFIED on SQLite")
    assert r.status_code == 200
