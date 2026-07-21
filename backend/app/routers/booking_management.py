import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.user import User
from app.schemas.booking_management import (
    BookingAnalyticsOut,
    BookingDashboardCardOut,
    BookingDetailOut,
    BookingListItemOut,
    PassengerCountUpdateRequest,
    RescheduleRequest,
)
from app.schemas.pagination import Page
from app.services import booking_management_service

router = APIRouter(prefix="/api/admin/booking-management", tags=["admin-booking-management"])

PageParam = Query(default=1, ge=1)
PageSizeParam = Query(default=20, ge=1, le=100)


@router.get(
    "/bookings",
    response_model=Page[BookingListItemOut],
    summary="List bookings (Booking Management Center)",
    description="Requires admin role. Rich, searchable, filterable, sortable booking list with resolved destination names and payment status — a dedicated view separate from the existing /api/admin/bookings list.",
)
def list_bookings(
    search: str | None = None,
    booking_type: Literal["flight", "hotel", "cruise", "package"] | None = None,
    booking_status: Literal["pending", "confirmed", "completed", "cancelled"] | None = None,
    payment_status: Literal["success", "failed", "refunded"] | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    customer_id: int | None = None,
    sort: Literal["newest", "oldest", "travel_date", "amount", "status", "customer_name"] = "newest",
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    items, total = booking_management_service.list_bookings_rich(
        db, page, page_size, search=search, booking_type=booking_type, booking_status=booking_status,
        payment_status=payment_status, date_from=date_from, date_to=date_to, customer_id=customer_id, sort=sort,
    )
    return Page.build([BookingListItemOut(**item) for item in items], total, page, page_size)


@router.get(
    "/bookings/{booking_id}",
    response_model=BookingDetailOut,
    summary="Get full booking detail (Booking Management Center)",
    description="Requires admin role. Returns booking info, customer, payment(s), activity timeline, and current inventory state for the item.",
)
def get_booking(booking_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return booking_management_service.get_booking_detail(db, booking_id)


@router.post(
    "/bookings/{booking_id}/approve",
    response_model=BookingDetailOut,
    summary="Approve a pending booking (admin)",
)
def approve_booking(booking_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    booking_management_service.approve_booking(db, booking_id, _admin.id)
    return booking_management_service.get_booking_detail(db, booking_id)


@router.post(
    "/bookings/{booking_id}/reject",
    response_model=BookingDetailOut,
    summary="Reject a pending booking (admin)",
)
def reject_booking(booking_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    booking_management_service.reject_booking(db, booking_id, _admin.id)
    return booking_management_service.get_booking_detail(db, booking_id)


@router.post(
    "/bookings/{booking_id}/cancel",
    response_model=BookingDetailOut,
    summary="Cancel a booking (admin)",
)
def cancel_booking(booking_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    booking_management_service.cancel_booking_admin(db, booking_id, _admin.id)
    return booking_management_service.get_booking_detail(db, booking_id)


@router.post(
    "/bookings/{booking_id}/complete",
    response_model=BookingDetailOut,
    summary="Mark a confirmed booking as completed (admin)",
)
def complete_booking(booking_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    booking_management_service.complete_booking(db, booking_id, _admin.id)
    return booking_management_service.get_booking_detail(db, booking_id)


@router.patch(
    "/bookings/{booking_id}/reschedule",
    response_model=BookingDetailOut,
    summary="Reschedule a booking's travel date (admin)",
)
def reschedule_booking(
    booking_id: int, payload: RescheduleRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    booking_management_service.reschedule_booking(db, booking_id, _admin.id, payload.travel_date)
    return booking_management_service.get_booking_detail(db, booking_id)


@router.patch(
    "/bookings/{booking_id}/passengers",
    response_model=BookingDetailOut,
    summary="Change a booking's passenger count (admin)",
    description="Requires admin role. Atomically adjusts inventory for the delta and recomputes the total price.",
)
def update_passengers(
    booking_id: int, payload: PassengerCountUpdateRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    booking_management_service.update_passenger_count(db, booking_id, _admin.id, payload.quantity)
    return booking_management_service.get_booking_detail(db, booking_id)


@router.get(
    "/bookings/{booking_id}/invoice",
    summary="Download a CSV invoice for a booking (admin)",
    description="Requires admin role. Streams a simple CSV invoice — full styled PDF invoices are a later phase.",
)
def download_invoice(booking_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    csv_text = booking_management_service.export_invoice_csv(db, booking_id)
    return Response(
        content=csv_text, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="invoice-booking-{booking_id}.csv"'},
    )


@router.get(
    "/analytics",
    response_model=BookingAnalyticsOut,
    summary="Booking analytics (Booking Management Center)",
)
def get_analytics(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return booking_management_service.get_analytics(db)


@router.get(
    "/dashboard-card",
    response_model=BookingDashboardCardOut,
    summary="Booking Management summary card for the main Admin Dashboard",
)
def get_dashboard_card(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return booking_management_service.get_dashboard_card(db)
