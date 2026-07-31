"""Schemas for the cancellation and reschedule workflow (M3).

Money crosses this boundary as **strings**, in both directions. A JSON number
is a float in every client that parses it, and a cancellation charge that
arrives as 2999.9999999999995 is a rounding bug waiting to reach the ledger.
``change_request_service._money`` turns the string into a ``Decimal`` and
bounds it; nothing here does arithmetic.
"""
import datetime

from pydantic import BaseModel, Field

from app.services.lifecycle import SPEC_LABELS


class CancellationRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class RescheduleRequest(BaseModel):
    new_travel_date: datetime.date
    new_return_date: datetime.date | None = None
    reason: str = Field(min_length=1, max_length=2000)


class ApproveChangeRequest(BaseModel):
    """Staff quote. Which fields matter depends on the request type.

    Everything is optional and defaults to zero, so a free cancellation is
    expressed by sending nothing rather than by sending ``"0.00"`` — but a
    charge that *is* sent is always bounded against the booking.
    """

    #: Cancellation only. Bounded to at most the booking total.
    cancellation_charge: str | None = None
    #: Reschedule only. The airline's fare difference on the new date.
    fare_difference: str | None = None
    #: Reschedule only. What we charge on top for handling the change.
    change_fee: str | None = None
    note: str | None = Field(default=None, max_length=2000)


class RejectChangeRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class ChangeRequestItem(BaseModel):
    """One row of the change-request list."""

    id: int
    request_number: str
    change_type: str
    change_type_label: str

    status: str
    status_label: str

    booking_id: int | None = None
    booking_request_number: str | None = None
    booking_reference: str | None = None
    pnr: str | None = None

    merchant_id: int | None = None
    merchant_name: str | None = None

    reason: str | None = None
    #: Empty until staff quote it — a pending request carries no amounts.
    pricing: dict = Field(default_factory=dict)
    amount: str = "0.00"

    #: Reschedule only, so the list can show "12 Sep → 19 Sep" without a second
    #: call for the parent booking.
    new_travel_date: datetime.date | None = None
    current_travel_date: datetime.date | None = None

    review_claimed_by: int | None = None
    review_claimed_by_name: str | None = None

    rejection_reason: str | None = None
    created_at: datetime.datetime
    updated_at: datetime.datetime | None = None

    @classmethod
    def of(cls, r, *, merchant_name: str | None = None) -> "ChangeRequestItem":
        details = r.travel_details or {}

        def _date(key):
            value = details.get(key)
            return datetime.date.fromisoformat(value) if value else None

        return cls(
            id=r.request_id,
            request_number=r.request_number,
            change_type=r.request_type.value,
            change_type_label=(
                "Cancellation" if r.request_type.value == "cancellation" else "Reschedule"
            ),
            status=r.status.value,
            status_label=SPEC_LABELS.get(r.status, r.status.value),
            booking_id=r.parent_request_id,
            booking_request_number=details.get("booking_request_number"),
            booking_reference=r.booking_reference,
            pnr=r.pnr,
            merchant_id=r.merchant_id,
            merchant_name=merchant_name or (r.merchant.company_name if r.merchant else None),
            reason=details.get("reason") or r.remarks,
            pricing=r.pricing or {},
            amount=str(r.total_amount),
            new_travel_date=_date("new_travel_date"),
            current_travel_date=_date("current_travel_date"),
            review_claimed_by=details.get("review_claimed_by"),
            review_claimed_by_name=details.get("review_claimed_by_name"),
            rejection_reason=r.rejection_reason,
            created_at=r.created_at,
            updated_at=r.updated_at,
        )


class ChangeRequestDetail(BaseModel):
    """One change request, with the booking it is against and its timeline."""

    request: ChangeRequestItem
    booking: dict | None = None
    timeline: list[dict] = Field(default_factory=list)
    #: What the caller may do to it right now, so the UI offers nothing the
    #: server would refuse.
    can_review: bool = False
    can_settle: bool = False
    can_withdraw: bool = False


class ChangeRequestCounts(BaseModel):
    """Tab badges."""

    pending_approval: int = 0
    in_review: int = 0
    approved: int = 0
    rejected: int = 0
    cancelled: int = 0
    #: Pending + Under Review — the ones that still need someone.
    open: int = 0
    total: int = 0
