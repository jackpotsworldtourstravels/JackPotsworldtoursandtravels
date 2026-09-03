"""Admin view of B2C customer payments — ``/api/admin/customer-payments/*``.

PERMISSIONS — NO NEW CODES
Reads are gated on ``payment.verify``, which is held by ``_ADMIN`` alone. NOT
on ``payment.view``: that code is held by every merchant role, and this router
returns other people's customers' payments with no merchant scoping at all, so
gating it on ``payment.view`` would let any merchant staff member read every
customer payment on the platform. That is the same mistake CR-4d found in
``payment_admin.py`` and it is not being repeated here.

THESE ARE NOT MERCHANT PAYMENTS
Everything here reads the three ``customer_*_booking_payments`` tables — a
member of the public paying for their own trip through a gateway. The B2B
``payments`` table, the wallet and ``service_requests`` are not imported by
this router or by the service under it, and the route prefix says
``customer-payments`` so the two can never be confused in a log or a URL.

READ-ONLY, AND THAT IS A SECURITY PROPERTY
There is no write endpoint here. A payment becomes ``captured`` because the
provider says so and ``payment_verification_service`` agrees; a button on an
admin list that could do it would be a second path to the money-state that
skips every check. Refunds, when they are built, belong behind their own
permission and their own audit — not on a read screen.
"""
from __future__ import annotations

import datetime as dt
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_payment_admin import (
    CustomerPaymentCounts,
    CustomerPaymentDetail,
    CustomerPaymentList,
)
from app.services import activity_service
from app.services import customer_payment_admin_service as payments

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/customer-payments", tags=["admin-customer-payments"])

_PRODUCTS = ("package", "hotel", "flight")


@router.get(
    "/counts",
    response_model=CustomerPaymentCounts,
    summary="B2C payment counts by status",
    description=(
        "Requires `payment.verify` (admin only).\n\n"
        "Counts across the **customer** payment tables. Merchant payments are "
        "not included and are not reachable from this router.\n\n"
        "`deferred_events` is not a payment status — it is the number of "
        "provider deliveries still awaiting verification. A non-zero value "
        "means money may have moved without a booking being confirmed yet."
    ),
)
def payment_counts(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    return payments.counts(db)


@router.get(
    "",
    response_model=CustomerPaymentList,
    summary="List B2C customer payments",
    description=(
        "Requires `payment.verify` (admin only). Newest first.\n\n"
        "Statuses are the database's own: `pending`, `processing`, "
        "`authorized`, `captured`, `failed`, `cancelled`, `expired`, "
        "`refunded`. **`captured` is the terminal success state and is not "
        "renamed** — a screen may label it *Paid* for a reader.\n\n"
        "No secret, credential, card detail, VPA or customer phone number is "
        "returned by this or any endpoint in this router."
    ),
)
def list_customer_payments(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.PAYMENT_VERIFY)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    product: str | None = Query(None, description="package | hotel | flight"),
    payment_status: str | None = Query(None, alias="status"),
    provider: str | None = Query(None),
    search: str | None = Query(None, max_length=120),
    date_from: dt.date | None = Query(None),
    date_to: dt.date | None = Query(None),
):
    if product and product not in _PRODUCTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown product {product!r}.",
        )
    if payment_status and payment_status not in payments.STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown payment status {payment_status!r}.",
        )
    return payments.list_payments(
        db, page=page, page_size=page_size, product=product,
        status=payment_status, provider=provider, search=search,
        date_from=date_from, date_to=date_to,
    )


@router.get(
    "/{product}/{payment_id}",
    response_model=CustomerPaymentDetail,
    summary="One B2C payment, with its provider events",
    description=(
        "Requires `payment.verify` (admin only).\n\n"
        "Includes the provider deliveries recorded against this payment and "
        "what happened to each — including any left `deferred`, which is the "
        "retry state the sweep will come back for. **The stored event body is "
        "not returned**: it is kept redacted for reconciliation, not published "
        "to every holder of this permission."
    ),
    responses={404: {"description": "No such payment."}},
)
def get_customer_payment(
    request: Request,
    product: str,
    payment_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.PAYMENT_VERIFY)),
):
    if product not in _PRODUCTS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found.")
    row = payments.get_payment(db, product, payment_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found.")

    # SENSITIVE-DATA ACCESS IS RECORDED, following the convention the rest of
    # the admin surface uses (activity_service.log_activity, as payment_admin
    # and the wallet desk do). Names the payment and the booking, never a
    # credential — there is nothing on these rows that could be one, and this
    # line is written so it stays that way.
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Customer payment viewed", meta["ip_address"],
        activity_type="Read", module="CustomerPayments",
        description=(
            f"{user.full_name} opened {product} payment {payment_id} "
            f"({row['booking_ref']}, {row['currency']} {row['amount']}, {row['status']})"
        ),
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()
    return row
