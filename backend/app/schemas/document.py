"""Schemas for booking-request documents.

``stored_path`` is deliberately absent from every response: it is a server-side
filesystem location and a client has no use for it. Files are fetched by id
through the authenticated download endpoint, never by path.
"""
import datetime

from pydantic import BaseModel, Field

#: Module level, not a class attribute: Pydantic turns any underscore-prefixed
#: class attribute into a ModelPrivateAttr, so `cls._LABELS.get(...)` would
#: raise AttributeError rather than read the dict.
_VERIFICATION_LABELS = {
    "pending": "Awaiting check",
    "verified": "Verified",
    "rejected": "Rejected",
}


class DocumentResponse(BaseModel):
    id: int
    request_id: int
    passenger_id: int | None = None
    doc_type: str
    original_filename: str
    content_type: str
    size_bytes: int

    verification_status: str
    verification_label: str
    rejection_reason: str | None = None
    verified_at: datetime.datetime | None = None
    verified_by_name: str | None = None

    uploaded_by_name: str | None = None
    created_at: datetime.datetime

    @classmethod
    def of(cls, d, *, uploader: str | None = None, verifier: str | None = None) -> "DocumentResponse":
        status = d.verification_status.value
        return cls(
            id=d.document_id,
            request_id=d.request_id,
            passenger_id=d.passenger_id,
            doc_type=d.doc_type.value,
            original_filename=d.original_filename,
            content_type=d.content_type,
            size_bytes=d.size_bytes,
            verification_status=status,
            verification_label=_VERIFICATION_LABELS.get(status, status),
            rejection_reason=d.rejection_reason,
            verified_at=d.verified_at,
            verified_by_name=verifier,
            uploaded_by_name=uploader,
            created_at=d.created_at,
        )


class DocumentVerifyRequest(BaseModel):
    #: True marks the document verified; False rejects it and needs a reason.
    approved: bool
    reason: str | None = Field(default=None, max_length=500)
