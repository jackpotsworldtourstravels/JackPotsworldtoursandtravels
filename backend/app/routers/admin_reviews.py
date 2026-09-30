"""Admin B2C reviews & ratings — ``/api/admin/reviews/*``. Phase 6 of the B2C
Admin Portal build-out. See ``customer_review_admin_service``'s module
docstring for what this reuses (the customer's own review table, plus the
moderation columns migration 0090 added) and why approving/rejecting decides
what the public sees.

GATED ON `customer.view`, THE SAME CODE THE OTHER B2C DESKS USE (Customers,
Bookings, Cancellations) — a review is a member of the public's own words, the
same kind of data those screens read. Admin only.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_review_admin import ReviewAnalytics, ReviewList, ReviewModeration, ReviewRow
from app.services import customer_review_admin_service as service
from app.services.catalogue_common import log_change

router = APIRouter(prefix="/api/admin/reviews", tags=["admin-reviews"])

_NO_REVIEW = "No such review."


@router.get(
    "", response_model=ReviewList, summary="List B2C reviews",
    description=(
        "Requires `customer.view` (admin only). Newest first. `product` is "
        "`flight`, `hotel`, `package`, `gaming` or `cruise` (gaming = a package "
        "in the gaming category). `counts` are per-status totals under the same "
        "product/rating/search filters."
    ),
)
def list_reviews(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    review_status: str | None = Query(None, alias="status"),
    product: str | None = Query(None),
    rating: int | None = Query(None, ge=1, le=5),
    search: str | None = Query(None, max_length=120),
):
    if review_status and review_status not in service.STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown status {review_status!r}.")
    if product and product not in service.PRODUCTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown product {product!r}.")
    return service.list_reviews(
        db, page=page, page_size=page_size, status_=review_status, product=product,
        rating=rating, search=search,
    )


# Declared before "/{review_id}" so "analytics" is not read as an id.
@router.get(
    "/analytics", response_model=ReviewAnalytics, summary="Rating analytics",
    description="Requires `customer.view` (admin only). Counts approved reviews only.",
)
def review_analytics(db: Session = Depends(get_db), _: User = Depends(require(P.CUSTOMER_VIEW))):
    return service.analytics(db)


@router.get(
    "/{review_id}", response_model=ReviewRow, summary="One review",
    description="Requires `customer.view` (admin only).",
    responses={404: {"description": _NO_REVIEW}},
)
def get_review(review_id: int, db: Session = Depends(get_db), _: User = Depends(require(P.CUSTOMER_VIEW))):
    row = service.get_review(db, review_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_REVIEW)
    return row


@router.patch(
    "/{review_id}", response_model=ReviewRow, summary="Approve, reject or reply to a review",
    description=(
        "Requires `customer.view` (admin only). Send `status` (`approved` or "
        "`rejected`) and/or `admin_reply` (empty removes it). Only what is sent "
        "is written; the customer's rating and comment are never editable here."
    ),
    responses={404: {"description": _NO_REVIEW}},
)
def moderate_review(
    review_id: int, payload: ReviewModeration, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CUSTOMER_VIEW)),
):
    result = service.moderate(db, review_id, payload.model_dump(exclude_unset=True))
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_REVIEW)
    row, changed = result
    if changed:
        log_change(
            db, request, user, action="Review moderated", reference_id=review_id, module="B2CReviews",
            description=(
                f"{user.full_name} updated review {review_id} ({row['item_name']}, {row['rating']}★): "
                f"{', '.join(changed)} → status {row['status']}"
            ),
        )
    db.commit()
    return row
