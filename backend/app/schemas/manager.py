"""Schemas for the Manager approval surface (CR-2).

Deliberately thin: the Manager reviews the same Booking Request every other
portal renders, so the payload reuses ``RequestResponse`` and ``TimelineStep``
rather than inventing a second shape for the same row. What is *not* here is as
deliberate — no payment summary, because this workflow has none, and no
internal notes, which are the operations desk's and stay staff-only to them.
"""
from pydantic import BaseModel, Field

from app.schemas.ticket import ActionOption, RequestResponse, TimelineStep


class ManagerQueueCounts(BaseModel):
    """Tab badges: one count per status, plus one roll-up per queue tab."""

    pending_approval: int = 0
    in_review: int = 0
    approved: int = 0
    ticket_issued: int = 0
    completed: int = 0
    draft: int = 0
    #: Roll-ups, matching ``manager_service.BUCKETS`` one for one — the same
    #: names the queue's ``bucket`` parameter takes, so a badge and the list it
    #: opens are counting the same rows.
    awaiting: int = 0
    returned: int = 0
    ticketed: int = 0


class ManagerBookingSummary(BaseModel):
    """One row of the Manager's queue."""

    id: int
    request_number: str
    booking_reference: str | None = None
    enquiry_reference: str | None = None
    status: str
    status_label: str
    merchant_id: int | None = None
    merchant_name: str | None = None
    raised_by: str | None = None
    title: str | None = None
    origin: str | None = None
    destination: str | None = None
    travel_date: str | None = None
    return_date: str | None = None
    trip_type: str | None = None
    travel_class: str | None = None
    international: bool = False
    passenger_count: int = 0
    #: Who holds the review claim, when one is held.
    reviewer_id: int | None = None
    reviewer_name: str | None = None
    submitted_at: str | None = None

    @classmethod
    def of(cls, r) -> "ManagerBookingSummary":
        from app.models_v2 import TravelType
        from app.services import lifecycle

        d = r.travel_details or {}
        # Hotel writes its own key names in travel_details (no origin/trip_type
        # concept, guests instead of passengers) — see
        # hotel_booking_service.to_booking_request. Falling back to those here
        # is what keeps a hotel row off "—" and "0" on this queue rather than
        # asking every reader of ManagerBookingSummary to know both shapes.
        is_hotel = r.travel_type is TravelType.HOTEL
        return cls(
            id=r.request_id,
            request_number=r.request_number,
            booking_reference=r.booking_reference,
            enquiry_reference=d.get("hotel_enquiry_reference") if is_hotel else d.get("enquiry_reference"),
            status=r.status.value,
            status_label=lifecycle.label_of(r),
            merchant_id=r.merchant_id,
            merchant_name=r.merchant.company_name if r.merchant else None,
            raised_by=r.user.full_name if r.user else None,
            title=r.title,
            origin=d.get("origin"),
            destination=d.get("destination_city") if is_hotel else d.get("destination"),
            travel_date=r.travel_date.isoformat() if r.travel_date else None,
            return_date=r.return_date.isoformat() if r.return_date else None,
            trip_type=d.get("trip_type"),
            travel_class=d.get("travel_class"),
            international=bool(d.get("international")),
            passenger_count=len(r.hotel_guests) if is_hotel else len(r.passengers),
            reviewer_id=d.get("manager_claimed_by"),
            reviewer_name=d.get("manager_claimed_by_name"),
            submitted_at=r.created_at.isoformat() if r.created_at else None,
        )


class ManagerBookingDetail(BaseModel):
    """Everything the review screen needs, in one call."""

    request: RequestResponse
    timeline: list[TimelineStep]
    actions: list[ActionOption]
    reviewer_id: int | None = None
    reviewer_name: str | None = None
    #: True when this manager holds the claim (or nobody does).
    can_decide: bool = False


class ManagerApproveRequest(BaseModel):
    #: Optional sign-off note, recorded on the transition and shown on the
    #: timeline. Not a fare — this workflow has no amount to enter.
    note: str | None = Field(default=None, max_length=1000)


class ManagerReturnRequest(BaseModel):
    #: What the merchant must correct. Mandatory: a booking returned with no
    #: remarks is a booking nobody can act on.
    remarks: str = Field(min_length=1, max_length=1000)
