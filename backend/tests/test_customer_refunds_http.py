"""The refund endpoints as an HTTP client meets them: permissions, maker-checker
and error shapes enforced on the SERVER, not by the admin screen hiding a button.

Same harness as test_customer_refunds.py (fake gateway, SQLite); the app here is
just the cancellations router with the current user chosen per request.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import deps, rbac
from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import get_db
from app.models_v2 import UserRole
from app.routers import admin_cancellations
from app.services import activity_service
from tests.test_customer_refunds import (  # noqa: F401  (fixtures are re-used)
    CHECKER,
    MAKER,
    actor,
    cancellation,
    captured_payment,
    customer,
    gateway,
    trustbrick_cancellation,
    _defaults,
    _tables,
)

@pytest.fixture()
def db():
    """As the shared fixture, but usable from the TestClient's worker thread."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from app.models_customer import Base

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=_tables())
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


USERS = {
    "maker": MAKER,                                                    # admin: view/execute/reconcile
    "other_maker": actor(2),
    "checker": CHECKER,                                                # admin + refund.authorize
    "checker_is_maker": actor(1, "refund.authorize"),
    "viewer": actor(7, role=UserRole.SUPER_ADMIN),                     # refund.view only
}


@pytest.fixture()
def client(db, monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)
    monkeypatch.setattr(activity_service, "log_activity", lambda *a, **k: None)
    monkeypatch.setattr(activity_service, "request_context", lambda r: {"ip_address": None, "browser": None, "device": None})
    api = FastAPI()
    api.state.limiter = limiter
    api.include_router(admin_cancellations.router)

    def _db():
        yield db

    from fastapi import Header

    def _user(x_test_user: str = Header(...)):
        return USERS[x_test_user]

    api.dependency_overrides[get_db] = _db
    api.dependency_overrides[deps.get_current_user] = _user
    return TestClient(api)


def as_(client, who, method, url, **kw):
    return client.request(method, url, headers={"x-test-user": who}, **kw)


def setup_cancellation(db, customer, **kw):
    booking, pay = captured_payment(db, customer)
    return cancellation(db, booking, customer, **kw), pay


@pytest.fixture()
def two_person(monkeypatch):
    monkeypatch.setattr(settings, "refund_approval_threshold_minor", 0)


def test_view_only_role_can_read_but_not_act(client, db, customer, gateway):
    c, _ = setup_cancellation(db, customer)
    ref = c.cancellation_ref
    r = as_(client, "viewer", "GET", f"/api/admin/cancellations/{ref}/refund")
    assert r.status_code == 200 and r.json()["captured_amount"] == "100.00"
    assert as_(client, "viewer", "POST", f"/api/admin/cancellations/{ref}/refund", json={}).status_code == 403
    assert as_(client, "viewer", "POST", f"/api/admin/cancellations/refunds/reconcile").status_code == 403
    assert as_(client, "viewer", "POST", f"/api/admin/cancellations/{ref}/refund/manual",
               json={"reference": "x", "reason": "y", "admin_override": True}).status_code == 403
    assert gateway.calls == []


def test_unknown_cancellation_is_404(client):
    assert as_(client, "maker", "GET", "/api/admin/cancellations/NOPE/refund").status_code == 404
    r = as_(client, "maker", "POST", "/api/admin/cancellations/NOPE/refund", json={})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_found"


def test_two_person_flow_over_http(client, db, customer, gateway, two_person):
    c, pay = setup_cancellation(db, customer)
    base = f"/api/admin/cancellations/{c.cancellation_ref}"

    r = as_(client, "maker", "POST", f"{base}/refund", json={})
    body = r.json()
    assert r.status_code == 200 and body["outcome"] == "awaiting_approval"
    (att,) = body["overview"]["attempts"]
    assert att["status"] == "pending" and att["initiated_by"] == {"id": 1, "name": "Admin 1"}
    assert gateway.calls == []

    again = as_(client, "maker", "POST", f"{base}/refund", json={}).json()
    assert again["outcome"] == "existing" and len(again["overview"]["attempts"]) == 1

    auth = f"{base}/refund/attempts/{att['attempt_id']}/authorize"
    assert as_(client, "other_maker", "POST", auth).status_code == 403            # no refund.authorize
    self_ = as_(client, "checker_is_maker", "POST", auth)
    assert self_.status_code == 403 and self_.json()["detail"]["code"] == "self_approval"
    assert gateway.calls == []

    ok = as_(client, "checker", "POST", auth)
    assert ok.status_code == 200 and ok.json()["outcome"] == "succeeded"
    ov = ok.json()["overview"]
    assert ov["previously_refunded"] == "100.00" and ov["remaining_refundable"] == "0.00"
    a = ov["attempts"][0]
    assert a["status"] == "succeeded" and a["approved_by"]["id"] == 3 and a["provider_refund_id"] == "rfnd_0001"
    assert len(gateway.calls) == 1


def test_over_refund_is_a_409_with_the_numbers(client, db, customer, gateway):
    c, _ = setup_cancellation(db, customer, refund_amount="100.00")
    r = as_(client, "maker", "POST", f"/api/admin/cancellations/{c.cancellation_ref}/refund", json={"amount": "150.00"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "exceeds_cancellation"
    assert gateway.calls == []


def test_fractional_paise_amount_is_rejected(client, db, customer, gateway):
    c, _ = setup_cancellation(db, customer)
    r = as_(client, "maker", "POST", f"/api/admin/cancellations/{c.cancellation_ref}/refund", json={"amount": "10.005"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "invalid_amount"


def test_legacy_complete_refund_can_no_longer_mark_anything_refunded(client, db, customer, gateway):
    c, _ = setup_cancellation(db, customer, status="refund_processing")
    r = as_(client, "maker", "PATCH", f"/api/admin/cancellations/{c.cancellation_ref}", json={"action": "complete_refund"})
    assert r.status_code == 400 and "no longer" in r.json()["detail"]
    db.refresh(c)
    assert c.status == "refund_processing"


def test_legacy_start_refund_goes_through_the_same_permissioned_workflow(client, db, customer, gateway, two_person, monkeypatch):
    c, _ = setup_cancellation(db, customer, refund_amount="40.00")
    r = as_(client, "maker", "PATCH", f"/api/admin/cancellations/{c.cancellation_ref}", json={"action": "start_refund"})
    assert r.status_code == 200 and r.json()["status"] == "refund_processing"
    assert gateway.calls == []                                                  # waiting for a checker
    # An admin whose role lacks refund.execute cannot use the old button either.
    admin_codes = rbac.ROLE_PERMISSIONS[UserRole.ADMIN]
    monkeypatch.setitem(rbac.ROLE_PERMISSIONS, UserRole.ADMIN, admin_codes - {"refund.execute"})
    c2, _ = setup_cancellation(db, customer, refund_amount="10.00")
    denied = as_(client, "maker", "PATCH", f"/api/admin/cancellations/{c2.cancellation_ref}", json={"action": "start_refund"})
    assert denied.status_code == 403


def test_manual_trustbrick_over_http(client, db, customer, monkeypatch, two_person):
    _, pay, c = trustbrick_cancellation(db, customer, monkeypatch, ref="JPH800001")
    base = f"/api/admin/cancellations/{c.cancellation_ref}"
    first = as_(client, "maker", "POST", f"{base}/refund", json={}).json()
    assert first["outcome"] == "manual_required"
    assert first["overview"]["manual_only"] is True and first["overview"]["attempts"][0]["status"] == "manual_required"

    body = {"reference": "UTR-1", "reason": "NEFT sent", "admin_override": False}
    no_override = as_(client, "checker", "POST", f"{base}/refund/manual", json=body)
    assert no_override.status_code == 400 and no_override.json()["detail"]["code"] == "override_required"
    assert as_(client, "other_maker", "POST", f"{base}/refund/manual", json={**body, "admin_override": True}).status_code == 403
    ok = as_(client, "checker", "POST", f"{base}/refund/manual", json={**body, "admin_override": True})
    assert ok.status_code == 200 and ok.json()["outcome"] == "manual_recorded"
    a = ok.json()["overview"]["attempts"][0]
    assert a["status"] == "succeeded" and a["is_manual"] and a["admin_override"] and a["manual_reference"] == "UTR-1"
    assert a["completed_by"]["id"] == 3


def test_reconcile_endpoint_is_permissioned_and_read_only(client, db, customer, gateway):
    gateway.mode = "pending"
    c, _ = setup_cancellation(db, customer)
    as_(client, "maker", "POST", f"/api/admin/cancellations/{c.cancellation_ref}/refund", json={})
    gateway.status_override = "refunded"
    n_calls = len(gateway.calls)
    r = as_(client, "maker", "POST", "/api/admin/cancellations/refunds/reconcile")
    assert r.status_code == 200 and r.json()["succeeded"] == 1
    assert len(gateway.calls) == n_calls                                        # asked, never re-submitted


def test_resolve_failed_endpoint(client, db, customer, gateway):
    gateway.mode = "timeout_lost"
    c, _ = setup_cancellation(db, customer)
    base = f"/api/admin/cancellations/{c.cancellation_ref}"
    att = as_(client, "maker", "POST", f"{base}/refund", json={}).json()["overview"]["attempts"][0]
    assert att["uncertain"] is True
    assert as_(client, "viewer", "POST", f"{base}/refund/attempts/{att['attempt_id']}/resolve-failed",
               json={"reason": "checked"}).status_code == 403
    r = as_(client, "maker", "POST", f"{base}/refund/attempts/{att['attempt_id']}/resolve-failed",
            json={"reason": "Razorpay dashboard shows no refund"})
    assert r.status_code == 200 and r.json()["overview"]["attempts"][0]["status"] == "failed"
    wrong = as_(client, "maker", "POST", f"/api/admin/cancellations/CXL-OTHER/refund/attempts/{att['attempt_id']}/resolve-failed",
                json={"reason": "x"})
    assert wrong.status_code == 404
