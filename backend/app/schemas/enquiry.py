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
from decimal import Decimal
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

    #: Still free text on the wire, though CR-5 made the merchant form a
    #: four-option dropdown (Economy / Premium Economy / Business / First
    #: Class). Narrowing this to an enum would be a contract change that breaks
    #: every enquiry already stored with a fare-family name, and the dropdown is
    #: a strict subset of what is accepted — the UI offers less than the server
    #: allows, which is the safe direction.
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
    """The Admin's answer — **Send Quotation**, or decline (CR-5).

    Phase 2 shipped this as a bare availability flag: the admin marked an
    enquiry available and the merchant learned nothing about what it would
    cost. CR-5 makes the positive answer a quotation, because that is what the
    desk is actually producing — a total the merchant has to accept before a
    ticket is bought on its behalf.

    Both new requirements apply **only to the positive answer**. Declining is
    unchanged: a reason, and no fare, because there is nothing to quote.
    """

    #: True sends a quotation, marks the enquiry available and unlocks Request
    #: Ticket for the merchant. False declines it.
    available: bool

    #: The quoted total, in INR. **Required, and strictly positive, on a
    #: quotation.** Free-text on purpose — the business types what it has
    #: worked out, and nothing on the platform recomputes it. ``Decimal``, never
    #: ``float``: this figure becomes the booking's ``total_amount`` and is what
    #: the merchant's wallet is debited, so it crosses the wire as a decimal
    #: string like every other money field (``docs/WALLET_ARCHITECTURE.md``).
    total_fare: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)

    #: Mandatory either way, and for two different reasons. On a decline the
    #: state machine refuses the ``rejected`` edge without one. On a quotation
    #: it is the breakdown — "₹3,000 ticket fare, ₹12,000 baggage" — that tells
    #: the merchant why the total differs from the bare fare. A number with no
    #: explanation is what puts the merchant on the phone.
    reason: str | None = Field(default=None, max_length=2000)

    #: Retained from Phase 2 and still accepted, so an existing caller does not
    #: break. When both are sent the two are kept distinct: ``response`` is the
    #: covering note, ``reason`` the breakdown.
    response: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check(self) -> "EnquiryRespond":
        if not self.available:
            # Declining takes no fare. Silently dropping one would be worse
            # than refusing it — the desk would believe it had quoted.
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

    #: CR-5 — the quoted total, set when the enquiry was answered with a
    #: quotation. ``Decimal`` so it serialises as a string and no browser can
    #: float it; ``None`` on a pending, declined or pre-CR-5 enquiry, which is
    #: why every surface has to handle its absence rather than assume a zero.
    quoted_fare: Decimal | None = None
    #: The breakdown shown beside the amount — the whole point of quoting.
    quotation_remarks: str | None = None

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
            # Stored as a string in JSONB (Decimal is not JSON-serialisable) and
            # rebuilt as a Decimal here, so the value that reaches the wire has
            # never been through a float.
            quoted_fare=(
                Decimal(d["quoted_fare"]) if d.get("quoted_fare") is not None else None
            ),
            quotation_remarks=d.get("quotation_remarks"),
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
