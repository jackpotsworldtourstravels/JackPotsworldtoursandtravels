"""Ticket Enquiry — ask the desk about a sector, then book what it confirms.

    Merchant: Enquire Ticket -> (Pending)
    Admin:    Reviews -> marks Available / Not available
    Merchant: Request Ticket -> Booking Request, pre-filled -> Submit

WHERE AN ENQUIRY LIVES
In ``service_requests``, as ``request_type = 'ticket_enquiry'`` — a value the
enum has carried since migration 0023, reserved for exactly this. The form
fields sit in ``travel_details`` JSONB, which is how every other request type
in this schema stores its type-specific payload. **No new table, no schema
change**; migration 0030 adds only the ENQ reference sequence.

The keys written into ``travel_details`` (``origin``, ``destination``,
``origin_city``, ``destination_city``, ``airline``, ``flight_number``) are
deliberately the same keys catalog items use. That is not decoration:
``ticket_service.list_requests`` already searches
``travel_details['destination_city']``, and the Classic request-detail modal
already renders those keys as an itinerary — so an enquiry reads correctly on
screens that were written before it existed.

STATUS
Enquiries reuse the shared lifecycle rather than inventing a parallel one:

    pending_approval  the spec's "Pending"      — with our team
    in_review         Admin has picked it up
    approved          "Available for booking"   — unlocks Request Ticket
    rejected          not available             — reason required
    cancelled         withdrawn by the merchant

There is no draft stage: an enquiry is submitted the instant it is created,
so :func:`create` writes the row at ``pending_approval`` with the matching
history entry, exactly as ``create_booking_request`` writes its rows at
``draft``. Every later move goes through :mod:`app.services.lifecycle`.
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import (
    Merchant,
    PassengerData,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    TravelType,
    User,
)
from app.services import (
    activity_service,
    lifecycle,
    merchant_service,
    notification_service,
    ticket_service,
)


#: Enquiry wording for the shared statuses. ``lifecycle.SPEC_LABELS`` says
#: "Approved"/"Rejected", which are right for a booking but read wrongly here —
#: an approved enquiry means "we have this, go ahead and book". The stored
#: status is untouched; only the wording differs, and the Classic merchant UI
#: uses the same map so both surfaces say the same thing.
ENQUIRY_LABELS: dict[S, str] = {
    S.PENDING_APPROVAL: "Pending",
    S.IN_REVIEW: "Under Review",
    S.APPROVED: "Available",
    S.REJECTED: "Not Available",
    S.CANCELLED: "Cancelled",
}


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _next_reference(db: Session) -> str:
    """Allocate ``ENQ-20260730-000123``.

    Date-stamped rather than year-stamped (the spec's format), and backed by
    the sequence migration 0030 adds so two concurrent enquiries cannot
    collide on ``uq_service_requests_number``.
    """
    number = db.scalar(select(func.nextval("seq_enquiry_number")))
    return f"ENQ-{_now():%Y%m%d}-{number:06d}"


def _title(payload) -> str:
    """What the enquiry is called on every screen that lists requests.

    The flight number is upper-cased here for the same reason it is in
    ``travel_details``: the merchant types "ai217" as readily as "AI217", and a
    title that disagrees with the stored value reads as two different flights.
    """
    route = f"{payload.origin_city or payload.origin} → {payload.destination_city or payload.destination}"
    return f"Enquiry: {route} · {payload.airline.strip()} {payload.flight_number.strip().upper()}"


def _base_filter(actor: User):
    """Enquiries this actor may see, honouring the same scoping as requests."""
    return and_(
        ticket_service.scoped_query(actor),
        ServiceRequest.request_type == RequestType.TICKET_ENQUIRY,
    )


# ---------------------------------------------------------------------------
# Merchant
# ---------------------------------------------------------------------------
def create(db: Session, actor: User, payload) -> ServiceRequest:
    """Raise an enquiry and put it straight in front of the Admin team."""
    if actor.merchant_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only merchant accounts can raise ticket enquiries",
        )

    now = _now()
    enquiry = ServiceRequest(
        request_number=_next_reference(db),
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.TICKET_ENQUIRY,
        # Flight-only by design: the form asks for an airline and a flight
        # number, neither of which a hotel or cruise enquiry would carry.
        travel_type=TravelType.FLIGHT,
        status=S.PENDING_APPROVAL,
        title=_title(payload),
        remarks=payload.notes,
        travel_details={
            "trip_type": payload.trip_type,
            "origin": payload.origin.strip(),
            "origin_city": (payload.origin_city or "").strip() or None,
            "destination": payload.destination.strip(),
            "destination_city": (payload.destination_city or "").strip() or None,
            "airline": payload.airline.strip(),
            "flight_number": payload.flight_number.strip().upper(),
            "preferred_time": payload.preferred_time,
            "return_preferred_time": payload.return_preferred_time,
            "travel_class": payload.travel_class.strip(),
            "passenger_count": payload.passenger_count,
            "adults": payload.adults,
            "children": payload.children,
            "infants": payload.infants,
        },
        quantity=payload.passenger_count,
        # An enquiry asks what a sector costs; it does not owe anything. The
        # amount is set on the booking the Admin approves, not here.
        total_amount=Decimal("0"),
        travel_date=payload.travel_date,
        return_date=payload.return_date,
        # An enquiry has no draft stage, so the row is born submitted. Writing
        # the history entry here keeps the Activity Timeline complete —
        # lifecycle.transition() owns every *move*, but not the initial value,
        # which create_booking_request also sets directly.
        status_history=[
            {
                "from": S.DRAFT.value,
                "to": S.PENDING_APPROVAL.value,
                "label": "Enquiry submitted",
                "by": actor.user_id,
                "by_name": actor.full_name,
                "at": now.isoformat(),
            }
        ],
    )
    db.add(enquiry)
    db.commit()
    db.refresh(enquiry)

    activity_service.log_activity(
        db, actor.user_id, "Ticket enquiry raised",
        activity_type="Enquiry", module="Ticket Enquiry",
        description=f"{actor.full_name} raised {enquiry.request_number}",
        reference_id=enquiry.request_id, merchant_id=actor.merchant_id,
    )
    notification_service.notify_admins(
        db,
        "New ticket enquiry",
        f"{enquiry.request_number} — {enquiry.title} — needs a response.",
    )
    return enquiry


def list_enquiries(
    db: Session,
    actor: User,
    *,
    page: int = 1,
    page_size: int = 20,
    request_status: S | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
) -> tuple[list[ServiceRequest], int]:
    conditions = [_base_filter(actor)]
    if request_status is not None:
        conditions.append(ServiceRequest.status == request_status)
    if merchant_id is not None and actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    if search:
        pattern = f"%{search}%"
        conditions.append(
            ServiceRequest.request_number.ilike(pattern)
            | ServiceRequest.title.ilike(pattern)
            | ServiceRequest.travel_details["flight_number"].astext.ilike(pattern)
            | ServiceRequest.travel_details["destination_city"].astext.ilike(pattern)
            | ServiceRequest.travel_details["origin_city"].astext.ilike(pattern)
        )

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    rows = db.scalars(
        select(ServiceRequest)
        .where(where)
        .order_by(ServiceRequest.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return list(rows), total


def get(db: Session, actor: User, enquiry_id: int) -> ServiceRequest:
    enquiry = db.scalars(
        select(ServiceRequest).where(
            and_(ServiceRequest.request_id == enquiry_id, _base_filter(actor))
        )
    ).first()
    if not enquiry:
        # 404 not 403 — never confirm another merchant's enquiry exists.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Enquiry not found"
        )
    return enquiry


def _locked(db: Session, actor: User, enquiry_id: int) -> ServiceRequest:
    """Re-read the enquiry under a row lock, for the actions that mutate it.

    Two admins opening the same enquiry is normal; two admins *answering* it
    at the same instant must not both succeed. ``SELECT ... FOR UPDATE`` makes
    the second caller wait for the first to commit, so its status re-check
    below sees the committed outcome rather than the stale value it loaded
    when the screen was rendered. Checking without the lock would be a
    time-of-check/time-of-use race: both would read *Pending* and both would
    transition.

    ``scoped_query`` contributes only WHERE terms (no outer join), so the lock
    is safe to take here — Postgres refuses FOR UPDATE on the nullable side of
    an outer join.
    """
    enquiry = db.scalars(
        select(ServiceRequest)
        .where(and_(ServiceRequest.request_id == enquiry_id, _base_filter(actor)))
        .with_for_update()
    ).first()
    if not enquiry:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Enquiry not found"
        )
    return enquiry


def _reviewer(enquiry: ServiceRequest) -> tuple[int | None, str | None]:
    d = enquiry.travel_details or {}
    return d.get("review_claimed_by"), d.get("review_claimed_by_name")


def _guard_not_answered(enquiry: ServiceRequest) -> None:
    """An answered enquiry is final — the merchant raises a new one instead."""
    if enquiry.status in (S.APPROVED, S.REJECTED, S.CANCELLED):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{enquiry.request_number} has already been answered — it is "
                f"{ENQUIRY_LABELS.get(enquiry.status, enquiry.status.value)}. "
                "An answered enquiry cannot be changed; ask the merchant to raise a new one."
            ),
        )


def _guard_claim(enquiry: ServiceRequest, actor: User) -> None:
    """Block a second admin from answering one already under someone's review."""
    holder_id, holder_name = _reviewer(enquiry)
    if (
        enquiry.status is S.IN_REVIEW
        and holder_id is not None
        and holder_id != actor.user_id
    ):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another admin'} is already reviewing "
                f"{enquiry.request_number}. Only they can answer it."
            ),
        )


def _audit(
    db: Session, actor: User, enquiry: ServiceRequest, action: str,
    *, before: S, after: S, note: str | None = None,
) -> None:
    """One actor-attributed audit entry per admin action.

    The ``audit_logs`` trigger on ``service_requests`` already stores the full
    before/after row, but its ``changed_by`` is always NULL — a DB trigger has
    no idea which application user is behind the connection. This records who,
    when, and the exact status edge, and it is queryable from the Admin
    activity feed.
    """
    activity_service.log_activity(
        db, actor.user_id, action,
        activity_type="Enquiry", module="Ticket Enquiry",
        description=(
            f"{actor.full_name} moved {enquiry.request_number} from "
            f"{ENQUIRY_LABELS.get(before, before.value)} to "
            f"{ENQUIRY_LABELS.get(after, after.value)}"
        ),
        reference_id=enquiry.request_id, merchant_id=enquiry.merchant_id,
        details={
            "enquiry_reference": enquiry.request_number,
            "from_status": before.value,
            "to_status": after.value,
            "actor_id": actor.user_id,
            "actor_name": actor.full_name,
            "merchant_name": enquiry.merchant.company_name if enquiry.merchant else None,
            **({"note": note} if note else {}),
        },
    )


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
def start_review(db: Session, actor: User, enquiry_id: int) -> ServiceRequest:
    """Claim a Pending enquiry: Pending -> Under Review, owned by this admin.

    This is what makes **Under Review** a real state rather than a label the
    status filter offers but nothing ever occupies. Claiming is also the
    concurrency gate: :func:`_guard_claim` then refuses an answer from anyone
    but the holder, so two admins cannot work the same enquiry into two
    different outcomes.

    Re-claiming your own enquiry is a no-op rather than an error — an admin who
    reopens the panel should not be punished for it.
    """
    enquiry = _locked(db, actor, enquiry_id)
    _guard_not_answered(enquiry)

    holder_id, holder_name = _reviewer(enquiry)
    if enquiry.status is S.IN_REVIEW:
        if holder_id == actor.user_id:
            return enquiry
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another admin'} is already reviewing "
                f"{enquiry.request_number}."
            ),
        )

    before = enquiry.status
    now = _now()
    lifecycle.transition(db, enquiry, S.IN_REVIEW, actor, commit=False)
    # Reassign rather than mutate: SQLAlchemy does not track in-place changes
    # to a JSONB dict.
    enquiry.travel_details = {
        **(enquiry.travel_details or {}),
        "review_claimed_by": actor.user_id,
        "review_claimed_by_name": actor.full_name,
        "review_claimed_at": now.isoformat(),
    }
    db.commit()
    db.refresh(enquiry)

    _audit(db, actor, enquiry, "Ticket enquiry review started",
           before=before, after=S.IN_REVIEW)
    return enquiry


def respond(
    db: Session, actor: User, enquiry_id: int, *, available: bool,
    reason: str | None = None, response: str | None = None,
) -> ServiceRequest:
    """Answer an enquiry: available for booking, or not.

    Approving stops at **Approved**. It deliberately does *not* walk on to
    Payment Pending the way :func:`ticket_service.approve_request` does for a
    booking — nothing is owed on an enquiry, and a payable enquiry would show
    the merchant a Pay button against a zero amount.

    The answer is final either way: :func:`_guard_not_answered` refuses a
    second response, so a merchant who needs a different answer raises a new
    enquiry rather than having this one quietly rewritten underneath a booking
    they may already have made against it.
    """
    enquiry = _locked(db, actor, enquiry_id)
    _guard_not_answered(enquiry)
    _guard_claim(enquiry, actor)

    before = enquiry.status
    if response:
        enquiry.travel_details = {**(enquiry.travel_details or {}), "admin_response": response}

    if not available:
        lifecycle.transition(db, enquiry, S.REJECTED, actor, reason=reason, commit=False)
        db.commit()
        db.refresh(enquiry)

        _audit(db, actor, enquiry, "Ticket enquiry marked not available",
               before=before, after=S.REJECTED, note=reason)
        ticket_service._notify_merchant(
            db, enquiry, "Ticket enquiry: not available",
            f"{enquiry.request_number} — {reason or 'this sector is not available.'}",
        )
        return enquiry

    if enquiry.status is S.PENDING_APPROVAL:
        lifecycle.transition(db, enquiry, S.IN_REVIEW, actor, commit=False)
    lifecycle.transition(db, enquiry, S.APPROVED, actor, note=response, commit=False)
    db.commit()
    db.refresh(enquiry)

    _audit(db, actor, enquiry, "Ticket enquiry marked available",
           before=before, after=S.APPROVED, note=response)
    ticket_service._notify_merchant(
        db, enquiry, "Ticket enquiry: available to book",
        f"{enquiry.request_number} is available. Use Request Ticket to raise the booking.",
    )
    return enquiry


# ---------------------------------------------------------------------------
# Enquiry -> Booking Request
# ---------------------------------------------------------------------------
def to_booking_request(
    db: Session, actor: User, enquiry_id: int, *, passengers: list[dict],
    remarks: str | None = None, contact: dict | None = None,
    international: bool = False, special_requests: str | None = None,
) -> ServiceRequest:
    """Create the draft booking the Request Ticket button leads to.

    Every itinerary field is copied from the enquiry rather than accepted from
    the caller, so the booking that reaches the approvals desk is the journey
    the Admin actually said yes to. Only the passengers are new.

    The booking's parent is the **enquiry**, not a catalog row. That is what
    makes the two traceable to each other, and it is safe for the existing
    submit path: ``catalog_service.reserve_units`` returns immediately when
    ``available_units`` is NULL, which it is on an enquiry — so submitting
    reserves nothing and cancelling releases nothing.
    """
    # Locked for the same reason the admin actions are: two Request Ticket
    # clicks landing together would both read booking_request_id as empty and
    # both raise a booking against one answer.
    enquiry = _locked(db, actor, enquiry_id)

    if enquiry.status is not S.APPROVED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                "Only an enquiry our team has marked available can be turned into a "
                f"booking — this one is "
                f"{lifecycle.SPEC_LABELS.get(enquiry.status, enquiry.status.value)}"
            ),
        )

    details = dict(enquiry.travel_details or {})
    existing_id = details.get("booking_request_id")
    if existing_id:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"This enquiry has already been booked as "
                f"{details.get('booking_request_number') or existing_id}"
            ),
        )
    if not passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one passenger is required",
        )

    merchant = db.get(Merchant, enquiry.merchant_id)
    booking = ServiceRequest(
        request_number=ticket_service._next_number(db, "REQ"),
        parent_request_id=enquiry.request_id,
        merchant_id=enquiry.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.BOOKING,
        booking_reference=merchant_service.next_booking_reference(db, merchant),
        travel_type=enquiry.travel_type,
        status=S.DRAFT,
        title=(enquiry.title or "").replace("Enquiry: ", "", 1) or enquiry.title,
        remarks=remarks,
        # The enquiry's own details are spread first so the itinerary is
        # verbatim what was answered; only the booking-specific additions are
        # layered on. The review claim is dropped — it belongs to the enquiry's
        # workflow, not this booking's.
        travel_details={
            **{k: v for k, v in details.items() if not k.startswith("review_claimed")},
            "enquiry_reference": enquiry.request_number,
            "contact": contact or {},
            "international": bool(international),
            "special_requests": (special_requests or "").strip() or None,
        },
        # There is no catalog row to price against: the fare on an enquiry-led
        # booking is whatever the Admin confirms at approval (approve_request's
        # `final_amount`). A zero here is honest — the Classic UI shows
        # "Awaiting amount" rather than a Pay button that could only 400.
        pricing={"currency": "INR", "quoted": False, "source": "ticket_enquiry"},
        quantity=len(passengers),
        total_amount=Decimal("0"),
        travel_date=enquiry.travel_date,
        return_date=enquiry.return_date,
        status_history=[],
    )
    db.add(booking)
    db.flush()

    for p in passengers:
        db.add(
            PassengerData(
                request_id=booking.request_id,
                merchant_id=enquiry.merchant_id,
                **ticket_service.passenger_columns(p),
            )
        )

    # Stamp the link back so the enquiry listing shows the booking instead of
    # offering Request Ticket a second time.
    enquiry.travel_details = {
        **details,
        "booking_request_id": booking.request_id,
        "booking_request_number": booking.request_number,
    }

    db.commit()
    db.refresh(booking)

    activity_service.log_activity(
        db, actor.user_id, "Booking request created from enquiry",
        activity_type="Booking", module="Booking Request",
        description=(
            f"{actor.full_name} drafted {booking.request_number} "
            f"from enquiry {enquiry.request_number}"
        ),
        reference_id=booking.request_id, merchant_id=booking.merchant_id,
    )
    return booking


def load_with_passengers(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Re-read a booking with its passengers eagerly loaded, for the response."""
    return db.scalars(
        select(ServiceRequest)
        .options(selectinload(ServiceRequest.passengers))
        .where(
            and_(
                ServiceRequest.request_id == request_id,
                ticket_service.scoped_query(actor),
            )
        )
    ).one()
