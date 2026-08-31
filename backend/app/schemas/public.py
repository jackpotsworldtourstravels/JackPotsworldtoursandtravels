"""Requests raised from public, unauthenticated pages (the landing page's own
forms) rather than from inside any portal."""
import datetime

from pydantic import BaseModel, EmailStr, Field, model_validator


class ContactFormRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    subject: str | None = Field(default=None, max_length=200)
    message: str = Field(min_length=1, max_length=5000)


class NewsletterSubscribeRequest(BaseModel):
    email: EmailStr


class HotelGroupEnquiryRequest(BaseModel):
    """A "Group Deals" enquiry from the landing page's hotel card.

    Distinct from the merchant-facing hotel enquiry in `schemas/hotel_enquiry`:
    that one belongs to a signed-in company and becomes a tracked request row.
    This is a member of the public asking to be quoted, so it carries its own
    contact details and is delivered as mail rather than persisted."""

    destination: str = Field(min_length=1, max_length=200)
    check_in: datetime.date
    check_out: datetime.date
    #: Above the standard flow's 4-room cap — that ceiling is the whole reason
    #: this is a separate mode. The upper bound is commercial, not technical.
    rooms: int = Field(ge=1, le=200)
    guests: int = Field(ge=1, le=2000)

    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    phone: str = Field(min_length=6, max_length=40)

    company: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_dates(self):
        if self.check_out <= self.check_in:
            raise ValueError("Check-out must be at least one night after check-in.")
        return self
