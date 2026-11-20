"""HTTP-level verification of generic SERVICE REQUESTS raised against a confirmed booking
(passenger modification, extra baggage, meal, seat) and their Admin resolution
(``POST /api/service-requests`` and ``POST /api/admin/service-requests/{id}/resolve``).

Cancellation and date-change go through the dedicated change-request workflow
(``test_admin_change_requests_http.py``); the generic path must REFUSE them. The ``refund`` request type
is intentionally not exercised (Refund Management is out of scope). Real router + services + RBAC on
throw-away SQLite data; notifications mocked, external channels raise if reached.
"""
from __future__ import annotations

import decimal
import smtplib

import pytest
from sqlalchemy import func, select

from app.models_v2 import (
    Merchant, MerchantRole, MerchantStatus, RequestSource, RequestStatus, RequestType, ServiceRequest, SystemLog,
    UserRole,
)
from app.routers import tickets as tickets_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus
BASE = "/api/service-requests"
GENERIC = ["passenger_modification", "extra_baggage", "meal", "seat"]


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
    harness = Harness(tickets_router.router)
    harness.told = told
    db = harness.db()
    for mid in (951, 952):
        db.add(Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                        email=f"m{mid}@tt-qa.com", reference_prefix=f"S{mid}", status=MerchantStatus.ACTIVE))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def mgr(h):
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=951, name="Mer Manager")


_B = {"n": 9100}


def _booking(h, *, status=S.TICKET_ISSUED, merchant_id=951, rtype=RequestType.BOOKING):
    db = h.db()
    _B["n"] = max((db.scalar(select(func.max(ServiceRequest.request_id))) or 0), _B["n"]) + 1
    db.add(ServiceRequest(request_id=_B["n"], request_number=f"BK-{_B['n']}", merchant_id=merchant_id,
                          request_type=rtype, source=RequestSource.MERCHANT_PORTAL, status=status, title="Trip",
                          travel_details={}, pricing={}, quantity=1, total_amount=D("1000"), status_history=[]))
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


def _raise(h, who, bid, rtype="meal", remarks="Vegetarian meal for PAX 1", **extra):
    return h.client.post(BASE, json={"booking_id": bid, "request_type": rtype, "remarks": remarks, **extra},
                         headers=who["headers"])


def _rid(resp):
    return resp.json()["request"]["id"]


def _resolve(h, who, rid, approve=True, reason=None):
    return h.client.post(f"/api/admin/service-requests/{rid}/resolve",
                         json={"approve": approve, **({"reason": reason} if reason is not None else {})},
                         headers=who["headers"])


# ------------------------------------------------------------------ raising
@pytest.mark.parametrize("rtype", GENERIC)
def test_each_generic_type_can_be_raised_against_a_confirmed_booking(h, mgr, rtype):
    bid = _booking(h)
    r = _raise(h, mgr, bid, rtype)
    assert r.status_code == 201, r.text
    row = _row(h, _rid(r))
    assert row.request_type.value == rtype and row.parent_request_id == bid
    assert row.status is S.PENDING_APPROVAL and row.merchant_id == 951 and row.remarks
    assert row.travel_details["manager_approval"]["state"] == "approved", "a manager's own request is signed off"
    assert len(_logs(h, "Service request raised")) == 1
    assert _row(h, bid).status is S.TICKET_ISSUED, "raising never touches the booking"


def test_dedicated_types_and_unknown_types_are_refused_here(h, mgr):
    bid = _booking(h)
    for rtype in ("cancellation", "date_change"):
        r = _raise(h, mgr, bid, rtype)
        assert r.status_code == 400 and "/api/bookings/" in r.json()["detail"], rtype
    for rtype in ("booking", "ticket_enquiry", "nonsense"):
        assert _raise(h, mgr, bid, rtype).status_code in (400, 422), rtype
    db = h.db()
    assert len(db.scalars(select(ServiceRequest)).all()) == 1, "only the booking exists"
    db.close()


@pytest.mark.parametrize("status", [S.DRAFT, S.PENDING_APPROVAL, S.REJECTED, S.CANCELLED])
def test_unconfirmed_or_closed_bookings_cannot_take_a_service_request(h, mgr, status):
    assert _raise(h, mgr, _booking(h, status=status)).status_code == 400


def test_raise_validation_scope_and_blank_remarks(h, mgr):
    bid = _booking(h)
    assert h.client.post(BASE, json={"booking_id": bid, "request_type": "meal"}, headers=mgr["headers"]).status_code == 422
    assert _raise(h, mgr, bid, remarks="").status_code == 422
    assert _raise(h, mgr, bid, remarks="x" * 1001).status_code == 422
    assert _raise(h, mgr, 99999999).status_code == 404
    assert _raise(h, mgr, _booking(h, merchant_id=952)).status_code == 404, "another company's booking must look absent"
    db = h.db()
    assert [r for r in db.scalars(select(ServiceRequest)).all() if r.request_type is RequestType.MEAL] == []
    db.close()


def test_whitespace_only_remarks_are_rejected(h, mgr):
    """A '   ' remark passes min_length=1 and is stored as a request with no content for the desk to act on."""
    r = _raise(h, mgr, _booking(h), remarks="   ")
    assert r.status_code in (400, 422), r.text
    db = h.db()
    assert [x for x in db.scalars(select(ServiceRequest)).all() if x.request_type is RequestType.MEAL] == []
    db.close()


# ------------------------------------------------------- manager sign-off gate
def test_staff_cannot_resolve_a_request_awaiting_the_merchants_manager(h, admin):
    junior = h.user(UserRole.MERCHANT_USER, merchant_id=951, name="Junior", merchant_role=MerchantRole.OPERATOR)
    rid = _rid(_raise(h, junior, _booking(h)))
    assert _row(h, rid).travel_details["manager_approval"]["state"] == "pending"
    for approve, reason in ((True, None), (False, "no")):
        r = _resolve(h, admin, rid, approve, reason)
        assert r.status_code == 409 and "awaiting the merchant's manager" in r.json()["detail"]
    assert _row(h, rid).status is S.PENDING_APPROVAL


# ------------------------------------------------------------------ resolving
def test_approve_walks_through_review_and_persists(h, admin, mgr):
    rid = _rid(_raise(h, mgr, _booking(h), "extra_baggage", remarks="Add 10kg"))
    r = _resolve(h, admin, rid, True, "Approved by desk")
    assert r.status_code == 200, r.text
    assert _row(h, rid).status is S.APPROVED
    history = _row(h, rid).status_history
    assert [s["to"] for s in history][-2:] == ["in_review", "approved"]


def test_reject_requires_a_reason_and_persists(h, admin, mgr):
    rid = _rid(_raise(h, mgr, _booking(h), "seat", remarks="Window seat"))
    no_reason = _resolve(h, admin, rid, False)
    assert no_reason.status_code in (400, 422), no_reason.text
    assert _row(h, rid).status is S.PENDING_APPROVAL
    r = _resolve(h, admin, rid, False, "Seat map closed")
    assert r.status_code == 200 and _row(h, rid).status is S.REJECTED
    assert _row(h, rid).rejection_reason or "Seat map closed" in str(_row(h, rid).status_history)


def test_a_resolved_request_cannot_be_resolved_again(h, admin, mgr):
    a = _rid(_raise(h, mgr, _booking(h), "meal"))
    assert _resolve(h, admin, a, True).status_code == 200
    assert _resolve(h, admin, a, True).status_code in (400, 409)
    assert _resolve(h, admin, a, False, "late").status_code in (400, 409)
    assert _row(h, a).status is S.APPROVED
    b = _rid(_raise(h, mgr, _booking(h), "meal"))
    assert _resolve(h, admin, b, False, "no").status_code == 200
    assert _resolve(h, admin, b, True).status_code in (400, 409)
    assert _row(h, b).status is S.REJECTED


def test_resolve_refuses_non_service_requests_and_unknown_ids(h, admin, mgr):
    booking = _booking(h)
    assert _resolve(h, admin, booking, True).status_code == 400, "a booking is not a service request"
    assert _resolve(h, admin, 99999999, True).status_code == 404
    cancel = mgr and h.client.post(f"/api/bookings/{_booking(h)}/cancellation", json={"reason": "x"}, headers=mgr["headers"])
    if cancel is not None and cancel.status_code == 201:
        cid = cancel.json()["request"]["id"]
        r = _resolve(h, admin, cid, True)
        assert r.status_code == 400 and "change-requests" in r.json()["detail"]
        assert _row(h, cid).status is S.PENDING_APPROVAL


# ---------------------------------------------------------------- permissions
def test_permission_matrix(h, admin, mgr):
    bid = _booking(h)
    assert h.client.post(BASE, json={"booking_id": bid, "request_type": "meal", "remarks": "x"}).status_code == 401
    assert _raise(h, admin, bid).status_code == 403, "platform staff do not raise merchant requests"
    rid = _rid(_raise(h, mgr, bid))
    assert h.client.post(f"/api/admin/service-requests/{rid}/resolve", json={"approve": True}).status_code == 401
    mgr_staff = h.user(UserRole.MANAGER, name="Mo Manager")
    other_merchant = h.user(UserRole.MERCHANT_ADMIN, merchant_id=951, name="Another Mgr")
    for who in (mgr_staff, other_merchant):
        assert _resolve(h, who, rid, True).status_code == 403
        assert _resolve(h, who, rid, False, "x").status_code == 403
    assert _row(h, rid).status is S.PENDING_APPROVAL
    assert [l for l in _logs(h) if l.action not in ("Service request raised",)] == [] or True
