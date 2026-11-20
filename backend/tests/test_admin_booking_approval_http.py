"""HTTP-level verification of the Admin booking APPROVAL workflow:
``POST /api/admin/requests/{id}/approve | reprice | reject``.

Real router + services + models on throw-away SQLite data (``tests/_v2_harness.py``);
notification delivery is mocked and every external channel raises if reached.
Business rules asserted are the ones the code itself documents (amount required, credit limit,
mandatory reasons, reprice only at Payment Pending, state-machine refusals) — none are invented.
PostgreSQL-specific behaviour is not exercised here.
"""
from __future__ import annotations

import decimal
import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import (
    Merchant, MerchantStatus, RequestSource, RequestStatus, RequestType, ServiceRequest, SystemLog, UserRole,
)
from app.routers import tickets as tickets_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

D = decimal.Decimal


@pytest.fixture()
def h(monkeypatch):
    sent = []
    monkeypatch.setattr(notification_service, "create_notification",
                        lambda db, uid, title, msg: sent.append((uid, title, msg)))

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)
    harness = Harness(tickets_router.router)
    harness.sent = sent
    db = harness.db()
    db.add(Merchant(merchant_id=501, merchant_code="M501", merchant_name="Mer", company_name="Mer Co",
                    email="m@tt-qa.com", reference_prefix="MC", status=MerchantStatus.ACTIVE,
                    credit_limit=D("100000")))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


_RID = {"n": 7000}


def _request(h, *, status=RequestStatus.PENDING_APPROVAL, total="0", rtype=RequestType.BOOKING,
             merchant_id=501, user_id=None):
    _RID["n"] += 1
    db = h.db()
    db.add(ServiceRequest(
        request_id=_RID["n"], request_number=f"REQ-T-{_RID['n']}", merchant_id=merchant_id, user_id=user_id,
        request_type=rtype, source=RequestSource.MERCHANT_PORTAL, status=status, title="Test booking",
        travel_details={}, pricing={}, quantity=1, total_amount=D(total)))
    db.commit()
    db.close()
    return _RID["n"]


def _state(h, rid):
    db = h.db()
    r = db.get(ServiceRequest, rid)
    out = (r.status, r.total_amount)
    db.close()
    return out


def _approve(h, admin, rid, **body):
    return h.client.post(f"/api/admin/requests/{rid}/approve", json=body, headers=admin["headers"])


def _logs(h):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return rows


# ------------------------------------------------------------------ approve
def test_approve_prices_and_moves_to_payment_pending_with_audit(h, admin):
    rid = _request(h)
    r = _approve(h, admin, rid, final_amount="5000")
    assert r.status_code == 200, r.text
    status, total = _state(h, rid)
    assert status is RequestStatus.PAYMENT_PENDING and total == D("5000")
    logs = [l for l in _logs(h) if l.action == "Ticket request approved"]
    assert len(logs) == 1 and logs[0].user_id == admin["id"]


def test_approve_records_each_transition_on_the_timeline(h, admin):
    rid = _request(h)
    body = _approve(h, admin, rid, final_amount="1200").json()
    history = body.get("status_history") or body.get("timeline") or []
    assert len(history) >= 3, body.keys()


@pytest.mark.parametrize("body", [{}, {"final_amount": "0"}], ids=["no-amount-on-unpriced", "zero"])
def test_approve_without_a_payable_amount_is_refused_and_changes_nothing(h, admin, body):
    rid = _request(h, total="0")
    r = _approve(h, admin, rid, **body)
    assert r.status_code == 400 and "no amount to pay" in r.json()["detail"], r.text
    assert _state(h, rid)[0] is RequestStatus.PENDING_APPROVAL
    assert [l for l in _logs(h) if l.action == "Ticket request approved"] == []


def test_approve_negative_amount_is_rejected(h, admin):
    rid = _request(h)
    assert _approve(h, admin, rid, final_amount="-5").status_code == 422
    assert _state(h, rid)[0] is RequestStatus.PENDING_APPROVAL


def test_already_priced_booking_can_be_approved_without_resending_the_amount(h, admin):
    rid = _request(h, total="800")
    assert _approve(h, admin, rid).status_code == 200
    assert _state(h, rid) == (RequestStatus.PAYMENT_PENDING, D("800"))


def test_approval_beyond_the_merchant_credit_limit_is_refused_atomically(h, admin):
    rid = _request(h)
    r = _approve(h, admin, rid, final_amount="100001")          # limit is 100000 in the fixture
    assert r.status_code in (400, 402, 409), r.text
    assert _state(h, rid) == (RequestStatus.PENDING_APPROVAL, D("0")), "refusal must leave it un-priced"


def test_approve_twice_and_approve_after_reject_are_refused(h, admin):
    rid = _request(h)
    assert _approve(h, admin, rid, final_amount="500").status_code == 200
    again = _approve(h, admin, rid, final_amount="500")
    assert again.status_code in (400, 409), again.text
    rid2 = _request(h)
    assert h.client.post(f"/api/admin/requests/{rid2}/reject", json={"reason": "no seats"},
                         headers=admin["headers"]).status_code == 200
    assert _approve(h, admin, rid2, final_amount="500").status_code in (400, 409)
    assert _state(h, rid2)[0] is RequestStatus.REJECTED


def test_approve_missing_request_is_404(h, admin):
    assert _approve(h, admin, 99999999, final_amount="1").status_code == 404


def test_enquiries_cannot_go_through_the_booking_approval_endpoint(h, admin):
    rid = _request(h, rtype=RequestType.TICKET_ENQUIRY)
    r = _approve(h, admin, rid, final_amount="500")
    assert r.status_code in (400, 409, 422), r.text
    assert _state(h, rid)[0] is RequestStatus.PENDING_APPROVAL


# ------------------------------------------------------------------- reject
def test_reject_requires_a_reason_and_persists_with_audit(h, admin):
    rid = _request(h)
    for bad in ({}, {"reason": ""}):
        assert h.client.post(f"/api/admin/requests/{rid}/reject", json=bad,
                             headers=admin["headers"]).status_code == 422
    assert _state(h, rid)[0] is RequestStatus.PENDING_APPROVAL
    r = h.client.post(f"/api/admin/requests/{rid}/reject", json={"reason": "Fare unavailable"},
                      headers=admin["headers"])
    assert r.status_code == 200, r.text
    assert _state(h, rid)[0] is RequestStatus.REJECTED
    assert any("rejected" in (l.action or "").lower() for l in _logs(h))


def test_reject_a_paid_or_already_rejected_booking_is_refused(h, admin):
    done = _request(h, status=RequestStatus.PAID, total="900")
    r = h.client.post(f"/api/admin/requests/{done}/reject", json={"reason": "x"}, headers=admin["headers"])
    assert r.status_code in (400, 409), r.text
    assert _state(h, done)[0] is RequestStatus.PAID


def test_reject_reason_longer_than_500_is_422(h, admin):
    rid = _request(h)
    r = h.client.post(f"/api/admin/requests/{rid}/reject", json={"reason": "x" * 501}, headers=admin["headers"])
    assert r.status_code == 422


# ------------------------------------------------------------------ reprice
def test_reprice_only_at_payment_pending_with_mandatory_reason(h, admin):
    pending = _request(h)
    r = h.client.post(f"/api/admin/requests/{pending}/reprice", json={"amount": "700", "reason": "fix"},
                      headers=admin["headers"])
    assert r.status_code in (400, 409), r.text                  # not yet Payment Pending
    owner = h.user(UserRole.MERCHANT_USER, merchant_id=501, name="Booking Owner")
    rid = _request(h, status=RequestStatus.PAYMENT_PENDING, total="1000", user_id=owner["id"])
    for bad in ({"amount": "700"}, {"amount": "700", "reason": ""}, {"amount": "0", "reason": "x"},
                {"amount": "-3", "reason": "x"}):
        assert h.client.post(f"/api/admin/requests/{rid}/reprice", json=bad,
                             headers=admin["headers"]).status_code == 422, bad
    assert _state(h, rid) == (RequestStatus.PAYMENT_PENDING, D("1000"))
    ok = h.client.post(f"/api/admin/requests/{rid}/reprice", json={"amount": "700", "reason": "Fare corrected"},
                       headers=admin["headers"])
    assert ok.status_code == 200, ok.text
    assert _state(h, rid) == (RequestStatus.PAYMENT_PENDING, D("700"))
    assert h.sent, "the merchant is notified of a repricing (delivery mocked)"


# -------------------------------------------------------------- permissions
def test_anonymous_and_unprivileged_users_cannot_approve_reject_or_reprice(h, admin):
    rid = _request(h)
    for method_url, body in [(f"/api/admin/requests/{rid}/approve", {"final_amount": "5"}),
                             (f"/api/admin/requests/{rid}/reject", {"reason": "x"}),
                             (f"/api/admin/requests/{rid}/reprice", {"amount": "5", "reason": "x"})]:
        assert h.client.post(method_url, json=body).status_code == 401
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    merchant_user = h.user(UserRole.MERCHANT_USER, merchant_id=501, name="Mer User")
    for who in (mgr, merchant_user):
        assert h.client.post(f"/api/admin/requests/{rid}/approve", json={"final_amount": "5"},
                             headers=who["headers"]).status_code == 403
        assert h.client.post(f"/api/admin/requests/{rid}/reject", json={"reason": "x"},
                             headers=who["headers"]).status_code == 403
        assert h.client.post(f"/api/admin/requests/{rid}/reprice", json={"amount": "5", "reason": "x"},
                             headers=who["headers"]).status_code == 403
    assert _state(h, rid)[0] is RequestStatus.PENDING_APPROVAL
    assert _logs(h) == [] or all("approved" not in (l.action or "").lower() for l in _logs(h))
