"""Admin view of B2C customers — ``/api/admin/customers/*``. Phase 1 of the
B2C Admin Portal build-out (see the plan's own doc for the full phase list).

READ-ONLY, like ``customer_payment_admin.py`` next to it. No new table: every
field served here already exists on ``Customer`` and the three per-product
booking/payment/review tables the customer-facing site already writes to.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_admin import CustomerDetail, CustomerList
from app.services import activity_service, customer_admin_service as service

router = APIRouter(prefix="/api/admin/customers", tags=["admin-customers"])

_FILTERS = ("active", "blocked", "new")


@router.get(
    "",
    response_model=CustomerList,
    summary="List B2C customers",
    description=(
        "Requires `customer.view` (admin only). Newest first.\n\n"
        "`filter` is the sidebar's own vocabulary — `active`, `blocked` or "
        "`new` (registered in the last 30 days) — separate from `status`, "
        "which takes the database's own values "
        "(`active`/`inactive`/`blocked`/`suspended`)."
    ),
)
def list_customers(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
    search: str | None = Query(None, max_length=120),
    status_: str | None = Query(None, alias="status"),
    filter: str | None = Query(None, description="active | blocked | new"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    if filter and filter not in _FILTERS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Unknown filter {filter!r}. Use one of {_FILTERS}."
        )
    return service.list_customers(
        db, search=search, status=status_, filter_=filter, page=page, page_size=page_size,
    )


@router.get(
    "/{customer_id}",
    response_model=CustomerDetail,
    summary="One customer: profile, booking history, payment history, reviews",
    description="Requires `customer.view` (admin only).",
    responses={404: {"description": "No such customer."}},
)
def get_customer(
    customer_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.CUSTOMER_VIEW)),
):
    customer = service.get_customer(db, customer_id)
    if customer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such customer.")

    # SENSITIVE-DATA ACCESS IS RECORDED, following the convention
    # customer_payment_admin.py set: naming the customer, never a credential.
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Customer record viewed", meta["ip_address"],
        activity_type="Read", module="B2CCustomers",
        description=f"{user.full_name} opened customer {customer.customer_code} ({customer.email})",
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()

    return service.get_customer_detail(db, customer)
