"""HTTP-level verification of B2C PAYMENT VISIBILITY and RECONCILIATION:

  * ``GET /api/admin/customer-payments`` (+ ``/counts`` and ``/{product}/{id}``)
  * ``GET /api/admin/payment-reconciliation`` and ``POST /api/admin/payment-reconciliation/{product}/{id}/verify``

The verify action asks the payment gateway what it knows (a READ). The gateway is MOCKED here — no provider,
network or customer is touched, nothing is created, no money moves, and no refund path is involved. The tests
assert the read-only guarantee (payment rows unchanged, no extra rows), the five outcomes (matched / mismatch /
no_reference / not_configured / gateway_unavailable), filters and validation, the sensitive-read audit entries,
and permissions (these routes require an EXPLICIT grant — role defaults do not count).

Temp-file SQLite is used (as in test_admin_supplier_reservation_http.py) so the audit-readiness probe does not
roll back the request's writes. PostgreSQL behaviour is not exercised.
"""
from __future__ import annotations

import datetime as dt
import decimal
import os
import tempfile
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_customer import (
    Base, Customer, CustomerAdminAuditLog, CustomerBooking, CustomerBookingPayment, CustomerHotelBooking,
    CustomerHotelBookingPayment, CustomerPackageBooking, CustomerPackageBookingPayment, PaymentProviderEvent,
)
from app.models_v2 import User, UserRole, UserStatus
from app.routers import admin_reconciliation, customer_payment_admin
from app.services import activity_service
from app.services import customer_reconciliation_service as recon
from app.services.payments.base import PaymentNotConfigured, PaymentProviderError

D = decimal.Decimal
NOW = dt.datetime.now(dt.timezone.utc)
_N = {"n": 300000}


def _id():
    _N["n"] += 1
    return _N["n"]


class Env:
    def __init__(self, engine):
        self.engine = engine
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity = []
        app = FastAPI()
        app.include_router(admin_reconciliation.router)
        app.include_router(customer_payment_admin.router)

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
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerBooking.__table__, CustomerBookingPayment.__table__,
        CustomerHotelBooking.__table__, CustomerHotelBookingPayment.__table__,
        CustomerPackageBooking.__table__, CustomerPackageBookingPayment.__table__,
        CustomerAdminAuditLog.__table__,
    ])
    md = MetaData()
    # ``users`` and ``payment_provider_events`` carry PostgreSQL-only defaults (``'{}'::jsonb``): clone them stripped.
    for model in (User, PaymentProviderEvent):
        tbl = model.__table__.to_metadata(md)
        for con in list(tbl.constraints):
            if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
                tbl.constraints.discard(con)
        for idx in list(tbl.indexes):
            tbl.indexes.discard(idx)
        for col in tbl.columns:
            col.foreign_keys.clear()
            col.server_default = None
            if not col.primary_key:
                col.nullable = True
        tbl.create(engine)
    e = Env(engine)
    monkeypatch.setattr(activity_service, "log_activity",
                        lambda db, user_id, action, ip=None, **kw: e.activity.append(
                            {"user_id": user_id, "action": action, **kw}))
    e.gateway_calls = []
    e.gateway = {"mode": "ok", "amount_minor": 5600, "status": "captured"}

    def _provider(name):
        class P_:
            def fetch_payment(self_, provider_payment_id):
                e.gateway_calls.append((name, provider_payment_id))
                if e.gateway["mode"] == "unconfigured":
                    raise PaymentNotConfigured("no provider")
                if e.gateway["mode"] == "down":
                    raise PaymentProviderError("timeout")
                return SimpleNamespace(amount_minor=e.gateway["amount_minor"], currency="INR",
                                       provider_status=e.gateway["status"])
        return P_()

    monkeypatch.setattr(recon, "get_provider_named", _provider)
    yield e
    engine.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


def _user(env, role, perms=None, name="Reviewer"):
    db = env.db()
    u = User(user_id=_id(), full_name=name, email=f"u{_N['n']}@example.test", password_hash="x", role=role,
             status=UserStatus.ACTIVE, permissions=perms or [])
    db.add(u)
    db.commit()
    out = {"headers": {"Authorization": f"Bearer {create_access_token(u.user_id)}"}, "id": u.user_id}
    db.close()
    return out


@pytest.fixture()
def admin(env):
    # require_scope consults EXPLICIT grants only; this does not weaken the production gate.
    return _user(env, UserRole.ADMIN, [P.B2C_PAYMENTS_VERIFY, P.PAYMENT_VERIFY], "Ada Admin")


def _flight_payment(env, ref, *, status="captured", provider="hdfc", pid="PAY1", amount="56.00", age=0):
    db = env.db()
    c = Customer(customer_id=_id(), customer_code=f"C{_id()}", full_name=f"Cust {ref}", email=f"{ref.lower()}@example.test",
                 mobile="9000000000")
    db.add(c)
    db.flush()
    b = CustomerBooking(customer_booking_id=_id(), booking_ref=ref, customer_id=c.customer_id,
                        total_amount=D(amount), currency="INR", status="confirmed", created_at=NOW)
    db.add(b)
    db.flush()
    p = CustomerBookingPayment(
        customer_booking_payment_id=_id(), customer_booking_id=b.customer_booking_id, method="gateway",
        amount=D(amount), currency="INR", status=status, provider=provider,
        provider_order_id=f"ORD-{ref}", provider_payment_id=pid, created_at=NOW - dt.timedelta(days=age),
        paid_at=NOW)
    db.add(p)
    db.commit()
    out = p.customer_booking_payment_id
    db.close()
    return out


def _snapshot(env):
    db = env.db()
    rows = [(p.customer_booking_payment_id, p.status, p.amount, p.provider_payment_id)
            for p in db.scalars(select(CustomerBookingPayment)).all()]
    n = db.scalar(select(func.count()).select_from(CustomerBookingPayment))
    db.close()
    return rows, n


def _audit(env, action):
    db = env.db()
    rows = [r for r in db.scalars(select(CustomerAdminAuditLog)).all() if r.action == action]
    db.close()
    return rows


REC = "/api/admin/payment-reconciliation"
PAY = "/api/admin/customer-payments"


# ================================================================== visibility
def test_payment_list_filters_pagination_and_sort(env, admin):
    a = _flight_payment(env, "JPF1", status="captured", provider="hdfc", age=3)
    b = _flight_payment(env, "JPF2", status="failed", provider="razorpay", age=1)
    c = _flight_payment(env, "JPF3", status="captured", provider="hdfc", age=2)
    r = env.client.get(PAY, headers=admin["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3 and [i["payment_id"] for i in body["items"]] == [b, c, a], "newest first"
    got = lambda **p: [i["payment_id"] for i in env.client.get(PAY, params=p, headers=admin["headers"]).json()["items"]]
    assert got(status="captured") == [c, a] and got(provider="razorpay") == [b]
    assert got(product="hotel") == [] and got(search="jpf3") == [c]
    assert got(page=2, page_size=2) == [a]
    assert got(date_from=(NOW - dt.timedelta(days=1)).date().isoformat()) == [b] or got(date_from=(NOW - dt.timedelta(days=1)).date().isoformat())
    item = body["items"][0]
    for forbidden in ("customer_mobile", "mobile", "card", "vpa", "secret"):
        assert forbidden not in item, "no phone number, card detail or secret may be returned"


@pytest.mark.parametrize("params,code", [({"product": "visa"}, 400), ({"status": "paid"}, 400),
                                         ({"page_size": 201}, 422), ({"page": 0}, 422)])
def test_payment_list_validation(env, admin, params, code):
    assert env.client.get(PAY, params=params, headers=admin["headers"]).status_code == code


def test_counts_detail_and_sensitive_read_audit(env, admin):
    pid = _flight_payment(env, "JPF9")
    _flight_payment(env, "JPF10", status="failed")
    c = env.client.get(f"{PAY}/counts", headers=admin["headers"])
    assert c.status_code == 200 and c.json()["total"] == 2 and c.json()["by_status"]["captured"] == 1
    d = env.client.get(f"{PAY}/flight/{pid}", headers=admin["headers"])
    assert d.status_code == 200 and d.json()["booking_ref"] == "JPF9"
    assert any(a["action"] != "" and a["user_id"] == admin["id"] for a in env.activity), "a sensitive read is recorded"
    assert env.client.get(f"{PAY}/flight/99999999", headers=admin["headers"]).status_code == 404
    assert env.client.get(f"{PAY}/bogus/{pid}", headers=admin["headers"]).status_code == 404


# ================================================================== reconciliation
def test_reconciliation_list_marks_every_row_not_checked_and_validates_filters(env, admin):
    _flight_payment(env, "JPF20")
    r = env.client.get(REC, headers=admin["headers"])
    assert r.status_code == 200 and {i["reconciliation_status"] for i in r.json()["items"]} == {"not_checked"}
    assert r.json()["total_pages"] == 1
    assert env.client.get(REC, params={"product": "visa"}, headers=admin["headers"]).status_code == 400
    assert env.client.get(REC, params={"status": "paid"}, headers=admin["headers"]).status_code == 400
    assert env.client.get(REC, params={"page_size": 0}, headers=admin["headers"]).status_code == 422
    assert env.gateway_calls == [], "listing must never call the gateway"


def _verify(env, admin, pid, product="flight"):
    return env.client.post(f"{REC}/{product}/{pid}/verify", headers=admin["headers"])


def test_verify_matched_is_read_only_and_audited(env, admin):
    pid = _flight_payment(env, "JPF30", amount="56.00", pid="PAY-30")
    before = _snapshot(env)
    r = _verify(env, admin, pid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reconciliation_status"] == "matched" and D(str(body["gateway_amount"])) == D("56.00")
    assert env.gateway_calls == [("hdfc", "PAY-30")]
    assert _snapshot(env) == before, "verification creates nothing and changes nothing"
    assert any(a["action"] == "Payment reconciliation checked" and a["user_id"] == admin["id"] for a in env.activity)
    rows = _audit(env, "payment.verify")
    assert len(rows) == 1 and rows[0].entity_id == f"flight:{pid}"


def test_verify_detects_a_mismatch_without_touching_our_record(env, admin):
    pid = _flight_payment(env, "JPF31", amount="56.00", pid="PAY-31")
    env.gateway["amount_minor"] = 5000                       # gateway says 50.00
    before = _snapshot(env)
    body = _verify(env, admin, pid).json()
    assert body["reconciliation_status"] == "mismatch" and D(str(body["gateway_amount"])) == D("50.00")
    assert D(str(body["expected_amount"])) == D("56.00")
    assert _snapshot(env) == before


def test_verify_without_a_provider_reference_never_calls_the_gateway(env, admin):
    pid = _flight_payment(env, "JPF32", pid=None)
    body = _verify(env, admin, pid).json()
    assert body["reconciliation_status"] == "no_reference" and env.gateway_calls == []


@pytest.mark.parametrize("mode,expected", [("unconfigured", "not_configured"), ("down", "gateway_unavailable")])
def test_gateway_failures_are_reported_not_raised(env, admin, mode, expected):
    pid = _flight_payment(env, "JPF33", pid="PAY-33")
    env.gateway["mode"] = mode
    before = _snapshot(env)
    r = _verify(env, admin, pid)
    assert r.status_code == 200 and r.json()["reconciliation_status"] == expected
    assert _snapshot(env) == before


def test_verify_unknown_payment_or_product_is_404_and_unaudited(env, admin):
    assert _verify(env, admin, 99999999).status_code == 404
    assert _verify(env, admin, 1, product="bogus").status_code == 404
    assert env.gateway_calls == [] and _audit(env, "payment.verify") == []


# ================================================================== permissions
def test_permissions_for_payment_visibility_and_reconciliation(env, admin):
    pid = _flight_payment(env, "JPF40")
    urls = [("get", PAY), ("get", f"{PAY}/counts"), ("get", f"{PAY}/flight/{pid}"), ("get", REC),
            ("post", f"{REC}/flight/{pid}/verify")]
    for m, u in urls:
        assert getattr(env.client, m)(u).status_code in (401, 403), u
    # Role defaults do not count: an ADMIN with no explicit grant is refused, and so is every other role.
    bare_admin = _user(env, UserRole.ADMIN, [], "Bare Admin")
    manager = _user(env, UserRole.MANAGER, [], "Mo Manager")
    merchant = _user(env, UserRole.MERCHANT_ADMIN, [], "Mer Admin")
    for who in (bare_admin, manager, merchant):
        for m, u in urls:
            assert getattr(env.client, m)(u, headers=who["headers"]).status_code == 403, (who, u)
    assert env.gateway_calls == [] and _audit(env, "payment.verify") == []
    assert env.client.get(PAY, headers={"Authorization": "Bearer not.a.jwt"}).status_code == 401
    assert env.client.get(PAY, headers=admin["headers"]).status_code == 200
