"""HTTP-level verification of booking DOCUMENT verification by the Admin
(``POST /api/admin/documents/{id}/verify``). Only the verification decision is exercised — no file
is uploaded, downloaded or stored (the upload/download paths need file storage and are NOT TESTED here).

Rules asserted are the code's own: independent of the booking's lifecycle, a reason is mandatory on
rejection, actor-attributed audit, and ``document.verify`` (Admin) is required.
"""
from __future__ import annotations

import decimal
import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import (
    DocumentType, DocumentVerification, Merchant, MerchantStatus, RequestDocument, RequestSource, RequestStatus,
    RequestType, ServiceRequest, SystemLog, UserRole,
)
from app.routers import documents as documents_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

D = decimal.Decimal


@pytest.fixture()
def h(monkeypatch):
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant"):
        monkeypatch.setattr(notification_service, name, lambda *a, **k: 0)

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(documents_router.router)
    db = harness.db()
    db.add(Merchant(merchant_id=961, merchant_code="M961", merchant_name="M", company_name="M Co",
                    email="m961@tt-qa.com", reference_prefix="DV", status=MerchantStatus.ACTIVE))
    db.add(ServiceRequest(request_id=9601, request_number="BK-9601", merchant_id=961, request_type=RequestType.BOOKING,
                          source=RequestSource.MERCHANT_PORTAL, status=RequestStatus.PENDING_APPROVAL, title="Trip",
                          travel_details={}, pricing={}, quantity=1, total_amount=D("500"), status_history=[]))
    db.add(RequestDocument(document_id=9701, request_id=9601, merchant_id=961, doc_type=DocumentType.PASSPORT,
                           original_filename="passport.pdf", stored_path="/nonexistent/x", content_type="application/pdf",
                           size_bytes=10, verification_status=DocumentVerification.PENDING))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


def _doc(h):
    db = h.db()
    d = db.get(RequestDocument, 9701)
    db.close()
    return d


def _booking_status(h):
    db = h.db()
    s = db.get(ServiceRequest, 9601).status
    db.close()
    return s


def _verify(h, who, doc=9701, **body):
    return h.client.post(f"/api/admin/documents/{doc}/verify", json=body, headers=who["headers"])


def _logs(h):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return rows


def test_verify_persists_the_decision_actor_and_audit_without_touching_the_booking(h, admin):
    r = _verify(h, admin, approved=True)
    assert r.status_code == 200, r.text
    d = _doc(h)
    assert d.verification_status is DocumentVerification.VERIFIED
    assert d.verified_by == admin["id"] and d.verified_at is not None and d.rejection_reason is None
    assert _booking_status(h) is RequestStatus.PENDING_APPROVAL
    log = [l for l in _logs(h) if l.action == "Booking document verified"]
    assert len(log) == 1 and log[0].user_id == admin["id"]
    assert log[0].extra_data["from_status"] == "pending" and log[0].extra_data["to_status"] == "verified"


def test_reject_requires_a_real_reason_and_leaves_the_booking_alone(h, admin):
    for body in ({"approved": False}, {"approved": False, "reason": ""}, {"approved": False, "reason": "   "}):
        r = _verify(h, admin, **body)
        assert r.status_code in (400, 422), (body, r.text)
    assert _doc(h).verification_status is DocumentVerification.PENDING
    assert [l for l in _logs(h) if "document" in l.action] == []
    r = _verify(h, admin, approved=False, reason="Photo is unreadable")
    assert r.status_code == 200, r.text
    d = _doc(h)
    assert d.verification_status is DocumentVerification.REJECTED and d.rejection_reason == "Photo is unreadable"
    assert _booking_status(h) is RequestStatus.PENDING_APPROVAL, "rejecting a document does not reject the booking"
    assert len([l for l in _logs(h) if l.action == "Booking document rejected"]) == 1


def test_a_decision_can_be_revised_and_clears_the_old_reason(h, admin):
    """Observation (not a defect): the code allows changing a decision, e.g. rejected -> verified."""
    assert _verify(h, admin, approved=False, reason="blurry").status_code == 200
    assert _verify(h, admin, approved=True).status_code == 200
    d = _doc(h)
    assert d.verification_status is DocumentVerification.VERIFIED and d.rejection_reason is None


def test_missing_document_and_bad_bodies(h, admin):
    assert _verify(h, admin, doc=99999999, approved=True).status_code == 404
    assert h.client.post("/api/admin/documents/9701/verify", json={}, headers=admin["headers"]).status_code == 422
    assert _verify(h, admin, approved="maybe").status_code == 422
    assert _doc(h).verification_status is DocumentVerification.PENDING


def test_permissions(h, admin):
    assert h.client.post("/api/admin/documents/9701/verify", json={"approved": True}).status_code == 401
    manager = h.user(UserRole.MANAGER, name="Mo Manager")
    merchant = h.user(UserRole.MERCHANT_ADMIN, merchant_id=961, name="Mer Admin")
    for who in (manager, merchant):
        assert _verify(h, who, approved=True).status_code == 403
    assert _doc(h).verification_status is DocumentVerification.PENDING
    assert [l for l in _logs(h) if "document" in l.action] == []
