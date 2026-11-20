"""HTTP-level verification of booking DOCUMENT upload / list / download / delete and their access rules
(``/api/requests/{id}/documents``, ``/api/documents/{id}/download``, ``DELETE /api/documents/{id}``).
Decision verification lives in ``test_admin_document_verification_http.py``.

Disposable files only: storage is a pytest ``tmp_path`` (``LocalStorage``) — the repository's ``uploads/``
directory is never touched, and the upload size cap is lowered to 1 MB for the oversize test. Real routers/
services/RBAC on throw-away SQLite rows. Business rules asserted are the code's own (merchant: draft only; staff:
``ticket``/``other`` once the booking is paid / manager-approved on the classic track; scope re-checked on every
read). The S3 backend is not exercised.
"""
from __future__ import annotations

import decimal
import smtplib

import pytest
from sqlalchemy import func, select

from app.config import settings
from app.models_v2 import (
    DocumentType, Merchant, MerchantStatus, PassengerData, RequestDocument, RequestSource, RequestStatus, RequestType,
    ServiceRequest, SystemLog, UserRole,
)
from app.routers import documents as documents_router
from app.services import delivery_service, notification_service, storage
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus
PDF = b"%PDF-1.4\n% disposable test file\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


@pytest.fixture()
def h(monkeypatch, tmp_path):
    root = tmp_path / "uploads"
    root.mkdir()
    monkeypatch.setattr(settings, "upload_root", str(root))
    monkeypatch.setattr(settings, "max_upload_mb", 1)
    monkeypatch.setattr(storage, "backend", storage.LocalStorage(root))
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant"):
        monkeypatch.setattr(notification_service, name, lambda *a, **k: 0)

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(documents_router.router)
    harness.root = root
    db = harness.db()
    for mid in (1301, 1302):
        db.add(Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                        email=f"m{mid}@tt-qa.com", reference_prefix=f"F{mid}", status=MerchantStatus.ACTIVE))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def owner(h):
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=1301, name="Owner Admin")


@pytest.fixture()
def stranger(h):
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=1302, name="Stranger")


def _booking(h, *, status=S.DRAFT, merchant_id=1301, classic=False):
    db = h.db()
    nid = (db.scalar(select(func.max(ServiceRequest.request_id))) or 13000) + 1
    db.add(ServiceRequest(request_id=nid, request_number=f"DOC-{nid}", merchant_id=merchant_id,
                          request_type=RequestType.BOOKING, source=RequestSource.MERCHANT_PORTAL, status=status,
                          title="Trip", travel_details={"direct_booking": True} if classic else {}, pricing={},
                          quantity=1, total_amount=D("500"), status_history=[]))
    db.commit()
    db.close()
    return nid


def _passenger(h, rid, merchant_id=1301):
    db = h.db()
    nid = (db.scalar(select(func.max(PassengerData.passenger_id))) or 0) + 1
    db.add(PassengerData(passenger_id=nid, request_id=rid, merchant_id=merchant_id, first_name="Asha", last_name="Rao"))
    db.commit()
    db.close()
    return nid


def _upload(h, who, rid, content=PDF, name="scan.pdf", ctype="application/pdf", doc_type="passport", **extra):
    return h.client.post(f"/api/requests/{rid}/documents", headers=who["headers"],
                         files={"file": (name, content, ctype)}, data={"doc_type": doc_type, **extra})


def _docs(h, rid=None):
    db = h.db()
    q = select(RequestDocument)
    if rid:
        q = q.where(RequestDocument.request_id == rid)
    rows = db.scalars(q).all()
    db.close()
    return rows


def _files(h):
    return sorted(p for p in h.root.rglob("*") if p.is_file())


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


# ================================================================== upload
def test_merchant_uploads_to_its_own_draft_and_the_bytes_are_stored(h, owner):
    rid = _booking(h)
    r = _upload(h, owner, rid)
    assert r.status_code == 201, r.text
    d = _docs(h, rid)[0]
    assert d.merchant_id == 1301 and d.doc_type is DocumentType.PASSPORT and d.content_type == "application/pdf"
    assert d.size_bytes == len(PDF) and d.checksum and d.uploaded_by == owner["id"]
    assert d.verification_status.value == "pending"
    files = _files(h)
    assert len(files) == 1 and files[0].read_bytes() == PDF and files[0].suffix == ".pdf"
    assert "stored_path" not in r.text, "the stored path is never exposed"
    log = _logs(h, "Booking document uploaded")
    assert len(log) == 1 and log[0].user_id == owner["id"]


@pytest.mark.parametrize("content,name,ctype,code", [
    (b"<html><script>alert(1)</script></html>", "x.png", "image/png", 400),     # HTML renamed to PNG
    (PDF, "x.jpg", "image/jpeg", 400),                                          # PDF bytes declared as JPEG
    (b"MZ\x90\x00", "x.exe", "application/octet-stream", 415),
    (PDF, "x.txt", "text/plain", 415),
    (b"", "empty.pdf", "application/pdf", 400),
], ids=["html-as-png", "pdf-as-jpeg", "exe", "text", "empty"])
def test_unsafe_or_invalid_files_are_refused_and_nothing_is_stored(h, owner, content, name, ctype, code):
    rid = _booking(h)
    r = _upload(h, owner, rid, content=content, name=name, ctype=ctype)
    assert r.status_code == code, r.text
    assert _docs(h) == [] and _files(h) == [] and _logs(h, "Booking document uploaded") == []


def test_oversize_files_are_refused_while_streaming(h, owner):
    rid = _booking(h)
    big = PDF + b"0" * (1024 * 1024)
    r = _upload(h, owner, rid, content=big)
    assert r.status_code == 413, r.text
    assert _docs(h) == [] and _files(h) == []


def test_filenames_are_reduced_to_a_safe_leaf_and_never_used_as_a_path(h, owner):
    rid = _booking(h)
    r = _upload(h, owner, rid, name='../../etc/passwd"\r\n.pdf')
    assert r.status_code == 201, r.text
    d = _docs(h, rid)[0]
    assert "/" not in d.original_filename and "\n" not in d.original_filename and '"' not in d.original_filename
    assert all(h.root in f.parents for f in _files(h)), "nothing may be written outside the storage root"


def test_unknown_doc_type_and_passenger_scoping(h, owner):
    rid = _booking(h)
    assert _upload(h, owner, rid, doc_type="selfie").status_code == 422
    mine = _passenger(h, rid)
    other_rid = _booking(h)
    theirs = _passenger(h, other_rid)
    assert _upload(h, owner, rid, passenger_id=str(theirs)).status_code == 400, "another booking's traveller"
    assert _upload(h, owner, rid, passenger_id="99999").status_code == 400
    ok = _upload(h, owner, rid, passenger_id=str(mine))
    assert ok.status_code == 201 and _docs(h, rid)[0].passenger_id == mine
    assert len(_docs(h)) == 1


def test_a_merchant_can_only_attach_while_the_booking_is_a_draft(h, owner):
    for st in (S.PENDING_APPROVAL, S.APPROVED, S.PAID, S.TICKET_ISSUED):
        rid = _booking(h, status=st)
        r = _upload(h, owner, rid, doc_type="ticket")
        assert r.status_code in (403, 409), (st, r.text)
    assert _docs(h) == [] and _files(h) == []


def test_staff_may_attach_ticket_paperwork_only_in_the_late_window(h, admin):
    paid = _booking(h, status=S.PAID)
    assert _upload(h, admin, paid, doc_type="ticket").status_code == 201
    assert _upload(h, admin, paid, doc_type="other", name="note.pdf").status_code == 201
    assert _upload(h, admin, paid, doc_type="passport").status_code in (403, 409), "staff cannot add a passport late"
    pending = _booking(h, status=S.PENDING_APPROVAL)
    assert _upload(h, admin, pending, doc_type="ticket").status_code in (403, 409)
    classic_approved = _booking(h, status=S.APPROVED, classic=True)
    assert _upload(h, admin, classic_approved, doc_type="ticket").status_code == 201, "classic track: Approved is the window"
    standard_approved = _booking(h, status=S.APPROVED)
    assert _upload(h, admin, standard_approved, doc_type="ticket").status_code in (403, 409)


def test_upload_scope_and_permissions(h, owner, stranger, admin):
    rid = _booking(h)
    assert h.client.post(f"/api/requests/{rid}/documents", files={"file": ("a.pdf", PDF, "application/pdf")}).status_code == 401
    assert _upload(h, stranger, rid).status_code == 404, "another company's booking must look absent"
    assert _upload(h, owner, 99999999).status_code == 404
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    assert _upload(h, mgr, rid).status_code == 403
    assert _docs(h) == [] and _files(h) == []


# ================================================================== list / download
def test_download_streams_the_exact_bytes_as_a_private_attachment(h, owner, admin):
    rid = _booking(h)
    did = _upload(h, owner, rid, content=PNG, name="id.png", ctype="image/png").json()["id"]
    for who in (owner, admin):
        r = h.client.get(f"/api/documents/{did}/download", headers=who["headers"])
        assert r.status_code == 200, r.text
        assert r.content == PNG and r.headers["content-type"].startswith("image/png")
        assert r.headers["content-disposition"].startswith("attachment;")
        assert r.headers["cache-control"] == "private, no-store" and int(r.headers["content-length"]) == len(PNG)


def test_downloads_and_listings_are_scoped_by_merchant(h, owner, stranger, admin):
    rid = _booking(h)
    did = _upload(h, owner, rid).json()["id"]
    assert h.client.get(f"/api/documents/{did}/download").status_code == 401
    assert h.client.get(f"/api/documents/{did}/download", headers=stranger["headers"]).status_code == 404
    assert h.client.get(f"/api/requests/{rid}/documents", headers=stranger["headers"]).status_code == 404
    assert [d["id"] for d in h.client.get(f"/api/requests/{rid}/documents", headers=owner["headers"]).json()] == [did]
    assert [d["id"] for d in h.client.get(f"/api/requests/{rid}/documents", headers=admin["headers"]).json()] == [did]
    assert h.client.get("/api/documents/99999999/download", headers=admin["headers"]).status_code == 404


def test_a_missing_file_and_a_tampered_path_never_leak_or_500(h, owner, admin):
    rid = _booking(h)
    did = _upload(h, owner, rid).json()["id"]
    _files(h)[0].unlink()
    r = h.client.get(f"/api/documents/{did}/download", headers=owner["headers"])
    assert r.status_code == 404 and "missing" in r.json()["detail"]
    db = h.db()
    db.get(RequestDocument, did).stored_path = "../../outside.pdf"
    db.commit()
    db.close()
    r = h.client.get(f"/api/documents/{did}/download", headers=admin["headers"])
    assert r.status_code == 400, "a tampered stored_path is refused, never opened"


# ================================================================== delete
def test_merchant_deletes_from_a_draft_removing_row_file_and_logging_it(h, owner):
    rid = _booking(h)
    did = _upload(h, owner, rid).json()["id"]
    assert len(_files(h)) == 1
    assert h.client.delete(f"/api/documents/{did}", headers=owner["headers"]).status_code == 204
    assert _docs(h) == [] and _files(h) == []
    log = _logs(h, "Booking document deleted")
    assert len(log) == 1 and log[0].user_id == owner["id"]
    assert h.client.delete(f"/api/documents/{did}", headers=owner["headers"]).status_code == 404, "no double delete"


def test_delete_rules_after_the_draft_stage(h, owner, admin):
    rid = _booking(h)
    passport = _upload(h, owner, rid, doc_type="passport").json()["id"]
    db = h.db()
    db.get(ServiceRequest, rid).status = S.PAID
    db.commit()
    db.close()
    for who in (owner, admin):
        assert h.client.delete(f"/api/documents/{passport}", headers=who["headers"]).status_code in (403, 409), who
    assert len(_docs(h, rid)) == 1 and len(_files(h)) == 1, "a merchant's passport is never removed from a booking in flight"
    ticket = _upload(h, admin, rid, doc_type="ticket", name="t.pdf").json()["id"]
    assert h.client.delete(f"/api/documents/{ticket}", headers=admin["headers"]).status_code == 204
    assert [d.document_id for d in _docs(h, rid)] == [passport] and len(_files(h)) == 1


def test_delete_scope_and_permissions(h, owner, stranger):
    rid = _booking(h)
    did = _upload(h, owner, rid).json()["id"]
    assert h.client.delete(f"/api/documents/{did}").status_code == 401
    assert h.client.delete(f"/api/documents/{did}", headers=stranger["headers"]).status_code == 404
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    assert h.client.delete(f"/api/documents/{did}", headers=mgr["headers"]).status_code == 403
    assert len(_docs(h, rid)) == 1 and len(_files(h)) == 1 and _logs(h, "Booking document deleted") == []
