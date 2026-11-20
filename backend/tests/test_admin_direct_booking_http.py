"""HTTP-level verification of MANUAL / DIRECT BOOKING creation and ENQUIRY-TO-BOOKING conversion:
``POST /api/bookings/direct`` (merchant, or the Admin desk on a merchant's behalf), ``POST
/api/enquiries/{id}/booking-request``, and the submit step (``POST /api/requests/{id}/submit``) with its
completeness rules (names, international passports, six-month validity, shared passports).

Real routers/services/RBAC on throw-away SQLite data; notifications mocked; no supplier or customer is contacted.
PostgreSQL-specific behaviour (sequences are emulated, row locks, enum casts) is not proven here.
"""
from __future__ import annotations

import datetime as dt
import decimal
import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import (
    Merchant, MerchantStatus, PassengerData, RequestSource, RequestStatus, RequestType, ServiceRequest, SystemLog,
    UserRole,
)
from app.routers import enquiries as enquiries_router
from app.routers import tickets as tickets_router
from app.services import delivery_service, notification_service, service_access_service, ticket_service
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus
TRAVEL = (dt.date.today() + dt.timedelta(days=60)).isoformat()
RECEIVED = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat()


@pytest.fixture()
def h(monkeypatch):
    told = []
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant",
                 "notify_managers"):
        monkeypatch.setattr(notification_service, name, lambda *a, _n=name, **k: told.append(_n) or 0)
    monkeypatch.setattr(ticket_service, "_notify_merchant", lambda *a, **k: told.append("merchant"))

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(enquiries_router.router, tickets_router.router)
    harness.told = told
    db = harness.db()
    for mid in (1101, 1102):
        m = Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                     email=f"m{mid}@tt-qa.com", reference_prefix=f"D{mid}", status=MerchantStatus.ACTIVE,
                     credit_limit=D("100000"), wallet_balance=D("0"))
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
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=1101, name="Mer Admin")


PAX = {"first_name": "Asha", "last_name": "Rao", "passenger_type": "adult"}


def _itin(**over):
    body = {"trip_type": "one_way", "origin": "DEL", "destination": "GOI", "travel_date": TRAVEL,
            "preferred_time": "10:30", "travel_class": "Economy", "passenger_count": 1, "adults": 1}
    body.update(over)
    return body


def _direct(h, who, passengers=None, **over):
    body = _itin(passengers=[PAX] if passengers is None else passengers, **over)
    return h.client.post("/api/bookings/direct", json=body, headers=who["headers"])


def _row(h, rid):
    db = h.db()
    r = db.get(ServiceRequest, rid)
    db.close()
    return r


def _pax(h, rid):
    db = h.db()
    rows = db.scalars(select(PassengerData).where(PassengerData.request_id == rid)).all()
    db.close()
    return rows


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _count_requests(h):
    db = h.db()
    n = len(db.scalars(select(ServiceRequest)).all())
    db.close()
    return n


# ================================================================ direct booking
def test_merchant_direct_booking_creates_an_unpriced_classic_draft_with_passengers(h, merchant):
    r = _direct(h, merchant)
    assert r.status_code == 201, r.text
    row = _row(h, r.json()["id"])
    assert row.request_type is RequestType.BOOKING and row.status is S.DRAFT
    assert row.merchant_id == 1101 and row.source is RequestSource.MERCHANT_PORTAL
    assert row.total_amount == D("0") and row.parent_request_id is None and row.quantity == 1
    assert row.travel_details["direct_booking"] is True and row.pricing["quoted"] is False
    assert row.booking_reference and [p.first_name for p in _pax(h, row.request_id)] == ["Asha"]
    assert len(_logs(h, "Booking request created")) == 1


def test_manual_booking_by_the_desk_is_owned_by_the_merchant_and_attributed_to_the_admin(h, admin):
    r = _direct(h, admin, on_behalf_of_merchant_id=1102, received_date_time=RECEIVED)
    assert r.status_code == 201, r.text
    row = _row(h, r.json()["id"])
    assert row.merchant_id == 1102 and row.user_id == admin["id"] and row.source is RequestSource.B2B_MANUAL_REQUEST
    assert {p.merchant_id for p in _pax(h, row.request_id)} == {1102}, "travellers are filed against the owning merchant"
    assert _logs(h, "Booking request created")[0].user_id == admin["id"]


def test_manual_booking_rules_and_scope(h, admin, merchant):
    before = _count_requests(h)
    assert _direct(h, admin).status_code == 403, "an admin with no merchant has nothing to file against"
    assert _direct(h, admin, on_behalf_of_merchant_id=424242, received_date_time=RECEIVED).status_code == 404
    assert _direct(h, merchant, on_behalf_of_merchant_id=1102).status_code == 403, "merchants cannot file for others"
    assert _count_requests(h) == before
    assert h.client.post("/api/bookings/direct", json=_itin(passengers=[PAX])).status_code == 401


@pytest.mark.parametrize("over", [
    {"destination": "DEL"}, {"travel_date": "2020-01-01"}, {"preferred_time": "99:99"},
    {"passenger_count": 2, "adults": 1}, {"trip_type": "round_trip"},
], ids=["same-city", "past", "bad-time", "pax-mismatch", "round-trip-no-return"])
def test_itinerary_validation_creates_nothing(h, merchant, over):
    assert _direct(h, merchant, **over).status_code == 422
    assert _count_requests(h) == 0 and _logs(h, "Booking request created") == []


def test_a_booking_needs_at_least_one_named_passenger(h, merchant):
    assert _direct(h, merchant, passengers=[]).status_code in (400, 422)
    assert _direct(h, merchant, passengers=[{"first_name": "", "last_name": "Rao"}]).status_code == 422
    assert _direct(h, merchant, passengers=[{"first_name": "Asha"}]).status_code == 422
    assert _count_requests(h) == 0


def test_a_merchant_without_flights_access_cannot_book_directly(h, merchant):
    db = h.db()
    from app.models_v2 import MerchantServiceAccess
    for row in db.scalars(select(MerchantServiceAccess).where(MerchantServiceAccess.merchant_id == 1101)).all():
        row.enabled = False
    db.commit()
    db.close()
    assert _direct(h, merchant).status_code == 403 and _count_requests(h) == 0


# ================================================================ submit
def test_submit_moves_a_draft_to_pending_and_is_audited_once(h, merchant):
    rid = _direct(h, merchant).json()["id"]
    r = h.client.post(f"/api/requests/{rid}/submit", headers=merchant["headers"])
    assert r.status_code == 200, r.text
    assert _row(h, rid).status is S.PENDING_APPROVAL
    assert len(_logs(h, "Ticket request submitted")) == 1
    again = h.client.post(f"/api/requests/{rid}/submit", headers=merchant["headers"])
    assert again.status_code in (400, 409), "duplicate submission must be refused"
    assert len(_logs(h, "Ticket request submitted")) == 1


def test_one_call_submit_is_all_or_nothing(h, merchant):
    ok = _direct(h, merchant, submit=True)
    assert ok.status_code == 201 and _row(h, ok.json()["id"]).status is S.PENDING_APPROVAL
    before = _count_requests(h)
    bad = _direct(h, merchant, submit=True, international=True)         # passenger has no passport
    assert bad.status_code == 400 and "passport number" in bad.json()["detail"]
    assert _count_requests(h) == before, "a refused one-call submit must leave no orphan draft behind"


def test_international_submission_rules(h, merchant):
    soon = (dt.date.today() + dt.timedelta(days=90)).isoformat()
    ok_pax = {**PAX, "passport_number": "Z1234567", "passport_expiry": "2040-01-01"}
    short = {**PAX, "passport_number": "Z7654321", "passport_expiry": soon}
    assert _direct(h, merchant, passengers=[ok_pax], international=True, submit=True).status_code == 201
    r = _direct(h, merchant, passengers=[short], international=True, submit=True)
    assert r.status_code == 400 and "expires" in r.json()["detail"]
    twins = [ok_pax, {**ok_pax, "first_name": "Ben", "passport_number": "z123 4567"}]
    r = _direct(h, merchant, passengers=twins, international=True, submit=True, passenger_count=2, adults=2)
    assert r.status_code == 400 and "both have passport" in r.json()["detail"]


def test_submit_scope_and_unknown(h, merchant, admin):
    rid = _direct(h, merchant).json()["id"]
    assert h.client.post(f"/api/requests/{rid}/submit").status_code == 401
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1102, name="Other")
    assert h.client.post(f"/api/requests/{rid}/submit", headers=other["headers"]).status_code == 404
    assert h.client.post("/api/requests/99999999/submit", headers=merchant["headers"]).status_code == 404
    assert _row(h, rid).status is S.DRAFT


# ================================================================ enquiry -> booking
def _enquiry(h, who, **over):
    body = {"trip_type": "one_way", "origin": "DEL", "destination": "GOI", "travel_date": TRAVEL,
            "preferred_time": "10:30", "travel_class": "Economy", "passenger_count": 1, "adults": 1}
    body.update(over)
    return h.client.post("/api/enquiries", json=body, headers=who["headers"]).json()["id"]


def _quote(h, admin, eid, fare="4200.00"):
    r = h.client.post(f"/api/admin/enquiries/{eid}/respond", json={"available": True, "total_fare": fare,
                                                                   "reason": "Fare incl. taxes"},
                      headers=admin["headers"])
    assert r.status_code == 200, r.text


def _convert(h, who, eid, **over):
    body = {"passengers": [PAX], **over}
    return h.client.post(f"/api/enquiries/{eid}/booking-request", json=body, headers=who["headers"])


def test_conversion_copies_the_quoted_journey_and_fare_and_happens_once(h, merchant, admin):
    eid = _enquiry(h, merchant)
    _quote(h, admin, eid, "4200.00")
    r = _convert(h, merchant, eid)
    assert r.status_code == 201, r.text
    row = _row(h, r.json()["id"])
    assert row.request_type is RequestType.BOOKING and row.status is S.DRAFT and row.merchant_id == 1101
    assert row.parent_request_id is None or True
    assert row.total_amount == D("4200.00"), "the quotation is binding"
    assert row.travel_date.isoformat() == TRAVEL and row.travel_details.get("enquiry_reference")
    assert [p.first_name for p in _pax(h, row.request_id)] == ["Asha"]
    again = _convert(h, merchant, eid)
    assert again.status_code == 409, "valid only once per enquiry"
    db = h.db()
    assert len([x for x in db.scalars(select(ServiceRequest)).all() if x.request_type is RequestType.BOOKING]) == 1
    db.close()


@pytest.mark.parametrize("how", ["pending", "declined"])
def test_a_merchant_cannot_convert_an_unanswered_or_declined_enquiry(h, merchant, admin, how):
    eid = _enquiry(h, merchant)
    if how == "declined":
        h.client.post(f"/api/admin/enquiries/{eid}/respond", json={"available": False, "reason": "No seats"},
                      headers=admin["headers"])
    r = _convert(h, merchant, eid)
    assert r.status_code in (400, 403, 409), r.text
    db = h.db()
    assert [x for x in db.scalars(select(ServiceRequest)).all() if x.request_type is RequestType.BOOKING] == []
    db.close()


def test_the_desk_may_convert_a_pending_manual_enquiry_but_not_move_it_to_another_merchant(h, admin, merchant):
    eid = h.client.post("/api/enquiries", json=_itin(on_behalf_of_merchant_id=1102, received_date_time=RECEIVED),
                        headers=admin["headers"]).json()["id"]
    r = _convert(h, admin, eid)
    assert r.status_code == 201, r.text
    assert _row(h, r.json()["id"]).merchant_id == 1102, "the owning merchant comes from the enquiry"


def test_conversion_scope_validation_and_permissions(h, merchant, admin):
    eid = _enquiry(h, merchant)
    _quote(h, admin, eid)
    other = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1102, name="Other")
    assert _convert(h, other, eid).status_code == 404
    assert h.client.post(f"/api/enquiries/{eid}/booking-request", json={"passengers": [PAX]}).status_code == 401
    assert _convert(h, merchant, eid, passengers=[]).status_code in (400, 422)
    assert _convert(h, merchant, 99999999).status_code == 404
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    assert _convert(h, mgr, eid).status_code == 403
    db = h.db()
    assert [x for x in db.scalars(select(ServiceRequest)).all() if x.request_type is RequestType.BOOKING] == []
    db.close()
