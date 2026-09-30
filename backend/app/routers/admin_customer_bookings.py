"""Admin view of B2C bookings — ``/api/admin/customer-bookings/*``. Phase 2 of
the B2C Admin Portal build-out: this is the module that answers "when a
customer books from the B2C site, where does admin see it?" — see the module
docstring on ``customer_booking_admin_service`` for what it reads and why
Gaming Packages returns no rows here.

READ + ONE WRITE. Unlike Customer Payments and the Customers module beside
it, this module has a real PATCH: an admin may move a booking's own `status`
between the four values the database already defines. Nothing about payment
state is touched by it — a booking marked `cancelled` here does not refund
anything; that is Phase 3's job.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_booking_admin import (
    BookingDetail,
    BookingList,
    BookingStatusUpdate,
    DashboardBookingCounts,
)
from app.services import activity_service, customer_booking_admin_service as service

router = APIRouter(prefix="/api/admin/customer-bookings", tags=["admin-customer-bookings"])


@router.get(
    "",
    response_model=BookingList,
    summary="List B2C bookings across flights, hotels and packages",
    description=(
        "Requires `customer.view` (admin only). Newest first.\n\n"
        "`service_type`: flight | hotel | package | gaming (gaming always "
        "returns zero rows — see the service module's docstring).\n"
        "`status`: pending | confirmed | cancelled | completed."
    ),
)
def list_bookings(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
    search: str | None = Query(None, max_length=120),
    service_type: str | None = Query(None),
    status_: str | None = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    if service_type and service_type not in service.SERVICE_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown service_type {service_type!r}. Use one of {service.SERVICE_TYPES}.",
        )
    if status_ and status_.lower() not in service.BOOKING_STATUSES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown status {status_!r}. Use one of {service.BOOKING_STATUSES}.",
        )
    return service.list_bookings(
        db, search=search, service_type=service_type, booking_status=status_,
        page=page, page_size=page_size,
    )


@router.get(
    "/counts",
    response_model=DashboardBookingCounts,
    summary="Booking counts by product, for the B2C dashboard cards",
    description="Requires `customer.view` (admin only).",
)
def booking_counts(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
):
    return service.dashboard_counts(db)


@router.get(
    "/{booking_id}",
    response_model=BookingDetail,
    summary="One booking: customer, trip, passengers and payment",
    description="Requires `customer.view` (admin only).",
    responses={404: {"description": "No such booking."}},
)
def get_booking(
    booking_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.CUSTOMER_VIEW)),
):
    detail = service.get_booking(db, booking_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such booking.")

    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Customer booking viewed", meta["ip_address"],
        activity_type="Read", module="B2CBookings",
        description=f"{user.full_name} opened booking {booking_id} ({detail['customer']['email']})",
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()
    return detail


@router.patch(
    "/{booking_id}/status",
    response_model=BookingDetail,
    summary="Update a booking's status",
    description=(
        "Requires `customer.view` (admin only). Allowed values: "
        "pending | confirmed | cancelled | completed (case-insensitive). "
        "Does not touch payment state or issue a refund."
    ),
    responses={404: {"description": "No such booking."}, 400: {"description": "Unknown status."}},
)
def update_booking_status(
    booking_id: str,
    payload: BookingStatusUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.CUSTOMER_VIEW)),
):
    result = service.update_status(db, booking_id, payload.status)
    if result == "invalid":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown status {payload.status!r}. Use one of {service.BOOKING_STATUSES}.",
        )
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such booking.")

    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Customer booking status changed", meta["ip_address"],
        activity_type="Update", module="B2CBookings",
        description=(
            f"{user.full_name} set booking {booking_id} to "
            f"{result['booking_status']} ({result['customer']['email']})"
        ),
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()
    return result
