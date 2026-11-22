"""Tour Package Enquiry — the Contact Us page's "Enquire About Dates" form.

Public, no session: the same shape as `schemas/gaming_tour_enquiry.py`, for a
customer asking to be called back about a tour package rather than a casino
trip. See `app.models_v2.TourPackageEnquiry` for why this is its own table.
"""
import datetime as dt

from pydantic import BaseModel, EmailStr, Field, field_validator

#: Reused rather than re-specified — "validate the mobile number per the
#: project's existing customer rules" means the same 8-to-15-digit, optional
#: leading "+" check `CustomerSignupRequest`/`CustomerProfileUpdate` already
#: enforce, not a second regex that could quietly drift from it.
from app.schemas.customer import _clean_mobile

#: The admin workflow (Phase 2 Bug 3). The three original public-form statuses
#: (NEW/CONTACTED/CLOSED) are kept as a subset so existing rows and the DB CHECK
#: stay valid; the rest describe how the desk actually works an enquiry.
STATUSES = ("NEW", "ASSIGNED", "CONTACTED", "QUOTE_SENT", "CONVERTED", "CLOSED", "CANCELLED")

#: Short of a terminal state — what the queue still owes an answer on. Mirrors
#: ``gaming_tour_enquiry_service.OPEN_STATUSES``.
OPEN_STATUSES = ("NEW", "ASSIGNED", "CONTACTED", "QUOTE_SENT")


class TourPackageEnquiryCreate(BaseModel):
    """The Contact Us form's payload.

    ``package_id`` is present when the customer arrived via a package's own
    "Enquire about dates" button, and absent when Contact Us was opened
    directly — in which case ``package_name`` is whatever the customer typed
    by hand. The field itself is always required: an enquiry naming no
    package at all is not answerable by the desk.
    """

    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    mobile: str

    package_id: int | None = Field(default=None, gt=0)
    package_name: str = Field(min_length=1, max_length=200)

    preferred_travel_date: dt.date | None = None
    number_of_travellers: int | None = Field(default=None, gt=0, le=200)

    message: str = Field(min_length=1, max_length=4000)

    @field_validator("name", "package_name", "message", mode="before")
    @classmethod
    def _strip(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v: str) -> str:
        return _clean_mobile(v)


class TourPackageEnquiryResponse(BaseModel):
    success: bool = True
    message: str = "Please wait, our team will contact you soon."
    enquiry_reference: str


# ---------------------------------------------------------------------------
# Admin (Phase 2 Bug 3) — the queue and detail screen. Same shape as
# schemas/gaming_tour_enquiry.py's admin models.
# ---------------------------------------------------------------------------
class TourPackageEnquiryAdminItem(BaseModel):
    """One row on the Admin queue's table."""

    id: int
    enquiry_reference: str
    customer_name: str
    email: str
    mobile_number: str
    package_id: int | None = None
    package_name: str
    preferred_travel_date: dt.date | None = None
    number_of_travellers: int | None = None
    status: str
    assigned_admin_id: int | None = None
    assigned_admin_name: str | None = None
    created_at: dt.datetime


class TourPackageEnquiryAdminDetail(TourPackageEnquiryAdminItem):
    message: str
    admin_notes: str | None = None
    updated_at: dt.datetime


class TourPackageEnquiryUpdate(BaseModel):
    """PATCH body for the detail screen's Save. Every field optional — only
    what the admin actually changed is sent and written."""

    status: str | None = None
    assigned_admin_id: int | None = None
    admin_notes: str | None = Field(default=None, max_length=4000)

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v: str | None) -> str | None:
        if v is not None and v not in STATUSES:
            raise ValueError(f"status must be one of {', '.join(STATUSES)}")
        return v


class TourPackageEnquiryAuditEntry(BaseModel):
    """One row of an enquiry's actor-attributed history (System Logs)."""

    at: dt.datetime
    actor_id: int | None = None
    actor_name: str | None = None
    action: str
    description: str | None = None
    from_status: str | None = None
    to_status: str | None = None


class TourPackageEnquiryCounts(BaseModel):
    """The dashboard card and sidebar badge figures."""

    new: int = 0
    open: int = 0
    total: int = 0
