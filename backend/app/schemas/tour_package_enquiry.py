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

STATUSES = ("NEW", "CONTACTED", "CLOSED")


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
