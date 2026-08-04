"""Cancellation & Reschedule (M3) — a confirmed booking moving backwards.

TWO PREFIXES, ONE RESOURCE
Merchant-facing paths sit under ``/api/bookings`` and ``/api/change-requests``;
staff settlement sits under ``/api/admin/change-requests``. The split is the
same one the rest of this API uses: a path a merchant may call never begins
``/api/admin``, so "can this caller reach this at all" is answerable from the
URL before any permission is evaluated.

PERMISSIONS
``servicerequest.create`` to raise (merchant roles), ``servicerequest.manage``
to review, approve or reject (Admin), and ``ticket.view`` to read. Those three
already mean exactly this; a parallel ``cancellation.*`` family would only give
them a way to drift apart.

The merchant's own sign-off — ``servicerequest.approve``, held by their manager
— is not here. It applies to every service request type, not just these two, so
it lives in ``routers/manager_approvals.py``. Nothing on this router can be
actioned by staff until that sign-off has happened.

Note that ``servicerequest.manage`` is held by Admin, which also holds
``ticket.approve`` — the lifecycle edges these actions walk require the latter.
Every role that can reach these endpoints therefore holds both; the state
machine, not this router, is what enforces that.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_permission, require
from app.database.session import get_db
from app.models_v2 import RequestStatus, RequestType, User
from app.schemas.change_request import (
    ApproveChangeRequest,
    CancellationRequest,
    ChangeRequestCounts,
    ChangeRequestDetail,
    ChangeRequestItem,
    RejectChangeRequest,
    RescheduleRequest,
)
from app.schemas.pagination import Page
from app.services import change_request_service, lifecycle, manager_approval

router = APIRouter(prefix="/api", tags=["cancellation & reschedule"])


def _detail(db: Session, request, actor: User) -> ChangeRequestDetail:
    booking = change_request_service.parent_booking(db, request)
    staff = has_permission(actor, P.SERVICE_REQUEST_MANAGE)
    open_now = request.status in change_request_service.OPEN_STATUSES
    holder = (request.travel_details or {}).get("review_claimed_by")
    # Nothing our desk may do exists until the merchant's own manager has
    # signed the request off — see services/manager_approval.py.
    signed_off = manager_approval.is_approved(request)

    return ChangeRequestDetail(
        request=ChangeRequestItem.of(request),
        booking=(
            {
                "id": booking.request_id,
                "request_number": booking.request_number,
                "booking_reference": booking.booking_reference,
                "pnr": booking.pnr,
                "status": booking.status.value,
                "status_label": lifecycle.SPEC_LABELS.get(booking.status, booking.status.value),
                "travel_date": booking.travel_date.isoformat() if booking.travel_date else None,
                "return_date": booking.return_date.isoformat() if booking.return_date else None,
                "total_amount": str(booking.total_amount),
                "passengers": len(booking.passengers),
                "title": booking.title,
            }
            if booking else None
        ),
        timeline=lifecycle.timeline(request),
        can_review=staff and signed_off and request.status is RequestStatus.PENDING_APPROVAL,
        # Only the holder may settle one already under review — the same claim
        # rule the enquiry desk uses.
        can_settle=staff and signed_off and open_now and (holder in (None, actor.user_id)),
        can_manager_decide=(
            manager_approval.is_pending(request)
            and manager_approval.is_manager(actor)
            and actor.merchant_id == request.merchant_id
            and has_permission(actor, P.SERVICE_REQUEST_APPROVE)
        ),
    )


# ---------------------------------------------------------------------------
# Merchant — raising
# ---------------------------------------------------------------------------
@router.post(
    "/bookings/{booking_id}/cancellation",
    response_model=ChangeRequestDetail,
    status_code=201,
    tags=["merchant · change requests"],
    summary="Ask for a confirmed booking to be cancelled",
    description=(
        "Requires `servicerequest.create`. Allowed while the booking is Approved, Payment "
        "Pending, Paid or Ticket Issued. A booking that is still Draft or Pending is withdrawn "
        "from the booking itself at no charge, and a Completed one has already flown — both "
        "return 409. **No amounts are sent:** the cancellation charge is quoted by staff at "
        "approval, so a pending request carries none. Only one change request may be open "
        "against a booking at a time (409 naming the other one)."
    ),
)
def raise_cancellation(
    booking_id: int,
    payload: CancellationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_CREATE)),
):
    request = change_request_service.raise_cancellation(
        db, current_user, booking_id, reason=payload.reason
    )
    return _detail(db, request, current_user)


@router.post(
    "/bookings/{booking_id}/reschedule",
    response_model=ChangeRequestDetail,
    status_code=201,
    tags=["merchant · change requests"],
    summary="Ask for a confirmed booking to be moved to another date",
    description=(
        "Requires `servicerequest.create`. Same booking-status window as cancellation. The new "
        "travel date must be in the future and different from the current one; a return date, if "
        "given, cannot precede it. The booking's own dates are **not** touched until staff "
        "approve — a request is not a reschedule."
    ),
)
def raise_reschedule(
    booking_id: int,
    payload: RescheduleRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_CREATE)),
):
    request = change_request_service.raise_reschedule(
        db, current_user, booking_id,
        new_travel_date=payload.new_travel_date,
        new_return_date=payload.new_return_date,
        reason=payload.reason,
    )
    return _detail(db, request, current_user)


@router.get(
    "/bookings/{booking_id}/change-requests",
    response_model=list[ChangeRequestItem],
    tags=["merchant · change requests"],
    summary="Every change ever raised against one booking",
    description=(
        "Requires `ticket.view`. Newest first. A merchant sees only its own booking's history; "
        "another company's booking id returns 404, not 403."
    ),
)
def booking_change_requests(
    booking_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return [
        ChangeRequestItem.of(r)
        for r in change_request_service.for_booking(db, current_user, booking_id)
    ]


# ---------------------------------------------------------------------------
# Reading — merchant and staff share these
# ---------------------------------------------------------------------------
@router.get(
    "/change-requests",
    response_model=Page[ChangeRequestItem],
    summary="Cancellation and reschedule requests",
    description=(
        "Requires `ticket.view`. **Newest first** — unlike the booking processing queue, this "
        "list is also read by the merchant who just raised the top row. A merchant sees only its "
        "own; platform staff see every company's. Filter by `type` "
        "(`cancellation` / `date_change`), by `request_status`, by `merchant_id` (staff), and "
        "`search` over request number, booking reference, PNR and title."
    ),
)
def list_change_requests(
    type: RequestType | None = None,
    request_status: RequestStatus | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    items, total = change_request_service.list_change_requests(
        db, current_user, page=page, page_size=page_size, request_type=type,
        request_status=request_status, merchant_id=merchant_id, search=search,
    )
    return Page.build([ChangeRequestItem.of(r) for r in items], total, page, page_size)


@router.get(
    "/change-requests/counts",
    response_model=ChangeRequestCounts,
    summary="Change-request tab badges",
    description=(
        "Requires `ticket.view`. Counted in one grouped query. `open` is Pending + Under "
        "Review — the ones that still need someone. Scoped exactly like the list, so a "
        "merchant's badges count only its own."
    ),
)
def change_request_counts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return ChangeRequestCounts(**change_request_service.stage_counts(db, current_user))


@router.get(
    "/change-requests/{request_id}",
    response_model=ChangeRequestDetail,
    summary="One change request, with its booking and timeline",
    description=(
        "Requires `ticket.view`. Carries `can_review` / `can_settle` / `can_manager_decide` for "
        "the calling account, so the UI offers nothing the server would refuse. The first two "
        "are false until the merchant's manager has signed the request off."
    ),
)
def get_change_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    request = change_request_service.get_change_request(db, current_user, request_id)
    return _detail(db, request, current_user)


# There is no withdraw endpoint. Whoever raises a change request cannot take it
# back; their own manager approves it or rejects it, through
# /api/manager/service-requests — which covers every service request type, not
# only these two. See routers/manager_approvals.py.


# ---------------------------------------------------------------------------
# Staff — settlement
# ---------------------------------------------------------------------------
@router.post(
    "/admin/change-requests/{request_id}/review",
    response_model=ChangeRequestDetail,
    tags=["admin · change requests"],
    summary="Claim a change request",
    description=(
        "Requires `servicerequest.manage`. Pending → Under Review, owned by you. Row-locked, so "
        "two admins clicking at once cannot both believe they won — the loser gets 409 naming "
        "the holder. Re-claiming your own is a no-op, not an error."
    ),
)
def start_review(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_MANAGE)),
):
    request = change_request_service.start_review(db, current_user, request_id)
    return _detail(db, request, current_user)


@router.post(
    "/admin/change-requests/{request_id}/approve",
    response_model=ChangeRequestDetail,
    tags=["admin · change requests"],
    summary="Settle a change request and apply it to the booking",
    description=(
        "Requires `servicerequest.manage`. **This is where the money is quoted.** For a "
        "cancellation send `cancellation_charge` (amount as a string; omit for a free "
        "cancellation) — it is bounded to at most the booking total and the refund is derived, "
        "never sent. For a reschedule send `fare_difference` and/or `change_fee`; both must be "
        "non-negative, because a date change never produces a refund — a merchant who wants "
        "money back cancels instead.\n\n"
        "The effect is applied in the same transaction: a cancellation walks the booking to "
        "Cancelled (releasing catalog inventory if it held any), a reschedule rewrites its "
        "travel dates and records the move. Both the request and its booking are row-locked, and "
        "the booking's status is re-checked under that lock — a booking that was completed while "
        "this sat in the queue returns 409 rather than being cancelled after the fact."
    ),
)
def approve_change_request(
    request_id: int,
    payload: ApproveChangeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_MANAGE)),
):
    request = change_request_service.approve(
        db, current_user, request_id,
        cancellation_charge=payload.cancellation_charge,
        fare_difference=payload.fare_difference,
        change_fee=payload.change_fee,
        note=payload.note,
    )
    return _detail(db, request, current_user)


@router.post(
    "/admin/change-requests/{request_id}/reject",
    response_model=ChangeRequestDetail,
    tags=["admin · change requests"],
    summary="Refuse a change request",
    description=(
        "Requires `servicerequest.manage`. A reason is mandatory. The parent booking is left "
        "exactly as it was — refusing a cancellation does not cancel anything."
    ),
)
def reject_change_request(
    request_id: int,
    payload: RejectChangeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_MANAGE)),
):
    request = change_request_service.reject(db, current_user, request_id, payload.reason)
    return _detail(db, request, current_user)
