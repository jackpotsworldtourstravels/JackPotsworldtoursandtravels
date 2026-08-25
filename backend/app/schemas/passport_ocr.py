"""Schemas for passport OCR.

TWO THINGS ARE DELIBERATELY ABSENT FROM EVERY RESPONSE HERE.

``stored_path`` — the scan's key in storage, for the same reason
``DocumentResponse`` omits it: a client fetches the image by extraction id
through the authenticated proxy, never by path, and a path is a server-side
detail that only becomes a liability once it is published.

``raw_response`` — the provider's untouched reply. It is stored (debugging a
normalisation bug needs it) and it is shown to platform staff on the Admin panel
(that is what "View OCR Data" is), but it is not in the merchant's response.
It can carry vendor-internal identifiers and bounding-box geometry that no
merchant screen uses, and the normalised fields are the whole of what the form
needs. :class:`ExtractionAdminResponse` is the one place it crosses the wire.
"""
from __future__ import annotations

import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.services import passport_ocr_service

_STATUS_LABELS = {
    "queued": "Queued",
    "processing": "Reading the passport…",
    "succeeded": "Read",
    "failed": "Could not be read",
}


class ExtractedFieldOut(BaseModel):
    """One field, its score, and the band that score falls in.

    The band is computed server-side rather than left to each client. Two
    screens read this — the merchant's form and the Admin's review panel — and a
    threshold duplicated in two stylesheets is how a field ends up green on one
    and orange on the other.
    """

    value: str
    confidence: float | None = None
    #: high (>=95%) · medium (80–94%) · low (<80%) · unknown (unscored)
    band: str


class PassportValidityOut(BaseModel):
    checked: bool
    valid: bool
    #: ok · warning · error. `warning` is the six-month rule, which is advisory:
    #: it is never enforced at submission — see passport_ocr_service.assess_passport.
    severity: str
    message: str | None = None
    expires_on: datetime.date | None = None
    required_until: datetime.date | None = None


class DuplicatePassengerOut(BaseModel):
    """A traveller this merchant has already sent on this passport number.

    Carries no passenger id on purpose. The merchant's choice is Use / Update /
    Create New, and all three are satisfied by filling the form — the booking
    creates its own passenger row exactly as it always has. Returning an id
    would invite a caller to link to it, which is the duplicate-record problem
    this is supposed to prevent.
    """

    found: bool = False
    full_name: str | None = None
    last_used: datetime.datetime | None = None
    fields: dict[str, Any] = Field(default_factory=dict)


class ExtractionResponse(BaseModel):
    """What the merchant portal gets back from a scan or a poll."""

    id: int
    status: str
    status_label: str
    provider: str
    #: True only for a row written BEFORE the fabricating provider was removed.
    #: No live extraction can set this any more — every provider now reads the
    #: uploaded document — but those rows are still attached to real bookings,
    #: and a screen that showed one as an ordinary read would be presenting an
    #: invented passenger as a scanned one. Kept for exactly that reason.
    simulated: bool = False

    fields: dict[str, ExtractedFieldOut] = Field(default_factory=dict)
    overall_confidence: float | None = None
    #: The thresholds the bands were computed from, so a client can label them
    #: ("95%+") without hard-coding a second copy of the numbers.
    confidence_bands: dict[str, float] = Field(
        default_factory=lambda: dict(passport_ocr_service.CONFIDENCE_BANDS)
    )

    validity: PassportValidityOut | None = None
    duplicate: DuplicatePassengerOut | None = None

    processing_ms: int | None = None
    error_code: str | None = None
    error_detail: str | None = None
    created_at: datetime.datetime
    completed_at: datetime.datetime | None = None

    @classmethod
    def of(
        cls,
        row,
        *,
        validity: dict[str, Any] | None = None,
        duplicate: DuplicatePassengerOut | None = None,
    ) -> "ExtractionResponse":
        status = row.status.value
        fields = {
            name: ExtractedFieldOut(
                value=str(payload.get("value", "")),
                confidence=payload.get("confidence"),
                band=passport_ocr_service.band_for(payload.get("confidence")),
            )
            for name, payload in (row.normalized or {}).items()
            if isinstance(payload, dict) and payload.get("value") not in (None, "")
        }
        return cls(
            id=row.extraction_id,
            status=status,
            status_label=_STATUS_LABELS.get(status, status),
            provider=row.provider,
            simulated=row.provider == "simulated",
            fields=fields,
            overall_confidence=(
                float(row.overall_confidence) if row.overall_confidence is not None else None
            ),
            validity=PassportValidityOut(**validity) if validity else None,
            duplicate=duplicate,
            processing_ms=row.processing_ms,
            error_code=row.error_code,
            error_detail=row.error_detail,
            created_at=row.created_at,
            completed_at=row.completed_at,
        )


class FieldEditOut(BaseModel):
    field_name: str
    ocr_value: str | None = None
    edited_value: str | None = None
    ocr_confidence: float | None = None
    edited_by_name: str | None = None
    edited_at: datetime.datetime

    @classmethod
    def of(cls, e, *, editor: str | None = None) -> "FieldEditOut":
        return cls(
            field_name=e.field_name,
            ocr_value=e.ocr_value,
            edited_value=e.edited_value,
            ocr_confidence=float(e.ocr_confidence) if e.ocr_confidence is not None else None,
            edited_by_name=editor,
            edited_at=e.edited_at,
        )


class ExtractionAdminResponse(ExtractionResponse):
    """The desk's view: everything above, plus the provider's own words.

    ``raw_response`` is here and nowhere else. It is what "View OCR Data" shows,
    and it is the difference between an admin who can say "the provider read the
    expiry as 2013 with 41% confidence" and one who can only say "the merchant
    typed something different".
    """

    passenger_id: int | None = None
    provider_model: str | None = None
    provider_api_version: str | None = None
    raw_response: dict[str, Any] | None = None
    edits: list[FieldEditOut] = Field(default_factory=list)
    uploaded_by_name: str | None = None
    original_filename: str
    content_type: str
    size_bytes: int

    @classmethod
    def of_admin(
        cls,
        row,
        *,
        uploader: str | None = None,
        editors: dict[int, str] | None = None,
        validity: dict[str, Any] | None = None,
    ) -> "ExtractionAdminResponse":
        base = ExtractionResponse.of(row, validity=validity).model_dump()
        editors = editors or {}
        return cls(
            **base,
            passenger_id=row.passenger_id,
            provider_model=row.provider_model,
            provider_api_version=row.provider_api_version,
            raw_response=row.raw_response,
            edits=[
                FieldEditOut.of(e, editor=editors.get(e.edited_by)) for e in row.edits
            ],
            uploaded_by_name=uploader,
            original_filename=row.original_filename,
            content_type=row.content_type,
            size_bytes=row.size_bytes,
        )


class RecordEditsRequest(BaseModel):
    """The passenger as the merchant actually saved it.

    Sent whole rather than as a diff: the client does not have to work out what
    changed, and the server is the only place that knows what OCR originally
    read. Fields absent from ``values`` are ignored rather than treated as
    cleared, so a caller that only sends what it collected cannot silently
    record eight deletions.
    """

    values: dict[str, str | None]
    #: Both optional. Supplied once the merchant has saved, to tell the scan
    #: which booking and traveller it became — which is what puts it in front of
    #: the Admin. A scan that is never saved keeps both NULL, and that is valid.
    request_id: int | None = None
    passenger_id: int | None = None


class OcrAvailabilityResponse(BaseModel):
    """Whether to offer the Scan control at all.

    Read by the merchant portal on load. A deployment with no OCR provider
    renders no button rather than one that fails when pressed.
    """

    available: bool
    provider: str | None = None
    simulated: bool = False
    #: Set only when a provider was SELECTED and cannot run — a missing Azure
    #: key, or `simulated` without its second variable. ``available: false`` with
    #: this empty means scanning is deliberately off; with this set it means
    #: somebody needs to fix a deployment. The merchant portal shows the same
    #: "no scanning here" either way; this exists so the fault is visible to
    #: whoever asks the API rather than only in a server log.
    configuration_error: str | None = None
    max_upload_mb: int
    accepted_types: list[str]
    confidence_bands: dict[str, float]
    passport_validity_months: int
