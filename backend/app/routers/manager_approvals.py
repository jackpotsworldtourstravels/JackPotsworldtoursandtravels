"""The merchant's own approval queue — sign-off before a request reaches us.

Every service request a merchant raises (cancellation, date change, passenger
correction, extra baggage, meal, seat) now waits for a **manager of that
merchant** before our desk can see or settle it. This router is that queue.

WHY IT IS ITS OWN ROUTER
It is neither ``/api/admin/...`` (these are the merchant's decisions about the
merchant's own work — no platform staff member may take them) nor a corner of
``change_requests.py`` (that module owns two of the seven types; this stage
covers all of them). One prefix, ``/api/manager``, so "may this caller reach it
at all" is answerable from the URL, exactly as it is for ``/api/admin``.

PERMISSION — one new code
``servicerequest.approve``. It is a genuinely new capability rather than a
rename of an existing one: ``servicerequest.create`` is held by every merchant
role including operators, and reusing it would make the sign-off a formality
the raiser could perform on themselves. Held by ``MerchantRole.MANAGER`` and by
the company's ``merchant_admin``, and by no platform role — see
``auth/rbac.py``.

The business rules live in ``services/manager_approval.py``; this file is the
HTTP surface over them.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.manager_approval import (
    ManagerDecisionRequest,
    ManagerQueueCounts,
    ManagerQueueItem,
)
from app.schemas.pagination import Page
from app.services import manager_approval

router = APIRouter(prefix="/api/manager", tags=["merchant · manager approval"])


@router.get(
    "/service-requests",
    response_model=Page[ManagerQueueItem],
    summary="Service requests raised inside my company",
    description=(
        "Requires `servicerequest.approve` — a manager of the merchant, or the merchant admin. "
        "**Newest first.** Defaults to `outstanding=true`, the decisions you still owe; pass "
        "`outstanding=false` for everything your company has raised, decided or not. Scoped to "
        "your own merchant with no way to widen it — the caller's `merchant_id` is the filter, "
        "not a parameter."
    ),
)
def list_queue(
    outstanding: bool = True,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_APPROVE)),
):
    manager_approval.guard_manager(current_user)
    items, total = manager_approval.queue(
        db, current_user, page=page, page_size=page_size, outstanding=outstanding
    )
    return Page.build([ManagerQueueItem.of(r) for r in items], total, page, page_size)


@router.get(
    "/service-requests/counts",
    response_model=ManagerQueueCounts,
    summary="How many decisions I owe",
    description=(
        "Requires `servicerequest.approve`. One count, for the sidebar badge. Returns zero "
        "rather than an error for an account that is not a manager, so a shared navigation "
        "component can call it unconditionally."
    ),
)
def counts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_APPROVE)),
):
    return ManagerQueueCounts(pending=manager_approval.pending_count(db, current_user))


@router.post(
    "/service-requests/{request_id}/approve",
    response_model=ManagerQueueItem,
    summary="Sign off one of your company's service requests",
    description=(
        "Requires `servicerequest.approve`. The request stays **Pending Approval** — it is now "
        "pending *ours* — and becomes visible and actionable on the Admin portal's Service "
        "Request Management screen. Row-locked, so two managers clicking at once cannot both "
        "record a decision; the second gets a 409 naming the first. Another company's request "
        "is a 404, not a 403."
    ),
)
def approve(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_APPROVE)),
):
    request = manager_approval.decide(db, current_user, request_id, approved=True)
    return ManagerQueueItem.of(request)


@router.post(
    "/service-requests/{request_id}/reject",
    response_model=ManagerQueueItem,
    summary="Refuse one of your company's service requests",
    description=(
        "Requires `servicerequest.approve`. A reason is mandatory — the person who raised it "
        "reads it. The request is closed and never reaches our desk; the booking it was raised "
        "against is untouched."
    ),
)
def reject(
    request_id: int,
    payload: ManagerDecisionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_APPROVE)),
):
    request = manager_approval.decide(
        db, current_user, request_id, approved=False, reason=payload.reason
    )
    return ManagerQueueItem.of(request)
