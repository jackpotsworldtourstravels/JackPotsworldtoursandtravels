"""PHASE 13 — PostgreSQL integration tests (run ONLY against the disposable Phase 13 Docker database).

SAFETY: every test in this module SKIPS unless ``PHASE13_PG=1`` is set AND the resolved application settings point at
``127.0.0.1:55434/jackpots_phase13_test`` (a throw-away PostgreSQL 17 container created for Phase 13), and the live
connection reports that same database name. In a normal ``pytest`` run the module is skipped, so nothing can reach
``jackpots_v2`` or any other database. Email/SMS/push delivery, the payment provider's refund call and supplier calls
are blocked (they raise if reached).

Covers on real PostgreSQL what SQLite could not prove for Phase 13: the real B2C report SQL behind the export gate,
``customer_admin_audit_logs`` rows for DENIED / SUCCESS / FAILURE, real FK-constrained bookings going through the
product cancel()/confirm_booking paths (refund-owed rows, notifications, seat release), row locking when two admins
cancel the same package at once, and the claim race when two agents claim the same conversation at once.
"""
from __future__ import annotations

import concurrent.futures
import datetime as dt
import decimal
import os
import smtplib
import threading
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.config import settings

_DB = "jackpots_phase13_test"
_TARGET = f"@127.0.0.1:55434/{_DB}"
pytestmark = pytest.mark.skipif(
    os.environ.get("PHASE13_PG") != "1" or not settings.database_url.endswith(_TARGET)
    or "jackpots_v2" in settings.database_url,
    reason="Phase 13 PostgreSQL tests run only against the disposable Phase 13 Docker database",
)

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)


def _u():
    return uuid.uuid4().hex[:8]


@pytest.fixture(scope="module")
def pg():
    from app.database.session import SessionLocal, engine
    from app.main import app

    with engine.connect() as c:
        name = c.execute(text("select current_database()")).scalar_one()
    assert name == _DB, name

    class PG:
        pass

    p = PG()
    p.Session = SessionLocal
    p.app = app
    return p


@pytest.fixture(autouse=True)
def _no_external(monkeypatch, pg):
    from app.auth.rate_limit import limiter
    from app.services import delivery_service, notification_service
    from app.services import payments as payment_providers

    def _blocked(*a, **k):
        raise AssertionError("an external channel was reached during a Phase 13 PostgreSQL test")

    monkeypatch.setattr(limiter, "enabled", False)
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant",
                 "notify_managers"):
        if hasattr(notification_service, name):
            monkeypatch.setattr(notification_service, name, lambda *a, **k: 0)
    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)
    for name in ("refund", "create_refund", "issue_refund"):
        if hasattr(payment_providers, name):
            monkeypatch.setattr(payment_providers, name, _blocked)


def _client(pg):
    return TestClient(pg.app, raise_server_exceptions=False)


# ------------------------------------------------------------------ seed helpers (real FK-constrained rows)
def _user(pg, role, perms=(), name="PG13 User"):
    from app.auth.security import create_access_token, hash_password
    from app.models_v2 import User, UserStatus
    db = pg.Session()
    u = User(full_name=name, email=f"p13{_u()}@tt-qa.com", password_hash=hash_password("Throwaway#13"), role=role,
             status=UserStatus.ACTIVE, permissions=list(perms))
    db.add(u)
    db.commit()
    out = {"id": u.user_id, "name": name, "headers": {"Authorization": f"Bearer {create_access_token(u.user_id)}"}}
    db.close()
    return out


def _customer(db):
    from app.models_customer import Customer
    c = Customer(customer_code=f"P13{_u()}".upper(), full_name=f"PG Traveller {_u()}", email=f"c{_u()}@tt-qa.com",
                 mobile="9" + str(uuid.uuid4().int)[:9])
    db.add(c)
    db.flush()
    return c


def _hotel_booking(pg, *, status="pending", total="900.00", pay=None):
    from app.models_customer import CustomerHotel, CustomerHotelBooking, CustomerHotelBookingPayment, CustomerHotelRoom
    db = pg.Session()
    c = _customer(db)
    h = CustomerHotel(name=f"PG13 Hotel {_u()}", location="Goa")
    db.add(h)
    db.flush()
    r = CustomerHotelRoom(hotel_id=h.customer_hotel_id, code=f"R{_u()}", name="Deluxe", base_price_per_night=D(total))
    db.add(r)
    db.flush()
    ref = f"JPH{_u()}".upper()[:20]
    b = CustomerHotelBooking(booking_ref=ref, customer_id=c.customer_id, hotel_id=h.customer_hotel_id,
                             hotel_name=h.name, room_id=r.customer_hotel_room_id, room_name="Deluxe",
                             check_in_date=dt.date.today() + dt.timedelta(days=20),
                             check_out_date=dt.date.today() + dt.timedelta(days=21), nights=1,
                             total_amount=D(total), currency="INR", status=status)
    db.add(b)
    db.flush()
    if pay:
        db.add(CustomerHotelBookingPayment(hotel_booking_id=b.customer_hotel_booking_id, method="gateway",
                                           amount=D(pay[1]), currency="INR", status=pay[0], provider="hdfc",
                                           provider_order_id=f"O{_u()}", provider_payment_id=f"P{_u()}"))
    db.commit()
    out = (ref, c.customer_id)
    db.close()
    return out


def _package_booking(pg, *, status="confirmed", pax=2, seats=5, pay=("captured", "20000.00")):
    from app.models_customer import (
        CustomerPackage, CustomerPackageBooking, CustomerPackageBookingPayment, CustomerPackageDeparture,
    )
    db = pg.Session()
    c = _customer(db)
    p = CustomerPackage(name=f"PG13 Package {_u()}", blurb="test", days=4, price_from=D("10000.00"))
    db.add(p)
    db.flush()
    dep = CustomerPackageDeparture(package_id=p.customer_package_id,
                                   departure_date=dt.date.today() + dt.timedelta(days=40 + int(_u()[:2], 16) % 200),
                                   price_per_person=D("10000.00"), seats_left=seats, is_active=True)
    db.add(dep)
    db.flush()
    ref = f"JPP{_u()}".upper()[:20]
    b = CustomerPackageBooking(booking_ref=ref, customer_id=c.customer_id, status=status,
                               package_id=p.customer_package_id, package_name=p.name, package_days=4,
                               departure_id=dep.customer_package_departure_id, departure_date=dep.departure_date,
                               pax_count=pax, total_amount=D(pay[1]) if pay else D("20000.00"), currency="INR")
    db.add(b)
    db.flush()
    if pay:
        db.add(CustomerPackageBookingPayment(package_booking_id=b.customer_package_booking_id, method="gateway",
                                             amount=D(pay[1]), currency="INR", status=pay[0], provider="hdfc",
                                             provider_order_id=f"O{_u()}", provider_payment_id=f"P{_u()}"))
    db.commit()
    out = (ref, dep.customer_package_departure_id)
    db.close()
    return out


def _admin_audit(pg, action, admin_id=None):
    from app.models_customer import CustomerAdminAuditLog
    db = pg.Session()
    rows = db.scalars(select(CustomerAdminAuditLog).where(CustomerAdminAuditLog.action == action)).all()
    db.close()
    return [r for r in rows if admin_id is None or r.admin_user_id == admin_id]


def _booking_status(pg, model, ref):
    db = pg.Session()
    row = db.scalars(select(model).where(model.booking_ref == ref)).one()
    db.close()
    return row


# ================================================================== reports (D2 / C1) on the real SQL
def test_report_exports_gate_and_audit_on_postgres(pg):
    from app.auth.rbac import P
    from app.models_customer import AdminAuditOutcome
    from app.models_v2 import UserRole
    client = _client(pg)
    _hotel_booking(pg, status="confirmed", pay=("captured", "900.00"))
    viewer = _user(pg, UserRole.ADMIN, [P.CUSTOMER_VIEW, P.B2C_CUSTOMERS_VIEW], "PG13 Viewer")
    partial = _user(pg, UserRole.ADMIN, [P.B2C_REPORTS_VIEW, P.B2C_REPORTS_EXPORT], "PG13 Partial")
    full = _user(pg, UserRole.ADMIN, [P.B2C_REPORTS_VIEW, P.B2C_REPORTS_EXPORT, P.B2C_CUSTOMERS_EXPORT], "PG13 Full")
    sa = _user(pg, UserRole.SUPER_ADMIN, [], "PG13 Super")
    types = ("bookings", "payments", "cancellations", "customers", "reviews")
    for t in types:
        url = f"/api/admin/b2c-reports/export?type={t}&format=csv"
        assert client.get(url, headers=viewer["headers"]).status_code == 403, t
        assert client.get(url, headers=partial["headers"]).status_code == 403, t
        for who in (full, sa):
            r = client.get(url, headers=who["headers"])
            assert r.status_code == 200, (t, r.text)
            assert r.headers["content-disposition"].startswith(f'attachment; filename="b2c-{t}-report-')
        assert client.get(f"/api/admin/b2c-reports/preview?type={t}", headers=full["headers"]).status_code == 200
        assert client.get(f"/api/admin/b2c-reports/preview?type={t}", headers=viewer["headers"]).status_code == 403
    denied = [a for a in _admin_audit(pg, "report.export", partial["id"]) if a.outcome == AdminAuditOutcome.DENIED]
    assert len(denied) == 5 and all("b2c.customers.export" in a.reason for a in denied)
    ok = [a for a in _admin_audit(pg, "report.export", full["id"]) if a.outcome == AdminAuditOutcome.SUCCESS]
    assert len(ok) == 5 and {a.entity_id for a in ok} == set(types)
    assert client.get("/api/admin/b2c-analytics/overview", headers=full["headers"]).status_code == 200
    assert client.get("/api/admin/b2c-analytics/overview", headers=viewer["headers"]).status_code == 403


# ================================================================== bookings (D1, D3, C3, D5, D6)
def test_booking_status_matrix_on_postgres(pg):
    from app.auth.rbac import P
    from app.models_customer import (
        AdminAuditOutcome, CustomerAuditLog, CustomerHotelBooking, CustomerNotification,
    )
    from app.models_v2 import UserRole
    client = _client(pg)
    mgr = _user(pg, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW, P.B2C_CUSTOMERS_MANAGE], "PG13 Manager")
    viewer = _user(pg, UserRole.ADMIN, [P.CUSTOMER_VIEW, P.B2C_CUSTOMERS_VIEW], "PG13 Viewer2")
    BK = "/api/admin/customer-bookings"

    unpaid, _ = _hotel_booking(pg, status="pending")
    assert client.patch(f"{BK}/{unpaid}/status", json={"status": "cancelled"}, headers=viewer["headers"]).status_code == 403
    r = client.patch(f"{BK}/{unpaid}/status", json={"status": "confirmed"}, headers=mgr["headers"])
    assert r.status_code == 409 and "no captured payment" in r.json()["detail"]

    paid, cust = _hotel_booking(pg, status="pending", pay=("captured", "900.00"))
    r = client.patch(f"{BK}/{paid}/status", json={"status": "confirmed"}, headers=mgr["headers"])
    assert r.status_code == 200, r.text
    assert _booking_status(pg, CustomerHotelBooking, paid).status == "confirmed"
    r = client.patch(f"{BK}/{paid}/status", json={"status": "completed"}, headers=mgr["headers"])
    assert r.status_code == 409 and _booking_status(pg, CustomerHotelBooking, paid).status == "confirmed"
    r = client.patch(f"{BK}/{paid}/status", json={"status": "cancelled"}, headers=mgr["headers"])
    assert r.status_code == 200
    row = _booking_status(pg, CustomerHotelBooking, paid)
    assert row.status == "cancelled" and row.cancelled_at is not None
    r = client.patch(f"{BK}/{paid}/status", json={"status": "confirmed"}, headers=mgr["headers"])
    assert r.status_code == 409, "cancelled is terminal"

    db = pg.Session()
    owed = [a for a in db.scalars(select(CustomerAuditLog).where(CustomerAuditLog.customer_id == cust)).all()
            if "refund owed" in (a.action or "").lower()]
    notes = db.scalars(select(CustomerNotification).where(CustomerNotification.customer_id == cust)).all()
    db.close()
    assert len(owed) == 1 and "900" in owed[0].description and "INR" in owed[0].description
    assert sorted(n.notification_type for n in notes) == ["booking_cancelled", "booking_confirmed"]
    upd = _admin_audit(pg, "booking.update", mgr["id"])
    outcomes = sorted(str(a.outcome.value if hasattr(a.outcome, "value") else a.outcome) for a in upd)
    assert outcomes.count("success") == 2 and outcomes.count("failure") == 3
    assert len([a for a in _admin_audit(pg, "booking.update", viewer["id"]) if a.outcome == AdminAuditOutcome.DENIED]) == 1


def test_two_admins_cancelling_the_same_package_release_seats_once(pg):
    from app.auth.rbac import P
    from app.models_customer import CustomerAuditLog, CustomerPackageBooking, CustomerPackageDeparture
    from app.models_v2 import UserRole
    a = _user(pg, UserRole.ADMIN, [P.B2C_CUSTOMERS_MANAGE], "PG13 Racer A")
    b = _user(pg, UserRole.ADMIN, [P.B2C_CUSTOMERS_MANAGE], "PG13 Racer B")
    ref, dep = _package_booking(pg, status="confirmed", pax=2, seats=5)
    barrier = threading.Barrier(2)

    def go(who):
        client = _client(pg)
        barrier.wait()
        return client.patch(f"/api/admin/customer-bookings/{ref}/status", json={"status": "cancelled"},
                            headers=who["headers"]).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(pool.map(go, (a, b)))
    assert codes == [200, 409], codes
    db = pg.Session()
    assert db.get(CustomerPackageDeparture, dep).seats_left == 7, "seats released exactly once"
    booking = db.scalars(select(CustomerPackageBooking).where(CustomerPackageBooking.booking_ref == ref)).one()
    owed = [x for x in db.scalars(select(CustomerAuditLog).where(CustomerAuditLog.customer_id == booking.customer_id)).all()
            if "refund owed" in (x.action or "").lower()]
    db.close()
    assert booking.status == "cancelled" and len(owed) == 1


def test_cancellation_request_decisions_on_postgres(pg):
    from app.auth.rbac import P
    from app.models_customer import CustomerCancellationRequest, CustomerHotelBooking
    from app.models_v2 import UserRole
    client = _client(pg)
    desk = _user(pg, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW, P.B2C_CUSTOMERS_MANAGE], "PG13 Desk")
    viewer = _user(pg, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW], "PG13 Desk Viewer")
    db = pg.Session()
    refs = {}
    for label, status in (("open", "confirmed"), ("done", "completed")):
        ref, cust = _hotel_booking(pg, status=status, pay=("captured", "900.00"))
        cref = f"CXL{_u()}".upper()
        db.add(CustomerCancellationRequest(cancellation_ref=cref, customer_id=cust, product="hotel", booking_ref=ref,
                                           reason="pg test", status="requested"))
        refs[label] = (cref, ref)
    db.commit()
    db.close()
    cref, ref = refs["open"]
    assert client.patch(f"/api/admin/cancellations/{cref}", json={"action": "approve"},
                        headers=viewer["headers"]).status_code == 403
    r = client.patch(f"/api/admin/cancellations/{cref}", json={"action": "approve"}, headers=desk["headers"])
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    assert _booking_status(pg, CustomerHotelBooking, ref).status == "cancelled"
    cref, ref = refs["done"]
    r = client.patch(f"/api/admin/cancellations/{cref}", json={"action": "approve"}, headers=desk["headers"])
    assert r.status_code == 409
    assert _booking_status(pg, CustomerHotelBooking, ref).status == "completed"
    db = pg.Session()
    assert db.scalars(select(CustomerCancellationRequest.status)
                      .where(CustomerCancellationRequest.cancellation_ref == cref)).one() == "requested"
    db.close()


# ================================================================== chat (D8, D9, C4, C8) + the claim race
def test_chat_ownership_and_two_agents_claiming_at_once(pg):
    from app.auth.rbac import P
    from app.models_customer import CustomerConversation
    from app.models_v2 import UserRole
    a = _user(pg, UserRole.ADMIN, [P.B2C_CHAT_MANAGE], "PG13 Agent A")
    b = _user(pg, UserRole.ADMIN, [P.B2C_CHAT_MANAGE], "PG13 Agent B")
    viewer = _user(pg, UserRole.ADMIN, [P.B2C_CUSTOMERS_VIEW], "PG13 Chat Viewer")
    sa = _user(pg, UserRole.SUPER_ADMIN, [], "PG13 Chat Super")
    db = pg.Session()
    c = _customer(db)
    conv = CustomerConversation(customer_id=c.customer_id, status="waiting", last_message="hello there",
                                last_message_at=NOW)
    db.add(conv)
    db.commit()
    cid = conv.conversation_id
    db.close()
    API = "/api/admin/chat"
    client = _client(pg)
    assert client.post(f"{API}/ws-ticket", headers=viewer["headers"]).status_code == 403
    rows = {r["conversation_id"]: r for r in
            client.get(f"{API}/conversations", headers=b["headers"]).json()["conversations"]}
    assert rows[cid]["customer_email"] is None and rows[cid]["last_message"] is None, "C8 masking"
    assert client.get(f"{API}/conversations/{cid}", headers=b["headers"]).status_code == 403

    barrier = threading.Barrier(2)

    def claim(who):
        cl = _client(pg)
        barrier.wait()
        return cl.post(f"{API}/conversations/{cid}/claim", headers=who["headers"]).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(pool.map(claim, (a, b)))
    assert codes == [200, 409], codes
    db = pg.Session()
    owner = db.get(CustomerConversation, cid).assigned_admin_id
    db.close()
    winner, loser = (a, b) if owner == a["id"] else (b, a)
    assert client.get(f"{API}/conversations/{cid}", headers=winner["headers"]).status_code == 200
    assert client.get(f"{API}/conversations/{cid}", headers=loser["headers"]).status_code == 403
    r = client.post(f"{API}/conversations/{cid}/messages", json={"body": "loser"}, headers=loser["headers"])
    assert r.status_code == 409
    assert client.post(f"{API}/conversations/{cid}/messages", json={"body": "winner"},
                       headers=winner["headers"]).status_code == 201
    assert client.post(f"{API}/conversations/{cid}/messages", json={"body": "supervisor"},
                       headers=sa["headers"]).status_code == 201
    assert client.get(f"{API}/conversations/{cid}", headers=sa["headers"]).status_code == 200
    assert len(_admin_audit(pg, "chat.reply_supervisor", sa["id"])) == 1
    assert len(_admin_audit(pg, "chat.supervise_read", sa["id"])) == 1
    assert len(_admin_audit(pg, "chat.claim", winner["id"])) == 1
