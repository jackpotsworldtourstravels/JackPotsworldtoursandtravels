"""Supporting documents on a booking request — passports, visas, IDs.

THE THREAT MODEL, BECAUSE IT SHAPES EVERYTHING BELOW
These files are passport and visa scans. Three rules follow from that and none
of them are negotiable:

1. **No static mount, and no public bucket.** Files are stored under generated
   names and returned only by :func:`open_for_download`, which re-checks
   merchant scope on every read. Serving ``uploads/`` with ``StaticFiles`` — or
   pointing a browser at a readable S3 bucket — would make every scan readable
   by URL, across merchants, with no authentication: the single worst thing
   this module could do. For the same reason the S3 backend proxies downloads
   rather than handing out presigned URLs.
2. **Never trust the client's filename or content type.** The browser-supplied
   name is stored for display only and never used to build a path; the declared
   MIME type is checked against the *bytes* (:func:`_sniff`) before anything is
   written.
3. **Merchant isolation is enforced in the query**, not after it — the same
   ``scoped_query`` every other request-shaped read uses, so a merchant cannot
   reach another company's document even by guessing an id.

WHERE THE BYTES GO
Under the key ``requests/<request_id>/<uuid4><ext>``, in whichever backend
:mod:`app.services.storage` is configured for — a directory on disk in
development, an S3 bucket in a deployment where the server is disposable. The
uuid means an uploaded name can never traverse ("../../etc/passwd") or collide,
and the per-request prefix keeps a merchant's files together for retention work.
The storage layer re-validates every key it is given, so even a corrupted
``stored_path`` in the database cannot be turned into an arbitrary read or
unlink; :func:`_storage_key` is where that refusal becomes an HTTP error.
"""
import datetime
import hashlib
import tempfile
import uuid
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from fastapi import HTTPException, UploadFile, status as http_status
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models_v2 import (
    DocumentType,
    DocumentVerification as V,
    RequestDocument,
    RequestStatus as S,
    ServiceRequest,
    User,
)
from app.services import activity_service, lifecycle, storage, ticket_service

# ---------------------------------------------------------------------------
# What may be uploaded
# ---------------------------------------------------------------------------
#: Declared type -> the byte signatures that type must actually start with.
#: A ``.pdf`` renamed to ``.jpg`` fails here, and so does an HTML page renamed
#: to anything — which is what stops a stored-XSS payload from being served
#: back through the download endpoint.
_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    "application/pdf": (b"%PDF-",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),          # plus the WEBP tag checked below
}
_EXTENSIONS = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
ALLOWED_CONTENT_TYPES = tuple(_SIGNATURES)

#: Read in chunks so a large upload never lands in memory all at once.
_CHUNK = 64 * 1024

# ---------------------------------------------------------------------------
# Who may attach what, and when
# ---------------------------------------------------------------------------
# A merchant's documents are part of what it is *submitting*, so they stay
# draft-only — that rule is what makes a submitted request a fixed thing.
#
# Staff are the opposite case: the airline's e-ticket only exists *after* the
# money has moved, so the desk has to be able to attach it to a booking that is
# long past draft. Without this, the platform could take a payment and then have
# nowhere to put the ticket it just bought — the merchant's whole reason for
# being here.
#: Document types platform staff may attach after the draft stage.
STAFF_LATE_TYPES: frozenset[DocumentType] = frozenset(
    {DocumentType.TICKET, DocumentType.OTHER}
)
#: Stages at which that is allowed. PAID is included deliberately: the desk
#: books with the airline once payment clears, so the e-ticket arrives before
#: anyone presses "Ticket Issued".
STAFF_LATE_STAGES: frozenset[S] = frozenset({S.PAID, S.TICKET_ISSUED, S.COMPLETED})

#: The same window on the Classic Tours track (CR-2), which has no Paid stage
#: at all. There, Manager Approved is the moment the booking reaches the desk
#: and the operator goes off to book it on the airline's own site; the issued
#: tickets come back and have to attach *before* anyone presses "Ticket
#: Issued", because on this track that button is the last step, not the middle
#: one. Reusing STAFF_LATE_STAGES unchanged would have left the operator with a
#: booking to work and nowhere to put the tickets it bought.
CLASSIC_STAFF_LATE_STAGES: frozenset[S] = frozenset(
    {S.APPROVED, S.TICKET_ISSUED, S.COMPLETED}
)


def staff_upload_stages(request: ServiceRequest) -> frozenset[S]:
    """When platform staff may attach ticket paperwork to this booking."""
    if lifecycle.is_classic_track(request):
        return CLASSIC_STAFF_LATE_STAGES
    return STAFF_LATE_STAGES


def _assert_may_modify(request: ServiceRequest, actor: User, doc_type: DocumentType | None) -> None:
    """Gate every write to a request's documents.

    One function rather than a check per call site, so the merchant rule and
    the staff exception can never drift apart between upload and delete.
    """
    if request.status is S.DRAFT:
        return
    if (
        actor.is_platform_staff
        and request.status in staff_upload_stages(request)
        and (doc_type is None or doc_type in STAFF_LATE_TYPES)
    ):
        return

    if actor.is_platform_staff:
        allowed = ", ".join(sorted(t.value for t in STAFF_LATE_TYPES))
        when = (
            "once a booking is approved by a manager"
            if lifecycle.is_classic_track(request)
            else "only once a booking is paid"
        )
        detail = (
            f"{request.request_number} is at '{request.status.value}'. Staff may attach "
            f"{allowed} documents {when}."
        )
    else:
        detail = (
            f"{request.request_number} is no longer a draft, so its documents cannot be "
            "changed. Contact our team if something needs to be added."
        )
    raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=detail)


def _sniff(head: bytes, declared: str) -> bool:
    """Do the first bytes match the declared type?"""
    sigs = _SIGNATURES.get(declared)
    if not sigs:
        return False
    if not any(head.startswith(s) for s in sigs):
        return False
    # RIFF alone is also AVI/WAV; the WEBP tag sits at offset 8.
    if declared == "image/webp" and head[8:12] != b"WEBP":
        return False
    return True


def _safe_display_name(raw: str | None) -> str:
    """Reduce a client-supplied filename to something safe to echo back.

    The name is never used to build a path — that comes from a uuid — but it is
    returned in JSON and in the download's ``Content-Disposition``. Left raw, a
    name like ``../../../etc/passwd.png`` travels into whatever a browser or a
    downstream script does with the suggested save-name, and control characters
    can forge extra header lines. Keep the leaf, drop the rest.
    """
    leaf = PurePosixPath((raw or "document").replace("\\", "/")).name
    cleaned = "".join(c for c in leaf if c.isprintable() and c not in '"\r\n').strip()
    # Strip leading dots so nothing becomes a hidden file or bare "..".
    cleaned = cleaned.lstrip(". ")
    return (cleaned or "document")[:255]


def discard_file(stored_path: str) -> None:
    """Delete the bytes for a document row that has already gone.

    Needed because ``request_documents.passenger_id`` cascades: removing a
    traveller takes their document rows with it inside the database, and
    nothing would otherwise clean up the files. The key is still validated, so
    a tampered ``stored_path`` cannot be turned into an arbitrary delete.
    """
    storage.backend.delete(_storage_key(stored_path))


def _storage_key(stored_path: str) -> str:
    """Check a stored path before it reaches the storage backend.

    The backend refuses a malformed key on its own; this exists to turn that
    refusal into the 400 the API has always returned, rather than letting a
    ``ValueError`` become a 500. Only reachable if a ``stored_path`` were
    tampered with directly in the database — still refused rather than trusted.
    """
    try:
        return storage.validate_key(stored_path)
    except storage.InvalidDocumentKey:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Invalid document path"
        ) from None


# ---------------------------------------------------------------------------
# Scoping
# ---------------------------------------------------------------------------
def _request_for(db: Session, actor: User, request_id: int, *, lock: bool = False) -> ServiceRequest:
    """The request this actor may touch, optionally locked for mutation."""
    stmt = select(ServiceRequest).where(
        and_(ServiceRequest.request_id == request_id, ticket_service.scoped_query(actor))
    )
    if lock:
        stmt = stmt.with_for_update()
    request = db.scalars(stmt).first()
    if not request:
        # 404 rather than 403 — never confirm another merchant's request exists.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Request not found"
        )
    return request


def get_document(db: Session, actor: User, document_id: int) -> RequestDocument:
    """A document this actor may see. Platform staff see all; a merchant only
    its own, enforced by joining the request's own scoping rule."""
    doc = db.scalars(
        select(RequestDocument)
        .join(ServiceRequest, RequestDocument.request_id == ServiceRequest.request_id)
        .where(and_(RequestDocument.document_id == document_id, ticket_service.scoped_query(actor)))
    ).first()
    if not doc:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Document not found"
        )
    return doc


def list_documents(db: Session, actor: User, request_id: int) -> list[RequestDocument]:
    _request_for(db, actor, request_id)
    return list(
        db.scalars(
            select(RequestDocument)
            .where(RequestDocument.request_id == request_id)
            .order_by(RequestDocument.created_at)
        ).all()
    )


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------
def upload(
    db: Session,
    actor: User,
    request_id: int,
    upload_file: UploadFile,
    *,
    doc_type: DocumentType,
    passenger_id: int | None = None,
) -> RequestDocument:
    """Attach a file to a draft booking request.

    Locked because the draft-status check and the insert must agree: without
    it, a submit committing between the two would let a document land on a
    request that is already with the approvals desk.
    """
    request = _request_for(db, actor, request_id, lock=True)
    _assert_may_modify(request, actor, doc_type)

    if passenger_id is not None:
        if not any(p.passenger_id == passenger_id for p in request.passengers):
            # Checked against *this* request's passengers, so a valid id from
            # another booking cannot be attached here.
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="That passenger is not on this booking request",
            )

    declared = (upload_file.content_type or "").split(";")[0].strip().lower()
    if declared not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                f"'{declared or 'unknown'}' files are not accepted. Upload a PDF, "
                "JPEG, PNG or WebP."
            ),
        )

    head = upload_file.file.read(16)
    upload_file.file.seek(0)
    if not _sniff(head, declared):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"This file is not a valid {declared}. Its contents do not match "
                "its type — re-export it and try again."
            ),
        )

    stored_name = f"{uuid.uuid4().hex}{_EXTENSIONS[declared]}"
    relative = f"requests/{request.request_id}/{stored_name}"

    # Stream to a scratch file first, then hand the finished file to the
    # backend. The cap and the checksum therefore run in exactly one place for
    # both backends, and a rejected upload never reaches storage at all — which
    # matters more for S3 than for a disk, where a partial object would have to
    # be deleted over the network and would linger if that call failed too.
    digest = hashlib.sha256()
    size = 0
    scratch_dir = settings.upload_root_path / "incoming"
    scratch_dir.mkdir(parents=True, exist_ok=True)
    fd, scratch_name = tempfile.mkstemp(dir=scratch_dir, suffix=_EXTENSIONS[declared])
    scratch = Path(scratch_name)
    try:
        with open(fd, "wb") as out:
            while chunk := upload_file.file.read(_CHUNK):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    # Enforced while streaming rather than from the declared
                    # Content-Length, which a client controls.
                    raise HTTPException(
                        status_code=http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"Files must be {settings.max_upload_mb} MB or smaller.",
                    )
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST, detail="That file is empty."
            )
        storage.backend.put(relative, scratch, content_type=declared)
    except Exception:
        # Never leave a partial file behind for a rejected upload.
        scratch.unlink(missing_ok=True)
        raise
    finally:
        # The local backend moves the scratch file into place, so by now it is
        # usually gone; S3 leaves it behind and it must not accumulate.
        scratch.unlink(missing_ok=True)

    document = RequestDocument(
        request_id=request.request_id,
        merchant_id=request.merchant_id,
        passenger_id=passenger_id,
        doc_type=doc_type,
        # Display only — the path above comes from a uuid, and this is reduced
        # to a bare leaf name so it is safe to echo in JSON and in the
        # download's Content-Disposition.
        original_filename=_safe_display_name(upload_file.filename),
        stored_path=relative,
        content_type=declared,
        size_bytes=size,
        checksum=digest.hexdigest(),
        uploaded_by=actor.user_id,
        verification_status=V.PENDING,
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    activity_service.log_activity(
        db, actor.user_id, "Booking document uploaded",
        activity_type="Document", module="Booking Request",
        description=(
            f"{actor.full_name} uploaded {document.original_filename} "
            f"({doc_type.value}) to {request.request_number}"
        ),
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={
            "document_id": document.document_id,
            "request_number": request.request_number,
            "doc_type": doc_type.value,
            "passenger_id": passenger_id,
            "size_bytes": size,
            "checksum": document.checksum,
        },
    )
    return document


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------
def open_for_download(db: Session, actor: User, document_id: int) -> tuple[BinaryIO, RequestDocument]:
    """Open a document's bytes, after re-checking scope.

    Scope is re-checked here rather than assumed from the id: a document id is
    a plain integer, and this is the only thing standing between one merchant
    and another's passport scans.

    Returns an open handle rather than a path because an S3 object has no path.
    The caller owns closing it — :func:`storage.iter_chunks` does that, and the
    router streams through it.
    """
    doc = get_document(db, actor, document_id)
    try:
        stream = storage.backend.open(_storage_key(doc.stored_path))
    except storage.DocumentBytesMissing:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="The stored file for this document is missing.",
        ) from None
    return stream, doc


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------
def delete(db: Session, actor: User, document_id: int) -> None:
    """Remove a document from a draft.

    The row goes first and the file second: if the unlink fails the transaction
    has already committed and we are left with an orphaned blob, which is
    harmless. The reverse order could delete the bytes and then roll back,
    leaving a row pointing at nothing.
    """
    doc = get_document(db, actor, document_id)
    request = _request_for(db, actor, doc.request_id, lock=True)
    # Same gate as upload, and passed this document's own type: a reissue means
    # the desk must be able to replace a ticket it attached, but nobody may
    # remove a merchant's passport from a booking that is already in flight.
    _assert_may_modify(request, actor, doc.doc_type)

    snapshot = {
        "document_id": doc.document_id,
        "request_number": request.request_number,
        "filename": doc.original_filename,
        "doc_type": doc.doc_type.value,
        "checksum": doc.checksum,
    }
    # Read before the delete, while the row is still attached.
    key = _storage_key(doc.stored_path)
    db.delete(doc)
    db.commit()

    try:
        storage.backend.delete(key)
    except Exception:
        # Row is gone; a stray blob is not worth failing the request over. Broad
        # rather than OSError because an S3 delete fails with a botocore error.
        pass

    activity_service.log_activity(
        db, actor.user_id, "Booking document deleted",
        activity_type="Document", module="Booking Request",
        description=(
            f"{actor.full_name} deleted {snapshot['filename']} from "
            f"{snapshot['request_number']}"
        ),
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details=snapshot,
    )


# ---------------------------------------------------------------------------
# Admin verification
# ---------------------------------------------------------------------------
def verify(
    db: Session, actor: User, document_id: int, *, approved: bool, reason: str | None = None
) -> RequestDocument:
    """Admin marks a document verified or rejected.

    Independent of the booking's own lifecycle on purpose: paperwork is checked
    while the request sits at Pending Approval, and a rejected document should
    not by itself reject the booking — the admin decides that separately.
    """
    doc = get_document(db, actor, document_id)
    if not approved and not (reason or "").strip():
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="A reason is required when rejecting a document",
        )

    before = doc.verification_status
    doc.verification_status = V.VERIFIED if approved else V.REJECTED
    doc.verified_by = actor.user_id
    doc.verified_at = datetime.datetime.now(datetime.timezone.utc)
    doc.rejection_reason = None if approved else reason.strip()
    db.commit()
    db.refresh(doc)

    request = db.get(ServiceRequest, doc.request_id)
    activity_service.log_activity(
        db, actor.user_id, f"Booking document {'verified' if approved else 'rejected'}",
        activity_type="Document", module="Booking Request",
        description=(
            f"{actor.full_name} {'verified' if approved else 'rejected'} "
            f"{doc.original_filename} on {request.request_number if request else doc.request_id}"
        ),
        reference_id=doc.request_id, merchant_id=doc.merchant_id,
        details={
            "document_id": doc.document_id,
            "request_number": request.request_number if request else None,
            "from_status": before.value,
            "to_status": doc.verification_status.value,
            "reason": doc.rejection_reason,
        },
    )
    return doc
