"""Manager portal — approval of submitted Booking Requests (CR-2).

Every endpoint declares ``booking.manager_approve`` or
``booking.manager_return``, codes held by the Manager role alone. An Admin
reaching these paths gets a 403, which is the point: the desk that answered the
Ticket Enquiry must not also sign off the booking that came out of it.

Read endpoints use the approve code rather than ``ticket.view``. Granting the
Manager ``ticket.view`` would have opened the Admin's booking screens, the
operations queue and the internal-notes API along with it — a much wider door
than "may see the bookings it has to decide".
"""
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import RequestStatus, User
from app.schemas.manager import (
    ManagerApproveRequest,
    ManagerBookingDetail,
    ManagerBookingSummary,
    ManagerQueueCounts,
    ManagerReturnRequest,
)
from app.schemas.pagination import Page
from app.schemas.ticket import ActionOption, RequestResponse, TimelineStep
from app.services import lifecycle, manager_service, ticket_service

router = APIRouter(prefix="/api/manager", tags=["manager"])


def _detail(booking, actor: User) -> ManagerBookingDetail:
    reviewer_id, reviewer_name = manager_service._reviewer(booking)
    return ManagerBookingDetail(
        request=RequestResponse.of(booking),
        timeline=[TimelineStep(**s) for s in lifecycle.timeline(booking)],
        actions=[ActionOption(**a) for a in ticket_service.action_menu(booking, actor)],
        reviewer_id=reviewer_id,
        reviewer_name=reviewer_name,
        can_decide=(
            booking.status in manager_service.PENDING_STATUSES
            and reviewer_id in (None, actor.user_id)
        ),
    )


@router.get(
    "/bookings",
    response_model=Page[ManagerBookingSummary],
    summary="Booking Requests on the Manager's desk",
    description=(
        "Requires `booking.manager_approve`. Classic Tours booking requests only — those "
        "raised from an answered ticket enquiry. `bucket` selects a queue tab "
        "(`awaiting`, `approved`, `returned`, `ticketed`); `status` narrows to one status "
        "and the two compose. Omit both for the whole desk. Waiting requests sort "
        "**oldest first** — it is a work queue — and decided ones newest first. "
        "Catalog-led bookings, enquiries and change requests never appear here."
    ),
)
def list_bookings(
    bucket: Literal["awaiting", "approved", "returned", "ticketed"] | None = Query(None),
    status: RequestStatus | None = Query(None),
    merchant_id: int | None = Query(None),
    search: str | None = Query(None, max_length=120),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MANAGER_APPROVE)),
):
    rows, total = manager_service.list_queue(
        db, current_user, status=status, bucket=bucket, merchant_id=merchant_id,
        search=search, page=page, page_size=page_size,
    )
    return Page.build(
        [ManagerBookingSummary.of(r) for r in rows], total, page, page_size
    )


@router.get(
    "/bookings/counts",
    response_model=ManagerQueueCounts,
    summary="Tab badges for the Manager's queue",
    description=(
        "Requires `booking.manager_approve`. One grouped query, not one per tab. "
        "`awaiting` is Pending Manager Approval plus Under Manager Review."
    ),
)
def counts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MANAGER_APPROVE)),
):
    return ManagerQueueCounts(**manager_service.queue_counts(db, current_user))


@router.get(
    "/bookings/{request_id}",
    response_model=ManagerBookingDetail,
    summary="One Booking Request, in full",
    description=(
        "Requires `booking.manager_approve`. The whole submitted booking read-only: "
        "itinerary, contact, every passenger field and the lifecycle timeline — what the "
        "Manager verifies before deciding. 400 when the request is not a Classic Tours "
        "booking; those have their own workflows."
    ),
)
def get_booking(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MANAGER_APPROVE)),
):
    booking = manager_service.get_booking(db, current_user, request_id)
    return _detail(booking, current_user)


@router.post(
    "/bookings/{request_id}/start-review",
    response_model=ManagerBookingDetail,
    summary="Claim a Booking Request for review",
    description=(
        "Requires `booking.manager_approve`. Pending Manager Approval -> Under Manager "
        "Review, claimed by the caller under a row lock. Re-claiming your own is a no-op; "
        "409 when another manager already holds it."
    ),
)
def start_review(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MANAGER_APPROVE)),
):
    booking = manager_service.start_review(db, current_user, request_id)
    return _detail(booking, current_user)


@router.post(
    "/bookings/{request_id}/approve",
    response_model=ManagerBookingDetail,
    summary="Approve a Booking Request",
    description=(
        "Requires `booking.manager_approve`. Moves the booking to **Manager Approved**, "
        "which is what puts it in the Admin Booking Operations queue. Takes **no amount** — "
        "the Classic Tours workflow has no payment step, and Manager Approved has no edge "
        "to Payment Pending. 409 when another manager holds the review claim."
    ),
)
def approve(
    request_id: int,
    payload: ManagerApproveRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MANAGER_APPROVE)),
):
    booking = manager_service.approve(
        db, current_user, request_id, note=payload.note if payload else None
    )
    return _detail(booking, current_user)


@router.post(
    "/bookings/{request_id}/return",
    response_model=ManagerBookingDetail,
    summary="Return a Booking Request to the merchant for correction",
    description=(
        "Requires `booking.manager_return`. The change request's *reject*: the booking goes "
        "back to **Created** — editable, with its passengers, enquiry link and history "
        "intact — carrying the Manager's remarks, and the merchant corrects and resubmits. "
        "It is deliberately **not** moved to Rejected, which is terminal. `remarks` is "
        "mandatory."
    ),
)
def return_for_correction(
    request_id: int,
    payload: ManagerReturnRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MANAGER_RETURN)),
):
    booking = manager_service.return_for_correction(
        db, current_user, request_id, remarks=payload.remarks
    )
    return _detail(booking, current_user)
