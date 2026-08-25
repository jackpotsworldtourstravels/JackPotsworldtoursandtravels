"""Passport OCR: storing the scan, running the provider, recording what changed.

WHERE THIS SITS
``app.services.passport_ocr`` owns *which vendor and how to talk to it*. This
module owns *everything else*: who may scan, where the bytes go, the row that
records the run, the background execution, the duplicate-traveller lookup, the
validity assessment, and the audit of what the merchant changed afterwards. No
vendor name appears below this line.

THE RULE THIS FEATURE IS BUILT AROUND
**Scanning is a shortcut over a form that is complete without it.** It cannot be
required, it cannot gate a submission, and it cannot fail in a way that stops a
merchant booking. CR-1 removed uploads from this workflow because attaching a
passport forced the merchant to save a draft first; re-introducing anything with
that shape would be the same defect wearing a new name. Concretely:

* an extraction needs no ``request_id`` and no ``passenger_id`` — it works on a
  blank form, which is the only moment it is actually useful;
* it writes no passenger data — the merchant's own Save does that, unchanged;
* every failure path returns a form the merchant can still type into;
* ``ticket_service`` is not touched, so the submit rules are exactly what they
  were before this shipped.

THE 202 PATH, AND WHY THE DATABASE IS THE ONLY STATE
A scan usually answers in a second or two, and sometimes a large PDF does not.
The request waits ``ocr_inline_wait_seconds`` and then hands back a job id for
the client to poll. The work runs on a worker thread that writes its result to
the row — **not** to anything in memory — because this application runs under
gunicorn with several worker processes and the poll will frequently land on a
different process from the one doing the work. The row is the only thing both
can see. That also means a worker that dies mid-scan leaves a row stuck at
``processing``, which :func:`_reap_if_stale` turns into an honest failure at
read time rather than a spinner that never stops.
"""
from __future__ import annotations

import datetime as dt
import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from typing import Any, BinaryIO

from fastapi import HTTPException, UploadFile, status as http_status
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database.session import SessionLocal
from app.models_v2 import (
    OcrStatus,
    PassengerData,
    PassportOcrExtraction,
    PassportOcrFieldEdit,
    ServiceRequest,
    User,
)
from app.services import (
    activity_service,
    document_service,
    passport_ocr,
    passport_rules,
    storage,
    ticket_service,
)

logger = logging.getLogger(__name__)

#: Bounded on purpose. Each running extraction holds a database connection and a
#: socket to the provider; an unbounded pool turns a burst of uploads into a
#: connection-pool exhaustion that takes the whole API down, not just scanning.
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="passport-ocr")

#: How far past its own timeout a row may sit before a reader calls it dead.
#: Generous because the budget is the *provider's*, and a queued job may have
#: waited behind three others in the pool before it started.
_STALE_GRACE_SECONDS = 120

# ---------------------------------------------------------------------------
# Confidence bands — defined ONCE, here, and returned to every client
# ---------------------------------------------------------------------------
# The merchant portal colours a field by these and the Admin panel labels a scan
# by them. Both read them from the API rather than hard-coding their own copy,
# because two copies of a threshold is how a field ends up green on one screen
# and orange on the other.
CONFIDENCE_BANDS: dict[str, float] = {"high": 0.95, "medium": 0.80}


def band_for(confidence: float | None) -> str:
    """``high`` / ``medium`` / ``low`` / ``unknown`` for one score."""
    if confidence is None:
        return "unknown"
    if confidence >= CONFIDENCE_BANDS["high"]:
        return "high"
    if confidence >= CONFIDENCE_BANDS["medium"]:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# Scoping
# ---------------------------------------------------------------------------
def _scoped(actor: User, extraction_id: int):
    """The one filter that decides who may see an extraction.

    A merchant sees only its own rows. Platform staff see an extraction only
    once it is **attached to a booking** — an unattached scan is a merchant
    filling in a form that may never be submitted, and the desk has no business
    reading a passport off an abandoned draft. Staff reach an attached one
    through the booking, which is where the desk's legitimate interest is.
    """
    conditions = [PassportOcrExtraction.extraction_id == extraction_id]
    if actor.is_platform_staff:
        conditions.append(PassportOcrExtraction.request_id.isnot(None))
    else:
        if actor.merchant_id is None:
            # Neither staff nor a merchant user: no rows, rather than all rows.
            conditions.append(PassportOcrExtraction.extraction_id.is_(None))
        else:
            conditions.append(PassportOcrExtraction.merchant_id == actor.merchant_id)
    return and_(*conditions)


def get_extraction(db: Session, actor: User, extraction_id: int) -> PassportOcrExtraction:
    row = db.scalars(
        select(PassportOcrExtraction).where(_scoped(actor, extraction_id))
    ).first()
    if not row:
        # 404 rather than 403 — never confirm another merchant's scan exists.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Extraction not found"
        )
    return _reap_if_stale(db, row)


def _reap_if_stale(db: Session, row: PassportOcrExtraction) -> PassportOcrExtraction:
    """Turn an abandoned run into a failure the client can act on.

    Only reachable when the process running the extraction died — a normal
    failure writes its own row. Without this the merchant polls a ``processing``
    row for ever and the only way out is a page reload.
    """
    if row.status not in (OcrStatus.QUEUED, OcrStatus.PROCESSING):
        return row
    age = (
        dt.datetime.now(dt.timezone.utc) - row.created_at
    ).total_seconds()
    if age < settings.ocr_timeout_seconds + _STALE_GRACE_SECONDS:
        return row

    row.status = OcrStatus.FAILED
    row.error_code = "ocr_abandoned"
    row.error_detail = (
        "The scan did not finish. Enter the passport details by hand, or try again."
    )
    row.completed_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Starting an extraction
# ---------------------------------------------------------------------------
def start_extraction(
    db: Session,
    actor: User,
    upload_file: UploadFile,
    *,
    request_id: int | None = None,
) -> PassportOcrExtraction:
    """Store the scan, then read it. Returns as soon as there is an answer or a
    job id, whichever comes first.

    ``request_id`` is optional and is only ever a *label*: it links the scan to
    a draft the merchant has already saved so the Admin can see it later. It is
    never required, and passing none is the normal case — the merchant scans
    first and saves afterwards.
    """
    if actor.merchant_id is None:
        # Staff have no merchant to scope a scan to, and this endpoint exists to
        # fill a merchant's own booking form.
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Passport scanning is for merchant accounts.",
        )

    # Fail before storing anything if there is no provider: writing a scan we
    # cannot read wastes the merchant's upload and leaves a file to clean up.
    try:
        provider = passport_ocr.get_provider()
    except passport_ocr.OCRNotConfigured as exc:
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Passport scanning is not available on this system. Enter the "
                "passport details by hand."
            ),
        ) from exc

    if request_id is not None:
        # Scoped read: a merchant may only label its own booking, and a bad id
        # is a 404 here rather than a foreign-key error at commit.
        if not db.scalars(
            select(ServiceRequest.request_id).where(
                and_(
                    ServiceRequest.request_id == request_id,
                    ticket_service.scoped_query(actor),
                )
            )
        ).first():
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Request not found"
            )

    # THE SAME UPLOAD PATH BOOKING DOCUMENTS USE. Everything security-critical
    # about accepting a file — the type allowlist, the magic-byte sniff that
    # stops an HTML payload arriving as image/png, the size cap enforced while
    # streaming — lives in document_service.store_upload and is not repeated
    # here. A second copy is how one of them ends up missing a check.
    stored = document_service.store_upload(
        upload_file, prefix=f"passport-scans/{actor.merchant_id}"
    )

    row = PassportOcrExtraction(
        merchant_id=actor.merchant_id,
        created_by=actor.user_id,
        request_id=request_id,
        stored_path=stored.relative_path,
        original_filename=stored.display_filename,
        content_type=stored.content_type,
        size_bytes=stored.size_bytes,
        checksum=stored.checksum,
        status=OcrStatus.QUEUED,
        provider=getattr(provider, "name", "unknown"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    activity_service.log_activity(
        db, actor.user_id, "Passport scanned",
        activity_type="Document", module="Booking Request",
        description=f"{actor.full_name} uploaded a passport for extraction",
        reference_id=row.extraction_id, merchant_id=actor.merchant_id,
        details={
            "extraction_id": row.extraction_id,
            "provider": row.provider,
            "size_bytes": row.size_bytes,
            "checksum": row.checksum,
            "request_id": request_id,
        },
    )

    future = _POOL.submit(_run_extraction, row.extraction_id)
    # Wait for the common case — most scans answer well inside this — and hand
    # back a job id for the rest rather than holding a worker on a slow PDF.
    try:
        future.result(timeout=settings.ocr_inline_wait_seconds)
    except Exception:
        # Either the budget expired (the client will poll) or the worker raised
        # (it recorded its own failure on the row). Both are read back below.
        pass

    db.expire(row)
    return db.get(PassportOcrExtraction, row.extraction_id)


def _run_extraction(extraction_id: int) -> None:
    """The worker body. Owns its own session and never raises to the pool.

    A fresh ``SessionLocal`` rather than the request's session: the request's is
    bound to a connection the endpoint is still using and is not safe to touch
    from another thread. Nothing here returns a value — the row IS the result,
    because the process that polls for it is very often not this one.
    """
    db = SessionLocal()
    try:
        row = db.get(PassportOcrExtraction, extraction_id)
        if row is None or row.status is not OcrStatus.QUEUED:
            return
        row.status = OcrStatus.PROCESSING
        db.commit()

        try:
            provider = passport_ocr.get_provider()
            with storage.backend.open(row.stored_path) as handle:
                content = handle.read()
            result = provider.extract(content, row.content_type)
        except passport_ocr.OCRError as exc:
            _record_failure(db, row, exc.code, str(exc))
            return
        except Exception as exc:  # a bug in an adapter must not hang the row
            logger.exception("passport OCR failed for extraction %s", extraction_id)
            _record_failure(
                db, row, "ocr_failed",
                "The scan could not be completed. Enter the details by hand.",
            )
            return

        row.status = OcrStatus.SUCCEEDED
        row.provider = result.provider
        row.provider_model = result.model
        row.provider_api_version = result.api_version
        row.normalized = result.normalized_dict()
        row.raw_response = result.raw
        overall = result.overall_confidence
        row.overall_confidence = None if overall is None else Decimal(str(overall))
        row.processing_ms = result.processing_ms
        row.completed_at = dt.datetime.now(dt.timezone.utc)
        db.commit()
    finally:
        db.close()


def _record_failure(db: Session, row: PassportOcrExtraction, code: str, detail: str) -> None:
    row.status = OcrStatus.FAILED
    row.error_code = code
    # Truncated: a provider can return a paragraph, and this is shown to a
    # merchant. The full picture is in the application log.
    row.error_detail = (detail or "")[:500]
    row.completed_at = dt.datetime.now(dt.timezone.utc)
    db.commit()


# ---------------------------------------------------------------------------
# Reading the scan back
# ---------------------------------------------------------------------------
def open_scan(db: Session, actor: User, extraction_id: int) -> tuple[BinaryIO, PassportOcrExtraction]:
    """Open the stored passport image, after re-checking scope.

    NO PRESIGNED URL, DELIBERATELY — the same decision ``document_service``
    documents for booking documents. A signed URL is a bearer token for a
    passport scan that keeps working after the session that minted it has ended,
    cannot be revoked, and travels in browser history and referrer headers.
    Proxying through this endpoint means every single read re-checks who is
    asking, which is strictly stronger than a URL that was checked once.
    """
    row = get_extraction(db, actor, extraction_id)
    try:
        stream = storage.backend.open(storage.validate_key(row.stored_path))
    except storage.InvalidDocumentKey:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Invalid document path"
        ) from None
    except storage.DocumentBytesMissing:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="The stored scan for this extraction is missing.",
        ) from None
    return stream, row


def for_request(db: Session, actor: User, request_id: int) -> list[PassportOcrExtraction]:
    """Every scan attached to one booking. What the Admin review panel reads."""
    request = db.scalars(
        select(ServiceRequest).where(
            and_(
                ServiceRequest.request_id == request_id,
                ticket_service.scoped_query(actor),
            )
        )
    ).first()
    if not request:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Request not found"
        )
    return list(
        db.scalars(
            select(PassportOcrExtraction)
            .where(PassportOcrExtraction.request_id == request_id)
            .order_by(PassportOcrExtraction.extraction_id)
        ).all()
    )


# ---------------------------------------------------------------------------
# Duplicate traveller
# ---------------------------------------------------------------------------
def duplicate_for(db: Session, actor: User, extraction: PassportOcrExtraction) -> PassengerData | None:
    """Has this merchant sent this passport before?

    Reuses ``ticket_service.lookup_passenger`` rather than querying here — that
    function is the platform's one answer to "do we know this passport", it is
    already merchant-scoped, already refuses short numbers that would leak by
    enumeration, and is already covered by ``tests/verify_passenger_lookup.py``.
    A second query would be a second set of those decisions to keep in step.

    Returns the row so the caller can OFFER it. Nothing is written, nothing is
    merged, and no passenger record is created or updated — which is how "never
    create duplicate passenger records without user confirmation" is satisfied
    by construction rather than by a rule somebody has to remember.
    """
    field = (extraction.normalized or {}).get("passport_number") or {}
    number = (field.get("value") or "").strip()
    if not number:
        return None
    return ticket_service.lookup_passenger(db, actor, number)


# ---------------------------------------------------------------------------
# Passport validity
# ---------------------------------------------------------------------------
def assess_passport(
    expiry: dt.date | str | None, travel_date: dt.date | str | None
) -> dict[str, Any]:
    """Is this passport usable for this journey?

    NO LONGER ADVISORY (changed 2026-08-07 by change request).
    Two rules are checked: the passport must not be expired, and it must stay
    valid for ``passport_validity_months`` beyond the travel date — the
    near-universal carrier and immigration requirement. Both are now *enforced*
    at submission by ``ticket_service._validate_classic_submission``, so both
    come back here at ``severity: "error"``.

    CR-8 shipped the six-month figure as a warning on purpose: turning it into a
    refusal changed approved submit behaviour for every international booking on
    the platform, which was a change request in its own right rather than
    something a scanning feature could decide. That change request has now been
    made, so the panel and the submit rule agree again — this reports what the
    server will actually do, which is the only useful thing a pre-flight check
    can say. The figure and the arithmetic live in ``passport_rules``.
    """
    result: dict[str, Any] = {
        "checked": False, "valid": True, "severity": "ok",
        "message": None, "expires_on": None, "required_until": None,
    }
    expiry_date = _as_date(expiry)
    if expiry_date is None:
        return result
    result["checked"] = True
    result["expires_on"] = expiry_date.isoformat()

    today = dt.date.today()
    if expiry_date <= today:
        result.update(
            valid=False, severity="error",
            message=f"This passport expired on {expiry_date:%d %b %Y}.",
        )
        return result

    travel = _as_date(travel_date)
    if travel is None:
        # No journey to measure against yet — the merchant has not picked dates.
        # Reporting "valid" here is honest: the only rule we can check passed.
        return result

    if expiry_date <= travel:
        result.update(
            valid=False, severity="error",
            message=(
                f"This passport expires on {expiry_date:%d %b %Y}, on or before "
                f"the travel date ({travel:%d %b %Y})."
            ),
        )
        return result

    required = passport_rules.add_months(travel, passport_rules.validity_months())
    result["required_until"] = required.isoformat()
    if expiry_date < required:
        result.update(
            valid=False, severity="error",
            # No "cannot be submitted" tail here: the merchant portal appends
            # exactly that sentence to any `error` (clOcrValidity), and a
            # message carrying it too would say it twice in one note.
            message=(
                f"This passport expires on {expiry_date:%d %b %Y}, less than "
                f"{passport_rules.validity_months()} months after travel. "
                f"{passport_rules.SIX_MONTH_MESSAGE}"
            ),
        )
    return result


# Both of these moved to ``passport_rules`` when the six-month figure stopped
# being this file's private business and became the rule the submit path
# enforces. Kept as aliases rather than call-site edits: everything above reads
# `_as_date` and there is exactly one definition to be wrong.
_as_date = passport_rules.as_date
_add_months = passport_rules.add_months


# ---------------------------------------------------------------------------
# The manual-edit audit
# ---------------------------------------------------------------------------
def record_edits(
    db: Session,
    actor: User,
    extraction_id: int,
    *,
    values: dict[str, str | None],
    request_id: int | None = None,
    passenger_id: int | None = None,
) -> list[PassportOcrFieldEdit]:
    """Record where the merchant's saved values differ from what OCR read.

    Called with the passenger as the merchant saved it. Only the DIFFERENCES
    become rows: "OCR read JOHN, the merchant saved JOHNN" is what an
    investigation asks about, and a row per unchanged field would bury it. The
    database enforces that too (``ck_ocr_edit_is_a_change``), so a client that
    posts its whole form cannot fill the audit with noise.

    Also the moment the scan learns which booking and traveller it became, which
    is what lets the Admin panel show it. Both stay NULL if the merchant scanned
    and never saved — an extraction is valid with neither.
    """
    row = get_extraction(db, actor, extraction_id)
    if row.merchant_id != actor.merchant_id:
        # Staff may READ an attached extraction; only its owner may write to it.
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only the merchant that scanned this passport can update it.",
        )

    if request_id is not None:
        if not db.scalars(
            select(ServiceRequest.request_id).where(
                and_(
                    ServiceRequest.request_id == request_id,
                    ticket_service.scoped_query(actor),
                )
            )
        ).first():
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Request not found"
            )
        row.request_id = request_id
    if passenger_id is not None:
        # Checked against the request's own travellers, so an id from another
        # booking cannot be attached here.
        owner = db.scalars(
            select(PassengerData).where(PassengerData.passenger_id == passenger_id)
        ).first()
        if owner is None or owner.merchant_id != actor.merchant_id:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="That passenger is not on this merchant's booking",
            )
        row.passenger_id = passenger_id

    normalized = row.normalized or {}
    # Replaced rather than appended: a merchant who saves the same passenger
    # three times must not produce three copies of the same edit. The audit
    # answers "what did they change", not "how many times did they press Save".
    for existing in list(row.edits):
        db.delete(existing)
    db.flush()

    created: list[PassportOcrFieldEdit] = []
    for field in passport_ocr.PASSPORT_FIELDS:
        if field not in values:
            continue
        ocr_field = normalized.get(field) or {}
        ocr_value = _blank_to_none(ocr_field.get("value"))
        edited_value = _blank_to_none(values.get(field))
        if ocr_value == edited_value:
            continue
        confidence = ocr_field.get("confidence")
        edit = PassportOcrFieldEdit(
            extraction_id=row.extraction_id,
            field_name=field,
            ocr_value=ocr_value,
            edited_value=edited_value,
            ocr_confidence=None if confidence is None else Decimal(str(confidence)),
            edited_by=actor.user_id,
        )
        db.add(edit)
        created.append(edit)

    db.commit()
    db.refresh(row)

    if created:
        activity_service.log_activity(
            db, actor.user_id, "Passport OCR values edited",
            activity_type="Document", module="Booking Request",
            description=(
                f"{actor.full_name} changed {len(created)} field"
                f"{'' if len(created) == 1 else 's'} read from a passport scan"
            ),
            reference_id=row.extraction_id, merchant_id=row.merchant_id,
            details={
                "extraction_id": row.extraction_id,
                "request_id": row.request_id,
                "fields": [e.field_name for e in created],
            },
        )
    return list(row.edits)


def _blank_to_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
