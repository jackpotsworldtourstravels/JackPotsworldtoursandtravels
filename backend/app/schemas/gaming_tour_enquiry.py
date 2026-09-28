"""Gaming Tour Enquiries — the public submission and the Admin queue built on
top of it. See `app.models_v2.GamingTourEnquiry` for why this is its own
table rather than a `HotelEnquiry`-shaped row: there is no merchant behind a
submission, so there is nothing here to bind a wallet or a credit limit to.
"""
import datetime as dt

from pydantic import BaseModel, EmailStr, Field, field_validator

STATUSES = (
    "NEW", "ASSIGNED", "CONTACTED", "QUOTE_PREPARED",
    "CUSTOMER_CONFIRMED", "BOOKING_CREATED", "COMPLETED", "CANCELLED",
)


class GamingTourEnquiryCreate(BaseModel):
    """The public form's payload — no session, no merchant, no booking
    reference: a member of the public asking to be called back about a
    casino trip."""

    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    #: Free-form rather than E.164-validated: an international casino trip is
    #: as likely to be booked from a number this app has no country code
    #: table for as from one it does, and rejecting a real number over
    #: formatting is a worse failure than accepting a loosely-shaped one a
    #: human is about to phone back anyway.
    mobile: str = Field(min_length=6, max_length=30)

    from_airport: str = Field(min_length=1, max_length=120)
    to_airport: str = Field(min_length=1, max_length=120)
    travel_datetime: dt.datetime
    number_of_nights: int = Field(gt=0, le=90)

    #: FREE TEXT, ON PURPOSE. "VIP Casino, Poker, Blackjack, Roulette, Slot
    #: Games" in the brief's own placeholder is not a set of mutually
    #: exclusive options — a real enquiry names several — and the operators
    #: this business actually deals with are decided property by property,
    #: not by a fixed list shipped in this codebase. A dropdown here would be
    #: exactly the kind of hardcoded destination/preference list the rest of
    #: this project deliberately avoids.
    casino_type: str = Field(min_length=1, max_length=300)

    @field_validator("name", "mobile", "from_airport", "to_airport", "casino_type", mode="before")
    @classmethod
    def _strip(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v


class GamingTourEnquiryResponse(BaseModel):
    success: bool = True
    message: str = "Please wait, our team will contact you soon."
    enquiry_reference: str


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
class GamingTourEnquiryAdminItem(BaseModel):
    """One row on the Admin queue's table."""

    id: int
    enquiry_reference: str
    customer_name: str
    email: str
    mobile_number: str
    from_airport: str
    to_airport: str
    travel_datetime: dt.datetime
    number_of_nights: int
    casino_type: str
    status: str
    assigned_admin_id: int | None = None
    assigned_admin_name: str | None = None
    created_at: dt.datetime


class GamingTourEnquiryAdminDetail(GamingTourEnquiryAdminItem):
    admin_notes: str | None = None
    updated_at: dt.datetime


class GamingTourEnquiryUpdate(BaseModel):
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


class GamingTourEnquiryCounts(BaseModel):
    """The dashboard's Gaming Tour Enquiries card and the sidebar badge —
    same shape `EnquiryCounts` already gives the Ticket Enquiry queue."""

    new: int = 0
    open: int = 0  # NEW + ASSIGNED + CONTACTED + QUOTE_PREPARED + CUSTOMER_CONFIRMED
    total: int = 0
