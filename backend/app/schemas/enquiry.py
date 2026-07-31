"""Schemas for Ticket Enquiry — the merchant's new entry point.

The old flow searched live inventory and raised a request against a priced
catalog row. The new one inverts that: the merchant *describes* the sector it
wants, an Admin answers, and only an answered enquiry can become a booking.

Everything a merchant fills in on the form lands in one place, and validation
that the form enforces client-side is repeated here — a browser is not a
trust boundary, and the "From ≠ To" / "return after departure" rules are the
kind that silently produce nonsense bookings when only the UI checks them.
"""
import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.ticket import PassengerInput

TripType = Literal["one_way", "round_trip"]


class EnquiryCreate(BaseModel):
    """The Enquire Ticket form.

    ``origin`` / ``destination`` carry the IATA code the searchable dropdown
    resolved ("HYD"); ``*_city`` carries what the merchant actually saw
    ("Hyderabad"). Both are stored, because the code is what a later search
    filters on and the city name is what a human reads on the enquiry.
    """

    trip_type: TripType = "one_way"

    origin: str = Field(min_length=1, max_length=100)
    origin_city: str | None = Field(default=None, max_length=120)
    destination: str = Field(min_length=1, max_length=100)
    destination_city: str | None = Field(default=None, max_length=120)

    airline: str = Field(min_length=1, max_length=120)
    flight_number: str = Field(min_length=1, max_length=20)

    travel_date: datetime.date
    #: 24-hour ``HH:MM``. The form collects 1-12 plus AM/PM and converts.
    preferred_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")

    return_date: datetime.date | None = None
    return_preferred_time: str | None = Field(
        default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$"
    )

    #: Free text on purpose — the spec's placeholder lists Economy / Business /
    #: Premium Economy / First Class, but airlines sell fare families that do
    #: not fit a fixed enum, and this is a request to a human, not a filter.
    travel_class: str = Field(min_length=1, max_length=80)

    passenger_count: int = Field(ge=1, le=99)
    adults: int = Field(default=1, ge=1, le=99)
    children: int = Field(default=0, ge=0, le=99)
    infants: int = Field(default=0, ge=0, le=99)

    notes: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def _check(self) -> "EnquiryCreate":
        if self.origin.strip().casefold() == self.destination.strip().casefold():
            raise ValueError("From and To cannot be the same city")

        if self.travel_date < datetime.date.today():
            raise ValueError("Travel date cannot be in the past")

        if self.trip_type == "round_trip":
            if self.return_date is None:
                raise ValueError("A round trip needs a return date")
            if self.return_date <= self.travel_date:
                raise ValueError("Return date must be after the departure date")
        else:
            # A one-way enquiry that carries return details would store a
            # return leg nobody asked for, and ck_sr_date_order would then
            # judge dates the merchant never entered.
            self.return_date = None
            self.return_preferred_time = None

        if self.adults + self.children + self.infants != self.passenger_count:
            raise ValueError(
                "Passenger count must equal adults + children + infants "
                f"({self.adults} + {self.children} + {self.infants} "
                f"= {self.adults + self.children + self.infants}, not {self.passenger_count})"
            )
        # An infant travels on an adult's lap; more infants than adults is not
        # a bookable party and every airline would reject it at ticketing.
        if self.infants > self.adults:
            raise ValueError("There cannot be more infants than adults")
        return self


class EnquiryRespond(BaseModel):
    """The Admin's answer. Phase 2 builds the screen; this is the contract."""

    #: True marks the enquiry available and unlocks Request Ticket for the
    #: merchant. False rejects it.
    available: bool
    #: Mandatory on a rejection — the state machine refuses the edge without one.
    reason: str | None = Field(default=None, max_length=500)
    #: Free-text answer shown to the merchant either way (fare, timing, an
    #: alternative flight).
    response: str | None = Field(default=None, max_length=2000)


class BookingContact(BaseModel):
    """Who to reach about this booking.

    Held on the request rather than per passenger: airlines and our own desk
    contact one person about a party, and duplicating it onto every traveller
    would just be four copies to keep in sync.
    """

    name: str | None = Field(default=None, max_length=120)
    email: str = Field(min_length=3, max_length=255)
    phone: str = Field(min_length=5, max_length=30)
    alternate_phone: str | None = Field(default=None, max_length=30)


class EnquiryToBooking(BaseModel):
    """Turn an available enquiry into a draft booking request.

    The itinerary is *not* here: every journey field is copied from the enquiry
    server-side, so this screen cannot submit a journey the Admin never
    approved. What the merchant genuinely adds is who is travelling, who to
    contact, and anything special about the party.
    """

    passengers: list[PassengerInput] = Field(min_length=1)
    remarks: str | None = Field(default=None, max_length=1000)
    contact: BookingContact | None = None
    #: Set by the Classic UI from its airport reference data, which is the only
    #: place country is known (the v2 schema stores an IATA code and a city
    #: name, no country). False when it cannot be determined — passports then
    #: stay optional rather than blocking on a fact nobody recorded.
    international: bool = False
    #: Free text for the desk: wheelchair, bassinet, dietary, seating together.
    special_requests: str | None = Field(default=None, max_length=1000)


class EnquiryResponse(BaseModel):
    id: int
    reference_number: str
    status: str
    status_label: str

    trip_type: TripType
    origin: str | None = None
    origin_city: str | None = None
    destination: str | None = None
    destination_city: str | None = None
    airline: str | None = None
    flight_number: str | None = None

    travel_date: datetime.date | None = None
    preferred_time: str | None = None
    return_date: datetime.date | None = None
    return_preferred_time: str | None = None

    travel_class: str | None = None
    passenger_count: int = 1
    adults: int = 1
    children: int = 0
    infants: int = 0
    notes: str | None = None

    #: What the Admin wrote back, and why if it was turned down.
    admin_response: str | None = None
    rejection_reason: str | None = None

    #: Set once the merchant has turned this enquiry into a booking, so the
    #: listing can show the booking instead of offering Request Ticket twice.
    booking_request_id: int | None = None
    booking_request_number: str | None = None

    #: Who holds this enquiry while it is Under Review. The Admin screen shows
    #: the name on someone else's row and disables the answer controls there,
    #: so the 409 is explained before it is provoked rather than after.
    review_claimed_by: int | None = None
    review_claimed_by_name: str | None = None
    review_claimed_at: datetime.datetime | None = None

    merchant_name: str | None = None
    raised_by: str | None = None
    created_at: datetime.datetime
    responded_at: datetime.datetime | None = None

    @classmethod
    def of(cls, r) -> "EnquiryResponse":
        from app.services.lifecycle import SPEC_LABELS

        d: dict[str, Any] = r.travel_details or {}
        return cls(
            id=r.request_id,
            reference_number=r.request_number,
            status=r.status.value,
            status_label=SPEC_LABELS.get(r.status, r.status.value),
            trip_type=d.get("trip_type", "one_way"),
            origin=d.get("origin"),
            origin_city=d.get("origin_city"),
            destination=d.get("destination"),
            destination_city=d.get("destination_city"),
            airline=d.get("airline"),
            flight_number=d.get("flight_number"),
            travel_date=r.travel_date,
            preferred_time=d.get("preferred_time"),
            return_date=r.return_date,
            return_preferred_time=d.get("return_preferred_time"),
            travel_class=d.get("travel_class"),
            passenger_count=d.get("passenger_count", r.quantity),
            adults=d.get("adults", 1),
            children=d.get("children", 0),
            infants=d.get("infants", 0),
            notes=r.remarks,
            admin_response=d.get("admin_response"),
            rejection_reason=r.rejection_reason,
            booking_request_id=d.get("booking_request_id"),
            booking_request_number=d.get("booking_request_number"),
            review_claimed_by=d.get("review_claimed_by"),
            review_claimed_by_name=d.get("review_claimed_by_name"),
            review_claimed_at=d.get("review_claimed_at"),
            merchant_name=r.merchant.company_name if r.merchant else None,
            raised_by=r.user.full_name if r.user else None,
            created_at=r.created_at,
            responded_at=r.approved_at or r.resolved_at,
        )
