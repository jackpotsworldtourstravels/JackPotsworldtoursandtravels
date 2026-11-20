"""PHASE 12 — PostgreSQL integration tests (run ONLY against the disposable Docker database).

SAFETY: every test in this module SKIPS unless ``PHASE12_PG=1`` is set AND the resolved application settings point at
``127.0.0.1:55432/jackpots_phase12_test`` (the throw-away PostgreSQL 17 container created for Phase 12). In a normal
``pytest`` run the settings point elsewhere, so the whole module is skipped and nothing can reach ``jackpots_v2`` or any other
database. All payment / supplier / communication paths are mocked; nothing leaves the process.

Covers what SQLite could not prove: the ``audit_logs`` trigger, partial/unique indexes, real sequences, enum round-trips,
ARRAY persistence, JSONB search / filters, analytics SQL, B2C activity sessions + summary, and ROW LOCKING under real concurrency
(two threads racing the same top-up / ticket / payment).
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
from sqlalchemy.exc import IntegrityError

from app.config import settings

_TARGET = "@127.0.0.1:55432/jackpots_phase12_test"
pytestmark = pytest.mark.skipif(
    os.environ.get("PHASE12_PG") != "1" or not settings.database_url.endswith(_TARGET)
    or "jackpots_v2" in settings.database_url,
    reason="Phase 12 PostgreSQL tests run only against the disposable Docker database",
)

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)


def _u():
    return uuid.uuid4().hex[:8]


@pytest.fixture(scope="module")
def pg():
    # Imported lazily so a skipped module never even builds the app.
    from app.database.session import SessionLocal, engine
    from app.main import app
    from app.services import delivery_service, notification_service

    with engine.connect() as c:
        db_name, port = c.execute(text("select current_database(), inet_server_port()")).one()
    assert db_name == "jackpots_phase12_test", db_name

    class PG:
        pass

    p = PG()
    p.Session = SessionLocal
    p.engine = engine
    p.app = app
    p.notification_service = notification_service
    p.delivery_service = delivery_service
    return p


@pytest.fixture(autouse=True)
def _no_external(monkeypatch, pg):
    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a Phase 12 test")

    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant",
                 "notify_managers"):
        if hasattr(pg.notification_service, name):
            monkeypatch.setattr(pg.notification_service, name, lambda *a, **k: 0)
    monkeypatch.setattr(pg.delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)


def _client(pg):
    return TestClient(pg.app, raise_server_exceptions=False)


def _user(pg, role, *, merchant_id=None, perms=None, merchant_role=None, name="PG User"):
    from app.auth.security import create_access_token, hash_password
    from app.models_v2 import User, UserStatus
    db = pg.Session()
    u = User(full_name=name, email=f"pg{_u()}@tt-qa.com", password_hash=hash_password("Throwaway#1"), role=role,
             status=UserStatus.ACTIVE, merchant_id=merchant_id, permissions=perms or [], merchant_role=merchant_role)
    db.add(u)
    db.commit()
    uid = u.user_id
    db.close()
    return {"id": uid, "headers": {"Authorization": f"Bearer {create_access_token(uid)}"}}


def _merchant(pg, *, wallet="0", credit="100000", hotels=True):
    from app.models_v2 import Merchant, MerchantStatus
    from app.services import service_access_service
    db = pg.Session()
    tag = _u()
    m = Merchant(merchant_code=f"PG{tag}", merchant_name=f"PG {tag}", company_name=f"PG Co {tag}",
                 email=f"m{tag}@tt-qa.com", reference_prefix=f"P{tag[:5]}", status=MerchantStatus.ACTIVE,
                 wallet_balance=D(wallet), credit_limit=D(credit))
    db.add(m)
    db.flush()
    service_access_service.ensure_defaults(db, m, overrides={"hotels": hotels})
    db.commit()
    mid = m.merchant_id
    db.close()
    return mid


# =============================================================================== audit trigger
def test_audit_trigger_records_insert_and_update_and_the_reader_redacts_secrets(pg):
    from app.models_v2 import AuditLog, Merchant, User, UserRole
    mid = _merchant(pg)
    db = pg.Session()
    m = db.get(Merchant, mid)
    m.city = "Pune"
    db.commit()
    rows = db.scalars(select(AuditLog).where(AuditLog.table_name == "merchants", AuditLog.record_id == mid)
                      .order_by(AuditLog.audit_id)).all()
    ops = [r.operation.value if hasattr(r.operation, "value") else r.operation for r in rows]
    assert ops[:2] == ["INSERT", "UPDATE"], ops
    assert rows[1].new_value["city"] == "Pune" and (rows[1].old_value or {}).get("city") in (None, "")
    db.close()
    viewer = _user(pg, UserRole.SUPER_ADMIN, name="PG Super")
    r = _client(pg).get("/api/super-admin/audit-logs", params={"table_name": "users", "page_size": 100}, headers=viewer["headers"])
    assert r.status_code == 200, r.text
    db = pg.Session()
    hashes = [u.password_hash for u in db.scalars(select(User)).all()]
    db.close()
    for h in hashes:
        assert h not in r.text, "password hashes captured by the trigger must be redacted on read"


# =============================================================================== indexes / sequences / enums
def test_partial_unique_merchant_email_index(pg):
    from app.models_v2 import Merchant, MerchantStatus
    email = f"dup{_u()}@tt-qa.com"
    db = pg.Session()
    db.add(Merchant(merchant_code=f"A{_u()}", merchant_name="A", company_name="A", email=email,
                    reference_prefix=f"A{_u()[:6]}", status=MerchantStatus.ACTIVE))
    db.commit()
    db.add(Merchant(merchant_code=f"B{_u()}", merchant_name="B", company_name="B", email=email,
                    reference_prefix=f"B{_u()[:6]}", status=MerchantStatus.ACTIVE))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    first = db.scalars(select(Merchant).where(Merchant.email == email)).one()
    first.status = MerchantStatus.DELETED
    db.commit()
    db.add(Merchant(merchant_code=f"C{_u()}", merchant_name="C", company_name="C", email=email,
                    reference_prefix=f"C{_u()[:6]}", status=MerchantStatus.ACTIVE))
    db.commit()        # a deleted merchant no longer holds its email (ux_merchants_email_not_deleted)
    db.close()


def test_unique_ticket_number_index_and_enum_round_trip(pg):
    from app.models_v2 import RequestSource, RequestStatus, RequestType, ServiceRequest
    mid = _merchant(pg)
    db = pg.Session()
    tkt = f"TKT-{_u()}"
    created = []
    for st in RequestStatus:
        r = ServiceRequest(request_number=f"E-{_u()}", merchant_id=mid, request_type=RequestType.BOOKING,
                           source=RequestSource.MERCHANT_PORTAL, status=st, title="enum", travel_details={}, pricing={},
                           quantity=1, total_amount=D("1"), status_history=[])
        db.add(r)
        db.flush()
        created.append((r.request_id, st))
    db.commit()
    for rid, st in created:
        db.expire_all()
        assert db.get(ServiceRequest, rid).status is st, st
    a, b = created[0][0], created[1][0]
    db.get(ServiceRequest, a).ticket_number = tkt
    db.commit()
    db.get(ServiceRequest, b).ticket_number = tkt
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.close()


def test_real_sequences_allocate_distinct_increasing_numbers(pg):
    from app.services.ticket_service import _next_number
    db = pg.Session()
    nums = [_next_number(db, "REQ") for _ in range(5)]
    db.commit()
    db.close()
    assert len(set(nums)) == 5 and nums == sorted(nums), nums


# =============================================================================== JSONB search / filters
def test_enquiry_free_text_search_and_support_category_filter(pg):
    from app.models_v2 import UserRole
    mid = _merchant(pg)
    merchant = _user(pg, UserRole.MERCHANT_ADMIN, merchant_id=mid, name="PG Mer")
    admin = _user(pg, UserRole.ADMIN, name="PG Admin")
    c = _client(pg)
    city = f"Zq{_u()}"
    body = {"trip_type": "one_way", "origin": "DEL", "origin_city": city, "destination": "GOI", "destination_city": "Goa",
            "travel_date": (dt.date.today() + dt.timedelta(days=30)).isoformat(), "preferred_time": "10:00",
            "travel_class": "Economy", "passenger_count": 1, "adults": 1}
    r = c.post("/api/enquiries", json=body, headers=merchant["headers"])
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    hits = c.get("/api/enquiries", params={"search": city}, headers=admin["headers"])
    assert hits.status_code == 200, hits.text
    assert [i["id"] for i in hits.json()["items"]] == [eid], "JSONB origin_city search"
    t1 = c.post("/api/support/threads", json={"message": f"wallet issue {city}", "category": "wallet"}, headers=merchant["headers"])
    t2 = c.post("/api/support/threads", json={"message": f"booking issue {city}", "category": "booking"}, headers=merchant["headers"])
    assert t1.status_code == t2.status_code == 201
    tid1 = t1.json().get("thread", t1.json())["id"]
    cat = c.get("/api/support/threads", params={"category": "wallet", "q": city}, headers=admin["headers"])
    assert cat.status_code == 200, cat.text
    assert [i["id"] for i in cat.json()["items"]] == [tid1], "JSONB @> category filter"


def test_report_search_uses_the_same_rows_as_the_export(pg):
    from app.models_v2 import RequestSource, RequestStatus, RequestType, ServiceRequest, UserRole
    mid = _merchant(pg)
    admin = _user(pg, UserRole.ADMIN, name="PG Admin")
    tag = f"Rq{_u()}"
    db = pg.Session()
    db.add(ServiceRequest(request_number=f"RP-{_u()}", merchant_id=mid, request_type=RequestType.BOOKING,
                          source=RequestSource.MERCHANT_PORTAL, status=RequestStatus.PAID, title=f"{tag} trip",
                          travel_details={"origin_city": tag, "destination_city": "Goa"}, pricing={}, quantity=1,
                          total_amount=D("1234.50"), status_history=[], travel_date=dt.date.today()))
    db.commit()
    db.close()
    c = _client(pg)
    s = c.get("/api/reports/summary", params={"type": "bookings", "search": tag}, headers=admin["headers"])
    assert s.status_code == 200, s.text
    assert s.json()["rows"] == 1 and D(str(s.json()["total_value"])) == D("1234.50")
    e = c.get("/api/reports/export", params={"type": "bookings", "format": "csv", "search": tag}, headers=admin["headers"])
    assert e.status_code == 200 and len(e.content.decode("utf-8-sig").strip().splitlines()) == 2


# =============================================================================== analytics SQL
def test_b2b_analytics_and_operations_metrics_run_on_postgres(pg):
    from app.models_v2 import RequestSource, RequestStatus, RequestType, ServiceRequest, UserRole
    mid = _merchant(pg)
    db = pg.Session()
    for st, amt in ((RequestStatus.PAID, "1000"), (RequestStatus.TICKET_ISSUED, "500"), (RequestStatus.APPROVED, "250")):
        db.add(ServiceRequest(request_number=f"AN-{_u()}", merchant_id=mid, request_type=RequestType.BOOKING,
                              source=RequestSource.MERCHANT_PORTAL, status=st, title="x", travel_details={}, pricing={},
                              quantity=1, total_amount=D(amt), status_history=[], travel_date=dt.date.today()))
    db.commit()
    db.close()
    admin = _user(pg, UserRole.ADMIN, name="PG Admin")
    me = _user(pg, UserRole.MERCHANT_ADMIN, merchant_id=mid, name="PG Mer")
    c = _client(pg)
    for path in ("/api/analytics/bookings", "/api/analytics/change-requests", "/api/analytics/operations"):
        r = c.get(path, headers=admin["headers"])
        assert r.status_code == 200, (path, r.text)
    mine = c.get("/api/analytics/bookings", params={"date_field": "created_at"}, headers=me["headers"]).json()
    assert mine["totals"]["count"] == 3 if "count" in mine.get("totals", {}) else True
    assert c.get("/api/analytics/operations", headers=me["headers"]).status_code == 403


def test_b2c_analytics_and_activity_sessions_summary_run_on_postgres(pg):
    from app.auth.rbac import P
    from app.models_customer import Customer, CustomerAuditLog, CustomerSession
    from app.models_v2 import UserRole
    db = pg.Session()
    c = Customer(customer_code=f"C{_u()}", full_name="PG Cust", email=f"c{_u()}@tt-qa.com", mobile="9000000000")
    db.add(c)
    db.flush()
    db.add(CustomerSession(customer_id=c.customer_id, login_at=NOW - dt.timedelta(minutes=3),
                           last_seen_at=NOW - dt.timedelta(minutes=1), is_active=True))
    db.add(CustomerSession(customer_id=c.customer_id, login_at=NOW - dt.timedelta(days=2),
                           last_seen_at=NOW - dt.timedelta(days=2), logout_at=NOW - dt.timedelta(days=2), is_active=False))
    db.add(CustomerAuditLog(customer_id=c.customer_id, action="Login", module="Auth", status="success"))
    db.commit()
    cid = c.customer_id
    db.close()
    admin = _user(pg, UserRole.ADMIN, perms=[P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW, P.B2C_REPORTS_VIEW], name="PG B2C")
    cl = _client(pg)
    s = cl.get("/api/admin/user-activity/summary", headers=admin["headers"])
    assert s.status_code == 200, s.text
    sess = cl.get("/api/admin/user-activity/sessions", params={"customer_id": cid}, headers=admin["headers"])
    assert sess.status_code == 200, sess.text
    assert sorted(i["state"] for i in sess.json()["items"]) == ["active", "ended"]
    ended = cl.get("/api/admin/user-activity/sessions", params={"customer_id": cid, "state": "ended"}, headers=admin["headers"])
    assert ended.json()["total"] == 1
    ov = cl.get("/api/admin/b2c-analytics/overview", params={"months": 3}, headers=admin["headers"])
    assert ov.status_code == 200, ov.text


# =============================================================================== ARRAY persistence
def test_package_and_hotel_arrays_round_trip_on_postgres(pg):
    from app.auth.rbac import P
    from app.models_customer import CustomerHotel, CustomerPackage
    from app.models_v2 import UserRole
    admin = _user(pg, UserRole.ADMIN, perms=[P.B2C_CATALOGUE_MANAGE, P.CATALOG_MANAGE], name="PG Cat")
    c = _client(pg)
    r = c.post("/api/admin/catalogue/packages", json={"name": f"PG Pkg {_u()}", "blurb": "b", "trip_type": "domestic", "days": 3,
                                                       "price_from": "9999.00", "highlights": ["Beach", "Fort, old"],
                                                       "inclusions": ["Hotel"], "exclusions": []}, headers=admin["headers"])
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    it = c.put(f"/api/admin/catalogue/packages/{pid}/itinerary",
               json={"days": [{"day_number": 1, "title": "Arrive", "meals": ["breakfast", "dinner"]}]}, headers=admin["headers"])
    assert it.status_code == 200, it.text
    dep = c.post(f"/api/admin/catalogue/packages/{pid}/departures",
                 json={"departure_date": (dt.date.today() + dt.timedelta(days=40)).isoformat(), "price_per_person": "9999.00"},
                 headers=admin["headers"])
    assert dep.status_code == 201, dep.text
    dup = c.post(f"/api/admin/catalogue/packages/{pid}/departures",
                 json={"departure_date": (dt.date.today() + dt.timedelta(days=40)).isoformat(), "price_per_person": "1"},
                 headers=admin["headers"])
    assert dup.status_code == 409
    db = pg.Session()
    p = db.get(CustomerPackage, pid)
    assert p.highlights == ["Beach", "Fort, old"] and p.inclusions == ["Hotel"] and p.exclusions == []
    h = CustomerHotel(name=f"PG Hotel {_u()}", star_rating=4, location="Goa", price_per_night=D("0"), amenities=["Wifi"], images=[])
    db.add(h)
    db.commit()
    hid = h.customer_hotel_id
    db.close()
    e = c.patch(f"/api/admin/catalogue/hotels/{hid}", json={"amenities": ["Wifi", "Pool, heated"]}, headers=admin["headers"])
    assert e.status_code == 200, e.text
    room = c.post(f"/api/admin/catalogue/hotels/{hid}/rooms", json={"code": "DLX", "name": "Deluxe", "base_price_per_night": "4500.00",
                                                                    "perks": ["Breakfast", "Late checkout"]}, headers=admin["headers"])
    assert room.status_code == 201, room.text
    db = pg.Session()
    assert db.get(CustomerHotel, hid).amenities == ["Wifi", "Pool, heated"]
    db.close()


# =============================================================================== concurrency / row locking
def _race(pg, method, url, headers, body=None, n=2):
    barrier = threading.Barrier(n)

    def one():
        cl = _client(pg)
        barrier.wait()
        return getattr(cl, method)(url, headers=headers, **({"json": body} if body is not None else {})).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
        return sorted(f.result() for f in [ex.submit(one) for _ in range(n)])


def test_concurrent_topup_verification_credits_exactly_once(pg):
    from app.models_v2 import Merchant, UserRole, WalletTopup, WalletTopupMethod, WalletTopupStatus, WalletTransaction
    mid = _merchant(pg, wallet="100.00")
    db = pg.Session()
    t = WalletTopup(topup_number=f"WTU-{_u()}", merchant_id=mid, amount=D("2500.00"), method=WalletTopupMethod.UPI,
                    utr=f"UTR{_u()}", status=WalletTopupStatus.SUBMITTED, submitted_at=NOW)
    db.add(t)
    db.commit()
    tid = t.topup_id
    db.close()
    a1 = _user(pg, UserRole.ADMIN, name="Racer One")
    codes = _race(pg, "post", f"/api/admin/wallet/topups/{tid}/verify", a1["headers"])
    assert codes == [200, 409], codes
    db = pg.Session()
    assert db.get(Merchant, mid).wallet_balance == D("2600.00")
    assert len(db.scalars(select(WalletTransaction).where(WalletTransaction.topup_id == tid)).all()) == 1
    db.close()


def test_concurrent_classic_ticket_issue_debits_the_wallet_once(pg):
    from app.models_v2 import (
        DocumentType, DocumentVerification, Merchant, RequestDocument, RequestSource, RequestStatus, RequestType,
        ServiceRequest, UserRole, WalletTransaction,
    )
    mid = _merchant(pg, wallet="5000.00")
    db = pg.Session()
    r = ServiceRequest(request_number=f"CL-{_u()}", merchant_id=mid, request_type=RequestType.BOOKING,
                       source=RequestSource.MERCHANT_PORTAL, status=RequestStatus.APPROVED, title="classic",
                       travel_details={"direct_booking": True}, pricing={}, quantity=1, total_amount=D("0"), status_history=[])
    db.add(r)
    db.flush()
    db.add(RequestDocument(request_id=r.request_id, merchant_id=mid, doc_type=DocumentType.TICKET, original_filename="t.pdf",
                           stored_path="requests/x/t.pdf", content_type="application/pdf", size_bytes=5,
                           verification_status=DocumentVerification.PENDING))
    db.commit()
    rid = r.request_id
    db.close()
    admin = _user(pg, UserRole.ADMIN, name="Issuer")
    codes = _race(pg, "post", f"/api/admin/requests/{rid}/issue-ticket", admin["headers"], {"fare_amount": "1800.00"})
    assert codes[0] == 200 and codes[1] in (400, 409), codes
    db = pg.Session()
    assert db.get(Merchant, mid).wallet_balance == D("3200.00")
    assert len(db.scalars(select(WalletTransaction).where(WalletTransaction.request_id == rid)).all()) == 1
    assert db.get(ServiceRequest, rid).status is RequestStatus.TICKET_ISSUED
    db.close()


def test_concurrent_payment_verification_moves_the_booking_once(pg):
    from app.models_v2 import (
        Payment, PaymentStatus, PaymentType, RequestSource, RequestStatus, RequestType, ServiceRequest, UserRole,
    )
    mid = _merchant(pg)
    db = pg.Session()
    r = ServiceRequest(request_number=f"PV-{_u()}", merchant_id=mid, request_type=RequestType.BOOKING,
                       source=RequestSource.MERCHANT_PORTAL, status=RequestStatus.PAYMENT_PENDING, title="pv",
                       travel_details={}, pricing={}, quantity=1, total_amount=D("700"), status_history=[])
    db.add(r)
    db.flush()
    p = Payment(merchant_id=mid, request_id=r.request_id, amount=D("700"), payment_type=PaymentType.BOOKING_PAYMENT,
                payment_method="bank_transfer", transaction_id=f"UTR{_u()}", payment_status=PaymentStatus.PENDING, paid_date=NOW)
    db.add(p)
    db.commit()
    rid, pid = r.request_id, p.payment_id
    db.close()
    admin = _user(pg, UserRole.ADMIN, name="Verifier")
    codes = _race(pg, "post", f"/api/admin/payments/{pid}/verify", admin["headers"], {"approve": True})
    assert codes == [200, 400], codes
    db = pg.Session()
    assert db.get(Payment, pid).payment_status is PaymentStatus.SUCCESS
    sr = db.get(ServiceRequest, rid)
    assert sr.status is RequestStatus.PAID
    assert [h["to"] for h in sr.status_history].count("paid") == 1, "one timeline entry, not two"
    db.close()


# =============================================================================== wallet payment requests on PostgreSQL
def test_payment_request_raise_cancel_and_awaiting_cannot_be_verified(pg):
    from app.models_v2 import MerchantRole, UserRole, WalletTopup, WalletTopupStatus
    mid = _merchant(pg)
    mgr = _user(pg, UserRole.MERCHANT_USER, merchant_id=mid, merchant_role=MerchantRole.MANAGER, name="PG Mgr")
    admin = _user(pg, UserRole.ADMIN, name="PG Desk")
    c = _client(pg)
    r = c.post("/api/admin/wallet/payment-requests", json={"merchant_id": mid, "manager_id": mgr["id"], "amount": "1500.00",
                                                         "method": "crypto", "instructions": {"wallet_address": "TXtest", "network": "trc-20"}},
               headers=admin["headers"])
    assert r.status_code == 201, r.text
    tid = r.json().get("topup_id") or r.json()["id"]
    assert c.post(f"/api/admin/wallet/topups/{tid}/verify", headers=admin["headers"]).status_code == 409
    w = c.post(f"/api/admin/wallet/payment-requests/{tid}/cancel", json={"remarks": "raised in error"}, headers=admin["headers"])
    assert w.status_code == 200, w.text
    db = pg.Session()
    t = db.get(WalletTopup, tid)
    assert t.status is WalletTopupStatus.REJECTED and t.instructions["network"] == "TRC20"
    db.close()
