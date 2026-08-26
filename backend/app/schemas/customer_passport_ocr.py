"""Request/response shapes for the customer-facing passport scan.

Deliberately thin next to ``app.schemas.passport_ocr`` (the merchant portal's
schema module): there is no extraction id, no request/passenger id, no
provider name anywhere in here. A customer scan is not a row anyone looks up
later — it is one upload, one answer, and the traveller decides what to keep
by editing the form it filled in. See ``customer_passport_ocr_service`` for
why.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

#: The ``TravellerBase`` columns a passport scan can fill (see
#: ``customer_booking.py``). Deliberately a subset of the OCR engine's own
#: ``PASSPORT_FIELDS`` — ``place_of_birth``, ``passport_type``,
#: ``passport_issue_date`` and ``mrz`` have no field on this form to land in,
#: because the customer traveller form was never built with the merchant
#: form's extra columns.
CUSTOMER_PASSPORT_FIELDS = (
    "title",
    "first_name",
    "last_name",
    "gender",
    "date_of_birth",
    "nationality",
    "passport_number",
    "issuing_country",
    "passport_expiry",
)


class OcrAvailabilityOut(BaseModel):
    """Answer to 'should the traveller step offer a Scan control at all?'

    No configuration detail, no provider name — a customer who sees
    ``available: false`` should see no Scan button, not a diagnosis of why.
    """

    available: bool


class ExtractedFieldOut(BaseModel):
    value: str
    confidence: float | None = None
    band: Literal["high", "medium", "low", "unknown"] = "unknown"


class PassportValidityOut(BaseModel):
    checked: bool = False
    valid: bool = True
    severity: str = "ok"
    message: str | None = None
    expires_on: str | None = None
    required_until: str | None = None


class PassportExtractionOut(BaseModel):
    """What the traveller step gets back to prefill the form.

    ``fields`` only contains keys the scan actually read — a field the
    provider could not find is simply absent, exactly as the OCR engine
    represents it, so the frontend's "only fill blanks" rule has nothing to
    overwrite with an empty guess.
    """

    fields: dict[str, ExtractedFieldOut]
    overall_confidence: float | None = None
    validity: PassportValidityOut
