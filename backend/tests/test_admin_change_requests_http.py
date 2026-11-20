"""HTTP-level verification of CANCELLATION & RESCHEDULE change requests (the Admin "Service Request
Management" desk): raise (merchant side), list/detail/counts, manager sign-off gate, claim (review),
approve (settle) and reject — with persistence, state-machine refusals, permissions and audit.

Real router + services + RBAC on throw-away SQLite data. Bookings used here are UNPAID, so a
cancellation settles a refund of 0 and no wallet/ledger money moves; reschedule fees are only billed
to wallet-billed bookings (none here). Nothing is sent: notification delivery is mocked and every
external channel raises if reached. PostgreSQL row locks are not exercised.
"""
from __future__ import annotations

import datetime as dt
import decimal
import smtplib

import pytest
from sqlalchemy import func, select

from app.models_v2 import (
    Merchant, MerchantRole, MerchantStatus, RequestSource, RequestStatus, RequestType, ServiceRequest,
    SystemLog, User, UserRole,
)
from app.routers import change_requests as cr_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus
TOMORROW = dt.date.today() + dt.timedelta(days=30)
LATER = dt.date.today() + dt.timedelta(days=45)


@pytest.fixture()
def h(monkeypatch):
    told = []
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant"):
        monkeypatch.setattr(notification_service, name, lambda *a, _n=name, **k: told.append(_n) or 0)

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)
    harness = Harness(cr_router.router)
    harness.told = told
    db = harness.db()
    for mid, code in ((801, "M801"), (802, "M802")):
        db.add(Merchant(merchant_id=mid, merchant_code=code, merchant_name=code, company_name=f"{code} Co",
                        email=f"{code.lower()}@tt-qa.com", reference_prefix=f"C{mid}"[:8],
                        status=MerchantStatus.ACTIVE, wallet_balance=D("0"), credit_limit=D("0")))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def mgr(h):
    """A merchant manager: merchant_admin => a request they raise is stamped approved on the spot."""
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=801, name="Mer Manager")


_B = {"n": 8100}


def _booking(h, *, status=S.PAID, merchant_id=801, total="2000", travel=None):
    db = h.db()
    # SQLite gives app-created rows max(rowid)+1, so allocate the same way to avoid collisions.
    _B["n"] = max((db.scalar(select(func.max(ServiceRequest.request_id))) or 0), _B["n"]) + 1
    db.add(ServiceRequest(
        request_id=_B["n"], request_number=f"BK-{_B['n']}", merchant_id=merchant_id,
        request_type=RequestType.BOOKING, source=RequestSource.MERCHANT_PORTAL, status=status,
        title="Delhi to Goa", travel_details={}, pricing={}, quantity=1, total_amount=D(total),
        travel_date=travel or (dt.date.today() + dt.timedelta(days=10)), status_history=[]))
    db.commit()
    db.close()
    return _B["n"]


def _row(h, rid):
    db = h.db()
    r = db.get(ServiceRequest, rid)
    db.close()
    return r


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _cancel(h, who, bid, reason="Customer changed plans"):
    return h.client.post(f"/api/bookings/{bid}/cancellation", json={"reason": reason}, headers=who["headers"])


def _resched(h, who, bid, new=TOMORROW, **extra):
    body = {"new_travel_date": new.isoformat(), "reason": "Customer asked", **extra}
    return h.client.post(f"/api/bookings/{bid}/reschedule", json=body, headers=who["headers"])


def _cid(resp):
    return resp.json()["request"]["id"]


def _admin(h, admin, action, cid, **body):
    return h.client.post(f"/api/admin/change-requests/{cid}/{action}", json=body, headers=admin["headers"])


# ------------------------------------------------------------------ raising
def test_raise_cancellation_creates_a_pending_request_without_touching_the_booking(h, mgr):
    bid = _booking(h)
    r = _cancel(h, mgr, bid)
    assert r.status_code == 201, r.text
    cid = _cid(r)
    cr = _row(h, cid)
    assert cr.request_type is RequestType.CANCELLATION and cr.parent_request_id == bid
    assert cr.status is S.PENDING_APPROVAL and cr.total_amount == D("0.00") and cr.pricing == {}
    assert _row(h, bid).status is S.PAID, "a request is not a cancellation"
    assert len(_logs(h, "Cancellation requested")) == 1


def test_raise_validation_and_state_rules(h, mgr):
    ok = _booking(h)
    assert h.client.post(f"/api/bookings/{ok}/cancellation", json={}, headers=mgr["headers"]).status_code == 422
    assert _cancel(h, mgr, ok, reason="   ").status_code == 400
    assert _cancel(h, mgr, ok, reason="x" * 2001).status_code == 422
    for st in (S.DRAFT, S.PENDING_APPROVAL, S.REJECTED, S.CANCELLED):
        assert _cancel(h, mgr, _booking(h, status=st)).status_code == 409, st
    # COMPLETED: cancelling a flown trip is deliberately allowed (money, not travel, is being settled — see
    # CANCELLABLE_PARENT_STATUSES); moving its date is not.
    done = _booking(h, status=S.COMPLETED)
    assert _resched(h, mgr, done).status_code == 409
    assert _cancel(h, mgr, done).status_code == 201
    assert _cancel(h, mgr, 99999999).status_code == 404
    other = _booking(h, merchant_id=802)
    assert _cancel(h, mgr, other).status_code == 404, "another company's booking must look absent"
    db = h.db()
    made = db.scalars(select(ServiceRequest).where(ServiceRequest.request_type == RequestType.CANCELLATION)).all()
    db.close()
    assert len(made) == 1, "only the allowed COMPLETED cancellation was created"


def test_only_one_open_change_and_one_live_cancellation_per_booking(h, mgr):
    bid = _booking(h)
    assert _cancel(h, mgr, bid).status_code == 201
    assert _cancel(h, mgr, bid).status_code == 409
    assert _resched(h, mgr, bid).status_code == 409, "a reschedule is blocked while a change is open"


def test_reschedule_validation_and_booking_dates_untouched_until_approval(h, mgr):
    bid = _booking(h)
    past = dt.date.today() - dt.timedelta(days=1)
    assert _resched(h, mgr, bid, new=past).status_code == 400
    assert _resched(h, mgr, bid, new=dt.date.today()).status_code == 400
    assert _resched(h, mgr, bid, new=_row(h, bid).travel_date).status_code == 400
    assert _resched(h, mgr, bid, new=LATER, new_return_date=TOMORROW.isoformat()).status_code == 400
    before = _row(h, bid).travel_date
    r = _resched(h, mgr, bid)
    assert r.status_code == 201, r.text
    assert _row(h, bid).travel_date == before
    assert _row(h, _cid(r)).travel_details["new_travel_date"] == TOMORROW.isoformat()
    assert len(_logs(h, "Reschedule requested")) == 1


# -------------------------------------------------------- reading / counts
def test_admin_can_list_view_and_count_change_requests(h, admin, mgr):
    bid = _booking(h)
    cid = _cid(_cancel(h, mgr, bid))
    lst = h.client.get("/api/change-requests", headers=admin["headers"])
    assert lst.status_code == 200 and cid in [i["id"] for i in lst.json()["items"]]
    det = h.client.get(f"/api/change-requests/{cid}", headers=admin["headers"])
    assert det.status_code == 200
    body = det.json()
    assert body["request"]["status"] == "pending_approval" and body["booking"]["id"] == bid
    assert body["can_review"] is True and body["timeline"]
    assert h.client.get("/api/change-requests/counts", headers=admin["headers"]).json()["pending_approval"] == 1
    hist = h.client.get(f"/api/bookings/{bid}/change-requests", headers=admin["headers"])
    assert hist.status_code == 200 and [i["id"] for i in hist.json()] == [cid]
    assert h.client.get("/api/change-requests/99999999", headers=admin["headers"]).status_code == 404
    assert h.client.get(f"/api/change-requests/{bid}", headers=admin["headers"]).status_code == 404, "a booking is not a change request"


def test_a_merchant_sees_only_its_own_change_requests(h, mgr):
    cid = _cid(_cancel(h, mgr, _booking(h)))
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=802, name="Other Mgr")
    assert h.client.get(f"/api/change-requests/{cid}", headers=other["headers"]).status_code == 404
    mine = h.client.get("/api/change-requests", headers=other["headers"]).json()
    assert cid not in [i["id"] for i in mine["items"]]


# ----------------------------------------------------- manager sign-off gate
def test_staff_cannot_act_on_a_request_still_awaiting_the_merchants_manager(h, admin):
    junior = h.user(UserRole.MERCHANT_USER, merchant_id=801, name="Junior", merchant_role=MerchantRole.OPERATOR)
    bid = _booking(h)
    cid = _cid(_cancel(h, junior, bid))
    assert _row(h, cid).travel_details["manager_approval"]["state"] == "pending"
    for action, body in (("review", {}), ("approve", {}), ("reject", {"reason": "no"})):
        r = _admin(h, admin, action, cid, **body)
        assert r.status_code == 409 and "awaiting the merchant's manager" in r.json()["detail"], (action, r.text)
    assert _row(h, cid).status is S.PENDING_APPROVAL and _row(h, bid).status is S.PAID
    det = h.client.get(f"/api/change-requests/{cid}", headers=admin["headers"]).json()
    assert det["can_review"] is False and det["can_settle"] is False


# --------------------------------------------------------------- review/claim
def test_review_claims_once_and_blocks_a_second_admin(h, admin, mgr):
    cid = _cid(_cancel(h, mgr, _booking(h)))
    assert _admin(h, admin, "review", cid).status_code == 200
    assert _row(h, cid).status is S.IN_REVIEW
    assert _admin(h, admin, "review", cid).status_code == 200, "re-claiming your own is a no-op"
    other = h.user(UserRole.ADMIN, name="Bo Other")
    r = _admin(h, other, "review", cid)
    assert r.status_code == 409 and "Ada Admin" in r.json()["detail"]
    for action, body in (("approve", {}), ("reject", {"reason": "mine now"})):
        assert _admin(h, other, action, cid, **body).status_code == 409, action
    assert _row(h, cid).status is S.IN_REVIEW
    assert len(_logs(h, "Cancellation review started")) == 1


# -------------------------------------------------------- approve: cancellation
def test_approve_cancellation_cancels_the_booking_quotes_the_charge_and_audits(h, admin, mgr):
    bid = _booking(h, total="2000")
    cid = _cid(_cancel(h, mgr, bid))
    r = _admin(h, admin, "approve", cid, cancellation_charge="300.00", note="Airline penalty")
    assert r.status_code == 200, r.text
    cr, bk = _row(h, cid), _row(h, bid)
    assert cr.status is S.APPROVED and bk.status is S.CANCELLED
    assert cr.pricing["cancellation_charge"] == "300.00" and cr.pricing["refund_amount"] == "1700.00"
    assert cr.pricing["refund_settled"] == "0.00", "unpaid booking: nothing to give back, and it says so"
    assert cr.total_amount == D("1700.00")
    log = _logs(h, "Cancellation approved")
    assert len(log) == 1 and log[0].user_id == admin["id"]
    assert r.json()["booking"]["status"] == "cancelled"


def test_approve_cancellation_rejects_bad_amounts_and_changes_nothing(h, admin, mgr):
    bid = _booking(h, total="2000")
    cid = _cid(_cancel(h, mgr, bid))
    for charge in ("2000.01", "-5", "abc", ""):
        r = _admin(h, admin, "approve", cid, cancellation_charge=charge)
        assert r.status_code == 400, (charge, r.text)
    assert _row(h, cid).status is S.PENDING_APPROVAL and _row(h, bid).status is S.PAID
    assert _logs(h, "Cancellation approved") == []
    free = _admin(h, admin, "approve", cid)          # omitted = free cancellation
    assert free.status_code == 200 and _row(h, cid).pricing["cancellation_charge"] == "0.00"


def test_double_approval_and_approve_after_reject_are_refused(h, admin, mgr):
    cid = _cid(_cancel(h, mgr, _booking(h)))
    assert _admin(h, admin, "approve", cid).status_code == 200
    for action, body in (("approve", {}), ("reject", {"reason": "late"}), ("review", {})):
        assert _admin(h, admin, action, cid, **body).status_code == 409, action
    assert len(_logs(h, "Cancellation approved")) == 1

    cid2 = _cid(_cancel(h, mgr, _booking(h)))
    assert _admin(h, admin, "reject", cid2, reason="Not allowed").status_code == 200
    assert _admin(h, admin, "approve", cid2).status_code == 409


def test_approve_is_refused_if_the_booking_moved_on_while_queued(h, admin, mgr):
    bid = _booking(h)
    cid = _cid(_cancel(h, mgr, bid))
    db = h.db()
    db.get(ServiceRequest, bid).status = S.CANCELLED
    db.commit()
    db.close()
    r = _admin(h, admin, "approve", cid)
    assert r.status_code == 409 and "Reject" in r.json()["detail"]
    assert _row(h, bid).status is S.CANCELLED and _row(h, cid).status is S.PENDING_APPROVAL


# ---------------------------------------------------------- approve: reschedule
def test_approve_reschedule_moves_the_dates_records_history_and_bills_nothing_unbilled(h, admin, mgr):
    bid = _booking(h)
    old = _row(h, bid).travel_date
    cid = _cid(_resched(h, mgr, bid, new=TOMORROW, new_return_date=LATER.isoformat()))
    r = _admin(h, admin, "approve", cid, fare_difference="150.00", change_fee="50.00")
    assert r.status_code == 200, r.text
    bk, cr = _row(h, bid), _row(h, cid)
    assert bk.travel_date == TOMORROW and bk.return_date == LATER and bk.status is S.PAID
    hist = bk.travel_details["reschedule_history"]
    assert len(hist) == 1 and hist[0]["from"]["travel_date"] == old.isoformat() and hist[0]["payable"] == "200.00"
    assert cr.status is S.APPROVED and cr.pricing["total_payable"] == "200.00"
    assert len(_logs(h, "Reschedule approved")) == 1


@pytest.mark.parametrize("body", [{"fare_difference": "-1"}, {"change_fee": "-1"}, {"fare_difference": "x"}],
                         ids=["neg-fare", "neg-fee", "not-a-number"])
def test_reschedule_never_accepts_negative_or_invalid_amounts(h, admin, mgr, body):
    bid = _booking(h)
    old = _row(h, bid).travel_date
    cid = _cid(_resched(h, mgr, bid))
    assert _admin(h, admin, "approve", cid, **body).status_code == 400
    assert _row(h, bid).travel_date == old and _row(h, cid).status is S.PENDING_APPROVAL


# ---------------------------------------------------------------------- reject
def test_reject_requires_a_reason_leaves_the_booking_alone_and_allows_a_new_request(h, admin, mgr):
    bid = _booking(h)
    cid = _cid(_cancel(h, mgr, bid))
    for body in ({}, {"reason": ""}, {"reason": "x" * 2001}):
        assert _admin(h, admin, "reject", cid, **body).status_code == 422
    assert _admin(h, admin, "reject", cid, reason="   ").status_code in (400, 422)
    assert _row(h, cid).status is S.PENDING_APPROVAL
    r = _admin(h, admin, "reject", cid, reason="Outside the fare rules")
    assert r.status_code == 200, r.text
    assert _row(h, cid).status is S.REJECTED and _row(h, bid).status is S.PAID
    log = _logs(h, "Cancellation rejected")
    assert len(log) == 1 and log[0].user_id == admin["id"]
    assert _cancel(h, mgr, bid).status_code == 201, "a refused cancellation may be asked for again"


def test_unknown_change_request_is_404_for_every_admin_action(h, admin):
    for action, body in (("review", {}), ("approve", {}), ("reject", {"reason": "x"})):
        assert _admin(h, admin, action, 99999999, **body).status_code == 404, action


# ----------------------------------------------------------------- permissions
def test_anonymous_and_unprivileged_callers_cannot_settle_or_raise(h, mgr, admin):
    cid = _cid(_cancel(h, mgr, _booking(h)))
    for action, body in (("review", None), ("approve", {}), ("reject", {"reason": "x"})):
        assert h.client.post(f"/api/admin/change-requests/{cid}/{action}", json=body).status_code == 401
    assert h.client.get("/api/change-requests").status_code == 401
    manager_staff = h.user(UserRole.MANAGER, name="Mo Manager")
    merchant = h.user(UserRole.MERCHANT_ADMIN, merchant_id=801, name="Another Mgr")
    for who in (manager_staff, merchant):
        for action, body in (("review", None), ("approve", {}), ("reject", {"reason": "x"})):
            r = h.client.post(f"/api/admin/change-requests/{cid}/{action}", json=body, headers=who["headers"])
            assert r.status_code == 403, (who, action, r.status_code)
    bid2 = _booking(h)
    assert _cancel(h, admin, bid2).status_code == 403, "platform staff do not raise merchant requests"
    assert _cancel(h, {"headers": {}}, bid2).status_code == 401
    assert _row(h, cid).status is S.PENDING_APPROVAL
    assert [l for l in _logs(h) if l.action.endswith(("approved", "rejected", "review started"))] == []
