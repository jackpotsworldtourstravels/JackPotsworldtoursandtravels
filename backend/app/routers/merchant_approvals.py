"""Merchant approval desk — the merchant signs off its own Booking Requests (CR-3).

CR-2 put this sign-off with a *platform* Manager. CR-3 moves it to the merchant
that raised the booking: the merchant's own manager sub-role (or its Merchant
Admin) reviews what its staff submitted and either releases it to the Admin
Booking Operations queue or returns it for correction.

WHY THIS IS A SECOND ROUTER OVER ONE SERVICE
The decision logic — the claim, the row lock, the lifecycle edges, the audit
entry, the notifications — is identical whoever approves; only *scope* differs.
Duplicating ``manager_service`` would have meant two copies of the concurrency
handling, which is precisely the code least safe to fork. So the service takes
both actor kinds and confines a merchant one to its own merchant, and the
routers stay separate because their **permission codes** must be:
``booking.merchant_approve`` here, ``booking.manager_approve`` there. A merchant
holding the platform code would still be refused by
``manager_service._assert_approver_surface``'s scoping, but it would be refused
late — a merchant must not be able to *address* the platform queue at all.

WHY ``/api/merchant/...`` AND NOT ``/api/manager/...``
Every other merchant-scoped endpoint lives under ``/api/merchant``. Keeping this
one there means the merchant portal's existing auth, base URL and error handling
apply unchanged, and the path itself says whose data it returns.
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

router = APIRouter(prefix="/api/merchant/approvals", tags=["merchant · approvals"])


def _detail(booking, actor: User) -> ManagerBookingDetail:
    """Same payload shape as the platform Manager's detail view.

    Deliberately identical: the merchant portal renders the same read-only
    review screen, and one schema means the two cannot drift apart field by
    field. ``can_decide`` additionally goes false on the approver's own
    booking, so the buttons never render for a decision the server will refuse.
    """
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
            and booking.user_id != actor.user_id
        ),
    )


@router.get(
    "",
    response_model=Page[ManagerBookingSummary],
    summary="Booking Requests awaiting this merchant's approval",
    description=(
        "Requires `booking.merchant_approve`. **Scoped to the caller's own merchant** — "
        "the scope is taken from the token, never from a parameter. Classic Tours booking "
        "requests only, those raised from an answered ticket enquiry. `bucket` selects a "
        "tab (`awaiting`, `approved`, `returned`, `ticketed`); `status` narrows to one and "
        "the two compose. Waiting requests sort oldest first."
    ),
)
def list_bookings(
    bucket: Literal["awaiting", "approved", "returned", "ticketed"] | None = Query(None),
    status: RequestStatus | None = Query(None),
    search: str | None = Query(None, max_length=120),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MERCHANT_APPROVE)),
):
    # No merchant_id parameter, by design: the service scopes a merchant actor
    # to its own merchant regardless, and offering the filter would imply the
    # caller has a choice.
    rows, total = manager_service.list_queue(
        db, current_user, status=status, bucket=bucket,
        search=search, page=page, page_size=page_size,
    )
    return Page.build(
        [ManagerBookingSummary.of(r) for r in rows], total, page, page_size
    )


@router.get(
    "/counts",
    response_model=ManagerQueueCounts,
    summary="Tab badges for the merchant's approval queue",
    description=(
        "Requires `booking.merchant_approve`. Counts this merchant's bookings only, "
        "in one grouped query."
    ),
)
def counts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MERCHANT_APPROVE)),
):
    return ManagerQueueCounts(**manager_service.queue_counts(db, current_user))


@router.get(
    "/{request_id}",
    response_model=ManagerBookingDetail,
    summary="One Booking Request, in full",
    description=(
        "Requires `booking.merchant_approve`. The whole submitted booking read-only: "
        "itinerary, contact, every passenger field and the lifecycle timeline. "
        "**404 for another merchant's booking** — not 403, which would confirm it exists."
    ),
)
def get_booking(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MERCHANT_APPROVE)),
):
    booking = manager_service.get_booking(db, current_user, request_id)
    return _detail(booking, current_user)


@router.post(
    "/{request_id}/start-review",
    response_model=ManagerBookingDetail,
    summary="Claim a Booking Request for review",
    description=(
        "Requires `booking.merchant_approve`. Claimed under a row lock so two approvers "
        "at the same merchant cannot both decide it. Re-claiming your own is a no-op; "
        "409 when a colleague already holds it."
    ),
)
def start_review(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MERCHANT_APPROVE)),
):
    booking = manager_service.start_review(db, current_user, request_id)
    return _detail(booking, current_user)


@router.post(
    "/{request_id}/approve",
    response_model=ManagerBookingDetail,
    summary="Approve one of this merchant's Booking Requests",
    description=(
        "Requires `booking.merchant_approve`. Moves the booking to **Manager Approved**, "
        "which puts it in the Admin Booking Operations queue. Takes **no amount** — the "
        "Classic Tours workflow has no payment step. "
        "**403 when the caller raised the booking themselves**: someone else at the "
        "merchant must decide it. 409 when a colleague holds the review claim."
    ),
)
def approve(
    request_id: int,
    payload: ManagerApproveRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MERCHANT_APPROVE)),
):
    booking = manager_service.approve(
        db, current_user, request_id, note=payload.note if payload else None
    )
    return _detail(booking, current_user)


@router.post(
    "/{request_id}/return",
    response_model=ManagerBookingDetail,
    summary="Return a Booking Request to the raiser for correction",
    description=(
        "Requires `booking.merchant_return`. The booking goes back to **Created** — "
        "editable, with its passengers, enquiry link and history intact — carrying the "
        "approver's remarks. Deliberately **not** Rejected, which is terminal. "
        "`remarks` is mandatory, and the same self-approval rule applies."
    ),
)
def return_for_correction(
    request_id: int,
    payload: ManagerReturnRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.BOOKING_MERCHANT_RETURN)),
):
    booking = manager_service.return_for_correction(
        db, current_user, request_id, remarks=payload.remarks
    )
    return _detail(booking, current_user)
