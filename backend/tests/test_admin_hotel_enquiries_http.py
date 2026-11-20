"""HTTP-level verification of HOTEL ENQUIRIES: merchant creation (Hotels service access, rooms/guests
rules), listing scope, and the Admin review -> quotation / decline workflow
(``/api/admin/hotel-enquiries/{id}/review|respond``). Real routers/services/RBAC on throw-away SQLite data;
notifications mocked; nobody is contacted. Enquiry -> hotel booking conversion is NOT covered here.
"""
from __future__ import annotations

import datetime as dt
import decimal
import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import (
    HotelEnquiry, Merchant, MerchantServiceAccess, MerchantStatus, RequestStatus, SystemLog, UserRole,
)
from app.routers import hotel_enquiries as hotel_router
from app.services import delivery_service, notification_service, service_access_service, ticket_service
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus
IN = (dt.date.today() + dt.timedelta(days=30)).isoformat()
OUT = (dt.date.today() + dt.timedelta(days=33)).isoformat()


@pytest.fixture()
def h(monkeypatch):
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant"):
        monkeypatch.setattr(notification_service, name, lambda *a, **k: 0)
    monkeypatch.setattr(ticket_service, "_notify_merchant", lambda *a, **k: None)

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(hotel_router.router, hotel_router.admin_router)
    db = harness.db()
    for mid in (1201, 1202):
        m = Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                     email=f"m{mid}@tt-qa.com", reference_prefix=f"H{mid}", status=MerchantStatus.ACTIVE)
        db.add(m)
        db.flush()
        service_access_service.ensure_defaults(db, m, overrides={"hotels": True})
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def merchant(h):
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=1201, name="Mer Admin")


def _body(**over):
    b = {"destination_city": "Goa", "check_in": IN, "check_out": OUT, "rooms": [{"adults": 2, "children": 0}],
         "star_category": "4", "meal_plan": "breakfast"}
    b.update(over)
    return b


def _create(h, who, **over):
    return h.client.post("/api/hotel/enquiries", json=_body(**over), headers=who["headers"])


def _row(h, eid):
    db = h.db()
    r = db.get(HotelEnquiry, eid)
    db.close()
    return r


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _respond(h, who, eid, **body):
    return h.client.post(f"/api/admin/hotel-enquiries/{eid}/respond", json=body, headers=who["headers"])


def _review(h, who, eid):
    return h.client.post(f"/api/admin/hotel-enquiries/{eid}/review", headers=who["headers"])


def test_merchant_creates_a_hotel_enquiry_with_rooms_and_nights(h, merchant):
    r = _create(h, merchant, rooms=[{"adults": 2, "children": 1, "child_ages": [7]}, {"adults": 1}])
    assert r.status_code == 201, r.text
    row = _row(h, r.json()["id"])
    assert row.merchant_id == 1201 and row.status is S.PENDING_APPROVAL and row.number_of_nights == 3
    assert row.enquiry_reference.startswith("HTL-")
    db = h.db()
    from app.models_v2 import HotelEnquiryRoom
    assert len(db.scalars(select(HotelEnquiryRoom).where(HotelEnquiryRoom.hotel_enquiry_id == row.id)).all()) == 2
    db.close()
    assert _logs(h) , "an audit entry is written"


@pytest.mark.parametrize("over", [
    {"check_in": "2020-01-01", "check_out": "2020-01-03"}, {"check_out": IN}, {"rooms": []},
    {"rooms": [{"adults": 0}]}, {"rooms": [{"adults": 1, "children": 2, "child_ages": [4]}]},
    {"rooms": [{"adults": 1, "children": 1, "child_ages": [18]}]}, {"star_category": "2"}, {"meal_plan": "all"},
    {"pan": "bad"}, {"destination_city": ""},
], ids=["past", "same-day", "no-rooms", "zero-adults", "child-age-count", "child-age-range", "stars", "meal",
        "pan", "no-city"])
def test_hotel_enquiry_validation_stores_nothing(h, merchant, over):
    assert _create(h, merchant, **over).status_code == 422
    db = h.db()
    assert db.scalars(select(HotelEnquiry)).all() == []
    db.close()


def test_hotels_access_gate_and_role_rules(h, merchant, admin):
    db = h.db()
    for row in db.scalars(select(MerchantServiceAccess).where(MerchantServiceAccess.merchant_id == 1201)).all():
        row.enabled = False
    db.commit()
    db.close()
    assert _create(h, merchant).status_code == 403
    assert _create(h, admin).status_code == 403, "an admin cannot raise a merchant's enquiry here"
    assert h.client.post("/api/hotel/enquiries", json=_body()).status_code == 401


def test_listing_and_detail_are_scoped(h, merchant, admin):
    eid = _create(h, merchant).json()["id"]
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1202, name="Other")
    assert [i["id"] for i in h.client.get("/api/hotel/enquiries", headers=admin["headers"]).json()["items"]] == [eid]
    assert h.client.get("/api/hotel/enquiries", headers=other["headers"]).json()["items"] == []
    assert h.client.get(f"/api/hotel/enquiries/{eid}", headers=merchant["headers"]).status_code == 200
    assert h.client.get(f"/api/hotel/enquiries/{eid}", headers=other["headers"]).status_code == 404
    assert h.client.get("/api/hotel/enquiries/99999999", headers=admin["headers"]).status_code == 404


def test_review_claims_and_blocks_a_second_admin(h, merchant, admin):
    eid = _create(h, merchant).json()["id"]
    assert _review(h, admin, eid).status_code == 200 and _row(h, eid).status is S.IN_REVIEW
    assert _review(h, admin, eid).status_code == 200
    other = h.user(UserRole.ADMIN, name="Bo Other")
    assert _review(h, other, eid).status_code == 409
    assert _respond(h, other, eid, available=False, reason="mine").status_code == 409
    assert _row(h, eid).status is S.IN_REVIEW


def test_quotation_is_stored_audited_and_final(h, merchant, admin):
    eid = _create(h, merchant).json()["id"]
    r = _respond(h, admin, eid, available=True, total_fare="9800.00", reason="3 nights incl. breakfast")
    assert r.status_code == 200, r.text
    row = _row(h, eid)
    assert row.status is S.APPROVED
    assert any("quot" in (l.action or "").lower() and l.user_id == admin["id"] for l in _logs(h))
    for body in ({"available": True, "total_fare": "1.00", "reason": "x"}, {"available": False, "reason": "x"}):
        assert _respond(h, admin, eid, **body).status_code == 409
    assert _row(h, eid).status is S.APPROVED


@pytest.mark.parametrize("body", [
    {"available": True, "reason": "x"}, {"available": True, "total_fare": "0", "reason": "x"},
    {"available": True, "total_fare": "100"}, {"available": False, "total_fare": "100", "reason": "x"},
    {"available": True, "total_fare": "1.234", "reason": "x"}, {},
], ids=["no-fare", "zero", "no-remarks", "decline-with-fare", "3dp", "empty"])
def test_invalid_hotel_responses_are_rejected(h, merchant, admin, body):
    eid = _create(h, merchant).json()["id"]
    assert _respond(h, admin, eid, **body).status_code == 422
    assert _row(h, eid).status is S.PENDING_APPROVAL


def test_decline_needs_a_reason_and_permissions_hold(h, merchant, admin):
    """Regression for DEFECT-7: a hotel decline with no reason used to be accepted (200)."""
    eid = _create(h, merchant).json()["id"]
    assert _respond(h, admin, eid, available=False).status_code in (400, 422)
    assert _row(h, eid).status is S.PENDING_APPROVAL
    assert h.client.post(f"/api/admin/hotel-enquiries/{eid}/review").status_code == 401
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    approver = h.user(UserRole.MANAGER, permissions=["ticket.approve", "ticket.view"], name="Approver")
    for who in (merchant, mgr):
        assert _review(h, who, eid).status_code == 403
        assert _respond(h, who, eid, available=False, reason="x").status_code == 403
    assert _respond(h, approver, eid, available=False, reason="x").status_code == 403, "approve-only cannot decline"
    assert _row(h, eid).status is S.PENDING_APPROVAL
    assert _respond(h, admin, eid, available=False, reason="No rooms").status_code == 200
    assert _row(h, eid).status is S.REJECTED
    assert _respond(h, admin, 99999999, available=False, reason="x").status_code == 404
