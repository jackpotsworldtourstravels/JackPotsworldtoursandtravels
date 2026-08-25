"""Passport OCR endpoints.

    POST /api/bookings/passport/extract          upload a passport, get fields
    GET  /api/bookings/passport/extract/{id}     poll a slow one
    GET  /api/bookings/passport/extract/{id}/scan  the image, authenticated
    POST /api/bookings/passport/extract/{id}/edits record what the merchant changed
    GET  /api/bookings/passport/availability     should the portal offer this?
    GET  /api/admin/requests/{id}/passport-ocr   what the desk sees on a booking

PERMISSIONS REUSE ``document.upload``. It has existed since migration 0023, is
already held by every merchant role that can raise a booking, and means exactly
what this endpoint does — a merchant sending us a file about a booking. Adding
an ``ocr.extract`` code would be a new permission on an approved role matrix,
which ``docs/BOOKING_OPS_MILESTONES.md`` §0 treats as a change to approved
behaviour. Reading one back on the Admin side reuses ``document.verify``, which
is the desk's existing right to look at a merchant's paperwork.

NO STATIC MOUNT, NO PRESIGNED URL. The scan is streamed by
:func:`download_scan` after the service has re-checked who is asking, exactly as
booking documents are. See ``passport_ocr_service.open_scan`` for why a signed
URL was not used instead.
"""
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.config import settings
from app.database.session import get_db
from app.models_v2 import OcrStatus, User
from app.schemas.passport_ocr import (
    DuplicatePassengerOut,
    ExtractionAdminResponse,
    ExtractionResponse,
    OcrAvailabilityResponse,
    RecordEditsRequest,
)
from app.services import document_service, passport_ocr, passport_ocr_service, storage

router = APIRouter(prefix="/api", tags=["passport OCR"])

#: The passenger fields a duplicate match may offer back, mirroring what the
#: existing passenger-lookup endpoint returns. `passport_number` is absent: it
#: is the key that was just read, and echoing it adds nothing.
_DUPLICATE_FIELDS = (
    "title", "first_name", "last_name", "gender", "dob", "nationality",
    "passport_issue_country", "passport_issue_date", "passport_expiry",
    "seat_preference", "meal_preference",
)


def _duplicate_out(passenger) -> DuplicatePassengerOut:
    if passenger is None:
        return DuplicatePassengerOut(found=False)
    fields = {}
    for name in _DUPLICATE_FIELDS:
        value = getattr(passenger, name, None)
        if value is None or value == "":
            continue
        fields[name] = value.value if hasattr(value, "value") else str(value)
    return DuplicatePassengerOut(
        found=True,
        full_name=passenger.full_name,
        last_used=passenger.updated_at,
        fields=fields,
    )


def _travel_date_of(db: Session, request_id: int | None):
    """The journey date a passport's validity is measured against, if known."""
    if request_id is None:
        return None
    from app.models_v2 import ServiceRequest

    request = db.get(ServiceRequest, request_id)
    return request.travel_date if request else None


def _respond(db: Session, actor: User, row, *, travel_date=None) -> ExtractionResponse:
    """Assemble the merchant-facing answer for one extraction.

    The duplicate lookup and the validity assessment run HERE rather than in the
    worker, because both depend on things that can change after the scan: the
    merchant may have booked that passport again since, and the travel date is
    often chosen after the passenger details are filled in. Computing them at
    read time means a poll and a re-read always agree with the current state.
    """
    if row.status is not OcrStatus.SUCCEEDED:
        return ExtractionResponse.of(row)

    expiry = ((row.normalized or {}).get("passport_expiry") or {}).get("value")
    return ExtractionResponse.of(
        row,
        validity=passport_ocr_service.assess_passport(
            expiry, travel_date if travel_date is not None else _travel_date_of(db, row.request_id)
        ),
        duplicate=_duplicate_out(passport_ocr_service.duplicate_for(db, actor, row)),
    )


@router.get(
    "/bookings/passport/availability",
    response_model=OcrAvailabilityResponse,
    summary="Is passport scanning available on this deployment?",
    description=(
        "Requires `document.upload`. Read by the merchant portal on load so a "
        "deployment with no OCR provider configured renders no Scan control at "
        "all, rather than a button that fails when pressed.\n\n"
        "`simulated` is always `false` here: no provider that fabricates data "
        "exists any more. It remains in the contract because rows written "
        "before it was removed are still in the database and still carry "
        "`provider: \"simulated\"`, and any screen showing one must say so."
    ),
)
def ocr_availability(_: User = Depends(require(P.DOCUMENT_UPLOAD))):
    available = passport_ocr.is_available()
    provider = None
    if available:
        provider = getattr(passport_ocr.get_provider(), "name", None)
    return OcrAvailabilityResponse(
        available=available,
        provider=provider,
        simulated=provider == "simulated",
        configuration_error=passport_ocr.configuration_error(),
        max_upload_mb=settings.max_upload_mb,
        accepted_types=list(document_service.ALLOWED_CONTENT_TYPES),
        confidence_bands=dict(passport_ocr_service.CONFIDENCE_BANDS),
        passport_validity_months=settings.passport_validity_months,
    )


@router.post(
    "/bookings/passport/extract",
    response_model=ExtractionResponse,
    summary="Read a passport and return the passenger fields",
    description=(
        "Requires `document.upload`. Upload the passport photo page; get back "
        "the passenger fields with a **confidence score each**, a duplicate-"
        "traveller match if this merchant has sent that passport before, and a "
        "validity assessment against the travel date.\n\n"
        "**`request_id` is optional and is only a label.** Scanning works on a "
        "blank form with no draft saved — that is the point of it. Supply the "
        "id only once a draft exists, to make the scan visible to the desk "
        "alongside the booking.\n\n"
        "**Answers `202` when the provider is slow.** If the read has not "
        "finished within `OCR_INLINE_WAIT_SECONDS` (default 3), the response is "
        "`202` with `status: \"processing\"` and an `id`; poll "
        "`GET /api/bookings/passport/extract/{id}` until `status` is "
        "`succeeded` or `failed`.\n\n"
        "**Nothing here writes passenger data.** The merchant's own Save "
        "creates the passenger row exactly as it always has, and no booking can "
        "ever be blocked by a scan that failed."
    ),
    responses={
        202: {"description": "Accepted; still reading. Poll for the result."},
        415: {"description": "Not a PDF, JPEG, PNG or WebP."},
        503: {"description": "No OCR provider is configured."},
    },
)
def extract_passport(
    response: Response,
    file: UploadFile = File(...),
    request_id: int | None = Form(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.DOCUMENT_UPLOAD)),
):
    row = passport_ocr_service.start_extraction(
        db, current_user, file, request_id=request_id
    )
    if row.status in (OcrStatus.QUEUED, OcrStatus.PROCESSING):
        # 202, not 200: the caller must poll, and the status code is what says
        # so without the client having to inspect the body first.
        response.status_code = status.HTTP_202_ACCEPTED
    return _respond(db, current_user, row)


@router.get(
    "/bookings/passport/extract/{extraction_id}",
    response_model=ExtractionResponse,
    summary="Poll a passport extraction",
    description=(
        "Requires `document.upload`. Poll every two seconds until `status` is "
        "`succeeded` or `failed`.\n\n"
        "A scan whose worker process died is reported as `failed` with "
        "`error_code: \"ocr_abandoned\"` once it is past its budget, so this "
        "never polls forever."
    ),
)
def get_extraction(
    extraction_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.DOCUMENT_UPLOAD)),
):
    row = passport_ocr_service.get_extraction(db, current_user, extraction_id)
    return _respond(db, current_user, row)


@router.get(
    "/bookings/passport/extract/{extraction_id}/scan",
    summary="Download the scanned passport image",
    description=(
        "Requires `document.upload` (the merchant that uploaded it) **or** "
        "`document.verify` (the desk reviewing the booking it is attached to). "
        "Streams the stored scan after re-checking who is asking.\n\n"
        "**There is no public URL for this file and no presigned link.** It is "
        "served only here, only to the merchant that uploaded it and to "
        "platform staff once it is attached to a booking, and the response is "
        "marked `private, no-store` so it is not written to a shared cache."
    ),
)
def download_scan(
    extraction_id: int,
    db: Session = Depends(get_db),
    # BOTH codes, and this is the only endpoint here that takes `document.verify`.
    # No platform role holds `document.upload` — it is a merchant's right to send
    # us a file — so gating on it alone made the Admin panel's "View passport"
    # button a guaranteed 403: the desk could see that a scan existed and never
    # open it. Widening the gate does not widen what staff can reach, because
    # `passport_ocr_service._scoped` still hands them attached rows only; an
    # unattached scan is a 404 to the desk exactly as before.
    current_user: User = Depends(require(P.DOCUMENT_UPLOAD, P.DOCUMENT_VERIFY)),
):
    stream, row = passport_ocr_service.open_scan(db, current_user, extraction_id)
    return StreamingResponse(
        storage.iter_chunks(stream),
        media_type=row.content_type,
        headers={
            # inline, not attachment: this is shown in a viewer beside the form,
            # not saved. The magic-byte sniff at upload is what makes rendering
            # it safe — nothing reaches storage whose bytes disagree with its
            # declared image type.
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(row.original_filename)}",
            "Content-Length": str(row.size_bytes),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/bookings/passport/extract/{extraction_id}/edits",
    response_model=ExtractionResponse,
    summary="Record what the merchant changed after the scan",
    description=(
        "Requires `document.upload`. Send the passenger **as saved**; the server "
        "compares it with what OCR read and stores one row per field that "
        "differs — original value, edited value, who and when.\n\n"
        "Fields absent from `values` are ignored rather than treated as "
        "cleared. Re-sending replaces this extraction's edit list rather than "
        "appending, so saving the same passenger three times records what "
        "changed, not how many times Save was pressed.\n\n"
        "Optionally supply `request_id` and `passenger_id` to tell the scan "
        "which booking and traveller it became — which is what makes it visible "
        "on the Admin's review panel."
    ),
)
def record_edits(
    extraction_id: int,
    payload: RecordEditsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.DOCUMENT_UPLOAD)),
):
    passport_ocr_service.record_edits(
        db, current_user, extraction_id,
        values=payload.values,
        request_id=payload.request_id,
        passenger_id=payload.passenger_id,
    )
    row = passport_ocr_service.get_extraction(db, current_user, extraction_id)
    return _respond(db, current_user, row)


@router.get(
    "/admin/requests/{request_id}/passport-ocr",
    response_model=list[ExtractionAdminResponse],
    tags=["admin · booking ops"],
    summary="Passport scans behind a booking, with the provider's raw answer",
    description=(
        "Requires `document.verify`. Every scan attached to this booking: the "
        "extracted fields and their confidence, whether the merchant changed "
        "any of them (and from what), and the provider's untouched response.\n\n"
        "Only scans the merchant **attached to a booking** appear. A scan that "
        "filled a form the merchant never submitted is not visible to the desk."
    ),
)
def request_extractions(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.DOCUMENT_VERIFY)),
):
    rows = passport_ocr_service.for_request(db, current_user, request_id)
    if not rows:
        return []

    # One query for every name, rather than one per row per edit.
    user_ids = {r.created_by for r in rows} | {
        e.edited_by for r in rows for e in r.edits
    }
    from sqlalchemy import select as _select

    names = dict(
        db.execute(
            _select(User.user_id, User.full_name).where(User.user_id.in_(user_ids))
        ).all()
    )
    travel_date = _travel_date_of(db, request_id)
    return [
        ExtractionAdminResponse.of_admin(
            row,
            uploader=names.get(row.created_by),
            editors=names,
            validity=(
                passport_ocr_service.assess_passport(
                    ((row.normalized or {}).get("passport_expiry") or {}).get("value"),
                    travel_date,
                )
                if row.status is OcrStatus.SUCCEEDED
                else None
            ),
        )
        for row in rows
    ]
