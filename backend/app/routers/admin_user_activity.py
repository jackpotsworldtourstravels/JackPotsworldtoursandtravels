"""Admin B2C user activity — ``/api/admin/user-activity/*``. Phase 7 of the B2C
Admin Portal build-out. READ-ONLY, over ``customer_audit_logs`` and
``customer_sessions``. See ``customer_activity_admin_service``'s docstring for
what is deliberately NOT shown (customers' browsing signal) and why "active" is
derived from last-seen rather than trusted from the stored flag.

Gated on `customer.view`, the same code the other B2C desks use. Admin only.
"""
from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_activity_admin import ActivityList, ActivitySummary, SessionList
from app.services import customer_activity_admin_service as service

router = APIRouter(prefix="/api/admin/user-activity", tags=["admin-user-activity"])


@router.get(
    "/summary", response_model=ActivitySummary, summary="Activity totals",
    description=(
        "Requires `customer.view` (admin only). Sign-ins, failed sign-ins, signups and bookings "
        "for the last 24 hours and 7 days, and how many customers are active right now."
    ),
)
def activity_summary(db: Session = Depends(get_db), _: User = Depends(require(P.CUSTOMER_VIEW))):
    return service.summary(db)


@router.get(
    "/logs", response_model=ActivityList, summary="Customer activity log",
    description=(
        "Requires `customer.view` (admin only). Newest first. A failed sign-in against an "
        "unknown address has no customer."
    ),
)
def list_activity(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    module: str | None = Query(None, max_length=60),
    log_status: str | None = Query(None, alias="status"),
    search: str | None = Query(None, max_length=120),
    date_from: dt.date | None = Query(None),
    date_to: dt.date | None = Query(None),
    customer_id: int | None = Query(None),
):
    if log_status and log_status not in service.AUDIT_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown status {log_status!r}.")
    if date_from and date_to and date_to < date_from:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "date_to is before date_from.")
    return service.list_activity(
        db, page=page, page_size=page_size, module=module, log_status=log_status, search=search,
        date_from=date_from, date_to=date_to, customer_id=customer_id,
    )


@router.get(
    "/sessions", response_model=SessionList, summary="Customer sign-in sessions",
    description=(
        "Requires `customer.view` (admin only). `state` is `active` (seen in the last "
        f"{service.ACTIVE_WINDOW_MINUTES} minutes), `idle` (never signed out, gone quiet) or `ended`."
    ),
)
def list_sessions(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    state: str | None = Query(None),
    search: str | None = Query(None, max_length=120),
    customer_id: int | None = Query(None),
):
    if state and state not in service.SESSION_STATES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown state {state!r}.")
    return service.list_sessions(
        db, page=page, page_size=page_size, state=state, search=search, customer_id=customer_id,
    )
