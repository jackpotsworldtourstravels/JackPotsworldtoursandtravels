"""Schemas for catalog search, ticket requests, and the request lifecycle."""
import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.document import DocumentResponse
from app.models_v2 import (
    Gender,
    PassengerType,
    RequestStatus,
    RequestType,
    SeatPreference,
    TravelType,
)


# ---------------------------------------------------------------------------
# Catalog / Ticket Enquiry
# ---------------------------------------------------------------------------
class CatalogItemResponse(BaseModel):
    id: int
    travel_type: TravelType | None = None
    title: str | None = None
    details: dict[str, Any] = {}
    pricing: dict[str, Any] = {}
    total_amount: Decimal
    available_units: int | None = None
    travel_date: datetime.date | None = None
    return_date: datetime.date | None = None

    @classmethod
    def of(cls, item) -> "CatalogItemResponse":
        return cls(
            id=item.request_id,
            travel_type=item.travel_type,
            title=item.title,
            details=item.travel_details or {},
            pricing=item.pricing or {},
            total_amount=item.total_amount,
            available_units=item.available_units,
            travel_date=item.travel_date,
            return_date=item.return_date,
        )


class QuoteResponse(BaseModel):
    """The spec's Review Price step. Recomputed server-side, never trusted."""

    item: CatalogItemResponse
    currency: str
    base_fare: Decimal
    taxes: Decimal
    per_passenger: Decimal
    passengers: int
    total: Decimal


# ---------------------------------------------------------------------------
# Passengers
# ---------------------------------------------------------------------------
class PassengerInput(BaseModel):
    #: The id of an existing passenger on this request, when the caller is
    #: editing rather than adding. Supplying it keeps that traveller's database
    #: row — and therefore the passport scans attached to it — alive across a
    #: replace. Omitted for a newly added traveller, and by every caller written
    #: before documents existed, which keeps the old delete-and-recreate
    #: behaviour for them.
    id: int | None = None
    title: str | None = Field(default=None, max_length=10)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    gender: Gender | None = None
    dob: datetime.date | None = None
    passenger_type: PassengerType = PassengerType.ADULT
    passport_number: str | None = Field(default=None, max_length=40)
    passport_issue_country: str | None = Field(default=None, max_length=100)
    passport_issue_date: datetime.date | None = None
    passport_expiry: datetime.date | None = None
    nationality: str | None = Field(default=None, max_length=100)
    seat_preference: SeatPreference | None = None
    meal_preference: str | None = Field(default=None, max_length=100)
    special_services: list[dict[str, Any]] = []


class PassengerResponse(PassengerInput):
    id: int
    is_cancelled: bool = False

    @classmethod
    def of(cls, p) -> "PassengerResponse":
        return cls(
            id=p.passenger_id,
            title=p.title,
            first_name=p.first_name,
            last_name=p.last_name,
            gender=p.gender,
            dob=p.dob,
            passenger_type=p.passenger_type,
            passport_number=p.passport_number,
            passport_issue_country=p.passport_issue_country,
            passport_issue_date=p.passport_issue_date,
            passport_expiry=p.passport_expiry,
            nationality=p.nationality,
            seat_preference=p.seat_preference,
            meal_preference=p.meal_preference,
            special_services=p.special_services or [],
            is_cancelled=p.is_cancelled,
        )


class PassengerLookupResponse(BaseModel):
    """A traveller this merchant has sent before, found by passport number.

    DELIBERATELY NOT A ``PassengerResponse``, and the missing field is the point:
    there is **no ``id``**. That id identifies a ``passenger_data`` row on
    *another booking*, and ``replace_passengers`` reads ``id`` as "keep this
    traveller's existing row". Handing it to a form that is filling in a
    different booking would ask the API to move a row between bookings — so the
    lookup returns the *facts about a person* and never a row identity. The
    booking being filled in creates its own row, exactly as it always did.

    ``found`` is explicit rather than implied by a 404: "we have not seen this
    passport" is a normal, successful answer to a lookup, and a 404 would make
    every unrecognised passport look like an error in the browser console.
    """

    found: bool = False
    title: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    gender: Gender | None = None
    dob: datetime.date | None = None
    passenger_type: PassengerType | None = None
    passport_number: str | None = None
    passport_issue_country: str | None = None
    passport_issue_date: datetime.date | None = None
    passport_expiry: datetime.date | None = None
    nationality: str | None = None
    seat_preference: SeatPreference | None = None
    meal_preference: str | None = None
    #: When this merchant last sent this traveller. Shown beside the fill so the
    #: merchant can judge whether details from that long ago are still current.
    last_used: datetime.datetime | None = None

    @classmethod
    def of(cls, p) -> "PassengerLookupResponse":
        if p is None:
            return cls(found=False)
        return cls(
            found=True,
            title=p.title,
            first_name=p.first_name,
            last_name=p.last_name,
            gender=p.gender,
            dob=p.dob,
            passenger_type=p.passenger_type,
            passport_number=p.passport_number,
            passport_issue_country=p.passport_issue_country,
            passport_issue_date=p.passport_issue_date,
            passport_expiry=p.passport_expiry,
            nationality=p.nationality,
            seat_preference=p.seat_preference,
            meal_preference=p.meal_preference,
            last_used=p.updated_at or p.created_at,
        )


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------
class CreateBookingRequest(BaseModel):
    catalog_item_id: int
    passengers: list[PassengerInput] = Field(min_length=1)
    travel_date: datetime.date | None = None
    return_date: datetime.date | None = None
    remarks: str | None = None


class UpdateDraftRequest(BaseModel):
    remarks: str | None = None
    travel_date: datetime.date | None = None
    return_date: datetime.date | None = None
    #: Booking-level contact and party notes, added in Phase 3. Both are
    #: optional and merge into ``travel_details``, so a catalog-led caller that
    #: has never sent them is unaffected.
    contact: dict | None = None
    special_requests: str | None = None


class ReplacePassengersRequest(BaseModel):
    passengers: list[PassengerInput] = Field(min_length=1)


class ApproveRequest(BaseModel):
    #: Optional override — the spec lets an Admin approve at a final amount.
    #:
    #: Still optional, and still ``ge=0``, because a catalog-led booking already
    #: carries a price computed from the catalog row and does not need one sent.
    #: That a *priced* booking must result is enforced in
    #: ``ticket_service.approve_request``, where the request's own total is in
    #: hand — a schema rule here could only ever see this field.
    final_amount: Decimal | None = Field(default=None, ge=0)
    note: str | None = None


class RepriceRequest(BaseModel):
    """Correct the amount on a booking already at Payment Pending."""

    amount: Decimal = Field(gt=0)
    #: Mandatory: this changes what a merchant owes, and the merchant is told
    #: why. Same standard as a rejection reason.
    reason: str = Field(min_length=1, max_length=500)


class RejectRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class CancelRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class PayRequest(BaseModel):
    amount: Decimal = Field(gt=0)
    method: str = Field(min_length=1, max_length=50)
    transaction_id: str | None = Field(default=None, max_length=100)


class IssueTicketRequest(BaseModel):
    """CR-4b. The fare the desk actually paid the airline.

    Required only on a wallet-billed booking that still carries no amount —
    enquiry-led bookings are created at 0 and no live path sets a fare before
    this point. Ignored where an amount already exists, which is every
    catalog-led booking, so the standard track is untouched.
    """

    fare_amount: Decimal | None = Field(default=None, gt=0)

    #: WHO THE TICKET WAS BOUGHT FROM (0039), and the person at that supplier
    #: who booked it.
    #:
    #: **Optional here, required by the Booking Operations screen.** The
    #: business asked for two required fields; making them required *in the
    #: schema* would reject every existing caller — the whole regression suite,
    #: any integration, and any booking mid-flight when this shipped — which the
    #: same brief forbids ("preserve backward compatibility", "existing ticket
    #: issuance continues to work"). The two requirements only conflict at this
    #: layer, so the enforcement lives where the humans are: the desk cannot
    #: submit the form without choosing both.
    #:
    #: Optional does not mean unvalidated. ``provider_service.resolve_for_issuance``
    #: refuses an unknown or inactive provider, a person who works somewhere
    #: else, and a person named without a provider.
    provider_id: int | None = Field(default=None, gt=0)
    provider_user_id: int | None = Field(default=None, gt=0)


class VerifyPaymentRequest(BaseModel):
    approve: bool = True
    note: str | None = Field(default=None, max_length=500)


class CreateServiceRequest(BaseModel):
    booking_id: int
    request_type: RequestType
    remarks: str = Field(min_length=1, max_length=1000)
    details: dict[str, Any] = {}


class ResolveServiceRequest(BaseModel):
    approve: bool
    reason: str | None = Field(default=None, max_length=500)


class TimelineStep(BaseModel):
    status: str | None = None
    label: str | None = None
    detail: str | None = None
    by: str | None = None
    at: str | None = None
    reason: str | None = None
    note: str | None = None
    state: str


class ActionOption(BaseModel):
    to: str
    label: str
    requires_reason: bool


class PaymentSummary(BaseModel):
    id: int
    amount: Decimal
    currency: str
    method: str | None = None
    transaction_id: str | None = None
    status: str
    paid_date: datetime.datetime | None = None

    #: Which booking this payment is against. Redundant when nested inside that
    #: booking's own detail response, but essential on the Admin payments
    #: screens, which list payments across every merchant — without it a
    #: reviewer is asked to approve an amount with no way to see what it buys.
    #: Optional so nothing that already consumes this schema breaks.
    request_id: int | None = None
    request_number: str | None = None
    merchant_id: int | None = None
    merchant_name: str | None = None
    #: Set when the payment has been refunded in whole or in part.
    refund_amount: Decimal | None = None

    @classmethod
    def of(cls, p) -> "PaymentSummary":
        request = getattr(p, "request", None)
        return cls(
            id=p.payment_id,
            amount=p.amount,
            currency=p.currency,
            method=p.payment_method,
            transaction_id=p.transaction_id,
            status=p.payment_status.value,
            paid_date=p.paid_date,
            request_id=p.request_id,
            request_number=request.request_number if request else None,
            merchant_id=p.merchant_id,
            merchant_name=(
                request.merchant.company_name if request and request.merchant else None
            ),
            refund_amount=p.refund_amount or None,
        )


class RequestResponse(BaseModel):
    id: int
    request_number: str
    request_type: RequestType
    status: RequestStatus
    #: What the status column should READ. On a service request still awaiting
    #: the merchant's own manager this is "Under Manager Approval" or "Manager
    #: Approved" rather than the bare "Pending" — `status` itself is unchanged,
    #: so filters and the state machine are untouched. See
    #: services/manager_approval.py.
    status_label: str
    #: `pending` / `approved` / `rejected`, or None on anything that does not go
    #: through manager sign-off (a booking, an enquiry, a pre-existing row).
    manager_state: str | None = None
    manager_approval: dict[str, Any] = {}

    #: ``classic_tours`` for an enquiry-led booking running the CR-2 workflow
    #: (Manager approval, no payment step), ``standard`` for everything else.
    #: Frontends branch on this rather than re-deriving the rule — the Classic
    #: portal hides its payment surfaces on it, and the operations desk shows
    #: "upload tickets" instead of "awaiting payment".
    workflow: Literal["classic_tours", "standard"] = "standard"
    parent_request_id: int | None = None
    merchant_id: int | None = None
    merchant_name: str | None = None
    raised_by: str | None = None

    booking_reference: str | None = None
    pnr: str | None = None
    ticket_number: str | None = None
    invoice_number: str | None = None

    travel_type: TravelType | None = None
    title: str | None = None
    remarks: str | None = None
    rejection_reason: str | None = None
    details: dict[str, Any] = {}
    pricing: dict[str, Any] = {}

    quantity: int
    total_amount: Decimal
    #: 0040 — what the merchant sold this at to its own customer, and the margin
    #: that implies against ``total_amount``. Both default to None, so a booking
    #: made before client fares existed serialises exactly as it did before and
    #: no client has to know about them. ``saved_amount`` is derived on the
    #: model (``ServiceRequest.saved_amount``) and is never accepted as input.
    client_fare: Decimal | None = None
    saved_amount: Decimal | None = None
    travel_date: datetime.date | None = None
    return_date: datetime.date | None = None

    passengers: list[PassengerResponse] = []
    #: 0039 — who this was bought from, once a ticket has been issued. Both
    #: default to None, so every response for a booking issued before providers
    #: existed is byte-for-byte what it was; no client has to know about them.
    provider_id: int | None = None
    provider_name: str | None = None
    provider_user_id: int | None = None
    provider_user_name: str | None = None
    created_at: datetime.datetime
    approved_at: datetime.datetime | None = None
    completed_at: datetime.datetime | None = None

    @classmethod
    def of(cls, r, *, include_passengers: bool = True) -> "RequestResponse":
        from app.services import lifecycle, manager_approval

        classic = lifecycle.is_classic_track(r)
        return cls(
            id=r.request_id,
            request_number=r.request_number,
            request_type=r.request_type,
            status=r.status,
            # `label_of` is the track-aware lifecycle label (CR-2 gave the
            # classic track its own wording); the manager sign-off label wins
            # over it only while the request is still Pending Approval.
            status_label=manager_approval.status_label(r, lifecycle.label_of(r)),
            manager_state=manager_approval.state(r),
            manager_approval=manager_approval.block(r),
            workflow="classic_tours" if classic else "standard",
            parent_request_id=r.parent_request_id,
            merchant_id=r.merchant_id,
            merchant_name=r.merchant.company_name if r.merchant else None,
            raised_by=r.user.full_name if r.user else None,
            booking_reference=r.booking_reference,
            pnr=r.pnr,
            ticket_number=r.ticket_number,
            invoice_number=r.invoice_number,
            travel_type=r.travel_type,
            title=r.title,
            remarks=r.remarks,
            rejection_reason=r.rejection_reason,
            details=r.travel_details or {},
            pricing=r.pricing or {},
            quantity=r.quantity,
            total_amount=r.total_amount,
            client_fare=r.client_fare,
            saved_amount=r.saved_amount,
            travel_date=r.travel_date,
            return_date=r.return_date,
            passengers=[PassengerResponse.of(p) for p in r.passengers]
            if include_passengers
            else [],
            provider_id=r.provider_id,
            # Guarded on the id rather than reached for unconditionally: these
            # are lazy relationships, and touching them on a booking with no
            # provider would emit a query per row on every list that serialises
            # through here. Null id, null name, no SQL.
            provider_name=r.provider.provider_name if r.provider_id and r.provider else None,
            provider_user_id=r.provider_user_id,
            provider_user_name=(
                r.provider_user.user_name if r.provider_user_id and r.provider_user else None
            ),
            created_at=r.created_at,
            approved_at=r.approved_at,
            completed_at=r.completed_at,
        )


class RequestDetailResponse(BaseModel):
    """One request plus everything the detail screen needs in a single call."""

    request: RequestResponse
    timeline: list[TimelineStep]
    actions: list[ActionOption]
    payments: list[PaymentSummary] = []
    #: Attachments (Phase 3). Defaulted, so a catalog-led request that has none
    #: — and every caller written before documents existed — is unaffected.
    documents: list["DocumentResponse"] = []
    can_download: bool = False
