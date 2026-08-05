"""Group booking — the passenger manifest endpoints.

Merchant and Admin routes live together for the reason
:mod:`app.routers.enquiries` gives: they read the same rows under the same
scoping rules, and splitting them would mean writing that scoping twice.

Permissions reuse the existing codes rather than inventing any. Uploading a
manifest is part of raising a booking, so it is gated on ``ticket.request`` —
the same code the Direct Booking and enquiry-led paths already require. Reading
one back is ``ticket.view``. There is no new capability to grant, which means an
existing merchant role works on day one and no permission matrix changes.

THE AUDIT TRAIL (spec section 12)
Every step is recorded through :func:`activity_service.log_activity`, the same
sink the rest of the platform writes to, under the ``group_booking`` module:
``template_downloaded``, ``upload_started``, ``validation_completed``,
``import_successful``, ``import_failed``, and — from the booking path —
``booking_submitted``. They are written even on the failure branches, because
the interesting question afterwards is almost always about an import that did
*not* work.
"""
import io

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status as http_status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import GroupImportStatus, User
from app.schemas.group_booking import (
    GroupBookingLimits,
    GroupImportDetail,
    GroupImportUploadResult,
)
from app.services import activity_service, group_booking_service as gb, storage

router = APIRouter(prefix="/api", tags=["group bookings"])

#: Downloads are never cached and never inlined. A manifest is a list of real
#: travellers with passport numbers on it — the same handling every other
#: document on this platform gets.
_NO_STORE = {"Cache-Control": "no-store, private"}


def _attachment(filename: str) -> dict[str, str]:
    # RFC 5987, because a merchant's filename is not necessarily ASCII and a
    # bare filename= with a non-ASCII value is what makes a download arrive
    # named "_____.xlsx".
    from urllib.parse import quote

    safe = quote(filename, safe="")
    return {
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe}",
        **_NO_STORE,
    }


def _log(
    db: Session,
    request: Request,
    actor: User,
    action: str,
    *,
    reference_id: int | None = None,
    description: str | None = None,
    status: str = "success",
    details: dict | None = None,
) -> None:
    # `request_context` also returns `os`, which `log_activity` does not accept —
    # the three keys are named explicitly here for that reason, exactly as
    # routers/auth.py does. Splatting the dict raises a TypeError.
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db,
        actor.user_id,
        action,
        meta["ip_address"],
        module="group_booking",
        activity_type="Booking",
        description=description,
        reference_id=reference_id,
        merchant_id=actor.merchant_id,
        status=status,
        details=details,
        browser=meta["browser"],
        device=meta["device"],
    )


# ---------------------------------------------------------------------------
# Merchant
# ---------------------------------------------------------------------------
@router.get(
    "/group-bookings/limits",
    response_model=GroupBookingLimits,
    tags=["merchant · group booking"],
    summary="The configured group-booking bounds",
    description=(
        "Requires `ticket.request`. The party size a group booking may carry and the upload "
        "size limit, both read from server configuration. The enquiry form validates the "
        "merchant's **Number of Passengers** against `max_passengers` before sending, and the "
        "same number bounds the rows an uploaded manifest may contain — one setting, so the "
        "two gates cannot contradict each other."
    ),
)
def group_booking_limits(
    current_user: User = Depends(require(P.TICKET_REQUEST)),
) -> GroupBookingLimits:
    # Deliberately not logged to activity: it is read on every open of the
    # enquiry form and says nothing about what the merchant did.
    return GroupBookingLimits(
        max_passengers=gb.MAX_ROWS,
        max_upload_mb=gb.MAX_UPLOAD_BYTES // (1024 * 1024),
    )


@router.get(
    "/group-bookings/template",
    tags=["merchant · group booking"],
    summary="Download the passenger list template",
    description=(
        "Requires `ticket.request`. Returns the .xlsx the merchant fills in — headers, one "
        "worked sample row, date-formatted cells, and dropdowns on Gender, AM/PM and Booking "
        "Class. `journey_type` decides whether the return-leg columns are present: a "
        "`one_way_group` template does not carry them at all, so a one-way booking cannot "
        "acquire a return date by leaving a column blank."
    ),
)
def download_template(
    request: Request,
    journey_type: str = gb.ONE_WAY_GROUP,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    data = gb.build_template(journey_type)
    _log(
        db, request, current_user, "template_downloaded",
        description=f"Downloaded the {journey_type} passenger template",
        details={"journey_type": journey_type},
    )
    return StreamingResponse(
        io.BytesIO(data),
        media_type=gb._CONTENT_TYPE,
        headers=_attachment(gb.template_filename(journey_type)),
    )


@router.post(
    "/group-bookings/imports",
    response_model=GroupImportUploadResult,
    status_code=201,
    tags=["merchant · group booking"],
    summary="Upload a filled passenger list",
    description=(
        "Requires `ticket.request`. Accepts one `.xlsx` or `.xls` up to 10 MB, decided by the "
        "file's **magic bytes** rather than its name. Every row is validated and every problem "
        "is returned at once with the merchant's own Excel row numbers — a sheet is not refused "
        "at its first bad row. A file with problems is still stored and answered with `partial` "
        "or `invalid`; only a wholly `valid` import may then be turned into a booking, which "
        "`POST /api/bookings/direct` and the enquiry-led path both enforce. Send `replaces` to "
        "swap out a previous upload — its row and its bytes are deleted."
    ),
)
async def upload_manifest(
    request: Request,
    file: UploadFile = File(...),
    journey_type: str = Form(gb.ONE_WAY_GROUP),
    replaces: int | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    _log(
        db, request, current_user, "upload_started",
        description=f"Uploading {file.filename!r} as a {journey_type} passenger list",
        details={"journey_type": journey_type, "filename": file.filename},
    )
    try:
        imp = gb.create_import(
            db, current_user, file, journey_type, replaces=replaces
        )
    except HTTPException as exc:
        # The failure branches are the ones worth having a trail for.
        _log(
            db, request, current_user, "import_failed",
            description=f"Passenger list {file.filename!r} was refused: {exc.detail}",
            status="failure",
            details={"journey_type": journey_type, "reason": str(exc.detail)},
        )
        raise

    ok = imp.validation_status == GroupImportStatus.VALID
    _log(
        db, request, current_user,
        "import_successful" if ok else "validation_completed",
        reference_id=imp.import_id,
        description=(
            f"{imp.passengers_imported} passenger(s) imported from "
            f"{imp.original_filename!r} ({imp.validation_status.value})"
        ),
        status="success" if ok else "warning",
        details={
            "journey_type": journey_type,
            "total_rows": imp.total_rows,
            "valid_rows": imp.valid_rows,
            "invalid_rows": imp.invalid_rows,
            "validation_status": imp.validation_status.value,
        },
    )

    if ok:
        message = f"Excel successfully imported — {imp.passengers_imported} passengers."
    elif imp.validation_status == GroupImportStatus.PARTIAL:
        message = (
            f"{imp.valid_rows} of {imp.total_rows} rows imported. "
            f"{imp.invalid_rows} row(s) need fixing before you can book."
        )
    else:
        message = (
            f"None of the {imp.total_rows} rows could be imported. "
            "Download the error report to see why."
        )

    return GroupImportUploadResult(
        imported=GroupImportDetail.of(
            imp, uploaded_by_name=current_user.full_name
        ),
        message=message,
    )


@router.get(
    "/group-bookings/imports/{import_id}",
    response_model=GroupImportDetail,
    tags=["merchant · group booking"],
    summary="Read an imported passenger list",
    description=(
        "Requires `ticket.view`. Everything **View Imported Data** shows: the summary, the "
        "journey the sheet declared, every parsed passenger and every outstanding error. "
        "Scoped — a merchant cannot read another company's import."
    ),
)
def get_import(
    import_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return GroupImportDetail.of(gb.get(db, current_user, import_id))


@router.get(
    "/group-bookings/imports/{import_id}/file",
    tags=["merchant · group booking"],
    summary="Download the uploaded spreadsheet",
    description=(
        "Requires `ticket.view`. Streams back the exact bytes the merchant uploaded, scoped and "
        "`no-store`. Platform staff reach the same file through this route, which is what lets "
        "the desk compare a manifest against what it is about to ticket."
    ),
)
def download_manifest(
    import_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    imp = gb.get(db, current_user, import_id)
    return StreamingResponse(
        storage.iter_chunks(gb.open_for_download(imp)),
        media_type=imp.content_type,
        headers=_attachment(imp.original_filename),
    )


@router.get(
    "/group-bookings/imports/{import_id}/errors",
    tags=["merchant · group booking"],
    summary="Download the validation error report",
    description=(
        "Requires `ticket.view`. A two-sheet .xlsx — every problem with the Excel row number it "
        "belongs to, plus the import summary. A spreadsheet rather than a list because the thing "
        "being corrected is a spreadsheet, and these row numbers line up with the file still "
        "open on the merchant's screen. 404 on an import that has no errors."
    ),
)
def download_error_report(
    import_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    imp = gb.get(db, current_user, import_id)
    if not imp.validation_errors:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="That import has no validation errors.",
        )
    return StreamingResponse(
        io.BytesIO(gb.build_error_report(imp)),
        media_type=gb._CONTENT_TYPE,
        headers=_attachment(gb.error_report_filename(imp)),
    )


@router.delete(
    "/group-bookings/imports/{import_id}",
    status_code=204,
    tags=["merchant · group booking"],
    summary="Discard an uploaded passenger list",
    description=(
        "Requires `ticket.request`. Removes a staging upload and its stored bytes. Returns 409 "
        "once the import belongs to a booking — at that point it is the evidence behind a live "
        "request, and the desk issuing tickets has to be able to open it."
    ),
)
def discard_import(
    request: Request,
    import_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    gb.discard(db, current_user, import_id)
    _log(
        db, request, current_user, "import_discarded",
        reference_id=import_id,
        description=f"Discarded passenger list #{import_id}",
    )
    return None


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
@router.get(
    "/admin/requests/{request_id}/group-import",
    response_model=GroupImportDetail,
    tags=["admin · group booking"],
    summary="The manifest behind a group booking",
    description=(
        "Requires `ticket.view`. Everything the Admin needs to work a group booking without "
        "re-entering anything: the validation summary, the journey the sheet declared, and the "
        "full imported passenger list. 404 when the booking did not come from a manifest."
    ),
)
def admin_group_import(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    imp = gb.for_request(db, current_user, request_id)
    return GroupImportDetail.of(imp)


@router.get(
    "/admin/requests/{request_id}/group-import/file",
    tags=["admin · group booking"],
    summary="Download the spreadsheet behind a group booking",
    description=(
        "Requires `ticket.view`. The merchant's original upload, streamed back for the desk. "
        "Same scoping as every other request-shaped read, so a merchant hitting this route "
        "reaches only its own bookings."
    ),
)
def admin_download_manifest(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    imp = gb.for_request(db, current_user, request_id)
    return StreamingResponse(
        storage.iter_chunks(gb.open_for_download(imp)),
        media_type=imp.content_type,
        headers=_attachment(imp.original_filename),
    )
