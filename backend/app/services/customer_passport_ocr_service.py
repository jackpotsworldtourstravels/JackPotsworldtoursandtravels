"""Passport scanning for the B2C traveller step.

WHERE THIS SITS, AND WHY IT IS NOT ``passport_ocr_service``
That module owns the merchant portal's scan: a stored row, a background
worker + poll for a slow read, a duplicate-passenger lookup scoped to a
merchant, and an audit of what a merchant changed afterwards. None of that
exists for a customer — there is no draft, no admin desk, no request or
passenger id to hang a row on. What *is* shared is the vendor-agnostic engine
underneath both features (:mod:`app.services.passport_ocr`) and two of
``passport_ocr_service``'s pure helpers (``band_for``, ``assess_passport``),
imported below rather than re-implemented, so the confidence thresholds and
the validity rule cannot drift between the two portals.

SCANNING IS STILL A SHORTCUT HERE, TOO. It writes nothing to the database —
the traveller's own Save does that, unchanged — and every failure path
returns a message the form can show without blocking manual entry.

THE IMAGE IS NEVER STORED. It is read into memory, handed to the provider,
and discarded when the request ends. Nothing about the customer flow needs to
re-display a scan later the way the Admin desk sometimes needs to on the
merchant side, and not keeping a copy of an uploaded passport is the safer
default absent that need.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

from fastapi import HTTPException, UploadFile, status as http_status

from app.config import settings
from app.schemas.customer_passport_ocr import (
    ExtractedFieldOut,
    PassportExtractionOut,
    PassportValidityOut,
)
from app.services import passport_ocr
from app.services.passport_ocr_service import assess_passport, band_for

logger = logging.getLogger(__name__)

#: One vendor call per request, so a burst of scans cannot exhaust the
#: connection pool the way an unbounded one could — same reasoning as the
#: merchant side's pool, sized down because this path has no queue to hold
#: work for later; a caller that cannot get a slot fails the same request.
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="customer-passport-ocr")

#: The OCR engine's field name -> the customer traveller form's field name.
#: ``place_of_birth``, ``passport_type``, ``passport_issue_date`` and ``mrz``
#: have no home on this form (see ``CUSTOMER_PASSPORT_FIELDS``) and are
#: dropped rather than mapped.
_FIELD_MAP = {
    "title": "title",
    "first_name": "first_name",
    "last_name": "last_name",
    "gender": "gender",
    "dob": "date_of_birth",
    "nationality": "nationality",
    "passport_number": "passport_number",
    "passport_issue_country": "issuing_country",
    "passport_expiry": "passport_expiry",
}

_ALLOWED_CONTENT_TYPES = (
    "application/pdf", "image/jpeg", "image/png", "image/webp",
)

#: Read in chunks so a large upload never lands in memory all at once before
#: the size cap has had a chance to reject it.
_CHUNK = 64 * 1024


def is_available() -> bool:
    return passport_ocr.is_available()


def _read_upload(upload_file: UploadFile) -> bytes:
    declared = (upload_file.content_type or "").split(";")[0].strip().lower()
    if declared not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"'{declared or 'unknown'}' files are not accepted. Upload a PDF, JPEG, PNG or WebP.",
        )

    chunks: list[bytes] = []
    size = 0
    while chunk := upload_file.file.read(_CHUNK):
        size += len(chunk)
        if size > settings.max_upload_bytes:
            raise HTTPException(
                status_code=http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Files must be {settings.max_upload_mb} MB or smaller.",
            )
        chunks.append(chunk)
    if size == 0:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail="That file is empty.")
    return b"".join(chunks)


def extract(upload_file: UploadFile, travel_date=None) -> PassportExtractionOut:
    """Read a passport and return what could be filled in.

    ``travel_date`` is optional context for the validity check only — the
    traveller step already enforces the six-month rule itself once a flight
    is chosen, so a missing date here just means the validity block comes
    back unchecked rather than blocking anything.
    """
    try:
        provider = passport_ocr.get_provider()
    except passport_ocr.OCRNotConfigured:
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Passport scanning isn't available right now. Please enter the details by hand.",
        )

    content = _read_upload(upload_file)
    content_type = (upload_file.content_type or "").split(";")[0].strip().lower()

    future = _POOL.submit(provider.extract, content, content_type)
    try:
        result = future.result(timeout=settings.ocr_timeout_seconds)
    except FutureTimeoutError:
        future.cancel()
        raise HTTPException(
            status_code=http_status.HTTP_504_GATEWAY_TIMEOUT,
            detail="That scan is taking too long. Please try again or enter the details by hand.",
        )
    except passport_ocr.OCRError as exc:
        logger.info("customer passport OCR failed: %s", exc)
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc) or "We couldn't read that passport clearly. Try a clearer photo, or enter the details by hand.",
        )
    except Exception:
        logger.exception("customer passport OCR: unexpected provider failure")
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="We couldn't read that passport clearly. Try a clearer photo, or enter the details by hand.",
        )

    fields: dict[str, ExtractedFieldOut] = {}
    for ocr_name, customer_name in _FIELD_MAP.items():
        field = result.fields.get(ocr_name)
        if field is None or not field.value:
            continue
        fields[customer_name] = ExtractedFieldOut(
            value=field.value, confidence=field.confidence, band=band_for(field.confidence),
        )

    expiry = fields.get("passport_expiry")
    validity_raw = assess_passport(expiry.value if expiry else None, travel_date)

    return PassportExtractionOut(
        fields=fields,
        overall_confidence=result.overall_confidence,
        validity=PassportValidityOut(**validity_raw),
    )
