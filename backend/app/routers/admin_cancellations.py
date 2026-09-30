"""Admin view of B2C cancellations & refunds — ``/api/admin/cancellations/*``.
Phase 3 of the B2C Admin Portal build-out: completes the lifecycle Phase 2
left at "a booking can be marked cancelled" with an actual request/decision
trail and a refund state, per the plan's own diagram (Customer -> Booking ->
Payment -> Cancellation -> Refund).

FOUR ACTIONS, ONE ENDPOINT. approve / reject / start_refund / complete_refund
are a state machine (see customer_cancellation_admin_service._TRANSITIONS),
not four routes, because they share every concern (find the row, check the
current state, log the actor) and the router's job is to translate the
service's sentinel returns into the right HTTP status.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_cancellation_admin import (
    CancellationDecision,
    CancellationDetail,
    CancellationList,
)
from app.services import activity_service, customer_cancellation_admin_service as service

router = APIRouter(prefix="/api/admin/cancellations", tags=["admin-cancellations"])


@router.get(
    "",
    response_model=CancellationList,
    summary="List B2C cancellation/refund requests",
    description=(
        "Requires `customer.view` (admin only). Newest first. "
        "`status`: requested | approved | rejected | refund_processing | refunded."
    ),
)
def list_cancellations(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
    search: str | None = Query(None, max_length=120),
    status_: str | None = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    if status_ and status_ not in service.STATUSES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Unknown status {status_!r}. Use one of {service.STATUSES}."
        )
    return service.list_requests(db, search=search, status=status_, page=page, page_size=page_size)


@router.get(
    "/{cancellation_id}",
    response_model=CancellationDetail,
    summary="One cancellation/refund request",
    description="Requires `customer.view` (admin only).",
    responses={404: {"description": "No such request."}},
)
def get_cancellation(
    cancellation_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
):
    row = service.get_request(db, cancellation_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such request.")
    return row


@router.patch(
    "/{cancellation_id}",
    response_model=CancellationDetail,
    summary="Approve, reject, or move a request through the refund lifecycle",
    description=(
        "Requires `customer.view` (admin only). `action` is one of "
        "approve | reject | start_refund | complete_refund, each legal only "
        "from the state that precedes it: requested -> approved (approve) or "
        "rejected (reject); approved -> refund_processing (start_refund); "
        "refund_processing -> refunded (complete_refund).\n\n"
        "Approving cancels the underlying booking. Nothing here moves money "
        "or calls a payment provider — `complete_refund` records that the "
        "desk already refunded the customer by whatever means it used."
    ),
    responses={
        404: {"description": "No such request."},
        400: {"description": "Unknown action, or not legal from this request's current status."},
    },
)
def decide_cancellation(
    cancellation_id: str,
    payload: CancellationDecision,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.CUSTOMER_VIEW)),
):
    result = service.decide(db, cancellation_id, payload.action, payload.refund_amount, payload.admin_notes)
    if result == "invalid_action":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown action {payload.action!r}. Use one of "
            "approve | reject | start_refund | complete_refund.",
        )
    if result == "wrong_state":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{payload.action!r} is not valid for this request's current status.",
        )
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such request.")

    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Cancellation request decided", meta["ip_address"],
        activity_type="Update", module="B2CCancellations",
        description=(
            f"{user.full_name} set {cancellation_id} to {result['status']} "
            f"via {payload.action} ({result['customer']['email']})"
        ),
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()
    return result
