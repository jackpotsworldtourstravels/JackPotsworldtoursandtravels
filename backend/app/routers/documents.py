"""Supporting documents on a booking request.

Permissions reuse the two codes that have existed since 0023 and were reserved
for exactly this: ``document.upload`` (merchant roles) and ``document.verify``
(Admin). No new codes.

There is deliberately **no static file mount** anywhere in this application.
Every byte is served by :func:`download_document`, which resolves the file only
after :func:`document_service.get_document` has re-checked that this caller's
merchant owns it.
"""
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import DocumentType, User
from app.schemas.document import DocumentResponse, DocumentVerifyRequest
from app.services import document_service, storage

router = APIRouter(prefix="/api", tags=["documents"])


def _attachment(filename: str) -> str:
    """Build the Content-Disposition header for a download.

    ``FileResponse`` used to do this; the S3 backend has no path to hand it, so
    downloads stream instead and the header is built here. Same two-form rule
    Starlette applies: a plain quoted name when it is ASCII, and the RFC 5987
    encoded form otherwise, because a bare non-ASCII byte in a header is not
    something every client parses the same way. The name has already been
    stripped of quotes and newlines by ``_safe_display_name`` upstream, so it
    cannot forge a second header line here.
    """
    try:
        filename.encode("ascii")
    except UnicodeEncodeError:
        return f"attachment; filename*=utf-8''{quote(filename)}"
    return f'attachment; filename="{filename}"'


def _named(db: Session, doc) -> DocumentResponse:
    """Attach uploader/verifier display names without a second round trip."""
    from app.models_v2 import User as U

    def name(uid):
        return db.get(U, uid).full_name if uid else None

    return DocumentResponse.of(doc, uploader=name(doc.uploaded_by), verifier=name(doc.verified_by))


@router.post(
    "/requests/{request_id}/documents",
    response_model=DocumentResponse,
    status_code=201,
    summary="Attach a document to a booking request",
    description=(
        "Requires `document.upload`. Multipart upload of a PDF, JPEG, PNG or WebP, "
        "size-capped and signature-checked — the declared content type must match the "
        "file's actual leading bytes. "
        "**A merchant may attach only while the request is a draft** (409 otherwise), because "
        "its documents are part of what it is submitting. **Platform staff may additionally "
        "attach `ticket` and `other` documents once the booking is paid** — the airline's "
        "e-ticket only exists after the money has moved. "
        "`passenger_id` ties the document to one traveller and must belong to this request; "
        "omit it for booking-level paperwork."
    ),
)
def upload_document(
    request_id: int,
    file: UploadFile = File(...),
    doc_type: DocumentType = Form(DocumentType.OTHER),
    passenger_id: int | None = Form(None),
    db: Session = Depends(get_db),
    # Either code opens the door; ``document_service`` decides what each may
    # actually do. A merchant holds `document.upload` because the paperwork is
    # its own; an Admin holds `ticket.issue` because attaching the airline's
    # e-ticket *is* part of issuing the ticket. Expressed as an OR here rather
    # than by granting `document.upload` to the Admin role, which would also
    # have let admins attach passports and widened the matrix for no reason.
    current_user: User = Depends(require(P.DOCUMENT_UPLOAD, P.TICKET_ISSUE)),
):
    doc = document_service.upload(
        db, current_user, request_id, file, doc_type=doc_type, passenger_id=passenger_id
    )
    return _named(db, doc)


@router.get(
    "/requests/{request_id}/documents",
    response_model=list[DocumentResponse],
    summary="Documents on a booking request",
    description=(
        "Requires `ticket.view`. A merchant sees only its own request's documents; "
        "platform staff see any. Returns metadata only — fetch bytes from the download "
        "endpoint."
    ),
)
def list_documents(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return [_named(db, d) for d in document_service.list_documents(db, current_user, request_id)]


@router.get(
    "/documents/{document_id}/download",
    response_class=StreamingResponse,
    summary="Download a document",
    description=(
        "Requires `ticket.view`, **and** the document must belong to the caller's merchant "
        "(platform staff excepted) — re-checked on every request. Served as an attachment "
        "rather than inline, so a crafted file can never execute in the app's origin; the "
        "stored path is never exposed."
    ),
)
def download_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    stream, doc = document_service.open_for_download(db, current_user, document_id)
    return StreamingResponse(
        storage.iter_chunks(stream),
        media_type=doc.content_type,
        headers={
            "Content-Disposition": _attachment(doc.original_filename),
            "Content-Length": str(doc.size_bytes),
            # Passport scans should not sit in a shared cache.
            "Cache-Control": "private, no-store",
        },
    )


@router.delete(
    "/documents/{document_id}",
    status_code=204,
    summary="Remove a document",
    description=(
        "Requires `document.upload` — the code that put the file there. Same window as upload: "
        "a merchant only while the request is a draft, staff also for `ticket`/`other` on a paid "
        "booking so a reissued ticket can be replaced (409 otherwise)."
    ),
)
def delete_document(
    document_id: int,
    db: Session = Depends(get_db),
    # Mirrors upload — see the note there on why this is an OR.
    current_user: User = Depends(require(P.DOCUMENT_UPLOAD, P.TICKET_ISSUE)),
):
    document_service.delete(db, current_user, document_id)
    return None


@router.post(
    "/admin/documents/{document_id}/verify",
    response_model=DocumentResponse,
    tags=["admin · documents"],
    summary="Verify or reject a document",
    description=(
        "Requires `document.verify` (Admin). Independent of the booking's own lifecycle: "
        "rejecting a document does not reject the booking. A reason is mandatory on rejection."
    ),
)
def verify_document(
    document_id: int,
    payload: DocumentVerifyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.DOCUMENT_VERIFY)),
):
    doc = document_service.verify(
        db, current_user, document_id, approved=payload.approved, reason=payload.reason
    )
    return _named(db, doc)
