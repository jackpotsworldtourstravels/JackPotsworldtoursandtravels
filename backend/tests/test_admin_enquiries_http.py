"""HTTP-level verification of TICKET ENQUIRIES from the Admin desk's point of view: the manual
enquiry (desk raises one on a merchant's behalf), listing / detail scoping, and the admin
review -> quotation / decline workflow (``/api/admin/enquiries/{id}/review|respond``).

Real router + services + RBAC on throw-away SQLite data. Nothing is quoted to a real customer or
supplier: notifications are mocked and external channels raise if reached. Free-text ``search`` uses
PostgreSQL JSONB operators and is not exercised here (BLOCKED on PostgreSQL).
"""
from __future__ import annotations

import datetime as dt
import decimal
import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import (
    Merchant, MerchantStatus, RequestSource, RequestStatus, RequestType, ServiceRequest, SystemLog, UserRole,
)
from app.routers import enquiries as enquiries_router
from app.services import delivery_service, notification_service, service_access_service, ticket_service
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus
TRAVEL = (dt.date.today() + dt.timedelta(days=20)).isoformat()
RECEIVED = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat()


@pytest.fixture()
def h(monkeypatch):
    told = []
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant"):
        monkeypatch.setattr(notification_service, name, lambda *a, _n=name, **k: told.append(_n) or 0)
    monkeypatch.setattr(ticket_service, "_notify_merchant", lambda *a, **k: told.append("merchant"))

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)
    harness = Harness(enquiries_router.router)
    harness.told = told
    db = harness.db()
    for mid in (901, 902):
        m = Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                     email=f"m{mid}@tt-qa.com", reference_prefix=f"E{mid}", status=MerchantStatus.ACTIVE)
        db.add(m)
        db.flush()
        service_access_service.ensure_defaults(db, m)
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def merchant(h):
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=901, name="Mer Admin")


def _payload(**over):
    body = {"trip_type": "one_way", "origin": "DEL", "destination": "GOI", "travel_date": TRAVEL,
            "preferred_time": "10:30", "travel_class": "Economy", "passenger_count": 2, "adults": 2}
    body.update(over)
    return body


def _create(h, who, **over):
    return h.client.post("/api/enquiries", json=_payload(**over), headers=who["headers"])


def _manual(h, admin, merchant_id=901, **over):
    return _create(h, admin, on_behalf_of_merchant_id=merchant_id, received_date_time=RECEIVED, **over)


def _row(h, eid):
    db = h.db()
    r = db.get(ServiceRequest, eid)
    db.close()
    return r


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _respond(h, who, eid, **body):
    return h.client.post(f"/api/admin/enquiries/{eid}/respond", json=body, headers=who["headers"])


def _review(h, who, eid):
    return h.client.post(f"/api/admin/enquiries/{eid}/review", headers=who["headers"])


# ------------------------------------------------------------------ creation
def test_merchant_creates_an_enquiry_for_itself(h, merchant):
    r = _create(h, merchant)
    assert r.status_code == 201, r.text
    row = _row(h, r.json()["id"])
    assert row.request_type is RequestType.TICKET_ENQUIRY and row.status is S.PENDING_APPROVAL
    assert row.merchant_id == 901 and row.source is RequestSource.MERCHANT_PORTAL
    assert row.total_amount == D("0") and row.request_number.startswith("ENQ-")
    assert len(_logs(h, "Ticket enquiry raised")) == 1


def test_manual_enquiry_is_filed_against_the_merchant_and_attributed_to_the_desk(h, admin):
    r = _manual(h, admin, merchant_id=902)
    assert r.status_code == 201, r.text
    row = _row(h, r.json()["id"])
    assert row.merchant_id == 902 and row.user_id == admin["id"]
    assert row.source is RequestSource.B2B_MANUAL_ENQUIRY and row.received_date_time is not None
    log = _logs(h, "Ticket enquiry raised")
    assert len(log) == 1 and log[0].user_id == admin["id"] and log[0].merchant_id == 902


def test_manual_enquiry_rules(h, admin, merchant):
    assert _create(h, admin).status_code == 403, "an admin with no on-behalf-of merchant has nothing to file against"
    assert _create(h, admin, on_behalf_of_merchant_id=901).status_code == 422, "received_date_time is required"
    future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).isoformat()
    assert _create(h, admin, on_behalf_of_merchant_id=901, received_date_time=future).status_code == 422
    assert _manual(h, admin, merchant_id=424242).status_code == 404
    assert _create(h, merchant, on_behalf_of_merchant_id=902, received_date_time=RECEIVED).status_code == 403, \
        "a merchant can never file against another merchant"
    db = h.db()
    assert db.scalars(select(ServiceRequest)).all() == []
    db.close()


@pytest.mark.parametrize("over", [
    {"destination": "DEL"}, {"travel_date": "2020-01-01"}, {"preferred_time": "25:00"},
    {"trip_type": "round_trip"}, {"passenger_count": 3, "adults": 2}, {"passenger_count": 0},
    {"infants": 2}, {"travel_class": None}, {"origin": ""},
], ids=["same-city", "past-date", "bad-time", "round-trip-no-return", "pax-mismatch", "zero-pax",
        "infants>adults", "no-class", "blank-origin"])
def test_enquiry_validation_rejects_bad_input_and_stores_nothing(h, merchant, over):
    assert _create(h, merchant, **over).status_code == 422
    db = h.db()
    assert db.scalars(select(ServiceRequest)).all() == []
    db.close()
    assert _logs(h, "Ticket enquiry raised") == []


def test_a_merchant_without_flights_access_cannot_raise_one(h, merchant):
    db = h.db()
    from app.models_v2 import MerchantServiceAccess
    for row in db.scalars(select(MerchantServiceAccess).where(MerchantServiceAccess.merchant_id == 901)).all():
        row.enabled = False
    db.commit()
    db.close()
    assert _create(h, merchant).status_code == 403


# ----------------------------------------------------------- listing / detail
def test_listing_and_detail_are_scoped_by_merchant(h, admin, merchant):
    mine = _create(h, merchant).json()["id"]
    theirs = _manual(h, admin, merchant_id=902).json()["id"]
    other_merchant = h.user(UserRole.MERCHANT_ADMIN, merchant_id=902, name="Other")
    ids = lambda who, **p: [i["id"] for i in h.client.get("/api/enquiries", params=p, headers=who["headers"]).json()["items"]]
    assert set(ids(admin)) == {mine, theirs}
    assert ids(merchant) == [mine] and ids(other_merchant) == [theirs]
    assert ids(admin, merchant_id=902) == [theirs]
    assert ids(admin, source="b2b_manual_enquiry") == [theirs]
    assert ids(admin, status="pending_approval") and ids(admin, status="rejected") == []
    assert h.client.get(f"/api/enquiries/{mine}", headers=admin["headers"]).status_code == 200
    assert h.client.get(f"/api/enquiries/{mine}", headers=other_merchant["headers"]).status_code == 404
    assert h.client.get("/api/enquiries/99999999", headers=admin["headers"]).status_code == 404
    assert h.client.get("/api/enquiries", params={"page_size": 101}, headers=admin["headers"]).status_code == 422


# ----------------------------------------------------------- admin workflow
def test_review_claims_the_enquiry_once(h, admin, merchant):
    eid = _create(h, merchant).json()["id"]
    assert _review(h, admin, eid).status_code == 200 and _row(h, eid).status is S.IN_REVIEW
    assert _review(h, admin, eid).status_code == 200, "re-claiming your own is a no-op"
    other = h.user(UserRole.ADMIN, name="Bo Other")
    assert _review(h, other, eid).status_code == 409
    assert _respond(h, other, eid, available=True, total_fare="500", reason="mine").status_code == 409
    assert _row(h, eid).status is S.IN_REVIEW
    assert len(_logs(h, "Ticket enquiry review started")) == 1


def test_quotation_is_binding_persisted_and_audited(h, admin, merchant):
    eid = _create(h, merchant).json()["id"]
    r = _respond(h, admin, eid, available=True, total_fare="12345.68", reason="Fare 10000 + baggage 2345.68")
    assert r.status_code == 200, r.text
    row = _row(h, eid)
    assert row.status is S.APPROVED and row.travel_details["quoted_fare"] == "12345.68"
    assert row.travel_details["quoted_by"] == admin["id"] and row.total_amount == D("0"), "an enquiry itself owes nothing"
    log = _logs(h, "Ticket enquiry quoted")
    assert len(log) == 1 and log[0].user_id == admin["id"]
    assert log[0].extra_data["from_status"] == "pending_approval" and log[0].extra_data["to_status"] == "approved"


@pytest.mark.parametrize("body", [
    {"available": True, "reason": "x"},                                   # no fare
    {"available": True, "total_fare": "0", "reason": "x"},                # zero fare
    {"available": True, "total_fare": "-5", "reason": "x"},               # negative
    {"available": True, "total_fare": "500"},                             # no remarks
    {"available": True, "total_fare": "500", "reason": "   "},
    {"available": False, "total_fare": "500", "reason": "x"},             # decline cannot carry a fare
    {"available": True, "total_fare": "1234567890123", "reason": "x"},    # too many digits
    {"available": True, "total_fare": "12.345", "reason": "x"},          # more than 2 decimal places
    {},
], ids=["no-fare", "zero-fare", "negative", "no-remarks", "blank-remarks", "decline-with-fare", "huge", "3dp", "empty"])
def test_invalid_responses_are_rejected_and_leave_the_enquiry_pending(h, admin, merchant, body):
    eid = _create(h, merchant).json()["id"]
    assert _respond(h, admin, eid, **body).status_code == 422
    assert _row(h, eid).status is S.PENDING_APPROVAL and _logs(h, "Ticket enquiry quoted") == []


def test_decline_needs_a_reason_and_is_final(h, admin, merchant):
    eid = _create(h, merchant).json()["id"]
    assert _respond(h, admin, eid, available=False).status_code in (400, 422)
    assert _row(h, eid).status is S.PENDING_APPROVAL
    r = _respond(h, admin, eid, available=False, reason="Sector not operated that day")
    assert r.status_code == 200 and _row(h, eid).status is S.REJECTED
    assert len(_logs(h, "Ticket enquiry declined")) == 1
    for body in ({"available": True, "total_fare": "100", "reason": "late"}, {"available": False, "reason": "again"}):
        assert _respond(h, admin, eid, **body).status_code == 409
    assert _review(h, admin, eid).status_code == 409


def test_a_quoted_enquiry_cannot_be_answered_again(h, admin, merchant):
    eid = _create(h, merchant).json()["id"]
    assert _respond(h, admin, eid, available=True, total_fare="900", reason="ok").status_code == 200
    again = _respond(h, admin, eid, available=True, total_fare="100", reason="cheaper now")
    assert again.status_code == 409
    assert _row(h, eid).travel_details["quoted_fare"] == "900.00", "the binding quotation must not be repriced"
    assert _respond(h, admin, eid, available=False, reason="changed mind").status_code == 409


def test_unknown_enquiry_is_404_for_admin_actions(h, admin):
    assert _review(h, admin, 99999999).status_code == 404
    assert _respond(h, admin, 99999999, available=False, reason="x").status_code == 404


# -------------------------------------------------------------- permissions
def test_permission_matrix(h, admin, merchant):
    eid = _create(h, merchant).json()["id"]
    assert h.client.post("/api/enquiries", json=_payload()).status_code == 401
    assert h.client.get("/api/enquiries").status_code == 401
    assert h.client.post(f"/api/admin/enquiries/{eid}/review").status_code == 401
    assert h.client.post(f"/api/admin/enquiries/{eid}/respond", json={"available": False, "reason": "x"}).status_code == 401
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    for who in (merchant, mgr):
        assert _review(h, who, eid).status_code == 403
        assert _respond(h, who, eid, available=False, reason="x").status_code == 403
    # an approve-only reviewer may quote but not decline; a reject-only reviewer may decline but not quote
    approver = h.user(UserRole.MANAGER, permissions=["ticket.approve", "ticket.view"], name="Approver")
    rejecter = h.user(UserRole.MANAGER, permissions=["ticket.reject", "ticket.view"], name="Rejecter")
    assert _respond(h, approver, eid, available=False, reason="x").status_code == 403
    assert _respond(h, rejecter, eid, available=True, total_fare="100", reason="x").status_code == 403
    assert _row(h, eid).status is S.PENDING_APPROVAL
    assert [l for l in _logs(h) if l.action.startswith("Ticket enquiry") and l.action != "Ticket enquiry raised"] == []
    assert _respond(h, rejecter, eid, available=False, reason="Not operated").status_code == 200
