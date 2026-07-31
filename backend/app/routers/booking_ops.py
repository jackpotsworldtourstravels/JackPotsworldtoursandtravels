"""Booking Operations — the post-approval desk (Phase 4).

Deliberately separate from ``admin_ops.approval_queue``: that queue ends the
moment a booking is approved, and this one begins there. A booking is therefore
in exactly one of the two at any time, which is what stops two people working
it from two screens.

Permissions reuse the existing ticket codes — ``ticket.view`` to look,
``ticket.approve`` to act. No new permission codes: "may work a booking" is
already exactly what ``ticket.approve`` means, and inventing a parallel code
would let the two drift apart.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import RequestStatus, RequestType, ServiceRequest, User
from app.schemas.booking_ops import (
    AssignRequest,
    NoteRequest,
    NoteResponse,
    OperatorOption,
    QueueCounts,
    QueueItem,
    ReferencesRequest,
)
from app.schemas.pagination import Page
from app.services import booking_ops_service

router = APIRouter(prefix="/api/admin/bookings", tags=["admin · booking operations"])


# ---------------------------------------------------------------------------
# Processing queue
# ---------------------------------------------------------------------------
@router.get(
    "/queue",
    response_model=Page[QueueItem],
    summary="Booking processing queue",
    description=(
        "Requires `ticket.view`. Bookings that have been approved and are now being worked: "
        "Approved → Payment Pending → Paid → Ticket Issued. **Oldest first** — this is a work "
        "queue, so the longest-waiting booking leads. Filter by `stage`, by `assigned_to`, or "
        "by `unassigned=true`; `search` matches request number, booking reference, PNR, ticket "
        "number and title."
    ),
)
def queue(
    stage: RequestStatus | None = None,
    assigned_to: int | None = None,
    unassigned: bool = False,
    merchant_id: int | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    if stage is not None and stage not in booking_ops_service.QUEUE_STAGES:
        # A stage outside the desk's world is a caller bug, not an empty page.
        allowed = ", ".join(s.value for s in booking_ops_service.QUEUE_STAGES)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"stage must be one of: {allowed}",
        )

    items, total = booking_ops_service.list_queue(
        db, current_user, page=page, page_size=page_size, stage=stage,
        assigned_to=assigned_to, unassigned=unassigned, merchant_id=merchant_id,
        search=search,
    )
    # One lookup for every operator on the page rather than one per row.
    operator_ids = {r.assigned_admin for r in items if r.assigned_admin}
    names = {
        u.user_id: u.full_name
        for u in db.scalars(select(User).where(User.user_id.in_(operator_ids))).all()
    } if operator_ids else {}

    return Page.build(
        [QueueItem.of(r, operator=names.get(r.assigned_admin)) for r in items],
        total, page, page_size,
    )


@router.get(
    "/queue/counts",
    response_model=QueueCounts,
    summary="Queue tab badges",
    description=(
        "Requires `ticket.view`. How many bookings sit at each post-approval stage, plus "
        "`unassigned`. Pass `mine=true` to count only your own. One grouped query, not one "
        "per tab."
    ),
)
def queue_counts(
    mine: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    counts = booking_ops_service.stage_counts(
        db, current_user, mine_only_for=current_user.user_id if mine else None
    )
    return QueueCounts(**counts)


# ---------------------------------------------------------------------------
# Operator assignment
# ---------------------------------------------------------------------------
@router.get(
    "/operators",
    response_model=list[OperatorOption],
    summary="Operators a booking can be assigned to",
    description=(
        "Requires `ticket.view`. Active platform staff holding `ticket.approve`, each with the "
        "number of post-approval bookings they already hold — assigning blind is how one "
        "operator ends up with the whole queue."
    ),
)
def operators(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    staff = booking_ops_service.assignable_operators(db, current_user)
    if not staff:
        return []

    loads = dict(
        db.execute(
            select(ServiceRequest.assigned_admin, func.count())
            .where(
                ServiceRequest.request_type == RequestType.BOOKING,
                ServiceRequest.status.in_(booking_ops_service.QUEUE_STAGES),
                ServiceRequest.assigned_admin.in_([u.user_id for u in staff]),
            )
            .group_by(ServiceRequest.assigned_admin)
        ).all()
    )
    return [
        OperatorOption(
            id=u.user_id, full_name=u.full_name, email=u.email,
            role=u.role.value, open_bookings=loads.get(u.user_id, 0),
        )
        for u in staff
    ]


@router.post(
    "/{request_id}/assign",
    response_model=QueueItem,
    summary="Assign a booking to an operator",
    description=(
        "Requires `ticket.approve`. Send `operator_id: null` to return the booking to the "
        "unassigned pool. Row-locked, so two admins assigning at once cannot both believe they "
        "won. The operator must be active platform staff who holds `ticket.approve` — assigning "
        "work to someone who cannot action it is refused rather than allowed."
    ),
)
def assign(
    request_id: int,
    payload: AssignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE)),
):
    request = booking_ops_service.assign(db, current_user, request_id, payload.operator_id)
    return QueueItem.of(request, operator=booking_ops_service.operator_name(db, request))


# ---------------------------------------------------------------------------
# External references
# ---------------------------------------------------------------------------
@router.put(
    "/{request_id}/references",
    response_model=QueueItem,
    summary="Record the airline PNR and ticket number",
    description=(
        "Requires `ticket.approve`. Replaces the synthetic PNR allocated at issue time with the "
        "real airline locator. Only the fields you send are written, so updating the PNR cannot "
        "blank the ticket number. Allowed from Approved onward — before that there is nothing to "
        "have a reference for. Overwriting is permitted (reissues happen) and every change is "
        "logged with its previous value. A duplicate ticket number returns 409 naming the other "
        "booking rather than a unique-violation 500."
    ),
)
def set_references(
    request_id: int,
    payload: ReferencesRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE)),
):
    request = booking_ops_service.set_references(
        db, current_user, request_id,
        pnr=payload.pnr, ticket_number=payload.ticket_number,
        airline_reference=payload.airline_reference,
    )
    return QueueItem.of(request, operator=booking_ops_service.operator_name(db, request))


# ---------------------------------------------------------------------------
# Internal notes
# ---------------------------------------------------------------------------
@router.get(
    "/{request_id}/notes",
    response_model=list[NoteResponse],
    summary="Internal notes on a booking",
    description=(
        "Requires `ticket.view` **and** platform staff. These are staff-only by design and are "
        "never included in any merchant-facing response — a merchant calling this gets 403, not "
        "an empty list."
    ),
)
def list_notes(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    notes = booking_ops_service.list_notes(db, current_user, request_id)
    authors = {
        u.user_id: u.full_name
        for u in db.scalars(
            select(User).where(User.user_id.in_({n.author_id for n in notes if n.author_id}))
        ).all()
    } if notes else {}
    return [
        NoteResponse.of(n, author=authors.get(n.author_id), viewer_id=current_user.user_id)
        for n in notes
    ]


@router.post(
    "/{request_id}/notes",
    response_model=NoteResponse,
    status_code=201,
    summary="Add an internal note",
    description=(
        "Requires `ticket.view` and platform staff. The note body is deliberately **not** copied "
        "into the activity feed — the feed surfaces in places the note does not, and duplicating "
        "it there would undo the staff-only guarantee it was written under."
    ),
)
def add_note(
    request_id: int,
    payload: NoteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    note = booking_ops_service.add_note(db, current_user, request_id, payload.body)
    return NoteResponse.of(note, author=current_user.full_name, viewer_id=current_user.user_id)


@router.put(
    "/notes/{note_id}",
    response_model=NoteResponse,
    summary="Edit your own note",
    description=(
        "Requires `ticket.view`. **Only the author** may edit; anyone who disagrees adds their "
        "own note, which is what leaves the disagreement visible. Sets `edited_at` so an amended "
        "note is distinguishable from an original."
    ),
)
def edit_note(
    note_id: int,
    payload: NoteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    note = booking_ops_service.edit_note(db, current_user, note_id, payload.body)
    return NoteResponse.of(note, author=current_user.full_name, viewer_id=current_user.user_id)


@router.delete(
    "/notes/{note_id}",
    status_code=204,
    summary="Delete your own note",
    description="Requires `ticket.view`. Only the author may delete. The deletion is logged.",
)
def delete_note(
    note_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    booking_ops_service.delete_note(db, current_user, note_id)
    return None
