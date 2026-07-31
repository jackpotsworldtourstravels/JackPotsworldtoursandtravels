"""Schemas for the Booking Operations desk.

These are **staff-facing only**. ``NoteResponse`` in particular must never be
embedded in a merchant response — internal notes are staff-only by design (see
migration 0032), and the guarantee is only as good as the schemas that do not
carry them.
"""
import datetime

from pydantic import BaseModel, Field

from app.services.lifecycle import SPEC_LABELS


class QueueItem(BaseModel):
    """One row of the processing queue."""

    id: int
    request_number: str
    booking_reference: str | None = None
    title: str | None = None

    status: str
    status_label: str

    merchant_id: int | None = None
    merchant_name: str | None = None

    passengers: int = 0
    lead_passenger: str | None = None
    travel_date: datetime.date | None = None
    total_amount: str = "0.00"

    pnr: str | None = None
    ticket_number: str | None = None

    assigned_admin: int | None = None
    assigned_to: str | None = None

    #: How long this booking has been sitting in the queue. Computed server-side
    #: so every client ages it against the same clock — a browser with a skewed
    #: system time must not be able to make a breaching booking look fresh.
    age_hours: int = 0

    created_at: datetime.datetime

    @classmethod
    def of(cls, r, *, operator: str | None = None) -> "QueueItem":
        now = datetime.datetime.now(datetime.timezone.utc)
        created = r.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=datetime.timezone.utc)
        lead = r.passengers[0] if r.passengers else None
        return cls(
            id=r.request_id,
            request_number=r.request_number,
            booking_reference=r.booking_reference,
            title=r.title,
            status=r.status.value,
            status_label=SPEC_LABELS.get(r.status, r.status.value),
            merchant_id=r.merchant_id,
            merchant_name=r.merchant.company_name if r.merchant else None,
            passengers=len(r.passengers),
            lead_passenger=lead.full_name if lead else None,
            travel_date=r.travel_date,
            total_amount=str(r.total_amount),
            pnr=r.pnr,
            ticket_number=r.ticket_number,
            assigned_admin=r.assigned_admin,
            assigned_to=operator,
            age_hours=max(0, int((now - created).total_seconds() // 3600)),
            created_at=r.created_at,
        )


class QueueCounts(BaseModel):
    """Tab badges for the queue. Keys are status values plus two roll-ups."""

    approved: int = 0
    payment_pending: int = 0
    paid: int = 0
    ticket_issued: int = 0
    total: int = 0
    unassigned: int = 0


class OperatorOption(BaseModel):
    """Someone who can be given a booking to work."""

    id: int
    full_name: str
    email: str
    role: str
    #: How many post-approval bookings they already hold — assigning blind is
    #: how one operator ends up with the whole queue.
    open_bookings: int = 0


class AssignRequest(BaseModel):
    #: ``None`` returns the booking to the unassigned pool.
    operator_id: int | None = None


class ReferencesRequest(BaseModel):
    """Airline identifiers coming back from the GDS.

    Every field is optional and only non-``None`` fields are written, so a
    caller updating just the PNR cannot accidentally blank the ticket number.
    """

    #: Airline locator, e.g. "H4X9PQ". Upper-cased on the way in.
    pnr: str | None = Field(default=None, max_length=20)
    ticket_number: str | None = Field(default=None, max_length=40)
    #: Anything else the airline calls this booking — a tour code, a group ref.
    airline_reference: str | None = Field(default=None, max_length=120)


class NoteRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class NoteResponse(BaseModel):
    id: int
    request_id: int
    body: str
    author_id: int | None = None
    author_name: str | None = None
    edited_at: datetime.datetime | None = None
    created_at: datetime.datetime
    #: Whether the caller may edit or delete this note — only its author can,
    #: so the UI can hide controls that would 403.
    can_edit: bool = False

    @classmethod
    def of(cls, n, *, author: str | None = None, viewer_id: int | None = None) -> "NoteResponse":
        return cls(
            id=n.note_id,
            request_id=n.request_id,
            body=n.body,
            author_id=n.author_id,
            author_name=author,
            edited_at=n.edited_at,
            created_at=n.created_at,
            can_edit=viewer_id is not None and n.author_id == viewer_id,
        )
