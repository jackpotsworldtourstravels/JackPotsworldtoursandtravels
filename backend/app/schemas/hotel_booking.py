"""Hotel Booking — turning a quoted hotel enquiry into a service_requests row.

Deliberately not in ``schemas/hotel_enquiry.py``: that module's own docstring
says Hotel stops at quotation, and this is the schema for the step that
proves it no longer does. It also isn't in ``schemas/enquiry.py`` — Flight's
booking schemas assume a journey and passengers; a hotel booking has neither,
it has a stay and guests. See ``services/hotel_booking_service.py`` for how
this feeds the conversion, and migration 0048's docstring for why guests are
a new table rather than a reuse of ``PassengerData``.
"""
import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models_v2 import PassengerType
from app.schemas.common import BookingContact
from app.schemas.hotel_enquiry import HotelEnquiryCreate


class HotelGuestInput(BaseModel):
    """One guest on a hotel booking, mirroring ``HotelRoomInput``'s age rule.

    ``room_number`` ties a guest back to a specific room the enquiry already
    committed to — the booking screen cannot invent a room the enquiry never
    asked about, only fill in who is staying in each one.
    """

    room_number: int = Field(ge=1)
    is_lead_guest: bool = False
    title: str | None = Field(default=None, max_length=10)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    guest_type: PassengerType = PassengerType.ADULT
    #: Child guests only — validated below against ``guest_type``.
    age: int | None = Field(default=None, ge=0, le=17)
    id_proof_type: str | None = Field(default=None, max_length=40)
    id_proof_number: str | None = Field(default=None, max_length=60)

    @field_validator("title", "id_proof_type", "id_proof_number", mode="before")
    @classmethod
    def _blank_to_none(cls, v: Any) -> Any:
        if v is None:
            return None
        return str(v).strip() or None

    @model_validator(mode="after")
    def _check_age(self) -> "HotelGuestInput":
        if self.guest_type is PassengerType.CHILD and self.age is None:
            raise ValueError("A child guest needs an age")
        if self.guest_type is not PassengerType.CHILD and self.age is not None:
            raise ValueError("Only a child guest carries an age")
        return self


class HotelGuestResponse(HotelGuestInput):
    id: int

    @classmethod
    def of(cls, g) -> "HotelGuestResponse":
        return cls(
            id=g.id,
            room_number=g.room_number,
            is_lead_guest=g.is_lead_guest,
            title=g.title,
            first_name=g.first_name,
            last_name=g.last_name,
            guest_type=g.guest_type,
            age=g.age,
            id_proof_type=g.id_proof_type,
            id_proof_number=g.id_proof_number,
        )


def _check_exactly_one_lead(guests: list[HotelGuestInput]) -> None:
    """Shared by every schema that carries a guest list — enquiry-led or
    direct. Exactly one guest across the whole booking is the lead, the one
    the hotel checks the reservation in against."""
    leads = sum(1 for g in guests if g.is_lead_guest)
    if leads != 1:
        raise ValueError(
            "Exactly one guest must be marked as the lead guest for the booking"
        )


class HotelEnquiryToBooking(BaseModel):
    """Turn an approved, quoted hotel enquiry into a draft booking request.

    The stay itself is not here: destination, hotel, dates, room/child
    composition are all copied from the enquiry server-side (see
    ``hotel_booking_service.to_booking_request``), so this screen cannot
    submit a stay the Admin never quoted. What the merchant adds is who is
    staying, who to contact, and anything special about the party — the same
    shape ``EnquiryToBooking`` adds on the Flight side.
    """

    guests: list[HotelGuestInput] = Field(min_length=1)
    remarks: str | None = Field(default=None, max_length=1000)
    contact: BookingContact | None = None
    special_requests: str | None = Field(default=None, max_length=1000)
    #: What the merchant is charging its OWN customer (mirrors
    #: ``EnquiryToBooking.client_fare``). ``None`` leaves it unset.
    client_fare: Decimal | None = Field(default=None, ge=0, le=Decimal("9999999999.99"))

    @model_validator(mode="after")
    def _exactly_one_lead_guest(self) -> "HotelEnquiryToBooking":
        _check_exactly_one_lead(self.guests)
        return self


class DirectHotelBookingCreate(HotelEnquiryCreate):
    """Book Directly for Hotel — no enquiry, no quotation, in front first.

    Subclasses ``HotelEnquiryCreate`` rather than restating its fields: the
    stay is described the same way whether or not a quotation was asked for
    first, so the check-in/check-out chronology rule, the PAN format check
    and ``HotelRoomInput``'s own room/child-age validator are the *same*
    validators, not a second copy of them that drifts — the same reason
    Flight's ``DirectBookingCreate`` subclasses ``EnquiryCreate`` rather than
    duplicating the itinerary fields.

    THERE IS NO PRICE HERE, AND THAT IS THE POINT (mirrors
    ``DirectBookingCreate``'s own docstring). This stay has never been
    quoted, so the booking is created at ``0`` and the fare is captured
    where it always is for an unpriced booking — at voucher issuance, by
    ``ticket_service._capture_fare_for_wallet_billing`` (fully generic over
    travel_type, confirmed — no change needed there for this feature).
    """

    guests: list[HotelGuestInput] = Field(min_length=1)
    remarks: str | None = Field(default=None, max_length=1000)
    contact: BookingContact | None = None
    special_requests: str | None = Field(default=None, max_length=1000)
    #: What the merchant is charging its OWN customer (mirrors
    #: ``HotelEnquiryToBooking.client_fare``).
    client_fare: Decimal | None = Field(default=None, ge=0, le=Decimal("9999999999.99"))
    #: Raise it in front of the Manager in the same call — mirrors
    #: ``DirectBookingCreate.submit``. The Classic portal always sends
    #: ``false`` and calls ``POST /api/requests/{id}/submit`` separately, but
    #: the field exists for any caller that wants the one-call path.
    submit: bool = False

    @model_validator(mode="after")
    def _exactly_one_lead_guest(self) -> "DirectHotelBookingCreate":
        _check_exactly_one_lead(self.guests)
        return self


class HotelBookingResponse(BaseModel):
    """What the merchant sees immediately after raising a hotel booking.

    Deliberately thin — the full detail view for a hotel booking is the same
    ``RequestResponse`` every other request type renders through (see
    ``schemas/ticket.py``'s ``hotel_guests`` field), so this is just the
    confirmation payload the Raise Booking screen redirects on.
    """

    request_id: int
    request_number: str
    status: str
    destination_city: str
    check_in: datetime.date
    check_out: datetime.date
    total_amount: Decimal
    guests: list[HotelGuestResponse]
