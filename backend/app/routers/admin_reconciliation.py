"""Admin B2C payment reconciliation — ``/api/admin/payment-reconciliation/*``.
Phase 4 of the B2C Admin Portal build-out. See
``customer_reconciliation_service``'s module docstring for what this reuses
(Customer Payments' own row data and query logic, the existing Razorpay/HDFC/
TrustBrick provider adapters) and what it deliberately does not do (create a
new table, a new payment system, or touch Customer Payments' own endpoints).

GATED ON `payment.verify`, THE SAME CODE CUSTOMER PAYMENTS USES — not
`customer.view`. Reconciliation reads the same money-sensitive rows that
screen does, under the same permission `payment_admin.py` already restricts
to Admin alone; giving it a different code would let one role see payments
without the other, for no reason tied to what either screen actually shows.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_reconciliation import ReconciliationList, VerifyResult
from app.services import activity_service, customer_reconciliation_service as service
from app.services.customer_payment_admin_service import STATUSES

router = APIRouter(prefix="/api/admin/payment-reconciliation", tags=["admin-reconciliation"])

_PRODUCTS = ("package", "hotel", "flight")


@router.get(
    "",
    response_model=ReconciliationList,
    summary="List B2C payments for reconciliation",
    description=(
        "Requires `payment.verify` (admin only). The same rows Customer "
        "Payments lists, with `reconciliation_status` starting at "
        "`not_checked` on every row — see POST .../verify to actually ask "
        "the gateway about one."
    ),
)
def list_reconciliation(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    product: str | None = Query(None, description="package | hotel | flight"),
    payment_status: str | None = Query(None, alias="status"),
    provider: str | None = Query(None),
    search: str | None = Query(None, max_length=120),
):
    if product and product not in _PRODUCTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown product {product!r}.")
    if payment_status and payment_status not in STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown payment status {payment_status!r}.")
    return service.list_for_reconciliation(
        db, page=page, page_size=page_size, product=product,
        status=payment_status, provider=provider, search=search,
    )


@router.post(
    "/{product}/{payment_id}/verify",
    response_model=VerifyResult,
    summary="Ask the gateway, live, what it says about one payment",
    description=(
        "Requires `payment.verify` (admin only). Calls the payment's own "
        "provider (Razorpay/HDFC/TrustBrick, whichever collected it) right "
        "now and compares the amount it reports against what we recorded. "
        "Creates nothing and moves no money — a read against the gateway, "
        "the same call `fetch_payment()` makes for the return-page and "
        "missed-webhook paths."
    ),
    responses={404: {"description": "No such payment."}},
)
def verify_payment(
    product: str,
    payment_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.PAYMENT_VERIFY)),
):
    if product not in _PRODUCTS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such payment.")
    result = service.verify_payment(db, product, payment_id)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such payment.")

    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Payment reconciliation checked", meta["ip_address"],
        activity_type="Read", module="B2CReconciliation",
        description=(
            f"{user.full_name} verified {product} payment {payment_id} "
            f"({result['booking_ref']}) against its gateway: {result['reconciliation_status']}"
        ),
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()
    return result
