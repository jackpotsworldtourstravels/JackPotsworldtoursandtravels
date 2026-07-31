"""Booking operations — the desk that works a booking after it is approved.

WHERE THIS SITS
``ticket_service`` owns the *lifecycle* (approve, pay, issue, complete) and
``approval_service`` owns the pre-approval queue. This module owns everything
the operations desk does *alongside* that lifecycle without changing it: who is
working the booking, what they wrote down, and the real-world identifiers that
came back from the airline.

Nothing here calls ``lifecycle.transition``. Assigning an operator, writing a
note or recording a PNR must never move a booking's status — a desk should be
able to record a PNR without that being an implicit "ticket issued", and the
one function that changes status stays the one function that changes status.

STAFF ONLY, EVERY ENTRY POINT
Every function here begins with :func:`_staff` — a merchant has no business
seeing who is assigned to their booking or what the desk wrote about them.
That is enforced per call rather than only at the router, so a future internal
caller cannot bypass it by not being an HTTP request.
"""
import datetime

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, selectinload

from app.auth.rbac import P, has_permission
from app.models_v2 import (
    Merchant,
    RequestNote,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    User,
    UserStatus,
)
from app.services import activity_service

#: The stages a booking passes through *after* approval. This is the operations
#: desk's world; anything earlier belongs to the Approval Queue, and the two
#: screens deliberately do not overlap so a booking is never worked twice.
QUEUE_STAGES: tuple[S, ...] = (
    S.APPROVED,
    S.PAYMENT_PENDING,
    S.PAID,
    S.TICKET_ISSUED,
)

#: Recording an airline reference only makes sense once the booking is real —
#: i.e. the merchant has committed and we are dealing with the airline. Before
#: approval there is nothing to have a PNR for.
REFERENCE_STAGES: frozenset[S] = frozenset(QUEUE_STAGES) | {S.COMPLETED}


def _staff(actor: User) -> None:
    """Refuse anyone who is not platform staff.

    A 403 rather than a 404: unlike a cross-merchant read, this leaks nothing —
    the caller already knows the endpoint exists because it is theirs to call
    or not, and a plain "not yours" is more useful than a fake not-found.
    """
    if not actor.is_platform_staff:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Booking operations are restricted to platform staff",
        )


def _booking(db: Session, actor: User, request_id: int, *, lock: bool = False) -> ServiceRequest:
    """A booking this staff member may work on, optionally locked."""
    _staff(actor)
    stmt = select(ServiceRequest).where(ServiceRequest.request_id == request_id)
    if lock:
        stmt = stmt.with_for_update()
    request = db.scalars(stmt).first()
    if not request:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Booking not found"
        )
    if request.request_type is RequestType.CATALOG_ITEM:
        # Catalog rows share this table but are inventory, not bookings.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Booking not found"
        )
    return request


# ---------------------------------------------------------------------------
# Processing queue
# ---------------------------------------------------------------------------
def stage_counts(db: Session, actor: User, *, mine_only_for: int | None = None) -> dict[str, int]:
    """How many bookings sit at each post-approval stage.

    Drives the queue's tab badges. Counted in one grouped query rather than one
    query per tab, because this runs on every queue load.
    """
    _staff(actor)
    conditions = [
        ServiceRequest.request_type == RequestType.BOOKING,
        ServiceRequest.status.in_(QUEUE_STAGES),
    ]
    if mine_only_for is not None:
        conditions.append(ServiceRequest.assigned_admin == mine_only_for)

    rows = db.execute(
        select(ServiceRequest.status, func.count())
        .where(and_(*conditions))
        .group_by(ServiceRequest.status)
    ).all()

    counts = {s.value: 0 for s in QUEUE_STAGES}
    for status, n in rows:
        counts[status.value] = n
    counts["total"] = sum(counts[s.value] for s in QUEUE_STAGES)

    # "Nobody is working this" is the number the desk actually acts on, so it
    # is computed here rather than left to the client to derive.
    counts["unassigned"] = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(
            and_(*conditions, ServiceRequest.assigned_admin.is_(None))
        )
    ) or 0
    return counts


def list_queue(
    db: Session,
    actor: User,
    *,
    page: int = 1,
    page_size: int = 20,
    stage: S | None = None,
    assigned_to: int | None = None,
    unassigned: bool = False,
    merchant_id: int | None = None,
    search: str | None = None,
) -> tuple[list[ServiceRequest], int]:
    """The processing queue: approved-and-onward bookings, oldest first.

    Oldest first on purpose — this is a work queue, not a feed. The booking
    that has been waiting longest is the one at risk, and sorting newest-first
    would bury it.
    """
    _staff(actor)
    conditions = [
        ServiceRequest.request_type == RequestType.BOOKING,
        ServiceRequest.status.in_([stage] if stage else QUEUE_STAGES),
    ]
    if unassigned:
        conditions.append(ServiceRequest.assigned_admin.is_(None))
    elif assigned_to is not None:
        conditions.append(ServiceRequest.assigned_admin == assigned_to)
    if merchant_id is not None:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    if search:
        pattern = f"%{search.strip()}%"
        conditions.append(
            ServiceRequest.request_number.ilike(pattern)
            | ServiceRequest.booking_reference.ilike(pattern)
            | ServiceRequest.pnr.ilike(pattern)
            | ServiceRequest.ticket_number.ilike(pattern)
            | ServiceRequest.title.ilike(pattern)
        )

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    items = list(
        db.scalars(
            select(ServiceRequest)
            # Eager-loaded: the queue renders passenger names and the merchant
            # company on every row, which is a textbook N+1 without this.
            .options(
                selectinload(ServiceRequest.passengers),
                selectinload(ServiceRequest.merchant),
            )
            .where(where)
            .order_by(ServiceRequest.created_at.asc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()
    )
    return items, total


# ---------------------------------------------------------------------------
# Operator assignment
# ---------------------------------------------------------------------------
def assignable_operators(db: Session, actor: User) -> list[User]:
    """Staff who could actually work a booking.

    Filtered by the permission the work needs rather than by role name, so a
    Super Admin who grants ``ticket.approve`` to a new role does not also have
    to remember to update this list.
    """
    _staff(actor)
    staff = db.scalars(
        select(User)
        .where(User.merchant_id.is_(None), User.status == UserStatus.ACTIVE)
        .order_by(User.full_name)
    ).all()
    return [u for u in staff if has_permission(u, P.TICKET_APPROVE)]


def assign(db: Session, actor: User, request_id: int, operator_id: int | None) -> ServiceRequest:
    """Give the booking to an operator, or hand it back to the pool.

    Reassignment is allowed rather than refused: a supervisor moving work off
    someone who is away is normal desk behaviour, and an enquiry-style
    first-claim-wins lock would make that impossible without a database edit.
    The last write therefore wins — but never silently, because the row is
    locked for the read-modify-write and the activity log records the exact
    operator it moved *from*, which a torn read would have got wrong.
    """
    request = _booking(db, actor, request_id, lock=True)

    if operator_id is None:
        previous, new_name = request.assigned_admin, None
        request.assigned_admin = None
    else:
        operator = db.get(User, operator_id)
        if not operator or operator.merchant_id is not None:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="That user is not a platform operator",
            )
        if operator.status is not UserStatus.ACTIVE:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=f"{operator.full_name} is not an active user",
            )
        if not has_permission(operator, P.TICKET_APPROVE):
            # Assigning work to someone who cannot action it is a silent
            # dead end for the booking, so it is refused rather than allowed.
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=f"{operator.full_name} does not have permission to work bookings",
            )
        previous, new_name = request.assigned_admin, operator.full_name
        request.assigned_admin = operator_id

    db.commit()
    db.refresh(request)

    was = db.get(User, previous).full_name if previous else "nobody"
    activity_service.log_activity(
        db, actor.user_id,
        "Booking assigned" if operator_id else "Booking unassigned",
        activity_type="Booking", module="Booking Operations",
        description=(
            f"{actor.full_name} assigned {request.request_number} to {new_name}"
            if operator_id else
            f"{actor.full_name} returned {request.request_number} to the unassigned pool"
        ),
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={
            "request_number": request.request_number,
            "from_operator": was,
            "to_operator": new_name,
        },
    )
    return request


# ---------------------------------------------------------------------------
# External references (airline PNR, ticket number)
# ---------------------------------------------------------------------------
def set_references(
    db: Session,
    actor: User,
    request_id: int,
    *,
    pnr: str | None = None,
    ticket_number: str | None = None,
    airline_reference: str | None = None,
) -> ServiceRequest:
    """Record what the airline gave us back.

    ``issue_ticket`` allocates a synthetic PNR so the platform always has one;
    this is how the *real* airline locator replaces it. Overwriting is allowed
    on purpose — a reissue produces a new PNR and the desk must be able to
    correct a typo — but every change is logged with its previous value, which
    is what makes the overwrite safe to allow.

    Only ``ticket_number`` is uniqueness-constrained in the schema; a PNR is
    deliberately not, because one airline locator legitimately covers every
    passenger on a group booking.
    """
    request = _booking(db, actor, request_id, lock=True)

    if request.status not in REFERENCE_STAGES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} is not confirmed yet, so it has no airline "
                "reference to record. Approve it first."
            ),
        )

    before = {
        "pnr": request.pnr,
        "ticket_number": request.ticket_number,
        "airline_reference": (request.travel_details or {}).get("airline_reference"),
    }

    if pnr is not None:
        cleaned = pnr.strip().upper()
        if not cleaned:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="A PNR cannot be blank — leave it out to keep the current one",
            )
        request.pnr = cleaned

    if ticket_number is not None:
        cleaned = ticket_number.strip()
        if not cleaned:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="A ticket number cannot be blank",
            )
        clash = db.scalars(
            select(ServiceRequest).where(
                and_(
                    ServiceRequest.ticket_number == cleaned,
                    ServiceRequest.request_id != request.request_id,
                )
            )
        ).first()
        if clash:
            # Caught here so the desk gets a sentence naming the other booking
            # instead of a raw unique-violation 500 from uq_sr_ticket_number.
            raise HTTPException(
                status_code=http_status.HTTP_409_CONFLICT,
                detail=f"Ticket number {cleaned} is already on {clash.request_number}",
            )
        request.ticket_number = cleaned

    if airline_reference is not None:
        # Reassigned rather than mutated: SQLAlchemy does not track in-place
        # changes to a JSONB dict.
        details = dict(request.travel_details or {})
        details["airline_reference"] = airline_reference.strip() or None
        request.travel_details = details

    db.commit()
    db.refresh(request)

    after = {
        "pnr": request.pnr,
        "ticket_number": request.ticket_number,
        "airline_reference": (request.travel_details or {}).get("airline_reference"),
    }
    changed = {k: {"from": before[k], "to": after[k]} for k in after if before[k] != after[k]}
    if changed:
        activity_service.log_activity(
            db, actor.user_id, "Booking references updated",
            activity_type="Booking", module="Booking Operations",
            description=(
                f"{actor.full_name} updated "
                f"{', '.join(sorted(changed))} on {request.request_number}"
            ),
            reference_id=request.request_id, merchant_id=request.merchant_id,
            details={"request_number": request.request_number, "changes": changed},
        )
    return request


# ---------------------------------------------------------------------------
# Internal notes
# ---------------------------------------------------------------------------
def list_notes(db: Session, actor: User, request_id: int) -> list[RequestNote]:
    _booking(db, actor, request_id)
    return list(
        db.scalars(
            select(RequestNote)
            .where(RequestNote.request_id == request_id)
            .order_by(RequestNote.note_id.desc())
        ).all()
    )


def add_note(db: Session, actor: User, request_id: int, body: str) -> RequestNote:
    request = _booking(db, actor, request_id)
    text = (body or "").strip()
    if not text:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="A note cannot be empty"
        )

    note = RequestNote(
        request_id=request.request_id,
        merchant_id=request.merchant_id,
        author_id=actor.user_id,
        body=text,
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    activity_service.log_activity(
        db, actor.user_id, "Internal note added",
        activity_type="Booking", module="Booking Operations",
        description=f"{actor.full_name} added an internal note to {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
        # The body is deliberately not copied into the activity feed: the feed
        # is visible in places the note is not, and duplicating it there would
        # undo the staff-only guarantee the note was written under.
        details={"request_number": request.request_number, "note_id": note.note_id},
    )
    return note


def _own_note(db: Session, actor: User, note_id: int) -> RequestNote:
    _staff(actor)
    note = db.get(RequestNote, note_id)
    if not note:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Note not found"
        )
    # Only the author may rewrite history. Anyone else who disagrees adds their
    # own note, which is what leaves the disagreement visible.
    if note.author_id != actor.user_id:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only the author can change a note",
        )
    return note


def edit_note(db: Session, actor: User, note_id: int, body: str) -> RequestNote:
    note = _own_note(db, actor, note_id)
    text = (body or "").strip()
    if not text:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="A note cannot be empty"
        )
    note.body = text
    note.edited_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    db.refresh(note)
    return note


def delete_note(db: Session, actor: User, note_id: int) -> None:
    note = _own_note(db, actor, note_id)
    request_id, merchant_id = note.request_id, note.merchant_id
    db.delete(note)
    db.commit()
    activity_service.log_activity(
        db, actor.user_id, "Internal note deleted",
        activity_type="Booking", module="Booking Operations",
        description=f"{actor.full_name} deleted an internal note",
        reference_id=request_id, merchant_id=merchant_id,
        details={"note_id": note_id},
    )


# ---------------------------------------------------------------------------
# Detail
# ---------------------------------------------------------------------------
def get_booking(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """One booking, with everything the operations detail view renders."""
    _staff(actor)
    request = db.scalars(
        select(ServiceRequest)
        .options(
            selectinload(ServiceRequest.passengers),
            selectinload(ServiceRequest.documents),
            selectinload(ServiceRequest.payments),
            selectinload(ServiceRequest.merchant),
        )
        .where(ServiceRequest.request_id == request_id)
    ).first()
    if not request or request.request_type is RequestType.CATALOG_ITEM:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Booking not found"
        )
    return request


def operator_name(db: Session, request: ServiceRequest) -> str | None:
    if not request.assigned_admin:
        return None
    user = db.get(User, request.assigned_admin)
    return user.full_name if user else None
