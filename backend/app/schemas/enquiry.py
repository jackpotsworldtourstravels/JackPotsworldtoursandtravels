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

from app.schemas.group_booking import GroupImportSummary
from app.schemas.ticket import PassengerInput

#: ``group_trip`` is a MARKER, not a fourth workflow. It says "this booking is a
#: large party travelling together" — a corporate group, a tour, a pilgrimage —
#: and nothing else about it differs: same validation, same approval path, same
#: issuance, same wallet rules. It is stored in ``travel_details`` like the other
#: two, so adding it needed no migration (the real ``trip_type_enum`` in
#: PostgreSQL belongs to the retired partner_portal tables, which no live router
#: touches).
#:
#: **Only the Direct Booking Request form offers it.** The enquiry form still
#: shows One Way / Round Trip, because a group fare is not what the quotation
#: stage is for. This literal is shared by both schemas anyway — the UI offering
#: less than the server accepts is the safe direction, exactly as with
#: ``travel_class`` below.
#:
#: **Both forms now offer it (2026-08-04).** The sentence above described the
#: state before group bookings had a passenger manifest. A group fare still is
#: not priced at the quotation stage, but a merchant asking us to quote a party
#: of eighty has the same reason to attach the party as one raising the booking
#: directly — so the enquiry form offers the third option too, and
#: ``group_journey_type`` below decides its shape.
TripType = Literal["one_way", "round_trip", "group_trip"]

#: The shape of a group booking, and the ONLY thing that distinguishes the two.
#: Required when ``trip_type`` is ``group_trip``, refused otherwise — a journey
#: type on a one-way booking would be a field nothing reads, and the pair going
#: out of step is how a round-trip group loses its return leg silently.
GroupJourneyType = Literal["one_way_group", "round_trip_group"]


class EnquiryCreate(BaseModel):
    """The Enquire Ticket form.

    ``origin`` / ``destination`` carry the IATA code the searchable dropdown
    resolved ("HYD"); ``*_city`` carries what the merchant actually saw
    ("Hyderabad"). Both are stored, because the code is what a later search
    filters on and the city name is what a human reads on the enquiry.
    """

    trip_type: TripType = "one_way"
    #: Mandatory on a group booking, refused on anything else — see the
    #: validator, which is the only place the pairing is enforced.
    group_journey_type: GroupJourneyType | None = None
    #: The uploaded passenger manifest, on a group booking.
    #:
    #: AN ENQUIRY HAS NO PASSENGERS, so this may look out of place here — but
    #: the merchant uploads the sheet while filling *this* form, and the desk
    #: quoting a party of eighty needs to see the eighty. The manifest is
    #: therefore bound to the enquiry, and ``to_booking_request`` reads the
    #: travellers back off it when the enquiry becomes a booking. Without this
    #: the merchant would upload once to enquire and again to book.
    group_import_id: int | None = None

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

    #: What the merchant's Data Operator has quoted their OWN end customer
    #: (migration 0040). Optional — a merchant that does not resell at a markup
    #: has nothing to record here, and NULL means exactly that. Never used for
    #: settlement; it only produces the "You Saved" figure once we have quoted.
    #: ``le`` guards the Numeric(14, 2) column: 12 digits before the point.
    client_fare: Decimal | None = Field(default=None, ge=0, le=Decimal("9999999999.99"))

    @model_validator(mode="after")
    def _check(self) -> "EnquiryCreate":
        if self.origin.strip().casefold() == self.destination.strip().casefold():
            raise ValueError("From and To cannot be the same city")

        if self.travel_date < datetime.date.today():
            raise ValueError("Travel date cannot be in the past")

        # THE PAIRING, BEFORE ANYTHING READS EITHER FIELD.
        # These two describe one choice made on one form, and every rule below
        # reads both. Letting them disagree — a group booking with no journey
        # type, or a journey type on a one-way — would mean the return-leg rule
        # silently picks a branch the merchant never chose.
        if self.trip_type == "group_trip":
            if self.group_journey_type is None:
                raise ValueError(
                    "Choose whether this is a One Way Group or a Round Trip Group"
                )
        elif self.group_journey_type is not None:
            raise ValueError(
                "group_journey_type applies only to a group booking"
            )

        # WHICH ITINERARIES CARRY A RETURN LEG.
        # Until 2026-08-04 this was ``trip_type == "round_trip"`` and nothing
        # else, and ``group_trip`` deliberately fell through to the one-way
        # branch: a group needing a return raised two bookings. The Group
        # Booking spec replaced that with an explicit Round Trip Group, so the
        # question is no longer "is it a round trip?" but "does this itinerary
        # have a return leg?" — which round_trip and round_trip_group both
        # answer yes to, and which is now asked in exactly one place.
        #
        # Nothing about one_way or round_trip changes. A round_trip validates
        # against the identical two rules it always has.
        has_return_leg = self.trip_type == "round_trip" or (
            self.trip_type == "group_trip"
            and self.group_journey_type == "round_trip_group"
        )

        if has_return_leg:
            if self.return_date is None:
                raise ValueError("A round trip needs a return date")
            if self.return_date <= self.travel_date:
                raise ValueError("Return date must be after the departure date")
        else:
            # A one-way enquiry that carries return details would store a
            # return leg nobody asked for, and ck_sr_date_order would then
            # judge dates the merchant never entered. A One Way Group lands
            # here for that same reason.
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


def _check_passenger_source(model):
    """A booking takes its travellers from the form OR from a manifest, never both.

    Shared by both booking-creating schemas rather than written twice, for the
    reason ``DirectBookingCreate`` subclasses ``EnquiryCreate``: the rule is the
    same rule, and a second copy is a second thing to forget.

    The "at least one passenger" guarantee is unchanged for every booking that
    is not a group one — it has simply moved off the field and into here, where
    it can see whether a manifest is supplying the list instead. Dropping
    ``min_length=1`` without this would have quietly allowed an empty booking on
    both paths.
    """
    if model.group_import_id is not None:
        if model.passengers:
            raise ValueError(
                "This booking already takes its travellers from the uploaded "
                "passenger list — remove the manually entered passengers"
            )
        return model

    if not model.passengers:
        raise ValueError("A booking needs at least one passenger")
    return model


class EnquiryToBooking(BaseModel):
    """Turn an available enquiry into a draft booking request.

    The itinerary is *not* here: every journey field is copied from the enquiry
    server-side, so this screen cannot submit a journey the Admin never
    approved. What the merchant genuinely adds is who is travelling, who to
    contact, and anything special about the party.
    """

    #: Empty ONLY on a group booking, where the travellers come from the
    #: uploaded manifest instead — see ``group_import_id`` and the validator.
    #: Every other booking still requires at least one, exactly as before.
    passengers: list[PassengerInput] = []
    #: A validated ``group_booking_imports`` row whose passengers become this
    #: booking's. Mutually exclusive with ``passengers``: two sources for one
    #: list is how a manifest silently loses to a stale form field.
    group_import_id: int | None = None
    remarks: str | None = Field(default=None, max_length=1000)
    contact: BookingContact | None = None
    #: Set by the Classic UI from its airport reference data, which is the only
    #: place country is known (the v2 schema stores an IATA code and a city
    #: name, no country). False when it cannot be determined — passports then
    #: stay optional rather than blocking on a fact nobody recorded.
    international: bool = False
    #: Free text for the desk: wheelchair, bassinet, dietary, seating together.
    special_requests: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def _one_passenger_source(self) -> "EnquiryToBooking":
        return _check_passenger_source(self)


class DirectBookingCreate(EnquiryCreate):
    """Raise a booking straight from the form, with no enquiry in front of it.

    **Every field is inherited, deliberately.** Subclassing ``EnquiryCreate``
    rather than restating the itinerary means the From ≠ To rule, the past-date
    rule, the round-trip return rule and the adults/children/infants arithmetic
    are the *same* validator, not a second copy of it that drifts. A merchant
    describing a journey is describing the same journey whether or not it asked
    us to price it first, so there is exactly one definition of a valid one.

    What is added is what a booking needs and an enquiry does not: who is
    travelling, who to contact, and anything special about the party — the same
    three things ``EnquiryToBooking`` adds on the enquiry-led path.

    THERE IS NO PRICE HERE, AND THAT IS THE POINT.
    The enquiry-led booking is created at the quotation the desk sent (CR-5).
    This one has never been quoted, so it is created at ``0`` and the fare is
    captured where it always was for an unpriced booking — at ticket issuance,
    by ``ticket_service._capture_fare_for_wallet_billing``. Accepting an amount
    from the merchant here would let it name the price of its own booking.
    """

    #: Empty ONLY on a group booking — ``_check_passenger_source`` still refuses
    #: a passenger-less booking on every other path, so the guarantee the old
    #: ``min_length=1`` gave is intact.
    passengers: list[PassengerInput] = []
    #: The validated manifest supplying those travellers on a group booking.
    group_import_id: int | None = None
    contact: BookingContact | None = None
    #: Set by the Classic UI from its airport reference data, which is the only
    #: place country is known. False when it cannot be determined — passports
    #: then stay optional rather than blocking on a fact nobody recorded.
    international: bool = False
    #: Free text for the desk: wheelchair, bassinet, dietary, seating together.
    special_requests: str | None = Field(default=None, max_length=1000)
    #: The booking's own remarks. ``notes`` is inherited from the enquiry form
    #: and is not reused for this: on an enquiry it is "what to consider when
    #: quoting", which a booking with no quotation stage has no use for.
    remarks: str | None = Field(default=None, max_length=1000)

    #: Submit it to the approvals desk in the same call. False leaves it as a
    #: draft, exactly as ``Save as draft`` does on the enquiry-led screen — the
    #: separate ``POST /api/requests/{id}/submit`` still works either way and is
    #: still the only thing that moves the status.
    submit: bool = False

    # Runs alongside the inherited itinerary validator, not instead of it —
    # pydantic executes every ``model_validator`` on the class.
    @model_validator(mode="after")
    def _one_passenger_source(self) -> "DirectBookingCreate":
        return _check_passenger_source(self)


class EnquiryResponse(BaseModel):
    id: int
    reference_number: str
    status: str
    status_label: str

    trip_type: TripType
    #: ``None`` on everything that is not a group booking, which is what every
    #: screen keys off to decide whether to show the manifest panel at all.
    group_journey_type: GroupJourneyType | None = None
    #: Import summary for a group booking, so the Admin drawer and the merchant
    #: listing can show "48 passengers imported" without a second round trip.
    #: ``None`` when this booking did not come from a manifest.
    group_import: GroupImportSummary | None = None

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

    #: 0040 — the merchant's own sell price, and the margin it implies. Both are
    #: visible to the Admin as well as the merchant: the Admin needs to see what
    #: the merchant has committed to before quoting under or over it.
    #: ``saved_amount`` is DERIVED, never stored and never accepted from a
    #: client — it is ``client_fare - quoted_fare`` floored at zero, computed
    #: here so the merchant portal, the Admin screen, Reports and the invoice
    #: can never disagree about it.
    client_fare: Decimal | None = None
    saved_amount: Decimal | None = None

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

        # THE SAVING IS AGAINST THE QUOTED FARE, NOT ``total_amount``.
        # On an enquiry `total_amount` is still 0 — it only becomes the billed
        # figure on the BOOKING that the enquiry turns into. Subtracting from it
        # here would report the entire client fare as "saved" on every open
        # enquiry. The comparable number at this stage is what we quoted, so
        # there is no saving to show until we have answered.
        _quoted = Decimal(d["quoted_fare"]) if d.get("quoted_fare") is not None else None
        _saved = None
        if r.client_fare is not None and _quoted is not None:
            _diff = r.client_fare - _quoted
            _saved = _diff if _diff > 0 else Decimal("0")

        return cls(
            id=r.request_id,
            reference_number=r.request_number,
            status=r.status.value,
            status_label=SPEC_LABELS.get(r.status, r.status.value),
            trip_type=d.get("trip_type", "one_way"),
            group_journey_type=d.get("group_journey_type"),
            # Populated only when the caller eager-loaded it — every screen that
            # needs the manifest asks for the detail endpoint anyway, and a
            # lazy relationship here would put one query per row in the listing.
            group_import=(
                GroupImportSummary.of(r.group_import)
                if getattr(r, "group_import", None) is not None
                else None
            ),
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
            client_fare=r.client_fare,
            saved_amount=_saved,
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
