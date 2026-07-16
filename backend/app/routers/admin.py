from typing import Literal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.user import User
from app.schemas.activity import ActivityLogOut
from app.schemas.booking import AdminBookingOut, AdminPaymentOut, BookingStatusUpdate
from app.schemas.misc import ContactMessageOut, MonthlyStatOut, NewsletterSubscriberOut, ReportsOut
from app.schemas.notification import AdminNotificationCreate, AdminNotificationOut
from app.schemas.pagination import Page
from app.schemas.review import AdminReviewOut
from app.schemas.wishlist import AdminWishlistOut
from app.services import activity_service, admin_service, notification_service, review_service, wishlist_service

router = APIRouter(prefix="/api/admin", tags=["admin"])

_CSV_EXPORTERS = {
    "users": admin_service.export_users_csv,
    "bookings": admin_service.export_bookings_csv,
    "payments": admin_service.export_payments_csv,
    "flights": admin_service.export_flights_csv,
    "hotels": admin_service.export_hotels_csv,
    "cruises": admin_service.export_cruises_csv,
    "packages": admin_service.export_packages_csv,
    "contact": admin_service.export_contact_csv,
}

PageParam = Query(default=1, ge=1)
PageSizeParam = Query(default=20, ge=1, le=100)


@router.get(
    "/bookings",
    response_model=Page[AdminBookingOut],
    summary="List all bookings (admin)",
    description="Requires admin role. Returns a paginated list of every booking across all users, including the booking owner's email.",
)
def list_bookings(
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    rows, total = admin_service.list_all_bookings_paginated(db, page, page_size)
    items = [AdminBookingOut(**booking.__dict__, user_email=email) for booking, email in rows]
    return Page.build(items, total, page, page_size)


@router.patch(
    "/bookings/{booking_id}",
    response_model=AdminBookingOut,
    summary="Update a booking's status (admin)",
    description="Requires admin role. Sets a booking's status to pending, confirmed, or cancelled and logs the change.",
)
def update_booking_status(
    booking_id: int,
    payload: BookingStatusUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    booking, email = admin_service.update_booking_status(db, booking_id, payload.status)
    result = AdminBookingOut(**booking.__dict__, user_email=email)
    activity_service.log_activity(db, _admin.id, f"Admin updated booking #{booking_id} status to {payload.status}")
    return result


@router.get(
    "/payments",
    response_model=Page[AdminPaymentOut],
    summary="List all payments (admin)",
    description="Requires admin role. Returns a paginated list of every payment across all users, including the payer's email.",
)
def list_payments(
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    rows, total = admin_service.list_all_payments_paginated(db, page, page_size)
    items = [AdminPaymentOut(**payment.__dict__, user_email=email) for payment, email in rows]
    return Page.build(items, total, page, page_size)


@router.get(
    "/contact",
    response_model=Page[ContactMessageOut],
    summary="List contact messages (admin)",
    description="Requires admin role. Returns a paginated list of messages submitted via the contact-us form.",
)
def list_contact_messages(
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    items, total = admin_service.list_contact_messages_paginated(db, page, page_size)
    return Page.build(items, total, page, page_size)


@router.delete(
    "/contact/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a contact message (admin)",
    description="Requires admin role. Permanently deletes a contact-us message.",
)
def delete_contact_message(message_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    admin_service.delete_contact_message(db, message_id)
    activity_service.log_activity(db, _admin.id, f"Admin deleted contact message #{message_id}")


@router.get(
    "/newsletter",
    response_model=list[NewsletterSubscriberOut],
    summary="List newsletter subscribers (admin)",
    description="Requires admin role. Returns all newsletter subscriber emails.",
)
def list_newsletter_subscribers(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.list_newsletter_subscribers(db)


@router.get(
    "/reports",
    response_model=ReportsOut,
    summary="Get the admin dashboard summary (admin)",
    description="Requires admin role. Returns aggregate platform stats: user/booking/revenue totals, catalog counts, booking status breakdown, and recent activity.",
)
def get_reports(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.build_reports(db)


@router.get(
    "/reports/monthly",
    response_model=list[MonthlyStatOut],
    summary="Get monthly revenue/booking stats (admin)",
    description="Requires admin role. Returns revenue and booking counts grouped by month.",
)
def get_monthly_stats(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.monthly_stats(db)


@router.get(
    "/reports/export/{kind}",
    summary="Export a report as CSV (admin)",
    description=(
        "Requires admin role. Streams a CSV export for the requested data set (users, bookings, payments, "
        "flights, hotels, cruises, packages, or contact) as a file download."
    ),
)
def export_report(
    kind: Literal["users", "bookings", "payments", "flights", "hotels", "cruises", "packages", "contact"],
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    csv_text = _CSV_EXPORTERS[kind](db)
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{kind}.csv"'},
    )


@router.get(
    "/wishlist",
    response_model=Page[AdminWishlistOut],
    summary="List all wishlist entries (admin)",
    description="Requires admin role. Returns a paginated list of every wishlist entry across all users, including the owner's email.",
)
def list_all_wishlist(
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    rows, total = wishlist_service.list_all_wishlist_paginated(db, page, page_size)
    items = [AdminWishlistOut(**entry.__dict__, user_email=email) for entry, email in rows]
    return Page.build(items, total, page, page_size)


@router.delete(
    "/wishlist/{wishlist_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a wishlist entry (admin)",
    description="Requires admin role. Permanently removes any user's wishlist entry.",
)
def delete_wishlist_entry(wishlist_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    wishlist_service.delete_wishlist_admin(db, wishlist_id)
    activity_service.log_activity(db, _admin.id, f"Admin deleted wishlist entry #{wishlist_id}")


@router.get(
    "/reviews",
    response_model=Page[AdminReviewOut],
    summary="List all reviews (admin)",
    description="Requires admin role. Returns a paginated list of every review across all users, including the reviewer's email.",
)
def list_all_reviews(
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    items, total = review_service.list_all_reviews_paginated(db, page, page_size)
    return Page.build(items, total, page, page_size)


@router.delete(
    "/reviews/{review_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a review (admin)",
    description="Requires admin role. Permanently removes any user's review.",
)
def delete_review_admin(review_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    review_service.delete_review(db, _admin, review_id, is_admin=True)
    activity_service.log_activity(db, _admin.id, f"Admin deleted review #{review_id}")


@router.get(
    "/notifications",
    response_model=Page[AdminNotificationOut],
    summary="List all notifications (admin)",
    description="Requires admin role. Returns a paginated list of every notification sent to any user, including the recipient's email.",
)
def list_all_notifications(
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    items, total = notification_service.list_all_notifications_paginated(db, page, page_size)
    return Page.build(items, total, page, page_size)


@router.post(
    "/notifications",
    status_code=status.HTTP_201_CREATED,
    summary="Send a notification (admin)",
    description=(
        "Requires admin role. Sends a notification with the given title/message to a single user (if "
        "user_id is set) or broadcasts it to every user (if user_id is omitted/null)."
    ),
)
def send_notification(
    payload: AdminNotificationCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    count = notification_service.send_admin_notification(db, payload.user_id, payload.title, payload.message)
    activity_service.log_activity(db, _admin.id, f"Admin sent notification to {count} user(s)")
    return {"message": f"Notification sent to {count} user(s)"}


@router.get(
    "/activity-logs",
    response_model=Page[ActivityLogOut],
    summary="List activity logs (admin)",
    description="Requires admin role. Returns a paginated, optionally filtered (by search text or action type) list of user activity log entries across the platform.",
)
def list_activity_logs(
    search: str | None = None,
    action: str | None = None,
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    rows, total = activity_service.list_activity_logs_paginated(db, page, page_size, search=search, action=action)
    items = [
        ActivityLogOut(
            id=log.id, user_id=log.user_id, user_email=email, action=log.action,
            ip_address=log.ip_address, created_at=log.created_at,
        )
        for log, email in rows
    ]
    return Page.build(items, total, page, page_size)


@router.get(
    "/activity-logs/actions",
    response_model=list[str],
    summary="List distinct activity log actions (admin)",
    description="Requires admin role. Returns the distinct set of action names recorded in the activity log, for use as filter options.",
)
def list_activity_log_actions(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return activity_service.list_distinct_actions(db)
