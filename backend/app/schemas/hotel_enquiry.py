"""Hotel Enquiry — schemas for the standalone hotel_enquiries tables.

Deliberately not part of ``schemas/enquiry.py``: Hotel now has its own tables
(migration 0047), so it gets its own request/response shapes rather than a
branch of Flight's discriminated union. ``HotelEnquiryResponse`` still mirrors
``EnquiryResponse``'s field *names* where the concepts overlap (reference_number,
travel_date/return_date for check-in/out, notes for special requirements) —
that's what lets the merchant and admin portals render a hotel row with almost
the same code path as a flight row, even though the two are unrelated tables
underneath.
"""
import datetime
import re
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

#: Standard PAN structure (5 letters, 4 digits, 1 letter).
_PAN_PATTERN = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")

StarCategory = Literal["3", "4", "5"]
MealPlan = Literal["breakfast", "half_board", "full_board"]
MEAL_PLAN_LABELS = {"breakfast": "Breakfast", "half_board": "Half Board", "full_board": "Full Board"}


class HotelRoomInput(BaseModel):
    """One room in the Rooms & Guests selector.

    ``child_ages`` must list exactly one age per child — the popover collects
    an age selector per child once the count goes above zero, and a mismatch
    here means the draft and its committed count disagreed.
    """

    adults: int = Field(ge=1)
    children: int = Field(default=0, ge=0)
    child_ages: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> "HotelRoomInput":
        if len(self.child_ages) != self.children:
            raise ValueError(
                f"This room says {self.children} child(ren) but "
                f"{len(self.child_ages)} age(s) were given"
            )
        for age in self.child_ages:
            if not (0 <= age <= 17):
                raise ValueError("A child's age must be between 0 and 17")
        return self


class HotelEnquiryCreate(BaseModel):
    """The Hotel Enquiry form."""

    destination_city: str = Field(min_length=1, max_length=120)
    check_in: datetime.date
    check_out: datetime.date

    rooms: list[HotelRoomInput] = Field(min_length=1)

    hotel_name: str | None = Field(default=None, max_length=200)
    star_category: StarCategory
    room_type: str | None = Field(default=None, max_length=120)
    meal_plan: MealPlan
    preferred_location: str | None = Field(default=None, max_length=200)
    pan: str | None = Field(default=None, max_length=10)
    special_requirements: str | None = Field(default=None, max_length=1000)

    @field_validator("hotel_name", "room_type", "preferred_location", "special_requirements",
                      mode="before")
    @classmethod
    def _blank_to_none(cls, v: Any) -> Any:
        if v is None:
            return None
        return str(v).strip() or None

    @field_validator("pan", mode="before")
    @classmethod
    def _normalise_pan(cls, v: Any) -> Any:
        if v is None:
            return None
        text = str(v).strip().upper()
        return text or None

    @field_validator("pan")
    @classmethod
    def _check_pan_format(cls, v: str | None) -> str | None:
        if v is not None and not _PAN_PATTERN.match(v):
            raise ValueError("PAN should look like ABCDE1234F")
        return v

    @model_validator(mode="after")
    def _check(self) -> "HotelEnquiryCreate":
        if self.check_in < datetime.date.today():
            raise ValueError("Check-in date cannot be in the past")
        # Strictly after, not on-or-after: a stay is at least one night
        # (same-day hotel bookings are not supported in this phase).
        if self.check_out <= self.check_in:
            raise ValueError("Check-out date must be after the check-in date")
        return self


class HotelEnquiryRespond(BaseModel):
    """The Admin's answer — Send Quotation, or decline. Mirrors EnquiryRespond."""

    available: bool
    total_fare: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    reason: str | None = Field(default=None, max_length=2000)
    response: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check(self) -> "HotelEnquiryRespond":
        if not self.available:
            if self.total_fare is not None:
                raise ValueError(
                    "A declined enquiry cannot carry a total fare — there is nothing to quote"
                )
            return self
        if self.total_fare is None or self.total_fare <= 0:
            raise ValueError(
                "Enter the total fare being quoted. It becomes the amount the "
                "merchant is billed, so a quotation of 0 bills nobody"
            )
        if not (self.reason or "").strip() and not (self.response or "").strip():
            raise ValueError(
                "Add the remarks explaining the quotation — what the total is made "
                "up of. The merchant sees this beside the amount"
            )
        return self


class HotelEnquiryResponse(BaseModel):
    id: int
    reference_number: str
    status: str
    status_label: str
    #: Literal, not stored — the merchant/admin row renderers branch on this
    #: exactly as they do for a flight row, so both portals need it present
    #: even though there's no travel_type column on this table.
    travel_type: Literal["hotel"] = "hotel"

    destination_city: str
    #: Named to match EnquiryResponse's check-in/out fields (travel_date /
    #: return_date) rather than this table's own column names, so the
    #: merchant/admin list and detail renderers need almost no branching
    #: between a flight row and a hotel row.
    travel_date: datetime.date
    return_date: datetime.date
    nights: int

    rooms: list[HotelRoomInput]
    rooms_count: int
    adults_total: int
    children_total: int

    hotel_name: str | None = None
    star_category: str
    room_type: str | None = None
    meal_plan: str
    preferred_location: str | None = None
    pan: str | None = None
    #: Special Requirements, under EnquiryResponse's "notes" name.
    notes: str | None = None

    admin_response: str | None = None
    rejection_reason: str | None = None
    quoted_fare: Decimal | None = None
    quotation_remarks: str | None = None

    #: Hotel has no client-fare capture on the enquiry itself — that is
    #: entered on the booking screen once raised (mirrors Flight's
    #: EnquiryToBooking.client_fare). Present and always None here so the
    #: shared row/detail renderers, which check this key for a flight row,
    #: don't need a hotel-specific branch.
    client_fare: Decimal | None = None
    saved_amount: Decimal | None = None
    #: Set once Raise Booking has converted this enquiry (migration 0048) —
    #: the merchant/admin row renderers use this to swap Raise Booking for a
    #: link to the booking instead.
    booking_request_id: int | None = None
    booking_request_number: str | None = None

    review_claimed_by: int | None = None
    review_claimed_by_name: str | None = None
    review_claimed_at: datetime.datetime | None = None

    merchant_name: str | None = None
    raised_by: str | None = None
    created_at: datetime.datetime
    responded_at: datetime.datetime | None = None

    @classmethod
    def of(cls, r) -> "HotelEnquiryResponse":
        from app.services.lifecycle import SPEC_LABELS

        rooms = [
            {"adults": room.adults, "children": room.children,
             "child_ages": [c.child_age for c in room.children_ages]}
            for room in r.rooms
        ]
        return cls(
            id=r.id,
            reference_number=r.enquiry_reference,
            status=r.status.value,
            status_label=SPEC_LABELS.get(r.status, r.status.value),
            destination_city=r.destination_city,
            travel_date=r.check_in_date,
            return_date=r.check_out_date,
            nights=r.number_of_nights,
            rooms=rooms,
            rooms_count=len(rooms),
            adults_total=sum(room["adults"] for room in rooms),
            children_total=sum(room["children"] for room in rooms),
            hotel_name=r.hotel_name,
            star_category=r.star_category,
            room_type=r.room_type,
            meal_plan=r.meal_plan,
            preferred_location=r.preferred_location,
            pan=r.pan,
            notes=r.special_requirements,
            admin_response=r.admin_response,
            rejection_reason=r.rejection_reason,
            quoted_fare=r.quoted_fare,
            quotation_remarks=r.quotation_remarks,
            booking_request_id=r.booking_request_id,
            booking_request_number=r.booking_request.request_number if r.booking_request else None,
            review_claimed_by=r.review_claimed_by,
            review_claimed_by_name=r.reviewer.full_name if r.reviewer else None,
            review_claimed_at=r.review_claimed_at,
            merchant_name=r.merchant.company_name if r.merchant else None,
            raised_by=r.user.full_name if r.user else None,
            created_at=r.created_at,
            responded_at=r.responded_at,
        )
